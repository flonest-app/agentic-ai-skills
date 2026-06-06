#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { registerManagedSkill } from './managed-registry.mjs';

const scriptUrl = pathToFileURL(process.argv[1]).href;

export function readSkillhubInventory(path = new URL('../../../registry/skills.json', import.meta.url)) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function findSkill(inventory, skillId) {
  return inventory.skills.find((skill) => skill.skill_id === skillId);
}

export function buildInstallCommand(skill) {
  if (!skill?.install?.spec) throw new Error('skill install spec is missing');
  return ['npx', 'skills', 'add', skill.install.spec];
}

export function buildExternalSkill({ skillId, name, installSpec, upstreamRepo, upstreamSkillId, installedPath, managementMode = 'external-feedback' }) {
  if (!skillId) throw new Error('--skill-id is required');
  if (!installSpec) throw new Error('--install-spec is required for third-party skills');
  return {
    skill_id: skillId,
    name: name || skillId,
    version: null,
    default_project_path: installedPath || `.agents/skills/${skillId}`,
    install: {
      type: 'npx-skills',
      spec: installSpec,
    },
    source: 'skills-sh',
    management_mode: managementMode,
    upstream_repo: upstreamRepo || installSpec,
    upstream_skill_id: upstreamSkillId || skillId,
  };
}

if (import.meta.url === scriptUrl) {
  const args = parseArgs(process.argv.slice(2));
  const projectRoot = resolve(args.projectRoot || process.cwd());
  const inventory = readSkillhubInventory(args.inventory || new URL('../../../registry/skills.json', import.meta.url));
  const skill = findSkill(inventory, args.skillId) || buildExternalSkill({
    skillId: args.skillId,
    name: args.name,
    installSpec: args.installSpec,
    upstreamRepo: args.upstreamRepo,
    upstreamSkillId: args.upstreamSkillId,
    installedPath: args.installedPath,
    managementMode: args.managementMode,
  });

  const command = buildInstallCommand(skill);
  const installedPath = args.installedPath || skill.default_project_path || `.agents/skills/${skill.skill_id}`;

  if (!args.execute) {
    console.log(JSON.stringify({
      mode: 'dry-run',
      skill_id: skill.skill_id,
      command,
      register_after_install: {
        project_root: projectRoot,
        path: installedPath,
        management_mode: skill.management_mode || 'flonest-owned',
        upstream_repo: skill.upstream_repo || null,
      },
      note: 'Add --execute to run npx skills and register the installed skill.',
    }, null, 2));
    process.exit(0);
  }

  const result = spawnSync(command[0], command.slice(1), {
    cwd: projectRoot,
    encoding: 'utf8',
    stdio: 'pipe',
  });

  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout);
    process.exit(result.status || 1);
  }

  const registered = registerManagedSkill({
    projectRoot,
    skillId: skill.skill_id,
    name: skill.name,
    skillPath: installedPath,
    source: skill.source === 'skills-sh' ? 'installed-skills-sh' : 'installed-public-skillhub',
    managementMode: skill.management_mode || 'flonest-owned',
    upstreamRepo: skill.upstream_repo || null,
    upstreamSkillId: skill.upstream_skill_id || null,
    installSpec: skill.install.spec,
    version: skill.version,
  });

  console.log(JSON.stringify({ ok: true, installed: skill.skill_id, registered }, null, 2));
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
    else if (arg === '--execute') parsed.execute = true;
    else if (arg === '--help') {
      console.log('Usage: install-managed-skill.mjs --skill-id <id> [--project-root repo] [--install-spec owner/repo] [--management-mode external-feedback] [--execute]');
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!parsed.skillId) throw new Error('--skill-id is required');
  return parsed;
}
