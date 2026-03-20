# Session Metadata Transport Design

## Goal

Implement an independent OpenClaw plugin that injects stable session metadata for configured provider `baseUrl` values without reading provider API keys and without changing persistent OpenClaw config files at runtime.

## Design

- Patch `globalThis.fetch` from a plugin service during OpenClaw runtime.
- Build match rules from `config.models.providers[*].baseUrl` plus provider API type.
- For matched OpenAI-compatible requests, fill `prompt_cache_key`, `session_id`, and `x-session-id` if absent.
- For matched Anthropic-compatible requests, fill `metadata.user_id` if absent.
- Keep a stable installation-scoped identity in plugin state under OpenClaw `stateDir`.
- Restore the original `fetch` implementation on plugin stop.

## Non-goals

- No transcript rewriting
- No proxy port or local listener
- No provider key lookup or secret persistence
- No support for providers that bypass configured `baseUrl`
