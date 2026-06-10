import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CODEX_ERROR_KINDS,
  classifyCodexError,
  isCodexAuthError,
  isCodexUsageLimitError,
} from '../runtime/agentic-ai-maintainer/scripts/codex-errors.mjs';

test('classifies Codex auth errors', () => {
  const error = classifyCodexError({ message: 'chatgpt authentication required', status: 401 });

  assert.equal(error.kind, CODEX_ERROR_KINDS.AUTH_REQUIRED);
  assert.equal(isCodexAuthError(error), true);
  assert.equal(
    classifyCodexError({
      message: 'Your authentication token has been invalidated. Please try signing in again.',
    }).kind,
    CODEX_ERROR_KINDS.AUTH_REQUIRED,
  );
  assert.equal(
    classifyCodexError({
      error: { code: 'token_invalidated' },
    }).kind,
    CODEX_ERROR_KINDS.AUTH_REQUIRED,
  );
  assert.equal(
    classifyCodexError({
      data: {
        errorCode: 'Auth',
        action: 'relogin',
        detail: 'Your access token could not be refreshed because your refresh token was revoked. Please log out and sign in again.',
      },
    }).kind,
    CODEX_ERROR_KINDS.AUTH_REQUIRED,
  );
});

test('classifies Codex usage and credit exhaustion errors', () => {
  assert.equal(
    classifyCodexError({ message: 'The usage limit has been reached' }).kind,
    CODEX_ERROR_KINDS.QUOTA_EXHAUSTED,
  );
  assert.equal(
    classifyCodexError({ message: 'Your workspace is out of credits. Add credits to continue.' }).kind,
    CODEX_ERROR_KINDS.QUOTA_EXHAUSTED,
  );
  assert.equal(
    classifyCodexError({
      rateLimits: { rateLimitReachedType: 'workspace_member_usage_limit_reached' },
    }).rate_limit_reached_type,
    'workspace_member_usage_limit_reached',
  );
  assert.equal(isCodexUsageLimitError({ message: 'You hit your spend cap set in your workspace.' }), true);
});

test('classifies rate limits and app-server overloads', () => {
  assert.equal(
    classifyCodexError({ message: 'Too many requests', status: 429 }).kind,
    CODEX_ERROR_KINDS.RATE_LIMITED,
  );
  assert.equal(
    classifyCodexError({ message: 'Server overloaded; retry later.' }).kind,
    CODEX_ERROR_KINDS.APP_SERVER_OVERLOADED,
  );
});

test('preserves already-classified Codex errors', () => {
  const error = classifyCodexError({
    kind: CODEX_ERROR_KINDS.QUOTA_EXHAUSTED,
    message: 'Codex usage limit reached.',
    retry_after_seconds: 120,
  });

  assert.equal(error.kind, CODEX_ERROR_KINDS.QUOTA_EXHAUSTED);
  assert.equal(error.retry_after_seconds, 120);
});
