import test from 'node:test';
import assert from 'node:assert/strict';
import {
  childEnvForLogFormat,
  createUserLogger,
  getLogFormat,
  renderFriendlyEvent,
  stripLogArgs,
} from '../runtime/agentic-ai-maintainer/scripts/user-log.mjs';

test('defaults to friendly logs and supports --json machine mode', () => {
  assert.equal(getLogFormat({ argv: [], env: {} }), 'friendly');
  assert.equal(getLogFormat({ argv: ['--json'], env: {} }), 'json');
  assert.equal(getLogFormat({ argv: [], env: { AGENTIC_AI_LOG_FORMAT: 'json' } }), 'json');
  assert.deepEqual(stripLogArgs(['--watch', '--json', '--idle-ms', '1000']), ['--watch', '--idle-ms', '1000']);
  assert.equal(childEnvForLogFormat({}, 'json').AGENTIC_AI_LOG_FORMAT, 'json');
});

test('renders friendly maintainer messages without raw JSON shape', () => {
  assert.match(
    renderFriendlyEvent('maintainer.started', {
      project_root: '/tmp/project',
      mode: 'watch',
    }),
    /Watching for coding-agent activity/,
  );
  assert.equal(
    renderFriendlyEvent('codex.quota.wait'),
    'Codex usage limit reached. Agentic AI will keep watching and retry later. To use another account, run: agi account switch',
  );
  assert.equal(
    renderFriendlyEvent('maintainer.turn.done', { status: 'NO_MODEL_OUTPUT' }),
    'Codex produced no maintainer output. Agentic AI will keep watching and retry later.',
  );
  assert.match(
    renderFriendlyEvent('maintainer.turn.done', {
      status: 'COMPLETED',
      proposal_results: [{ result: 'applied' }, { result: 'rejected' }],
      outbox_results: [{ result: 'delivered' }],
    }),
    /Applied 1 safe update/,
  );
});

test('json logger emits structured events for scripts', () => {
  let output = '';
  const logger = createUserLogger({
    format: 'json',
    stdout: { write: (text) => { output += text; } },
    stderr: { write: () => {} },
  });

  logger.event('watch.started', { project_root: '/tmp/project', idle_ms: 10000 });
  const parsed = JSON.parse(output);
  assert.equal(parsed.event, 'watch.started');
  assert.equal(parsed.project_root, '/tmp/project');
  assert.equal(parsed.idle_ms, 10000);
  assert.match(parsed.updated_at, /^\d{4}-\d{2}-\d{2}T/);
});
