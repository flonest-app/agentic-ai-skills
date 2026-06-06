#!/usr/bin/env node
import { createHash, createVerify } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '../../..');

export function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalize(item)).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
}

export function sha256Directory(dir) {
  const hash = createHash('sha256');
  for (const file of listFiles(dir)) {
    const rel = relative(dir, file).replaceAll('\\', '/');
    hash.update(rel);
    hash.update('\0');
    hash.update(readFileSync(file));
    hash.update('\0');
  }
  return hash.digest('hex');
}

export function verifyManifestSignature({ manifest, signature, publicKey }) {
  const verifier = createVerify('sha256');
  verifier.update(canonicalize(manifest));
  verifier.end();
  return verifier.verify(publicKey, Buffer.from(signature.trim(), 'base64'));
}

export async function checkUpdates({
  manifestRef,
  signatureRef,
  publicKeyRef,
  installedSkill,
  expectedSkillId = 'agentic-ai-lite',
} = {}) {
  const manifest = JSON.parse(await readText(manifestRef || process.env.AGENTIC_AI_MANIFEST_URL || join(repoRoot, 'registry/manifest.json')));
  const signature = await readText(signatureRef || process.env.AGENTIC_AI_MANIFEST_SIG_URL || join(repoRoot, 'registry/manifest.sig'));
  const publicKey = await readText(publicKeyRef || process.env.AGENTIC_AI_MANIFEST_PUBLIC_KEY || join(repoRoot, 'registry/keys/agentic-ai-lab-dev-public.pem'));

  if (manifest.skill_id !== expectedSkillId) {
    throw new Error(`manifest skill_id mismatch: expected ${expectedSkillId}, got ${manifest.skill_id}`);
  }

  const validSignature = verifyManifestSignature({ manifest, signature, publicKey });
  const installedHash = installedSkill && existsSync(installedSkill) ? sha256Directory(installedSkill) : null;

  return {
    skill_id: manifest.skill_id,
    version: manifest.version,
    channel: manifest.channel,
    git_ref: manifest.git_ref,
    manifestHash: manifest.sha256,
    installedHash,
    validSignature,
    updateAvailable: Boolean(installedHash && installedHash !== manifest.sha256),
    updatePolicy: manifest.update_policy,
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = await checkUpdates({
      manifestRef: args.manifest || args.manifestUrl,
      signatureRef: args.signature || args.signatureUrl,
      publicKeyRef: args.publicKey,
      installedSkill: args.installedSkill || resolve(scriptDir, '..'),
      expectedSkillId: args.expectedSkillId,
    });
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.validSignature ? 0 : 2);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--manifest') parsed.manifest = argv[++i];
    else if (arg === '--manifest-url') parsed.manifestUrl = argv[++i];
    else if (arg === '--signature') parsed.signature = argv[++i];
    else if (arg === '--signature-url') parsed.signatureUrl = argv[++i];
    else if (arg === '--public-key') parsed.publicKey = argv[++i];
    else if (arg === '--installed-skill') parsed.installedSkill = argv[++i];
    else if (arg === '--expected-skill-id') parsed.expectedSkillId = argv[++i];
    else if (arg === '--help') {
      console.log('Usage: check-updates.mjs [--manifest path|--manifest-url url] [--signature path|--signature-url url] [--public-key path] [--installed-skill path]');
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return parsed;
}

async function readText(ref) {
  if (!ref) throw new Error('missing file or URL reference');
  if (/^https?:\/\//i.test(ref)) {
    const response = await fetch(ref);
    if (!response.ok) throw new Error(`fetch failed: ${ref} (${response.status})`);
    return response.text();
  }
  return readFileSync(ref, 'utf8');
}

function listFiles(root) {
  const files = [];
  walk(root);
  return files.sort();

  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) files.push(path);
    }
  }
}
