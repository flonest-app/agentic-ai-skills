#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { appendFileSync, mkdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

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
    const account = await client.request('account/read', { refreshToken: false }, 30000);
    if (!account.account) return { authRequired: true, account };

    const input = buildTurnInput({ prompt, skillPath, skillName });

    let thread = threadId ? { id: threadId } : await startThread(client, { model, cwd, approvalPolicy, sandbox, serviceName });
    let reusedThread = Boolean(threadId);
    let turn;
    let skillAttached = Boolean(skillPath);
    try {
      turn = (await client.request('turn/start', { threadId: thread.id, input, cwd }, 30000)).turn;
    } catch (err) {
      if (!threadId) throw err;
      thread = await startThread(client, { model, cwd, approvalPolicy, sandbox, serviceName });
      reusedThread = false;
      const fallbackInput = skillPath
        ? input
        : buildTurnInput({ prompt, skillPath: fallbackSkillPath, skillName });
      skillAttached = Boolean(skillPath || fallbackSkillPath);
      turn = (await client.request('turn/start', { threadId: thread.id, input: fallbackInput, cwd }, 30000)).turn;
    }
    const completed = await client.waitForTurn(turn.id, { stream });
    return {
      authRequired: false,
      threadId: thread.id,
      reusedThread,
      turnId: turn.id,
      skillAttached,
      turn: completed.turn,
      output: completed.output,
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
  }

  async start() {
    this.proc = spawn(process.env.CODEX_BIN || 'codex', ['app-server', '--stdio'], {
      cwd: this.cwd,
      env: { ...process.env, ...this.extraEnv, ...(this.codexHome ? { CODEX_HOME: this.codexHome } : {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.proc.stderr.on('data', (chunk) => this.handleStderr(chunk));
    createInterface({ input: this.proc.stdout }).on('line', (line) => this.handleLine(line));

    await this.request('initialize', {
      clientInfo: { name: 'agentic_ai_lite', title: 'Agentic AI Lite', version: '0.1.0' },
    }, 15000);
    this.notify('initialized', {});
  }

  request(method, params = {}, timeoutMs = 300000) {
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
      const onNotification = (message) => {
        if (message.method === 'item/agentMessage/delta') {
          const delta = message.params?.delta || '';
          output += delta;
          if (stream) process.stdout.write(delta);
        }
        if (message.method !== 'turn/completed' || message.params?.turn?.id !== turnId) return;
        this.off('notification', onNotification);
        if (stream) process.stdout.write('\n');
        resolveWait({ turn: message.params.turn, output });
      };
      this.on('notification', onNotification);
    });
  }

  stop() {
    this.proc?.kill('SIGTERM');
  }

  handleStderr(chunk) {
    const text = chunk.toString('utf8');
    appendDiagnostic(this.diagnosticLogPath, text);
    if (/^(?:1|true|yes|verbose)$/i.test(process.env.AGENTIC_AI_CODEX_DIAGNOSTICS || '')) {
      process.stderr.write(text);
      return;
    }

    this.stderrBuffer += text;
    const lines = this.stderrBuffer.split(/\r?\n/);
    this.stderrBuffer = lines.pop() || '';
    for (const line of lines) {
      if (shouldMirrorCodexDiagnosticLine(line)) process.stderr.write(`${line}\n`);
    }
  }

  handleLine(line) {
    const message = JSON.parse(line);
    if (Object.hasOwn(message, 'id')) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message}`));
      else pending.resolve(message.result);
      return;
    }
    this.emit('notification', message);
  }
}

export function shouldMirrorCodexDiagnosticLine(line) {
  const text = String(line || '').trim();
  if (!text) return false;
  if (/ExperimentalWarning|default prompt too long|icon paths|plugin|skill loader|skill.*warning/i.test(text)) return false;
  return /\b(error|fatal|panic|failed|auth|unauthorized|forbidden)\b/i.test(text);
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
