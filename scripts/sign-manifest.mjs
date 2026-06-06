#!/usr/bin/env node
import { createSign } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { canonicalize, sha256Directory } from '../runtime/agentic-ai-maintainer/scripts/check-updates.mjs';

const args = parseArgs(process.argv.slice(2));
const repoRoot = resolve(args.repoRoot || '.');
const skillDir = resolveFromRepo(repoRoot, args.skillDir || 'skill-hub');
const manifestPath = resolveFromRepo(repoRoot, args.manifest || 'registry/manifest.json');
const signaturePath = resolveFromRepo(repoRoot, args.signature || 'registry/manifest.sig');
const inventoryPath = resolveFromRepo(repoRoot, args.inventory || 'registry/skills.json');
const privateKey = readPrivateKey(args);

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
manifest.sha256 = sha256Directory(skillDir);
manifest.skills = buildManifestSkillEntries({ inventoryPath, repoRoot, skillDir });
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
    if (arg === '--repo-root') parsed.repoRoot = argv[++i];
    else if (arg === '--skill-dir') parsed.skillDir = argv[++i];
    else if (arg === '--inventory') parsed.inventory = argv[++i];
    else if (arg === '--manifest') parsed.manifest = argv[++i];
    else if (arg === '--signature') parsed.signature = argv[++i];
    else if (arg === '--private-key-file') parsed.privateKeyFile = argv[++i];
    else if (arg === '--git-ref') parsed.gitRef = argv[++i];
    else if (arg === '--help') {
      console.log('Usage: sign-manifest.mjs --private-key-file key.pem [--git-ref ref] [--inventory registry/skills.json] [--skill-dir skill-hub]');
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return parsed;
}

function resolveFromRepo(repoRoot, path) {
  return isAbsolute(path) ? resolve(path) : resolve(repoRoot, path);
}

function buildManifestSkillEntries({ inventoryPath, repoRoot, skillDir }) {
  const inventory = JSON.parse(readFileSync(inventoryPath, 'utf8'));
  const entries = [];
  for (const skill of inventory.skills || []) {
    if (!skill.skill_id || !skill.path) throw new Error(`inventory skill is missing skill_id or path: ${JSON.stringify(skill)}`);
    const skillPath = String(skill.path).replaceAll('\\', '/');
    const absolutePath = resolve(repoRoot, skillPath);
    const relativeToSkillDir = relative(skillDir, absolutePath);
    if (relativeToSkillDir.startsWith('..') || isAbsolute(relativeToSkillDir)) {
      throw new Error(`inventory skill path must be under ${relative(repoRoot, skillDir) || skillDir}: ${skill.path}`);
    }
    if (!existsSync(absolutePath)) throw new Error(`inventory skill path is missing: ${skill.path}`);
    entries.push({
      skill_id: skill.skill_id,
      name: skill.name || skill.skill_id,
      version: skill.version || null,
      channel: skill.channel || null,
      path: skillPath,
      sha256: sha256Directory(absolutePath),
    });
  }
  return entries.sort((a, b) => a.skill_id.localeCompare(b.skill_id));
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key])]));
}
