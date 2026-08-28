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
