{
  description = "Declarative Pi configuration for NixOS";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

    home-manager = {
      url = "github:nix-community/home-manager";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    pi-flake = {
      url = "github:ChauDucToan/pi-flake";
      inputs.nixpkgs.follows = "nixpkgs";
      inputs.home-manager.follows = "home-manager";
    };
  };

  outputs =
    {
      self,
      home-manager,
      nixpkgs,
      pi-flake,
    }:
    let
      systems = [
        "aarch64-linux"
        "x86_64-linux"
      ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
    in
    {
      formatter = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        pkgs.writeShellApplication {
          name = "nixos-pi-format";
          runtimeInputs = [
            pkgs.fd
            pkgs.nixfmt
          ];
          text = ''
            if [ "$#" -gt 0 ]; then
              exec nixfmt "$@"
            fi
            fd --type f --extension nix --exec nixfmt
          '';
        }
      );

      packages = forAllSystems (system: {
        inherit (pi-flake.packages.${system}) pi-coding-agent;
        default = self.packages.${system}.pi-coding-agent;
      });

      nixosModules = {
        default = import ./module.nix { inherit self pi-flake; };
        dictationExtension = import ./dictation-extension.nix;
      };

      checks = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          extensionTests =
            pkgs.runCommand "nixos-pi-extension-tests" { nativeBuildInputs = [ pkgs.nodejs ]; }
              ''
                cp -r ${./extensions} extensions
                chmod -R u+w extensions
                mapfile -t tests < <(find extensions -name '*.test.mjs' -type f | sort)
                node --test "''${tests[@]}"
                touch "$out"
              '';
        in
        {
          extensions = extensionTests;
        }
        // nixpkgs.lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux (
          let
            evaluated = nixpkgs.lib.nixosSystem {
              inherit system;
              specialArgs.username = "kevin";
              modules = [
                self.nixosModules.default
                self.nixosModules.dictationExtension
                home-manager.nixosModules.home-manager
                {
                  system.stateVersion = "25.11";
                  users.users.kevin = {
                    isNormalUser = true;
                    group = "users";
                    home = "/home/kevin";
                  };
                  home-manager.users.kevin.home.stateVersion = "25.11";
                }
              ];
            };
            homeFiles = evaluated.config.home-manager.users.kevin.home.file;
            sharedSkillsTarget = "${evaluated.config.home-manager.users.kevin.home.homeDirectory}/.pi/agent/skills";
            requiredHomeFiles = [
              ".claude/skills"
              ".codex/skills"
              ".pi/agent/AGENTS.md"
              ".pi/agent/extensions/dictation.ts"
              ".pi/agent/extensions/session-status"
              ".pi/agent/settings.json"
              ".pi/agent/skills"
              ".pi/agent/zentui.json"
              ".pi/settings.json"
            ];
            missingHomeFiles = builtins.filter (name: !(builtins.hasAttr name homeFiles)) requiredHomeFiles;
          in
          {
            module =
              assert evaluated.config.services.pi-coding-agent.enable;
              assert missingHomeFiles == [ ];
              assert homeFiles.".claude/skills".force;
              assert homeFiles.".codex/skills".force;
              pkgs.runCommand "nixos-pi-module-check" { } ''
                for skillFile in \
                  bro/SKILL.md \
                  domain-modeling/ADR-FORMAT.md \
                  domain-modeling/CONTEXT-FORMAT.md \
                  domain-modeling/SKILL.md \
                  grilling/SKILL.md \
                  grill-me/SKILL.md \
                  grill-with-docs/SKILL.md
                do
                  test -f ${homeFiles.".pi/agent/skills".source}/"$skillFile"
                done
                test "$(readlink ${homeFiles.".claude/skills".source})" = ${sharedSkillsTarget}
                test "$(readlink ${homeFiles.".codex/skills".source})" = ${sharedSkillsTarget}
                touch "$out"
              '';
          }
        )
      );
    };
}
