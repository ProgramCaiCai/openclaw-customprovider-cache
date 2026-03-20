import { describe, expect, it } from "vitest";

import { normalizePluginConfig } from "./config.js";

describe("normalizePluginConfig", () => {
  it("applies safe defaults", () => {
    expect(normalizePluginConfig(undefined)).toEqual({
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
  });

  it("rejects non-string providers", () => {
    expect(() => normalizePluginConfig({ providers: [123] })).toThrow("providers");
  });
});
