import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createPersistedSessionRecoveryTracker,
  resolveSessionRecoveryStatePath,
  SESSION_OVERLOAD_COOLDOWN_MS,
} from "./session-recovery.js";

const UUID_V7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("createPersistedSessionRecoveryTracker", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("persists poisoned session recovery mappings across tracker reloads", async () => {
    const stateDir = await createStateDir(tempDirs);
    let now = 1_000;
    const tracker = await createPersistedSessionRecoveryTracker({
      stateDir,
      fallbackSessionId: "session-stable",
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      now: () => now,
    });

    await tracker.noteOutcome({
      requestedSessionId: "session-poisoned",
      effectiveSessionId: "session-poisoned",
      outcome: "overloaded",
    });
    await tracker.noteOutcome({
      requestedSessionId: "session-poisoned",
      effectiveSessionId: "session-poisoned",
      outcome: "overloaded",
    });

    const recoverySessionId = tracker.selectSessionId("session-poisoned");
    expect(recoverySessionId).toMatch(UUID_V7_RE);
    expect(recoverySessionId).not.toMatch(/session|recover|openclaw/i);
    await tracker.flush();

    const reloaded = await createPersistedSessionRecoveryTracker({
      stateDir,
      fallbackSessionId: "session-stable",
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      now: () => now,
    });

    expect(reloaded.selectSessionId("session-poisoned")).toBe(recoverySessionId);
  });

  it("invalidates persisted poisoned mappings after a successful recovery attempt", async () => {
    const stateDir = await createStateDir(tempDirs);
    const tracker = await createPersistedSessionRecoveryTracker({
      stateDir,
      fallbackSessionId: "session-stable",
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });

    await tracker.noteOutcome({
      requestedSessionId: "session-poisoned",
      effectiveSessionId: "session-poisoned",
      outcome: "overloaded",
    });
    await tracker.noteOutcome({
      requestedSessionId: "session-poisoned",
      effectiveSessionId: "session-poisoned",
      outcome: "overloaded",
    });

    const recoverySessionId = tracker.selectSessionId("session-poisoned");
    await tracker.noteOutcome({
      requestedSessionId: "session-poisoned",
      effectiveSessionId: recoverySessionId,
      outcome: "success",
    });
    await tracker.flush();

    const reloaded = await createPersistedSessionRecoveryTracker({
      stateDir,
      fallbackSessionId: "session-stable",
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });

    expect(reloaded.selectSessionId("session-poisoned")).toBe("session-poisoned");

    const contents = JSON.parse(
      await readFile(resolveSessionRecoveryStatePath(stateDir), "utf8"),
    ) as { entries: Record<string, { recoverySessionId?: string; lastSuccessAt?: number }> };
    expect(contents.entries["session-poisoned"]).toMatchObject({
      lastSuccessAt: expect.any(Number),
    });
    expect(contents.entries["session-poisoned"]?.recoverySessionId).toBeUndefined();
  });

  it("prunes stale recovery entries once their cooldown expires", async () => {
    const stateDir = await createStateDir(tempDirs);
    let now = 10_000;
    const tracker = await createPersistedSessionRecoveryTracker({
      stateDir,
      fallbackSessionId: "session-stable",
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      now: () => now,
    });

    await tracker.noteOutcome({
      requestedSessionId: "session-poisoned",
      effectiveSessionId: "session-poisoned",
      outcome: "overloaded",
    });
    await tracker.noteOutcome({
      requestedSessionId: "session-poisoned",
      effectiveSessionId: "session-poisoned",
      outcome: "overloaded",
    });
    await tracker.flush();

    now += SESSION_OVERLOAD_COOLDOWN_MS + 1;
    expect(tracker.selectSessionId("session-poisoned")).toBe("session-poisoned");
    await tracker.flush();

    const contents = JSON.parse(
      await readFile(resolveSessionRecoveryStatePath(stateDir), "utf8"),
    ) as { entries: Record<string, unknown> };
    expect(contents.entries).not.toHaveProperty("session-poisoned");
  });
});

async function createStateDir(tempDirs: string[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "openclaw-customprovider-cache-recovery-"));
  tempDirs.push(dir);
  return dir;
}
