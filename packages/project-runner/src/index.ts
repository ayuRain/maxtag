import { timingSafeEqual, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import path from 'node:path';
import { runCliCommand, type CliCommandResult } from '@opentag/executor-cli';

export interface ProjectRunnerExecuteInput {
  projectKey: string;
  command: string;
  args: string[];
  timeoutMs: number;
  maxOutputBytes: number;
  signal?: AbortSignal;
}

export interface ProjectRunnerExecuteResult extends CliCommandResult {
  requestId: string;
}

export interface ProjectRunner {
  execute(input: ProjectRunnerExecuteInput): Promise<ProjectRunnerExecuteResult>;
}

export interface HttpProjectRunnerOptions {
  baseUrl: string;
  token: string;
  fetch?: typeof fetch;
  /**
   * Optional per-project runtime endpoints. This keeps build-enabled or
   * data runtimes isolated from the default sandbox while preserving one
   * general command interface for the agent.
   */
  routes?: Record<string, string>;
}

export interface ProjectRunnerServerOptions {
  workspaceRoot: string;
  token: string;
  /**
   * Optional defence-in-depth executable filter. `*` means any basename that
   * is installed in the runner image. The runner Pod, filesystem mount,
   * workload identity and network policy are the security boundary; this list
   * must not turn the project agent into a fixed workflow executor.
   */
  allowedCommands?: string[];
  host?: string;
  port?: number;
  maxRequestBytes?: number;
  maxTimeoutMs?: number;
  maxOutputBytes?: number;
  path?: string;
  homeRoot?: string;
  environment?: (
    input: { projectKey: string; home: string; command: string },
  ) => Promise<Record<string, string | undefined>>;
  prepare?: (
    input: {
      projectKey: string;
      home: string;
      command: string;
      env: Record<string, string>;
      signal: AbortSignal;
    },
  ) => Promise<void>;
}

interface WireExecuteRequest {
  projectKey: string;
  command: string;
  args: string[];
  timeoutMs: number;
  maxOutputBytes: number;
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.floor(value)));
}

function validProjectKey(value: unknown): value is string {
  return typeof value === 'string' && /^(?!\.{1,2}$)[a-zA-Z0-9_.-]{1,128}$/u.test(value);
}

function validCommand(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9_.+-]{1,100}$/u.test(value);
}

export function parseProjectRunnerRoutesJson(
  value: string | undefined,
): Record<string, string> {
  if (!value?.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('OPENTAG_PROJECT_RUNNER_ROUTES_JSON must be valid JSON.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('OPENTAG_PROJECT_RUNNER_ROUTES_JSON must be an object.');
  }
  const routes: Record<string, string> = {};
  for (const [projectKey, rawUrl] of Object.entries(parsed)) {
    if (!validProjectKey(projectKey) || typeof rawUrl !== 'string') {
      throw new Error('project_runner_route_invalid');
    }
    const url = new URL(rawUrl);
    if (
      url.protocol !== 'http:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/'
    ) {
      throw new Error('project_runner_route_invalid');
    }
    routes[projectKey] = rawUrl.replace(/\/+$/u, '');
  }
  return routes;
}

function wireRequest(value: unknown): WireExecuteRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('project_runner_request_invalid');
  }
  const input = value as Record<string, unknown>;
  if (!validProjectKey(input.projectKey)) throw new Error('project_runner_project_key_invalid');
  if (!validCommand(input.command)) throw new Error('project_runner_command_invalid');
  if (!Array.isArray(input.args) || input.args.length > 100 || input.args.some((item) => typeof item !== 'string' || item.length > 2_000)) {
    throw new Error('project_runner_args_invalid');
  }
  return {
    projectKey: input.projectKey,
    command: input.command,
    args: input.args as string[],
    timeoutMs: boundedInteger(input.timeoutMs, 120_000, 100, 600_000),
    maxOutputBytes: boundedInteger(input.maxOutputBytes, 64 * 1_024, 2_048, 512 * 1_024),
  };
}

async function jsonBody(request: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const raw of request) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    bytes += chunk.byteLength;
    if (bytes > maxBytes) throw new Error('project_runner_request_too_large');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('project_runner_json_invalid');
  }
}

async function projectDirectory(root: string, projectKey: string): Promise<string> {
  const realRoot = await fs.realpath(root);
  const candidate = path.resolve(realRoot, projectKey);
  const relative = path.relative(realRoot, candidate);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('project_runner_workspace_outside_root');
  }
  await fs.mkdir(candidate, { recursive: true, mode: 0o700 });
  const realCandidate = await fs.realpath(candidate);
  const realRelative = path.relative(realRoot, realCandidate);
  if (realRelative === '..' || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) {
    throw new Error('project_runner_workspace_outside_root');
  }
  return realCandidate;
}

export function createHttpProjectRunner(options: HttpProjectRunnerOptions): ProjectRunner {
  const baseUrl = options.baseUrl.replace(/\/+$/u, '');
  if (!baseUrl || !options.token) throw new Error('project_runner_http_not_configured');
  const routes = Object.fromEntries(
    Object.entries(options.routes ?? {}).map(([projectKey, url]) => [
      projectKey,
      url.replace(/\/+$/u, ''),
    ]),
  );
  return {
    async execute(input) {
      const routedBaseUrl = routes[input.projectKey] || baseUrl;
      const response = await (options.fetch ?? fetch)(`${routedBaseUrl}/v1/execute`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${options.token}`,
          'content-type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify({
          projectKey: input.projectKey,
          command: input.command,
          args: input.args,
          timeoutMs: input.timeoutMs,
          maxOutputBytes: input.maxOutputBytes,
        }),
        signal: input.signal,
      });
      const body = await response.text();
      let parsed: unknown;
      try { parsed = body ? JSON.parse(body) : {}; } catch { parsed = {}; }
      if (!response.ok) {
        const error = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? String((parsed as Record<string, unknown>).error || '')
          : '';
        throw new Error(error || `project_runner_http_${response.status}`);
      }
      return parsed as ProjectRunnerExecuteResult;
    },
  };
}

export function startProjectRunnerServer(options: ProjectRunnerServerOptions): Server {
  if (!options.token) throw new Error('OPENTAG_PROJECT_RUNNER_TOKEN is required.');
  const configuredCommands = options.allowedCommands ?? ['*'];
  const allowAnyCommand = configuredCommands.includes('*');
  const commands = new Set(configuredCommands.filter(validCommand));
  if (!allowAnyCommand && !commands.size) {
    throw new Error('OPENTAG_PROJECT_RUNNER_COMMANDS contains no valid commands.');
  }
  const endpoint = options.path || '/v1/execute';
  const server = createServer(async (request, response) => {
    const respond = (status: number, value: unknown): void => {
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      response.end(JSON.stringify(value));
    };
    if (request.method === 'GET' && request.url === '/health') {
      respond(200, { ok: true, service: 'opentag-project-runner' });
      return;
    }
    if (request.method !== 'POST' || request.url !== endpoint) {
      respond(404, { error: 'project_runner_not_found' });
      return;
    }
    const authorization = request.headers.authorization || '';
    if (!authorization.startsWith('Bearer ') || !safeEqual(authorization.slice(7), options.token)) {
      respond(401, { error: 'project_runner_unauthorized' });
      return;
    }
    const abort = new AbortController();
    request.once('aborted', () => abort.abort());
    const requestId = randomUUID();
    let input: WireExecuteRequest | undefined;
    try {
      input = wireRequest(await jsonBody(request, options.maxRequestBytes ?? 256 * 1_024));
      if (!allowAnyCommand && !commands.has(input.command)) {
        throw new Error('project_runner_command_not_allowed');
      }
      const cwd = await projectDirectory(options.workspaceRoot, input.projectKey);
      const home = path.resolve(options.homeRoot || '/tmp/opentag-project-runner', input.projectKey);
      await fs.mkdir(home, { recursive: true, mode: 0o700 });
      const dynamicEnvironment = await options.environment?.({
        projectKey: input.projectKey,
        home,
        command: input.command,
      }) ?? {};
      const env: Record<string, string> = {
        PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
        HOME: home,
        TMPDIR: '/tmp',
        LANG: process.env.LANG || 'C.UTF-8',
        CI: '1',
        NO_COLOR: '1',
      };
      for (const [name, value] of Object.entries(dynamicEnvironment)) {
        if (value !== undefined) env[name] = value;
      }
      await options.prepare?.({
        projectKey: input.projectKey,
        home,
        command: input.command,
        env,
        signal: abort.signal,
      });
      const result = await runCliCommand({
        command: input.command,
        args: input.args,
        cwd,
        input: '',
        env,
        abortSignal: abort.signal,
        timeoutMs: Math.min(input.timeoutMs, options.maxTimeoutMs ?? 600_000),
        maxOutputBytes: Math.min(input.maxOutputBytes, options.maxOutputBytes ?? 512 * 1_024),
        rejectOnNonZero: false,
      });
      process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), service: 'opentag-project-runner', event: 'command_completed', requestId, projectKey: input.projectKey, command: input.command, exitCode: result.exitCode, signal: result.signal, durationMs: result.durationMs })}\n`);
      respond(200, { requestId, ...result, cwd: '.' });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'project_runner_failed';
      process.stderr.write(`${JSON.stringify({ at: new Date().toISOString(), service: 'opentag-project-runner', event: 'command_failed', requestId, projectKey: input?.projectKey, command: input?.command, error: message })}\n`);
      if (!response.headersSent) respond(message === 'project_runner_command_not_allowed' ? 403 : 400, { requestId, error: message });
    }
  });
  server.listen(options.port ?? 3081, options.host ?? '0.0.0.0');
  return server;
}
