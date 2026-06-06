# Agentic AI Skills Instructions

This public repo distributes lightweight skills and scripts for agent improvement loops.

## Boundaries
- Keep public skills generic and reusable across projects.
- Put project-specific rules, local paths, repo names, and workflow quirks in the consuming project's `AGENTS.md`, not in public skills.
- Do not commit raw transcripts, private local paths, secrets, browser profiles, or user-identifying context.
- Keep scripts deterministic, dependency-light, and safe to run in ordinary project workspaces.
- Track only agentic-ai-managed skills in the project-local SQLite registry. User-installed skills are out of scope unless explicitly registered.
- When agentic-ai creates or tunes a skill in a project, register it and route generic improvements upstream as PR, issue, or discussion candidates.

## Validation
- Run `npm run check`.
- Run `npm test`.
- Regenerate `registry/manifest.json` and `registry/manifest.sig` when skill files change.

## Skill Design
- `SKILL.md` should stay light and route deterministic work to scripts.
- Scripts may sanitize feedback, verify manifests, or start local Codex app-server tasks.
- Consumer-side update logic must preserve local edits and propose `AGENTS.md` patches rather than overwriting durable project rules.
