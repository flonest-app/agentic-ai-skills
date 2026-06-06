#!/usr/bin/env node
import { readdirSync, statSync, unlinkSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  getMaintainerPaths,
  runMaintenanceOnce,
  shouldStop,
  writeMaintainerStatus,
} from './maintainer-runtime.mjs';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2));
  const projectRoot = resolve(args.projectRoot || process.cwd());
  const intervalMs = Math.max(1, args.intervalMinutes || 60) * 60 * 1000;
  const idleMs = Math.max(1000, args.idleMs || 10000);
  const pollMs = Math.max(250, args.pollMs || 1000);
  const paths = getMaintainerPaths({ projectRoot, codexHome: args.codexHome, sourceCodexHome: args.sourceCodexHome });
  const stopFromSignal = (signal) => {
    writeMaintainerStatus({
      projectRoot,
      status: 'STOPPED',
      pid: null,
      message: `Maintainer stopped by ${signal}.`,
    });
    logEvent('maintainer.stopped', { project_root: projectRoot, signal });
    process.exit(signalExitCode(signal));
  };

  process.once('SIGINT', () => stopFromSignal('SIGINT'));
  process.once('SIGTERM', () => stopFromSignal('SIGTERM'));
  process.once('SIGHUP', () => stopFromSignal('SIGHUP'));

  try {
    unlinkSync(paths.stopPath);
  } catch {}

  writeMaintainerStatus({
    projectRoot,
    status: 'RUNNING',
    pid: process.pid,
    message: 'Maintainer daemon running.',
  });
  logEvent('maintainer.started', {
    project_root: projectRoot,
    mode: args.watch ? 'watch' : 'interval',
    interval_minutes: args.intervalMinutes || 60,
    idle_ms: args.watch ? idleMs : null,
  });

  if (args.watch) {
    await runWatchLoop({ projectRoot, args, idleMs, pollMs });
  } else {
    while (!shouldStop({ projectRoot })) {
      await runMaintainerTurn({ projectRoot, args });
      await sleep(intervalMs);
    }
  }

  writeMaintainerStatus({
    projectRoot,
    status: 'STOPPED',
    pid: null,
    message: 'Maintainer daemon stopped.',
  });
  logEvent('maintainer.stopped', { project_root: projectRoot });
}

async function runMaintainerTurn({ projectRoot, args, changedFiles = [] }) {
  const message = args.message || (
    changedFiles.length > 0
      ? `Repository changed and stayed idle. Review the attached conversation evidence, AGENTS.md, and managed skills. Changed files: ${changedFiles.slice(0, 20).join(', ')}`
      : null
  );
    logEvent('maintainer.turn.start', { project_root: projectRoot, message, conversation_file: args.conversationFile || null });
    const status = await runMaintenanceOnce({
      projectRoot,
      codexHome: args.codexHome,
      sourceCodexHome: args.sourceCodexHome,
      historyRoots: args.historyRoots,
      conversationFile: args.conversationFile,
      triggerMessage: message,
      model: args.model,
    });
    logEvent('maintainer.turn.done', {
      project_root: projectRoot,
      status: status.status,
      message: status.message,
      thread_id: status.thread_id || null,
      turn_id: status.turn_id || null,
      thread_ref_path: status.thread_ref_path || null,
      codex_session_index_path: status.codex_session_index_path || null,
    });
}

async function runWatchLoop({ projectRoot, args, idleMs, pollMs }) {
  logEvent('watch.started', { project_root: projectRoot, idle_ms: idleMs, poll_ms: pollMs });
  let previous = collectProjectFileState(projectRoot);
  let pending = null;

  while (!shouldStop({ projectRoot })) {
    await sleep(pollMs);
    const next = collectProjectFileState(projectRoot);
    const changedFiles = diffProjectFileState(previous, next);
    if (changedFiles.length > 0) {
      const files = new Set([...(pending?.files || []), ...changedFiles]);
      pending = { changedAt: Date.now(), files: Array.from(files).slice(0, 50) };
      previous = next;
      logEvent('watch.change', { project_root: projectRoot, changed_files: pending.files });
    }

    if (pending && Date.now() - pending.changedAt >= idleMs) {
      const files = pending.files;
      pending = null;
      logEvent('watch.idle_trigger', { project_root: projectRoot, changed_files: files });
      await runMaintainerTurn({ projectRoot, args, changedFiles: files });
      previous = collectProjectFileState(projectRoot);
    }
  }
}

function parseArgs(argv) {
  const parsed = { historyRoots: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--project-root') parsed.projectRoot = argv[++i];
    else if (arg === '--codex-home') parsed.codexHome = argv[++i];
    else if (arg === '--source-codex-home') parsed.sourceCodexHome = argv[++i];
    else if (arg === '--history-root') parsed.historyRoots.push(argv[++i]);
    else if (arg === '--interval-minutes') parsed.intervalMinutes = Number(argv[++i]);
    else if (arg === '--model') parsed.model = argv[++i];
    else if (arg === '--message') parsed.message = argv[++i];
    else if (arg === '--query') parsed.message = argv[++i];
    else if (arg === '--conversation-file') parsed.conversationFile = argv[++i];
    else if (arg === '--watch') parsed.watch = true;
    else if (arg === '--idle-ms') parsed.idleMs = Number(argv[++i]);
    else if (arg === '--poll-ms') parsed.pollMs = Number(argv[++i]);
    else if (arg === '--help') {
      console.log('Usage: maintainer-daemon.mjs [--project-root repo] [--interval-minutes 60] [--watch] [--idle-ms 10000] [--message text] [--conversation-file path] [--history-root path] [--source-codex-home path]');
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return parsed;
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function logEvent(event, payload = {}) {
  console.log(JSON.stringify({ event, updated_at: new Date().toISOString(), ...payload }));
}

function signalExitCode(signal) {
  if (signal === 'SIGINT') return 130;
  if (signal === 'SIGTERM') return 143;
  if (signal === 'SIGHUP') return 129;
  return 1;
}

export function collectProjectFileState(projectRoot) {
  const root = resolve(projectRoot);
  const state = new Map();
  walk(root, root, state);
  return state;
}

export function diffProjectFileState(previous, next) {
  const changed = [];
  for (const [file, fingerprint] of next.entries()) {
    if (previous.get(file) !== fingerprint) changed.push(file);
  }
  for (const file of previous.keys()) {
    if (!next.has(file)) changed.push(file);
  }
  return changed.sort();
}

function walk(root, currentPath, state) {
  let stat;
  try {
    stat = statSync(currentPath);
  } catch {
    return;
  }

  if (stat.isDirectory()) {
    const rel = relative(root, currentPath).replaceAll('\\', '/');
    const name = rel.split('/').at(-1);
    if (shouldSkipPath(rel, name)) return;
    let entries = [];
    try {
      entries = readdirSync(currentPath);
    } catch {
      return;
    }
    for (const entry of entries) walk(root, join(currentPath, entry), state);
    return;
  }

  if (!stat.isFile()) return;
  const rel = relative(root, currentPath).replaceAll('\\', '/');
  if (shouldSkipPath(rel, rel.split('/').at(-1))) return;
  state.set(rel, `${stat.size}:${Math.floor(stat.mtimeMs)}`);
}

function shouldSkipPath(rel, name) {
  if (!rel || rel === '.') return false;
  if (['.git', 'node_modules', '.agentic-ai', 'runtime', 'dist', 'build', 'coverage'].includes(name)) return true;
  if (rel.startsWith('.git/') || rel.startsWith('node_modules/') || rel.startsWith('.agentic-ai/')) return true;
  return false;
}
