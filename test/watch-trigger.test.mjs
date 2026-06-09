import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  collectProjectFileState,
  collectSourceCodexTurnState,
  countNewSourceCodexTurns,
  diffProjectFileState,
  mergePendingChangedFiles,
  sourceCodexActivityChanged,
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

test('detects completed source Codex turns for a project cwd', () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'agentic-ai-watch-project-'));
  const sourceCodexHome = mkdtempSync(join(tmpdir(), 'agentic-ai-watch-source-codex-'));
  const sessionDir = join(sourceCodexHome, 'sessions/2026/06/07');
  mkdirSync(sessionDir, { recursive: true });
  const sessionPath = join(sessionDir, 'rollout-watch.jsonl');
  writeFileSync(sessionPath, [
    JSON.stringify({ timestamp: '2026-06-07T00:00:00Z', type: 'turn_context', payload: { turn_id: 'turn-1', cwd: projectRoot } }),
    JSON.stringify({ timestamp: '2026-06-07T00:00:02Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-1' } }),
    '',
  ].join('\n'));

  const before = collectSourceCodexTurnState({ projectRoot, sourceCodexHome });
  writeFileSync(sessionPath, [
    JSON.stringify({ timestamp: '2026-06-07T00:00:00Z', type: 'turn_context', payload: { turn_id: 'turn-1', cwd: projectRoot } }),
    JSON.stringify({ timestamp: '2026-06-07T00:00:02Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-1' } }),
    JSON.stringify({ timestamp: '2026-06-07T00:00:03Z', type: 'turn_context', payload: { turn_id: 'turn-2', cwd: projectRoot } }),
    JSON.stringify({ timestamp: '2026-06-07T00:00:05Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-2' } }),
    '',
  ].join('\n'));
  const after = collectSourceCodexTurnState({ projectRoot, sourceCodexHome });

  assert.equal(before.sessionCount, 1);
  assert.equal(before.turnCount, 1);
  assert.equal(after.turnCount, 2);
  assert.equal(countNewSourceCodexTurns(before, after), 1);
  assert.equal(sourceCodexActivityChanged(before, after), true);
});

test('counts source Codex turns across multiple threads for the same cwd', () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'agentic-ai-watch-project-'));
  const sourceCodexHome = mkdtempSync(join(tmpdir(), 'agentic-ai-watch-source-codex-'));
  const sessionDir = join(sourceCodexHome, 'sessions/2026/06/07');
  mkdirSync(sessionDir, { recursive: true });

  writeFileSync(join(sessionDir, 'rollout-thread-a.jsonl'), [
    JSON.stringify({ timestamp: '2026-06-07T00:00:00Z', type: 'turn_context', payload: { turn_id: 'a1', cwd: projectRoot } }),
    JSON.stringify({ timestamp: '2026-06-07T00:00:01Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'a1' } }),
    '',
  ].join('\n'));
  const before = collectSourceCodexTurnState({ projectRoot, sourceCodexHome });

  writeFileSync(join(sessionDir, 'rollout-thread-b.jsonl'), [
    JSON.stringify({ timestamp: '2026-06-07T00:01:00Z', type: 'turn_context', payload: { turn_id: 'b1', cwd: projectRoot } }),
    JSON.stringify({ timestamp: '2026-06-07T00:01:01Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'b1' } }),
    JSON.stringify({ timestamp: '2026-06-07T00:02:00Z', type: 'turn_context', payload: { turn_id: 'b2', cwd: projectRoot } }),
    JSON.stringify({ timestamp: '2026-06-07T00:02:01Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'b2' } }),
    '',
  ].join('\n'));
  const after = collectSourceCodexTurnState({ projectRoot, sourceCodexHome });

  assert.equal(before.turnCount, 1);
  assert.equal(after.sessionCount, 2);
  assert.equal(after.turnCount, 3);
  assert.equal(countNewSourceCodexTurns(before, after), 2);
});

test('ignores completed source Codex turns from another cwd that mention the project', () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'agentic-ai-watch-project-'));
  const otherRoot = mkdtempSync(join(tmpdir(), 'agentic-ai-watch-other-'));
  const sourceCodexHome = mkdtempSync(join(tmpdir(), 'agentic-ai-watch-source-codex-'));
  const sessionDir = join(sourceCodexHome, 'sessions/2026/06/07');
  mkdirSync(sessionDir, { recursive: true });

  writeFileSync(join(sessionDir, 'rollout-noisy.jsonl'), [
    JSON.stringify({ timestamp: '2026-06-07T00:00:00Z', type: 'turn_context', payload: { turn_id: 'other-1', cwd: otherRoot } }),
    JSON.stringify({ timestamp: '2026-06-07T00:00:01Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `Please inspect ${projectRoot} AGENTS.md.` }] } }),
    JSON.stringify({ timestamp: '2026-06-07T00:00:02Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'other-1' } }),
    '',
  ].join('\n'));

  const state = collectSourceCodexTurnState({ projectRoot, sourceCodexHome });

  assert.equal(state.sessionCount, 0);
  assert.equal(state.turnCount, 0);
});
