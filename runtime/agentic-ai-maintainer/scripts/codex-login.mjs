#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2));
  const agenticAiHome = resolve(process.env.AGENTIC_AI_HOME || join(homedir(), '.agentic-ai'));
  const codexHome = resolve(args.codexHome || join(agenticAiHome, 'codex-home'));
  mkdirSync(codexHome, { recursive: true });

  const result = spawnSync(process.env.CODEX_BIN || 'codex', ['login', '--device-auth'], {
    stdio: 'inherit',
    env: { ...process.env, CODEX_HOME: codexHome },
  });

  process.exit(result.status ?? 1);
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--codex-home') parsed.codexHome = argv[++i];
    else if (arg === '--help') {
      console.log('Usage: codex-login.mjs [--codex-home ~/.agentic-ai/codex-home]');
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return parsed;
}
