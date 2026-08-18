import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ScopedFileMemoryStore } from '@opentag/memory';
import { FileDeliveryStore } from '@opentag/delivery';
import { FileRoutineStore } from '@opentag/routines';
import { FileManagedConnectorStore } from '@opentag/config';
import {
  createOpenTagToolBroker,
  ExternalMcpRegistry,
  parseExternalMcpServersJson,
  toolApprovalArgumentDigest,
} from '@opentag/tool-broker';

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
          constraints: {
            repositories: ['acme/payments'],
            permissions: ['read', 'write'],
          },
        },
        {
          id: 'lark-docs',
          kind: 'lark-docs',
          scope: 'project',
          label: 'Lark Docs',
          constraints: {
            documentIds: ['dox-approved'],
            permissions: ['read', 'write'],
          },
        },
        {
          id: 'lark-base',
          kind: 'lark-base',
          scope: 'project',
          label: 'Lark Base',
          constraints: {
            appTokens: ['base-approved'],
            permissions: ['read', 'write'],
          },
        },
      ],
      networkPolicy: { mode: 'deny-by-default', allowedHosts: [] },
      memoryRetentionDays: { project: 30 },
    },
    memory: '',
    async onEvent(event) {
      events.push(event);
    },
  };
}

function approvalRunRequest(events) {
  const request = runRequest(events);
  request.access = {
    ...request.access,
    memoryApprovalPolicy: {
      mode: 'require_approval',
      scopes: ['project'],
      actions: ['remember'],
    },
    memoryRetentionDays: { project: 30 },
  };
  return request;
}

function textResult(result) {
  return result.content
    .filter((item) => item.type === 'text')
    .map((item) => item.text)
    .join('\n');
}

function externalMcpConfig() {
  return {
    id: 'linear',
    label: 'Linear MCP',
    description: 'Issue workflows through a deployment-managed MCP server.',
    command: '/deployment/linear-mcp',
    args: ['--stdio'],
    envRefs: { LINEAR_TOKEN: 'LINEAR_MCP_TOKEN' },
    tools: [
      { name: 'search_issues', risk: 'read', title: 'Search Linear issues' },
      { name: 'create_issue', risk: 'write', title: 'Create Linear issue' },
    ],
  };
}

function externalMcpGrant(permissions = ['read', 'write'], tools = ['search_issues', 'create_issue']) {
  return {
    id: 'mcp:linear',
    kind: 'mcp:linear',
    scope: 'project',
    label: 'Linear MCP',
    constraints: { permissions, tools },
  };
}

function externalMcpConnector(calls) {
  return async ({ server, env }) => {
    calls.connections.push({
      serverId: server.id,
      token: env.LINEAR_TOKEN,
      unrelatedSecret: env.UNRELATED_SECRET,
    });
    return {
      async listTools() {
        return {
          tools: [
            {
              name: 'search_issues',
              inputSchema: {
                type: 'object',
                additionalProperties: false,
                properties: { query: { type: 'string' } },
                required: ['query'],
              },
            },
            {
              name: 'create_issue',
              inputSchema: {
                type: 'object',
                additionalProperties: false,
                properties: { title: { type: 'string' } },
                required: ['title'],
              },
            },
            {
              name: 'server_added_without_policy',
              inputSchema: { type: 'object' },
            },
          ],
        };
      },
      async callTool(input) {
        calls.tools.push(input);
        return {
          content: [{ type: 'text', text: `remote:${input.name}` }],
          structuredContent: { ok: true, tool: input.name },
        };
      },
      async close() {
        calls.closed += 1;
      },
    };
  };
}

test('brokered GitHub tools resolve short-lived installation tokens lazily', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-broker-github-app-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  let tokenCalls = 0;
  let authorization;
  const broker = createOpenTagToolBroker({
    memory: new ScopedFileMemoryStore(root),
    github: {
      tokenProvider: {
        async getToken() {
          tokenCalls += 1;
          return 'ghs_broker';
        },
      },
      async fetch(_url, options) {
        authorization = options.headers.authorization;
        return new Response(JSON.stringify({
          full_name: 'acme/payments',
          private: true,
          default_branch: 'main',
        }), { status: 200 });
      },
    },
    async resolveCredentialIdentity(id) {
      assert.equal(id, 'github-default');
      return {
        id,
        displayName: 'GitHub installation identity',
        provider: 'github',
        revision: 1,
        github: {
          tokenProvider: {
            async getToken() {
              tokenCalls += 1;
              return 'ghs_broker';
            },
          },
        },
      };
    },
  });
  const request = runRequest([]);
  request.access.grants.find((grant) => grant.kind === 'github').credentialIdentityId =
    'github-default';
  const session = await broker.open(request);
  assert.ok(session);
  context.after(() => session.close());
  const client = new Client({ name: 'github-app-broker-test', version: '0.1.0' });
  await client.connect(new StdioClientTransport({
    command: session.mcp.command,
    args: session.mcp.args,
    env: session.mcp.env,
    stderr: 'pipe',
  }));
  context.after(() => client.close());

  const result = await client.callTool({
    name: 'github_repository',
    arguments: { owner: 'acme', repo: 'payments' },
  });
  assert.equal(result.isError, undefined);
  assert.equal(tokenCalls, 1);
  assert.equal(authorization, 'Bearer ghs_broker');
});

async function connectedClient(context, session, name = 'opentag-local-tool-test') {
  assert.ok(session);
  context.after(() => session.close());
  const client = new Client({ name, version: '0.1.0' });
  await client.connect(
    new StdioClientTransport({
      command: session.mcp.command,
      args: session.mcp.args,
      env: session.mcp.env,
      stderr: 'pipe',
    }),
  );
  context.after(() => client.close());
  return client;
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
      baseUrl: 'https://open.larksuite.test/open-apis',
      async request(pathname, options) {
        larkCalls.push({ pathname, options });
        if (pathname.includes('/raw_content')) return { content: 'Approved plan' };
        if (pathname.includes('/blocks/') && pathname.endsWith('/children')) {
          return { children: [{ block_id: 'block-new' }] };
        }
        if (pathname.endsWith('/records') && options.method === 'POST') {
          return { record: { record_id: 'rec-created', fields: options.body.fields } };
        }
        if (pathname.includes('/records/') && options.method === 'PUT') {
          return { record: { record_id: 'rec-updated', fields: options.body.fields } };
        }
        return {
          items: [{ record_id: 'rec-1', fields: { Status: 'Open' } }],
          has_more: false,
          total: 1,
        };
      },
    },
    github: {
      token: 'host-only-token',
      baseUrl: 'https://api.github.test/v3',
      async fetch(url, options) {
        githubCalls.push({
          url: String(url),
          method: options.method,
          body: options.body,
          authorization: options.headers.authorization,
        });
        if (options.method === 'POST' && String(url).endsWith('/issues')) {
          return new Response(
            JSON.stringify({ number: 42, title: 'Investigate retry spike', html_url: 'https://github.test/acme/payments/issues/42' }),
            { status: 201, headers: { 'content-type': 'application/json' } },
          );
        }
        if (options.method === 'POST' && String(url).endsWith('/issues/42/comments')) {
          return new Response(
            JSON.stringify({ id: 91, html_url: 'https://github.test/acme/payments/issues/42#issuecomment-91' }),
            { status: 201, headers: { 'content-type': 'application/json' } },
          );
        }
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
  const request = runRequest(events);
  const session = await broker.open(request);
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
      'github_issue_comment',
      'github_issue_create',
      'github_repository',
      'lark_base_record_create',
      'lark_base_record_update',
      'lark_base_records',
      'lark_doc_append_text',
      'lark_doc_read',
      'memory_get',
      'memory_remember',
      'memory_search',
    ].sort(),
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
  const expiry = await memory.getMemoryExpiry({
    thread: request.thread,
    workspace: request.workspace,
    project: request.project,
    scope: 'project',
  });
  assert.equal(expiry.entries.length, 1);
  assert.equal(expiry.entries[0].source, 'tool-broker:broker-run-1');
  assert.ok(
    Date.parse(expiry.entries[0].expiresAt) >= Date.now() + 29 * 24 * 60 * 60 * 1_000,
  );
  const searched = await client.callTool({
    name: 'memory_search',
    arguments: { scope: 'project', query: 'exponential backoff' },
  });
  assert.equal(searched.isError, undefined);
  assert.match(textResult(searched), /Retries use exponential backoff/);

  const deniedMemory = await client.callTool({
    name: 'memory_remember',
    arguments: { scope: 'global', text: 'Do not allow this.' },
  });
  assert.equal(deniedMemory.isError, true);
  assert.match(textResult(deniedMemory), /tool_arguments_invalid/);

  const repository = await client.callTool({
    name: 'github_repository',
    arguments: { owner: 'acme', repo: 'payments' },
  });
  assert.match(textResult(repository), /Payments service/);
  assert.equal(githubCalls[0].authorization, 'Bearer host-only-token');

  const issue = await client.callTool({
    name: 'github_issue_create',
    arguments: {
      owner: 'acme',
      repo: 'payments',
      title: 'Investigate retry spike',
      body: 'Observed after deploy.',
      labels: ['incident'],
    },
  });
  assert.match(textResult(issue), /"number": 42/);
  assert.deepEqual(JSON.parse(githubCalls[1].body), {
    title: 'Investigate retry spike',
    body: 'Observed after deploy.',
    labels: ['incident'],
  });

  const comment = await client.callTool({
    name: 'github_issue_comment',
    arguments: {
      owner: 'acme',
      repo: 'payments',
      issueNumber: 42,
      body: 'Rollback window is 15 minutes.',
    },
  });
  assert.match(textResult(comment), /issuecomment-91/);

  const deniedRepository = await client.callTool({
    name: 'github_repository',
    arguments: { owner: 'other', repo: 'private' },
  });
  assert.equal(deniedRepository.isError, true);
  assert.equal(githubCalls.length, 3);

  const document = await client.callTool({
    name: 'lark_doc_read',
    arguments: { documentId: 'dox-approved' },
  });
  assert.match(textResult(document), /Approved plan/);
  assert.equal(larkCalls[0].options.query.lang, 0);

  const appended = await client.callTool({
    name: 'lark_doc_append_text',
    arguments: { documentId: 'dox-approved', text: 'Decision: roll back.' },
  });
  assert.match(textResult(appended), /block-new/);
  assert.equal(larkCalls[1].options.method, 'POST');

  const records = await client.callTool({
    name: 'lark_base_records',
    arguments: { appToken: 'base-approved', tableId: 'tbl-1', pageSize: 10 },
  });
  assert.match(textResult(records), /rec-1/);
  assert.equal(larkCalls[2].options.query.page_size, 10);

  const createdRecord = await client.callTool({
    name: 'lark_base_record_create',
    arguments: {
      appToken: 'base-approved',
      tableId: 'tbl-1',
      fields: { Status: 'Open', Owner: 'Ada' },
    },
  });
  assert.match(textResult(createdRecord), /rec-created/);

  const updatedRecord = await client.callTool({
    name: 'lark_base_record_update',
    arguments: {
      appToken: 'base-approved',
      tableId: 'tbl-1',
      recordId: 'rec-created',
      fields: { Status: 'Closed' },
    },
  });
  assert.match(textResult(updatedRecord), /rec-updated/);

  assert.equal(events.filter((event) => event.type === 'tool_call').length, 13);
  assert.equal(events.filter((event) => event.type === 'tool_result').length, 13);
  assert.ok(
    events.some(
      (event) =>
        event.type === 'tool_result' &&
        event.call.name === 'github_repository' &&
        event.call.status === 'denied',
    ),
  );
  const successfulGitHub = events.find(
    (event) =>
      event.type === 'tool_result' &&
      event.call.name === 'github_repository' &&
      event.call.status === 'succeeded',
  );
  assert.equal(successfulGitHub.call.destination, 'https://api.github.test');
  assert.equal(
    events.find(
      (event) =>
        event.type === 'tool_result' &&
        event.call.name === 'github_issue_create' &&
        event.call.status === 'succeeded',
    ).call.resultUrl,
    'https://github.test/acme/payments/issues/42',
  );
  assert.equal(
    events.find(
      (event) =>
        event.type === 'tool_result' &&
        event.call.name === 'github_issue_comment' &&
        event.call.status === 'succeeded',
    ).call.resultUrl,
    'https://github.test/acme/payments/issues/42#issuecomment-91',
  );
  assert.equal(
    events.find(
      (event) =>
        event.type === 'tool_result' &&
        event.call.name === 'lark_doc_append_text' &&
        event.call.status === 'succeeded',
    ).call.resultUrl,
    'https://www.larksuite.com/docx/dox-approved',
  );
  const deniedGitHub = events.find(
    (event) =>
      event.type === 'tool_result' &&
      event.call.name === 'github_repository' &&
      event.call.status === 'denied',
  );
  assert.equal(deniedGitHub.call.destination, undefined);
  assert.ok(
    events
      .filter(
        (event) =>
          event.type === 'tool_result' && event.call.name.startsWith('lark_'),
      )
      .every(
        (event) => event.call.destination === 'https://open.larksuite.test',
      ),
  );
  assert.equal(JSON.stringify(events).includes('/repos/acme/payments'), false);
});

test('memory write tool honors approval policy instead of writing directly', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-broker-approval-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const memory = new ScopedFileMemoryStore(root);
  const events = [];
  const broker = createOpenTagToolBroker({ memory });
  const request = approvalRunRequest(events);
  const session = await broker.open(request);
  assert.ok(session);
  context.after(() => session.close());
  const transport = new StdioClientTransport({
    command: session.mcp.command,
    args: session.mcp.args,
    env: session.mcp.env,
    stderr: 'pipe',
  });
  const client = new Client({ name: 'opentag-approval-test', version: '0.1.0' });
  await client.connect(transport);
  context.after(() => client.close());

  const result = await client.callTool({
    name: 'memory_remember',
    arguments: { scope: 'project', text: 'Approval is required for this fact.' },
  });
  assert.equal(result.isError, undefined);
  assert.match(textResult(result), /"proposed": true/u);
  const snapshot = await memory.loadMemory({
    thread: request.thread,
    workspace: request.workspace,
    project: request.project,
    scopes: ['project'],
  });
  assert.equal(snapshot.scopes[0].content, '');
  const proposals = await memory.listMemoryProposals({
    workspaceId: request.workspace.id,
    projectId: request.project.id,
    status: 'pending',
  });
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].value, 'Approval is required for this fact.');
  assert.equal(proposals[0].retentionDays, 30);
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

test('broker uses the route-bound credential identity and audits the external actor', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-broker-identity-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const events = [];
  const calls = [];
  const request = runRequest(events);
  request.access.grants.find((grant) => grant.kind === 'github').credentialIdentityId =
    'github-payments';
  const broker = createOpenTagToolBroker({
    memory: new ScopedFileMemoryStore(root),
    async resolveCredentialIdentity(id) {
      if (id !== 'github-payments') return undefined;
      return {
        id,
        displayName: 'GitHub Payments',
        provider: 'github',
        revision: 3,
        externalActor: 'opentag-payments[bot]',
        github: {
          token: 'identity-only-token',
          baseUrl: 'https://api.github.identity/v3',
          async fetch(url, options) {
            calls.push({
              url: String(url),
              authorization: options.headers.authorization,
            });
            return new Response(
              JSON.stringify({
                full_name: 'acme/payments',
                description: 'Identity-scoped repository',
              }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            );
          },
        },
      };
    },
  });
  const session = await broker.open(request);
  assert.ok(session);
  context.after(() => session.close());
  const client = new Client({ name: 'opentag-identity-test', version: '0.1.0' });
  await client.connect(new StdioClientTransport({
    command: session.mcp.command,
    args: session.mcp.args,
    env: session.mcp.env,
    stderr: 'pipe',
  }));
  context.after(() => client.close());

  const result = await client.callTool({
    name: 'github_repository',
    arguments: { owner: 'acme', repo: 'payments' },
  });
  assert.match(textResult(result), /Identity-scoped repository/u);
  assert.equal(calls[0].authorization, 'Bearer identity-only-token');
  const audit = events.find(
    (event) =>
      event.type === 'tool_result' &&
      event.call.name === 'github_repository' &&
      event.call.status === 'succeeded',
  ).call;
  assert.equal(audit.agentIdentityId, 'payments-agent');
  assert.equal(audit.credentialIdentityId, 'github-payments');
  assert.equal(audit.credentialIdentityRevision, 3);
  assert.equal(audit.externalActor, 'opentag-payments[bot]');
  assert.equal(audit.destination, 'https://api.github.identity');
  assert.equal(JSON.stringify(events).includes('identity-only-token'), false);
});

test('approved writes fail when the credential identity revision changes', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-broker-identity-fence-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const approvals = new FileDeliveryStore(path.join(root, 'delivery'));
  const providerCalls = [];
  let revision = 1;
  const broker = createOpenTagToolBroker({
    memory: new ScopedFileMemoryStore(path.join(root, 'memory')),
    approvalStore: approvals,
    async resolveCredentialIdentity(id) {
      return {
        id,
        displayName: 'GitHub Payments',
        provider: 'github',
        revision,
        externalActor: 'opentag-payments[bot]',
        github: {
          token: `token-r${revision}`,
          async fetch() {
            providerCalls.push(revision);
            return new Response('{}', { status: 201 });
          },
        },
      };
    },
  });
  const request = runRequest([]);
  request.access.grants.find((grant) => grant.kind === 'github').credentialIdentityId =
    'github-payments';
  request.access.toolApprovalPolicy = { mode: 'require_approval', risks: ['write'] };
  const session = await broker.open(request);
  assert.ok(session);
  context.after(() => session.close());
  const client = new Client({ name: 'opentag-identity-fence-test', version: '0.1.0' });
  await client.connect(new StdioClientTransport({
    command: session.mcp.command,
    args: session.mcp.args,
    env: session.mcp.env,
    stderr: 'pipe',
  }));
  context.after(() => client.close());

  const pending = await client.callTool({
    name: 'github_issue_create',
    arguments: { owner: 'acme', repo: 'payments', title: 'Fence identity' },
  });
  assert.match(textResult(pending), /pendingApproval/u);
  const [approval] = await approvals.listToolApprovals({ status: 'pending' });
  assert.equal(approval.credentialIdentityId, 'github-payments');
  assert.equal(approval.credentialIdentityRevision, 1);
  await approvals.approveToolApproval({ id: approval.id, actorId: 'operator:ada' });
  revision = 2;
  const result = await broker.executeApproved({
    approvalId: approval.id,
    request,
    claimedBy: 'worker-a',
  });
  assert.equal(result.executed, true);
  assert.equal(result.approval.status, 'failed');
  assert.equal(result.approval.error, 'tool_approval_credential_identity_changed');
  assert.deepEqual(providerCalls, []);
});

test('external MCP registry exposes only project-granted deployment tools without leaking secrets', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-external-mcp-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const calls = { connections: [], tools: [], closed: 0 };
  const registry = new ExternalMcpRegistry([externalMcpConfig()], {
    environment: {
      LINEAR_MCP_TOKEN: 'host-only-linear-token',
      UNRELATED_SECRET: 'must-not-be-inherited',
    },
    connector: externalMcpConnector(calls),
  });
  const broker = createOpenTagToolBroker({
    memory: new ScopedFileMemoryStore(root),
    externalMcp: registry,
  });
  assert.deepEqual(broker.catalog().find((item) => item.grantKind === 'mcp:linear'), {
    grantKind: 'mcp:linear',
    label: 'Linear MCP',
    description: 'Issue workflows through a deployment-managed MCP server.',
    toolCount: 2,
    writeToolCount: 1,
    tools: [
      { name: 'search_issues', risk: 'read' },
      { name: 'create_issue', risk: 'write' },
    ],
    providerStatus: 'configured',
    constraints: [
      {
        key: 'tools',
        label: 'Allowed MCP tools',
        placeholder: 'search_issues, create_issue',
        allowedValues: ['search_issues', 'create_issue'],
      },
    ],
  });

  const events = [];
  const request = runRequest(events);
  request.access.grants.push(externalMcpGrant(['read'], ['search_issues']));
  const session = await broker.open(request);
  assert.ok(session);
  context.after(() => session.close());
  assert.equal(JSON.stringify(session).includes('host-only-linear-token'), false);
  const client = new Client({ name: 'external-mcp-test', version: '0.1.0' });
  await client.connect(
    new StdioClientTransport({
      command: session.mcp.command,
      args: session.mcp.args,
      env: session.mcp.env,
      stderr: 'pipe',
    }),
  );
  context.after(() => client.close());

  const names = (await client.listTools()).tools.map((tool) => tool.name);
  const searchTool = names.find((name) => name.endsWith('_search_issues'));
  assert.match(searchTool, /^mcp_linear_[a-f0-9]{8}_search_issues$/u);
  assert.equal(names.some((name) => name.endsWith('_create_issue')), false);
  assert.equal(
    names.some((name) => name.endsWith('_server_added_without_policy')),
    false,
  );
  const result = await client.callTool({
    name: searchTool,
    arguments: { query: 'incident' },
  });
  assert.match(textResult(result), /remote:search_issues/u);
  assert.deepEqual(calls.tools, [
    { name: 'search_issues', arguments: { query: 'incident' } },
  ]);
  assert.ok(calls.connections.every((item) => item.token === 'host-only-linear-token'));
  assert.ok(calls.connections.every((item) => item.unrelatedSecret === undefined));
  assert.equal(JSON.stringify(events).includes('host-only-linear-token'), false);
  assert.ok(
    events.some(
      (event) =>
        event.type === 'tool_result' &&
        event.call.name === searchTool &&
        event.call.provider === 'mcp:linear' &&
        event.call.destination === 'mcp+stdio://linear' &&
        event.call.arguments.argumentShape.query.characters === 8 &&
        event.call.resultPreview === 'Search Linear issues completed',
    ),
  );
});

test('external MCP registry enforces shared disable state across server and worker instances while allowing health checks', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-external-mcp-state-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const calls = { connections: [], tools: [], closed: 0 };
  const serverStore = new FileManagedConnectorStore(root);
  const workerStore = new FileManagedConnectorStore(root);
  await serverStore.setEnabled({ id: 'linear', enabled: false, expectedRevision: 0 });
  const serverRegistry = new ExternalMcpRegistry([externalMcpConfig()], {
    environment: { LINEAR_MCP_TOKEN: 'host-only-linear-token' },
    connector: externalMcpConnector(calls),
    stateStore: serverStore,
  });
  const workerRegistry = new ExternalMcpRegistry([externalMcpConfig()], {
    environment: { LINEAR_MCP_TOKEN: 'host-only-linear-token' },
    connector: externalMcpConnector(calls),
    stateStore: workerStore,
  });

  const disabled = await workerRegistry.discover(['linear']);
  assert.deepEqual(disabled.tools, []);
  assert.deepEqual(disabled.disabledServerIds, ['linear']);
  await assert.rejects(
    workerRegistry.callTool('linear', 'search_issues', { query: 'incident' }),
    /external_mcp_server_disabled/u,
  );
  const health = await serverRegistry.check('linear');
  assert.equal(health.status, 'ready');
  assert.equal(health.toolCount, 2);
  assert.equal(calls.tools.length, 0);

  await serverStore.setEnabled({ id: 'linear', enabled: true, expectedRevision: 1 });
  const available = await workerRegistry.discover(['linear']);
  assert.equal(available.tools.length, 2);
  assert.deepEqual(available.disabledServerIds, []);
});

test('external MCP write uses exact durable approval and rechecks project grants', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-external-mcp-approval-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const calls = { connections: [], tools: [], closed: 0 };
  const approvals = new FileDeliveryStore(path.join(root, 'delivery'));
  const broker = createOpenTagToolBroker({
    memory: new ScopedFileMemoryStore(path.join(root, 'memory')),
    approvalStore: approvals,
    externalMcp: new ExternalMcpRegistry([externalMcpConfig()], {
      environment: { LINEAR_MCP_TOKEN: 'host-only-linear-token' },
      connector: externalMcpConnector(calls),
    }),
  });
  const request = runRequest([]);
  request.access.grants.push(externalMcpGrant());
  request.access.toolApprovalPolicy = {
    mode: 'require_approval',
    risks: ['write'],
  };
  const session = await broker.open(request);
  assert.ok(session);
  context.after(() => session.close());
  const client = new Client({ name: 'external-mcp-approval-test', version: '0.1.0' });
  await client.connect(
    new StdioClientTransport({
      command: session.mcp.command,
      args: session.mcp.args,
      env: session.mcp.env,
      stderr: 'pipe',
    }),
  );
  context.after(() => client.close());

  const createTool = (await client.listTools()).tools
    .map((tool) => tool.name)
    .find((name) => name.endsWith('_create_issue'));
  assert.match(createTool, /^mcp_linear_[a-f0-9]{8}_create_issue$/u);
  const pending = await client.callTool({
    name: createTool,
    arguments: { title: 'Approved only once' },
  });
  assert.match(textResult(pending), /pendingApproval/u);
  assert.equal(calls.tools.length, 0);
  const [approval] = await approvals.listToolApprovals({ status: 'pending' });
  assert.equal(approval.grantKind, 'mcp:linear');
  assert.deepEqual(approval.arguments, { title: 'Approved only once' });
  await approvals.approveToolApproval({ id: approval.id, actorId: 'operator:ada' });
  const attempts = await Promise.all([
    broker.executeApproved({ approvalId: approval.id, request, claimedBy: 'worker-a' }),
    broker.executeApproved({ approvalId: approval.id, request, claimedBy: 'worker-b' }),
  ]);
  assert.equal(attempts.filter((attempt) => attempt.executed).length, 1);
  assert.equal(calls.tools.length, 1);
  assert.deepEqual(calls.tools[0], {
    name: 'create_issue',
    arguments: { title: 'Approved only once' },
  });

  const revoked = await approvals.proposeToolApproval({
    runId: 'revoked-external-run',
    toolCallId: 'revoked-external-call',
    toolName: createTool,
    title: 'Create Linear issue',
    grantKind: 'mcp:linear',
    risk: 'write',
    arguments: { title: 'Revoked before execution' },
    argumentSummary: { title: 'Revoked before execution' },
    argumentDigest: toolApprovalArgumentDigest(createTool, {
      title: 'Revoked before execution',
    }),
    thread: request.thread,
    requestedBy: 'agent:test',
  });
  await approvals.approveToolApproval({ id: revoked.id, actorId: 'operator:ada' });
  const revokedRequest = {
    ...request,
    runId: 'revoked-external-run',
    access: {
      ...request.access,
      grants: request.access.grants.filter((grant) => grant.kind !== 'mcp:linear'),
    },
  };
  const revokedResult = await broker.executeApproved({
    approvalId: revoked.id,
    request: revokedRequest,
    claimedBy: 'worker-c',
  });
  assert.equal(revokedResult.approval.status, 'failed');
  assert.equal(revokedResult.approval.error, 'approved_tool_not_available');
  assert.equal(calls.tools.length, 1);
});

test('external MCP config is strict and only stores environment references', () => {
  const [server] = parseExternalMcpServersJson(
    JSON.stringify({ servers: [externalMcpConfig()] }),
  );
  assert.equal(server.envRefs.LINEAR_TOKEN, 'LINEAR_MCP_TOKEN');
  assert.equal(JSON.stringify(server).includes('host-only-linear-token'), false);
  assert.throws(
    () =>
      parseExternalMcpServersJson(
        JSON.stringify({
          servers: [
            {
              ...externalMcpConfig(),
              tools: [
                ...externalMcpConfig().tools,
                { name: 'unclassified', risk: 'unknown' },
              ],
            },
          ],
        }),
      ),
    /external_mcp_invalid_tool_risk/u,
  );
  assert.throws(
    () =>
      parseExternalMcpServersJson(
        JSON.stringify({ servers: [{ ...externalMcpConfig(), token: 'inline-secret' }] }),
      ),
    /external_mcp_unknown_field/u,
  );
});

test('brokered standing work creates a thread-bound one-time follow-up only after approval', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-routine-tools-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const approvals = new FileDeliveryStore(path.join(root, 'delivery'));
  const routines = new FileRoutineStore(path.join(root, 'routines'));
  const events = [];
  const broker = createOpenTagToolBroker({
    memory: new ScopedFileMemoryStore(path.join(root, 'memory')),
    approvalStore: approvals,
    routines,
  });
  const request = runRequest(events);
  request.access.grants.push({
    id: 'routines',
    kind: 'routines',
    scope: 'project',
    label: 'Standing work',
    constraints: { permissions: ['read', 'write'] },
  });
  request.access.toolApprovalPolicy = {
    mode: 'require_approval',
    risks: ['write'],
  };
  const session = await broker.open(request);
  assert.ok(session);
  context.after(() => session.close());
  const client = new Client({ name: 'routine-tools-test', version: '0.1.0' });
  await client.connect(
    new StdioClientTransport({
      command: session.mcp.command,
      args: session.mcp.args,
      env: session.mcp.env,
      stderr: 'pipe',
    }),
  );
  context.after(() => client.close());

  const toolNames = (await client.listTools()).tools.map((tool) => tool.name);
  assert.ok(toolNames.includes('routine_list'));
  assert.ok(toolNames.includes('routine_create'));
  assert.ok(toolNames.includes('routine_pause'));
  const exactArguments = {
    name: 'Release follow-up',
    instructions: `Check the release and report blockers in this thread. ${'detail '.repeat(400)}`,
    schedule: { kind: 'once', at: '2099-08-14T09:00:00+08:00' },
    notificationMode: 'failures_only',
    failureThreshold: 2,
    recoveryNotification: true,
  };
  const pending = await client.callTool({
    name: 'routine_create',
    arguments: exactArguments,
  });
  assert.match(textResult(pending), /pendingApproval/u);
  assert.equal((await routines.listRoutines()).length, 0);
  const [approval] = await approvals.listToolApprovals({ status: 'pending' });
  assert.deepEqual(approval.arguments, exactArguments);
  await approvals.approveToolApproval({ id: approval.id, actorId: 'operator:ada' });
  const executed = await broker.executeApproved({
    approvalId: approval.id,
    request,
    claimedBy: 'routine-worker',
  });
  assert.equal(executed.approval.status, 'succeeded');
  const [routine] = await routines.listRoutines();
  assert.equal(routine.createdBy, 'agent:payments-agent');
  assert.equal(routine.destination.threadId, request.thread.id);
  assert.equal(routine.destination.externalId, request.thread.externalId);
  assert.equal(routine.schedule.kind, 'once');
  assert.equal(routine.notifications.mode, 'failures_only');
  assert.equal(routine.notifications.failureThreshold, 2);
  const execution = await routines.triggerRoutine(routine.id, 'operator:test');
  await routines.markExecutionQueued(execution.id, 'routine-tool-run');
  await routines.reconcileRun({
    runId: 'routine-tool-run',
    status: 'completed',
    summary: `Release is ready. ${'bounded '.repeat(60)}`,
  });
  const listed = await client.callTool({
    name: 'routine_list',
    arguments: { limit: 1 },
  });
  const listedBody = JSON.parse(textResult(listed));
  assert.equal(listedBody.routines[0].name, 'Release follow-up');
  assert.equal(listedBody.routines[0].recentExecutions.length, 1);
  assert.equal(listedBody.routines[0].recentExecutions[0].status, 'completed');
  assert.equal(listedBody.routines[0].recentExecutions[0].summary.length, 300);
  assert.equal(listedBody.routines[0].instructions.length, 2_000);
  assert.equal(listedBody.routines[0].instructionsTruncated, true);
  assert.equal(listedBody.routines[0].notifications.mode, 'failures_only');
  assert.equal(listedBody.total, 1);
  assert.equal(listedBody.truncated, false);
  assert.ok(
    events.some(
      (event) =>
        event.type === 'tool_result' &&
        event.call.name === 'routine_create' &&
        event.call.status === 'succeeded',
    ),
  );

  const foreign = await routines.upsertRoutine({
    workspaceId: request.thread.workspaceId,
    projectId: request.thread.projectId,
    name: 'Other topic routine',
    instructions: 'Must remain isolated.',
    schedule: { kind: 'interval', everyMinutes: 60 },
    destination: {
      platform: 'lark',
      externalId: 'other:topic',
      threadId: 'lark:other:topic',
      visibility: 'public',
    },
  });
  const denied = await client.callTool({
    name: 'routine_delete',
    arguments: { routineId: foreign.id },
  });
  assert.equal(denied.isError, true);
  assert.match(textResult(denied), /routine_not_available_in_thread/u);
  assert.equal(
    (await approvals.listToolApprovals({ runId: request.runId })).length,
    1,
  );
});

test('write tools are absent unless the resource grant explicitly permits writes', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-broker-readonly-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const input = runRequest([]);
  input.access.grants = input.access.grants.map((grant) =>
    ['github', 'lark-docs', 'lark-base'].includes(grant.kind)
      ? {
          ...grant,
          constraints: {
            ...grant.constraints,
            permissions: ['read'],
          },
        }
      : grant,
  );
  const session = await createOpenTagToolBroker({
    memory: new ScopedFileMemoryStore(root),
    github: { token: 'host-token', async fetch() { throw new Error('must_not_execute'); } },
    lark: { async request() { throw new Error('must_not_execute'); } },
  }).open(input);
  assert.ok(session);
  context.after(() => session.close());
  const client = new Client({ name: 'opentag-readonly-test', version: '0.1.0' });
  await client.connect(
    new StdioClientTransport({
      command: session.mcp.command,
      args: session.mcp.args,
      env: session.mcp.env,
      stderr: 'pipe',
    }),
  );
  context.after(() => client.close());

  const names = (await client.listTools()).tools.map((tool) => tool.name);
  assert.ok(names.includes('github_repository'));
  assert.ok(names.includes('lark_doc_read'));
  assert.ok(names.includes('lark_base_records'));
  assert.equal(names.some((name) => name.includes('create')), false);
  assert.equal(names.some((name) => name.includes('update')), false);
  assert.equal(names.some((name) => name.includes('append')), false);
  assert.equal(names.some((name) => name.includes('comment')), false);
});

test('external write approval executes exact arguments once after a durable decision', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-broker-tool-approval-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const approvals = new FileDeliveryStore(path.join(root, 'delivery'));
  const events = [];
  const providerCalls = [];
  const broker = createOpenTagToolBroker({
    memory: new ScopedFileMemoryStore(path.join(root, 'memory')),
    approvalStore: approvals,
    github: {
      token: 'host-only-token',
      async fetch(url, options) {
        providerCalls.push({ url: String(url), body: options.body });
        return new Response(
          JSON.stringify({
            number: 77,
            title: 'Exact approved issue',
            html_url: 'https://github.test/acme/payments/issues/77',
          }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        );
      },
    },
  });
  const request = runRequest(events);
  request.access.toolApprovalPolicy = {
    mode: 'require_approval',
    risks: ['write'],
  };
  const session = await broker.open(request);
  assert.ok(session);
  context.after(() => session.close());
  const client = new Client({ name: 'opentag-tool-approval-test', version: '0.1.0' });
  await client.connect(
    new StdioClientTransport({
      command: session.mcp.command,
      args: session.mcp.args,
      env: session.mcp.env,
      stderr: 'pipe',
    }),
  );
  context.after(() => client.close());

  const exactArguments = {
    owner: 'acme',
    repo: 'payments',
    title: 'Exact approved issue',
    body: 'Only this exact body may be sent.',
    labels: ['approved'],
  };
  const pending = await client.callTool({
    name: 'github_issue_create',
    arguments: exactArguments,
  });
  assert.equal(pending.isError, undefined);
  assert.match(textResult(pending), /pendingApproval/u);
  assert.equal(providerCalls.length, 0);

  const [approval] = await approvals.listToolApprovals({ status: 'pending' });
  assert.ok(approval);
  assert.deepEqual(approval.arguments, exactArguments);
  assert.equal(
    approval.argumentDigest,
    toolApprovalArgumentDigest('github_issue_create', exactArguments),
  );
  await approvals.approveToolApproval({ id: approval.id, actorId: 'operator:ada' });
  const attempts = await Promise.all([
    broker.executeApproved({
      approvalId: approval.id,
      request,
      claimedBy: 'worker-a',
    }),
    broker.executeApproved({
      approvalId: approval.id,
      request,
      claimedBy: 'worker-b',
    }),
  ]);
  assert.equal(attempts.filter((attempt) => attempt.executed).length, 1);
  assert.equal(providerCalls.length, 1);
  assert.deepEqual(JSON.parse(providerCalls[0].body), {
    title: exactArguments.title,
    body: exactArguments.body,
    labels: exactArguments.labels,
  });
  const completedApproval = await approvals.getToolApproval(approval.id);
  assert.equal(completedApproval.status, 'succeeded');
  assert.equal(
    completedApproval.resultUrl,
    'https://github.test/acme/payments/issues/77',
  );
  assert.ok(
    events.some(
      (event) =>
        event.type === 'tool_result' &&
        event.call.status === 'succeeded' &&
        event.call.resultUrl === 'https://github.test/acme/payments/issues/77',
    ),
  );
  const replay = await broker.executeApproved({
    approvalId: approval.id,
    request,
    claimedBy: 'worker-c',
  });
  assert.equal(replay.executed, false);
  assert.equal(providerCalls.length, 1);
  const modelReplay = await client.callTool({
    name: 'github_issue_create',
    arguments: exactArguments,
  });
  assert.equal(modelReplay.isError, undefined);
  assert.match(textResult(modelReplay), /"status":"succeeded"/u);
  assert.match(textResult(modelReplay), /github\.test\/acme\/payments\/issues\/77/u);
  assert.equal((await approvals.listToolApprovals({ runId: request.runId })).length, 1);
  assert.equal(providerCalls.length, 1);
  assert.ok(
    events.some(
      (event) =>
        event.type === 'tool_result' &&
        event.call.status === 'pending_approval',
    ),
  );
});

test('approved writes fail closed when exact arguments or current grants differ', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-broker-approval-guard-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const approvals = new FileDeliveryStore(path.join(root, 'delivery'));
  let providerCalls = 0;
  const broker = createOpenTagToolBroker({
    memory: new ScopedFileMemoryStore(path.join(root, 'memory')),
    approvalStore: approvals,
    github: {
      token: 'host-only-token',
      async fetch() {
        providerCalls += 1;
        throw new Error('must_not_execute');
      },
    },
  });
  const request = runRequest([]);
  const exactArguments = {
    owner: 'acme',
    repo: 'payments',
    title: 'Do not execute',
  };
  const tampered = await approvals.proposeToolApproval({
    runId: request.runId,
    toolCallId: 'tampered-call',
    toolName: 'github_issue_create',
    title: 'Create GitHub issue',
    grantKind: 'github',
    risk: 'write',
    arguments: exactArguments,
    argumentSummary: exactArguments,
    argumentDigest: toolApprovalArgumentDigest('github_issue_create', {
      ...exactArguments,
      title: 'Different title',
    }),
    thread: request.thread,
    requestedBy: 'agent:test',
  });
  await approvals.approveToolApproval({ id: tampered.id, actorId: 'operator:ada' });
  const tamperedResult = await broker.executeApproved({
    approvalId: tampered.id,
    request,
    claimedBy: 'worker-a',
  });
  assert.equal(tamperedResult.approval.status, 'failed');
  assert.equal(tamperedResult.approval.error, 'tool_approval_arguments_changed');

  const revoked = await approvals.proposeToolApproval({
    runId: request.runId,
    toolCallId: 'revoked-call',
    toolName: 'github_issue_create',
    title: 'Create GitHub issue',
    grantKind: 'github',
    risk: 'write',
    arguments: exactArguments,
    argumentSummary: exactArguments,
    argumentDigest: toolApprovalArgumentDigest('github_issue_create', exactArguments),
    thread: request.thread,
    requestedBy: 'agent:test',
  });
  await approvals.approveToolApproval({ id: revoked.id, actorId: 'operator:ada' });
  request.access.grants = request.access.grants.map((grant) =>
    grant.kind === 'github'
      ? {
          ...grant,
          constraints: { ...grant.constraints, permissions: ['read'] },
        }
      : grant,
  );
  const revokedResult = await broker.executeApproved({
    approvalId: revoked.id,
    request,
    claimedBy: 'worker-b',
  });
  assert.equal(revokedResult.approval.status, 'failed');
  assert.equal(revokedResult.approval.error, 'github_resource_not_allowed');
  assert.equal(providerCalls, 0);
});

test('workspace broker isolates project paths and performs digest-guarded file writes inside the sandbox', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-workspace-tools-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = path.join(root, 'payments');
  const foreign = path.join(root, 'foreign');
  await fs.mkdir(path.join(project, 'src'), { recursive: true });
  await fs.mkdir(foreign);
  await fs.writeFile(path.join(project, 'src', 'index.ts'), 'export const value = 1;\n');
  await fs.chmod(path.join(project, 'src', 'index.ts'), 0o755);
  await fs.writeFile(path.join(foreign, 'secret.txt'), 'must-not-read\n');
  await fs.symlink(foreign, path.join(project, 'linked'));
  const approvals = new FileDeliveryStore(path.join(root, 'delivery'));
  const broker = createOpenTagToolBroker({
    memory: new ScopedFileMemoryStore(path.join(root, 'memory')),
    approvalStore: approvals,
    workspaceRoot: root,
  });
  const request = runRequest([]);
  request.access.grants.push({
    id: 'shell',
    kind: 'shell',
    scope: 'project',
    label: 'Workspace',
    constraints: {
      permissions: ['read', 'write'],
      commands: [path.basename(process.execPath)],
    },
  });
  request.access.toolApprovalPolicy = {
    mode: 'require_approval',
    risks: ['write'],
  };
  const client = await connectedClient(context, await broker.open(request));
  const names = (await client.listTools()).tools.map((tool) => tool.name);
  assert.ok(names.includes('workspace_list'));
  assert.ok(names.includes('workspace_capabilities'));
  assert.ok(names.includes('workspace_read'));
  assert.ok(names.includes('workspace_search'));
  assert.ok(names.includes('workspace_write'));
  assert.ok(names.includes('workspace_run'));

  const listed = JSON.parse(
    textResult(await client.callTool({ name: 'workspace_list', arguments: { depth: 3 } })),
  );
  assert.ok(listed.entries.some((entry) => entry.path === 'src/index.ts'));
  assert.equal(JSON.stringify(listed).includes('secret.txt'), false);
  const read = JSON.parse(
    textResult(await client.callTool({ name: 'workspace_read', arguments: { path: 'src/index.ts' } })),
  );
  assert.match(read.content, /export const value = 1/u);
  assert.match(read.sha256, /^[a-f0-9]{64}$/u);
  const searched = JSON.parse(
    textResult(await client.callTool({ name: 'workspace_search', arguments: { query: 'value = 1' } })),
  );
  assert.equal(searched.matches[0].path, 'src/index.ts');
  const escaped = await client.callTool({
    name: 'workspace_read',
    arguments: { path: '../foreign/secret.txt' },
  });
  assert.equal(escaped.isError, true);
  assert.match(textResult(escaped), /workspace_path_outside_project/u);
  const symlinked = await client.callTool({
    name: 'workspace_read',
    arguments: { path: 'linked/secret.txt' },
  });
  assert.equal(symlinked.isError, true);
  assert.match(textResult(symlinked), /workspace_symlink_not_allowed/u);

  const exactArguments = {
    path: 'src/index.ts',
    content: 'export const value = 2;\n',
    expectedSha256: read.sha256,
  };
  const written = await client.callTool({
    name: 'workspace_write',
    arguments: exactArguments,
  });
  assert.equal(written.isError, undefined);
  assert.equal(
    await fs.readFile(path.join(project, 'src', 'index.ts'), 'utf8'),
    exactArguments.content,
  );
  assert.equal(
    (await fs.stat(path.join(project, 'src', 'index.ts'))).mode & 0o777,
    0o755,
  );

  const stale = await client.callTool({
    name: 'workspace_write',
    arguments: {
      ...exactArguments,
      content: 'export const value = 3;\n',
    },
  });
  assert.equal(stale.isError, true);
  assert.match(textResult(stale), /workspace_write_precondition_failed/u);
  assert.equal((await approvals.listToolApprovals({ status: 'pending' })).length, 0);
});

test('workspace commands follow project approval policy and recheck their allowlist', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-workspace-command-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'payments'));
  const approvals = new FileDeliveryStore(path.join(root, 'delivery'));
  const broker = createOpenTagToolBroker({
    memory: new ScopedFileMemoryStore(path.join(root, 'memory')),
    approvalStore: approvals,
    workspaceRoot: root,
  });
  const events = [];
  const request = runRequest(events);
  request.access.grants.push({
    id: 'shell',
    kind: 'shell',
    scope: 'project',
    label: 'Workspace',
    constraints: {
      permissions: ['read', 'write'],
      commands: [path.basename(process.execPath), 'maxtag-image-build'],
    },
  });
  request.access.toolApprovalPolicy = { mode: 'disabled' };
  const client = await connectedClient(context, await broker.open(request), 'workspace-command-test');
  const command = path.basename(process.execPath);
  const workspaceRunTool = (await client.listTools()).tools.find(
    (tool) => tool.name === 'workspace_run',
  );
  assert.deepEqual(workspaceRunTool.inputSchema.properties.command.enum, [
    command,
    'maxtag-image-build',
  ].sort());
  assert.match(workspaceRunTool.description, /Allowed program names for this run:/u);
  assert.match(workspaceRunTool.description, new RegExp(command, 'u'));
  assert.match(workspaceRunTool.description, /Combine them as needed/u);
  assert.match(workspaceRunTool.description, /optional accelerator rather than a required workflow/u);
  assert.doesNotMatch(workspaceRunTool.description, /poll status <build-id>/u);
  const capabilities = JSON.parse(textResult(await client.callTool({
    name: 'workspace_capabilities',
    arguments: {},
  })));
  assert.equal(capabilities.projectRoot, '.');
  assert.equal(capabilities.projectKey, 'payments');
  assert.deepEqual(capabilities.permissions, { read: true, write: true });
  assert.deepEqual(capabilities.commands, [command, 'maxtag-image-build'].sort());
  assert.equal(capabilities.approvalPolicy.mode, 'disabled');
  const pending = await client.callTool({
    name: 'workspace_run',
    arguments: { command, args: ['-e', "console.log('approved')"] },
  });
  assert.equal(pending.isError, undefined);
  const executed = JSON.parse(textResult(pending));
  assert.equal(executed.exitCode, 0);
  assert.equal(executed.status, 'succeeded');
  assert.match(executed.outputPreview, /approved/u);
  assert.match(executed.stdout, /approved/u);
  assert.equal(executed.stderr, '');
  const succeededEvent = events.find(
    (event) => event.type === 'tool_result' && event.call?.name === 'workspace_run',
  );
  assert.match(succeededEvent.call.resultPreview, /approved/u);
  assert.equal((await approvals.listToolApprovals({ status: 'pending' })).length, 0);

  const denied = await client.callTool({
    name: 'workspace_run',
    arguments: { command: 'sh', args: ['-c', 'echo denied'] },
  });
  assert.equal(denied.isError, true);
  assert.match(textResult(denied), /workspace_command_not_allowed/u);

  const failedResult = await client.callTool({
    name: 'workspace_run',
    arguments: {
      command,
      args: ['-e', "console.error('actionable failure details'); process.exit(17)"],
    },
  });
  assert.equal(failedResult.isError, true);
  const failedExecution = JSON.parse(textResult(failedResult));
  assert.equal(failedExecution.status, 'failed');
  assert.equal(failedExecution.exitCode, 17);
  assert.match(failedExecution.stderr, /actionable failure details/u);
});

test('workspace commands remain autonomous inside the project sandbox', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-workspace-command-approval-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'payments'));
  const approvals = new FileDeliveryStore(path.join(root, 'delivery'));
  const broker = createOpenTagToolBroker({
    memory: new ScopedFileMemoryStore(path.join(root, 'memory')),
    approvalStore: approvals,
    workspaceRoot: root,
  });
  const request = runRequest([]);
  request.access.grants.push({
    id: 'shell',
    kind: 'shell',
    scope: 'project',
    label: 'Workspace',
    constraints: {
      permissions: ['read', 'write'],
      commands: [path.basename(process.execPath)],
    },
  });
  request.access.toolApprovalPolicy = { mode: 'require_approval', risks: ['write'] };
  const client = await connectedClient(context, await broker.open(request), 'workspace-command-approval-test');
  const result = await client.callTool({
    name: 'workspace_run',
    arguments: { command: path.basename(process.execPath), args: ['-e', "console.log('approved')"] },
  });
  assert.equal(result.isError, undefined);
  assert.match(textResult(result), /approved/u);
  assert.equal((await approvals.listToolApprovals({ status: 'pending' })).length, 0);
});

test('wildcard workspace grant exposes installed runtime commands without an executable allowlist', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-workspace-wildcard-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'payments'));
  const request = runRequest([]);
  request.access.grants.push({
    id: 'shell-runtime',
    kind: 'shell',
    scope: 'project',
    label: 'Agent Runtime',
    constraints: { permissions: ['read', 'write'], commands: ['*'] },
  });
  const broker = createOpenTagToolBroker({
    memory: new ScopedFileMemoryStore(path.join(root, 'memory')),
    workspaceRoot: root,
  });
  const client = await connectedClient(context, await broker.open(request), 'workspace-wildcard-test');
  const tool = (await client.listTools()).tools.find((candidate) => candidate.name === 'workspace_run');
  assert.ok(tool);
  assert.equal(tool.inputSchema.properties.command.enum, undefined);
  assert.match(tool.description, /Any installed executable/u);
  const result = await client.callTool({
    name: 'workspace_run',
    arguments: { command: path.basename(process.execPath), args: ['-e', "console.log('agent-runtime')"] },
  });
  assert.equal(result.isError, undefined);
  assert.match(textResult(result), /agent-runtime/u);
});

test('workspace commands use the configured isolated project runner backend', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-workspace-remote-runner-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'payments'));
  const calls = [];
  const broker = createOpenTagToolBroker({
    memory: new ScopedFileMemoryStore(path.join(root, 'memory')),
    workspaceRoot: root,
    projectRunner: {
      async execute(input) {
        calls.push(input);
        return {
          requestId: 'runner-request-1',
          command: input.command,
          args: input.args,
          cwd: '.',
          exitCode: 0,
          signal: null,
          stdout: 'remote runner ok\n',
          stderr: '',
          stdoutTruncated: false,
          stderrTruncated: false,
          durationMs: 3,
        };
      },
    },
  });
  const request = runRequest([]);
  request.access.grants.push({
    id: 'shell',
    kind: 'shell',
    scope: 'project',
    label: 'Workspace',
    constraints: { permissions: ['read', 'write'], commands: ['node'] },
  });
  request.access.toolApprovalPolicy = { mode: 'disabled' };
  const client = await connectedClient(context, await broker.open(request), 'remote-project-runner-test');
  const capabilities = JSON.parse(textResult(await client.callTool({
    name: 'workspace_capabilities',
    arguments: {},
  })));
  assert.equal(capabilities.executionBackend, 'isolated-project-runner');
  assert.deepEqual(capabilities.commands, ['*']);
  const runtimeTool = (await client.listTools()).tools.find(
    (tool) => tool.name === 'workspace_run',
  );
  assert.equal(runtimeTool.inputSchema.properties.command.enum, undefined);
  const result = JSON.parse(textResult(await client.callTool({
    name: 'workspace_run',
    arguments: { command: 'bash', args: ['-lc', 'node --version'], timeoutMs: 4_000 },
  })));
  assert.equal(result.status, 'succeeded');
  assert.match(result.stdout, /remote runner ok/u);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].projectKey, 'payments');
  assert.equal(calls[0].command, 'bash');
  assert.deepEqual(calls[0].args, ['-lc', 'node --version']);
  assert.equal(calls[0].timeoutMs, 4_000);
});

test('workspace command authorization selects the matching shell grant', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-workspace-command-grants-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'payments'));
  const approvals = new FileDeliveryStore(path.join(root, 'delivery'));
  const broker = createOpenTagToolBroker({
    memory: new ScopedFileMemoryStore(path.join(root, 'memory')),
    approvalStore: approvals,
    workspaceRoot: root,
  });
  const request = runRequest([]);
  request.access.grants.push(
    {
      id: 'shell-first',
      kind: 'shell',
      scope: 'project',
      label: 'First wrapper',
      constraints: { permissions: ['read', 'write'], commands: ['not-the-command'] },
    },
    {
      id: 'shell-second',
      kind: 'shell',
      scope: 'project',
      label: 'Matching wrapper',
      constraints: { permissions: ['read', 'write'], commands: [path.basename(process.execPath)] },
    },
  );
  const client = await connectedClient(context, await broker.open(request), 'workspace-command-grants-test');
  const command = path.basename(process.execPath);
  const workspaceRunTool = (await client.listTools()).tools.find(
    (tool) => tool.name === 'workspace_run',
  );
  assert.deepEqual(workspaceRunTool.inputSchema.properties.command.enum, [
    command,
    'not-the-command',
  ].sort());
  const executed = await client.callTool({
    name: 'workspace_run',
    arguments: { command, args: ['-e', "console.log('matched')"] },
  });
  assert.equal(executed.isError, undefined);
  assert.match(textResult(executed), /matched/u);
});

test('legacy shell grants retain file writes without implicitly enabling commands', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-legacy-shell-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'payments'));
  const request = runRequest([]);
  request.access.grants.push({
    id: 'legacy-shell',
    kind: 'shell',
    scope: 'project',
    label: 'Legacy shell',
  });
  const broker = createOpenTagToolBroker({
    memory: new ScopedFileMemoryStore(path.join(root, 'memory')),
    approvalStore: new FileDeliveryStore(path.join(root, 'delivery')),
    workspaceRoot: root,
  });
  const client = await connectedClient(context, await broker.open(request), 'legacy-shell-test');
  const names = (await client.listTools()).tools.map((tool) => tool.name);
  assert.ok(names.includes('workspace_write'));
  assert.equal(names.includes('workspace_run'), false);
});

test('brokered browser fetch enforces public HTTPS hosts and every redirect', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opentag-browser-tool-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const calls = [];
  const events = [];
  const broker = createOpenTagToolBroker({
    memory: new ScopedFileMemoryStore(path.join(root, 'memory')),
    browser: {
      async resolve(hostname) {
        return hostname === 'private.example.com' ? ['127.0.0.1'] : ['203.0.113.10'];
      },
      async fetch(url) {
        calls.push(String(url));
        if (String(url) === 'https://allowed.example.com/redirect') {
          return new Response('', {
            status: 302,
            headers: { location: 'https://blocked.example.net/secret' },
          });
        }
        if (new URL(String(url)).pathname === '/redirect-ok') {
          return new Response('', {
            status: 302,
            headers: { location: 'https://final.example.org/result?secret=hidden' },
          });
        }
        return new Response('approved content', {
          status: 200,
          headers: { 'content-type': 'text/plain' },
        });
      },
    },
  });
  const request = runRequest(events);
  request.access.grants.push({
    id: 'browser',
    kind: 'browser',
    scope: 'project',
    label: 'Browser',
  });
  request.access.networkPolicy = {
    mode: 'restricted',
    allowedHosts: [
      'allowed.example.com',
      'final.example.org',
      'private.example.com',
    ],
  };
  const client = await connectedClient(context, await broker.open(request), 'browser-policy-test');
  const fetched = JSON.parse(
    textResult(await client.callTool({
      name: 'browser_fetch',
      arguments: { url: 'https://allowed.example.com/page' },
    })),
  );
  assert.equal(fetched.content, 'approved content');
  const redirected = JSON.parse(
    textResult(await client.callTool({
      name: 'browser_fetch',
      arguments: {
        url: 'https://allowed.example.com/redirect-ok?token=never-persist',
      },
    })),
  );
  assert.equal(redirected.url, 'https://final.example.org/result?secret=hidden');
  const privateResult = await client.callTool({
    name: 'browser_fetch',
    arguments: { url: 'https://private.example.com/metadata' },
  });
  assert.equal(privateResult.isError, true);
  assert.match(textResult(privateResult), /browser_host_resolves_private/u);
  const redirect = await client.callTool({
    name: 'browser_fetch',
    arguments: { url: 'https://allowed.example.com/redirect' },
  });
  assert.equal(redirect.isError, true);
  assert.match(textResult(redirect), /browser_host_not_allowed/u);
  assert.equal(calls.includes('https://blocked.example.net/secret'), false);
  const browserResults = events.filter(
    (event) => event.type === 'tool_result' && event.call.name === 'browser_fetch',
  );
  assert.equal(browserResults[0].call.destination, 'https://allowed.example.com');
  assert.equal(browserResults[1].call.destination, 'https://final.example.org');
  assert.equal(browserResults[2].call.destination, 'https://private.example.com');
  assert.equal(browserResults[3].call.destination, 'https://allowed.example.com');
  assert.doesNotMatch(JSON.stringify(browserResults), /metadata|secret=|never-persist/u);
});
