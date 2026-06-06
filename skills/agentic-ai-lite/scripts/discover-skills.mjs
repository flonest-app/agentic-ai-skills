#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export function buildSkillsSearchCommand(query) {
  if (!query) throw new Error('--query is required');
  return ['npx', 'skills', 'find', query];
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2));
  const command = buildSkillsSearchCommand(args.query);

  if (!args.execute) {
    console.log(JSON.stringify({
      mode: 'dry-run',
      command,
      note: 'Run with --execute to search skills.sh through the skills CLI. Select a result, install it, then register it as managed.',
    }, null, 2));
    process.exit(0);
  }

  const result = spawnSync(command[0], command.slice(1), {
    encoding: 'utf8',
    stdio: 'inherit',
  });
  process.exit(result.status ?? 1);
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--query') parsed.query = argv[++i];
    else if (arg === '--execute') parsed.execute = true;
    else if (arg === '--help') {
      console.log('Usage: discover-skills.mjs --query <search text> [--execute]');
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!parsed.query) throw new Error('--query is required');
  return parsed;
}
