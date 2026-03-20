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
- `anthropic.userId`: optional explicit `metadata.user_id`
- `anthropic.userIdPrefix`: used when generating a stable installation-scoped identity

## Verification

```bash
pnpm test
pnpm typecheck
```
