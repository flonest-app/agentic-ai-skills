import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseMaintainerJson,
  processMaintainerOutput,
  submitQueuedOutbox,
} from '../runtime/agentic-ai-maintainer/scripts/proposal-controller.mjs';
import {
  listManagedSkills,
  registerManagedSkill,
} from '../runtime/agentic-ai-maintainer/scripts/managed-registry.mjs';
import {
  addMaintainerProposal,
  beginMaintainerProposal,
} from '../runtime/agentic-ai-maintainer/scripts/write-maintainer-proposal.mjs';

test('parses maintainer JSON with a short preface', () => {
  const parsed = parseMaintainerJson(`Using agentic-ai-maintainer for this smoke test.\n${maintainerOutput([{
    classification: 'project-specific',
    target: 'AGENTS.md',
    action: 'update',
    rationale: 'capture durable project rule',
    proposed_patch: null,
  }])}`);

  assert.equal(parsed.summary, 'maintainer summary');
  assert.equal(parsed.proposals[0].target, 'AGENTS.md');
  assert.equal(parsed.proposals[0].classification, 'project-specific');
});

test('applies valid AGENTS.md patch and creates missing AGENTS.md', async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'agentic-ai-proposals-'));
  const createOutput = maintainerOutput([{
    classification: 'project-specific',
    target: 'AGENTS.md',
    action: 'create',
    rationale: 'capture durable project rule',
    proposed_patch: [
      '--- /dev/null',
      '+++ b/AGENTS.md',
      '@@ -0,0 +1,2 @@',
      '+# Instructions',
      '+Be careful.',
      '',
    ].join('\n'),
  }]);

  const created = await processMaintainerOutput({ projectRoot, output: createOutput });
  assert.equal(created.proposal_results[0].status, 'applied');
  assert.match(readFileSync(join(projectRoot, 'AGENTS.md'), 'utf8'), /Be careful/);

  const updateOutput = maintainerOutput([{
    classification: 'project-specific',
    target: 'AGENTS.md',
    action: 'update',
    rationale: 'capture another rule',
    proposed_patch: [
      '--- a/AGENTS.md',
      '+++ b/AGENTS.md',
      '@@ -1,2 +1,3 @@',
      ' # Instructions',
      ' Be careful.',
      '+Prefer small patches.',
      '',
    ].join('\n'),
  }]);

  const updated = await processMaintainerOutput({ projectRoot, output: updateOutput });
  assert.equal(updated.proposal_results[0].status, 'applied');
  assert.match(readFileSync(join(projectRoot, 'AGENTS.md'), 'utf8'), /Prefer small patches/);
});

test('consumes script-owned proposal file and ignores bogus final model text', async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'agentic-ai-proposal-file-'));
  const proposalFile = beginMaintainerProposal({ projectRoot, summary: 'script-owned proposal' }).path;
  addMaintainerProposal({
    projectRoot,
    file: proposalFile,
    proposal: {
      classification: 'project-specific',
      target: 'AGENTS.md',
      action: 'create',
      rationale: 'capture durable project rule',
      proposed_patch: [
        '--- /dev/null',
        '+++ b/AGENTS.md',
        '@@ -0,0 +1,2 @@',
        '+# Instructions',
        '+Use the script-owned proposal file.',
        '',
      ].join('\n'),
    },
  });

  const result = await processMaintainerOutput({
    projectRoot,
    proposalFile,
    output: '{"summary":"bogus","proposals":[{"classification":"project-specific","target":"src/app.js","action":"update"}]}',
  });

  assert.equal(result.parsed.source, 'proposal-file');
  assert.equal(result.parsed.valid, true);
  assert.equal(result.proposal_results[0].status, 'applied');
  assert.match(readFileSync(join(projectRoot, 'AGENTS.md'), 'utf8'), /script-owned proposal file/);
});

test('missing or invalid proposal file applies nothing and records rejection', async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'agentic-ai-missing-proposal-file-'));
  const result = await processMaintainerOutput({
    projectRoot,
    proposalFile: join(projectRoot, '.agentic-ai/proposals/active.json'),
    output: maintainerOutput([{
      classification: 'project-specific',
      target: 'AGENTS.md',
      action: 'create',
      rationale: 'this final text must be ignored',
      proposed_patch: [
        '--- /dev/null',
        '+++ b/AGENTS.md',
        '@@ -0,0 +1,2 @@',
        '+# Instructions',
        '+Should not be written.',
        '',
      ].join('\n'),
    }]),
  });

  assert.equal(result.parsed.valid, false);
  assert.equal(result.proposal_results[0].status, 'rejected');
  assert.match(result.proposal_results[0].reason, /classification unclear/);
  assert.equal(existsSync(join(projectRoot, 'AGENTS.md')), false);
});

test('warns when an applied AGENTS.md file is ignored by git', async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'agentic-ai-proposals-'));
  writeFileSync(join(projectRoot, '.gitignore'), '/AGENTS.md\n');
  const init = spawnSync('git', ['init'], {
    cwd: projectRoot,
    encoding: 'utf8',
  });
  if (init.status !== 0) return;

  const result = await processMaintainerOutput({
    projectRoot,
    output: maintainerOutput([{
      classification: 'project-specific',
      target: 'AGENTS.md',
      action: 'create',
      rationale: 'capture durable project rule',
      proposed_patch: [
        '--- /dev/null',
        '+++ b/AGENTS.md',
        '@@ -0,0 +1,2 @@',
        '+# Instructions',
        '+Be careful.',
        '',
      ].join('\n'),
    }]),
  });

  assert.equal(result.proposal_results[0].status, 'applied');
  assert.match(result.proposal_results[0].warnings[0], /ignored by git/);
});

test('rejects product code and unmanaged skill edits', async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'agentic-ai-proposals-'));
  mkdirSync(join(projectRoot, 'src'), { recursive: true });
  writeFileSync(join(projectRoot, 'src/app.js'), 'console.log("old");\n');

  const product = await processMaintainerOutput({
    projectRoot,
    output: maintainerOutput([{
      classification: 'project-specific',
      target: 'AGENTS.md',
      action: 'update',
      rationale: 'bad target',
      proposed_patch: [
        '--- a/src/app.js',
        '+++ b/src/app.js',
        '@@ -1 +1 @@',
        '-console.log("old");',
        '+console.log("new");',
        '',
      ].join('\n'),
    }]),
  });
  assert.equal(product.proposal_results[0].status, 'rejected');
  assert.match(product.proposal_results[0].reason, /not allowlisted/);
  assert.equal(readFileSync(join(projectRoot, 'src/app.js'), 'utf8'), 'console.log("old");\n');

  mkdirSync(join(projectRoot, '.agents/skills/demo'), { recursive: true });
  writeFileSync(join(projectRoot, '.agents/skills/demo/SKILL.md'), '---\nname: demo\ndescription: demo\n---\n');
  const unmanaged = await processMaintainerOutput({
    projectRoot,
    output: maintainerOutput([{
      classification: 'managed-skill-drift',
      target: 'managed-skill:demo',
      action: 'update',
      rationale: 'unmanaged edit',
      proposed_patch: [
        '--- a/.agents/skills/demo/SKILL.md',
        '+++ b/.agents/skills/demo/SKILL.md',
        '@@ -1,4 +1,5 @@',
        ' ---',
        ' name: demo',
        ' description: demo',
        ' ---',
        '+new',
        '',
      ].join('\n'),
    }]),
  });
  assert.equal(unmanaged.proposal_results[0].status, 'rejected');
  assert.match(unmanaged.proposal_results[0].reason, /not managed/);
});

test('creates, updates, and removes registered managed skills only', async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'agentic-ai-proposals-'));
  const create = await processMaintainerOutput({
    projectRoot,
    output: maintainerOutput([{
      classification: 'generic',
      target: 'managed-skill:demo',
      action: 'create',
      rationale: 'reusable local skill',
      proposed_patch: [
        '--- /dev/null',
        '+++ b/.agents/skills/demo/SKILL.md',
        '@@ -0,0 +1,5 @@',
        '+---',
        '+name: demo',
        '+description: demo skill',
        '+---',
        '+# Demo',
        '',
      ].join('\n'),
    }]),
  });
  assert.equal(create.proposal_results[0].status, 'applied');
  assert.equal(listManagedSkills({ projectRoot }).find((skill) => skill.skill_id === 'demo')?.status, 'managed');

  const update = await processMaintainerOutput({
    projectRoot,
    output: maintainerOutput([{
      classification: 'managed-skill-drift',
      target: 'managed-skill:demo',
      action: 'update',
      rationale: 'tune skill',
      proposed_patch: [
        '--- a/.agents/skills/demo/SKILL.md',
        '+++ b/.agents/skills/demo/SKILL.md',
        '@@ -2,4 +2,5 @@',
        ' name: demo',
        ' description: demo skill',
        ' ---',
        ' # Demo',
        '+Use this carefully.',
        '',
      ].join('\n'),
    }]),
  });
  assert.equal(update.proposal_results[0].status, 'applied');
  assert.equal(listManagedSkills({ projectRoot }).find((skill) => skill.skill_id === 'demo')?.status, 'locally_tuned');

  const remove = await processMaintainerOutput({
    projectRoot,
    output: maintainerOutput([{
      classification: 'managed-skill-unused',
      target: 'managed-skill:demo',
      action: 'remove',
      rationale: 'unused',
      proposed_patch: null,
    }]),
  });
  assert.equal(remove.proposal_results[0].status, 'applied');
  assert.equal(existsSync(join(projectRoot, '.agents/skills/demo')), false);
  assert.equal(listManagedSkills({ projectRoot }).find((skill) => skill.skill_id === 'demo')?.status, 'removed');
});

test('installs managed skills through installer with execute and registers result', async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'agentic-ai-install-proposal-'));
  const calls = [];
  const result = await processMaintainerOutput({
    projectRoot,
    output: maintainerOutput([{
      classification: 'generic',
      target: 'managed-skill:installed-demo',
      action: 'install',
      rationale: 'install reusable managed skill',
      install_spec: 'flonest-app/installed-demo',
      upstream_repo: 'flonest-app/installed-demo',
      upstream_skill_id: 'installed-demo',
    }]),
    installManagedSkillImpl: (args) => {
      calls.push(args);
      const skillPath = `.agents/skills/${args.skillId}`;
      mkdirSync(join(args.projectRoot, skillPath), { recursive: true });
      writeFileSync(join(args.projectRoot, skillPath, 'SKILL.md'), '---\nname: installed-demo\ndescription: installed demo\n---\n');
      return {
        ok: true,
        installed: args.skillId,
        installed_path: skillPath,
        registered: registerManagedSkill({
          projectRoot: args.projectRoot,
          skillId: args.skillId,
          name: 'Installed Demo',
          skillPath,
          source: 'installed-public-skillhub',
          upstreamRepo: args.upstreamRepo,
          upstreamSkillId: args.upstreamSkillId,
          installSpec: args.installSpec,
        }),
      };
    },
  });

  assert.equal(result.proposal_results[0].status, 'applied');
  assert.equal(calls[0].execute, true);
  assert.equal(calls[0].installSpec, 'flonest-app/installed-demo');
  const registered = listManagedSkills({ projectRoot }).find((skill) => skill.skill_id === 'installed-demo');
  assert.equal(registered.status, 'managed');
  assert.equal(registered.install_spec, 'flonest-app/installed-demo');
});

test('queues sanitized outbox and marks delivery results', async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'agentic-ai-proposals-'));
  const output = maintainerOutput([{
    classification: 'generic',
    target: 'skillhub',
    action: 'record',
    rationale: 'public reusable lesson',
    upstream_feedback: 'Generic lesson from /home/private/project without secret values.',
  }]);

  const queued = await processMaintainerOutput({ projectRoot, output });
  assert.equal(queued.outbox_results.length, 1);
  const queuedPayload = JSON.parse(readFileSync(queued.outbox_results[0].path, 'utf8'));
  assert.equal(queuedPayload.schema_version, 2);
  assert.equal(queuedPayload.source, 'consumer-agi');
  assert.equal(queuedPayload.proposal_type, 'feedback');
  assert.equal(queuedPayload.delivery.status, 'queued');
  assert.match(queuedPayload.delivery.last_error, /LABSERVER_URL/);
  assert.match(queuedPayload.private_context, /\[REDACTED_LOCAL_PATH\]/);

  const delivered = await submitQueuedOutbox({
    projectRoot,
    fetchImpl: async (url) => {
      assert.equal(url, 'https://lab.example/skill-proposals');
      return {
      ok: true,
      async json() {
        return { ok: true, route: 'stored' };
      },
    };
    },
    labserverUrl: 'https://lab.example',
  });
  assert.equal(delivered.results[0].status, 'delivered');
  const deliveredPayload = JSON.parse(readFileSync(queued.outbox_results[0].path, 'utf8'));
  assert.equal(deliveredPayload.delivery.status, 'delivered');
});

test('queues same-target proposals without outbox filename collisions', async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'agentic-ai-proposals-'));
  const result = await processMaintainerOutput({
    projectRoot,
    output: maintainerOutput([
      {
        classification: 'generic',
        target: 'skillhub',
        action: 'record',
        rationale: 'first reusable lesson',
        upstream_feedback: 'First generic runtime lesson.',
      },
      {
        classification: 'generic',
        target: 'skillhub',
        action: 'record',
        rationale: 'second reusable lesson',
        upstream_feedback: 'Second generic runtime lesson.',
      },
    ]),
  });

  assert.equal(result.outbox_results.length, 2);
  assert.notEqual(result.outbox_results[0].path, result.outbox_results[1].path);

  const first = JSON.parse(readFileSync(result.outbox_results[0].path, 'utf8'));
  const second = JSON.parse(readFileSync(result.outbox_results[1].path, 'utf8'));
  assert.match(first.proposal_id, /^[a-f0-9]{32}$/);
  assert.match(second.proposal_id, /^[a-f0-9]{32}$/);
  assert.notEqual(first.proposal_id, second.proposal_id);
  assert.match(first.private_context, /First generic/);
  assert.match(second.private_context, /Second generic/);
});

test('preserves outbox retry state when labserver submission fails', async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'agentic-ai-proposals-'));
  await processMaintainerOutput({
    projectRoot,
    output: maintainerOutput([{
      classification: 'generic',
      target: 'skillhub',
      action: 'record',
      rationale: 'public reusable lesson',
      upstream_feedback: 'Generic lesson.',
    }]),
  });

  const failed = await submitQueuedOutbox({
    projectRoot,
    labserverUrl: 'https://lab.example',
    fetchImpl: async () => ({
      ok: false,
      status: 503,
      async text() {
        return 'unavailable';
      },
    }),
  });
  assert.equal(failed.results[0].status, 'queued');
  assert.match(failed.results[0].reason, /503 unavailable/);
});

test('queues labserver revision responses and marks local request answered', async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'agentic-ai-proposals-'));
  const inboxDir = join(projectRoot, '.agentic-ai/inbox');
  mkdirSync(inboxDir, { recursive: true });
  writeFileSync(join(inboxDir, '1111222233334444.json'), `${JSON.stringify({
    request_id: '1111222233334444',
    local_status: 'pending',
    sanitized_request: 'Please clarify.',
  }, null, 2)}\n`);

  const result = await processMaintainerOutput({
    projectRoot,
    output: maintainerOutput([{
      classification: 'generic',
      target: 'skillhub',
      action: 'record',
      response_to: '1111222233334444',
      rationale: 'answer review clarification',
      upstream_feedback: 'Clarification: this guidance is reusable across projects.',
    }]),
  });

  const payload = JSON.parse(readFileSync(result.outbox_results[0].path, 'utf8'));
  assert.equal(payload.response_to, '1111222233334444');
  assert.equal(payload.proposal_type, 'feedback');
  assert.match(payload.private_context, /Clarification/);
  const request = JSON.parse(readFileSync(join(inboxDir, '1111222233334444.json'), 'utf8'));
  assert.equal(request.local_status, 'answered');
});

test('records registered skill removal through registry helper', () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'agentic-ai-registry-'));
  mkdirSync(join(projectRoot, '.agents/skills/remove-me'), { recursive: true });
  writeFileSync(join(projectRoot, '.agents/skills/remove-me/SKILL.md'), '---\nname: remove-me\ndescription: demo\n---\n');
  registerManagedSkill({
    projectRoot,
    skillId: 'remove-me',
    name: 'Remove Me',
    skillPath: '.agents/skills/remove-me',
    source: 'created-local',
  });
  assert.equal(listManagedSkills({ projectRoot }).find((skill) => skill.skill_id === 'remove-me')?.status, 'managed');
});

function maintainerOutput(proposals) {
  return JSON.stringify({
    summary: 'maintainer summary',
    proposals,
  });
}
