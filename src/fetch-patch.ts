import { randomUUID } from "node:crypto";

import type { NormalizationLedger } from "./normalization-ledger.js";
import { classifySemanticFailure } from "./semantic-failure.js";
import {
  createInMemorySessionRecoveryTracker,
  type SessionRecoveryOutcome,
  type SessionRecoveryTracker,
} from "./session-recovery.js";
import { createStreamTracker } from "./stream-inspector.js";
import { detectSubagentResultStopgap } from "./subagent-result-stopgap.js";
import type {
  FetchRewriteRule,
  ForwardedRequestLogger,
  ForwardedRequestLogRecord,
  NormalizedPluginConfig,
  RequestExecutionClass,
  SemanticFailureInfo,
  StreamInspectionResult,
  SubagentResultStopgapReason,
  SubagentResultStopgapVerdict,
} from "./types.js";
import { rewriteProxyRequest } from "./proxy-rewrite.js";

function normalizePathname(pathname: string): string {
  const normalized = pathname.replace(/\/+$/, "");
  return normalized.length > 0 ? normalized : "/";
}

function joinPathname(basePathname: string, suffix: string): string {
  const normalizedBase = normalizePathname(basePathname);
  const normalizedSuffix = suffix.replace(/^\/+/, "");
  if (normalizedBase === "/") {
    return `/${normalizedSuffix}`;
  }
  return `${normalizedBase}/${normalizedSuffix}`;
}

function buildApiEndpointCandidates(rule: FetchRewriteRule): string[] {
  const baseUrl = new URL(rule.baseUrl);
  const basePathname = normalizePathname(baseUrl.pathname);
  const endsWithV1 = basePathname === "/v1" || basePathname.endsWith("/v1");
  const candidates = new Set<string>();

  if (rule.api === "openai-responses") {
    candidates.add(joinPathname(basePathname, "responses"));
    if (!endsWithV1) {
      candidates.add(joinPathname(basePathname, "v1/responses"));
    }
  }

  if (rule.api === "anthropic-messages") {
    candidates.add(joinPathname(basePathname, "messages"));
    if (!endsWithV1) {
      candidates.add(joinPathname(basePathname, "v1/messages"));
    }
  }

  return [...candidates];
}

function isGoogleStreamEndpointMatch(requestPathname: string, basePathname: string): boolean {
  const modelsPrefix = joinPathname(basePathname, "models/");
  return requestPathname.startsWith(modelsPrefix) && requestPathname.endsWith(":streamGenerateContent");
}

function isJsonContentType(contentType: string | null): boolean {
  return contentType?.toLowerCase().includes("application/json") ?? false;
}

function isStreamLikeContentType(contentType: string | null): boolean {
  const normalized = (contentType ?? "").toLowerCase();
  return (
    normalized.includes("text/event-stream") ||
    normalized.includes("application/x-ndjson") ||
    normalized.includes("application/json-seq")
  );
}

function isEndpointMatch(request: Request, rule: FetchRewriteRule): boolean {
  if (request.method !== "POST") {
    return false;
  }
  if (!isJsonContentType(request.headers.get("content-type"))) {
    return false;
  }

  const requestUrl = new URL(request.url);
  const ruleUrl = new URL(rule.baseUrl);
  if (requestUrl.origin !== ruleUrl.origin) {
    return false;
  }

  const requestPathname = normalizePathname(requestUrl.pathname);
  if (rule.api === "google-generative-ai") {
    return isGoogleStreamEndpointMatch(requestPathname, normalizePathname(ruleUrl.pathname));
  }
  return buildApiEndpointCandidates(rule).includes(requestPathname);
}

function asJsonObject(headers: Headers, rawBody: Buffer): Record<string, unknown> | undefined {
  if (!rawBody.length || !isJsonContentType(headers.get("content-type"))) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(rawBody.toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function matchesApiShape(
  rule: FetchRewriteRule,
  headers: Headers,
  rawBody: Buffer,
): boolean {
  const body = asJsonObject(headers, rawBody);
  if (!body) {
    return false;
  }

  if (rule.api === "openai-responses") {
    return Object.hasOwn(body, "input") || typeof body.prompt_cache_key === "string";
  }

  if (rule.api === "anthropic-messages") {
    return Array.isArray(body.messages);
  }

  if (rule.api === "google-generative-ai") {
    return Array.isArray(body.contents);
  }

  return false;
}

function buildForwardInit(
  request: Request,
  headers: Headers,
  bodyBuffer: Buffer,
): RequestInit & { duplex?: "half" } {
  const nextInit: RequestInit & { duplex?: "half" } = {
    method: request.method,
    headers,
    signal: request.signal,
    body:
      request.method === "GET" || request.method === "HEAD"
        ? undefined
        : new Uint8Array(bodyBuffer),
  };
  if (nextInit.body !== undefined) {
    nextInit.duplex = "half";
  }
  return nextInit;
}

function collectPromptishStrings(value: unknown, parts: string[]): void {
  if (typeof value === "string") {
    parts.push(value);
    return;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      collectPromptishStrings(entry, parts);
    }
    return;
  }

  if (value && typeof value === "object") {
    for (const entry of Object.values(value)) {
      collectPromptishStrings(entry, parts);
    }
  }
}

export function extractPromptishText(
  _rule: FetchRewriteRule,
  headers: Headers,
  rawBody: Buffer,
): string {
  const body = asJsonObject(headers, rawBody);
  if (!body) {
    return rawBody.toString("utf8");
  }

  const parts: string[] = [];
  collectPromptishStrings(body, parts);
  return parts.join("\n");
}

export function classifyExecutionClass(promptText: string): RequestExecutionClass {
  // This v1 heuristic intentionally keys off SOUL.md absence because current subagent flows inject AGENTS.md and TOOLS.md without SOUL.md.
  if (/SOUL\.md/i.test(promptText)) {
    return "main-like";
  }
  if (/AGENTS\.md/i.test(promptText) && /TOOLS\.md/i.test(promptText)) {
    return "subagent-like";
  }
  return "unknown";
}

function extractOpenAiSessionId(headers: Headers, rawBody: Buffer, fallbackSessionId: string): string {
  const headerId = headers.get("session_id")?.trim() || headers.get("x-session-id")?.trim();
  if (headerId) {
    return headerId;
  }

  const body = asJsonObject(headers, rawBody);
  const promptCacheKey = body?.prompt_cache_key;
  if (typeof promptCacheKey === "string" && promptCacheKey.trim()) {
    return promptCacheKey.trim();
  }

  return fallbackSessionId;
}
function isOverloadText(value: string): boolean {
  return /overload|capacity|service_unavailable|temporarily unavailable|upstream-overloaded/.test(
    value.toLowerCase(),
  );
}

function isSemanticOverload(semanticError: SemanticFailureInfo): boolean {
  return (
    semanticError.status === 503 ||
    semanticError.providerStatus === 503 ||
    semanticError.providerStatus === 529 ||
    semanticError.code === "SERVER_OVERLOADED" ||
    semanticError.classification === "server-overloaded" ||
    isOverloadText(`${semanticError.code ?? ""} ${semanticError.message ?? ""}`)
  );
}

async function classifyNonStreamOutcome(response: Response): Promise<SessionRecoveryOutcome | undefined> {
  if (response.ok) {
    return "success";
  }

  if (response.status === 503 || response.status === 529) {
    return "overloaded";
  }

  const contentType = response.headers.get("content-type");
  const isTextLike = isJsonContentType(contentType) || (contentType ?? "").toLowerCase().includes("text/");
  if (!isTextLike) {
    return undefined;
  }

  try {
    const bodyText = await response.text();
    return isOverloadText(bodyText) ? "overloaded" : undefined;
  } catch {
    return undefined;
  }
}

function isInspectableStream(rule: FetchRewriteRule, response: Response): boolean {
  return (
    (rule.api === "openai-responses" ||
      rule.api === "anthropic-messages" ||
      rule.api === "google-generative-ai") &&
    response.body !== null &&
    isStreamLikeContentType(response.headers.get("content-type"))
  );
}

function shouldEscalateSemanticFailure(
  summary: StreamInspectionResult,
  executionClass: RequestExecutionClass,
  mainLikePostFirstTokenFailureEscalation: boolean,
): boolean {
  if (summary.semanticState === "completed") {
    return false;
  }

  if (summary.semanticState === "error-after-partial") {
    if (executionClass === "subagent-like") {
      return true;
    }
    if (executionClass === "main-like") {
      return mainLikePostFirstTokenFailureEscalation;
    }
    return false;
  }

  return true;
}

function enrichSemanticFailure(summary: StreamInspectionResult): SemanticFailureInfo {
  return classifySemanticFailure(summary);
}

function createSemanticStreamError(semanticError: SemanticFailureInfo): Error & SemanticFailureInfo {
  return Object.assign(new Error(semanticError.message), semanticError);
}

function createSubagentResultStopgapError(params: {
  verdict: Exclude<SubagentResultStopgapVerdict, "none">;
  reason?: SubagentResultStopgapReason;
}): SemanticFailureInfo {
  const message =
    params.verdict === "empty-child-result"
      ? "Child completion reported success without usable output; retry before upstream generation."
      : "Suspicious child-completion payload detected before upstream generation.";

  return {
    status: 408,
    providerStatus: 408,
    code: "SUBAGENT_RESULT_STOPGAP",
    message,
    classification: "retryable-stream",
    retryable: true,
    syntheticFailure: true,
  };
}

function createSubagentResultStopgapResponse(params: {
  semanticError: SemanticFailureInfo;
  executionClass: RequestExecutionClass;
  verdict: Exclude<SubagentResultStopgapVerdict, "none">;
  reason?: SubagentResultStopgapReason;
}): Response {
  return new Response(
    JSON.stringify({
      error: {
        code: params.semanticError.code,
        message: params.semanticError.message,
        retryable: true,
        executionClass: params.executionClass,
        verdict: params.verdict,
        reason: params.reason,
        syntheticFailure: true,
      },
    }),
    {
      status: params.semanticError.status ?? 408,
      headers: { "content-type": "application/json" },
    },
  );
}

function wrapInspectableStream(params: {
  matched: FetchRewriteRule;
  requestId?: string;
  requestLogger?: ForwardedRequestLogger;
  requestUrl: string;
  response: Response;
  executionClass: RequestExecutionClass;
  requestedSessionId?: string;
  mainLikePostFirstTokenFailureEscalation: boolean;
  effectiveSessionId?: string;
  sessionRecoveryTracker?: SessionRecoveryTracker;
}): Response {
  const sourceBody = params.response.body;
  if (!sourceBody) {
    return params.response;
  }

  const tracker = createStreamTracker(params.matched.api);
  const reader = sourceBody.getReader();
  const bufferedChunks: Uint8Array[] = [];
  let flushedVisibleOutput = false;
  let finalized = false;
  let summaryLogged = false;

  const flushBufferedChunks = (controller: ReadableStreamDefaultController<Uint8Array>): void => {
    if (flushedVisibleOutput) {
      return;
    }
    for (const chunk of bufferedChunks) {
      controller.enqueue(chunk);
    }
    bufferedChunks.length = 0;
    flushedVisibleOutput = true;
  };

  const appendSummary = (summary: StreamInspectionResult): SemanticFailureInfo | undefined => {
    const semanticError = summary.semanticState === "completed" ? undefined : enrichSemanticFailure(summary);
    if (!summaryLogged && params.requestId) {
      summaryLogged = true;
      void params.requestLogger?.appendResponseSummary({
        requestId: params.requestId,
        provider: params.matched.provider,
        api: params.matched.api,
        url: params.requestUrl,
        executionClass: params.executionClass,
        transportStatus: params.response.status,
        semanticState: summary.semanticState,
        semanticError,
      });
    }
    if (
      params.sessionRecoveryTracker &&
      params.requestedSessionId &&
      params.effectiveSessionId
    ) {
      const outcome = semanticError
        ? isSemanticOverload(semanticError)
          ? "overloaded"
          : undefined
        : summary.semanticState === "completed"
          ? "success"
          : undefined;
      void params.sessionRecoveryTracker.noteOutcome({
        requestedSessionId: params.requestedSessionId,
        effectiveSessionId: params.effectiveSessionId,
        outcome,
      });
    }
    return semanticError;
  };

  const wrappedBody = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (finalized) {
        return;
      }

      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            const summary = tracker.finalize();
            const semanticError = appendSummary(summary);
            finalized = true;
            if (
              shouldEscalateSemanticFailure(
                summary,
                params.executionClass,
                params.mainLikePostFirstTokenFailureEscalation,
              )
            ) {
              controller.error(createSemanticStreamError(semanticError ?? enrichSemanticFailure(summary)));
              return;
            }
            if (!flushedVisibleOutput) {
              flushBufferedChunks(controller);
            }
            controller.close();
            return;
          }

          if (!value || value.byteLength === 0) {
            continue;
          }

          tracker.consumeChunk(value);
          const currentSummary = tracker.currentResult();

          if (
            currentSummary &&
            shouldEscalateSemanticFailure(
              currentSummary,
              params.executionClass,
              params.mainLikePostFirstTokenFailureEscalation,
            )
          ) {
            const semanticError = appendSummary(currentSummary) ?? enrichSemanticFailure(currentSummary);
            finalized = true;
            controller.error(createSemanticStreamError(semanticError));
            await reader.cancel().catch(() => undefined);
            return;
          }

          if (!flushedVisibleOutput) {
            bufferedChunks.push(value);
            if (tracker.sawVisibleOutput) {
              flushBufferedChunks(controller);
              return;
            }
            continue;
          }

          controller.enqueue(value);
          return;
        }
      } catch (error) {
        const summary = tracker.abort(error);
        const semanticError = appendSummary(summary) ?? enrichSemanticFailure(summary);
        finalized = true;
        controller.error(createSemanticStreamError(semanticError));
      }
    },
    async cancel(reason) {
      if (finalized) {
        return;
      }
      finalized = true;
      appendSummary(tracker.abort(reason));
      await reader.cancel(reason).catch(() => undefined);
    },
  });

  return new Response(wrappedBody, {
    status: params.response.status,
    statusText: params.response.statusText,
    headers: new Headers(params.response.headers),
  });
}

async function forwardRequest(params: {
  originalFetch: typeof globalThis.fetch;
  request: Request;
  matched: FetchRewriteRule;
  requestLogger?: ForwardedRequestLogger;
  headers: Headers;
  bodyBuffer: Buffer;
  requestNormalization?: ForwardedRequestLogRecord["requestNormalization"];
  semanticFailureGating: boolean;
  mainLikePostFirstTokenFailureEscalation?: boolean;
  subagentResultStopgap: boolean;
  requestedSessionId?: string;
  effectiveSessionId?: string;
  sessionRecoveryTracker?: SessionRecoveryTracker;
}): Promise<Response> {
  const requestId = params.requestLogger ? randomUUID() : undefined;
  const promptText =
    params.semanticFailureGating || params.subagentResultStopgap
      ? extractPromptishText(params.matched, params.headers, params.bodyBuffer)
      : "";
  const executionClass = params.semanticFailureGating ? classifyExecutionClass(promptText) : undefined;

  if (requestId) {
    await params.requestLogger?.appendRequest({
      requestId,
      provider: params.matched.provider,
      api: params.matched.api,
      url: params.request.url,
      method: params.request.method,
      headers: params.headers,
      bodyBuffer: params.bodyBuffer,
      requestNormalization: params.requestNormalization,
    });
  }

  if (params.subagentResultStopgap) {
    const decision = detectSubagentResultStopgap(promptText);
    if (decision.verdict !== "none") {
      const semanticError = createSubagentResultStopgapError({
        verdict: decision.verdict,
        reason: decision.reason,
      });
      const response = createSubagentResultStopgapResponse({
        semanticError,
        executionClass: executionClass ?? "unknown",
        verdict: decision.verdict,
        reason: decision.reason,
      });

      if (requestId) {
        await params.requestLogger?.appendResponse({
          requestId,
          provider: params.matched.provider,
          api: params.matched.api,
          url: params.request.url,
          response: response.clone(),
          semanticState: "error",
          semanticError,
          executionClass,
        });
      }

      return response;
    }
  }

  const response = await params.originalFetch(
    params.request.url,
    buildForwardInit(params.request, params.headers, params.bodyBuffer),
  );
  const inspectableStream = params.semanticFailureGating && isInspectableStream(params.matched, response);
  const responseForLogging = requestId ? response.clone() : undefined;

  if (requestId) {
    void params.requestLogger?.appendResponse({
      requestId,
      provider: params.matched.provider,
      api: params.matched.api,
      url: params.request.url,
      response: responseForLogging ?? response,
      executionClass: inspectableStream ? executionClass : undefined,
    });
  }

  if (!inspectableStream) {
    if (
      params.sessionRecoveryTracker &&
      params.requestedSessionId &&
      params.effectiveSessionId
    ) {
      let outcome: SessionRecoveryOutcome | undefined;
      try {
        outcome = await classifyNonStreamOutcome(response.clone());
      } catch {
        outcome = undefined;
      }
      await params.sessionRecoveryTracker.noteOutcome({
        requestedSessionId: params.requestedSessionId,
        effectiveSessionId: params.effectiveSessionId,
        outcome,
      });
    }
    return response;
  }

  return wrapInspectableStream({
    matched: params.matched,
    requestId,
    requestLogger: params.requestLogger,
    requestUrl: params.request.url,
    response,
    executionClass: executionClass ?? "unknown",
    requestedSessionId: params.requestedSessionId,
    mainLikePostFirstTokenFailureEscalation:
      params.mainLikePostFirstTokenFailureEscalation ?? true,
    effectiveSessionId: params.effectiveSessionId,
    sessionRecoveryTracker: params.sessionRecoveryTracker,
  });
}

export function createPatchedFetch(
  params: Pick<
    NormalizedPluginConfig,
    | "openai"
    | "anthropic"
    | "semanticFailureGating"
    | "mainLikePostFirstTokenFailureEscalation"
    | "subagentResultStopgap"
  > & {
    originalFetch: typeof globalThis.fetch;
    rules: FetchRewriteRule[];
    stableUserId: string;
    fallbackSessionId: string;
    requestLogger?: ForwardedRequestLogger;
    normalizationLedger?: NormalizationLedger;
    sessionRecoveryTracker?: SessionRecoveryTracker;
  },
): typeof globalThis.fetch {
  const normalizedRules = params.rules
    .map((rule) => ({
      ...rule,
      baseUrl: rule.baseUrl.replace(/\/+$/, ""),
    }))
    .filter((rule) => rule.baseUrl.length > 0)
    .sort((left, right) => right.baseUrl.length - left.baseUrl.length);
  const sessionRecoveryTracker =
    params.sessionRecoveryTracker ?? createInMemorySessionRecoveryTracker(params.fallbackSessionId);

  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const matched = normalizedRules.find((rule) => isEndpointMatch(request, rule));
    if (!matched) {
      return params.originalFetch(input, init);
    }

    const rawBody =
      request.method === "GET" || request.method === "HEAD"
        ? Buffer.alloc(0)
        : Buffer.from(await request.arrayBuffer());
    if (!matchesApiShape(matched, new Headers(request.headers), rawBody)) {
      const headers = new Headers(request.headers);
      return forwardRequest({
        originalFetch: params.originalFetch,
        request,
        matched,
        requestLogger: params.requestLogger,
        headers,
        bodyBuffer: rawBody,
        semanticFailureGating: params.semanticFailureGating,
        mainLikePostFirstTokenFailureEscalation:
          params.mainLikePostFirstTokenFailureEscalation,
        subagentResultStopgap: params.subagentResultStopgap,
      });
    }

    const requestedSessionId =
      matched.api === "openai-responses"
        ? extractOpenAiSessionId(new Headers(request.headers), rawBody, params.fallbackSessionId)
        : undefined;
    const overrideSessionId = requestedSessionId
      ? sessionRecoveryTracker.selectSessionId(requestedSessionId)
      : undefined;

    const rewritten = await rewriteProxyRequest({
      provider: matched.provider,
      api: matched.api,
      headers: new Headers(request.headers),
      rawBody,
      stableUserId: params.stableUserId,
      fallbackSessionId: params.fallbackSessionId,
      openai: {
        ...params.openai,
        overrideSessionId:
          overrideSessionId && overrideSessionId !== requestedSessionId ? overrideSessionId : undefined,
      },
      anthropic: params.anthropic,
      normalizationLedger: params.normalizationLedger,
    });

    return forwardRequest({
      originalFetch: params.originalFetch,
      request,
      matched,
      requestLogger: params.requestLogger,
      headers: rewritten.headers,
      bodyBuffer: rewritten.bodyBuffer,
      requestNormalization: rewritten.requestNormalization,
      semanticFailureGating: params.semanticFailureGating,
      mainLikePostFirstTokenFailureEscalation:
        params.mainLikePostFirstTokenFailureEscalation,
      subagentResultStopgap: params.subagentResultStopgap,
      requestedSessionId,
      effectiveSessionId: rewritten.openaiSessionId,
      sessionRecoveryTracker,
    });
  };
}
