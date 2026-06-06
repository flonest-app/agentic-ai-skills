#!/usr/bin/env node
import { mkdirSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { sha256Directory } from './check-updates.mjs';

const DEFAULT_DB_RELATIVE_PATH = '.agentic-ai/registry.sqlite';

export function openManagedRegistry({
  projectRoot = process.cwd(),
  dbPath = join(projectRoot, DEFAULT_DB_RELATIVE_PATH),
} = {}) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS project_policy (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS managed_skills (
      skill_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      relative_path TEXT NOT NULL,
      source TEXT NOT NULL,
      management_mode TEXT NOT NULL DEFAULT 'flonest-owned',
      upstream_repo TEXT,
      upstream_skill_id TEXT,
      install_spec TEXT,
      version TEXT,
      sha256 TEXT,
      status TEXT NOT NULL DEFAULT 'managed',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS registry_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      skill_id TEXT,
      details_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  ensureColumn(db, 'managed_skills', 'management_mode', "TEXT NOT NULL DEFAULT 'flonest-owned'");
  ensureColumn(db, 'managed_skills', 'upstream_repo', 'TEXT');
  ensureColumn(db, 'managed_skills', 'upstream_skill_id', 'TEXT');

  return { db, projectRoot: resolve(projectRoot), dbPath };
}

export function initRegistry(options = {}) {
  const registry = openManagedRegistry(options);
  const now = new Date().toISOString();
  const notice = 'AGENTS.md is agentic-ai-managed when this project opts into the meta skill. User-owned skills remain untouched unless registered here.';

  registry.db.prepare(`
    INSERT INTO project_policy (key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run('agents_md_ownership_notice', notice, now);

  recordEvent(registry, 'registry_initialized', null, { notice });
  return {
    dbPath: registry.dbPath,
    warning: notice,
  };
}

export function registerManagedSkill({
  projectRoot = process.cwd(),
  skillId,
  name = skillId,
  skillPath,
  source = 'unknown',
  managementMode = 'flonest-owned',
  upstreamRepo = null,
  upstreamSkillId = null,
  installSpec = null,
  version = null,
  status = 'managed',
} = {}) {
  if (!skillId) throw new Error('--skill-id is required');
  if (!skillPath) throw new Error('--path is required');

  const registry = openManagedRegistry({ projectRoot });
  const absoluteSkillPath = resolve(projectRoot, skillPath);
  const relativePath = relative(resolve(projectRoot), absoluteSkillPath).replaceAll('\\', '/');
  const now = new Date().toISOString();
  const hash = sha256Directory(absoluteSkillPath);

  registry.db.prepare(`
    INSERT INTO managed_skills (skill_id, name, relative_path, source, management_mode, upstream_repo, upstream_skill_id, install_spec, version, sha256, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(skill_id) DO UPDATE SET
      name = excluded.name,
      relative_path = excluded.relative_path,
      source = excluded.source,
      management_mode = excluded.management_mode,
      upstream_repo = excluded.upstream_repo,
      upstream_skill_id = excluded.upstream_skill_id,
      install_spec = excluded.install_spec,
      version = excluded.version,
      sha256 = excluded.sha256,
      status = excluded.status,
      updated_at = excluded.updated_at
  `).run(skillId, name, relativePath, source, managementMode, upstreamRepo, upstreamSkillId, installSpec, version, hash, status, now, now);

  recordEvent(registry, 'skill_registered', skillId, { relativePath, source, managementMode, upstreamRepo, upstreamSkillId, installSpec, version, hash, status });
  return { skill_id: skillId, name, relative_path: relativePath, source, management_mode: managementMode, upstream_repo: upstreamRepo, upstream_skill_id: upstreamSkillId, install_spec: installSpec, version, sha256: hash, status };
}

export function recordTunedSkill({
  projectRoot = process.cwd(),
  skillId,
  upstreamAction = 'pr_or_issue_required',
  note = '',
} = {}) {
  if (!skillId) throw new Error('--skill-id is required');
  const registry = openManagedRegistry({ projectRoot });
  const existing = registry.db.prepare('SELECT * FROM managed_skills WHERE skill_id = ?').get(skillId);
  if (!existing) throw new Error(`skill is not managed by agentic-ai: ${skillId}`);

  const skillPath = resolve(projectRoot, existing.relative_path);
  const hash = sha256Directory(skillPath);
  const now = new Date().toISOString();

  registry.db.prepare(`
    UPDATE managed_skills
    SET sha256 = ?, status = ?, updated_at = ?
    WHERE skill_id = ?
  `).run(hash, 'locally_tuned', now, skillId);

  recordEvent(registry, 'skill_tuned', skillId, { upstreamAction, note, hash });
  return { skill_id: skillId, status: 'locally_tuned', sha256: hash, upstream_action: upstreamAction };
}

export function markManagedSkillRemoved({
  projectRoot = process.cwd(),
  skillId,
} = {}) {
  if (!skillId) throw new Error('--skill-id is required');
  const registry = openManagedRegistry({ projectRoot });
  const existing = registry.db.prepare('SELECT * FROM managed_skills WHERE skill_id = ?').get(skillId);
  if (!existing) throw new Error(`skill is not managed by agentic-ai: ${skillId}`);

  const now = new Date().toISOString();
  registry.db.prepare(`
    UPDATE managed_skills
    SET status = ?, updated_at = ?
    WHERE skill_id = ?
  `).run('removed', now, skillId);

  recordEvent(registry, 'skill_removed', skillId, { relativePath: existing.relative_path });
  return { skill_id: skillId, relative_path: existing.relative_path, status: 'removed' };
}

export function listManagedSkills(options = {}) {
  const registry = openManagedRegistry(options);
  return registry.db.prepare('SELECT * FROM managed_skills ORDER BY skill_id').all();
}

export function verifyManagedSkills(options = {}) {
  const registry = openManagedRegistry(options);
  const rows = registry.db.prepare('SELECT * FROM managed_skills ORDER BY skill_id').all();

  const skills = rows.map((row) => {
    const absolutePath = resolve(registry.projectRoot, row.relative_path);
    let currentHash = null;
    let ok = false;
    let error = null;
    try {
      currentHash = sha256Directory(absolutePath);
      ok = currentHash === row.sha256;
    } catch (err) {
      error = err.message;
    }
    return {
      skill_id: row.skill_id,
      relative_path: row.relative_path,
      status: row.status,
      expected_sha256: row.sha256,
      current_sha256: currentHash,
      ok,
      error,
    };
  });

  return {
    ok: skills.every((skill) => skill.ok),
    skills,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);

  try {
    let result;
    if (command === 'init') {
      result = initRegistry({ projectRoot: resolve(args.projectRoot || process.cwd()) });
    } else if (command === 'register') {
      result = registerManagedSkill({
        projectRoot: resolve(args.projectRoot || process.cwd()),
        skillId: args.skillId,
        name: args.name || args.skillId,
        skillPath: args.path,
        source: args.source,
        managementMode: args.managementMode,
        upstreamRepo: args.upstreamRepo,
        upstreamSkillId: args.upstreamSkillId,
        installSpec: args.installSpec,
        version: args.version,
      });
    } else if (command === 'record-tuned') {
      result = recordTunedSkill({
        projectRoot: resolve(args.projectRoot || process.cwd()),
        skillId: args.skillId,
        upstreamAction: args.upstreamAction,
        note: args.note,
      });
    } else if (command === 'mark-removed') {
      result = markManagedSkillRemoved({
        projectRoot: resolve(args.projectRoot || process.cwd()),
        skillId: args.skillId,
      });
    } else if (command === 'list') {
      result = { skills: listManagedSkills({ projectRoot: resolve(args.projectRoot || process.cwd()) }) };
    } else if (command === 'verify') {
      result = verifyManagedSkills({ projectRoot: resolve(args.projectRoot || process.cwd()) });
    } else {
      printHelp();
      process.exit(command ? 1 : 0);
    }

    console.log(JSON.stringify(result, null, 2));
    process.exit(result.ok === false ? 2 : 0);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

function recordEvent(registry, eventType, skillId, details) {
  registry.db.prepare(`
    INSERT INTO registry_events (event_type, skill_id, details_json, created_at)
    VALUES (?, ?, ?, ?)
  `).run(eventType, skillId, JSON.stringify(details), new Date().toISOString());
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--project-root') parsed.projectRoot = argv[++i];
    else if (arg === '--skill-id') parsed.skillId = argv[++i];
    else if (arg === '--name') parsed.name = argv[++i];
    else if (arg === '--path') parsed.path = argv[++i];
    else if (arg === '--source') parsed.source = argv[++i];
    else if (arg === '--management-mode') parsed.managementMode = argv[++i];
    else if (arg === '--upstream-repo') parsed.upstreamRepo = argv[++i];
    else if (arg === '--upstream-skill-id') parsed.upstreamSkillId = argv[++i];
    else if (arg === '--install-spec') parsed.installSpec = argv[++i];
    else if (arg === '--version') parsed.version = argv[++i];
    else if (arg === '--upstream-action') parsed.upstreamAction = argv[++i];
    else if (arg === '--note') parsed.note = argv[++i];
    else if (arg === '--help') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return parsed;
}

function printHelp() {
  console.log(`Usage:
  managed-registry.mjs init --project-root <repo>
  managed-registry.mjs register --project-root <repo> --skill-id <id> --name <name> --path .agents/skills/<id> --source <installed|created-local|tuned-local> [--management-mode flonest-owned|external-feedback]
  managed-registry.mjs record-tuned --project-root <repo> --skill-id <id>
  managed-registry.mjs mark-removed --project-root <repo> --skill-id <id>
  managed-registry.mjs list --project-root <repo>
  managed-registry.mjs verify --project-root <repo>
`);
}

function ensureColumn(db, tableName, columnName, definition) {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all();
  if (columns.some((column) => column.name === columnName)) return;
  db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
}
