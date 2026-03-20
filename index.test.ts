import { describe, expect, it, vi } from "vitest";

import plugin from "./index.js";

describe("plugin registration", () => {
  it("registers the renamed plugin and service ids", () => {
    const services: Array<{ id?: string }> = [];
    plugin.register({
      config: { models: { providers: {} } },
      pluginConfig: undefined,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      registerService: (service: { id?: string }) => {
        services.push(service);
      },
    });

    expect(plugin.id).toBe("openclaw-customprovider-cache");
    expect(plugin.name).toBe("OpenClaw Custom Provider Cache");
    expect(services).toHaveLength(1);
    expect(services[0]?.id).toBe("openclaw-customprovider-cache");
  });
});
