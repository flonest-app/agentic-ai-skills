import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { collectMaintainerContext } from '../runtime/agentic-ai-maintainer/scripts/collect-maintainer-context.mjs';
import { registerManagedSkill } from '../runtime/agentic-ai-maintainer/scripts/managed-registry.mjs';

test('collects focused maintainer context before ad hoc exploration', () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'agentic-ai-context-'));
  const sourceCodexHome = mkdtempSync(join(tmpdir(), 'source-codex-'));
  const cursorPath = join(projectRoot, '.agentic-ai/evidence-cursors.json');

  writeFileSync(join(projectRoot, 'AGENTS.md'), '# Project Agents\n');
  writeFileSync(join(projectRoot, 'GEMINI.md'), '# Gemini guidance\n');
  mkdirSync(join(projectRoot, 'docs'), { recursive: true });
  writeFileSync(join(projectRoot, 'docs/learned.md'), '# Learned\n');

  mkdirSync(join(projectRoot, '.agents/skills/managed'), { recursive: true });
  writeFileSync(join(projectRoot, '.agents/skills/managed/SKILL.md'), '---\nname: managed\ndescription: Managed skill\n---\n');
  mkdirSync(join(projectRoot, '.agents/skills/unmanaged'), { recursive: true });
  writeFileSync(join(projectRoot, '.agents/skills/unmanaged/SKILL.md'), '---\nname: unmanaged\ndescription: User skill\n---\n');

  registerManagedSkill({
    projectRoot,
    skillId: 'managed',
    name: 'Managed',
    skillPath: '.agents/skills/managed',
    source: 'created-local',
  });

  mkdirSync(join(sourceCodexHome, 'sessions/2026/06/07'), { recursive: true });
  writeFileSync(
    join(sourceCodexHome, 'sessions/2026/06/07/rollout-test.jsonl'),
    `${JSON.stringify({ timestamp: '2026-06-07T00:00:00Z', type: 'session_meta', payload: { id: 'thread-1', cwd: projectRoot } })}\n`,
  );

  const context = collectMaintainerContext({ projectRoot, sourceCodexHome, cursorPath, limit: 5 });

  assert.equal(context.project_root, projectRoot);
  assert.equal(context.source_codex_home, sourceCodexHome);
  assert.equal(context.root_agents_md.exists, true);
  assert.equal(context.agent_instruction_files.some((file) => file.relative_path === 'AGENTS.md'), true);
  assert.equal(context.guidance_files.some((file) => file.relative_path === 'GEMINI.md'), true);
  assert.equal(context.guidance_files.some((file) => file.relative_path === 'docs/learned.md'), true);
  assert.equal(context.project_skills.find((skill) => skill.skill_id === 'managed').ownership, 'agentic-ai-managed');
  assert.equal(context.project_skills.find((skill) => skill.skill_id === 'unmanaged').ownership, 'user-owned-unmanaged');
  assert.equal(context.managed_skill_verification.ok, true);
  assert.equal(context.conversation_discovery.candidateCount, 1);
  assert.equal(context.evidence_cursor_path, cursorPath);
  assert.equal(context.conversation_discovery.candidates[0].cursor.previous_line, 0);
  assert.equal(context.conversation_discovery.candidates[0].cursor.next_unread_line, 1);
  assert.match(context.conversation_discovery.candidates[0].cursor.read_command, /read-conversation-slice\.mjs/);
  assert.match(context.next_steps.join('\n'), /write-maintainer-proposal\.mjs/);
  assert.match(context.next_steps.join('\n'), /controller reads the proposal file/);
  assert.match(context.next_steps.join('\n'), /starts at the stored cursor/);
});
