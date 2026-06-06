---
name: agentic-ai-lite
description: Use when an agent needs to improve durable agent instructions from human feedback, failures, or repo experience while keeping generic reusable learning separate from project-specific AGENTS.md rules.
---
# Agentic AI Lite

Use this skill to turn feedback, repeated friction, and observed failures into better future agent behavior without leaking project-private context.

## Core Loop

1. Triage the signal as `generic`, `project-specific`, `duplicate`, `unsafe`, or `unclear`.
2. Keep generic reusable lessons in the skill ecosystem.
3. Keep project-specific rules in the consuming project's `AGENTS.md`.
4. Treat transcript discovery as candidate triage, not a mandate to read everything.
5. Distill only durable lessons: user corrections, repeated failures, stable workflow rules, and reusable validation steps.

## Update Safety

Before accepting upstream skill updates, verify the signed manifest:

```bash
node skills/agentic-ai-lite/scripts/check-updates.mjs --installed-skill skills/agentic-ai-lite
```

If a local skill edit exists, preserve it:

- generic local edits become upstream feedback candidates
- project-specific local edits become proposed `AGENTS.md` patches
- raw transcripts, secrets, private paths, and repo names are rejected

Never overwrite `AGENTS.md`. Propose a patch and let the active agent apply it only when the user or task calls for persistent project rules.

## Feedback Submission

Sanitize feedback before sending it upstream:

```bash
node skills/agentic-ai-lite/scripts/submit-feedback.mjs --file feedback.md
```

The sanitizer strips secret-like values, absolute local paths, raw transcript blocks, and explicit repo names passed with `--repo-name`.

## Codex App-Server Task

When a consumer agent needs a local Codex task with the user's own auth, use:

```bash
node skills/agentic-ai-lite/scripts/appserver-task.mjs --cwd "$PWD" --prompt "Classify this feedback for durable agent learning."
```

This uses `codex app-server` over `stdio`; it does not expose a websocket listener.

## Public Skill Boundaries

- Do not include project-specific commands, repo paths, private architecture, or one-off chat detail.
- Do not include raw transcripts or screenshots.
- Do not encode a specific agent product's history path.
- Do not make transcript discovery exhaustive. Mandatory distillation means mandatory triage and selective inspection.
- Prefer scripts for deterministic checks, signatures, sanitization, and update decisions.
