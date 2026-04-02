import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { resolvePluginStateDir } from "./session-recovery.js";
import type { CorrelationEnvelope, PluginLogger, ProviderApi } from "./types.js";

const ATTEMPT_LEDGER_FILE = "abandoned-attempts.json";
const ATTEMPT_LEDGER_VERSION = 1;
const MAX_ATTEMPT_LEDGER_ENTRIES = 100;

export type AbandonedAttemptEntry = {
  attemptId: string;
  requestId?: string;
  provider: string;
  api: ProviderApi;
  url: string;
  semanticState: string;
  abandonedAt: string;
  errorPolicyKind?: string;
  correlation?: CorrelationEnvelope;
};

type StoredAttemptLedger = {
  version: 1;
  entries: AbandonedAttemptEntry[];
};

export type AttemptLedger = {
  recordAbandoned: (entry: Omit<AbandonedAttemptEntry, "abandonedAt">) => Promise<void>;
  flush: () => Promise<void>;
};

function resolveAttemptLedgerPath(stateDir: string): string {
  return path.join(resolvePluginStateDir(stateDir), ATTEMPT_LEDGER_FILE);
}

async function loadEntries(stateDir: string, logger: PluginLogger): Promise<AbandonedAttemptEntry[]> {
  try {
    const stored = JSON.parse(
      await readFile(resolveAttemptLedgerPath(stateDir), "utf8"),
    ) as StoredAttemptLedger;
    if (stored?.version !== ATTEMPT_LEDGER_VERSION || !Array.isArray(stored.entries)) {
      logger.warn("openclaw-customprovider-cache ignored attempt ledger with unsupported schema");
      return [];
    }
    return stored.entries.slice(0, MAX_ATTEMPT_LEDGER_ENTRIES);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      logger.warn(
        `openclaw-customprovider-cache ignored unreadable attempt ledger: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return [];
  }
}

async function persistEntries(stateDir: string, entries: AbandonedAttemptEntry[]): Promise<void> {
  const ledgerPath = resolveAttemptLedgerPath(stateDir);
  const tempPath = `${ledgerPath}.${Date.now()}.tmp`;
  await mkdir(resolvePluginStateDir(stateDir), { recursive: true });
  try {
    const payload: StoredAttemptLedger = {
      version: ATTEMPT_LEDGER_VERSION,
      entries: entries.slice(0, MAX_ATTEMPT_LEDGER_ENTRIES),
    };
    await writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    await rename(tempPath, ledgerPath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function createPersistedAttemptLedger(params: {
  stateDir: string;
  logger: PluginLogger;
}): Promise<AttemptLedger> {
  const entries = await loadEntries(params.stateDir, params.logger);
  let writeChain = Promise.resolve();

  const schedulePersist = (): Promise<void> => {
    writeChain = writeChain.then(async () => {
      try {
        await persistEntries(params.stateDir, entries);
      } catch (error) {
        params.logger.warn(
          `openclaw-customprovider-cache failed to persist attempt ledger: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    });
    return writeChain;
  };

  return {
    async recordAbandoned(entry) {
      entries.unshift({
        ...entry,
        abandonedAt: new Date().toISOString(),
      });
      entries.splice(MAX_ATTEMPT_LEDGER_ENTRIES);
      await schedulePersist();
    },
    flush() {
      return schedulePersist();
    },
  };
}
