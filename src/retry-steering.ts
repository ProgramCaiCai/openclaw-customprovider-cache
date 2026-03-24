import type { RetrySteeringReason, RetrySteeringVerdict } from "./types.js";

export type RetrySteeringDecision = {
  verdict: RetrySteeringVerdict;
  reason?: RetrySteeringReason;
};

const COMPLETION_SUCCESS_PATTERN = /\b(?:subagent|child|worker)?\s*completed successfully\b/i;
const NO_OUTPUT_PATTERN = /\(\s*no output\s*\)/i;
const REPORT_PATH_PATTERN = /\breports\/[^\s]+\/index\.md\b/i;
const CHANGED_FILES_PATTERN = /(?:^|\n)changed files\s*:/i;
const VERIFICATION_PATTERN = /(?:^|\n)verification\s*:/i;
const RAW_FILE_DUMP_PATTERNS = [
  /```[\s\S]{0,800}?\b(?:HEARTBEAT\.md|README\.md|package\.json|AGENTS\.md|TOOLS\.md|SOUL\.md)\b/i,
  /(?:^|\n)(?:diff --git|--- a\/|\+\+\+ b\/|@@ )/m,
  /(?:^|\n)(?:file|begin file)\s*:\s*[^\n]+\.(?:md|ts|tsx|js|json|txt)\b/i,
];
const PROGRESS_ONLY_PATTERNS = [
  /\bmoving into implementation\b/i,
  /\breviewed the brief\/plan\/review\b/i,
  /\bno blocker\b/i,
  /\bprogress update\b/i,
];

function hasDeliverableSignals(promptText: string): boolean {
  return (
    REPORT_PATH_PATTERN.test(promptText) ||
    (CHANGED_FILES_PATTERN.test(promptText) && VERIFICATION_PATTERN.test(promptText))
  );
}

function createDecision(
  verdict: Exclude<RetrySteeringVerdict, "none">,
  reason: RetrySteeringReason,
): RetrySteeringDecision {
  return { verdict, reason };
}

export function detectRetrySteeringNeed(promptText: string): RetrySteeringDecision {
  const normalized = promptText.trim();
  if (!COMPLETION_SUCCESS_PATTERN.test(normalized)) {
    return { verdict: "none" };
  }

  if (NO_OUTPUT_PATTERN.test(normalized)) {
    return createDecision("empty-child-result", "child-completion-empty-output");
  }

  if (hasDeliverableSignals(normalized)) {
    return { verdict: "none" };
  }

  if (RAW_FILE_DUMP_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return createDecision("poisoned-child-result", "raw-child-result-dump");
  }

  if (PROGRESS_ONLY_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return createDecision(
      "poisoned-child-result",
      "child-completion-without-deliverable-summary",
    );
  }

  return { verdict: "none" };
}
