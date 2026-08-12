import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ScopedFileMemoryStore } from '@opentag/memory';
import { createOpenTagToolBroker } from '@opentag/tool-broker';

function runRequest(events) {
  return {
    runId: 'broker-run-1',
    workspace: { id: 'acme', name: 'Acme' },
    project: {
      id: 'acme:payments',
      workspaceId: 'acme',
      key: 'payments',
      name: 'Payments',
    },
    thread: {
      id: 'lark:payments:root',
      platform: 'lark',
      externalId: 'payments:root',
      workspaceId: 'acme',
      projectId: 'acme:payments',
      visibility: 'public',
    },
    message: {
      id: 'message-1',
      threadId: 'lark:payments:root',
      platform: 'lark',
      text: 'Check the project resources.',
      actor: { id: 'user-1', displayName: 'Ada' },
      createdAt: new Date().toISOString(),
      mentionsAgent: true,
    },
    identity: {
      id: 'payments-agent',
      displayName: 'Payments Copilot',
      instructions: 'Own payment incidents.',
      defaultExecutorId: 'codex',
    },
    access: {
      id: 'access-1',
      threadId: 'lark:payments:root',
      workspaceId: 'acme',
      projectId: 'acme:payments',
      grants: [
        {
          id: 'memory:global',
          kind: 'memory',
          scope: 'global',
          label: 'Global memory',
          constraints: { permissions: ['read'] },
        },
        {
          id: 'memory:project',
          kind: 'memory',
          scope: 'project',
          label: 'Project memory',
          constraints: { permissions: ['read', 'write'] },
        },
        {
          id: 'github',
          kind: 'github',
          scope: 'project',
          label: 'GitHub',
          constraints: { repositories: ['acme/payments'] },
        },
        {
          id: 'lark-docs',
          kind: 'lark-docs',
          scope: 'project',
          label: 'Lark Docs',
          constraints: { documentIds: ['dox-approved'] },
        },
        {
          id: 'lark-base',
          kind: 'lark-base',
          scope: 'project',
          label: 'Lark Base',
          constraints: { appTokens: ['base-approved'] },
        },
      ],
      networkPolicy: { mode: 'deny-by-default', allowedHosts: [] },
    },
    memory: '',
    async onEvent(event) {
      events.push(event);
    },
  };
}

function textResult(result) {
  return result.content
    .filter((item) => item.type === 'text')
    .map((item) => item.text)
    .join('\n');
}

test('per-run MCP broker filters, authorizes, executes, and audits tools', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-broker-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const memory = new ScopedFileMemoryStore(root);
  const events = [];
  const larkCalls = [];
  const githubCalls = [];
  const broker = createOpenTagToolBroker({
    memory,
    lark: {
      async request(pathname, options) {
        larkCalls.push({ pathname, options });
        if (pathname.includes('/raw_content')) return { content: 'Approved plan' };
        return {
          items: [{ record_id: 'rec-1', fields: { Status: 'Open' } }],
          has_more: false,
          total: 1,
        };
      },
    },
    github: {
      token: 'host-only-token',
      async fetch(url, options) {
        githubCalls.push({ url: String(url), authorization: options.headers.authorization });
        return new Response(
          JSON.stringify({
            full_name: 'acme/payments',
            description: 'Payments service',
            private: true,
            default_branch: 'main',
            html_url: 'https://github.com/acme/payments',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      },
    },
  });
  const session = await broker.open(runRequest(events));
  assert.ok(session);
  context.after(() => session.close());

  const transport = new StdioClientTransport({
    command: session.mcp.command,
    args: session.mcp.args,
    env: session.mcp.env,
    stderr: 'pipe',
  });
  const client = new Client({ name: 'opentag-test', version: '0.1.0' });
  await client.connect(transport);
  context.after(() => client.close());

  const listed = await client.listTools();
  assert.deepEqual(
    listed.tools.map((tool) => tool.name).sort(),
    [
      'github_issues',
      'github_repository',
      'lark_base_records',
      'lark_doc_read',
      'memory_get',
      'memory_remember',
    ],
  );

  const remembered = await client.callTool({
    name: 'memory_remember',
    arguments: { scope: 'project', text: 'Retries use exponential backoff.' },
  });
  assert.equal(remembered.isError, undefined);
  const loaded = await client.callTool({
    name: 'memory_get',
    arguments: { scope: 'project' },
  });
  assert.match(textResult(loaded), /Retries use exponential backoff/);

  const deniedMemory = await client.callTool({
    name: 'memory_remember',
    arguments: { scope: 'global', text: 'Do not allow this.' },
  });
  assert.equal(deniedMemory.isError, true);
  assert.match(textResult(deniedMemory), /memory_global_write_not_granted/);

  const repository = await client.callTool({
    name: 'github_repository',
    arguments: { owner: 'acme', repo: 'payments' },
  });
  assert.match(textResult(repository), /Payments service/);
  assert.equal(githubCalls[0].authorization, 'Bearer host-only-token');

  const deniedRepository = await client.callTool({
    name: 'github_repository',
    arguments: { owner: 'other', repo: 'private' },
  });
  assert.equal(deniedRepository.isError, true);
  assert.equal(githubCalls.length, 1);

  const document = await client.callTool({
    name: 'lark_doc_read',
    arguments: { documentId: 'dox-approved' },
  });
  assert.match(textResult(document), /Approved plan/);
  assert.equal(larkCalls[0].options.query.lang, 0);

  const records = await client.callTool({
    name: 'lark_base_records',
    arguments: { appToken: 'base-approved', tableId: 'tbl-1', pageSize: 10 },
  });
  assert.match(textResult(records), /rec-1/);
  assert.equal(larkCalls[1].options.query.page_size, 10);

  assert.equal(events.filter((event) => event.type === 'tool_call').length, 7);
  assert.equal(events.filter((event) => event.type === 'tool_result').length, 7);
  assert.ok(
    events.some(
      (event) =>
        event.type === 'tool_result' &&
        event.call.name === 'github_repository' &&
        event.call.status === 'denied',
    ),
  );
});

test('broker rejects invalid arguments before provider execution', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-broker-schema-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const events = [];
  const session = await createOpenTagToolBroker({
    memory: new ScopedFileMemoryStore(root),
    github: { async fetch() { throw new Error('must_not_execute'); } },
  }).open(runRequest(events));
  assert.ok(session);
  context.after(() => session.close());
  const client = new Client({ name: 'opentag-schema-test', version: '0.1.0' });
  await client.connect(
    new StdioClientTransport({
      command: session.mcp.command,
      args: session.mcp.args,
      env: session.mcp.env,
      stderr: 'pipe',
    }),
  );
  context.after(() => client.close());

  const result = await client.callTool({
    name: 'github_repository',
    arguments: { owner: 'acme', repo: 'payments', unexpected: true },
  });
  assert.equal(result.isError, true);
  assert.match(textResult(result), /tool_arguments_invalid/);
});
