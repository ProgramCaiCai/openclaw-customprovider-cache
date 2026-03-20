import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { PluginLogger, StableIdentity } from "./types.js";

type StoredIdentity = {
  version: 1;
  installationId: string;
};

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function buildStableIdentity(prefix: string, installationId: string): StableIdentity {
  const normalizedPrefix = prefix.trim().replace(/[^a-zA-Z0-9_-]+/g, "-");
  return {
    userId: `${normalizedPrefix}-${installationId}`,
    fallbackSessionId: `${normalizedPrefix}-session-${shortHash(installationId)}`,
  };
}

export async function resolveStableIdentity(params: {
  stateDir: string;
  prefix: string;
  userIdOverride?: string;
  logger: PluginLogger;
}): Promise<StableIdentity> {
  if (params.userIdOverride) {
    return {
      userId: params.userIdOverride,
      fallbackSessionId: `${params.prefix}-session-${shortHash(params.userIdOverride)}`,
    };
  }

  const dir = path.join(params.stateDir, "plugins", "session-metadata-proxy");
  const filePath = path.join(dir, "identity.json");
  await mkdir(dir, { recursive: true });

  let stored: StoredIdentity | undefined;
  try {
    stored = JSON.parse(await readFile(filePath, "utf8")) as StoredIdentity;
  } catch {}

  if (!stored?.installationId) {
    stored = { version: 1, installationId: randomUUID().replaceAll("-", "") };
    await writeFile(filePath, `${JSON.stringify(stored, null, 2)}\n`, "utf8");
    params.logger.info("openclaw-customprovider-cache created a stable installation identity");
  }

  return buildStableIdentity(params.prefix, stored.installationId);
}
