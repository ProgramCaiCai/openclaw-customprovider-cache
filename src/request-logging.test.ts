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

  it("writes request normalization metadata without needing raw duplicate content", async () => {
    const stateDir = await createStateDir(tempDirs);
    const logger = createForwardedRequestLogger({
      config: { enabled: true },
      stateDir,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });

    await logger?.appendRequest({
      requestId: "req-normalized",
      provider: "openai",
      api: "openai-responses",
      url: "https://example.test/v1/responses",
      method: "POST",
      headers: new Headers({ "content-type": "application/json" }),
      bodyBuffer: Buffer.from(
        JSON.stringify({
          model: "gpt-5.2",
          input: [{ role: "user", content: "hello" }],
        }),
      ),
      requestNormalization: {
        droppedDuplicateProviderInputIds: ["rs_dup"],
        droppedDuplicateProviderInputCount: 1,
      },
    });
    await logger?.flush();

    const [line] = await readLines(stateDir);
    expect(line).toMatchObject({
      event: "request",
      requestId: "req-normalized",
      requestNormalization: {
        droppedDuplicateProviderInputIds: ["rs_dup"],
        droppedDuplicateProviderInputCount: 1,
      },
    });
  });

  it("annotates stream-like transport responses as unresolved instead of implying success", async () => {
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
      providerTerminalKind: "unknown-stream",
      executionClass: "subagent-like",
      truncated: false,
    });
    expect(line.providerStatus).toBeUndefined();
    expect(line.normalizedErrorKind).toBeUndefined();
    expect(line.body).toBeUndefined();
  });

  it("falls back to unavailable bodies when the response was already consumed", async () => {
    const stateDir = await createStateDir(tempDirs);
    const warnings: string[] = [];
    const logger = createForwardedRequestLogger({
      config: { enabled: true },
      stateDir,
      logger: {
        info: () => {},
        warn: (message) => warnings.push(message),
        error: () => {},
      },
    });

    const response = new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    await response.text();

    await logger?.appendResponse({
      requestId: "req-consumed",
      provider: "openai",
      api: "openai-responses",
      url: "https://example.test/v1/responses",
      response,
    });
    await logger?.flush();

    const [line] = await readLines(stateDir);
    expect(line).toMatchObject({
      event: "response",
      requestId: "req-consumed",
      bodyState: "unavailable",
      truncated: false,
    });
    expect(line.body).toBeUndefined();
    expect(warnings).toHaveLength(0);
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
      streamIntegrity: {
        firstChunkAtMs: 12,
        firstVisibleOutputAtMs: 34,
        terminalEventType: "response.failed",
        malformedEventCount: 1,
        ignoredJsonParseFailureCount: 1,
        malformedEventPreviews: ['{"type":"response.failed"'],
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
      providerTerminalKind: "semantic-error",
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
      streamIntegrity: {
        firstChunkAtMs: 12,
        firstVisibleOutputAtMs: 34,
        terminalEventType: "response.failed",
        malformedEventCount: 1,
        ignoredJsonParseFailureCount: 1,
        malformedEventPreviews: ['{"type":"response.failed"'],
      },
    });
    expect(invalidStreamLine).toMatchObject({
      event: "response-summary",
      requestId: "req-invalid-stream",
      semanticState: "ended-empty",
      providerTerminalKind: "ended-empty",
      normalizedErrorKind: "invalid-stream",
      semanticError: {
        status: 408,
        code: "STREAM_ABORTED",
        message: "stream ended without a terminal success event",
      },
    });
  });

  it("marks completed summaries with an explicit provider terminal kind", async () => {
    const stateDir = await createStateDir(tempDirs);
    const logger = createForwardedRequestLogger({
      config: { enabled: true },
      stateDir,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });

    await logger?.appendResponseSummary({
      requestId: "req-completed",
      provider: "anthropic",
      api: "anthropic-messages",
      url: "https://example.test/v1/messages",
      transportStatus: 200,
      semanticState: "completed",
      executionClass: "main-like",
    });
    await logger?.flush();

    const [line] = await readLines(stateDir);
    expect(line).toMatchObject({
      event: "response-summary",
      requestId: "req-completed",
      semanticState: "completed",
      providerTerminalKind: "completed",
      executionClass: "main-like",
      transportStatus: 200,
    });
    expect(line.providerStatus).toBeUndefined();
    expect(line.normalizedErrorKind).toBeUndefined();
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
