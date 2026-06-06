#!/usr/bin/env node
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  listManagedSkills,
  markManagedSkillRemoved,
  recordTunedSkill,
  registerManagedSkill,
} from './managed-registry.mjs';
import { installManagedSkill } from './install-managed-skill.mjs';
import { markLabserverRequestAnswered } from './labserver-sync.mjs';
import { sanitizeFeedback } from './submit-feedback.mjs';

const DENIED_PATH_PARTS = new Set(['.git', 'node_modules']);
const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_-]{20,}/,
  /gh[pousr]_[A-Za-z0-9_]{20,}/,
  /-----BEGIN (?:RSA |EC |OPENSSH |)PRIVATE KEY-----/,
  /\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/,
];
const RAW_TRANSCRIPT_PATTERNS = [
  /^\{"timestamp":".*","type":"response_item".*$/m,
  /"encrypted_content"\s*:\s*"[^"]+"/,
];

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2));
  const output = args.file ? readFileSync(args.file, 'utf8') : readFileSync(0, 'utf8');
  const result = await processMaintainerOutput({
    projectRoot: resolve(args.projectRoot || process.cwd()),
    output,
    localMode: args.localMode,
    labserverUrl: args.labserverUrl,
  });
  console.log(JSON.stringify(result, null, 2));
}

export async function processMaintainerOutput({
  projectRoot = process.cwd(),
  paths,
  output,
  localMode = process.env.AGENTIC_AI_LOCAL_MODE || 'apply-safe',
  labserverUrl = process.env.AGENTIC_AI_LABSERVER_URL,
  fetchImpl = globalThis.fetch,
  installManagedSkillImpl = installManagedSkill,
} = {}) {
  const root = resolve(projectRoot);
  const runtimePaths = paths || {
    projectRoot: root,
    patchesDir: join(root, '.agentic-ai', 'patches'),
    outboxDir: join(root, '.agentic-ai', 'outbox'),
    projectId: null,
  };
  mkdirSync(runtimePaths.patchesDir, { recursive: true });
  mkdirSync(runtimePaths.outboxDir, { recursive: true });

  const parsed = parseMaintainerJson(output);
  const managedSkills = listManagedSkills({ projectRoot: root });
  const context = {
    projectRoot: root,
    managedSkills,
    managedById: new Map(managedSkills.map((skill) => [skill.skill_id, skill])),
    installManagedSkill: installManagedSkillImpl,
    localMode,
  };
  const proposalResults = [];
  const outboxResults = [];
  const proposals = Array.isArray(parsed.proposals) ? parsed.proposals : [];

  for (const proposal of proposals) {
    const localResult = applyProposal({ proposal, context });
    proposalResults.push(localResult);

    const outbox = writeOutboxPayload({
      proposal,
      localResult,
      parsed,
      paths: runtimePaths,
      projectRoot: root,
    });
    if (outbox) outboxResults.push(outbox);
  }

  const submission = await submitQueuedOutbox({
    projectRoot: root,
    outboxDir: runtimePaths.outboxDir,
    labserverUrl,
    fetchImpl,
  });

  return {
    parsed,
    proposal_results: proposalResults,
    outbox_results: outboxResults,
    submission,
  };
}

export function parseMaintainerJson(output) {
  const text = String(output || '').trim();
  const candidates = [
    text,
    ...Array.from(text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)).map((match) => match[1].trim()),
    ...extractBalancedJsonObjects(text),
  ];

  for (const candidate of Array.from(new Set(candidates))) {
    try {
      const parsed = JSON.parse(candidate);
      return {
        summary: typeof parsed.summary === 'string' ? parsed.summary : '',
        proposals: Array.isArray(parsed.proposals) ? parsed.proposals : [],
      };
    } catch {}
  }

  return {
    summary: 'Maintainer output was not valid JSON.',
    proposals: [
      {
        classification: 'unclear',
        target: 'none',
        action: 'none',
        rationale: 'The maintainer response could not be parsed as JSON.',
        proposed_patch: null,
        upstream_feedback: null,
      },
    ],
  };
}

function extractBalancedJsonObjects(text) {
  const candidates = [];
  for (let start = 0; start < text.length; start += 1) {
    if (text[start] !== '{') continue;

    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < text.length; index += 1) {
      const char = text[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
        continue;
      }

      if (char === '"') inString = true;
      else if (char === '{') depth += 1;
      else if (char === '}') {
        depth -= 1;
        if (depth === 0) {
          candidates.push(text.slice(start, index + 1).trim());
          break;
        }
      }
    }
  }
  return candidates;
}

export function applyProposal({ proposal, context }) {
  const normalized = normalizeProposal(proposal);
  const base = {
    target: normalized.target,
    action: normalized.action,
    classification: normalized.classification,
    status: 'rejected',
    reason: null,
    applied_paths: [],
  };

  if (['unsafe', 'unclear'].includes(normalized.classification)) {
    return { ...base, reason: `classification ${normalized.classification} is not auto-applicable` };
  }
  if (context.localMode === 'proposal-only') {
    return { ...base, status: 'queued', reason: 'AGENTIC_AI_LOCAL_MODE=proposal-only' };
  }
  if (context.localMode !== 'apply-safe') {
    return { ...base, reason: `unknown local mode: ${context.localMode}` };
  }

  try {
    if (normalized.target === 'AGENTS.md') {
      return applyAgentsProposal({ proposal: normalized, context, base });
    }
    if (normalized.target.startsWith('managed-skill:')) {
      return applyManagedSkillProposal({ proposal: normalized, context, base });
    }
    if (normalized.target === 'skillhub' || normalized.target === 'none') {
      return { ...base, status: 'queued', reason: 'public feedback only' };
    }
    return { ...base, reason: `target is not allowlisted: ${normalized.target}` };
  } catch (error) {
    return { ...base, reason: error.message };
  }
}

function applyAgentsProposal({ proposal, context, base }) {
  if (!['create', 'update'].includes(proposal.action)) {
    return { ...base, reason: `unsupported AGENTS.md action: ${proposal.action}` };
  }
  if (!proposal.proposed_patch) return { ...base, reason: 'AGENTS.md proposal is missing proposed_patch' };
  const result = applyUnifiedDiff({
    projectRoot: context.projectRoot,
    diff: proposal.proposed_patch,
    allowPath: (path) => path === 'AGENTS.md',
  });
  return { ...base, status: 'applied', applied_paths: result.paths };
}

function applyManagedSkillProposal({ proposal, context, base }) {
  const skillId = proposal.target.slice('managed-skill:'.length);
  if (!skillId) return { ...base, reason: 'managed skill target is missing id' };
  assertSafeSkillId(skillId);
  const existing = context.managedById.get(skillId);

  if (proposal.action === 'install') {
    if (existing && existing.status !== 'removed') {
      return { ...base, reason: `managed skill already exists: ${skillId}` };
    }
    const installedPath = proposal.installed_path || `.agents/skills/${skillId}`;
    assertSafeProjectPath(installedPath);
    if (installedPath !== `.agents/skills/${skillId}`) {
      return { ...base, reason: `managed skill install path must be .agents/skills/${skillId}` };
    }
    const result = context.installManagedSkill({
      projectRoot: context.projectRoot,
      skillId,
      name: proposal.name || skillId,
      installedPath,
      installSpec: proposal.install_spec,
      upstreamRepo: proposal.upstream_repo,
      upstreamSkillId: proposal.upstream_skill_id,
      managementMode: proposal.management_mode,
      installAgent: proposal.install_agent,
      execute: true,
    });
    if (result.mode === 'runtime-only') {
      return { ...base, reason: 'runtime-only skills are not installed into project managed skills' };
    }
    if (result.registered) context.managedById.set(skillId, result.registered);
    return {
      ...base,
      status: 'applied',
      applied_paths: [result.registered?.relative_path || result.installed_path || installedPath],
    };
  }

  if (proposal.action === 'create') {
    if (existing && existing.status !== 'removed') {
      return { ...base, reason: `managed skill already exists: ${skillId}` };
    }
    if (!proposal.proposed_patch) return { ...base, reason: 'managed skill create is missing proposed_patch' };
    const defaultPath = `.agents/skills/${skillId}`;
    const result = applyUnifiedDiff({
      projectRoot: context.projectRoot,
      diff: proposal.proposed_patch,
      allowPath: (path) => path === defaultPath || path.startsWith(`${defaultPath}/`),
    });
    const skillDir = resolve(context.projectRoot, defaultPath);
    if (!existsSync(join(skillDir, 'SKILL.md'))) {
      return { ...base, reason: `created skill is missing SKILL.md: ${defaultPath}` };
    }
    const registered = registerManagedSkill({
      projectRoot: context.projectRoot,
      skillId,
      name: proposal.name || skillId,
      skillPath: defaultPath,
      source: 'created-local',
      managementMode: 'flonest-owned',
    });
    context.managedById.set(skillId, registered);
    return { ...base, status: 'applied', applied_paths: result.paths };
  }

  if (!existing || existing.status === 'removed') {
    return { ...base, reason: `skill is not managed by agentic-ai: ${skillId}` };
  }

  if (proposal.action === 'update') {
    if (!proposal.proposed_patch) return { ...base, reason: 'managed skill update is missing proposed_patch' };
    const allowedPrefix = existing.relative_path;
    const result = applyUnifiedDiff({
      projectRoot: context.projectRoot,
      diff: proposal.proposed_patch,
      allowPath: (path) => path === allowedPrefix || path.startsWith(`${allowedPrefix}/`),
    });
    const tuned = recordTunedSkill({ projectRoot: context.projectRoot, skillId });
    context.managedById.set(skillId, { ...existing, status: tuned.status, sha256: tuned.sha256 });
    return { ...base, status: 'applied', applied_paths: result.paths };
  }

  if (proposal.action === 'remove') {
    rmSync(resolve(context.projectRoot, existing.relative_path), { recursive: true, force: true });
    const removed = markManagedSkillRemoved({ projectRoot: context.projectRoot, skillId });
    context.managedById.set(skillId, { ...existing, status: removed.status });
    return { ...base, status: 'applied', applied_paths: [existing.relative_path] };
  }

  return { ...base, reason: `unsupported managed skill action: ${proposal.action}` };
}

export function applyUnifiedDiff({ projectRoot = process.cwd(), diff, allowPath }) {
  if (!diff || containsUnsafeText(diff)) throw new Error('diff is missing or unsafe');
  const files = parseUnifiedDiff(diff);
  if (files.length === 0) throw new Error('diff does not contain any file changes');
  const applied = [];

  for (const file of files) {
    const path = normalizeProjectPath(file.path);
    if (!allowPath(path)) throw new Error(`path is not allowlisted: ${path}`);
    assertSafeProjectPath(path);

    const abs = resolve(projectRoot, path);
    const current = existsSync(abs) ? readFileSync(abs, 'utf8') : '';
    const next = applyHunks(current, file.hunks, path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, next);
    applied.push(path);
  }

  return { paths: applied };
}

function parseUnifiedDiff(diff) {
  const lines = String(diff).replaceAll('\r\n', '\n').split('\n');
  const files = [];
  let current = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.startsWith('diff --git ')) {
      current = { path: null, hunks: [] };
      files.push(current);
      continue;
    }
    if (line.startsWith('+++ ')) {
      if (!current) {
        current = { path: null, hunks: [] };
        files.push(current);
      }
      current.path = stripDiffPath(line.slice(4).trim());
      continue;
    }
    if (line.startsWith('@@ ')) {
      if (!current) throw new Error('hunk appears before file header');
      const match = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (!match) throw new Error(`invalid hunk header: ${line}`);
      const hunk = { oldStart: Number(match[1]), newStart: Number(match[2]), lines: [] };
      current.hunks.push(hunk);
      i += 1;
      while (i < lines.length && !lines[i].startsWith('diff --git ') && !lines[i].startsWith('@@ ')) {
        if (/^[ +\\-]/.test(lines[i])) hunk.lines.push(lines[i]);
        i += 1;
      }
      i -= 1;
    }
  }
  return files.filter((file) => file.path && file.path !== '/dev/null');
}

function applyHunks(text, hunks, path) {
  const hadTrailingNewline = text.endsWith('\n');
  const original = text.length === 0 ? [] : text.replace(/\n$/, '').split('\n');
  const output = [];
  let cursor = 0;

  for (const hunk of hunks) {
    const oldIndex = Math.max(0, hunk.oldStart - 1);
    while (cursor < oldIndex) output.push(original[cursor++]);

    for (const line of hunk.lines) {
      if (line.startsWith('\\')) continue;
      const kind = line[0] || ' ';
      const value = line.length > 0 ? line.slice(1) : '';
      if (kind === ' ') {
        if (original[cursor] !== value) throw new Error(`diff context mismatch in ${path}`);
        output.push(original[cursor++]);
      } else if (kind === '-') {
        if (original[cursor] !== value) throw new Error(`diff removal mismatch in ${path}`);
        cursor += 1;
      } else if (kind === '+') {
        output.push(value);
      }
    }
  }
  while (cursor < original.length) output.push(original[cursor++]);
  const next = output.join('\n');
  return next.length === 0 ? '' : `${next}${hadTrailingNewline || hunks.some((hunk) => hunk.lines.some((line) => line.startsWith('+'))) ? '\n' : ''}`;
}

function writeOutboxPayload({ proposal, localResult, parsed, paths, projectRoot }) {
  const normalized = normalizeProposal(proposal);
  if (!normalized.response_to && !normalized.upstream_feedback && normalized.target !== 'skillhub' && !normalized.proposed_public_patch) return null;

  const sourceText = normalized.upstream_feedback || normalized.proposed_public_patch || normalized.rationale || parsed.summary;
  const sanitized = sanitizeFeedback(sourceText, {
    cwd: projectRoot,
    skillId: normalized.skill_id,
    upstreamRepo: normalized.upstream_repo,
    feedbackKind: 'local-maintainer-output',
  });
  const payload = {
    schema_version: 1,
    project_id: paths.projectId || null,
    created_at: new Date().toISOString(),
    classification: normalized.classification,
    target: normalized.target,
    action: normalized.action,
    skill_id: normalized.skill_id,
    upstream_repo: normalized.upstream_repo,
    summary: parsed.summary || '',
    rationale: normalized.rationale,
    sanitized_feedback: sanitized.sanitized_text,
    redactions: sanitized.redactions,
    proposed_public_patch: normalized.proposed_public_patch || null,
    response_to: normalized.response_to || null,
    local_result: {
      status: localResult.status,
      reason: localResult.reason,
    },
    delivery: {
      status: 'queued',
      attempts: 0,
    },
  };
  const outboxPath = join(paths.outboxDir, `${Date.now()}-${safeName(normalized.target)}.json`);
  writeJson(outboxPath, payload);
  if (normalized.response_to) {
    markLabserverRequestAnswered({
      inboxDir: paths.inboxDir || join(projectRoot, '.agentic-ai', 'inbox'),
      requestId: normalized.response_to,
    });
  }
  return { path: outboxPath, status: 'queued' };
}

export async function submitQueuedOutbox({
  projectRoot = process.cwd(),
  outboxDir = join(projectRoot, '.agentic-ai', 'outbox'),
  labserverUrl = process.env.AGENTIC_AI_LABSERVER_URL,
  fetchImpl = globalThis.fetch,
} = {}) {
  mkdirSync(outboxDir, { recursive: true });
  const files = readdirSync(outboxDir).filter((file) => file.endsWith('.json')).sort();
  const endpoint = labserverUrl ? `${labserverUrl.replace(/\/$/, '')}/feedback/agentic-ai` : null;
  const results = [];

  for (const file of files) {
    const path = join(outboxDir, file);
    const payload = JSON.parse(readFileSync(path, 'utf8'));
    if (payload.delivery?.status === 'delivered') continue;

    if (!endpoint) {
      payload.delivery = {
        ...(payload.delivery || {}),
        status: 'queued',
        attempts: payload.delivery?.attempts || 0,
        last_error: 'AGENTIC_AI_LABSERVER_URL is not configured',
      };
      writeJson(path, payload);
      results.push({ path, status: 'queued', reason: payload.delivery.last_error });
      continue;
    }

    try {
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
      payload.delivery = {
        status: 'delivered',
        attempts: (payload.delivery?.attempts || 0) + 1,
        delivered_at: new Date().toISOString(),
        response: await response.json().catch(() => null),
      };
      writeJson(path, payload);
      results.push({ path, status: 'delivered' });
    } catch (error) {
      payload.delivery = {
        ...(payload.delivery || {}),
        status: 'queued',
        attempts: (payload.delivery?.attempts || 0) + 1,
        last_error: error.message,
        last_attempt_at: new Date().toISOString(),
      };
      writeJson(path, payload);
      results.push({ path, status: 'queued', reason: error.message });
    }
  }

  return { endpoint, results };
}

function normalizeProposal(proposal = {}) {
  const target = String(proposal.target || 'none');
  const skillId = target.startsWith('managed-skill:') ? target.slice('managed-skill:'.length) : (proposal.skill_id || null);
  return {
    ...proposal,
    classification: String(proposal.classification || 'unclear').toLowerCase(),
    target,
    action: String(proposal.action || 'none').toLowerCase(),
    rationale: String(proposal.rationale || ''),
    proposed_patch: proposal.proposed_patch || null,
    proposed_public_patch: proposal.proposed_public_patch || proposal.public_patch || (target === 'skillhub' ? proposal.proposed_patch : null),
    upstream_feedback: proposal.upstream_feedback || null,
    upstream_repo: proposal.upstream_repo || null,
    response_to: proposal.response_to || proposal.revision_request_id || null,
    skill_id: skillId,
  };
}

function normalizeProjectPath(path) {
  const normalized = stripDiffPath(path).replaceAll('\\', '/');
  return normalized.replace(/^\.\/+/, '');
}

function stripDiffPath(path) {
  if (path === '/dev/null') return path;
  return path.replace(/^[ab]\//, '');
}

function assertSafeProjectPath(path) {
  if (!path || path.startsWith('/') || path.includes('..')) throw new Error(`unsafe path: ${path}`);
  const parts = path.split('/');
  if (parts.some((part) => DENIED_PATH_PARTS.has(part))) throw new Error(`denied path: ${path}`);
  if (/(^|\/)\.env($|[.\-/])|secret/i.test(path)) throw new Error(`secret-like path is denied: ${path}`);
}

function assertSafeSkillId(skillId) {
  if (!/^[a-z0-9][a-z0-9._-]{0,79}$/i.test(skillId) || skillId.includes('..')) {
    throw new Error(`unsafe managed skill id: ${skillId}`);
  }
}

function containsUnsafeText(text) {
  return [...SECRET_PATTERNS, ...RAW_TRANSCRIPT_PATTERNS].some((pattern) => pattern.test(text));
}

function safeName(value) {
  return String(value || 'proposal').replace(/[^a-z0-9_.-]+/gi, '-').slice(0, 80);
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--project-root') parsed.projectRoot = argv[++i];
    else if (arg === '--file') parsed.file = argv[++i];
    else if (arg === '--local-mode') parsed.localMode = argv[++i];
    else if (arg === '--labserver-url') parsed.labserverUrl = argv[++i];
    else if (arg === '--help') {
      console.log('Usage: proposal-controller.mjs [--project-root repo] [--file maintainer-output.json]');
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return parsed;
}
