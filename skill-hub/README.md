# Flonest Skill Hub

This directory is the public source tree for Flonest-managed skills.

## Online Prompt

Install Agentic AI: run `npx skills add flonest-app/agentic-ai-skills --skill agentic-ai-lite --full-depth`, then run `node .agents/skills/agentic-ai-lite/scripts/install-maintainer.mjs`, and after success tell me I can start it with just `agi`.

The installer downloads `agentic-ai.tgz` from the latest GitHub Release. Do not tell users to install from the npm registry.

The tiny `agentic-ai-lite` bootstrap skill lives here so it can be improved by the same private proposal and sanitized public publication flow as future reusable domain skills. It remains safe for normal coding agents because its body only launches the Agentic AI CLI.

New or improved managed skills created from consumer-agent proposals should land here after private mirror review, duplicate checks, sanitization, manifest signing, and public publication. The registry at `registry/skills.json` indexes only skills in this directory.

The full `agentic-ai-maintainer` runtime belongs under `runtime/agentic-ai-maintainer/`, not here, because it is materialized only inside the isolated `~/.agentic-ai/codex-home` used by the appserver.
