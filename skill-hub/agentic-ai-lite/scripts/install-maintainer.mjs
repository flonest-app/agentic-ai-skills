#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
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
    if (result.profileChangedPaths.length > 0) {
      console.log(`PATH updated in ${formatPathList(result.profileChangedPaths)}.`);
    }
    if (result.pathReady) {
      console.log('You can start the maintainer with: agi');
    } else {
      console.log('Open a new terminal, then start the maintainer with: agi');
    }
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

export function installMaintainer({
  agenticAiHome,
  packageSpec,
  releaseRepository,
  releaseTag,
  releaseAsset,
  npmCommand = process.env.NPM_BIN || 'npm',
  downloadCommand = process.env.AGENTIC_AI_DOWNLOAD_BIN || 'curl',
  shellProfile,
  skipNpmInstall = false,
  updateProfile = true,
  env = process.env,
  home = homedir(),
  spawnSyncImpl = spawnSync,
  consoleImpl = console,
} = {}) {
  const plan = resolveInstallPlan({
    agenticAiHome,
    packageSpec,
    releaseRepository,
    releaseTag,
    releaseAsset,
    shellProfile,
    updateProfile,
    env,
    home,
  });

  for (const dir of [plan.agenticAiHome, plan.codexHome, plan.projectsDir, plan.binDir, plan.cacheDir]) {
    mkdirSync(dir, { recursive: true });
  }

  if (!skipNpmInstall) {
    const npmPackageSpec = prepareNpmPackageSpec({
      packageSpec: plan.packageSpec,
      cacheDir: plan.cacheDir,
      downloadCommand,
      env,
      spawnSyncImpl,
      consoleImpl,
    });
    consoleImpl.log(`Installing Agentic AI CLI from ${npmPackageSpec}`);
    const install = spawnSyncImpl(npmCommand, buildNpmInstallArgs({ ...plan, packageSpec: npmPackageSpec }), {
      stdio: 'inherit',
      env,
    });
    if (install.status !== 0) {
      throw new Error(`npm install failed for ${plan.packageSpec}`);
    }
  }

  const profileChangedPaths = plan.updateProfile
    ? ensurePathInProfiles({ profilePaths: plan.profilePaths, binDir: plan.binDir, home })
    : [];

  if (!skipNpmInstall && !existsSync(plan.agiPath)) {
    throw new Error(`agi was not installed at ${plan.agiPath}`);
  }

  return {
    ...plan,
    profileChanged: profileChangedPaths.length > 0,
    profileChangedPaths,
    pathReady: pathIncludesDir(plan.binDir, env.PATH || '', home),
  };
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
  const profilePaths = resolveProfilePaths({ shellProfile, env, home });
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
    cacheDir: join(root, 'cache'),
    agiPath: join(root, 'bin', binName),
    profilePath: profilePaths[0],
    profilePaths,
    updateProfile,
  };
}

export function resolveProfilePaths({ shellProfile, env = process.env, home = homedir() } = {}) {
  const explicitProfile = shellProfile || env.AGENTIC_AI_PROFILE;
  if (explicitProfile) return [resolve(explicitProfile)];

  const paths = [join(home, '.profile')];
  const shellName = basename(env.SHELL || '');
  const bashProfile = join(home, '.bashrc');
  const zshProfile = join(home, '.zshrc');
  if (shellName.includes('bash') || existsSync(bashProfile)) paths.push(bashProfile);
  if (shellName.includes('zsh') || existsSync(zshProfile)) paths.push(zshProfile);
  return [...new Set(paths.map((path) => resolve(path)))];
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

export function prepareNpmPackageSpec({
  packageSpec,
  cacheDir,
  downloadCommand = 'curl',
  env = process.env,
  spawnSyncImpl = spawnSync,
  consoleImpl = console,
} = {}) {
  if (!shouldDownloadPackageSpec(packageSpec)) return packageSpec;
  return downloadReleasePackage({
    packageSpec,
    cacheDir,
    downloadCommand,
    env,
    spawnSyncImpl,
    consoleImpl,
  });
}

export function shouldDownloadPackageSpec(packageSpec) {
  try {
    const url = new URL(packageSpec);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

export function downloadReleasePackage({
  packageSpec,
  cacheDir,
  downloadCommand = 'curl',
  env = process.env,
  spawnSyncImpl = spawnSync,
  consoleImpl = console,
} = {}) {
  if (!cacheDir) throw new Error('cacheDir is required to download release package');
  mkdirSync(cacheDir, { recursive: true });
  const assetName = safeAssetName(packageSpec);
  const target = join(cacheDir, assetName);
  consoleImpl.log(`Downloading Agentic AI release: ${packageSpec}`);
  const download = runCurlDownload({
    downloadCommand,
    url: packageSpec,
    target,
    env,
    spawnSyncImpl,
  });
  if (download.status === 0 && existsSync(target)) return target;

  const fallback = resolveGitHubApiAssetUrl({
    packageSpec,
    downloadCommand,
    env,
    spawnSyncImpl,
  });
  if (fallback) {
    consoleImpl.log(`Primary download failed; retrying through GitHub asset API: ${fallback}`);
    const apiDownload = runCurlDownload({
      downloadCommand,
      url: fallback,
      target,
      headers: ['Accept: application/octet-stream'],
      env,
      spawnSyncImpl,
    });
    if (apiDownload.status === 0 && existsSync(target)) return target;
  }

  throw new Error(`download failed for ${packageSpec}`);
}

export function resolveGitHubApiAssetUrl({
  packageSpec,
  downloadCommand = 'curl',
  env = process.env,
  spawnSyncImpl = spawnSync,
} = {}) {
  const parsed = parseGitHubReleasePackageSpec(packageSpec);
  if (!parsed) return null;
  const releaseUrl = parsed.tag === 'latest'
    ? `https://api.github.com/repos/${parsed.repository}/releases/latest`
    : `https://api.github.com/repos/${parsed.repository}/releases/tags/${encodeURIComponent(parsed.tag)}`;
  const result = spawnSyncImpl(downloadCommand, [
    '--fail',
    '--location',
    '--silent',
    '--show-error',
    releaseUrl,
  ], {
    encoding: 'utf8',
    env,
  });
  if (result.status !== 0) return null;
  try {
    const release = JSON.parse(result.stdout || '{}');
    const asset = (release.assets || []).find((candidate) => candidate.name === parsed.asset);
    return asset?.url || null;
  } catch {
    return null;
  }
}

export function parseGitHubReleasePackageSpec(packageSpec) {
  let url;
  try {
    url = new URL(packageSpec);
  } catch {
    return null;
  }
  if (url.hostname !== 'github.com') return null;
  const latest = url.pathname.match(/^\/(?<owner>[^/]+)\/(?<repo>[^/]+)\/releases\/latest\/download\/(?<asset>[^/]+)$/);
  if (latest?.groups) {
    return {
      repository: `${latest.groups.owner}/${latest.groups.repo}`,
      tag: 'latest',
      asset: latest.groups.asset,
    };
  }
  const tagged = url.pathname.match(/^\/(?<owner>[^/]+)\/(?<repo>[^/]+)\/releases\/download\/(?<tag>[^/]+)\/(?<asset>[^/]+)$/);
  if (tagged?.groups) {
    return {
      repository: `${tagged.groups.owner}/${tagged.groups.repo}`,
      tag: tagged.groups.tag,
      asset: tagged.groups.asset,
    };
  }
  return null;
}

function runCurlDownload({
  downloadCommand,
  url,
  target,
  headers = [],
  env,
  spawnSyncImpl,
}) {
  const args = [
    '--fail',
    '--location',
    '--retry',
    '5',
    '--retry-delay',
    '2',
    '--retry-all-errors',
    '--connect-timeout',
    '20',
  ];
  for (const header of headers) args.push('--header', header);
  args.push('--output', target, url);
  return spawnSyncImpl(downloadCommand, args, {
    stdio: 'inherit',
    env,
  });
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

export function ensurePathInProfiles({ profilePaths, binDir, home = homedir() }) {
  const changed = [];
  for (const profilePath of profilePaths) {
    if (ensurePathInProfile({ profilePath, binDir, home })) changed.push(profilePath);
  }
  return changed;
}

export function pathIncludesDir(dir, pathValue = process.env.PATH || '', home = homedir()) {
  const target = resolve(dir);
  return String(pathValue).split(delimiter).some((entry) => {
    if (!entry) return false;
    const expanded = expandPathEntry(entry, home);
    return resolve(expanded) === target;
  });
}

function expandPathEntry(entry, home) {
  if (entry === '~' || entry === '$HOME') return home;
  if (entry.startsWith('~/')) return join(home, entry.slice(2));
  if (entry.startsWith('$HOME/')) return join(home, entry.slice(6));
  return entry;
}

function formatPathList(paths) {
  if (paths.length <= 1) return paths[0] || '';
  return `${paths.slice(0, -1).join(', ')} and ${paths.at(-1)}`;
}

function safeAssetName(packageSpec) {
  try {
    const url = new URL(packageSpec);
    return basename(url.pathname) || DEFAULT_RELEASE_ASSET;
  } catch {
    return DEFAULT_RELEASE_ASSET;
  }
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
      console.log('Usage: install-maintainer.mjs [--agentic-ai-home ~/.agentic-ai] [--release-tag latest|v0.1.15] [--package URL]');
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return parsed;
}
