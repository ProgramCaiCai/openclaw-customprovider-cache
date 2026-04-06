import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveStableIdentity } from "./identity.js";

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UUID_V7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("resolveStableIdentity", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("returns stable UUID-shaped generated identities across reloads", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "openclaw-customprovider-cache-identity-"));
    tempDirs.push(stateDir);

    const first = await resolveStableIdentity({
      stateDir,
      prefix: "openclaw",
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });
    const second = await resolveStableIdentity({
      stateDir,
      prefix: "openclaw",
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });

    expect(first.userId).toMatch(UUID_V4_RE);
    expect(first.userId).not.toMatch(/openclaw/i);
    expect(first.fallbackSessionId).toMatch(UUID_V7_RE);
    expect(first.fallbackSessionId).not.toMatch(/openclaw|session|recover/i);
    expect(second.userId).toBe(first.userId);
    expect(second.fallbackSessionId).toBe(first.fallbackSessionId);
  });
});
