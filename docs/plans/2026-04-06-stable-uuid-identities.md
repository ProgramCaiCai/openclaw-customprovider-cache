# Stable UUID Identities Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace auto-generated Anthropic and OpenAI identity values with stable UUID-looking values that preserve cross-turn reuse and remove visible `openclaw` markers.

**Architecture:** Keep the existing precedence rules for caller-supplied ids, but change only the plugin-generated fallback identity path. Derive a deterministic Anthropic UUID v4 and deterministic OpenAI UUID v7-style session id from the persisted installation identity, and generate UUID v7-style recovery ids for poisoned OpenAI sessions without the old `-recover-` suffix.

**Tech Stack:** TypeScript, Node.js `crypto`, Vitest

---

### Task 1: Capture the new outward format with failing tests

**Files:**
- Modify: `src/proxy-service.test.ts`
- Modify: `src/session-recovery.test.ts`

**Step 1: Write the failing test**

- Update the logged OpenAI session assertions to require a UUID v7-shaped string and to reject `openclaw`.
- Update the generated Anthropic `stableUserId` assertion to require a UUID v4-shaped string.
- Update the poisoned-session recovery assertion to require a UUID v7-shaped string without `recover`.

**Step 2: Run test to verify it fails**

Run: `npm test -- src/proxy-service.test.ts src/session-recovery.test.ts`

Expected: FAIL because current generated values still contain `openclaw-session-...` and `...-recover-...`.

### Task 2: Implement deterministic UUID generators

**Files:**
- Create: `src/uuid-identity.ts`
- Modify: `src/identity.ts`
- Modify: `src/session-recovery.ts`

**Step 1: Write minimal implementation**

- Add helper functions that derive UUID-looking strings from stable seeds.
- Anthropic generator emits deterministic UUID v4 shape.
- OpenAI generator emits deterministic UUID v7 shape for stable fallback ids.
- Recovery generator emits UUID v7 shape from fallback id plus fresh randomness.

**Step 2: Run targeted tests**

Run: `npm test -- src/proxy-service.test.ts src/session-recovery.test.ts`

Expected: PASS.

### Task 3: Update docs and broader regression expectations

**Files:**
- Modify: `README.md`
- Modify: `src/fetch-patch.test.ts`

**Step 1: Adjust docs and any pattern-based tests**

- Document that generated Anthropic and OpenAI ids are stable UUID-looking values.
- Update fetch-patch poisoned-session assertions to the UUID v7 recovery format.

**Step 2: Run regression verification**

Run: `npm test -- src/proxy-service.test.ts src/session-recovery.test.ts src/fetch-patch.test.ts`

Expected: PASS.

### Task 4: Final verification

**Files:**
- No code changes expected

**Step 1: Run final checks**

Run: `npm test -- src/proxy-service.test.ts src/session-recovery.test.ts src/fetch-patch.test.ts src/proxy-rewrite.test.ts`

Expected: PASS.
