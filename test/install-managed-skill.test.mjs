import test from 'node:test';
import assert from 'node:assert/strict';
import { buildInstallCommand, buildExternalSkill, findSkill } from '../skills/agentic-ai-lite/scripts/install-managed-skill.mjs';

test('builds npx skills install command from inventory', () => {
  const inventory = {
    skills: [
      {
        skill_id: 'agentic-ai-lite',
        install: { spec: 'flonest-app/agentic-ai-skills' },
      },
    ],
  };

  const skill = findSkill(inventory, 'agentic-ai-lite');
  assert.deepEqual(buildInstallCommand(skill), ['npx', 'skills', 'add', 'flonest-app/agentic-ai-skills']);
});

test('builds third-party skills.sh install records', () => {
  const skill = buildExternalSkill({
    skillId: 'useful-skill',
    name: 'Useful Skill',
    installSpec: 'someone/useful-skill',
    upstreamRepo: 'someone/useful-skill',
  });

  assert.equal(skill.management_mode, 'external-feedback');
  assert.deepEqual(buildInstallCommand(skill), ['npx', 'skills', 'add', 'someone/useful-skill']);
});
