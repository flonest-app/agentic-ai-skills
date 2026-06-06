#!/usr/bin/env node
import { cpSync, existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { registerManagedSkill } from './managed-registry.mjs';

const scriptUrl = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

export function readSkillhubInventory(path = new URL('../../../registry/skills.json', import.meta.url)) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function findSkill(inventory, skillId) {
  return inventory.skills.find((skill) => skill.skill_id === skillId);
}

export function buildInstallCommand(skill) {
  if (skill?.runtime_only || skill?.install?.type === 'runtime-skill') {
    throw new Error('runtime-only skills are initialized under ~/.agentic-ai/codex-home, not installed into project skills');
  }
  if (skill?.install?.type === 'skill-hub-copy') {
    throw new Error('skill-hub-copy installs are copied from the local Flonest skill-hub, not installed with npx skills');
  }
  if (!skill?.install?.spec) throw new Error('skill install spec is missing');
  const install = skill.install;
  const command = ['npx', 'skills', 'add', install.spec];
  const agents = normalizeList(install.agent || install.agents || 'codex');
  const skillNames = normalizeList(install.skill || install.skills);

  if (agents.length > 0) command.push('--agent', ...agents);
  if (skillNames.length > 0) command.push('--skill', ...skillNames);
  if (install.copy !== false) command.push('--copy');
  if (install.yes !== false) command.push('--yes');
  if (install.full_depth || install.fullDepth) command.push('--full-depth');
  return command;
}

export function buildExternalSkill({
  skillId,
  name,
  installSpec,
  upstreamRepo,
  upstreamSkillId,
  installedPath,
  managementMode = 'external-feedback',
  agent = 'codex',
  copy = true,
  yes = true,
}) {
  if (!skillId) throw new Error('--skill-id is required');
  if (!installSpec) throw new Error('--install-spec is required for third-party skills');
  const install = {
    type: 'npx-skills',
    spec: installSpec,
    agent,
    copy,
    yes,
  };
  if (upstreamSkillId) install.skill = upstreamSkillId;

  return {
    skill_id: skillId,
    name: name || skillId,
    version: null,
    default_project_path: installedPath || `.agents/skills/${skillId}`,
    install,
    source: 'skills-sh',
    management_mode: managementMode,
    upstream_repo: upstreamRepo || installSpec,
    upstream_skill_id: upstreamSkillId || skillId,
  };
}

export function installManagedSkill({
  projectRoot = process.cwd(),
  skillId,
  name,
  inventory,
  inventoryPath,
  installedPath,
  installSpec,
  upstreamRepo,
  upstreamSkillId,
  managementMode,
  installAgent,
  copy,
  yes,
  execute = false,
  replace = false,
  spawnImpl = spawnSync,
} = {}) {
  if (!skillId) throw new Error('--skill-id is required');
  const root = resolve(projectRoot);
  const skillInventory = inventory || readSkillhubInventory(inventoryPath || new URL('../../../registry/skills.json', import.meta.url));
  const skill = findSkill(skillInventory, skillId) || buildExternalSkill({
    skillId,
    name,
    installSpec,
    upstreamRepo,
    upstreamSkillId,
    installedPath,
    managementMode,
    agent: installAgent,
    copy,
    yes,
  });

  const targetPath = installedPath || skill.default_project_path || `.agents/skills/${skill.skill_id}`;
  assertSafeInstalledPath(targetPath);
  const installType = skill.install?.type || 'npx-skills';
  if (skill.runtime_only || installType === 'runtime-skill') {
    return {
      mode: 'runtime-only',
      skill_id: skill.skill_id,
      install_type: installType,
      source_path: resolve(repoRoot, skill.path),
      runtime_path: skill.default_runtime_path || '$AGENTIC_AI_HOME/codex-home/skills/<skill-id>',
      note: 'This skill is loaded by the Agentic AI appserver runtime and is not installed into project .agents/skills.',
    };
  }
  const command = installType === 'npx-skills' ? buildInstallCommand(skill) : null;
  const sourcePath = installType === 'skill-hub-copy' ? resolve(repoRoot, skill.path) : null;

  if (!execute) {
    return {
      mode: 'dry-run',
      skill_id: skill.skill_id,
      install_type: installType,
      command,
      copy_from: sourcePath,
      copy_to: resolve(root, targetPath),
      register_after_install: {
        project_root: root,
        path: targetPath,
        management_mode: skill.management_mode || 'flonest-owned',
        upstream_repo: skill.upstream_repo || null,
      },
      note: 'Add --execute to install and register the managed skill.',
    };
  }

  if (installType === 'skill-hub-copy') {
    if (!existsSync(sourcePath)) throw new Error(`skill-hub source is missing: ${sourcePath}`);
    const destination = resolve(root, targetPath);
    if (existsSync(destination) && !replace) {
      throw new Error(`destination already exists; pass --replace to overwrite: ${targetPath}`);
    }
    cpSync(sourcePath, destination, { recursive: true, force: Boolean(replace) });
  } else {
    const result = spawnImpl(command[0], command.slice(1), {
      cwd: root,
      encoding: 'utf8',
      stdio: 'pipe',
    });

    if (result.status !== 0) {
      const error = new Error(result.stderr || result.stdout || `install command failed with status ${result.status || 1}`);
      error.status = result.status || 1;
      throw error;
    }
  }

  const registered = registerManagedSkill({
    projectRoot: root,
    skillId: skill.skill_id,
    name: skill.name,
    skillPath: targetPath,
    source: skill.source === 'skills-sh' ? 'installed-skills-sh' : 'installed-public-skillhub',
    managementMode: skill.management_mode || 'flonest-owned',
    upstreamRepo: skill.upstream_repo || null,
    upstreamSkillId: skill.upstream_skill_id || null,
    installSpec: skill.install?.spec || skill.path,
    version: skill.version,
  });

  return { ok: true, installed: skill.skill_id, installed_path: targetPath, registered };
}

if (import.meta.url === scriptUrl) {
  const args = parseArgs(process.argv.slice(2));
  const result = installManagedSkill({
    projectRoot: args.projectRoot,
    skillId: args.skillId,
    name: args.name,
    inventoryPath: args.inventory,
    installedPath: args.installedPath,
    installSpec: args.installSpec,
    upstreamRepo: args.upstreamRepo,
    upstreamSkillId: args.upstreamSkillId,
    managementMode: args.managementMode,
    installAgent: args.installAgent,
    copy: args.copy,
    yes: args.yes,
    execute: args.execute,
    replace: args.replace,
  });
  console.log(JSON.stringify(result, null, 2));
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--project-root') parsed.projectRoot = argv[++i];
    else if (arg === '--skill-id') parsed.skillId = argv[++i];
    else if (arg === '--name') parsed.name = argv[++i];
    else if (arg === '--inventory') parsed.inventory = argv[++i];
    else if (arg === '--installed-path') parsed.installedPath = argv[++i];
    else if (arg === '--install-spec') parsed.installSpec = argv[++i];
    else if (arg === '--upstream-repo') parsed.upstreamRepo = argv[++i];
    else if (arg === '--upstream-skill-id') parsed.upstreamSkillId = argv[++i];
    else if (arg === '--management-mode') parsed.managementMode = argv[++i];
    else if (arg === '--install-agent') parsed.installAgent = argv[++i];
    else if (arg === '--install-skill') parsed.upstreamSkillId = argv[++i];
    else if (arg === '--symlink') parsed.copy = false;
    else if (arg === '--allow-prompts') parsed.yes = false;
    else if (arg === '--execute') parsed.execute = true;
    else if (arg === '--replace') parsed.replace = true;
    else if (arg === '--help') {
      console.log('Usage: install-managed-skill.mjs --skill-id <id> [--project-root repo] [--install-spec owner/repo] [--upstream-skill-id skill] [--install-agent codex] [--management-mode external-feedback] [--execute]');
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!parsed.skillId) throw new Error('--skill-id is required');
  return parsed;
}

function normalizeList(value) {
  if (!value) return [];
  return Array.isArray(value) ? value.filter(Boolean) : [value].filter(Boolean);
}

function assertSafeInstalledPath(path) {
  const normalized = String(path || '').replaceAll('\\', '/');
  if (!normalized || normalized.startsWith('/') || normalized.includes('..')) {
    throw new Error(`unsafe installed path: ${path}`);
  }
  if (!normalized.startsWith('.agents/skills/')) {
    throw new Error(`managed skills must install under .agents/skills/: ${path}`);
  }
  if (/(^|\/)\.env($|[.\-/])|secret/i.test(normalized)) {
    throw new Error(`secret-like installed path is denied: ${path}`);
  }
}
