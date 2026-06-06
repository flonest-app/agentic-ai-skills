#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const args = parseArgs(process.argv.slice(2));
const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));
const version = args.version || packageJson.version;
const tag = args.tag || `v${version}`;
const distDir = resolve(args.distDir || 'dist');
const assetName = args.assetName || 'agentic-ai.tgz';
const assetPath = join(distDir, assetName);
const checksumPath = `${assetPath}.sha256`;
const metadataPath = join(distDir, 'release.json');

if (!version) throw new Error('package.json version is required');

rmSync(distDir, { recursive: true, force: true });
mkdirSync(distDir, { recursive: true });

const pack = spawnSync('npm', ['pack', '--json', '--pack-destination', distDir], {
  encoding: 'utf8',
});
if (pack.status !== 0) {
  process.stderr.write(pack.stderr || pack.stdout);
  process.exit(pack.status || 1);
}

const packed = JSON.parse(pack.stdout);
const packedFile = packed[0]?.filename;
if (!packedFile) throw new Error(`npm pack did not report a filename: ${pack.stdout}`);

const packedPath = resolve(distDir, basename(packedFile));
copyFileSync(packedPath, assetPath);

const sha256 = sha256File(assetPath);
writeFileSync(checksumPath, `${sha256}  ${assetName}\n`);

const metadata = {
  schema_version: 1,
  package_name: packageJson.name,
  version,
  tag,
  asset: assetName,
  asset_path: assetPath,
  asset_sha256: sha256,
  source_pack: basename(packedPath),
  install_url: `https://github.com/flonest-app/agentic-ai-skills/releases/download/${tag}/${assetName}`,
  latest_install_url: `https://github.com/flonest-app/agentic-ai-skills/releases/latest/download/${assetName}`,
};
writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);

console.log(JSON.stringify({
  ok: true,
  ...metadata,
  checksum_path: checksumPath,
  gh_release_command: [
    'gh',
    'release',
    'create',
    shellQuote(tag),
    shellQuote(assetPath),
    shellQuote(checksumPath),
    shellQuote(metadataPath),
    '--title',
    shellQuote(`Agentic AI ${tag}`),
  ].join(' '),
}, null, 2));

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--tag') parsed.tag = argv[++i];
    else if (arg === '--version') parsed.version = argv[++i];
    else if (arg === '--dist-dir') parsed.distDir = argv[++i];
    else if (arg === '--asset-name') parsed.assetName = argv[++i];
    else if (arg === '--help') {
      console.log('Usage: prepare-github-release.mjs [--tag v0.1.0] [--asset-name agentic-ai.tgz]');
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return parsed;
}
