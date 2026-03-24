import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { createForwardedRequestLogger } from "./request-logging.js";

describe("createForwardedRequestLogger", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("keeps captured JSON responses readable", async () => {
    const stateDir = await createStateDir(tempDirs);
    const logger = createForwardedRequestLogger({
      config: { enabled: true },
      stateDir,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });

    await logger?.appendResponse({
      requestId: "req-json",
      provider: "openai",
      api: "openai-responses",
      url: "https://example.test/v1/responses",
      response: new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    });
    await logger?.flush();

    const [line] = await readLines(stateDir);
    expect(line).toMatchObject({
      event: "response",
      requestId: "req-json",
      bodyState: "captured",
      truncated: false,
      body: { ok: true },
    });
    expect(line.semanticState).toBeUndefined();
  });

  it("annotates stream-like transport responses as unknown semantic state", async () => {
    const stateDir = await createStateDir(tempDirs);
    const logger = createForwardedRequestLogger({
      config: { enabled: true },
      stateDir,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });

    await logger?.appendResponse({
      requestId: "req-stream",
      provider: "openai",
      api: "openai-responses",
      url: "https://example.test/v1/responses",
      response: new Response("data: hello\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
      executionClass: "subagent-like",
    });
    await logger?.flush();

    const [line] = await readLines(stateDir);
    expect(line).toMatchObject({
      event: "response",
      requestId: "req-stream",
      bodyState: "stream-like",
      semanticState: "unknown-stream",
      executionClass: "subagent-like",
      truncated: false,
    });
    expect(line.body).toBeUndefined();
  });

  it("normalizes auth transport failures while preserving raw provider payloads", async () => {
    const stateDir = await createStateDir(tempDirs);
    const logger = createForwardedRequestLogger({
      config: { enabled: true },
      stateDir,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });

    await logger?.appendResponse({
      requestId: "req-auth",
      provider: "google",
      api: "google-generative-ai",
      url: "https://example.test/v1beta/models/gemini-2.5-pro:streamGenerateContent",
      response: new Response(
        JSON.stringify({
          error: {
            code: 401,
            status: "UNAUTHENTICATED",
            message: "API key invalid",
          },
        }),
        {
          status: 401,
          headers: { "content-type": "application/json" },
        },
      ),
    });
    await logger?.flush();

    const [line] = await readLines(stateDir);
    expect(line).toMatchObject({
      event: "response",
      requestId: "req-auth",
      status: 401,
      providerStatus: 401,
      normalizedErrorKind: "auth",
      body: {
        error: {
          code: 401,
          status: "UNAUTHENTICATED",
          message: "API key invalid",
        },
      },
    });
  });

  it("writes semantic response summaries with normalized error kinds", async () => {
    const stateDir = await createStateDir(tempDirs);
    const logger = createForwardedRequestLogger({
      config: { enabled: true },
      stateDir,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });

    await logger?.appendResponseSummary({
      requestId: "req-summary",
      provider: "openai",
      api: "openai-responses",
      url: "https://example.test/v1/responses",
      transportStatus: 200,
      semanticState: "error",
      executionClass: "subagent-like",
      semanticError: {
        status: 429,
        code: "RATE_LIMIT",
        message: "quota exhausted upstream",
        providerStatus: 529,
      },
    });
    await logger?.appendResponseSummary({
      requestId: "req-invalid-stream",
      provider: "openai",
      api: "openai-responses",
      url: "https://example.test/v1/responses",
      transportStatus: 200,
      semanticState: "ended-empty",
      executionClass: "subagent-like",
      semanticError: {
        status: 408,
        code: "STREAM_ABORTED",
        message: "stream ended without a terminal success event",
      },
    });
    await logger?.flush();

    const [rateLimitLine, invalidStreamLine] = await readLines(stateDir);
    expect(rateLimitLine).toMatchObject({
      event: "response-summary",
      requestId: "req-summary",
      semanticState: "error",
      executionClass: "subagent-like",
      transportStatus: 200,
      providerStatus: 529,
      normalizedErrorKind: "rate-limit",
      semanticError: {
        status: 429,
        code: "RATE_LIMIT",
        message: "quota exhausted upstream",
        providerStatus: 529,
      },
    });
    expect(invalidStreamLine).toMatchObject({
      event: "response-summary",
      requestId: "req-invalid-stream",
      semanticState: "ended-empty",
      normalizedErrorKind: "invalid-stream",
      semanticError: {
        status: 408,
        code: "STREAM_ABORTED",
        message: "stream ended without a terminal success event",
      },
    });
  });
});

async function createStateDir(tempDirs: string[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "openclaw-customprovider-cache-logging-"));
  tempDirs.push(dir);
  return dir;
}

async function readLines(stateDir: string): Promise<Array<Record<string, unknown>>> {
  const contents = await readFile(join(stateDir, "forwarded-requests.jsonl"), "utf8");
  return contents
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}
