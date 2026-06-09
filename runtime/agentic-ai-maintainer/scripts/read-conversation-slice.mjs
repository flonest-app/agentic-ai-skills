#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_CURSOR_RELATIVE_PATH = '.agentic-ai/evidence-cursors.json';
const DEFAULT_MAX_LINES = 120;
const DEFAULT_MAX_BYTES = 96 * 1024;

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2));
  const result = readConversationSlice({
    filePath: args.file,
    projectRoot: args.projectRoot,
    cursorPath: args.cursorPath,
    fromLine: args.fromLine,
    maxLines: args.maxLines,
    maxBytes: args.maxBytes,
    markRead: args.markRead,
  });
  console.log(JSON.stringify(result, null, 2));
}

export function defaultEvidenceCursorPath(projectRoot = process.cwd()) {
  return join(resolve(projectRoot), DEFAULT_CURSOR_RELATIVE_PATH);
}

export function readEvidenceCursor(cursorPath = defaultEvidenceCursorPath()) {
  if (!existsSync(cursorPath)) return { schema_version: 1, files: {} };
  const parsed = JSON.parse(readFileSync(cursorPath, 'utf8'));
  return {
    schema_version: 1,
    ...parsed,
    files: parsed.files && typeof parsed.files === 'object' ? parsed.files : {},
  };
}

export function writeEvidenceCursor(cursorPath, cursor) {
  mkdirSync(dirname(cursorPath), { recursive: true });
  writeFileSync(cursorPath, `${JSON.stringify({ schema_version: 1, ...cursor }, null, 2)}\n`);
}

export function getEvidenceFileCursor({ filePath, cursorPath = defaultEvidenceCursorPath() }) {
  const absFile = resolve(filePath);
  const cursor = readEvidenceCursor(cursorPath);
  const entry = cursor.files[absFile] || {};
  const line = Number.isFinite(entry.line) && entry.line > 0 ? Math.floor(entry.line) : 0;
  return { cursor, entry, line };
}

export function updateEvidenceFileCursor({
  filePath,
  cursorPath = defaultEvidenceCursorPath(),
  line,
  bytes,
}) {
  const absFile = resolve(filePath);
  const cursor = readEvidenceCursor(cursorPath);
  cursor.files[absFile] = {
    ...(cursor.files[absFile] || {}),
    line: Math.max(0, Math.floor(Number(line) || 0)),
    bytes: Number.isFinite(bytes) ? bytes : statSafe(absFile)?.size || null,
    updated_at: new Date().toISOString(),
  };
  writeEvidenceCursor(cursorPath, cursor);
  return cursor.files[absFile];
}

export function readConversationSlice({
  filePath,
  projectRoot = process.cwd(),
  cursorPath = defaultEvidenceCursorPath(projectRoot),
  fromLine,
  maxLines = DEFAULT_MAX_LINES,
  maxBytes = DEFAULT_MAX_BYTES,
  markRead = false,
} = {}) {
  if (!filePath) throw new Error('--file is required');
  const absFile = resolve(filePath);
  const stat = statSync(absFile);
  const lines = readFileSync(absFile, 'utf8').split('\n');
  if (lines.at(-1) === '') lines.pop();

  const stored = getEvidenceFileCursor({ filePath: absFile, cursorPath });
  const storedLine = stored.line > lines.length ? 0 : stored.line;
  const startLine = Number.isFinite(fromLine) && fromLine > 0
    ? Math.floor(fromLine) - 1
    : storedLine;
  const boundedStart = Math.max(0, Math.min(startLine, lines.length));
  const normalizedLines = lines.map((line, index) => normalizeJsonlEvent(line, index + 1));
  const emitted = [];
  let totalBytes = 0;
  let cursorLine = boundedStart;

  for (let index = boundedStart; index < lines.length; index += 1) {
    if (emitted.length >= maxLines) break;
    const normalized = normalizedLines[index];
    if (!isSemanticTranscriptEvent(normalized, {
      previous: normalizedLines[index - 1],
      next: normalizedLines[index + 1],
    })) {
      cursorLine = index + 1;
      continue;
    }
    const bytes = Buffer.byteLength(JSON.stringify(normalized), 'utf8');
    if (emitted.length > 0 && totalBytes + bytes > maxBytes) break;
    emitted.push(normalized);
    totalBytes += bytes;
    cursorLine = index + 1;
  }

  let updatedCursor = null;
  if (markRead) {
    updatedCursor = updateEvidenceFileCursor({
      filePath: absFile,
      cursorPath,
      line: cursorLine,
      bytes: stat.size,
    });
  }

  return {
    schema_version: 1,
    file_path: absFile,
    cursor_path: resolve(cursorPath),
    previous_cursor_line: storedLine,
    emitted_from_line: emitted.length > 0 ? boundedStart + 1 : null,
    emitted_through_line: emitted.length > 0 ? cursorLine : null,
    file_line_count: lines.length,
    remaining_line_count: Math.max(0, lines.length - cursorLine),
    max_lines: maxLines,
    max_bytes: maxBytes,
    mark_read: markRead,
    transcript_view: 'semantic',
    cursor_updated: Boolean(updatedCursor),
    cursor: updatedCursor,
    events: emitted,
  };
}

function normalizeJsonlEvent(line, lineNumber) {
  try {
    const event = JSON.parse(line);
    const payload = event.payload || {};
    const contentText = extractText(payload.content) || extractText(payload.text) || extractText(payload.message);
    const outputText = extractText(payload.output);
    const argsText = extractText(payload.arguments);
    return {
      line_number: lineNumber,
      timestamp: event.timestamp || event.created_at || payload.timestamp || null,
      type: event.type || null,
      item_type: payload.type || null,
      role: payload.role || null,
      call_id: payload.call_id || null,
      name: payload.name || null,
      cwd: payload.cwd || payload.session?.cwd || null,
      semantic_kind: semanticKind({ event, payload }),
      text: truncateText(contentText || outputText || argsText || '', 4000),
    };
  } catch {
    return {
      line_number: lineNumber,
      type: 'raw',
      text: truncateText(line, 4000),
    };
  }
}

function semanticKind({ event, payload }) {
  if (event.type === 'session_meta') return 'session_metadata';
  if (event.type === 'turn_context') return 'turn_context';
  if (event.type === 'response_item' && payload.type === 'message') return `message:${payload.role || 'unknown'}`;
  if (event.type === 'response_item' && payload.type === 'function_call') return `tool_call:${payload.name || 'unknown'}`;
  if (event.type === 'response_item' && payload.type === 'function_call_output') return 'tool_output';
  if (event.type === 'event_msg' && payload.type === 'task_started') return 'task_started';
  if (event.type === 'event_msg' && payload.type === 'task_complete') return 'task_complete';
  if (event.type === 'event_msg' && payload.type === 'user_message') return 'message:user';
  if (event.type === 'event_msg' && payload.type === 'agent_message') return 'message:assistant';
  return null;
}

function isSemanticTranscriptEvent(event, { previous = null, next = null } = {}) {
  if (!event) return false;
  if (event.type === 'raw') return Boolean(event.text);
  if (event.semantic_kind === 'session_metadata' || event.semantic_kind === 'turn_context') return true;
  if (event.semantic_kind === 'task_started' || event.semantic_kind === 'task_complete') return true;
  if (event.semantic_kind?.startsWith('tool_call:') || event.semantic_kind === 'tool_output') return true;
  if (event.semantic_kind?.startsWith('message:')) {
    if (!event.text) return false;
    return !isDuplicateDisplayMessage(event, previous) && !isDuplicateDisplayMessage(event, next);
  }
  return false;
}

function isDuplicateDisplayMessage(event, neighbor) {
  if (!neighbor || !event.text || event.text !== neighbor.text) return false;
  const eventIsDisplay = event.type === 'event_msg'
    && (event.item_type === 'user_message' || event.item_type === 'agent_message');
  const neighborIsMessage = neighbor.type === 'response_item' && neighbor.item_type === 'message';
  return eventIsDisplay && neighborIsMessage;
}

function extractText(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (typeof item === 'string') return item;
      if (item && typeof item === 'object') return item.text || item.content || '';
      return '';
    }).filter(Boolean).join('\n');
  }
  if (typeof value === 'object') return value.text || value.content || '';
  return String(value);
}

function truncateText(text, maxChars) {
  const value = String(text || '');
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}...[truncated]`;
}

function statSafe(path) {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

function parseArgs(argv) {
  const parsed = {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
    markRead: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--file') parsed.file = argv[++i];
    else if (arg === '--project-root') parsed.projectRoot = argv[++i];
    else if (arg === '--cursor-path') parsed.cursorPath = argv[++i];
    else if (arg === '--from-line') parsed.fromLine = Number(argv[++i]);
    else if (arg === '--max-lines') parsed.maxLines = Number(argv[++i]);
    else if (arg === '--max-bytes') parsed.maxBytes = Number(argv[++i]);
    else if (arg === '--mark-read') parsed.markRead = true;
    else if (arg === '--help') {
      console.log('Usage: read-conversation-slice.mjs --file path [--project-root repo] [--cursor-path path] [--from-line line] [--max-lines 120] [--max-bytes 98304] [--mark-read]');
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return parsed;
}
