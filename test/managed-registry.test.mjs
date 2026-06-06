import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  initRegistry,
  registerManagedSkill,
  recordTunedSkill,
  verifyManagedSkills,
  listManagedSkills,
} from '../runtime/agentic-ai-maintainer/scripts/managed-registry.mjs';

test('tracks only agentic-ai-managed skills in SQLite', () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'agentic-ai-project-'));
  const skillDir = join(projectRoot, '.agents/skills/demo-skill');
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: demo-skill\ndescription: demo\n---\n');

  const init = initRegistry({ projectRoot });
  assert.match(init.warning, /AGENTS\.md is agentic-ai-managed/);

  const registered = registerManagedSkill({
    projectRoot,
    skillId: 'demo-skill',
    name: 'Demo Skill',
    skillPath: '.agents/skills/demo-skill',
    source: 'created-local',
  });

  assert.equal(registered.skill_id, 'demo-skill');
  assert.equal(registered.management_mode, 'flonest-owned');
  assert.equal(listManagedSkills({ projectRoot }).length, 1);
  assert.equal(verifyManagedSkills({ projectRoot }).ok, true);

  writeFileSync(join(skillDir, 'NOTE.md'), 'local tune\n');
  const tuned = recordTunedSkill({ projectRoot, skillId: 'demo-skill' });
  assert.equal(tuned.status, 'locally_tuned');
  assert.equal(verifyManagedSkills({ projectRoot }).ok, true);
});

test('registers third-party skills as external feedback managed', () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'agentic-ai-project-'));
  const skillDir = join(projectRoot, '.agents/skills/third-party');
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: third-party\ndescription: demo\n---\n');

  const registered = registerManagedSkill({
    projectRoot,
    skillId: 'third-party',
    name: 'Third Party',
    skillPath: '.agents/skills/third-party',
    source: 'installed-skills-sh',
    managementMode: 'external-feedback',
    upstreamRepo: 'someone/useful-skill',
    upstreamSkillId: 'useful-skill',
    installSpec: 'someone/useful-skill',
  });

  assert.equal(registered.management_mode, 'external-feedback');
  assert.equal(registered.upstream_repo, 'someone/useful-skill');
});
