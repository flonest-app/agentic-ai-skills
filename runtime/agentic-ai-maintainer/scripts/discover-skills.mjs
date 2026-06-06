#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const DEFAULT_API_BASE = process.env.SKILLS_API_URL || 'https://skills.sh';
const DEFAULT_LIMIT = 10;

export function buildSkillsSearchCommand(query) {
  if (!query) throw new Error('--query is required');
  return ['npx', 'skills', 'find', query];
}

export function buildSkillsSearchUrl(query, { apiBase = DEFAULT_API_BASE, limit = DEFAULT_LIMIT } = {}) {
  if (!query) throw new Error('--query is required');
  const url = new URL('/api/search', apiBase);
  url.searchParams.set('q', query);
  url.searchParams.set('limit', String(limit));
  return url.toString();
}

export function normalizeSkillsSearchResponse(response) {
  const skills = Array.isArray(response?.skills) ? response.skills : [];
  return {
    query: response?.query || null,
    search_type: response?.searchType || null,
    count: Number.isFinite(response?.count) ? response.count : skills.length,
    skills: skills.map((skill) => {
      const source = skill.source || inferSourceFromId(skill.id);
      const skillId = skill.skillId || inferSkillIdFromId(skill.id) || skill.name;
      return {
        id: skill.id || `${source}/${skillId}`,
        skill_id: skillId,
        name: skill.name || skillId,
        source,
        install_spec: source,
        install_skill: skillId,
        installs: Number.isFinite(skill.installs) ? skill.installs : 0,
        management_mode: 'external-feedback',
      };
    }),
  };
}

export async function searchSkillsApi({
  query,
  apiBase = DEFAULT_API_BASE,
  limit = DEFAULT_LIMIT,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!fetchImpl) throw new Error('global fetch is required');
  const url = buildSkillsSearchUrl(query, { apiBase, limit });
  const response = await fetchImpl(url);
  if (!response.ok) throw new Error(`skills.sh search failed: HTTP ${response.status}`);
  return normalizeSkillsSearchResponse(await response.json());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2));

  if (args.cli) {
    const command = buildSkillsSearchCommand(args.query);
    const result = spawnSync(command[0], command.slice(1), {
      encoding: 'utf8',
      stdio: 'inherit',
    });
    process.exit(result.status ?? 1);
  }

  try {
    const result = await searchSkillsApi({
      query: args.query,
      apiBase: args.apiBase,
      limit: args.limit,
    });
    console.log(JSON.stringify({
      ok: true,
      source: buildSkillsSearchUrl(args.query, { apiBase: args.apiBase, limit: args.limit }),
      ...result,
      fallback_command: buildSkillsSearchCommand(args.query),
    }, null, 2));
  } catch (err) {
    console.error(JSON.stringify({
      ok: false,
      error: err.message,
      fallback_command: buildSkillsSearchCommand(args.query),
      note: 'Run with --cli to use the interactive npx skills find fallback.',
    }, null, 2));
    process.exit(1);
  }
}

function parseArgs(argv) {
  const parsed = {
    apiBase: DEFAULT_API_BASE,
    limit: DEFAULT_LIMIT,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--query') parsed.query = argv[++i];
    else if (arg === '--api-base') parsed.apiBase = argv[++i];
    else if (arg === '--limit') parsed.limit = Number(argv[++i]);
    else if (arg === '--cli' || arg === '--execute') parsed.cli = true;
    else if (arg === '--help') {
      console.log('Usage: discover-skills.mjs --query <search text> [--limit 10] [--cli]');
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!parsed.query) throw new Error('--query is required');
  if (!Number.isFinite(parsed.limit) || parsed.limit <= 0) throw new Error('--limit must be a positive number');
  return parsed;
}

function inferSourceFromId(id) {
  if (!id) return null;
  const parts = String(id).split('/');
  return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : null;
}

function inferSkillIdFromId(id) {
  if (!id) return null;
  const parts = String(id).split('/');
  return parts.at(-1) || null;
}
