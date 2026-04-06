import { createHash, randomUUID } from "node:crypto";

function hashBytes(seed: string): Uint8Array {
  return createHash("sha256").update(seed).digest().subarray(0, 16);
}

function formatUuid(bytes: Uint8Array): string {
  const hex = Buffer.from(bytes).toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

function applyUuidLayout(bytes: Uint8Array, version: 4 | 7): string {
  const next = Uint8Array.from(bytes);
  next[6] = (next[6] & 0x0f) | (version << 4);
  next[8] = (next[8] & 0x3f) | 0x80;
  return formatUuid(next);
}

function normalizeIdentitySalt(prefix: string): string {
  return prefix.trim().replace(/\s+/g, "-").replace(/[^a-zA-Z0-9_-]+/g, "-") || "identity";
}

export function createStableAnthropicUserId(prefix: string, installationId: string): string {
  const seed = `${normalizeIdentitySalt(prefix)}:${installationId}:anthropic-user`;
  return applyUuidLayout(hashBytes(seed), 4);
}

export function createStableOpenAiSessionId(prefix: string, installationId: string): string {
  const seed = `${normalizeIdentitySalt(prefix)}:${installationId}:openai-session`;
  return applyUuidLayout(hashBytes(seed), 7);
}

export function createRecoveryOpenAiSessionId(fallbackSessionId: string): string {
  return applyUuidLayout(hashBytes(`${fallbackSessionId}:${randomUUID()}`), 7);
}
