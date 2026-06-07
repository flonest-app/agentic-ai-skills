import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CODEX_SANDBOX } from '../runtime/agentic-ai-maintainer/scripts/appserver-task.mjs';
import { CODEX_ERROR_KINDS } from '../runtime/agentic-ai-maintainer/scripts/codex-errors.mjs';
import { registerManagedSkill } from '../runtime/agentic-ai-maintainer/scripts/managed-registry.mjs';
import {
  DEFAULT_LABSERVER_URL,
  buildConversationEvidencePolicy,
  buildConversationEvidenceSources,
  buildMaintainerPrompt,
  buildWritablePolicy,
  getLabserverUrl,
  getMaintainerPaths,
  getProjectId,
  initializeMaintainerState,
  isMaintainerDaemonProcess,
  readProjectThreadRef,
  readMaintainerStatus,
  requestMaintainerStop,
  runMaintenanceOnce,
  writeProjectThreadRef,
} from '../runtime/agentic-ai-maintainer/scripts/maintainer-runtime.mjs';

test('initializes maintainer state with isolated codex home and auth-required status', () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'agentic-ai-maintainer-'));
  const previousHome = process.env.AGENTIC_AI_HOME;
  const previousLabserverUrl = process.env.AGENTIC_AI_LABSERVER_URL;
  process.env.AGENTIC_AI_HOME = join(projectRoot, 'hidden-agentic-ai-home');
  delete process.env.AGENTIC_AI_LABSERVER_URL;
  const skillDir = join(projectRoot, '.agents/skills/demo-skill');
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: demo-skill\ndescription: demo\n---\n');

  try {
    registerManagedSkill({
      projectRoot,
      skillId: 'demo-skill',
      name: 'Demo Skill',
      skillPath: '.agents/skills/demo-skill',
      source: 'created-local',
    });

    const initialized = initializeMaintainerState({
      projectRoot,
      historyRoots: ['.conversations'],
    });

    assert.equal(initialized.paths.codexHome, join(projectRoot, 'hidden-agentic-ai-home/codex-home'));
    assert.equal(initialized.paths.projectId, getProjectId(projectRoot));
    assert.equal(initialized.paths.runtimeProjectDir, join(projectRoot, `hidden-agentic-ai-home/projects/${getProjectId(projectRoot)}`));
    assert.equal(initialized.paths.pidPath, join(initialized.paths.runtimeProjectDir, 'maintainer.pid'));
    assert.equal(initialized.paths.stopPath, join(initialized.paths.runtimeProjectDir, 'stop'));
    assert.equal(initialized.paths.threadRefPath, join(initialized.paths.runtimeProjectDir, 'thread-ref.json'));
    assert.equal(initialized.config.thread_ref_path, initialized.paths.threadRefPath);
    assert.equal(initialized.config.labserver_url, DEFAULT_LABSERVER_URL);
    assert.equal(initialized.config.codex_session_index_path, join(initialized.paths.codexHome, 'session_index.jsonl'));
    assert.equal(initialized.config.codex_sessions_dir, join(initialized.paths.codexHome, 'sessions'));
    assert.equal(initialized.config.source_codex_home, join(process.env.HOME, '.codex'));
    assert.equal(initialized.config.maintainer_proposal_file, join(projectRoot, '.agentic-ai/proposals/active.json'));
    assert.equal(initialized.config.conversation_evidence_policy.required, true);
    assert.equal(initialized.config.conversation_evidence_policy.source_codex_home, join(process.env.HOME, '.codex'));
    assert.equal(initialized.config.conversation_evidence_policy.excludes_isolated_maintainer_sessions, true);
    assert.match(
      initialized.config.conversation_evidence_sources.map((source) => source.kind).join(','),
      /source-codex-sessions/,
    );
    assert.equal(initialized.paths.maintainerSkillPath, join(projectRoot, 'hidden-agentic-ai-home/codex-home/skills/agentic-ai-maintainer/SKILL.md'));
    assert.equal(existsSync(initialized.paths.maintainerSkillPath), true);
    assert.match(readFileSync(initialized.paths.maintainerSkillPath, 'utf8'), /name: agentic-ai-maintainer/);
    assert.match(readFileSync(initialized.paths.maintainerSkillPath, 'utf8'), /Helper scripts are available/);
    assert.match(readFileSync(initialized.paths.maintainerSkillPath, 'utf8'), /collect-maintainer-context\.mjs/);
    assert.match(readFileSync(initialized.paths.maintainerSkillPath, 'utf8'), /read-conversation-slice\.mjs/);
    assert.match(readFileSync(initialized.paths.maintainerSkillPath, 'utf8'), /write-maintainer-proposal\.mjs/);
    assert.equal(existsSync(join(initialized.paths.maintainerSkillDir, 'scripts/collect-maintainer-context.mjs')), true);
    assert.equal(existsSync(join(initialized.paths.maintainerSkillDir, 'scripts/read-conversation-slice.mjs')), true);
    assert.equal(existsSync(join(initialized.paths.maintainerSkillDir, 'scripts/discover-project-conversations.mjs')), true);
    assert.equal(existsSync(join(initialized.paths.maintainerSkillDir, 'scripts/proposal-controller.mjs')), true);
    assert.equal(existsSync(join(initialized.paths.maintainerSkillDir, 'scripts/write-maintainer-proposal.mjs')), true);
    assert.equal(existsSync(join(initialized.paths.maintainerSkillDir, 'references/maintainer-agent-prompt.md')), true);
    assert.equal(initialized.status.status, 'AUTH_REQUIRED');
    assert.equal(readMaintainerStatus({ projectRoot }).status, 'AUTH_REQUIRED');
    assert.deepEqual(initialized.config.write_policy.allow, [
      'AGENTS.md',
      '.agentic-ai',
      '.agents/skills/demo-skill',
    ]);

    assert.equal(readProjectThreadRef(initialized.paths).thread_id, null);
    writeProjectThreadRef(initialized.paths, {
      thread_id: 'thread-1',
      last_turn_id: 'turn-1',
      last_trigger_message: 'repo file change idle trigger',
    });
    assert.equal(readProjectThreadRef(initialized.paths).thread_id, 'thread-1');
    assert.equal(readProjectThreadRef(initialized.paths).codex_session_index_path, join(initialized.paths.codexHome, 'session_index.jsonl'));
    assert.equal(readProjectThreadRef(initialized.paths).source_codex_session_index_path, join(process.env.HOME, '.codex/session_index.jsonl'));
  } finally {
    if (previousHome === undefined) delete process.env.AGENTIC_AI_HOME;
    else process.env.AGENTIC_AI_HOME = previousHome;
    if (previousLabserverUrl === undefined) delete process.env.AGENTIC_AI_LABSERVER_URL;
    else process.env.AGENTIC_AI_LABSERVER_URL = previousLabserverUrl;
  }
});

test('resolves labserver URL default, override, and local-only disable', () => {
  const previousLabserverUrl = process.env.AGENTIC_AI_LABSERVER_URL;
  try {
    delete process.env.AGENTIC_AI_LABSERVER_URL;
    assert.equal(getLabserverUrl(), DEFAULT_LABSERVER_URL);

    process.env.AGENTIC_AI_LABSERVER_URL = 'https://lab.example';
    assert.equal(getLabserverUrl(), 'https://lab.example');

    process.env.AGENTIC_AI_LABSERVER_URL = 'off';
    assert.equal(getLabserverUrl(), '');
  } finally {
    if (previousLabserverUrl === undefined) delete process.env.AGENTIC_AI_LABSERVER_URL;
    else process.env.AGENTIC_AI_LABSERVER_URL = previousLabserverUrl;
  }
});

test('runMaintenanceOnce uses script-owned proposal file instead of final provider text', async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'agentic-ai-maintainer-run-'));
  const agenticHome = join(projectRoot, 'hidden-agentic-ai-home');
  const previousHome = process.env.AGENTIC_AI_HOME;
  const previousLabserverUrl = process.env.AGENTIC_AI_LABSERVER_URL;
  process.env.AGENTIC_AI_HOME = agenticHome;
  process.env.AGENTIC_AI_LABSERVER_URL = 'off';
  mkdirSync(join(agenticHome, 'codex-home'), { recursive: true });
  writeFileSync(join(agenticHome, 'codex-home/auth.json'), '{}\n');
  const calls = [];

  try {
    const status = await runMaintenanceOnce({
      projectRoot,
      runAppServerTaskImpl: async (args) => {
        calls.push({ kind: 'appserver', args });
        assert.equal(args.extraEnv.AGENTIC_AI_PROJECT_ROOT, projectRoot);
        assert.equal(args.extraEnv.AGENTIC_AI_PROPOSAL_FILE, join(projectRoot, '.agentic-ai/proposals/active.json'));
        assert.equal(existsSync(args.extraEnv.AGENTIC_AI_PROPOSAL_FILE), true);
        return {
          authRequired: false,
          threadId: 'thread-1',
          reusedThread: false,
          turnId: 'turn-1',
          skillAttached: false,
          output: '{"summary":"ignored final text","proposals":[{"target":"src/app.js"}]}',
        };
      },
      processMaintainerOutputImpl: async (args) => {
        calls.push({ kind: 'controller', args });
        assert.equal(args.proposalFile, join(projectRoot, '.agentic-ai/proposals/active.json'));
        assert.equal(args.output, undefined);
        return {
          parsed: { source: 'proposal-file', valid: true, proposals: [] },
          proposal_results: [],
          outbox_results: [],
          submission: { results: [] },
        };
      },
    });

    assert.equal(status.status, 'COMPLETED');
    assert.equal(status.maintainer_proposal_file, join(projectRoot, '.agentic-ai/proposals/active.json'));
    assert.deepEqual(calls.map((call) => call.kind), ['appserver', 'controller']);
  } finally {
    if (previousHome === undefined) delete process.env.AGENTIC_AI_HOME;
    else process.env.AGENTIC_AI_HOME = previousHome;
    if (previousLabserverUrl === undefined) delete process.env.AGENTIC_AI_LABSERVER_URL;
    else process.env.AGENTIC_AI_LABSERVER_URL = previousLabserverUrl;
  }
});

test('runMaintenanceOnce treats empty Codex turns as blocked no-op without controller', async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'agentic-ai-maintainer-empty-'));
  const agenticHome = join(projectRoot, 'hidden-agentic-ai-home');
  const previousHome = process.env.AGENTIC_AI_HOME;
  const previousLabserverUrl = process.env.AGENTIC_AI_LABSERVER_URL;
  process.env.AGENTIC_AI_HOME = agenticHome;
  process.env.AGENTIC_AI_LABSERVER_URL = 'off';
  mkdirSync(join(agenticHome, 'codex-home'), { recursive: true });
  writeFileSync(join(agenticHome, 'codex-home/auth.json'), '{}\n');

  try {
    const status = await runMaintenanceOnce({
      projectRoot,
      runAppServerTaskImpl: async () => ({
        authRequired: false,
        threadId: 'thread-empty',
        reusedThread: true,
        resumeError: null,
        turnId: 'turn-empty',
        skillAttached: false,
        output: '',
        activity: {
          output_chars: 0,
          agent_message_delta_count: 0,
          assistant_message_count: 0,
          tool_call_count: 0,
          item_count: 0,
          notification_count: 1,
        },
        noModelOutput: true,
      }),
      processMaintainerOutputImpl: async () => {
        throw new Error('controller should not run for an empty Codex turn');
      },
    });

    assert.equal(status.status, 'NO_MODEL_OUTPUT');
    assert.equal(status.thread_id, 'thread-empty');
    assert.equal(status.turn_id, 'turn-empty');
    assert.match(status.message, /no maintainer output/);
    assert.equal(existsSync(join(projectRoot, '.agentic-ai/patches')), true);
  } finally {
    if (previousHome === undefined) delete process.env.AGENTIC_AI_HOME;
    else process.env.AGENTIC_AI_HOME = previousHome;
    if (previousLabserverUrl === undefined) delete process.env.AGENTIC_AI_LABSERVER_URL;
    else process.env.AGENTIC_AI_LABSERVER_URL = previousLabserverUrl;
  }
});

test('runMaintenanceOnce maps empty turn with exhausted credits to quota wait after saving thread', async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'agentic-ai-maintainer-empty-quota-'));
  const agenticHome = join(projectRoot, 'hidden-agentic-ai-home');
  const previousHome = process.env.AGENTIC_AI_HOME;
  const previousLabserverUrl = process.env.AGENTIC_AI_LABSERVER_URL;
  process.env.AGENTIC_AI_HOME = agenticHome;
  process.env.AGENTIC_AI_LABSERVER_URL = 'off';
  mkdirSync(join(agenticHome, 'codex-home'), { recursive: true });
  writeFileSync(join(agenticHome, 'codex-home/auth.json'), '{}\n');

  try {
    const status = await runMaintenanceOnce({
      projectRoot,
      runAppServerTaskImpl: async () => ({
        authRequired: false,
        threadId: 'thread-quota',
        reusedThread: true,
        turnId: 'turn-quota',
        skillAttached: false,
        output: '',
        activity: {
          output_chars: 0,
          agent_message_delta_count: 0,
          assistant_message_count: 0,
          tool_call_count: 0,
          item_count: 0,
          notification_count: 1,
        },
        noModelOutput: true,
        rateLimits: { rateLimits: { credits: { has_credits: false, unlimited: false } } },
      }),
      processMaintainerOutputImpl: async () => {
        throw new Error('controller should not run while Codex quota is exhausted');
      },
    });

    assert.equal(status.status, 'WAITING_FOR_CODEX_QUOTA');
    assert.match(status.message, /agi account switch/);
    assert.equal(readProjectThreadRef(getMaintainerPaths({ projectRoot })).thread_id, 'thread-quota');
  } finally {
    if (previousHome === undefined) delete process.env.AGENTIC_AI_HOME;
    else process.env.AGENTIC_AI_HOME = previousHome;
    if (previousLabserverUrl === undefined) delete process.env.AGENTIC_AI_LABSERVER_URL;
    else process.env.AGENTIC_AI_LABSERVER_URL = previousLabserverUrl;
  }
});

test('runMaintenanceOnce records expired Codex auth without running controller', async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'agentic-ai-maintainer-auth-'));
  const agenticHome = join(projectRoot, 'hidden-agentic-ai-home');
  const previousHome = process.env.AGENTIC_AI_HOME;
  const previousLabserverUrl = process.env.AGENTIC_AI_LABSERVER_URL;
  process.env.AGENTIC_AI_HOME = agenticHome;
  process.env.AGENTIC_AI_LABSERVER_URL = 'off';
  mkdirSync(join(agenticHome, 'codex-home'), { recursive: true });
  writeFileSync(join(agenticHome, 'codex-home/auth.json'), '{}\n');

  try {
    const status = await runMaintenanceOnce({
      projectRoot,
      runAppServerTaskImpl: async () => ({
        authRequired: true,
        codexError: {
          kind: CODEX_ERROR_KINDS.AUTH_REQUIRED,
          message: 'chatgpt authentication required',
        },
      }),
      processMaintainerOutputImpl: async () => {
        throw new Error('controller should not run when auth is expired');
      },
    });

    assert.equal(status.status, 'AUTH_REQUIRED');
    assert.equal(status.codex_error.kind, CODEX_ERROR_KINDS.AUTH_REQUIRED);
    assert.equal(status.codex_home, join(agenticHome, 'codex-home'));
  } finally {
    if (previousHome === undefined) delete process.env.AGENTIC_AI_HOME;
    else process.env.AGENTIC_AI_HOME = previousHome;
    if (previousLabserverUrl === undefined) delete process.env.AGENTIC_AI_LABSERVER_URL;
    else process.env.AGENTIC_AI_LABSERVER_URL = previousLabserverUrl;
  }
});

test('runMaintenanceOnce waits on Codex quota without running controller', async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'agentic-ai-maintainer-quota-'));
  const agenticHome = join(projectRoot, 'hidden-agentic-ai-home');
  const previousHome = process.env.AGENTIC_AI_HOME;
  const previousLabserverUrl = process.env.AGENTIC_AI_LABSERVER_URL;
  process.env.AGENTIC_AI_HOME = agenticHome;
  process.env.AGENTIC_AI_LABSERVER_URL = 'off';
  mkdirSync(join(agenticHome, 'codex-home'), { recursive: true });
  writeFileSync(join(agenticHome, 'codex-home/auth.json'), '{}\n');

  try {
    const status = await runMaintenanceOnce({
      projectRoot,
      runAppServerTaskImpl: async () => ({
        authRequired: false,
        codexError: {
          kind: CODEX_ERROR_KINDS.QUOTA_EXHAUSTED,
          message: 'The usage limit has been reached',
          rate_limit_reached_type: 'workspace_member_usage_limit_reached',
        },
      }),
      processMaintainerOutputImpl: async () => {
        throw new Error('controller should not run while Codex quota is exhausted');
      },
    });

    assert.equal(status.status, 'WAITING_FOR_CODEX_QUOTA');
    assert.match(status.message, /keep watching/);
    assert.match(status.message, /agi account switch/);
    assert.equal(status.codex_error.kind, CODEX_ERROR_KINDS.QUOTA_EXHAUSTED);
    assert.equal(status.evidence_cursor_path, join(projectRoot, '.agentic-ai/evidence-cursors.json'));
    assert.equal(existsSync(join(projectRoot, '.agentic-ai/patches')), true);
    assert.equal(existsSync(join(projectRoot, '.agentic-ai/patches', 'should-not-exist.json')), false);
  } finally {
    if (previousHome === undefined) delete process.env.AGENTIC_AI_HOME;
    else process.env.AGENTIC_AI_HOME = previousHome;
    if (previousLabserverUrl === undefined) delete process.env.AGENTIC_AI_LABSERVER_URL;
    else process.env.AGENTIC_AI_LABSERVER_URL = previousLabserverUrl;
  }
});

test('builds controller-mediated write policy and sidecar prompt', () => {
  assert.equal(DEFAULT_CODEX_SANDBOX, 'workspace-write');

  const policy = buildWritablePolicy({
    projectRoot: '/tmp/project',
    managedSkills: [{ skill_id: 'demo', relative_path: '.agents/skills/demo' }],
  });
  assert.equal(policy.mode, 'controller-mediated');
  assert.deepEqual(policy.allow, ['AGENTS.md', '.agentic-ai', '.agents/skills/demo']);
  assert.match(policy.note, /proposes changes/);
  assert.match(policy.note, /~\/\.agentic-ai/);

  const prompt = buildMaintainerPrompt({
    triggerMessage: 'New maintainer message from file watcher',
  });
  assert.equal(prompt, 'Use agentic-ai-maintainer skill: start New maintainer message from file watcher');
  assert.equal(prompt.split('\n').length, 1);
  assert.doesNotMatch(prompt, /## Output Contract/);
  assert.doesNotMatch(prompt, /Source Codex evidence policy/);
  assert.doesNotMatch(prompt, /collect-maintainer-context\.mjs/);
  assert.doesNotMatch(prompt, /read-conversation-slice\.mjs/);
  assert.doesNotMatch(prompt, /project_root=/);
  assert.doesNotMatch(prompt, /config=/);

  const followupPrompt = buildMaintainerPrompt({
    firstTurn: false,
  });
  assert.equal(followupPrompt, 'Use agentic-ai-maintainer skill: continue maintaining this project');
  assert.equal(followupPrompt.split('\n').length, 1);
  assert.doesNotMatch(followupPrompt, /## Output Contract/);
});

test('builds conversation evidence sources from project and Codex history homes', () => {
  const paths = getMaintainerPaths({
    projectRoot: '/tmp/project',
    codexHome: '/tmp/agentic-home/codex-home',
    sourceCodexHome: '/tmp/user-codex',
  });
  const sources = buildConversationEvidenceSources({
    paths,
    historyRoots: ['/tmp/extra-history'],
  });

  assert.deepEqual(sources.map((source) => source.kind), [
    'project-conversation-summaries',
    'source-codex-session-index',
    'source-codex-sessions',
    'provided-history-root',
  ]);
  assert.equal(sources.find((source) => source.kind === 'source-codex-sessions').path, '/tmp/user-codex/sessions');
  assert.equal(sources.some((source) => source.path.includes('/tmp/agentic-home/codex-home/sessions')), false);

  const policy = buildConversationEvidencePolicy({ paths, evidenceSources: sources });
  assert.equal(policy.required, true);
  assert.equal(policy.source_codex_home, '/tmp/user-codex');
  assert.equal(policy.source_codex_sessions_dir, '/tmp/user-codex/sessions');
  assert.equal(policy.isolated_maintainer_codex_home, '/tmp/agentic-home/codex-home');
  assert.equal(policy.excludes_isolated_maintainer_sessions, true);
});

test('stores stop control outside project state and avoids killing unverified pids', () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'agentic-ai-maintainer-'));
  const previousHome = process.env.AGENTIC_AI_HOME;
  process.env.AGENTIC_AI_HOME = join(projectRoot, 'hidden-agentic-ai-home');

  try {
    const paths = getMaintainerPaths({ projectRoot });
    assert.match(paths.stopPath, /hidden-agentic-ai-home\/projects\/[a-f0-9]{16}\/stop$/);
    assert.doesNotMatch(paths.stopPath, /\.agentic-ai\/stop$/);

    const status = requestMaintainerStop({ projectRoot });
    assert.equal(status.status, 'STOPPED');
    assert.equal(existsSync(paths.stopPath), true);
    assert.equal(isMaintainerDaemonProcess(process.pid, projectRoot), false);
  } finally {
    if (previousHome === undefined) delete process.env.AGENTIC_AI_HOME;
    else process.env.AGENTIC_AI_HOME = previousHome;
  }
});
