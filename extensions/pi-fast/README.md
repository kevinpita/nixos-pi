# pi-fast

`/fast` toggles fast service for the current session. The setting survives subsequent turns, reloads, and resumes, and follows the selected session branch. New sessions start with the configured default.

Supported models on `openai-codex` and `openai`: GPT-5.4, GPT-5.5, GPT-5.6 (including Luna, Sol, and Terra), and GPT-6 Astra. Requests use `service_tier: "priority"` when enabled and `"default"` when disabled. Other models are left unchanged. The model and thinking level stay the same.

OpenAI accepts `priority` for [Fast mode](https://openai.com/api-fast-mode/). Availability and actual service depend on the account and backend.

## Install

Copy this directory to `~/.pi/agent/extensions/pi-fast/` and run `/reload`. For a temporary session:

```sh
pi -e ./extensions/pi-fast/index.ts
```

For NixOS, select this directory in `nixos-config/modules/pi.nix`, as with the other extensions in this repository.

## Default

Create `~/.pi/agent/pi-fast.json` (or `pi-fast.json` inside `PI_CODING_AGENT_DIR`):

```json
{ "enabledByDefault": true }
```

The default is off when the file is absent. `/fast` changes only the session, never this file.

## Subagents

New Pi subagents inherit the parent's setting through `PI_FAST_STATE`, including native foreground and background `pi-subagents` sessions. Each child captures the setting when its extension loads and persists it in its own session. Existing children keep their setting when the parent toggles again.

Install the extension globally so children load it too. If an agent has an explicit `extensions` list, include `pi-fast/index.ts` there. A temporary parent `-e` flag alone does not install the extension for children. External CLI agents and children with extensions disabled cannot use this extension.

Use `/fast` in the parent; `pi-subagents`' separate `fast: true` option has its own model allowlist and can reject Astra.
