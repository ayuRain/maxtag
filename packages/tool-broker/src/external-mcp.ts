import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import type { ToolCallRisk } from '@opentag/core';

type JsonObject = Record<string, unknown>;

export interface ExternalMcpToolPolicy {
  name: string;
  risk: ToolCallRisk;
  title?: string;
  description?: string;
}

export interface ExternalMcpServerConfig {
  id: string;
  label: string;
  description?: string;
  command: string;
  args: string[];
  cwd?: string;
  envRefs: Record<string, string>;
  tools: ExternalMcpToolPolicy[];
}

export interface ExternalMcpDiscoveredTool extends ExternalMcpToolPolicy {
  exposedName: string;
  serverId: string;
  serverLabel: string;
  inputSchema: JsonObject;
}

export interface ExternalMcpConnection {
  listTools(options: { signal?: AbortSignal; timeout: number }): Promise<{
    tools: Array<{
      name: string;
      inputSchema: JsonObject;
    }>;
  }>;
  callTool(
    input: { name: string; arguments: JsonObject },
    options: { signal?: AbortSignal; timeout: number },
  ): Promise<unknown>;
  close(): Promise<void>;
}

export interface ExternalMcpConnectorInput {
  server: ExternalMcpServerConfig;
  env: Record<string, string>;
  maxBufferBytes: number;
  signal?: AbortSignal;
  timeout: number;
}

export type ExternalMcpConnector = (
  input: ExternalMcpConnectorInput,
) => Promise<ExternalMcpConnection>;

export interface ExternalMcpRegistryOptions {
  environment?: NodeJS.ProcessEnv;
  connector?: ExternalMcpConnector;
  stateStore?: ExternalMcpStateStore;
  timeoutMs?: number;
  maxBufferBytes?: number;
}

export interface ExternalMcpStateStore {
  isEnabled(serverId: string): Promise<boolean>;
}

export interface ExternalMcpHealthResult {
  status: 'ready' | 'credentials-required' | 'unavailable';
  checkedAt: string;
  latencyMs: number;
  toolCount: number;
  errorCode?: string;
}

function objectValue(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

function requiredString(value: unknown, field: string, maximum = 200): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) {
    throw new Error(`external_mcp_invalid_${field}`);
  }
  return value.trim();
}

function optionalString(value: unknown, field: string, maximum = 500): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, field, maximum);
}

function rejectUnknownKeys(
  input: JsonObject,
  allowed: string[],
  location: string,
): void {
  const unknown = Object.keys(input).find((key) => !allowed.includes(key));
  if (unknown) throw new Error(`external_mcp_unknown_field:${location}:${unknown}`);
}

function parseServer(value: unknown): ExternalMcpServerConfig {
  const input = objectValue(value);
  rejectUnknownKeys(
    input,
    ['id', 'label', 'description', 'command', 'args', 'cwd', 'envRefs', 'tools'],
    'server',
  );
  const id = requiredString(input.id, 'server_id', 40).toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/u.test(id)) {
    throw new Error('external_mcp_invalid_server_id');
  }
  const rawArgs = input.args ?? [];
  if (
    !Array.isArray(rawArgs) ||
    rawArgs.length > 100 ||
    rawArgs.some((item) => typeof item !== 'string' || item.length > 2_000)
  ) {
    throw new Error(`external_mcp_invalid_args:${id}`);
  }
  const envRefs: Record<string, string> = {};
  for (const [name, reference] of Object.entries(objectValue(input.envRefs))) {
    if (
      !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name) ||
      typeof reference !== 'string' ||
      !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(reference)
    ) {
      throw new Error(`external_mcp_invalid_env_ref:${id}`);
    }
    envRefs[name] = reference;
  }
  if (!Array.isArray(input.tools) || input.tools.length < 1 || input.tools.length > 100) {
    throw new Error(`external_mcp_invalid_tools:${id}`);
  }
  const seenTools = new Set<string>();
  const tools = input.tools.map((value) => {
    const tool = objectValue(value);
    rejectUnknownKeys(tool, ['name', 'risk', 'title', 'description'], `tool:${id}`);
    const name = requiredString(tool.name, 'tool_name', 80);
    if (!/^[A-Za-z0-9_-]+$/u.test(name) || seenTools.has(name)) {
      throw new Error(`external_mcp_invalid_tool_name:${id}`);
    }
    seenTools.add(name);
    if (tool.risk !== 'read' && tool.risk !== 'write') {
      throw new Error(`external_mcp_invalid_tool_risk:${id}:${name}`);
    }
    return {
      name,
      risk: tool.risk,
      title: optionalString(tool.title, 'tool_title', 120),
      description: optionalString(tool.description, 'tool_description', 500),
    } satisfies ExternalMcpToolPolicy;
  });
  return {
    id,
    label: requiredString(input.label, 'server_label', 120),
    description: optionalString(input.description, 'server_description', 500),
    command: requiredString(input.command, 'command', 2_000),
    args: [...(rawArgs as string[])],
    cwd: optionalString(input.cwd, 'cwd', 2_000),
    envRefs,
    tools,
  };
}

export function parseExternalMcpServersJson(
  value: string | undefined,
): ExternalMcpServerConfig[] {
  if (!value?.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('OPENTAG_EXTERNAL_MCP_SERVERS_JSON must be valid JSON.');
  }
  const root = objectValue(parsed);
  if (!Array.isArray(parsed)) rejectUnknownKeys(root, ['servers'], 'registry');
  const rawServers = Array.isArray(parsed) ? parsed : root.servers;
  if (!Array.isArray(rawServers) || rawServers.length > 50) {
    throw new Error('OPENTAG_EXTERNAL_MCP_SERVERS_JSON must contain a servers array.');
  }
  const servers = rawServers.map(parseServer);
  if (new Set(servers.map((server) => server.id)).size !== servers.length) {
    throw new Error('external_mcp_duplicate_server_id');
  }
  return servers;
}

function externalToolName(serverId: string, toolName: string): string {
  const readableServerId = serverId.replaceAll('-', '_').slice(0, 20);
  const digest = createHash('sha256')
    .update(`${serverId}\0${toolName}`, 'utf8')
    .digest('hex')
    .slice(0, 8);
  return `mcp_${readableServerId}_${digest}_${toolName}`;
}

async function stdioConnector(
  input: ExternalMcpConnectorInput,
): Promise<ExternalMcpConnection> {
  const transport = new StdioClientTransport({
    command: input.server.command,
    args: input.server.args,
    env: input.env,
    cwd: input.server.cwd,
    stderr: 'ignore',
    maxBufferSize: input.maxBufferBytes,
  });
  const client = new Client({
    name: `opentag-${input.server.id}`,
    version: '0.1.0',
  });
  try {
    await client.connect(transport, {
      signal: input.signal,
      timeout: input.timeout,
    });
  } catch (error) {
    await client.close().catch(() => transport.close().catch(() => undefined));
    throw error;
  }
  return {
    listTools: (options) => client.listTools(undefined, options),
    callTool: (request, options) => client.callTool(request, undefined, options),
    close: () => client.close(),
  };
}

export class ExternalMcpRegistry {
  private readonly environment: NodeJS.ProcessEnv;
  private readonly connector: ExternalMcpConnector;
  private readonly stateStore?: ExternalMcpStateStore;
  private readonly timeoutMs: number;
  private readonly maxBufferBytes: number;
  private readonly byId: Map<string, ExternalMcpServerConfig>;

  constructor(
    readonly servers: ExternalMcpServerConfig[],
    options: ExternalMcpRegistryOptions = {},
  ) {
    this.environment = options.environment ?? process.env;
    this.connector = options.connector ?? stdioConnector;
    this.stateStore = options.stateStore;
    this.timeoutMs = Math.max(100, options.timeoutMs ?? 30_000);
    this.maxBufferBytes = Math.max(64 * 1024, options.maxBufferBytes ?? 2 * 1024 * 1024);
    this.byId = new Map(servers.map((server) => [server.id, server]));
  }

  private resolvedEnvironment(server: ExternalMcpServerConfig): Record<string, string> {
    const env = getDefaultEnvironment();
    for (const [target, reference] of Object.entries(server.envRefs)) {
      const value = this.environment[reference];
      if (value === undefined) {
        throw new Error(`external_mcp_secret_missing:${server.id}:${reference}`);
      }
      env[target] = value;
    }
    return env;
  }

  credentialsAvailable(serverId: string): boolean {
    const server = this.byId.get(serverId);
    return Boolean(
      server &&
        Object.values(server.envRefs).every(
          (reference) => this.environment[reference] !== undefined,
        ),
    );
  }

  has(serverId: string): boolean {
    return this.byId.has(serverId);
  }

  async isEnabled(serverId: string): Promise<boolean> {
    return this.byId.has(serverId) && (await this.stateStore?.isEnabled(serverId)) !== false;
  }

  private async connect(
    server: ExternalMcpServerConfig,
    signal?: AbortSignal,
  ): Promise<ExternalMcpConnection> {
    return this.connector({
      server,
      env: this.resolvedEnvironment(server),
      maxBufferBytes: this.maxBufferBytes,
      signal,
      timeout: this.timeoutMs,
    });
  }

  async discover(
    serverIds: string[],
    signal?: AbortSignal,
  ): Promise<{
    tools: ExternalMcpDiscoveredTool[];
    unavailableServerIds: string[];
    disabledServerIds: string[];
  }> {
    const tools: ExternalMcpDiscoveredTool[] = [];
    const unavailableServerIds: string[] = [];
    const disabledServerIds: string[] = [];
    await Promise.all(
      [...new Set(serverIds)].map(async (serverId) => {
        const server = this.byId.get(serverId);
        if (!server) return;
        if (!(await this.isEnabled(server.id))) {
          disabledServerIds.push(server.id);
          return;
        }
        let connection: ExternalMcpConnection | undefined;
        try {
          connection = await this.connect(server, signal);
          const listed = await connection.listTools({
            signal,
            timeout: this.timeoutMs,
          });
          const discovered = new Map(listed.tools.map((tool) => [tool.name, tool]));
          for (const policy of server.tools) {
            const actual = discovered.get(policy.name);
            if (!actual) continue;
            const schema = objectValue(actual.inputSchema);
            if (Buffer.byteLength(JSON.stringify(schema)) > 128 * 1024) continue;
            tools.push({
              ...policy,
              title: policy.title || `${server.label}: ${policy.name}`,
              description:
                policy.description ||
                `Call the deployment-approved ${policy.name} tool on ${server.label}.`,
              exposedName: externalToolName(server.id, policy.name),
              serverId: server.id,
              serverLabel: server.label,
              inputSchema: {
                ...schema,
                type: 'object',
              },
            });
          }
        } catch {
          unavailableServerIds.push(server.id);
        } finally {
          await connection?.close().catch(() => undefined);
        }
      }),
    );
    if (new Set(tools.map((tool) => tool.exposedName)).size !== tools.length) {
      throw new Error('external_mcp_exposed_tool_name_collision');
    }
    return { tools, unavailableServerIds, disabledServerIds };
  }

  async check(serverId: string, signal?: AbortSignal): Promise<ExternalMcpHealthResult> {
    const checkedAt = new Date().toISOString();
    const startedAt = Date.now();
    const server = this.byId.get(serverId);
    if (!server) throw new Error('external_mcp_server_not_registered');
    if (!this.credentialsAvailable(serverId)) {
      return {
        status: 'credentials-required',
        checkedAt,
        latencyMs: Date.now() - startedAt,
        toolCount: 0,
        errorCode: 'external_mcp_credentials_required',
      };
    }
    let connection: ExternalMcpConnection | undefined;
    try {
      connection = await this.connect(server, signal);
      const listed = await connection.listTools({ signal, timeout: this.timeoutMs });
      const names = new Set(listed.tools.map((tool) => tool.name));
      return {
        status: 'ready',
        checkedAt,
        latencyMs: Date.now() - startedAt,
        toolCount: server.tools.filter((tool) => names.has(tool.name)).length,
      };
    } catch {
      return {
        status: 'unavailable',
        checkedAt,
        latencyMs: Date.now() - startedAt,
        toolCount: 0,
        errorCode: 'external_mcp_connection_failed',
      };
    } finally {
      await connection?.close().catch(() => undefined);
    }
  }

  async callTool(
    serverId: string,
    toolName: string,
    argumentsValue: JsonObject,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const server = this.byId.get(serverId);
    const policy = server?.tools.find((tool) => tool.name === toolName);
    if (!server || !policy) throw new Error('external_mcp_tool_not_registered');
    if (!(await this.isEnabled(serverId))) {
      throw new Error('external_mcp_server_disabled');
    }
    let connection: ExternalMcpConnection | undefined;
    try {
      connection = await this.connect(server, signal);
      const result = await connection.callTool(
        { name: toolName, arguments: argumentsValue },
        { signal, timeout: this.timeoutMs },
      );
      const record = objectValue(result);
      if (record.isError === true) throw new Error('external_mcp_tool_error');
      return result;
    } finally {
      await connection?.close().catch(() => undefined);
    }
  }
}

export function externalMcpRegistryFromJson(
  value: string | undefined,
  options?: ExternalMcpRegistryOptions,
): ExternalMcpRegistry | undefined {
  const servers = parseExternalMcpServersJson(value);
  return servers.length ? new ExternalMcpRegistry(servers, options) : undefined;
}
