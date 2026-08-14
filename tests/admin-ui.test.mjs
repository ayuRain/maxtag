import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

test('admin browser module parses as JavaScript', async () => {
  await execFileAsync(process.execPath, ['--check', 'apps/admin/public/admin.js']);
});

test('admin offers a Chinese-first, add-bot-and-mention Lark onboarding path', async () => {
  const [html, script, styles] = await Promise.all([
    fs.readFile('apps/admin/public/index.html', 'utf8'),
    fs.readFile('apps/admin/public/admin.js', 'utf8'),
    fs.readFile('apps/admin/public/admin.css', 'utf8'),
  ]);
  assert.match(html, /id="onboarding-panel"/u);
  assert.match(html, /把 MaxTag 拉进群，直接 @ 它/u);
  assert.match(html, /id="onboarding-steps"/u);
  assert.match(script, /function installChineseInterface/u);
  assert.match(script, /function renderOnboarding/u);
  assert.match(script, /function setAdminMode/u);
  assert.match(script, /在群里添加 MaxTag/u);
  assert.match(script, /第一条消息需要 @/u);
  assert.match(script, /lark\.mode === 'http'.*lark\.hasCredentials/su);
  assert.match(script, /item\.status === 'ready' \|\| item\.mode === 'local-cli'/u);
  assert.match(script, /maxtag-onboarding-dismissed-v1/u);
  assert.match(script, /maxtag-admin-mode-v1/u);
  assert.match(styles, /\.onboarding-progress-track/u);
  assert.match(styles, /\.app-shell:not\(\.admin-mode\) \.advanced-nav-item/u);
  assert.match(styles, /scroll-snap-type: x proximity/u);
});

test('admin presents Lark as a focused channel card with progressive disclosure', async () => {
  const [html, script, styles, server] = await Promise.all([
    fs.readFile('apps/admin/public/index.html', 'utf8'),
    fs.readFile('apps/admin/public/admin.js', 'utf8'),
    fs.readFile('apps/admin/public/admin.css', 'utf8'),
    fs.readFile('apps/server/src/index.ts', 'utf8'),
  ]);
  assert.match(html, /id="lark-channel-card"/u);
  assert.match(html, /id="lark-readiness-list"/u);
  assert.match(html, /id="test-lark-connection"/u);
  assert.match(html, /id="connector-advanced"/u);
  assert.match(html, /飞书开放平台配置指引/u);
  assert.match(html, /https:\/\/open\.feishu\.cn\/app/u);
  assert.match(script, /function renderLarkSetup/u);
  assert.match(script, /async function testLarkConnection/u);
  assert.match(script, /getJson\('\/v1\/lark\/readiness'\)/u);
  assert.match(styles, /\.lark-channel-card/u);
  assert.match(styles, /\.connector-advanced/u);
  assert.match(server, /async function larkReadinessSnapshot/u);
  assert.match(server, /url\.pathname === '\/v1\/lark\/readiness'/u);
});

test('admin Connectors and destinations expose native Slack', async () => {
  const [html, script] = await Promise.all([
    fs.readFile('apps/admin/public/index.html', 'utf8'),
    fs.readFile('apps/admin/public/admin.js', 'utf8'),
  ]);
  assert.doesNotMatch(html, /option value="slack" disabled/u);
  const pairingForm = html.slice(
    html.indexOf('id="pairing-form"'),
    html.indexOf('id="pairing-list"'),
  );
  const testDialog = html.slice(html.indexOf('id="test-dialog"'));
  assert.match(pairingForm, /option value="slack">Slack/u);
  assert.match(testDialog, /option value="slack">Slack/u);
  assert.match(script, /client\.id === 'slack'.*slackTransport/su);
  assert.match(script, /client\.id === 'slack'.*\/v1\/slack\/events/su);
  assert.match(script, /C0123456789/u);
});

test('admin exposes a first-class durable Web Assistant client', async () => {
  const [html, script, css] = await Promise.all([
    fs.readFile('apps/admin/public/index.html', 'utf8'),
    fs.readFile('apps/admin/public/admin.js', 'utf8'),
    fs.readFile('apps/admin/public/admin.css', 'utf8'),
  ]);
  assert.match(html, /data-view="assistant"/u);
  assert.match(html, /id="assistant-session-list"/u);
  assert.match(html, /id="assistant-form"/u);
  assert.match(html, /id="assistant-stop"/u);
  assert.match(html, /id="assistant-live-trace"/u);
  assert.match(script, /\/v1\/assistant\/sessions/u);
  assert.match(script, /async function sendAssistantMessage/u);
  assert.match(script, /new EventSource/u);
  assert.match(script, /addEventListener\('run_event'/u);
  assert.match(script, /import DOMPurify from '\/vendor\/dompurify\.js'/u);
  assert.match(script, /import \{ marked \} from '\/vendor\/marked\.js'/u);
  assert.match(script, /DOMPurify\.sanitize/u);
  assert.match(script, /ALLOWED_TAGS/u);
  assert.match(script, /\['http:', 'https:'\]/u);
  assert.match(script, /function assistantRunTrace/u);
  assert.match(script, /function delegatedTraceGroups/u);
  assert.match(script, /Delegated agents/u);
  assert.match(script, /assistantSnapshot\.timeline/u);
  assert.doesNotMatch(script, /2000\);/u);
  assert.match(css, /\.assistant-layout/u);
  assert.match(css, /\.assistant-message\.user/u);
  assert.match(css, /\.assistant-live-row/u);
  assert.match(css, /\.markdown-body pre/u);
  assert.match(css, /\.assistant-run-trace/u);
  assert.match(css, /\.assistant-agent-trace/u);
  assert.match(css, /\.run-agent-row/u);
});

test('admin Projects view renders deployment-managed MCP tool grants', async () => {
  const script = await fs.readFile('apps/admin/public/admin.js', 'utf8');
  assert.match(script, /tool\.providerStatus === 'configured'/u);
  assert.match(script, /constraint\.allowedValues/u);
  assert.match(script, /input\.dataset\.defaultValues/u);
  assert.match(script, /\.tool-constraint input/u);
});

test('admin manages Lark-first Agent Identities and binds them to route grants', async () => {
  const [html, script, styles] = await Promise.all([
    fs.readFile('apps/admin/public/index.html', 'utf8'),
    fs.readFile('apps/admin/public/admin.js', 'utf8'),
    fs.readFile('apps/admin/public/admin.css', 'utf8'),
  ]);
  assert.match(html, /<h2>Agent identities<\/h2>/u);
  assert.match(html, /id="tool-identity-form"/u);
  assert.match(html, /id="tool-identity-app-id-ref"/u);
  assert.match(html, /id="tool-identity-app-secret-ref"/u);
  assert.match(html, /id="tool-identity-token-ref"/u);
  assert.doesNotMatch(html, /Secret value|Token value/u);
  assert.match(script, /getJson\('\/v1\/tool-identities'\)/u);
  assert.match(script, /values\.credentialIdentityId = identitySelect\.value/u);
  assert.match(script, /credentialIdentityRevision/u);
  assert.match(script, /External actor/u);
  assert.match(styles, /\.tool-identity-editor/u);
  assert.match(
    styles,
    /@media \(max-width: 680px\)[\s\S]*\.tool-identity-editor[\s\S]*grid-template-columns: 1fr/u,
  );
});

test('admin manages route-scoped on-demand Skills without embedding credentials or commands', async () => {
  const [html, script, styles] = await Promise.all([
    fs.readFile('apps/admin/public/index.html', 'utf8'),
    fs.readFile('apps/admin/public/admin.js', 'utf8'),
    fs.readFile('apps/admin/public/admin.css', 'utf8'),
  ]);
  assert.match(html, /data-view="skills"/u);
  assert.match(html, /id="skill-form"/u);
  assert.match(html, /id="workspace-skill-picker"/u);
  assert.match(html, /id="project-skill-picker"/u);
  assert.match(html, /id="channel-skill-picker"/u);
  assert.match(script, /function renderSkillPicker/u);
  assert.match(script, /function renderSkills/u);
  assert.match(script, /window\.addEventListener\('hashchange'/u);
  assert.match(script, /\/v1\/skills\?workspaceId=/u);
  assert.match(script, /skillIds: selectedSkillIds\('#workspace-skill-picker'\)/u);
  assert.match(script, /skillIds: selectedSkillIds\('#project-skill-picker'\)/u);
  assert.match(script, /skillIds: selectedSkillIds\('#channel-skill-picker'\)/u);
  assert.match(script, /enabled = action === 'enable'/u);
  assert.match(script, /enabled \? 'Disable' : 'Enable'/u);
  assert.doesNotMatch(
    script,
    /setButtonBusy\(button, false, skill\.enabled \? 'Disabling' : 'Enabling', idle\)/u,
  );
  assert.doesNotMatch(html, /API key|Secret value|Command allowlist/u);
  assert.match(styles, /\.skill-workbench/u);
  assert.match(styles, /\.skill-picker/u);
  assert.match(styles, /@media \(max-width: 680px\)[\s\S]*\.skill-picker/u);
  assert.match(
    styles,
    /@media \(max-width: 680px\)[\s\S]*grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/u,
  );
});

test('admin manages governed workspace Knowledge Sources and route assignments', async () => {
  const [html, script, styles] = await Promise.all([
    fs.readFile('apps/admin/public/index.html', 'utf8'),
    fs.readFile('apps/admin/public/admin.js', 'utf8'),
    fs.readFile('apps/admin/public/admin.css', 'utf8'),
  ]);
  assert.match(html, /data-view="sources"/u);
  assert.match(html, /id="source-form"/u);
  assert.match(html, /id="source-file"/u);
  assert.match(html, /id="source-refresh-interval"/u);
  assert.match(html, /Every 6 hours/u);
  assert.match(html, /id="workspace-source-picker"/u);
  assert.match(html, /id="project-source-picker"/u);
  assert.match(html, /id="channel-source-picker"/u);
  assert.match(html, /option value="knowledge">Knowledge/u);
  assert.match(script, /function renderKnowledgeSources/u);
  assert.match(script, /function renderKnowledgeSourcePicker/u);
  assert.match(script, /Source content is available to workspace owners/u);
  assert.match(script, /file\.size > 10 \* 1024 \* 1024/u);
  assert.match(script, /contentBase64 = await fileAsBase64/u);
  assert.match(script, /refreshIntervalMs/u);
  assert.match(script, /nextRefreshAt/u);
  assert.match(script, /if \(state\.knowledgeSourceDirty\) return/u);
  assert.match(script, /!state\.knowledgeSourceDirty/u);
  assert.match(script, /\/v1\/knowledge-sources\?workspaceId=/u);
  assert.match(script, /knowledgeSourceIds: selectedKnowledgeSourceIds\('#workspace-source-picker'\)/u);
  assert.match(script, /knowledgeSourceIds: selectedKnowledgeSourceIds\('#project-source-picker'\)/u);
  assert.match(script, /knowledgeSourceIds: selectedKnowledgeSourceIds\('#channel-source-picker'\)/u);
  assert.match(styles, /\.source-version/u);
});

test('admin Connectors view manages approved MCP lifecycle without defining commands or secrets', async () => {
  const [html, script, styles] = await Promise.all([
    fs.readFile('apps/admin/public/index.html', 'utf8'),
    fs.readFile('apps/admin/public/admin.js', 'utf8'),
    fs.readFile('apps/admin/public/admin.css', 'utf8'),
  ]);
  assert.match(html, /id="mcp-connector-list"/u);
  assert.match(script, /\/v1\/mcp-connectors\?workspaceId=/u);
  assert.match(script, /function renderMcpConnectors/u);
  assert.match(script, /function manageMcpConnector/u);
  assert.match(script, /function assignMcpConnector/u);
  assert.match(script, /Installation operator required/u);
  assert.doesNotMatch(html, /MCP command|Environment variable|Secret value/u);
  assert.match(styles, /\.mcp-connector-row/u);
  assert.match(styles, /@media \(max-width: 900px\)[\s\S]*\.mcp-connector-row/u);
});

test('admin Routines view supports one-time follow-ups', async () => {
  const [html, script] = await Promise.all([
    fs.readFile('apps/admin/public/index.html', 'utf8'),
    fs.readFile('apps/admin/public/admin.js', 'utf8'),
  ]);
  assert.match(html, /option value="once">Once/u);
  assert.match(html, /id="routine-once-at" type="datetime-local"/u);
  assert.match(script, /routine-list-last/u);
  assert.match(script, /Last \$\{statusLabel\(latest\.status\)\}/u);
  assert.match(script, /Never run/u);
  assert.match(html, /id="routine-notification-mode"/u);
  assert.match(html, /option value="failures_only">Failures only/u);
  assert.match(html, /id="routine-failure-threshold"/u);
  assert.match(html, /id="routine-recovery"/u);
  assert.match(script, /function updateRoutineNotificationFields/u);
  assert.match(script, /routineNotificationLabel/u);
  const routineView = html.slice(
    html.indexOf('id="view-routines"'),
    html.indexOf('id="view-workflows"'),
  );
  const projectView = html.slice(
    html.indexOf('id="view-projects"'),
    html.indexOf('id="view-access"'),
  );
  assert.match(routineView, /id="routine-notification-mode"/u);
  assert.doesNotMatch(projectView, /id="routine-notification-mode"/u);
  assert.match(script, /schedule\?\.kind === 'once'/u);
  assert.match(script, /function localDateTimeInputValue/u);
  assert.match(script, /getTimezoneOffset\(\) \* 60_000/u);
  assert.match(script, /new Date\(onceAt\)\.toISOString\(\)/u);
});

test('admin Workflows view exposes native event producers without locking custom events', async () => {
  const [html, script, styles] = await Promise.all([
    fs.readFile('apps/admin/public/index.html', 'utf8'),
    fs.readFile('apps/admin/public/admin.js', 'utf8'),
    fs.readFile('apps/admin/public/admin.css', 'utf8'),
  ]);
  assert.match(html, /id="workflow-event-type" list="workflow-event-catalog"/u);
  assert.match(html, /id="workflow-event-catalog"/u);
  assert.match(html, /id="workflow-producer-hint"/u);
  assert.match(html, /id="workflow-producer-form"/u);
  assert.match(html, /id="workflow-producer-routes"/u);
  assert.match(html, /option value="lark-document">Lark document/u);
  assert.match(html, /id="workflow-producer-document-id"/u);
  assert.match(html, /id="workflow-producer-poll-interval"/u);
  assert.match(script, /function fillWorkflowEventCatalog/u);
  assert.match(script, /function workflowProducerLabel/u);
  assert.match(script, /workflowEventCatalog/u);
  assert.match(script, /metadata\?\.workflowEventType/u);
  assert.match(script, /workflow producers on/u);
  assert.match(script, /function renderWorkflowProducerRoutes/u);
  assert.match(script, /function updateWorkflowProducerFields/u);
  assert.match(script, /workflowProducerRuntime/u);
  assert.match(script, /route\.kind === 'lark-document'/u);
  assert.match(script, /\/v1\/workflow-producers/u);
  assert.match(script, /\/v1\/alertmanager\/\$\{encodeURIComponent\(route\.id\)\}\/events/u);
  assert.match(styles, /\.workflow-producer-hint/u);
  assert.match(styles, /\.workflow-producer-route/u);
});

test('admin Workflows view exposes durable execution cancel and failed-node retry controls', async () => {
  const script = await fs.readFile(
    path.join(process.cwd(), 'apps/admin/public/admin.js'),
    'utf8',
  );
  const styles = await fs.readFile(
    path.join(process.cwd(), 'apps/admin/public/admin.css'),
    'utf8',
  );
  assert.match(script, /cancelWorkflowExecution/u);
  assert.match(script, /retryWorkflowNode/u);
  assert.match(script, /workflow-executions\/\$\{encodeURIComponent\(executionId\)\}\/cancel/u);
  assert.match(script, /nodes\/\$\{encodeURIComponent\(nodeId\)\}\/retry/u);
  assert.match(styles, /\.workflow-node-retry/u);
  assert.match(styles, /\.workflow-execution-controls/u);
});

test('admin Workflows list exposes per-workflow queue health', async () => {
  const source = await fs.readFile('apps/admin/public/admin.js', 'utf8');
  assert.match(source, /summary\?\.queues/u);
  assert.match(source, /activeExecutions/u);
  assert.match(source, /queuedNodes/u);
  assert.match(source, /failedExecutions/u);
});

test('admin Audit view filters and exports organization evidence', async () => {
  const [html, script, styles] = await Promise.all([
    fs.readFile('apps/admin/public/index.html', 'utf8'),
    fs.readFile('apps/admin/public/admin.js', 'utf8'),
    fs.readFile('apps/admin/public/admin.css', 'utf8'),
  ]);
  assert.match(html, /data-view="audit"/u);
  assert.match(html, /id="audit-filter-form"/u);
  assert.match(html, /id="audit-project"/u);
  assert.match(html, /id="audit-category"/u);
  assert.match(html, /id="audit-outcome"/u);
  assert.match(html, /id="audit-destination"/u);
  assert.match(html, /id="export-audit"/u);
  assert.match(script, /function refreshAudit/u);
  assert.match(script, /\/v1\/audit\?/u);
  assert.match(script, /\/v1\/audit\.csv\?/u);
  assert.match(script, /entry\.tool\.argumentKeys/u);
  assert.match(script, /entry\.tool\.destination/u);
  assert.match(script, /provider-native/u);
  assert.match(script, /native tool/u);
  assert.doesNotMatch(script, /entry\.tool\.arguments/u);
  assert.match(styles, /\.audit-toolbar/u);
  assert.match(styles, /\.audit-layout/u);
  assert.match(styles, /@media \(max-width: 680px\)[\s\S]*\.audit-layout/u);
});

test('admin Audit view previews and owner-gates workspace data lifecycle', async () => {
  const [html, script, styles] = await Promise.all([
    fs.readFile('apps/admin/public/index.html', 'utf8'),
    fs.readFile('apps/admin/public/admin.js', 'utf8'),
    fs.readFile('apps/admin/public/admin.css', 'utf8'),
  ]);

  assert.match(html, /id="data-lifecycle-days"/u);
  assert.match(html, /id="data-lifecycle-keep"/u);
  assert.match(html, /id="preview-data-lifecycle"/u);
  assert.match(html, /id="apply-data-lifecycle"/u);
  assert.match(script, /function previewDataLifecycle/u);
  assert.match(script, /function applyDataLifecycle/u);
  assert.match(script, /confirmationWorkspaceId/u);
  assert.match(script, /principal\?\.role !== 'owner'/u);
  assert.match(script, /\/v1\/data-lifecycle/u);
  assert.match(styles, /\.data-lifecycle-bar/u);
  assert.match(styles, /@media \(max-width: 680px\)[\s\S]*\.data-lifecycle-bar/u);
});

test('admin Activity view is organized around workspace threads and run evidence', async () => {
  const [html, script, styles] = await Promise.all([
    fs.readFile('apps/admin/public/index.html', 'utf8'),
    fs.readFile('apps/admin/public/admin.js', 'utf8'),
    fs.readFile('apps/admin/public/admin.css', 'utf8'),
  ]);

  assert.match(html, /id="activity-project"/);
  assert.match(html, /id="activity-search-form"/);
  assert.match(html, /id="activity-query"/);
  assert.match(html, /id="thread-list"/);
  assert.match(html, /id="thread-title"/);
  assert.match(html, /id="run-detail"/);
  assert.match(html, /id="tool-approval-list"/);
  assert.match(script, /function activityThreads/);
  assert.match(script, /function renderThreadList/);
  assert.match(script, /function renderActivity/);
  assert.match(script, /function refreshActivityRuns/);
  assert.match(script, /function renderToolApprovals/);
  assert.match(script, /function decideToolApproval/);
  assert.match(script, /\/v1\/tool-approvals/);
  assert.match(script, /query\.set\('q', state\.activityQuery\)/);
  assert.match(script, /activitySearchTimer = setTimeout/);
  const renderActivity = script.match(/function renderActivity\(\) \{[^}]+\}/)?.[0];
  assert.ok(renderActivity);
  assert.match(renderActivity, /renderThreadList\(\)/);
  assert.match(renderActivity, /renderRunTable\(\)/);
  assert.equal((renderActivity.match(/renderActivity\(\)/g) || []).length, 1);
  assert.match(script, /'run-exchange'/);
  assert.match(script, /Delivery receipts/);
  assert.match(script, /const grouped = new Map\(\)/);
  assert.match(script, /Tokens not reported/);
  assert.match(script, /data\.deliveries \|\| \{\}/);
  assert.match(styles, /\.thread-index/);
  assert.match(styles, /\.run-feed-row/);
  assert.match(styles, /\.activity-search/);
  assert.match(styles, /\.run-exchange/);
  assert.match(styles, /\.tool-approval-row/);
  assert.match(styles, /@media \(max-width: 680px\)[\s\S]*\.thread-list/);
});

test('admin Memory view exposes proposal review controls', async () => {
  const [html, script, styles] = await Promise.all([
    fs.readFile('apps/admin/public/index.html', 'utf8'),
    fs.readFile('apps/admin/public/admin.js', 'utf8'),
    fs.readFile('apps/admin/public/admin.css', 'utf8'),
  ]);

  assert.match(html, /id="memory-proposal-list"/);
  assert.match(html, /id="approve-memory-proposals"/);
  assert.match(html, /id="reject-memory-proposals"/);
  assert.match(html, /id="reload-memory-proposals"/);
  assert.match(html, /data-scope="channel"/);
  assert.match(script, /function renderMemoryProposals/);
  assert.match(script, /function refreshMemoryProposals/);
  assert.match(script, /function decideMemoryProposal/);
  assert.match(script, /function decideSelectedMemoryProposals/);
  assert.match(script, /function selectedMemoryProposalIds/);
  assert.match(script, /function memoryProposalActionLabel/);
  assert.match(script, /Current approved fact/);
  assert.match(script, /Proposed fact/);
  assert.match(script, /Retrieval aliases/);
  assert.match(script, /Model rationale/);
  assert.match(script, /Target document v/);
  assert.match(script, /memory-proposal-select/);
  assert.match(script, /\/v1\/memory-proposals\/batch/);
  assert.match(script, /\/v1\/memory-proposals\/\$\{encodeURIComponent\(id\)\}\/\$\{action\}/);
  assert.match(script, /'#approve-memory-proposals'/);
  assert.match(script, /'#reject-memory-proposals'/);
  assert.match(script, /'#reload-memory-proposals'/);
  assert.match(styles, /\.memory-proposal-row/);
  assert.match(styles, /\.memory-proposal-toolbar/);
  assert.match(styles, /\.memory-proposal-select/);
  assert.match(styles, /\.memory-proposal-comparison/);
  assert.match(styles, /\.memory-proposal-field-value/);
  assert.match(styles, /@media \(max-width: 680px\)[\s\S]*\.memory-proposal-row/);
});

test('admin Memory view exposes route-scoped approved memory search', async () => {
  const [html, script, styles] = await Promise.all([
    fs.readFile('apps/admin/public/index.html', 'utf8'),
    fs.readFile('apps/admin/public/admin.js', 'utf8'),
    fs.readFile('apps/admin/public/admin.css', 'utf8'),
  ]);

  assert.match(html, /id="memory-search-form"/u);
  assert.match(html, /id="memory-search-results"/u);
  assert.match(script, /\/v1\/memory-search\?/u);
  assert.match(script, /\.\.\.memoryThread\(\)/u);
  assert.match(script, /clearMemorySearch\(\)/u);
  assert.match(styles, /\.memory-search-row/u);
});

test('admin Memory view separates fast search, semantic query, and transcript synthesis', async () => {
  const [html, script, styles] = await Promise.all([
    fs.readFile('apps/admin/public/index.html', 'utf8'),
    fs.readFile('apps/admin/public/admin.js', 'utf8'),
    fs.readFile('apps/admin/public/admin.css', 'utf8'),
  ]);

  assert.match(html, /id="search-memory"[^>]*>Search</u);
  assert.match(html, /id="query-memory"[^>]*>Analyze</u);
  assert.match(html, /id="analyze-thread-memory"[^>]*>Synthesize thread</u);
  assert.match(html, /id="memory-retrieval-status"/u);
  assert.match(html, /id="memory-wrapup-status"/u);
  assert.match(script, /indexedFacts/u);
  assert.match(script, /indexedAliases/u);
  assert.match(script, /\/v1\/memory-query/u);
  assert.match(script, /\/v1\/memory-analysis/u);
  assert.match(script, /Automatic wrapup/u);
  assert.match(script, /Retrieval \$\{retrieval\.executor\?\.model/u);
  assert.match(script, /\.\.\.route/u);
  assert.match(styles, /\.memory-analysis-bar/u);
});

test('admin Memory view configures per-fact retention without hiding revision history', async () => {
  const [html, script, styles] = await Promise.all([
    fs.readFile('apps/admin/public/index.html', 'utf8'),
    fs.readFile('apps/admin/public/admin.js', 'utf8'),
    fs.readFile('apps/admin/public/admin.css', 'utf8'),
  ]);

  assert.match(html, /id="memory-retention"/u);
  assert.match(html, /id="memory-expiry-date"/u);
  assert.match(html, /id="memory-expiry-meta"/u);
  assert.match(html, /id="set-memory-expiry"/u);
  assert.match(html, /id="clear-memory-expiry"/u);
  assert.match(script, /function selectedMemoryExpiry/u);
  assert.match(script, /function renderMemoryExpiry/u);
  assert.match(script, /function updateMemoryExpiry/u);
  assert.match(script, /\/v1\/memory-expiry/u);
  assert.match(script, /expiresAt/u);
  assert.match(styles, /\.memory-retention/u);
  assert.match(styles, /\.memory-expiry-bar/u);
  assert.match(styles, /@media \(max-width: 680px\)[\s\S]*\.memory-expiry-bar/u);
});

test('admin Spend view separates project-agent and memory-runner usage', async () => {
  const [html, script, styles] = await Promise.all([
    fs.readFile('apps/admin/public/index.html', 'utf8'),
    fs.readFile('apps/admin/public/admin.js', 'utf8'),
    fs.readFile('apps/admin/public/admin.css', 'utf8'),
  ]);

  assert.match(html, /id="spend-purposes"/u);
  assert.match(html, /Agent and memory runner/u);
  assert.match(script, /memory_retrieval: 'Luna retrieval'/u);
  assert.match(script, /memory_wrapup: 'Luna wrapup'/u);
  assert.match(script, /status\.queryExecutor\?\.model/u);
  assert.match(script, /retrieval\.executor\?\.model/u);
  assert.match(script, /purpose\.inputTokens/u);
  assert.match(script, /purpose\.costReportedCalls/u);
  assert.match(styles, /\.spend-purpose-row/u);
  assert.match(styles, /@media \(max-width: 680px\)[\s\S]*\.spend-purpose-row/u);
});

test('admin Memory review renders multi-fact semantic merge proposals', async () => {
  const script = await fs.readFile('apps/admin/public/admin.js', 'utf8');
  assert.match(script, /if \(action === 'merge'\) return 'Merge approved facts'/u);
  assert.match(script, /proposal\.selectors \|\| \[\]/u);
  assert.match(script, /'Merged fact'/u);
});

test('admin Projects view can configure memory approval policy', async () => {
  const [html, script, styles] = await Promise.all([
    fs.readFile('apps/admin/public/index.html', 'utf8'),
    fs.readFile('apps/admin/public/admin.js', 'utf8'),
    fs.readFile('apps/admin/public/admin.css', 'utf8'),
  ]);

  assert.match(html, /id="project-memory-approval-mode"/);
  assert.match(html, /value="require_approval"/);
  assert.match(html, /id="project-memory-approval-project"/);
  assert.match(html, /id="project-memory-approval-channel"/);
  assert.match(script, /function fillProjectMemoryApproval/);
  assert.match(script, /function projectMemoryApprovalPolicyInput/);
  assert.match(script, /memoryApprovalPolicy: projectMemoryApprovalPolicyInput\(\)/);
  assert.match(script, /'#project-memory-approval-mode'/);
  assert.match(styles, /\.memory-approval-editor/);
  assert.match(styles, /\.memory-approval-options/);
});

test('admin Workspace defaults can configure inherited memory approval policy', async () => {
  const [html, script, styles] = await Promise.all([
    fs.readFile('apps/admin/public/index.html', 'utf8'),
    fs.readFile('apps/admin/public/admin.js', 'utf8'),
    fs.readFile('apps/admin/public/admin.css', 'utf8'),
  ]);

  assert.match(html, /id="workspace-memory-approval-mode"/);
  assert.match(html, /id="workspace-memory-approval-options"/);
  assert.match(html, /id="workspace-memory-approval-workspace"/);
  assert.match(html, /id="workspace-memory-approval-channel"/);
  assert.match(script, /function fillWorkspaceMemoryApproval/);
  assert.match(script, /function workspaceMemoryApprovalPolicyInput/);
  assert.match(script, /memoryApprovalPolicy: workspaceMemoryApprovalPolicyInput\(\)/);
  assert.match(script, /'#workspace-memory-approval-mode'/);
  assert.match(styles, /\.workspace-memory-approval-editor/);
});

test('admin workspace and project policies configure default memory retention', async () => {
  const [html, script, styles] = await Promise.all([
    fs.readFile('apps/admin/public/index.html', 'utf8'),
    fs.readFile('apps/admin/public/admin.js', 'utf8'),
    fs.readFile('apps/admin/public/admin.css', 'utf8'),
  ]);
  assert.match(html, /id="workspace-memory-retention-mode"/u);
  assert.match(html, /id="project-memory-retention-mode"/u);
  assert.match(html, /Use route default/u);
  assert.match(script, /function memoryRetentionPolicyInput/u);
  assert.match(script, /memoryRetentionPolicy: workspaceMemoryRetentionPolicyInput\(\)/u);
  assert.match(script, /memoryRetentionPolicy: projectMemoryRetentionPolicyInput\(\)/u);
  assert.match(script, /retentionOverride/u);
  assert.match(styles, /\.memory-retention-policy/u);
});

test('admin Projects view can configure a channel policy overlay', async () => {
  const [html, script, styles] = await Promise.all([
    fs.readFile('apps/admin/public/index.html', 'utf8'),
    fs.readFile('apps/admin/public/admin.js', 'utf8'),
    fs.readFile('apps/admin/public/admin.css', 'utf8'),
  ]);

  assert.match(html, /id="channel-policy-dialog"/);
  assert.match(html, /id="channel-instruction-mode"/);
  assert.match(html, /id="channel-capability-mode"/);
  assert.match(html, /id="channel-tool-grid"/);
  assert.match(html, /id="channel-budget-mode"/);
  assert.match(script, /function openChannelPolicy/);
  assert.match(script, /function saveChannelPolicy/);
  assert.match(script, /function removeChannelPolicy/);
  assert.match(script, /\/v1\/channel-policies/);
  assert.match(script, /channelPolicyForBinding/);
  assert.match(styles, /\.channel-budget-editor/);
});

test('admin Projects view renders runner descriptors and capability differences', async () => {
  const [html, script, styles] = await Promise.all([
    fs.readFile('apps/admin/public/index.html', 'utf8'),
    fs.readFile('apps/admin/public/admin.js', 'utf8'),
    fs.readFile('apps/admin/public/admin.css', 'utf8'),
  ]);

  assert.match(html, /id="workspace-runner-capabilities"/u);
  assert.match(html, /id="project-runner-capabilities"/u);
  assert.match(script, /function renderRunnerCapabilities/u);
  assert.match(script, /capabilities\.steering === 'live'/u);
  assert.match(script, /capabilities\.automaticMemoryCandidates/u);
  assert.match(script, /\(unavailable\)/u);
  assert.match(styles, /\.runner-capabilities/u);
  assert.match(styles, /\.runner-capability-list/u);
});

test('admin Agents view manages bounded specialists and route assignments', async () => {
  const [html, script, styles] = await Promise.all([
    fs.readFile('apps/admin/public/index.html', 'utf8'),
    fs.readFile('apps/admin/public/admin.js', 'utf8'),
    fs.readFile('apps/admin/public/admin.css', 'utf8'),
  ]);

  assert.match(html, /data-view="agents"/u);
  assert.match(html, /id="delegated-agent-form"/u);
  assert.match(html, /id="delegated-agent-model"/u);
  assert.match(html, /id="delegated-agent-grant-picker"/u);
  const agentsView = html.slice(
    html.indexOf('id="view-agents"'),
    html.indexOf('id="view-spend"'),
  );
  const skillsView = html.slice(
    html.indexOf('id="view-skills"'),
    html.indexOf('id="view-sources"'),
  );
  assert.match(agentsView, /id="agent-task-list"/u);
  assert.doesNotMatch(skillsView, /id="agent-task-list"/u);
  assert.match(html, /<option value="agent">Agents<\/option>/u);
  assert.match(html, /id="workspace-agent-picker"/u);
  assert.match(html, /id="project-agent-picker"/u);
  assert.match(html, /id="channel-agent-picker"/u);
  assert.match(script, /function renderDelegatedAgents/u);
  assert.match(script, /function saveDelegatedAgent/u);
  assert.match(script, /function renderDelegatedAgentTasks/u);
  assert.match(script, /\/v1\/agent-tasks\//u);
  assert.match(script, /getJson\(`\/v1\/agents\?workspaceId=/u);
  assert.match(script, /agentIds: selectedDelegatedAgentIds\('#workspace-agent-picker'\)/u);
  assert.match(script, /agentIds: selectedDelegatedAgentIds\('#project-agent-picker'\)/u);
  assert.match(script, /agentIds: selectedDelegatedAgentIds\('#channel-agent-picker'\)/u);
  assert.match(styles, /\.compact-fieldset/u);
  assert.match(styles, /\.agent-task-list/u);
  assert.match(styles, /\.task-stop-button/u);
});

test('Sources supports server-side document extraction and controlled URL refresh', async () => {
  const [html, script] = await Promise.all([
    fs.readFile('apps/admin/public/index.html', 'utf8'),
    fs.readFile('apps/admin/public/admin.js', 'utf8'),
  ]);
  assert.match(html, /id="source-file"[^>]+\.pdf[^>]+\.docx/u);
  assert.match(html, /id="refresh-source"/u);
  assert.match(script, /contentBase64 = await fileAsBase64/u);
  assert.match(script, /knowledge-sources\/\$\{encodeURIComponent\(source\.id\)\}\/refresh/u);
  assert.match(script, /will be extracted securely on the server/u);
});

test('admin Access view manages one-time persistent operator credentials', async () => {
  const [html, script, styles] = await Promise.all([
    fs.readFile('apps/admin/public/index.html', 'utf8'),
    fs.readFile('apps/admin/public/admin.js', 'utf8'),
    fs.readFile('apps/admin/public/admin.css', 'utf8'),
  ]);
  const accessView = html.slice(
    html.indexOf('id="view-access"'),
    html.indexOf('id="view-connectors"'),
  );
  assert.match(accessView, /id="operator-credential-form"/u);
  assert.match(accessView, /id="operator-credential-list"/u);
  assert.match(html, /id="operator-credential-secret-dialog"/u);
  assert.match(html, /cannot be recovered after you close this dialog/u);
  assert.match(script, /function createOperatorCredential/u);
  assert.match(script, /function rotateOperatorCredential/u);
  assert.match(script, /function revokeOperatorCredential/u);
  assert.match(script, /principal\?\.role === 'owner'/u);
  assert.match(script, /\/v1\/operator-credentials/u);
  assert.match(styles, /\.operator-credential-form/u);
  assert.match(styles, /\.credential-secret-body code/u);
});
