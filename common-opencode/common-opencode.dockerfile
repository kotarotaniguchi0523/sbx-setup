# ---- build the CLI toolchain with Nix (reproducible, hash-verified) --------
# uv, gh, apm, agent-browser, obscura, ffmpeg, jq, ripgrep, fd, typos,
# lefthook, betterleaks, waza, ax, depgraph and Node 24 LTS (+ its npm) all come from
# ./flake.nix.
# The bundle closure is copied into the image so no npm -g / brew / curl|bash
# installers run (cf / difit / opencode stay on npm; see below).
# mise and pnpm come from their vendors' official images instead: both ship a
# single static binary and track upstream releases faster than nixpkgs does
# (mise 2026.10.3 vs 2026.10.13, pnpm 12.9.0 vs 12.14.0 when this was written).
FROM nixos/nix@sha256:7a007c766426c1877758ddc5cb87a965ac131fc78c582ce0083d922d51ae945c AS tools
WORKDIR /src
COPY flake.nix flake.lock ./
RUN set -eux; \
    nix --extra-experimental-features "nix-command flakes" build .#bundle -o /out/bundle; \
    readlink -f /out/bundle > /out/bundle-path; \
    nix-store -qR /out/bundle | while read -r p; do printf '%s\n' "${p#/}"; done > /out/closure.txt; \
    cd / && tar -cf /out/store.tar --files-from=/out/closure.txt

FROM docker/sandbox-templates:opencode@sha256:7feb9784bc882dbe014888becb65c23e7fb1d1b24169a68d33660fe44476a0b4

USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential procps file curl ca-certificates xz-utils git \
 && rm -rf /var/lib/apt/lists/*

# Single Node.js / npm: drop the base image's own copy (apt nodejs/npm on the
# claude-code base, the official Node tarball under /usr/local on the codex /
# opencode bases) so only the Nix Node 24 LTS and npm 12 below are on PATH.
RUN set -eux; \
    if dpkg -s nodejs >/dev/null 2>&1 || dpkg -s npm >/dev/null 2>&1; then \
      apt-get purge -y nodejs npm; \
      apt-get autoremove -y --purge; \
    fi; \
    rm -rf /usr/local/bin/node /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
           /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
           /usr/local/include/node /usr/local/share/doc/node /usr/local/share/man/man1/node.1; \
    test -z "$(command -v node || true)"

# mise + pnpm from the vendors' official images. Both are single static binaries
# with no runtime deps; the digest pins are what Renovate's docker manager keeps
# current, the same mechanism as the base image above.
#   jdxcode/mise      -> /usr/local/bin/mise
#   ghcr.io/pnpm/pnpm -> /opt/pnpm/pnpm, symlinked onto PATH so the PNPM_CONFIG_*
#                        wrapper below can rewrite that symlink into a shim.
COPY --from=jdxcode/mise:2026.11.4@sha256:085be191bbe51dbe93894681b7f29f6c014ae267e7a365c0b8b6a2fdd882ac63 /usr/local/bin/mise /usr/local/bin/mise
COPY --from=ghcr.io/pnpm/pnpm:12.14.0@sha256:71202ae73719148f6b6e129ca1e9fa3ceabbc9a037dc34800715606f2b5290a1 /opt/pnpm/pnpm /opt/pnpm/pnpm
RUN ln -sf /opt/pnpm/pnpm /usr/local/bin/pnpm

# CLI toolchain from the Nix bundle (Node 24 LTS + its bundled npm): unpack the
# store closure and link every binary onto PATH.
COPY --from=tools /out/store.tar /tmp/store.tar
COPY --from=tools /out/bundle-path /tmp/bundle-path
RUN set -eux; \
    tar -xf /tmp/store.tar -C /; \
    bundle="$(cat /tmp/bundle-path)"; \
    for f in "$bundle"/bin/*; do ln -sf "$f" "/usr/local/bin/$(basename "$f")"; done; \
    rm -f /tmp/store.tar /tmp/bundle-path; \
    uv --version; mise --version; gh --version | head -1; pnpm --version; node --version; npm --version; depgraph --version

# pnpm-only defaults: the sandbox workspace is a virtiofs/FUSE mount where
# pnpm's default symlinks break. Wrap pnpm so the settings apply only while
# pnpm runs -- PNPM_CONFIG_* is pnpm's own env namespace, so npm / yarn / other
# toolchains never see it, and no global pnpm config file is installed.
RUN real="$(readlink -f /usr/local/bin/pnpm)" \
 && rm -f /usr/local/bin/pnpm \
 && printf '%s\n' \
      '#!/bin/sh' \
      'export PNPM_CONFIG_NODE_LINKER="${PNPM_CONFIG_NODE_LINKER:-hoisted}"' \
      'export PNPM_CONFIG_PREFER_SYMLINKED_EXECUTABLES="${PNPM_CONFIG_PREFER_SYMLINKED_EXECUTABLES:-false}"' \
      "exec \"$real\" \"\$@\"" \
      > /usr/local/bin/pnpm \
 && chmod +x /usr/local/bin/pnpm \
 && pnpm --version

# npm 12 (latest) on top of the Nix-provided Node 24 LTS, which satisfies npm
# 12's engine requirement (>= 24.15). Installed from the registry; Renovate
# tracks the version. The Nix npm links are moved aside and used only to
# bootstrap npm 12 into /usr/local (npm refuses to overwrite a link it does not
# own), leaving exactly one node and one npm on PATH.
RUN mkdir -p /tmp/npm-boot \
 && mv /usr/local/bin/npm /usr/local/bin/npx /tmp/npm-boot/ \
 && PATH="/tmp/npm-boot:$PATH" npm install -g npm@12.2.2 --prefix /usr/local \
 && rm -rf /tmp/npm-boot \
 && test "$(which -a node | wc -l)" -eq 1 \
 && test "$(which -a npm | wc -l)" -eq 1 \
 && test "$(command -v npm)" = /usr/local/bin/npm \
 && node --version && npm --version

# npm-only CLIs, fully pinned via package-lock.json (npm ci, integrity-checked).
# Their npm packages are not self-contained (they import runtime deps such as
# minisearch / commander), so they are not in the Nix bundle.
#   cf    = Cloudflare's new CLI (cloudflare/cf)
#   difit = yoshiko-pg/difit
COPY tools/npm/cli /opt/npm-cli
RUN cd /opt/npm-cli \
 && npm ci --omit=dev \
 && for f in node_modules/.bin/*; do ln -sf "/opt/npm-cli/$f" "/usr/local/bin/$(basename "$f")"; done \
 && cf --version && difit --help >/dev/null

# opencode = v2 @opencode/cli (nixpkgs ships a different v1 project).
COPY tools/npm/opencode /opt/npm-opencode
RUN npm uninstall -g opencode-ai \
 && cd /opt/npm-opencode \
 && npm ci --omit=dev \
 && for f in node_modules/.bin/*; do ln -sf "/opt/npm-opencode/$f" "/usr/local/bin/$(basename "$f")"; done \
 && opencode --version

# The /nix dir was created root-owned when we unpacked the bundle closure; give
# the agent ownership so the single-user Nix install below can proceed.
RUN chown -R agent:agent /nix

USER agent

RUN curl --proto '=https' --tlsv1.2 -L https://nixos.org/nix/install | sh -s -- --no-daemon

RUN touch /etc/sandbox-persistent.sh \
 && printf '%s\n' \
      'export PATH="/home/agent/.local/share/mise/shims:/home/agent/.local/bin:/home/agent/.nix-profile/bin:$PATH"' \
      'export AGENT_BROWSER_ENGINE=obscura' \
      >> /etc/sandbox-persistent.sh

# Generate the pstack-opencode APM package from 本家 cursor/plugins/pstack at
# image build time (git sparse fetch + tools/convert.mjs), then install it plus the
# third-party skills in one APM call (parallel downloads). The .apm/ tree is not
# committed; it is produced here so the conversion happens on every build.
#   third-party: mizchi/explainer, nanaism/yomiyasu,
#                yusukebe/ax, microsoft/waza, microsoft/apm (apm-usage)
#   agent-browser comes from pstack-opencode/vendor/agent-browser via its
#   apm.yml; do not add vercel-labs/agent-browser here, or it overrides the
#   locally pinned copy (and restores the unpinned npx permission).
COPY --chown=agent:agent pstack-opencode /opt/pstack-opencode
RUN export PATH="/home/agent/.local/bin:/home/agent/.nix-profile/bin:$PATH" \
 && cd /opt/pstack-opencode \
 && node tools/convert.mjs \
 && cd /home/agent \
 && apm install -g --target opencode --parallel-downloads 8 \
      /opt/pstack-opencode \
      mizchi/explainer \
      nanaism/yomiyasu \
      yusukebe/ax \
      microsoft/waza \
      microsoft/apm/packages/apm-guide/.apm/skills/apm-usage \
 && mkdir -p /home/agent/.config/opencode \
 && cp /opt/pstack-opencode/opencode/AGENTS.md /home/agent/.config/opencode/AGENTS.md

ENV BASH_ENV=/etc/sandbox-persistent.sh

# Keep the base image's ENTRYPOINT (["tini","--"]) so the sandbox init runs;
# only set the launch command. `opencode` here is the v2 binary installed above.
CMD ["opencode"]
