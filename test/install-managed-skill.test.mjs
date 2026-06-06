import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildExternalSkill,
  buildInstallCommand,
  findSkill,
} from '../runtime/agentic-ai-maintainer/scripts/install-managed-skill.mjs';

test('recognizes Flonest skillhub copy installs from inventory', () => {
  const inventory = {
    skills: [
      {
        skill_id: 'github-pr-review',
        path: 'skill-hub/github-pr-review',
        default_project_path: '.agents/skills/github-pr-review',
        install: { type: 'skill-hub-copy' },
      },
    ],
  };

  const skill = findSkill(inventory, 'github-pr-review');
  assert.equal(skill.path, 'skill-hub/github-pr-review');
  assert.equal(skill.install.type, 'skill-hub-copy');
  assert.throws(() => buildInstallCommand(skill), /skill-hub-copy/);
});

test('builds agentic-ai-lite install command from skillhub inventory', () => {
  const inventory = {
    skills: [
      {
        skill_id: 'agentic-ai-lite',
        path: 'skill-hub/agentic-ai-lite',
        default_project_path: '.agents/skills/agentic-ai-lite',
        install: {
          type: 'npx-skills',
          spec: 'flonest-app/agentic-ai-skills',
          agent: 'codex',
          skill: 'agentic-ai-lite',
          copy: true,
          yes: true,
          full_depth: true,
        },
      },
    ],
  };

  assert.deepEqual(buildInstallCommand(findSkill(inventory, 'agentic-ai-lite')), [
    'npx',
    'skills',
    'add',
    'flonest-app/agentic-ai-skills',
    '--agent',
    'codex',
    '--skill',
    'agentic-ai-lite',
    '--copy',
    '--yes',
    '--full-depth',
  ]);
});

test('builds third-party skills CLI install records', () => {
  const skill = buildExternalSkill({
    skillId: 'useful-skill',
    name: 'Useful Skill',
    installSpec: 'someone/useful-skill',
    upstreamRepo: 'someone/useful-skill',
    upstreamSkillId: 'upstream-useful-skill',
  });

  assert.equal(skill.management_mode, 'external-feedback');
  assert.deepEqual(buildInstallCommand(skill), [
    'npx',
    'skills',
    'add',
    'someone/useful-skill',
    '--agent',
    'codex',
    '--skill',
    'upstream-useful-skill',
    '--copy',
    '--yes',
  ]);
});
