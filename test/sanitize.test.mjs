import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeFeedback } from '../skills/agentic-ai-lite/scripts/submit-feedback.mjs';

test('sanitizes secrets, paths, repo names, and transcript lines', () => {
  const payload = sanitizeFeedback([
    'Repo AgentSurf should learn this.',
    '/home/ubuntu/workspace/1_PROJECTS/AgentSurf/file.txt',
    'sk-abcdefghijklmnopqrstuvwxyz',
    '{"timestamp":"2026-01-01","type":"response_item","payload":{}}',
  ].join('\n'), {
    repoName: 'AgentSurf',
    cwd: '/tmp/AgentSurf',
  });

  assert.match(payload.sanitized_text, /\[REDACTED_REPO_NAME\]/);
  assert.match(payload.sanitized_text, /\[REDACTED_LOCAL_PATH\]/);
  assert.match(payload.sanitized_text, /\[REDACTED_OPENAI_KEY\]/);
  assert.match(payload.sanitized_text, /\[REDACTED_TRANSCRIPT_LINE\]/);
  assert.deepEqual(new Set(payload.redactions), new Set(['repo_name', 'absolute_path', 'secret', 'raw_transcript']));
});
