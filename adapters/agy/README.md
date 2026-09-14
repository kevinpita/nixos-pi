# AGY review adapter

This adapter runs Antigravity CLI 1.2.3 through pi-subagents' external CLI runner.
The consuming configuration supplies the agent name, model, and effort.
`nixos-config` defines `gemini`, alias `agy`, using Gemini 3.8 Flash High.

```text
/run gemini "Review this supplied diff without edits: ..."
/run agy "Review this supplied function: ..."
```

In ordinary chat, ask Gemini to review a target. The parent supplies the diff and
source context inline. This agent cannot inspect the working repository.
`/multi-review` still selects Oracle and Claude unless its recipe is changed.

## Integration

`nixos-config` consumes `adapters/agy/` through its `pi-extensions` input.
Its `modules/pi.nix` installs a Nix-built launcher and the local
`pi/agents/gemini.md` profile. Apply that configuration and reload Pi to load it.
The launcher supplies four absolute paths:

```text
node adapter.mjs /path/to/agy /path/to/bwrap /path/to/xdg-dbus-proxy /path/to/config.json
```

The JSON configuration requires exactly `model` (an AGY model slug) and
`effort` (`low`, `medium`, or `high`). There is no adapter-level model default.
The protocol verifies that AGY used the requested model. Configuration cannot
change permission or sandbox rules. No new Pi extension or pi-subagents fork is required. The generic
`external-cli` runner owns async status, stop, and output artifacts. This local
adapter owns AGY flags, isolation, protocol validation, and process cleanup.

The generic runner does not expose native tool events, structured results,
resume, live steering, Pi model overrides, or native fork context. Pi usage
reports do not account for AGY model tokens through this generic runner.
Model and effort changes belong in the consuming configuration, not a native Pi
`model` override.

## Access boundary

AGY has no equivalent of Claude Code's `--tools` empty allowlist. Its plan mode
is not a security boundary and has no effect with slash expansion disabled.
This adapter therefore uses:

- A private home, workspace, project metadata, logs, and conversation state.
  Temporary state is removed after normal completion, cancellation, or failure.
- Bubblewrap with a read-only host root, hidden home directories, temporary
  `/tmp`, private PID namespace, and hidden host runtime sockets. Only the
  isolated home, workspace, and AGY project metadata are writable bind mounts.
- Read-only isolated settings with explicit denies for every documented
  permission resource. User settings, hooks, plugins, and conversations are
  not copied. Global customizations are empty and read-only.
- A filtered D-Bus proxy that exposes only `org.freedesktop.secrets`, for the
  operator's existing AGY login. Other desktop services are not exposed.
- A minimal environment, no session reuse, disabled slash expansion, and no
  permission bypass flags.
- One bounded stdin message. Prompt text never appears in process arguments.
- Strict streamed output validation: matching model, workspace, strict
  permissions, and conversation identity, one successful terminal result, and
  exit status zero. Tool or subagent activity, malformed or oversized output,
  duplicate results, missing results, and failures reject the entire review.

This is handoff-only review with denied tools, not a claim that AGY removes
its tool definitions. The protocol check is detection, not the access-control
boundary. Bubblewrap and the permission engine supply that boundary.

Network access remains available for AGY. The CLI and its locally installed
`bin` and `builtin` assets are trusted. The filtered keyring connection can read
and refresh credentials, like the normal CLI. The adapter is not a sandbox for
a malicious AGY executable and does not isolate a compromised model service.
External account quota, retention, and data policies still apply.

An uncatchable process kill can leave a mode-0700 `pi-agy-review-*` temporary
directory, including AGY conversation logs and copied onboarding state. The
sandbox dies with its parent and the keyring proxy exits when its owner pipe
closes. Remove an abandoned directory only after confirming its run stopped.

## Compatibility and references

The version guard rejects AGY versions other than 1.2.3. Verify protocol and
permission compatibility before changing that guard.

Protocol and permission references:

- https://antigravity.google/docs/cli/headless/
- https://antigravity.google/docs/cli/permissions
- https://antigravity.google/docs/cli/settings
