# agentic-ai-skills

Public lightweight skill distribution for Agentic AI improvement loops.

Install/update target:

```bash
npx skills add flonest-app/agentic-ai-skills
```

The `agentic-ai-lite` skill helps coding agents:

- Distill durable feedback without reading every transcript.
- Keep generic reusable lessons in public skills.
- Keep project-specific rules in the project `AGENTS.md`.
- Verify signed update manifests before accepting skill updates.
- Submit sanitized feedback for upstream improvement.
- Keep a project-local SQLite inventory of only agentic-ai-managed skills.
- Leave user-installed skills untouched unless they are registered as managed.

## Project-Local Registry

Each consuming project can initialize an agentic-ai inventory:

```bash
node .agents/skills/agentic-ai-lite/scripts/managed-registry.mjs init --project-root "$PWD"
```

The registry lives at `.agentic-ai/registry.sqlite` by default. It records which skills agentic-ai installed, created, or tuned, plus their hashes. This lets agentic-ai improve managed skills while treating all unregistered skills as user-owned.

The public skillhub inventory lives at [registry/skills.json](registry/skills.json). Agentic-ai can use it to find related public skills, install them with `npx skills add`, and then register them in the local inventory.

## Validate

```bash
npm run check
npm test
```
