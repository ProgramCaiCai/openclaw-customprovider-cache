import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { withDevVcrFixture } from "./dev-vcr.js";

describe("withDevVcrFixture", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("records sanitized plugin fixtures and replays them deterministically", async () => {
    const fixtureRoot = await createStateDir(tempDirs);
    const input = {
      provider: "openai",
      api: "openai-responses",
      request: {
        url: "https://example.test/v1/responses",
        headers: {
          authorization: "Bearer secret-token",
        },
      },
    };

    const recorded = await withDevVcrFixture({
      fixtureRoot,
      fixtureName: "broken-stream",
      input,
      mode: "record",
      build: async () => ({
        request: input.request,
        response: {
          status: 200,
          headers: {
            "x-api-key": "sk-live-secret",
          },
          streamChunks: ['data: {"type":"response.failed"}\n\n'],
        },
        semanticSummary: {
          semanticState: "error",
          streamIntegrity: {
            malformedEventCount: 1,
            ignoredJsonParseFailureCount: 1,
          },
        },
      }),
    });

    expect(recorded).toMatchObject({
      request: {
        headers: {
          authorization: "[REDACTED]",
        },
      },
      response: {
        headers: {
          "x-api-key": "[REDACTED]",
        },
      },
    });

    const replayed = await withDevVcrFixture({
      fixtureRoot,
      fixtureName: "broken-stream",
      input,
      mode: "replay",
      build: async () => {
        throw new Error("should not rebuild");
      },
    });

    expect(replayed).toEqual(recorded);

    const [fixtureFile] = (await readFileNames(fixtureRoot)).filter((name) =>
      name.startsWith("broken-stream-"),
    );
    const contents = JSON.parse(
      await readFile(join(fixtureRoot, fixtureFile ?? "missing"), "utf8"),
    ) as { output: { request: { headers: { authorization: string } } } };
    expect(contents.output.request.headers.authorization).toBe("[REDACTED]");
  });

  it("fails replay mode when the fixture is missing", async () => {
    const fixtureRoot = await createStateDir(tempDirs);

    await expect(
      withDevVcrFixture({
        fixtureRoot,
        fixtureName: "missing-fixture",
        input: { requestId: "req-1" },
        mode: "replay",
        build: async () => ({ ok: true }),
      }),
    ).rejects.toThrow(/Missing VCR fixture/);
  });
});

async function createStateDir(tempDirs: string[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "openclaw-customprovider-cache-vcr-"));
  tempDirs.push(dir);
  return dir;
}

async function readFileNames(dir: string): Promise<string[]> {
  const fs = await import("node:fs/promises");
  return fs.readdir(dir);
}
