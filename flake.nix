{
  description = "sbx common environment — tooling (dev shell + pinned CLIs)";

  # Everything the repo's builds and hooks need, declared as a flake:
  #   - the dev toolchain (node, go, gh, curl, jq, lefthook, betterleaks, docker)
  #     comes from nixpkgs and is pinned by flake.lock;
  #   - the CLIs that are not in nixpkgs (waza, ax, sisakulint) are packaged here
  #     as fixed-output derivations (release binaries verified by sha256).
  #
  # Secrets must never go here: the Nix store is world-readable.

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
    in
    {
      # Packaged CLIs. Versions/hashes are pinned here (hashes are the values
      # published in each project's release checksums.txt).
      overlays.default = final: prev:
        let
          system = final.stdenv.hostPlatform.system;

          wazaVersion = "0.38.10";
          axVersion = "0.1.25";
          sisakulintVersion = "0.3.7";

          wazaAssets = {
            x86_64-linux = { name = "waza-linux-amd64"; sha256 = "fae469af3b20ca63b789ad64e8f2c007a069d0843cc88d9e83d224de4f7077b3"; };
            aarch64-linux = { name = "waza-linux-arm64"; sha256 = "0371e7d31da4aa9d5ddf4558ea3cd41490c7a4ca7d14ca4f13f842e99770e829"; };
            x86_64-darwin = { name = "waza-darwin-amd64"; sha256 = "ab9af220fa90714ae13ebf5250531fd2ada828181cdd5d7b205455c2445b7070"; };
            aarch64-darwin = { name = "waza-darwin-arm64"; sha256 = "ca70863080e732eb9157c0aa1d692f441e115a6a0740b805ca28458f433ab706"; };
          };
          axAssets = {
            x86_64-linux = { name = "ax-linux-x64"; sha256 = "6e72297182074038a202d94e1cca9d61e8908d8a4fd5206b3c25ab91957cae2f"; };
            aarch64-linux = { name = "ax-linux-arm64"; sha256 = "631fabf91071b30022039edb0c89a5e8768067cc00c8cf7ddb598326f02d2d5c"; };
            x86_64-darwin = { name = "ax-darwin-x64"; sha256 = "c33b0a72df9960116e8467bfa0b170eec3f57244630ec8018efc593c7c375083"; };
            aarch64-darwin = { name = "ax-darwin-arm64"; sha256 = "94633f9d61c743cffcf51e5338289d974c21428efb70bd2995e6c6ec13e062c1"; };
          };
          sisakulintAssets = {
            x86_64-linux = { name = "sisakulint_${sisakulintVersion}_linux_amd64.tar.gz"; sha256 = "746161556d4913baef4fa60be3dfc8b34ca9ded20ad0dc1a936b58ad4808f5ba"; };
            aarch64-linux = { name = "sisakulint_${sisakulintVersion}_linux_arm64.tar.gz"; sha256 = "f911b7b516fc6cb0159e12ba1143beeaa901b7a2b2b6231e67e89b0dbfba2423"; };
            x86_64-darwin = { name = "sisakulint_${sisakulintVersion}_darwin_amd64.tar.gz"; sha256 = "2b32d103c644038cbc2dfca2e0037f43f25e0f0ba9ccb1bcef1bf744b68f896a"; };
            aarch64-darwin = { name = "sisakulint_${sisakulintVersion}_darwin_arm64.tar.gz"; sha256 = "0119216c5dd7759da9d0b2fcfd010db6b8c42efae0b8be1ddb59eef977f8eb07"; };
          };

          pick = name: table:
            table.${system} or (throw "${name}: unsupported system ${system}");
        in
        {
          waza = final.stdenvNoCC.mkDerivation {
            pname = "waza";
            version = wazaVersion;
            src = final.fetchurl {
              url = "https://github.com/microsoft/waza/releases/download/v${wazaVersion}/${(pick "waza" wazaAssets).name}";
              sha256 = (pick "waza" wazaAssets).sha256;
            };
            dontUnpack = true;
            installPhase = ''
              install -D -m 0755 "$src" "$out/bin/waza"
            '';
          };

          ax = final.stdenvNoCC.mkDerivation {
            pname = "ax";
            version = axVersion;
            src = final.fetchurl {
              url = "https://github.com/yusukebe/ax/releases/download/v${axVersion}/${(pick "ax" axAssets).name}";
              sha256 = (pick "ax" axAssets).sha256;
            };
            dontUnpack = true;
            installPhase = ''
              install -D -m 0755 "$src" "$out/bin/ax"
            '';
          };

          sisakulint = final.stdenvNoCC.mkDerivation {
            pname = "sisakulint";
            version = sisakulintVersion;
            src = final.fetchurl {
              url = "https://github.com/sisaku-security/sisakulint/releases/download/v${sisakulintVersion}/${(pick "sisakulint" sisakulintAssets).name}";
              sha256 = (pick "sisakulint" sisakulintAssets).sha256;
            };
            sourceRoot = ".";
            installPhase = ''
              install -D -m 0755 sisakulint "$out/bin/sisakulint"
            '';
          };
        };

      packages = forAllSystems (system:
        let
          pkgs = import nixpkgs { inherit system; overlays = [ self.overlays.default ]; };
        in
        {
          inherit (pkgs) waza ax sisakulint;
          default = pkgs.sisakulint;
        });

      devShells = forAllSystems (system:
        let
          pkgs = import nixpkgs { inherit system; overlays = [ self.overlays.default ]; };
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
              waza
              ax
              sisakulint
            ] ++ pkgs.lib.optionals pkgs.stdenv.isLinux [ pkgs.docker-client ];
          };
        });
    };
}
