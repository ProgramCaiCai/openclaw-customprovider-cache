import { describe, expect, it, vi } from "vitest";

import { createPatchedFetch } from "./fetch-patch.js";

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
      providers: [],
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
      providers: [],
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
      providers: [],
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
});
