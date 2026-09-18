# Pi extensions and adapters

This repository contains Pi extensions, their tests, and external CLI adapters. NixOS configuration, Pi settings, skills, prompts, themes, and session maintenance are maintained in [nixos-config](https://github.com/kevinpita/nixos-config).

## Structure

- `extensions/`: extension implementations, tests, and extension documentation.
- `adapters/`: external CLI adapters and adapter documentation.
- `flake.nix`: formatting, extension checks, and adapter checks. It does not export a Pi runtime or a NixOS configuration module.

[`agy`](adapters/agy/README.md) provides handoff-only review through local Antigravity CLI, using the operator's normal login and settings without adapter filesystem isolation. Agent profiles and model preferences stay in `nixos-config`.

[`pi-fast`](extensions/pi-fast/README.md) adds a persistent `/fast` toggle, a configurable default, and inheritance by Pi subagents.

Jev context pruning now lives in its own repository: [`pi-jev-context`](https://github.com/kevinpita/pi-jev-context). Install it with `pi install npm:pi-jev-context`.

## Checks

With Node.js 24 or later:

```bash
node --test $(find extensions adapters -name '*.test.mjs' -type f | sort)
```

With Nix:

```bash
nix fmt -- flake.nix
nix flake check
```

## NixOS integration

`nixos-config` consumes this repository through its `pi-extensions` input with `flake = false`. It selects extension files in `modules/pi.nix`; it does not load every extension automatically.

After publishing an extension change, update that input in `nixos-config`:

```bash
nix flake update pi-extensions
```
