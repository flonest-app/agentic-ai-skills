#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2));
  const result = await syncLabserverRequests({
    projectRoot: resolve(args.projectRoot || process.cwd()),
    projectId: args.projectId,
    labserverUrl: args.labserverUrl,
  });
  console.log(JSON.stringify(result, null, 2));
}

export async function syncLabserverRequests({
  projectRoot = process.cwd(),
  inboxDir = join(projectRoot, '.agentic-ai', 'inbox'),
  projectId,
  labserverUrl = process.env.AGENTIC_AI_LABSERVER_URL,
  fetchImpl = globalThis.fetch,
} = {}) {
  mkdirSync(inboxDir, { recursive: true });
  if (!labserverUrl) {
    return { status: 'skipped', reason: 'AGENTIC_AI_LABSERVER_URL is not configured', received: 0 };
  }
  if (!projectId) throw new Error('project_id is required to poll labserver requests');

  const endpoint = `${labserverUrl.replace(/\/$/, '')}/skill-proposals/projects/${projectId}/requests`;
  const response = await fetchImpl(endpoint);
  if (!response.ok) throw new Error(`labserver request poll failed: ${response.status} ${await response.text()}`);
  const body = await response.json();
  const requests = Array.isArray(body.requests) ? body.requests : [];
  let written = 0;

  for (const request of requests) {
    if (!request.request_id) continue;
    const path = join(inboxDir, `${safeName(request.request_id)}.json`);
    if (existsSync(path)) continue;
    writeJson(path, {
      ...request,
      local_status: 'pending',
      received_at: new Date().toISOString(),
    });
    written += 1;
  }

  return { status: 'synced', endpoint, received: written, total_remote: requests.length };
}

export function listPendingLabserverRequests({
  inboxDir = join(process.cwd(), '.agentic-ai', 'inbox'),
} = {}) {
  if (!existsSync(inboxDir)) return [];
  return readdirSync(inboxDir)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) => JSON.parse(readFileSync(join(inboxDir, file), 'utf8')))
    .filter((request) => request.local_status !== 'answered' && request.status !== 'responded');
}

export function markLabserverRequestAnswered({
  inboxDir = join(process.cwd(), '.agentic-ai', 'inbox'),
  requestId,
} = {}) {
  const path = join(inboxDir, `${safeName(requestId)}.json`);
  if (!existsSync(path)) return null;
  const request = JSON.parse(readFileSync(path, 'utf8'));
  const next = {
    ...request,
    local_status: 'answered',
    answered_at: new Date().toISOString(),
  };
  writeJson(path, next);
  return next;
}

function safeName(value) {
  return String(value || 'request').replace(/[^a-z0-9_.-]+/gi, '-').slice(0, 100);
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
    else if (arg === '--project-id') parsed.projectId = argv[++i];
    else if (arg === '--labserver-url') parsed.labserverUrl = argv[++i];
    else if (arg === '--help') {
      console.log('Usage: labserver-sync.mjs --project-id <id> [--project-root repo] [--labserver-url url]');
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return parsed;
}
