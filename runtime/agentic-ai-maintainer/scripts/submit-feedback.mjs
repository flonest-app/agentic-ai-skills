#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const SECRET_PATTERNS = [
  [/sk-[A-Za-z0-9_-]{20,}/g, '[REDACTED_OPENAI_KEY]'],
  [/gh[pousr]_[A-Za-z0-9_]{20,}/g, '[REDACTED_GITHUB_TOKEN]'],
  [/-----BEGIN (?:RSA |EC |OPENSSH |)PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |)PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]'],
  [/\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g, '[REDACTED_JWT]'],
];

const RAW_TRANSCRIPT_PATTERNS = [
  [/```(?:jsonl|json)?\s*\n(?:\{"timestamp"[\s\S]*?)```/g, '[REDACTED_TRANSCRIPT_BLOCK]'],
  [/^\{"timestamp":".*","type":"response_item".*$/gm, '[REDACTED_TRANSCRIPT_LINE]'],
  [/"encrypted_content"\s*:\s*"[^"]+"/g, '"encrypted_content":"[REDACTED]"'],
];

export function sanitizeFeedback(input, {
  repoName,
  cwd = process.cwd(),
  maxLength = 12000,
  skillId,
  upstreamRepo,
  feedbackKind = 'skill-feedback',
} = {}) {
  const redactions = [];
  let text = input;

  for (const [pattern, replacement] of SECRET_PATTERNS) {
    text = replaceAndTrack(text, pattern, replacement, redactions, 'secret');
  }

  for (const [pattern, replacement] of RAW_TRANSCRIPT_PATTERNS) {
    text = replaceAndTrack(text, pattern, replacement, redactions, 'raw_transcript');
  }

  text = replaceAndTrack(text, /\/home\/[^/\s"'`]+\/[^\s"'`]+/g, '[REDACTED_LOCAL_PATH]', redactions, 'absolute_path');
  text = replaceAndTrack(text, /\/Users\/[^/\s"'`]+\/[^\s"'`]+/g, '[REDACTED_LOCAL_PATH]', redactions, 'absolute_path');
  text = replaceAndTrack(text, /[A-Za-z]:\\Users\\[^\\\s"'`]+\\[^\s"'`]+/g, '[REDACTED_LOCAL_PATH]', redactions, 'absolute_path');

  const names = new Set([repoName, basename(resolve(cwd))].filter(Boolean));
  for (const name of names) {
    if (name.length < 4) continue;
    const pattern = new RegExp(escapeRegExp(name), 'gi');
    text = replaceAndTrack(text, pattern, '[REDACTED_REPO_NAME]', redactions, 'repo_name');
  }

  if (text.length > maxLength) {
    text = `${text.slice(0, maxLength)}\n[TRUNCATED]`;
    redactions.push('length');
  }

  return {
    schema_version: 1,
    kind: 'agentic-ai-feedback',
    feedback_kind: feedbackKind,
    skill_id: skillId || null,
    upstream_repo: upstreamRepo || null,
    classification_hint: classifySanitizedFeedback(text),
    sanitized_text: text,
    redactions: Array.from(new Set(redactions)),
  };
}

export function buildProposalTitle(input = {}) {
  const target = input.skillId || input.skill_id || input.upstreamRepo || input.upstream_repo || 'unknown-skill';
  const kind = input.feedbackKind || input.feedback_kind || 'skill-feedback';
  return `[agentic-ai] ${kind}: ${target}`;
}

export function formatProposalBody(payload) {
  return [
    'Agentic AI sanitized proposal context.',
    '',
    `Feedback kind: ${payload.feedback_kind}`,
    `Skill ID: ${payload.skill_id || 'unknown'}`,
    `Upstream repo: ${payload.upstream_repo || 'unknown'}`,
    `Classification hint: ${payload.classification_hint}`,
    `Redactions: ${payload.redactions.length > 0 ? payload.redactions.join(', ') : 'none'}`,
    '',
    '```text',
    payload.sanitized_text,
    '```',
  ].join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2));
  if (args.endpoint) {
    throw new Error('Direct feedback submission is disabled. Run agi and let the proposal outbox submit to /skill-proposals.');
  }
  const input = args.text ?? (args.file ? readFileSync(args.file, 'utf8') : readFileSync(0, 'utf8'));
  const payload = sanitizeFeedback(input, {
    repoName: args.repoName,
    cwd: args.cwd,
    skillId: args.skillId,
    upstreamRepo: args.upstreamRepo,
    feedbackKind: args.feedbackKind,
  });

  console.log(JSON.stringify(payload, null, 2));
}

function classifySanitizedFeedback(text) {
  if (/\[REDACTED_(?:OPENAI_KEY|GITHUB_TOKEN|PRIVATE_KEY|JWT|TRANSCRIPT)/.test(text)) return 'unsafe-redacted';
  if (/\bAGENTS\.md\b|\bproject-specific\b/i.test(text)) return 'project-specific-or-mixed';
  return 'generic-candidate';
}

function replaceAndTrack(text, pattern, replacement, redactions, label) {
  let matched = false;
  const next = text.replace(pattern, () => {
    matched = true;
    return replacement;
  });
  if (matched) redactions.push(label);
  return next;
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--text') parsed.text = argv[++i];
    else if (arg === '--file') parsed.file = argv[++i];
    else if (arg === '--repo-name') parsed.repoName = argv[++i];
    else if (arg === '--skill-id') parsed.skillId = argv[++i];
    else if (arg === '--upstream-repo') parsed.upstreamRepo = argv[++i];
    else if (arg === '--feedback-kind') parsed.feedbackKind = argv[++i];
    else if (arg === '--cwd') parsed.cwd = argv[++i];
    else if (arg === '--endpoint') parsed.endpoint = argv[++i];
    else if (arg === '--help') {
      console.log('Usage: submit-feedback.mjs [--text text|--file path] [--skill-id id] [--upstream-repo owner/repo]');
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return parsed;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
