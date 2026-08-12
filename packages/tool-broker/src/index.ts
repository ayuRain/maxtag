import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { Ajv, type ValidateFunction } from 'ajv';
import type {
  AgentRunRequest,
  MemoryScopeKind,
  MemoryStore,
  ToolCallRisk,
  ToolGrant,
  ToolGrantKind,
} from '@opentag/core';
import type {
  CliToolDescriptor,
  CliToolSession,
  CliToolSessionFactory,
} from '@opentag/executor-cli';

type JsonObject = Record<string, unknown>;

export interface LarkOpenApiClient {
  request<T>(
    pathname: string,
    options: {
      method: 'GET' | 'POST';
      query?: Record<string, string | number | boolean | undefined>;
      body?: JsonObject;
      signal?: AbortSignal;
    },
  ): Promise<T>;
}

export interface OpenTagToolBrokerOptions {
  memory: MemoryStore;
  lark?: LarkOpenApiClient;
  github?: {
    token?: string;
    baseUrl?: string;
    fetch?: typeof fetch;
  };
  maxCallsPerRun?: number;
  maxRequestBytes?: number;
  maxResultBytes?: number;
  callTimeoutMs?: number;
}

export interface OpenTagToolCatalogEntry {
  grantKind: ToolGrantKind;
  label: string;
  description: string;
  toolCount: number;
  constraints?: Array<{
    key: string;
    label: string;
    placeholder: string;
  }>;
}

export const OPENTAG_TOOL_CATALOG: OpenTagToolCatalogEntry[] = [
  {
    grantKind: 'github',
    label: 'GitHub',
    description: 'Inspect repositories and issues without exposing GitHub credentials.',
    toolCount: 2,
    constraints: [
      {
        key: 'repositories',
        label: 'Allowed repositories',
        placeholder: 'owner/repo, owner/another-repo',
      },
    ],
  },
  {
    grantKind: 'lark-docs',
    label: 'Lark Docs',
    description: 'Read approved Lark documents with the workspace bot identity.',
    toolCount: 1,
    constraints: [
      {
        key: 'documentIds',
        label: 'Allowed document IDs',
        placeholder: 'doxcn..., doxcn...',
      },
    ],
  },
  {
    grantKind: 'lark-base',
    label: 'Lark Base',
    description: 'Query records from approved Base apps and tables.',
    toolCount: 1,
    constraints: [
      {
        key: 'appTokens',
        label: 'Allowed Base app tokens',
        placeholder: 'bascn..., bascn...',
      },
    ],
  },
  {
    grantKind: 'browser',
    label: 'Browser',
    description: 'Use provider web tools under the project network policy.',
    toolCount: 2,
  },
  {
    grantKind: 'shell',
    label: 'Shell',
    description: 'Edit and run commands inside the resolved project directory.',
    toolCount: 3,
  },
];

interface ToolExecutionContext {
  request: AgentRunRequest;
  grant: ToolGrant;
  signal: AbortSignal;
}

interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  grantKind: ToolGrantKind;
  risk: ToolCallRisk;
  inputSchema: JsonObject;
  available(options: OpenTagToolBrokerOptions): boolean;
  authorize(request: AgentRunRequest, input: JsonObject): ToolGrant;
  summarize(input: JsonObject): JsonObject;
  execute(context: ToolExecutionContext, input: JsonObject): Promise<unknown>;
  validate?: ValidateFunction;
}

interface WireToolDefinition extends CliToolDescriptor {
  description: string;
  inputSchema: JsonObject;
  grantKind: ToolGrantKind;
}

interface WireToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: JsonObject;
  isError?: boolean;
}

class ToolDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolDeniedError';
  }
}

function objectValue(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

function stringValue(input: JsonObject, key: string): string {
  const value = input[key];
  return typeof value === 'string' ? value.trim() : '';
}

function boundedInteger(
  input: JsonObject,
  key: string,
  fallback: number,
  maximum: number,
): number {
  const value = input[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(maximum, Math.floor(value)));
}

function grantsFor(request: AgentRunRequest, kind: ToolGrantKind): ToolGrant[] {
  return request.access.grants.filter((grant) => grant.kind === kind);
}

function permissionAllows(grant: ToolGrant, permission: 'read' | 'write'): boolean {
  const value = grant.constraints?.permissions;
  if (!Array.isArray(value)) return permission === 'read';
  return value.some((item) => item === permission);
}

function memoryGrant(
  request: AgentRunRequest,
  scope: MemoryScopeKind,
  permission: 'read' | 'write',
): ToolGrant {
  const grant = grantsFor(request, 'memory').find(
    (candidate) =>
      candidate.scope === scope && permissionAllows(candidate, permission),
  );
  if (!grant) throw new ToolDeniedError(`memory_${scope}_${permission}_not_granted`);
  return grant;
}

function constraintStrings(grant: ToolGrant, ...keys: string[]): string[] {
  for (const key of keys) {
    const value = grant.constraints?.[key];
    if (!Array.isArray(value)) continue;
    return value
      .map((item) => {
        if (typeof item === 'string') return item.trim();
        const record = objectValue(item);
        const owner = stringValue(record, 'owner');
        const repo = stringValue(record, 'repo');
        return owner && repo ? `${owner}/${repo}` : '';
      })
      .filter(Boolean);
  }
  return [];
}

function resourceGrant(
  request: AgentRunRequest,
  kind: ToolGrantKind,
  value: string,
  keys: string[],
): ToolGrant {
  const normalized = value.toLowerCase();
  const grant = grantsFor(request, kind).find((candidate) =>
    constraintStrings(candidate, ...keys).some((allowed) => {
      const pattern = allowed.toLowerCase();
      if (pattern === '*') return true;
      if (pattern.endsWith('/*')) {
        return normalized.startsWith(pattern.slice(0, -1));
      }
      return pattern === normalized;
    }),
  );
  if (!grant) throw new ToolDeniedError(`${kind}_resource_not_allowed`);
  return grant;
}

function safeArguments(input: JsonObject): JsonObject {
  const result: JsonObject = {};
  for (const [key, value] of Object.entries(input)) {
    if (/token|secret|password|authorization/iu.test(key)) {
      result[key] = '[redacted]';
      continue;
    }
    if (typeof value === 'string') {
      result[key] = value.length <= 180 ? value : `${value.slice(0, 180)}...`;
      continue;
    }
    if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
      result[key] = value;
      continue;
    }
    if (Array.isArray(value)) result[key] = `[${value.length} item(s)]`;
    else if (value && typeof value === 'object') result[key] = '[object]';
  }
  return result;
}

function errorText(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  return value.replace(/[\r\n]+/gu, ' ').slice(0, 500) || 'tool_call_failed';
}

function abortPromise(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) {
      reject(new Error('tool_call_aborted_or_timed_out'));
      return;
    }
    signal.addEventListener(
      'abort',
      () => reject(new Error('tool_call_aborted_or_timed_out')),
      { once: true },
    );
  });
}

function jsonText(value: unknown, maxBytes: number): {
  text: string;
  structuredContent?: JsonObject;
} {
  const serialized = JSON.stringify(value, null, 2) ?? 'null';
  const bytes = Buffer.byteLength(serialized);
  if (bytes <= maxBytes) {
    return {
      text: serialized,
      structuredContent:
        value && typeof value === 'object' && !Array.isArray(value)
          ? (value as JsonObject)
          : { value },
    };
  }
  const suffix = `\n[truncated at ${maxBytes} bytes]`;
  return {
    text: `${Buffer.from(serialized).subarray(0, maxBytes - Buffer.byteLength(suffix)).toString('utf8')}${suffix}`,
  };
}

function repositoryInput(input: JsonObject): { owner: string; repo: string; key: string } {
  const owner = stringValue(input, 'owner');
  const repo = stringValue(input, 'repo');
  return { owner, repo, key: `${owner}/${repo}` };
}

async function githubRequest(
  options: OpenTagToolBrokerOptions,
  pathname: string,
  query: Record<string, string | number | undefined>,
  signal: AbortSignal,
): Promise<unknown> {
  const baseUrl = (options.github?.baseUrl || 'https://api.github.com').replace(/\/+$/u, '');
  const url = new URL(`${baseUrl}${pathname}`);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  const headers: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'user-agent': 'opentag-tool-broker/0.1',
    'x-github-api-version': '2022-11-28',
  };
  if (options.github?.token) headers.authorization = `Bearer ${options.github.token}`;
  const response = await (options.github?.fetch || fetch)(url, {
    method: 'GET',
    headers,
    signal,
  });
  const body = await response.text();
  let parsed: unknown;
  try {
    parsed = body ? JSON.parse(body) : {};
  } catch {
    parsed = body;
  }
  if (!response.ok) {
    const message = stringValue(objectValue(parsed), 'message') || body;
    throw new Error(`github_http_${response.status}:${message.slice(0, 300)}`);
  }
  return parsed;
}

function createDefinitions(options: OpenTagToolBrokerOptions): ToolDefinition[] {
  return [
    {
      name: 'memory_get',
      title: 'Read scoped memory',
      description: 'Read one OpenTag memory scope for the current global, workspace, project, or thread context.',
      grantKind: 'memory',
      risk: 'read',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          scope: { type: 'string', enum: ['global', 'workspace', 'project', 'thread'] },
        },
        required: ['scope'],
      },
      available: () => Boolean(options.memory.loadMemory),
      authorize: (request, input) =>
        memoryGrant(request, stringValue(input, 'scope') as MemoryScopeKind, 'read'),
      summarize: safeArguments,
      async execute({ request }, input) {
        if (!options.memory.loadMemory) throw new Error('scoped_memory_unavailable');
        const scope = stringValue(input, 'scope') as MemoryScopeKind;
        const snapshot = await options.memory.loadMemory({
          thread: request.thread,
          workspace: request.workspace,
          project: request.project,
          scopes: [scope],
        });
        const item = snapshot.scopes[0];
        return {
          scope: item?.scope,
          content: item?.content || '',
          version: item?.document?.version ?? 0,
          updatedAt: item?.document?.updatedAt,
        };
      },
    },
    {
      name: 'memory_remember',
      title: 'Remember scoped context',
      description: 'Append a durable fact to the current project or thread memory.',
      grantKind: 'memory',
      risk: 'write',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          scope: { type: 'string', enum: ['global', 'workspace', 'project', 'thread'] },
          text: { type: 'string', minLength: 1, maxLength: 4000 },
        },
        required: ['scope', 'text'],
      },
      available: () => Boolean(options.memory.rememberScoped),
      authorize: (request, input) =>
        memoryGrant(request, stringValue(input, 'scope') as MemoryScopeKind, 'write'),
      summarize(input) {
        return {
          scope: stringValue(input, 'scope'),
          textLength: stringValue(input, 'text').length,
        };
      },
      async execute({ request }, input) {
        if (!options.memory.rememberScoped) throw new Error('scoped_memory_unavailable');
        const scope = stringValue(input, 'scope') as MemoryScopeKind;
        await options.memory.rememberScoped({
          thread: request.thread,
          workspace: request.workspace,
          project: request.project,
          scope,
          text: stringValue(input, 'text'),
          actorId: `agent:${request.identity.id}`,
          source: `tool-broker:${request.runId}`,
        });
        return { remembered: true, scope };
      },
    },
    {
      name: 'github_repository',
      title: 'Inspect GitHub repository',
      description: 'Read metadata for an approved GitHub repository.',
      grantKind: 'github',
      risk: 'read',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          owner: { type: 'string', minLength: 1, maxLength: 100 },
          repo: { type: 'string', minLength: 1, maxLength: 100 },
        },
        required: ['owner', 'repo'],
      },
      available: () => Boolean(options.github),
      authorize(request, input) {
        return resourceGrant(request, 'github', repositoryInput(input).key, ['repositories']);
      },
      summarize: safeArguments,
      async execute({ signal }, input) {
        const repository = repositoryInput(input);
        const raw = objectValue(
          await githubRequest(
            options,
            `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}`,
            {},
            signal,
          ),
        );
        return {
          fullName: raw.full_name,
          description: raw.description,
          private: raw.private,
          archived: raw.archived,
          defaultBranch: raw.default_branch,
          language: raw.language,
          stars: raw.stargazers_count,
          forks: raw.forks_count,
          openIssues: raw.open_issues_count,
          htmlUrl: raw.html_url,
          pushedAt: raw.pushed_at,
        };
      },
    },
    {
      name: 'github_issues',
      title: 'List GitHub issues',
      description: 'List recent issues and pull requests for an approved GitHub repository.',
      grantKind: 'github',
      risk: 'read',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          owner: { type: 'string', minLength: 1, maxLength: 100 },
          repo: { type: 'string', minLength: 1, maxLength: 100 },
          state: { type: 'string', enum: ['open', 'closed', 'all'] },
          limit: { type: 'integer', minimum: 1, maximum: 50 },
        },
        required: ['owner', 'repo'],
      },
      available: () => Boolean(options.github),
      authorize(request, input) {
        return resourceGrant(request, 'github', repositoryInput(input).key, ['repositories']);
      },
      summarize: safeArguments,
      async execute({ signal }, input) {
        const repository = repositoryInput(input);
        const raw = await githubRequest(
          options,
          `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}/issues`,
          {
            state: stringValue(input, 'state') || 'open',
            per_page: boundedInteger(input, 'limit', 20, 50),
          },
          signal,
        );
        const items = Array.isArray(raw) ? raw : [];
        return {
          repository: repository.key,
          items: items.map((value) => {
            const item = objectValue(value);
            const user = objectValue(item.user);
            return {
              number: item.number,
              title: item.title,
              state: item.state,
              type: item.pull_request ? 'pull_request' : 'issue',
              author: user.login,
              htmlUrl: item.html_url,
              updatedAt: item.updated_at,
            };
          }),
        };
      },
    },
    {
      name: 'lark_doc_read',
      title: 'Read Lark document',
      description: 'Read the plain-text content of an approved Lark document with the workspace bot.',
      grantKind: 'lark-docs',
      risk: 'read',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          documentId: { type: 'string', minLength: 1, maxLength: 100 },
          language: { type: 'integer', enum: [0, 1] },
        },
        required: ['documentId'],
      },
      available: () => Boolean(options.lark),
      authorize(request, input) {
        return resourceGrant(request, 'lark-docs', stringValue(input, 'documentId'), [
          'documentIds',
          'documents',
        ]);
      },
      summarize: safeArguments,
      async execute({ signal }, input) {
        if (!options.lark) throw new Error('lark_provider_unavailable');
        const documentId = stringValue(input, 'documentId');
        const response = objectValue(
          await options.lark.request(
            `/open-apis/docx/v1/documents/${encodeURIComponent(documentId)}/raw_content`,
            {
              method: 'GET',
              query: { lang: input.language === 1 ? 1 : 0 },
              signal,
            },
          ),
        );
        const content = stringValue(response, 'content');
        return {
          documentId,
          content: content.slice(0, 50_000),
          truncated: content.length > 50_000,
        };
      },
    },
    {
      name: 'lark_base_records',
      title: 'Query Lark Base records',
      description: 'Query a page of records from an approved Lark Base app.',
      grantKind: 'lark-base',
      risk: 'read',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          appToken: { type: 'string', minLength: 1, maxLength: 100 },
          tableId: { type: 'string', minLength: 1, maxLength: 100 },
          viewId: { type: 'string', maxLength: 100 },
          fieldNames: {
            type: 'array',
            maxItems: 50,
            items: { type: 'string', minLength: 1, maxLength: 200 },
          },
          filter: { type: 'object' },
          pageSize: { type: 'integer', minimum: 1, maximum: 100 },
          pageToken: { type: 'string', maxLength: 1000 },
        },
        required: ['appToken', 'tableId'],
      },
      available: () => Boolean(options.lark),
      authorize(request, input) {
        return resourceGrant(request, 'lark-base', stringValue(input, 'appToken'), [
          'appTokens',
          'bases',
        ]);
      },
      summarize(input) {
        return {
          appToken: stringValue(input, 'appToken'),
          tableId: stringValue(input, 'tableId'),
          viewId: stringValue(input, 'viewId') || undefined,
          pageSize: boundedInteger(input, 'pageSize', 20, 100),
          hasFilter: Boolean(input.filter),
        };
      },
      async execute({ signal }, input) {
        if (!options.lark) throw new Error('lark_provider_unavailable');
        const appToken = stringValue(input, 'appToken');
        const tableId = stringValue(input, 'tableId');
        const fieldNames = Array.isArray(input.fieldNames)
          ? input.fieldNames.filter((item): item is string => typeof item === 'string')
          : undefined;
        const response = objectValue(
          await options.lark.request(
            `/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/records/search`,
            {
              method: 'POST',
              query: {
                page_size: boundedInteger(input, 'pageSize', 20, 100),
                page_token: stringValue(input, 'pageToken') || undefined,
                user_id_type: 'open_id',
              },
              body: {
                view_id: stringValue(input, 'viewId') || undefined,
                field_names: fieldNames?.length ? fieldNames : undefined,
                filter: input.filter,
                automatic_fields: false,
              },
              signal,
            },
          ),
        );
        return {
          appToken,
          tableId,
          items: Array.isArray(response.items) ? response.items : [],
          hasMore: response.has_more === true,
          pageToken: response.page_token,
          total: response.total,
        };
      },
    },
  ];
}

function authorized(request: IncomingMessage, token: string): boolean {
  const header = request.headers.authorization || '';
  const expected = Buffer.from(`Bearer ${token}`);
  const actual = Buffer.from(header);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function requestBody(request: IncomingMessage, maxBytes: number): Promise<JsonObject> {
  const declared = Number(request.headers['content-length'] || 0);
  if (declared > maxBytes) throw new Error('tool_request_too_large');
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const value of request) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    total += chunk.byteLength;
    if (total > maxBytes) throw new Error('tool_request_too_large');
    chunks.push(chunk);
  }
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('tool_request_invalid');
  }
  return parsed as JsonObject;
}

function sendJson(
  response: import('node:http').ServerResponse,
  statusCode: number,
  value: unknown,
): void {
  const body = JSON.stringify(value);
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  response.end(body);
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once('error', onError);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', onError);
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('tool_broker_address_unavailable'));
        return;
      }
      resolve(address.port);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections?.();
  });
}

export class OpenTagToolBroker implements CliToolSessionFactory {
  private readonly options: OpenTagToolBrokerOptions;
  private readonly definitions: ToolDefinition[];

  constructor(options: OpenTagToolBrokerOptions) {
    this.options = options;
    const ajv = new Ajv({ allErrors: true, strict: false });
    this.definitions = createDefinitions(options).map((definition) => ({
      ...definition,
      validate: ajv.compile(definition.inputSchema),
    }));
  }

  catalog(): OpenTagToolCatalogEntry[] {
    return OPENTAG_TOOL_CATALOG.map((entry) => ({
      ...entry,
      constraints: entry.constraints?.map((constraint) => ({ ...constraint })),
    }));
  }

  async open(request: AgentRunRequest): Promise<CliToolSession | undefined> {
    const definitions = this.definitions.filter(
      (definition) =>
        definition.available(this.options) &&
        request.access.grants.some((grant) => grant.kind === definition.grantKind),
    );
    if (!definitions.length) return undefined;

    const token = randomBytes(32).toString('base64url');
    const maxCalls = Math.max(1, this.options.maxCallsPerRun ?? 100);
    const maxRequestBytes = Math.max(1024, this.options.maxRequestBytes ?? 256 * 1024);
    const maxResultBytes = Math.max(4096, this.options.maxResultBytes ?? 128 * 1024);
    const callTimeoutMs = Math.max(100, this.options.callTimeoutMs ?? 30_000);
    const byName = new Map(definitions.map((definition) => [definition.name, definition]));
    const sessionAbort = new AbortController();
    let callCount = 0;
    let closed = false;

    const wireTools: WireToolDefinition[] = definitions.map((definition) => ({
      name: definition.name,
      title: definition.title,
      description: definition.description,
      grantKind: definition.grantKind,
      risk: definition.risk,
      inputSchema: definition.inputSchema,
    }));

    const invoke = async (body: JsonObject): Promise<WireToolResult> => {
      const name = stringValue(body, 'name');
      const input = objectValue(body.arguments);
      const definition = byName.get(name);
      if (!definition) {
        return { content: [{ type: 'text', text: 'tool_not_available' }], isError: true };
      }
      const callId = randomUUID();
      const startedAt = Date.now();
      await request.onEvent?.({
        type: 'tool_call',
        call: {
          id: callId,
          name,
          title: definition.title,
          grantKind: definition.grantKind,
          risk: definition.risk,
          arguments: definition.summarize(input),
        },
      });
      let grant: ToolGrant | undefined;
      try {
        callCount += 1;
        if (callCount > maxCalls) throw new ToolDeniedError('tool_call_limit_exceeded');
        if (!definition.validate?.(input)) {
          const detail = definition.validate?.errors
            ?.map((error) => `${error.instancePath || '/'} ${error.message || 'invalid'}`)
            .join('; ');
          throw new Error(`tool_arguments_invalid:${detail || 'schema mismatch'}`);
        }
        grant = definition.authorize(request, input);
        const callAbort = new AbortController();
        const abort = (): void => callAbort.abort();
        sessionAbort.signal.addEventListener('abort', abort, { once: true });
        request.abortSignal?.addEventListener('abort', abort, { once: true });
        const timeout = setTimeout(abort, callTimeoutMs);
        timeout.unref?.();
        let value: unknown;
        try {
          value = await Promise.race([
            definition.execute(
              { request, grant, signal: callAbort.signal },
              input,
            ),
            abortPromise(callAbort.signal),
          ]);
        } finally {
          clearTimeout(timeout);
          sessionAbort.signal.removeEventListener('abort', abort);
          request.abortSignal?.removeEventListener('abort', abort);
        }
        const result = jsonText(value, maxResultBytes);
        await request.onEvent?.({
          type: 'tool_result',
          call: {
            id: callId,
            name,
            title: definition.title,
            grantKind: definition.grantKind,
            risk: definition.risk,
            arguments: definition.summarize(input),
            status: 'succeeded',
            durationMs: Date.now() - startedAt,
            resultPreview: result.text.replace(/\s+/gu, ' ').slice(0, 300),
          },
        });
        return {
          content: [{ type: 'text', text: result.text }],
          structuredContent: result.structuredContent,
        };
      } catch (error) {
        const message = errorText(error);
        await request.onEvent?.({
          type: 'tool_result',
          call: {
            id: callId,
            name,
            title: definition.title,
            grantKind: definition.grantKind,
            risk: definition.risk,
            arguments: definition.summarize(input),
            status: error instanceof ToolDeniedError ? 'denied' : 'failed',
            durationMs: Date.now() - startedAt,
            error: message,
          },
        });
        return { content: [{ type: 'text', text: message }], isError: true };
      }
    };

    const server = createServer(async (incoming, response) => {
      try {
        if (!authorized(incoming, token)) {
          sendJson(response, 401, { error: 'unauthorized' });
          return;
        }
        const url = new URL(incoming.url || '/', 'http://127.0.0.1');
        if (incoming.method === 'GET' && url.pathname === '/v1/tools') {
          sendJson(response, 200, { tools: wireTools });
          return;
        }
        if (incoming.method === 'POST' && url.pathname === '/v1/call') {
          sendJson(response, 200, { result: await invoke(await requestBody(incoming, maxRequestBytes)) });
          return;
        }
        sendJson(response, 404, { error: 'not_found' });
      } catch (error) {
        sendJson(response, 400, { error: errorText(error) });
      }
    });
    const port = await listen(server);
    const proxyPath = fileURLToPath(new URL('./mcp-proxy.js', import.meta.url));
    return {
      mcp: {
        name: 'opentag',
        command: process.execPath,
        args: [proxyPath],
        env: {
          OPENTAG_TOOL_BROKER_URL: `http://127.0.0.1:${port}`,
          OPENTAG_TOOL_BROKER_TOKEN: token,
        },
      },
      tools: wireTools.map(({ name, title, risk }) => ({ name, title, risk })),
      async close() {
        if (closed) return;
        closed = true;
        sessionAbort.abort();
        await closeServer(server);
      },
    };
  }
}

export function createOpenTagToolBroker(
  options: OpenTagToolBrokerOptions,
): OpenTagToolBroker {
  return new OpenTagToolBroker(options);
}
