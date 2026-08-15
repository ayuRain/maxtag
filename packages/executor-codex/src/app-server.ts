import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createInterface, type Interface as ReadlineInterface } from 'node:readline';
import type { CliToolSession } from '@opentag/executor-cli';

type JsonRecord = Record<string, unknown>;

interface JsonRpcMessage {
  id?: string | number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
    data?: unknown;
  };
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer?: NodeJS.Timeout;
}

interface AppNotification {
  method: string;
  params?: unknown;
}

export interface CodexAppServerUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  modelContextWindow?: number;
}

export type CodexAppServerEvent =
  | { type: 'item.started' | 'item.completed'; item: JsonRecord }
  | {
      type: 'compact.completed';
      threadId: string;
      turnId?: string;
      source: 'item' | 'thread';
    }
  | { type: 'text.delta'; text: string }
  | { type: 'usage'; usage: CodexAppServerUsage }
  | {
      type: 'error';
      message: string;
      willRetry: boolean;
      errorInfo?: unknown;
    }
  | {
      type: 'turn.completed';
      status: string;
      error?: string;
    };

export interface CodexAppServerCompactResult {
  threadId: string;
  turnId?: string;
  source: 'item' | 'thread' | 'turn';
}

export interface CodexAppServerOptions {
  command: string;
  commandPrefixArgs?: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  model?: string;
  resumeThreadId?: string;
  ephemeral: boolean;
  toolSession?: CliToolSession;
  requestTimeoutMs?: number;
  onStderrLine?(line: string): void | Promise<void>;
  onUnstructuredLine?(line: string): void | Promise<void>;
}

export interface PrepareCodexHomeOptions {
  target: string;
  source?: string;
  env?: NodeJS.ProcessEnv;
}

const MANAGED_CONFIG = [
  '# Managed by MaxTag.',
  '# Provider tools and instructions are configured per run.',
  '',
].join('\n');

function object(value: unknown): JsonRecord | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' && value.length ? value : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function errorMessage(value: unknown, fallback: string): string {
  if (typeof value === 'string' && value.trim()) return value.trim();
  const candidate = object(value);
  return string(candidate?.message) || fallback;
}

async function writeManagedConfig(target: string): Promise<void> {
  const configPath = path.join(target, 'config.toml');
  try {
    const stat = await fs.lstat(configPath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error('codex_home_config_must_be_regular_file');
    }
    const current = await fs.readFile(configPath, 'utf8');
    if (current !== MANAGED_CONFIG) {
      throw new Error('codex_home_config_not_managed_by_opentag');
    }
    await fs.chmod(configPath, 0o600);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  try {
    await fs.writeFile(configPath, MANAGED_CONFIG, {
      flag: 'wx',
      mode: 0o600,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const stat = await fs.lstat(configPath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error('codex_home_config_must_be_regular_file');
    }
    const current = await fs.readFile(configPath, 'utf8');
    if (current !== MANAGED_CONFIG) {
      throw new Error('codex_home_config_not_managed_by_opentag');
    }
    await fs.chmod(configPath, 0o600);
  }
}

async function seedAuth(source: string, target: string): Promise<void> {
  const sourcePath = path.join(source, 'auth.json');
  const targetPath = path.join(target, 'auth.json');
  const samePath = path.resolve(sourcePath) === path.resolve(targetPath);
  try {
    const targetStat = await fs.lstat(targetPath);
    if (!targetStat.isFile() || targetStat.isSymbolicLink()) {
      throw new Error('codex_auth_target_must_be_regular_file');
    }
    await fs.chmod(targetPath, 0o600);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    // Seed once. Codex owns subsequent token refreshes in the isolated home.
  }
  if (samePath) return;

  let sourceStat;
  try {
    sourceStat = await fs.lstat(sourcePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
    throw new Error('codex_auth_source_must_be_regular_file');
  }
  if (sourceStat.size > 10 * 1024 * 1024) {
    throw new Error('codex_auth_source_too_large');
  }
  const content = await fs.readFile(sourcePath);
  try {
    await fs.writeFile(targetPath, content, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const targetStat = await fs.lstat(targetPath);
    if (!targetStat.isFile() || targetStat.isSymbolicLink()) {
      throw new Error('codex_auth_target_must_be_regular_file');
    }
    await fs.chmod(targetPath, 0o600);
  }
}

export async function prepareCodexAppServerHome(
  options: PrepareCodexHomeOptions,
): Promise<string> {
  const target = path.resolve(options.target);
  await fs.mkdir(target, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(target);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('codex_home_must_be_regular_directory');
  }
  await fs.chmod(target, 0o700);
  await writeManagedConfig(target);

  const env = options.env ?? process.env;
  const source =
    options.source ||
    env.CODEX_HOME ||
    (env.HOME ? path.join(env.HOME, '.codex') : undefined);
  if (source) await seedAuth(path.resolve(source), target);
  return target;
}

export class CodexAppServerRpcError extends Error {
  readonly code?: number;
  readonly data?: unknown;

  constructor(message: string, code?: number, data?: unknown) {
    super(message);
    this.name = 'CodexAppServerRpcError';
    this.code = code;
    this.data = data;
  }
}

export class CodexAppServerUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CodexAppServerUnavailableError';
  }
}

class AsyncQueue<T> {
  private values: T[] = [];
  private waiters: Array<{
    resolve(value: T | undefined): void;
    reject(error: Error): void;
  }> = [];
  private closed = false;
  private closeError?: Error;

  push(value: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve(value);
    else this.values.push(value);
  }

  close(error?: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.closeError = error;
    for (const waiter of this.waiters.splice(0)) {
      if (error) waiter.reject(error);
      else waiter.resolve(undefined);
    }
  }

  async next(signal?: AbortSignal): Promise<T | undefined> {
    const value = this.values.shift();
    if (value) return value;
    if (this.closed) {
      if (this.closeError) throw this.closeError;
      return undefined;
    }
    if (signal?.aborted) throw abortError(signal);
    return new Promise<T | undefined>((resolve, reject) => {
      const waiter = { resolve, reject };
      const abort = (): void => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(abortError(signal));
      };
      this.waiters.push(waiter);
      signal?.addEventListener('abort', abort, { once: true });
      const originalResolve = waiter.resolve;
      const originalReject = waiter.reject;
      waiter.resolve = (next) => {
        signal?.removeEventListener('abort', abort);
        originalResolve(next);
      };
      waiter.reject = (error) => {
        signal?.removeEventListener('abort', abort);
        originalReject(error);
      };
    });
  }
}

function abortError(signal?: AbortSignal): Error {
  const reason = signal?.reason;
  return reason instanceof Error
    ? reason
    : new Error(typeof reason === 'string' ? reason : 'executor_aborted');
}

function signalProcessGroup(
  child: ChildProcessWithoutNullStreams,
  signal: NodeJS.Signals,
): void {
  if (!child.pid) return;
  if (process.platform !== 'win32') {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // The child may already have exited or not be a group leader yet.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // The child already exited.
  }
}

function mcpServers(toolSession?: CliToolSession): JsonRecord {
  if (!toolSession) return {};
  return {
    [toolSession.mcp.name]: {
      command: toolSession.mcp.command,
      args: toolSession.mcp.args,
      env: toolSession.mcp.env,
      default_tools_approval_mode: 'approve',
    },
  };
}

function threadIdFromResponse(value: unknown): string | undefined {
  return string(object(object(value)?.thread)?.id);
}

function turnIdFromResponse(value: unknown): string | undefined {
  return string(object(object(value)?.turn)?.id);
}

function normalizeStatus(value: unknown): string {
  if (value === 'completed') return 'completed';
  if (value === 'failed' || value === 'declined') return 'failed';
  return 'in_progress';
}

function normalizeItem(value: unknown): JsonRecord | undefined {
  const item = object(value);
  if (!item) return undefined;
  const id = string(item.id) || 'unknown';
  switch (item.type) {
    case 'agentMessage':
      return { id, type: 'agent_message', text: string(item.text) || '' };
    case 'reasoning':
      return {
        id,
        type: 'reasoning',
        text: [
          ...(Array.isArray(item.summary) ? item.summary : []),
          ...(Array.isArray(item.content) ? item.content : []),
        ]
          .filter((part): part is string => typeof part === 'string')
          .join('\n'),
      };
    case 'commandExecution':
      return {
        id,
        type: 'command_execution',
        command: string(item.command) || '',
        aggregated_output: string(item.aggregatedOutput) || '',
        exit_code: number(item.exitCode),
        status: normalizeStatus(item.status),
      };
    case 'fileChange':
      return {
        id,
        type: 'file_change',
        changes: item.changes,
        status: normalizeStatus(item.status),
      };
    case 'mcpToolCall':
    case 'dynamicToolCall':
      return {
        id,
        type: 'mcp_tool_call',
        server:
          item.type === 'dynamicToolCall' ? 'dynamic' : string(item.server) || '',
        tool: string(item.tool) || '',
        arguments: item.arguments,
        result: item.result,
        error: item.error,
        status: normalizeStatus(item.status),
      };
    case 'webSearch':
      return {
        id,
        type: 'web_search',
        query: string(item.query) || '',
      };
    case 'plan':
      return { id, type: 'reasoning', text: string(item.text) || '' };
    case 'contextCompaction':
      return { id, type: 'context_compaction' };
    default:
      return undefined;
  }
}

function usageFromNotification(value: unknown): CodexAppServerUsage {
  const usage = object(value);
  const last = object(usage?.last) || usage;
  return {
    inputTokens: number(last?.inputTokens),
    outputTokens: number(last?.outputTokens),
    totalTokens: number(last?.totalTokens),
    modelContextWindow: number(usage?.modelContextWindow),
  };
}

export class CodexAppServerSession {
  private child?: ChildProcessWithoutNullStreams;
  private stdout?: ReadlineInterface;
  private stderr?: ReadlineInterface;
  private nextRequestId = 1;
  private pending = new Map<string | number, PendingRequest>();
  private notifications = new AsyncQueue<AppNotification>();
  private threadId?: string;
  private activeTurnId?: string;
  private closing = false;

  constructor(private readonly options: CodexAppServerOptions) {}

  async startOrResume(): Promise<string> {
    await this.ensureServer();
    const common = {
      model: this.options.model,
      cwd: this.options.cwd,
      approvalPolicy: 'never',
      sandbox: 'read-only',
      serviceName: 'opentag',
      experimentalRawEvents: false,
      config: {
        mcp_servers: mcpServers(this.options.toolSession),
      },
    };
    let response: unknown;
    if (this.options.resumeThreadId) {
      try {
        response = await this.request('thread/resume', {
          ...common,
          threadId: this.options.resumeThreadId,
          excludeTurns: true,
        });
      } catch (error) {
        throw new Error(
          `failed_to_resume_codex_thread:${
            error instanceof Error ? error.message : String(error)
          }`,
          { cause: error },
        );
      }
    } else {
      response = await this.request('thread/start', {
        ...common,
        ephemeral: this.options.ephemeral,
      });
    }
    const threadId =
      threadIdFromResponse(response) || this.options.resumeThreadId;
    if (!threadId) throw new Error('codex_app_server_missing_thread_id');
    this.threadId = threadId;
    return threadId;
  }

  async *runTurn(
    prompt: string,
    options: {
      localImages?: string[];
      signal?: AbortSignal;
      onStarted?(): void;
    } = {},
  ): AsyncGenerator<CodexAppServerEvent> {
    if (!this.threadId) throw new Error('codex_app_server_thread_not_started');
    const input: JsonRecord[] = [
      { type: 'text', text: prompt, text_elements: [] },
      ...(options.localImages ?? []).map((imagePath) => ({
        type: 'localImage',
        path: imagePath,
      })),
    ];
    const response = await this.request('turn/start', {
      threadId: this.threadId,
      input,
      cwd: this.options.cwd,
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'readOnly' },
      model: this.options.model,
    });
    const turnId = turnIdFromResponse(response);
    if (!turnId) throw new Error('codex_app_server_missing_turn_id');
    this.activeTurnId = turnId;
    options.onStarted?.();
    if (options.signal?.aborted) {
      // Cancellation can race with the turn/start response. Once the provider
      // reveals the exact turn id, still interrupt that turn before unwinding.
      await this.interrupt();
      throw abortError(options.signal);
    }

    while (true) {
      const notification = await this.notifications.next(options.signal);
      if (!notification) throw new Error('codex_app_server_closed');
      const params = object(notification.params) ?? {};
      const eventThreadId = string(params.threadId);
      const eventTurnId =
        string(params.turnId) || string(object(params.turn)?.id);
      if (eventThreadId && eventThreadId !== this.threadId) continue;
      if (eventTurnId && eventTurnId !== turnId) continue;

      if (
        notification.method === 'item/started' ||
        notification.method === 'item/completed'
      ) {
        const item = normalizeItem(params.item);
        if (item) {
          const completed = notification.method === 'item/completed';
          yield {
            type: completed ? 'item.completed' : 'item.started',
            item,
          };
          if (completed && item.type === 'context_compaction') {
            yield {
              type: 'compact.completed',
              threadId: this.threadId,
              turnId,
              source: 'item',
            };
          }
        }
        continue;
      }
      if (notification.method === 'thread/compacted') {
        yield {
          type: 'compact.completed',
          threadId: this.threadId,
          turnId: eventTurnId,
          source: 'thread',
        };
        continue;
      }
      if (notification.method === 'item/agentMessage/delta') {
        const delta = string(params.delta);
        if (delta) yield { type: 'text.delta', text: delta };
        continue;
      }
      if (notification.method === 'thread/tokenUsage/updated') {
        yield {
          type: 'usage',
          usage: usageFromNotification(params.tokenUsage),
        };
        continue;
      }
      if (notification.method === 'error') {
        const error = object(params.error);
        yield {
          type: 'error',
          message: string(error?.message) || string(params.message) || 'codex_app_server_error',
          willRetry: params.willRetry === true,
          errorInfo: error?.codexErrorInfo,
        };
        continue;
      }
      if (notification.method === 'turn/completed') {
        const turn = object(params.turn) ?? {};
        const status = string(turn.status) || 'completed';
        this.activeTurnId = undefined;
        yield {
          type: 'turn.completed',
          status,
          error:
            status === 'failed'
              ? errorMessage(turn.error, 'codex_turn_failed')
              : undefined,
        };
        return;
      }
    }
  }

  async compact(
    options: { signal?: AbortSignal } = {},
  ): Promise<CodexAppServerCompactResult> {
    if (!this.threadId) throw new Error('codex_app_server_thread_not_started');
    if (this.activeTurnId) throw new Error('codex_app_server_turn_active');
    const threadId = this.threadId;
    await this.request('thread/compact/start', { threadId });

    let compactTurnId: string | undefined;
    try {
      while (true) {
        const notification = await this.notifications.next(options.signal);
        if (!notification) throw new Error('codex_app_server_closed');
        const params = object(notification.params) ?? {};
        const eventThreadId = string(params.threadId);
        if (eventThreadId && eventThreadId !== threadId) continue;

        if (notification.method === 'turn/started') {
          const turnId = string(object(params.turn)?.id);
          if (turnId) {
            compactTurnId = turnId;
            this.activeTurnId = turnId;
          }
          continue;
        }

        const eventTurnId =
          string(params.turnId) || string(object(params.turn)?.id);
        if (
          compactTurnId &&
          eventTurnId &&
          eventTurnId !== compactTurnId
        ) {
          continue;
        }

        if (notification.method === 'item/completed') {
          const item = normalizeItem(params.item);
          if (item?.type === 'context_compaction') {
            return {
              threadId,
              turnId: eventTurnId || compactTurnId,
              source: 'item',
            };
          }
          continue;
        }
        if (notification.method === 'thread/compacted') {
          return {
            threadId,
            turnId: eventTurnId || compactTurnId,
            source: 'thread',
          };
        }
        if (notification.method === 'error') {
          const error = object(params.error);
          if (params.willRetry !== true) {
            throw new Error(
              string(error?.message) ||
                string(params.message) ||
                'codex_context_compaction_failed',
            );
          }
          continue;
        }
        if (notification.method === 'turn/completed') {
          const turn = object(params.turn) ?? {};
          const status = string(turn.status) || 'completed';
          if (status === 'failed') {
            throw new Error(
              errorMessage(turn.error, 'codex_context_compaction_failed'),
            );
          }
          return {
            threadId,
            turnId: eventTurnId || compactTurnId,
            source: 'turn',
          };
        }
      }
    } finally {
      if (!compactTurnId || this.activeTurnId === compactTurnId) {
        this.activeTurnId = undefined;
      }
    }
  }

  async steer(prompt: string, clientUserMessageId?: string): Promise<boolean> {
    if (!this.threadId || !this.activeTurnId) return false;
    const expectedTurnId = this.activeTurnId;
    const response = await this.request(
      'turn/steer',
      {
        threadId: this.threadId,
        expectedTurnId,
        input: [{ type: 'text', text: prompt, text_elements: [] }],
        ...(clientUserMessageId ? { clientUserMessageId } : {}),
      },
      15_000,
    );
    return string(object(response)?.turnId) === expectedTurnId;
  }

  async interrupt(): Promise<void> {
    if (!this.threadId || !this.activeTurnId) return;
    try {
      await this.request(
        'turn/interrupt',
        { threadId: this.threadId, turnId: this.activeTurnId },
        5_000,
      );
    } catch {
      // Shutdown still terminates the process group if interrupt loses the race.
    }
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    this.notifications.close();
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(new Error('codex_app_server_closed'));
    }
    this.pending.clear();
    this.stdout?.close();
    this.stderr?.close();
    const child = this.child;
    this.child = undefined;
    if (child && !child.killed) {
      signalProcessGroup(child, 'SIGTERM');
      const forceKill = setTimeout(() => signalProcessGroup(child, 'SIGKILL'), 2_000);
      forceKill.unref?.();
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          clearTimeout(forceKill);
          resolve();
          return;
        }
        child.once('exit', () => {
          clearTimeout(forceKill);
          clearTimeout(giveUp);
          resolve();
        });
        const giveUp = setTimeout(() => {
          clearTimeout(forceKill);
          resolve();
        }, 4_000);
        giveUp.unref?.();
      });
    }
  }

  private async ensureServer(): Promise<void> {
    const args = [
      ...(this.options.commandPrefixArgs ?? []),
      'app-server',
      '--stdio',
      '--strict-config',
    ];
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(this.options.command, args, {
        cwd: this.options.cwd,
        env: this.options.env,
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      throw new CodexAppServerUnavailableError(
        `codex_app_server_spawn_failed:${this.options.command}`,
        { cause: error },
      );
    }
    this.child = child;
    child.stdin.on('error', () => undefined);
    child.once('error', (error) => this.failAll(error));
    child.once('exit', (code, signal) => {
      if (this.closing) return;
      this.failAll(
        new Error(`codex_app_server_exited:${code ?? signal ?? 'unknown'}`),
      );
    });

    this.stdout = createInterface({ input: child.stdout });
    this.stdout.on('line', (line) => this.handleLine(line));
    this.stderr = createInterface({ input: child.stderr });
    this.stderr.on('line', (line) => {
      if (line.trim()) {
        void Promise.resolve(this.options.onStderrLine?.(line)).catch(() => undefined);
      }
    });

    try {
      await this.request('initialize', {
        clientInfo: {
          name: 'opentag',
          title: 'MaxTag',
          version: '0.1.0',
        },
        capabilities: { experimentalApi: true },
      });
      this.notify('initialized');
    } catch (error) {
      await this.close();
      throw new CodexAppServerUnavailableError(
        'codex_app_server_initialize_failed',
        { cause: error },
      );
    }
  }

  private request(
    method: string,
    params: unknown,
    timeoutMs = this.options.requestTimeoutMs ?? 30_000,
  ): Promise<unknown> {
    const child = this.child;
    if (!child || child.stdin.destroyed || child.stdin.writableEnded) {
      return Promise.reject(new Error('codex_app_server_not_running'));
    }
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const pending: PendingRequest = { resolve, reject };
      if (timeoutMs > 0) {
        pending.timer = setTimeout(() => {
          if (!this.pending.delete(id)) return;
          reject(new Error(`${method}_timed_out_after_${timeoutMs}ms`));
        }, timeoutMs);
        pending.timer.unref?.();
      }
      this.pending.set(id, pending);
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`, (error) => {
        if (!error) return;
        const current = this.pending.get(id);
        this.pending.delete(id);
        if (current?.timer) clearTimeout(current.timer);
        reject(error);
      });
    });
  }

  private notify(method: string, params?: unknown): void {
    if (!this.child) return;
    const payload = params === undefined ? { method } : { method, params };
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  private respond(id: string | number, result: unknown): void {
    this.child?.stdin.write(`${JSON.stringify({ id, result })}\n`);
  }

  private respondError(id: string | number, message: string): void {
    this.child?.stdin.write(
      `${JSON.stringify({ id, error: { code: -32601, message } })}\n`,
    );
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(trimmed) as JsonRpcMessage;
    } catch {
      void Promise.resolve(
        this.options.onUnstructuredLine?.(trimmed.slice(0, 500)),
      ).catch(() => undefined);
      return;
    }

    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (pending) {
        this.pending.delete(message.id);
        if (pending.timer) clearTimeout(pending.timer);
        if (message.error) {
          pending.reject(
            new CodexAppServerRpcError(
              message.error.message || 'codex_app_server_rpc_error',
              message.error.code,
              message.error.data,
            ),
          );
        } else {
          pending.resolve(message.result);
        }
        return;
      }
      this.handleServerRequest(message);
      return;
    }
    if (message.method) {
      this.notifications.push({ method: message.method, params: message.params });
    }
  }

  private handleServerRequest(message: JsonRpcMessage): void {
    if (message.id === undefined || !message.method) return;
    switch (message.method) {
      case 'item/commandExecution/requestApproval':
      case 'item/fileChange/requestApproval':
        this.respond(message.id, { decision: 'decline' });
        return;
      case 'item/permissions/requestApproval':
        this.respond(message.id, { permissions: {}, scope: 'turn' });
        return;
      case 'item/tool/requestUserInput':
        this.respond(message.id, { answers: {} });
        return;
      case 'mcpServer/elicitation/request':
        this.respond(message.id, { action: 'decline', content: null });
        return;
      case 'applyPatchApproval':
      case 'execCommandApproval':
        this.respond(message.id, { decision: 'denied' });
        return;
      default:
        this.respondError(
          message.id,
          `Unsupported Codex server request: ${message.method}`,
        );
    }
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.notifications.close(error);
  }
}
