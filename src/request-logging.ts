import { appendFile, mkdir } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

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

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function extractProviderErrorDetails(body: unknown): {
  status?: number;
  code?: string;
  message?: string;
} {
  const record = asRecord(body);
  const error = asRecord(record?.error) ?? record;
  return {
    status: asNumber(error?.status) ?? asNumber(error?.code),
    code: asString(error?.code) ?? asString(error?.status),
    message: asString(error?.message),
  };
}

function resolveProviderStatus(input: {
  status?: number;
  semanticError?: SemanticFailureInfo;
  body?: unknown;
}): number | undefined {
  return (
    input.semanticError?.providerStatus ??
    input.semanticError?.status ??
    extractProviderErrorDetails(input.body).status ??
    (input.status !== undefined && input.status >= 400 ? input.status : undefined)
  );
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

function resolveNormalizedErrorKind(input: {
  status?: number;
  semanticState?: SemanticState;
  semanticError?: SemanticFailureInfo;
  body?: unknown;
}): NormalizedProviderErrorKind | undefined {
  if (input.semanticState === "ended-empty" || input.semanticState === "aborted") {
    return "invalid-stream";
  }

  const providerDetails = extractProviderErrorDetails(input.body);
  const providerStatus = resolveProviderStatus(input);
  const fingerprint = [
    input.semanticError?.code,
    input.semanticError?.message,
    providerDetails.code,
    providerDetails.message,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (/invalid stream|malformed|unexpected end|stream ended without a terminal success event|stream aborted before a terminal success event/.test(fingerprint)) {
    return "invalid-stream";
  }

  if (
    providerStatus === 401 ||
    providerStatus === 403 ||
    /unauth|invalid api key|permission denied|forbidden|credential/.test(fingerprint)
  ) {
    return "auth";
  }

  if (
    providerStatus === 429 ||
    /rate[_ -]?limit|too many requests|quota|resource exhausted|throttl/.test(fingerprint)
  ) {
    return "rate-limit";
  }

  if (
    (providerStatus !== undefined && providerStatus >= 500) ||
    /overload|capacity|busy|temporar(?:y|ily unavailable)|unavailable/.test(fingerprint)
  ) {
    return "upstream-overloaded";
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
}): ForwardedResponseLogRecord {
  const semanticState =
    input.semanticState ?? (input.bodyState === "stream-like" ? "unknown-stream" : undefined);
  const providerStatus = resolveProviderStatus({
    status: input.status,
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
    providerStatus,
    providerTerminalKind: resolveProviderTerminalKind({ status: input.status, semanticState }),
    normalizedErrorKind: resolveNormalizedErrorKind({
      status: input.status,
      semanticState,
      semanticError: input.semanticError,
      body: input.body,
    }),
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
}): ForwardedResponseSummaryLogRecord {
  const providerStatus = resolveProviderStatus({
    status: input.transportStatus,
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
    providerStatus,
    providerTerminalKind: resolveProviderTerminalKind({ semanticState: input.semanticState }),
    normalizedErrorKind: resolveNormalizedErrorKind({
      status: input.transportStatus,
      semanticState: input.semanticState,
      semanticError: input.semanticError,
    }),
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

  const cloned = response.clone();
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
