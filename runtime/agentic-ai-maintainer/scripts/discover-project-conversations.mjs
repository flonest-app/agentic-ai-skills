#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';

const TEXT_FILE_RE = /\.(jsonl|json|md|txt|log)$/i;
const MAX_READ_BYTES = 25 * 1024 * 1024;

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2));
  const projectRoot = resolve(args.projectRoot || process.cwd());
  const result = discoverProjectConversations({
    projectRoot,
    projectName: args.projectName,
    searchRoots: args.searchRoots,
    sourceCodexHome: args.sourceCodexHome,
    limit: args.limit,
  });
  console.log(JSON.stringify(result, null, 2));
}

export function discoverProjectConversations({
  projectRoot = process.cwd(),
  projectName,
  searchRoots = [],
  sourceCodexHome = join(homedir(), '.codex'),
  limit = 50,
} = {}) {
  const root = resolve(projectRoot);
  const name = projectName || basename(root);
  const terms = Array.from(new Set([root, name].filter((term) => term && term.length >= 3)));
  const roots = searchRoots.length > 0
    ? searchRoots.map((searchRoot) => resolve(searchRoot))
    : defaultConversationSearchRoots({ projectRoot: root, sourceCodexHome });

  const candidates = discoverCandidatePaths({ terms, searchRoots: roots })
    .map((filePath) => inspectConversationCandidate({ filePath, terms }))
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score || b.lastModifiedMs - a.lastModifiedMs)
    .slice(0, Number(limit || 50));

  return {
    projectRoot: root,
    projectName: name,
    searchRoots: roots,
    candidateCount: candidates.length,
    candidates,
  };
}

export function defaultConversationSearchRoots({
  projectRoot = process.cwd(),
  sourceCodexHome = join(homedir(), '.codex'),
} = {}) {
  const root = resolve(projectRoot);
  return Array.from(new Set([
    join(root, '.conversations'),
    join(resolve(sourceCodexHome), 'session_index.jsonl'),
    join(resolve(sourceCodexHome), 'sessions'),
  ]));
}

export function discoverCandidatePaths({ terms, searchRoots }) {
  const existingRoots = searchRoots.filter((searchRoot) => existsSync(searchRoot));
  if (existingRoots.length === 0 || terms.length === 0) return [];

  const rg = spawnSync('rg', ['--version'], { encoding: 'utf8' });
  if (rg.status === 0) return discoverWithRipgrep({ terms, searchRoots: existingRoots });
  return discoverByWalking({ terms, searchRoots: existingRoots });
}

function discoverWithRipgrep({ terms, searchRoots }) {
  const files = new Set();
  for (const term of terms) {
    const result = spawnSync('rg', [
      '--hidden',
      '--no-messages',
      '--files-with-matches',
      '--fixed-strings',
      '--ignore-case',
      '--glob', '!**/.git/**',
      '--glob', '!**/node_modules/**',
      '--glob', '!**/runtime/**',
      '--glob', '!**/dist/**',
      '--glob', '!**/build/**',
      '--glob', '!**/coverage/**',
      term,
      ...searchRoots,
    ], {
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
    });

    for (const line of (result.stdout || '').split('\n')) {
      if (line.trim()) files.add(resolve(line.trim()));
    }
  }
  return Array.from(files);
}

function discoverByWalking({ terms, searchRoots }) {
  const files = new Set();
  for (const searchRoot of searchRoots) walk(searchRoot, files, terms);
  return Array.from(files);
}

function walk(currentPath, files, terms) {
  let stat;
  try {
    stat = statSync(currentPath);
  } catch {
    return;
  }

  if (stat.isDirectory()) {
    const name = basename(currentPath);
    if (['.git', 'node_modules', 'runtime', 'dist', 'build', 'coverage'].includes(name)) return;
    let entries = [];
    try {
      entries = readdirSync(currentPath);
    } catch {
      return;
    }
    for (const entry of entries) walk(resolve(currentPath, entry), files, terms);
    return;
  }

  if (!stat.isFile() || stat.size > MAX_READ_BYTES || !TEXT_FILE_RE.test(currentPath)) return;
  let text = '';
  try {
    text = readFileSync(currentPath, 'utf8');
  } catch {
    return;
  }
  const lower = text.toLowerCase();
  if (terms.some((term) => lower.includes(term.toLowerCase()))) files.add(resolve(currentPath));
}

export function inspectConversationCandidate({ filePath, terms }) {
  const stat = statSync(filePath);
  const ext = extname(filePath).toLowerCase();
  const pathLower = filePath.toLowerCase();
  const scoreParts = [];
  const conversationPath = /(conversation|transcript|session|history|chat|message|logs?|rollout)/.test(pathLower);
  if (conversationPath) scoreParts.push(['conversation_path', 5]);
  if (ext === '.jsonl') scoreParts.push(['jsonl', 3]);
  if (['.json', '.md', '.txt', '.log'].includes(ext)) scoreParts.push(['readable_text', 1]);

  let text = '';
  try {
    if (stat.size <= MAX_READ_BYTES && TEXT_FILE_RE.test(filePath)) text = readFileSync(filePath, 'utf8');
  } catch {}

  const matchedTerms = terms.filter((term) => text.toLowerCase().includes(term.toLowerCase()));
  if (matchedTerms.length > 0) scoreParts.push(['project_match', matchedTerms.length * 4]);
  const jsonl = ext === '.jsonl' ? inspectJsonl(text) : {};
  const score = scoreParts.reduce((total, [, value]) => total + value, 0);
  return {
    filePath: resolve(filePath),
    score,
    scoreParts: Object.fromEntries(scoreParts),
    lastModified: new Date(stat.mtimeMs).toISOString(),
    lastModifiedMs: stat.mtimeMs,
    bytes: stat.size,
    lineCount: text ? countLines(text) : null,
    matchedTerms,
    ...jsonl,
  };
}

function inspectJsonl(text) {
  let firstTimestamp = null;
  let cwd = null;
  const detectedIds = new Set();

  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      const payload = event.payload || {};
      const timestamp = event.created_at || event.timestamp || payload.timestamp;
      if (timestamp && !firstTimestamp) firstTimestamp = timestamp;
      const id = event.conversation_id || event.session_id || payload.id || payload.session_id;
      if (typeof id === 'string') detectedIds.add(id);
      const candidateCwd = event.cwd || payload.cwd || payload.session?.cwd;
      if (typeof candidateCwd === 'string' && !cwd) cwd = candidateCwd;
    } catch {
      // Session files may include non-JSON lines; text matching still makes them useful.
    }
  }

  return {
    firstTimestamp,
    cwd,
    detectedIds: Array.from(detectedIds).slice(0, 10),
  };
}

function countLines(text) {
  if (!text) return 0;
  const newlineMatches = text.match(/\n/g);
  return (newlineMatches?.length || 0) + (text.endsWith('\n') ? 0 : 1);
}

function parseArgs(argv) {
  const parsed = { searchRoots: [], limit: 50 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--project-root') parsed.projectRoot = argv[++i];
    else if (arg === '--project-name') parsed.projectName = argv[++i];
    else if (arg === '--search-root') parsed.searchRoots.push(argv[++i]);
    else if (arg === '--source-codex-home') parsed.sourceCodexHome = argv[++i];
    else if (arg === '--limit') parsed.limit = Number(argv[++i]);
    else if (arg === '--help') {
      console.log('Usage: discover-project-conversations.mjs --project-root <repo> [--source-codex-home ~/.codex] [--search-root path]');
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return parsed;
}
