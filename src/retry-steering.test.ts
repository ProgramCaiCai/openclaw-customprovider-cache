import { describe, expect, it } from "vitest";

import { detectRetrySteeringNeed } from "./retry-steering.js";

describe("detectRetrySteeringNeed", () => {
  it("does not flag benign parent prompts", () => {
    expect(
      detectRetrySteeringNeed(`
SOUL.md
Plan the next change and summarize the risks before you edit anything.
`),
    ).toEqual({ verdict: "none" });
  });

  it("flags completion blocks that paste raw file dumps", () => {
    expect(
      detectRetrySteeringNeed(`
SOUL.md
Subagent completed successfully.

\`\`\`md
# HEARTBEAT.md
status: green
notes: copied directly from the child workspace
\`\`\`
`),
    ).toMatchObject({
      verdict: "poisoned-child-result",
      reason: "raw-child-result-dump",
    });
  });

  it("flags completion blocks that explicitly report no output", () => {
    expect(
      detectRetrySteeringNeed(`
SOUL.md
Subagent completed successfully.
(no output)
`),
    ).toMatchObject({
      verdict: "empty-child-result",
      reason: "child-completion-empty-output",
    });
  });

  it("allows well-formed child summaries that point to deliverables", () => {
    expect(
      detectRetrySteeringNeed(`
SOUL.md
Subagent completed successfully.
Deliverable: reports/customprovider-cache-retry-steering-2026-03-24/index.md
Changed files:
- src/fetch-patch.ts
- src/retry-steering.ts
Verification:
- npm test
- npm run typecheck
`),
    ).toEqual({ verdict: "none" });
  });
});
