import { randomUUID } from "node:crypto";

import type { AttemptLedger } from "./attempt-ledger.js";
import { resolveErrorPolicy } from "./error-policy.js";
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
  CorrelationEnvelope,
  FetchRewriteRule,
  ForwardedRequestLogger,
  ForwardedRequestLogRecord,
  NormalizedPluginConfig,
  PostFirstTokenFailurePolicy,
  RequestExecutionClass,
  SemanticFailureInfo,
  SemanticRetryConfig,
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
async function classifyNonStreamOutcome(response: Response): Promise<SessionRecoveryOutcome | undefined> {
  if (response.ok) {
    return "success";
  }

  const contentType = response.headers.get("content-type");
  const isTextLike = isJsonContentType(contentType) || (contentType ?? "").toLowerCase().includes("text/");
  const bodyText = isTextLike ? await response.text().catch(() => undefined) : undefined;
  const body =
    isJsonContentType(contentType) && bodyText
      ? JSON.parse(bodyText) as unknown
      : bodyText;
  const policy = resolveErrorPolicy({
    transportStatus: response.status,
    body,
  });
  return policy.kind === "overload-error" ? "overloaded" : undefined;
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

function resolveDefaultSemanticRetryConfig(
  mainLikePostFirstTokenFailureEscalation = true,
): SemanticRetryConfig {
  return {
    maxAttempts: 3,
    baseBackoffMs: 200,
    mainLikePostFirstTokenPolicy: mainLikePostFirstTokenFailureEscalation
      ? "raise"
      : "passthrough",
    subagentLikePostFirstTokenPolicy: "buffered-retry",
  };
}

function resolvePostFirstTokenFailurePolicy(
  executionClass: RequestExecutionClass,
  semanticRetry: SemanticRetryConfig,
): PostFirstTokenFailurePolicy {
  if (executionClass === "subagent-like") {
    return semanticRetry.subagentLikePostFirstTokenPolicy;
  }
  if (executionClass === "main-like") {
    return semanticRetry.mainLikePostFirstTokenPolicy;
  }
  return "passthrough";
}

function enrichSemanticFailure(summary: StreamInspectionResult): SemanticFailureInfo {
  return classifySemanticFailure(summary);
}

function shouldRetrySemanticFailure(
  summary: StreamInspectionResult,
  semanticError: SemanticFailureInfo,
): boolean {
  return resolveErrorPolicy({
    semanticState: summary.semanticState,
    semanticError,
  }).retryable;
}

function computeRetryDelayMs(
  semanticError: SemanticFailureInfo,
  semanticRetry: SemanticRetryConfig,
  attemptNumber: number,
): number {
  if (semanticError.retryAfterMs !== undefined) {
    return semanticError.retryAfterMs;
  }
  return semanticRetry.baseBackoffMs * 2 ** Math.max(0, attemptNumber - 1);
}

function buildCorrelationEnvelope(params: {
  attemptId?: string;
  pluginInstallationId?: string;
  stableUserId: string;
  matched: FetchRewriteRule;
  headers: Headers;
  bodyBuffer: Buffer;
  requestNormalization?: ForwardedRequestLogRecord["requestNormalization"];
  requestedSessionId?: string;
  effectiveSessionId?: string;
  executionClass?: RequestExecutionClass;
}): CorrelationEnvelope {
  const body = asJsonObject(params.headers, params.bodyBuffer);
  const model = typeof body?.model === "string" ? body.model : undefined;
  return {
    ...(params.attemptId ? { attemptId: params.attemptId } : {}),
    pluginInstallationId: params.pluginInstallationId ?? params.stableUserId,
    stableUserId: params.stableUserId,
    provider: params.matched.provider,
    api: params.matched.api,
    ...(model ? { model } : {}),
    ...(params.requestedSessionId ? { requestedSessionId: params.requestedSessionId } : {}),
    ...(params.effectiveSessionId ? { effectiveSessionId: params.effectiveSessionId } : {}),
    ...(params.requestedSessionId &&
    params.effectiveSessionId &&
    params.requestedSessionId !== params.effectiveSessionId
      ? { recoverySessionId: params.effectiveSessionId }
      : {}),
    ...(params.executionClass ? { executionClass: params.executionClass } : {}),
    ...(params.requestNormalization?.normalizationKey
      ? { normalizationKey: params.requestNormalization.normalizationKey }
      : {}),
    ...(params.requestNormalization?.normalizationReplaySource
      ? { normalizationReplaySource: params.requestNormalization.normalizationReplaySource }
      : {}),
  };
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
  originalFetch: typeof globalThis.fetch;
  request: Request;
  matched: FetchRewriteRule;
  headers: Headers;
  bodyBuffer: Buffer;
  requestId?: string;
  requestLogger?: ForwardedRequestLogger;
  requestUrl: string;
  response: Response;
  correlation: CorrelationEnvelope;
  attemptLedger?: AttemptLedger;
  executionClass: RequestExecutionClass;
  requestedSessionId?: string;
  semanticRetry: SemanticRetryConfig;
  effectiveSessionId?: string;
  sessionRecoveryTracker?: SessionRecoveryTracker;
}): Response {
  const sourceBody = params.response.body;
  if (!sourceBody) {
    return params.response;
  }

  let finalized = false;
  let cancelled = false;
  let activeReader: ReadableStreamDefaultReader<Uint8Array> | undefined;

  const appendSummary = (
    summary: StreamInspectionResult,
    transportStatus: number,
  ): SemanticFailureInfo | undefined => {
    const semanticError = summary.semanticState === "completed" ? undefined : enrichSemanticFailure(summary);
    if (params.requestId) {
      void params.requestLogger?.appendResponseSummary({
        requestId: params.requestId,
        attemptId: params.correlation.attemptId,
        provider: params.matched.provider,
        api: params.matched.api,
        url: params.requestUrl,
        executionClass: params.executionClass,
        transportStatus,
        semanticState: summary.semanticState,
        sawVisibleOutput: summary.sawVisibleOutput,
        attemptAbandoned: summary.semanticState === "error-after-partial",
        semanticError,
        streamIntegrity: summary.streamIntegrity,
        correlation: params.correlation,
      });
    }
    if (summary.semanticState === "error-after-partial" && params.attemptLedger) {
      void params.attemptLedger.recordAbandoned({
        attemptId: params.correlation.attemptId ?? params.requestId ?? randomUUID(),
        requestId: params.requestId,
        provider: params.matched.provider,
        api: params.matched.api,
        url: params.requestUrl,
        semanticState: summary.semanticState,
        errorPolicyKind: semanticError
          ? resolveErrorPolicy({
              semanticState: summary.semanticState,
              semanticError,
            }).kind
          : undefined,
        correlation: params.correlation,
      });
    }
    if (
      params.sessionRecoveryTracker &&
      params.requestedSessionId &&
      params.effectiveSessionId
    ) {
      const outcome = semanticError
        ? resolveErrorPolicy({
            semanticState: summary.semanticState,
            semanticError,
          }).kind === "overload-error"
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
    start(controller) {
      const postFirstTokenPolicy = resolvePostFirstTokenFailurePolicy(
        params.executionClass,
        params.semanticRetry,
      );

      const flushBufferedChunks = (
        bufferedChunks: Uint8Array[],
        state: { flushedVisibleOutput: boolean },
      ): void => {
        if (state.flushedVisibleOutput) {
          return;
        }
        for (const chunk of bufferedChunks) {
          controller.enqueue(chunk);
        }
        bufferedChunks.length = 0;
        state.flushedVisibleOutput = true;
      };

      const run = async (): Promise<void> => {
        let attemptNumber = 1;
        let nextResponse: Response = params.response;

        while (!cancelled && attemptNumber <= params.semanticRetry.maxAttempts) {
          const attemptResponse = nextResponse;
          nextResponse = undefined as unknown as Response;
          const attemptBody = attemptResponse.body;
          if (!attemptBody) {
            finalized = true;
            controller.error(new Error("Inspectable stream response body is missing"));
            return;
          }

          const tracker = createStreamTracker(params.matched.api);
          const reader = attemptBody.getReader();
          activeReader = reader;
          const bufferedChunks: Uint8Array[] = [];
          const outputState = { flushedVisibleOutput: false };

          const requestRetry = async (semanticError: SemanticFailureInfo): Promise<void> => {
            await reader.cancel().catch(() => undefined);
            activeReader = undefined;
            const delayMs = computeRetryDelayMs(
              semanticError,
              params.semanticRetry,
              attemptNumber,
            );
            if (delayMs > 0) {
              await new Promise((resolve) => setTimeout(resolve, delayMs));
            }
            attemptNumber += 1;
            if (attemptNumber > params.semanticRetry.maxAttempts || cancelled) {
              finalized = true;
              controller.error(createSemanticStreamError(semanticError));
              return;
            }
            nextResponse = await params.originalFetch(
              params.request.url,
              buildForwardInit(params.request, params.headers, params.bodyBuffer),
            );
          };

          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) {
                const summary = tracker.finalize();
                const semanticError = appendSummary(summary, attemptResponse.status);

                if (summary.semanticState === "completed") {
                  if (!outputState.flushedVisibleOutput) {
                    flushBufferedChunks(bufferedChunks, outputState);
                  }
                  finalized = true;
                  controller.close();
                  return;
                }

                const resolvedSemanticError = semanticError ?? enrichSemanticFailure(summary);
                const retryable = shouldRetrySemanticFailure(summary, resolvedSemanticError);
                const canRetry =
                  retryable &&
                  attemptNumber < params.semanticRetry.maxAttempts &&
                  (!summary.sawVisibleOutput || postFirstTokenPolicy === "buffered-retry");

                if (canRetry) {
                  await requestRetry(resolvedSemanticError);
                  break;
                }

                if (summary.sawVisibleOutput && postFirstTokenPolicy === "passthrough") {
                  if (!outputState.flushedVisibleOutput) {
                    flushBufferedChunks(bufferedChunks, outputState);
                  }
                  finalized = true;
                  controller.close();
                  return;
                }

                finalized = true;
                controller.error(createSemanticStreamError(resolvedSemanticError));
                return;
              }

              if (!value || value.byteLength === 0) {
                continue;
              }

              tracker.consumeChunk(value);
              const currentSummary = tracker.currentResult();

              if (!outputState.flushedVisibleOutput) {
                bufferedChunks.push(value);
                if (
                  tracker.sawVisibleOutput &&
                  postFirstTokenPolicy !== "buffered-retry"
                ) {
                  flushBufferedChunks(bufferedChunks, outputState);
                }
              } else if (
                !currentSummary ||
                currentSummary.semanticState === "completed" ||
                postFirstTokenPolicy === "passthrough"
              ) {
                controller.enqueue(value);
              }

              if (!currentSummary) {
                continue;
              }

              if (currentSummary.semanticState === "completed") {
                appendSummary(currentSummary, attemptResponse.status);
                if (!outputState.flushedVisibleOutput) {
                  flushBufferedChunks(bufferedChunks, outputState);
                }
                finalized = true;
                controller.close();
                await reader.cancel().catch(() => undefined);
                activeReader = undefined;
                return;
              }

              const semanticError =
                appendSummary(currentSummary, attemptResponse.status) ??
                enrichSemanticFailure(currentSummary);
              const retryable = shouldRetrySemanticFailure(currentSummary, semanticError);
              const canRetry =
                retryable &&
                attemptNumber < params.semanticRetry.maxAttempts &&
                (!currentSummary.sawVisibleOutput ||
                  postFirstTokenPolicy === "buffered-retry");

              if (canRetry) {
                await requestRetry(semanticError);
                break;
              }

              if (currentSummary.sawVisibleOutput && postFirstTokenPolicy === "passthrough") {
                continue;
              }

              finalized = true;
              controller.error(createSemanticStreamError(semanticError));
              await reader.cancel().catch(() => undefined);
              activeReader = undefined;
              return;
            }
          } catch (error) {
            const summary = tracker.abort(error);
            const semanticError = appendSummary(summary, attemptResponse.status) ?? enrichSemanticFailure(summary);
            const retryable = shouldRetrySemanticFailure(summary, semanticError);
            const canRetry =
              retryable &&
              attemptNumber < params.semanticRetry.maxAttempts &&
              (!summary.sawVisibleOutput || postFirstTokenPolicy === "buffered-retry");

            if (canRetry) {
              await requestRetry(semanticError);
              continue;
            }

            finalized = true;
            controller.error(createSemanticStreamError(semanticError));
            return;
          } finally {
            activeReader = undefined;
          }

          if (!nextResponse) {
            return;
          }
        }
      };

      void run().catch((error) => {
        if (finalized || cancelled) {
          return;
        }
        finalized = true;
        controller.error(error instanceof Error ? error : new Error(String(error)));
      });
    },
    async cancel(reason) {
      if (finalized) {
        return;
      }
      finalized = true;
      cancelled = true;
      await activeReader?.cancel(reason).catch(() => undefined);
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
  semanticRetry: SemanticRetryConfig;
  mainLikePostFirstTokenFailureEscalation?: boolean;
  subagentResultStopgap: boolean;
  pluginInstallationId?: string;
  stableUserId: string;
  attemptLedger?: AttemptLedger;
  requestedSessionId?: string;
  effectiveSessionId?: string;
  sessionRecoveryTracker?: SessionRecoveryTracker;
}): Promise<Response> {
  const requestId = params.requestLogger ? randomUUID() : undefined;
  const attemptId = randomUUID();
  const promptText =
    params.semanticFailureGating || params.subagentResultStopgap
      ? extractPromptishText(params.matched, params.headers, params.bodyBuffer)
      : "";
  const executionClass = params.semanticFailureGating ? classifyExecutionClass(promptText) : undefined;
  const correlation = buildCorrelationEnvelope({
    pluginInstallationId: params.pluginInstallationId,
    stableUserId: params.stableUserId,
    matched: params.matched,
    attemptId,
    headers: params.headers,
    bodyBuffer: params.bodyBuffer,
    requestNormalization: params.requestNormalization,
    requestedSessionId: params.requestedSessionId,
    effectiveSessionId: params.effectiveSessionId,
    executionClass,
  });

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
      correlation,
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
          correlation,
          attemptId,
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
      attemptId,
      executionClass: inspectableStream ? executionClass : undefined,
      correlation,
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
    originalFetch: params.originalFetch,
    request: params.request,
    headers: params.headers,
    bodyBuffer: params.bodyBuffer,
    requestId,
    requestLogger: params.requestLogger,
    requestUrl: params.request.url,
    response,
    correlation,
    attemptLedger: params.attemptLedger,
    executionClass: executionClass ?? "unknown",
    requestedSessionId: params.requestedSessionId,
    semanticRetry:
      params.semanticRetry ??
      resolveDefaultSemanticRetryConfig(params.mainLikePostFirstTokenFailureEscalation ?? true),
    effectiveSessionId: params.effectiveSessionId,
    sessionRecoveryTracker: params.sessionRecoveryTracker,
  });
}

export function createPatchedFetch(
  params: Omit<
    Pick<
      NormalizedPluginConfig,
      | "openai"
      | "anthropic"
      | "semanticFailureGating"
      | "semanticRetry"
      | "mainLikePostFirstTokenFailureEscalation"
      | "subagentResultStopgap"
    >,
    "semanticRetry"
  > & {
    originalFetch: typeof globalThis.fetch;
    pluginInstallationId?: string;
    rules: FetchRewriteRule[];
    stableUserId: string;
    fallbackSessionId: string;
    requestLogger?: ForwardedRequestLogger;
    normalizationLedger?: NormalizationLedger;
    sessionRecoveryTracker?: SessionRecoveryTracker;
    attemptLedger?: AttemptLedger;
    semanticRetry?: SemanticRetryConfig;
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
        semanticRetry:
          params.semanticRetry ??
          resolveDefaultSemanticRetryConfig(params.mainLikePostFirstTokenFailureEscalation ?? true),
        mainLikePostFirstTokenFailureEscalation:
          params.mainLikePostFirstTokenFailureEscalation,
        subagentResultStopgap: params.subagentResultStopgap,
        pluginInstallationId: params.pluginInstallationId,
        stableUserId: params.stableUserId,
        attemptLedger: params.attemptLedger,
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
      semanticRetry:
        params.semanticRetry ??
        resolveDefaultSemanticRetryConfig(params.mainLikePostFirstTokenFailureEscalation ?? true),
      mainLikePostFirstTokenFailureEscalation:
        params.mainLikePostFirstTokenFailureEscalation,
      subagentResultStopgap: params.subagentResultStopgap,
      pluginInstallationId: params.pluginInstallationId,
      stableUserId: params.stableUserId,
      attemptLedger: params.attemptLedger,
      requestedSessionId,
      effectiveSessionId: rewritten.openaiSessionId,
      sessionRecoveryTracker,
    });
  };
}
