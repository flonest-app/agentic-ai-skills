import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_PACKAGE_SPEC,
  buildGitHubReleasePackageSpec,
  buildNpmInstallArgs,
  installMaintainer,
  pathIncludesDir,
  parseGitHubReleasePackageSpec,
  prepareNpmPackageSpec,
  resolveProfilePaths,
  resolveInstallPlan,
  resolveGitHubApiAssetUrl,
  shouldDownloadPackageSpec,
  toHomeRelativePath,
} from '../skill-hub/agentic-ai-lite/scripts/install-maintainer.mjs';

test('defaults to the GitHub Release tarball, not an npm registry package', () => {
  assert.equal(
    DEFAULT_PACKAGE_SPEC,
    'https://github.com/flonest-app/agentic-ai-skills/releases/latest/download/agentic-ai.tgz',
  );
  assert.equal(
    buildGitHubReleasePackageSpec({ tag: 'v0.1.0' }),
    'https://github.com/flonest-app/agentic-ai-skills/releases/download/v0.1.0/agentic-ai.tgz',
  );
});

test('builds agi installer plan under the user Agentic AI home', () => {
  const home = mkdtempSync(join(tmpdir(), 'agentic-ai-home-'));
  const plan = resolveInstallPlan({
    home,
    env: {},
    packageSpec: 'file:/tmp/agentic-ai.tgz',
  });

  assert.equal(plan.agenticAiHome, join(home, '.agentic-ai'));
  assert.equal(plan.codexHome, join(home, '.agentic-ai/codex-home'));
  assert.equal(plan.projectsDir, join(home, '.agentic-ai/projects'));
  assert.equal(plan.binDir, join(home, '.agentic-ai/bin'));
  assert.equal(plan.cacheDir, join(home, '.agentic-ai/cache'));
  assert.equal(plan.agiPath, join(home, '.agentic-ai/bin/agi'));
  assert.deepEqual(buildNpmInstallArgs(plan), [
    'install',
    '--global',
    '--prefix',
    join(home, '.agentic-ai'),
    'file:/tmp/agentic-ai.tgz',
  ]);
});

test('installMaintainer passes release tag into the install plan', () => {
  const home = mkdtempSync(join(tmpdir(), 'agentic-ai-install-'));
  const result = installMaintainer({
    home,
    env: {},
    releaseTag: 'v0.1.13',
    skipNpmInstall: true,
    updateProfile: false,
  });

  assert.equal(
    result.packageSpec,
    'https://github.com/flonest-app/agentic-ai-skills/releases/download/v0.1.13/agentic-ai.tgz',
  );
});

test('installer downloads release URLs before npm install', () => {
  const cacheDir = mkdtempSync(join(tmpdir(), 'agentic-ai-cache-'));
  const calls = [];
  const downloaded = prepareNpmPackageSpec({
    packageSpec: DEFAULT_PACKAGE_SPEC,
    cacheDir,
    consoleImpl: { log() {} },
    spawnSyncImpl: (command, args) => {
      calls.push({ command, args });
      const output = args[args.indexOf('--output') + 1];
      writeFileSync(output, 'tgz');
      return { status: 0 };
    },
  });

  assert.equal(downloaded, join(cacheDir, 'agentic-ai.tgz'));
  assert.equal(calls[0].command, 'curl');
  assert.deepEqual(calls[0].args.slice(0, 2), ['--fail', '--location']);
  assert.equal(calls[0].args.includes('--retry-all-errors'), true);
  assert.equal(calls[0].args.at(-1), DEFAULT_PACKAGE_SPEC);
  assert.equal(shouldDownloadPackageSpec(DEFAULT_PACKAGE_SPEC), true);
  assert.equal(shouldDownloadPackageSpec('@flonest/agentic-ai@test'), false);
});

test('installer can fall back to GitHub asset API downloads', () => {
  const cacheDir = mkdtempSync(join(tmpdir(), 'agentic-ai-cache-'));
  const packageSpec = buildGitHubReleasePackageSpec({ tag: 'v0.1.13' });
  const calls = [];
  const downloaded = prepareNpmPackageSpec({
    packageSpec,
    cacheDir,
    consoleImpl: { log() {} },
    spawnSyncImpl: (command, args, options = {}) => {
      calls.push({ command, args, options });
      const url = args.at(-1);
      if (url === packageSpec) return { status: 22 };
      if (String(url).includes('/releases/tags/v0.1.13')) {
        return {
          status: 0,
          stdout: JSON.stringify({
            assets: [{ name: 'agentic-ai.tgz', url: 'https://api.github.test/assets/123' }],
          }),
        };
      }
      if (url === 'https://api.github.test/assets/123') {
        const output = args[args.indexOf('--output') + 1];
        writeFileSync(output, 'tgz');
        return { status: 0 };
      }
      return { status: 1 };
    },
  });

  assert.equal(downloaded, join(cacheDir, 'agentic-ai.tgz'));
  assert.equal(calls.some((call) => call.args.includes('Accept: application/octet-stream')), true);
  assert.deepEqual(parseGitHubReleasePackageSpec(packageSpec), {
    repository: 'flonest-app/agentic-ai-skills',
    tag: 'v0.1.13',
    asset: 'agentic-ai.tgz',
  });
  assert.equal(resolveGitHubApiAssetUrl({
    packageSpec,
    spawnSyncImpl: () => ({
      status: 0,
      stdout: JSON.stringify({ assets: [{ name: 'other.tgz', url: 'nope' }] }),
    }),
  }), null);
});

test('installer creates runtime root and profile PATH hint without npm in dry mode', () => {
  const home = mkdtempSync(join(tmpdir(), 'agentic-ai-install-'));
  const profile = join(home, '.profile');
  const result = installMaintainer({
    home,
    env: {},
    shellProfile: profile,
    packageSpec: '@flonest/agentic-ai@test',
    skipNpmInstall: true,
  });

  assert.equal(existsSync(result.agenticAiHome), true);
  assert.equal(existsSync(result.codexHome), true);
  assert.equal(existsSync(result.projectsDir), true);
  assert.equal(existsSync(result.binDir), true);
  assert.equal(result.profileChanged, true);
  assert.deepEqual(result.profileChangedPaths, [profile]);
  assert.match(readFileSync(profile, 'utf8'), /export PATH="\$HOME\/\.agentic-ai\/bin:\$PATH"/);
  assert.equal(toHomeRelativePath(join(home, '.agentic-ai/bin'), home), '$HOME/.agentic-ai/bin');
});

test('installer updates login and shell startup profiles for common shells', () => {
  const home = mkdtempSync(join(tmpdir(), 'agentic-ai-install-'));
  const result = installMaintainer({
    home,
    env: { SHELL: '/bin/bash', PATH: `/usr/bin:${join(home, '.agentic-ai/bin')}` },
    packageSpec: '@flonest/agentic-ai@test',
    skipNpmInstall: true,
  });

  const expectedProfiles = [join(home, '.profile'), join(home, '.bashrc')];
  assert.deepEqual(result.profilePaths, expectedProfiles);
  assert.deepEqual(result.profileChangedPaths, expectedProfiles);
  assert.equal(result.pathReady, true);
  for (const profile of expectedProfiles) {
    assert.match(readFileSync(profile, 'utf8'), /export PATH="\$HOME\/\.agentic-ai\/bin:\$PATH"/);
  }
  const zshHome = mkdtempSync(join(tmpdir(), 'agentic-ai-install-'));
  assert.deepEqual(resolveProfilePaths({ home: zshHome, env: { SHELL: '/bin/zsh' } }), [join(zshHome, '.profile'), join(zshHome, '.zshrc')]);
  assert.equal(pathIncludesDir(join(home, '.agentic-ai/bin'), `$HOME/.agentic-ai/bin:/usr/bin`, home), true);
});

test('agi help advertises the no-argument command and account recovery tools', () => {
  const result = spawnSync(process.execPath, ['bin/agentic-ai.mjs', '--help'], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage:\n  agi/);
  assert.match(result.stdout, /agi account switch/);
  assert.match(result.stdout, /quota/i);
});

test('agi account commands target only the isolated Agentic AI Codex home', () => {
  const home = mkdtempSync(join(tmpdir(), 'agentic-ai-account-'));
  const fakeCodex = join(home, 'codex');
  const logPath = join(home, 'codex-calls.log');
  writeFileSync(fakeCodex, [
    '#!/bin/sh',
    'printf "%s|%s\\n" "$CODEX_HOME" "$*" >> "$FAKE_CODEX_LOG"',
    'exit 0',
    '',
  ].join('\n'));
  chmodSync(fakeCodex, 0o755);

  const result = spawnSync(process.execPath, ['bin/agentic-ai.mjs', 'account', 'switch'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      AGENTIC_AI_HOME: join(home, '.agentic-ai'),
      CODEX_BIN: fakeCodex,
      FAKE_CODEX_LOG: logPath,
    },
  });

  assert.equal(result.status, 0);
  assert.deepEqual(readFileSync(logPath, 'utf8').trim().split('\n'), [
    `${join(home, '.agentic-ai/codex-home')}|logout`,
    `${join(home, '.agentic-ai/codex-home')}|login --device-auth`,
  ]);
});

test('agi login and logout are friendly account aliases, while --login is not needed', () => {
  const home = mkdtempSync(join(tmpdir(), 'agentic-ai-account-'));
  const fakeCodex = join(home, 'codex');
  const logPath = join(home, 'codex-calls.log');
  writeFileSync(fakeCodex, [
    '#!/bin/sh',
    'printf "%s|%s\\n" "$CODEX_HOME" "$*" >> "$FAKE_CODEX_LOG"',
    'exit 0',
    '',
  ].join('\n'));
  chmodSync(fakeCodex, 0o755);

  for (const arg of ['login', 'logout']) {
    const result = spawnSync(process.execPath, ['bin/agentic-ai.mjs', arg], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        AGENTIC_AI_HOME: join(home, '.agentic-ai'),
        CODEX_BIN: fakeCodex,
        FAKE_CODEX_LOG: logPath,
      },
    });

    assert.equal(result.status, 0);
  }

  assert.deepEqual(readFileSync(logPath, 'utf8').trim().split('\n'), [
    `${join(home, '.agentic-ai/codex-home')}|login --device-auth`,
    `${join(home, '.agentic-ai/codex-home')}|logout`,
  ]);

  const flag = spawnSync(process.execPath, ['bin/agentic-ai.mjs', '--login'], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
  assert.equal(flag.status, 1);
  assert.match(flag.stderr, /agi account login/);
});
