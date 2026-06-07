#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { childEnvForLogFormat, getLogFormat, stripLogArgs } from './user-log.mjs';
import {
  getMaintainerPaths,
  initializeMaintainerState,
  isMaintainerDaemonProcess,
  isProcessAlive,
  readPid,
  runMaintenanceOnce,
  writeMaintainerStatus,
} from './maintainer-runtime.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const rawArgv = process.argv.slice(2);
  const logFormat = getLogFormat({ argv: rawArgv });
  const args = parseArgs(stripLogArgs(rawArgv));
  const projectRoot = resolve(args.projectRoot || process.cwd());
  const childEnv = childEnvForLogFormat(process.env, logFormat);

  if (args.foreground) {
    const result = spawnSync(process.execPath, buildDaemonArgs({ scriptDir, projectRoot, args }), {
      cwd: projectRoot,
      stdio: 'inherit',
      env: childEnv,
    });
    process.exit(result.status ?? 1);
  }

  if (args.daemon) {
    const paths = getMaintainerPaths({ projectRoot, codexHome: args.codexHome, sourceCodexHome: args.sourceCodexHome });
    const existingPid = readPid(paths.pidPath);
    if (existingPid && isProcessAlive(existingPid) && isMaintainerDaemonProcess(existingPid, projectRoot)) {
      const status = writeMaintainerStatus({
        projectRoot,
        status: 'RUNNING',
        pid: existingPid,
        message: 'Maintainer daemon already running.',
      });
      console.log(JSON.stringify(status, null, 2));
      process.exit(0);
    }
    if (existsSync(paths.stopPath)) {
      try {
        unlinkSync(paths.stopPath);
      } catch {}
    }

    const child = spawn(process.execPath, buildDaemonArgs({ scriptDir, projectRoot, args }), {
      cwd: projectRoot,
      env: childEnv,
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    const status = writeMaintainerStatus({
      projectRoot,
      status: 'RUNNING',
      pid: child.pid,
      message: 'Maintainer daemon started.',
    });
    console.log(JSON.stringify(status, null, 2));
    process.exit(0);
  }

  const initialized = initializeMaintainerState({
    projectRoot,
    codexHome: args.codexHome,
    sourceCodexHome: args.sourceCodexHome,
    historyRoots: args.historyRoots,
    intervalMinutes: args.intervalMinutes,
    model: args.model,
  });

  if (!args.once) {
    console.log(JSON.stringify(initialized.status, null, 2));
    process.exit(initialized.status.status === 'AUTH_REQUIRED' ? 2 : 0);
  }

  console.error('Running Agentic AI maintainer turn. This can take a minute; diagnostics are saved under .agentic-ai/logs/.');
  const status = await runMaintenanceOnce({
    projectRoot,
    codexHome: args.codexHome,
    sourceCodexHome: args.sourceCodexHome,
    historyRoots: args.historyRoots,
    conversationFile: args.conversationFile,
    triggerMessage: args.message,
    model: args.model,
  });
  console.log(JSON.stringify(status, null, 2));
  process.exit(status.status === 'ERROR' ? 1 : status.status === 'AUTH_REQUIRED' ? 2 : 0);
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
    else if (arg === '--once') parsed.once = true;
    else if (arg === '--daemon') parsed.daemon = true;
    else if (arg === '--foreground') parsed.foreground = true;
    else if (arg === '--json') {}
    else if (arg === '--help') {
      console.log('Usage: start-maintainer.mjs [--project-root repo] [--once|--daemon|--foreground] [--watch] [--idle-ms 10000] [--message text] [--conversation-file path] [--history-root path] [--source-codex-home path]');
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return parsed;
}

function buildDaemonArgs({ scriptDir, projectRoot, args }) {
  return [
    resolve(scriptDir, 'maintainer-daemon.mjs'),
    '--project-root',
    projectRoot,
    '--interval-minutes',
    String(args.intervalMinutes || 60),
    '--model',
    args.model || 'gpt-5.5',
    ...args.historyRoots.flatMap((root) => ['--history-root', root]),
    ...(args.message ? ['--message', args.message] : []),
    ...(args.conversationFile ? ['--conversation-file', args.conversationFile] : []),
    ...(args.watch ? ['--watch'] : []),
    ...(args.idleMs ? ['--idle-ms', String(args.idleMs)] : []),
    ...(args.pollMs ? ['--poll-ms', String(args.pollMs)] : []),
    ...(args.codexHome ? ['--codex-home', args.codexHome] : []),
    ...(args.sourceCodexHome ? ['--source-codex-home', args.sourceCodexHome] : []),
  ];
}
