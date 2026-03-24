import type { ProviderApi, SemanticFailureInfo, StreamInspectionResult } from "./types.js";

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
): StreamTracker {
  const decoder = new TextDecoder();
  let buffer = "";
  let sawVisibleOutput = false;
  let terminalResult: StreamInspectionResult | undefined;

  const markVisibleOutput = (): void => {
    if (sawVisibleOutput) {
      return;
    }
    sawVisibleOutput = true;
    onVisibleOutput?.();
    if (terminalResult?.semanticState === "error") {
      terminalResult = {
        ...terminalResult,
        semanticState: "error-after-partial",
        sawVisibleOutput: true,
      };
    }
  };

  const setError = (semanticError: SemanticFailureInfo): void => {
    terminalResult = {
      semanticState: sawVisibleOutput ? "error-after-partial" : "error",
      semanticError,
      sawVisibleOutput,
    };
  };

  const setCompleted = (): void => {
    terminalResult = {
      semanticState: "completed",
      sawVisibleOutput,
    };
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
      buffer += decoder.decode(chunk, { stream: true });
      drainBuffer(false);
    },
    currentResult() {
      return terminalResult;
    },
    finalize() {
      buffer += decoder.decode();
      drainBuffer(true);
      return (
        terminalResult ?? {
          semanticState: "ended-empty",
          semanticError: {
            message: "stream ended without a terminal success event",
          },
          sawVisibleOutput,
        }
      );
    },
    abort(reason) {
      return {
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
      };
    },
  };
}

function processOpenAiPayload(
  payload: Record<string, unknown>,
  markVisibleOutput: () => void,
  setCompleted: () => void,
  setError: (semanticError: SemanticFailureInfo) => void,
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
    setCompleted();
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
    });
  }
}

function processAnthropicPayload(
  payload: Record<string, unknown>,
  markVisibleOutput: () => void,
  setCompleted: () => void,
  setError: (semanticError: SemanticFailureInfo) => void,
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
    setCompleted();
    return;
  }

  if (type === "error") {
    const error = asRecord(payload.error);
    setError({
      status: asNumber(error?.status ?? payload.status),
      providerStatus: asNumber(error?.status ?? payload.status),
      code: asString(error?.type ?? payload.code),
      message: asString(error?.message ?? payload.message) ?? "Anthropic stream reported a terminal failure",
    });
  }
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

function hasNonEmptyText(value: unknown): boolean {
  return typeof value === "string" && value.length > 0;
}
