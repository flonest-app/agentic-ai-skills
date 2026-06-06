---
name: agentic-ai-lite
description: Use only when the user asks to install, start, stop, or check the Agentic AI maintainer runtime. This is a tiny bootstrap skill; do not perform maintainer work directly.
---
# Agentic AI Lite

Use this skill only as a launcher for the Agentic AI maintainer runtime.

The normal coding agent must not improve `AGENTS.md`, read conversation history, tune skills, or submit upstream feedback just because this skill is installed. It should only run the public CLI when the user asks.

## Commands

Install Agentic AI for the user:

```bash
npx skills add flonest-app/agentic-ai-skills --skill agentic-ai-lite --full-depth
node .agents/skills/agentic-ai-lite/scripts/install-maintainer.mjs
```

The installer downloads `agentic-ai.tgz` from the latest GitHub Release. Do not direct users to an npm registry package.

After the installer succeeds, tell the user:

Agentic AI installed. Open a terminal at the project root and run `agi`.

Start the maintainer only when the user explicitly asks:

```bash
agi
```

Do not give the user any separate login command or login flag. First-time login is automatic when `agi` starts. The maintainer runs in that terminal until the terminal closes or the user presses Ctrl+C, and logs are shown in the terminal.

When `agi` runs, it may apply safe `AGENTS.md` and registered managed-skill updates. It must never edit unmanaged skills or product code. Public reusable feedback is sanitized and queued in `.agentic-ai/outbox/`; if `AGENTIC_AI_LABSERVER_URL` is configured, it is submitted to the labserver.

## Boundary

- The full maintainer skill is not installed in project `.agents/skills/`.
- The full maintainer skill is not installed in `~/.agents/skills/` or default `~/.codex/skills/`.
- The CLI/appserver uses the public Flonest `skill-hub/` inventory and writes its isolated Codex home under `~/.agentic-ai/codex-home`.
- Project-local state lives under project `.agentic-ai/`.
- The active coding agent should report CLI status and wait for the user's next instruction.
