import { describe, expect, it } from "vitest";

import { createStreamTracker, inspectSseStream } from "./stream-inspector.js";

describe("inspectSseStream", () => {
  it("marks openai responses streams as completed when they emit response.completed", async () => {
    const result = await inspectSseStream({
      api: "openai-responses",
      stream: streamFromText(
        'data: {"type":"response.output_text.delta","delta":"hello"}\n\n',
        'data: {"type":"response.completed"}\n\n',
      ),
    });

    expect(result).toMatchObject({
      semanticState: "completed",
      sawVisibleOutput: true,
    });
  });

  it("marks openai responses semantic failures as errors", async () => {
    const result = await inspectSseStream({
      api: "openai-responses",
      stream: streamFromText(
        'data: {"type":"response.failed","response":{"status":529,"error":{"code":"overloaded_error","message":"capacity"}}}\n\n',
      ),
    });

    expect(result).toMatchObject({
      semanticState: "error",
      sawVisibleOutput: false,
      semanticError: {
        code: "overloaded_error",
        message: "capacity",
        providerStatus: 529,
      },
    });
  });

  it("marks streams without visible output or a terminal success as ended-empty", async () => {
    const result = await inspectSseStream({
      api: "openai-responses",
      stream: streamFromText('data: {"type":"response.created"}\n\n'),
    });

    expect(result).toMatchObject({
      semanticState: "ended-empty",
      sawVisibleOutput: false,
      semanticError: {
        message: "stream ended without a terminal success event",
      },
      streamIntegrity: {
        terminalEventType: "stream-ended-empty",
      },
    });
  });

  it("marks visible-output streams without a terminal success as partial failures", async () => {
    const result = await inspectSseStream({
      api: "openai-responses",
      stream: streamFromText('data: {"type":"response.output_text.delta","delta":"hello"}\n\n'),
    });

    expect(result).toMatchObject({
      semanticState: "error-after-partial",
      sawVisibleOutput: true,
      semanticError: {
        message: "stream ended after visible output without a terminal success event",
      },
      streamIntegrity: {
        terminalEventType: "stream-ended-after-visible-output",
      },
    });
  });

  it("marks anthropic message_stop streams as completed", async () => {
    const result = await inspectSseStream({
      api: "anthropic-messages",
      stream: streamFromText(
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hello"}}\n\n',
        'data: {"type":"message_stop"}\n\n',
      ),
    });

    expect(result).toMatchObject({
      semanticState: "completed",
      sawVisibleOutput: true,
    });
  });

  it("marks anthropic error events as errors", async () => {
    const result = await inspectSseStream({
      api: "anthropic-messages",
      stream: streamFromText(
        'data: {"type":"error","error":{"type":"rate_limit_error","message":"too many requests"}}\n\n',
      ),
    });

    expect(result).toMatchObject({
      semanticState: "error",
      sawVisibleOutput: false,
      semanticError: {
        code: "rate_limit_error",
        message: "too many requests",
      },
    });
  });

  it("marks google streams as completed when they reach a terminal finish reason after visible output", async () => {
    const result = await inspectSseStream({
      api: "google-generative-ai",
      stream: streamFromText(
        'data: {"candidates":[{"content":{"parts":[{"text":"hello"}]}}]}\n\n',
        'data: {"candidates":[{"finishReason":"STOP","content":{"parts":[{"text":" world"}]}}]}\n\n',
      ),
    });

    expect(result).toMatchObject({
      semanticState: "completed",
      sawVisibleOutput: true,
    });
  });

  it("marks google streams without usable model output as ended-empty", async () => {
    const result = await inspectSseStream({
      api: "google-generative-ai",
      stream: streamFromText(
        'data: {"promptFeedback":{"blockReason":"SAFETY"},"candidates":[{"finishReason":"SAFETY"}]}\n\n',
      ),
    });

    expect(result).toMatchObject({
      semanticState: "ended-empty",
      sawVisibleOutput: false,
    });
  });

  it("marks google error payloads as errors", async () => {
    const result = await inspectSseStream({
      api: "google-generative-ai",
      stream: streamFromText(
        'event: error\n',
        'data: {"error":{"code":429,"status":"RESOURCE_EXHAUSTED","message":"quota exhausted"}}\n\n',
      ),
    });

    expect(result).toMatchObject({
      semanticState: "error",
      sawVisibleOutput: false,
      semanticError: {
        code: "RESOURCE_EXHAUSTED",
        message: "quota exhausted",
        providerStatus: 429,
      },
    });
  });

  it("marks visible-output aborts as partial failures", async () => {
    const encoder = new TextEncoder();
    let emitted = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!emitted) {
          emitted = true;
          controller.enqueue(
            encoder.encode('data: {"type":"response.output_text.delta","delta":"hello"}\n\n'),
          );
          return;
        }
        controller.error(new Error("socket closed"));
      },
    });

    const result = await inspectSseStream({
      api: "openai-responses",
      stream,
    });

    expect(result).toMatchObject({
      semanticState: "error-after-partial",
      sawVisibleOutput: true,
      semanticError: {
        message: "stream aborted after visible output before a terminal success event: socket closed",
      },
      streamIntegrity: {
        terminalEventType: "stream-aborted-after-visible-output",
      },
    });
  });

  it("records stream milestones for first chunk, visible output, completion, and end", () => {
    const encoder = new TextEncoder();
    let now = 1_000;
    const tracker = createStreamTracker("openai-responses", undefined, () => now);

    tracker.consumeChunk(encoder.encode('data: {"type":"response.created"}\n\n'));
    now = 1_020;
    tracker.consumeChunk(encoder.encode('data: {"type":"response.output_text.delta","delta":"hello"}\n\n'));
    now = 1_045;
    tracker.consumeChunk(encoder.encode('data: {"type":"response.completed"}\n\n'));
    now = 1_050;

    expect(tracker.finalize()).toMatchObject({
      semanticState: "completed",
      sawVisibleOutput: true,
      streamIntegrity: {
        firstChunkAtMs: 0,
        firstVisibleOutputAtMs: 20,
        streamEndedAtMs: 50,
        terminalEventType: "response.completed",
        malformedEventCount: 0,
        ignoredJsonParseFailureCount: 0,
      },
    });
  });

  it("counts malformed SSE event blocks and keeps bounded previews", () => {
    const encoder = new TextEncoder();
    const tracker = createStreamTracker("openai-responses");

    tracker.consumeChunk(encoder.encode('data: {"type":"response.created"}\n\n'));
    tracker.consumeChunk(
      encoder.encode('data: {"type":"response.output_text.delta","delta":"hello"\n\n'),
    );

    expect(tracker.finalize()).toMatchObject({
      semanticState: "ended-empty",
      streamIntegrity: {
        malformedEventCount: 1,
        ignoredJsonParseFailureCount: 1,
        malformedEventPreviews: ['{"type":"response.output_text.delta","delta":"hello"'],
      },
    });
  });
});

function streamFromText(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}
