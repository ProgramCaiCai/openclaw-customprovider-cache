export type ProviderApi =
  | "openai-responses"
  | "openai-completions"
  | "openai-codex-responses"
  | "anthropic-messages"
  | (string & {});

export type ProviderModelConfig = {
  api?: ProviderApi;
};

export type ProviderConfig = {
  baseUrl: string;
  api?: ProviderApi;
  models?: ProviderModelConfig[];
};

export type OpenClawConfigLike = {
  models?: {
    providers?: Record<string, ProviderConfig>;
  };
};

export type PluginLogger = {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
};

export type NormalizedPluginConfig = {
  providers: string[];
  openai: {
    injectSessionIdHeader: boolean;
    injectPromptCacheKey: boolean;
  };
  anthropic: {
    injectMetadataUserId: boolean;
    userId?: string;
    userIdPrefix: string;
  };
};

export type StableIdentity = {
  userId: string;
  fallbackSessionId: string;
};

export type FetchRewriteRule = {
  provider: string;
  api: ProviderApi;
  baseUrl: string;
};

export type ServiceParams = {
  config: OpenClawConfigLike;
  pluginConfig: NormalizedPluginConfig;
  stateDir: string;
  logger: PluginLogger;
};

export type ServiceContext = {
  config: OpenClawConfigLike;
  stateDir: string;
  logger: PluginLogger;
};

export type PluginApiLike = {
  config: OpenClawConfigLike;
  pluginConfig?: unknown;
  logger: PluginLogger;
  registerService: (service: {
    id: string;
    start: (ctx: ServiceContext) => Promise<void> | void;
    stop?: (ctx: ServiceContext) => Promise<void> | void;
  }) => void;
};
