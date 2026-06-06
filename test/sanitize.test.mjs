import test from 'node:test';
import assert from 'node:assert/strict';
import { buildIssueTitle, formatIssueBody, sanitizeFeedback } from '../runtime/agentic-ai-maintainer/scripts/submit-feedback.mjs';

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

test('formats Flonest issue payload for third-party skill feedback', () => {
  const payload = sanitizeFeedback('The skill should preserve local AGENTS.md edits.', {
    skillId: 'useful-skill',
    upstreamRepo: 'someone/useful-skill',
    feedbackKind: 'third-party-skill-feedback',
  });

  assert.equal(buildIssueTitle(payload), '[agentic-ai] third-party-skill-feedback: useful-skill');
  assert.match(formatIssueBody(payload), /someone\/useful-skill/);
});
