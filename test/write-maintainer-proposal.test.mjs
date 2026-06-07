import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addMaintainerProposal,
  beginMaintainerProposal,
  loadMaintainerProposalFile,
} from '../runtime/agentic-ai-maintainer/scripts/write-maintainer-proposal.mjs';

const scriptPath = new URL('../runtime/agentic-ai-maintainer/scripts/write-maintainer-proposal.mjs', import.meta.url).pathname;

test('creates empty valid maintainer proposal file', () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'agentic-ai-writer-'));
  const result = beginMaintainerProposal({ projectRoot, summary: 'nothing durable yet' });

  assert.equal(existsSync(result.path), true);
  const loaded = loadMaintainerProposalFile({ projectRoot });
  assert.equal(loaded.document.summary, 'nothing durable yet');
  assert.deepEqual(loaded.document.proposals, []);
});

test('adds AGENTS, managed-skill, skillhub, and revision response proposals', () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'agentic-ai-writer-'));
  beginMaintainerProposal({ projectRoot });

  addMaintainerProposal({
    projectRoot,
    proposal: {
      classification: 'project-specific',
      target: 'AGENTS.md',
      action: 'update',
      rationale: 'capture durable project guidance',
      proposed_patch: agentsPatch(),
    },
  });
  addMaintainerProposal({
    projectRoot,
    proposal: {
      classification: 'managed-skill-drift',
      target: 'managed-skill:demo',
      action: 'update',
      rationale: 'tune a registered managed skill',
      proposed_patch: managedSkillPatch(),
    },
  });
  addMaintainerProposal({
    projectRoot,
    proposal: {
      classification: 'generic',
      target: 'skillhub',
      action: 'create',
      rationale: 'propose reusable public skillhub knowledge',
      proposed_skill_patch: skillhubPatch(),
      candidate_skill_name: 'Demo',
    },
  });
  addMaintainerProposal({
    projectRoot,
    proposal: {
      classification: 'generic',
      target: 'skillhub',
      action: 'record',
      response_to: '1111222233334444',
      rationale: 'answer maintainer clarification',
      upstream_feedback: 'Clarification that is reusable across projects.',
    },
  });

  const loaded = loadMaintainerProposalFile({ projectRoot });
  assert.equal(loaded.document.proposals.length, 4);
  assert.equal(loaded.document.proposals[0].target, 'AGENTS.md');
  assert.equal(loaded.document.proposals[1].target, 'managed-skill:demo');
  assert.equal(loaded.document.proposals[2].proposed_skill_patch.includes('skill-hub/demo/SKILL.md'), true);
  assert.equal(loaded.document.proposals[3].response_to, '1111222233334444');
});

test('CLI add accepts large patch text from a file', () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'agentic-ai-writer-cli-'));
  const patchPath = join(projectRoot, 'agents.diff');
  writeFileSync(patchPath, agentsPatch());

  const result = spawnSync(process.execPath, [
    scriptPath,
    'add',
    '--project-root',
    projectRoot,
    '--classification',
    'project-specific',
    '--target',
    'AGENTS.md',
    '--action',
    'update',
    '--rationale',
    'capture durable project guidance',
    '--proposed-patch-file',
    patchPath,
  ], { encoding: 'utf8' });

  assert.equal(result.status, 0, result.stderr);
  const proposal = JSON.parse(readFileSync(join(projectRoot, '.agentic-ai/proposals/active.json'), 'utf8'));
  assert.equal(proposal.proposals.length, 1);
  assert.match(proposal.proposals[0].proposed_patch, /Prefer small patches/);
});

test('rejects invalid targets, unsafe content, and malformed patches', () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'agentic-ai-writer-'));
  beginMaintainerProposal({ projectRoot });

  assert.throws(() => addMaintainerProposal({
    projectRoot,
    proposal: {
      classification: 'generic',
      target: 'src/app.js',
      action: 'update',
      rationale: 'bad target',
      proposed_patch: agentsPatch(),
    },
  }), /invalid target/);

  assert.throws(() => addMaintainerProposal({
    projectRoot,
    proposal: {
      classification: 'generic',
      target: 'skillhub',
      action: 'record',
      rationale: 'contains a private path',
      upstream_feedback: 'Observed in /home/user/private-project.',
    },
  }), /private local path/);

  assert.throws(() => addMaintainerProposal({
    projectRoot,
    proposal: {
      classification: 'generic',
      target: 'skillhub',
      action: 'record',
      rationale: 'contains a secret',
      upstream_feedback: 'token sk-abcdefghijklmnopqrstuvwxyz',
    },
  }), /raw secret/);

  assert.throws(() => addMaintainerProposal({
    projectRoot,
    proposal: {
      classification: 'generic',
      target: 'skillhub',
      action: 'record',
      rationale: 'contains raw transcript',
      upstream_feedback: '{"timestamp":"now","type":"response_item"}',
    },
  }), /raw secret or transcript/);

  assert.throws(() => addMaintainerProposal({
    projectRoot,
    proposal: {
      classification: 'project-specific',
      target: 'AGENTS.md',
      action: 'update',
      rationale: 'malformed patch',
      proposed_patch: 'not a diff',
    },
  }), /file changes/);
});

function agentsPatch() {
  return [
    '--- /dev/null',
    '+++ b/AGENTS.md',
    '@@ -0,0 +1,2 @@',
    '+# Instructions',
    '+Prefer small patches.',
    '',
  ].join('\n');
}

function managedSkillPatch() {
  return [
    '--- a/.agents/skills/demo/SKILL.md',
    '+++ b/.agents/skills/demo/SKILL.md',
    '@@ -1,4 +1,5 @@',
    ' ---',
    ' name: demo',
    ' description: demo',
    ' ---',
    '+Use this carefully.',
    '',
  ].join('\n');
}

function skillhubPatch() {
  return [
    '--- /dev/null',
    '+++ b/skill-hub/demo/SKILL.md',
    '@@ -0,0 +1,5 @@',
    '+---',
    '+name: demo',
    '+description: demo skill',
    '+---',
    '+# Demo',
    '',
  ].join('\n');
}
