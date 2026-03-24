# Documentation Python → TypeScript Conversion Progress

## Status: IN PROGRESS

## Goal
Convert all Python code blocks in documentation files to TypeScript equivalents.

## Files Summary
- docs/en/: 12 files
- docs/zh/: 12 files
- docs/ja/: 12 files
- **Total: 36 files**

## Progress

### docs/en/ (12 files)
- [x] s01-the-agent-loop.md
- [x] s02-tool-use.md
- [x] s03-todo-write.md
- [x] s04-subagent.md
- [x] s05-skill-loading.md
- [x] s06-context-compact.md
- [x] s07-task-system.md
- [x] s08-background-tasks.md
- [x] s09-agent-teams.md
- [x] s10-team-protocols.md
- [x] s11-autonomous-agents.md
- [x] s12-worktree-task-isolation.md

### docs/zh/ (12 files)
- [x] s01-the-agent-loop.md
- [x] s02-tool-use.md
- [x] s03-todo-write.md
- [x] s04-subagent.md
- [x] s05-skill-loading.md
- [x] s06-context-compact.md
- [x] s07-task-system.md
- [x] s08-background-tasks.md
- [x] s09-agent-teams.md
- [x] s10-team-protocols.md
- [x] s11-autonomous-agents.md
- [x] s12-worktree-task-isolation.md

### docs/ja/ (12 files)
- [x] s01-the-agent-loop.md
- [x] s02-tool-use.md
- [x] s03-todo-write.md
- [x] s04-subagent.md
- [x] s05-skill-loading.md
- [x] s06-context-compact.md
- [x] s07-task-system.md
- [x] s08-background-tasks.md
- [x] s09-agent-teams.md
- [x] s10-team-protocols.md
- [x] s11-autonomous-agents.md
- [x] s12-worktree-task-isolation.md

## Conversion Rules

### Python → TypeScript Patterns
| Python | TypeScript |
|--------|------------|
| `def func(x):` | `function func(x): string` |
| `None` | `null` / `undefined` |
| `True` / `False` | `true` / `false` |
| `some_list.append(x)` | `someList.push(x)` |
| `for item in list:` | `for (const item of list) {` |
| `if condition:` | `if (condition) {` |
| `dict["key"]` | `dict["key"]` or `dict.key` |
| `list[i]` | `list[i]` |
| `print(x)` | `console.log(x)` |
| `os.path.join(a, b)` | `path.join(a, b)` |
| `import os` | `import * as os from "node:os"` |
| `client.messages.create(...)` | Same (Anthropic SDK) |
| `{"role": "user", "content": x}` | Same object literal syntax |
| `messages.append(x)` | `messages.push(x)` |

### Keep as-is (language agnostic or exact match)
- ASCII diagrams (```
+--------+...`` )
- Shell commands (`cd ...`, `python ...`, `npm run ...`)
- Table formats
- Quotes and prose

## Notes
- Start: 2026-03-24
- Completed: 2026-03-24

## Summary
All 36 documentation files (12 sessions × 3 languages) converted from Python to TypeScript code blocks.
