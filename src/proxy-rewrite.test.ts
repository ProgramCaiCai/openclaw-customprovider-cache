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
        scrubAssistantCommentaryReplay: true,
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
        scrubAssistantCommentaryReplay: true,
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

  it("scrubs assistant commentary replay items by phase for OpenAI responses requests", async () => {
    const body = {
      model: "gpt-5.4",
      input: [
        { type: "message", role: "user", content: "hello" },
        { type: "message", role: "assistant", phase: "commentary", content: "I will check that now." },
        { type: "message", role: "assistant", phase: "final_answer", content: "Final answer." },
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
        scrubAssistantCommentaryReplay: true,
      },
      anthropic: {
        injectMetadataUserId: true,
        userId: undefined,
        userIdPrefix: "openclaw",
      },
    });

    expect(rewritten.jsonBody).toMatchObject({
      input: [
        { type: "message", role: "user", content: "hello" },
        { type: "message", role: "assistant", phase: "final_answer", content: "Final answer." },
      ],
    });
    expect(rewritten.requestNormalization).toEqual({
      droppedDuplicateProviderInputIds: [],
      droppedDuplicateProviderInputCount: 0,
      scrubbedAssistantReplayCount: 1,
      scrubbedAssistantReplayRules: ["phase-commentary"],
    });
  });

  it("scrubs assistant pseudo-tool artifact replay items without phase", async () => {
    const body = {
      model: "gpt-5.4",
      input: [
        { type: "message", role: "user", content: "hello" },
        {
          type: "message",
          role: "assistant",
          content: 'to=sessions_spawn worker/json\n{"runtime":"acp","agentId":"codex"}',
        },
        { type: "message", role: "assistant", phase: "final_answer", content: "Final answer." },
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
        scrubAssistantCommentaryReplay: true,
      },
      anthropic: {
        injectMetadataUserId: true,
        userId: undefined,
        userIdPrefix: "openclaw",
      },
    });

    expect(rewritten.jsonBody).toMatchObject({
      input: [
        { type: "message", role: "user", content: "hello" },
        { type: "message", role: "assistant", phase: "final_answer", content: "Final answer." },
      ],
    });
    expect(rewritten.requestNormalization).toEqual({
      droppedDuplicateProviderInputIds: [],
      droppedDuplicateProviderInputCount: 0,
      scrubbedAssistantReplayCount: 1,
      scrubbedAssistantReplayRules: ["pseudo-tool-artifact"],
    });
  });

  it("scrubs adjacent assistant JSON argument items after a pseudo-tool artifact", async () => {
    const body = {
      model: "gpt-5.4",
      input: [
        { type: "message", role: "user", content: "hello" },
        { type: "message", role: "assistant", content: "to=sessions_spawn worker/json" },
        {
          type: "message",
          role: "assistant",
          content: '{"runtime":"acp","agentId":"codex","message":"run task"}',
        },
        { type: "message", role: "assistant", phase: "final_answer", content: "Final answer." },
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
        scrubAssistantCommentaryReplay: true,
      },
      anthropic: {
        injectMetadataUserId: true,
        userId: undefined,
        userIdPrefix: "openclaw",
      },
    });

    expect(rewritten.jsonBody).toMatchObject({
      input: [
        { type: "message", role: "user", content: "hello" },
        { type: "message", role: "assistant", phase: "final_answer", content: "Final answer." },
      ],
    });
    expect(rewritten.requestNormalization).toEqual({
      droppedDuplicateProviderInputIds: [],
      droppedDuplicateProviderInputCount: 0,
      scrubbedAssistantReplayCount: 2,
      scrubbedAssistantReplayRules: ["pseudo-tool-artifact"],
    });
  });

  it("preserves final answers, reasoning, and function call items while scrubbing assistant replay", async () => {
    const body = {
      model: "gpt-5.4",
      input: [
        { id: "rs_keep", type: "reasoning", summary: [] },
        {
          type: "function_call",
          call_id: "call_lookup_weather",
          name: "lookup_weather",
          arguments: '{"city":"Tokyo"}',
        },
        {
          type: "function_call_output",
          call_id: "call_lookup_weather",
          output: '{"temperatureC":21}',
        },
        { type: "message", role: "assistant", phase: "commentary", content: "Working on it." },
        { type: "message", role: "assistant", phase: "final_answer", content: "Done." },
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
        scrubAssistantCommentaryReplay: true,
      },
      anthropic: {
        injectMetadataUserId: true,
        userId: undefined,
        userIdPrefix: "openclaw",
      },
    });

    expect(rewritten.jsonBody).toMatchObject({
      input: [
        { id: "rs_keep", type: "reasoning", summary: [] },
        {
          type: "function_call",
          call_id: "call_lookup_weather",
          name: "lookup_weather",
          arguments: '{"city":"Tokyo"}',
        },
        {
          type: "function_call_output",
          call_id: "call_lookup_weather",
          output: '{"temperatureC":21}',
        },
        { type: "message", role: "assistant", phase: "final_answer", content: "Done." },
      ],
    });
    expect(rewritten.requestNormalization).toEqual({
      droppedDuplicateProviderInputIds: [],
      droppedDuplicateProviderInputCount: 0,
      scrubbedAssistantReplayCount: 1,
      scrubbedAssistantReplayRules: ["phase-commentary"],
    });
  });

  it("drops orphaned function_call_output items that have no matching function_call", async () => {
    const body = {
      model: "gpt-5.4",
      input: [
        {
          type: "function_call",
          call_id: "call_write_ok",
          name: "write",
          arguments: '{"path":"a.txt","content":"ok"}',
        },
        {
          type: "function_call_output",
          call_id: "call_write_ok",
          output: "ok",
        },
        {
          type: "function_call_output",
          call_id: "call_write_orphan",
          output: "should be dropped",
        },
        { type: "message", role: "assistant", phase: "final_answer", content: "Done." },
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
        scrubAssistantCommentaryReplay: true,
      },
      anthropic: {
        injectMetadataUserId: true,
        userId: undefined,
        userIdPrefix: "openclaw",
      },
    });

    expect(rewritten.jsonBody).toMatchObject({
      input: [
        {
          type: "function_call",
          call_id: "call_write_ok",
          name: "write",
          arguments: '{"path":"a.txt","content":"ok"}',
        },
        {
          type: "function_call_output",
          call_id: "call_write_ok",
          output: "ok",
        },
        { type: "message", role: "assistant", phase: "final_answer", content: "Done." },
      ],
    });
    expect(rewritten.requestNormalization).toEqual({
      droppedDuplicateProviderInputIds: [],
      droppedDuplicateProviderInputCount: 0,
      droppedOrphanFunctionCallOutputCount: 1,
      droppedOrphanFunctionCallOutputCallIds: ["call_write_orphan"],
    });
  });

  it("preserves function_call_output items when a matching function_call exists earlier in input", async () => {
    const body = {
      model: "gpt-5.4",
      input: [
        { type: "message", role: "user", content: "hello" },
        {
          type: "function_call",
          call_id: "call_lookup_weather",
          name: "lookup_weather",
          arguments: '{"city":"Tokyo"}',
        },
        {
          type: "function_call_output",
          call_id: "call_lookup_weather",
          output: '{"temperatureC":21}',
        },
        { type: "message", role: "assistant", phase: "final_answer", content: "Done." },
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
        scrubAssistantCommentaryReplay: true,
      },
      anthropic: {
        injectMetadataUserId: true,
        userId: undefined,
        userIdPrefix: "openclaw",
      },
    });

    expect(rewritten.jsonBody).toMatchObject({
      input: body.input,
    });
    expect(rewritten.requestNormalization).toBeUndefined();
  });

  it("does not scrub user messages that mention pseudo-tool artifact text", async () => {
    const body = {
      model: "gpt-5.4",
      input: [
        {
          type: "message",
          role: "user",
          content: 'Please explain why logs contain to=sessions_spawn worker/json\n{"runtime":"acp"}',
        },
        { type: "message", role: "assistant", phase: "final_answer", content: "It is from a replay artifact." },
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
        scrubAssistantCommentaryReplay: true,
      },
      anthropic: {
        injectMetadataUserId: true,
        userId: undefined,
        userIdPrefix: "openclaw",
      },
    });

    expect(rewritten.jsonBody).toMatchObject({
      input: body.input,
    });
    expect(rewritten.requestNormalization).toBeUndefined();
  });

  it("does not scrub assistant replay items when the feature flag is disabled", async () => {
    const body = {
      model: "gpt-5.4",
      input: [
        { type: "message", role: "user", content: "hello" },
        { type: "message", role: "assistant", phase: "commentary", content: "I will check that now." },
        { type: "message", role: "assistant", phase: "final_answer", content: "Final answer." },
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
        scrubAssistantCommentaryReplay: false,
      },
      anthropic: {
        injectMetadataUserId: true,
        userId: undefined,
        userIdPrefix: "openclaw",
      },
    });

    expect(rewritten.jsonBody).toMatchObject({
      input: body.input,
    });
    expect(rewritten.requestNormalization).toBeUndefined();
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
        scrubAssistantCommentaryReplay: true,
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
        scrubAssistantCommentaryReplay: true,
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
        scrubAssistantCommentaryReplay: true,
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
