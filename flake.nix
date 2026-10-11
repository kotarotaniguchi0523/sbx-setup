{
  description = "sbx common environment — local dev tooling";

  # Dependencies for working on this repo (hooks, converter, sisakulint launcher,
  # builds). Pinned tool versions that are not in nixpkgs are tracked separately:
  #   - Go       -> tools/golang.version   (downloaded by tools/sisakulint.mjs)
  #   - sisakulint -> tools/sisakulint.version
  #   - waza / ax  -> ARG WAZA_VERSION / ARG AX_VERSION in the kit Dockerfiles
  # Renovate updates the flake inputs once flake.lock exists (run `nix flake lock`).

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
    in
    {
      devShells = forAllSystems (system:
        let
          pkgs = import nixpkgs { inherit system; };
        in
        {
          default = pkgs.mkShell {
            packages = with pkgs; [
              nodejs_24
              go
              git
              gh
              curl
              jq
              lefthook
              betterleaks
            ] ++ pkgs.lib.optionals pkgs.stdenv.isLinux [ pkgs.docker-client ];
          };
        });
    };
}
