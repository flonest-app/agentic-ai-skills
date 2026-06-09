---
name: agentic-ai-maintainer
description: Full Agentic AI maintainer skill used by the local Codex app-server runtime to improve project AGENTS.md and Flonest-managed skills from durable feedback, failures, repo docs, and sanitized conversation evidence.
---
# Agentic AI Maintainer

Use this skill only from the Agentic AI CLI/appserver runtime. Do not install it into the normal coding agent's project skills.

## Mission

Turn feedback, repeated friction, and observed failures into better future agent behavior without leaking project-private context.

1. Triage the signal as `generic`, `project-specific`, `duplicate`, `unsafe`, or `unclear`.
2. Keep generic reusable lessons as private skill proposal packages for the Flonest private mirror.
3. Keep project-specific rules as `AGENTS.md` patch proposals.
4. Treat conversation discovery as candidate triage, not a mandate to read everything.
5. Distill only durable lessons: user corrections, repeated failures, stable workflow rules, and reusable validation steps.
6. Bring in, create, update, or propose removal of project skills only through the managed-skill registry.

## Mandatory Turn Workflow

Run the deterministic context bootstrap before broad repo exploration or raw transcript reads:

```bash
node runtime/agentic-ai-maintainer/scripts/collect-maintainer-context.mjs --project-root "$PWD" --source-codex-home ~/.codex --cursor-path .agentic-ai/evidence-cursors.json --limit 20
```

In the installed hidden skill, resolve this helper from the skill's `scripts/` directory. The bootstrap output is the map for the turn:

- AGENTS files and repo guidance files
- project `.agents/skills/*` with managed vs unmanaged ownership
- managed-skill registry verification
- git status and root `AGENTS.md` ignore state
- project-relevant source Codex conversation candidates from `~/.codex`

Only after this bootstrap should the maintainer read selected files or conversation ranges. Avoid open-ended `find`, broad `rg`, and app-server logs unless the bootstrap output gives a specific reason.

Evidence order matters:

1. Read unread human/source Codex conversation candidates whose `turn_context.cwd` matches this project first. `turn_context.cwd` is the source of truth; plain text path/name mentions in other projects are noise.
2. Then read relevant project agent instructions and guidance docs.
3. Read product code only after chat/docs show a durable rule, skill install, or managed-skill update need.

The bootstrap helper is the unread inbox for project conversations. On the first read of an exact-cwd source Codex session, read the full unread conversation from top to bottom so short replies like "yes" or "yep" keep their surrounding meaning. The reader emits a semantic transcript: user/developer/assistant messages, tool calls, tool outputs, cwd metadata, and task boundaries. Tool outputs are required evidence because they explain how the coding agent reached a decision. It filters telemetry, duplicate display echoes, and encrypted reasoning placeholders with no readable text. On later turns, use the stored evidence cursor and read only conversation lines that arrived after the previous maintainer read:

```bash
<candidate cursor.read_command from collect-maintainer-context.mjs>
```

The cursor file lives in project `.agentic-ai/evidence-cursors.json`. It records the last JSONL line inspected per source conversation file, so follow-up turns do not replay old human/coding-agent chats. On follow-up turns, treat `AGENTS.md` and registered managed skills as the distilled memory from previous reads; combine that memory only with newly unread source conversation lines.

The controller prompt is intentionally only a one-line goal trigger, such as `Use agentic-ai-maintainer skill: start maintaining this project` or `Use agentic-ai-maintainer skill: continue maintaining this project`. The cwd tells Codex which project is active; the skill body and CLI scripts own discovery, Codex-history handling, schema, and safety. Final assistant text is not trusted for maintenance actions. Write every proposal through `write-maintainer-proposal.mjs` to `$AGENTIC_AI_PROPOSAL_FILE`; `proposal-controller.mjs` then validates that file, rejects unsafe targets, and applies only allowlisted changes.

In watch mode, the controller weighs unread source Codex evidence from exact-cwd sessions against the effective Codex context window. Empty/no-output source turns do not count. A trigger means enough unread source context has settled; do not assume it corresponds to exactly one file edit, one completed turn, or one source thread.

The runtime also writes `.agentic-ai/turn-context.json` before each turn. The bootstrap script reads it automatically so changed files are available even when a provider does not propagate environment variables into shell tools.

Before finishing each turn, validate the script-owned proposal file:

```bash
node runtime/agentic-ai-maintainer/scripts/write-maintainer-proposal.mjs validate --project-root "$PWD"
```

If no durable change is needed, leave the initialized proposal file empty and still validate it.

## Conversation Evidence

The actual coding agent's Codex session history is one of the main sources of project learning. Do not confuse ownership with relevance:

- The user's/source coding agent Codex home owns project session storage under `session_index.jsonl` and `sessions/`.
- That source Codex home is mandatory evidence for project learning because it contains the real human/coding-agent conversations.
- The Agentic AI sidecar's isolated `~/.agentic-ai/codex-home` is operational state for auth and maintainer thread continuity; do not use its chats as project-learning evidence.
- The project `.agentic-ai/logs/` directory and Codex app-server stderr are operational diagnostics, not project-learning evidence. Use them only to diagnose Agentic AI runtime failures.
- Agentic AI owns only the project thread pointer under `thread-ref.json`.
- The maintainer must use source Codex sessions as read-only evidence only when their `turn_context.cwd` matches the project. Text-only mentions of the project path/name are lower-confidence noise and are not part of the core release path.
- Discovery is mandatory triage, not exhaustive reading.

Use the runtime helper to locate project-relevant session artifacts:

```bash
node runtime/agentic-ai-maintainer/scripts/discover-project-conversations.mjs --project-root "$PWD" --limit 20
```

Default evidence sources include project `.conversations/`, exact-cwd sessions from the user's source Codex history at `~/.codex`, and any explicit `--history-root` values. They do not include the Agentic AI sidecar's private Codex home.

## Project-Local Ownership

The runtime maintains a project-local ownership registry:

- Warn the user that project `AGENTS.md` will become agentic-ai-managed before creating or rewriting it.
- If durable project rules belong in root `AGENTS.md`, still propose the `AGENTS.md` patch when that file is absent or ignored by git. The controller applies safe local patches and reports git-ignore warnings; do not edit `.gitignore`.
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

Search the public skills.sh ecosystem first, then check the Flonest skillhub inventory. The discovery helper reads the same skills.sh search API used by the `npx skills find` command and returns structured results for decisions:

```bash
node runtime/agentic-ai-maintainer/scripts/discover-skills.mjs --query "github pr review"
```

Use `--cli` only when a human-facing interactive `npx skills find` search is useful.

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
3. Submit a private skill proposal package to the labserver.
4. Let the private mirror maintainer decide whether to create a Flonest wrapper/adaptation, open an upstream issue/PR, or add the lesson to an existing Flonest skill.

```bash
node runtime/agentic-ai-maintainer/scripts/submit-feedback.mjs --file feedback.md --skill-id <id> --upstream-repo <owner/repo>
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
- Do not emit skillhub feedback for unrelated user/global Codex plugins or skills discovered only through app-server diagnostics. Emit skillhub proposals only for Agentic AI runtime behavior, Flonest skillhub skills, registered agentic-ai-managed project skills, or registered third-party skills.
- Do not encode a specific agent product's history path.
- Do not make transcript discovery exhaustive. Mandatory distillation means mandatory triage and selective inspection.
- Do not modify skills that are absent from the local managed-skill registry.
- Do not remove skills that are absent from the local managed-skill registry.
- Prefer scripts for deterministic checks, signatures, sanitization, and update decisions.
