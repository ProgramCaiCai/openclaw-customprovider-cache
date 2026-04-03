import type { SemanticFailureInfo, StreamInspectionResult } from "./types.js";

const CONTEXT_WINDOW_PATTERN = /context(?:[_ -]?length| window).*(?:exceed|limit)|input exceeds the context window/i;
const QUOTA_PATTERN = /insufficient_quota|quota exceeded|quota exhausted|billing details/i;
const USAGE_NOT_INCLUDED_PATTERN = /usage[_ -]?not[_ -]?included/i;
const INVALID_REQUEST_PATTERN = /invalid[_ -]?prompt|invalid request|limited access to this content|safety reasons/i;
const OVERLOADED_PATTERN = /server_is_overloaded|slow_down|overload|capacity|temporarily unavailable|service_unavailable|busy/i;
const RATE_LIMIT_PATTERN = /rate[_ -]?limit|too many requests|resource exhausted|throttl/i;

const PARTIAL_STREAM_PATTERN = /after visible output.*terminal success event|visible output.*terminal success event/i;

function resolveBaseMessage(summary: StreamInspectionResult): string {
  return (
    summary.semanticError?.message ??
    (summary.semanticState === "ended-empty"
      ? "stream ended without a terminal success event"
      : summary.semanticState === "aborted"
        ? "stream aborted before a terminal success event"
        : summary.semanticState === "error-after-partial"
          ? "stream ended after visible output without a terminal success event"
          : "upstream stream reported a terminal failure")
  );
}

function resolveProviderStatus(summary: StreamInspectionResult): number | undefined {
  return summary.semanticError?.providerStatus ?? summary.semanticError?.status;
}

function buildFingerprint(summary: StreamInspectionResult, baseMessage: string): string {
  return [summary.semanticError?.code, baseMessage].filter(Boolean).join(" ").toLowerCase();
}

function parseRetryAfterMs(message: string): number | undefined {
  const secondMatch = message.match(/(?:try again|retry)(?:[^\d]{0,20}|\s+in\s+)(\d+(?:\.\d+)?)\s*s\b/i);
  if (secondMatch) {
    return Math.round(Number(secondMatch[1]) * 1000);
  }

  const millisecondMatch = message.match(/(?:try again|retry)(?:[^\d]{0,20}|\s+in\s+)(\d+)\s*ms\b/i);
  if (millisecondMatch) {
    return Number(millisecondMatch[1]);
  }

  return undefined;
}

export function classifySemanticFailure(summary: StreamInspectionResult): SemanticFailureInfo {
  const message = resolveBaseMessage(summary);
  const providerStatus = resolveProviderStatus(summary);
  const fingerprint = buildFingerprint(summary, message);

  if (summary.semanticState === "ended-empty") {
    return {
      status: 408,
      code: "STREAM_ENDED_EMPTY",
      message,
      providerStatus,
      classification: "retryable-stream-empty",
      retryable: true,
      retryAfterMs: undefined,
    };
  }

  if (summary.semanticState === "aborted") {
    return {
      status: 408,
      code: "STREAM_ABORTED",
      message,
      providerStatus,
      classification: "retryable-stream-aborted",
      retryable: true,
      retryAfterMs: undefined,
    };
  }

  if (CONTEXT_WINDOW_PATTERN.test(fingerprint)) {
    return {
      status: providerStatus ?? 400,
      code: "CONTEXT_WINDOW_EXCEEDED",
      message,
      providerStatus,
      classification: "context-window-exceeded",
      retryable: false,
    };
  }

  if (QUOTA_PATTERN.test(fingerprint)) {
    return {
      status: providerStatus ?? 429,
      code: "QUOTA_EXCEEDED",
      message,
      providerStatus,
      classification: "quota-exceeded",
      retryable: false,
    };
  }

  if (USAGE_NOT_INCLUDED_PATTERN.test(fingerprint)) {
    return {
      status: providerStatus ?? 429,
      code: "USAGE_NOT_INCLUDED",
      message,
      providerStatus,
      classification: "usage-not-included",
      retryable: false,
    };
  }

  if (INVALID_REQUEST_PATTERN.test(fingerprint)) {
    return {
      status: providerStatus ?? 400,
      code: "INVALID_REQUEST",
      message,
      providerStatus,
      classification: "invalid-request",
      retryable: false,
    };
  }

  if (providerStatus === 503 || providerStatus === 529 || OVERLOADED_PATTERN.test(fingerprint)) {
    return {
      status: 503,
      code: "SERVER_OVERLOADED",
      message,
      providerStatus,
      classification: "server-overloaded",
      retryable: false,
    };
  }

  const retryAfterMs = parseRetryAfterMs(message);
  if (providerStatus === 429 || RATE_LIMIT_PATTERN.test(fingerprint) || retryAfterMs !== undefined) {
    return {
      status: providerStatus ?? 429,
      code: "RETRYABLE_STREAM_ERROR",
      message,
      providerStatus,
      classification: "retryable-stream",
      retryable: true,
      retryAfterMs,
    };
  }

  if (summary.semanticState === "error-after-partial" && PARTIAL_STREAM_PATTERN.test(message)) {
    return {
      status: providerStatus ?? summary.semanticError?.status ?? 502,
      code: "STREAM_TRUNCATED_AFTER_VISIBLE_OUTPUT",
      message,
      providerStatus,
      classification: "retryable-stream-partial",
      retryable: true,
      retryAfterMs,
    };
  }

  return {
    status: providerStatus ?? summary.semanticError?.status ?? 502,
    code: "RETRYABLE_STREAM_ERROR",
    message,
    providerStatus,
    classification: "retryable-stream",
    retryable: true,
    retryAfterMs,
  };
}
