#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const DEFAULT_RELEASE_REPOSITORY = 'flonest-app/agentic-ai-skills';
export const DEFAULT_RELEASE_TAG = 'latest';
export const DEFAULT_RELEASE_ASSET = 'agentic-ai.tgz';
export const DEFAULT_PACKAGE_SPEC = buildGitHubReleasePackageSpec();

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = installMaintainer(args);
    console.log('');
    console.log('Agentic AI installed.');
    console.log(`Runtime home: ${result.agenticAiHome}`);
    if (result.profileChanged) {
      console.log(`PATH updated in ${result.profilePath}. Open a new terminal if this shell cannot find agi yet.`);
    }
    console.log('You can start the maintainer with: agi');
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

export function installMaintainer({
  agenticAiHome,
  packageSpec,
  npmCommand = process.env.NPM_BIN || 'npm',
  shellProfile,
  skipNpmInstall = false,
  updateProfile = true,
  env = process.env,
  home = homedir(),
} = {}) {
  const plan = resolveInstallPlan({ agenticAiHome, packageSpec, shellProfile, updateProfile, env, home });

  for (const dir of [plan.agenticAiHome, plan.codexHome, plan.projectsDir, plan.binDir]) {
    mkdirSync(dir, { recursive: true });
  }

  if (!skipNpmInstall) {
    const install = spawnSync(npmCommand, buildNpmInstallArgs(plan), {
      stdio: 'inherit',
      env,
    });
    if (install.status !== 0) {
      throw new Error(`npm install failed for ${plan.packageSpec}`);
    }
  }

  const profileChanged = plan.updateProfile
    ? ensurePathInProfile({ profilePath: plan.profilePath, binDir: plan.binDir, home })
    : false;

  if (!skipNpmInstall && !existsSync(plan.agiPath)) {
    throw new Error(`agi was not installed at ${plan.agiPath}`);
  }

  return { ...plan, profileChanged };
}

export function resolveInstallPlan({
  agenticAiHome,
  packageSpec,
  releaseRepository,
  releaseTag,
  releaseAsset,
  shellProfile,
  updateProfile = true,
  env = process.env,
  home = homedir(),
} = {}) {
  const root = resolve(agenticAiHome || env.AGENTIC_AI_HOME || join(home, '.agentic-ai'));
  const binName = process.platform === 'win32' ? 'agi.cmd' : 'agi';
  return {
    packageSpec: packageSpec || env.AGENTIC_AI_PACKAGE || buildGitHubReleasePackageSpec({
      repository: releaseRepository || env.AGENTIC_AI_RELEASE_REPOSITORY,
      tag: releaseTag || env.AGENTIC_AI_RELEASE_TAG,
      asset: releaseAsset || env.AGENTIC_AI_RELEASE_ASSET,
    }),
    agenticAiHome: root,
    codexHome: join(root, 'codex-home'),
    projectsDir: join(root, 'projects'),
    binDir: join(root, 'bin'),
    agiPath: join(root, 'bin', binName),
    profilePath: resolve(shellProfile || env.AGENTIC_AI_PROFILE || join(home, '.profile')),
    updateProfile,
  };
}

export function buildGitHubReleasePackageSpec({
  repository = DEFAULT_RELEASE_REPOSITORY,
  tag = DEFAULT_RELEASE_TAG,
  asset = DEFAULT_RELEASE_ASSET,
} = {}) {
  const normalizedTag = tag === 'latest' ? 'latest/download' : `download/${tag}`;
  return `https://github.com/${repository}/releases/${normalizedTag}/${asset}`;
}

export function buildNpmInstallArgs(plan) {
  return ['install', '--global', '--prefix', plan.agenticAiHome, plan.packageSpec];
}

export function ensurePathInProfile({ profilePath, binDir, home = homedir() }) {
  mkdirSync(dirname(profilePath), { recursive: true });
  const profileBin = toHomeRelativePath(binDir, home);
  const line = `export PATH="${profileBin}:$PATH"`;
  const marker = '# Agentic AI CLI';
  const content = existsSync(profilePath) ? readFileSync(profilePath, 'utf8') : '';
  if (content.includes(line)) return false;

  const prefix = content.length > 0 && !content.endsWith('\n') ? '\n' : '';
  writeFileSync(profilePath, `${content}${prefix}${marker}\n${line}\n`);
  return true;
}

export function toHomeRelativePath(path, home = homedir()) {
  const absolute = resolve(path);
  const root = resolve(home);
  if (absolute === root) return '$HOME';
  if (absolute.startsWith(`${root}/`)) return `$HOME/${absolute.slice(root.length + 1)}`;
  return absolute;
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--agentic-ai-home') parsed.agenticAiHome = argv[++i];
    else if (arg === '--package') parsed.packageSpec = argv[++i];
    else if (arg === '--release-repo') parsed.releaseRepository = argv[++i];
    else if (arg === '--release-tag') parsed.releaseTag = argv[++i];
    else if (arg === '--release-asset') parsed.releaseAsset = argv[++i];
    else if (arg === '--npm') parsed.npmCommand = argv[++i];
    else if (arg === '--profile') parsed.shellProfile = argv[++i];
    else if (arg === '--no-profile') parsed.updateProfile = false;
    else if (arg === '--skip-npm-install') parsed.skipNpmInstall = true;
    else if (arg === '--help') {
      console.log('Usage: install-maintainer.mjs [--agentic-ai-home ~/.agentic-ai] [--release-tag latest|v0.1.0] [--package URL]');
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return parsed;
}
