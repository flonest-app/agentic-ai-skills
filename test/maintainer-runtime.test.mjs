import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { registerManagedSkill } from '../runtime/agentic-ai-maintainer/scripts/managed-registry.mjs';
import {
  buildConversationEvidenceSources,
  buildMaintainerPrompt,
  buildWritablePolicy,
  getMaintainerPaths,
  getProjectId,
  initializeMaintainerState,
  isMaintainerDaemonProcess,
  readProjectThreadRef,
  readMaintainerStatus,
  requestMaintainerStop,
  writeProjectThreadRef,
} from '../runtime/agentic-ai-maintainer/scripts/maintainer-runtime.mjs';

test('initializes maintainer state with isolated codex home and auth-required status', () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'agentic-ai-maintainer-'));
  const previousHome = process.env.AGENTIC_AI_HOME;
  process.env.AGENTIC_AI_HOME = join(projectRoot, 'hidden-agentic-ai-home');
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
    assert.equal(initialized.config.codex_session_index_path, join(initialized.paths.codexHome, 'session_index.jsonl'));
    assert.equal(initialized.config.codex_sessions_dir, join(initialized.paths.codexHome, 'sessions'));
    assert.equal(initialized.config.source_codex_home, join(process.env.HOME, '.codex'));
    assert.match(
      initialized.config.conversation_evidence_sources.map((source) => source.kind).join(','),
      /source-codex-sessions/,
    );
    assert.equal(initialized.paths.maintainerSkillPath, join(projectRoot, 'hidden-agentic-ai-home/codex-home/skills/agentic-ai-maintainer/SKILL.md'));
    assert.equal(existsSync(initialized.paths.maintainerSkillPath), true);
    assert.match(readFileSync(initialized.paths.maintainerSkillPath, 'utf8'), /name: agentic-ai-maintainer/);
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
  }
});

test('builds controller-mediated write policy and sidecar prompt', () => {
  const policy = buildWritablePolicy({
    projectRoot: '/tmp/project',
    managedSkills: [{ skill_id: 'demo', relative_path: '.agents/skills/demo' }],
  });
  assert.equal(policy.mode, 'controller-mediated');
  assert.deepEqual(policy.allow, ['AGENTS.md', '.agentic-ai', '.agents/skills/demo']);
  assert.match(policy.note, /proposes changes/);
  assert.match(policy.note, /~\/\.agentic-ai/);

  const prompt = buildMaintainerPrompt({
    projectRoot: '/tmp/project',
    historyRoots: ['/tmp/history'],
    conversationFile: '/tmp/history/chat.jsonl',
    triggerMessage: 'New maintainer message from file watcher',
    managedSkills: [{ skill_id: 'demo' }],
  });
  assert.match(prompt, /not the coding agent/);
  assert.match(prompt, /Controller message/);
  assert.match(prompt, /Conversation evidence sources/);
  assert.match(prompt, /source-codex-sessions/);
  assert.match(prompt, /New maintainer message from file watcher/);
  assert.match(prompt, /chat\.jsonl/);
  assert.match(prompt, /Return JSON only/);
  assert.match(prompt, /Managed skills: demo/);
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
