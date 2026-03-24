# openclaw-customprovider-cache

Independent OpenClaw plugin for custom providers that keeps upstream cache and session identifiers stable without touching provider API keys or rewriting OpenClaw transcripts.

## Why this improves cache hit rate

Custom providers and provider gateways often key prompt caching or session affinity off provider-native fields instead of the raw prompt alone. This plugin fills those fields only when they are missing:

- OpenAI Responses style traffic:
  - `prompt_cache_key`
  - `session_id`
  - `x-session-id`
- Anthropic Messages style traffic:
  - `metadata.user_id`

That matters because upstream systems such as cache layers, prompt stores, or compatibility gateways can only reuse cached context when the request keeps presenting the same stable cache/session identifier across turns. OpenClaw still owns the transcript, pruning, and compaction. This plugin only preserves the provider-facing identity that lets the upstream cache recognize repeated conversation state.

## What the plugin does

- Matches configured custom providers by `baseUrl`, API adapter, endpoint path, and request shape
- Completes missing OpenAI Responses cache/session identifiers
- Injects missing Anthropic `metadata.user_id`
- Converts semantic fake-success streams into real failures before the first visible token for covered providers
- Escalates post-first-token semantic failures only for subagent-like requests detected by the `SOUL.md`-absence heuristic
- Fails narrow suspicious parent-consumption requests before upstream generation when child completion payloads look raw, empty, or missing deliverable signals
- Leaves auth handling to OpenClaw and forwards existing auth headers unchanged
- Keeps request rewriting scoped to configured custom-provider traffic

## What it does not do

- It does not read or store provider API keys
- It does not edit `~/.openclaw/openclaw.json` at runtime
- It does not mutate OpenClaw transcripts, sessions, pruning, or compaction rules
- It does not affect providers that do not use the configured `baseUrl`

## Install

Primary one-command path:

```bash
python3 scripts/install.py
```

Dry run:

```bash
python3 scripts/install.py --dry-run
```

Uninstall:

```bash
python3 scripts/install.py --uninstall
```

## Upgrade from the previous plugin id

Earlier local installs used the plugin id `session-metadata-proxy`. Remove that install before enabling the renamed plugin:

```bash
openclaw plugins uninstall session-metadata-proxy --force --keep-files
python3 scripts/install.py
```

## Config

The plugin works with defaults. Configure it under `plugins.entries.openclaw-customprovider-cache.config`:

```json
{
  "providers": ["custom-openai", "custom-anthropic"],
  "semanticFailureGating": true,
  "retrySteeringForPoisonedChildResults": true,
  "requestLogging": {
    "enabled": false
  },
  "openai": {
    "injectSessionIdHeader": true,
    "injectPromptCacheKey": true
  },
  "anthropic": {
    "injectMetadataUserId": true,
    "userIdPrefix": "openclaw"
  }
}
```

Notes:

- `providers`: empty means all configured providers with supported APIs
- `semanticFailureGating`: defaults to `true`; set `false` to disable semantic stream inspection and let covered streams pass through untouched
- `retrySteeringForPoisonedChildResults`: defaults to `true`; set `false` to disable only the request-side poisoned child-result retry steering short-circuit
- `requestLogging.enabled`: when `true`, append sanitized JSONL request and response events for each forwarded plugin-handled request to `stateDir/forwarded-requests.jsonl`
- `requestLogging.path`: optional custom log file path; relative paths resolve from the plugin `stateDir`
- `anthropic.userId`: optional explicit `metadata.user_id`
- `anthropic.userIdPrefix`: used when generating a stable installation-scoped identity

## Retry steering stopgap

This stopgap is intentionally narrow and plugin-only. Before a matched request is forwarded upstream, the plugin now looks for parent-consumption payloads that claim a child completed successfully while carrying suspicious content such as:

- raw markdown or file-dump style payloads
- explicit `(no output)` child results
- progress-only child results without deliverable signals

When matched, the plugin returns a synthetic `408` JSON error with code `RETRY_STEERING_POISONED_CHILD_RESULT`, logs the decision, and avoids upstream generation entirely.

Current limits:

- It only runs on traffic already handled by this plugin
- It is heuristic and intentionally fail-closed on a narrow class of suspicious child-completion payloads
- It cannot repair poisoned parent state or incorrect core success semantics after a bad child result has already been accepted upstream

## Semantic failure gating

For covered streaming APIs, the plugin now distinguishes transport success from semantic success:

- `semanticState: "unknown-stream"`: the upstream transport returned a stream-like `200`, but the plugin has not seen the terminal event yet
- `semanticState: "completed"`: the stream reached a provider-specific success terminator
- `semanticState: "error"`: the stream reported a semantic failure before any visible output
- `semanticState: "error-after-partial"`: the stream produced visible output and later reported a semantic failure
- `semanticState: "ended-empty"`: the stream ended without a success terminator
- `semanticState: "aborted"`: the stream terminated abnormally before a success terminator

When request logging is enabled, each covered stream can produce three JSONL records:

- `request`
- `response` with the transport-level `status`, `bodyState`, and initial `semanticState`
- `response-summary` with the final `semanticState`, optional `semanticError`, and `executionClass`

The execution class is a v1 heuristic based on prompt/bootstrap payloads:

- If the payload includes `SOUL.md`, the request is treated as `main-like`
- If the payload includes `AGENTS.md` and `TOOLS.md` but not `SOUL.md`, the request is treated as `subagent-like`
- Anything else remains `unknown`

That heuristic matters because the policy is intentionally split:

- Pre-first-token semantic failures are upgraded to real stream errors for all covered streams
- Post-first-token semantic failures are only upgraded to real stream errors for `subagent-like` requests
- Main-like partial failures stay readable to the caller and are only logged as semantic failures

## Current scope

- Covered today: OpenAI Responses SSE and Anthropic Messages SSE
- Not covered yet: Gemini semantic stream inspection and gating

## Verification

```bash
npm test
npm run typecheck
```
