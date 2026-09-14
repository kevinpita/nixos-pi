{
  description = "Pi extensions, adapters, and checks";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { nixpkgs, ... }:
    let
      forAllSystems = nixpkgs.lib.genAttrs [
        "aarch64-linux"
        "x86_64-linux"
      ];
    in
    {
      formatter = forAllSystems (system: nixpkgs.legacyPackages.${system}.nixfmt);

      checks = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        {
          adapters = pkgs.runCommand "pi-adapter-tests" { nativeBuildInputs = [ pkgs.nodejs ]; } ''
            cp -r ${./adapters} adapters
            chmod -R u+w adapters
            mapfile -t tests < <(find adapters -name '*.test.mjs' -type f | sort)
            node --test "''${tests[@]}"
            touch "$out"
          '';
          extensions = pkgs.runCommand "pi-extension-tests" { nativeBuildInputs = [ pkgs.nodejs ]; } ''
            cp -r ${./extensions} extensions
            chmod -R u+w extensions
            mapfile -t tests < <(find extensions -name '*.test.mjs' -type f | sort)
            node --test "''${tests[@]}"
            touch "$out"
          '';
        }
      );
    };
}
