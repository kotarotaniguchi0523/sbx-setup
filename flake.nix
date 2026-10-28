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

          wazaVersion = "0.39.0";
          axVersion = "0.1.25";
          sisakulintVersion = "0.3.8";

          wazaAssets = {
            x86_64-linux = { name = "waza-linux-amd64"; sha256 = "a80138c3d37d48e947ef5b414a1ba4657935b7334d2cebe47cf71d004680f250"; };
            aarch64-linux = { name = "waza-linux-arm64"; sha256 = "1cf67885d7ddb6047aac9da932c5169c8c89eea00926f3fec37069e0249e625d"; };
            x86_64-darwin = { name = "waza-darwin-amd64"; sha256 = "22f6d715af18904d6e68fee767b21d0b0c1a35baab85f42deec671fef4749a5e"; };
            aarch64-darwin = { name = "waza-darwin-arm64"; sha256 = "f4732e350a61e22f440ddfe7fcedc2e781661fd7c039cf3005af90bab5d52c0f"; };
          };
          axAssets = {
            x86_64-linux = { name = "ax-linux-x64"; sha256 = "6e72297182074038a202d94e1cca9d61e8908d8a4fd5206b3c25ab91957cae2f"; };
            aarch64-linux = { name = "ax-linux-arm64"; sha256 = "631fabf91071b30022039edb0c89a5e8768067cc00c8cf7ddb598326f02d2d5c"; };
            x86_64-darwin = { name = "ax-darwin-x64"; sha256 = "c33b0a72df9960116e8467bfa0b170eec3f57244630ec8018efc593c7c375083"; };
            aarch64-darwin = { name = "ax-darwin-arm64"; sha256 = "94633f9d61c743cffcf51e5338289d974c21428efb70bd2995e6c6ec13e062c1"; };
          };
          sisakulintAssets = {
            x86_64-linux = { name = "sisakulint_${sisakulintVersion}_linux_amd64.tar.gz"; sha256 = "6da250932db1cc6fae8b8f44185acacb6e6ffc16dbafb90b1a37a25ad3ad21df"; };
            aarch64-linux = { name = "sisakulint_${sisakulintVersion}_linux_arm64.tar.gz"; sha256 = "81bdfda81da01a3481fa4d2455fc9930dc6b3e39d78c9b4552458f89806caf61"; };
            x86_64-darwin = { name = "sisakulint_${sisakulintVersion}_darwin_amd64.tar.gz"; sha256 = "dd3107cacc022332428bc05995b1a4cf4d5fcdffdcf04f7b8047fd580e183a73"; };
            aarch64-darwin = { name = "sisakulint_${sisakulintVersion}_darwin_arm64.tar.gz"; sha256 = "4816e02bf8579b3d08aa5442014a06f646f8c963b8c1ce80c33c3accf2950f48"; };
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

          # CLI tooling this repo adds to the sandbox images. Consumed as a
          # closure (see the kit Dockerfiles) so the images do not run npm -g /
          # brew / curl|bash installers. Tools already in the base image
          # (uv, gh, jq, ripgrep, node, npm, python, git, curl) are NOT repeated
          # here — the base image is digest-pinned, so those stay pinned too.
          # mise and pnpm are not here either: the Dockerfiles copy those two
          # from the vendors' official images (jdxcode/mise, ghcr.io/pnpm/pnpm),
          # which ship a single static binary and track upstream faster than
          # nixpkgs does. mo is installed through mise (aqua backend) in the
          # Dockerfiles, where the version is pinned and Renovate tracks it.
          bundle = pkgs.buildEnv {
            name = "sbx-tools";
            paths = with pkgs; [
              apm-cli
              nodejs_24
              agent-browser
              obscura
              ffmpeg
              fd
              typos
              lefthook
              betterleaks
              waza
              ax
            ];
            pathsToLink = [ "/bin" ];
          };

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
