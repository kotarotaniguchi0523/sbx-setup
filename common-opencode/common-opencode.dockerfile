# ---- build the pinned CLIs with Nix (reproducible, hash-verified) ----------
# waza / ax come from ./flake.nix as fixed-output derivations (release assets
# pinned by sha256), so the image no longer runs `curl | bash` for them.
FROM nixos/nix@sha256:7a007c766426c1877758ddc5cb87a965ac131fc78c582ce0083d922d51ae945c AS tools
WORKDIR /src
COPY flake.nix flake.lock ./
RUN set -eux; \
    mkdir -p /out; \
    nix --extra-experimental-features "nix-command flakes" build --no-link --print-out-paths .#waza > /tmp/waza.path; \
    cp "$(cat /tmp/waza.path)/bin/waza" /out/waza; \
    nix --extra-experimental-features "nix-command flakes" build --no-link --print-out-paths .#ax > /tmp/ax.path; \
    cp "$(cat /tmp/ax.path)/bin/ax" /out/ax; \
    chmod 0755 /out/waza /out/ax

FROM docker/sandbox-templates:opencode@sha256:b3b69aa5148a20d1c0e3ec4d5db2975b8b9d6830d46d50a93fd766aec7d6668b

USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential procps file curl ca-certificates xz-utils git \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g cf difit pnpm agent-browser

# OpenCode v2 (beta). The base image ships v1 (opencode-ai); replace it so the
# `opencode` entrypoint runs v2. https://opencode.ai/v2
RUN npm uninstall -g opencode-ai && npm install -g @opencode/cli

# waza / ax from the Nix build stage (pinned + hash-verified). ax is dynamically
# linked, so it is smoke-tested here where the glibc loader exists.
COPY --from=tools /out/waza /usr/local/bin/waza
COPY --from=tools /out/ax /usr/local/bin/ax
RUN waza --version && ax --version

USER agent

RUN curl -LsSf https://astral.sh/uv/install.sh | sh \
 && curl https://mise.run | sh

RUN NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" \
 && /home/linuxbrew/.linuxbrew/bin/brew install k1LoW/tap/mo gh apm

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
