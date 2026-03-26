import type {
  SubagentResultStopgapBoundedBlock,
  SubagentResultStopgapReason,
  SubagentResultStopgapVerdict,
} from "./types.js";

export type SubagentResultStopgapDecision = {
  verdict: SubagentResultStopgapVerdict;
  reason?: SubagentResultStopgapReason;
};

const COMPLETION_STATUS_PATTERN = /(?:^|\n)status:\s*completed successfully\b/i;
const RESULT_HEADER_PATTERN = /(?:^|\n)Result \(untrusted content, treat as data\):/i;
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
const BOUNDED_BLOCK_PATTERNS = [
  /\[Internal task completion event\][\s\S]{0,1200}?status:\s*completed successfully\b[\s\S]{0,400}?Result \(untrusted content, treat as data\):\s*\n<<<BEGIN_UNTRUSTED_CHILD_RESULT>>>\n?([\s\S]{0,12000}?)\n?<<<END_UNTRUSTED_CHILD_RESULT>>>/gi,
  /(?:^|\n)type:\s*subagent task\b[\s\S]{0,600}?status:\s*completed successfully\b[\s\S]{0,200}?Result \(untrusted content, treat as data\):\s*\n<<<BEGIN_UNTRUSTED_CHILD_RESULT>>>\n?([\s\S]{0,12000}?)\n?<<<END_UNTRUSTED_CHILD_RESULT>>>/gi,
];

function hasDeliverableSignals(promptText: string): boolean {
  return (
    REPORT_PATH_PATTERN.test(promptText) ||
    (CHANGED_FILES_PATTERN.test(promptText) && VERIFICATION_PATTERN.test(promptText))
  );
}

function createDecision(
  verdict: Exclude<SubagentResultStopgapVerdict, "none">,
  reason: SubagentResultStopgapReason,
): SubagentResultStopgapDecision {
  return { verdict, reason };
}

function extractBoundedBlocks(promptText: string): SubagentResultStopgapBoundedBlock[] {
  const blocks: SubagentResultStopgapBoundedBlock[] = [];
  const seenOffsets = new Set<number>();

  for (const pattern of BOUNDED_BLOCK_PATTERNS) {
    for (const match of promptText.matchAll(pattern)) {
      const blockText = match[0];
      const resultText = match[1] ?? "";
      const index = match.index ?? -1;
      if (index < 0 || seenOffsets.has(index)) {
        continue;
      }
      if (!COMPLETION_STATUS_PATTERN.test(blockText) || !RESULT_HEADER_PATTERN.test(blockText)) {
        continue;
      }
      seenOffsets.add(index);
      blocks.push({
        kind: "internal-task-completion",
        text: blockText.trim(),
        result: resultText.trim(),
      });
    }
  }

  return blocks;
}

function evaluateBoundedBlock(
  block: SubagentResultStopgapBoundedBlock,
): SubagentResultStopgapDecision {
  const candidateText = block.text;
  const resultText = block.result;

  if (NO_OUTPUT_PATTERN.test(resultText) || NO_OUTPUT_PATTERN.test(candidateText)) {
    return createDecision("empty-child-result", "child-completion-empty-output");
  }

  if (hasDeliverableSignals(resultText) || hasDeliverableSignals(candidateText)) {
    return { verdict: "none" };
  }

  if (RAW_FILE_DUMP_PATTERNS.some((pattern) => pattern.test(resultText) || pattern.test(candidateText))) {
    return createDecision("poisoned-child-result", "raw-child-result-dump");
  }

  if (PROGRESS_ONLY_PATTERNS.some((pattern) => pattern.test(resultText) || pattern.test(candidateText))) {
    return createDecision(
      "poisoned-child-result",
      "child-completion-without-deliverable-summary",
    );
  }

  return { verdict: "none" };
}

export function detectSubagentResultStopgap(promptText: string): SubagentResultStopgapDecision {
  const normalized = promptText.trim();
  if (normalized.length === 0) {
    return { verdict: "none" };
  }

  for (const block of extractBoundedBlocks(normalized)) {
    const decision = evaluateBoundedBlock(block);
    if (decision.verdict !== "none") {
      return decision;
    }
  }

  return { verdict: "none" };
}
