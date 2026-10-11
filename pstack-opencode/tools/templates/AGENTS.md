# pstack routing

The pstack skill set is installed (poteto's agent workflows). Route work
through it:

- Invoke the `poteto-mode` skill at the start of a task that touches more than
  one file, changes a signature other files call, involves a design or
  architecture choice, or is a bug with an unknown cause or a performance
  issue. It selects a playbook and runs the supporting skills.
- Smaller, single-file, clearly-scoped changes proceed directly.
- Explicit user instructions take precedence over this rule.

These skills are authored for Cursor / Claude Code. Where a skill names a
Claude tool, subagent, or model, use the OpenCode equivalent in the
`poteto-mode` skill's `references/opencode-tools.md`. In short: `read`,
`write`, `edit`, `shell`, `grep`, `glob`, the `skill` tool to load a skill,
`subagent` to dispatch an agent, `question` to ask, and your configured
`provider/model` names.

## Environment

- Skills are installed with APM (`apm`); the pstack set and the shared skills are
  already present under `~/.config/opencode/skills`.
- Common CLIs are available: `git` / `gh`, `uv`, `mise`, `nix`, `node` / `npm` /
  `pnpm`, `cf` (Cloudflare), `mo` (markdown preview), `difit` (diff viewer),
  `apm`, `waza`, `ax`, `agent-browser`.
- Prefer these installed tools and keep changes reproducible.
