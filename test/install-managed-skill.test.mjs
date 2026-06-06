import test from 'node:test';
import assert from 'node:assert/strict';
import { buildInstallCommand, findSkill } from '../skills/agentic-ai-lite/scripts/install-managed-skill.mjs';

test('builds npx skills install command from inventory', () => {
  const inventory = {
    skills: [
      {
        skill_id: 'agentic-ai-lite',
        install: { spec: '<owner>/agentic-ai-skills' },
      },
    ],
  };

  const skill = findSkill(inventory, 'agentic-ai-lite');
  assert.deepEqual(buildInstallCommand(skill), ['npx', 'skills', 'add', '<owner>/agentic-ai-skills']);
});
