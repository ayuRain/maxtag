import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import fs from 'node:fs/promises';
import { isIP } from 'node:net';
import path from 'node:path';
import type { AgentRunRequest, ToolGrant } from '@opentag/core';
import {
  resolveProjectWorkingDirectory,
  runCliCommand,
} from '@opentag/executor-cli';
import { ToolDeniedError } from './errors.js';

type JsonObject = Record<string, unknown>;

interface LocalToolContext {
  request: AgentRunRequest;
  grant: ToolGrant;
  signal: AbortSignal;
}

export interface LocalToolDefinition {
  name: string;
  title: string;
  description: string;
  grantKind: 'shell' | 'browser';
  risk: 'read' | 'write';
  provider: string;
  approval?: 'policy' | 'always';
  inputSchema: JsonObject;
  available(): boolean;
  granted?(request: AgentRunRequest): boolean;
  authorize(request: AgentRunRequest, input: JsonObject): ToolGrant;
  summarize(input: JsonObject): JsonObject;
  destination?(input: JsonObject, result?: unknown): string | undefined;
  execute(context: LocalToolContext, input: JsonObject): Promise<unknown>;
}

export interface LocalToolOptions {
  workspaceRoot?: string;
  browser?: {
    fetch?: typeof fetch;
    resolve?: (hostname: string) => Promise<string[]>;
  };
  maxResultBytes?: number;
}

const SKIPPED_DIRECTORIES = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
]);
const SENSITIVE_HOSTNAMES = new Set([
  'host.docker.internal',
  'kubernetes.default',
  'kubernetes.default.svc',
  'localhost',
  'metadata.google.internal',
]);

function stringValue(input: JsonObject, key: string): string {
  const value = input[key];
  return typeof value === 'string' ? value.trim() : '';
}

function httpsOrigin(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.origin : undefined;
  } catch {
    return undefined;
  }
}

function stringArray(input: JsonObject, key: string): string[] {
  const value = input[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function integerValue(
  input: JsonObject,
  key: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const value = input[key];
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(minimum, Math.min(maximum, Math.floor(value)))
    : fallback;
}

function permissionAllows(grant: ToolGrant, permission: 'read' | 'write'): boolean {
  const permissions = grant.constraints?.permissions;
  if (!Array.isArray(permissions)) {
    return permission === 'read' || grant.kind === 'shell';
  }
  return permissions.includes(permission);
}

function localGrant(
  request: AgentRunRequest,
  kind: 'shell' | 'browser',
  permission: 'read' | 'write',
): ToolGrant {
  const grant = request.access.grants.find(
    (candidate) =>
      candidate.kind === kind && permissionAllows(candidate, permission),
  );
  if (!grant) throw new ToolDeniedError(`${kind}_${permission}_not_granted`);
  return grant;
}

async function projectRoot(
  options: LocalToolOptions,
  request: AgentRunRequest,
): Promise<string> {
  return fs.realpath(
    await resolveProjectWorkingDirectory(options.workspaceRoot, request),
  );
}

function relativeInput(input: JsonObject, key = 'path'): string {
  const value = stringValue(input, key) || '.';
  if (path.isAbsolute(value) || value.includes('\0')) {
    throw new ToolDeniedError('workspace_path_outside_project');
  }
  return value.replaceAll('\\', '/');
}

function assertInside(root: string, candidate: string): void {
  const relative = path.relative(root, candidate);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new ToolDeniedError('workspace_path_outside_project');
  }
}

async function existingPath(
  options: LocalToolOptions,
  request: AgentRunRequest,
  input: JsonObject,
  key = 'path',
): Promise<{ root: string; absolute: string; relative: string }> {
  const root = await projectRoot(options, request);
  const relative = relativeInput(input, key);
  const unresolved = path.resolve(root, relative);
  assertInside(root, unresolved);
  await assertNoSymlinks(root, unresolved, true);
  const absolute = await fs.realpath(unresolved).catch(() => {
    throw new ToolDeniedError('workspace_path_not_found');
  });
  assertInside(root, absolute);
  return { root, absolute, relative: path.relative(root, absolute) || '.' };
}

async function writablePath(
  options: LocalToolOptions,
  request: AgentRunRequest,
  input: JsonObject,
): Promise<{ root: string; absolute: string; parent: string; relative: string }> {
  const root = await projectRoot(options, request);
  const relative = relativeInput(input);
  const absolute = path.resolve(root, relative);
  assertInside(root, absolute);
  await assertNoSymlinks(root, absolute, false);
  const parent = await fs.realpath(path.dirname(absolute)).catch(() => {
    throw new ToolDeniedError('workspace_parent_not_found');
  });
  assertInside(root, parent);
  try {
    const existing = await fs.realpath(absolute);
    assertInside(root, existing);
    const stat = await fs.lstat(absolute);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new ToolDeniedError('workspace_write_requires_regular_file');
    }
  } catch (error) {
    if (error instanceof ToolDeniedError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') throw error;
  }
  return { root, absolute, parent, relative };
}

async function assertNoSymlinks(
  root: string,
  candidate: string,
  includeLast: boolean,
): Promise<void> {
  const relative = path.relative(root, candidate);
  assertInside(root, candidate);
  const segments = relative.split(path.sep).filter(Boolean);
  const count = includeLast ? segments.length : Math.max(0, segments.length - 1);
  let current = root;
  for (const segment of segments.slice(0, count)) {
    current = path.join(current, segment);
    const stat = await fs.lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') throw new ToolDeniedError('workspace_path_not_found');
      throw error;
    });
    if (stat.isSymbolicLink()) throw new ToolDeniedError('workspace_symlink_not_allowed');
  }
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function outputLimit(options: LocalToolOptions): number {
  return Math.max(4_096, Math.min(options.maxResultBytes ?? 128 * 1_024, 512 * 1_024));
}

function truncateUtf8(value: string, maxBytes: number): { text: string; truncated: boolean } {
  const buffer = Buffer.from(value);
  if (buffer.byteLength <= maxBytes) return { text: value, truncated: false };
  return {
    text: buffer.subarray(0, maxBytes).toString('utf8'),
    truncated: true,
  };
}

async function listEntries(
  root: string,
  start: string,
  depth: number,
  limit: number,
): Promise<{ entries: Array<{ path: string; type: 'file' | 'directory' | 'other'; size?: number }>; truncated: boolean }> {
  const entries: Array<{ path: string; type: 'file' | 'directory' | 'other'; size?: number }> = [];
  const visit = async (directory: string, level: number): Promise<void> => {
    const children = await fs.readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      if (entries.length >= limit) return;
      if (SKIPPED_DIRECTORIES.has(child.name)) continue;
      const absolute = path.join(directory, child.name);
      const relative = path.relative(root, absolute).replaceAll(path.sep, '/');
      if (child.isSymbolicLink()) {
        entries.push({ path: relative, type: 'other' });
        continue;
      }
      if (child.isDirectory()) {
        entries.push({ path: relative, type: 'directory' });
        if (level < depth) await visit(absolute, level + 1);
        continue;
      }
      if (child.isFile()) {
        const stat = await fs.stat(absolute);
        entries.push({ path: relative, type: 'file', size: stat.size });
      } else {
        entries.push({ path: relative, type: 'other' });
      }
    }
  };
  await visit(start, 1);
  return { entries, truncated: entries.length === limit };
}

async function searchFiles(
  root: string,
  start: string,
  query: string,
  maxFiles: number,
  maxMatches: number,
): Promise<{ matches: Array<{ path: string; line: number; text: string }>; scannedFiles: number; truncated: boolean }> {
  const normalizedQuery = query.toLocaleLowerCase();
  const matches: Array<{ path: string; line: number; text: string }> = [];
  let scannedFiles = 0;
  let truncated = false;
  const visit = async (directory: string): Promise<void> => {
    const children = await fs.readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      if (truncated) return;
      if (SKIPPED_DIRECTORIES.has(child.name) || child.isSymbolicLink()) continue;
      const absolute = path.join(directory, child.name);
      if (child.isDirectory()) {
        await visit(absolute);
        continue;
      }
      if (!child.isFile()) continue;
      if (scannedFiles >= maxFiles) {
        truncated = true;
        return;
      }
      scannedFiles += 1;
      const stat = await fs.stat(absolute);
      if (stat.size > 1_000_000) continue;
      const buffer = await fs.readFile(absolute);
      if (buffer.includes(0)) continue;
      const lines = buffer.toString('utf8').split(/\r?\n/u);
      for (let index = 0; index < lines.length; index += 1) {
        if (!lines[index].toLocaleLowerCase().includes(normalizedQuery)) continue;
        matches.push({
          path: path.relative(root, absolute).replaceAll(path.sep, '/'),
          line: index + 1,
          text: lines[index].slice(0, 500),
        });
        if (matches.length >= maxMatches) {
          truncated = true;
          return;
        }
      }
    }
  };
  await visit(start);
  return { matches, scannedFiles, truncated };
}

function allowedCommands(grant: ToolGrant): string[] {
  const configured = grant.constraints?.commands;
  const values = Array.isArray(configured)
    ? configured.filter((value): value is string => typeof value === 'string')
    : [];
  return values
    .map((value) => value.trim())
    .filter((value) => Boolean(value) && value !== '*');
}

function commandAllowed(grant: ToolGrant, command: string): boolean {
  if (!command || command.includes('/') || command.includes('\\')) return false;
  return allowedCommands(grant).includes(command);
}

function workspaceCommandGrant(
  request: AgentRunRequest,
  command: string,
): ToolGrant {
  const grant = request.access.grants.find(
    (candidate) =>
      candidate.kind === 'shell' &&
      permissionAllows(candidate, 'write') &&
      commandAllowed(candidate, command),
  );
  if (!grant) throw new ToolDeniedError('workspace_command_not_allowed');
  return grant;
}

function networkHostAllowed(request: AgentRunRequest, hostname: string): boolean {
  const host = hostname.toLocaleLowerCase().replace(/\.$/u, '');
  if (
    !host ||
    isIP(host) !== 0 ||
    SENSITIVE_HOSTNAMES.has(host) ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal')
  ) {
    return false;
  }
  if (request.access.networkPolicy.mode === 'allow-all') return true;
  if (request.access.networkPolicy.mode !== 'restricted') return false;
  return request.access.networkPolicy.allowedHosts.some((allowed) => {
    const pattern = allowed.trim().toLocaleLowerCase().replace(/\.$/u, '');
    return pattern === host || (pattern.startsWith('*.') && host.endsWith(pattern.slice(1)));
  });
}

function privateIp(value: string): boolean {
  const normalized = value.toLocaleLowerCase();
  if (normalized.includes(':')) {
    return (
      normalized === '::' ||
      normalized === '::1' ||
      normalized.startsWith('fc') ||
      normalized.startsWith('fd') ||
      /^(?:fe[89ab])/u.test(normalized) ||
      normalized.startsWith('::ffff:127.') ||
      normalized.startsWith('::ffff:10.') ||
      normalized.startsWith('::ffff:192.168.')
    );
  }
  const octets = normalized.split('.').map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part))) return true;
  const [first, second] = octets;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 100 && second >= 64 && second <= 127) ||
    first >= 224
  );
}

async function resolvePublicHost(
  options: LocalToolOptions,
  hostname: string,
): Promise<void> {
  const addresses = options.browser?.resolve
    ? await options.browser.resolve(hostname)
    : (await lookup(hostname, { all: true, verbatim: true })).map(
        (entry) => entry.address,
      );
  if (!addresses.length || addresses.some(privateIp)) {
    throw new ToolDeniedError('browser_host_resolves_private');
  }
}

function browserGrant(request: AgentRunRequest, input: JsonObject): ToolGrant {
  const grant = localGrant(request, 'browser', 'read');
  let url: URL;
  try {
    url = new URL(stringValue(input, 'url'));
  } catch {
    throw new ToolDeniedError('browser_url_invalid');
  }
  if (url.protocol !== 'https:' || url.username || url.password || !networkHostAllowed(request, url.hostname)) {
    throw new ToolDeniedError('browser_host_not_allowed');
  }
  return grant;
}

export function createLocalToolDefinitions(
  options: LocalToolOptions,
): LocalToolDefinition[] {
  const shellAuthorize = (permission: 'read' | 'write') =>
    (request: AgentRunRequest): ToolGrant => localGrant(request, 'shell', permission);
  return [
    {
      name: 'workspace_list',
      title: 'List workspace files',
      description: 'List bounded files and directories below the current project root. Symlinks are never followed.',
      grantKind: 'shell',
      risk: 'read',
      provider: 'opentag:workspace',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', maxLength: 1_000 },
          depth: { type: 'integer', minimum: 1, maximum: 5 },
          limit: { type: 'integer', minimum: 1, maximum: 500 },
        },
      },
      available: () => true,
      authorize: shellAuthorize('read'),
      summarize: (input) => ({ path: stringValue(input, 'path') || '.', depth: integerValue(input, 'depth', 2, 1, 5), limit: integerValue(input, 'limit', 200, 1, 500) }),
      async execute({ request }, input) {
        const resolved = await existingPath(options, request, input);
        const stat = await fs.stat(resolved.absolute);
        if (!stat.isDirectory()) throw new ToolDeniedError('workspace_list_requires_directory');
        return {
          root: '.',
          path: resolved.relative,
          ...(await listEntries(
            resolved.root,
            resolved.absolute,
            integerValue(input, 'depth', 2, 1, 5),
            integerValue(input, 'limit', 200, 1, 500),
          )),
        };
      },
    },
    {
      name: 'workspace_read',
      title: 'Read workspace file',
      description: 'Read a bounded UTF-8 text file below the current project root with line numbers and a content digest.',
      grantKind: 'shell',
      risk: 'read',
      provider: 'opentag:workspace',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', minLength: 1, maxLength: 1_000 },
          startLine: { type: 'integer', minimum: 1, maximum: 1_000_000 },
          endLine: { type: 'integer', minimum: 1, maximum: 1_000_000 },
        },
        required: ['path'],
      },
      available: () => true,
      authorize: shellAuthorize('read'),
      summarize: (input) => ({ path: stringValue(input, 'path'), startLine: integerValue(input, 'startLine', 1, 1, 1_000_000), endLine: integerValue(input, 'endLine', 400, 1, 1_000_000) }),
      async execute({ request }, input) {
        const resolved = await existingPath(options, request, input);
        const stat = await fs.stat(resolved.absolute);
        if (!stat.isFile() || stat.size > 2_000_000) throw new ToolDeniedError('workspace_read_file_too_large');
        const buffer = await fs.readFile(resolved.absolute);
        if (buffer.includes(0)) throw new ToolDeniedError('workspace_read_binary_file');
        const value = buffer.toString('utf8');
        const lines = value.split(/\r?\n/u);
        const startLine = integerValue(input, 'startLine', 1, 1, lines.length || 1);
        const endLine = Math.max(startLine, Math.min(integerValue(input, 'endLine', startLine + 399, 1, 1_000_000), lines.length));
        const selected = lines
          .slice(startLine - 1, endLine)
          .map((line, index) => `${startLine + index}: ${line}`)
          .join('\n');
        const bounded = truncateUtf8(selected, outputLimit(options));
        return { path: resolved.relative, sha256: sha256(buffer), startLine, endLine, totalLines: lines.length, content: bounded.text, truncated: bounded.truncated };
      },
    },
    {
      name: 'workspace_search',
      title: 'Search workspace text',
      description: 'Search bounded UTF-8 project files for a literal case-insensitive query. Binary, large, hidden dependency, and symlink content is skipped.',
      grantKind: 'shell',
      risk: 'read',
      provider: 'opentag:workspace',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string', minLength: 1, maxLength: 500 },
          path: { type: 'string', maxLength: 1_000 },
          maxFiles: { type: 'integer', minimum: 1, maximum: 2_000 },
          maxMatches: { type: 'integer', minimum: 1, maximum: 200 },
        },
        required: ['query'],
      },
      available: () => true,
      authorize: shellAuthorize('read'),
      summarize: (input) => ({ query: stringValue(input, 'query'), path: stringValue(input, 'path') || '.', maxMatches: integerValue(input, 'maxMatches', 100, 1, 200) }),
      async execute({ request }, input) {
        const resolved = await existingPath(options, request, input);
        const stat = await fs.stat(resolved.absolute);
        if (!stat.isDirectory()) throw new ToolDeniedError('workspace_search_requires_directory');
        return searchFiles(
          resolved.root,
          resolved.absolute,
          stringValue(input, 'query'),
          integerValue(input, 'maxFiles', 500, 1, 2_000),
          integerValue(input, 'maxMatches', 100, 1, 200),
        );
      },
    },
    {
      name: 'workspace_write',
      title: 'Write workspace file',
      description: 'Atomically create or replace one UTF-8 project file. Supply expectedSha256 to guard edits to an existing file, or null only when creating a new file.',
      grantKind: 'shell',
      risk: 'write',
      provider: 'opentag:workspace',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', minLength: 1, maxLength: 1_000 },
          content: { type: 'string', maxLength: 500_000 },
          expectedSha256: {
            anyOf: [
              { type: 'string', pattern: '^[a-f0-9]{64}$' },
              { type: 'null' },
            ],
          },
        },
        required: ['path', 'content', 'expectedSha256'],
      },
      available: () => true,
      authorize: shellAuthorize('write'),
      summarize: (input) => ({ path: stringValue(input, 'path'), contentBytes: Buffer.byteLength(typeof input.content === 'string' ? input.content : ''), expectedSha256: input.expectedSha256 }),
      async execute({ request }, input) {
        const resolved = await writablePath(options, request, input);
        const content = typeof input.content === 'string' ? input.content : '';
        let current: Buffer | undefined;
        let fileMode = 0o600;
        try {
          current = await fs.readFile(resolved.absolute);
          fileMode = (await fs.stat(resolved.absolute)).mode & 0o777;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        const expected = input.expectedSha256;
        if ((current && expected !== sha256(current)) || (!current && expected !== null)) {
          throw new ToolDeniedError('workspace_write_precondition_failed');
        }
        const temporary = path.join(
          resolved.parent,
          `.${path.basename(resolved.absolute)}.opentag-${process.pid}-${Date.now()}`,
        );
        try {
          await fs.writeFile(temporary, content, {
            encoding: 'utf8',
            flag: 'wx',
            mode: fileMode,
          });
          await fs.rename(temporary, resolved.absolute);
        } finally {
          await fs.rm(temporary, { force: true }).catch(() => undefined);
        }
        return { path: resolved.relative, bytes: Buffer.byteLength(content), sha256: sha256(content), created: !current };
      },
    },
    {
      name: 'workspace_run',
      title: 'Run workspace command',
      description: 'Execute one allowlisted program directly in the project root without shell parsing. The resolved project tool-approval policy decides whether a confirmation is required.',
      grantKind: 'shell',
      risk: 'write',
      provider: 'opentag:workspace',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          command: { type: 'string', minLength: 1, maxLength: 100, pattern: '^[a-zA-Z0-9_.+-]+$' },
          args: { type: 'array', maxItems: 100, items: { type: 'string', maxLength: 2_000 } },
          timeoutMs: { type: 'integer', minimum: 100, maximum: 600_000 },
        },
        required: ['command'],
      },
      available: () => true,
      granted: (request) =>
        request.access.grants.some(
          (grant) =>
            grant.kind === 'shell' &&
            permissionAllows(grant, 'write') &&
            allowedCommands(grant).length > 0,
        ),
      authorize(request, input) {
        return workspaceCommandGrant(request, stringValue(input, 'command'));
      },
      summarize: (input) => ({ command: stringValue(input, 'command'), args: stringArray(input, 'args'), timeoutMs: integerValue(input, 'timeoutMs', 120_000, 100, 600_000) }),
      async execute({ request, signal }, input) {
        const cwd = await projectRoot(options, request);
        const result = await runCliCommand({
          command: stringValue(input, 'command'),
          args: stringArray(input, 'args'),
          cwd,
          input: '',
          env: { PATH: process.env.PATH || '', HOME: process.env.HOME || '', LANG: process.env.LANG || 'C.UTF-8' },
          abortSignal: signal,
          timeoutMs: integerValue(input, 'timeoutMs', 120_000, 100, 600_000),
          maxOutputBytes: outputLimit(options),
        });
        const output = `${result.stdout}${result.stderr}`.replace(/\s+/gu, ' ').trim();
        return { command: result.command, args: result.args, exitCode: result.exitCode, durationMs: result.durationMs, outputSha256: sha256(`${result.stdout}\n${result.stderr}`), outputPreview: output.slice(0, 300), stdoutTruncated: result.stdoutTruncated, stderrTruncated: result.stderrTruncated };
      },
    },
    {
      name: 'browser_fetch',
      title: 'Fetch web resource',
      description: 'Fetch a bounded public HTTPS resource through the route host policy. Redirects are checked one hop at a time; credentials are never sent.',
      grantKind: 'browser',
      risk: 'read',
      provider: 'opentag:browser',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          url: { type: 'string', minLength: 1, maxLength: 4_000 },
          maxBytes: { type: 'integer', minimum: 1_024, maximum: 262_144 },
        },
        required: ['url'],
      },
      available: () => true,
      granted: (request) => request.access.grants.some((grant) => grant.kind === 'browser') && request.access.networkPolicy.mode !== 'deny-by-default',
      authorize: browserGrant,
      summarize(input) {
        let host = '';
        try { host = new URL(stringValue(input, 'url')).hostname; } catch { /* validated later */ }
        return { host, maxBytes: integerValue(input, 'maxBytes', 64 * 1_024, 1_024, 262_144) };
      },
      destination(input, result) {
        const finalUrl = result && typeof result === 'object' && !Array.isArray(result)
          ? stringValue(result as JsonObject, 'url')
          : '';
        return httpsOrigin(finalUrl || stringValue(input, 'url'));
      },
      async execute({ request, signal }, input) {
        const requestFetch = options.browser?.fetch || fetch;
        let current = new URL(stringValue(input, 'url'));
        const maxBytes = integerValue(input, 'maxBytes', 64 * 1_024, 1_024, 262_144);
        for (let redirects = 0; redirects <= 5; redirects += 1) {
          if (!networkHostAllowed(request, current.hostname) || current.protocol !== 'https:') {
            throw new ToolDeniedError('browser_host_not_allowed');
          }
          await resolvePublicHost(options, current.hostname);
          const response = await requestFetch(current, {
            method: 'GET',
            redirect: 'manual',
            headers: { accept: 'text/plain,text/html,application/json;q=0.9,*/*;q=0.1', 'user-agent': 'opentag-tool-broker/0.1' },
            signal,
          });
          if (response.status >= 300 && response.status < 400) {
            const location = response.headers.get('location');
            if (!location) throw new Error(`browser_http_${response.status}:redirect_without_location`);
            current = new URL(location, current);
            continue;
          }
          if (!response.ok) throw new Error(`browser_http_${response.status}`);
          const declared = Number(response.headers.get('content-length') || 0);
          if (declared > maxBytes) throw new ToolDeniedError('browser_response_too_large');
          if (!response.body) {
            return { url: current.toString(), status: response.status, contentType: response.headers.get('content-type') || '', content: '', truncated: false };
          }
          const reader = response.body.getReader();
          const chunks: Buffer[] = [];
          let received = 0;
          let truncated = false;
          while (true) {
            const value = await reader.read();
            if (value.done) break;
            const chunk = Buffer.from(value.value);
            const remaining = maxBytes - received;
            if (remaining <= 0) {
              truncated = true;
              await reader.cancel();
              break;
            }
            chunks.push(chunk.subarray(0, remaining));
            received += Math.min(chunk.byteLength, remaining);
            if (chunk.byteLength > remaining || received === maxBytes) {
              truncated = true;
              await reader.cancel();
              break;
            }
          }
          return { url: current.toString(), status: response.status, contentType: response.headers.get('content-type') || '', content: Buffer.concat(chunks).toString('utf8'), truncated };
        }
        throw new ToolDeniedError('browser_redirect_limit_exceeded');
      },
    },
  ];
}
