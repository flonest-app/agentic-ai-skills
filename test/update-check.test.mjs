import { generateKeyPairSync, createSign } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalize,
  checkUpdates,
  findManifestSkill,
  sha256Directory,
  verifyManifestSignature,
} from '../runtime/agentic-ai-maintainer/scripts/check-updates.mjs';

test('verifies a signed manifest', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentic-ai-skill-'));
  writeFileSync(join(dir, 'SKILL.md'), '---\nname: x\ndescription: y\n---\n');

  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const manifest = {
    skill_id: 'agentic-ai-skillhub',
    version: '0.1.0',
    sha256: sha256Directory(dir),
  };
  const signer = createSign('sha256');
  signer.update(canonicalize(manifest));
  signer.end();

  const signature = signer.sign(privateKey).toString('base64');
  assert.equal(verifyManifestSignature({
    manifest,
    signature,
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }),
  }), true);
});

test('signer writes per-skill hashes into the signed manifest', () => {
  const root = mkdtempSync(join(tmpdir(), 'agentic-ai-sign-manifest-'));
  mkdirSync(join(root, 'skill-hub/demo'), { recursive: true });
  writeFileSync(join(root, 'skill-hub/demo/SKILL.md'), '---\nname: demo\ndescription: demo\n---\n');
  mkdirSync(join(root, 'registry'), { recursive: true });
  writeFileSync(join(root, 'registry/manifest.json'), `${JSON.stringify({
    skill_id: 'agentic-ai-skillhub',
    name: 'Agentic AI Skillhub',
    version: '0.1.0',
    channel: 'stable',
    signature_key_id: 'test',
    update_policy: 'verify-signature-preserve-local-edits',
    sha256: '',
  }, null, 2)}\n`);
  writeFileSync(join(root, 'registry/skills.json'), `${JSON.stringify({
    schema_version: 1,
    registry_id: 'agentic-ai-skillhub',
    skills: [{
      skill_id: 'demo',
      name: 'Demo',
      version: '0.1.0',
      channel: 'stable',
      path: 'skill-hub/demo',
      default_project_path: '.agents/skills/demo',
      install: { type: 'npx-skills', spec: 'flonest-app/agentic-ai-skills', skill: 'demo' },
    }],
  }, null, 2)}\n`);
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const keyPath = join(root, 'private.pem');
  writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }));

  const result = spawnSync(process.execPath, [
    'scripts/sign-manifest.mjs',
    '--repo-root', root,
    '--private-key-file', keyPath,
    '--git-ref', 'v-test',
  ], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const manifest = JSON.parse(readFileSync(join(root, 'registry/manifest.json'), 'utf8'));
  const signature = readFileSync(join(root, 'registry/manifest.sig'), 'utf8');
  const manifestSkill = findManifestSkill(manifest, 'demo');
  assert.equal(manifest.sha256, sha256Directory(join(root, 'skill-hub')));
  assert.equal(manifestSkill.path, 'skill-hub/demo');
  assert.equal(manifestSkill.sha256, sha256Directory(join(root, 'skill-hub/demo')));
  assert.equal(verifyManifestSignature({
    manifest,
    signature,
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }),
  }), true);
});

test('checks an installed skill against its signed per-skill hash', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agentic-ai-skill-check-'));
  const skillHub = join(root, 'skill-hub');
  const demo = join(skillHub, 'demo');
  mkdirSync(demo, { recursive: true });
  writeFileSync(join(demo, 'SKILL.md'), '---\nname: demo\ndescription: demo\n---\n');
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const manifest = {
    skill_id: 'agentic-ai-skillhub',
    version: '0.1.0',
    sha256: sha256Directory(skillHub),
    skills: [{
      skill_id: 'demo',
      path: 'skill-hub/demo',
      sha256: sha256Directory(demo),
    }],
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

  const update = await checkUpdates({
    manifestRef: manifestPath,
    signatureRef: signaturePath,
    publicKeyRef: publicKeyPath,
    installedSkill: demo,
    installedSkillId: 'demo',
  });

  assert.equal(update.validSignature, true);
  assert.equal(update.manifestHash, sha256Directory(skillHub));
  assert.equal(update.manifestSkillHash, sha256Directory(demo));
  assert.equal(update.expectedInstalledHash, update.manifestSkillHash);
  assert.equal(update.installedHash, update.manifestSkillHash);
  assert.equal(update.updateAvailable, false);
});
