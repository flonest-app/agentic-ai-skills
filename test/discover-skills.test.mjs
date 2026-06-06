import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSkillsSearchCommand,
  buildSkillsSearchUrl,
  normalizeSkillsSearchResponse,
} from '../runtime/agentic-ai-maintainer/scripts/discover-skills.mjs';

test('builds skills.sh search command', () => {
  assert.deepEqual(buildSkillsSearchCommand('github pr review'), ['npx', 'skills.sh', 'find', 'github pr review']);
});

test('builds skills.sh API search URL', () => {
  assert.equal(
    buildSkillsSearchUrl('github pr review', { apiBase: 'https://skills.sh', limit: 3 }),
    'https://skills.sh/api/search?q=github+pr+review&limit=3',
  );
});

test('normalizes skills.sh API search results for managed installs', () => {
  const result = normalizeSkillsSearchResponse({
    query: 'github pr review',
    searchType: 'semantic',
    skills: [
      {
        id: 'aidankinzett/claude-git-pr-skill/github-pr-review',
        skillId: 'github-pr-review',
        name: 'github-pr-review',
        installs: 74,
        source: 'aidankinzett/claude-git-pr-skill',
      },
    ],
    count: 1,
  });

  assert.deepEqual(result.skills[0], {
    id: 'aidankinzett/claude-git-pr-skill/github-pr-review',
    skill_id: 'github-pr-review',
    name: 'github-pr-review',
    source: 'aidankinzett/claude-git-pr-skill',
    install_spec: 'aidankinzett/claude-git-pr-skill',
    install_skill: 'github-pr-review',
    installs: 74,
    management_mode: 'external-feedback',
  });
});
