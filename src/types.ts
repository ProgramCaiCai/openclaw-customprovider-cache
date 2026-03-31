export type ProviderApi =
  | "openai-responses"
  | "openai-completions"
  | "openai-codex-responses"
  | "anthropic-messages"
  | "google-generative-ai"
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

export type RequestLoggingConfig = {
  enabled: boolean;
  path?: string;
};

export type SubagentResultStopgapVerdict =
  | "none"
  | "poisoned-child-result"
  | "empty-child-result";

export type SubagentResultStopgapReason =
  | "raw-child-result-dump"
  | "child-completion-without-deliverable-summary"
  | "child-completion-empty-output";

export type SubagentResultStopgapBoundedBlock = {
  kind: "internal-task-completion";
  text: string;
  result: string;
};

export type SemanticFailureClassification =
  | "context-window-exceeded"
  | "quota-exceeded"
  | "usage-not-included"
  | "invalid-request"
  | "server-overloaded"
  | "retryable-stream";

export type NormalizedPluginConfig = {
  providers: string[];
  semanticFailureGating: boolean;
  mainLikePostFirstTokenFailureEscalation?: boolean;
  subagentResultStopgap: boolean;
  requestLogging: RequestLoggingConfig;
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

export type SemanticState =
  | "unknown-stream"
  | "completed"
  | "error"
  | "ended-empty"
  | "aborted"
  | "error-after-partial";

export type RequestExecutionClass = "main-like" | "subagent-like" | "unknown";

export type NormalizedProviderErrorKind =
  | "auth"
  | "rate-limit"
  | "upstream-overloaded"
  | "invalid-stream";

export type ProviderTerminalKind =
  | "completed"
  | "semantic-error"
  | "unknown-stream"
  | "ended-empty"
  | "aborted"
  | "transport-error";

export type SemanticFailureInfo = {
  status?: number;
  code?: string;
  message: string;
  providerStatus?: number;
  classification?: SemanticFailureClassification;
  retryable?: boolean;
  retryAfterMs?: number;
  syntheticFailure?: boolean;
};

export type StreamInspectionResult = {
  semanticState: Exclude<SemanticState, "unknown-stream">;
  semanticError?: SemanticFailureInfo;
  sawVisibleOutput: boolean;
};

export type ForwardedRequestLogRecord = {
  event: "request";
  requestId: string;
  timestamp: string;
  provider: string;
  api: ProviderApi;
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
  requestNormalization?: {
    droppedDuplicateProviderInputIds: string[];
    droppedDuplicateProviderInputCount: number;
  };
};

export type ForwardedResponseBodyState =
  | "captured"
  | "truncated"
  | "stream-like"
  | "binary"
  | "unavailable";

export type ForwardedResponseLogRecord = {
  event: "response";
  requestId: string;
  timestamp: string;
  provider: string;
  api: ProviderApi;
  url: string;
  status: number;
  headers: Record<string, string>;
  body?: unknown;
  bodyState: ForwardedResponseBodyState;
  truncated: boolean;
  semanticState?: SemanticState;
  semanticError?: SemanticFailureInfo;
  executionClass?: RequestExecutionClass;
  providerStatus?: number;
  providerTerminalKind?: ProviderTerminalKind;
  normalizedErrorKind?: NormalizedProviderErrorKind;
};

export type ForwardedResponseSummaryLogRecord = {
  event: "response-summary";
  requestId: string;
  timestamp: string;
  provider: string;
  api: ProviderApi;
  url: string;
  semanticState: Exclude<SemanticState, "unknown-stream">;
  semanticError?: SemanticFailureInfo;
  executionClass?: RequestExecutionClass;
  transportStatus?: number;
  providerStatus?: number;
  providerTerminalKind?: ProviderTerminalKind;
  normalizedErrorKind?: NormalizedProviderErrorKind;
};

export type ForwardedRequestLogger = {
  appendRequest: (record: {
    requestId: string;
    provider: string;
    api: ProviderApi;
    url: string;
    method: string;
    headers: Headers;
    bodyBuffer: Buffer;
    requestNormalization?: ForwardedRequestLogRecord["requestNormalization"];
  }) => Promise<void>;
  appendResponse: (record: {
    requestId: string;
    provider: string;
    api: ProviderApi;
    url: string;
    response: Response;
    semanticState?: SemanticState;
    semanticError?: SemanticFailureInfo;
    executionClass?: RequestExecutionClass;
  }) => Promise<void>;
  appendResponseSummary: (record: {
    requestId: string;
    provider: string;
    api: ProviderApi;
    url: string;
    semanticState: Exclude<SemanticState, "unknown-stream">;
    semanticError?: SemanticFailureInfo;
    executionClass?: RequestExecutionClass;
    transportStatus?: number;
  }) => Promise<void>;
  flush: () => Promise<void>;
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
