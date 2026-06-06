#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { initRegistry, listManagedSkills } from './managed-registry.mjs';
import { runAppServerTask } from './appserver-task.mjs';
import { processMaintainerOutput } from './proposal-controller.mjs';
import { listPendingLabserverRequests, syncLabserverRequests } from './labserver-sync.mjs';
import { reconcileSignedManagedSkills } from './reconcile-signed-skills.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const skillRoot = resolve(scriptDir, '..');

export const DEFAULT_STATE_DIR = '.agentic-ai';
export const DEFAULT_MAINTAINER_SKILL_ID = 'agentic-ai-maintainer';
export const DEFAULT_LABSERVER_URL = 'https://lab.agi.flonest.app';
export const STATUS = {
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  READY: 'READY',
  RUNNING: 'RUNNING',
  COMPLETED: 'COMPLETED',
  STOPPED: 'STOPPED',
  ERROR: 'ERROR',
};

export function getAgenticAiHome() {
  return resolve(process.env.AGENTIC_AI_HOME || join(homedir(), '.agentic-ai'));
}

export function getProjectId(projectRoot = process.cwd()) {
  return createHash('sha256').update(resolve(projectRoot)).digest('hex').slice(0, 16);
}

export function getLabserverUrl() {
  const configured = process.env.AGENTIC_AI_LABSERVER_URL;
  if (configured === undefined || configured === '') return DEFAULT_LABSERVER_URL;
  if (/^(?:0|false|off|none)$/i.test(configured.trim())) return '';
  return configured;
}

export function getMaintainerPaths({
  projectRoot = process.cwd(),
  stateDir = DEFAULT_STATE_DIR,
  codexHome,
  sourceCodexHome,
  agenticAiHome = getAgenticAiHome(),
} = {}) {
  const root = resolve(projectRoot);
  const stateRoot = resolve(root, stateDir);
  const globalHome = resolve(agenticAiHome);
  const projectId = getProjectId(root);
  const runtimeProjectDir = join(globalHome, 'projects', projectId);
  const hiddenCodexHome = resolve(codexHome || join(globalHome, 'codex-home'));
  const userCodexHome = resolve(sourceCodexHome || process.env.AGENTIC_AI_SOURCE_CODEX_HOME || join(homedir(), '.codex'));
  const maintainerSkillDir = join(hiddenCodexHome, 'skills', DEFAULT_MAINTAINER_SKILL_ID);
  return {
    projectRoot: root,
    stateRoot,
    globalHome,
    projectId,
    runtimeProjectDir,
    codexHome: hiddenCodexHome,
    sourceCodexHome: userCodexHome,
    maintainerSkillDir,
    maintainerSkillPath: join(maintainerSkillDir, 'SKILL.md'),
    logsDir: join(stateRoot, 'logs'),
    inboxDir: join(stateRoot, 'inbox'),
    outboxDir: join(stateRoot, 'outbox'),
    patchesDir: join(stateRoot, 'patches'),
    configPath: join(stateRoot, 'maintainer-config.json'),
    statusPath: join(stateRoot, 'status.json'),
    threadRefPath: join(runtimeProjectDir, 'thread-ref.json'),
    pidPath: join(runtimeProjectDir, 'maintainer.pid'),
    stopPath: join(runtimeProjectDir, 'stop'),
    skillPath: join(skillRoot, 'MAINTAINER.md'),
    maintainerPromptPath: join(skillRoot, 'references', 'maintainer-agent-prompt.md'),
  };
}

export function initializeMaintainerState({
  projectRoot = process.cwd(),
  stateDir = DEFAULT_STATE_DIR,
  codexHome,
  sourceCodexHome,
  historyRoots = [],
  intervalMinutes = 60,
  model = 'gpt-5.5',
} = {}) {
  const paths = getMaintainerPaths({ projectRoot, stateDir, codexHome, sourceCodexHome });

  for (const dir of [paths.stateRoot, paths.globalHome, paths.runtimeProjectDir, paths.codexHome, paths.maintainerSkillDir, paths.logsDir, paths.inboxDir, paths.outboxDir, paths.patchesDir]) {
    mkdirSync(dir, { recursive: true });
  }
  installHiddenMaintainerSkill(paths);

  initRegistry({ projectRoot: paths.projectRoot });
  const managedSkills = listManagedSkills({ projectRoot: paths.projectRoot });
  const normalizedHistoryRoots = normalizeRoots(historyRoots, paths.projectRoot);
  const evidenceSources = buildConversationEvidenceSources({ paths, historyRoots: normalizedHistoryRoots });
  const writePolicy = buildWritablePolicy({ projectRoot: paths.projectRoot, managedSkills });
  const authReady = hasCodexAuth(paths.codexHome);
  const now = new Date().toISOString();

  const config = {
    schema_version: 1,
    project_root: paths.projectRoot,
    project_id: paths.projectId,
    labserver_url: getLabserverUrl() || null,
    agentic_ai_home: paths.globalHome,
    runtime_project_dir: paths.runtimeProjectDir,
    codex_home: paths.codexHome,
    source_codex_home: paths.sourceCodexHome,
    maintainer_skill_path: paths.maintainerSkillPath,
    thread_ref_path: paths.threadRefPath,
    codex_session_index_path: join(paths.codexHome, 'session_index.jsonl'),
    codex_sessions_dir: join(paths.codexHome, 'sessions'),
    source_codex_session_index_path: join(paths.sourceCodexHome, 'session_index.jsonl'),
    source_codex_sessions_dir: join(paths.sourceCodexHome, 'sessions'),
    model,
    interval_minutes: intervalMinutes,
    conversation_evidence_sources: evidenceSources,
    read_roots: Array.from(new Set([paths.projectRoot, ...evidenceSources.map((source) => source.path)])),
    write_policy: writePolicy,
    skill_path: paths.skillPath,
    created_at: now,
    updated_at: now,
  };
  writeJson(paths.configPath, config);

  const status = writeMaintainerStatus({
    projectRoot: paths.projectRoot,
    stateDir,
    status: authReady ? STATUS.READY : STATUS.AUTH_REQUIRED,
    pid: null,
    message: authReady
      ? 'Maintainer is initialized and ready.'
      : 'Codex auth required. Run `agi`; first-time login starts automatically.',
    extra: {
      project_id: paths.projectId,
      agentic_ai_home: paths.globalHome,
      runtime_project_dir: paths.runtimeProjectDir,
      codex_home: paths.codexHome,
      source_codex_home: paths.sourceCodexHome,
      maintainer_skill_path: paths.maintainerSkillPath,
      thread_ref_path: paths.threadRefPath,
      codex_session_index_path: join(paths.codexHome, 'session_index.jsonl'),
      codex_sessions_dir: join(paths.codexHome, 'sessions'),
      source_codex_session_index_path: join(paths.sourceCodexHome, 'session_index.jsonl'),
      source_codex_sessions_dir: join(paths.sourceCodexHome, 'sessions'),
      conversation_evidence_sources: evidenceSources,
      inbox_dir: paths.inboxDir,
      outbox_dir: paths.outboxDir,
      managed_skill_count: managedSkills.length,
    },
  });

  return { paths, config, status };
}

export function hasCodexAuth(codexHome) {
  return existsSync(join(codexHome, 'auth.json'));
}

export function buildWritablePolicy({ projectRoot = process.cwd(), managedSkills = [] } = {}) {
  const root = resolve(projectRoot);
  const paths = [
    'AGENTS.md',
    DEFAULT_STATE_DIR,
    ...managedSkills.map((skill) => skill.relative_path).filter(Boolean),
  ];

  return {
    mode: 'controller-mediated',
    allow: Array.from(new Set(paths)).map((path) => path.replaceAll('\\', '/')),
    deny: ['**/.env*', '**/*secret*', '**/runtime/**', '**/.git/**'],
    note: 'Codex app-server proposes changes. The controller may apply project writes only to AGENTS.md, .agentic-ai, and registered managed skills. The hidden maintainer skill and Codex auth live under ~/.agentic-ai, outside the project write policy.',
    project_root: root,
  };
}

export function buildMaintainerPrompt({
  projectRoot = process.cwd(),
  historyRoots = [],
  evidenceSources,
  conversationFile,
  triggerMessage,
  managedSkills = [],
  revisionRequests = [],
  maintainerPromptPath = getMaintainerPaths({ projectRoot }).maintainerPromptPath,
} = {}) {
  const paths = getMaintainerPaths({ projectRoot });
  const sources = evidenceSources || buildConversationEvidenceSources({
    paths,
    historyRoots: normalizeRoots(historyRoots, projectRoot),
  });
  return [
    readFileSync(maintainerPromptPath, 'utf8').trim(),
    '',
    'Controller message:',
    triggerMessage ? triggerMessage : 'Run a project maintenance pass from the latest available durable evidence.',
    '',
    `Project root: ${projectRoot}`,
    `Conversation file: ${conversationFile || 'none provided'}`,
    `History roots: ${historyRoots.length > 0 ? historyRoots.join(', ') : 'none configured'}`,
    'Conversation evidence sources:',
    sources.length > 0
      ? sources.map((source) => `- ${source.kind}: ${source.path}`).join('\n')
      : '- none configured',
    `Managed skills: ${managedSkills.length > 0 ? managedSkills.map((skill) => skill.skill_id).join(', ') : 'none registered'}`,
    'Pending labserver revision requests:',
    revisionRequests.length > 0
      ? revisionRequests.map(formatRevisionRequestForPrompt).join('\n')
      : '- none',
  ].join('\n');
}

export async function runMaintenanceOnce({
  projectRoot = process.cwd(),
  stateDir = DEFAULT_STATE_DIR,
  codexHome,
  sourceCodexHome,
  historyRoots = [],
  conversationFile,
  triggerMessage,
  model = 'gpt-5.5',
} = {}) {
  const { paths } = initializeMaintainerState({ projectRoot, stateDir, codexHome, sourceCodexHome, historyRoots, model });
  if (!hasCodexAuth(paths.codexHome)) {
    return readMaintainerStatus({ projectRoot, stateDir });
  }

  const managedSkills = listManagedSkills({ projectRoot: paths.projectRoot });
  const labserverUrl = getLabserverUrl();
  let signedReconcile = null;
  if (process.env.AGENTIC_AI_AUTO_RECONCILE_SIGNED !== 'false') {
    try {
      signedReconcile = await reconcileSignedManagedSkills({ projectRoot: paths.projectRoot });
    } catch (error) {
      signedReconcile = { status: 'error', reason: error.message };
    }
  }
  let inboundSync = null;
  try {
    inboundSync = await syncLabserverRequests({
      projectRoot: paths.projectRoot,
      inboxDir: paths.inboxDir,
      projectId: paths.projectId,
      labserverUrl,
    });
  } catch (error) {
    inboundSync = { status: 'error', reason: error.message };
  }
  const revisionRequests = listPendingLabserverRequests({ inboxDir: paths.inboxDir });
  const threadRef = readProjectThreadRef(paths);
  const normalizedHistoryRoots = normalizeRoots(historyRoots, paths.projectRoot);
  const evidenceSources = buildConversationEvidenceSources({ paths, historyRoots: normalizedHistoryRoots });
  const prompt = buildMaintainerPrompt({
    projectRoot: paths.projectRoot,
    historyRoots: normalizedHistoryRoots,
    evidenceSources,
    conversationFile: conversationFile ? resolve(paths.projectRoot, conversationFile) : null,
    triggerMessage,
    managedSkills,
    revisionRequests,
  });

  writeMaintainerStatus({
    projectRoot: paths.projectRoot,
    stateDir,
    status: STATUS.RUNNING,
    pid: process.pid,
    message: 'Running one maintainer app-server turn.',
  });

  try {
    const result = await runAppServerTask({
      cwd: paths.projectRoot,
      codexHome: paths.codexHome,
      model,
      prompt,
      threadId: threadRef.thread_id,
      skillPath: paths.maintainerSkillPath,
      skillName: DEFAULT_MAINTAINER_SKILL_ID,
      stream: false,
      approvalPolicy: 'never',
      sandbox: 'workspaceWrite',
      serviceName: 'agentic_ai_maintainer',
    });

    if (result.authRequired) {
      return writeMaintainerStatus({
        projectRoot: paths.projectRoot,
        stateDir,
        status: STATUS.AUTH_REQUIRED,
        pid: null,
        message: 'Codex auth required. Run `agi`; first-time login starts automatically.',
      });
    }

    const nextThreadRef = writeProjectThreadRef(paths, {
      ...threadRef,
      thread_id: result.threadId,
      last_turn_id: result.turnId,
      last_trigger_message: triggerMessage || null,
      last_conversation_file: conversationFile ? resolve(paths.projectRoot, conversationFile) : null,
    });
    const timestamp = new Date().toISOString().replaceAll(':', '-');
    const controller = await processMaintainerOutput({
      projectRoot: paths.projectRoot,
      paths,
      output: result.output,
      labserverUrl,
    });
    const patchPath = join(paths.patchesDir, `${timestamp}.json`);

    writeJson(patchPath, {
      schema_version: 1,
      kind: 'local-maintainer-private-proposal',
      thread_id: result.threadId,
      turn_id: result.turnId,
      raw_output: result.output,
      parsed_output: controller.parsed,
      proposal_results: controller.proposal_results,
      outbox_results: controller.outbox_results,
      submission: controller.submission,
      inbound_sync: inboundSync,
      signed_reconcile: signedReconcile,
      revision_requests: revisionRequests.map((request) => request.request_id),
      trigger_message: triggerMessage || null,
      conversation_file: conversationFile ? resolve(paths.projectRoot, conversationFile) : null,
      created_at: new Date().toISOString(),
    });

    return writeMaintainerStatus({
      projectRoot: paths.projectRoot,
      stateDir,
      status: STATUS.COMPLETED,
      pid: null,
      message: 'Maintainer turn completed.',
      extra: {
        last_patch: patchPath,
        outbox_results: controller.outbox_results,
        submission: controller.submission,
        inbound_sync: inboundSync,
        signed_reconcile: signedReconcile,
        pending_revision_request_count: revisionRequests.length,
        thread_id: result.threadId,
        turn_id: result.turnId,
        reused_thread: result.reusedThread,
        thread_ref_path: paths.threadRefPath,
        thread_ref_updated_at: nextThreadRef.updated_at,
        codex_session_index_path: join(paths.codexHome, 'session_index.jsonl'),
        codex_sessions_dir: join(paths.codexHome, 'sessions'),
        source_codex_session_index_path: join(paths.sourceCodexHome, 'session_index.jsonl'),
        source_codex_sessions_dir: join(paths.sourceCodexHome, 'sessions'),
        conversation_evidence_sources: evidenceSources,
      },
    });
  } catch (err) {
    return writeMaintainerStatus({
      projectRoot: paths.projectRoot,
      stateDir,
      status: STATUS.ERROR,
      pid: null,
      message: err.message,
    });
  }
}

function formatRevisionRequestForPrompt(request) {
  return [
    `- request_id: ${request.request_id}`,
    `  source: ${request.source?.kind || 'unknown'} ${request.source?.repo || ''}#${request.source?.number || ''}`.trimEnd(),
    `  request: ${String(request.sanitized_request || '').replace(/\s+/g, ' ').slice(0, 500)}`,
    '  response: emit a sanitized upstream proposal with "response_to" set to this request_id',
  ].join('\n');
}

export function readProjectThreadRef(paths) {
  const metadata = buildProjectThreadRefMetadata(paths);
  if (!existsSync(paths.threadRefPath)) {
    return {
      ...metadata,
      thread_id: null,
      last_turn_id: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
  }
  const stored = JSON.parse(readFileSync(paths.threadRefPath, 'utf8'));
  return {
    ...stored,
    ...metadata,
  };
}

export function writeProjectThreadRef(paths, threadRef) {
  const existingCreatedAt = threadRef.created_at || new Date().toISOString();
  const next = {
    ...threadRef,
    ...buildProjectThreadRefMetadata(paths),
    created_at: existingCreatedAt,
    updated_at: new Date().toISOString(),
  };
  writeJson(paths.threadRefPath, next);
  return next;
}

function buildProjectThreadRefMetadata(paths) {
  return {
    schema_version: 1,
    project_id: paths.projectId,
    project_root: paths.projectRoot,
    codex_home: paths.codexHome,
    source_codex_home: paths.sourceCodexHome,
    codex_session_index_path: join(paths.codexHome, 'session_index.jsonl'),
    codex_sessions_dir: join(paths.codexHome, 'sessions'),
    source_codex_session_index_path: join(paths.sourceCodexHome, 'session_index.jsonl'),
    source_codex_sessions_dir: join(paths.sourceCodexHome, 'sessions'),
    conversation_evidence_sources: buildConversationEvidenceSources({ paths, historyRoots: [] }),
  };
}

export function buildConversationEvidenceSources({ paths, historyRoots = [] }) {
  const candidates = [
    { kind: 'project-conversation-summaries', path: join(paths.projectRoot, '.conversations') },
    { kind: 'source-codex-session-index', path: join(paths.sourceCodexHome, 'session_index.jsonl') },
    { kind: 'source-codex-sessions', path: join(paths.sourceCodexHome, 'sessions') },
    ...historyRoots.map((root) => ({ kind: 'provided-history-root', path: root })),
  ];
  const seen = new Set();
  return candidates
    .map((source) => ({ ...source, path: resolve(source.path) }))
    .filter((source) => {
      const key = `${source.kind}:${source.path}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

export function installHiddenMaintainerSkill(paths) {
  const body = readFileSync(paths.maintainerPromptPath, 'utf8').trim();
  materializeSkillSupport(paths);
  writeFileSync(paths.maintainerSkillPath, [
    '---',
    `name: ${DEFAULT_MAINTAINER_SKILL_ID}`,
    'description: Hidden Agentic AI maintainer skill for the local Codex app-server sidecar. Use only when CODEX_HOME points at the Agentic AI runtime home.',
    '---',
    '# Agentic AI Maintainer',
    '',
    'This skill is installed in the Agentic AI private Codex home, not in the normal user Codex home or project skill directory.',
    'Helper scripts are available beside this file under `scripts/`; use paths like `scripts/discover-project-conversations.mjs` when needed.',
    '',
    body,
    '',
  ].join('\n'));
  return paths.maintainerSkillPath;
}

function materializeSkillSupport(paths) {
  for (const name of ['scripts', 'references']) {
    const source = join(skillRoot, name);
    const target = join(paths.maintainerSkillDir, name);
    rmSync(target, { recursive: true, force: true });
    cpSync(source, target, { recursive: true });
  }
}

export function readMaintainerStatus({ projectRoot = process.cwd(), stateDir = DEFAULT_STATE_DIR } = {}) {
  const paths = getMaintainerPaths({ projectRoot, stateDir });
  if (!existsSync(paths.statusPath)) {
    return {
      schema_version: 1,
      status: 'NOT_INITIALIZED',
      message: 'Run start-maintainer.mjs first.',
      project_root: resolve(projectRoot),
    };
  }
  const status = JSON.parse(readFileSync(paths.statusPath, 'utf8'));
  return {
    ...status,
    pid_alive: status.pid ? isProcessAlive(status.pid) : false,
  };
}

export function writeMaintainerStatus({
  projectRoot = process.cwd(),
  stateDir = DEFAULT_STATE_DIR,
  status,
  pid = null,
  message = '',
  extra = {},
} = {}) {
  const paths = getMaintainerPaths({ projectRoot, stateDir });
  mkdirSync(paths.stateRoot, { recursive: true });
  mkdirSync(dirname(paths.pidPath), { recursive: true });
  const payload = {
    schema_version: 1,
    status,
    pid,
    pid_alive: pid ? isProcessAlive(pid) : false,
    project_root: resolve(projectRoot),
    message,
    updated_at: new Date().toISOString(),
    ...extra,
  };
  writeJson(paths.statusPath, payload);
  if (pid) writeFileSync(paths.pidPath, `${pid}\n`);
  return payload;
}

export function requestMaintainerStop({ projectRoot = process.cwd(), stateDir = DEFAULT_STATE_DIR } = {}) {
  const paths = getMaintainerPaths({ projectRoot, stateDir });
  mkdirSync(dirname(paths.stopPath), { recursive: true });
  writeFileSync(paths.stopPath, new Date().toISOString());
  let pid = null;
  if (existsSync(paths.pidPath)) pid = Number(readFileSync(paths.pidPath, 'utf8').trim());
  if (Number.isFinite(pid) && pid > 0 && isMaintainerDaemonProcess(pid, paths.projectRoot)) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {}
  }
  return writeMaintainerStatus({
    projectRoot,
    stateDir,
    status: STATUS.STOPPED,
    pid: null,
    message: 'Maintainer stop requested.',
  });
}

export function shouldStop({ projectRoot = process.cwd(), stateDir = DEFAULT_STATE_DIR } = {}) {
  return existsSync(getMaintainerPaths({ projectRoot, stateDir }).stopPath);
}

export function readPid(pidPath) {
  if (!existsSync(pidPath)) return null;
  const pid = Number(readFileSync(pidPath, 'utf8').trim());
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

export function isMaintainerDaemonProcess(pid, projectRoot = process.cwd()) {
  try {
    const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ');
    return cmdline.includes('maintainer-daemon.mjs') && cmdline.includes(resolve(projectRoot));
  } catch {
    return false;
  }
}

export function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function normalizeRoots(roots, projectRoot) {
  return roots.map((root) => resolve(projectRoot, root));
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}
