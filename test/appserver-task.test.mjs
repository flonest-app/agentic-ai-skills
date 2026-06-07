import test from 'node:test';
import assert from 'node:assert/strict';
import { CODEX_ERROR_KINDS } from '../runtime/agentic-ai-maintainer/scripts/codex-errors.mjs';
import {
  MiniAppServerClient,
  buildInitializeParams,
  hasAppServerModelActivity,
  hasExhaustedCodexCredits,
  openAppServerThread,
  shouldMirrorCodexDiagnosticLine,
} from '../runtime/agentic-ai-maintainer/scripts/appserver-task.mjs';

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

test('initializes app-server with experimental API capability for cheap resume', () => {
  assert.deepEqual(buildInitializeParams(), {
    clientInfo: { name: 'agentic_ai_lite', title: 'Agentic AI Lite', version: '0.1.0' },
    capabilities: {
      experimentalApi: true,
      requestAttestation: false,
    },
  });
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

test('resumes stored app-server thread before starting followup turns', async () => {
  const calls = [];
  const client = {
    async request(method, params) {
      calls.push({ method, params });
      if (method === 'thread/resume') return { thread: { id: params.threadId } };
      throw new Error(`unexpected request: ${method}`);
    },
  };

  const result = await openAppServerThread(client, {
    threadId: 'thread-1',
    model: 'gpt-5.5',
    cwd: '/tmp/project',
    approvalPolicy: 'never',
    sandbox: 'workspace-write',
    serviceName: 'agentic_ai_maintainer',
  });

  assert.equal(result.thread.id, 'thread-1');
  assert.equal(result.reusedThread, true);
  assert.deepEqual(calls.map((call) => call.method), ['thread/resume']);
  assert.equal(calls[0].params.excludeTurns, true);
});

test('does not create a fresh thread when stored thread resume fails', async () => {
  const calls = [];
  const client = {
    async request(method, params) {
      calls.push({ method, params });
      if (method === 'thread/resume') throw new Error('thread not found');
      throw new Error(`unexpected request: ${method}`);
    },
  };

  await assert.rejects(() => openAppServerThread(client, {
    threadId: 'thread-1',
    model: 'gpt-5.5',
    cwd: '/tmp/project',
    approvalPolicy: 'never',
    sandbox: 'workspace-write',
    serviceName: 'agentic_ai_maintainer',
  }), /thread not found/);
  assert.deepEqual(calls.map((call) => call.method), ['thread/resume']);
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
  assert.equal(hasAppServerModelActivity(result.activity), true);
  assert.equal(result.activity.output_chars, 4);
  assert.equal(result.activity.agent_message_delta_count, 1);
});

test('tracks tool activity and identifies truly empty turns', async () => {
  const activeClient = new MiniAppServerClient({ cwd: process.cwd() });
  const activeWaiting = activeClient.waitForTurn('turn-3');
  activeClient.emit('notification', {
    method: 'item/completed',
    params: { item: { type: 'function_call', name: 'shell' } },
  });
  activeClient.emit('notification', {
    method: 'turn/completed',
    params: { turn: { id: 'turn-3', status: 'completed' } },
  });
  const activeResult = await activeWaiting;
  assert.equal(hasAppServerModelActivity(activeResult.activity), true);
  assert.equal(activeResult.activity.tool_call_count, 1);

  const emptyClient = new MiniAppServerClient({ cwd: process.cwd() });
  const emptyWaiting = emptyClient.waitForTurn('turn-4');
  emptyClient.emit('notification', {
    method: 'turn/completed',
    params: { turn: { id: 'turn-4', status: 'completed' } },
  });
  const emptyResult = await emptyWaiting;
  assert.equal(hasAppServerModelActivity(emptyResult.activity), false);
});

test('detects exhausted Codex credits from rate limit payloads', () => {
  assert.equal(hasExhaustedCodexCredits({
    rateLimits: { credits: { has_credits: false, unlimited: false } },
  }), true);
  assert.equal(hasExhaustedCodexCredits({
    rateLimits: { credits: { hasCredits: false, unlimited: true } },
  }), false);
});
