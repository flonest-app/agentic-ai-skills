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
    JSON.stringify({ timestamp: '2026-06-07T00:00:01Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Updated the project.' }] } }),
    JSON.stringify({ timestamp: '2026-06-07T00:00:02Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-1' } }),
    '',
  ].join('\n'));

  const before = collectSourceCodexTurnState({ projectRoot, sourceCodexHome });
  writeFileSync(sessionPath, [
    JSON.stringify({ timestamp: '2026-06-07T00:00:00Z', type: 'turn_context', payload: { turn_id: 'turn-1', cwd: projectRoot } }),
    JSON.stringify({ timestamp: '2026-06-07T00:00:01Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Updated the project.' }] } }),
    JSON.stringify({ timestamp: '2026-06-07T00:00:02Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-1' } }),
    JSON.stringify({ timestamp: '2026-06-07T00:00:03Z', type: 'turn_context', payload: { turn_id: 'turn-2', cwd: projectRoot } }),
    JSON.stringify({ timestamp: '2026-06-07T00:00:04Z', type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: 'call-1', arguments: '{"cmd":"npm test"}' } }),
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
    JSON.stringify({ timestamp: '2026-06-07T00:00:00Z', type: 'event_msg', payload: { type: 'agent_message', message: 'I changed the repo.' } }),
    JSON.stringify({ timestamp: '2026-06-07T00:00:01Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'a1' } }),
    '',
  ].join('\n'));
  const before = collectSourceCodexTurnState({ projectRoot, sourceCodexHome });

  writeFileSync(join(sessionDir, 'rollout-thread-b.jsonl'), [
    JSON.stringify({ timestamp: '2026-06-07T00:01:00Z', type: 'turn_context', payload: { turn_id: 'b1', cwd: projectRoot } }),
    JSON.stringify({ timestamp: '2026-06-07T00:01:00Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'First followup.' }] } }),
    JSON.stringify({ timestamp: '2026-06-07T00:01:01Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'b1' } }),
    JSON.stringify({ timestamp: '2026-06-07T00:02:00Z', type: 'turn_context', payload: { turn_id: 'b2', cwd: projectRoot } }),
    JSON.stringify({ timestamp: '2026-06-07T00:02:00Z', type: 'response_item', payload: { type: 'function_call_output', call_id: 'call-1', output: 'Tests passed.' } }),
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

test('ignores source Codex turns that complete with no assistant or tool activity', () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'agentic-ai-watch-project-'));
  const sourceCodexHome = mkdtempSync(join(tmpdir(), 'agentic-ai-watch-source-codex-'));
  const sessionDir = join(sourceCodexHome, 'sessions/2026/06/09');
  mkdirSync(sessionDir, { recursive: true });

  writeFileSync(join(sessionDir, 'rollout-empty-hi.jsonl'), [
    JSON.stringify({ timestamp: '2026-06-09T10:55:39Z', type: 'session_meta', payload: { id: 'thread-empty', cwd: projectRoot } }),
    JSON.stringify({ timestamp: '2026-06-09T10:55:40Z', type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'System context' }] } }),
    JSON.stringify({ timestamp: '2026-06-09T10:55:41Z', type: 'turn_context', payload: { turn_id: 'turn-empty', cwd: projectRoot } }),
    JSON.stringify({ timestamp: '2026-06-09T10:55:42Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] } }),
    JSON.stringify({ timestamp: '2026-06-09T10:55:43Z', type: 'event_msg', payload: { type: 'user_message', message: 'hi' } }),
    JSON.stringify({ timestamp: '2026-06-09T10:55:45Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-empty', last_agent_message: null } }),
    '',
  ].join('\n'));

  const state = collectSourceCodexTurnState({ projectRoot, sourceCodexHome });

  assert.equal(state.sessionCount, 1);
  assert.equal(state.turnCount, 0);
  assert.deepEqual(state.turnIds, []);
});

test('weights unread source Codex context by percent and evidence cursor', () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'agentic-ai-watch-project-'));
  const sourceCodexHome = mkdtempSync(join(tmpdir(), 'agentic-ai-watch-source-codex-'));
  const sessionDir = join(sourceCodexHome, 'sessions/2026/06/09');
  mkdirSync(sessionDir, { recursive: true });
  const sessionPath = join(sessionDir, 'rollout-context-heavy.jsonl');
  const longUserContext = 'Durable project lesson. '.repeat(80);

  writeFileSync(sessionPath, [
    JSON.stringify({ timestamp: '2026-06-09T11:00:00Z', type: 'turn_context', payload: { turn_id: 'turn-heavy', cwd: projectRoot } }),
    JSON.stringify({ timestamp: '2026-06-09T11:00:01Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: longUserContext }] } }),
    JSON.stringify({ timestamp: '2026-06-09T11:00:02Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'I applied that lesson.' }] } }),
    JSON.stringify({ timestamp: '2026-06-09T11:00:03Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-heavy' } }),
    '',
  ].join('\n'));

  const unread = collectSourceCodexTurnState({
    projectRoot,
    sourceCodexHome,
    sourceContextWindowTokens: 100,
  });

  assert.equal(unread.turnCount, 1);
  assert.equal(unread.unreadTurnCount, 1);
  assert.equal(unread.unreadContextPercent, 100);

  mkdirSync(join(projectRoot, '.agentic-ai'), { recursive: true });
  writeFileSync(join(projectRoot, '.agentic-ai/evidence-cursors.json'), JSON.stringify({
    schema_version: 1,
    files: {
      [sessionPath]: {
        line: 4,
        bytes: 1,
        updated_at: '2026-06-09T11:00:04Z',
      },
    },
  }, null, 2));

  const read = collectSourceCodexTurnState({
    projectRoot,
    sourceCodexHome,
    sourceContextWindowTokens: 100,
  });

  assert.equal(read.turnCount, 1);
  assert.equal(read.unreadTurnCount, 0);
  assert.equal(read.unreadContextPercent, 0);
});

test('uses source Codex token-count context percent when available', () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'agentic-ai-watch-project-'));
  const sourceCodexHome = mkdtempSync(join(tmpdir(), 'agentic-ai-watch-source-codex-'));
  const sessionDir = join(sourceCodexHome, 'sessions/2026/06/09');
  mkdirSync(sessionDir, { recursive: true });

  writeFileSync(join(sessionDir, 'rollout-token-context.jsonl'), [
    JSON.stringify({ timestamp: '2026-06-09T11:00:00Z', type: 'turn_context', payload: { turn_id: 'turn-token', cwd: projectRoot } }),
    JSON.stringify({ timestamp: '2026-06-09T11:00:01Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'I worked on this project.' }] } }),
    JSON.stringify({
      timestamp: '2026-06-09T11:00:02Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          last_token_usage: { total_tokens: 60 },
          model_context_window: 100,
        },
      },
    }),
    JSON.stringify({ timestamp: '2026-06-09T11:00:03Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-token' } }),
    '',
  ].join('\n'));

  const state = collectSourceCodexTurnState({ projectRoot, sourceCodexHome });

  assert.equal(state.turnCount, 1);
  assert.equal(state.unreadTurnCount, 1);
  assert.equal(state.unreadContextPercent, 60);
});
