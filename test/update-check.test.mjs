import { generateKeyPairSync, createSign } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalize, sha256Directory, verifyManifestSignature } from '../runtime/agentic-ai-maintainer/scripts/check-updates.mjs';

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
