import { describe, expect, it } from "vitest";

import { normalizePluginConfig } from "./config.js";

describe("normalizePluginConfig", () => {
  it("applies safe defaults", () => {
    expect(normalizePluginConfig(undefined)).toEqual({
      providers: [],
      semanticFailureGating: true,
      semanticRetry: {
        maxAttempts: 3,
        baseBackoffMs: 200,
        mainLikePostFirstTokenPolicy: "raise",
        subagentLikePostFirstTokenPolicy: "buffered-retry",
      },
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

  it("maps the legacy main-like boolean to semantic retry policy and warns", () => {
    const warnings: string[] = [];

    expect(
      normalizePluginConfig({
        mainLikePostFirstTokenFailureEscalation: false,
      }, {
        warn: (message) => warnings.push(message),
      }),
    ).toMatchObject({
      semanticRetry: {
        mainLikePostFirstTokenPolicy: "passthrough",
      },
    });
    expect(warnings).toEqual([
      expect.stringContaining("mainLikePostFirstTokenFailureEscalation"),
    ]);
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

  it("normalizes semantic retry policies explicitly", () => {
    expect(
      normalizePluginConfig({
        semanticRetry: {
          maxAttempts: 5,
          baseBackoffMs: 350,
          mainLikePostFirstTokenPolicy: "buffered-retry",
          subagentLikePostFirstTokenPolicy: "passthrough",
        },
      }),
    ).toMatchObject({
      semanticRetry: {
        maxAttempts: 5,
        baseBackoffMs: 350,
        mainLikePostFirstTokenPolicy: "buffered-retry",
        subagentLikePostFirstTokenPolicy: "passthrough",
      },
    });
  });

  it("prefers explicit semantic retry policy over legacy main-like boolean fallback", () => {
    const warnings: string[] = [];

    expect(
      normalizePluginConfig({
        mainLikePostFirstTokenFailureEscalation: false,
        semanticRetry: {
          mainLikePostFirstTokenPolicy: "raise",
        },
      }, {
        warn: (message) => warnings.push(message),
      }),
    ).toMatchObject({
      semanticRetry: {
        mainLikePostFirstTokenPolicy: "raise",
      },
    });
    expect(warnings).toEqual([
      expect.stringContaining("mainLikePostFirstTokenFailureEscalation"),
    ]);
  });

  it("rejects invalid semantic retry policy values", () => {
    expect(() =>
      normalizePluginConfig({
        semanticRetry: {
          mainLikePostFirstTokenPolicy: "retry",
        },
      }),
    ).toThrow("semanticRetry.mainLikePostFirstTokenPolicy");
  });

  it("rejects invalid semantic retry numeric values", () => {
    expect(() =>
      normalizePluginConfig({
        semanticRetry: {
          maxAttempts: 0,
        },
      }),
    ).toThrow("semanticRetry.maxAttempts");
    expect(() =>
      normalizePluginConfig({
        semanticRetry: {
          baseBackoffMs: -1,
        },
      }),
    ).toThrow("semanticRetry.baseBackoffMs");
  });
});
