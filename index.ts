import { normalizePluginConfig } from "./src/config.js";
import { SessionMetadataProxyService } from "./src/proxy-service.js";
import type { PluginApiLike } from "./src/types.js";

const plugin = {
  id: "openclaw-customprovider-cache",
  name: "OpenClaw Custom Provider Cache",
  description: "Independent OpenClaw plugin that preserves provider-native cache/session identifiers for custom providers.",
  register(api: PluginApiLike) {
    const pluginConfig = normalizePluginConfig(api.pluginConfig, {
      warn: (message) => api.logger.warn(message),
    });
    let service: SessionMetadataProxyService | undefined;

    api.registerService({
      id: "openclaw-customprovider-cache",
      start: async (ctx) => {
        service = new SessionMetadataProxyService({
          config: ctx.config,
          pluginConfig,
          stateDir: ctx.stateDir,
          logger: ctx.logger,
        });
        await service.start();
      },
      stop: async () => {
        await service?.stop();
        service = undefined;
      },
    });
  },
};

export default plugin;
