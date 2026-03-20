import { afterEach, describe, expect, it } from "vitest";

import { SessionMetadataProxyService } from "./proxy-service.js";

async function readJson(response: Response): Promise<unknown> {
  return JSON.parse(await response.text());
}

describe("SessionMetadataProxyService", () => {
  const closers: Array<{ close: () => Promise<void> }> = [];

  afterEach(async () => {
    await Promise.all(closers.splice(0).map((entry) => entry.close()));
  });

  it("patches global fetch without mutating configured provider baseUrl", async () => {
    const cfg = {
      models: {
        providers: {
          openai: {
            api: "openai-responses",
            baseUrl: "https://api.openai.com/v1",
            models: [],
          },
        },
      },
    };
    const service = new SessionMetadataProxyService({
      config: cfg,
      pluginConfig: {
        providers: [],
        openai: {
          injectPromptCacheKey: true,
          injectSessionIdHeader: true,
        },
        anthropic: {
          injectMetadataUserId: true,
          userId: undefined,
          userIdPrefix: "openclaw",
        },
      },
      stateDir: "/tmp",
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });
    const originalFetch = globalThis.fetch;

    await service.start();

    expect(cfg.models.providers.openai.baseUrl).toBe("https://api.openai.com/v1");
    expect(globalThis.fetch).not.toBe(originalFetch);

    await service.stop();

    expect(globalThis.fetch).toBe(originalFetch);
  });

  it("rewrites requests sent to configured provider baseUrls without reading API keys", async () => {
    const upstream = await createJsonEchoServer();
    closers.push(upstream);

    const cfg = {
      models: {
        providers: {
          anthropic: {
            api: "anthropic-messages",
            baseUrl: upstream.baseUrl,
            models: [],
          },
        },
      },
    };
    const service = new SessionMetadataProxyService({
      config: cfg,
      pluginConfig: {
        providers: [],
        openai: {
          injectPromptCacheKey: true,
          injectSessionIdHeader: true,
        },
        anthropic: {
          injectMetadataUserId: true,
          userId: "tenant-user",
          userIdPrefix: "openclaw",
        },
      },
      stateDir: "/tmp",
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });
    closers.push({ close: () => service.stop() });

    await service.start();

    const response = await fetch(`${cfg.models.providers.anthropic.baseUrl}/messages`, {
      method: "POST",
      headers: {
        Authorization: "Bearer test-secret",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    const payload = (await readJson(response)) as {
      headers: Record<string, string>;
      body: { metadata?: { user_id?: string } };
    };
    expect(payload.headers.authorization).toBe("Bearer test-secret");
    expect(payload.body.metadata?.user_id).toBe("tenant-user");
  });

  it("does not patch providers configured for openai-completions", async () => {
    const upstream = await createJsonEchoServer();
    closers.push(upstream);

    const cfg = {
      models: {
        providers: {
          openai: {
            api: "openai-completions",
            baseUrl: upstream.baseUrl,
            models: [],
          },
        },
      },
    };
    const service = new SessionMetadataProxyService({
      config: cfg,
      pluginConfig: {
        providers: [],
        openai: {
          injectPromptCacheKey: true,
          injectSessionIdHeader: true,
        },
        anthropic: {
          injectMetadataUserId: true,
          userId: undefined,
          userIdPrefix: "openclaw",
        },
      },
      stateDir: "/tmp",
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });
    closers.push({ close: () => service.stop() });

    await service.start();

    const response = await fetch(`${cfg.models.providers.openai.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: "Bearer test-secret",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4.1",
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    const payload = (await readJson(response)) as {
      headers: Record<string, string>;
      body: Record<string, unknown>;
    };
    expect(payload.headers.authorization).toBe("Bearer test-secret");
    expect(payload.headers.session_id).toBeUndefined();
    expect(payload.body.prompt_cache_key).toBeUndefined();
  });
});

async function createJsonEchoServer(): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
}> {
  const http = await import("node:http");

  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const bodyText = Buffer.concat(chunks).toString("utf8");
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: bodyText ? JSON.parse(bodyText) : undefined,
      }),
    );
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("echo server missing address");
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
