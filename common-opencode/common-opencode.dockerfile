# ---- build the CLI toolchain with Nix (reproducible, hash-verified) --------
# uv, mise, gh, apm, mo, cf, difit, pnpm, agent-browser, jq, ripgrep, fd, typos,
# lefthook, betterleaks, waza, ax all come from ./flake.nix. The bundle closure
# is copied into the image so no npm -g / brew / curl|bash installers run.
FROM nixos/nix@sha256:7a007c766426c1877758ddc5cb87a965ac131fc78c582ce0083d922d51ae945c AS tools
WORKDIR /src
COPY flake.nix flake.lock ./
RUN set -eux; \
    nix --extra-experimental-features "nix-command flakes" build .#bundle -o /out/bundle; \
    readlink -f /out/bundle > /out/bundle-path; \
    nix-store -qR /out/bundle | while read -r p; do printf '%s\n' "${p#/}"; done > /out/closure.txt; \
    cd / && tar -cf /out/store.tar --files-from=/out/closure.txt

FROM docker/sandbox-templates:opencode@sha256:b3b69aa5148a20d1c0e3ec4d5db2975b8b9d6830d46d50a93fd766aec7d6668b

USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential procps file curl ca-certificates xz-utils git \
 && rm -rf /var/lib/apt/lists/*

# CLI toolchain from the Nix bundle: unpack the store closure and link every
# binary onto PATH.
COPY --from=tools /out/store.tar /tmp/store.tar
COPY --from=tools /out/bundle-path /tmp/bundle-path
RUN set -eux; \
    tar -xf /tmp/store.tar -C /; \
    bundle="$(cat /tmp/bundle-path)"; \
    for f in "$bundle"/bin/*; do ln -sf "$f" "/usr/local/bin/$(basename "$f")"; done; \
    rm -f /tmp/store.tar /tmp/bundle-path; \
    uv --version; mise --version; gh --version | head -1; pnpm --version; mo -version

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

USER agent

RUN curl --proto '=https' --tlsv1.2 -L https://nixos.org/nix/install | sh -s -- --no-daemon

RUN touch /etc/sandbox-persistent.sh \
 && printf '%s\n' 'export PATH="/home/agent/.local/bin:/home/agent/.nix-profile/bin:/home/linuxbrew/.linuxbrew/bin:$PATH"' >> /etc/sandbox-persistent.sh

# Generate the pstack-opencode APM package from 本家 cursor/plugins/pstack at
# image build time (Repomix fetch + tools/convert.mjs), then install it plus the
# third-party skills in one APM call (parallel downloads). The .apm/ tree is not
# committed; it is produced here so the conversion happens on every build.
#   third-party: mizchi/explainer, nanaism/yomiyasu, vercel-labs/agent-browser,
#                yusukebe/ax, microsoft/waza, microsoft/apm (apm-usage)
COPY --chown=agent:agent pstack-opencode /opt/pstack-opencode
RUN export PATH="/home/agent/.local/bin:/home/agent/.nix-profile/bin:/home/linuxbrew/.linuxbrew/bin:$PATH" \
 && cd /opt/pstack-opencode \
 && node tools/convert.mjs \
 && cd /home/agent \
 && apm install -g --target opencode --parallel-downloads 8 \
      /opt/pstack-opencode \
      mizchi/explainer \
      nanaism/yomiyasu \
      vercel-labs/agent-browser \
      yusukebe/ax \
      microsoft/waza \
      microsoft/apm/packages/apm-guide/.apm/skills/apm-usage \
 && mkdir -p /home/agent/.config/opencode \
 && cp /opt/pstack-opencode/opencode/AGENTS.md /home/agent/.config/opencode/AGENTS.md

ENV BASH_ENV=/etc/sandbox-persistent.sh

# Keep the base image's ENTRYPOINT (["tini","--"]) so the sandbox init runs;
# only set the launch command. `opencode` here is the v2 binary installed above.
CMD ["opencode"]
