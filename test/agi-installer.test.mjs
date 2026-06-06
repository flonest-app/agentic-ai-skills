import { existsSync, readFileSync } from 'node:fs';
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
  resolveInstallPlan,
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
  assert.equal(plan.agiPath, join(home, '.agentic-ai/bin/agi'));
  assert.deepEqual(buildNpmInstallArgs(plan), [
    'install',
    '--global',
    '--prefix',
    join(home, '.agentic-ai'),
    'file:/tmp/agentic-ai.tgz',
  ]);
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
  assert.match(readFileSync(profile, 'utf8'), /export PATH="\$HOME\/\.agentic-ai\/bin:\$PATH"/);
  assert.equal(toHomeRelativePath(join(home, '.agentic-ai/bin'), home), '$HOME/.agentic-ai/bin');
});

test('agi help advertises the no-argument command and not a login command', () => {
  const result = spawnSync(process.execPath, ['bin/agentic-ai.mjs', '--help'], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage:\n  agi/);
  assert.doesNotMatch(result.stdout, /agi login/);
});

test('agi login explains that login is automatic', () => {
  for (const arg of ['login', '--login']) {
    const result = spawnSync(process.execPath, ['bin/agentic-ai.mjs', arg], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /No separate login command is needed/);
  }
});
