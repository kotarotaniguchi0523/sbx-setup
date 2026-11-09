# Skill security audit · 2026-11-09T03:25Z

**Version** `pstack-opencode 0.1.0` · upstream `cursor/plugins@c742dd61706f`
**Scanner** APM external scanner — `apm audit --external skillspector` (offline, deterministic)

## APM audit (lock-pinned skill set)

`apm install --frozen` + `apm audit --ci` (10 baseline checks). See the `apm-audit` SARIF in Code Scanning.

## SkillSpector findings

**Baseline** `tools/skillspector-baseline.yaml` (reviewed false positives)

- `apm audit --external` raw exit: 1 (`0` clean, `1` critical, `2` warning, `3` infrastructure)
- Suppressed by baseline: 114 / 125
- Active after baseline: 11 (error 0, warning 5, note 6)
- Effective exit: 2 (`0` clean, `1` critical, `2` warning)

| Level | Rule | Count |
|---|---|---|
| `note` | `apm/hidden-unicode/skillspector/AST7` | 4 |
| `note` | `apm/hidden-unicode/skillspector/SC1` | 2 |
| `warning` | `apm/hidden-unicode/skillspector/AE4` | 1 |
| `warning` | `apm/hidden-unicode/skillspector/AST4` | 1 |
| `warning` | `apm/hidden-unicode/skillspector/EA2` | 1 |
| `warning` | `apm/hidden-unicode/skillspector/EA4` | 1 |
| `warning` | `apm/hidden-unicode/skillspector/RA2` | 1 |

### Details

| Severity | Rule | Location |
|---|---|---|
| warning | apm/hidden-unicode/skillspector/EA2 | automate-me/SKILL.md:57 |
| note | apm/hidden-unicode/skillspector/SC1 | poteto-mode/scripts/package.json:13 |
| note | apm/hidden-unicode/skillspector/SC1 | poteto-mode/scripts/package.json:14 |
| warning | apm/hidden-unicode/skillspector/AST4 | yomiyasu/scripts/yomiyasu_check.py:1437 |
| warning | apm/hidden-unicode/skillspector/EA4 | yomiyasu/scripts/yomiyasu_check.py:4831 |
| warning | apm/hidden-unicode/skillspector/RA2 | yomiyasu/scripts/yomiyasu_check.py:5294 |
| note | apm/hidden-unicode/skillspector/AST7 | yomiyasu/scripts/yomiyasu_check.py:4862 |
| note | apm/hidden-unicode/skillspector/AST7 | yomiyasu/scripts/yomiyasu_check.py:5299 |
| warning | apm/hidden-unicode/skillspector/AE4 | yomiyasu/scripts/yomiyasu_diff.py:1 |
| note | apm/hidden-unicode/skillspector/AST7 | yomiyasu/scripts/yomiyasu_lint.py:3378 |
| note | apm/hidden-unicode/skillspector/AST7 | yomiyasu/scripts/yomiyasu_lint.py:3379 |

## Rules

- Periodic audit is informational: **infrastructure errors only** fail the job (exit 3); active critical/warning are reported.
- Scanner: the APM external-scanner contract (`skillspector scan --format sarif --no-llm`).
- Baseline: `tools/skillspector-baseline.yaml` suppresses reviewed false positives (rule + path glob + optional message).
