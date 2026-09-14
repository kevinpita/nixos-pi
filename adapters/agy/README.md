# Local AGY review adapter

`nixos-config` consumes this adapter through its `pi-extensions` input.
Its `modules/pi.nix` runs `gemini` (alias `agy`) with AGY 1.2.3,
Gemini 3.8 Flash High, and high effort. Agent profiles and model preferences
stay in `nixos-config`. This replaces the previous isolated execution mode.

The launcher supplies two absolute paths:

```text
node adapter.mjs /absolute/agy /absolute/config.json
```

The JSON configuration requires exactly `model` and `effort`.

## Execution and trust

Like the Claude Code external runner, this adapter uses the operator's normal
home, environment, working directory, login, settings, and hooks. It does not
use Bubblewrap, a private home, or a filtered D-Bus proxy. It does not copy,
read, or replace credential files. AGY owns authentication, including its
file-based fallback on hosts without a desktop keyring.

The agent is instructed to review supplied text only. The adapter rejects
reported tool or subagent activity. This is detection, not prevention. Host
files are not protected by this adapter, and an action can occur before its
event is rejected. Local hooks and plugins are trusted. AGY can save its normal
logs and conversation state in the user's home.

AGY uses the permissions in the user's settings. There is no documented
per-run deny-list flag. The adapter does not change global settings and does
not pass `--dangerously-skip-permissions`. All known inherited permission modes
are accepted, including `always-proceed` if the user configured it. Do not use
this adapter when OS-enforced isolation or guaranteed read-only access is required.

The adapter keeps bounded stdin and output, explicit model and effort selection,
CLI version checks, disabled slash expansion, timeout and cancellation handling,
and validation of the workspace, conversation identity, result, and exit status.
It starts a new conversation rather than continuing an existing one. No model
text is returned until the stream and exit status pass validation.

## Tests

```bash
node --test adapters/agy/adapter.test.mjs
nix fmt -- flake.nix
```

The process-level test uses fake credentials and a fake AGY executable. It checks
that normal home, login, settings, environment, and cwd reach the CLI unchanged.
It does not contact a model service. A live test is still required after deployment.

## Deployment

Publish this change, then update `pi-extensions` in `nixos-config`. The launcher
must use the new two-argument interface, without Bubblewrap or D-Bus proxy paths.
Rebuild the target host's NixOS configuration and reload Pi to load the new agent
profile and launcher. Editing this repository does not change running sessions.

## References

- https://antigravity.google/docs/cli/headless/
- https://antigravity.google/docs/cli/permissions
- https://antigravity.google/docs/cli/settings
