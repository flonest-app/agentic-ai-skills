#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { checkUpdates, sha256Directory } from '../skills/agentic-ai-lite/scripts/check-updates.mjs';

const mjsFiles = [
  'skills/agentic-ai-lite/scripts/check-updates.mjs',
  'skills/agentic-ai-lite/scripts/submit-feedback.mjs',
  'skills/agentic-ai-lite/scripts/appserver-task.mjs',
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

const skill = readFileSync('skills/agentic-ai-lite/SKILL.md', 'utf8');
if (!skill.startsWith('---\n')) throw new Error('SKILL.md missing frontmatter');
const end = skill.indexOf('\n---', 4);
if (end < 0) throw new Error('SKILL.md missing closing frontmatter');
const header = skill.slice(4, end);
if (!/^name:\s*agentic-ai-lite$/m.test(header)) throw new Error('SKILL.md missing name');
if (!/^description:\s*.+$/m.test(header)) throw new Error('SKILL.md missing description');

const update = await checkUpdates({
  manifestRef: 'registry/manifest.json',
  signatureRef: 'registry/manifest.sig',
  publicKeyRef: 'registry/keys/agentic-ai-lab-dev-public.pem',
  installedSkill: 'skills/agentic-ai-lite',
});

if (!update.validSignature) throw new Error('manifest signature is invalid');
if (update.manifestHash !== sha256Directory('skills/agentic-ai-lite')) {
  throw new Error('manifest hash does not match skill directory');
}

console.log(`validation ok (${mjsFiles.length} scripts)`);
