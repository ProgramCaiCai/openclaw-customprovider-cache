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

For auto-generated values, the plugin now uses provider-appropriate UUID-looking identifiers instead of `openclaw-*` markers:

- Anthropic `metadata.user_id`: stable UUID v4-shaped value
- OpenAI `session_id` / `x-session-id` / `prompt_cache_key`: stable UUID v7-shaped value
- OpenAI poisoned-session recovery ids: fresh UUID v7-shaped value

## What the plugin does

- Matches configured custom providers by `baseUrl`, API adapter, endpoint path, and request shape
- Completes missing OpenAI Responses cache/session identifiers
- Injects missing Anthropic `metadata.user_id`
- Converts semantic fake-success streams into real failures before the first visible token for covered providers
- Escalates post-first-token semantic failures for both main-like and subagent-like requests by default, with a dedicated opt-out for main-like traffic
- Short-circuits bounded poisoned child-result envelopes before upstream generation with a retry-friendly synthetic failure
- Leaves auth handling to OpenClaw and forwards existing auth headers unchanged
- Keeps request rewriting scoped to configured custom-provider traffic

## What it does not do

- It does not read or store provider API keys
- It does not edit `~/.openclaw/openclaw.json` at runtime
- It does not mutate OpenClaw transcripts, sessions, pruning, or compaction rules
- It does not affect providers that do not use the configured `baseUrl`

## Install

Default packaged install:

```bash
python3 scripts/install.py
```

That command builds a local npm package with `npm pack`, writes the archive to `.artifacts/`, and installs the generated `.tgz` with `openclaw plugins install <artifact>`. This keeps the live OpenClaw install decoupled from later source edits in the repo.

Explicit mutable source install for development only:

```bash
python3 scripts/install.py --link
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
  "mainLikePostFirstTokenFailureEscalation": true,
  "semanticRetry": {
    "maxAttempts": 3,
    "baseBackoffMs": 200,
    "mainLikePostFirstTokenPolicy": "raise",
    "subagentLikePostFirstTokenPolicy": "buffered-retry"
  },
  "subagentResultStopgap": true,
  "requestLogging": {
    "enabled": false
  },
  "openai": {
    "injectSessionIdHeader": true,
    "injectPromptCacheKey": true,
    "scrubAssistantCommentaryReplay": true
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
- `mainLikePostFirstTokenFailureEscalation`: legacy compatibility switch. `true` maps to `semanticRetry.mainLikePostFirstTokenPolicy="raise"` and `false` maps to `"passthrough"`
- `semanticRetry.maxAttempts`: defaults to `3`; total same-provider attempts for retryable semantic failures, including the first attempt
- `semanticRetry.baseBackoffMs`: defaults to `200`; exponential backoff base used when the semantic failure does not provide `retryAfterMs`
- `semanticRetry.mainLikePostFirstTokenPolicy`: defaults to `raise`; controls main-like post-first-token semantic failures
- `semanticRetry.subagentLikePostFirstTokenPolicy`: defaults to `buffered-retry`; controls subagent-like post-first-token semantic failures
- Post-first-token policies:
  - `passthrough`: keep readable partial output and do not raise a real stream error
  - `raise`: raise a real stream error after partial output
  - `buffered-retry`: buffer the attempt, retry same-provider on retryable semantic failure, and only flush a successful attempt
- `subagentResultStopgap`: defaults to `true`; set `false` to disable the bounded request-side child-result short-circuit
- `requestLogging.enabled`: when `true`, append sanitized JSONL request and response events for each forwarded plugin-handled request to `stateDir/forwarded-requests.jsonl`
- `requestLogging.path`: optional custom log file path; relative paths resolve from the plugin `stateDir`
- `requestNormalization.scrubbedAssistantReplayCount`: reserved forwarded-request metadata field for how many assistant replay items were scrubbed from an outbound request body
- `requestNormalization.scrubbedAssistantReplayRules`: reserved forwarded-request metadata field listing which scrubber rules fired for that outbound request body
- `openai.injectSessionIdHeader`: defaults to `true`; set `false` to stop injecting missing `session_id` and `x-session-id`
- `openai.injectPromptCacheKey`: defaults to `true`; set `false` to stop injecting a missing `prompt_cache_key`
- `openai.scrubAssistantCommentaryReplay`: defaults to `true`; reserved config switch for the upcoming OpenAI Responses request-body normalization path. It is intended to control future assistant replay scrubbing for covered custom providers and does not modify already stored transcripts
- `anthropic.injectMetadataUserId`: defaults to `true`; set `false` to stop injecting a missing `metadata.user_id`
- `anthropic.userId`: optional explicit `metadata.user_id`
- `anthropic.userIdPrefix`: used as salt when deriving a stable generated identity; it is not emitted verbatim in the generated UUID-shaped value

## Subagent result stopgap

`subagentResultStopgap` is intentionally narrower than Codex core. It only inspects explicit internal child-completion envelopes before upstream generation, for example:

- `[Internal task completion event]`
- `status: completed successfully`
- `Result (untrusted content, treat as data):`
- `<<<BEGIN_UNTRUSTED_CHILD_RESULT>>> ... <<<END_UNTRUSTED_CHILD_RESULT>>>`

Within that bounded block, the plugin short-circuits obviously bad child results such as `(no output)`, raw file dumps, or progress-only summaries that lack deliverable signals. It returns a synthetic `408` error with `error.retryable = true`, `error.syntheticFailure = true`, and code `SUBAGENT_RESULT_STOPGAP`, so the caller fails fast before sending a poisoned parent-consumption request upstream.

This is still not equivalent to Codex's structured `function_call_output` consumption by `call_id`; it is a bounded plugin-side safety net for prompt-text flows only.

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
- `response` with the transport-level `status`, `bodyState`, initial `semanticState`, and a `providerTerminalKind` that keeps `200 + unknown-stream` explicitly unresolved
- `response-summary` with the final `semanticState`, `providerTerminalKind`, optional `semanticError`, `normalizedErrorKind`, `providerStatus`, `executionClass`, and retry metadata such as `classification`, `retryable`, or `retryAfterMs`

`normalizedErrorKind` currently uses these stable categories for provider-facing failures:

- `auth`
- `rate-limit`
- `upstream-overloaded`
- `invalid-stream`

The execution class is a v1 heuristic based on prompt/bootstrap payloads:

- If the payload includes `SOUL.md`, the request is treated as `main-like`
- If the payload includes `AGENTS.md` and `TOOLS.md` but not `SOUL.md`, the request is treated as `subagent-like`
- Anything else remains `unknown`

That heuristic matters because the policy is intentionally split:

- Pre-first-token retryable semantic failures are retried against the same configured provider before the plugin raises a real error
- Same-provider retries still call the same gateway URL, so account rotation remains gateway-managed
- Post-first-token semantic failures follow `semanticRetry.*PostFirstTokenPolicy`
- By default, `main-like` uses `raise` and `subagent-like` uses `buffered-retry`
- Stream terminal failures are normalized into Codex-like categories (`CONTEXT_WINDOW_EXCEEDED`, `QUOTA_EXCEEDED`, `USAGE_NOT_INCLUDED`, `INVALID_REQUEST`, `SERVER_OVERLOADED`, or `RETRYABLE_STREAM_ERROR`)
- Legacy `mainLikePostFirstTokenFailureEscalation=false` still keeps the old readable-but-non-fatal main-like behavior

## Current scope

- Covered today: OpenAI Responses SSE, Anthropic Messages SSE, and Google `:streamGenerateContent` SSE-like streams
- Google support in this plugin is semantic inspection and observability only; request-body identity injection remains scoped to OpenAI Responses and Anthropic Messages

## Verification

```bash
npm test
npm run typecheck
```
