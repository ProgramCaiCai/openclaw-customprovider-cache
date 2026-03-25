import type { ProviderApi } from "./types.js";

type RewriteParams = {
  provider: string;
  api: ProviderApi;
  headers: Headers;
  rawBody: Buffer;
  stableUserId: string;
  fallbackSessionId: string;
  openai: {
    injectSessionIdHeader: boolean;
    injectPromptCacheKey: boolean;
    overrideSessionId?: string;
  };
  anthropic: {
    injectMetadataUserId: boolean;
    userId?: string;
    userIdPrefix: string;
  };
};

export type RewriteResult = {
  headers: Headers;
  bodyBuffer: Buffer;
  jsonBody?: Record<string, unknown>;
  openaiSessionId?: string;
  requestNormalization?: {
    droppedDuplicateProviderInputIds: string[];
    droppedDuplicateProviderInputCount: number;
  };
};

function isRsProviderInputItem(value: unknown): value is Record<string, unknown> & { id: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  return typeof (value as { id?: unknown }).id === "string" && /^rs_/.test((value as { id: string }).id);
}

function dedupeOpenAiProviderInput(
  body: Record<string, unknown> | undefined,
): {
  jsonBody: Record<string, unknown> | undefined;
  changed: boolean;
  requestNormalization?: RewriteResult["requestNormalization"];
} {
  const input = body?.input;
  if (!Array.isArray(input)) {
    return { jsonBody: body, changed: false };
  }

  const seenIds = new Set<string>();
  const droppedDuplicateProviderInputIds: string[] = [];
  let droppedDuplicateProviderInputCount = 0;
  const normalizedInput = input.filter((item) => {
    if (!isRsProviderInputItem(item)) {
      return true;
    }

    if (seenIds.has(item.id)) {
      droppedDuplicateProviderInputIds.push(item.id);
      droppedDuplicateProviderInputCount += 1;
      return false;
    }

    seenIds.add(item.id);
    return true;
  });

  if (droppedDuplicateProviderInputCount === 0) {
    return { jsonBody: body, changed: false };
  }

  return {
    jsonBody: { ...body, input: normalizedInput },
    changed: true,
    requestNormalization: {
      droppedDuplicateProviderInputIds: [...new Set(droppedDuplicateProviderInputIds)],
      droppedDuplicateProviderInputCount,
    },
  };
}

function isJsonContentType(contentType: string | null): boolean {
  return contentType?.toLowerCase().includes("application/json") ?? false;
}

function isOpenAiApi(api: ProviderApi): boolean {
  return api === "openai-responses";
}

function isAnthropicApi(api: ProviderApi): boolean {
  return api === "anthropic-messages";
}

function asJsonObject(rawBody: Buffer, headers: Headers): Record<string, unknown> | undefined {
  if (!rawBody.length || !isJsonContentType(headers.get("content-type"))) {
    return undefined;
  }
  const parsed = JSON.parse(rawBody.toString("utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("JSON request body must be an object");
  }
  return parsed as Record<string, unknown>;
}

function pickSessionId(headers: Headers, body: Record<string, unknown> | undefined, fallback: string): string {
  const headerId = headers.get("session_id")?.trim() || headers.get("x-session-id")?.trim();
  if (headerId) return headerId;
  const promptCacheKey = body?.prompt_cache_key;
  if (typeof promptCacheKey === "string" && promptCacheKey.trim()) {
    return promptCacheKey.trim();
  }
  return fallback;
}

function cloneHeaders(headers: Headers): Headers {
  const next = new Headers(headers);
  next.delete("content-length");
  next.delete("host");
  next.delete("connection");
  next.delete("transfer-encoding");
  return next;
}

export async function rewriteProxyRequest(params: RewriteParams): Promise<RewriteResult> {
  const headers = cloneHeaders(params.headers);
  let jsonBody = asJsonObject(params.rawBody, headers);
  let bodyChanged = false;
  let openaiSessionId: string | undefined;
  let requestNormalization: RewriteResult["requestNormalization"];

  if (isOpenAiApi(params.api)) {
    const normalizedInput = dedupeOpenAiProviderInput(jsonBody);
    jsonBody = normalizedInput.jsonBody;
    requestNormalization = normalizedInput.requestNormalization;
    bodyChanged = normalizedInput.changed;

    const requestedSessionId = pickSessionId(headers, jsonBody, params.fallbackSessionId);
    const sessionId = params.openai.overrideSessionId ?? requestedSessionId;
    openaiSessionId = sessionId;

    if (params.openai.injectPromptCacheKey) {
      if (jsonBody?.prompt_cache_key !== sessionId) {
        jsonBody = { ...jsonBody, prompt_cache_key: sessionId };
        bodyChanged = true;
      }
    }
    if (params.openai.injectSessionIdHeader) {
      if (headers.get("session_id") !== sessionId) {
        headers.set("session_id", sessionId);
      }
      if (headers.get("x-session-id") !== sessionId) {
        headers.set("x-session-id", sessionId);
      }
    }
  }

  if (isAnthropicApi(params.api) && params.anthropic.injectMetadataUserId && jsonBody) {
    const metadataRaw = jsonBody.metadata;
    const metadata =
      metadataRaw && typeof metadataRaw === "object" && !Array.isArray(metadataRaw)
        ? { ...(metadataRaw as Record<string, unknown>) }
        : {};
    if (metadata.user_id === undefined) {
      metadata.user_id = params.anthropic.userId ?? params.stableUserId;
      jsonBody = { ...jsonBody, metadata };
      bodyChanged = true;
    }
  }

  const bodyBuffer =
    bodyChanged && jsonBody ? Buffer.from(JSON.stringify(jsonBody)) : Buffer.from(params.rawBody);

  return {
    headers,
    bodyBuffer,
    jsonBody,
    openaiSessionId,
    requestNormalization,
  };
}
