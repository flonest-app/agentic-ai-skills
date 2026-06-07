export function getLogFormat({ argv = process.argv.slice(2), env = process.env } = {}) {
  if (argv.includes('--json')) return 'json';
  const configured = String(env.AGENTIC_AI_LOG_FORMAT || '').trim().toLowerCase();
  return configured === 'json' ? 'json' : 'friendly';
}

export function stripLogArgs(argv = []) {
  return argv.filter((arg) => arg !== '--json');
}

export function childEnvForLogFormat(env = process.env, format = getLogFormat({ env })) {
  return {
    ...env,
    AGENTIC_AI_LOG_FORMAT: format,
  };
}

export function createUserLogger({
  format = getLogFormat(),
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  return {
    format,
    event(event, payload = {}) {
      const record = { event, updated_at: new Date().toISOString(), ...payload };
      if (format === 'json') {
        stdout.write(`${JSON.stringify(record)}\n`);
        return;
      }
      const message = renderFriendlyEvent(event, payload);
      if (!message) return;
      const target = payload.level === 'error' || payload.level === 'warn' ? stderr : stdout;
      target.write(`${message}\n`);
    },
  };
}

export function renderFriendlyEvent(event, payload = {}) {
  switch (event) {
    case 'agi.starting':
      return [
        'Agentic AI maintainer starting',
        payload.project_root ? `Project: ${payload.project_root}` : null,
        'Press Ctrl+C to stop.',
      ].filter(Boolean).join('\n');
    case 'auth.first_run':
      return [
        'First run: Agentic AI needs Codex sign-in for its isolated maintainer runtime.',
        payload.codex_home ? `Auth will be stored under ${payload.codex_home}` : null,
      ].filter(Boolean).join('\n');
    case 'auth.success':
      return 'Codex sign-in ready. Starting maintainer.';
    case 'auth.reauth.start':
      return 'Codex sign-in expired for Agentic AI. Starting sign-in again...';
    case 'auth.reauth.done':
      return payload.ok ? 'Codex sign-in refreshed. Retrying maintainer turn.' : 'Codex sign-in did not complete. Agentic AI will wait.';
    case 'maintainer.started':
      return [
        'Agentic AI maintainer started',
        payload.project_root ? `Project: ${payload.project_root}` : null,
        payload.mode === 'watch' ? 'Watching for coding-agent activity...' : `Running every ${payload.interval_minutes || 60} minutes...`,
        'Press Ctrl+C to stop.',
      ].filter(Boolean).join('\n');
    case 'maintainer.stopped':
      return payload.signal ? `Agentic AI maintainer stopped by ${payload.signal}.` : 'Agentic AI maintainer stopped.';
    case 'watch.started':
      return `Watching for project changes. Idle window: ${Math.round((payload.idle_ms || 0) / 1000)}s.`;
    case 'watch.change':
      return `Project activity detected. Waiting for edits to settle... (${count(payload.changed_files)} file${plural(payload.changed_files)} changed)`;
    case 'watch.idle_trigger':
      return 'Project is idle. Reviewing recent coding-agent conversation and project changes...';
    case 'maintainer.turn.start':
      return 'Running maintainer review...';
    case 'maintainer.turn.done':
      return renderTurnDone(payload);
    case 'codex.quota.wait':
      return 'Codex usage limit reached. Agentic AI will keep watching and retry later. No project files were changed.';
    case 'codex.overloaded':
      return 'Codex app-server is busy. Agentic AI will retry later.';
    default:
      return '';
  }
}

function renderTurnDone(payload) {
  if (payload.status === 'AUTH_REQUIRED') return 'Codex sign-in is required before Agentic AI can continue.';
  if (payload.status === 'WAITING_FOR_CODEX_QUOTA') return 'Codex usage limit reached. Agentic AI will keep watching and retry later. No project files were changed.';
  if (payload.status === 'ERROR') return `Maintainer turn failed: ${payload.message || 'unknown error'}`;

  const proposalResults = payload.proposal_results || [];
  const applied = proposalResults.filter((result) => result.result === 'applied').length;
  const queued = proposalResults.filter((result) => result.result === 'queued').length;
  const rejected = proposalResults.filter((result) => result.result === 'rejected').length;
  const outboxDelivered = (payload.outbox_results || []).filter((result) => result.result === 'delivered').length;

  if (applied || queued || rejected || outboxDelivered) {
    return [
      'Maintainer review completed.',
      applied ? `Applied ${applied} safe update${applied === 1 ? '' : 's'}.` : null,
      queued ? `Queued ${queued} proposal${queued === 1 ? '' : 's'} for Agentic AI Lab.` : null,
      outboxDelivered ? `Delivered ${outboxDelivered} lab proposal${outboxDelivered === 1 ? '' : 's'}.` : null,
      rejected ? `Rejected ${rejected} unsafe or unclear proposal${rejected === 1 ? '' : 's'}.` : null,
      'Watching again.',
    ].filter(Boolean).join('\n');
  }

  return 'No safe maintenance needed. Watching again.';
}

function count(value) {
  return Array.isArray(value) ? value.length : 0;
}

function plural(value) {
  return count(value) === 1 ? '' : 's';
}

