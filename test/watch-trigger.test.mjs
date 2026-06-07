import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  collectProjectFileState,
  diffProjectFileState,
  mergePendingChangedFiles,
} from '../runtime/agentic-ai-maintainer/scripts/maintainer-daemon.mjs';

test('detects project file changes while ignoring generated and agentic-ai runtime state', () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'agentic-ai-watch-'));
  writeFileSync(join(projectRoot, 'AGENTS.md'), 'one\n');
  mkdirSync(join(projectRoot, '.agentic-ai'), { recursive: true });
  writeFileSync(join(projectRoot, '.agentic-ai/status.json'), '{}\n');
  mkdirSync(join(projectRoot, '__pycache__'), { recursive: true });
  writeFileSync(join(projectRoot, '__pycache__/main.cpython-312.pyc'), 'one\n');
  mkdirSync(join(projectRoot, '.pytest_cache'), { recursive: true });
  writeFileSync(join(projectRoot, '.pytest_cache/nodeid'), 'one\n');

  const before = collectProjectFileState(projectRoot);
  writeFileSync(join(projectRoot, 'AGENTS.md'), 'two\n');
  writeFileSync(join(projectRoot, '.agentic-ai/status.json'), '{"status":"RUNNING"}\n');
  writeFileSync(join(projectRoot, '__pycache__/main.cpython-312.pyc'), 'two\n');
  writeFileSync(join(projectRoot, '.pytest_cache/nodeid'), 'two\n');
  const after = collectProjectFileState(projectRoot);

  assert.deepEqual(diffProjectFileState(before, after), ['AGENTS.md']);
});

test('coalesces active watcher changes and extends settle time on each edit', () => {
  const first = mergePendingChangedFiles(null, ['AGENTS.md'], 1000);
  const second = mergePendingChangedFiles(first, ['src/app.js'], 9000);

  assert.deepEqual(second.files, ['AGENTS.md', 'src/app.js']);
  assert.equal(second.changedAt, 9000);
});
