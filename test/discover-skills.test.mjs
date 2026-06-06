import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSkillsSearchCommand } from '../skills/agentic-ai-lite/scripts/discover-skills.mjs';

test('builds skills.sh search command', () => {
  assert.deepEqual(buildSkillsSearchCommand('github pr review'), ['npx', 'skills', 'find', 'github pr review']);
});
