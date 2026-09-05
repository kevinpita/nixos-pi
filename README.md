# nixos-pi

This flake installs Pi and manages Kevin's Pi configuration on NixOS.

It contains:

- the Pi package from `pi-flake`
- Pi and extension settings
- local Pi extensions and their tests
- global prompts, themes, and instructions
- shared Pi, Claude Code, and Codex skills under `skills/`

## Use the NixOS module

Add the input:

```nix
nixos-pi = {
  url = "github:kevinpita/nixos-pi";
  inputs.nixpkgs.follows = "nixpkgs";
  inputs.home-manager.follows = "home-manager";
};
```

Import the default module in a NixOS configuration that also imports Home Manager:

```nix
{
  imports = [ inputs.nixos-pi.nixosModules.default ];
}
```

The caller must pass `username` as a module argument. The current `nixos-config` flake does this through `specialArgs`.

The dictation command is host-specific. A host that provides `dictate-toggle` can also import:

```nix
{
  imports = [ inputs.nixos-pi.nixosModules.dictationExtension ];
}
```

## Use the package

Build Pi directly:

```bash
nix build .#pi-coding-agent
./result/bin/pi --version
```

## Use Pi profiles

The local `profile-modes` extension provides these persistent commands:

- `/quick`: Use GPT-6 Astra with medium thinking and do not use pstack by default.
- `/deep`: Use GPT-6 Astra with xhigh thinking and use pstack for non-trivial work.
- `/read`: Permit read-only tools only.
- `/read-off`: Restore normal tool access.

## Maintain session history

The Home Manager user timer runs `pi-session-maintenance` each week. The command:

- archives primary Pi sessions older than 90 days under `~/.local/share/pi/session-archive/`;
- removes nested and dedicated subagent sessions older than 30 days;
- removes expired persistent subagent artifacts; and
- stores archives as private `.tar.zst` files.

Future subagent sessions use `~/.local/state/pi-subagents/sessions`. Future subagent artifacts use temporary storage.

Run maintenance manually:

```bash
pi-session-maintenance
```

Inspect the timer:

```bash
systemctl --user status pi-session-maintenance.timer
```

## Validate changes

Run all flake checks:

```bash
nix flake check --all-systems
```

Run the extension tests without Nix:

```bash
mapfile -t tests < <(find extensions -name '*.test.mjs' -type f | sort)
node --test "${tests[@]}"
```
