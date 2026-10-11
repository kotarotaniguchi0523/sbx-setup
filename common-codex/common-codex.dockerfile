FROM docker/sandbox-templates:codex

USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential procps file curl ca-certificates xz-utils git \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g cf difit pnpm agent-browser

# waza: fetch the pinned release binary + checksums directly. The upstream
# install.sh queries api.github.com unauthenticated, which is rate-limited
# (HTTP 403) on shared CI runners, so we do not use it here.
ARG WAZA_VERSION=0.38.10
RUN set -eux; \
    warch="$(dpkg --print-architecture)"; \
    base="https://github.com/microsoft/waza/releases/download/v${WAZA_VERSION}"; \
    curl -fSL -o "/tmp/waza-linux-${warch}" "${base}/waza-linux-${warch}"; \
    curl -fSL -o /tmp/waza-checksums.txt "${base}/checksums.txt"; \
    (cd /tmp && grep "waza-linux-${warch}" waza-checksums.txt | sha256sum -c -); \
    install -m 0755 "/tmp/waza-linux-${warch}" /usr/local/bin/waza; \
    rm -f "/tmp/waza-linux-${warch}" /tmp/waza-checksums.txt

USER agent

RUN curl -LsSf https://astral.sh/uv/install.sh | sh \
 && curl https://mise.run | sh

# ax: pinned release (the installer honours AX_VERSION).
ARG AX_VERSION=0.1.25
RUN AX_VERSION="v${AX_VERSION}" curl -fsSL https://ax.yusuke.run/install | sh

RUN NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" \
 && /home/linuxbrew/.linuxbrew/bin/brew install k1LoW/tap/mo gh apm

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
