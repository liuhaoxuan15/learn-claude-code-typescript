# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a **harness engineering** learning project -- teaching how to build the environment (harness) that surrounds an AI agent model. The core philosophy: **the model is the agent; the code is the harness.**

```
Harness = Tools + Knowledge + Observation + Action Interfaces + Permissions
```

## Quick Start

```sh
# Python agents (each is self-contained and runnable)
pip install -r requirements.txt
cp .env.example .env   # add your ANTHROPIC_API_KEY

python agents/s01_agent_loop.py       # Start here
python agents/s12_worktree_task_isolation.py
python agents/s_full.py                # Capstone: all mechanisms combined

# Web platform (interactive visualizations)
cd web && npm install && npm run dev   # http://localhost:3000
```

## Architecture

```
agents/          Python reference implementations (s01-s12 + s_full capstone)
                 Each file is a self-contained teaching session demonstrating
                 one harness mechanism layered on the same agent loop

web/             Next.js interactive learning platform
                 src/components/visualizations/  -- step-through diagrams per session
                 src/components/simulator/      -- interactive agent loop simulator
                 src/components/code/           -- source code viewer with diff
                 src/data/                     -- scenarios, annotations, generated docs
                 src/hooks/                    -- useSimulator, useSteppedVisualization

skills/          SKILL.md files used by s05 (skill loading via tool_result)
docs/{en,zh,ja}/ Mental-model documentation in 3 languages
```

## Core Pattern (the invariant loop)

```python
while True:
    response = client.messages.create(model=MODEL, messages=messages, tools=TOOLS)
    messages.append(response)
    if response.stop_reason != "tool_use":
        return  # agent finished
    for block in response.content:
        if block.type == "tool_use":
            result = TOOL_HANDLERS[block.name](**block.input)
    messages.append({"role": "user", "content": [{"type": "tool_result", ...}]})
```

Every session layers one mechanism onto this loop WITHOUT changing the loop itself:
- **s01**: One tool (bash) + one loop = an agent
- **s02**: Tool dispatch map (name → handler registration)
- **s03**: TodoWrite with nag reminder
- **s04**: Subagents with fresh messages[] per child
- **s05**: On-demand skill loading via tool_result (not system prompt)
- **s06**: Three-layer context compression (microcompact → auto-compact → manual)
- **s07**: File-based task graph with dependencies
- **s08**: Background daemon threads + notification queue
- **s09**: Persistent teammates + JSONL async mailboxes
- **s10**: Shutdown handshake + plan approval FSM
- **s11**: Idle cycle + auto-claim from task board
- **s12**: Worktree isolation per teammate (separate git worktree + directory)

## Web Development

```sh
cd web
npm run extract    # Run content extraction script (predev/prebuild hook)
npm run dev        # Dev server with HMR
npm run build      # Production build
```

The web platform uses **Next.js 16** with App Router, **Tailwind CSS v4**, **framer-motion** for animations, and **unified/remark/rehype** for markdown rendering. It is purely static -- no API routes. The `extract` script processes markdown docs into `src/data/generated/` for the source viewer.

## Environment

- `ANTHROPIC_API_KEY` required for Python agents
- `MODEL_ID` (default: `claude-sonnet-4-6`) -- supports MiniMax, GLM, Kimi, DeepSeek via `ANTHROPIC_BASE_URL`
- `.env` is git-ignored; use `.env.example` as template
