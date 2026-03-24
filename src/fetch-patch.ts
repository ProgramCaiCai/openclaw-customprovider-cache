import { randomUUID } from "node:crypto";

import { createStreamTracker } from "./stream-inspector.js";
import type {
  FetchRewriteRule,
  ForwardedRequestLogger,
  NormalizedPluginConfig,
  RequestExecutionClass,
  SemanticFailureInfo,
  StreamInspectionResult,
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
): boolean {
  if (summary.semanticState === "completed") {
    return false;
  }

  if (summary.semanticState === "error-after-partial") {
    return executionClass === "subagent-like";
  }

  return true;
}

function enrichSemanticFailure(summary: StreamInspectionResult): SemanticFailureInfo {
  const baseMessage =
    summary.semanticError?.message ??
    (summary.semanticState === "ended-empty"
      ? "stream ended without a terminal success event"
      : summary.semanticState === "aborted"
        ? "stream aborted before a terminal success event"
        : "upstream stream reported a terminal failure");
  const providerStatus = summary.semanticError?.providerStatus ?? summary.semanticError?.status;
  const fingerprint = `${summary.semanticError?.code ?? ""} ${baseMessage}`.toLowerCase();

  if (summary.semanticState === "ended-empty" || summary.semanticState === "aborted") {
    return {
      status: 408,
      code: "STREAM_ABORTED",
      message: baseMessage,
      providerStatus,
    };
  }

  if (/overload|capacity/.test(fingerprint)) {
    return {
      status: 503,
      code: "OVERLOADED",
      message: baseMessage,
      providerStatus,
    };
  }

  if (/rate[_ -]?limit|too many requests|quota/.test(fingerprint)) {
    return {
      status: 429,
      code: "RATE_LIMIT",
      message: baseMessage,
      providerStatus,
    };
  }

  return {
    status: 502,
    code: "UPSTREAM_STREAM_ERROR",
    message: baseMessage,
    providerStatus,
  };
}

function createSemanticStreamError(semanticError: SemanticFailureInfo): Error & SemanticFailureInfo {
  return Object.assign(new Error(semanticError.message), semanticError);
}

function wrapInspectableStream(params: {
  matched: FetchRewriteRule;
  requestId?: string;
  requestLogger?: ForwardedRequestLogger;
  requestUrl: string;
  response: Response;
  executionClass: RequestExecutionClass;
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
            if (shouldEscalateSemanticFailure(summary, params.executionClass)) {
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

          if (currentSummary && shouldEscalateSemanticFailure(currentSummary, params.executionClass)) {
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
  semanticFailureGating: boolean;
}): Promise<Response> {
  const requestId = params.requestLogger ? randomUUID() : undefined;
  const executionClass = params.semanticFailureGating
    ? classifyExecutionClass(extractPromptishText(params.matched, params.headers, params.bodyBuffer))
    : undefined;

  if (requestId) {
    await params.requestLogger?.appendRequest({
      requestId,
      provider: params.matched.provider,
      api: params.matched.api,
      url: params.request.url,
      method: params.request.method,
      headers: params.headers,
      bodyBuffer: params.bodyBuffer,
    });
  }

  const response = await params.originalFetch(
    params.request.url,
    buildForwardInit(params.request, params.headers, params.bodyBuffer),
  );
  const inspectableStream = params.semanticFailureGating && isInspectableStream(params.matched, response);

  if (requestId) {
    void params.requestLogger?.appendResponse({
      requestId,
      provider: params.matched.provider,
      api: params.matched.api,
      url: params.request.url,
      response,
      executionClass: inspectableStream ? executionClass : undefined,
    });
  }

  if (!inspectableStream) {
    return response;
  }

  return wrapInspectableStream({
    matched: params.matched,
    requestId,
    requestLogger: params.requestLogger,
    requestUrl: params.request.url,
    response,
    executionClass: executionClass ?? "unknown",
  });
}

export function createPatchedFetch(
  params: Pick<NormalizedPluginConfig, "openai" | "anthropic" | "semanticFailureGating"> & {
    originalFetch: typeof globalThis.fetch;
    rules: FetchRewriteRule[];
    stableUserId: string;
    fallbackSessionId: string;
    requestLogger?: ForwardedRequestLogger;
  },
): typeof globalThis.fetch {
  const normalizedRules = params.rules
    .map((rule) => ({
      ...rule,
      baseUrl: rule.baseUrl.replace(/\/+$/, ""),
    }))
    .filter((rule) => rule.baseUrl.length > 0)
    .sort((left, right) => right.baseUrl.length - left.baseUrl.length);

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
      });
    }

    const rewritten = await rewriteProxyRequest({
      provider: matched.provider,
      api: matched.api,
      headers: new Headers(request.headers),
      rawBody,
      stableUserId: params.stableUserId,
      fallbackSessionId: params.fallbackSessionId,
      openai: params.openai,
      anthropic: params.anthropic,
    });

    return forwardRequest({
      originalFetch: params.originalFetch,
      request,
      matched,
      requestLogger: params.requestLogger,
      headers: rewritten.headers,
      bodyBuffer: rewritten.bodyBuffer,
      semanticFailureGating: params.semanticFailureGating,
    });
  };
}
