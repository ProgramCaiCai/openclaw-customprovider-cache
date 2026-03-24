import { describe, expect, it } from "vitest";

import { normalizePluginConfig } from "./config.js";

describe("normalizePluginConfig", () => {
  it("applies safe defaults", () => {
    expect(normalizePluginConfig(undefined)).toEqual({
      providers: [],
      semanticFailureGating: true,
      requestLogging: {
        enabled: false,
        path: undefined,
      },
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
});
