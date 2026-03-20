import type { FetchRewriteRule, NormalizedPluginConfig } from "./types.js";
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

function isJsonContentType(contentType: string | null): boolean {
  return contentType?.toLowerCase().includes("application/json") ?? false;
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
  return buildApiEndpointCandidates(rule).includes(requestPathname);
}

function asJsonObject(headers: Headers, rawBody: Buffer): Record<string, unknown> | undefined {
  if (!rawBody.length || !isJsonContentType(headers.get("content-type"))) {
    return undefined;
  }
  const parsed = JSON.parse(rawBody.toString("utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }
  return parsed as Record<string, unknown>;
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

export function createPatchedFetch(
  params: NormalizedPluginConfig & {
    originalFetch: typeof globalThis.fetch;
    rules: FetchRewriteRule[];
    stableUserId: string;
    fallbackSessionId: string;
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
      return params.originalFetch(request.url, buildForwardInit(request, new Headers(request.headers), rawBody));
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

    return params.originalFetch(
      request.url,
      buildForwardInit(request, rewritten.headers, rewritten.bodyBuffer),
    );
  };
}
