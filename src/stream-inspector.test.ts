import { describe, expect, it } from "vitest";

import { inspectSseStream } from "./stream-inspector.js";

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

  it("marks streams without a terminal success as ended-empty", async () => {
    const result = await inspectSseStream({
      api: "openai-responses",
      stream: streamFromText('data: {"type":"response.created"}\n\n'),
    });

    expect(result).toMatchObject({
      semanticState: "ended-empty",
      sawVisibleOutput: false,
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
