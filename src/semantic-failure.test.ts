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
});
