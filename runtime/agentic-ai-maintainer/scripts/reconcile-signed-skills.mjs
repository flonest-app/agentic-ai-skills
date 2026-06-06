#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkUpdates, sha256Directory } from './check-updates.mjs';
import { findSkill, installManagedSkill, readSkillhubInventory } from './install-managed-skill.mjs';
import { listManagedSkills } from './managed-registry.mjs';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2));
  const result = await reconcileSignedManagedSkills({
    projectRoot: resolve(args.projectRoot || process.cwd()),
    manifestRef: args.manifest,
    signatureRef: args.signature,
    publicKeyRef: args.publicKey,
  });
  console.log(JSON.stringify(result, null, 2));
}

export async function reconcileSignedManagedSkills({
  projectRoot = process.cwd(),
  manifestRef,
  signatureRef,
  publicKeyRef,
  inventory,
  installManagedSkillImpl = installManagedSkill,
} = {}) {
  const root = resolve(projectRoot);
  const update = await checkUpdates({
    manifestRef,
    signatureRef,
    publicKeyRef,
    installedSkill: null,
  });

  if (!update.validSignature) {
    return { status: 'skipped', reason: 'signed skillhub manifest is not valid', results: [] };
  }

  const publicInventory = inventory || readSkillhubInventory();
  const managed = listManagedSkills({ projectRoot: root });
  const results = [];

  for (const skill of managed) {
    if (!isLocalDraftOrTune(skill)) continue;
    const publicSkill = findSkill(publicInventory, skill.skill_id);
    if (!publicSkill) continue;
    const manifestSkill = update.manifestSkills.find((entry) => entry.skill_id === skill.skill_id) || null;
    if (update.manifestSkills.length > 0 && !manifestSkill) {
      results.push({
        skill_id: skill.skill_id,
        status: 'skipped',
        reason: 'signed manifest does not include a per-skill hash for this skill',
      });
      continue;
    }

    const currentPath = resolve(root, skill.relative_path);
    if (!existsSync(currentPath)) {
      results.push({ skill_id: skill.skill_id, status: 'skipped', reason: 'local skill path is missing' });
      continue;
    }

    const currentHash = sha256Directory(currentPath);
    if (skill.sha256 && currentHash !== skill.sha256) {
      results.push({
        skill_id: skill.skill_id,
        status: 'queued',
        reason: 'local skill changed after registry record; queued for maintainer merge instead of overwrite',
      });
      continue;
    }

    const backupPath = join(root, '.agentic-ai', 'local-drafts', new Date().toISOString().replaceAll(':', '-'), skill.skill_id);
    mkdirSync(backupPath, { recursive: true });
    cpSync(currentPath, backupPath, { recursive: true, force: true });
    const installed = installManagedSkillImpl({
      projectRoot: root,
      skillId: skill.skill_id,
      installedPath: skill.relative_path,
      execute: true,
      replace: true,
    });
    const installedPath = installed.installed_path || installed.registered?.relative_path || skill.relative_path;
    if (manifestSkill?.sha256) {
      const installedHash = sha256Directory(resolve(root, installedPath));
      if (installedHash !== manifestSkill.sha256) {
        rmSync(resolve(root, installedPath), { recursive: true, force: true });
        cpSync(backupPath, resolve(root, installedPath), { recursive: true, force: true });
        results.push({
          skill_id: skill.skill_id,
          status: 'rejected',
          reason: 'installed skill hash does not match signed manifest',
          expected_sha256: manifestSkill.sha256,
          current_sha256: installedHash,
          backup_path: backupPath,
        });
        continue;
      }
    }
    results.push({
      skill_id: skill.skill_id,
      status: 'replaced-with-signed-upstream',
      backup_path: backupPath,
      installed_path: installedPath,
      signed_sha256: manifestSkill?.sha256 || null,
    });
  }

  return {
    status: results.length > 0 ? 'reconciled' : 'no-op',
    manifest: {
      skill_id: update.skill_id,
      version: update.version,
      git_ref: update.git_ref,
      sha256: update.manifestHash,
    },
    results,
  };
}

function isLocalDraftOrTune(skill) {
  return skill.source === 'created-local' || skill.status === 'locally_tuned';
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--project-root') parsed.projectRoot = argv[++i];
    else if (arg === '--manifest') parsed.manifest = argv[++i];
    else if (arg === '--signature') parsed.signature = argv[++i];
    else if (arg === '--public-key') parsed.publicKey = argv[++i];
    else if (arg === '--help') {
      console.log('Usage: reconcile-signed-skills.mjs [--project-root repo] [--manifest path] [--signature path] [--public-key path]');
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return parsed;
}
