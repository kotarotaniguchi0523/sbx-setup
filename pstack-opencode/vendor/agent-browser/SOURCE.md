# Vendored agent-browser skill

Source: https://github.com/vercel-labs/agent-browser
Upstream path: `skills/agent-browser/SKILL.md`
Pinned commit: `04ba5264dade678062c3cdcce0f4f293e748249f`
License: Apache-2.0 (see `LICENSE`)

## Local change

Removed the `npx`-based permission from `allowed-tools`; only the installed
`agent-browser` CLI is allowed. The skill invokes the installed CLI, so the
`npx` form also permitted an unpinned package fetch, which SkillSpector reports
as `RP1` (rug-pull risk).

The upstream skill is tracked by APM, so the fix is vendored here and declared
as a local dependency in `apm.yml`. When updating this file from upstream,
re-apply the one-line `allowed-tools` change. Upstream issue:
https://github.com/vercel-labs/agent-browser/issues/2230
