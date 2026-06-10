#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { appendFileSync, mkdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CODEX_ERROR_KINDS, classifyCodexError } from './codex-errors.mjs';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2));
  const prompt = args.prompt || 'Classify this feedback for durable agent learning.';
  const cwd = resolve(args.cwd || process.cwd());
  try {
    const result = await runAppServerTask({
      cwd,
      prompt,
      model: args.model,
      threadId: args.threadId,
      skillPath: args.skillPath,
      fallbackSkillPath: args.fallbackSkillPath,
      skillName: args.skillName,
      codexHome: args.codexHome || process.env.CODEX_HOME,
      stream: true,
    });
    if (result.authRequired) {
      console.error('Codex auth is required. Run agi; first-time login starts automatically.');
      process.exit(2);
    }
    if (result.codexError) {
      console.error(result.codexError.message || 'Codex task failed.');
      process.exit(isBlockingCodexError(result.codexError) ? 2 : 1);
    }
    if (result.noModelOutput) {
      console.error('Codex produced no maintainer output.');
      process.exit(2);
    }
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

export const DEFAULT_CODEX_SANDBOX = 'workspace-write';

export async function runAppServerTask({
  cwd = process.cwd(),
  prompt = 'Classify this feedback for durable agent learning.',
  model = 'gpt-5.5',
  threadId,
  skillPath,
  fallbackSkillPath,
  skillName = 'agentic-ai-maintainer',
  codexHome,
  stream = false,
  approvalPolicy = 'never',
  sandbox = DEFAULT_CODEX_SANDBOX,
  serviceName = 'agentic_ai_lite',
  diagnosticLogPath,
  extraEnv = {},
} = {}) {
  const client = new MiniAppServerClient({ cwd, codexHome, diagnosticLogPath, extraEnv });
  try {
    await client.start();
    let account = await client.request('account/read', { refreshToken: false }, 30000);
    if (!account.account && account.requiresOpenaiAuth !== false) {
      account = await client.request('account/read', { refreshToken: true }, 30000)
        .catch(() => account);
    }
    if (!account.account && account.requiresOpenaiAuth !== false) {
      return {
        authRequired: true,
        account,
        codexError: classifyCodexError({
          message: 'Codex authentication is required.',
          account,
          status: 401,
        }),
      };
    }
    const rateLimits = await client.request('account/rateLimits/read', {}, 30000).catch((error) => {
      const codexError = classifyCodexError(error);
      return isBlockingCodexError(codexError) ? { codexError } : null;
    });
    if (rateLimits?.codexError) {
      return blockedTaskResult({ account, codexError: rateLimits.codexError });
    }
    const rateLimitCodexError = codexErrorFromRateLimits(rateLimits);
    if (rateLimitCodexError) {
      return blockedTaskResult({
        account,
        codexError: rateLimitCodexError,
      });
    }

    const input = buildTurnInput({ prompt, skillPath, skillName });

    let thread;
    let turnStartError = null;
    let reusedThread = false;
    try {
      const opened = await openAppServerThread(client, { threadId, model, cwd, approvalPolicy, sandbox, serviceName });
      thread = opened.thread;
      reusedThread = opened.reusedThread;
    } catch (err) {
      const codexError = classifyCodexError(err);
      if (isBlockingCodexError(codexError)) return blockedTaskResult({ account, codexError });
      throw err;
    }
    let turn;
    let skillAttached = Boolean(skillPath);
    try {
      turn = (await client.request('turn/start', { threadId: thread.id, input, cwd }, 30000)).turn;
    } catch (err) {
      const codexError = classifyCodexError(err);
      if (isBlockingCodexError(codexError)) return blockedTaskResult({ account, codexError });
      turnStartError = safeCodexRequestError(err);
      throw Object.assign(err, { turnStartError });
    }
    const completed = await client.waitForTurn(turn.id, { stream });
    const noModelOutput = !hasAppServerModelActivity(completed.activity);
    const completedRateLimits = completed.rateLimits || rateLimits;
    return {
      authRequired: false,
      threadId: thread.id,
      reusedThread,
      resumeError: null,
      turnStartError,
      turnId: turn.id,
      skillAttached,
      turn: completed.turn,
      output: completed.output,
      activity: completed.activity,
      noModelOutput,
      codexError: completed.codexError,
      rateLimits: completedRateLimits,
    };
  } finally {
    client.stop();
  }
}

function buildTurnInput({ prompt, skillPath, skillName }) {
  const input = [{ type: 'text', text: prompt }];
  if (skillPath) input.push({ type: 'skill', name: skillName, path: resolve(skillPath) });
  return input;
}

async function startThread(client, { model, cwd, approvalPolicy, sandbox, serviceName }) {
  return (await client.request('thread/start', {
    model,
    cwd,
    approvalPolicy,
    sandbox,
    serviceName,
  })).thread;
}

export async function openAppServerThread(client, {
  threadId,
  model,
  cwd,
  approvalPolicy,
  sandbox,
  serviceName,
} = {}) {
  if (threadId) {
    const thread = (await client.request('thread/resume', {
      threadId,
      model,
      cwd,
      approvalPolicy,
      sandbox,
      serviceName,
      excludeTurns: true,
    })).thread;
    return { thread, reusedThread: true, resumeError: null };
  }
  const thread = await startThread(client, { model, cwd, approvalPolicy, sandbox, serviceName });
  return { thread, reusedThread: false, resumeError: null };
}

export function createEmptyAppServerActivity() {
  return {
    output_chars: 0,
    agent_message_delta_count: 0,
    assistant_message_count: 0,
    tool_call_count: 0,
    item_count: 0,
    notification_count: 0,
  };
}

export function hasAppServerModelActivity(activity) {
  if (!activity) return true;
  return Number(activity.output_chars || 0) > 0
    || Number(activity.agent_message_delta_count || 0) > 0
    || Number(activity.assistant_message_count || 0) > 0
    || Number(activity.tool_call_count || 0) > 0;
}

export class MiniAppServerClient extends EventEmitter {
  constructor({ cwd, codexHome, diagnosticLogPath, extraEnv = {} }) {
    super();
    this.cwd = cwd;
    this.codexHome = codexHome;
    this.diagnosticLogPath = diagnosticLogPath || join(cwd, '.agentic-ai', 'logs', 'codex-appserver.stderr.log');
    this.extraEnv = extraEnv;
    this.stderrBuffer = '';
    this.nextId = 1;
    this.pending = new Map();
    this.proc = null;
    this.blockingCodexError = null;
  }

  async start() {
    this.proc = spawn(process.env.CODEX_BIN || 'codex', ['app-server', '--stdio'], {
      cwd: this.cwd,
      env: { ...process.env, ...this.extraEnv, ...(this.codexHome ? { CODEX_HOME: this.codexHome } : {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.proc.stderr.on('data', (chunk) => this.handleStderr(chunk));
    createInterface({ input: this.proc.stdout }).on('line', (line) => this.handleLine(line));

    await this.request('initialize', buildInitializeParams(), 15000);
    this.notify('initialized', {});
  }

  request(method, params = {}, timeoutMs = 300000) {
    if (this.blockingCodexError) {
      return Promise.reject(createCodexBlockingError(this.blockingCodexError));
    }
    const id = this.nextId++;
    return new Promise((resolveRequest, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolveRequest, reject, timeout, method });
      this.proc.stdin.write(`${JSON.stringify({ method, id, params })}\n`);
    });
  }

  notify(method, params = {}) {
    this.proc.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  waitForTurn(turnId, { stream = false } = {}) {
    return new Promise((resolveWait) => {
      let output = '';
      let latestError = null;
      let latestRateLimits = null;
      const activity = createEmptyAppServerActivity();
      let onNotification;
      let onCodexError;
      const finish = (turn, codexError = null) => {
        if (onNotification) this.off('notification', onNotification);
        if (onCodexError) this.off('codex-error', onCodexError);
        if (stream) process.stdout.write('\n');
        mergeTurnActivity(activity, turn);
        resolveWait({ turn, output, codexError, activity, rateLimits: latestRateLimits });
      };
      onCodexError = (codexError) => {
        finish({ id: turnId, status: 'failed', error: codexError }, codexError);
      };
      onNotification = (message) => {
        activity.notification_count += 1;
        if (message.method === 'item/agentMessage/delta') {
          const delta = message.params?.delta || '';
          output += delta;
          activity.output_chars += delta.length;
          activity.agent_message_delta_count += 1;
          if (stream) process.stdout.write(delta);
        }
        if (message.method === 'item/started' || message.method === 'item/completed') {
          recordTurnItemActivity(activity, message.params?.item || message.params);
        }
        if (message.method === 'account/rateLimits/updated') {
          latestRateLimits = message.params || message;
          const rateLimitCodexError = codexErrorFromRateLimits(latestRateLimits);
          if (rateLimitCodexError) latestError = rateLimitCodexError;
        }
        if (message.method === 'error') {
          latestError = message.params?.error || message.params || message;
          if (message.params?.willRetry) return;
          const codexError = classifyCodexError(latestError);
          if (isBlockingCodexError(codexError)) {
            finish({ id: turnId, status: 'failed', error: latestError }, codexError);
          }
          return;
        }
        if (message.method !== 'turn/completed' || message.params?.turn?.id !== turnId) return;
        const turn = message.params.turn;
        const codexError = turn.status === 'failed' || turn.error
          ? classifyCodexError({ turn, error: turn.error || latestError })
          : null;
        finish(turn, codexError);
      };
      this.on('notification', onNotification);
      this.on('codex-error', onCodexError);
      if (this.blockingCodexError) onCodexError(this.blockingCodexError);
    });
  }

  stop() {
    this.proc?.kill('SIGTERM');
  }

  handleStderr(chunk) {
    const text = chunk.toString('utf8');
    appendDiagnostic(this.diagnosticLogPath, text);

    const verboseDiagnostics = /^(?:1|true|yes|verbose)$/i.test(process.env.AGENTIC_AI_CODEX_DIAGNOSTICS || '');
    this.stderrBuffer += text;
    const lines = this.stderrBuffer.split(/\r?\n/);
    this.stderrBuffer = lines.pop() || '';
    for (const line of lines) {
      const codexError = codexErrorFromDiagnosticLine(line);
      if (codexError) {
        this.blockOnCodexError(codexError, line);
        continue;
      }
      if (verboseDiagnostics || shouldMirrorCodexDiagnosticLine(line)) process.stderr.write(`${line}\n`);
    }
  }

  blockOnCodexError(codexError, diagnosticLine = '') {
    if (this.blockingCodexError) return;
    this.blockingCodexError = codexError;
    const error = createCodexBlockingError(codexError, diagnosticLine);
    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timeout);
      this.pending.delete(id);
      pending.reject(error);
    }
    this.emit('codex-error', codexError);
    this.stop();
  }

  handleLine(line) {
    const message = JSON.parse(line);
    if (Object.hasOwn(message, 'id')) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.pending.delete(message.id);
      if (message.error) {
        const error = new Error(`${pending.method}: ${message.error.message || 'request failed'}`);
        error.codexError = classifyCodexError(message.error);
        error.rawCodexError = message.error;
        pending.reject(error);
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    this.emit('notification', message);
  }
}

export function shouldMirrorCodexDiagnosticLine(line) {
  const text = String(line || '').trim();
  if (!text) return false;
  if (/ExperimentalWarning|default prompt too long|icon paths|plugin|skill loader|skill.*warning/i.test(text)) return false;
  if (/^"(?:error|message|type|code|param|status)"\s*:/.test(text)) return false;
  if (codexErrorFromDiagnosticLine(text)) return false;
  return /\b(error|fatal|panic|failed|auth|unauthorized|forbidden|quota|usage limit|rate limit|too many requests|credits|spend cap|429|server overloaded)\b/i.test(text);
}

export function codexErrorFromDiagnosticLine(line) {
  const text = String(line || '').trim();
  if (!text) return null;
  const codexError = classifyCodexError({ message: text });
  return isBlockingCodexError(codexError) ? codexError : null;
}

export function buildInitializeParams() {
  return {
    clientInfo: { name: 'agentic_ai_lite', title: 'Agentic AI Lite', version: '0.1.0' },
    capabilities: {
      experimentalApi: true,
      requestAttestation: false,
    },
  };
}

function blockedTaskResult({ account = null, codexError }) {
  return {
    authRequired: codexError.kind === CODEX_ERROR_KINDS.AUTH_REQUIRED,
    account,
    codexError,
  };
}

function isBlockingCodexError(codexError) {
  return codexError?.kind === CODEX_ERROR_KINDS.AUTH_REQUIRED
    || codexError?.kind === CODEX_ERROR_KINDS.QUOTA_EXHAUSTED
    || codexError?.kind === CODEX_ERROR_KINDS.RATE_LIMITED
    || codexError?.kind === CODEX_ERROR_KINDS.APP_SERVER_OVERLOADED;
}

function createCodexBlockingError(codexError, diagnosticLine = '') {
  const error = new Error(codexError?.message || 'Codex task blocked.');
  error.codexError = codexError || classifyCodexError({ message: error.message });
  error.rawCodexError = diagnosticLine ? { diagnostic: diagnosticLine } : null;
  return error;
}

function codexErrorFromRateLimits(rateLimits) {
  if (!rateLimits) return null;
  const reachedType = findFirstKey(rateLimits, [
    'rateLimitReachedType',
    'rate_limit_reached_type',
    'rate_limit_type',
  ]);
  if (!reachedType) return null;
  return classifyCodexError({
    message: 'Codex usage limit reached.',
    rateLimitReachedType: reachedType,
    rateLimits,
  });
}

export function hasExhaustedCodexCredits(rateLimits) {
  if (!rateLimits) return false;
  const credits = findFirstKey(rateLimits, ['credits']);
  if (!credits || typeof credits !== 'object') return false;
  const hasCredits = credits.hasCredits ?? credits.has_credits;
  const unlimited = credits.unlimited ?? credits.is_unlimited;
  return hasCredits === false && unlimited !== true;
}

function mergeTurnActivity(activity, turn) {
  for (const item of collectTurnItems(turn)) recordTurnItemActivity(activity, item);
}

function collectTurnItems(turn) {
  if (!turn || typeof turn !== 'object') return [];
  const itemLists = [
    turn.items,
    turn.itemsView?.items,
    turn.outputItems,
    turn.output_items,
  ].filter(Array.isArray);
  return itemLists.flat();
}

function recordTurnItemActivity(activity, item) {
  const value = item?.item && typeof item.item === 'object' ? item.item : item;
  if (!value || typeof value !== 'object') return;
  activity.item_count += 1;
  const type = String(value.type || value.kind || '').toLowerCase();
  const role = String(value.role || '').toLowerCase();
  const name = String(value.name || value.toolName || value.tool_name || '').toLowerCase();
  if (role === 'assistant' || /agentmessage|assistant[_-]?message|message/.test(type)) {
    activity.assistant_message_count += 1;
  }
  if (/tool|function|exec|command|shell/.test(type) || /tool|function|exec|command|shell/.test(name)) {
    activity.tool_call_count += 1;
  }
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

function safeCodexRequestError(err) {
  return {
    message: err?.message || String(err),
    codex_error: err?.codexError || classifyCodexError(err),
    raw_codex_error: err?.rawCodexError || null,
  };
}

function appendDiagnostic(path, text) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, text);
  } catch {}
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--cwd') parsed.cwd = argv[++i];
    else if (arg === '--prompt') parsed.prompt = argv[++i];
    else if (arg === '--model') parsed.model = argv[++i];
    else if (arg === '--thread-id') parsed.threadId = argv[++i];
    else if (arg === '--skill-path') parsed.skillPath = argv[++i];
    else if (arg === '--fallback-skill-path') parsed.fallbackSkillPath = argv[++i];
    else if (arg === '--skill-name') parsed.skillName = argv[++i];
    else if (arg === '--codex-home') parsed.codexHome = argv[++i];
    else if (arg === '--help') {
      console.log('Usage: appserver-task.mjs --cwd <path> --prompt <text> [--skill-path SKILL.md]');
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return parsed;
}
