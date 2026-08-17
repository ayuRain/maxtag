#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

export const secretPatterns = [
  { name: 'private-key', pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u },
  { name: 'aws-access-key', pattern: /\bAKIA[0-9A-Z]{16}\b/u },
  { name: 'github-token', pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/u },
  { name: 'slack-token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/u },
];

export function scanText(text, file = '<text>') {
  const findings = [];
  for (const [index, line] of text.split(/\r?\n/u).entries()) {
    if (line.includes('secret-scan: allow')) continue;
    for (const candidate of secretPatterns) {
      if (candidate.pattern.test(line)) {
        findings.push({ file, line: index + 1, pattern: candidate.name });
      }
    }
  }
  return findings;
}

function trackedFiles() {
  return execFileSync(
    'git',
    [
      'ls-files',
      '-z',
      '--cached',
      '--others',
      '--exclude-standard',
      '--',
      ':!artifacts/**',
      ':!data/**',
    ],
    { encoding: 'utf8' },
  )
    .split('\0')
    .filter(Boolean);
}

function main() {
  const findings = [];
  for (const file of trackedFiles()) {
    // `git ls-files --cached` also reports tracked paths deleted in the current
    // worktree. A deletion cannot introduce a secret and should not make the
    // pre-commit scan crash before the index is updated.
    if (!fs.existsSync(file)) continue;
    const bytes = fs.readFileSync(file);
    if (bytes.includes(0)) continue;
    findings.push(...scanText(bytes.toString('utf8'), file));
  }
  if (!findings.length) {
    process.stdout.write('Secret scan passed.\n');
    return;
  }
  for (const finding of findings) {
    process.stderr.write(
      `${finding.file}:${finding.line}: possible ${finding.pattern}\n`,
    );
  }
  process.exitCode = 1;
}

if (process.argv[1]?.endsWith('scan-secrets.mjs')) main();
