import test from 'node:test';
import assert from 'node:assert/strict';
import { CODEX_ERROR_KINDS } from '../runtime/agentic-ai-maintainer/scripts/codex-errors.mjs';
import { MiniAppServerClient, shouldMirrorCodexDiagnosticLine } from '../runtime/agentic-ai-maintainer/scripts/appserver-task.mjs';

test('suppresses noisy Codex app-server loader warnings from terminal mirroring', () => {
  assert.equal(shouldMirrorCodexDiagnosticLine('default prompt too long for skill ngs-analysis'), false);
  assert.equal(shouldMirrorCodexDiagnosticLine('plugin icon paths should be relative'), false);
  assert.equal(shouldMirrorCodexDiagnosticLine('(node:1) ExperimentalWarning: SQLite is experimental'), false);
});

test('mirrors actionable Codex app-server diagnostics', () => {
  assert.equal(shouldMirrorCodexDiagnosticLine('error: app-server failed to start'), true);
  assert.equal(shouldMirrorCodexDiagnosticLine('fatal: unauthorized account'), true);
  assert.equal(shouldMirrorCodexDiagnosticLine('Usage limit reached. You have reached your usage limit.'), true);
  assert.equal(shouldMirrorCodexDiagnosticLine('Server overloaded; retry later.'), true);
});

test('captures failed turn Codex usage errors', async () => {
  const client = new MiniAppServerClient({ cwd: process.cwd() });
  const waiting = client.waitForTurn('turn-1');

  client.emit('notification', {
    method: 'turn/completed',
    params: {
      turn: {
        id: 'turn-1',
        status: 'failed',
        error: {
          message: 'The usage limit has been reached',
          codexErrorInfo: { rateLimitReachedType: 'workspace_member_usage_limit_reached' },
        },
      },
    },
  });

  const result = await waiting;
  assert.equal(result.codexError.kind, CODEX_ERROR_KINDS.QUOTA_EXHAUSTED);
  assert.equal(result.codexError.rate_limit_reached_type, 'workspace_member_usage_limit_reached');
});

test('does not stop on retryable app-server error notification', async () => {
  const client = new MiniAppServerClient({ cwd: process.cwd() });
  const waiting = client.waitForTurn('turn-2');

  client.emit('notification', {
    method: 'error',
    params: {
      willRetry: true,
      turnId: 'turn-2',
      error: { message: 'Server overloaded; retry later.' },
    },
  });
  client.emit('notification', {
    method: 'item/agentMessage/delta',
    params: { delta: 'done' },
  });
  client.emit('notification', {
    method: 'turn/completed',
    params: { turn: { id: 'turn-2', status: 'completed' } },
  });

  const result = await waiting;
  assert.equal(result.output, 'done');
  assert.equal(result.codexError, null);
});
