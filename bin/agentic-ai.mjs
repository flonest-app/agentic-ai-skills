#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scriptRoot = resolve(repoRoot, 'runtime/agentic-ai-maintainer/scripts');

const argv = process.argv.slice(2);
const [command, ...rest] = argv;

const scripts = {
  start: ['start-maintainer.mjs', ['--daemon']],
  run: ['start-maintainer.mjs', ['--foreground']],
  watch: ['start-maintainer.mjs', ['--foreground', '--watch']],
  once: ['start-maintainer.mjs', ['--once']],
  status: ['status.mjs', []],
  stop: ['stop-maintainer.mjs', []],
  'discover-conversations': ['discover-project-conversations.mjs', []],
  discover: ['discover-skills.mjs', []],
  'install-skill': ['install-managed-skill.mjs', []],
  'check-updates': ['check-updates.mjs', []],
  reconcile: ['reconcile-signed-skills.mjs', []],
};

if (command === 'help' || command === '--help' || command === '-h') {
  printHelp();
  process.exit(0);
}

if (command === 'login' || command === '--login') {
  console.error('No separate login command is needed. Run `agi`; first-time login starts automatically.');
  process.exit(1);
}

if (!command || command.startsWith('--')) {
  await runDefaultAgi(argv);
  process.exit(0);
}

const target = scripts[command];
if (!target) {
  console.error(`Unknown command: ${command}`);
  printHelp();
  process.exit(1);
}

const [script, defaults] = target;
const args = normalizeProjectArg(rest);
if (['start', 'run', 'watch', 'once'].includes(command)) await ensureRuntimeReady(args);
const result = spawnSync(process.execPath, [
  resolve(scriptRoot, script),
  ...defaults,
  ...args,
], {
  cwd: process.cwd(),
  stdio: 'inherit',
  env: childEnv(),
});

process.exit(result.status ?? signalExitCode(result.signal) ?? 1);

async function runDefaultAgi(rawArgs) {
  const args = normalizeProjectArg(rawArgs);
  await ensureRuntimeReady(args);
  console.log('Starting Agentic AI maintainer. Press Ctrl+C to stop.');
  const result = spawnSync(process.execPath, [
    resolve(scriptRoot, 'start-maintainer.mjs'),
    '--foreground',
    '--watch',
    ...args,
  ], {
    cwd: process.cwd(),
    stdio: 'inherit',
    env: childEnv(),
  });
  process.exit(result.status ?? signalExitCode(result.signal) ?? 1);
}

async function ensureRuntimeReady(args) {
  const projectRoot = resolve(readOption(args, '--project-root') || process.cwd());
  const codexHome = readOption(args, '--codex-home');
  const runtimeCodexHome = resolve(codexHome || join(getAgenticAiHome(), 'codex-home'));

  if (hasCodexAuth(runtimeCodexHome)) return { codex_home: runtimeCodexHome };

  console.log('First run: Agentic AI needs Codex auth for its isolated runtime home.');
  console.log(`Auth will be stored under ${runtimeCodexHome}`);
  const result = spawnSync(process.execPath, [
    resolve(scriptRoot, 'codex-login.mjs'),
    '--codex-home',
    runtimeCodexHome,
  ], {
    cwd: projectRoot,
    stdio: 'inherit',
    env: childEnv(),
  });

  if (result.status !== 0) {
    process.exit(result.status ?? signalExitCode(result.signal) ?? 1);
  }
  if (!hasCodexAuth(runtimeCodexHome)) {
    console.error(`Codex auth was not written under ${runtimeCodexHome}.`);
    process.exit(1);
  }
  return { codex_home: runtimeCodexHome };
}

function normalizeProjectArg(argv) {
  const normalized = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--project') normalized.push('--project-root', argv[++i]);
    else normalized.push(arg);
  }
  return normalized;
}

function readOption(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function signalExitCode(signal) {
  if (!signal) return null;
  if (signal === 'SIGINT') return 130;
  if (signal === 'SIGTERM') return 143;
  return 1;
}

function getAgenticAiHome() {
  return resolve(process.env.AGENTIC_AI_HOME || join(homedir(), '.agentic-ai'));
}

function hasCodexAuth(codexHome) {
  return existsSync(join(codexHome, 'auth.json'));
}

function childEnv(extra = {}) {
  return {
    ...process.env,
    NODE_OPTIONS: nodeOptionsWithoutExperimentalWarningNoise(process.env.NODE_OPTIONS),
    ...extra,
  };
}

function nodeOptionsWithoutExperimentalWarningNoise(value = '') {
  const existing = String(value || '').trim();
  if (existing.split(/\s+/).some((option) => option === '--no-warnings' || option.startsWith('--no-warnings='))) {
    return existing;
  }
  return [existing, '--no-warnings=ExperimentalWarning'].filter(Boolean).join(' ');
}

function printHelp() {
  console.log(`Usage:
  agi

Starts the Agentic AI maintainer for the current project. First run opens the
Codex login flow automatically; later runs reuse ~/.agentic-ai/codex-home.

Advanced:
  agi status
  agi stop
  agi once
  agi discover --query <text>
  agi reconcile
`);
}
