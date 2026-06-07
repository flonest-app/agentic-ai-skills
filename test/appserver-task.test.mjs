import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldMirrorCodexDiagnosticLine } from '../runtime/agentic-ai-maintainer/scripts/appserver-task.mjs';

test('suppresses noisy Codex app-server loader warnings from terminal mirroring', () => {
  assert.equal(shouldMirrorCodexDiagnosticLine('default prompt too long for skill ngs-analysis'), false);
  assert.equal(shouldMirrorCodexDiagnosticLine('plugin icon paths should be relative'), false);
  assert.equal(shouldMirrorCodexDiagnosticLine('(node:1) ExperimentalWarning: SQLite is experimental'), false);
});

test('mirrors actionable Codex app-server diagnostics', () => {
  assert.equal(shouldMirrorCodexDiagnosticLine('error: app-server failed to start'), true);
  assert.equal(shouldMirrorCodexDiagnosticLine('fatal: unauthorized account'), true);
});
