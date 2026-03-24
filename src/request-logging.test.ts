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

  it("writes semantic response summaries", async () => {
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
      retrySteeringVerdict: "poisoned-child-result",
      retrySteeringReason: "raw-child-result-dump",
      semanticError: {
        status: 429,
        code: "RATE_LIMIT",
        message: "rate limited upstream",
        providerStatus: 529,
      },
    });
    await logger?.flush();

    const [line] = await readLines(stateDir);
    expect(line).toMatchObject({
      event: "response-summary",
      requestId: "req-summary",
      semanticState: "error",
      executionClass: "subagent-like",
      retrySteeringVerdict: "poisoned-child-result",
      retrySteeringReason: "raw-child-result-dump",
      transportStatus: 200,
      semanticError: {
        status: 429,
        code: "RATE_LIMIT",
        message: "rate limited upstream",
        providerStatus: 529,
      },
    });
  });

  it("writes request-side stopgap fields on request and response-summary records", async () => {
    const stateDir = await createStateDir(tempDirs);
    const logger = createForwardedRequestLogger({
      config: { enabled: true },
      stateDir,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });

    await logger?.appendRequest({
      requestId: "req-stopgap",
      provider: "openai",
      api: "openai-responses",
      url: "https://example.test/v1/responses",
      method: "POST",
      headers: new Headers({ "content-type": "application/json" }),
      bodyBuffer: Buffer.from('{"input":"hello"}'),
      executionClass: "main-like",
      retrySteeringVerdict: "poisoned-child-result",
      retrySteeringReason: "raw-child-result-dump",
    });
    await logger?.appendResponseSummary({
      requestId: "req-stopgap",
      provider: "openai",
      api: "openai-responses",
      url: "https://example.test/v1/responses",
      transportStatus: 408,
      semanticState: "error",
      executionClass: "main-like",
      retrySteeringVerdict: "poisoned-child-result",
      retrySteeringReason: "raw-child-result-dump",
      semanticError: {
        status: 408,
        code: "RETRY_STEERING_POISONED_CHILD_RESULT",
        message: "Suspicious child-completion payload detected before upstream generation.",
      },
    });
    await logger?.flush();

    const [requestLine, summaryLine] = await readLines(stateDir);
    expect(requestLine).toMatchObject({
      event: "request",
      requestId: "req-stopgap",
      executionClass: "main-like",
      retrySteeringVerdict: "poisoned-child-result",
      retrySteeringReason: "raw-child-result-dump",
    });
    expect(summaryLine).toMatchObject({
      event: "response-summary",
      requestId: "req-stopgap",
      executionClass: "main-like",
      retrySteeringVerdict: "poisoned-child-result",
      retrySteeringReason: "raw-child-result-dump",
      transportStatus: 408,
      semanticError: {
        status: 408,
        code: "RETRY_STEERING_POISONED_CHILD_RESULT",
        message: "Suspicious child-completion payload detected before upstream generation.",
      },
    });
  });


  it("keeps stream-aborted 408 summaries distinct from retry steering stopgaps", async () => {
    const stateDir = await createStateDir(tempDirs);
    const logger = createForwardedRequestLogger({
      config: { enabled: true },
      stateDir,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });

    await logger?.appendResponseSummary({
      requestId: "req-stream-aborted",
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

    const [line] = await readLines(stateDir);
    expect(line).toMatchObject({
      event: "response-summary",
      requestId: "req-stream-aborted",
      transportStatus: 200,
      semanticState: "ended-empty",
      executionClass: "subagent-like",
      semanticError: {
        status: 408,
        code: "STREAM_ABORTED",
        message: "stream ended without a terminal success event",
      },
    });
    expect(line.retrySteeringVerdict).toBeUndefined();
    expect(line.retrySteeringReason).toBeUndefined();
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
