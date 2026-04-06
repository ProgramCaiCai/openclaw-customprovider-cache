# Semantic Retry Policies Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add plugin-managed same-provider semantic retry with user-configurable post-first-token policies for main-like and subagent-like requests.

**Architecture:** Keep gateway/account rotation unchanged by retrying against the same configured provider base URL. Move semantic retry decisions into the plugin: pre-first-token semantic failures retry by default, while post-first-token behavior is controlled by explicit per-execution-class policies with backward compatibility for the existing main-like boolean switch.

**Tech Stack:** TypeScript, Web Fetch/Response streams, Vitest

---

### Task 1: Extend config and types

**Files:**
- Modify: `src/types.ts`
- Modify: `src/config.ts`
- Modify: `src/config.test.ts`
- Modify: `openclaw.plugin.json`
- Modify: `README.md`

**Step 1: Write the failing tests**

Add config tests covering:
- default `semanticRetry` values
- acceptance of explicit policy strings
- fallback from legacy `mainLikePostFirstTokenFailureEscalation`
- rejection of invalid policy values / invalid retry numbers

**Step 2: Run test to verify it fails**

Run: `npm test -- --run src/config.test.ts`

**Step 3: Write minimal implementation**

Update normalized config/types/schema/docs to include:
- `semanticRetry.maxAttempts`
- `semanticRetry.baseBackoffMs`
- `semanticRetry.mainLikePostFirstTokenPolicy`
- `semanticRetry.subagentLikePostFirstTokenPolicy`

Preserve compatibility with `mainLikePostFirstTokenFailureEscalation`.

**Step 4: Run test to verify it passes**

Run: `npm test -- --run src/config.test.ts`

### Task 2: Add semantic retry orchestration tests

**Files:**
- Modify: `src/fetch-patch.test.ts`

**Step 1: Write the failing tests**

Add tests covering:
- pre-first-token semantic failure retries same provider and eventually succeeds
- non-retryable semantic failure does not retry
- main-like `buffered-retry` buffers partial output and retries
- subagent-like default `buffered-retry` retries and succeeds
- main-like default `raise` stays erroring after visible output
- explicit `passthrough` still preserves readable partial output

**Step 2: Run test to verify it fails**

Run: `npm test -- --run src/fetch-patch.test.ts`

**Step 3: Implement minimal code to satisfy behavior**

Add retry loop and policy-aware stream handling in `src/fetch-patch.ts`.

**Step 4: Run test to verify it passes**

Run: `npm test -- --run src/fetch-patch.test.ts`

### Task 3: Wire service and docs, then verify

**Files:**
- Modify: `src/proxy-service.ts`
- Modify: `README.md`
- Modify: `package.json`
- Modify: `openclaw.plugin.json`

**Step 1: Update callers and package version**

Wire new config into service and bump plugin version.

**Step 2: Run focused verification**

Run: `npm test -- --run src/config.test.ts src/fetch-patch.test.ts src/proxy-service.test.ts`

Run: `npm run typecheck`

**Step 3: Run full verification**

Run: `npm test`

**Step 4: Commit and push**

Commit with:

```bash
git add docs/plans/2026-04-06-semantic-retry-policies.md src/types.ts src/config.ts src/config.test.ts src/fetch-patch.ts src/fetch-patch.test.ts src/proxy-service.ts README.md openclaw.plugin.json package.json
git commit -m "feat(plugin): 增加语义重试策略配置"
git push origin main
```
