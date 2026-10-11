# ---- build the CLI toolchain with Nix (reproducible, hash-verified) --------
# uv, mise, gh, apm, mo, pnpm, agent-browser, jq, ripgrep, fd, typos, lefthook,
# betterleaks, waza, ax and Node 24 LTS (+ its npm) all come from ./flake.nix.
# The bundle closure is copied into the image so no npm -g / brew / curl|bash
# installers run.
FROM nixos/nix@sha256:7a007c766426c1877758ddc5cb87a965ac131fc78c582ce0083d922d51ae945c AS tools
WORKDIR /src
COPY flake.nix flake.lock ./
RUN set -eux; \
    nix --extra-experimental-features "nix-command flakes" build .#bundle -o /out/bundle; \
    readlink -f /out/bundle > /out/bundle-path; \
    nix-store -qR /out/bundle | while read -r p; do printf '%s\n' "${p#/}"; done > /out/closure.txt; \
    cd / && tar -cf /out/store.tar --files-from=/out/closure.txt

FROM docker/sandbox-templates:codex@sha256:a68b972a59148c6359ade441387159033f6d196d48aef9dda06d2d4bb26eb41e

USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential procps file curl ca-certificates xz-utils git \
 && rm -rf /var/lib/apt/lists/*

# CLI toolchain from the Nix bundle (Node 24 LTS + its bundled npm): unpack the
# store closure and link every binary onto PATH.
COPY --from=tools /out/store.tar /tmp/store.tar
COPY --from=tools /out/bundle-path /tmp/bundle-path
RUN set -eux; \
    tar -xf /tmp/store.tar -C /; \
    bundle="$(cat /tmp/bundle-path)"; \
    for f in "$bundle"/bin/*; do ln -sf "$f" "/usr/local/bin/$(basename "$f")"; done; \
    rm -f /tmp/store.tar /tmp/bundle-path; \
    uv --version; mise --version; gh --version | head -1; pnpm --version; mo --version; node --version; npm --version

# npm 12 (latest) on top of the Nix-provided Node 24 LTS (see common-opencode).
RUN npm install -g npm@12.2.0 \
 && node --version && npm --version

# npm-only CLIs, fully pinned via package-lock.json (see common-opencode).
COPY tools/npm/cli /opt/npm-cli
RUN cd /opt/npm-cli \
 && npm ci --omit=dev \
 && for f in node_modules/.bin/*; do ln -sf "/opt/npm-cli/$f" "/usr/local/bin/$(basename "$f")"; done \
 && cf --version && difit --help >/dev/null

USER agent

RUN curl --proto '=https' --tlsv1.2 -L https://nixos.org/nix/install | sh -s -- --no-daemon

RUN touch /etc/sandbox-persistent.sh \
 && printf '%s\n' 'export PATH="/home/agent/.local/bin:/home/agent/.nix-profile/bin:/home/linuxbrew/.linuxbrew/bin:$PATH"' >> /etc/sandbox-persistent.sh

# Shared skills via APM (codex target -> ~/.agents/skills). No pstack here
# (the pstack conversion targets OpenCode only).
RUN export PATH="/home/agent/.local/bin:/home/agent/.nix-profile/bin:/home/linuxbrew/.linuxbrew/bin:$PATH" \
 && cd /home/agent \
 && apm install -g --target codex --parallel-downloads 8 \
      mizchi/explainer \
      nanaism/yomiyasu \
      vercel-labs/agent-browser \
      yusukebe/ax \
      microsoft/waza \
      microsoft/apm/packages/apm-guide/.apm/skills/apm-usage

ENV BASH_ENV=/etc/sandbox-persistent.sh

# Keep the base image's ENTRYPOINT (["tini","--"]); only set the launch command.
CMD ["codex"]
