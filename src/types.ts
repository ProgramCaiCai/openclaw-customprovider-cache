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

export type PostFirstTokenFailurePolicy = "passthrough" | "raise" | "buffered-retry";

export type SemanticRetryConfig = {
  maxAttempts: number;
  baseBackoffMs: number;
  mainLikePostFirstTokenPolicy: PostFirstTokenFailurePolicy;
  subagentLikePostFirstTokenPolicy: PostFirstTokenFailurePolicy;
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
  | "retryable-stream"
  | "retryable-stream-empty"
  | "retryable-stream-aborted"
  | "retryable-stream-partial";

export type NormalizedPluginConfig = {
  providers: string[];
  semanticFailureGating: boolean;
  semanticRetry: SemanticRetryConfig;
  subagentResultStopgap: boolean;
  requestLogging: RequestLoggingConfig;
  openai: {
    injectSessionIdHeader: boolean;
    injectPromptCacheKey: boolean;
    scrubAssistantCommentaryReplay: boolean;
  };
  anthropic: {
    injectMetadataUserId: boolean;
    userId?: string;
    userIdPrefix: string;
  };
};

export type StableIdentity = {
  installationId: string;
  userId: string;
  fallbackSessionId: string;
};

export type CorrelationEnvelope = {
  attemptId?: string;
  pluginInstallationId: string;
  stableUserId: string;
  provider: string;
  api: ProviderApi;
  model?: string;
  requestedSessionId?: string;
  effectiveSessionId?: string;
  recoverySessionId?: string;
  executionClass?: RequestExecutionClass;
  normalizationKey?: string;
  normalizationReplaySource?: "fresh" | "persisted";
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

export type ErrorPolicyKind =
  | "none"
  | "transport-error"
  | "auth-error"
  | "rate-limit-error"
  | "overload-error"
  | "invalid-stream-error"
  | "semantic-provider-error"
  | "synthetic-stopgap-error"
  | "retryable-stream-error";

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

export type StreamIntegrityTelemetry = {
  firstChunkAtMs?: number;
  firstVisibleOutputAtMs?: number;
  streamEndedAtMs?: number;
  terminalEventType?: string;
  malformedEventCount: number;
  ignoredJsonParseFailureCount: number;
  malformedEventPreviews?: string[];
  completedBeforeVisibleOutput?: boolean;
};

export type StreamInspectionResult = {
  semanticState: Exclude<SemanticState, "unknown-stream">;
  semanticError?: SemanticFailureInfo;
  sawVisibleOutput: boolean;
  streamIntegrity?: StreamIntegrityTelemetry;
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
    droppedOrphanFunctionCallOutputCount?: number;
    droppedOrphanFunctionCallOutputCallIds?: string[];
    scrubbedAssistantReplayCount?: number;
    scrubbedAssistantReplayRules?: string[];
    normalizationKey?: string;
    normalizationReplaySource?: "fresh" | "persisted";
    requestedSessionId?: string;
    effectiveSessionId?: string;
    effectivePromptCacheKey?: string;
    recoverySessionOverrideApplied?: boolean;
  };
  correlation?: CorrelationEnvelope;
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
  attemptId?: string;
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
  errorPolicyKind?: ErrorPolicyKind;
  correlation?: CorrelationEnvelope;
};

export type ForwardedResponseSummaryLogRecord = {
  event: "response-summary";
  requestId: string;
  attemptId?: string;
  attemptAbandoned?: boolean;
  timestamp: string;
  provider: string;
  api: ProviderApi;
  url: string;
  semanticState: Exclude<SemanticState, "unknown-stream">;
  sawVisibleOutput: boolean;
  semanticError?: SemanticFailureInfo;
  executionClass?: RequestExecutionClass;
  transportStatus?: number;
  providerStatus?: number;
  providerTerminalKind?: ProviderTerminalKind;
  normalizedErrorKind?: NormalizedProviderErrorKind;
  errorPolicyKind?: ErrorPolicyKind;
  streamIntegrity?: StreamIntegrityTelemetry;
  correlation?: CorrelationEnvelope;
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
    correlation?: CorrelationEnvelope;
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
    correlation?: CorrelationEnvelope;
    attemptId?: string;
  }) => Promise<void>;
  appendResponseSummary: (record: {
    requestId: string;
    attemptId?: string;
    provider: string;
    api: ProviderApi;
    url: string;
    semanticState: Exclude<SemanticState, "unknown-stream">;
    sawVisibleOutput: boolean;
    attemptAbandoned?: boolean;
    semanticError?: SemanticFailureInfo;
    executionClass?: RequestExecutionClass;
    transportStatus?: number;
    streamIntegrity?: StreamIntegrityTelemetry;
    correlation?: CorrelationEnvelope;
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
