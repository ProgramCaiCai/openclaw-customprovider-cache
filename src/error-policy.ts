import type {
  NormalizedProviderErrorKind,
  SemanticFailureInfo,
  SemanticState,
} from "./types.js";

const INVALID_STREAM_PATTERN =
  /invalid stream|malformed|unexpected end|stream ended without a terminal success event|stream aborted before a terminal success event/;
const AUTH_PATTERN = /unauth|invalid api key|permission denied|forbidden|credential/;
const RATE_LIMIT_PATTERN = /rate[_ -]?limit|too many requests|quota|resource exhausted|throttl/;
const OVERLOAD_PATTERN = /overload|capacity|busy|temporar(?:y|ily unavailable)|unavailable/;

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

export type ErrorPolicyDecision = {
  kind: ErrorPolicyKind;
  normalizedErrorKind?: NormalizedProviderErrorKind;
  providerStatus?: number;
  retryable: boolean;
  retryAfterMs?: number;
  safeMessage?: string;
};

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
  transportStatus?: number;
  semanticError?: SemanticFailureInfo;
  body?: unknown;
}): number | undefined {
  return (
    input.semanticError?.providerStatus ??
    input.semanticError?.status ??
    extractProviderErrorDetails(input.body).status ??
    (input.transportStatus !== undefined && input.transportStatus >= 400
      ? input.transportStatus
      : undefined)
  );
}

function buildFingerprint(input: {
  semanticError?: SemanticFailureInfo;
  body?: unknown;
}): string {
  const providerDetails = extractProviderErrorDetails(input.body);
  return [
    input.semanticError?.code,
    input.semanticError?.message,
    providerDetails.code,
    providerDetails.message,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

export function resolveErrorPolicy(input: {
  transportStatus?: number;
  semanticState?: SemanticState;
  semanticError?: SemanticFailureInfo;
  body?: unknown;
}): ErrorPolicyDecision {
  const providerStatus = resolveProviderStatus(input);
  const fingerprint = buildFingerprint(input);

  if (input.semanticError?.syntheticFailure) {
    return {
      kind: "synthetic-stopgap-error",
      providerStatus,
      retryable: input.semanticError.retryable ?? true,
      retryAfterMs: input.semanticError.retryAfterMs,
      safeMessage: input.semanticError.message,
    };
  }

  if (input.semanticState === "ended-empty" || input.semanticState === "aborted") {
    return {
      kind: "invalid-stream-error",
      normalizedErrorKind: "invalid-stream",
      providerStatus,
      retryable: true,
      retryAfterMs: input.semanticError?.retryAfterMs,
      safeMessage: input.semanticError?.message,
    };
  }

  if (INVALID_STREAM_PATTERN.test(fingerprint)) {
    return {
      kind: "invalid-stream-error",
      normalizedErrorKind: "invalid-stream",
      providerStatus,
      retryable: true,
      retryAfterMs: input.semanticError?.retryAfterMs,
      safeMessage: input.semanticError?.message,
    };
  }

  if (
    providerStatus === 401 ||
    providerStatus === 403 ||
    AUTH_PATTERN.test(fingerprint)
  ) {
    return {
      kind: "auth-error",
      normalizedErrorKind: "auth",
      providerStatus,
      retryable: false,
      retryAfterMs: input.semanticError?.retryAfterMs,
      safeMessage: input.semanticError?.message,
    };
  }

  if (
    providerStatus === 429 ||
    RATE_LIMIT_PATTERN.test(fingerprint)
  ) {
    return {
      kind: "rate-limit-error",
      normalizedErrorKind: "rate-limit",
      providerStatus,
      retryable: true,
      retryAfterMs: input.semanticError?.retryAfterMs,
      safeMessage: input.semanticError?.message,
    };
  }

  if (
    providerStatus === 503 ||
    providerStatus === 529 ||
    OVERLOAD_PATTERN.test(fingerprint)
  ) {
    return {
      kind: "overload-error",
      normalizedErrorKind: "upstream-overloaded",
      providerStatus,
      retryable: true,
      retryAfterMs: input.semanticError?.retryAfterMs,
      safeMessage: input.semanticError?.message,
    };
  }

  if (input.semanticError?.classification === "retryable-stream" || input.semanticError?.retryable) {
    return {
      kind: "retryable-stream-error",
      providerStatus,
      retryable: true,
      retryAfterMs: input.semanticError?.retryAfterMs,
      safeMessage: input.semanticError?.message,
    };
  }

  if (input.semanticError) {
    return {
      kind: "semantic-provider-error",
      providerStatus,
      retryable: input.semanticError.retryable ?? false,
      retryAfterMs: input.semanticError.retryAfterMs,
      safeMessage: input.semanticError.message,
    };
  }

  if (input.transportStatus !== undefined && input.transportStatus >= 400) {
    return {
      kind: "transport-error",
      normalizedErrorKind:
        input.transportStatus >= 500 ? "upstream-overloaded" : undefined,
      providerStatus,
      retryable: input.transportStatus >= 500,
    };
  }

  return {
    kind: "none",
    providerStatus,
    retryable: false,
  };
}
