import type {
  ProviderApi,
  SemanticFailureInfo,
  StreamInspectionResult,
  StreamIntegrityTelemetry,
} from "./types.js";

type StreamTracker = {
  readonly sawVisibleOutput: boolean;
  consumeChunk: (chunk: Uint8Array) => void;
  currentResult: () => StreamInspectionResult | undefined;
  finalize: () => StreamInspectionResult;
  abort: (reason?: unknown) => StreamInspectionResult;
};

export async function inspectSseStream(params: {
  api: ProviderApi;
  stream: ReadableStream<Uint8Array>;
  onVisibleOutput?: () => void;
}): Promise<StreamInspectionResult> {
  const tracker = createStreamTracker(params.api, params.onVisibleOutput);
  const reader = params.stream.getReader();

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        return tracker.finalize();
      }
      if (!value || value.byteLength === 0) {
        continue;
      }
      tracker.consumeChunk(value);
    }
  } catch (error) {
    return tracker.abort(error);
  } finally {
    reader.releaseLock();
  }
}

export function createStreamTracker(
  api: ProviderApi,
  onVisibleOutput?: () => void,
  now: () => number = Date.now,
): StreamTracker {
  const decoder = new TextDecoder();
  const startedAt = now();
  let buffer = "";
  let sawVisibleOutput = false;
  let terminalResult: StreamInspectionResult | undefined;
  let firstChunkAtMs: number | undefined;
  let firstVisibleOutputAtMs: number | undefined;
  let terminalEventType: string | undefined;
  let malformedEventCount = 0;
  let ignoredJsonParseFailureCount = 0;
  const malformedEventPreviews: string[] = [];

  const currentOffset = (): number => now() - startedAt;

  const buildStreamIntegrity = (): StreamIntegrityTelemetry => ({
    ...(firstChunkAtMs !== undefined ? { firstChunkAtMs } : {}),
    ...(firstVisibleOutputAtMs !== undefined ? { firstVisibleOutputAtMs } : {}),
    ...(terminalEventType ? { terminalEventType } : {}),
    malformedEventCount,
    ignoredJsonParseFailureCount,
    ...(malformedEventPreviews.length > 0 ? { malformedEventPreviews } : {}),
    ...(terminalResult?.semanticState === "completed" && !sawVisibleOutput
      ? { completedBeforeVisibleOutput: true }
      : {}),
  });

  const updateTerminalResult = (
    base: Omit<StreamInspectionResult, "streamIntegrity">,
  ): StreamInspectionResult => ({
    ...base,
    streamIntegrity: buildStreamIntegrity(),
  });

  const markVisibleOutput = (): void => {
    if (sawVisibleOutput) {
      return;
    }
    sawVisibleOutput = true;
    firstVisibleOutputAtMs ??= currentOffset();
    onVisibleOutput?.();
    if (terminalResult?.semanticState === "error") {
      terminalResult = updateTerminalResult({
        ...terminalResult,
        semanticState: "error-after-partial",
        sawVisibleOutput: true,
      });
    }
  };

  const setError = (semanticError: SemanticFailureInfo, eventType?: string): void => {
    terminalEventType ??= eventType;
    terminalResult = updateTerminalResult({
      semanticState: sawVisibleOutput ? "error-after-partial" : "error",
      semanticError,
      sawVisibleOutput,
    });
  };

  const setCompleted = (eventType?: string): void => {
    terminalEventType ??= eventType;
    terminalResult = updateTerminalResult({
      semanticState: "completed",
      sawVisibleOutput,
    });
  };

  const recordMalformedBlock = (block: string, parseFailure = false): void => {
    malformedEventCount += 1;
    if (parseFailure) {
      ignoredJsonParseFailureCount += 1;
    }
    if (malformedEventPreviews.length >= 3) {
      return;
    }
    malformedEventPreviews.push(block.replace(/\s+/g, " ").trim().slice(0, 160));
  };

  const processPayload = (payload: unknown): void => {
    if (!payload || typeof payload !== "object" || Array.isArray(payload) || terminalResult) {
      return;
    }

    if (api === "openai-responses") {
      processOpenAiPayload(payload as Record<string, unknown>, markVisibleOutput, setCompleted, setError);
      return;
    }

    if (api === "anthropic-messages") {
      processAnthropicPayload(
        payload as Record<string, unknown>,
        markVisibleOutput,
        setCompleted,
        setError,
      );
      return;
    }

    if (api === "google-generative-ai") {
      processGooglePayload(
        payload as Record<string, unknown>,
        sawVisibleOutput,
        markVisibleOutput,
        setCompleted,
        setError,
      );
    }
  };

  const processEventBlock = (block: string): void => {
    const trimmedBlock = block.trim();
    if (!trimmedBlock) {
      return;
    }

    const dataLines: string[] = [];
    for (const line of trimmedBlock.split("\n")) {
      if (!line || line.startsWith(":")) {
        continue;
      }
      if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).replace(/^\s/, ""));
        continue;
      }
      if (!line.includes(":")) {
        dataLines.push(line);
      }
    }

    const dataText = dataLines.join("\n").trim();
    if (!dataText || dataText === "[DONE]") {
      return;
    }

    try {
      processPayload(JSON.parse(dataText) as unknown);
    } catch {
      recordMalformedBlock(dataText, true);
      return;
    }
  };

  const drainBuffer = (flush: boolean): void => {
    buffer = buffer.replace(/\r\n/g, "\n");

    for (;;) {
      const boundary = buffer.indexOf("\n\n");
      if (boundary < 0) {
        break;
      }
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      processEventBlock(block);
    }

    if (flush && buffer.trim().length > 0) {
      processEventBlock(buffer);
      buffer = "";
    }
  };

  return {
    get sawVisibleOutput() {
      return sawVisibleOutput;
    },
    consumeChunk(chunk) {
      if (terminalResult?.semanticState === "completed") {
        return;
      }
      firstChunkAtMs ??= currentOffset();
      buffer += decoder.decode(chunk, { stream: true });
      drainBuffer(false);
    },
    currentResult() {
      return terminalResult
        ? {
            ...terminalResult,
            streamIntegrity: buildStreamIntegrity(),
          }
        : undefined;
    },
    finalize() {
      buffer += decoder.decode();
      drainBuffer(true);
      return (
        terminalResult ??
        updateTerminalResult({
          semanticState: "ended-empty",
          semanticError: {
            message: "stream ended without a terminal success event",
          },
          sawVisibleOutput,
        })
      );
    },
    abort(reason) {
      terminalEventType ??= "stream-aborted";
      return updateTerminalResult({
        semanticState: "aborted",
        semanticError: {
          message:
            reason instanceof Error
              ? reason.message
              : typeof reason === "string"
                ? reason
                : "stream aborted before a terminal event",
        },
        sawVisibleOutput,
      });
    },
  };
}

function processOpenAiPayload(
  payload: Record<string, unknown>,
  markVisibleOutput: () => void,
  setCompleted: (eventType?: string) => void,
  setError: (semanticError: SemanticFailureInfo, eventType?: string) => void,
): void {
  const type = typeof payload.type === "string" ? payload.type : undefined;
  if (!type) {
    return;
  }

  if (
    ((type === "response.output_text.delta" || type === "response.output_text.done") &&
      hasNonEmptyText(payload.delta)) ||
    hasNonEmptyText(payload.text)
  ) {
    markVisibleOutput();
  }

  if (type === "response.completed") {
    setCompleted(type);
    return;
  }

  if (type === "response.failed" || type === "error") {
    const response = asRecord(payload.response);
    const error = asRecord(response?.error ?? payload.error);
    setError({
      status: asNumber(response?.status ?? payload.status),
      providerStatus: asNumber(response?.status ?? payload.status),
      code: asString(error?.code ?? payload.code),
      message:
        asString(error?.message ?? payload.message) ?? "OpenAI stream reported a terminal failure",
    }, type);
  }
}

function processAnthropicPayload(
  payload: Record<string, unknown>,
  markVisibleOutput: () => void,
  setCompleted: (eventType?: string) => void,
  setError: (semanticError: SemanticFailureInfo, eventType?: string) => void,
): void {
  const type = typeof payload.type === "string" ? payload.type : undefined;
  if (!type) {
    return;
  }

  if (type === "content_block_delta") {
    const delta = asRecord(payload.delta);
    if (delta?.type === "text_delta" && hasNonEmptyText(delta.text)) {
      markVisibleOutput();
    }
  }

  if (type === "message_stop") {
    setCompleted(type);
    return;
  }

  if (type === "error") {
    const error = asRecord(payload.error);
    setError({
      status: asNumber(error?.status ?? payload.status),
      providerStatus: asNumber(error?.status ?? payload.status),
      code: asString(error?.type ?? payload.code),
      message: asString(error?.message ?? payload.message) ?? "Anthropic stream reported a terminal failure",
    }, type);
  }
}

function processGooglePayload(
  payload: Record<string, unknown>,
  sawVisibleOutput: boolean,
  markVisibleOutput: () => void,
  setCompleted: (eventType?: string) => void,
  setError: (semanticError: SemanticFailureInfo, eventType?: string) => void,
): void {
  const error = asRecord(payload.error);
  if (error) {
    setError({
      status: asNumber(error.code ?? payload.code ?? payload.status),
      providerStatus: asNumber(error.code ?? payload.code ?? payload.status),
      code: asString(error.status ?? payload.code),
      message:
        asString(error.message ?? payload.message) ?? "Google stream reported a terminal failure",
    }, "google.error");
    return;
  }

  const candidates = asArrayOfRecords(payload.candidates);
  if (candidates.length === 0) {
    return;
  }

  const hasVisibleOutput = candidates.some((candidate) => googleCandidateHasVisibleOutput(candidate));
  if (hasVisibleOutput) {
    markVisibleOutput();
  }

  const reachedTerminalSuccess = candidates.some(
    (candidate) => hasNonEmptyText(candidate.finishReason) && (hasVisibleOutput || sawVisibleOutput),
  );
  if (reachedTerminalSuccess) {
    const finishReason = candidates.find((candidate) => hasNonEmptyText(candidate.finishReason))
      ?.finishReason;
    setCompleted(
      typeof finishReason === "string" ? `google.finishReason.${finishReason}` : "google.finishReason",
    );
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asArrayOfRecords(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((entry) => asRecord(entry)).filter(Boolean) as Record<string, unknown>[];
}

function googleCandidateHasVisibleOutput(candidate: Record<string, unknown>): boolean {
  const content = asRecord(candidate.content);
  const parts = content?.parts;
  if (!Array.isArray(parts)) {
    return false;
  }

  return parts.some((part) => hasNonEmptyText(asRecord(part)?.text));
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function hasNonEmptyText(value: unknown): boolean {
  return typeof value === "string" && value.length > 0;
}
