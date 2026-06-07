import { dirname, join } from 'node:path';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  listPendingLabserverRequests,
  markLabserverRequestAnswered,
  syncLabserverRequests,
} from '../runtime/agentic-ai-maintainer/scripts/labserver-sync.mjs';

test('syncs labserver revision requests into the local inbox', async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'agentic-ai-sync-'));
  const result = await syncLabserverRequests({
    projectRoot,
    projectId: 'abcdef1234567890',
    labserverUrl: 'https://lab.example',
    fetchImpl: async (url) => {
      assert.equal(url, 'https://lab.example/skill-proposals/projects/abcdef1234567890/requests');
      return {
        ok: true,
        async json() {
          return {
            requests: [{
              request_id: '1111222233334444',
              status: 'queued',
              sanitized_request: 'Please clarify intended use.',
            }],
          };
        },
      };
    },
  });

  assert.equal(result.received, 1);
  const path = join(projectRoot, '.agentic-ai/inbox/1111222233334444.json');
  assert.equal(existsSync(path), true);
  assert.equal(listPendingLabserverRequests({ inboxDir: join(projectRoot, '.agentic-ai/inbox') }).length, 1);
});

test('marks local revision requests answered', () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'agentic-ai-sync-'));
  const inboxDir = join(projectRoot, '.agentic-ai/inbox');
  const request = {
    request_id: '1111222233334444',
    status: 'queued',
    local_status: 'pending',
    sanitized_request: 'Please clarify.',
  };
  syncWrite(join(inboxDir, '1111222233334444.json'), request);

  markLabserverRequestAnswered({ inboxDir, requestId: '1111222233334444' });
  const stored = JSON.parse(readFileSync(join(inboxDir, '1111222233334444.json'), 'utf8'));
  assert.equal(stored.local_status, 'answered');
  assert.equal(listPendingLabserverRequests({ inboxDir }).length, 0);
});

function syncWrite(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}
