# OpenCode tool mapping for pstack

pstack skills are written in Cursor / Claude Code tool language (the `Skill`
tool, the `Agent` / `Task` tool, `AskUserQuestion`, Claude model names). On
OpenCode the skills are the same files; only the tool and model names resolve
differently. Read this when a pstack skill names a Claude tool, a driver or
bundled skill, or a Claude model. This file is OpenCode-specific.

## Tool actions

| pstack / Claude action | OpenCode equivalent |
|------------------------|---------------------|
| Read a file | `read` |
| Create / replace a file | `write` |
| Edit a file | `edit` |
| Multi-file add/update/delete in one shot | `patch` (models that expose it) |
| Run a shell command | `shell` |
| Search file contents | `grep` |
| Find files by pattern | `glob` |
| Load a skill (the `Skill` tool, `/command`) | `skill` with the exact skill ID |
| Dispatch a subagent (the `Agent` / `Task` tool) | `subagent` |
| Dispatch several subagents in parallel | several `subagent` calls (or `execute` for a catalog batch) |
| Ask the human a fixed-choice question (`AskUserQuestion`) | `question` |
| Fetch a URL | `webfetch` |
| Search the web | `websearch` |
| Track tasks (the todolist; `TaskCreate` / `TaskUpdate` / `TodoWrite`) | no task tool; keep an uncommitted `todo.md` checklist |

## Subagent policy

poteto-mode sets Claude-specific defaults (`subagent_type: "poteto-agent"`,
`run_in_background: true`). On OpenCode:

- The subagent tool is `subagent`, and it takes an agent ID, a short
  `description`, and a complete `prompt`. Only agents configured with
  `mode: subagent` can be used.
- `background: true` returns immediately and notifies the parent when the child
  finishes; pass the returned `sessionID` to continue the same child.
- The default nesting depth is one. A child cannot itself fan out further.
- `poteto-agent` and `comment-sicko` are installed as subagents. Reference them
  by their agent ID.
- Parallel fan-out is several `subagent` calls, or one `execute` (Code Mode)
  batch when the calls are independent.

## Model names

Skills name Claude defaults (`opus`, `fable`) and Cursor models (`grok`). These
slugs do not resolve on OpenCode. Substitute your configured OpenCode models,
written as `provider/model-id` (for example `anthropic/claude-sonnet-4-5`,
`opencode/gpt-5.1-codex`). Run `opencode models` to list what is available.

For model-diverse panels (`arena`, `architect`, `interrogate`, `how` critics,
`reflect`), pick distinct providers/models so the adversarial signal is real.

## Driver and bundled skills

| Skill or driver named in pstack | On OpenCode |
|---------------------------------|-------------|
| `run` (drive a CLI/TUI to see a change work) | Run the app yourself with `shell` and observe the real output. |
| Project UI driver | Drive the UI with whatever automation you have, or hand the user a concrete manual check. |
| `plugin-dev:skill-development` | Follow the Agent Skills authoring rules: keep `name` + `description` frontmatter and progressive disclosure. |
| `loop` (recurring re-invocation) | OpenCode has no `loop` skill; re-run the step yourself on a cadence. |
| `create-verification-skill` output path | Write the project skill under `.opencode/skills/<name>/SKILL.md`. |

## Instructions file

Where a pstack skill says "your instructions file", on OpenCode that is
`AGENTS.md` (project root, plus `~/.config/opencode/AGENTS.md` global).

## Skills as slash commands

OpenCode exposes a skill as a `/name` command when its frontmatter sets
`metadata: { opencode/slash: "true" }`. `poteto-mode` is set up this way, so it
is available as `/poteto-mode`.
