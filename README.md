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
- `requestLogging.enabled`: when `true`, append sanitized JSONL request and response events for each forwarded plugin-handled request to `stateDir/forwarded-requests.jsonl`
- `requestLogging.path`: optional custom log file path; relative paths resolve from the plugin `stateDir`
- `anthropic.userId`: optional explicit `metadata.user_id`
- `anthropic.userIdPrefix`: used when generating a stable installation-scoped identity

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
- `response-summary` with the final `semanticState`, `providerTerminalKind`, optional `semanticError`, `normalizedErrorKind`, `providerStatus`, and `executionClass`

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

- Pre-first-token semantic failures are upgraded to real stream errors for all covered streams
- Post-first-token semantic failures are only upgraded to real stream errors for `subagent-like` requests
- Main-like partial failures stay readable to the caller and are only logged as semantic failures

## Current scope

- Covered today: OpenAI Responses SSE, Anthropic Messages SSE, and Google `:streamGenerateContent` SSE-like streams
- Google support in this plugin is semantic inspection and observability only; request-body identity injection remains scoped to OpenAI Responses and Anthropic Messages

## Verification

```bash
npm test
npm run typecheck
```
