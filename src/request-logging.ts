import { appendFile, mkdir } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

import { resolveErrorPolicy } from "./error-policy.js";
import type {
  ForwardedRequestLogRecord,
  ForwardedRequestLogger,
  ForwardedResponseBodyState,
  ForwardedResponseLogRecord,
  ForwardedResponseSummaryLogRecord,
  NormalizedProviderErrorKind,
  PluginLogger,
  ProviderTerminalKind,
  RequestExecutionClass,
  RequestLoggingConfig,
  SemanticFailureInfo,
  SemanticState,
} from "./types.js";

const DEFAULT_LOG_PATH = "forwarded-requests.jsonl";
const MAX_CAPTURE_BYTES = 64 * 1024;
const REDACTED = "[REDACTED]";
const SENSITIVE_KEY_PATTERN =
  /^(authorization|proxy-authorization|x-api-key|api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|token|secret|password|cookie|set-cookie)$/i;
const OBVIOUS_SECRET_VALUE_PATTERNS = [
  /^Bearer\s+.+/i,
  /(?:^|[^a-z])(sk|rk|pk|ak)-[a-z0-9._-]{8,}/i,
];

function isJsonContentType(contentType: string | null): boolean {
  return /(^|\/|\+)json(?:$|[;\s])/i.test(contentType ?? "");
}

function isTextContentType(contentType: string | null): boolean {
  return /^text\//i.test(contentType ?? "");
}

function isStreamLikeContentType(contentType: string | null): boolean {
  const normalized = (contentType ?? "").toLowerCase();
  return (
    normalized.includes("text/event-stream") ||
    normalized.includes("application/x-ndjson") ||
    normalized.includes("application/json-seq")
  );
}

function resolveLogPath(stateDir: string, config: RequestLoggingConfig): string {
  if (!config.path) {
    return resolve(stateDir, DEFAULT_LOG_PATH);
  }
  return isAbsolute(config.path) ? config.path : resolve(stateDir, config.path);
}

function shouldRedactKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(key);
}

function sanitizeString(value: string): string {
  return OBVIOUS_SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(value)) ? REDACTED : value;
}

function sanitizeValue(value: unknown, key?: string): unknown {
  if (key && shouldRedactKey(key)) {
    return REDACTED;
  }

  if (typeof value === "string") {
    return sanitizeString(value);
  }

  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeValue(entry));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        sanitizeValue(entryValue, entryKey),
      ]),
    );
  }

  return value;
}

function sanitizeHeaders(headers: Headers): Record<string, string> {
  return Object.fromEntries(
    [...headers.entries()].map(([key, value]) => [key, sanitizeValue(value, key) as string]),
  );
}

function sanitizeBody(headers: Headers, bodyBuffer: Buffer): unknown {
  return sanitizeBodyBuffer(headers.get("content-type"), bodyBuffer);
}

function sanitizeBodyBuffer(contentType: string | null, bodyBuffer: Buffer): unknown {
  if (bodyBuffer.length === 0) {
    return undefined;
  }

  const bodyText = bodyBuffer.toString("utf8");
  if (isJsonContentType(contentType)) {
    try {
      return sanitizeValue(JSON.parse(bodyText));
    } catch {
      return sanitizeString(bodyText);
    }
  }

  return sanitizeString(bodyText);
}

function resolveProviderTerminalKind(input: {
  status?: number;
  semanticState?: SemanticState;
}): ProviderTerminalKind | undefined {
  if (input.semanticState === "completed") {
    return "completed";
  }
  if (input.semanticState === "error" || input.semanticState === "error-after-partial") {
    return "semantic-error";
  }
  if (input.semanticState === "unknown-stream") {
    return "unknown-stream";
  }
  if (input.semanticState === "ended-empty") {
    return "ended-empty";
  }
  if (input.semanticState === "aborted") {
    return "aborted";
  }
  if (input.status !== undefined && input.status >= 400) {
    return "transport-error";
  }
  return undefined;
}

function createRequestLogRecord(input: {
  requestId: string;
  provider: string;
  api: ForwardedRequestLogRecord["api"];
  url: string;
  method: string;
  headers: Headers;
  bodyBuffer: Buffer;
  requestNormalization?: ForwardedRequestLogRecord["requestNormalization"];
  correlation?: ForwardedRequestLogRecord["correlation"];
}): ForwardedRequestLogRecord {
  return {
    event: "request",
    requestId: input.requestId,
    timestamp: new Date().toISOString(),
    provider: input.provider,
    api: input.api,
    url: input.url,
    method: input.method,
    headers: sanitizeHeaders(input.headers),
    body: sanitizeBody(input.headers, input.bodyBuffer),
    requestNormalization: input.requestNormalization,
    correlation: input.correlation
      ? sanitizeValue(input.correlation) as ForwardedRequestLogRecord["correlation"]
      : undefined,
  };
}

function createResponseLogRecord(input: {
  requestId: string;
  provider: string;
  api: ForwardedResponseLogRecord["api"];
  url: string;
  status: number;
  headers: Headers;
  body?: unknown;
  bodyState: ForwardedResponseBodyState;
  truncated: boolean;
  semanticState?: SemanticState;
  semanticError?: SemanticFailureInfo;
  executionClass?: RequestExecutionClass;
  correlation?: ForwardedResponseLogRecord["correlation"];
}): ForwardedResponseLogRecord {
  const semanticState =
    input.semanticState ?? (input.bodyState === "stream-like" ? "unknown-stream" : undefined);
  const errorPolicy = resolveErrorPolicy({
    transportStatus: input.status,
    semanticState,
    semanticError: input.semanticError,
    body: input.body,
  });

  return {
    event: "response",
    requestId: input.requestId,
    timestamp: new Date().toISOString(),
    provider: input.provider,
    api: input.api,
    url: input.url,
    status: input.status,
    headers: sanitizeHeaders(input.headers),
    body: input.body,
    bodyState: input.bodyState,
    truncated: input.truncated,
    semanticState,
    semanticError: input.semanticError ? sanitizeValue(input.semanticError) as SemanticFailureInfo : undefined,
    executionClass: input.executionClass,
    providerStatus: errorPolicy.providerStatus,
    providerTerminalKind: resolveProviderTerminalKind({ status: input.status, semanticState }),
    normalizedErrorKind: errorPolicy.normalizedErrorKind,
    errorPolicyKind: errorPolicy.kind,
    correlation: input.correlation
      ? sanitizeValue(input.correlation) as ForwardedResponseLogRecord["correlation"]
      : undefined,
  };
}

function createResponseSummaryLogRecord(input: {
  requestId: string;
  provider: string;
  api: ForwardedResponseSummaryLogRecord["api"];
  url: string;
  semanticState: ForwardedResponseSummaryLogRecord["semanticState"];
  semanticError?: SemanticFailureInfo;
  executionClass?: RequestExecutionClass;
  transportStatus?: number;
  streamIntegrity?: ForwardedResponseSummaryLogRecord["streamIntegrity"];
  correlation?: ForwardedResponseSummaryLogRecord["correlation"];
}): ForwardedResponseSummaryLogRecord {
  const errorPolicy = resolveErrorPolicy({
    transportStatus: input.transportStatus,
    semanticState: input.semanticState,
    semanticError: input.semanticError,
  });

  return {
    event: "response-summary",
    requestId: input.requestId,
    timestamp: new Date().toISOString(),
    provider: input.provider,
    api: input.api,
    url: input.url,
    semanticState: input.semanticState,
    semanticError: input.semanticError ? sanitizeValue(input.semanticError) as SemanticFailureInfo : undefined,
    executionClass: input.executionClass,
    transportStatus: input.transportStatus,
    providerStatus: errorPolicy.providerStatus,
    providerTerminalKind: resolveProviderTerminalKind({ semanticState: input.semanticState }),
    normalizedErrorKind: errorPolicy.normalizedErrorKind,
    errorPolicyKind: errorPolicy.kind,
    streamIntegrity: input.streamIntegrity
      ? sanitizeValue(input.streamIntegrity) as ForwardedResponseSummaryLogRecord["streamIntegrity"]
      : undefined,
    correlation: input.correlation
      ? sanitizeValue(input.correlation) as ForwardedResponseSummaryLogRecord["correlation"]
      : undefined,
  };
}

async function captureResponseBody(response: Response): Promise<{
  body?: unknown;
  bodyState: ForwardedResponseBodyState;
  truncated: boolean;
}> {
  const contentType = response.headers.get("content-type");
  if (response.body === null) {
    return {
      body: undefined,
      bodyState: "unavailable",
      truncated: false,
    };
  }

  if (isStreamLikeContentType(contentType)) {
    return {
      body: undefined,
      bodyState: "stream-like",
      truncated: false,
    };
  }

  if (!isJsonContentType(contentType) && !isTextContentType(contentType)) {
    return {
      body: undefined,
      bodyState: "binary",
      truncated: false,
    };
  }

  let cloned: Response;
  try {
    cloned = response.clone();
  } catch {
    return {
      body: undefined,
      bodyState: "unavailable",
      truncated: false,
    };
  }
  const reader = cloned.body?.getReader();
  if (!reader) {
    return {
      body: undefined,
      bodyState: "unavailable",
      truncated: false,
    };
  }

  const chunks: Buffer[] = [];
  let totalBytes = 0;
  let truncated = false;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!value || value.byteLength === 0) {
        continue;
      }

      const remaining = MAX_CAPTURE_BYTES - totalBytes;
      if (remaining <= 0) {
        truncated = true;
        break;
      }

      const capturedChunk = value.byteLength > remaining ? value.subarray(0, remaining) : value;
      chunks.push(Buffer.from(capturedChunk));
      totalBytes += capturedChunk.byteLength;

      if (capturedChunk.byteLength !== value.byteLength) {
        truncated = true;
        break;
      }
    }
  } catch {
    return {
      body: undefined,
      bodyState: "unavailable",
      truncated: false,
    };
  } finally {
    if (truncated) {
      await reader.cancel().catch(() => undefined);
    }
  }

  const bodyBuffer = Buffer.concat(chunks);
  const body = sanitizeBodyBuffer(contentType, bodyBuffer);
  if (bodyBuffer.length === 0) {
    return {
      body: undefined,
      bodyState: "unavailable",
      truncated: false,
    };
  }

  return {
    body,
    bodyState: truncated ? "truncated" : "captured",
    truncated,
  };
}

export function createForwardedRequestLogger(params: {
  config: RequestLoggingConfig;
  stateDir: string;
  logger: PluginLogger;
}): ForwardedRequestLogger | undefined {
  if (!params.config.enabled) {
    return undefined;
  }

  const logPath = resolveLogPath(params.stateDir, params.config);
  let ready: Promise<void> | undefined;
  let pendingWrite: Promise<void> = Promise.resolve();
  const inflightTasks = new Set<Promise<void>>();

  const ensureLogDir = (): Promise<void> => {
    ready ??= mkdir(dirname(logPath), { recursive: true }).then(() => undefined);
    return ready;
  };

  const warnLogFailure = (error: unknown): void => {
    params.logger.warn(
      `openclaw-customprovider-cache failed to append forwarded traffic log: ${error instanceof Error ? error.message : String(error)}`,
    );
  };

  const trackTask = (task: Promise<void>): Promise<void> => {
    inflightTasks.add(task);
    task.finally(() => inflightTasks.delete(task)).catch(() => undefined);
    return task;
  };

  const enqueueAppend = (buildLine: () => Promise<string> | string): Promise<void> =>
    trackTask(
      (async () => {
        const line = await buildLine();
        pendingWrite = pendingWrite
          .then(async () => {
            await ensureLogDir();
            await appendFile(logPath, line, "utf8");
          })
          .catch((error) => {
            warnLogFailure(error);
            return undefined;
          });
        await pendingWrite;
      })().catch((error) => {
        warnLogFailure(error);
      }),
    );

  return {
    appendRequest: async (record) => {
      await enqueueAppend(async () => `${JSON.stringify(createRequestLogRecord(record))}\n`);
    },
    appendResponse: async (record) => {
      await enqueueAppend(async () => {
        const capturedBody = await captureResponseBody(record.response);
        const line = createResponseLogRecord({
          requestId: record.requestId,
          provider: record.provider,
          api: record.api,
          url: record.url,
          status: record.response.status,
          headers: record.response.headers,
          body: capturedBody.body,
          bodyState: capturedBody.bodyState,
          truncated: capturedBody.truncated,
          semanticState: record.semanticState,
          semanticError: record.semanticError,
          executionClass: record.executionClass,
          correlation: record.correlation,
        });
        return `${JSON.stringify(line)}\n`;
      });
    },
    appendResponseSummary: async (record) => {
      await enqueueAppend(
        async () => `${JSON.stringify(createResponseSummaryLogRecord(record))}\n`,
      );
    },
    flush: async () => {
      await Promise.allSettled([...inflightTasks]);
      await pendingWrite;
    },
  };
}

export { DEFAULT_LOG_PATH, REDACTED };
