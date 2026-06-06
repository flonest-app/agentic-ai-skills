#!/usr/bin/env node
import { createSign } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { canonicalize, sha256Directory } from '../skills/agentic-ai-lite/scripts/check-updates.mjs';

const args = parseArgs(process.argv.slice(2));
const skillDir = resolve(args.skillDir || 'skills/agentic-ai-lite');
const manifestPath = resolve(args.manifest || 'registry/manifest.json');
const signaturePath = resolve(args.signature || 'registry/manifest.sig');
const privateKey = readPrivateKey(args);

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
manifest.sha256 = sha256Directory(skillDir);
if (args.gitRef) manifest.git_ref = args.gitRef;

const signer = createSign('sha256');
signer.update(canonicalize(manifest));
signer.end();
const signature = signer.sign(privateKey).toString('base64');

writeFileSync(manifestPath, `${JSON.stringify(sortKeys(manifest), null, 2)}\n`);
writeFileSync(signaturePath, `${signature}\n`);

console.log(JSON.stringify({
  manifest: manifestPath,
  signature: signaturePath,
  sha256: manifest.sha256,
}, null, 2));

function readPrivateKey(parsed) {
  if (parsed.privateKeyFile) return readFileSync(parsed.privateKeyFile, 'utf8');
  if (process.env.REGISTRY_SIGNING_PRIVATE_KEY) {
    return process.env.REGISTRY_SIGNING_PRIVATE_KEY.replaceAll('\\n', '\n');
  }
  throw new Error('Provide --private-key-file or REGISTRY_SIGNING_PRIVATE_KEY');
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--skill-dir') parsed.skillDir = argv[++i];
    else if (arg === '--manifest') parsed.manifest = argv[++i];
    else if (arg === '--signature') parsed.signature = argv[++i];
    else if (arg === '--private-key-file') parsed.privateKeyFile = argv[++i];
    else if (arg === '--git-ref') parsed.gitRef = argv[++i];
    else if (arg === '--help') {
      console.log('Usage: sign-manifest.mjs --private-key-file key.pem [--git-ref ref]');
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return parsed;
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key])]));
}
