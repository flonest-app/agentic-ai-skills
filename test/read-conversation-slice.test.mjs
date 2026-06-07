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
