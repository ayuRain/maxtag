import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';

type JsonObject = Record<string, unknown>;

interface RemoteTool {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonObject;
}

interface RemoteToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: JsonObject;
  isError?: boolean;
}

const brokerUrl = process.env.OPENTAG_TOOL_BROKER_URL;
const brokerToken = process.env.OPENTAG_TOOL_BROKER_TOKEN;
if (!brokerUrl || !brokerToken) {
  throw new Error('OpenTag MCP proxy requires broker URL and token.');
}

async function brokerFetch(pathname: string, init?: RequestInit): Promise<JsonObject> {
  const response = await fetch(`${brokerUrl}${pathname}`, {
    ...init,
    headers: {
      ...Object.fromEntries(new Headers(init?.headers).entries()),
      authorization: `Bearer ${brokerToken}`,
      'content-type': 'application/json; charset=utf-8',
    },
  });
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = {};
  }
  if (!response.ok || !parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    const detail =
      parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? String((parsed as JsonObject).error || '')
        : text;
    throw new Error(`OpenTag tool broker HTTP ${response.status}: ${detail.slice(0, 300)}`);
  }
  return parsed as JsonObject;
}

const listed = await brokerFetch('/v1/tools');
const tools = Array.isArray(listed.tools) ? (listed.tools as RemoteTool[]) : [];
const names = new Set(tools.map((tool) => tool.name));
const server = new Server(
  { name: 'opentag', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: tools.map((tool) => ({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (!names.has(request.params.name)) {
    return {
      content: [{ type: 'text', text: 'tool_not_available' }],
      isError: true,
    };
  }
  try {
    const response = await brokerFetch('/v1/call', {
      method: 'POST',
      body: JSON.stringify({
        name: request.params.name,
        arguments: request.params.arguments || {},
      }),
    });
    return response.result as unknown as CallToolResult;
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: error instanceof Error ? error.message : String(error),
        },
      ],
      isError: true,
    };
  }
});

await server.connect(new StdioServerTransport());
