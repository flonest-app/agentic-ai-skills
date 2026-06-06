---
name: agentic-ai-maintainer
description: Full Agentic AI maintainer skill used by the local Codex app-server runtime to improve project AGENTS.md and Flonest-managed skills from durable feedback, failures, repo docs, and sanitized conversation evidence.
---
# Agentic AI Maintainer

Use this skill only from the Agentic AI CLI/appserver runtime. Do not install it into the normal coding agent's project skills.

## Mission

Turn feedback, repeated friction, and observed failures into better future agent behavior without leaking project-private context.

1. Triage the signal as `generic`, `project-specific`, `duplicate`, `unsafe`, or `unclear`.
2. Keep generic reusable lessons as sanitized public skillhub proposals.
3. Keep project-specific rules as `AGENTS.md` patch proposals.
4. Treat conversation discovery as candidate triage, not a mandate to read everything.
5. Distill only durable lessons: user corrections, repeated failures, stable workflow rules, and reusable validation steps.
6. Bring in, create, update, or propose removal of project skills only through the managed-skill registry.

## Conversation Evidence

The actual coding agent's Codex session history is one of the main sources of project learning. Do not confuse ownership with relevance:

- The user's/source coding agent Codex home owns project session storage under `session_index.jsonl` and `sessions/`.
- The Agentic AI sidecar's isolated `~/.agentic-ai/codex-home` is operational state for auth and maintainer thread continuity; do not use its chats as project-learning evidence.
- Agentic AI owns only the project thread pointer under `thread-ref.json`.
- The maintainer must still use Codex sessions as read-only evidence when they mention the project root, project name, files, `AGENTS.md`, or managed skills.
- Discovery is mandatory triage, not exhaustive reading.

Use the runtime helper to locate project-relevant session artifacts:

```bash
node runtime/agentic-ai-maintainer/scripts/discover-project-conversations.mjs --project-root "$PWD" --limit 20
```

Default evidence sources include project `.conversations/`, the user's source Codex history at `~/.codex`, and any explicit `--history-root` values. They do not include the Agentic AI sidecar's private Codex home.

## Project-Local Ownership

The runtime maintains a project-local ownership registry:

- Warn the user that project `AGENTS.md` will become agentic-ai-managed before creating or rewriting it.
- Never touch user-installed skills unless they are registered in the local agentic-ai managed-skill inventory.
- Register every skill that agentic-ai installs, creates, or tunes.
- Use the registry to verify managed skill integrity and detect local tuning drift.
- Treat unmanaged skills as user-owned.
- Treat registered third-party skills as Flonest-managed for feedback and improvement routing, even when Flonest does not own the upstream source.
- Propose removal only for registered managed skills that are stale, unused, broken, or superseded; never delete unmanaged skills.

## Project Threading

Use one durable appserver thread per project root. Codex stores the maintainer sidecar's own appserver thread records under the isolated runtime Codex home for auth and continuity only:

```text
$HOME/.agentic-ai/codex-home/session_index.jsonl
$HOME/.agentic-ai/codex-home/sessions/
```

Agentic AI keeps only a lightweight project-to-thread pointer:

```text
$HOME/.agentic-ai/projects/<project-id>/thread-ref.json
```

The controller sends a maintainer message, not necessarily a literal user query. The first message creates the project thread; later messages reuse the stored `thread_id` as follow-ups. Different project roots get different Codex threads and may run in parallel.

Connect each turn to:

- the project repo path
- Codex session evidence discovered from the configured conversation evidence sources
- the attached conversation file, when provided
- the project `AGENTS.md`
- registered managed skills under `.agents/skills/`

Do not treat unmanaged `.agents/skills/` entries as editable.

## Runtime Layout

The CLI/appserver creates project `.agentic-ai/` for status, logs, registry, patch proposals, and sanitized outbox only. Its Codex auth, Codex-generated sessions, project thread pointers, and hidden runtime copy of this skill live in:

```text
$HOME/.agentic-ai/
  projects/<project-id>/thread-ref.json
  codex-home/
    session_index.jsonl
    sessions/
    skills/agentic-ai-maintainer/SKILL.md
```

Allowed project write targets are:

- `AGENTS.md`
- `.agentic-ai/`
- registered managed skills under `.agents/skills/<id>/`

Everything else in the project is read-only for this workflow.

## Installing Related Skills

Search the public skills.sh ecosystem first, then check the Flonest skillhub inventory. The discovery helper reads the same `skills.sh` search API used by the `npx skills.sh find` command and returns structured results for decisions:

```bash
node runtime/agentic-ai-maintainer/scripts/discover-skills.mjs --query "github pr review"
```

Use `--cli` only when a human-facing interactive `npx skills.sh find` search is useful.

Do not copy this `agentic-ai-maintainer` runtime skill into project `.agents/skills/`. The CLI mirrors it into `~/.agentic-ai/codex-home` for the appserver.

For future Flonest skillhub domain skills listed in `registry/skills.json`, copy the skill from `skill-hub/` into the project and register it:

```bash
node runtime/agentic-ai-maintainer/scripts/install-managed-skill.mjs --project-root "$PWD" --skill-id <flonest-domain-skill-id>
```

For a third-party skills.sh result:

```bash
node runtime/agentic-ai-maintainer/scripts/install-managed-skill.mjs --project-root "$PWD" --skill-id <local-id> --install-spec <owner-or-org>/<repo> --upstream-skill-id <skills-sh-skill-id> --name "<display name>" --upstream-repo <owner-or-org>/<repo> --management-mode external-feedback
```

The installer prints the action by default. Add `--execute` only when the runtime should actually install and register the skill.

## Third-Party Skill Feedback

If feedback relates to a third-party skill, do not drop it as "not ours." Capture context safely and route it through Flonest:

1. Register the third-party skill locally with `management_mode = external-feedback`.
2. Record local tuning with `managed-registry.mjs record-tuned`.
3. Submit sanitized feedback to `flonest-app/agentic-ai-skills` as an issue or PR candidate.
4. Let the server agent decide whether to create a Flonest wrapper/adaptation, open an upstream issue/PR, or add the lesson to an existing Flonest skill.

```bash
node runtime/agentic-ai-maintainer/scripts/submit-feedback.mjs --file feedback.md --skill-id <id> --upstream-repo <owner/repo> --create-issue
```

## Update Safety

Before accepting upstream skillhub updates, verify the signed manifest:

```bash
node runtime/agentic-ai-maintainer/scripts/check-updates.mjs --installed-skill skill-hub
```

If a local skill edit exists, preserve it:

- generic local edits become upstream feedback candidates
- project-specific local edits become proposed `AGENTS.md` patches
- raw transcripts, secrets, private paths, and repo names are rejected

Never overwrite `AGENTS.md`. Propose a patch and let the user or supervising task accept it.

## Public Skill Boundaries

- Do not include project-specific commands, repo paths, private architecture, or one-off chat detail in public skillhub updates.
- Do not include raw transcripts or screenshots.
- Do not encode a specific agent product's history path.
- Do not make transcript discovery exhaustive. Mandatory distillation means mandatory triage and selective inspection.
- Do not modify skills that are absent from the local managed-skill registry.
- Do not remove skills that are absent from the local managed-skill registry.
- Prefer scripts for deterministic checks, signatures, sanitization, and update decisions.
