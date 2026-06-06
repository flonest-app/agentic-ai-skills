import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  collectProjectFileState,
  diffProjectFileState,
} from '../runtime/agentic-ai-maintainer/scripts/maintainer-daemon.mjs';

test('detects project file changes while ignoring agentic-ai runtime state', () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'agentic-ai-watch-'));
  writeFileSync(join(projectRoot, 'AGENTS.md'), 'one\n');
  mkdirSync(join(projectRoot, '.agentic-ai'), { recursive: true });
  writeFileSync(join(projectRoot, '.agentic-ai/status.json'), '{}\n');

  const before = collectProjectFileState(projectRoot);
  writeFileSync(join(projectRoot, 'AGENTS.md'), 'two\n');
  writeFileSync(join(projectRoot, '.agentic-ai/status.json'), '{"status":"RUNNING"}\n');
  const after = collectProjectFileState(projectRoot);

  assert.deepEqual(diffProjectFileState(before, after), ['AGENTS.md']);
});
