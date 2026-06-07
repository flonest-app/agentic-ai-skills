#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';

const ACTIONS = new Set(['status', 'login', 'logout', 'switch']);

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2));
  try {
    const result = runCodexAccountAction(args);
    process.exit(result.status ?? signalExitCode(result.signal) ?? 1);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

export function runCodexAccountAction({
  action = 'status',
  codexHome,
  codexBin = process.env.CODEX_BIN || 'codex',
  spawnSyncImpl = spawnSync,
  env = process.env,
  stdio = 'inherit',
} = {}) {
  if (!ACTIONS.has(action)) throw new Error(`Unknown account action: ${action}`);
  const runtimeCodexHome = resolve(codexHome || join(resolve(env.AGENTIC_AI_HOME || join(homedir(), '.agentic-ai')), 'codex-home'));
  mkdirSync(runtimeCodexHome, { recursive: true });
  const childEnv = { ...env, CODEX_HOME: runtimeCodexHome };

  if (action === 'switch') {
    const logout = spawnSyncImpl(codexBin, buildCodexAccountArgs('logout'), {
      stdio,
      env: childEnv,
    });
    if (logout.error) throw logout.error;
    const login = spawnSyncImpl(codexBin, buildCodexAccountArgs('login'), {
      stdio,
      env: childEnv,
    });
    if (login.error) throw login.error;
    return { ...login, codex_home: runtimeCodexHome };
  }

  const result = spawnSyncImpl(codexBin, buildCodexAccountArgs(action), {
    stdio,
    env: childEnv,
  });
  if (result.error) throw result.error;
  return { ...result, codex_home: runtimeCodexHome };
}

export function buildCodexAccountArgs(action) {
  if (action === 'status') return ['login', 'status'];
  if (action === 'login') return ['login', '--device-auth'];
  if (action === 'logout') return ['logout'];
  throw new Error(`Unknown account action: ${action}`);
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!parsed.action && ACTIONS.has(arg)) parsed.action = arg;
    else if (arg === '--codex-home') parsed.codexHome = argv[++i];
    else if (arg === '--help') {
      console.log('Usage: codex-account.mjs <status|login|logout|switch> [--codex-home ~/.agentic-ai/codex-home]');
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return { action: parsed.action || 'status', codexHome: parsed.codexHome };
}

function signalExitCode(signal) {
  if (!signal) return null;
  if (signal === 'SIGINT') return 130;
  if (signal === 'SIGTERM') return 143;
  return 1;
}
