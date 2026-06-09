#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { discoverProjectConversations } from './discover-project-conversations.mjs';
import { listManagedSkills, verifyManagedSkills } from './managed-registry.mjs';
import { defaultEvidenceCursorPath, getEvidenceFileCursor } from './read-conversation-slice.mjs';
import { listPendingLabserverRequests } from './labserver-sync.mjs';

const IGNORE_DIRS = new Set(['.git', 'node_modules', '.agentic-ai', 'dist', 'build', 'coverage']);
const scriptDir = dirname(fileURLToPath(import.meta.url));
const GUIDANCE_FILES = [
  'AGENTS.md',
  'AGENTS.override.md',
  'GEMINI.md',
  'CLAUDE.md',
  'README.md',
  'GOAL.md',
  '.cursorrules',
  '.cursor/rules',
  'docs/learned.md',
  'docs/README.md',
];

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2));
  const result = collectMaintainerContext({
    projectRoot: args.projectRoot,
    sourceCodexHome: args.sourceCodexHome,
    cursorPath: args.cursorPath,
    changedFiles: args.changedFiles,
    limit: args.limit,
  });
  console.log(JSON.stringify(result, null, 2));
}

export function collectMaintainerContext({
  projectRoot = process.cwd(),
  sourceCodexHome = join(homedir(), '.codex'),
  cursorPath = defaultEvidenceCursorPath(projectRoot),
  changedFiles = null,
  limit = 20,
} = {}) {
  const root = resolve(projectRoot);
  const sourceHome = resolve(sourceCodexHome);
  const changedFilesSource = changedFiles ?? changedFilesFromEnv() ?? changedFilesFromTurnContext(root);
  const normalizedChangedFiles = normalizeChangedFiles(changedFilesSource, root);
  const managedSkills = safe(() => listManagedSkills({ projectRoot: root }), []);
  const managedVerification = safe(() => verifyManagedSkills({ projectRoot: root }), { ok: true, skills: [] });
  const conversationDiscovery = safe(() => discoverProjectConversations({
    projectRoot: root,
    sourceCodexHome: sourceHome,
    changedFiles: normalizedChangedFiles,
    limit,
  }), {
    projectRoot: root,
    projectName: basename(root),
    searchRoots: defaultSourceRoots(root, sourceHome),
    candidateCount: 0,
    candidates: [],
    error: 'conversation discovery failed',
  });

  return {
    schema_version: 1,
    collected_at: new Date().toISOString(),
    project_root: root,
    source_codex_home: sourceHome,
    source_codex_session_index_path: join(sourceHome, 'session_index.jsonl'),
    source_codex_sessions_dir: join(sourceHome, 'sessions'),
    evidence_cursor_path: resolve(cursorPath),
    changed_files: normalizedChangedFiles,
    root_agents_md: inspectFile(join(root, 'AGENTS.md'), root),
    agent_instruction_files: discoverAgentInstructionFiles(root),
    guidance_files: discoverGuidanceFiles(root),
    project_skills: discoverProjectSkills(root, managedSkills),
    managed_skills: managedSkills,
    managed_skill_verification: managedVerification,
    pending_labserver_revision_requests: safe(() => listPendingLabserverRequests({
      inboxDir: join(root, '.agentic-ai', 'inbox'),
    }), []),
    git: collectGitContext(root),
    conversation_discovery: {
      ...conversationDiscovery,
      candidates: (conversationDiscovery.candidates || []).map((candidate) => trimConversationCandidate({
        candidate,
        projectRoot: root,
        cursorPath,
      })),
    },
    next_steps: [
      'First inspect unread human/source Codex conversation candidates whose turn_context.cwd matches this project. Treat the helper output like an inbox of unread source work.',
      'Then read relevant agent_instruction_files and guidance_files. Product code comes only after chat/docs show a durable rule or skill need.',
      'On follow-up turns, treat AGENTS.md and registered managed skills as distilled memory; combine them only with newly unread source conversation lines.',
      'For human Codex JSONL, use each candidate read_command. On first read it may return the full unread conversation; later turns start at the stored cursor and avoid replaying old chat.',
      'Do not read isolated maintainer Codex sessions as project evidence.',
      'Use managed_skill_verification before proposing managed-skill updates or removals.',
      'Write proposals only with write-maintainer-proposal.mjs; the controller reads the proposal file and ignores final assistant prose.',
    ],
  };
}

function defaultSourceRoots(projectRoot, sourceCodexHome) {
  return [
    join(projectRoot, '.conversations'),
    join(sourceCodexHome, 'session_index.jsonl'),
    join(sourceCodexHome, 'sessions'),
  ];
}

function discoverAgentInstructionFiles(projectRoot) {
  return walkFiles(projectRoot, (filePath) => /^AGENTS(?:\.override)?\.md$/i.test(basename(filePath)))
    .map((filePath) => inspectFile(filePath, projectRoot))
    .filter(Boolean)
    .slice(0, 100);
}

function discoverGuidanceFiles(projectRoot) {
  const files = new Set();
  for (const rel of GUIDANCE_FILES) {
    const full = join(projectRoot, rel);
    if (!existsSync(full)) continue;
    const stat = statSync(full);
    if (stat.isDirectory()) {
      for (const nested of walkFiles(full, (filePath) => /\.(md|mdc|txt)$/i.test(filePath))) files.add(nested);
    } else if (stat.isFile()) {
      files.add(full);
    }
  }
  return Array.from(files)
    .map((filePath) => inspectFile(filePath, projectRoot))
    .filter(Boolean)
    .slice(0, 100);
}

function discoverProjectSkills(projectRoot, managedSkills = []) {
  const root = join(projectRoot, '.agents', 'skills');
  if (!existsSync(root)) return [];
  const managedByPath = new Map(managedSkills.map((skill) => [normalizeRel(skill.relative_path), skill]));
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const skillDir = join(root, entry.name);
      const skillPath = join(skillDir, 'SKILL.md');
      const relativePath = normalizeRel(relative(projectRoot, skillDir));
      const managed = managedByPath.get(relativePath);
      return {
        skill_id: entry.name,
        relative_path: relativePath,
        skill_file: normalizeRel(relative(projectRoot, skillPath)),
        exists: existsSync(skillPath),
        ownership: managed ? 'agentic-ai-managed' : 'user-owned-unmanaged',
        managed_registry: managed || null,
        frontmatter: existsSync(skillPath) ? readFrontmatter(skillPath) : {},
        ...inspectFile(skillPath, projectRoot, { optional: true }),
      };
    })
    .slice(0, 100);
}

function collectGitContext(projectRoot) {
  const status = runGit(projectRoot, ['status', '--short', '--untracked-files=all']);
  return {
    available: status.status === 0,
    status_short: status.status === 0 ? status.stdout.split('\n').filter(Boolean).slice(0, 100) : [],
    status_error: status.status === 0 ? null : status.stderr || status.stdout || 'git status failed',
    ignored_agents_md: gitCheckIgnore(projectRoot, 'AGENTS.md'),
  };
}

function gitCheckIgnore(projectRoot, relPath) {
  const result = runGit(projectRoot, ['check-ignore', '-v', '--', relPath]);
  if (result.status !== 0) return null;
  return result.stdout.trim() || null;
}

function runGit(projectRoot, args) {
  return spawnSync('git', args, {
    cwd: projectRoot,
    encoding: 'utf8',
    maxBuffer: 512 * 1024,
  });
}

function walkFiles(start, predicate, files = []) {
  let stat;
  try {
    stat = statSync(start);
  } catch {
    return files;
  }
  if (stat.isFile()) {
    if (predicate(start)) files.push(resolve(start));
    return files;
  }
  if (!stat.isDirectory()) return files;
  for (const entry of readdirSync(start, { withFileTypes: true })) {
    if (entry.isDirectory() && IGNORE_DIRS.has(entry.name)) continue;
    walkFiles(join(start, entry.name), predicate, files);
  }
  return files;
}

function inspectFile(filePath, projectRoot, { optional = false } = {}) {
  if (!existsSync(filePath)) {
    if (optional) return {};
    return { relative_path: normalizeRel(relative(projectRoot, filePath)), exists: false };
  }
  const stat = statSync(filePath);
  if (!stat.isFile()) return null;
  return {
    relative_path: normalizeRel(relative(projectRoot, filePath)),
    exists: true,
    bytes: stat.size,
    last_modified: new Date(stat.mtimeMs).toISOString(),
  };
}

function readFrontmatter(filePath) {
  let text = '';
  try {
    text = readFileSync(filePath, 'utf8');
  } catch {
    return {};
  }
  const match = text.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const data = {};
  for (const line of match[1].split('\n')) {
    const parsed = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (parsed) data[parsed[1]] = parsed[2].trim();
  }
  return data;
}

function trimConversationCandidate({ candidate, projectRoot, cursorPath }) {
  const cursor = getEvidenceFileCursor({ filePath: candidate.filePath, cursorPath });
  const previousLine = cursor.line > candidate.lineCount ? 0 : cursor.line;
  const unreadLineCount = Math.max(0, (candidate.lineCount || 0) - previousLine);
  const readPlan = conversationReadPlan({ candidate, unreadLineCount });
  const readCommand = [
    'node',
    quoteShell(join(scriptDir, 'read-conversation-slice.mjs')),
    '--project-root', quoteShell(projectRoot),
    '--cursor-path', quoteShell(cursorPath),
    '--file', quoteShell(candidate.filePath),
    '--max-lines', String(readPlan.maxLines),
    '--max-bytes', String(readPlan.maxBytes),
    '--mark-read',
  ].join(' ');
  return {
    filePath: candidate.filePath,
    score: candidate.score,
    scoreParts: candidate.scoreParts,
    lastModified: candidate.lastModified,
    bytes: candidate.bytes,
    lineCount: candidate.lineCount,
    matchedTerms: candidate.matchedTerms,
    matchedProjectTerms: candidate.matchedProjectTerms,
    matchedChangedFiles: candidate.matchedChangedFiles,
    firstTimestamp: candidate.firstTimestamp,
    cwd: candidate.cwd,
    cwdMatch: candidate.cwdMatch || null,
    cwdValues: candidate.cwdValues || [],
    detectedIds: candidate.detectedIds,
    cursor: {
      previous_line: previousLine,
      next_unread_line: unreadLineCount > 0 ? previousLine + 1 : null,
      unread_line_count: unreadLineCount,
      read_mode: readPlan.mode,
      max_lines: readPlan.maxLines,
      max_bytes: readPlan.maxBytes,
      read_command: readCommand,
    },
  };
}

function conversationReadPlan({ candidate, unreadLineCount }) {
  if ((candidate.cwdMatch === 'exact' || candidate.cwdMatch === 'subdir') && unreadLineCount > 0) {
    return {
      mode: 'full-unread-source-cwd-conversation',
      maxLines: unreadLineCount,
      maxBytes: Math.max(256 * 1024, Math.ceil((candidate.bytes || unreadLineCount * 4096) * 4)),
    };
  }
  return {
    mode: 'bounded-candidate-slice',
    maxLines: 120,
    maxBytes: 96 * 1024,
  };
}

function quoteShell(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function safe(fn, fallback) {
  try {
    return fn();
  } catch (error) {
    if (Array.isArray(fallback)) return fallback;
    return { ...fallback, error: error.message };
  }
}

function normalizeRel(path) {
  return path.replaceAll('\\', '/');
}

function changedFilesFromEnv(env = process.env) {
  const value = env.AGENTIC_AI_CHANGED_FILES;
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed;
  } catch {}
  return String(value).split(/[,\n]/).map((entry) => entry.trim()).filter(Boolean);
}

function changedFilesFromTurnContext(projectRoot, env = process.env) {
  const contextPath = env.AGENTIC_AI_TURN_CONTEXT_FILE || join(projectRoot, '.agentic-ai', 'turn-context.json');
  try {
    const context = JSON.parse(readFileSync(contextPath, 'utf8'));
    if (Array.isArray(context.changed_files)) return context.changed_files;
  } catch {}
  return [];
}

function normalizeChangedFiles(changedFiles = [], projectRoot) {
  return Array.from(new Set(
    changedFiles
      .map((file) => String(file || '').trim().replaceAll('\\', '/'))
      .filter(Boolean)
      .map((file) => file.startsWith('/') ? relative(projectRoot, file).replaceAll('\\', '/') : file)
      .filter((file) => file && !file.startsWith('..')),
  )).slice(0, 50);
}

function parseArgs(argv) {
  const parsed = { changedFiles: [], limit: 20 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--project-root') parsed.projectRoot = argv[++i];
    else if (arg === '--source-codex-home') parsed.sourceCodexHome = argv[++i];
    else if (arg === '--cursor-path') parsed.cursorPath = argv[++i];
    else if (arg === '--changed-file') parsed.changedFiles.push(argv[++i]);
    else if (arg === '--limit') parsed.limit = Number(argv[++i]);
    else if (arg === '--help') {
      console.log('Usage: collect-maintainer-context.mjs [--project-root repo] [--source-codex-home ~/.codex] [--cursor-path .agentic-ai/evidence-cursors.json] [--changed-file path] [--limit 20]');
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return parsed;
}
