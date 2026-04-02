import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SessionMetadataProxyService } from "./proxy-service.js";

async function readJson(response: Response): Promise<unknown> {
  return JSON.parse(await response.text());
}

describe("SessionMetadataProxyService", () => {
  const closers: Array<{ close: () => Promise<void> }> = [];
  const tempDirs: string[] = [];
  const nativeFetch = globalThis.fetch;

  afterEach(async () => {
    await Promise.all(closers.splice(0).map((entry) => entry.close()));
    await Promise.all(
      tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    );
    globalThis.fetch = nativeFetch;
  });

  beforeEach(() => {
    globalThis.fetch = createJsonEchoFetch();
  });

  it("patches global fetch without mutating configured provider baseUrl", async () => {
    const cfg = {
      models: {
        providers: {
          openai: {
            api: "openai-responses",
            baseUrl: "https://api.openai.com/v1",
            models: [],
          },
        },
      },
    };
    const service = new SessionMetadataProxyService({
      config: cfg,
      pluginConfig: {
        providers: [],
        semanticFailureGating: true,
        subagentResultStopgap: true,
        requestLogging: {
          enabled: false,
          path: undefined,
        },
        openai: {
          injectPromptCacheKey: true,
          injectSessionIdHeader: true,
          scrubAssistantCommentaryReplay: true,
        },
        anthropic: {
          injectMetadataUserId: true,
          userId: undefined,
          userIdPrefix: "openclaw",
        },
      },
      stateDir: "/tmp",
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });
    const originalFetch = globalThis.fetch;

    await service.start();

    expect(cfg.models.providers.openai.baseUrl).toBe("https://api.openai.com/v1");
    expect(globalThis.fetch).not.toBe(originalFetch);

    await service.stop();

    expect(globalThis.fetch).toBe(originalFetch);
  });

  it("rewrites requests sent to configured provider baseUrls without reading API keys", async () => {
    const cfg = {
      models: {
        providers: {
          anthropic: {
            api: "anthropic-messages",
            baseUrl: "https://anthropic.example.test",
            models: [],
          },
        },
      },
    };
    const service = new SessionMetadataProxyService({
      config: cfg,
      pluginConfig: {
        providers: [],
        semanticFailureGating: true,
        subagentResultStopgap: true,
        requestLogging: {
          enabled: false,
          path: undefined,
        },
        openai: {
          injectPromptCacheKey: true,
          injectSessionIdHeader: true,
          scrubAssistantCommentaryReplay: true,
        },
        anthropic: {
          injectMetadataUserId: true,
          userId: "tenant-user",
          userIdPrefix: "openclaw",
        },
      },
      stateDir: "/tmp",
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });
    closers.push({ close: () => service.stop() });

    await service.start();

    const response = await fetch(`${cfg.models.providers.anthropic.baseUrl}/messages`, {
      method: "POST",
      headers: {
        Authorization: "Bearer test-secret",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    const payload = (await readJson(response)) as {
      headers: Record<string, string>;
      body: { metadata?: { user_id?: string } };
    };
    expect(payload.headers.authorization).toBe("Bearer test-secret");
    expect(payload.body.metadata?.user_id).toBe("tenant-user");
  });

  it("does not write request logs when logging is disabled by default", async () => {
    const stateDir = await createStateDir(tempDirs);
    const cfg = {
      models: {
        providers: {
          openai: {
            api: "openai-responses",
            baseUrl: "https://openai.example.test/v1",
            models: [],
          },
        },
      },
    };
    const service = new SessionMetadataProxyService({
      config: cfg,
      pluginConfig: {
        providers: [],
        semanticFailureGating: true,
        subagentResultStopgap: true,
        requestLogging: {
          enabled: false,
          path: undefined,
        },
        openai: {
          injectPromptCacheKey: true,
          injectSessionIdHeader: true,
          scrubAssistantCommentaryReplay: true,
        },
        anthropic: {
          injectMetadataUserId: true,
          userId: undefined,
          userIdPrefix: "openclaw",
        },
      },
      stateDir,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });
    closers.push({ close: () => service.stop() });

    await service.start();

    await fetch(`${cfg.models.providers.openai.baseUrl}/responses`, {
      method: "POST",
      headers: {
        Authorization: "Bearer test-secret",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-5.2",
        input: [{ role: "user", content: "hello" }],
      }),
    });

    await service.stop();

    await expect(
      readFile(join(stateDir, "forwarded-requests.jsonl"), "utf8"),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("writes correlated request and response events when logging is enabled", async () => {
    const stateDir = await createStateDir(tempDirs);
    const cfg = {
      models: {
        providers: {
          openai: {
            api: "openai-responses",
            baseUrl: "https://openai.example.test/v1",
            models: [],
          },
        },
      },
    };
    const service = new SessionMetadataProxyService({
      config: cfg,
      pluginConfig: {
        providers: [],
        semanticFailureGating: true,
        subagentResultStopgap: true,
        requestLogging: {
          enabled: true,
          path: undefined,
        },
        openai: {
          injectPromptCacheKey: true,
          injectSessionIdHeader: true,
          scrubAssistantCommentaryReplay: true,
        },
        anthropic: {
          injectMetadataUserId: true,
          userId: undefined,
          userIdPrefix: "openclaw",
        },
      },
      stateDir,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });
    closers.push({ close: () => service.stop() });

    await service.start();

    await fetch(`${cfg.models.providers.openai.baseUrl}/responses`, {
      method: "POST",
      headers: {
        Authorization: "Bearer test-secret",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-5.2",
        input: [{ role: "user", content: "hello" }],
      }),
    });

    await service.stop();

    const lines = (await readFile(join(stateDir, "forwarded-requests.jsonl"), "utf8"))
      .trim()
      .split("\n");
    expect(lines).toHaveLength(2);

    const requestRecord = JSON.parse(lines[0] ?? "null") as {
      event: string;
      requestId: string;
      provider: string;
      api: string;
      url: string;
      method: string;
      headers: Record<string, string>;
      body: Record<string, unknown>;
      timestamp: string;
    };

    const responseRecord = JSON.parse(lines[1] ?? "null") as {
      event: string;
      requestId: string;
      provider: string;
      api: string;
      url: string;
      status: number;
      headers: Record<string, string>;
      body?: {
        method?: string;
        url?: string;
      };
      bodyState: string;
      truncated: boolean;
      timestamp: string;
    };

    expect(requestRecord.event).toBe("request");
    expect(requestRecord.requestId).toBeTypeOf("string");
    expect(requestRecord.provider).toBe("openai");
    expect(requestRecord.api).toBe("openai-responses");
    expect(requestRecord.url).toBe(`${cfg.models.providers.openai.baseUrl}/responses`);
    expect(requestRecord.method).toBe("POST");
    expect(requestRecord.timestamp).toBeTypeOf("string");
    expect(requestRecord.headers.session_id).toMatch(/^openclaw-session-/);
    expect(requestRecord.headers["x-session-id"]).toBe(requestRecord.headers.session_id);
    expect(requestRecord.body).toMatchObject({
      model: "gpt-5.2",
      prompt_cache_key: requestRecord.headers.session_id,
    });

    expect(responseRecord.event).toBe("response");
    expect(responseRecord.requestId).toBe(requestRecord.requestId);
    expect(responseRecord.provider).toBe("openai");
    expect(responseRecord.api).toBe("openai-responses");
    expect(responseRecord.url).toBe(requestRecord.url);
    expect(responseRecord.status).toBe(200);
    expect(responseRecord.timestamp).toBeTypeOf("string");
    expect(responseRecord.headers["content-type"]).toBe("application/json");
    expect(responseRecord.bodyState).toBe("captured");
    expect(responseRecord.truncated).toBe(false);
    expect(responseRecord.body).toMatchObject({
      method: "POST",
      url: `${cfg.models.providers.openai.baseUrl}/responses`,
    });
  });

  it("redacts secrets in logged headers and body", async () => {
    const stateDir = await createStateDir(tempDirs);
    const cfg = {
      models: {
        providers: {
          openai: {
            api: "openai-responses",
            baseUrl: "https://openai.example.test/v1",
            models: [],
          },
        },
      },
    };
    const service = new SessionMetadataProxyService({
      config: cfg,
      pluginConfig: {
        providers: [],
        semanticFailureGating: true,
        subagentResultStopgap: true,
        requestLogging: {
          enabled: true,
          path: undefined,
        },
        openai: {
          injectPromptCacheKey: true,
          injectSessionIdHeader: true,
          scrubAssistantCommentaryReplay: true,
        },
        anthropic: {
          injectMetadataUserId: true,
          userId: undefined,
          userIdPrefix: "openclaw",
        },
      },
      stateDir,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });
    closers.push({ close: () => service.stop() });

    await service.start();

    await fetch(`${cfg.models.providers.openai.baseUrl}/responses`, {
      method: "POST",
      headers: {
        Authorization: "Bearer test-secret",
        "x-api-key": "sk-live-secret",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-5.2",
        input: [{ role: "user", content: "hello" }],
        api_key: "sk-body-secret",
        nested: {
          access_token: "Bearer nested-secret",
          safe: "keep-me",
        },
      }),
    });

    await service.stop();

    const [requestLine, responseLine] = (await readFile(join(stateDir, "forwarded-requests.jsonl"), "utf8"))
      .trim()
      .split("\n");
    const requestRecord = JSON.parse(requestLine ?? "null") as {
      headers: Record<string, string>;
      body: {
        api_key?: string;
        nested?: {
          access_token?: string;
          safe?: string;
        };
      };
    };
    const responseRecord = JSON.parse(responseLine ?? "null") as {
      headers: Record<string, string>;
      body?: {
        headers?: Record<string, string>;
        body?: {
          api_key?: string;
          nested?: {
            access_token?: string;
            safe?: string;
          };
        };
      };
    };

    expect(requestRecord.headers.authorization).toBe("[REDACTED]");
    expect(requestRecord.headers["x-api-key"]).toBe("[REDACTED]");
    expect(requestRecord.body.api_key).toBe("[REDACTED]");
    expect(requestRecord.body.nested?.access_token).toBe("[REDACTED]");
    expect(requestRecord.body.nested?.safe).toBe("keep-me");
    expect(responseRecord.headers["x-api-key"]).toBe("[REDACTED]");
    expect(responseRecord.body?.headers?.authorization).toBe("[REDACTED]");
    expect(responseRecord.body?.headers?.["x-api-key"]).toBe("[REDACTED]");
    expect(responseRecord.body?.body?.api_key).toBe("[REDACTED]");
    expect(responseRecord.body?.body?.nested?.access_token).toBe("[REDACTED]");
    expect(responseRecord.body?.body?.nested?.safe).toBe("keep-me");
  });

  it("keeps stream-like downstream responses readable while annotating body capture", async () => {
    const encoder = new TextEncoder();
    const stateDir = await createStateDir(tempDirs);
    const cfg = {
      models: {
        providers: {
          openai: {
            api: "openai-responses",
            baseUrl: "https://openai.example.test/v1",
            models: [],
          },
        },
      },
    };
    globalThis.fetch = vi.fn(async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              'data: {"type":"response.output_text.delta","delta":"hello"}\n\n',
            ),
          );
          controller.enqueue(encoder.encode('data: {"type":"response.completed"}\n\n'));
          controller.close();
        },
      });
      return new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    });
    const service = new SessionMetadataProxyService({
      config: cfg,
      pluginConfig: {
        providers: [],
        semanticFailureGating: true,
        subagentResultStopgap: true,
        requestLogging: {
          enabled: true,
          path: undefined,
        },
        openai: {
          injectPromptCacheKey: true,
          injectSessionIdHeader: true,
          scrubAssistantCommentaryReplay: true,
        },
        anthropic: {
          injectMetadataUserId: true,
          userId: undefined,
          userIdPrefix: "openclaw",
        },
      },
      stateDir,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });
    closers.push({ close: () => service.stop() });

    await service.start();

    const response = await fetch(`${cfg.models.providers.openai.baseUrl}/responses`, {
      method: "POST",
      headers: {
        Authorization: "Bearer test-secret",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-5.2",
        input: [{ role: "user", content: "hello" }],
      }),
    });

    expect(await response.text()).toBe(
      'data: {"type":"response.output_text.delta","delta":"hello"}\n\n' +
        'data: {"type":"response.completed"}\n\n',
    );

    await service.stop();

    const [, responseLine, summaryLine] = (await readFile(
      join(stateDir, "forwarded-requests.jsonl"),
      "utf8",
    ))
      .trim()
      .split("\n");
    const responseRecord = JSON.parse(responseLine ?? "null") as {
      status: number;
      body?: unknown;
      bodyState: string;
      semanticState?: string;
      truncated: boolean;
    };
    const summaryRecord = JSON.parse(summaryLine ?? "null") as {
      event: string;
      semanticState: string;
      streamIntegrity?: {
        terminalEventType?: string;
        firstChunkAtMs?: number;
      };
    };

    expect(responseRecord.status).toBe(200);
    expect(responseRecord.bodyState).toBe("stream-like");
    expect(responseRecord.semanticState).toBe("unknown-stream");
    expect(responseRecord.truncated).toBe(false);
    expect(responseRecord.body).toBeUndefined();
    expect(summaryRecord.event).toBe("response-summary");
    expect(summaryRecord.semanticState).toBe("completed");
    expect(summaryRecord.streamIntegrity).toMatchObject({
      terminalEventType: "response.completed",
    });
    expect(summaryRecord.streamIntegrity?.firstChunkAtMs).toBeTypeOf("number");
  });

  it("logs upstream stream overloads with normalized provider error categories", async () => {
    const encoder = new TextEncoder();
    const stateDir = await createStateDir(tempDirs);
    const cfg = {
      models: {
        providers: {
          openai: {
            api: "openai-responses",
            baseUrl: "https://openai.example.test/v1",
            models: [],
          },
        },
      },
    };
    globalThis.fetch = vi.fn(async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              'data: {"type":"response.failed","response":{"status":529,"error":{"code":"overloaded_error","message":"capacity exhausted"}}}\n\n',
            ),
          );
          controller.close();
        },
      });
      return new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    });
    const service = new SessionMetadataProxyService({
      config: cfg,
      pluginConfig: {
        providers: [],
        semanticFailureGating: true,
        subagentResultStopgap: true,
        requestLogging: {
          enabled: true,
          path: undefined,
        },
        openai: {
          injectPromptCacheKey: true,
          injectSessionIdHeader: true,
          scrubAssistantCommentaryReplay: true,
        },
        anthropic: {
          injectMetadataUserId: true,
          userId: undefined,
          userIdPrefix: "openclaw",
        },
      },
      stateDir,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });
    closers.push({ close: () => service.stop() });

    await service.start();

    const response = await fetch(`${cfg.models.providers.openai.baseUrl}/responses`, {
      method: "POST",
      headers: {
        Authorization: "Bearer test-secret",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-5.2",
        input: [{ role: "user", content: "AGENTS.md TOOLS.md" }],
      }),
    });

    await expect(response.text()).rejects.toMatchObject({
      status: 503,
      code: "SERVER_OVERLOADED",
      message: "capacity exhausted",
      providerStatus: 529,
    });

    await service.stop();

    const [, , summaryLine] = (await readFile(join(stateDir, "forwarded-requests.jsonl"), "utf8"))
      .trim()
      .split("\n");
    const summaryRecord = JSON.parse(summaryLine ?? "null") as {
      semanticState: string;
      providerStatus?: number;
      normalizedErrorKind?: string;
      streamIntegrity?: {
        terminalEventType?: string;
      };
    };

    expect(summaryRecord.semanticState).toBe("error");
    expect(summaryRecord.providerStatus).toBe(529);
    expect(summaryRecord.normalizedErrorKind).toBe("upstream-overloaded");
    expect(summaryRecord.streamIntegrity).toMatchObject({
      terminalEventType: "response.failed",
    });
  });

  it("passes covered streams through untouched when semantic failure gating is disabled", async () => {
    const encoder = new TextEncoder();
    const stateDir = await createStateDir(tempDirs);
    const cfg = {
      models: {
        providers: {
          openai: {
            api: "openai-responses",
            baseUrl: "https://openai.example.test/v1",
            models: [],
          },
        },
      },
    };
    globalThis.fetch = vi.fn(async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              'data: {"type":"response.failed","response":{"status":500,"error":{"code":"server_error","message":"late failure"}}}\n\n',
            ),
          );
          controller.close();
        },
      });
      return new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    });
    const service = new SessionMetadataProxyService({
      config: cfg,
      pluginConfig: {
        providers: [],
        semanticFailureGating: false,
        subagentResultStopgap: true,
        requestLogging: {
          enabled: true,
          path: undefined,
        },
        openai: {
          injectPromptCacheKey: true,
          injectSessionIdHeader: true,
          scrubAssistantCommentaryReplay: true,
        },
        anthropic: {
          injectMetadataUserId: true,
          userId: undefined,
          userIdPrefix: "openclaw",
        },
      },
      stateDir,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });
    closers.push({ close: () => service.stop() });

    await service.start();

    const response = await fetch(`${cfg.models.providers.openai.baseUrl}/responses`, {
      method: "POST",
      headers: {
        Authorization: "Bearer test-secret",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-5.2",
        input: [{ role: "user", content: "AGENTS.md TOOLS.md" }],
      }),
    });

    expect(await response.text()).toBe(
      'data: {"type":"response.failed","response":{"status":500,"error":{"code":"server_error","message":"late failure"}}}\n\n',
    );

    await service.stop();

    const lines = (await readFile(join(stateDir, "forwarded-requests.jsonl"), "utf8"))
      .trim()
      .split("\n");
    expect(lines).toHaveLength(2);

    const responseRecord = JSON.parse(lines[1] ?? "null") as {
      event: string;
      bodyState: string;
      semanticState?: string;
    };

    expect(responseRecord.event).toBe("response");
    expect(responseRecord.bodyState).toBe("stream-like");
    expect(responseRecord.semanticState).toBe("unknown-stream");
  });

  it("reuses persisted recovery session mappings after service restart", async () => {
    const stateDir = await createStateDir(tempDirs);
    const seenSessionIds: string[] = [];
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const bodyText =
        init?.body instanceof Uint8Array
          ? Buffer.from(init.body).toString("utf8")
          : typeof init?.body === "string"
            ? init.body
            : undefined;
      const payload = bodyText ? (JSON.parse(bodyText) as { prompt_cache_key?: string }) : {};
      const sessionId = headers.get("session_id") ?? payload.prompt_cache_key ?? "missing";
      seenSessionIds.push(sessionId);

      if (seenSessionIds.length <= 2) {
        return new Response(
          JSON.stringify({
            error: {
              code: "service_unavailable_error",
              message: "upstream overloaded",
            },
          }),
          {
            status: 503,
            headers: { "content-type": "application/json" },
          },
        );
      }

      return new Response(
        JSON.stringify({
          headers: Object.fromEntries(headers.entries()),
          body: payload,
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    });

    const cfg = {
      models: {
        providers: {
          openai: {
            api: "openai-responses",
            baseUrl: "https://openai.example.test/v1",
            models: [],
          },
        },
      },
    };
    const pluginConfig = {
      providers: [],
      semanticFailureGating: true,
      subagentResultStopgap: true,
      requestLogging: {
        enabled: false,
        path: undefined,
      },
      openai: {
        injectPromptCacheKey: true,
        injectSessionIdHeader: true,
        scrubAssistantCommentaryReplay: true,
      },
      anthropic: {
        injectMetadataUserId: true,
        userId: undefined,
        userIdPrefix: "openclaw",
      },
    };

    const firstService = new SessionMetadataProxyService({
      config: cfg,
      pluginConfig,
      stateDir,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });

    await firstService.start();

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await fetch(`${cfg.models.providers.openai.baseUrl}/responses`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          session_id: "session-poisoned",
        },
        body: JSON.stringify({
          model: "gpt-5.4",
          input: [{ role: "user", content: `attempt-${attempt}` }],
        }),
      });
      expect(response.status).toBe(503);
      await response.text();
    }

    await firstService.stop();

    const secondService = new SessionMetadataProxyService({
      config: cfg,
      pluginConfig,
      stateDir,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });

    await secondService.start();

    const response = await fetch(`${cfg.models.providers.openai.baseUrl}/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        session_id: "session-poisoned",
      },
      body: JSON.stringify({
        model: "gpt-5.4",
        input: [{ role: "user", content: "recover" }],
      }),
    });

    const payload = (await readJson(response)) as {
      headers: Record<string, string>;
      body: { prompt_cache_key?: string };
    };

    expect(seenSessionIds[0]).toBe("session-poisoned");
    expect(seenSessionIds[1]).toBe("session-poisoned");
    expect(seenSessionIds[2]).toMatch(/^openclaw-session-[a-f0-9]+-recover-/);
    expect(payload.headers.session_id).toBe(seenSessionIds[2]);
    expect(payload.headers["x-session-id"]).toBe(seenSessionIds[2]);
    expect(payload.body.prompt_cache_key).toBe(seenSessionIds[2]);

    await secondService.stop();
  });

  it("does not patch providers configured for openai-completions", async () => {
    const cfg = {
      models: {
        providers: {
          openai: {
            api: "openai-completions",
            baseUrl: "https://openai.example.test",
            models: [],
          },
        },
      },
    };
    const service = new SessionMetadataProxyService({
      config: cfg,
      pluginConfig: {
        providers: [],
        semanticFailureGating: true,
        subagentResultStopgap: true,
        requestLogging: {
          enabled: false,
          path: undefined,
        },
        openai: {
          injectPromptCacheKey: true,
          injectSessionIdHeader: true,
          scrubAssistantCommentaryReplay: true,
        },
        anthropic: {
          injectMetadataUserId: true,
          userId: undefined,
          userIdPrefix: "openclaw",
        },
      },
      stateDir: "/tmp",
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });
    closers.push({ close: () => service.stop() });

    await service.start();

    const response = await fetch(`${cfg.models.providers.openai.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: "Bearer test-secret",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4.1",
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    const payload = (await readJson(response)) as {
      headers: Record<string, string>;
      body: Record<string, unknown>;
    };
    expect(payload.headers.authorization).toBe("Bearer test-secret");
    expect(payload.headers.session_id).toBeUndefined();
    expect(payload.body.prompt_cache_key).toBeUndefined();
  });
});

async function createStateDir(tempDirs: string[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "openclaw-customprovider-cache-"));
  tempDirs.push(dir);
  return dir;
}

function createJsonEchoFetch(): typeof globalThis.fetch {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = init?.headers ? Object.fromEntries(new Headers(init.headers).entries()) : {};
    const bodyText =
      init?.body instanceof Uint8Array
        ? Buffer.from(init.body).toString("utf8")
        : typeof init?.body === "string"
          ? init.body
          : undefined;

    return new Response(
      JSON.stringify({
        method: init?.method ?? (input instanceof Request ? input.method : "GET"),
        url: typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
        headers,
        body: bodyText ? JSON.parse(bodyText) : undefined,
      }),
      {
        status: 200,
        headers: {
          "content-type": "application/json",
          "x-api-key": "sk-upstream-secret",
        },
      },
    );
  });
}
