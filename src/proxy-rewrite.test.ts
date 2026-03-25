import { describe, expect, it } from "vitest";

import { rewriteProxyRequest } from "./proxy-rewrite.js";

describe("rewriteProxyRequest", () => {
  it("fills OpenAI prompt_cache_key and session headers from a stable fallback", async () => {
    const body = { model: "gpt-5.2", input: [{ role: "user", content: "hello" }] };
    const rewritten = await rewriteProxyRequest({
      provider: "openai",
      api: "openai-responses",
      headers: new Headers({ "content-type": "application/json" }),
      rawBody: Buffer.from(JSON.stringify(body)),
      stableUserId: "openclaw-user",
      fallbackSessionId: "session-stable",
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

    expect(rewritten.jsonBody).toMatchObject({
      prompt_cache_key: "session-stable",
    });
    expect(rewritten.headers.get("session_id")).toBe("session-stable");
    expect(rewritten.headers.get("x-session-id")).toBe("session-stable");
  });

  it("deduplicates repeated provider rs_* input items while preserving the first occurrence order", async () => {
    const body = {
      model: "gpt-5.2",
      input: [
        { id: "rs_dup", type: "reasoning", summary: [] },
        { role: "user", content: "hello" },
        { id: "rs_dup", type: "reasoning", summary: [] },
        { id: "rs_keep", type: "reasoning", summary: [] },
      ],
    };

    const rewritten = await rewriteProxyRequest({
      provider: "openai",
      api: "openai-responses",
      headers: new Headers({ "content-type": "application/json" }),
      rawBody: Buffer.from(JSON.stringify(body)),
      stableUserId: "openclaw-user",
      fallbackSessionId: "session-stable",
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

    expect(rewritten.jsonBody).toMatchObject({
      input: [
        { id: "rs_dup", type: "reasoning", summary: [] },
        { role: "user", content: "hello" },
        { id: "rs_keep", type: "reasoning", summary: [] },
      ],
    });
    expect(rewritten.requestNormalization).toEqual({
      droppedDuplicateProviderInputIds: ["rs_dup"],
      droppedDuplicateProviderInputCount: 1,
    });
  });

  it("overrides a poisoned OpenAI session id across headers and prompt_cache_key", async () => {
    const body = {
      model: "gpt-5.2",
      input: [{ role: "user", content: "hello" }],
      prompt_cache_key: "session-poisoned",
    };

    const rewritten = await rewriteProxyRequest({
      provider: "openai",
      api: "openai-responses",
      headers: new Headers({
        "content-type": "application/json",
        session_id: "session-poisoned",
        "x-session-id": "session-poisoned",
      }),
      rawBody: Buffer.from(JSON.stringify(body)),
      stableUserId: "openclaw-user",
      fallbackSessionId: "session-stable",
      openai: {
        injectPromptCacheKey: true,
        injectSessionIdHeader: true,
        overrideSessionId: "session-recovered",
      },
      anthropic: {
        injectMetadataUserId: true,
        userId: undefined,
        userIdPrefix: "openclaw",
      },
    });

    expect(rewritten.jsonBody).toMatchObject({
      prompt_cache_key: "session-recovered",
    });
    expect(rewritten.headers.get("session_id")).toBe("session-recovered");
    expect(rewritten.headers.get("x-session-id")).toBe("session-recovered");
    expect(rewritten.openaiSessionId).toBe("session-recovered");
  });

  it("injects metadata.user_id into Anthropic requests without overwriting metadata", async () => {
    const body = {
      model: "claude-sonnet-4-5",
      messages: [{ role: "user", content: "hello" }],
      metadata: { trace_id: "abc" },
    };
    const rewritten = await rewriteProxyRequest({
      provider: "anthropic",
      api: "anthropic-messages",
      headers: new Headers({ "content-type": "application/json" }),
      rawBody: Buffer.from(JSON.stringify(body)),
      stableUserId: "openclaw-user",
      fallbackSessionId: "session-stable",
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

    expect(rewritten.jsonBody).toMatchObject({
      metadata: {
        trace_id: "abc",
        user_id: "openclaw-user",
      },
    });
  });

  it("does not rewrite openai-completions requests", async () => {
    const body = { model: "gpt-4.1", messages: [{ role: "user", content: "hello" }] };
    const rewritten = await rewriteProxyRequest({
      provider: "openai",
      api: "openai-completions",
      headers: new Headers({ "content-type": "application/json" }),
      rawBody: Buffer.from(JSON.stringify(body)),
      stableUserId: "openclaw-user",
      fallbackSessionId: "session-stable",
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

    expect(rewritten.headers.get("session_id")).toBeNull();
    expect(rewritten.headers.get("x-session-id")).toBeNull();
    expect(rewritten.jsonBody).toEqual(body);
  });
});
