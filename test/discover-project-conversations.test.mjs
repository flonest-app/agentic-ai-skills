import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultConversationSearchRoots,
  discoverProjectConversations,
} from '../runtime/agentic-ai-maintainer/scripts/discover-project-conversations.mjs';

test('discovers Codex session artifacts that mention the project', () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'agentic-ai-project-'));
  const sourceCodexHome = mkdtempSync(join(tmpdir(), 'agentic-ai-source-codex-'));
  const runtimeCodexHome = mkdtempSync(join(tmpdir(), 'agentic-ai-runtime-codex-'));
  const sessionDir = join(sourceCodexHome, 'sessions/2026/06/06');
  const runtimeSessionDir = join(runtimeCodexHome, 'sessions/2026/06/06');
  mkdirSync(sessionDir, { recursive: true });
  mkdirSync(runtimeSessionDir, { recursive: true });

  const sessionPath = join(sessionDir, 'rollout-2026-06-06T00-00-00-thread-1.jsonl');
  writeFileSync(sessionPath, [
    JSON.stringify({
      type: 'session_meta',
      timestamp: '2026-06-06T00:00:00.000Z',
      payload: { id: 'thread-1', cwd: projectRoot },
    }),
    JSON.stringify({
      type: 'message',
      timestamp: '2026-06-06T00:00:01.000Z',
      payload: { text: `Maintaining project at ${projectRoot}` },
    }),
    '',
  ].join('\n'));
  writeFileSync(join(runtimeSessionDir, 'rollout-sidecar.jsonl'), [
    JSON.stringify({
      type: 'session_meta',
      timestamp: '2026-06-06T00:00:00.000Z',
      payload: { id: 'sidecar-thread', cwd: projectRoot },
    }),
    JSON.stringify({
      type: 'message',
      timestamp: '2026-06-06T00:00:01.000Z',
      payload: { text: `Sidecar maintainer chat about ${projectRoot}` },
    }),
    '',
  ].join('\n'));

  const roots = defaultConversationSearchRoots({ projectRoot, sourceCodexHome });
  assert.equal(roots.includes(join(sourceCodexHome, 'sessions')), true);
  assert.equal(roots.includes(join(runtimeCodexHome, 'sessions')), false);

  const result = discoverProjectConversations({
    projectRoot,
    sourceCodexHome,
  });

  assert.equal(result.candidateCount, 1);
  assert.equal(result.candidates[0].filePath, sessionPath);
  assert.equal(result.candidates[0].cwd, projectRoot);
  assert.deepEqual(result.candidates[0].detectedIds, ['thread-1']);
});
