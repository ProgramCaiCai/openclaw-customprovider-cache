import { describe, expect, it } from "vitest";

import { resolveErrorPolicy } from "./error-policy.js";

describe("resolveErrorPolicy", () => {
  it("maps auth-shaped transport failures to auth-error", () => {
    expect(
      resolveErrorPolicy({
        transportStatus: 401,
        body: {
          error: {
            code: 401,
            status: "UNAUTHENTICATED",
            message: "API key invalid",
          },
        },
      }),
    ).toMatchObject({
      kind: "auth-error",
      normalizedErrorKind: "auth",
      providerStatus: 401,
      retryable: false,
    });
  });

  it("maps overloaded semantic failures to overload-error", () => {
    expect(
      resolveErrorPolicy({
        semanticState: "error",
        semanticError: {
          status: 503,
          providerStatus: 529,
          code: "SERVER_OVERLOADED",
          message: "capacity exhausted",
        },
      }),
    ).toMatchObject({
      kind: "overload-error",
      normalizedErrorKind: "upstream-overloaded",
      providerStatus: 529,
      retryable: true,
    });
  });

  it("maps synthetic stopgap failures to synthetic-stopgap-error", () => {
    expect(
      resolveErrorPolicy({
        semanticState: "error",
        semanticError: {
          status: 408,
          code: "SUBAGENT_RESULT_STOPGAP",
          message: "retry before upstream generation",
          retryable: true,
          syntheticFailure: true,
        },
      }),
    ).toMatchObject({
      kind: "synthetic-stopgap-error",
      retryable: true,
    });
  });
});
