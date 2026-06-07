#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { checkUpdates, findManifestSkill, sha256Directory } from '../runtime/agentic-ai-maintainer/scripts/check-updates.mjs';

const mjsFiles = [
  'bin/agentic-ai.mjs',
  'skill-hub/agentic-ai-lite/scripts/install-maintainer.mjs',
  'runtime/agentic-ai-maintainer/scripts/codex-login.mjs',
  'runtime/agentic-ai-maintainer/scripts/check-updates.mjs',
  'runtime/agentic-ai-maintainer/scripts/codex-errors.mjs',
  'runtime/agentic-ai-maintainer/scripts/submit-feedback.mjs',
  'runtime/agentic-ai-maintainer/scripts/user-log.mjs',
  'runtime/agentic-ai-maintainer/scripts/appserver-task.mjs',
  'runtime/agentic-ai-maintainer/scripts/collect-maintainer-context.mjs',
  'runtime/agentic-ai-maintainer/scripts/maintainer-runtime.mjs',
  'runtime/agentic-ai-maintainer/scripts/proposal-controller.mjs',
  'runtime/agentic-ai-maintainer/scripts/write-maintainer-proposal.mjs',
  'runtime/agentic-ai-maintainer/scripts/read-conversation-slice.mjs',
  'runtime/agentic-ai-maintainer/scripts/labserver-sync.mjs',
  'runtime/agentic-ai-maintainer/scripts/reconcile-signed-skills.mjs',
  'runtime/agentic-ai-maintainer/scripts/start-maintainer.mjs',
  'runtime/agentic-ai-maintainer/scripts/maintainer-daemon.mjs',
  'runtime/agentic-ai-maintainer/scripts/status.mjs',
  'runtime/agentic-ai-maintainer/scripts/stop-maintainer.mjs',
  'runtime/agentic-ai-maintainer/scripts/discover-project-conversations.mjs',
  'runtime/agentic-ai-maintainer/scripts/discover-skills.mjs',
  'runtime/agentic-ai-maintainer/scripts/managed-registry.mjs',
  'runtime/agentic-ai-maintainer/scripts/install-managed-skill.mjs',
  'scripts/prepare-github-release.mjs',
  'scripts/sign-manifest.mjs',
  'scripts/validate.mjs',
];

for (const file of mjsFiles) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout);
    process.exit(result.status || 1);
  }
}

const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));
if (packageJson.bin?.agi !== 'bin/agentic-ai.mjs') {
  throw new Error('package.json must expose the agi binary');
}
if (packageJson.private !== true) {
  throw new Error('package.json must remain private because releases use GitHub assets, not the npm registry');
}

const skill = readFileSync('skill-hub/agentic-ai-lite/SKILL.md', 'utf8');
if (!skill.startsWith('---\n')) throw new Error('SKILL.md missing frontmatter');
const end = skill.indexOf('\n---', 4);
if (end < 0) throw new Error('SKILL.md missing closing frontmatter');
const header = skill.slice(4, end);
if (!/^name:\s*agentic-ai-lite$/m.test(header)) throw new Error('SKILL.md missing name');
if (!/^description:\s*.+$/m.test(header)) throw new Error('SKILL.md missing description');

const openaiYaml = readFileSync('skill-hub/agentic-ai-lite/agents/openai.yaml', 'utf8');
if (!/allow_implicit_invocation:\s*false/.test(openaiYaml)) {
  throw new Error('agentic-ai-lite must not be implicitly invoked by normal coding agents');
}

const update = await checkUpdates({
  manifestRef: 'registry/manifest.json',
  signatureRef: 'registry/manifest.sig',
  publicKeyRef: 'registry/keys/agentic-ai-lab-dev-public.pem',
  installedSkill: 'skill-hub',
  expectedSkillId: 'agentic-ai-skillhub',
});

if (!update.validSignature) throw new Error('manifest signature is invalid');
if (update.manifestHash !== sha256Directory('skill-hub')) {
  throw new Error('manifest hash does not match skill-hub directory');
}

const inventory = JSON.parse(readFileSync('registry/skills.json', 'utf8'));
const manifest = JSON.parse(readFileSync('registry/manifest.json', 'utf8'));
if (!Array.isArray(inventory.skills)) {
  throw new Error('registry/skills.json must contain a skills array');
}
for (const skill of inventory.skills) {
  if (!skill.skill_id || !skill.path || !skill.install?.type) {
    throw new Error(`registry skill is missing required fields: ${JSON.stringify(skill)}`);
  }
  if (!skill.path.startsWith('skill-hub/')) {
    throw new Error(`managed skill must live under skill-hub/: ${skill.skill_id}`);
  }
  if (!skill.default_project_path) {
    throw new Error(`project-managed skill is missing default_project_path: ${skill.skill_id}`);
  }
  if (Array.isArray(manifest.skills)) {
    const manifestSkill = findManifestSkill(manifest, skill.skill_id);
    if (!manifestSkill) {
      throw new Error(`manifest is missing per-skill hash: ${skill.skill_id}`);
    }
    if (manifestSkill.path !== skill.path) {
      throw new Error(`manifest skill path mismatch for ${skill.skill_id}: ${manifestSkill.path} !== ${skill.path}`);
    }
    const currentSkillHash = sha256Directory(skill.path);
    if (manifestSkill.sha256 !== currentSkillHash) {
      throw new Error(`manifest skill hash mismatch for ${skill.skill_id}`);
    }
  }
}

console.log(`validation ok (${mjsFiles.length} scripts)`);
