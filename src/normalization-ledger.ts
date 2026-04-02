import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { resolvePluginStateDir } from "./session-recovery.js";
import type { ForwardedRequestLogRecord, PluginLogger } from "./types.js";

const NORMALIZATION_LEDGER_FILE = "normalization-ledger.json";
const NORMALIZATION_LEDGER_VERSION = 1;
const NORMALIZATION_LEDGER_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_LEDGER_ENTRIES = 256;
const MAX_SESSION_LEDGER_ENTRIES = 24;

export type NormalizationLedgerEntry = {
  requestedSessionId: string;
  normalizationKey: string;
  effectiveSessionId: string;
  effectivePromptCacheKey?: string;
  normalizedBody: string;
  requestNormalization?: ForwardedRequestLogRecord["requestNormalization"];
  updatedAt: number;
};

type StoredNormalizationLedger = {
  version: 1;
  entries: NormalizationLedgerEntry[];
};

export type NormalizationLedger = {
  lookup: (params: {
    requestedSessionId: string;
    normalizationKey: string;
  }) => NormalizationLedgerEntry | undefined;
  record: (entry: Omit<NormalizationLedgerEntry, "updatedAt">) => Promise<void>;
  flush: () => Promise<void>;
};

function resolveNormalizationLedgerPath(stateDir: string): string {
  return path.join(resolvePluginStateDir(stateDir), NORMALIZATION_LEDGER_FILE);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function parseEntry(value: unknown): NormalizationLedgerEntry | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.requestedSessionId !== "string" ||
    typeof candidate.normalizationKey !== "string" ||
    typeof candidate.effectiveSessionId !== "string" ||
    typeof candidate.normalizedBody !== "string" ||
    !isFiniteNumber(candidate.updatedAt)
  ) {
    return undefined;
  }

  return {
    requestedSessionId: candidate.requestedSessionId,
    normalizationKey: candidate.normalizationKey,
    effectiveSessionId: candidate.effectiveSessionId,
    effectivePromptCacheKey:
      typeof candidate.effectivePromptCacheKey === "string"
        ? candidate.effectivePromptCacheKey
        : undefined,
    normalizedBody: candidate.normalizedBody,
    requestNormalization: candidate.requestNormalization as
      | ForwardedRequestLogRecord["requestNormalization"]
      | undefined,
    updatedAt: candidate.updatedAt,
  };
}

function pruneEntries(entries: Map<string, NormalizationLedgerEntry>, now: number): void {
  for (const [key, entry] of entries.entries()) {
    if (entry.updatedAt + NORMALIZATION_LEDGER_TTL_MS <= now) {
      entries.delete(key);
    }
  }

  const sortedEntries = [...entries.entries()].sort(
    (left, right) => right[1].updatedAt - left[1].updatedAt,
  );
  const seenPerSession = new Map<string, number>();

  sortedEntries.forEach(([key, entry], index) => {
    const sessionCount = seenPerSession.get(entry.requestedSessionId) ?? 0;
    if (index >= MAX_LEDGER_ENTRIES || sessionCount >= MAX_SESSION_LEDGER_ENTRIES) {
      entries.delete(key);
      return;
    }
    seenPerSession.set(entry.requestedSessionId, sessionCount + 1);
  });
}

async function loadEntries(stateDir: string, logger: PluginLogger, now: number): Promise<Map<string, NormalizationLedgerEntry>> {
  const ledgerPath = resolveNormalizationLedgerPath(stateDir);
  let stored: StoredNormalizationLedger | undefined;

  try {
    stored = JSON.parse(await readFile(ledgerPath, "utf8")) as StoredNormalizationLedger;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/ENOENT/i.test(message)) {
      logger.warn(`openclaw-customprovider-cache ignored unreadable normalization ledger: ${message}`);
    }
    return new Map();
  }

  if (stored?.version !== NORMALIZATION_LEDGER_VERSION || !Array.isArray(stored.entries)) {
    logger.warn("openclaw-customprovider-cache ignored normalization ledger with unsupported schema");
    return new Map();
  }

  const entries = new Map<string, NormalizationLedgerEntry>();
  for (const value of stored.entries) {
    const entry = parseEntry(value);
    if (entry) {
      entries.set(`${entry.requestedSessionId}:${entry.normalizationKey}`, entry);
    }
  }
  pruneEntries(entries, now);
  return entries;
}

async function persistEntries(
  stateDir: string,
  entries: Map<string, NormalizationLedgerEntry>,
): Promise<void> {
  const ledgerPath = resolveNormalizationLedgerPath(stateDir);
  const tempPath = `${ledgerPath}.${Date.now()}.tmp`;
  await mkdir(resolvePluginStateDir(stateDir), { recursive: true });

  try {
    const payload: StoredNormalizationLedger = {
      version: NORMALIZATION_LEDGER_VERSION,
      entries: [...entries.values()].sort((left, right) => right.updatedAt - left.updatedAt),
    };
    await writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    await rename(tempPath, ledgerPath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function createPersistedNormalizationLedger(params: {
  stateDir: string;
  logger: PluginLogger;
  now?: () => number;
}): Promise<NormalizationLedger> {
  const now = params.now ?? Date.now;
  const entries = await loadEntries(params.stateDir, params.logger, now());
  let writeChain = Promise.resolve();

  const schedulePersist = (): Promise<void> => {
    writeChain = writeChain.then(async () => {
      try {
        pruneEntries(entries, now());
        await persistEntries(params.stateDir, entries);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        params.logger.warn(
          `openclaw-customprovider-cache failed to persist normalization ledger: ${message}`,
        );
      }
    });
    return writeChain;
  };

  return {
    lookup({ requestedSessionId, normalizationKey }) {
      pruneEntries(entries, now());
      return entries.get(`${requestedSessionId}:${normalizationKey}`);
    },
    async record(entry) {
      entries.set(`${entry.requestedSessionId}:${entry.normalizationKey}`, {
        ...entry,
        updatedAt: now(),
      });
      await schedulePersist();
    },
    flush() {
      return schedulePersist();
    },
  };
}
