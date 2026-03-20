import { createPatchedFetch } from "./fetch-patch.js";
import { resolveStableIdentity } from "./identity.js";
import type { FetchRewriteRule, ProviderApi, ServiceParams } from "./types.js";

const SUPPORTED_APIS = new Set<ProviderApi>([
  "openai-responses",
  "anthropic-messages",
]);

function resolveProviderApi(provider: string, config: ServiceParams["config"]): ProviderApi | undefined {
  const entry = config.models?.providers?.[provider];
  const candidates = [
    entry?.api,
    ...(entry?.models?.map((model) => model.api).filter(Boolean) ?? []),
  ].filter(Boolean) as ProviderApi[];
  if (candidates.length > 0) {
    const firstSupported = candidates.find((candidate) => SUPPORTED_APIS.has(candidate));
    return firstSupported ?? candidates[0];
  }
  return undefined;
}

function resolveRules(params: ServiceParams): FetchRewriteRule[] {
  const providers = params.config.models?.providers ?? {};
  const allowlist = new Set(params.pluginConfig.providers);

  return Object.entries(providers)
    .filter(([provider]) => allowlist.size === 0 || allowlist.has(provider))
    .map(([provider, entry]) => ({
      provider,
      api: resolveProviderApi(provider, params.config) ?? "openai-responses",
      baseUrl: entry.baseUrl?.trim() ?? "",
    }))
    .filter((rule) => rule.baseUrl.length > 0 && SUPPORTED_APIS.has(rule.api));
}

export class SessionMetadataProxyService {
  private readonly params: ServiceParams;
  private originalFetch?: typeof globalThis.fetch;
  private running = false;

  constructor(params: ServiceParams) {
    this.params = params;
  }

  async start(): Promise<void> {
    if (this.running) return;
    const identity = await resolveStableIdentity({
      stateDir: this.params.stateDir,
      prefix: this.params.pluginConfig.anthropic.userIdPrefix,
      userIdOverride: this.params.pluginConfig.anthropic.userId,
      logger: this.params.logger,
    });
    const rules = resolveRules(this.params);
    this.originalFetch = globalThis.fetch;
    globalThis.fetch = createPatchedFetch({
      originalFetch: this.originalFetch,
      rules,
      stableUserId: identity.userId,
      fallbackSessionId: identity.fallbackSessionId,
      openai: this.params.pluginConfig.openai,
      anthropic: this.params.pluginConfig.anthropic,
      providers: this.params.pluginConfig.providers,
    });
    this.running = true;
    this.params.logger.info(
      rules.length > 0
        ? `openclaw-customprovider-cache enabled for providers: ${rules.map((rule) => rule.provider).join(", ")}`
        : "openclaw-customprovider-cache enabled with no matching configured providers",
    );
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    if (this.originalFetch) {
      globalThis.fetch = this.originalFetch;
      this.originalFetch = undefined;
    }
    this.running = false;
    this.params.logger.info("openclaw-customprovider-cache disabled");
  }
}
