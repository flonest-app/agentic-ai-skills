import { createSign, generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalize, sha256Directory } from '../runtime/agentic-ai-maintainer/scripts/check-updates.mjs';
import { registerManagedSkill } from '../runtime/agentic-ai-maintainer/scripts/managed-registry.mjs';
import { reconcileSignedManagedSkills } from '../runtime/agentic-ai-maintainer/scripts/reconcile-signed-skills.mjs';

test('replaces clean local draft skills with signed upstream versions and keeps backup', async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'agentic-ai-reconcile-'));
  const skillDir = join(projectRoot, '.agents/skills/demo');
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: demo\ndescription: local draft\n---\n');
  registerManagedSkill({
    projectRoot,
    skillId: 'demo',
    name: 'Demo',
    skillPath: '.agents/skills/demo',
    source: 'created-local',
  });

  const signed = createSignedManifestFixture();
  const result = await reconcileSignedManagedSkills({
    projectRoot,
    manifestRef: signed.manifestPath,
    signatureRef: signed.signaturePath,
    publicKeyRef: signed.publicKeyPath,
    inventory: {
      skills: [{
        skill_id: 'demo',
        name: 'Demo',
        path: 'skill-hub/demo',
        default_project_path: '.agents/skills/demo',
        source: 'flonest-skillhub',
        management_mode: 'flonest-owned',
        install: { type: 'npx-skills', spec: 'flonest-app/agentic-ai-skills', skill: 'demo' },
      }],
    },
    installManagedSkillImpl: (args) => {
      writeFileSync(join(args.projectRoot, args.installedPath, 'SKILL.md'), '---\nname: demo\ndescription: signed upstream\n---\n');
      return { installed_path: args.installedPath, registered: { relative_path: args.installedPath } };
    },
  });

  assert.equal(result.status, 'reconciled');
  assert.equal(result.results[0].status, 'replaced-with-signed-upstream');
  assert.equal(existsSync(join(result.results[0].backup_path, 'SKILL.md')), true);
  assert.match(readFileSync(join(skillDir, 'SKILL.md'), 'utf8'), /signed upstream/);
});

function createSignedManifestFixture() {
  const root = mkdtempSync(join(tmpdir(), 'agentic-ai-manifest-'));
  const skillHub = join(root, 'skill-hub');
  mkdirSync(join(skillHub, 'demo'), { recursive: true });
  writeFileSync(join(skillHub, 'demo/SKILL.md'), '---\nname: demo\ndescription: signed upstream\n---\n');
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const manifest = {
    skill_id: 'agentic-ai-skillhub',
    name: 'Agentic AI Skillhub',
    version: '0.1.0',
    channel: 'stable',
    git_ref: 'main',
    signature_key_id: 'test',
    update_policy: 'verify-signature-preserve-local-edits',
    sha256: sha256Directory(skillHub),
  };
  const signer = createSign('sha256');
  signer.update(canonicalize(manifest));
  signer.end();
  const manifestPath = join(root, 'manifest.json');
  const signaturePath = join(root, 'manifest.sig');
  const publicKeyPath = join(root, 'public.pem');
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(signaturePath, `${signer.sign(privateKey).toString('base64')}\n`);
  writeFileSync(publicKeyPath, publicKey.export({ type: 'spki', format: 'pem' }));
  return { manifestPath, signaturePath, publicKeyPath };
}
