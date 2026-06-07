#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const VALID_CLASSIFICATIONS = new Set([
  'generic',
  'project-specific',
  'managed-skill-drift',
  'managed-skill-unused',
  'unsafe',
  'unclear',
]);
const VALID_ACTIONS = new Set(['install', 'create', 'update', 'remove', 'record', 'none']);
const SECRET_OR_TRANSCRIPT_PATTERNS = [
  /sk-[A-Za-z0-9_-]{20,}/,
  /gh[pousr]_[A-Za-z0-9_]{20,}/,
  /-----BEGIN (?:RSA |EC |OPENSSH |)PRIVATE KEY-----/,
  /\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/,
  /^\{"timestamp":".*","type":"response_item".*$/m,
  /"encrypted_content"\s*:\s*"[^"]+"/,
  /"tool_call_id"\s*:/,
  /"type"\s*:\s*"reasoning"/,
];
const PRIVATE_PATH_PATTERNS = [
  /\/home\/[^/\s"'`]+\/[^\s"'`]+/,
  /\/Users\/[^/\s"'`]+\/[^\s"'`]+/,
  /[A-Za-z]:\\Users\\[^\\\s"'`]+\\[^\s"'`]+/,
];

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  try {
    if (command === 'begin') {
      const result = beginMaintainerProposal(args);
      console.log(JSON.stringify({ ok: true, path: result.path, proposal_count: 0 }, null, 2));
    } else if (command === 'add') {
      const result = addMaintainerProposal({ ...args, proposal: args });
      console.log(JSON.stringify({ ok: true, path: result.path, proposal_count: result.document.proposals.length }, null, 2));
    } else if (command === 'validate') {
      const result = validateMaintainerProposalFile(args);
      console.log(JSON.stringify({ ok: true, path: result.path, proposal_count: result.document.proposals.length }, null, 2));
    } else if (command === 'show') {
      const result = loadMaintainerProposalFile(args);
      console.log(JSON.stringify(result.document, null, 2));
    } else {
      printUsage();
      process.exit(command ? 1 : 0);
    }
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

export function resolveProposalFile({
  projectRoot = process.cwd(),
  file = process.env.AGENTIC_AI_PROPOSAL_FILE,
} = {}) {
  return resolve(file || join(projectRoot, '.agentic-ai', 'proposals', 'active.json'));
}

export function beginMaintainerProposal({
  projectRoot = process.cwd(),
  file,
  summary = 'No maintainer proposals recorded.',
} = {}) {
  const path = resolveProposalFile({ projectRoot, file });
  const now = new Date().toISOString();
  const document = {
    schema_version: 1,
    kind: 'agentic-ai-maintainer-proposals',
    summary: String(summary || 'No maintainer proposals recorded.'),
    proposals: [],
    created_at: now,
    updated_at: now,
  };
  writeJson(path, document);
  return { path, document };
}

export function addMaintainerProposal({
  projectRoot = process.cwd(),
  file,
  proposal,
} = {}) {
  const loaded = existsSync(resolveProposalFile({ projectRoot, file }))
    ? loadMaintainerProposalFile({ projectRoot, file })
    : beginMaintainerProposal({ projectRoot, file });
  const next = {
    ...loaded.document,
    summary: proposal?.summary ? String(proposal.summary) : loaded.document.summary,
    proposals: [
      ...loaded.document.proposals,
      normalizeAndValidateProposal(proposal, { projectRoot }),
    ],
    updated_at: new Date().toISOString(),
  };
  const validated = validateMaintainerProposalDocument(next, { projectRoot });
  writeJson(loaded.path, validated.document);
  return { path: loaded.path, document: validated.document };
}

export function validateMaintainerProposalFile({
  projectRoot = process.cwd(),
  file,
} = {}) {
  return loadMaintainerProposalFile({ projectRoot, file });
}

export function loadMaintainerProposalFile({
  projectRoot = process.cwd(),
  file,
} = {}) {
  const path = resolveProposalFile({ projectRoot, file });
  if (!existsSync(path)) throw new Error(`maintainer proposal file was not found: ${path}`);
  let document;
  try {
    document = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`maintainer proposal file is not valid JSON: ${error.message}`);
  }
  return validateMaintainerProposalDocument(document, { projectRoot, path });
}

export function validateMaintainerProposalDocument(document, {
  projectRoot = process.cwd(),
  path = null,
} = {}) {
  if (!document || typeof document !== 'object') throw new Error('maintainer proposal document must be an object');
  if (document.kind !== 'agentic-ai-maintainer-proposals') throw new Error('maintainer proposal document has wrong kind');
  if (!Array.isArray(document.proposals)) throw new Error('maintainer proposal document must contain proposals[]');
  assertSafeText(document.summary || '', 'summary');
  const proposals = document.proposals.map((proposal) => normalizeAndValidateProposal(proposal, { projectRoot }));
  return {
    path,
    document: {
      schema_version: 1,
      kind: 'agentic-ai-maintainer-proposals',
      summary: String(document.summary || 'No maintainer proposals recorded.'),
      proposals,
      created_at: document.created_at || new Date().toISOString(),
      updated_at: document.updated_at || new Date().toISOString(),
    },
  };
}

export function normalizeAndValidateProposal(input = {}, { projectRoot = process.cwd() } = {}) {
  const classification = String(input.classification || 'unclear').toLowerCase();
  if (!VALID_CLASSIFICATIONS.has(classification)) throw new Error(`invalid classification: ${classification}`);

  const target = String(input.target || 'none');
  if (!isValidTarget(target)) throw new Error(`invalid target: ${target}`);
  if (target.startsWith('managed-skill:')) assertSafeSkillId(target.slice('managed-skill:'.length));

  const action = String(input.action || 'none').toLowerCase();
  if (!VALID_ACTIONS.has(action)) throw new Error(`invalid action: ${action}`);

  const proposedPatch = normalizeNullableString(input.proposed_patch);
  const proposedSkillPatch = normalizeNullableString(input.proposed_skill_patch || (target === 'skillhub' ? proposedPatch : null));
  const upstreamFeedback = normalizeNullableString(input.upstream_feedback);
  const rationale = String(input.rationale || '');

  if (!rationale.trim()) throw new Error('proposal rationale is required');
  for (const [field, value] of Object.entries({
    rationale,
    proposed_patch: proposedPatch,
    upstream_feedback: upstreamFeedback,
    proposed_skill_patch: proposedSkillPatch,
    candidate_skill_name: input.candidate_skill_name,
    upstream_repo: input.upstream_repo,
    response_to: input.response_to,
  })) {
    assertSafeText(value, field);
  }

  if (target === 'AGENTS.md' && ['create', 'update'].includes(action) && !proposedPatch) {
    throw new Error('AGENTS.md create/update proposals require proposed_patch');
  }
  if (target.startsWith('managed-skill:') && ['create', 'update'].includes(action) && !proposedPatch) {
    throw new Error('managed skill create/update proposals require proposed_patch');
  }
  if (target === 'skillhub' && ['create', 'update'].includes(action) && !proposedSkillPatch) {
    throw new Error('skillhub create/update proposals require proposed_skill_patch');
  }

  if (proposedPatch) validateUnifiedDiff(proposedPatch, { field: 'proposed_patch', projectRoot });
  if (proposedSkillPatch) validateUnifiedDiff(proposedSkillPatch, { field: 'proposed_skill_patch', projectRoot });

  return {
    classification,
    target,
    action,
    rationale,
    proposed_patch: proposedPatch,
    response_to: normalizeNullableString(input.response_to),
    upstream_feedback: upstreamFeedback,
    proposed_skill_patch: proposedSkillPatch,
    candidate_skill_name: normalizeNullableString(input.candidate_skill_name || input.name),
    skill_id: normalizeNullableString(input.skill_id),
    upstream_repo: normalizeNullableString(input.upstream_repo),
    upstream_skill_id: normalizeNullableString(input.upstream_skill_id),
    install_spec: normalizeNullableString(input.install_spec),
    installed_path: normalizeNullableString(input.installed_path),
    install_agent: normalizeNullableString(input.install_agent),
    management_mode: normalizeNullableString(input.management_mode),
    name: normalizeNullableString(input.name),
    proposal_id: normalizeNullableString(input.proposal_id),
  };
}

function validateUnifiedDiff(diff, { field }) {
  if (!diff || typeof diff !== 'string') throw new Error(`${field} must be a unified diff string`);
  const files = parseUnifiedDiff(diff);
  if (files.length === 0) throw new Error(`${field} does not contain any file changes`);
  for (const file of files) assertSafePatchPath(file.path, field);
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
      current.path = normalizePatchPath(line.slice(4).trim());
      continue;
    }
    if (line.startsWith('@@ ')) {
      if (!current) throw new Error(`hunk appears before file header: ${line}`);
      if (!/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/.test(line)) {
        throw new Error(`invalid hunk header: ${line}`);
      }
      const hunk = { lines: [] };
      current.hunks.push(hunk);
      i += 1;
      while (i < lines.length && !lines[i].startsWith('diff --git ') && !lines[i].startsWith('@@ ')) {
        if (/^[ +\\-]/.test(lines[i])) hunk.lines.push(lines[i]);
        else if (lines[i] !== '') throw new Error(`invalid diff line: ${lines[i]}`);
        i += 1;
      }
      i -= 1;
    }
  }
  return files.filter((file) => file.path && file.path !== '/dev/null');
}

function assertSafePatchPath(path, field) {
  const normalized = normalizePatchPath(path);
  if (!normalized || normalized.startsWith('/') || normalized.includes('..')) {
    throw new Error(`${field} has unsafe path: ${path}`);
  }
  if (normalized.startsWith('.git/') || normalized.includes('/.git/')) {
    throw new Error(`${field} has unsafe path: ${path}`);
  }
  if (/(^|\/)\.env($|[.\-/])|secret/i.test(normalized)) {
    throw new Error(`${field} has unsafe path: ${path}`);
  }
}

function assertSafeText(value, field) {
  if (value === null || value === undefined) return;
  const text = String(value);
  if (SECRET_OR_TRANSCRIPT_PATTERNS.some((pattern) => pattern.test(text))) {
    throw new Error(`${field} contains raw secret or transcript content`);
  }
  if (PRIVATE_PATH_PATTERNS.some((pattern) => pattern.test(text))) {
    throw new Error(`${field} contains a private local path`);
  }
}

function isValidTarget(target) {
  return target === 'AGENTS.md'
    || target === 'skillhub'
    || target === 'none'
    || /^managed-skill:[A-Za-z0-9._-]+$/.test(target);
}

function assertSafeSkillId(skillId) {
  if (!/^[A-Za-z0-9._-]+$/.test(skillId || '')) throw new Error(`unsafe managed skill id: ${skillId}`);
}

function normalizePatchPath(path) {
  return String(path || '').replace(/^[ab]\//, '').replaceAll('\\', '/');
}

function normalizeNullableString(value) {
  if (value === undefined || value === null || value === '') return null;
  return String(value);
}

function parseArgs(argv) {
  const parsed = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      parsed._.push(arg);
    } else if (arg === '--help') {
      parsed._ = [];
      return parsed;
    } else if (arg === '--project-root') parsed.projectRoot = resolve(argv[++i]);
    else if (arg === '--file') parsed.file = argv[++i];
    else if (arg === '--summary') parsed.summary = argv[++i];
    else if (arg === '--classification') parsed.classification = argv[++i];
    else if (arg === '--target') parsed.target = argv[++i];
    else if (arg === '--action') parsed.action = argv[++i];
    else if (arg === '--rationale') parsed.rationale = argv[++i];
    else if (arg === '--response-to') parsed.response_to = argv[++i];
    else if (arg === '--skill-id') parsed.skill_id = argv[++i];
    else if (arg === '--candidate-skill-name') parsed.candidate_skill_name = argv[++i];
    else if (arg === '--name') parsed.name = argv[++i];
    else if (arg === '--upstream-repo') parsed.upstream_repo = argv[++i];
    else if (arg === '--upstream-skill-id') parsed.upstream_skill_id = argv[++i];
    else if (arg === '--install-spec') parsed.install_spec = argv[++i];
    else if (arg === '--installed-path') parsed.installed_path = argv[++i];
    else if (arg === '--install-agent') parsed.install_agent = argv[++i];
    else if (arg === '--management-mode') parsed.management_mode = argv[++i];
    else if (arg === '--proposal-id') parsed.proposal_id = argv[++i];
    else if (arg === '--proposed-patch') parsed.proposed_patch = argv[++i];
    else if (arg === '--proposed-skill-patch') parsed.proposed_skill_patch = argv[++i];
    else if (arg === '--upstream-feedback') parsed.upstream_feedback = argv[++i];
    else if (arg === '--proposed-patch-file') parsed.proposed_patch = readInput(argv[++i]);
    else if (arg === '--proposed-skill-patch-file') parsed.proposed_skill_patch = readInput(argv[++i]);
    else if (arg === '--upstream-feedback-file') parsed.upstream_feedback = readInput(argv[++i]);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return parsed;
}

function readInput(path) {
  if (path === '-') return readFileSync(0, 'utf8');
  return readFileSync(path, 'utf8');
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function printUsage() {
  console.log([
    'Usage: write-maintainer-proposal.mjs <begin|add|validate|show> [options]',
    '',
    'Common options:',
    '  --project-root <repo>  --file <proposal.json>',
    '',
    'Add options:',
    '  --classification <kind> --target <target> --action <action> --rationale <text>',
    '  --proposed-patch-file <file|-> --proposed-skill-patch-file <file|-> --upstream-feedback-file <file|->',
  ].join('\n'));
}
