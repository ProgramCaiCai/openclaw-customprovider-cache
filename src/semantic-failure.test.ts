import { describe, expect, it } from "vitest";

import { classifySemanticFailure } from "./semantic-failure.js";
import type { StreamInspectionResult } from "./types.js";

describe("classifySemanticFailure", () => {
  it("maps context window failures to a non-retryable Codex-like category", () => {
    const summary: StreamInspectionResult = {
      semanticState: "error",
      sawVisibleOutput: false,
      semanticError: {
        status: 400,
        providerStatus: 400,
        code: "context_length_exceeded",
        message: "Your input exceeds the context window of this model.",
      },
    };

    expect(classifySemanticFailure(summary)).toMatchObject({
      status: 400,
      providerStatus: 400,
      code: "CONTEXT_WINDOW_EXCEEDED",
      classification: "context-window-exceeded",
      retryable: false,
    });
  });

  it("maps generic response.failed payloads with retry hints to retryable stream errors", () => {
    const summary: StreamInspectionResult = {
      semanticState: "error",
      sawVisibleOutput: false,
      semanticError: {
        status: 500,
        providerStatus: 500,
        code: "server_error",
        message: "Temporary upstream failure. Please try again in 11.054s.",
      },
    };

    expect(classifySemanticFailure(summary)).toMatchObject({
      status: 500,
      providerStatus: 500,
      code: "RETRYABLE_STREAM_ERROR",
      classification: "retryable-stream",
      retryable: true,
      retryAfterMs: 11054,
    });
  });

  it("distinguishes empty-ended streams from aborted streams", () => {
    const endedEmpty: StreamInspectionResult = {
      semanticState: "ended-empty",
      sawVisibleOutput: false,
      semanticError: {
        message: "stream ended without a terminal success event",
      },
    };
    const aborted: StreamInspectionResult = {
      semanticState: "aborted",
      sawVisibleOutput: false,
      semanticError: {
        message: "stream aborted before a terminal success event",
      },
    };

    expect(classifySemanticFailure(endedEmpty)).toMatchObject({
      status: 408,
      code: "STREAM_ENDED_EMPTY",
      classification: "retryable-stream-empty",
      retryable: true,
    });
    expect(classifySemanticFailure(aborted)).toMatchObject({
      status: 408,
      code: "STREAM_ABORTED",
      classification: "retryable-stream-aborted",
      retryable: true,
    });
  });

  it("distinguishes partial visible-output truncation from generic retryable stream errors", () => {
    const summary: StreamInspectionResult = {
      semanticState: "error-after-partial",
      sawVisibleOutput: true,
      semanticError: {
        message: "stream ended after visible output without a terminal success event",
      },
    };

    expect(classifySemanticFailure(summary)).toMatchObject({
      status: 502,
      code: "STREAM_TRUNCATED_AFTER_VISIBLE_OUTPUT",
      classification: "retryable-stream-partial",
      retryable: true,
    });
  });
});
