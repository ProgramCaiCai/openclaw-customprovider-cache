import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { PluginLogger } from "./types.js";
import { createRecoveryOpenAiSessionId } from "./uuid-identity.js";

const PLUGIN_STATE_DIR = path.join("plugins", "session-metadata-proxy");
const SESSION_RECOVERY_STATE_FILE = "session-recovery-state.json";
const SESSION_RECOVERY_STATE_VERSION = 1;
const SESSION_OVERLOAD_THRESHOLD = 2;

type SessionRecoveryEntry = {
  failureCount: number;
  lastFailureAt: number;
  lastSuccessAt?: number;
  poisonedUntil?: number;
  recoverySessionId?: string;
};

type StoredSessionRecoveryState = {
  version: 1;
  entries: Record<string, SessionRecoveryEntry>;
};

export type SessionRecoveryOutcome = "success" | "overloaded";

export type SessionRecoveryTracker = {
  selectSessionId: (sessionId: string) => string;
  noteOutcome: (params: {
    requestedSessionId: string;
    effectiveSessionId: string;
    outcome: SessionRecoveryOutcome | undefined;
  }) => Promise<void>;
  flush: () => Promise<void>;
};

export const SESSION_OVERLOAD_COOLDOWN_MS = 10 * 60 * 1000;

export function resolvePluginStateDir(stateDir: string): string {
  return path.join(stateDir, PLUGIN_STATE_DIR);
}

export function resolveSessionRecoveryStatePath(stateDir: string): string {
  return path.join(resolvePluginStateDir(stateDir), SESSION_RECOVERY_STATE_FILE);
}

function createRecoverySessionId(fallbackSessionId: string): string {
  return createRecoveryOpenAiSessionId(fallbackSessionId);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function parseEntry(value: unknown): SessionRecoveryEntry | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const candidate = value as Record<string, unknown>;
  if (!isFiniteNumber(candidate.failureCount) || !isFiniteNumber(candidate.lastFailureAt)) {
    return undefined;
  }

  const entry: SessionRecoveryEntry = {
    failureCount: candidate.failureCount,
    lastFailureAt: candidate.lastFailureAt,
  };
  if (isFiniteNumber(candidate.lastSuccessAt)) {
    entry.lastSuccessAt = candidate.lastSuccessAt;
  }
  if (isFiniteNumber(candidate.poisonedUntil)) {
    entry.poisonedUntil = candidate.poisonedUntil;
  }
  if (typeof candidate.recoverySessionId === "string" && candidate.recoverySessionId.trim()) {
    entry.recoverySessionId = candidate.recoverySessionId.trim();
  }
  return entry;
}

function pruneExpiredEntries(
  entries: Map<string, SessionRecoveryEntry>,
  now: number,
): boolean {
  let mutated = false;
  for (const [sessionId, entry] of entries.entries()) {
    const freshnessDeadline = Math.max(
      entry.poisonedUntil ?? 0,
      entry.lastFailureAt + SESSION_OVERLOAD_COOLDOWN_MS,
      entry.lastSuccessAt ?? 0,
    );
    if (freshnessDeadline > now) {
      continue;
    }
    entries.delete(sessionId);
    mutated = true;
  }
  return mutated;
}

async function loadEntries(stateDir: string, logger: PluginLogger, now: number): Promise<Map<string, SessionRecoveryEntry>> {
  const statePath = resolveSessionRecoveryStatePath(stateDir);
  let stored: StoredSessionRecoveryState | undefined;

  try {
    stored = JSON.parse(await readFile(statePath, "utf8")) as StoredSessionRecoveryState;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/ENOENT/i.test(message)) {
      logger.warn(`openclaw-customprovider-cache ignored unreadable recovery state: ${message}`);
    }
    return new Map();
  }

  if (stored?.version !== SESSION_RECOVERY_STATE_VERSION || !stored.entries) {
    logger.warn("openclaw-customprovider-cache ignored recovery state with unsupported schema");
    return new Map();
  }

  const entries = new Map<string, SessionRecoveryEntry>();
  for (const [sessionId, value] of Object.entries(stored.entries)) {
    const entry = parseEntry(value);
    if (entry) {
      entries.set(sessionId, entry);
    }
  }
  pruneExpiredEntries(entries, now);
  return entries;
}

async function persistEntries(
  stateDir: string,
  entries: Map<string, SessionRecoveryEntry>,
): Promise<void> {
  const dir = resolvePluginStateDir(stateDir);
  const statePath = resolveSessionRecoveryStatePath(stateDir);
  const tempPath = `${statePath}.${randomUUID().replace(/-/g, "")}.tmp`;
  await mkdir(dir, { recursive: true });

  try {
    const payload: StoredSessionRecoveryState = {
      version: SESSION_RECOVERY_STATE_VERSION,
      entries: Object.fromEntries(entries),
    };
    await writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    await rename(tempPath, statePath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function createTracker(params: {
  fallbackSessionId: string;
  entries: Map<string, SessionRecoveryEntry>;
  onMutation?: () => Promise<void>;
  now?: () => number;
}): SessionRecoveryTracker {
  const now = params.now ?? Date.now;
  const schedulePersist = params.onMutation ?? (async () => undefined);

  return {
    selectSessionId(sessionId) {
      if (pruneExpiredEntries(params.entries, now())) {
        void schedulePersist();
      }
      return params.entries.get(sessionId)?.recoverySessionId ?? sessionId;
    },
    async noteOutcome({ requestedSessionId, outcome }) {
      if (!outcome) {
        return;
      }

      const currentTime = now();
      if (pruneExpiredEntries(params.entries, currentTime)) {
        await schedulePersist();
      }

      if (outcome === "success") {
        const entry = params.entries.get(requestedSessionId);
        if (!entry) {
          return;
        }
        entry.failureCount = 0;
        entry.lastSuccessAt = currentTime;
        delete entry.poisonedUntil;
        delete entry.recoverySessionId;
        params.entries.set(requestedSessionId, entry);
        await schedulePersist();
        return;
      }

      const existing = params.entries.get(requestedSessionId);
      const freshEntry =
        existing && existing.lastFailureAt + SESSION_OVERLOAD_COOLDOWN_MS > currentTime
          ? existing
          : { failureCount: 0, lastFailureAt: currentTime };

      freshEntry.failureCount += 1;
      freshEntry.lastFailureAt = currentTime;
      if (freshEntry.failureCount >= SESSION_OVERLOAD_THRESHOLD) {
        freshEntry.poisonedUntil = currentTime + SESSION_OVERLOAD_COOLDOWN_MS;
        freshEntry.recoverySessionId ??= createRecoverySessionId(params.fallbackSessionId);
      }
      params.entries.set(requestedSessionId, freshEntry);
      await schedulePersist();
    },
    flush() {
      return schedulePersist();
    },
  };
}

export function createInMemorySessionRecoveryTracker(
  fallbackSessionId: string,
  now?: () => number,
): SessionRecoveryTracker {
  return createTracker({
    fallbackSessionId,
    entries: new Map(),
    now,
  });
}

export async function createPersistedSessionRecoveryTracker(params: {
  stateDir: string;
  fallbackSessionId: string;
  logger: PluginLogger;
  now?: () => number;
}): Promise<SessionRecoveryTracker> {
  const now = params.now ?? Date.now;
  const entries = await loadEntries(params.stateDir, params.logger, now());
  let writeChain = Promise.resolve();

  const schedulePersist = (): Promise<void> => {
    writeChain = writeChain.then(async () => {
      try {
        pruneExpiredEntries(entries, now());
        await persistEntries(params.stateDir, entries);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        params.logger.warn(`openclaw-customprovider-cache failed to persist recovery state: ${message}`);
      }
    });
    return writeChain;
  };

  return createTracker({
    fallbackSessionId: params.fallbackSessionId,
    entries,
    onMutation: schedulePersist,
    now,
  });
}
