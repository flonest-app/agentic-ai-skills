import { readFileSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  readConversationSlice,
  readEvidenceCursor,
} from '../runtime/agentic-ai-maintainer/scripts/read-conversation-slice.mjs';

test('reads only unread human Codex JSONL lines using a cursor', () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'agentic-ai-slice-project-'));
  const cursorPath = join(projectRoot, '.agentic-ai/evidence-cursors.json');
  const jsonlPath = join(projectRoot, 'human-codex.jsonl');

  writeFileSync(jsonlPath, [
    JSON.stringify({ timestamp: '2026-06-07T00:00:00Z', type: 'session_meta', payload: { id: 'thread-1', cwd: projectRoot } }),
    JSON.stringify({ timestamp: '2026-06-07T00:00:01Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'First correction' }] } }),
    JSON.stringify({ timestamp: '2026-06-07T00:00:02Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'First fix' }] } }),
    '',
  ].join('\n'));

  const first = readConversationSlice({
    projectRoot,
    cursorPath,
    filePath: jsonlPath,
    maxLines: 2,
    markRead: true,
  });

  assert.equal(first.previous_cursor_line, 0);
  assert.equal(first.emitted_from_line, 1);
  assert.equal(first.emitted_through_line, 2);
  assert.equal(first.remaining_line_count, 1);
  assert.equal(first.events.length, 2);
  assert.equal(readEvidenceCursor(cursorPath).files[jsonlPath].line, 2);

  writeFileSync(jsonlPath, `${readFileSync(jsonlPath, 'utf8')}${JSON.stringify({ timestamp: '2026-06-07T00:00:03Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Second correction' }] } })}\n`);

  const second = readConversationSlice({
    projectRoot,
    cursorPath,
    filePath: jsonlPath,
    maxLines: 10,
    markRead: true,
  });

  assert.equal(second.previous_cursor_line, 2);
  assert.equal(second.emitted_from_line, 3);
  assert.equal(second.emitted_through_line, 4);
  assert.equal(second.events.map((event) => event.text).join('\n').includes('First correction'), false);
  assert.equal(second.events.map((event) => event.text).join('\n').includes('Second correction'), true);
  assert.equal(readEvidenceCursor(cursorPath).files[jsonlPath].line, 4);
});

test('keeps tool calls and outputs while filtering telemetry and duplicate display messages', () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'agentic-ai-slice-semantic-'));
  const cursorPath = join(projectRoot, '.agentic-ai/evidence-cursors.json');
  const jsonlPath = join(projectRoot, 'source-codex.jsonl');

  writeFileSync(jsonlPath, [
    JSON.stringify({ timestamp: '2026-06-07T00:00:00Z', type: 'session_meta', payload: { id: 'thread-1', cwd: projectRoot } }),
    JSON.stringify({ timestamp: '2026-06-07T00:00:01Z', type: 'turn_context', payload: { turn_id: 'turn-1', cwd: projectRoot } }),
    JSON.stringify({ timestamp: '2026-06-07T00:00:02Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Check payroll behavior' }] } }),
    JSON.stringify({ timestamp: '2026-06-07T00:00:02Z', type: 'event_msg', payload: { type: 'user_message', message: 'Check payroll behavior' } }),
    JSON.stringify({ timestamp: '2026-06-07T00:00:03Z', type: 'response_item', payload: { type: 'reasoning', summary: [], encrypted_content: 'opaque' } }),
    JSON.stringify({ timestamp: '2026-06-07T00:00:04Z', type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: 'call-1', arguments: '{"cmd":"rg payroll","workdir":"/tmp/project"}' } }),
    JSON.stringify({ timestamp: '2026-06-07T00:00:05Z', type: 'response_item', payload: { type: 'function_call_output', call_id: 'call-1', output: 'payroll_item_days not found' } }),
    JSON.stringify({ timestamp: '2026-06-07T00:00:06Z', type: 'event_msg', payload: { type: 'agent_message', message: 'The ledger table is missing.' } }),
    JSON.stringify({ timestamp: '2026-06-07T00:00:06Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'The ledger table is missing.' }] } }),
    JSON.stringify({ timestamp: '2026-06-07T00:00:07Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { total_tokens: 100 } } } }),
    JSON.stringify({ timestamp: '2026-06-07T00:00:08Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-1' } }),
    '',
  ].join('\n'));

  const result = readConversationSlice({
    projectRoot,
    cursorPath,
    filePath: jsonlPath,
    maxLines: 20,
    markRead: true,
  });

  assert.deepEqual(result.events.map((event) => event.semantic_kind), [
    'session_metadata',
    'turn_context',
    'message:user',
    'tool_call:exec_command',
    'tool_output',
    'message:assistant',
    'task_complete',
  ]);
  assert.equal(result.events.some((event) => event.item_type === 'token_count'), false);
  assert.equal(result.events.some((event) => event.item_type === 'reasoning'), false);
  assert.equal(result.events.find((event) => event.semantic_kind === 'tool_output').text, 'payroll_item_days not found');
  assert.equal(result.events.filter((event) => event.text === 'Check payroll behavior').length, 1);
  assert.equal(result.events.filter((event) => event.text === 'The ledger table is missing.').length, 1);
  assert.equal(readEvidenceCursor(cursorPath).files[jsonlPath].line, 11);
});
