export const CODEX_ERROR_KINDS = {
  AUTH_REQUIRED: 'auth_required',
  QUOTA_EXHAUSTED: 'quota_exhausted',
  RATE_LIMITED: 'rate_limited',
  APP_SERVER_OVERLOADED: 'app_server_overloaded',
  UNKNOWN: 'unknown',
};

const RATE_LIMIT_REACHED_TYPES = new Set([
  'rate_limit_reached',
  'RateLimitReached',
  'workspace_owner_credits_depleted',
  'WorkspaceOwnerCreditsDepleted',
  'workspace_member_credits_depleted',
  'WorkspaceMemberCreditsDepleted',
  'workspace_owner_usage_limit_reached',
  'WorkspaceOwnerUsageLimitReached',
  'workspace_member_usage_limit_reached',
  'WorkspaceMemberUsageLimitReached',
]);

export function classifyCodexError(input) {
  if (input?.kind && Object.values(CODEX_ERROR_KINDS).includes(input.kind)) {
    return {
      kind: input.kind,
      message: input.message || fallbackMessageForKind(input.kind),
      rate_limit_reached_type: input.rate_limit_reached_type || null,
      retry_after_seconds: input.retry_after_seconds ?? null,
      resets_at: input.resets_at ?? null,
    };
  }
  const details = extractCodexErrorDetails(input);
  const text = details.text.toLowerCase();
  const rateLimitReachedType = details.rateLimitReachedType;

  if (/\b(unauthorized|forbidden|auth required|authentication required|not authenticated|invalid token|expired token)\b/.test(text)
    || /\b(?:401|403)\b/.test(text)) {
    return {
      kind: CODEX_ERROR_KINDS.AUTH_REQUIRED,
      message: details.message || 'Codex authentication is required.',
      rate_limit_reached_type: rateLimitReachedType,
      retry_after_seconds: details.retryAfterSeconds,
    };
  }

  if (rateLimitReachedType && RATE_LIMIT_REACHED_TYPES.has(rateLimitReachedType)) {
    return {
      kind: rateLimitReachedType.includes('rate_limit') || rateLimitReachedType === 'RateLimitReached'
        ? CODEX_ERROR_KINDS.RATE_LIMITED
        : CODEX_ERROR_KINDS.QUOTA_EXHAUSTED,
      message: details.message || 'Codex usage limit reached.',
      rate_limit_reached_type: normalizeRateLimitReachedType(rateLimitReachedType),
      retry_after_seconds: details.retryAfterSeconds,
      resets_at: details.resetsAt,
    };
  }

  if (/server overloaded; retry later/.test(text)) {
    return {
      kind: CODEX_ERROR_KINDS.APP_SERVER_OVERLOADED,
      message: details.message || 'Codex app-server is overloaded; retry later.',
      retry_after_seconds: details.retryAfterSeconds,
    };
  }

  if (/usage[_ -]?limit|usage limit reached|the usage limit has been reached|out of credits|credits depleted|spend cap|insufficient quota|quota|billing/.test(text)) {
    return {
      kind: CODEX_ERROR_KINDS.QUOTA_EXHAUSTED,
      message: details.message || 'Codex usage limit reached.',
      rate_limit_reached_type: rateLimitReachedType ? normalizeRateLimitReachedType(rateLimitReachedType) : null,
      retry_after_seconds: details.retryAfterSeconds,
      resets_at: details.resetsAt,
    };
  }

  if (/\b(rate limit|too many requests|429)\b/.test(text)) {
    return {
      kind: CODEX_ERROR_KINDS.RATE_LIMITED,
      message: details.message || 'Codex rate limit reached.',
      retry_after_seconds: details.retryAfterSeconds,
      resets_at: details.resetsAt,
    };
  }

  return {
    kind: CODEX_ERROR_KINDS.UNKNOWN,
    message: details.message || text || 'Unknown Codex error.',
    rate_limit_reached_type: rateLimitReachedType ? normalizeRateLimitReachedType(rateLimitReachedType) : null,
    retry_after_seconds: details.retryAfterSeconds,
    resets_at: details.resetsAt,
  };
}

export function isCodexAuthError(input) {
  return classifyCodexError(input).kind === CODEX_ERROR_KINDS.AUTH_REQUIRED;
}

export function isCodexUsageLimitError(input) {
  const kind = classifyCodexError(input).kind;
  return kind === CODEX_ERROR_KINDS.QUOTA_EXHAUSTED || kind === CODEX_ERROR_KINDS.RATE_LIMITED;
}

export function extractCodexErrorDetails(input) {
  const value = normalizeCodexErrorInput(input);
  const message = extractMessage(value);
  const rateLimitReachedType = findFirstKey(value, [
    'rateLimitReachedType',
    'rate_limit_reached_type',
    'rate_limit_type',
  ]);
  const retryAfterSeconds = parseOptionalNumber(findFirstKey(value, [
    'retryAfter',
    'retry_after',
    'retryAfterSeconds',
    'retry_after_seconds',
  ]));
  const resetsAt = findFirstKey(value, ['resetsAt', 'resets_at']);
  return {
    message,
    text: collectText(value),
    rateLimitReachedType: typeof rateLimitReachedType === 'string' ? rateLimitReachedType : null,
    retryAfterSeconds,
    resetsAt: resetsAt ?? null,
  };
}

function normalizeCodexErrorInput(input) {
  if (input instanceof Error) {
    if (input.codexError?.kind && Object.values(CODEX_ERROR_KINDS).includes(input.codexError.kind)) {
      return input.codexError;
    }
    return { message: input.message, codexError: input.codexError, cause: input.cause };
  }
  return input;
}

function extractMessage(value) {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';
  return String(
    value.message
      || value.error?.message
      || value.turn?.error?.message
      || value.params?.error?.message
      || value.codexErrorInfo?.message
      || value.additionalDetails?.message
      || '',
  );
}

function collectText(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(collectText).join(' ');
  if (typeof value === 'object') {
    return Object.entries(value)
      .filter(([key]) => !/token|authorization|api[_-]?key|secret|password/i.test(key))
      .map(([key, nested]) => `${key} ${collectText(nested)}`)
      .join(' ');
  }
  return '';
}

function findFirstKey(value, names) {
  if (!value || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findFirstKey(item, names);
      if (found !== null && found !== undefined) return found;
    }
    return null;
  }
  for (const name of names) {
    if (Object.hasOwn(value, name)) return value[name];
  }
  for (const nested of Object.values(value)) {
    const found = findFirstKey(nested, names);
    if (found !== null && found !== undefined) return found;
  }
  return null;
}

function parseOptionalNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function normalizeRateLimitReachedType(value) {
  return String(value)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase();
}

function fallbackMessageForKind(kind) {
  if (kind === CODEX_ERROR_KINDS.AUTH_REQUIRED) return 'Codex authentication is required.';
  if (kind === CODEX_ERROR_KINDS.QUOTA_EXHAUSTED) return 'Codex usage limit reached.';
  if (kind === CODEX_ERROR_KINDS.RATE_LIMITED) return 'Codex rate limit reached.';
  if (kind === CODEX_ERROR_KINDS.APP_SERVER_OVERLOADED) return 'Codex app-server is overloaded; retry later.';
  return 'Unknown Codex error.';
}
