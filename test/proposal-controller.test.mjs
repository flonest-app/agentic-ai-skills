import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  processMaintainerOutput,
  submitQueuedOutbox,
} from '../runtime/agentic-ai-maintainer/scripts/proposal-controller.mjs';
import {
  listManagedSkills,
  registerManagedSkill,
} from '../runtime/agentic-ai-maintainer/scripts/managed-registry.mjs';

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
  assert.equal(queuedPayload.delivery.status, 'queued');
  assert.match(queuedPayload.delivery.last_error, /LABSERVER_URL/);
  assert.match(queuedPayload.sanitized_feedback, /\[REDACTED_LOCAL_PATH\]/);

  const delivered = await submitQueuedOutbox({
    projectRoot,
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return { ok: true, route: 'issue' };
      },
    }),
    labserverUrl: 'https://lab.example',
  });
  assert.equal(delivered.results[0].status, 'delivered');
  const deliveredPayload = JSON.parse(readFileSync(queued.outbox_results[0].path, 'utf8'));
  assert.equal(deliveredPayload.delivery.status, 'delivered');
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
