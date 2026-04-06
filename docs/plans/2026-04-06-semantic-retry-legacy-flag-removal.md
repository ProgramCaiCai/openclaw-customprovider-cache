# Semantic Retry Legacy Flag Removal Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Remove `mainLikePostFirstTokenFailureEscalation` from the public config surface while keeping backward-compatible parsing with a deprecation warning.

**Architecture:** Keep the legacy boolean handling only inside config normalization. The normalized runtime config will expose only `semanticRetry.mainLikePostFirstTokenPolicy` and `semanticRetry.subagentLikePostFirstTokenPolicy`, so downstream runtime code no longer needs to know the legacy flag existed.

**Tech Stack:** TypeScript, Vitest, JSON schema

---

### Task 1: Capture the new public config contract with failing tests

**Files:**
- Modify: `src/config.test.ts`
- Modify: `src/proxy-service.test.ts`

**Step 1: Write the failing test**

- Assert default normalized config no longer includes `mainLikePostFirstTokenFailureEscalation`.
- Assert the legacy boolean still maps to the correct `semanticRetry.mainLikePostFirstTokenPolicy`.
- Assert parsing the legacy boolean emits a warning.
- Remove test helpers that still require the legacy field on `NormalizedPluginConfig`.

**Step 2: Run test to verify it fails**

Run: `npm test -- src/config.test.ts src/proxy-service.test.ts`

Expected: FAIL because the normalized config still exposes the legacy field and does not warn.

### Task 2: Implement compatibility-only parsing

**Files:**
- Modify: `src/config.ts`
- Modify: `src/types.ts`
- Modify: `src/proxy-service.ts`
- Modify: `src/fetch-patch.ts`
- Modify: `index.ts`

**Step 1: Write minimal implementation**

- Add an optional warning sink to `normalizePluginConfig`.
- Keep reading `mainLikePostFirstTokenFailureEscalation` only as a fallback for `semanticRetry.mainLikePostFirstTokenPolicy`.
- Emit a deprecation warning when the legacy field is present.
- Remove the legacy field from normalized types and downstream runtime plumbing.

**Step 2: Run targeted tests**

Run: `npm test -- src/config.test.ts src/proxy-service.test.ts`

Expected: PASS.

### Task 3: Remove the legacy field from public docs/schema

**Files:**
- Modify: `openclaw.plugin.json`
- Modify: `README.md`

**Step 1: Update public config examples**

- Remove the old field from schema and example config.
- Replace the old README wording with migration guidance that mentions the deprecation warning and the two replacement keys.

**Step 2: Run regression verification**

Run: `npm test -- src/config.test.ts src/proxy-service.test.ts src/fetch-patch.test.ts`

Expected: PASS.

### Task 4: Final verification and release

**Files:**
- Modify: `package.json`
- Modify: `openclaw.plugin.json`

**Step 1: Run final checks**

Run: `npm test -- src/config.test.ts src/proxy-service.test.ts src/fetch-patch.test.ts src/proxy-rewrite.test.ts`
Run: `npm run typecheck`

Expected: PASS.
