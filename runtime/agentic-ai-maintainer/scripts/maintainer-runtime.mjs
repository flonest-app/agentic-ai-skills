#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { initRegistry, listManagedSkills } from './managed-registry.mjs';
import {
  DEFAULT_CODEX_SANDBOX,
  hasAppServerModelActivity,
  hasExhaustedCodexCredits,
  runAppServerTask,
} from './appserver-task.mjs';
import { CODEX_ERROR_KINDS, classifyCodexError } from './codex-errors.mjs';
import { processMaintainerOutput } from './proposal-controller.mjs';
import { listPendingLabserverRequests, syncLabserverRequests } from './labserver-sync.mjs';
import { reconcileSignedManagedSkills } from './reconcile-signed-skills.mjs';
import { beginMaintainerProposal } from './write-maintainer-proposal.mjs';

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
  NO_MODEL_OUTPUT: 'NO_MODEL_OUTPUT',
  WAITING_FOR_CODEX_QUOTA: 'WAITING_FOR_CODEX_QUOTA',
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
    proposalsDir: join(stateRoot, 'proposals'),
    activeProposalPath: join(stateRoot, 'proposals', 'active.json'),
    turnContextPath: join(stateRoot, 'turn-context.json'),
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

  for (const dir of [paths.stateRoot, paths.globalHome, paths.runtimeProjectDir, paths.codexHome, paths.maintainerSkillDir, paths.logsDir, paths.inboxDir, paths.outboxDir, paths.patchesDir, paths.proposalsDir]) {
    mkdirSync(dir, { recursive: true });
  }
  installHiddenMaintainerSkill(paths);

  initRegistry({ projectRoot: paths.projectRoot });
  const managedSkills = listManagedSkills({ projectRoot: paths.projectRoot });
  const normalizedHistoryRoots = normalizeRoots(historyRoots, paths.projectRoot);
  const evidenceSources = buildConversationEvidenceSources({ paths, historyRoots: normalizedHistoryRoots });
  const evidencePolicy = buildConversationEvidencePolicy({ paths, evidenceSources });
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
    maintainer_proposal_file: paths.activeProposalPath,
    maintainer_turn_context_file: paths.turnContextPath,
    thread_ref_path: paths.threadRefPath,
    codex_session_index_path: join(paths.codexHome, 'session_index.jsonl'),
    codex_sessions_dir: join(paths.codexHome, 'sessions'),
    source_codex_session_index_path: join(paths.sourceCodexHome, 'session_index.jsonl'),
    source_codex_sessions_dir: join(paths.sourceCodexHome, 'sessions'),
    evidence_cursor_path: join(paths.stateRoot, 'evidence-cursors.json'),
    model,
    interval_minutes: intervalMinutes,
    conversation_evidence_policy: evidencePolicy,
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
      evidence_cursor_path: join(paths.stateRoot, 'evidence-cursors.json'),
      conversation_evidence_policy: evidencePolicy,
      conversation_evidence_sources: evidenceSources,
      inbox_dir: paths.inboxDir,
      outbox_dir: paths.outboxDir,
      proposals_dir: paths.proposalsDir,
      maintainer_proposal_file: paths.activeProposalPath,
      maintainer_turn_context_file: paths.turnContextPath,
      managed_skill_count: managedSkills.length,
    },
  });

  return { paths, config, status };
}

export function hasCodexAuth(codexHome) {
  return existsSync(join(codexHome, 'auth.json'));
}

export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
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
  triggerMessage,
  firstTurn = true,
} = {}) {
  const verb = firstTurn ? 'start' : 'continue';
  const goal = triggerMessage || 'maintaining this project';
  return `Use agentic-ai-maintainer skill: ${verb} ${goal}`;
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
  runAppServerTaskImpl = runAppServerTask,
  processMaintainerOutputImpl = processMaintainerOutput,
  beginMaintainerProposalImpl = beginMaintainerProposal,
  changedFiles = [],
} = {}) {
  const { paths } = initializeMaintainerState({ projectRoot, stateDir, codexHome, sourceCodexHome, historyRoots, model });
  if (!hasCodexAuth(paths.codexHome)) {
    return readMaintainerStatus({ projectRoot, stateDir });
  }

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
  const maintainerSkillHash = sha256File(paths.maintainerSkillPath);
  const firstTurn = !threadRef.thread_id;
  const normalizedHistoryRoots = normalizeRoots(historyRoots, paths.projectRoot);
  const evidenceSources = buildConversationEvidenceSources({ paths, historyRoots: normalizedHistoryRoots });
  const prompt = buildMaintainerPrompt({
    triggerMessage,
    firstTurn,
  });
  const activeProposal = beginMaintainerProposalImpl({
    projectRoot: paths.projectRoot,
    file: paths.activeProposalPath,
  });
  writeMaintainerTurnContext(paths, {
    triggerMessage,
    changedFiles,
    conversationFile,
    firstTurn,
  });

  writeMaintainerStatus({
    projectRoot: paths.projectRoot,
    stateDir,
    status: STATUS.RUNNING,
    pid: process.pid,
    message: 'Running one maintainer app-server turn.',
  });

  try {
    const result = await runAppServerTaskImpl({
      cwd: paths.projectRoot,
      codexHome: paths.codexHome,
      model,
      prompt,
      threadId: threadRef.thread_id,
      skillPath: null,
      fallbackSkillPath: null,
      skillName: DEFAULT_MAINTAINER_SKILL_ID,
      stream: false,
      approvalPolicy: 'never',
      sandbox: DEFAULT_CODEX_SANDBOX,
      serviceName: 'agentic_ai_maintainer',
      extraEnv: {
        AGENTIC_AI_PROPOSAL_FILE: paths.activeProposalPath,
        AGENTIC_AI_TURN_CONTEXT_FILE: paths.turnContextPath,
        AGENTIC_AI_PROJECT_ROOT: paths.projectRoot,
        AGENTIC_AI_CHANGED_FILES: JSON.stringify(normalizeChangedFiles(changedFiles)),
      },
    });

    if (result.authRequired) {
      return writeMaintainerStatus({
        projectRoot: paths.projectRoot,
        stateDir,
        status: STATUS.AUTH_REQUIRED,
        pid: null,
        message: 'Codex sign-in is required for Agentic AI.',
        extra: {
          codex_home: paths.codexHome,
          codex_error: result.codexError || classifyCodexError({ message: 'Codex authentication is required.' }),
          thread_ref_path: paths.threadRefPath,
          codex_session_index_path: join(paths.codexHome, 'session_index.jsonl'),
          codex_sessions_dir: join(paths.codexHome, 'sessions'),
          source_codex_session_index_path: join(paths.sourceCodexHome, 'session_index.jsonl'),
          source_codex_sessions_dir: join(paths.sourceCodexHome, 'sessions'),
          evidence_cursor_path: join(paths.stateRoot, 'evidence-cursors.json'),
        },
      });
    }

    const blockedStatus = statusForCodexError({
      codexError: result.codexError,
      paths,
      projectRoot: paths.projectRoot,
      stateDir,
    });
    if (blockedStatus) return blockedStatus;

    const nextThreadRef = writeProjectThreadRef(paths, {
      ...threadRef,
      thread_id: result.threadId,
      last_turn_id: result.turnId,
      maintainer_skill_sha256: maintainerSkillHash,
      last_trigger_message: triggerMessage || null,
      last_conversation_file: conversationFile ? resolve(paths.projectRoot, conversationFile) : null,
    });

    const proposalActivity = readProposalFileActivity(paths.activeProposalPath, activeProposal.document);
    const noModelOutput = (result.noModelOutput === true || !hasAppServerModelActivity(result.activity))
      && proposalActivity.proposal_count === 0
      && !proposalActivity.updated;
    if (noModelOutput) {
      const quotaStatus = hasExhaustedCodexCredits(result.rateLimits)
        ? statusForCodexError({
          codexError: classifyCodexError({ message: 'Codex usage limit reached.', rateLimits: result.rateLimits }),
          paths,
          projectRoot: paths.projectRoot,
          stateDir,
        })
        : null;
      if (quotaStatus) return quotaStatus;
      return writeMaintainerStatus({
        projectRoot: paths.projectRoot,
        stateDir,
        status: STATUS.NO_MODEL_OUTPUT,
        pid: null,
        message: 'Codex produced no maintainer output. Agentic AI will keep watching and retry later.',
        extra: {
          thread_id: result.threadId,
          turn_id: result.turnId,
          reused_thread: result.reusedThread,
          resume_error: result.resumeError || null,
          turn_start_error: result.turnStartError || null,
          first_turn: firstTurn,
          skill_attached: result.skillAttached,
          appserver_activity: result.activity || null,
          proposal_file_activity: proposalActivity,
          maintainer_proposal_file: activeProposal.path,
          maintainer_turn_context_file: paths.turnContextPath,
          thread_ref_path: paths.threadRefPath,
          thread_ref_updated_at: nextThreadRef.updated_at,
          codex_session_index_path: join(paths.codexHome, 'session_index.jsonl'),
          codex_sessions_dir: join(paths.codexHome, 'sessions'),
          source_codex_session_index_path: join(paths.sourceCodexHome, 'session_index.jsonl'),
          source_codex_sessions_dir: join(paths.sourceCodexHome, 'sessions'),
          conversation_evidence_sources: evidenceSources,
        },
      });
    }

    const timestamp = new Date().toISOString().replaceAll(':', '-');
    const controller = await processMaintainerOutputImpl({
      projectRoot: paths.projectRoot,
      paths,
      proposalFile: paths.activeProposalPath,
      labserverUrl,
    });
    const patchPath = join(paths.patchesDir, `${timestamp}.json`);

    writeJson(patchPath, {
      schema_version: 1,
      kind: 'local-maintainer-private-proposal',
      thread_id: result.threadId,
      turn_id: result.turnId,
      raw_output: result.output,
      proposal_file: activeProposal.path,
      parsed_output: controller.parsed,
      proposal_results: controller.proposal_results,
      outbox_results: controller.outbox_results,
      submission: controller.submission,
      inbound_sync: inboundSync,
      signed_reconcile: signedReconcile,
      revision_requests: revisionRequests.map((request) => request.request_id),
      first_turn: firstTurn,
      skill_attached: result.skillAttached,
      reused_thread: result.reusedThread,
      resume_error: result.resumeError || null,
      turn_start_error: result.turnStartError || null,
      appserver_activity: result.activity || null,
      maintainer_skill_sha256: maintainerSkillHash,
      trigger_message: triggerMessage || null,
      changed_files: normalizeChangedFiles(changedFiles),
      turn_context_file: paths.turnContextPath,
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
        proposal_results: controller.proposal_results,
        outbox_results: controller.outbox_results,
        submission: controller.submission,
        inbound_sync: inboundSync,
        signed_reconcile: signedReconcile,
        pending_revision_request_count: revisionRequests.length,
        thread_id: result.threadId,
        turn_id: result.turnId,
        reused_thread: result.reusedThread,
        resume_error: result.resumeError || null,
        turn_start_error: result.turnStartError || null,
        first_turn: firstTurn,
        skill_attached: result.skillAttached,
        appserver_activity: result.activity || null,
        maintainer_skill_sha256: maintainerSkillHash,
        maintainer_proposal_file: activeProposal.path,
        maintainer_turn_context_file: paths.turnContextPath,
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
    const codexError = classifyCodexError(err);
    const blockedStatus = statusForCodexError({
      codexError,
      paths,
      projectRoot: paths.projectRoot,
      stateDir,
      fallbackMessage: err.message,
    });
    if (blockedStatus) return blockedStatus;
    return writeMaintainerStatus({
      projectRoot: paths.projectRoot,
      stateDir,
      status: STATUS.ERROR,
      pid: null,
      message: err.message,
    });
  }
}

function statusForCodexError({
  codexError,
  paths,
  projectRoot,
  stateDir,
  fallbackMessage,
}) {
  if (!codexError || codexError.kind === CODEX_ERROR_KINDS.UNKNOWN) return null;

  if (codexError.kind === CODEX_ERROR_KINDS.AUTH_REQUIRED) {
    return writeMaintainerStatus({
      projectRoot,
      stateDir,
      status: STATUS.AUTH_REQUIRED,
      pid: null,
      message: 'Codex sign-in is required for Agentic AI.',
      extra: codexErrorStatusExtra({ codexError, paths }),
    });
  }

  if (codexError.kind === CODEX_ERROR_KINDS.QUOTA_EXHAUSTED || codexError.kind === CODEX_ERROR_KINDS.RATE_LIMITED) {
    return writeMaintainerStatus({
      projectRoot,
      stateDir,
      status: STATUS.WAITING_FOR_CODEX_QUOTA,
      pid: null,
      message: 'Codex usage limit reached. Agentic AI will keep watching and retry later. To use another account, run: agi account switch',
      extra: codexErrorStatusExtra({ codexError, paths }),
    });
  }

  if (codexError.kind === CODEX_ERROR_KINDS.APP_SERVER_OVERLOADED) {
    return writeMaintainerStatus({
      projectRoot,
      stateDir,
      status: STATUS.ERROR,
      pid: null,
      message: codexError.message || fallbackMessage || 'Codex app-server is overloaded; retry later.',
      extra: codexErrorStatusExtra({ codexError, paths }),
    });
  }

  return null;
}

function codexErrorStatusExtra({ codexError, paths }) {
  return {
    codex_error: codexError,
    codex_home: paths.codexHome,
    thread_ref_path: paths.threadRefPath,
    codex_session_index_path: join(paths.codexHome, 'session_index.jsonl'),
    codex_sessions_dir: join(paths.codexHome, 'sessions'),
    source_codex_session_index_path: join(paths.sourceCodexHome, 'session_index.jsonl'),
    source_codex_sessions_dir: join(paths.sourceCodexHome, 'sessions'),
    evidence_cursor_path: join(paths.stateRoot, 'evidence-cursors.json'),
  };
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
  const conversationEvidenceSources = buildConversationEvidenceSources({ paths, historyRoots: [] });
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
    evidence_cursor_path: join(paths.stateRoot, 'evidence-cursors.json'),
    conversation_evidence_policy: buildConversationEvidencePolicy({ paths, evidenceSources: conversationEvidenceSources }),
    conversation_evidence_sources: conversationEvidenceSources,
  };
}

export function buildConversationEvidencePolicy({ paths, evidenceSources = [] }) {
  const sourceIndexPath = resolve(join(paths.sourceCodexHome, 'session_index.jsonl'));
  const sourceSessionsDir = resolve(join(paths.sourceCodexHome, 'sessions'));
  const isolatedSessionsDir = resolve(join(paths.codexHome, 'sessions'));
  const sourceHomeIsIsolatedHome = resolve(paths.sourceCodexHome) === resolve(paths.codexHome);
  const includesIsolatedSessions = evidenceSources.some((source) => resolve(source.path) === isolatedSessionsDir);
  const hasSourceHistory = existsSync(sourceIndexPath) || existsSync(sourceSessionsDir);
  const status = sourceHomeIsIsolatedHome
    ? 'invalid-source-is-isolated-maintainer-home'
    : hasSourceHistory
      ? 'ready'
      : 'missing-source-codex-history';

  return {
    required: true,
    status,
    source_codex_home: resolve(paths.sourceCodexHome),
    source_codex_session_index_path: sourceIndexPath,
    source_codex_sessions_dir: sourceSessionsDir,
    source_index_exists: existsSync(sourceIndexPath),
    source_sessions_exists: existsSync(sourceSessionsDir),
    isolated_maintainer_codex_home: resolve(paths.codexHome),
    isolated_maintainer_sessions_dir: isolatedSessionsDir,
    excludes_isolated_maintainer_sessions: !includesIsolatedSessions,
    note: 'The real project knowledge comes from the human/source Codex home. The isolated Agentic AI Codex home is for maintainer auth and thread continuity only.',
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
    `Helper scripts are available beside this file under \`${join(paths.maintainerSkillDir, 'scripts')}\`. Start each turn with \`node ${join(paths.maintainerSkillDir, 'scripts', 'collect-maintainer-context.mjs')} --project-root "$PWD" --source-codex-home ${paths.sourceCodexHome} --cursor-path ${join(paths.stateRoot, 'evidence-cursors.json')} --limit 20\`.`,
    `The context helper reads active changed files from \`${paths.turnContextPath}\` and also supports \`$AGENTIC_AI_CHANGED_FILES\`.`,
    `When reading human Codex JSONL, use \`node ${join(paths.maintainerSkillDir, 'scripts', 'read-conversation-slice.mjs')} --project-root "$PWD" --cursor-path ${join(paths.stateRoot, 'evidence-cursors.json')} --file <candidate-jsonl> --max-lines 120 --mark-read\` so follow-up turns do not reread old chat lines.`,
    `Write proposals only with \`node ${join(paths.maintainerSkillDir, 'scripts', 'write-maintainer-proposal.mjs')}\`; the active proposal file is \`${paths.activeProposalPath}\` and is also exposed as \`$AGENTIC_AI_PROPOSAL_FILE\`.`,
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

function normalizeChangedFiles(changedFiles = []) {
  return Array.from(new Set(
    changedFiles
      .map((file) => String(file || '').trim().replaceAll('\\', '/'))
      .filter(Boolean),
  )).slice(0, 50);
}

function writeMaintainerTurnContext(paths, {
  triggerMessage,
  changedFiles = [],
  conversationFile,
  firstTurn = false,
} = {}) {
  writeJson(paths.turnContextPath, {
    schema_version: 1,
    project_root: paths.projectRoot,
    project_id: paths.projectId,
    trigger_message: triggerMessage || null,
    changed_files: normalizeChangedFiles(changedFiles),
    conversation_file: conversationFile ? resolve(paths.projectRoot, conversationFile) : null,
    first_turn: Boolean(firstTurn),
    created_at: new Date().toISOString(),
  });
  return paths.turnContextPath;
}

function readProposalFileActivity(path, initialDocument = {}) {
  try {
    const document = JSON.parse(readFileSync(path, 'utf8'));
    const proposalCount = Array.isArray(document.proposals) ? document.proposals.length : 0;
    return {
      valid: true,
      proposal_count: proposalCount,
      updated: proposalCount > 0
        || String(document.updated_at || '') !== String(initialDocument.updated_at || '')
        || String(document.summary || '') !== String(initialDocument.summary || ''),
    };
  } catch (error) {
    return {
      valid: false,
      proposal_count: 0,
      updated: true,
      reason: error.message,
    };
  }
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}
