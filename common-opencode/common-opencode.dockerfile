FROM docker/sandbox-templates:opencode

USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential procps file curl ca-certificates xz-utils git \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g cf difit pnpm agent-browser

# OpenCode v2 (beta). The base image ships v1 (opencode-ai); replace it so the
# `opencode` entrypoint runs v2. https://opencode.ai/v2
RUN npm uninstall -g opencode-ai && npm install -g @opencode/cli

RUN curl -fsSL https://raw.githubusercontent.com/microsoft/waza/main/install.sh | bash

USER agent

RUN curl -LsSf https://astral.sh/uv/install.sh | sh \
 && curl https://mise.run | sh

RUN curl -fsSL https://ax.yusuke.run/install | sh

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
