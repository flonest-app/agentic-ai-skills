#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2));
  const prompt = args.prompt || 'Classify this feedback for durable agent learning.';
  const cwd = resolve(args.cwd || process.cwd());
  const client = new MiniAppServerClient({ cwd, codexHome: args.codexHome || process.env.CODEX_HOME });

  try {
    await client.start();
    const account = await client.request('account/read', { refreshToken: false }, 30000);
    if (!account.account) {
      console.error('Codex auth is required. Run Codex login first, then retry.');
      process.exit(2);
    }

    const thread = (await client.request('thread/start', {
      model: args.model || 'gpt-5.5',
      cwd,
      approvalPolicy: 'never',
      sandbox: 'workspaceWrite',
      serviceName: 'agentic_ai_lite',
    })).thread;

    const input = [{ type: 'text', text: prompt }];
    if (args.skillPath) input.push({ type: 'skill', name: 'agentic-ai-lite', path: resolve(args.skillPath) });

    const turn = (await client.request('turn/start', { threadId: thread.id, input, cwd }, 30000)).turn;
    await client.waitForTurn(turn.id);
  } finally {
    client.stop();
  }
}

class MiniAppServerClient extends EventEmitter {
  constructor({ cwd, codexHome }) {
    super();
    this.cwd = cwd;
    this.codexHome = codexHome;
    this.nextId = 1;
    this.pending = new Map();
    this.proc = null;
  }

  async start() {
    this.proc = spawn(process.env.CODEX_BIN || 'codex', ['app-server', '--stdio'], {
      cwd: this.cwd,
      env: { ...process.env, ...(this.codexHome ? { CODEX_HOME: this.codexHome } : {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.proc.stderr.on('data', (chunk) => process.stderr.write(chunk));
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

  waitForTurn(turnId) {
    return new Promise((resolveWait) => {
      const onNotification = (message) => {
        if (message.method === 'item/agentMessage/delta') {
          process.stdout.write(message.params?.delta || '');
        }
        if (message.method !== 'turn/completed' || message.params?.turn?.id !== turnId) return;
        this.off('notification', onNotification);
        process.stdout.write('\n');
        resolveWait(message.params.turn);
      };
      this.on('notification', onNotification);
    });
  }

  stop() {
    this.proc?.kill('SIGTERM');
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

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--cwd') parsed.cwd = argv[++i];
    else if (arg === '--prompt') parsed.prompt = argv[++i];
    else if (arg === '--model') parsed.model = argv[++i];
    else if (arg === '--skill-path') parsed.skillPath = argv[++i];
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
