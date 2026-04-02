import {
  createPersistedAttemptLedger,
  type AttemptLedger,
} from "./attempt-ledger.js";
import {
  createPersistedSessionRecoveryTracker,
  type SessionRecoveryTracker,
} from "./session-recovery.js";
import {
  createPersistedNormalizationLedger,
  type NormalizationLedger,
} from "./normalization-ledger.js";
import { createPatchedFetch } from "./fetch-patch.js";
import { resolveStableIdentity } from "./identity.js";
import { createForwardedRequestLogger } from "./request-logging.js";
import type {
  FetchRewriteRule,
  ForwardedRequestLogger,
  ProviderApi,
  ServiceParams,
} from "./types.js";

const SUPPORTED_APIS = new Set<ProviderApi>([
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
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
  private requestLogger?: ForwardedRequestLogger;
  private sessionRecoveryTracker?: SessionRecoveryTracker;
  private normalizationLedger?: NormalizationLedger;
  private attemptLedger?: AttemptLedger;
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
    this.requestLogger = createForwardedRequestLogger({
      config: this.params.pluginConfig.requestLogging,
      stateDir: this.params.stateDir,
      logger: this.params.logger,
    });
    this.sessionRecoveryTracker = await createPersistedSessionRecoveryTracker({
      stateDir: this.params.stateDir,
      fallbackSessionId: identity.fallbackSessionId,
      logger: this.params.logger,
    });
    this.normalizationLedger = await createPersistedNormalizationLedger({
      stateDir: this.params.stateDir,
      logger: this.params.logger,
    });
    this.attemptLedger = await createPersistedAttemptLedger({
      stateDir: this.params.stateDir,
      logger: this.params.logger,
    });
    this.originalFetch = globalThis.fetch;
    globalThis.fetch = createPatchedFetch({
      originalFetch: this.originalFetch,
      requestLogger: this.requestLogger,
      normalizationLedger: this.normalizationLedger,
      sessionRecoveryTracker: this.sessionRecoveryTracker,
      attemptLedger: this.attemptLedger,
      pluginInstallationId: identity.installationId,
      rules,
      stableUserId: identity.userId,
      fallbackSessionId: identity.fallbackSessionId,
      semanticFailureGating: this.params.pluginConfig.semanticFailureGating,
      mainLikePostFirstTokenFailureEscalation:
        this.params.pluginConfig.mainLikePostFirstTokenFailureEscalation,
      subagentResultStopgap: this.params.pluginConfig.subagentResultStopgap,
      openai: this.params.pluginConfig.openai,
      anthropic: this.params.pluginConfig.anthropic,
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
    await this.requestLogger?.flush();
    await this.normalizationLedger?.flush();
    await this.sessionRecoveryTracker?.flush();
    await this.attemptLedger?.flush();
    this.requestLogger = undefined;
    this.normalizationLedger = undefined;
    this.sessionRecoveryTracker = undefined;
    this.attemptLedger = undefined;
    this.running = false;
    this.params.logger.info("openclaw-customprovider-cache disabled");
  }
}
