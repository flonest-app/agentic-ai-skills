#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { discoverSourceCodexSessionsByCwd } from './discover-project-conversations.mjs';
import {
  getMaintainerPaths,
  runMaintenanceOnce,
  shouldStop,
  writeMaintainerStatus,
} from './maintainer-runtime.mjs';
import { createUserLogger, getLogFormat, stripLogArgs } from './user-log.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const rawArgv = process.argv.slice(2);
  const logger = createUserLogger({ format: getLogFormat({ argv: rawArgv }) });
  const args = parseArgs(stripLogArgs(rawArgv));
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
    logEvent(logger, 'maintainer.stopped', { project_root: projectRoot, signal });
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
  logEvent(logger, 'maintainer.started', {
    project_root: projectRoot,
    mode: args.watch ? 'watch' : 'interval',
    interval_minutes: args.intervalMinutes || 60,
    idle_ms: args.watch ? idleMs : null,
  });

  if (args.watch) {
    await runWatchLoop({ projectRoot, args, idleMs, pollMs, logger });
  } else {
    while (!shouldStop({ projectRoot })) {
      await runMaintainerTurn({ projectRoot, args, logger });
      await sleep(intervalMs);
    }
  }

  writeMaintainerStatus({
    projectRoot,
    status: 'STOPPED',
    pid: null,
    message: 'Maintainer daemon stopped.',
  });
  logEvent(logger, 'maintainer.stopped', { project_root: projectRoot });
}

async function runMaintainerTurn({ projectRoot, args, changedFiles = [], triggerMessage, logger }) {
  const message = args.message || triggerMessage || (
    changedFiles.length > 0
      ? `Repository changed and stayed idle. Review the attached conversation evidence, AGENTS.md, and managed skills. Changed files: ${changedFiles.slice(0, 20).join(', ')}`
      : null
  );
  logEvent(logger, 'maintainer.turn.start', { project_root: projectRoot, conversation_file: args.conversationFile || null });
  let status = await runMaintenanceOnce({
      projectRoot,
      codexHome: args.codexHome,
      sourceCodexHome: args.sourceCodexHome,
      historyRoots: args.historyRoots,
      conversationFile: args.conversationFile,
      triggerMessage: message,
      model: args.model,
      changedFiles,
    });

  if (status.status === 'AUTH_REQUIRED' && !args.reauthAttempted) {
    logEvent(logger, 'auth.reauth.start', { project_root: projectRoot, codex_home: status.codex_home || null });
    const paths = getMaintainerPaths({ projectRoot, codexHome: args.codexHome, sourceCodexHome: args.sourceCodexHome });
    const login = spawnSync(process.execPath, [
      resolve(scriptDir, 'codex-login.mjs'),
      '--codex-home',
      paths.codexHome,
    ], {
      cwd: projectRoot,
      stdio: 'inherit',
      env: process.env,
    });
    const ok = login.status === 0;
    logEvent(logger, 'auth.reauth.done', { project_root: projectRoot, ok });
    if (ok) {
      status = await runMaintenanceOnce({
        projectRoot,
        codexHome: args.codexHome,
        sourceCodexHome: args.sourceCodexHome,
        historyRoots: args.historyRoots,
        conversationFile: args.conversationFile,
        triggerMessage: message,
        model: args.model,
        changedFiles,
      });
    }
  }

  if (status.status === 'WAITING_FOR_CODEX_QUOTA') {
    logEvent(logger, 'codex.quota.wait', { project_root: projectRoot, codex_error: status.codex_error || null });
  } else if (status.codex_error?.kind === 'app_server_overloaded') {
    logEvent(logger, 'codex.overloaded', { project_root: projectRoot, codex_error: status.codex_error });
  }

  logEvent(logger, 'maintainer.turn.done', {
    project_root: projectRoot,
    status: status.status,
    message: status.message,
    proposal_results: status.proposal_results || [],
    outbox_results: status.outbox_results || [],
    thread_id: status.thread_id || null,
    turn_id: status.turn_id || null,
    thread_ref_path: status.thread_ref_path || null,
    codex_session_index_path: status.codex_session_index_path || null,
  });
}

async function runWatchLoop({ projectRoot, args, idleMs, pollMs, logger }) {
  const sourceTurnThreshold = Math.max(1, Number(args.sourceTurnThreshold || process.env.AGENTIC_AI_TRIGGER_TURNS || 3));
  logEvent(logger, 'watch.started', {
    project_root: projectRoot,
    idle_ms: idleMs,
    poll_ms: pollMs,
    source_turn_threshold: sourceTurnThreshold,
  });
  let sourceTurnState = collectSourceCodexTurnState({
    projectRoot,
    sourceCodexHome: args.sourceCodexHome,
  });
  let lastSourcePollAt = 0;
  let pendingSourceTurns = 0;
  let lastSourceActivityAt = null;
  let activeTurn = null;

  while (!shouldStop({ projectRoot })) {
    await sleep(pollMs);
    if (activeTurn) {
      if (activeTurn.done) {
        await activeTurn.promise;
        activeTurn = null;
        sourceTurnState = collectSourceCodexTurnState({
          projectRoot,
          sourceCodexHome: args.sourceCodexHome,
        });
        lastSourcePollAt = 0;
        pendingSourceTurns = 0;
        lastSourceActivityAt = null;
      }
      continue;
    }

    const now = Date.now();
    if (now - lastSourcePollAt >= Math.max(3000, pollMs)) {
      lastSourcePollAt = now;
      const nextSourceTurnState = collectSourceCodexTurnState({
        projectRoot,
        sourceCodexHome: args.sourceCodexHome,
      });
      const newTurnCount = countNewSourceCodexTurns(sourceTurnState, nextSourceTurnState);
      if (newTurnCount > 0) {
        pendingSourceTurns += newTurnCount;
        lastSourceActivityAt = now;
        logEvent(logger, 'watch.source_turns', {
          project_root: projectRoot,
          new_turn_count: newTurnCount,
          pending_turn_count: pendingSourceTurns,
          source_turn_threshold: sourceTurnThreshold,
          session_count: nextSourceTurnState.sessionCount,
        });
      } else if (sourceCodexActivityChanged(sourceTurnState, nextSourceTurnState) && pendingSourceTurns > 0) {
        lastSourceActivityAt = now;
        logEvent(logger, 'watch.conversation_change', {
          project_root: projectRoot,
          candidate_count: nextSourceTurnState.sessionCount,
        });
      }
      sourceTurnState = nextSourceTurnState;
    }

    if (
      pendingSourceTurns >= sourceTurnThreshold
      && lastSourceActivityAt
      && Date.now() - lastSourceActivityAt >= idleMs
    ) {
      const triggerTurnCount = pendingSourceTurns;
      pendingSourceTurns = 0;
      lastSourceActivityAt = null;
      logEvent(logger, 'watch.idle_trigger', {
        project_root: projectRoot,
        source_turn_count: triggerTurnCount,
      });
      activeTurn = startQueuedMaintainerTurn({
        projectRoot,
        args,
        changedFiles: [],
        triggerMessage: `Source Codex activity settled after ${triggerTurnCount} new completed turn${triggerTurnCount === 1 ? '' : 's'}. Review recent coding-agent conversation evidence, AGENTS.md, and managed skills.`,
        logger,
      });
    }
  }

  if (activeTurn) await activeTurn.promise;
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
    else if (arg === '--source-turn-threshold') parsed.sourceTurnThreshold = Number(argv[++i]);
    else if (arg === '--json') {}
    else if (arg === '--help') {
      console.log('Usage: maintainer-daemon.mjs [--project-root repo] [--interval-minutes 60] [--watch] [--idle-ms 10000] [--source-turn-threshold 3] [--message text] [--conversation-file path] [--history-root path] [--source-codex-home path]');
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

function logEvent(logger, event, payload = {}) {
  logger.event(event, payload);
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

export function mergePendingChangedFiles(pending, changedFiles = [], changedAt = Date.now()) {
  const files = new Set([...(pending?.files || []), ...changedFiles]);
  return { changedAt, files: Array.from(files).slice(0, 50) };
}

export function collectSourceCodexTurnState({
  projectRoot = process.cwd(),
  sourceCodexHome,
  limit = null,
} = {}) {
  const paths = getMaintainerPaths({ projectRoot, sourceCodexHome });
  const candidates = discoverSourceCodexSessionsByCwd({
    projectRoot: paths.projectRoot,
    sourceCodexHome: paths.sourceCodexHome,
  });
  const sessionLimit = Number.isFinite(Number(limit)) && Number(limit) > 0
    ? Number(limit)
    : candidates.length;
  const sessions = candidates
    .sort((a, b) => b.lastModifiedMs - a.lastModifiedMs)
    .slice(0, sessionLimit)
    .map((candidate) => inspectSourceCodexTurns({
      filePath: candidate.filePath,
      projectRoot: paths.projectRoot,
    }))
    .filter((session) => session.projectRelevant)
    .sort((a, b) => a.filePath.localeCompare(b.filePath));
  const turnIds = Array.from(new Set(sessions.flatMap((session) => session.turnIds))).sort();
  const fingerprintInput = sessions.map((session) => ({
    filePath: session.filePath,
    bytes: session.bytes,
    lastModifiedMs: session.lastModifiedMs,
    turnIds: session.turnIds,
  }));
  const fingerprint = createHash('sha256').update(JSON.stringify(fingerprintInput)).digest('hex');
  return {
    fingerprint,
    sessionCount: sessions.length,
    turnCount: turnIds.length,
    turnIds,
    latestModifiedMs: sessions.reduce((latest, session) => Math.max(latest, session.lastModifiedMs || 0), 0),
    sessions,
  };
}

export function sourceCodexActivityChanged(previous, next) {
  if (!previous || !next) return false;
  return previous.fingerprint !== next.fingerprint;
}

export function countNewSourceCodexTurns(previous, next) {
  const previousIds = new Set(previous?.turnIds || []);
  return (next?.turnIds || []).filter((turnId) => !previousIds.has(turnId)).length;
}

function inspectSourceCodexTurns({ filePath, projectRoot }) {
  let stat;
  let text = '';
  try {
    stat = statSync(filePath);
    text = readFileSync(filePath, 'utf8');
  } catch {
    return {
      filePath: resolve(filePath),
      projectRelevant: false,
      bytes: 0,
      lastModifiedMs: 0,
      turnIds: [],
    };
  }

  const root = resolve(projectRoot);
  const turnIds = [];
  let projectRelevant = false;
  let lineNo = 0;
  for (const line of text.split('\n')) {
    lineNo += 1;
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      const payload = event.payload || {};
      const cwd = event.cwd || payload.cwd || payload.session?.cwd;
      if (typeof cwd === 'string' && resolve(cwd) === root) projectRelevant = true;
      if (event.type === 'event_msg' && payload.type === 'task_complete') {
        const turnId = payload.turn_id || payload.turnId || `line-${lineNo}`;
        turnIds.push(`${resolve(filePath)}:${turnId}`);
      }
    } catch {}
  }

  return {
    filePath: resolve(filePath),
    projectRelevant,
    bytes: stat.size,
    lastModifiedMs: stat.mtimeMs,
    turnIds,
  };
}

function startQueuedMaintainerTurn({ projectRoot, args, changedFiles, triggerMessage, logger }) {
  const state = { done: false, promise: null };
  state.promise = runMaintainerTurn({ projectRoot, args, changedFiles, triggerMessage, logger })
    .catch((error) => {
      logEvent(logger, 'maintainer.turn.error', {
        project_root: projectRoot,
        message: error.message,
        level: 'error',
      });
    })
    .finally(() => {
      state.done = true;
    });
  return state;
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
  state.set(rel, `${stat.size}:${stat.mtimeMs}`);
}

function shouldSkipPath(rel, name) {
  if (!rel || rel === '.') return false;
  if ([
    '.git',
    'node_modules',
    '.agentic-ai',
    'runtime',
    'dist',
    'build',
    'coverage',
    '__pycache__',
    '.pytest_cache',
    '.mypy_cache',
    '.ruff_cache',
    '.tox',
    '.venv',
    'venv',
  ].includes(name)) return true;
  if (/\.(?:pyc|pyo)$/i.test(name)) return true;
  if (rel.startsWith('.git/') || rel.startsWith('node_modules/') || rel.startsWith('.agentic-ai/')) return true;
  return false;
}
