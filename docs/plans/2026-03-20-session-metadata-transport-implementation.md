# Session Metadata Transport Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build an independent OpenClaw plugin that injects stable request metadata for configured provider `baseUrl` values without handling provider API keys.

**Architecture:** A plugin service resolves supported provider routes from OpenClaw config, creates a stable installation identity, patches `globalThis.fetch`, rewrites matching JSON requests in-process, and restores the original fetch on shutdown.

**Tech Stack:** TypeScript, Node 22 fetch, Vitest

---

### Task 1: Define config and plugin-facing types

**Files:**
- Create: `src/types.ts`
- Create: `src/config.ts`
- Test: `src/config.test.ts`

### Task 2: Implement stable identity storage

**Files:**
- Create: `src/identity.ts`

### Task 3: Implement request rewrite rules

**Files:**
- Create: `src/proxy-rewrite.ts`
- Test: `src/proxy-rewrite.test.ts`

### Task 4: Implement fetch patching

**Files:**
- Create: `src/fetch-patch.ts`
- Test: `src/fetch-patch.test.ts`

### Task 5: Implement plugin service lifecycle

**Files:**
- Create: `src/proxy-service.ts`
- Create: `index.ts`
- Test: `src/proxy-service.test.ts`
- Test: `index.test.ts`

### Task 6: Package and document the plugin

**Files:**
- Modify: `package.json`
- Modify: `openclaw.plugin.json`
- Modify: `scripts/install.py`
- Create: `README.md`
