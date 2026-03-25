import { describe, expect, it, vi } from "vitest";

import {
  classifyExecutionClass,
  createPatchedFetch,
  extractPromptishText,
} from "./fetch-patch.js";
import type { ForwardedRequestLogger } from "./types.js";

describe("createPatchedFetch", () => {
  it("rewrites requests that target configured provider baseUrls", async () => {
    const originalFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const bodyText =
        init?.body instanceof Uint8Array
          ? Buffer.from(init.body).toString("utf8")
          : typeof init?.body === "string"
            ? init.body
            : undefined;
      return new Response(
        JSON.stringify({
          headers: init?.headers ? Object.fromEntries(new Headers(init.headers).entries()) : {},
          body: bodyText ? JSON.parse(bodyText) : undefined,
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    });

    const fetchWithPatch = createPatchedFetch({
      originalFetch,
      rules: [
        {
          provider: "openai",
          api: "openai-responses",
          baseUrl: "https://api.example.test/v1",
        },
      ],
      stableUserId: "openclaw-user",
      fallbackSessionId: "session-stable",
      semanticFailureGating: true,
      openai: {
        injectPromptCacheKey: true,
        injectSessionIdHeader: true,
      },
      anthropic: {
        injectMetadataUserId: true,
        userId: undefined,
        userIdPrefix: "openclaw",
      },
    });

    const response = await fetchWithPatch("https://api.example.test/v1/responses", {
      method: "POST",
      headers: {
        Authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-5.2",
        input: [{ role: "user", content: "hello" }],
      }),
    });

    const payload = (await response.json()) as {
      headers: Record<string, string>;
      body: { prompt_cache_key?: string };
    };

    expect(payload.headers.authorization).toBe("Bearer test-token");
    expect(payload.headers.session_id).toBe("session-stable");
    expect(payload.body.prompt_cache_key).toBe("session-stable");
  });

  it("records duplicate rs_* normalization metadata for rewritten OpenAI responses requests", async () => {
    const requestRecords: Array<Record<string, unknown>> = [];
    const originalFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const bodyText =
        init?.body instanceof Uint8Array
          ? Buffer.from(init.body).toString("utf8")
          : typeof init?.body === "string"
            ? init.body
            : undefined;
      return new Response(
        JSON.stringify({
          headers: init?.headers ? Object.fromEntries(new Headers(init.headers).entries()) : {},
          body: bodyText ? JSON.parse(bodyText) : undefined,
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    });

    const fetchWithPatch = createPatchedFetch({
      originalFetch,
      rules: [
        {
          provider: "openai",
          api: "openai-responses",
          baseUrl: "https://api.example.test/v1",
        },
      ],
      stableUserId: "openclaw-user",
      fallbackSessionId: "session-stable",
      semanticFailureGating: true,
      openai: {
        injectPromptCacheKey: true,
        injectSessionIdHeader: true,
      },
      anthropic: {
        injectMetadataUserId: true,
        userId: undefined,
        userIdPrefix: "openclaw",
      },
      requestLogger: {
        appendRequest: async (record) => {
          requestRecords.push(record as unknown as Record<string, unknown>);
        },
        appendResponse: async () => undefined,
        appendResponseSummary: async () => undefined,
        flush: async () => undefined,
      },
    });

    const response = await fetchWithPatch("https://api.example.test/v1/responses", {
      method: "POST",
      headers: {
        Authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-5.2",
        input: [
          { id: "rs_dup", type: "reasoning", summary: [] },
          { role: "user", content: "hello" },
          { id: "rs_dup", type: "reasoning", summary: [] },
        ],
      }),
    });

    const payload = (await response.json()) as {
      body: { input: unknown[] };
    };

    expect(payload.body.input).toEqual([
      { id: "rs_dup", type: "reasoning", summary: [] },
      { role: "user", content: "hello" },
    ]);
    expect(requestRecords).toContainEqual(
      expect.objectContaining({
        requestNormalization: {
          droppedDuplicateProviderInputIds: ["rs_dup"],
          droppedDuplicateProviderInputCount: 1,
        },
      }),
    );
  });

  it("rotates away from a poisoned OpenAI session after repeated overloaded 503s", async () => {
    const seenSessionIds: string[] = [];
    const originalFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
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

    const fetchWithPatch = createPatchedFetch({
      originalFetch,
      rules: [
        {
          provider: "custom-openai",
          api: "openai-responses",
          baseUrl: "https://api.example.test/v1",
        },
      ],
      stableUserId: "openclaw-user",
      fallbackSessionId: "session-stable",
      semanticFailureGating: true,
      openai: {
        injectPromptCacheKey: true,
        injectSessionIdHeader: true,
      },
      anthropic: {
        injectMetadataUserId: true,
        userId: undefined,
        userIdPrefix: "openclaw",
      },
    });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await fetchWithPatch("https://api.example.test/v1/responses", {
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

    const recoveryResponse = await fetchWithPatch("https://api.example.test/v1/responses", {
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

    const payload = (await recoveryResponse.json()) as {
      headers: Record<string, string>;
      body: { prompt_cache_key?: string };
    };

    expect(seenSessionIds[0]).toBe("session-poisoned");
    expect(seenSessionIds[1]).toBe("session-poisoned");
    expect(seenSessionIds[2]).toMatch(/^session-stable-recover-/);
    expect(seenSessionIds[2]).not.toBe("session-poisoned");
    expect(payload.headers.session_id).toBe(seenSessionIds[2]);
    expect(payload.headers["x-session-id"]).toBe(seenSessionIds[2]);
    expect(payload.body.prompt_cache_key).toBe(seenSessionIds[2]);
  });

  it("prefers the most specific provider baseUrl when provider baseUrls overlap", async () => {
    const originalFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const bodyText =
        init?.body instanceof Uint8Array
          ? Buffer.from(init.body).toString("utf8")
          : typeof init?.body === "string"
            ? init.body
            : undefined;
      return new Response(
        JSON.stringify({
          headers: init?.headers ? Object.fromEntries(new Headers(init.headers).entries()) : {},
          body: bodyText ? JSON.parse(bodyText) : undefined,
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    });

    const fetchWithPatch = createPatchedFetch({
      originalFetch,
      rules: [
        {
          provider: "custom-anthropic",
          api: "anthropic-messages",
          baseUrl: "http://127.0.0.1:23000",
        },
        {
          provider: "custom-openai",
          api: "openai-responses",
          baseUrl: "http://127.0.0.1:23000/v1",
        },
      ],
      stableUserId: "stable-user",
      fallbackSessionId: "stable-session",
      semanticFailureGating: true,
      openai: {
        injectPromptCacheKey: true,
        injectSessionIdHeader: true,
      },
      anthropic: {
        injectMetadataUserId: true,
        userId: undefined,
        userIdPrefix: "openclaw",
      },
    });

    const response = await fetchWithPatch("http://127.0.0.1:23000/v1/responses", {
      method: "POST",
      headers: {
        Authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-5.4",
        input: [{ role: "user", content: "hello" }],
      }),
    });

    const payload = (await response.json()) as {
      headers: Record<string, string>;
      body: { prompt_cache_key?: string; metadata?: { user_id?: string } };
    };

    expect(payload.headers.session_id).toBe("stable-session");
    expect(payload.headers["x-session-id"]).toBe("stable-session");
    expect(payload.body.prompt_cache_key).toBe("stable-session");
    expect(payload.body.metadata?.user_id).toBeUndefined();
  });

  it("does not rewrite requests that do not match the configured api endpoint", async () => {
    const originalFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const bodyText =
        init?.body instanceof Uint8Array
          ? Buffer.from(init.body).toString("utf8")
          : typeof init?.body === "string"
            ? init.body
            : undefined;
      return new Response(
        JSON.stringify({
          headers: init?.headers ? Object.fromEntries(new Headers(init.headers).entries()) : {},
          body: bodyText ? JSON.parse(bodyText) : undefined,
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    });

    const fetchWithPatch = createPatchedFetch({
      originalFetch,
      rules: [
        {
          provider: "custom-anthropic",
          api: "anthropic-messages",
          baseUrl: "http://127.0.0.1:23000",
        },
      ],
      stableUserId: "stable-user",
      fallbackSessionId: "stable-session",
      semanticFailureGating: true,
      openai: {
        injectPromptCacheKey: true,
        injectSessionIdHeader: true,
      },
      anthropic: {
        injectMetadataUserId: true,
        userId: undefined,
        userIdPrefix: "openclaw",
      },
    });

    const response = await fetchWithPatch("http://127.0.0.1:23000/v1/responses", {
      method: "POST",
      headers: {
        Authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-5.4",
        input: [{ role: "user", content: "hello" }],
      }),
    });

    const payload = (await response.json()) as {
      headers: Record<string, string>;
      body: { input?: unknown; metadata?: { user_id?: string } };
    };

    expect(payload.headers.session_id).toBeUndefined();
    expect(payload.headers["x-session-id"]).toBeUndefined();
    expect(payload.body.input).toBeDefined();
    expect(payload.body.metadata?.user_id).toBeUndefined();
  });

  it("classifies SOUL.md requests as main-like", () => {
    const promptText = extractPromptishText(
      { provider: "openai", api: "openai-responses", baseUrl: "https://example.test/v1" },
      new Headers({ "content-type": "application/json" }),
      Buffer.from(
        JSON.stringify({
          model: "gpt-5.2",
          input: [{ role: "user", content: "bootstrap includes SOUL.md AGENTS.md TOOLS.md" }],
        }),
      ),
    );

    expect(classifyExecutionClass(promptText)).toBe("main-like");
  });

  it("classifies AGENTS.md plus TOOLS.md without SOUL.md as subagent-like", () => {
    const promptText = extractPromptishText(
      { provider: "anthropic", api: "anthropic-messages", baseUrl: "https://example.test/v1" },
      new Headers({ "content-type": "application/json" }),
      Buffer.from(
        JSON.stringify({
          system: "bootstrap includes AGENTS.md and TOOLS.md only",
          messages: [{ role: "user", content: "worker bootstrap without soul file" }],
        }),
      ),
    );

    expect(classifyExecutionClass(promptText)).toBe("subagent-like");
  });

  it("turns pre-first-token semantic failures into real stream errors", async () => {
    const logger = createMemoryLogger();
    const fetchWithPatch = createPatchedFetch({
      originalFetch: vi.fn(async () =>
        new Response(
          streamFromText(
            'data: {"type":"response.failed","response":{"status":529,"error":{"code":"overloaded_error","message":"capacity exhausted"}}}\n\n',
          ),
          {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          },
        ),
      ),
      rules: [
        {
          provider: "openai",
          api: "openai-responses",
          baseUrl: "https://api.example.test/v1",
        },
      ],
      stableUserId: "openclaw-user",
      fallbackSessionId: "session-stable",
      requestLogger: logger,
      semanticFailureGating: true,
      openai: {
        injectPromptCacheKey: true,
        injectSessionIdHeader: true,
      },
      anthropic: {
        injectMetadataUserId: true,
        userId: undefined,
        userIdPrefix: "openclaw",
      },
    });

    const response = await fetchWithPatch("https://api.example.test/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.2",
        input: [{ role: "user", content: "AGENTS.md TOOLS.md" }],
      }),
    });

    await expect(response.text()).rejects.toMatchObject({
      status: 503,
      code: "OVERLOADED",
      message: "capacity exhausted",
      providerStatus: 529,
    });
    expect(logger.responseSummaries).toContainEqual(
      expect.objectContaining({
        semanticState: "error",
        executionClass: "subagent-like",
        semanticError: expect.objectContaining({
          status: 503,
          code: "OVERLOADED",
          message: "capacity exhausted",
        }),
      }),
    );
  });

  it("passes through semantic failures untouched when semantic failure gating is disabled", async () => {
    const logger = createMemoryLogger();
    const fetchWithPatch = createPatchedFetch({
      originalFetch: vi.fn(async () =>
        new Response(
          streamFromText(
            'data: {"type":"response.failed","response":{"status":529,"error":{"code":"overloaded_error","message":"capacity exhausted"}}}\n\n',
          ),
          {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          },
        ),
      ),
      rules: [
        {
          provider: "openai",
          api: "openai-responses",
          baseUrl: "https://api.example.test/v1",
        },
      ],
      stableUserId: "openclaw-user",
      fallbackSessionId: "session-stable",
      requestLogger: logger,
      semanticFailureGating: false,
      openai: {
        injectPromptCacheKey: true,
        injectSessionIdHeader: true,
      },
      anthropic: {
        injectMetadataUserId: true,
        userId: undefined,
        userIdPrefix: "openclaw",
      },
    });

    const response = await fetchWithPatch("https://api.example.test/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.2",
        input: [{ role: "user", content: "AGENTS.md TOOLS.md" }],
      }),
    });

    expect(await response.text()).toBe(
      'data: {"type":"response.failed","response":{"status":529,"error":{"code":"overloaded_error","message":"capacity exhausted"}}}\n\n',
    );
    expect(logger.responseSummaries).toEqual([]);
  });

  it("keeps post-first-token failures non-fatal for main-like requests", async () => {
    const logger = createMemoryLogger();
    const fetchWithPatch = createPatchedFetch({
      originalFetch: vi.fn(async () =>
        new Response(
          streamFromText(
            'data: {"type":"response.output_text.delta","delta":"hello"}\n\n',
            'data: {"type":"response.failed","response":{"status":500,"error":{"code":"server_error","message":"late failure"}}}\n\n',
          ),
          {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          },
        ),
      ),
      rules: [
        {
          provider: "openai",
          api: "openai-responses",
          baseUrl: "https://api.example.test/v1",
        },
      ],
      stableUserId: "openclaw-user",
      fallbackSessionId: "session-stable",
      requestLogger: logger,
      semanticFailureGating: true,
      openai: {
        injectPromptCacheKey: true,
        injectSessionIdHeader: true,
      },
      anthropic: {
        injectMetadataUserId: true,
        userId: undefined,
        userIdPrefix: "openclaw",
      },
    });

    const response = await fetchWithPatch("https://api.example.test/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.2",
        input: [{ role: "user", content: "SOUL.md AGENTS.md TOOLS.md" }],
      }),
    });

    const payload = await response.text();
    expect(payload).toContain("response.output_text.delta");
    expect(payload).toContain("response.failed");
    expect(logger.responseSummaries).toContainEqual(
      expect.objectContaining({
        semanticState: "error-after-partial",
        executionClass: "main-like",
      }),
    );
  });

  it("turns post-first-token failures into real errors for subagent-like requests", async () => {
    const logger = createMemoryLogger();
    const fetchWithPatch = createPatchedFetch({
      originalFetch: vi.fn(async () =>
        new Response(
          streamFromText(
            'data: {"type":"response.output_text.delta","delta":"hello"}\n\n',
            'data: {"type":"response.failed","response":{"status":429,"error":{"code":"rate_limit_error","message":"slow down"}}}\n\n',
          ),
          {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          },
        ),
      ),
      rules: [
        {
          provider: "openai",
          api: "openai-responses",
          baseUrl: "https://api.example.test/v1",
        },
      ],
      stableUserId: "openclaw-user",
      fallbackSessionId: "session-stable",
      requestLogger: logger,
      semanticFailureGating: true,
      openai: {
        injectPromptCacheKey: true,
        injectSessionIdHeader: true,
      },
      anthropic: {
        injectMetadataUserId: true,
        userId: undefined,
        userIdPrefix: "openclaw",
      },
    });

    const response = await fetchWithPatch("https://api.example.test/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.2",
        input: [{ role: "user", content: "AGENTS.md TOOLS.md" }],
      }),
    });

    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    const firstChunk = await reader!.read();
    expect(firstChunk.done).toBe(false);
    expect(decodeChunk(firstChunk.value)).toContain("response.output_text.delta");
    await expect(reader!.read()).rejects.toMatchObject({
      status: 429,
      code: "RATE_LIMIT",
      message: "slow down",
      providerStatus: 429,
    });
    expect(logger.responseSummaries).toContainEqual(
      expect.objectContaining({
        semanticState: "error-after-partial",
        executionClass: "subagent-like",
        semanticError: expect.objectContaining({
          status: 429,
          code: "RATE_LIMIT",
          message: "slow down",
        }),
      }),
    );
  });

  it("turns google stream terminal failures into real stream errors", async () => {
    const logger = createMemoryLogger();
    const fetchWithPatch = createPatchedFetch({
      originalFetch: vi.fn(async () =>
        new Response(
          streamFromText(
            'data: {"error":{"code":429,"status":"RESOURCE_EXHAUSTED","message":"quota exhausted"}}\n\n',
          ),
          {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          },
        ),
      ),
      rules: [
        {
          provider: "google",
          api: "google-generative-ai",
          baseUrl: "https://generativelanguage.example.test/v1beta",
        },
      ],
      stableUserId: "openclaw-user",
      fallbackSessionId: "session-stable",
      requestLogger: logger,
      semanticFailureGating: true,
      openai: {
        injectPromptCacheKey: true,
        injectSessionIdHeader: true,
      },
      anthropic: {
        injectMetadataUserId: true,
        userId: undefined,
        userIdPrefix: "openclaw",
      },
    });

    const response = await fetchWithPatch(
      "https://generativelanguage.example.test/v1beta/models/gemini-2.5-pro:streamGenerateContent",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: "AGENTS.md TOOLS.md" }] }],
        }),
      },
    );

    await expect(response.text()).rejects.toMatchObject({
      status: 429,
      code: "RATE_LIMIT",
      message: "quota exhausted",
      providerStatus: 429,
    });
    expect(logger.responseSummaries).toContainEqual(
      expect.objectContaining({
        api: "google-generative-ai",
        semanticState: "error",
        executionClass: "subagent-like",
        semanticError: expect.objectContaining({
          status: 429,
          code: "RATE_LIMIT",
          message: "quota exhausted",
        }),
      }),
    );
  });
});

function streamFromText(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

function decodeChunk(chunk?: Uint8Array): string {
  return chunk ? new TextDecoder().decode(chunk) : "";
}

function createMemoryLogger(): ForwardedRequestLogger & {
  responseSummaries: Array<Record<string, unknown>>;
} {
  const responseSummaries: Array<Record<string, unknown>> = [];

  return {
    responseSummaries,
    appendRequest: async () => undefined,
    appendResponse: async () => undefined,
    appendResponseSummary: async (record) => {
      responseSummaries.push(record as unknown as Record<string, unknown>);
    },
    flush: async () => undefined,
  };
}
