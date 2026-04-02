import { createHash } from "node:crypto";

import type { NormalizationLedger } from "./normalization-ledger.js";
import type {
  ForwardedRequestLogRecord,
  NormalizedPluginConfig,
  ProviderApi,
} from "./types.js";

type RewriteParams = {
  provider: string;
  api: ProviderApi;
  headers: Headers;
  rawBody: Buffer;
  stableUserId: string;
  fallbackSessionId: string;
  openai: NormalizedPluginConfig["openai"] & {
    overrideSessionId?: string;
  };
  anthropic: NormalizedPluginConfig["anthropic"];
  normalizationLedger?: NormalizationLedger;
};

export type RewriteResult = {
  headers: Headers;
  bodyBuffer: Buffer;
  jsonBody?: Record<string, unknown>;
  openaiSessionId?: string;
  requestNormalization?: ForwardedRequestLogRecord["requestNormalization"];
};

type RequestNormalization = NonNullable<RewriteResult["requestNormalization"]>;

function isRsProviderInputItem(value: unknown): value is Record<string, unknown> & { id: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  return typeof (value as { id?: unknown }).id === "string" && /^rs_/.test((value as { id: string }).id);
}

function isAssistantMessageItem(
  value: unknown,
): value is Record<string, unknown> & { role: "assistant"; type?: "message"; phase?: unknown } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const item = value as { role?: unknown; type?: unknown };
  if (item.role !== "assistant") {
    return false;
  }

  return item.type === undefined || item.type === "message";
}

function isFunctionCallItem(
  value: unknown,
): value is Record<string, unknown> & { type: "function_call"; call_id: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const item = value as { type?: unknown; call_id?: unknown };
  return item.type === "function_call" && typeof item.call_id === "string" && item.call_id.trim().length > 0;
}

function isFunctionCallOutputItem(
  value: unknown,
): value is Record<string, unknown> & { type: "function_call_output"; call_id: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const item = value as { type?: unknown; call_id?: unknown };
  return (
    item.type === "function_call_output" &&
    typeof item.call_id === "string" &&
    item.call_id.trim().length > 0
  );
}

function collectTextParts(value: unknown, parts: string[]): void {
  if (typeof value === "string") {
    parts.push(value);
    return;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      collectTextParts(entry, parts);
    }
    return;
  }

  if (!value || typeof value !== "object") {
    return;
  }

  for (const entry of Object.values(value)) {
    collectTextParts(entry, parts);
  }
}

function extractAssistantMessageText(item: Record<string, unknown>): string {
  const parts: string[] = [];
  collectTextParts(item.content, parts);
  return parts.join("\n").trim();
}

function isPseudoToolArtifactText(text: string): boolean {
  const normalized = text.trimStart();
  return (
    /^to=[a-z0-9_.:-]+(?:\s+[^\n]*)?\/json\b/im.test(normalized) ||
    /^<(tool|function)\b/i.test(normalized)
  );
}

function isJsonArtifactText(text: string): boolean {
  const normalized = text.trim();
  if (!(normalized.startsWith("{") || normalized.startsWith("["))) {
    return false;
  }

  try {
    const parsed = JSON.parse(normalized) as unknown;
    return typeof parsed === "object" && parsed !== null;
  } catch {
    return false;
  }
}

function mergeRequestNormalization(
  ...parts: Array<RequestNormalization | undefined>
): RequestNormalization | undefined {
  let hasData = false;
  const droppedDuplicateProviderInputIds = new Set<string>();
  let droppedDuplicateProviderInputCount = 0;
  let droppedOrphanFunctionCallOutputCount = 0;
  const droppedOrphanFunctionCallOutputCallIds: string[] = [];
  let scrubbedAssistantReplayCount = 0;
  const scrubbedAssistantReplayRules: string[] = [];
  let normalizationKey: string | undefined;
  let normalizationReplaySource: "fresh" | "persisted" | undefined;
  let requestedSessionId: string | undefined;
  let effectiveSessionId: string | undefined;
  let effectivePromptCacheKey: string | undefined;
  let recoverySessionOverrideApplied: boolean | undefined;

  for (const part of parts) {
    if (!part) {
      continue;
    }

    hasData = true;
    for (const id of part.droppedDuplicateProviderInputIds) {
      droppedDuplicateProviderInputIds.add(id);
    }
    droppedDuplicateProviderInputCount += part.droppedDuplicateProviderInputCount;

    if (part.scrubbedAssistantReplayCount) {
      scrubbedAssistantReplayCount += part.scrubbedAssistantReplayCount;
    }
    for (const rule of part.scrubbedAssistantReplayRules ?? []) {
      if (!scrubbedAssistantReplayRules.includes(rule)) {
        scrubbedAssistantReplayRules.push(rule);
      }
    }
    if (part.droppedOrphanFunctionCallOutputCount) {
      droppedOrphanFunctionCallOutputCount += part.droppedOrphanFunctionCallOutputCount;
    }
    for (const callId of part.droppedOrphanFunctionCallOutputCallIds ?? []) {
      if (!droppedOrphanFunctionCallOutputCallIds.includes(callId)) {
        droppedOrphanFunctionCallOutputCallIds.push(callId);
      }
    }
    normalizationKey = part.normalizationKey ?? normalizationKey;
    normalizationReplaySource = part.normalizationReplaySource ?? normalizationReplaySource;
    requestedSessionId = part.requestedSessionId ?? requestedSessionId;
    effectiveSessionId = part.effectiveSessionId ?? effectiveSessionId;
    effectivePromptCacheKey = part.effectivePromptCacheKey ?? effectivePromptCacheKey;
    recoverySessionOverrideApplied =
      part.recoverySessionOverrideApplied ?? recoverySessionOverrideApplied;
  }

  if (!hasData) {
    return undefined;
  }

  return {
    droppedDuplicateProviderInputIds: [...droppedDuplicateProviderInputIds],
    droppedDuplicateProviderInputCount,
    ...(droppedOrphanFunctionCallOutputCount > 0
      ? {
          droppedOrphanFunctionCallOutputCount,
          droppedOrphanFunctionCallOutputCallIds,
        }
      : {}),
    ...(scrubbedAssistantReplayCount > 0
      ? {
          scrubbedAssistantReplayCount,
          scrubbedAssistantReplayRules,
        }
      : {}),
    ...(normalizationKey ? { normalizationKey } : {}),
    ...(normalizationReplaySource ? { normalizationReplaySource } : {}),
    ...(requestedSessionId ? { requestedSessionId } : {}),
    ...(effectiveSessionId ? { effectiveSessionId } : {}),
    ...(effectivePromptCacheKey ? { effectivePromptCacheKey } : {}),
    ...(recoverySessionOverrideApplied ? { recoverySessionOverrideApplied } : {}),
  };
}

function sortStableValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sortStableValue(entry));
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== "prompt_cache_key")
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, sortStableValue(entry)]),
  );
}

function buildNormalizationKey(
  body: Record<string, unknown> | undefined,
  requestedSessionId: string,
  effectiveSessionId: string,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        requestedSessionId,
        effectiveSessionId,
        body: sortStableValue(body),
      }),
    )
    .digest("hex");
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

function scrubOpenAiAssistantReplay(
  body: Record<string, unknown> | undefined,
  enabled: boolean,
): {
  jsonBody: Record<string, unknown> | undefined;
  changed: boolean;
  requestNormalization?: RewriteResult["requestNormalization"];
} {
  if (!enabled) {
    return { jsonBody: body, changed: false };
  }

  const input = body?.input;
  if (!Array.isArray(input)) {
    return { jsonBody: body, changed: false };
  }

  let scrubbedAssistantReplayCount = 0;
  const scrubbedAssistantReplayRules: string[] = [];
  let expectAdjacentJsonArtifact = false;
  const normalizedInput = input.filter((item) => {
    if (!isAssistantMessageItem(item)) {
      expectAdjacentJsonArtifact = false;
      return true;
    }

    if (item.phase === "final_answer") {
      expectAdjacentJsonArtifact = false;
      return true;
    }

    const text = extractAssistantMessageText(item);

    if (item.phase === "commentary") {
      scrubbedAssistantReplayCount += 1;
      if (!scrubbedAssistantReplayRules.includes("phase-commentary")) {
        scrubbedAssistantReplayRules.push("phase-commentary");
      }
      expectAdjacentJsonArtifact = isPseudoToolArtifactText(text);
      return false;
    }

    if (isPseudoToolArtifactText(text)) {
      scrubbedAssistantReplayCount += 1;
      if (!scrubbedAssistantReplayRules.includes("pseudo-tool-artifact")) {
        scrubbedAssistantReplayRules.push("pseudo-tool-artifact");
      }
      expectAdjacentJsonArtifact = true;
      return false;
    }

    if (expectAdjacentJsonArtifact && isJsonArtifactText(text)) {
      scrubbedAssistantReplayCount += 1;
      if (!scrubbedAssistantReplayRules.includes("pseudo-tool-artifact")) {
        scrubbedAssistantReplayRules.push("pseudo-tool-artifact");
      }
      expectAdjacentJsonArtifact = false;
      return false;
    }

    expectAdjacentJsonArtifact = false;
    return true;
  });

  if (scrubbedAssistantReplayCount === 0) {
    return { jsonBody: body, changed: false };
  }

  return {
    jsonBody: { ...body, input: normalizedInput },
    changed: true,
    requestNormalization: {
      droppedDuplicateProviderInputIds: [],
      droppedDuplicateProviderInputCount: 0,
      scrubbedAssistantReplayCount,
      scrubbedAssistantReplayRules,
    },
  };
}

function dropOrphanFunctionCallOutputs(
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

  const seenFunctionCallIds = new Set<string>();
  let droppedOrphanFunctionCallOutputCount = 0;
  const droppedOrphanFunctionCallOutputCallIds: string[] = [];
  const normalizedInput = input.filter((item) => {
    if (isFunctionCallItem(item)) {
      seenFunctionCallIds.add(item.call_id);
      return true;
    }

    if (!isFunctionCallOutputItem(item)) {
      return true;
    }

    if (seenFunctionCallIds.has(item.call_id)) {
      return true;
    }

    droppedOrphanFunctionCallOutputCount += 1;
    droppedOrphanFunctionCallOutputCallIds.push(item.call_id);
    return false;
  });

  if (droppedOrphanFunctionCallOutputCount === 0) {
    return { jsonBody: body, changed: false };
  }

  return {
    jsonBody: { ...body, input: normalizedInput },
    changed: true,
    requestNormalization: {
      droppedDuplicateProviderInputIds: [],
      droppedDuplicateProviderInputCount: 0,
      droppedOrphanFunctionCallOutputCount,
      droppedOrphanFunctionCallOutputCallIds: [...new Set(droppedOrphanFunctionCallOutputCallIds)],
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
    const requestedSessionId = pickSessionId(headers, jsonBody, params.fallbackSessionId);
    const sessionId = params.openai.overrideSessionId ?? requestedSessionId;
    const normalizationKey = buildNormalizationKey(jsonBody, requestedSessionId, sessionId);
    const replayedDecision = params.normalizationLedger?.lookup({
      requestedSessionId,
      normalizationKey,
    });

    if (replayedDecision) {
      jsonBody = JSON.parse(replayedDecision.normalizedBody) as Record<string, unknown>;
      openaiSessionId = replayedDecision.effectiveSessionId;
      requestNormalization = mergeRequestNormalization(replayedDecision.requestNormalization, {
        droppedDuplicateProviderInputIds: [],
        droppedDuplicateProviderInputCount: 0,
        normalizationKey,
        normalizationReplaySource: "persisted",
        requestedSessionId,
        effectiveSessionId: replayedDecision.effectiveSessionId,
        effectivePromptCacheKey: replayedDecision.effectivePromptCacheKey,
        recoverySessionOverrideApplied:
          replayedDecision.effectiveSessionId !== requestedSessionId ? true : undefined,
      });

      if (params.openai.injectSessionIdHeader) {
        headers.set("session_id", replayedDecision.effectiveSessionId);
        headers.set("x-session-id", replayedDecision.effectiveSessionId);
      }

      return {
        headers,
        bodyBuffer: Buffer.from(replayedDecision.normalizedBody),
        jsonBody,
        openaiSessionId,
        requestNormalization,
      };
    }

    const normalizedInput = dedupeOpenAiProviderInput(jsonBody);
    jsonBody = normalizedInput.jsonBody;
    requestNormalization = normalizedInput.requestNormalization;
    bodyChanged = normalizedInput.changed;

    const scrubbedReplay = scrubOpenAiAssistantReplay(
      jsonBody,
      params.openai.scrubAssistantCommentaryReplay,
    );
    jsonBody = scrubbedReplay.jsonBody;
    requestNormalization = mergeRequestNormalization(
      requestNormalization,
      scrubbedReplay.requestNormalization,
    );
    bodyChanged = bodyChanged || scrubbedReplay.changed;

    const orphanedOutputs = dropOrphanFunctionCallOutputs(jsonBody);
    jsonBody = orphanedOutputs.jsonBody;
    requestNormalization = mergeRequestNormalization(
      requestNormalization,
      orphanedOutputs.requestNormalization,
    );
    bodyChanged = bodyChanged || orphanedOutputs.changed;

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

    requestNormalization = mergeRequestNormalization(requestNormalization, {
      droppedDuplicateProviderInputIds: [],
      droppedDuplicateProviderInputCount: 0,
      normalizationKey,
      normalizationReplaySource: "fresh",
      requestedSessionId,
      effectiveSessionId: sessionId,
      effectivePromptCacheKey:
        typeof jsonBody?.prompt_cache_key === "string" ? jsonBody.prompt_cache_key : undefined,
      recoverySessionOverrideApplied:
        params.openai.overrideSessionId && params.openai.overrideSessionId !== requestedSessionId
          ? true
          : undefined,
    });
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

  if (isOpenAiApi(params.api) && params.normalizationLedger && jsonBody && openaiSessionId) {
    await params.normalizationLedger.record({
      requestedSessionId: requestNormalization?.requestedSessionId ?? openaiSessionId,
      normalizationKey: requestNormalization?.normalizationKey ?? buildNormalizationKey(
        jsonBody,
        requestNormalization?.requestedSessionId ?? openaiSessionId,
        openaiSessionId,
      ),
      effectiveSessionId: openaiSessionId,
      effectivePromptCacheKey:
        typeof jsonBody.prompt_cache_key === "string" ? jsonBody.prompt_cache_key : undefined,
      normalizedBody: bodyBuffer.toString("utf8"),
      requestNormalization,
    });
  }

  return {
    headers,
    bodyBuffer,
    jsonBody,
    openaiSessionId,
    requestNormalization,
  };
}
