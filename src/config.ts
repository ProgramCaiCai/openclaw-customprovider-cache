import type { NormalizedPluginConfig } from "./types.js";

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function readBoolean(value: unknown, field: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") {
    throw new Error(`${field} must be a boolean`);
  }
  return value;
}

function readOptionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function readStringArray(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error(`${field} must be an array`);
  }
  return value.map((entry, index) => {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      throw new Error(`${field}[${index}] must be a non-empty string`);
    }
    return entry.trim();
  });
}

export function normalizePluginConfig(raw: unknown): NormalizedPluginConfig {
  const value = raw === undefined ? {} : asRecord(raw, "pluginConfig");
  const requestLoggingRaw =
    value.requestLogging === undefined ? {} : asRecord(value.requestLogging, "requestLogging");
  const openaiRaw = value.openai === undefined ? {} : asRecord(value.openai, "openai");
  const anthropicRaw =
    value.anthropic === undefined ? {} : asRecord(value.anthropic, "anthropic");

  return {
    providers: [...new Set(readStringArray(value.providers, "providers"))],
    semanticFailureGating: readBoolean(
      value.semanticFailureGating,
      "semanticFailureGating",
      true,
    ),
    mainLikePostFirstTokenFailureEscalation: readBoolean(
      value.mainLikePostFirstTokenFailureEscalation,
      "mainLikePostFirstTokenFailureEscalation",
      true,
    ),
    subagentResultStopgap: readBoolean(
      value.subagentResultStopgap,
      "subagentResultStopgap",
      true,
    ),
    requestLogging: {
      enabled: readBoolean(requestLoggingRaw.enabled, "requestLogging.enabled", false),
      path: readOptionalString(requestLoggingRaw.path, "requestLogging.path"),
    },
    openai: {
      injectSessionIdHeader: readBoolean(
        openaiRaw.injectSessionIdHeader,
        "openai.injectSessionIdHeader",
        true,
      ),
      injectPromptCacheKey: readBoolean(
        openaiRaw.injectPromptCacheKey,
        "openai.injectPromptCacheKey",
        true,
      ),
      scrubAssistantCommentaryReplay: readBoolean(
        openaiRaw.scrubAssistantCommentaryReplay,
        "openai.scrubAssistantCommentaryReplay",
        true,
      ),
    },
    anthropic: {
      injectMetadataUserId: readBoolean(
        anthropicRaw.injectMetadataUserId,
        "anthropic.injectMetadataUserId",
        true,
      ),
      userId: readOptionalString(anthropicRaw.userId, "anthropic.userId"),
      userIdPrefix:
        readOptionalString(anthropicRaw.userIdPrefix, "anthropic.userIdPrefix") ?? "openclaw",
    },
  };
}
