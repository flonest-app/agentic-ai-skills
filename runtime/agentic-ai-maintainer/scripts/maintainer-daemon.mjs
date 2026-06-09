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
import { getEvidenceFileCursor } from './read-conversation-slice.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const DEFAULT_SOURCE_CONTEXT_WINDOW_TOKENS = 258400;
const DEFAULT_SOURCE_CONTEXT_TRIGGER_PERCENT = 50;

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
  const sourceContextTriggerPercent = boundedPercent(
    args.sourceContextPercent || process.env.AGENTIC_AI_TRIGGER_CONTEXT_PERCENT || DEFAULT_SOURCE_CONTEXT_TRIGGER_PERCENT,
  );
  const sourceContextWindowTokens = Math.max(
    1,
    Number(args.sourceContextWindowTokens || process.env.AGENTIC_AI_SOURCE_CONTEXT_WINDOW_TOKENS || DEFAULT_SOURCE_CONTEXT_WINDOW_TOKENS),
  );
  logEvent(logger, 'watch.started', {
    project_root: projectRoot,
    idle_ms: idleMs,
    poll_ms: pollMs,
    source_context_trigger_percent: sourceContextTriggerPercent,
    source_context_window_tokens: sourceContextWindowTokens,
  });
  let sourceTurnState = collectSourceCodexTurnState({
    projectRoot,
    sourceCodexHome: args.sourceCodexHome,
    sourceContextWindowTokens,
  });
  let lastSourcePollAt = 0;
  let lastSourceActivityAt = null;
  let activeTurn = null;
  let lastTriggeredFingerprint = null;

  if (sourceContextThresholdReached(sourceTurnState, sourceContextTriggerPercent)) {
    logEvent(logger, 'watch.source_context', {
      project_root: projectRoot,
      unread_context_percent: sourceTurnState.unreadContextPercent,
      unread_estimated_tokens: sourceTurnState.unreadEstimatedTokens,
      source_context_trigger_percent: sourceContextTriggerPercent,
      unread_turn_count: sourceTurnState.unreadTurnCount,
      session_count: sourceTurnState.sessionCount,
    });
    lastTriggeredFingerprint = sourceTurnState.fingerprint;
    activeTurn = startSourceContextReview({
      projectRoot,
      args,
      logger,
      sourceTurnState,
      sourceContextTriggerPercent,
      reason: 'startup',
    });
  }

  while (!shouldStop({ projectRoot })) {
    await sleep(pollMs);
    if (activeTurn) {
      if (activeTurn.done) {
        await activeTurn.promise;
        activeTurn = null;
        sourceTurnState = collectSourceCodexTurnState({
          projectRoot,
          sourceCodexHome: args.sourceCodexHome,
          sourceContextWindowTokens,
        });
        lastSourcePollAt = 0;
        lastSourceActivityAt = null;
        if (
          sourceContextThresholdReached(sourceTurnState, sourceContextTriggerPercent)
          && sourceTurnState.fingerprint !== lastTriggeredFingerprint
        ) {
          logEvent(logger, 'watch.source_context', {
            project_root: projectRoot,
            unread_context_percent: sourceTurnState.unreadContextPercent,
            unread_estimated_tokens: sourceTurnState.unreadEstimatedTokens,
            source_context_trigger_percent: sourceContextTriggerPercent,
            unread_turn_count: sourceTurnState.unreadTurnCount,
            session_count: sourceTurnState.sessionCount,
          });
          lastTriggeredFingerprint = sourceTurnState.fingerprint;
          activeTurn = startSourceContextReview({
            projectRoot,
            args,
            logger,
            sourceTurnState,
            sourceContextTriggerPercent,
            reason: 'backlog',
          });
        }
      }
      continue;
    }

    const now = Date.now();
    if (now - lastSourcePollAt >= Math.max(3000, pollMs)) {
      lastSourcePollAt = now;
      const nextSourceTurnState = collectSourceCodexTurnState({
        projectRoot,
        sourceCodexHome: args.sourceCodexHome,
        sourceContextWindowTokens,
      });
      const newTurnCount = countNewSourceCodexTurns(sourceTurnState, nextSourceTurnState);
      const nextThresholdReached = sourceContextThresholdReached(nextSourceTurnState, sourceContextTriggerPercent);
      if (newTurnCount > 0 || nextThresholdReached) {
        lastSourceActivityAt = now;
        logEvent(logger, 'watch.source_context', {
          project_root: projectRoot,
          new_turn_count: newTurnCount,
          unread_context_percent: nextSourceTurnState.unreadContextPercent,
          unread_estimated_tokens: nextSourceTurnState.unreadEstimatedTokens,
          source_context_trigger_percent: sourceContextTriggerPercent,
          unread_turn_count: nextSourceTurnState.unreadTurnCount,
          session_count: nextSourceTurnState.sessionCount,
        });
      } else if (sourceCodexActivityChanged(sourceTurnState, nextSourceTurnState)) {
        lastSourceActivityAt = now;
        logEvent(logger, 'watch.conversation_change', {
          project_root: projectRoot,
          candidate_count: nextSourceTurnState.sessionCount,
          unread_context_percent: nextSourceTurnState.unreadContextPercent,
        });
      }
      sourceTurnState = nextSourceTurnState;
    }

    if (
      sourceContextThresholdReached(sourceTurnState, sourceContextTriggerPercent)
      && lastSourceActivityAt
      && Date.now() - lastSourceActivityAt >= idleMs
      && sourceTurnState.fingerprint !== lastTriggeredFingerprint
    ) {
      lastSourceActivityAt = null;
      lastTriggeredFingerprint = sourceTurnState.fingerprint;
      activeTurn = startSourceContextReview({
        projectRoot,
        args,
        logger,
        sourceTurnState,
        sourceContextTriggerPercent,
        reason: 'idle',
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
    else if (arg === '--source-context-percent') parsed.sourceContextPercent = Number(argv[++i]);
    else if (arg === '--source-context-window-tokens') parsed.sourceContextWindowTokens = Number(argv[++i]);
    else if (arg === '--json') {}
    else if (arg === '--help') {
      console.log('Usage: maintainer-daemon.mjs [--project-root repo] [--interval-minutes 60] [--watch] [--idle-ms 10000] [--source-context-percent 50] [--message text] [--conversation-file path] [--history-root path] [--source-codex-home path]');
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
  cursorPath,
  sourceContextWindowTokens = DEFAULT_SOURCE_CONTEXT_WINDOW_TOKENS,
  limit = null,
} = {}) {
  const paths = getMaintainerPaths({ projectRoot, sourceCodexHome });
  const evidenceCursorPath = cursorPath || join(paths.stateRoot, 'evidence-cursors.json');
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
      cursorPath: evidenceCursorPath,
      fallbackContextWindowTokens: sourceContextWindowTokens,
    }))
    .filter((session) => session.projectRelevant)
    .sort((a, b) => a.filePath.localeCompare(b.filePath));
  const turnIds = Array.from(new Set(sessions.flatMap((session) => session.turnIds))).sort();
  const unreadTurnIds = Array.from(new Set(sessions.flatMap((session) => session.unreadTurnIds))).sort();
  const unreadEstimatedTokens = sessions.reduce((sum, session) => sum + session.unreadEstimatedTokens, 0);
  const discoveredContextWindows = sessions
    .map((session) => session.sourceContextWindowTokens)
    .filter((value) => Number.isFinite(value) && value > 0);
  const sourceContextWindow = discoveredContextWindows.length > 0
    ? Math.max(...discoveredContextWindows)
    : Math.max(1, Number(sourceContextWindowTokens) || DEFAULT_SOURCE_CONTEXT_WINDOW_TOKENS);
  const estimatedContextPercent = (unreadEstimatedTokens / sourceContextWindow) * 100;
  const tokenUsageContextPercent = sessions.reduce((max, session) => Math.max(max, session.unreadTokenUsageContextPercent || 0), 0);
  const unreadContextPercent = Math.round(Math.max(estimatedContextPercent, tokenUsageContextPercent));
  const fingerprintInput = sessions.map((session) => ({
    filePath: session.filePath,
    bytes: session.bytes,
    lastModifiedMs: session.lastModifiedMs,
    turnIds: session.turnIds,
    unreadTurnIds: session.unreadTurnIds,
    unreadEstimatedTokens: session.unreadEstimatedTokens,
    unreadTokenUsageContextPercent: session.unreadTokenUsageContextPercent,
  }));
  const fingerprint = createHash('sha256').update(JSON.stringify(fingerprintInput)).digest('hex');
  return {
    fingerprint,
    sessionCount: sessions.length,
    turnCount: turnIds.length,
    turnIds,
    unreadTurnCount: unreadTurnIds.length,
    unreadTurnIds,
    unreadEstimatedTokens,
    sourceContextWindowTokens: sourceContextWindow,
    unreadContextPercent: Math.max(0, Math.min(100, unreadContextPercent)),
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

function inspectSourceCodexTurns({
  filePath,
  projectRoot,
  cursorPath,
  fallbackContextWindowTokens = DEFAULT_SOURCE_CONTEXT_WINDOW_TOKENS,
}) {
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
      unreadTurnIds: [],
      unreadEstimatedTokens: 0,
      unreadTokenUsageContextPercent: 0,
      sourceContextWindowTokens: Math.max(1, Number(fallbackContextWindowTokens) || DEFAULT_SOURCE_CONTEXT_WINDOW_TOKENS),
    };
  }

  const root = resolve(projectRoot);
  const unreadStartLine = getEvidenceFileCursor({ filePath: resolve(filePath), cursorPath }).line;
  const turns = new Map();
  let projectRelevant = false;
  let lineNo = 0;
  let currentTurnId = null;
  let sessionMatchesProject = false;

  const ensureTurn = (turnId) => {
    const id = turnId || currentTurnId || `line-${lineNo}`;
    if (!turns.has(id)) {
      turns.set(id, {
        completed: false,
        meaningful: false,
        projectRelevant: sessionMatchesProject,
        unreadEstimatedTokens: 0,
        unread: false,
        unreadTokenUsageContextPercent: 0,
        sourceContextWindowTokens: 0,
      });
    }
    return { id, turn: turns.get(id) };
  };

  for (const line of text.split('\n')) {
    lineNo += 1;
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      const payload = event.payload || {};
      const cwd = event.cwd || payload.cwd || payload.session?.cwd;
      const cwdMatchesProject = typeof cwd === 'string' && resolve(cwd) === root;
      if (cwdMatchesProject) {
        projectRelevant = true;
        if (event.type === 'session_meta') sessionMatchesProject = true;
      }
      if (event.type === 'turn_context') {
        currentTurnId = payload.turn_id || payload.turnId || event.turn_id || event.turnId || `line-${lineNo}`;
        const { turn } = ensureTurn(currentTurnId);
        if (cwdMatchesProject || sessionMatchesProject) turn.projectRelevant = true;
        continue;
      }

      const payloadTurnId = payload.turn_id || payload.turnId || event.turn_id || event.turnId;
      const isUnreadLine = lineNo > unreadStartLine;
      if (event.type === 'event_msg' && payload.type === 'task_complete') {
        const { turn } = ensureTurn(payloadTurnId);
        turn.completed = true;
        if (hasText(payload.last_agent_message)) turn.meaningful = true;
        if (cwdMatchesProject || sessionMatchesProject) turn.projectRelevant = true;
        if (isUnreadLine) turn.unread = true;
        continue;
      }

      if (event.type === 'event_msg' && payload.type === 'token_count') {
        const { turn } = ensureTurn(payloadTurnId);
        const tokenUsage = tokenUsageContext(payload);
        if (tokenUsage) {
          turn.sourceContextWindowTokens = tokenUsage.contextWindow;
          if (isUnreadLine) {
            turn.unread = true;
            turn.unreadTokenUsageContextPercent = Math.max(
              turn.unreadTokenUsageContextPercent,
              tokenUsage.contextPercent,
            );
          }
        }
        if (cwdMatchesProject || sessionMatchesProject) turn.projectRelevant = true;
        continue;
      }

      if (isMeaningfulSourceCodexActivity(event, payload)) {
        const { turn } = ensureTurn(payloadTurnId);
        turn.meaningful = true;
        if (cwdMatchesProject || sessionMatchesProject) turn.projectRelevant = true;
      }

      if (isUnreadLine && isSemanticSourceEvidence(event, payload)) {
        const { turn } = ensureTurn(payloadTurnId);
        const tokens = estimateEventTokens(payload);
        if (tokens > 0) {
          turn.unread = true;
          turn.unreadEstimatedTokens += tokens;
        }
      }
    } catch {}
  }

  const meaningfulTurns = Array.from(turns.entries())
    .filter(([, turn]) => turn.projectRelevant && turn.completed && turn.meaningful);
  const turnIds = meaningfulTurns.map(([turnId]) => `${resolve(filePath)}:${turnId}`);
  const unreadTurns = meaningfulTurns.filter(([, turn]) => turn.unread);
  const unreadTurnIds = unreadTurns.map(([turnId]) => `${resolve(filePath)}:${turnId}`);
  const unreadEstimatedTokens = unreadTurns.reduce((sum, [, turn]) => sum + turn.unreadEstimatedTokens, 0);
  const sourceContextWindowTokens = Math.max(
    1,
    ...meaningfulTurns
      .map(([, turn]) => turn.sourceContextWindowTokens)
      .filter((value) => Number.isFinite(value) && value > 0),
    Number(fallbackContextWindowTokens) || DEFAULT_SOURCE_CONTEXT_WINDOW_TOKENS,
  );
  const unreadTokenUsageContextPercent = unreadTurns.reduce(
    (max, [, turn]) => Math.max(max, turn.unreadTokenUsageContextPercent || 0),
    0,
  );

  return {
    filePath: resolve(filePath),
    projectRelevant,
    bytes: stat.size,
    lastModifiedMs: stat.mtimeMs,
    turnIds,
    unreadTurnIds,
    unreadEstimatedTokens,
    unreadTokenUsageContextPercent,
    sourceContextWindowTokens,
  };
}

function isMeaningfulSourceCodexActivity(event, payload) {
  if (event.type === 'response_item' && payload.type === 'message' && payload.role === 'assistant') {
    return hasText(extractMessageText(payload));
  }
  if (event.type === 'event_msg' && payload.type === 'agent_message') {
    return hasText(payload.message);
  }
  if (event.type === 'response_item' && payload.type === 'function_call') return true;
  if (event.type === 'response_item' && payload.type === 'function_call_output') return true;
  return false;
}

function isSemanticSourceEvidence(event, payload) {
  if (event.type === 'response_item' && payload.type === 'message') {
    return ['user', 'assistant'].includes(payload.role) && hasText(extractMessageText(payload));
  }
  if (event.type === 'event_msg' && ['user_message', 'agent_message'].includes(payload.type)) {
    return hasText(payload.message);
  }
  if (event.type === 'response_item' && payload.type === 'function_call') {
    return hasText(payload.arguments) || hasText(payload.name);
  }
  if (event.type === 'response_item' && payload.type === 'function_call_output') {
    return hasText(payload.output);
  }
  return false;
}

function estimateEventTokens(payload) {
  const text = [
    extractMessageText(payload),
    extractText(payload.message),
    extractText(payload.arguments),
    extractText(payload.output),
  ].filter(Boolean).join('\n');
  if (!text) return 0;
  return Math.ceil(Buffer.byteLength(text, 'utf8') / 4);
}

function tokenUsageContext(payload) {
  const info = payload.info || {};
  const usage = info.last_token_usage || info.lastTokenUsage || {};
  const contextWindow = Number(info.model_context_window || info.modelContextWindow || 0);
  const totalTokens = Number(usage.total_tokens || usage.totalTokens || 0);
  if (!Number.isFinite(contextWindow) || contextWindow <= 0 || !Number.isFinite(totalTokens) || totalTokens <= 0) {
    return null;
  }
  return {
    contextWindow,
    totalTokens,
    contextPercent: Math.max(0, Math.min(100, Math.round((totalTokens / contextWindow) * 100))),
  };
}

function extractMessageText(payload) {
  if (typeof payload.content === 'string') return payload.content;
  if (!Array.isArray(payload.content)) return '';
  return payload.content
    .map((item) => {
      if (!item || typeof item !== 'object') return '';
      return item.text || item.output_text || item.input_text || '';
    })
    .join('\n');
}

function extractText(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((item) => extractText(item)).filter(Boolean).join('\n');
  if (typeof value === 'object') return value.text || value.output_text || value.input_text || value.content || '';
  return String(value);
}

function hasText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function boundedPercent(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_SOURCE_CONTEXT_TRIGGER_PERCENT;
  return Math.max(1, Math.min(100, Math.round(parsed)));
}

function sourceContextThresholdReached(state, triggerPercent = DEFAULT_SOURCE_CONTEXT_TRIGGER_PERCENT) {
  return Number(state?.unreadTurnCount || 0) > 0
    && Number(state?.unreadContextPercent || 0) >= boundedPercent(triggerPercent);
}

function startSourceContextReview({
  projectRoot,
  args,
  logger,
  sourceTurnState,
  sourceContextTriggerPercent,
  reason,
}) {
  logEvent(logger, 'watch.idle_trigger', {
    project_root: projectRoot,
    reason,
    unread_context_percent: sourceTurnState.unreadContextPercent,
    unread_estimated_tokens: sourceTurnState.unreadEstimatedTokens,
    source_context_trigger_percent: sourceContextTriggerPercent,
    unread_turn_count: sourceTurnState.unreadTurnCount,
  });
  return startQueuedMaintainerTurn({
    projectRoot,
    args,
    changedFiles: [],
    triggerMessage: `Unread source Codex context reached ${sourceTurnState.unreadContextPercent}% of the effective context window, above the ${sourceContextTriggerPercent}% maintainer trigger. Review unread coding-agent conversation evidence first, then AGENTS.md and managed skills.`,
    logger,
  });
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
