{
  description = "Pi extensions and extension checks";

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
