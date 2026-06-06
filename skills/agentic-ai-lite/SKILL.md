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

## Project-Local Ownership

This skill is installed per project repo. When activated as the meta agentic-ai layer:

- Warn the user that project `AGENTS.md` will become agentic-ai-managed before creating or rewriting it.
- Never touch user-installed skills unless they are registered in the local agentic-ai managed-skill inventory.
- Register every skill that agentic-ai installs, creates, or tunes.
- Use the registry to verify managed skill integrity and detect local tuning drift.
- Treat unmanaged skills as user-owned.
- Treat registered third-party skills as Flonest-managed for feedback and improvement routing, even when Flonest does not own the upstream source.

Initialize or inspect the project-local inventory:

```bash
node skills/agentic-ai-lite/scripts/managed-registry.mjs init --project-root "$PWD"
node skills/agentic-ai-lite/scripts/managed-registry.mjs list --project-root "$PWD"
node skills/agentic-ai-lite/scripts/managed-registry.mjs verify --project-root "$PWD"
```

When agentic-ai creates a new local skill, register it:

```bash
node skills/agentic-ai-lite/scripts/managed-registry.mjs register --project-root "$PWD" --skill-id <id> --name <name> --path .agents/skills/<id> --source created-local
```

When agentic-ai tunes an installed public skill locally, record the drift and send sanitized feedback upstream as a PR candidate, issue, or discussion. The public skillhub evolves from these generic-safe changes; local project-specific edits stay in `AGENTS.md`.

## Installing Related Skills

Search the public skills.sh ecosystem first, then check the Flonest skillhub inventory. Install the best related skill with `npx skills`, then register it as managed:

```bash
node skills/agentic-ai-lite/scripts/discover-skills.mjs --query "github pr review"
```

For a Flonest skillhub skill:

```bash
node skills/agentic-ai-lite/scripts/install-managed-skill.mjs --project-root "$PWD" --skill-id agentic-ai-lite
```

For a third-party skills.sh result:

```bash
node skills/agentic-ai-lite/scripts/install-managed-skill.mjs --project-root "$PWD" --skill-id <local-id> --install-spec <owner-or-org>/<repo-or-skill> --name "<display name>" --upstream-repo <owner-or-org>/<repo-or-skill> --management-mode external-feedback
```

The installer prints the `npx skills add ...` command by default. Add `--execute` only when the active agent should actually install the skill in the current project.

## Third-Party Skill Feedback

If feedback relates to a third-party skill, do not drop it as "not ours." The consumer agent has the richest context from the user, repo, tools, failures, and conversation. Capture that context safely and route it through Flonest:

1. Register the third-party skill locally with `management_mode = external-feedback`.
2. Record local tuning with `managed-registry.mjs record-tuned`.
3. Submit sanitized feedback to `flonest-app/agentic-ai-skills` as an issue or PR candidate.
4. Let the server agent decide whether to create a Flonest wrapper/adaptation, open an upstream issue/PR, or add the lesson to an existing Flonest skill.

```bash
node skills/agentic-ai-lite/scripts/submit-feedback.mjs --file feedback.md --skill-id <id> --upstream-repo <owner/repo> --create-issue
```

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
- Do not modify skills that are absent from the local managed-skill registry.
- Prefer scripts for deterministic checks, signatures, sanitization, and update decisions.
