import { describe, expect, it } from "vitest";

import { normalizePluginConfig } from "./config.js";

describe("normalizePluginConfig", () => {
  it("applies safe defaults", () => {
    expect(normalizePluginConfig(undefined)).toEqual({
      providers: [],
      semanticFailureGating: true,
      mainLikePostFirstTokenFailureEscalation: true,
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
    });
  });

  it("rejects non-string providers", () => {
    expect(() => normalizePluginConfig({ providers: [123] })).toThrow("providers");
  });

  it("normalizes request logging config", () => {
    expect(
      normalizePluginConfig({
        requestLogging: {
          enabled: true,
          path: " logs/forwarded.jsonl ",
        },
      }),
    ).toMatchObject({
      requestLogging: {
        enabled: true,
        path: "logs/forwarded.jsonl",
      },
    });
  });

  it("allows disabling semantic failure gating explicitly", () => {
    expect(
      normalizePluginConfig({
        semanticFailureGating: false,
      }),
    ).toMatchObject({
      semanticFailureGating: false,
    });
  });

  it("allows disabling assistant commentary replay scrubbing explicitly", () => {
    expect(
      normalizePluginConfig({
        openai: {
          scrubAssistantCommentaryReplay: false,
        },
      }),
    ).toMatchObject({
      openai: {
        scrubAssistantCommentaryReplay: false,
      },
    });
  });

  it("rejects non-boolean assistant commentary replay scrub config", () => {
    expect(() =>
      normalizePluginConfig({
        openai: {
          scrubAssistantCommentaryReplay: "yes",
        },
      }),
    ).toThrow("openai.scrubAssistantCommentaryReplay");
  });

  it("allows disabling main-like post-first-token escalation explicitly", () => {
    expect(
      normalizePluginConfig({
        mainLikePostFirstTokenFailureEscalation: false,
      }),
    ).toMatchObject({
      mainLikePostFirstTokenFailureEscalation: false,
    });
  });

  it("allows disabling subagent result stopgap explicitly", () => {
    expect(
      normalizePluginConfig({
        subagentResultStopgap: false,
      }),
    ).toMatchObject({
      subagentResultStopgap: false,
    });
  });
});
