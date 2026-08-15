import DOMPurify from '/vendor/dompurify.js';
import { marked } from '/vendor/marked.js';

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const state = {
  auth: null,
  health: null,
  capabilities: null,
  larkReadiness: null,
  larkHistoryImports: null,
  larkConfig: null,
  executorConfig: null,
  mcpConnectors: null,
  toolIdentities: null,
  skills: null,
  skillDetail: null,
  knowledgeSources: null,
  knowledgeSourceDetail: null,
  delegatedAgents: null,
  delegatedAgentDetail: null,
  workspace: null,
  spend: null,
  audit: null,
  dataLifecycle: null,
  access: null,
  operatorCredentials: null,
  delivery: null,
  routines: null,
  workflows: null,
  assistantSessions: [],
  assistantSnapshot: null,
  assistantFiles: [],
  assistantLiveEvents: [],
  assistantTimeline: [],
  assistantDrafts: {},
  assistantStream: null,
  assistantStreamSessionId: null,
  assistantStreamCursors: {},
  selectedAssistantSessionId: null,
  selectedAssistantProjectId: null,
  pairings: null,
  runs: [],
  activityRuns: [],
  toolApprovals: [],
  bindings: [],
  selectedChannelBinding: null,
  selectedProjectId: null,
  selectedSkillId: null,
  selectedKnowledgeSourceId: null,
  selectedDelegatedAgentId: null,
  selectedAccessProjectId: null,
  selectedRoutineId: null,
  selectedWorkflowId: null,
  selectedRunId: null,
  selectedAuditId: null,
  selectedActivityProjectId: '',
  selectedActivityThreadId: '__all__',
  activityQuery: '',
  activitySearchTruncated: false,
  runFilter: '',
  memoryScope: 'project',
  memoryProjectId: null,
  memoryProposals: [],
  memorySearchHits: [],
  memoryExpiry: null,
  testProjectId: null,
  pairingProjectId: null,
  latestPairing: null,
  workspaceDirty: false,
  projectDirty: false,
  skillDirty: false,
  knowledgeSourceDirty: false,
  knowledgeSourceFile: null,
  delegatedAgentDirty: false,
  routineDirty: false,
  workflowDirty: false,
  workflowTriggerKind: 'manual',
  workflowDraftSteps: [],
  workflowGraphMode: 'sequential',
};

const viewCopy = {
  overview: { eyebrow: '工作空间', title: '总览' },
  projects: { eyebrow: '路由与权限', title: '项目' },
  skills: { eyebrow: '可复用能力', title: '技能' },
  sources: { eyebrow: '受控上下文', title: '知识源' },
  agents: { eyebrow: '有边界的专家', title: '子智能体' },
  spend: { eyebrow: '用量与限制', title: '预算' },
  access: { eyebrow: '身份与角色', title: '成员权限' },
  connectors: { eyebrow: '多端路由', title: '连接器' },
  assistant: { eyebrow: '项目会话', title: '网页助手' },
  routines: { eyebrow: '主动执行', title: '定时任务' },
  workflows: { eyebrow: '事件驱动', title: '工作流' },
  activity: { eyebrow: '运行与投递', title: '运行记录' },
  audit: { eyebrow: '组织证据', title: '审计' },
  memory: { eyebrow: '分域上下文', title: '记忆' },
};

// Keep the server/API vocabulary stable while presenting a Chinese-first console.
// Exact-node translation deliberately avoids user-authored text, logs and code.
const ZH_CN = new Map(Object.entries({
  'Operator access': '管理员入口', 'Sign in': '登录 MaxTag', 'Access token': '登录令牌',
  'Continue': '继续', Workspace: '工作空间', Loading: '加载中', Overview: '总览',
  Projects: '项目', Skills: '技能', Sources: '知识源', Agents: '子智能体',
  Spend: '预算', Access: '成员权限', Connectors: '连接器', Assistant: '网页助手',
  Routines: '定时任务', Workflows: '工作流', Activity: '运行记录', Audit: '审计', Memory: '记忆',
  'Local operator': '本地管理员', 'Owner / installation': '所有者 / 当前安装', Offline: '离线',
  'Runtime unavailable': '运行时不可用', 'Not synced': '尚未同步', Refresh: '刷新',
  'Sign out': '退出登录', 'Test agent': '网页试用', Routing: '路由', Manage: '管理',
  Surfaces: '接入端', Clients: '客户端', Latest: '最近', Runs: '运行', 'Open log': '查看日志',
  'Workspace profile': '工作空间配置', 'Workspace agent': '工作空间智能体', Active: '已启用',
  'Workspace name': '工作空间名称', 'Agent name': '智能体名称', Executor: '执行器',
  'Default project': '默认项目', Instructions: '指令', 'No unsaved changes': '没有未保存的更改',
  'Default tools': '默认工具', 'Save workspace': '保存工作空间', 'New project': '新建项目',
  Project: '项目', Name: '名称', Description: '说明', Status: '状态', Ready: '就绪',
  Configured: '已配置', Planned: '计划中', Enabled: '已启用', Disabled: '已停用', Unknown: '未知',
  Save: '保存', Cancel: '取消', Delete: '删除', Create: '创建', Add: '添加', Edit: '编辑',
  Search: '搜索', Filter: '筛选', Clear: '清除', Close: '关闭', Copy: '复制', Run: '运行',
  Running: '运行中', Failed: '失败', Completed: '已完成', Queued: '排队中', Pending: '等待中',
  'Active clients': '已启用客户端', 'Active runs': '正在运行', 'Needs attention': '需要处理',
  'Multi-client routing': '多端路由', 'Routing and access': '路由与权限',
  'Project conversations': '项目会话', 'Runs and delivery': '运行与投递',
  'Usage and limits': '用量与限制', 'Identity and roles': '身份与角色',
  'Reusable procedures': '可复用能力', 'Governed context': '受控上下文',
  'Bounded specialists': '有边界的专家', 'Proactive work': '主动执行',
  'Event-driven work': '事件驱动', 'Organization evidence': '组织证据',
  'Scoped context': '分域上下文', 'Select a run': '请选择一条运行记录',
  'No cap': '不限额', 'Operation completed': '操作已完成',
  'Development Workspace': '默认工作空间', 'Installation owner': '安装所有者', Online: '在线',
  'authorized': '已授权', 'bindings': '个群聊', 'Workspace profile': '工作空间配置',
  'Open workspace tools': '查看工作空间能力', 'Save project': '保存项目',
  'New conversation': '新对话', 'Send message': '发送消息', 'Start a conversation': '开始新对话',
  'Your operator session expired.': '管理员会话已过期，请重新登录。',
}));

for (const [english, chinese] of Object.entries({
  'Project policy': '项目策略', 'Project name': '项目名称', 'Project ID': '项目 ID',
  Agent: '智能体', Profile: '配置方式', 'Use workspace agent': '使用工作空间智能体',
  'Custom project agent': '自定义项目智能体', 'Workspace shared': '工作空间共享',
  Boundary: '隔离范围', 'Project isolated': '项目隔离', 'Default retention': '默认保留期限',
  'Use workspace default': '使用工作空间默认值', 'Keep indefinitely': '永久保留',
  'Custom days': '自定义天数', Days: '天数', Approval: '审批方式',
  'Direct writes': '直接写入', 'Require approval': '需要审批', Remember: '记住', Forget: '忘记',
  Channel: '群聊', Thread: '话题', 'Workspace baseline': '工作空间默认启用',
  'Delegated Agents': '子智能体', Tools: '工具', 'Workspace defaults': '工作空间默认值',
  Policy: '策略', 'Custom project policy': '自定义项目策略', 'Write approval': '写入审批',
  Network: '网络', 'Deny by default': '默认禁止', Restricted: '指定范围',
  'Allow all': '全部允许', 'Allowed hosts': '允许访问的域名', 'Channel binding': '群聊接入',
  Client: '客户端', Activation: '触发方式', Mention: '仅被 @ 时', Questions: '回答明确问题', 'Always on': '持续响应',
  'Require mention': '首条消息需要 @', Bind: '接入群聊', 'Save project': '保存项目',
  'Reusable procedures': '可复用流程', 'New skill': '新建技能', Catalog: '目录',
  'Agent Skill': '智能体技能', Draft: '草稿', 'Skill ID': '技能 ID', Disable: '停用',
  'Save skill': '保存技能', 'Governed context': '受控知识', 'New source': '新建知识源',
  'Knowledge Source': '知识源', 'Source ID': '知识源 ID', Kind: '类型', Text: '文本',
  'File snapshot': '文件快照', 'URL snapshot': '网页快照', 'Media type': '媒体类型',
  'Source URI': '来源地址', 'Automatic refresh': '自动刷新', Off: '关闭', Hourly: '每小时',
  'Every 6 hours': '每 6 小时', Daily: '每天', Weekly: '每周', 'Import file': '导入文件',
  'Content snapshot': '内容快照', 'Unsaved snapshot': '快照尚未保存', 'Save source': '保存知识源',
  'Bounded specialists': '受限专家', 'New agent': '新建子智能体', 'Delegated Agent': '子智能体',
  'Agent ID': '智能体 ID', Model: '模型', 'Max turns': '最大轮次', 'Timeout (seconds)': '超时（秒）',
  'Loaded on invocation': '调用时加载', 'Read-only tools': '只读工具',
  'Intersected with the parent route': '受主智能体权限范围限制', 'Memory scopes': '记忆范围',
  'Allowed network hosts': '允许访问的域名', 'Save agent': '保存子智能体',
  'Agent team': '智能体团队', 'Recent tasks': '最近任务', 'Hard limits': '硬性限制',
  'Workspace controls': '工作空间限制', 'Current month': '本月', 'Model calls': '模型调用',
  'Agent and memory runner': '主智能体与记忆任务', 'Aggregate caps': '总量上限',
  'Per-client limits': '按客户端限制', Channels: '群聊', 'Usage coverage': '用量覆盖',
  'Threshold notifications': '阈值通知', Alerts: '告警', 'Workspace directory': '工作空间成员',
  Members: '成员', 'Workspace role': '工作空间角色', Owner: '所有者', Admin: '管理员',
  Member: '成员', Guest: '访客', 'User ID': '用户 ID', 'Add member': '添加成员',
  'Project boundary': '项目边界', 'Project access': '项目权限', 'Access mode': '访问方式',
  Open: '开放', 'Workspace members': '工作空间成员', 'Project members': '项目成员',
  'Save mode': '保存访问方式', 'Project role': '项目角色', Manager: '项目管理员',
  Contributor: '协作者', Viewer: '只读成员', Assign: '分配',
  'Installation control plane': '平台管理', 'Operator credentials': '管理员凭据',
  'Credential ID': '凭据 ID', 'Workspace IDs': '工作空间 ID', 'Create credential': '创建凭据',
  'Lark agent': '飞书智能体', 'Agent identities': '智能体身份', 'Identity ID': '身份 ID',
  Provider: '服务商', 'App ID env': 'App ID 环境变量', 'App secret env': 'App Secret 环境变量',
  'Token env': '令牌环境变量', 'External actor': '外部身份', 'API base URL': 'API 地址',
  'Save identity': '保存身份', 'Agent tools': '智能体工具', 'MCP connectors': 'MCP 连接器',
  'Workspace routing': '工作空间路由', 'Connect a chat': '接入群聊', 'Generate code': '生成配对码',
  'Send in chat': '发送到群聊', 'Copy command': '复制命令', 'Recent access': '最近接入',
  Invitations: '邀请', 'Project routing': '项目路由', 'Bound chats': '已接入群聊',
  'Client runtime': '客户端运行状态', Adapters: '适配器', Scheduler: '调度器',
  'No tick recorded': '暂无调度记录', 'Tick now': '立即检查', 'Proactive run': '主动任务',
  'New routine': '新建定时任务', Schedule: '计划', 'Not scheduled': '未设置', Frequency: '频率',
  Once: '单次', Interval: '间隔', 'Run at': '执行时间', 'Every (minutes)': '间隔（分钟）',
  Time: '时间', 'Time zone': '时区', Destination: '发送位置', 'Client neutral': '通用客户端',
  Conversation: '会话类型', 'Public channel': '公开群', 'Direct message': '私聊',
  'Private channel': '私密群', 'Thread ID (optional)': '话题 ID（可选）', Notifications: '通知',
  'Per routine': '按任务设置', Send: '发送', 'Every result': '每次结果',
  'Failures only': '仅失败时', Silent: '静默', 'Alert after failures': '连续失败后告警',
  'Notify when recovered': '恢复后通知', Executions: '执行记录', 'Run now': '立即运行',
  'Save routine': '保存定时任务', Coordinator: '协调器', 'Native producers': '原生事件源',
  'Event sources': '事件源', Source: '来源', 'Lark document': '飞书文档',
  'Document ID': '文档 ID', 'Poll interval': '检查间隔', 'Add route': '添加路由',
  'Agent workflow': '智能体工作流', 'New workflow': '新建工作流', Trigger: '触发方式',
  Manual: '手动', Event: '事件', 'Event type': '事件类型', 'Native producer': '原生事件源',
  'This event uses a configured native producer route for this project.': '此事件使用该项目已配置的原生事件路由。',
  Steps: '步骤', 'Add step': '添加步骤', 'Final step': '最终步骤', Archive: '归档',
  'Save workflow': '保存工作流', 'Web client': '网页端', Conversations: '会话',
  'Workspace assistant': '工作空间助手', 'Select a conversation': '请选择会话', Idle: '空闲',
  'Start a project conversation': '开始项目会话', 'Durable workspace thread': '可恢复的工作空间会话',
  Attach: '添加附件', Stop: '停止', 'Search activity': '搜索运行记录',
  'Recent 50 runs': '最近 50 次运行', All: '全部', Live: '进行中', Done: '已完成',
  'Worker pass': '执行一轮任务', 'Recover runs': '恢复运行', 'Recover delivery': '恢复投递',
  'Guarded writes': '受控写入', 'Tool approvals': '工具审批', 'Workspace threads': '工作空间话题',
  Transport: '传输', Delivery: '投递', Outbound: '发出', Inbound: '收到',
  'Data lifecycle': '数据生命周期', 'No preview': '尚未预览', 'Retain days': '保留天数',
  'Keep / thread': '每话题保留', Preview: '预览', Apply: '应用', Category: '类别',
  Tasks: '任务', 'Tool calls': '工具调用', Knowledge: '知识', Bindings: '群聊接入',
  Outcome: '结果', Started: '已开始', Succeeded: '成功', Denied: '已拒绝', Cancelled: '已取消',
  Changed: '已变更', Actor: '操作人', Action: '操作', 'Export CSV': '导出 CSV',
  'Select an audit entry': '请选择一条审计记录', Installation: '当前安装',
  'Search approved memory': '搜索已确认记忆', Analyze: '语义分析', 'Current scope': '当前范围',
  'Memory runner': '记忆任务', 'Per-turn retrieval loading': '正在加载每轮记忆检索状态',
  'Automatic wrapup loading': '正在加载自动整理状态', 'Synthesize thread': '整理整个话题',
  'Project memory': '项目记忆', 'Current memory': '当前记忆', 'No revisions': '暂无历史版本',
  Reload: '重新加载', 'No memory loaded.': '尚未加载记忆。', 'Memory note': '记忆内容',
  Retention: '保留期限', 'Use route default': '使用路由默认值', 'Custom date': '自定义日期',
  Expires: '到期时间', 'No timed memory': '没有定时到期的记忆', 'Clear expiry': '清除到期时间',
  'Set on matching': '为匹配项设置', 'Forget matching': '忘记匹配项',
  'Immutable revisions': '不可变历史版本', History: '历史', Proposals: '待审批修改',
  Approve: '批准', Reject: '拒绝', 'No pending proposals.': '没有待审批的修改。',
  'Shown once': '仅显示一次', 'Operator token': '管理员令牌',
  'This token cannot be recovered after you close this dialog.': '关闭此窗口后将无法再次查看该令牌。',
  'Copy token': '复制令牌', 'Inherited policy': '继承策略', 'Save defaults': '保存默认设置',
  'Channel policy': '群聊策略', 'Use project instructions': '使用项目指令',
  'Append for this channel': '为当前群聊追加', 'Replace for this channel': '替换当前群聊指令',
  'Use project tools': '使用项目工具', 'Add channel tools': '添加群聊工具',
  'Custom channel tools': '自定义群聊工具', 'Use project policy': '使用项目策略',
  'Channel instructions': '群聊指令', 'Channel Skills': '群聊技能', 'Channel Sources': '群聊知识源',
  'Channel Agents': '群聊子智能体', 'Added to workspace and project': '在工作空间和项目基础上追加',
  'Monthly budget': '月度预算', 'Use default channel limit': '使用默认群聊限额',
  'Custom channel budget': '自定义群聊预算', 'No channel limit': '群聊不限额',
  'Max runs': '最大运行次数', 'Max cost (USD)': '最大费用（美元）',
  'Use project defaults': '使用项目默认值', 'Save channel': '保存群聊设置',
  'Client preview': '客户端预览', Message: '消息', 'No card': '暂无卡片', 'No output': '暂无输出',
})) ZH_CN.set(english, chinese);

const ZH_CN_PATTERNS = [
  [/^(\d+) clients$/, '$1 个客户端'], [/^(\d+) Projects$/, '$1 个项目'],
  [/^(\d+) bindings$/, '$1 个绑定'], [/^(\d+) active$/, '$1 个运行中'],
  [/^(\d+) enabled$/, '$1 个已启用'], [/^(\d+) recorded$/, '$1 条记录'],
  [/^Synced (.+)$/, '同步于 $1'],
];

function translateText(value) {
  const raw = String(value || '');
  const trimmed = raw.trim();
  if (!trimmed) return raw;
  let translated = ZH_CN.get(trimmed);
  if (!translated) {
    for (const [pattern, replacement] of ZH_CN_PATTERNS) {
      if (pattern.test(trimmed)) {
        translated = trimmed.replace(pattern, replacement);
        break;
      }
    }
  }
  return translated ? raw.replace(trimmed, translated) : raw;
}

function translateNode(root) {
  if (!root) return;
  const blocked = new Set(['SCRIPT', 'STYLE', 'CODE', 'PRE', 'TEXTAREA']);
  const nodes = [];
  if (root.nodeType === Node.TEXT_NODE) {
    nodes.push(root);
  } else {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) nodes.push(walker.currentNode);
  }
  for (const node of nodes) {
    if (blocked.has(node.parentElement?.tagName)) continue;
    const translated = translateText(node.nodeValue);
    if (translated !== node.nodeValue) node.nodeValue = translated;
  }
  if (root.nodeType === Node.ELEMENT_NODE) {
    for (const elementNode of [root, ...root.querySelectorAll('[placeholder], [title], [aria-label]')]) {
      for (const attribute of ['placeholder', 'title', 'aria-label']) {
        if (elementNode.hasAttribute(attribute)) {
          const original = elementNode.getAttribute(attribute);
          const translated = translateText(original);
          if (translated !== original) elementNode.setAttribute(attribute, translated);
        }
      }
    }
  }
}

function installChineseInterface() {
  translateNode(document.body);
  new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === 'characterData') translateNode(record.target);
      for (const node of record.addedNodes) translateNode(node);
    }
  }).observe(document.body, { childList: true, characterData: true, subtree: true });
}

let toastTimer;
let refreshInFlight = false;
let activitySearchTimer;
let activitySearchRequest = 0;

async function getJson(url, options) {
  const requestOptions = { ...(options || {}) };
  const method = String(requestOptions.method || 'GET').toUpperCase();
  const headers = new Headers(requestOptions.headers || {});
  if (
    state.auth?.csrfToken &&
    !['GET', 'HEAD', 'OPTIONS'].includes(method)
  ) {
    headers.set('x-opentag-csrf', state.auth.csrfToken);
  }
  requestOptions.headers = headers;
  const response = await fetch(url, requestOptions);
  const contentType = response.headers.get('content-type') || '';
  const data = contentType.includes('application/json')
    ? await response.json()
    : { message: await response.text() };
  if (!response.ok) {
    if (response.status === 401 && data.error === 'operator_auth_required') {
      showOperatorLogin('Your operator session expired.');
    }
    throw new Error(data.message || data.error || response.statusText);
  }
  return data;
}

function showOperatorLogin(message = '') {
  state.auth = {
    configured: true,
    authenticated: false,
  };
  $('#app-shell').hidden = true;
  $('#auth-shell').hidden = false;
  const error = $('#auth-error');
  error.textContent = message;
  error.hidden = !message;
  requestAnimationFrame(() => $('#auth-token').focus());
}

function applyOperatorSession(session) {
  state.auth = session;
  const signInRequired = session.configured && !session.authenticated;
  $('#auth-shell').hidden = !signInRequired;
  $('#app-shell').hidden = signInRequired;
  $('#sign-out').hidden = !session.configured;
  const principal = session.principal;
  $('#operator-name').textContent = principal?.displayName || 'Unknown operator';
  const workspaceIds = principal?.workspaceIds || [];
  const scopeLabel = workspaceIds.includes('*')
    ? 'installation'
    : workspaceIds.join(', ') || 'no workspace';
  $('#operator-scope').textContent = `${statusLabel(principal?.role)} / ${scopeLabel}`;
  applyOperatorCapabilities();
  if (!signInRequired) {
    $('#auth-error').hidden = true;
    $('#auth-token').value = '';
  }
  return !signInRequired;
}

function applyOperatorCapabilities() {
  const principal = state.auth?.principal;
  const viewer = principal?.role === 'viewer';
  const installation = Boolean(principal?.workspaceIds?.includes('*'));
  const installationOwner = installation && principal?.role === 'owner';
  if ($('#tool-identity-form')) $('#tool-identity-form').hidden = !installationOwner;
  document.body.classList.toggle('operator-viewer', viewer);
  for (const selector of [
    '#new-project',
    '#save-workspace',
    '#save-workspace-capabilities',
    '#view-spend button[type="submit"]',
    '#save-project',
    '#save-binding',
    '#add-access-member',
    '#save-access-policy',
    '#add-project-member',
    '#new-routine',
    '#save-routine',
    '#delete-routine',
    '#new-workflow',
    '#save-workflow',
    '#archive-workflow',
    '#save-workflow-producer',
    '#pairing-form button[type="submit"]',
    '#memory-form button[type="submit"]',
    '#forget-memory',
    '#set-memory-expiry',
    '#clear-memory-expiry',
    '#approve-memory-proposals',
    '#reject-memory-proposals',
    '#reload-memory-proposals',
    '#open-test',
    '#recover-delivery',
    '#apply-data-lifecycle',
  ]) {
    const control = $(selector);
    if (control) control.disabled = viewer;
  }
  for (const selector of [
    '#new-skill',
    '#save-skill',
    '#toggle-skill',
    '#new-source',
    '#save-source',
    '#toggle-source',
    '#refresh-source',
    '#new-delegated-agent',
    '#save-delegated-agent',
    '#toggle-delegated-agent',
  ]) {
    const control = $(selector);
    if (control) {
      const workspaceCatalog = control.id.includes('source');
      control.disabled = viewer || (workspaceCatalog
        ? !state.knowledgeSources?.canManageCatalog
        : !installation);
    }
  }
  const routineTrigger = $('#trigger-routine');
  if (routineTrigger) {
    routineTrigger.disabled =
      viewer || state.routineDirty || !routineById(state.selectedRoutineId);
  }
  const workflowTrigger = $('#trigger-workflow');
  if (workflowTrigger) {
    workflowTrigger.disabled =
      viewer || state.workflowDirty || !workflowById(state.selectedWorkflowId);
  }
  for (const selector of [
    '#tick-routines',
    '#tick-workflows',
    '#worker-pass',
    '#recover-runs',
  ]) {
    const control = $(selector);
    if (control) control.disabled = viewer || !installation;
  }
  const globalMemory = $('#memory-scope [data-scope="global"]');
  if (globalMemory) globalMemory.disabled = !installation;
  const operatorCredentialForm = $('#operator-credential-form');
  if (operatorCredentialForm) operatorCredentialForm.hidden = !installationOwner;
  const lifecycleApply = $('#apply-data-lifecycle');
  if (lifecycleApply) lifecycleApply.disabled = principal?.role !== 'owner';
}

async function loadOperatorSession() {
  try {
    return applyOperatorSession(await getJson('/v1/admin/session'));
  } catch (error) {
    showOperatorLogin(error.message || 'MaxTag is unavailable.');
    return false;
  }
}

async function signInOperator(event) {
  event.preventDefault();
  const button = $('#auth-submit');
  const error = $('#auth-error');
  error.hidden = true;
  setButtonBusy(button, true, 'Signing in', 'Continue');
  try {
    const session = await getJson('/v1/admin/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: $('#auth-token').value }),
    });
    applyOperatorSession(session);
    await refreshAll();
  } catch (failure) {
    error.textContent =
      failure.message === 'invalid_operator_token'
        ? 'That access token is not valid.'
        : failure.message;
    error.hidden = false;
    $('#auth-token').select();
  } finally {
    setButtonBusy(button, false, 'Signing in', 'Continue');
  }
}

async function signOutOperator() {
  try {
    await getJson('/v1/admin/session', { method: 'DELETE' });
  } finally {
    showOperatorLogin();
    $('#auth-token').value = '';
  }
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function statusLabel(value) {
  if (!value) return 'Unknown';
  return value
    .replaceAll('_', ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function statePill(value, label = statusLabel(value)) {
  return element('span', `state-pill ${value || 'planned'}`, label);
}

function formatTime(value, includeDate = false) {
  if (!value) return 'Never';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    ...(includeDate ? { month: 'short', day: 'numeric' } : {}),
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function formatBytes(value) {
  if (!Number.isFinite(value) || value < 0) return 'Size unknown';
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB'];
  let amount = value / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && amount >= 1024; index += 1) {
    amount /= 1024;
    unit = units[index];
  }
  return `${amount >= 10 ? amount.toFixed(0) : amount.toFixed(1)} ${unit}`;
}

function formatDuration(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return 'Duration unknown';
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  if (minutes < 60) return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function safeHttpUrl(value) {
  if (!value) return undefined;
  try {
    const url = new URL(value, window.location.origin);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function shortId(value) {
  if (!value) return 'unknown';
  if (value.startsWith('routine:')) return `routine:${value.slice(-6)}`;
  if (value.startsWith('workflow:')) return `workflow:${value.slice(-6)}`;
  if (value.startsWith('steering:')) return `follow-up:${value.slice(-6)}`;
  return value.slice(0, 8);
}

function initials(value) {
  return (value || 'OT')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0])
    .join('')
    .toUpperCase();
}

function showToast(message, tone = 'default') {
  const toast = $('#toast');
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.className = tone === 'error' ? 'toast error' : 'toast';
  toast.hidden = false;
  toastTimer = setTimeout(() => {
    toast.hidden = true;
  }, 3200);
}

function setButtonBusy(button, busy, busyLabel, idleLabel) {
  button.disabled = busy;
  button.textContent = busy ? busyLabel : idleLabel;
}

function currentWorkspaceId() {
  const principalWorkspace = state.auth?.principal?.workspaceIds?.find(
    (workspaceId) => workspaceId !== '*',
  );
  return (
    state.workspace?.workspace?.workspace?.id ||
    principalWorkspace ||
    'dev-workspace'
  );
}

function projectMatches(project, value) {
  return value === project?.projectId || value === project?.id;
}

function projectById(value) {
  return (state.workspace?.projects || []).find((project) =>
    projectMatches(project, value),
  );
}

function selectedProject() {
  return projectById(state.selectedProjectId);
}

function showView(view, updateHash = true) {
  const next = viewCopy[view] ? view : 'overview';
  for (const panel of $$('[data-view-panel]')) {
    panel.hidden = panel.dataset.viewPanel !== next;
  }
  for (const button of $$('[data-view]')) {
    button.classList.toggle('active', button.dataset.view === next);
  }
  $('#view-eyebrow').textContent = viewCopy[next].eyebrow;
  $('#view-title').textContent = viewCopy[next].title;
  if (updateHash) history.replaceState(null, '', `#${next}`);
  if (next === 'memory') void refreshMemory();
  if (next === 'audit') void refreshAudit();
  if (next === 'assistant') void refreshAssistant();
  else closeAssistantStream();
}

function renderHealth() {
  const health = $('#health');
  const online = Boolean(state.health?.ok);
  health.classList.toggle('online', online);
  health.innerHTML = '<i></i>';
  health.append(document.createTextNode(online ? ' Online' : ' Offline'));

  const worker = state.health?.worker;
  $('#runtime-label').textContent = worker
    ? `${worker.mode} worker / ${worker.activeRuns || 0} active`
    : 'Runtime unavailable';
}

function renderWorkspaceHeader() {
  const workspace = state.workspace?.workspace?.workspace;
  $('#workspace-name').textContent = workspace?.name || 'MaxTag Workspace';
  $('#workspace-id').textContent = workspace?.id || 'dev-workspace';
  $('#project-count').textContent = String(state.workspace?.projects?.length || 0);
  $('#skill-count').textContent = String(
    state.skills?.skills?.filter((skill) => skill.enabled).length || 0,
  );
  $('#source-count').textContent = String(
    state.knowledgeSources?.sources?.filter((source) => source.enabled).length || 0,
  );
  $('#agent-count').textContent = String(
    state.delegatedAgents?.agents?.filter((agent) => agent.enabled).length || 0,
  );
  $('#spend-alert-count').textContent = String(state.spend?.alerts?.length || 0);
  $('#member-count').textContent = String(state.access?.members?.length || 0);
  const clients = state.capabilities?.clients || [];
  $('#client-count').textContent = String(
    clients.filter((client) => client.status !== 'planned').length,
  );
  $('#assistant-count').textContent = String(state.assistantSessions.length);
  $('#routine-count').textContent = String(state.routines?.routines?.length || 0);
  $('#workflow-count').textContent = String(state.workflows?.workflows?.length || 0);
  const runSummary = state.delivery?.summary?.agentRuns || {};
  $('#active-count').textContent = String(
    (runSummary.queued || 0) +
      (runSummary.running || 0) +
      (runSummary.cancel_requested || 0),
  );
  $('#audit-count').textContent = String(state.audit?.total || 0);
  const workerMode = state.capabilities?.runWorker?.mode || 'manual';
  const storageLabel =
    state.capabilities?.storage?.driver === 'sqlite' ? 'SQLite WAL' : 'file';
  const activeClients = clients.filter((client) => client.status !== 'planned').length;
  const workerLabel = workerMode === 'manual' ? '手动调度' : workerMode === 'external' ? '独立调度' : workerMode;
  $('#runtime-label').textContent = `${activeClients} 个客户端 / ${storageLabel} / ${workerLabel}`;
}

function metric(value, label) {
  const node = element('div', 'summary-metric');
  node.append(element('strong', '', String(value)), element('span', '', label));
  return node;
}

function renderSummary() {
  const summary = $('#summary-strip');
  const projects = state.workspace?.projects || [];
  const clients = state.capabilities?.clients || [];
  const runs = state.delivery?.summary?.agentRuns || {};
  const outbox = state.delivery?.summary?.outbox || {};
  const active =
    (runs.queued || 0) + (runs.running || 0) + (runs.cancel_requested || 0);
  const failures =
    (runs.failed || 0) +
    (outbox.failed || 0) +
    (state.routines?.summary?.executions?.failed || 0) +
    (state.workflows?.summary?.executions?.failed || 0);
  summary.replaceChildren(
    metric(projects.length, 'Projects'),
    metric(clients.filter((client) => client.status !== 'planned').length, 'Active clients'),
    metric(active, 'Active runs'),
    metric(failures, 'Needs attention'),
  );
}

const ONBOARDING_DISMISSED_KEY = 'maxtag-onboarding-dismissed-v1';
const ADMIN_MODE_KEY = 'maxtag-admin-mode-v1';

function onboardingChecks() {
  const workspace = state.workspace?.workspace;
  const projects = state.workspace?.projects || [];
  const executors = state.workspace?.executors || [];
  const lark = state.capabilities?.larkTransport || {};
  return [
    {
      title: '默认智能体已创建',
      description: '普通成员无需选择工作空间或项目。',
      complete: Boolean(workspace?.workspace?.id),
      view: 'projects', action: '检查工作空间',
    },
    {
      title: '默认项目已准备',
      description: '新加入的群会自动使用默认项目。',
      complete: projects.length > 0,
      view: 'projects', action: '配置项目',
    },
    {
      title: '飞书机器人已上线',
      description: '飞书应用凭据与长连接由平台管理员统一维护。',
      complete: lark.mode === 'http' && Boolean(lark.hasCredentials),
      view: 'connectors', action: '查看连接器',
    },
    {
      title: '智能体已可执行',
      description: '真实执行器通过健康检查后，群成员即可开始使用。',
      complete: executors.some((item) => item.status === 'ready' || item.mode === 'local-cli'),
      view: 'projects', action: '检查执行器',
    },
  ];
}

function setAdminMode(enabled) {
  $('#app-shell').classList.toggle('admin-mode', enabled);
  $('#toggle-admin-mode').textContent = enabled ? '退出管理员设置' : '管理员设置';
  localStorage.setItem(ADMIN_MODE_KEY, enabled ? 'true' : 'false');
  if (!enabled && !['overview', 'assistant', 'activity'].includes(location.hash.slice(1))) {
    showView('overview');
  }
}

function renderOnboarding() {
  const panel = $('#onboarding-panel');
  const reopen = $('#onboarding-reopen');
  if (!panel || !reopen) return;
  const dismissed = localStorage.getItem(ONBOARDING_DISMISSED_KEY) === 'true';
  panel.hidden = dismissed;
  reopen.hidden = !dismissed;
  const steps = onboardingChecks();
  const completed = steps.filter((step) => step.complete).length;
  const ready = completed === steps.length;
  $('#onboarding-progress-label').textContent = ready ? 'MaxTag 已可使用' : 'MaxTag 暂未开放';
  $('#onboarding-progress-hint').textContent = ready
    ? '现在可以把 MaxTag 添加到任意允许使用的飞书群'
    : `管理员初始化 ${completed} / ${steps.length}`;
  $('#onboarding-progress-fill').style.width = `${Math.round((completed / steps.length) * 100)}%`;
  $('#onboarding-summary').textContent = ready
    ? '管理员已经完成初始化。普通成员不需要登录本页面，也不需要手动创建项目或群绑定。'
    : '管理员只需初始化一次。完成前系统保持安全模式，不会接收真实群消息。';
  const memberSteps = [
    ['在群里添加 MaxTag', '打开飞书群右上角菜单，选择“机器人”，搜索并添加 MaxTag。'],
    ['@MaxTag 说出需求', '例如：@MaxTag 帮我总结这个话题。第一条消息需要 @，之后在同一话题里直接回复即可。'],
    ['在群里查看结果', '进度、停止按钮、文件和最终结果都会回到原话题。'],
  ];
  $('#onboarding-steps').replaceChildren(...memberSteps.map(([title, description], index) => {
    const item = element('li', 'onboarding-step');
    const marker = element('span', 'onboarding-step-marker', String(index + 1));
    const copy = element('div', 'onboarding-step-copy');
    copy.append(element('strong', '', title), element('span', '', description));
    item.append(marker, copy);
    return item;
  }));
  $('#onboarding-admin-summary').textContent = `管理员初始化状态（${completed} / ${steps.length}）`;
  $('#onboarding-admin-checks').replaceChildren(...steps.map((step) => {
    const item = element('div', `onboarding-admin-check${step.complete ? ' complete' : ''}`);
    item.append(
      element('span', '', step.complete ? '✓' : '—'),
      element('strong', '', step.title),
      element('span', '', step.complete ? '已就绪' : '待完成'),
    );
    return item;
  }));
  const action = $('#onboarding-primary-action');
  action.textContent = ready ? '打开网页助手' : '查看管理员设置';
  action.dataset.view = ready ? 'assistant' : 'connectors';
  action.dataset.admin = ready ? 'false' : 'true';
}

function spendMoney(value) {
  return `$${Number(value || 0).toFixed(Number(value || 0) >= 1 ? 2 : 4)}`;
}

function spendPercent(value) {
  return typeof value === 'number' ? `${Math.round(value * 100)}%` : 'No cap';
}

function spendPolicyEditor({ target, policy, title, subtitle, route = {}, usage, utilization }) {
  const form = element('form', 'spend-policy-editor');
  form.dataset.target = target;
  for (const [key, value] of Object.entries(route)) form.dataset[key] = value;

  const identity = element('div', 'spend-policy-identity');
  identity.append(
    element('strong', '', title),
    element('span', '', subtitle),
  );
  if (usage) {
    const meter = element('div', 'spend-meter');
    const fill = element('i');
    const ratio = Math.max(0, utilization?.highest || 0);
    fill.style.width = `${Math.min(100, ratio * 100)}%`;
    meter.classList.toggle('warning', ratio >= 0.75 && ratio < 0.95);
    meter.classList.toggle('danger', ratio >= 0.95);
    meter.append(fill);
    identity.append(
      element(
        'span',
        'spend-usage-copy',
        `${usage.runs || 0} runs / ${spendMoney(usage.costUsd)} / ${spendPercent(utilization?.highest)}`,
      ),
      meter,
    );
  }

  const modeField = element('label', 'field');
  modeField.append(element('span', '', 'Limit'));
  const mode = document.createElement('select');
  mode.name = 'mode';
  const modes = target === 'workspace' || target === 'workspace-default-channel'
    ? [['disabled', 'No limit'], ['custom', 'Custom']]
    : [['inherit', 'Inherit'], ['custom', 'Custom'], ['disabled', 'No local limit']];
  for (const [value, label] of modes) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    mode.append(option);
  }
  mode.value = policy?.mode || modes[0][0];
  modeField.append(mode);

  const runField = element('label', 'field');
  runField.append(element('span', '', 'Max runs'));
  const runs = document.createElement('input');
  runs.name = 'maxRunsPerMonth';
  runs.type = 'number';
  runs.min = '0';
  runs.step = '1';
  runs.placeholder = 'Unlimited';
  runs.value = policy?.maxRunsPerMonth ?? '';
  runField.append(runs);

  const costField = element('label', 'field');
  costField.append(element('span', '', 'Max USD'));
  const cost = document.createElement('input');
  cost.name = 'maxCostUsdPerMonth';
  cost.type = 'number';
  cost.min = '0';
  cost.step = '0.01';
  cost.placeholder = 'Unlimited';
  cost.value = policy?.maxCostUsdPerMonth ?? '';
  costField.append(cost);

  const save = element('button', 'secondary-button', 'Save');
  save.type = 'submit';
  const applyMode = () => {
    const custom = mode.value === 'custom';
    runs.disabled = !custom;
    cost.disabled = !custom;
  };
  mode.addEventListener('change', applyMode);
  applyMode();
  save.disabled = state.auth?.principal?.role === 'viewer';
  form.append(identity, modeField, runField, costField, save);
  form.addEventListener('submit', (event) => void saveSpendPolicy(event));
  return form;
}

async function saveSpendPolicy(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  const mode = form.elements.mode.value;
  const policy = { mode };
  if (mode === 'custom') {
    if (form.elements.maxRunsPerMonth.value !== '') {
      policy.maxRunsPerMonth = Number(form.elements.maxRunsPerMonth.value);
    }
    if (form.elements.maxCostUsdPerMonth.value !== '') {
      policy.maxCostUsdPerMonth = Number(form.elements.maxCostUsdPerMonth.value);
    }
  }
  setButtonBusy(button, true, 'Saving', 'Save');
  try {
    state.spend = await getJson('/v1/spend/policies', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workspaceId: currentWorkspaceId(),
        target: form.dataset.target,
        projectId: form.dataset.projectId,
        platform: form.dataset.platform,
        channelId: form.dataset.channelId,
        policy,
      }),
    });
    await refreshAll({ quiet: true });
    showToast('Spend policy saved');
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    setButtonBusy(button, false, 'Saving', 'Save');
  }
}

function renderSpend() {
  const spend = state.spend;
  const summary = $('#spend-summary');
  if (!spend) {
    summary.replaceChildren(metric('—', 'Monthly runs'), metric('—', 'Reported cost'));
    return;
  }
  const workspace = spend.workspace || {};
  const alerts = spend.alerts || [];
  const critical = alerts.filter((alert) => alert.thresholdPercent === 95).length;
  const coverage = spend.coverage || {};
  summary.replaceChildren(
    metric(workspace.usage?.runs || 0, 'Monthly runs'),
    metric(spendMoney(workspace.usage?.costUsd), 'Provider-reported cost'),
    metric(critical, '95% alerts'),
    metric(
      coverage.records ? `${coverage.costReported || 0}/${coverage.records}` : '0/0',
      'Cost coverage',
    ),
  );
  $('#spend-period').textContent = spend.period || 'Current month';
  $('#spend-coverage').textContent = `${coverage.tokensReported || 0} token reports / ${coverage.costReported || 0} cost reports${coverage.legacyChannels ? ` / ${coverage.legacyChannels} legacy routes hidden` : ''}`;

  const purposeLabels = {
    agent: 'Project agent',
    memory_retrieval: 'Luna retrieval',
    memory_query: 'Luna query',
    memory_analysis: 'Luna synthesis',
    memory_wrapup: 'Luna wrapup',
  };
  const purposeRoot = $('#spend-purposes');
  purposeRoot.replaceChildren();
  for (const purpose of spend.purposes || []) {
    const row = element('div', 'spend-purpose-row');
    const copy = element('div', 'spend-purpose-copy');
    copy.append(
      element('strong', '', purposeLabels[purpose.purpose] || statusLabel(purpose.purpose)),
      element('span', '', `${purpose.calls || 0} call${purpose.calls === 1 ? '' : 's'} / ${purpose.runs || 0} user run${purpose.runs === 1 ? '' : 's'}`),
    );
    const tokenTotal = (purpose.inputTokens || 0) + (purpose.outputTokens || 0);
    row.append(
      copy,
      element('span', '', `${purpose.inputTokens || 0} in`),
      element('span', '', `${purpose.outputTokens || 0} out`),
      element('span', '', `${tokenTotal} tokens`),
      element('span', '', spendMoney(purpose.costUsd)),
      element('span', 'spend-purpose-coverage', `${purpose.tokenReportedCalls || 0}/${purpose.calls || 0} token / ${purpose.costReportedCalls || 0}/${purpose.calls || 0} cost`),
    );
    purposeRoot.append(row);
  }
  if (!purposeRoot.children.length) {
    purposeRoot.append(element('div', 'empty-state', 'No model usage this month'));
  }

  const workspacePolicies = $('#spend-workspace-policies');
  workspacePolicies.replaceChildren(
    spendPolicyEditor({
      target: 'workspace',
      policy: workspace.policy,
      title: workspace.name || 'Workspace',
      subtitle: 'All projects and channels',
      usage: workspace.usage,
      utilization: workspace.utilization,
    }),
    spendPolicyEditor({
      target: 'workspace-default-channel',
      policy: workspace.defaultChannelPolicy,
      title: 'New channel default',
      subtitle: 'Applied independently to every inherited channel',
    }),
  );

  const projects = $('#spend-projects');
  projects.replaceChildren();
  for (const project of spend.projects || []) {
    const row = element('div', 'spend-project-row');
    row.append(
      spendPolicyEditor({
        target: 'project',
        policy: project.policy,
        title: project.name,
        subtitle: `${project.projectId} aggregate`,
        route: { projectId: project.projectId },
        usage: project.usage,
        utilization: project.utilization,
      }),
    );
    projects.append(row);
  }
  if (!projects.children.length) projects.append(element('div', 'empty-state', 'No projects'));

  const channels = $('#spend-channels');
  channels.replaceChildren();
  for (const channel of spend.channels || []) {
    channels.append(
      spendPolicyEditor({
        target: 'channel',
        policy: channel.policy,
        title: channel.title,
        subtitle: `${channel.projectName} / ${channel.platform} / ${channel.policySource}`,
        route: {
          projectId: channel.projectId,
          platform: channel.platform,
          channelId: channel.channelId,
        },
        usage: channel.usage,
        utilization: channel.utilization,
      }),
    );
  }
  if (!channels.children.length) channels.append(element('div', 'empty-state', 'No channels observed'));

  const alertRoot = $('#spend-alerts');
  alertRoot.replaceChildren();
  for (const alert of alerts) {
    const route = [alert.scope, alert.projectId, alert.channelId].filter(Boolean).join(' / ');
    const row = element('div', 'spend-alert-row');
    row.append(
      statePill(alert.thresholdPercent >= 95 ? 'failed' : 'running'),
      element('strong', '', `${alert.thresholdPercent}% ${alert.metric}`),
      element('span', '', route),
      element('span', '', `${Number(alert.current).toFixed(alert.metric === 'cost' ? 2 : 0)} / ${Number(alert.limit).toFixed(alert.metric === 'cost' ? 2 : 0)}`),
      element('time', '', formatTime(alert.triggeredAt, true)),
    );
    alertRoot.append(row);
  }
  $('#spend-alerts-section').hidden = !alerts.length;
}

function auditFilters() {
  return {
    projectId: $('#audit-project')?.value || '',
    category: $('#audit-category')?.value || '',
    outcome: $('#audit-outcome')?.value || '',
    actor: $('#audit-actor')?.value.trim() || '',
    action: $('#audit-action')?.value.trim() || '',
    destination: $('#audit-destination')?.value.trim() || '',
  };
}

function auditQuery() {
  const query = new URLSearchParams({
    workspaceId: currentWorkspaceId(),
    limit: '200',
  });
  for (const [key, value] of Object.entries(auditFilters())) {
    if (value) query.set(key, value);
  }
  return query;
}

async function refreshAudit() {
  const [audit, lifecycle] = await Promise.all([
    getJson(`/v1/audit?${auditQuery().toString()}`),
    previewDataLifecycle({ quiet: true }),
  ]);
  state.audit = audit;
  state.dataLifecycle = lifecycle;
  if (!(state.audit.entries || []).some((entry) => entry.id === state.selectedAuditId)) {
    state.selectedAuditId = state.audit.entries?.[0]?.id || null;
  }
  renderAudit();
  renderWorkspaceHeader();
}

function dataLifecyclePolicy() {
  return {
    retentionDays: Number($('#data-lifecycle-days')?.value || 90),
    keepLatestPerThread: Number($('#data-lifecycle-keep')?.value || 20),
  };
}

function renderDataLifecycle() {
  const lifecycle = state.dataLifecycle;
  const status = $('#data-lifecycle-status');
  const summary = $('#data-lifecycle-summary');
  const apply = $('#apply-data-lifecycle');
  if (!lifecycle) {
    status.textContent = 'No preview';
    summary.textContent = `${$('#data-lifecycle-days')?.value || 90} days / ${$('#data-lifecycle-keep')?.value || 20} per thread`;
    apply.disabled = true;
    return;
  }
  const removed = lifecycle.removed || {};
  status.textContent = `${removed.agentRuns || 0} terminal runs eligible`;
  const preserved = lifecycle.preserved || {};
  const protectedRuns =
    (preserved.activeRuns || 0) +
    (preserved.recentTerminalRuns || 0) +
    (preserved.referencedTerminalRuns || 0);
  summary.textContent = `${removed.agentRunEvents || 0} events, ${removed.outbox || 0} outbound, ${removed.toolApprovals || 0} approvals / ${protectedRuns} runs protected`;
  apply.disabled =
    state.auth?.principal?.role !== 'owner' || !(removed.agentRuns > 0);
}

async function previewDataLifecycle(options = {}) {
  const policy = dataLifecyclePolicy();
  const query = new URLSearchParams({
    workspaceId: currentWorkspaceId(),
    retentionDays: String(policy.retentionDays),
    keepLatestPerThread: String(policy.keepLatestPerThread),
  });
  try {
    const lifecycle = await getJson(`/v1/data-lifecycle?${query.toString()}`);
    state.dataLifecycle = lifecycle;
    renderDataLifecycle();
    return lifecycle;
  } catch (error) {
    if (!options.quiet) showToast(error.message, 'error');
    throw error;
  }
}

async function applyDataLifecycle() {
  const lifecycle = state.dataLifecycle || await previewDataLifecycle();
  if (!lifecycle.removed?.agentRuns) return;
  const workspaceId = currentWorkspaceId();
  if (!window.confirm(`Delete ${lifecycle.removed.agentRuns} terminal runs from ${workspaceId}? Preserved ledgers and managed artifacts will not be removed.`)) return;
  const button = $('#apply-data-lifecycle');
  setButtonBusy(button, true, 'Applying', 'Apply');
  try {
    const result = await getJson('/v1/data-lifecycle', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workspaceId,
        confirmationWorkspaceId: workspaceId,
        ...dataLifecyclePolicy(),
      }),
    });
    state.dataLifecycle = result;
    await refreshAudit();
    showToast(`Removed ${result.removed.agentRuns} terminal runs.`, 'success');
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    setButtonBusy(button, false, 'Applying', 'Apply');
    renderDataLifecycle();
  }
}

function renderAuditProjectSelect() {
  const select = $('#audit-project');
  if (!select) return;
  const selected = select.value;
  select.replaceChildren();
  const all = document.createElement('option');
  all.value = '';
  all.textContent = 'All projects';
  select.append(all);
  for (const project of state.workspace?.projects || []) {
    const option = document.createElement('option');
    option.value = project.projectId;
    option.textContent = project.name;
    select.append(option);
  }
  select.value = [...select.options].some((option) => option.value === selected)
    ? selected
    : '';
}

function auditOutcomeState(outcome) {
  if (outcome === 'failed' || outcome === 'denied') return 'failed';
  if (outcome === 'cancelled') return 'cancelled';
  if (outcome === 'started') return 'running';
  return 'ready';
}

function auditRoute(entry) {
  return [entry.projectId, entry.platform, entry.channelId || entry.threadId]
    .filter(Boolean)
    .join(' / ') || entry.workspaceId;
}

function renderAuditDetail(entry) {
  const root = $('#audit-detail');
  root.replaceChildren();
  if (!entry) {
    root.append(element('div', 'empty-state', 'Select an audit entry'));
    return;
  }
  const heading = element('div', 'audit-detail-heading');
  heading.append(
    element('span', 'eyebrow', `${entry.category} / ${entry.source}`),
    element('h2', '', statusLabel(entry.action)),
    statePill(auditOutcomeState(entry.outcome), statusLabel(entry.outcome)),
  );
  const facts = element('dl', 'audit-facts');
  const appendFact = (label, value) => {
    if (!value) return;
    facts.append(element('dt', '', label), element('dd', '', String(value)));
  };
  const appendLinkFact = (label, value) => {
    if (!value) return;
    const link = element('a', '', '打开外部结果');
    link.href = value;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    const detail = element('dd');
    detail.append(link);
    facts.append(element('dt', '', label), detail);
  };
  appendFact('Time', new Date(entry.at).toLocaleString());
  appendFact('Actor', entry.actor);
  appendFact('Workspace', entry.workspaceId);
  appendFact('Project', entry.projectId);
  appendFact('Channel', entry.channelId);
  appendFact('Thread', entry.threadId);
  appendFact('Platform', entry.platform);
  appendFact('Destination', entry.destination);
  appendLinkFact('External result', entry.resultUrl);
  appendFact('Agent identity', entry.agentIdentityId);
  appendFact('Credential identity', entry.credentialIdentityId);
  appendFact('Credential revision', entry.credentialIdentityRevision);
  appendFact('External actor', entry.externalActor);
  appendFact('Run', entry.runId);
  appendFact('Reference', entry.referenceId);
  const summary = element('div', 'audit-summary-copy');
  summary.append(element('span', 'eyebrow', 'Summary'), element('p', '', entry.summary));
  root.append(heading, facts, summary);
  if (entry.tool) {
    const tool = element('div', 'audit-tool-detail');
    tool.append(
      element(
        'span',
        'eyebrow',
        entry.tool.source === 'provider-native'
          ? `${statusLabel(entry.tool.provider || 'provider')} native tool`
          : 'Brokered tool',
      ),
      element('strong', '', entry.tool.title || entry.tool.name || 'Tool'),
      element('span', '', `${entry.tool.grantKind || 'unknown'} / ${entry.tool.risk || 'unknown'}${typeof entry.tool.durationMs === 'number' ? ` / ${entry.tool.durationMs} ms` : ''}`),
      ...(entry.tool.destination
        ? [element('span', '', `Destination: ${entry.tool.destination}`)]
        : []),
      ...(entry.tool.resultUrl
        ? (() => {
            const link = element('a', '', '打开外部结果');
            link.href = entry.tool.resultUrl;
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            return [link];
          })()
        : []),
      ...(entry.tool.credentialIdentityId
        ? [
            element(
              'span',
              '',
              `Identity: ${entry.tool.credentialIdentityId} r${entry.tool.credentialIdentityRevision || '?'}`,
            ),
          ]
        : []),
      ...(entry.tool.externalActor
        ? [element('span', '', `External actor: ${entry.tool.externalActor}`)]
        : []),
      element('span', '', `Input fields: ${(entry.tool.argumentKeys || []).join(', ') || 'none'}`),
    );
    root.append(tool);
  }
}

function renderAudit() {
  renderAuditProjectSelect();
  renderDataLifecycle();
  const audit = state.audit || { entries: [], total: 0 };
  const entries = audit.entries || [];
  const categories = new Set(entries.map((entry) => entry.category));
  const needsAttention = entries.filter(
    (entry) => entry.outcome === 'failed' || entry.outcome === 'denied',
  ).length;
  $('#audit-summary').replaceChildren(
    metric(audit.total || 0, 'Matching evidence'),
    metric(categories.size, 'Categories'),
    metric(needsAttention, 'Needs attention'),
    metric(audit.truncated ? '200+' : entries.length, 'Loaded'),
  );
  const list = $('#audit-list');
  list.replaceChildren();
  for (const entry of entries) {
    const row = element('button', 'audit-row');
    row.type = 'button';
    row.classList.toggle('selected', entry.id === state.selectedAuditId);
    const copy = element('div', 'audit-row-copy');
    copy.append(
      element('strong', '', statusLabel(entry.action)),
      element('span', '', entry.summary),
      element('small', '', `${entry.actor} / ${auditRoute(entry)}`),
    );
    row.append(
      statePill(auditOutcomeState(entry.outcome), statusLabel(entry.outcome)),
      copy,
      element('time', '', formatTime(entry.at, true)),
    );
    row.addEventListener('click', () => {
      state.selectedAuditId = entry.id;
      renderAudit();
    });
    list.append(row);
  }
  if (!entries.length) list.append(element('div', 'empty-state', 'No matching audit evidence'));
  renderAuditDetail(entries.find((entry) => entry.id === state.selectedAuditId));
}

function exportAudit() {
  const link = document.createElement('a');
  link.href = `/v1/audit.csv?${auditQuery().toString()}`;
  link.download = `opentag-audit-${currentWorkspaceId()}.csv`;
  document.body.append(link);
  link.click();
  link.remove();
}

function selectedAccessProject() {
  return projectById(state.selectedAccessProjectId);
}

function projectAccessPolicy(project) {
  return (state.access?.projectPolicies || []).find((policy) =>
    projectMatches(project, policy.projectId),
  );
}

function projectAccessMemberships(project) {
  return (state.access?.projectMemberships || []).filter((membership) =>
    projectMatches(project, membership.projectId),
  );
}

function accessMember(memberId) {
  return (state.access?.members || []).find((member) => member.id === memberId);
}

function renderAccessSummary() {
  const root = $('#access-summary');
  const members = state.access?.members || [];
  const policies = state.access?.projectPolicies || [];
  root.replaceChildren(
    metric(members.length, 'Workspace members'),
    metric(members.filter((member) => member.status === 'active').length, 'Active'),
    metric(
      members.filter(
        (member) => member.role === 'owner' || member.role === 'admin',
      ).length,
      'Owners and admins',
    ),
    metric(policies.filter((policy) => policy.mode !== 'open').length, 'Managed projects'),
  );
}

function accessIdentityLabel(member) {
  return (member.identities || [])
    .map((identity) => `${statusLabel(identity.platform)}: ${identity.externalId}`)
    .join(' / ');
}

function renderAccessMembers() {
  const root = $('#access-member-list');
  const members = state.access?.members || [];
  root.replaceChildren();
  if (!members.length) {
    root.append(element('div', 'empty-state compact-empty', 'No workspace members'));
    $('#access-member-role').value = 'owner';
    return;
  }
  for (const member of members) {
    const row = element('div', 'access-row');
    const copy = element('div', 'access-row-copy');
    copy.append(
      element('strong', '', member.displayName),
      element('small', '', accessIdentityLabel(member)),
    );
    const status = element('div', 'access-row-status');
    status.append(statePill(member.role), statePill(member.status));
    const actions = element('div', 'access-row-actions');
    const toggle = element(
      'button',
      '',
      member.status === 'active' ? 'Suspend' : 'Activate',
    );
    toggle.type = 'button';
    toggle.addEventListener('click', () =>
      void updateAccessMember(member, {
        status: member.status === 'active' ? 'suspended' : 'active',
      }),
    );
    const remove = element('button', 'remove-access', 'Remove');
    remove.type = 'button';
    remove.addEventListener('click', () => void removeAccessMember(member));
    actions.append(toggle, remove);
    row.append(copy, status, actions);
    root.append(row);
  }
}

function fillAccessProjectControls() {
  const projects = state.workspace?.projects || [];
  const projectSelect = $('#access-project');
  const memberSelect = $('#access-project-member');
  const selected = projectById(state.selectedAccessProjectId) || projects[0];
  state.selectedAccessProjectId = selected?.projectId || null;
  projectSelect.replaceChildren();
  for (const project of projects) {
    const option = element('option', '', project.name);
    option.value = project.projectId;
    option.selected = projectMatches(project, state.selectedAccessProjectId);
    projectSelect.append(option);
  }

  memberSelect.replaceChildren();
  for (const member of state.access?.members || []) {
    if (member.status !== 'active') continue;
    const option = element('option', '', `${member.displayName} / ${statusLabel(member.role)}`);
    option.value = member.id;
    memberSelect.append(option);
  }
  memberSelect.disabled = !memberSelect.options.length;
  $('#add-project-member').disabled = !selected || !memberSelect.options.length;
}

function renderProjectAccess() {
  const root = $('#access-project-member-list');
  const project = selectedAccessProject();
  const policy = project ? projectAccessPolicy(project) : undefined;
  $('#access-mode').value = policy?.mode || 'open';
  root.replaceChildren();
  if (!project) {
    root.append(element('div', 'empty-state compact-empty', 'No project selected'));
    return;
  }
  const memberships = projectAccessMemberships(project);
  if (!memberships.length) {
    root.append(element('div', 'empty-state compact-empty', 'No project members'));
    return;
  }
  for (const membership of memberships) {
    const member = accessMember(membership.memberId);
    const row = element('div', 'access-row');
    const copy = element('div', 'access-row-copy');
    copy.append(
      element('strong', '', member?.displayName || membership.memberId),
      element('small', '', member ? accessIdentityLabel(member) : membership.memberId),
    );
    const role = statePill(membership.role);
    const actions = element('div', 'access-row-actions');
    const remove = element('button', 'remove-access', 'Remove');
    remove.type = 'button';
    remove.addEventListener('click', () =>
      void removeProjectMembership(project, membership),
    );
    actions.append(remove);
    row.append(copy, role, actions);
    root.append(row);
  }
}

function renderAccess() {
  renderAccessSummary();
  renderAccessMembers();
  fillAccessProjectControls();
  renderProjectAccess();
  renderOperatorCredentials();
}

function canManageOperatorCredentials() {
  const principal = state.auth?.principal;
  return Boolean(
    principal?.role === 'owner' && principal.workspaceIds?.includes('*'),
  );
}

function renderOperatorCredentials() {
  const section = $('#operator-credentials');
  const root = $('#operator-credential-list');
  const count = $('#operator-credential-count');
  section.hidden = false;
  root.replaceChildren();
  if (!canManageOperatorCredentials()) {
    count.className = 'state-pill planned';
    count.textContent = 'Owner only';
    root.append(
      element(
        'div',
        'empty-state compact-empty',
        'Installation owner access is required to manage operator credentials.',
      ),
    );
    return;
  }
  const credentials = state.operatorCredentials?.credentials || [];
  const active = credentials.filter((credential) => credential.status === 'active');
  count.className = `state-pill ${active.length ? 'ready' : 'planned'}`;
  count.textContent = `${active.length} active`;
  if (
    !state.operatorCredentials?.bootstrapOwnerConfigured &&
    !active.some(
      (credential) =>
        credential.role === 'owner' && credential.workspaceIds.includes('*'),
    )
  ) {
    $('#operator-credential-role').value = 'owner';
    $('#operator-credential-workspaces').value = '*';
  }
  if (!credentials.length) {
    root.append(
      element('div', 'empty-state compact-empty', 'No persistent credentials'),
    );
    return;
  }
  for (const credential of credentials) {
    const row = element('div', 'access-row operator-credential-row');
    const copy = element('div', 'access-row-copy');
    copy.append(
      element('strong', '', credential.displayName),
      element(
        'small',
        '',
        `${credential.id} / ${credential.tokenPrefix}... / ${credential.workspaceIds.join(', ')} / r${credential.revision}`,
      ),
    );
    const status = element('div', 'access-row-status');
    status.append(statePill(credential.role), statePill(credential.status));
    const actions = element('div', 'access-row-actions');
    if (credential.status === 'active') {
      const rotate = element('button', '', 'Rotate');
      rotate.type = 'button';
      rotate.addEventListener('click', () => void rotateOperatorCredential(credential));
      const revoke = element('button', 'remove-access', 'Revoke');
      revoke.type = 'button';
      revoke.addEventListener('click', () => void revokeOperatorCredential(credential));
      actions.append(rotate, revoke);
    }
    row.append(copy, status, actions);
    root.append(row);
  }
}

function showOperatorCredentialSecret(token) {
  $('#operator-credential-secret').textContent = token;
  $('#operator-credential-secret-dialog').showModal();
}

function closeOperatorCredentialSecret() {
  $('#operator-credential-secret-dialog').close();
  $('#operator-credential-secret').textContent = '';
}

async function reloadOperatorCredentials() {
  if (!canManageOperatorCredentials()) {
    state.operatorCredentials = null;
    renderOperatorCredentials();
    return;
  }
  state.operatorCredentials = await getJson('/v1/operator-credentials');
  renderOperatorCredentials();
}

async function createOperatorCredential(event) {
  event.preventDefault();
  const button = $('#create-operator-credential');
  setButtonBusy(button, true, 'Creating', 'Create credential');
  try {
    const workspaceIds = $('#operator-credential-workspaces').value
      .split(/[\s,]+/u)
      .map((value) => value.trim())
      .filter(Boolean);
    const data = await getJson('/v1/operator-credentials', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: $('#operator-credential-id').value,
        displayName: $('#operator-credential-name').value,
        role: $('#operator-credential-role').value,
        workspaceIds,
      }),
    });
    $('#operator-credential-form').reset();
    $('#operator-credential-role').value = 'admin';
    if (data.session) applyOperatorSession(data.session);
    await reloadOperatorCredentials();
    showOperatorCredentialSecret(data.token);
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    setButtonBusy(button, false, 'Creating', 'Create credential');
  }
}

async function rotateOperatorCredential(credential) {
  if (!window.confirm(`Rotate ${credential.displayName}? Its current token and sessions will stop working.`)) return;
  try {
    const data = await getJson(
      `/v1/operator-credentials/${encodeURIComponent(credential.id)}/rotate`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ expectedRevision: credential.revision }),
      },
    );
    await reloadOperatorCredentials();
    showOperatorCredentialSecret(data.token);
  } catch (error) {
    showToast(error.message, 'error');
  }
}

async function revokeOperatorCredential(credential) {
  if (!window.confirm(`Revoke ${credential.displayName}? Its token and sessions will stop working.`)) return;
  try {
    await getJson(
      `/v1/operator-credentials/${encodeURIComponent(credential.id)}/revoke`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ expectedRevision: credential.revision }),
      },
    );
    await reloadOperatorCredentials();
    showToast(`${credential.displayName} revoked`);
  } catch (error) {
    showToast(error.message, 'error');
  }
}

function accessErrorMessage(error) {
  const messages = {
    workspace_first_member_must_be_owner: 'The first workspace member must be an owner.',
    workspace_last_owner_required: 'Add another active owner before changing this owner.',
    workspace_member_identity_already_linked: 'That client user ID is already linked.',
  };
  return messages[error.message] || error.message;
}

async function saveAccessMember(event) {
  event.preventDefault();
  const button = $('#add-access-member');
  setButtonBusy(button, true, 'Adding', 'Add member');
  try {
    const data = await getJson('/v1/access/members', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workspaceId: currentWorkspaceId(),
        displayName: $('#access-member-name').value,
        role: $('#access-member-role').value,
        platform: $('#access-member-platform').value,
        externalId: $('#access-member-external-id').value,
      }),
    });
    state.access = data.access;
    $('#access-member-form').reset();
    $('#access-member-role').value = state.access.members.length ? 'member' : 'owner';
    await refreshAll({ quiet: true });
    showToast('Workspace member added');
  } catch (error) {
    showToast(accessErrorMessage(error), 'error');
  } finally {
    setButtonBusy(button, false, 'Adding', 'Add member');
  }
}

async function updateAccessMember(member, updates) {
  try {
    const data = await getJson('/v1/access/members', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...member,
        ...updates,
      }),
    });
    state.access = data.access;
    renderAccess();
    showToast(`${member.displayName} updated`);
  } catch (error) {
    showToast(accessErrorMessage(error), 'error');
  }
}

async function removeAccessMember(member) {
  if (!window.confirm(`Remove ${member.displayName} from this workspace?`)) return;
  try {
    const query = new URLSearchParams({ workspaceId: currentWorkspaceId() });
    const data = await getJson(
      `/v1/access/members/${encodeURIComponent(member.id)}?${query}`,
      { method: 'DELETE' },
    );
    state.access = data.access;
    await refreshAll({ quiet: true });
    showToast(`${member.displayName} removed`);
  } catch (error) {
    showToast(accessErrorMessage(error), 'error');
  }
}

async function saveAccessPolicy(event) {
  event.preventDefault();
  const project = selectedAccessProject();
  if (!project) return;
  const button = $('#save-access-policy');
  setButtonBusy(button, true, 'Saving', 'Save mode');
  try {
    const data = await getJson('/v1/access/project-policy', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workspaceId: currentWorkspaceId(),
        projectId: project.projectId,
        mode: $('#access-mode').value,
      }),
    });
    state.access = data.access;
    await refreshAll({ quiet: true });
    showToast(`${project.name} access updated`);
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    setButtonBusy(button, false, 'Saving', 'Save mode');
  }
}

async function assignProjectMember(event) {
  event.preventDefault();
  const project = selectedAccessProject();
  const memberId = $('#access-project-member').value;
  if (!project || !memberId) return;
  const button = $('#add-project-member');
  setButtonBusy(button, true, 'Assigning', 'Assign');
  try {
    const data = await getJson('/v1/access/project-memberships', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workspaceId: currentWorkspaceId(),
        projectId: project.projectId,
        memberId,
        role: $('#access-project-role').value,
      }),
    });
    state.access = data.access;
    await refreshAll({ quiet: true });
    showToast('Project role assigned');
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    setButtonBusy(button, false, 'Assigning', 'Assign');
  }
}

async function removeProjectMembership(project, membership) {
  try {
    const query = new URLSearchParams({
      workspaceId: currentWorkspaceId(),
      projectId: project.projectId,
      memberId: membership.memberId,
    });
    const data = await getJson(`/v1/access/project-memberships?${query}`, {
      method: 'DELETE',
    });
    state.access = data.access;
    await refreshAll({ quiet: true });
    showToast('Project role removed');
  } catch (error) {
    showToast(error.message, 'error');
  }
}

function projectRunState(project) {
  const summary = project.runSummary || {};
  if ((summary.running || 0) + (summary.queued || 0) > 0) return 'running';
  if ((summary.failed || 0) > 0) return 'failed';
  return 'ready';
}

function renderOverviewProjects() {
  const root = $('#overview-projects');
  root.replaceChildren();
  const projects = state.workspace?.projects || [];
  if (!projects.length) {
    root.append(element('div', 'empty-state', 'No projects'));
    return;
  }
  for (const project of projects) {
    const projectIdentity =
      project.agentMode === 'inherit'
        ? state.workspace?.workspace?.identity || project.identity
        : project.identity;
    const card = element('article', 'project-card');
    card.tabIndex = 0;
    card.setAttribute('role', 'button');

    const head = element('div', 'project-card-head');
    const identity = element('div', 'project-card-head');
    identity.append(
      element('span', 'avatar', initials(projectIdentity?.displayName)),
      element('strong', '', project.name),
    );
    head.append(identity, statePill(projectRunState(project)));

    const body = element('div', 'project-card-body');
    body.append(
      element('span', '', projectIdentity?.displayName || 'MaxTag'),
      element(
        'span',
        '',
        `${statusLabel(projectIdentity?.defaultExecutorId)} / ${project.toolCount || 0} authorized`,
      ),
      element(
        'span',
        '',
        project.clients?.length ? project.clients.join(', ') : 'No client binding',
      ),
    );

    const foot = element('div', 'project-card-foot');
    foot.append(
      element('span', '', `${project.bindingCount || 0} bindings`),
      element('span', '', project.lastRunAt ? formatTime(project.lastRunAt, true) : 'No runs'),
    );
    card.append(head, body, foot);
    const open = () => {
      selectProject(project.projectId);
      showView('projects');
    };
    card.addEventListener('click', open);
    card.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') open();
    });
    root.append(card);
  }
}

function renderConnectors() {
  const root = $('#connector-list');
  root.replaceChildren();
  for (const client of state.capabilities?.clients || []) {
    const row = element('div', 'connector-row');
    const copy = element('div');
    const transport = clientTransport(client);
    copy.append(
      element('strong', '', client.label || client.id),
      element(
        'small',
        '',
        `${client.inbound || 'not wired'} / ${transport?.mode || 'planned'}`,
      ),
    );
    row.append(copy, statePill(client.status));
    root.append(row);
  }
}

function clientTransport(client) {
  if (client.id === 'lark') return state.capabilities?.larkTransport;
  if (client.id === 'telegram') return state.capabilities?.telegramTransport;
  if (client.id === 'slack') return state.capabilities?.slackTransport;
  if (client.id === 'github') return state.capabilities?.githubTransport;
  return null;
}

function clientEndpoint(client) {
  if (client.id === 'lark') return '/v1/lark/events';
  if (client.id === 'telegram') return '/v1/telegram/events';
  if (client.id === 'slack') return '/v1/slack/events';
  if (client.id === 'github') return '/v1/github/events';
  if (client.id === 'web') return '/v1/assistant/sessions';
  return '/v1/client/events';
}

function clientRuntimeLabel(client) {
  const transport = clientTransport(client);
  if (client.id === 'web') return 'Authenticated / SQLite conversation';
  if (!transport) return client.status === 'planned' ? 'Not wired' : 'Generic receipt';
  if (client.id === 'lark') {
    const delivery = transport.mode === 'http'
      ? 'HTTP / credentials set'
      : `Memory / ${transport.hasCredentials ? 'credentials set' : 'no credentials'}`;
    const callback = transport.encryptionKeyConfigured
      ? 'signed + encrypted callback'
      : transport.verificationTokenConfigured
        ? 'token callback'
        : 'callback auth off';
    return `${delivery} / ${callback}`;
  }
  if (client.id === 'github') {
    const transportState = transport.hasToken ? 'token set' : 'no token';
    const webhookState = transport.webhookSecretConfigured
      ? 'secret set'
      : 'webhook off';
    const producerState = transport.workflowProducers?.enabled
      ? 'workflow producers on'
      : 'workflow producers off';
    return `${statusLabel(transport.mode)} / ${transportState} / ${webhookState} / ${producerState}`;
  }
  const secretConfigured = client.id === 'slack'
    ? transport.signingSecretConfigured
    : transport.webhookSecretConfigured;
  return transport.mode === 'http'
    ? `HTTP / ${secretConfigured ? 'secret set' : 'no secret'}`
    : `Memory / ${secretConfigured ? 'secret set' : 'no secret'}`;
}

function clientCell(label, value, className = '') {
  const cell = element('div', `client-cell ${className}`.trim());
  cell.append(
    element('span', 'client-cell-label', label),
    element('span', '', value),
  );
  return cell;
}

function renderLatestPairing() {
  const root = $('#pairing-result');
  const pairing = state.latestPairing;
  root.hidden = !pairing;
  if (!pairing) return;
  $('#pairing-command').textContent = pairing.command;
  $('#pairing-expiry').textContent = `Expires ${formatTime(pairing.invitation.expiresAt, true)}`;
}

function renderPairingInvitations() {
  const root = $('#pairing-invitations');
  root.replaceChildren();
  const invitations = state.pairings?.invitations || [];
  if (!invitations.length) {
    root.append(element('div', 'empty-state compact-empty', 'No invitations yet'));
    return;
  }
  for (const invitation of invitations.slice(0, 8)) {
    const row = element('div', 'pairing-invitation-row');
    const identity = element('div', 'pairing-invitation-copy');
    identity.append(
      element('strong', '', `${statusLabel(invitation.platform)} / ${invitation.projectId}`),
      element('small', '', `Created ${formatTime(invitation.createdAt, true)}`),
    );
    const expiry = element(
      'span',
      'pairing-invitation-expiry',
      invitation.status === 'pending'
        ? `Expires ${formatTime(invitation.expiresAt, true)}`
        : invitation.consumedAt
          ? `Used ${formatTime(invitation.consumedAt, true)}`
          : statusLabel(invitation.status),
    );
    const actions = element('div', 'pairing-row-actions');
    if (invitation.status === 'pending') {
      const revoke = element('button', 'danger-text-button', 'Revoke');
      revoke.type = 'button';
      revoke.addEventListener('click', () => void revokePairing(invitation.id));
      actions.append(revoke);
    }
    row.append(identity, expiry, statePill(invitation.status), actions);
    root.append(row);
  }
}

function renderConnectorConsole() {
  const clients = state.capabilities?.clients || [];
  const transports = clients
    .map((client) => clientTransport(client))
    .filter(Boolean);
  const configuredBindings = state.bindings.filter(
    (binding) => binding.source === 'configured',
  );
  $('#connector-summary').replaceChildren(
    metric(clients.filter((client) => client.status === 'ready').length, 'Native clients'),
    metric(transports.filter((transport) => transport.mode === 'http').length, 'Live transports'),
    metric(configuredBindings.length, 'Configured routes'),
    metric(state.pairings?.summary?.pending || 0, 'Pending invites'),
  );

  renderMcpConnectors();

  renderLatestPairing();
  renderPairingInvitations();

  const table = $('#client-table');
  table.replaceChildren();
  const header = element('div', 'client-table-header');
  for (const label of ['Client', 'Ingress', 'Surface', 'Runtime', 'State']) {
    header.append(element('span', '', label));
  }
  table.append(header);
  for (const client of clients) {
    const row = element('div', 'client-table-row');
    const identity = element('div', 'client-identity');
    identity.append(
      element('strong', '', client.label || client.id),
      element('small', '', client.id),
    );
    const ingress = clientCell('Ingress', client.inbound || 'Not wired', 'client-ingress');
    ingress.append(element('code', '', clientEndpoint(client)));
    row.append(
      identity,
      ingress,
      clientCell('Surface', client.surface || 'Planned'),
      clientCell('Runtime', clientRuntimeLabel(client)),
      statePill(client.status),
    );
    table.append(row);
  }

  const bindingList = $('#connector-bindings');
  bindingList.replaceChildren();
  if (!configuredBindings.length) {
    bindingList.append(element('div', 'empty-state compact-empty', 'No chats connected'));
    return;
  }
  for (const binding of configuredBindings) {
    const row = element('div', 'connector-binding-row');
    const identity = element('div');
    identity.append(
      element('strong', '', binding.title || binding.externalId),
      element(
        'small',
        '',
        `${statusLabel(binding.platform)} / ${binding.scope || 'thread'} / ${binding.source || 'observed'}`,
      ),
    );
    const project = element('div', 'binding-project');
    project.append(
      element('span', 'client-cell-label', 'Project'),
      element('strong', '', binding.projectId || 'general'),
    );
    const actions = element('div', 'binding-actions');
    if (binding.source === 'configured') {
      const unbind = element('button', 'danger-text-button', 'Unbind');
      unbind.type = 'button';
      unbind.addEventListener('click', () => void removeBinding(binding.id));
      actions.append(unbind);
    }
    row.append(
      identity,
      project,
      statePill(binding.activationMode, statusLabel(binding.activationMode)),
      actions,
    );
    bindingList.append(row);
  }
}

function renderLarkSetup() {
  const transport = state.capabilities?.larkTransport || {};
  const readiness = state.larkReadiness || {};
  const managed = state.larkConfig?.config;
  const credentialForm = $('#lark-credential-form');
  credentialForm.hidden = !canManageOperatorCredentials();
  if (!credentialForm.contains(document.activeElement)) {
    $('#lark-app-id').value = managed?.appId || '';
    $('#lark-app-secret').value = '';
    $('#lark-domain').value = managed?.domain || 'feishu';
    $('#lark-verification-token').value = '';
    $('#lark-encrypt-key').value = '';
  }
  $('#lark-callback-url').value = `${window.location.origin}/v1/lark/events`;
  $('#lark-app-secret').required = !managed?.configured;
  $('#lark-app-secret').placeholder = managed?.configured
    ? '已加密保存；留空保持不变'
    : '输入 App Secret';
  $('#lark-verification-token').placeholder = managed?.verificationTokenConfigured
    ? '已加密保存；留空保持不变'
    : '粘贴飞书 Verification Token';
  $('#lark-encrypt-key').placeholder = managed?.encryptionKeyConfigured
    ? '已加密保存；留空保持不变'
    : '粘贴飞书 Encrypt Key';
  $('#remove-lark-credentials').hidden = !managed?.configured;
  $('#lark-credential-hint').textContent = managed?.configured
    ? `已加密保存 · 版本 ${managed.revision} · ${formatTime(managed.updatedAt, true)}；修改后连接服务会自动重载。`
    : '凭据会在服务端使用 AES-256-GCM 加密保存，页面不会回显 App Secret。';
  const checks = [
    {
      label: '飞书应用凭据',
      description: transport.hasCredentials
        ? 'App ID 与 App Secret 已由平台加密托管'
        : '等待管理员在上方填写 App ID 与 App Secret',
      ready: Boolean(transport.hasCredentials),
    },
    {
      label: '消息连接',
      description: '群聊和私聊消息能够进入 MaxTag',
      ready: Boolean(readiness.ingressReady),
    },
    {
      label: '卡片交互',
      description: readiness.cardActionsReady
        ? '按钮与输入框回调已通过平台密钥保护'
        : '请配置回调地址、Verification Token 或 Encrypt Key',
      ready: Boolean(readiness.cardActionsReady),
    },
    {
      label: '真实执行器',
      description: '至少一个智能体执行器已启用',
      ready: Boolean(readiness.executorReady),
    },
    {
      label: '入群自动接入',
      description: '成员添加机器人并 @MaxTag，无需配对码',
      ready: transport.onboardingMode === 'add-bot-and-mention',
    },
  ];
  const readyCount = checks.filter((item) => item.ready).length;
  const ready = Boolean(readiness.ready);
  $('#lark-status-dot').classList.toggle('ready', ready);
  const stateNode = $('#lark-setup-state');
  stateNode.className = `state-pill ${ready ? 'ready' : 'planned'}`;
  stateNode.textContent = ready ? '连接正常' : `${readyCount} / ${checks.length} 已准备`;
  const callout = $('#lark-setup-callout');
  callout.classList.toggle('ready', ready);
  callout.replaceChildren(
    element('strong', '', ready ? 'MaxTag 已可加入飞书群' : '尚未完成飞书接入'),
    element(
      'span',
      '',
      ready
        ? '普通成员只需在群设置中添加 MaxTag，第一条消息 @MaxTag 即可。'
        : '完成管理员初始化后，普通成员无需登录本平台，也无需理解项目和群绑定。',
    ),
  );
  $('#lark-readiness-list').replaceChildren(...checks.map((item) => {
    const row = element('div', `lark-readiness-row${item.ready ? ' ready' : ''}`);
    row.append(
      element('span', 'lark-readiness-icon', item.ready ? '✓' : '—'),
      element('strong', '', item.label),
      element('span', '', item.description),
      element('small', '', item.ready ? '已就绪' : '待完成'),
    );
    return row;
  }));
  $('#lark-test-result').textContent = readiness.checkedAt
    ? `${readiness.message || (ready ? '连接正常' : '仍有未完成项')} · ${formatTime(readiness.checkedAt, true)}`
    : '尚未验证';
}

function larkHistoryChannels() {
  const channels = new Map();
  for (const binding of state.bindings || []) {
    if (binding.platform !== 'lark') continue;
    const channelId = binding.channelId || (binding.scope === 'channel' ? binding.externalId : '');
    if (!channelId) continue;
    const current = channels.get(channelId);
    const rank = (binding.scope === 'channel' ? 2 : 0) + (binding.source === 'configured' ? 1 : 0);
    if (!current || rank > current.rank) {
      channels.set(channelId, {
        channelId,
        title: binding.title || current?.title || channelId,
        projectId: binding.projectId || current?.projectId || 'general',
        rank,
      });
    }
  }
  return [...channels.values()].sort((a, b) => a.title.localeCompare(b.title));
}

function updateLarkHistoryRangeFields() {
  const custom = $('#lark-history-range').value === 'custom';
  for (const field of $$('.lark-history-custom')) field.hidden = !custom;
  $('#lark-history-since').required = custom;
  $('#lark-history-until').required = custom;
}

function larkHistoryRange() {
  const range = $('#lark-history-range').value;
  if (range === 'custom') {
    const sinceText = $('#lark-history-since').value;
    const untilText = $('#lark-history-until').value;
    if (!sinceText || !untilText) throw new Error('请选择完整的开始和结束日期');
    const since = new Date(`${sinceText}T00:00:00.000Z`);
    const until = new Date(`${untilText}T23:59:59.999Z`);
    if (since >= until) throw new Error('结束日期必须晚于开始日期');
    return { since: since.toISOString(), until: until.toISOString() };
  }
  const days = Number(range || 90);
  const until = new Date();
  const since = new Date(until.getTime() - days * 24 * 60 * 60_000);
  return { since: since.toISOString(), until: until.toISOString() };
}

function larkHistoryStatusLabel(status) {
  return ({
    awaiting_choice: '等待选择', pending: '等待导入', claimed: '正在导入',
    completed: '已完成', failed: '失败', cancelled: '已取消',
  })[status] || status;
}

function renderLarkHistoryImports() {
  const form = $('#lark-history-form');
  form.hidden = state.auth?.principal?.role === 'viewer';
  const select = $('#lark-history-channel');
  const selected = select.value;
  const channels = larkHistoryChannels();
  select.replaceChildren(...channels.map((channel) => {
    const option = element('option', '', `${channel.title} · ${channel.projectId}`);
    option.value = channel.channelId;
    option.dataset.projectId = channel.projectId;
    return option;
  }));
  if (channels.some((channel) => channel.channelId === selected)) select.value = selected;
  const ready = state.capabilities?.larkTransport?.mode === 'http';
  select.disabled = !channels.length || !ready;
  $('#preview-lark-history').disabled = !channels.length || !ready;
  $('#start-lark-history').disabled = !channels.length || !ready;
  $('#lark-history-preview').textContent = !ready
    ? '请先完成飞书消息连接。'
    : !channels.length
      ? '先把 MaxTag 拉进群并 @ 一次，群聊会自动出现在这里。'
      : '先预览权限与数量；正式导入会在后台断点续传。';
  updateLarkHistoryRangeFields();

  const jobs = state.larkHistoryImports?.jobs || [];
  const active = jobs.filter((job) => job.status === 'pending' || job.status === 'claimed').length;
  const stateNode = $('#lark-history-state');
  stateNode.className = `state-pill ${active ? 'running' : 'planned'}`;
  stateNode.textContent = active ? `${active} 个进行中` : '可选';
  const list = $('#lark-history-jobs');
  list.replaceChildren();
  if (!jobs.length) {
    list.append(element('div', 'empty-state compact-empty', '尚未执行历史初始化'));
    return;
  }
  for (const job of jobs.slice(0, 8)) {
    const row = element('div', 'lark-history-job');
    const identity = element('div');
    identity.append(
      element('strong', '', job.channelTitle || job.channelId),
      element('small', '', `${job.projectId} · ${larkHistoryStatusLabel(job.status)}`),
    );
    const progress = element('div');
    const since = Date.parse(job.since || job.createdAt);
    const until = Date.parse(job.until || job.completedAt || job.updatedAt);
    const cursor = Date.parse(job.cursor?.windowSince || job.completedAt || job.since || job.createdAt);
    const percent = Number.isFinite(since) && Number.isFinite(until) && until > since
      ? Math.max(0, Math.min(100, Math.round(((cursor - since) / (until - since)) * 100)))
      : job.status === 'completed' ? 100 : 0;
    const bar = element('div', 'lark-history-progress');
    const fill = element('i');
    fill.style.width = `${percent}%`;
    bar.append(fill);
    progress.append(
      element('span', '', `扫描 ${job.scannedMessages} · 导入 ${job.importedMessages} · 待审核记忆 ${job.proposalIds?.length || 0}`),
      bar,
      element('small', '', job.lastError || `${percent}% · ${formatTime(job.updatedAt, true)}`),
    );
    const actions = element('div');
    if (job.status === 'pending' || job.status === 'claimed' || job.status === 'awaiting_choice') {
      const cancel = element('button', 'danger-text-button', '取消');
      cancel.type = 'button';
      cancel.addEventListener('click', () => void cancelLarkHistoryImport(job, cancel));
      actions.append(cancel);
    } else {
      actions.append(statePill(job.status, larkHistoryStatusLabel(job.status)));
    }
    row.append(identity, progress, actions);
    list.append(row);
  }
}

async function previewLarkHistory(button = $('#preview-lark-history')) {
  const option = $('#lark-history-channel').selectedOptions[0];
  if (!option) return;
  setButtonBusy(button, true, '正在预览', '预览数量');
  try {
    const range = larkHistoryRange();
    const preview = await getJson('/v1/lark/history-imports/preview', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workspaceId: currentWorkspaceId(), channelId: option.value,
        projectId: option.dataset.projectId, ...range, maxMessages: 1000,
      }),
    });
    $('#lark-history-preview').textContent = preview.truncated
      ? `至少 ${preview.scannedMessages} 条消息、${preview.discoveredThreads} 个话题；数量较大，正式任务会分批导入。`
      : `预计扫描 ${preview.scannedMessages} 条消息、${preview.discoveredThreads} 个话题。`;
    if (preview.errors?.length) throw new Error(preview.errors[0].error);
  } catch (error) {
    $('#lark-history-preview').textContent = `预览失败：${error.message}`;
    showToast(error.message, 'error');
  } finally {
    setButtonBusy(button, false, '正在预览', '预览数量');
  }
}

async function startLarkHistoryImport(event) {
  event.preventDefault();
  const button = $('#start-lark-history');
  const option = $('#lark-history-channel').selectedOptions[0];
  if (!option) return;
  setButtonBusy(button, true, '正在创建', '后台导入');
  try {
    const range = larkHistoryRange();
    await getJson('/v1/lark/history-imports', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workspaceId: currentWorkspaceId(), channelId: option.value,
        projectId: option.dataset.projectId, ...range,
        analyzeMemory: $('#lark-history-analyze').checked,
      }),
    });
    showToast('历史初始化已在后台开始，可离开此页面');
    await refreshAll({ quiet: true });
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    setButtonBusy(button, false, '正在创建', '后台导入');
  }
}

async function cancelLarkHistoryImport(job, button) {
  if (!window.confirm('取消这个历史导入任务？已导入的聊天档案和待审核记忆会保留。')) return;
  setButtonBusy(button, true, '取消中', '取消');
  try {
    await getJson(`/v1/lark/history-imports/${encodeURIComponent(job.id)}/cancel`, { method: 'POST' });
    await refreshAll({ quiet: true });
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    setButtonBusy(button, false, '取消中', '取消');
  }
}

function updateExecutorAuthFields() {
  const apiMode = $('#executor-auth-mode').value === 'api-key';
  for (const field of $$('.executor-api-field')) field.hidden = !apiMode;
  const managed = state.executorConfig?.config;
  const preservesKey = managed?.configured &&
    managed.provider === $('#executor-provider').value &&
    managed.authMode === 'api-key' &&
    managed.hasApiKey;
  $('#executor-api-key').required = apiMode && !preservesKey;
  $('#executor-api-key').placeholder = preservesKey
    ? '已加密保存；留空保持不变'
    : '输入 API Key';
}

function renderExecutorSetup() {
  const managed = state.executorConfig?.config;
  const form = $('#executor-credential-form');
  form.hidden = !canManageOperatorCredentials();
  if (!form.contains(document.activeElement)) {
    $('#executor-provider').value = managed?.provider || 'codex';
    $('#executor-auth-mode').value = managed?.authMode || 'api-key';
    $('#executor-model').value = managed?.model || '';
    $('#executor-base-url').value = managed?.baseUrl || '';
    $('#executor-api-key').value = '';
  }
  updateExecutorAuthFields();
  $('#remove-executor-credentials').hidden = !managed?.configured;
  const provider = $('#executor-provider').value;
  const installation = state.executorConfig?.installations?.[provider];
  const ready = Boolean(state.larkReadiness?.executorReady);
  const stateNode = $('#executor-setup-state');
  stateNode.className = `state-pill ${ready ? 'ready' : 'planned'}`;
  stateNode.textContent = ready ? '已就绪' : '待配置';
  $('#executor-credential-hint').textContent = managed?.configured
    ? `${managed.provider === 'codex' ? 'Codex' : 'Claude'} · ${managed.authMode === 'cli' ? '本机 CLI 登录' : 'API Key'} · 版本 ${managed.revision} · ${formatTime(managed.updatedAt, true)}；修改后服务会自动重载。`
    : installation?.installed
      ? `${provider === 'codex' ? 'Codex CLI' : 'Claude CLI'} 已安装${installation.version ? `（${installation.version}）` : ''}；请选择认证方式。`
      : `${provider === 'codex' ? 'Codex CLI' : 'Claude CLI'} 尚未安装，无法启用该执行器。`;
}

async function saveExecutorCredentials(event) {
  event.preventDefault();
  const button = $('#save-executor-credentials');
  setButtonBusy(button, true, '正在验证', '验证并启用');
  try {
    const current = state.executorConfig?.config;
    const result = await getJson('/v1/config/executor', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        provider: $('#executor-provider').value,
        authMode: $('#executor-auth-mode').value,
        model: $('#executor-model').value.trim(),
        baseUrl: $('#executor-base-url').value.trim(),
        apiKey: $('#executor-api-key').value,
        expectedRevision: current?.revision || 0,
      }),
    });
    state.executorConfig = {
      ...state.executorConfig,
      config: result.config,
    };
    $('#executor-api-key').value = '';
    renderExecutorSetup();
    showToast(result.message || '真实执行器已保存，正在重新加载');
    await new Promise((resolve) => setTimeout(resolve, 4_000));
    await refreshAll({ quiet: true });
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    setButtonBusy(button, false, '正在验证', '验证并启用');
  }
}

async function removeExecutorCredentials(button = $('#remove-executor-credentials')) {
  const current = state.executorConfig?.config;
  if (!current?.configured || !window.confirm('停用真实执行器？Bot 将不再执行模型任务。')) return;
  setButtonBusy(button, true, '正在停用', '停用执行器');
  try {
    const result = await getJson('/v1/config/executor', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedRevision: current.revision }),
    });
    state.executorConfig = { ...state.executorConfig, config: result.config };
    renderExecutorSetup();
    showToast(result.message || '真实执行器已停用');
    await new Promise((resolve) => setTimeout(resolve, 4_000));
    await refreshAll({ quiet: true });
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    setButtonBusy(button, false, '正在停用', '停用执行器');
  }
}

async function saveLarkCredentials(event) {
  event.preventDefault();
  const button = $('#save-lark-credentials');
  setButtonBusy(button, true, '正在验证', '保存并连接');
  try {
    const current = state.larkConfig?.config;
    const result = await getJson('/v1/config/lark', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        appId: $('#lark-app-id').value.trim(),
        appSecret: $('#lark-app-secret').value,
        verificationToken: $('#lark-verification-token').value,
        encryptKey: $('#lark-encrypt-key').value,
        domain: $('#lark-domain').value,
        expectedRevision: current?.revision || 0,
      }),
    });
    state.larkConfig = { config: result.config, active: state.larkConfig?.active };
    $('#lark-app-secret').value = '';
    $('#lark-verification-token').value = '';
    $('#lark-encrypt-key').value = '';
    renderLarkSetup();
    showToast(result.message || '凭据已保存，正在连接飞书');
    await new Promise((resolve) => setTimeout(resolve, 4_000));
    await refreshAll({ quiet: true });
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    setButtonBusy(button, false, '正在验证', '保存并连接');
  }
}

async function removeLarkCredentials(button = $('#remove-lark-credentials')) {
  const current = state.larkConfig?.config;
  if (!current?.configured || !window.confirm('停用飞书 Bot？群消息将不再进入 MaxTag。')) return;
  setButtonBusy(button, true, '正在停用', '停用 Bot');
  try {
    const result = await getJson('/v1/config/lark', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedRevision: current.revision }),
    });
    state.larkConfig = { config: result.config, active: state.larkConfig?.active };
    renderLarkSetup();
    showToast(result.message || '飞书 Bot 已停用');
    await new Promise((resolve) => setTimeout(resolve, 4_000));
    await refreshAll({ quiet: true });
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    setButtonBusy(button, false, '正在停用', '停用 Bot');
  }
}

async function testLarkConnection(button = $('#test-lark-connection')) {
  setButtonBusy(button, true, '检测中', '验证连接');
  try {
    state.larkReadiness = await getJson('/v1/lark/readiness');
    renderLarkSetup();
    showToast(state.larkReadiness.ready ? '飞书连接正常' : '飞书接入尚未完成');
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    setButtonBusy(button, false, '检测中', '验证连接');
  }
}

function mcpConnectorRuntime(connector) {
  if (!connector.enabled) return 'Disabled across workers';
  if (!connector.credentialsAvailable) return 'Credentials required';
  if (!connector.lastCheck) return 'Not checked';
  return connector.lastCheck.status === 'ready'
    ? `${connector.lastCheck.toolCount} tools / ${connector.lastCheck.latencyMs}ms`
    : statusLabel(connector.lastCheck.status);
}

function assignMcpConnector(connector) {
  const projectId = connector.assignedProjects?.[0];
  if (projectId) selectProject(projectId);
  showView('projects');
  const checkbox = document.querySelector(
    `#tool-grid input[type="checkbox"][value="${CSS.escape(connector.grantKind)}"]`,
  );
  checkbox?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  checkbox?.focus();
}

async function manageMcpConnector(connector, action, button) {
  const idle = action === 'check' ? 'Check' : connector.enabled ? 'Disable' : 'Enable';
  setButtonBusy(button, true, action === 'check' ? 'Checking' : 'Saving', idle);
  try {
    const data = await getJson(
      `/v1/mcp-connectors/${encodeURIComponent(connector.id)}/${action}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          workspaceId: currentWorkspaceId(),
          expectedRevision: connector.revision,
        }),
      },
    );
    state.mcpConnectors = data.connectors;
    await refreshAll({ quiet: true });
    showToast(action === 'check' ? 'Connector checked' : `Connector ${action}d`);
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    setButtonBusy(button, false, action === 'check' ? 'Checking' : 'Saving', idle);
  }
}

function renderMcpConnectors() {
  const root = $('#mcp-connector-list');
  root.replaceChildren();
  const connectors = state.mcpConnectors?.connectors || [];
  if (!connectors.length) {
    root.append(
      element('div', 'empty-state compact-empty', 'No deployment-approved MCP connectors'),
    );
    return;
  }
  const installation = Boolean(
    state.auth?.principal?.workspaceIds?.includes('*'),
  );
  const viewer = state.auth?.principal?.role === 'viewer';
  for (const connector of connectors) {
    const row = element('div', 'mcp-connector-row');
    const identity = element('div', 'mcp-connector-identity');
    identity.append(
      element('strong', '', connector.label),
      element('small', '', connector.description || connector.id),
    );
    const tools = connector.tools || [];
    const toolSummary = clientCell(
      'Tools',
      `${tools.filter((tool) => tool.risk === 'read').length} read / ${
        tools.filter((tool) => tool.risk === 'write').length
      } write`,
    );
    const assignment = clientCell(
      'Projects',
      connector.assignedProjectCount
        ? `${connector.assignedProjectCount} assigned`
        : 'Not assigned',
    );
    const runtime = clientCell('Runtime', mcpConnectorRuntime(connector));
    const actions = element('div', 'mcp-connector-actions');
    const assign = element('button', 'text-button', 'Assign');
    assign.type = 'button';
    assign.addEventListener('click', () => assignMcpConnector(connector));
    const check = element('button', 'text-button mcp-installation-control', 'Check');
    check.type = 'button';
    check.disabled = viewer || !installation;
    check.title = installation ? 'Check connector health' : 'Installation operator required';
    check.addEventListener('click', () => void manageMcpConnector(connector, 'check', check));
    const toggle = element(
      'button',
      connector.enabled ? 'danger-text-button mcp-installation-control' : 'text-button mcp-installation-control',
      connector.enabled ? 'Disable' : 'Enable',
    );
    toggle.type = 'button';
    toggle.disabled = viewer || !installation;
    toggle.title = installation ? `${toggle.textContent} connector` : 'Installation operator required';
    toggle.addEventListener('click', () =>
      void manageMcpConnector(connector, connector.enabled ? 'disable' : 'enable', toggle),
    );
    actions.append(assign, check, toggle);
    row.append(
      identity,
      toolSummary,
      assignment,
      runtime,
      statePill(connector.enabled ? 'enabled' : 'disabled'),
      actions,
    );
    root.append(row);
  }
}

function toolIdentityProviderForTool(toolId) {
  if (toolId === 'github') return 'github';
  if (toolId === 'lark-docs' || toolId === 'lark-base') return 'lark';
  return null;
}

function selectableToolIdentities(provider) {
  return (state.toolIdentities?.identities || []).filter(
    (identity) =>
      identity.provider === provider &&
      identity.enabled &&
      identity.credentialsAvailable,
  );
}

function updateToolIdentityFields() {
  const lark = $('#tool-identity-provider').value === 'lark';
  for (const field of $$('.tool-identity-lark-ref')) field.hidden = !lark;
  for (const field of $$('.tool-identity-github-ref')) field.hidden = lark;
}

async function saveToolIdentity(event) {
  event.preventDefault();
  const button = $('#save-tool-identity');
  const provider = $('#tool-identity-provider').value;
  setButtonBusy(button, true, 'Saving', 'Save identity');
  try {
    const data = await getJson('/v1/tool-identities', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: $('#tool-identity-id').value.trim(),
        displayName: $('#tool-identity-name').value.trim(),
        provider,
        envRefs: provider === 'lark'
          ? {
              appId: $('#tool-identity-app-id-ref').value.trim(),
              appSecret: $('#tool-identity-app-secret-ref').value.trim(),
            }
          : { token: $('#tool-identity-token-ref').value.trim() },
        externalActor: $('#tool-identity-external-actor').value.trim(),
        baseUrl: $('#tool-identity-base-url').value.trim(),
      }),
    });
    state.toolIdentities = data.catalog;
    $('#tool-identity-form').reset();
    updateToolIdentityFields();
    await refreshAll({ quiet: true });
    showToast('Agent identity saved');
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    setButtonBusy(button, false, 'Saving', 'Save identity');
  }
}

async function toggleToolIdentity(identity, button) {
  const action = identity.enabled ? 'disable' : 'enable';
  setButtonBusy(button, true, 'Saving', identity.enabled ? 'Disable' : 'Enable');
  try {
    const data = await getJson(
      `/v1/tool-identities/${encodeURIComponent(identity.id)}/${action}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ expectedRevision: identity.revision }),
      },
    );
    state.toolIdentities = data.catalog;
    await refreshAll({ quiet: true });
    showToast(`Identity ${action}d`);
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    setButtonBusy(button, false, 'Saving', identity.enabled ? 'Disable' : 'Enable');
  }
}

function renderToolIdentities() {
  const root = $('#tool-identity-list');
  root.replaceChildren();
  const identities = state.toolIdentities?.identities || [];
  if (!identities.length) {
    root.append(element('div', 'empty-state compact-empty', 'No agent identities'));
    return;
  }
  const owner = canManageOperatorCredentials();
  $('#tool-identity-form').hidden = !owner;
  for (const identity of identities) {
    const row = element('div', 'mcp-connector-row');
    const copy = element('div', 'mcp-connector-identity');
    copy.append(
      element('strong', '', identity.displayName),
      element('small', '', `${identity.id} / r${identity.revision}`),
    );
    const actions = element('div', 'mcp-connector-actions');
    if (!identity.builtin) {
      const toggle = element(
        'button',
        identity.enabled ? 'danger-text-button' : 'text-button',
        identity.enabled ? 'Disable' : 'Enable',
      );
      toggle.type = 'button';
      toggle.disabled = !owner;
      toggle.addEventListener('click', () => void toggleToolIdentity(identity, toggle));
      actions.append(toggle);
    }
    row.append(
      copy,
      clientCell('Provider', statusLabel(identity.provider)),
      clientCell('External actor', identity.externalActor || 'App identity'),
      clientCell(
        'Runtime',
        identity.credentialsAvailable ? 'Credentials ready' : 'Env unavailable',
      ),
      statePill(identity.enabled ? 'enabled' : 'disabled'),
      actions,
    );
    root.append(row);
  }
}

function renderOverviewRuns() {
  const root = $('#overview-runs');
  root.replaceChildren();
  if (!state.runs.length) {
    root.append(element('div', 'empty-state', 'No runs yet'));
    return;
  }
  for (const run of state.runs.slice(0, 5)) {
    const row = element('div', 'compact-run');
    const copy = element('div');
    copy.append(
      element('strong', '', run.title || run.summary?.split('\n')[0] || shortId(run.id)),
      element('small', '', `${run.projectId || 'general'} / ${formatTime(run.updatedAt, true)}`),
    );
    row.append(copy, statePill(run.status));
    root.append(row);
  }
}

function renderToolGrid(policy, options = {}) {
  const root = $(options.selector || '#tool-grid');
  const disabled = Boolean(options.disabled);
  const markDirty = options.markDirty || markProjectDirty;
  const grants = new Map(
    (policy?.grants || []).map((grant) => [grant.kind, grant]),
  );
  root.replaceChildren();
  for (const tool of state.workspace?.availableTools || []) {
    const grant = grants.get(tool.id);
    const card = element('div', 'tool-option');
    const head = element('label', 'tool-option-head');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.value = tool.id;
    checkbox.checked = Boolean(grant);
    checkbox.disabled = disabled;
    const copy = element('span', 'tool-option-copy');
    const toolCountLabel = (writeEnabled) => {
      const authorized = writeEnabled
        ? tool.toolCount || 0
        : tool.readToolCount ?? tool.toolCount ?? 0;
      const available =
        tool.providerStatus === 'ready' || tool.providerStatus === 'configured'
          ? authorized
          : tool.providerStatus === 'public-only'
            ? Math.min(authorized, tool.readToolCount ?? authorized)
            : 0;
      if (!tool.writeToolCount) {
        return `${available} available / ${statusLabel(tool.providerStatus)}`;
      }
      return `${available} available / ${authorized} authorized / ${statusLabel(tool.providerStatus)}`;
    };
    copy.append(
      element('strong', '', tool.label),
      element(
        'small',
        '',
        toolCountLabel(grant?.constraints?.permissions?.includes('write')),
      ),
    );
    head.append(checkbox, copy);
    card.append(head);

    const description = element('p', 'tool-option-description', tool.description || '');
    card.append(description);
    const identityProvider = toolIdentityProviderForTool(tool.id);
    if (identityProvider) {
      const field = element('label', 'tool-constraint');
      field.append(element('span', '', 'Agent identity'));
      const select = document.createElement('select');
      select.className = 'tool-identity-select';
      select.dataset.toolKind = tool.id;
      select.dataset.credentialIdentity = 'true';
      const automatic = element('option', '', 'Workspace default');
      automatic.value = '';
      select.append(automatic);
      for (const identity of selectableToolIdentities(identityProvider)) {
        const option = element(
          'option',
          '',
          `${identity.displayName} / ${identity.externalActor || identity.id}`,
        );
        option.value = identity.id;
        option.selected = grant?.credentialIdentityId === identity.id;
        select.append(option);
      }
      if (
        grant?.credentialIdentityId &&
        ![...select.options].some((option) => option.value === grant.credentialIdentityId)
      ) {
        const unavailable = element(
          'option',
          '',
          `${grant.credentialIdentityId} / unavailable`,
        );
        unavailable.value = grant.credentialIdentityId;
        unavailable.selected = true;
        select.append(unavailable);
      }
      select.disabled = disabled || !checkbox.checked;
      select.addEventListener('change', markDirty);
      field.append(select);
      card.append(field);
    }
    if (tool.constraints?.length) {
      const constraints = element('div', 'tool-constraints');
      for (const constraint of tool.constraints) {
        const field = element('label', 'tool-constraint');
        field.append(element('span', '', constraint.label));
        const input = document.createElement('input');
        input.type = 'text';
        input.placeholder = constraint.placeholder || '';
        input.dataset.defaultValues = (constraint.allowedValues || []).join(', ');
        input.spellcheck = false;
        input.dataset.toolKind = tool.id;
        input.dataset.constraintKey = constraint.key;
        const current = grant?.constraints?.[constraint.key];
        input.value = Array.isArray(current)
          ? current
              .map((value) =>
                typeof value === 'string'
                  ? value
                  : value?.owner && value?.repo
                    ? `${value.owner}/${value.repo}`
                    : '',
              )
              .filter(Boolean)
              .join(', ')
          : '';
        input.disabled = disabled || !checkbox.checked;
        input.addEventListener('input', markDirty);
        field.append(input);
        constraints.append(field);
      }
      card.append(constraints);
    }
    if (tool.writeToolCount) {
      const permission = element('label', 'tool-write-toggle');
      const write = document.createElement('input');
      write.type = 'checkbox';
      write.dataset.toolKind = tool.id;
      write.dataset.permission = 'write';
      write.checked = Boolean(grant?.constraints?.permissions?.includes('write'));
      write.disabled = disabled || !checkbox.checked;
      permission.append(
        write,
        element('span', '', `Write access (+${tool.writeToolCount} tools)`),
      );
      write.addEventListener('change', () => {
        const count = copy.querySelector('small');
        count.textContent = toolCountLabel(write.checked);
        markDirty();
      });
      card.append(permission);
    }
    checkbox.addEventListener('change', () => {
      for (const input of card.querySelectorAll(
        '.tool-constraint input, .tool-write-toggle input',
      )) {
        input.disabled = disabled || !checkbox.checked;
      }
      for (const select of card.querySelectorAll('.tool-identity-select')) {
        select.disabled = disabled || !checkbox.checked;
      }
      if (checkbox.checked) {
        for (const input of card.querySelectorAll('.tool-constraint input')) {
          if (!input.value && input.dataset.defaultValues) {
            input.value = input.dataset.defaultValues;
          }
        }
      }
      markDirty();
    });
    root.append(card);
  }
}

function selectedTools(rootSelector) {
  return $$(`${rootSelector} .tool-option-head input[type="checkbox"]:checked`).map(
    (input) => input.value,
  );
}

function toolConstraints(rootSelector) {
  const constraints = {};
  for (const checkbox of $$(
    `${rootSelector} .tool-option-head input[type="checkbox"]:checked`,
  )) {
    const values = {};
    const identitySelect = checkbox.closest('.tool-option')?.querySelector(
      '.tool-identity-select',
    );
    if (identitySelect?.value) {
      values.credentialIdentityId = identitySelect.value;
    }
    for (const input of $$(
      `${rootSelector} input[data-tool-kind="${CSS.escape(checkbox.value)}"]`,
    )) {
      if (input.dataset.permission === 'write') {
        values.permissions = input.checked ? ['read', 'write'] : ['read'];
        continue;
      }
      values[input.dataset.constraintKey] = input.value
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);
    }
    constraints[checkbox.value] = values;
  }
  return constraints;
}

function fillExecutorOptions(selected) {
  fillExecutorSelect($('#agent-executor'), selected);
  renderRunnerCapabilities(
    $('#project-runner-capabilities'),
    $('#agent-executor').value,
  );
}

function fillExecutorSelect(select, selected) {
  select.replaceChildren();
  let found = false;
  for (const executor of state.workspace?.executors || []) {
    const option = document.createElement('option');
    option.value = executor.id;
    option.textContent = executor.mode
      ? `${executor.label} (${executor.mode})`
      : executor.label;
    option.selected = executor.id === selected;
    found ||= option.selected;
    select.append(option);
  }
  if (selected && !found) {
    const option = document.createElement('option');
    option.value = selected;
    option.textContent = `${selected} (unavailable)`;
    option.selected = true;
    select.prepend(option);
  }
}

function runnerById(id) {
  return (state.workspace?.executors || []).find((runner) => runner.id === id);
}

function renderRunnerCapabilities(container, runnerId) {
  const runner = runnerById(runnerId);
  container.replaceChildren();
  if (!runner) {
    container.append(element('span', 'runner-capability-list muted', 'Unavailable'));
    return;
  }
  const capabilities = runner.capabilities || {};
  const steering = capabilities.steering === 'live'
    ? 'Live steering'
    : 'Next-turn steering';
  const features = [
    capabilities.providerSessions ? 'sessions' : '',
    capabilities.brokeredTools ? 'tools' : '',
    capabilities.inputAttachments ? 'files' : '',
    capabilities.automaticMemoryCandidates ? 'memory' : '',
    capabilities.contextRecovery ? 'recovery' : '',
    capabilities.nativeCompaction ? 'compaction' : '',
  ].filter(Boolean);
  container.append(
    element(
      'span',
      'runner-steering',
      `${runner.status === 'dry-run' ? 'Dry run' : 'Ready'} · ${steering}`,
    ),
    element('span', 'runner-capability-list', features.join(' · ')),
  );
}

function skillCatalog() {
  return state.skills?.skills || [];
}

function selectedSkillIds(selector) {
  return $$(`${selector} input[data-skill-id]:checked`).map(
    (input) => input.dataset.skillId,
  );
}

function renderSkillPicker(selector, selectedIds = [], options = {}) {
  const root = $(selector);
  root.replaceChildren();
  const selected = new Set(selectedIds || []);
  for (const skill of skillCatalog()) {
    const row = element('label', 'skill-choice');
    const input = element('input');
    input.type = 'checkbox';
    input.dataset.skillId = skill.id;
    input.checked = selected.has(skill.id);
    input.disabled = Boolean(options.disabled) || (!skill.enabled && !input.checked);
    const copy = element('span', 'skill-choice-copy');
    copy.append(
      element('strong', '', skill.name),
      element('small', '', skill.description),
    );
    row.append(input, copy);
    if (!skill.enabled) row.append(statePill('disabled'));
    input.addEventListener('change', options.markDirty || (() => {}));
    root.append(row);
  }
  if (!skillCatalog().length) {
    root.append(element('div', 'empty-state compact-empty', 'No Skills in the catalog'));
  }
}

function skillSummary(id) {
  return skillCatalog().find((skill) => skill.id === id);
}

function fillSkillForm(skill = state.skillDetail) {
  const summary = skillSummary(state.selectedSkillId);
  const value = skill || summary;
  const isNew = state.selectedSkillId === '__new__';
  const canManage = Boolean(state.skills?.canManageCatalog);
  $('#skill-editor-title').textContent = value?.name || 'New skill';
  $('#skill-state').textContent = isNew
    ? 'Draft'
    : value?.enabled
      ? 'Enabled'
      : 'Disabled';
  $('#skill-state').className = `state-pill ${
    isNew ? 'planned' : value?.enabled ? 'ready' : 'disabled'
  }`;
  $('#skill-id').value = value?.id || '';
  $('#skill-id').disabled = !canManage || !isNew;
  $('#skill-name').value = value?.name || '';
  $('#skill-description').value = value?.description || '';
  $('#skill-content').value = skill?.content || '';
  $('#skill-content').placeholder = canManage
    ? 'Write the reusable procedure in Markdown.'
    : 'Skill content is available to installation operators.';
  for (const control of [
    $('#skill-name'),
    $('#skill-description'),
    $('#skill-content'),
    $('#save-skill'),
  ]) {
    control.disabled = !canManage;
  }
  const toggle = $('#toggle-skill');
  toggle.hidden = isNew || !value;
  toggle.textContent = value?.enabled ? 'Disable' : 'Enable';
  toggle.disabled = !canManage;
  state.skillDirty = false;
  $('#skill-save-state').textContent = canManage
    ? 'No unsaved changes'
    : 'Installation managed';
}

function renderSkillList() {
  const root = $('#skill-list');
  root.replaceChildren();
  const skills = skillCatalog();
  $('#skill-enabled-summary').textContent = `${
    skills.filter((skill) => skill.enabled).length
  } enabled`;
  for (const skill of skills) {
    const button = element('button', 'skill-list-item');
    button.type = 'button';
    button.classList.toggle('active', state.selectedSkillId === skill.id);
    const copy = element('span', 'skill-list-copy');
    copy.append(
      element('strong', '', skill.name),
      element(
        'small',
        '',
        `${skill.assignedProjectCount || 0} projects / ${
          skill.assignedChannelCount || 0
        } channels`,
      ),
    );
    button.append(copy, statePill(skill.enabled ? 'ready' : 'disabled'));
    button.addEventListener('click', () => void selectSkill(skill.id));
    root.append(button);
  }
  if (!skills.length) root.append(element('div', 'empty-state', 'No Skills yet'));
}

function renderSkills() {
  const skills = skillCatalog();
  if (
    state.selectedSkillId !== '__new__' &&
    !skills.some((skill) => skill.id === state.selectedSkillId)
  ) {
    state.selectedSkillId = skills[0]?.id || '__new__';
    state.skillDetail = null;
  }
  renderSkillList();
  if (
    state.skills?.canManageCatalog &&
    state.selectedSkillId !== '__new__' &&
    state.skillDetail?.id !== state.selectedSkillId
  ) {
    fillSkillForm(null);
    void selectSkill(state.selectedSkillId);
  } else {
    fillSkillForm(
      state.skillDetail?.id === state.selectedSkillId ? state.skillDetail : null,
    );
  }
}

async function selectSkill(id) {
  state.selectedSkillId = id;
  state.skillDetail = null;
  renderSkillList();
  fillSkillForm(null);
  if (id === '__new__' || !state.skills?.canManageCatalog) return;
  try {
    const data = await getJson(`/v1/skills/${encodeURIComponent(id)}`);
    if (state.selectedSkillId !== id) return;
    state.skillDetail = data.skill;
    fillSkillForm(data.skill);
  } catch (error) {
    showToast(error.message, 'error');
  }
}

function newSkill() {
  state.selectedSkillId = '__new__';
  state.skillDetail = null;
  renderSkillList();
  fillSkillForm(null);
  $('#skill-name').focus();
}

function markSkillDirty() {
  state.skillDirty = true;
  $('#skill-save-state').textContent = 'Unsaved changes';
}

async function saveSkill(event) {
  event.preventDefault();
  if (!state.skills?.canManageCatalog) return;
  const button = $('#save-skill');
  const id = $('#skill-id').value.trim();
  if (!id) {
    showToast('Skill ID is required', 'error');
    return;
  }
  setButtonBusy(button, true, 'Saving', 'Save skill');
  try {
    await getJson('/v1/skills', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workspaceId: currentWorkspaceId(),
        id,
        name: $('#skill-name').value.trim(),
        description: $('#skill-description').value.trim(),
        content: $('#skill-content').value,
        expectedRevision: state.skillDetail?.revision || 0,
      }),
    });
    state.selectedSkillId = id.toLowerCase();
    state.skillDetail = null;
    await refreshAll({ quiet: true });
    await selectSkill(state.selectedSkillId);
    showToast('Skill saved');
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    setButtonBusy(button, false, 'Saving', 'Save skill');
  }
}

async function toggleSkill() {
  const skill = state.skillDetail;
  if (!skill || !state.skills?.canManageCatalog) return;
  const button = $('#toggle-skill');
  const action = skill.enabled ? 'disable' : 'enable';
  const idle = skill.enabled ? 'Disable' : 'Enable';
  let enabled = skill.enabled;
  setButtonBusy(button, true, skill.enabled ? 'Disabling' : 'Enabling', idle);
  try {
    await getJson(`/v1/skills/${encodeURIComponent(skill.id)}/${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workspaceId: currentWorkspaceId(),
        expectedRevision: skill.revision,
      }),
    });
    enabled = action === 'enable';
    state.skillDetail = null;
    await refreshAll({ quiet: true });
    await selectSkill(skill.id);
    showToast(action === 'disable' ? 'Skill disabled across workers' : 'Skill enabled');
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    setButtonBusy(
      button,
      false,
      enabled ? 'Disabling' : 'Enabling',
      enabled ? 'Disable' : 'Enable',
    );
  }
}

function knowledgeSourceCatalog() {
  return state.knowledgeSources?.sources || [];
}

function selectedKnowledgeSourceIds(selector) {
  return $$(`${selector} input[data-source-id]:checked`).map(
    (input) => input.dataset.sourceId,
  );
}

function renderKnowledgeSourcePicker(selector, selectedIds = [], options = {}) {
  const root = $(selector);
  root.replaceChildren();
  const selected = new Set(selectedIds || []);
  for (const source of knowledgeSourceCatalog()) {
    const row = element('label', 'skill-choice');
    const input = element('input');
    input.type = 'checkbox';
    input.dataset.sourceId = source.id;
    input.checked = selected.has(source.id);
    input.disabled = Boolean(options.disabled) || (!source.enabled && !input.checked);
    const copy = element('span', 'skill-choice-copy');
    copy.append(
      element('strong', '', source.name),
      element('small', '', `${statusLabel(source.kind)} / r${source.revision} / ${formatBytes(source.sizeBytes)}`),
    );
    row.append(input, copy);
    if (!source.enabled) row.append(statePill('disabled'));
    input.addEventListener('change', options.markDirty || (() => {}));
    root.append(row);
  }
  if (!knowledgeSourceCatalog().length) {
    root.append(element('div', 'empty-state compact-empty', 'No Sources in this workspace'));
  }
}

function knowledgeSourceSummary(id) {
  return knowledgeSourceCatalog().find((source) => source.id === id);
}

function updateKnowledgeSourceKind() {
  const kind = $('#source-kind').value;
  $('#source-uri-field').hidden = kind === 'text';
  $('#source-uri').required = kind === 'url';
  $('#source-refresh-field').hidden = kind !== 'url';
  if (kind !== 'url') $('#source-refresh-interval').value = '0';
  $('#source-file-field').hidden = kind !== 'file';
}

function fillKnowledgeSourceForm(source = state.knowledgeSourceDetail) {
  const summary = knowledgeSourceSummary(state.selectedKnowledgeSourceId);
  const value = source ? { ...summary, ...source } : summary;
  const isNew = state.selectedKnowledgeSourceId === '__new__';
  const canManage = Boolean(state.knowledgeSources?.canManageCatalog);
  $('#source-editor-title').textContent = value?.name || 'New source';
  $('#source-state').textContent = isNew ? 'Draft' : value?.enabled ? 'Enabled' : 'Disabled';
  $('#source-state').className = `state-pill ${
    isNew ? 'planned' : value?.enabled ? 'ready' : 'disabled'
  }`;
  $('#source-id').value = value?.id || '';
  $('#source-id').disabled = !canManage || !isNew;
  $('#source-name').value = value?.name || '';
  $('#source-description').value = value?.description || '';
  $('#source-kind').value = value?.kind || 'text';
  $('#source-media-type').value = value?.mediaType || 'text/markdown';
  $('#source-uri').value = value?.sourceUri || '';
  $('#source-refresh-interval').value = String(value?.refreshIntervalMs || 0);
  $('#source-content').value = source?.content || '';
  state.knowledgeSourceFile = null;
  $('#source-content').required = true;
  $('#source-content').placeholder = canManage
    ? 'Paste the source snapshot.'
    : 'Source content is available to workspace owners.';
  $('#source-version').textContent = value
    ? [
        `Revision ${value.revision}`,
        formatBytes(value.sizeBytes),
        `SHA-256 ${value.contentHash?.slice(0, 16) || 'pending'}`,
        value.enrichmentStatus
          ? `${statusLabel(value.enrichmentStatus)} semantic index / ${value.semanticPassageCount || 0} passages`
          : 'Semantic index not started',
        value.extraction
          ? `${statusLabel(value.extraction.extractor)} from ${formatBytes(value.extraction.inputBytes)}`
          : null,
        value.refresh
          ? `${statusLabel(value.refresh.status)} refresh${value.refresh.outcome ? ` / ${statusLabel(value.refresh.outcome)}` : ''}`
          : null,
        value.refreshIntervalMs
          ? `Auto every ${formatDuration(value.refreshIntervalMs)}${value.nextRefreshAt ? ` / next ${formatTime(value.nextRefreshAt, true)}` : ''}`
          : null,
      ].filter(Boolean).join(' / ')
    : 'Unsaved snapshot';
  for (const control of [
    $('#source-name'), $('#source-description'), $('#source-kind'),
    $('#source-media-type'), $('#source-uri'), $('#source-refresh-interval'), $('#source-file'),
    $('#source-content'), $('#save-source'),
  ]) control.disabled = !canManage;
  const toggle = $('#toggle-source');
  toggle.hidden = isNew || !value;
  toggle.textContent = value?.enabled ? 'Disable' : 'Enable';
  toggle.disabled = !canManage;
  const refresh = $('#refresh-source');
  refresh.hidden = isNew || value?.kind !== 'url';
  refresh.disabled = !canManage || !value?.enabled || ['pending', 'claimed'].includes(value?.refresh?.status);
  updateKnowledgeSourceKind();
  state.knowledgeSourceDirty = false;
  $('#source-save-state').textContent = canManage
    ? 'No unsaved changes'
    : 'Workspace owner managed';
}

function renderKnowledgeSourceList() {
  const root = $('#source-list');
  root.replaceChildren();
  const sources = knowledgeSourceCatalog();
  $('#source-enabled-summary').textContent = `${
    sources.filter((source) => source.enabled).length
  } enabled`;
  for (const source of sources) {
    const button = element('button', 'skill-list-item');
    button.type = 'button';
    button.classList.toggle('active', state.selectedKnowledgeSourceId === source.id);
    const copy = element('span', 'skill-list-copy');
    copy.append(
      element('strong', '', source.name),
      element('small', '', `${source.assignedProjectCount || 0} projects / ${source.assignedChannelCount || 0} channels / ${source.semanticPassageCount || 0} passages / r${source.revision}`),
    );
    const sourceState = source.enabled
      ? source.enrichmentStatus || 'ready'
      : 'disabled';
    button.append(
      copy,
      statePill(
        sourceState,
        source.enabled ? statusLabel(sourceState) : 'Disabled',
      ),
    );
    button.addEventListener('click', () => void selectKnowledgeSource(source.id));
    root.append(button);
  }
  if (!sources.length) root.append(element('div', 'empty-state', 'No Sources yet'));
}

function renderKnowledgeSources() {
  const sources = knowledgeSourceCatalog();
  if (
    state.selectedKnowledgeSourceId !== '__new__' &&
    !sources.some((source) => source.id === state.selectedKnowledgeSourceId)
  ) {
    state.selectedKnowledgeSourceId = sources[0]?.id || '__new__';
    state.knowledgeSourceDetail = null;
  }
  renderKnowledgeSourceList();
  if (state.knowledgeSourceDirty) return;
  if (
    state.knowledgeSources?.canManageCatalog &&
    state.selectedKnowledgeSourceId !== '__new__' &&
    state.knowledgeSourceDetail?.id !== state.selectedKnowledgeSourceId
  ) {
    fillKnowledgeSourceForm(null);
    void selectKnowledgeSource(state.selectedKnowledgeSourceId);
  } else {
    fillKnowledgeSourceForm(
      state.knowledgeSourceDetail?.id === state.selectedKnowledgeSourceId
        ? state.knowledgeSourceDetail
        : null,
    );
  }
}

async function selectKnowledgeSource(id) {
  state.selectedKnowledgeSourceId = id;
  state.knowledgeSourceDetail = null;
  renderKnowledgeSourceList();
  fillKnowledgeSourceForm(null);
  if (id === '__new__' || !state.knowledgeSources?.canManageCatalog) return;
  try {
    const query = new URLSearchParams({ workspaceId: currentWorkspaceId() });
    const data = await getJson(`/v1/knowledge-sources/${encodeURIComponent(id)}?${query}`);
    if (state.selectedKnowledgeSourceId !== id) return;
    state.knowledgeSourceDetail = data.source;
    fillKnowledgeSourceForm(data.source);
  } catch (error) {
    showToast(error.message, 'error');
  }
}

function newKnowledgeSource() {
  state.selectedKnowledgeSourceId = '__new__';
  state.knowledgeSourceDetail = null;
  renderKnowledgeSourceList();
  fillKnowledgeSourceForm(null);
  $('#source-name').focus();
}

function markKnowledgeSourceDirty() {
  state.knowledgeSourceDirty = true;
  $('#source-save-state').textContent = 'Unsaved changes';
}

async function importKnowledgeSourceFile(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  if (file.size > 10 * 1024 * 1024) {
    showToast('Source file exceeds 10 MB', 'error');
    event.target.value = '';
    return;
  }
  state.knowledgeSourceFile = file;
  $('#source-content').value = '';
  $('#source-content').required = false;
  $('#source-content').placeholder = `${file.name} will be extracted securely on the server.`;
  $('#source-uri').value = file.name;
  $('#source-media-type').value = file.type || 'text/plain';
  if (!$('#source-name').value.trim()) $('#source-name').value = file.name;
  if (!$('#source-id').value.trim()) {
    $('#source-id').value = file.name.toLowerCase()
      .replace(/\.[^.]+$/u, '')
      .replace(/[^a-z0-9]+/gu, '-')
      .replace(/^-|-$/gu, '')
      .slice(0, 64);
  }
  markKnowledgeSourceDirty();
}

async function saveKnowledgeSource(event) {
  event.preventDefault();
  if (!state.knowledgeSources?.canManageCatalog) return;
  const button = $('#save-source');
  const id = $('#source-id').value.trim();
  if (!id) {
    showToast('Source ID is required', 'error');
    return;
  }
  setButtonBusy(button, true, 'Saving', 'Save source');
  try {
    const payload = {
      workspaceId: currentWorkspaceId(), id,
      name: $('#source-name').value.trim(),
      description: $('#source-description').value.trim(),
      kind: $('#source-kind').value,
      sourceUri: $('#source-uri').value.trim() || undefined,
      refreshIntervalMs: Number($('#source-refresh-interval').value),
      mediaType: $('#source-media-type').value.trim(),
      expectedRevision: state.knowledgeSourceDetail?.revision || 0,
    };
    if (state.knowledgeSourceFile) {
      payload.fileName = state.knowledgeSourceFile.name;
      payload.contentBase64 = await fileAsBase64(state.knowledgeSourceFile);
    } else {
      payload.content = $('#source-content').value;
    }
    await getJson('/v1/knowledge-sources', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    state.selectedKnowledgeSourceId = id.toLowerCase();
    state.knowledgeSourceDetail = null;
    await refreshAll({ quiet: true });
    await selectKnowledgeSource(state.selectedKnowledgeSourceId);
    showToast('Source snapshot saved');
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    setButtonBusy(button, false, 'Saving', 'Save source');
  }
}

async function refreshKnowledgeSource() {
  const source = state.knowledgeSourceDetail;
  if (!source || source.kind !== 'url' || !state.knowledgeSources?.canManageCatalog) return;
  const button = $('#refresh-source');
  setButtonBusy(button, true, 'Refreshing', 'Refresh');
  try {
    const data = await getJson(`/v1/knowledge-sources/${encodeURIComponent(source.id)}/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId: currentWorkspaceId() }),
    });
    state.knowledgeSourceDetail = null;
    await refreshAll({ quiet: true });
    await selectKnowledgeSource(source.id);
    showToast(data.duplicate ? 'Refresh is already queued' : 'Refresh queued');
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    setButtonBusy(button, false, 'Refreshing', 'Refresh');
  }
}

async function toggleKnowledgeSource() {
  const source = state.knowledgeSourceDetail;
  if (!source || !state.knowledgeSources?.canManageCatalog) return;
  const button = $('#toggle-source');
  const action = source.enabled ? 'disable' : 'enable';
  const idle = source.enabled ? 'Disable' : 'Enable';
  let enabled = source.enabled;
  setButtonBusy(button, true, source.enabled ? 'Disabling' : 'Enabling', idle);
  try {
    await getJson(`/v1/knowledge-sources/${encodeURIComponent(source.id)}/${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workspaceId: currentWorkspaceId(), expectedRevision: source.revision,
      }),
    });
    enabled = action === 'enable';
    state.knowledgeSourceDetail = null;
    await refreshAll({ quiet: true });
    await selectKnowledgeSource(source.id);
    showToast(action === 'disable' ? 'Source disabled across routes' : 'Source enabled');
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    setButtonBusy(
      button,
      false,
      enabled ? 'Disabling' : 'Enabling',
      enabled ? 'Disable' : 'Enable',
    );
  }
}

function delegatedAgentCatalog() {
  return state.delegatedAgents?.agents || [];
}

function selectedDelegatedAgentIds(selector) {
  return $$(`${selector} input[data-agent-id]:checked`).map(
    (input) => input.dataset.agentId,
  );
}

function renderDelegatedAgentPicker(selector, selectedIds = [], options = {}) {
  const root = $(selector);
  root.replaceChildren();
  const selected = new Set(selectedIds || []);
  for (const agent of delegatedAgentCatalog()) {
    const row = element('label', 'skill-choice');
    const input = element('input');
    input.type = 'checkbox';
    input.dataset.agentId = agent.id;
    input.checked = selected.has(agent.id);
    input.disabled = Boolean(options.disabled) || (!agent.enabled && !input.checked);
    const copy = element('span', 'skill-choice-copy');
    copy.append(
      element('strong', '', agent.name),
      element('small', '', `${agent.executorId} / ${agent.description}`),
    );
    row.append(input, copy);
    if (!agent.enabled) row.append(statePill('disabled'));
    input.addEventListener('change', options.markDirty || (() => {}));
    root.append(row);
  }
  if (!delegatedAgentCatalog().length) {
    root.append(element('div', 'empty-state compact-empty', 'No Agents in the catalog'));
  }
}

function delegatedAgentSummary(id) {
  return delegatedAgentCatalog().find((agent) => agent.id === id);
}

function renderDelegatedAgentGrantPicker(selectedKinds = []) {
  const root = $('#delegated-agent-grant-picker');
  root.replaceChildren();
  const selected = new Set(selectedKinds || []);
  for (const grant of state.delegatedAgents?.grantCatalog || []) {
    const row = element('label', 'skill-choice');
    const input = element('input');
    input.type = 'checkbox';
    input.dataset.grantKind = grant.kind;
    input.checked = selected.has(grant.kind);
    const copy = element('span', 'skill-choice-copy');
    copy.append(
      element('strong', '', grant.label),
      element('small', '', grant.description),
    );
    row.append(input, copy);
    input.addEventListener('change', markDelegatedAgentDirty);
    root.append(row);
  }
  if (!root.children.length) {
    root.append(element('div', 'empty-state compact-empty', 'No read-only tools available'));
  }
}

function selectedDelegatedAgentGrantKinds() {
  return $$('#delegated-agent-grant-picker input[data-grant-kind]:checked').map(
    (input) => input.dataset.grantKind,
  );
}

function fillDelegatedAgentForm(agent = state.delegatedAgentDetail) {
  const summary = delegatedAgentSummary(state.selectedDelegatedAgentId);
  const value = agent || summary;
  const isNew = state.selectedDelegatedAgentId === '__new__';
  const canManage = Boolean(state.delegatedAgents?.canManageCatalog);
  $('#delegated-agent-editor-title').textContent = value?.name || 'New agent';
  $('#delegated-agent-state').textContent = isNew
    ? 'Draft'
    : value?.enabled
      ? 'Enabled'
      : 'Disabled';
  $('#delegated-agent-state').className = `state-pill ${
    isNew ? 'planned' : value?.enabled ? 'ready' : 'disabled'
  }`;
  $('#delegated-agent-id').value = value?.id || '';
  $('#delegated-agent-id').disabled = !canManage || !isNew;
  $('#delegated-agent-name').value = value?.name || '';
  $('#delegated-agent-description').value = value?.description || '';
  $('#delegated-agent-instructions').value = agent?.instructions || '';
  $('#delegated-agent-model').value = agent?.model || '';
  $('#delegated-agent-max-turns').value = agent?.maxTurns || value?.maxTurns || 10;
  $('#delegated-agent-timeout').value = Math.round(
    (agent?.timeoutMs || value?.timeoutMs || 300_000) / 1000,
  );
  const executor = $('#delegated-agent-executor');
  executor.replaceChildren();
  for (const item of state.delegatedAgents?.executors || []) {
    const option = element('option', '', item.label);
    option.value = item.id;
    option.selected = item.id === (agent?.executorId || value?.executorId || 'codex');
    executor.append(option);
  }
  renderSkillPicker('#delegated-agent-skill-picker', agent?.skillIds || [], {
    disabled: !canManage,
    markDirty: markDelegatedAgentDirty,
  });
  renderDelegatedAgentGrantPicker(agent?.grantKinds || []);
  for (const input of $$('#delegated-agent-grant-picker input')) {
    input.disabled = !canManage;
  }
  const memoryScopes = new Set(agent?.memoryScopes || []);
  for (const input of $$('#delegated-agent-memory-scopes input')) {
    input.checked = memoryScopes.has(input.value);
    input.disabled = !canManage;
  }
  $('#delegated-agent-network-hosts').value = (agent?.networkHosts || []).join(', ');
  for (const control of [
    $('#delegated-agent-name'),
    $('#delegated-agent-description'),
    $('#delegated-agent-instructions'),
    $('#delegated-agent-executor'),
    $('#delegated-agent-model'),
    $('#delegated-agent-max-turns'),
    $('#delegated-agent-timeout'),
    $('#delegated-agent-network-hosts'),
    $('#save-delegated-agent'),
  ]) {
    control.disabled = !canManage;
  }
  const toggle = $('#toggle-delegated-agent');
  toggle.hidden = isNew || !value;
  toggle.textContent = value?.enabled ? 'Disable' : 'Enable';
  toggle.disabled = !canManage;
  state.delegatedAgentDirty = false;
  $('#delegated-agent-save-state').textContent = canManage
    ? 'No unsaved changes'
    : 'Installation operator required';
}

function renderDelegatedAgentList() {
  const root = $('#agent-list');
  root.replaceChildren();
  const agents = delegatedAgentCatalog();
  $('#agent-enabled-summary').textContent = `${
    agents.filter((agent) => agent.enabled).length
  } enabled`;
  for (const agent of agents) {
    const button = element('button', 'skill-list-item');
    button.type = 'button';
    button.classList.toggle('active', state.selectedDelegatedAgentId === agent.id);
    const copy = element('span', 'skill-list-copy');
    copy.append(
      element('strong', '', agent.name),
      element(
        'small',
        '',
        `${agent.executorId} / ${agent.assignedProjectCount || 0} projects / ${
          agent.assignedChannelCount || 0
        } channels`,
      ),
    );
    button.append(copy, statePill(agent.enabled ? 'ready' : 'disabled'));
    button.addEventListener('click', () => void selectDelegatedAgent(agent.id));
    root.append(button);
  }
  if (!agents.length) root.append(element('div', 'empty-state', 'No Agents yet'));
}

function renderDelegatedAgentTasks() {
  const root = $('#agent-task-list');
  root.replaceChildren();
  const tasks = state.delegatedAgents?.tasks || [];
  const active = tasks.filter((task) => ['queued', 'claimed'].includes(task.status));
  $('#agent-task-summary').textContent = `${active.length} active / ${tasks.length} recent`;
  for (const task of tasks) {
    const row = element('div', 'agent-task-row');
    const copy = element('div', 'agent-task-copy');
    copy.append(
      element('strong', '', `${task.agentId} / ${task.taskPreview || shortId(task.id)}`),
      element(
        'small',
        '',
        [
          task.summary || task.error,
          `${task.attempts || 0} attempt${task.attempts === 1 ? '' : 's'}`,
          formatTime(task.updatedAt, true),
        ]
          .filter(Boolean)
          .join(' / ')
          .slice(0, 360),
      ),
    );
    const actions = element('div', 'agent-task-actions');
    actions.append(statePill(task.status));
    if (['queued', 'claimed'].includes(task.status)) {
      const stop = element('button', 'task-stop-button');
      stop.type = 'button';
      stop.title = 'Stop task';
      stop.setAttribute('aria-label', 'Stop task');
      stop.disabled = state.auth?.principal?.role === 'viewer';
      stop.addEventListener('click', () => void cancelDelegatedAgentTask(task.id, stop));
      actions.append(stop);
    }
    row.append(copy, actions);
    root.append(row);
  }
  if (!tasks.length) root.append(element('div', 'empty-state', 'No Agent tasks yet'));
}

async function cancelDelegatedAgentTask(taskId, button) {
  button.disabled = true;
  try {
    await getJson(`/v1/agent-tasks/${encodeURIComponent(taskId)}/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    await refreshAll({ quiet: true });
    showToast('Agent task stopped');
  } catch (error) {
    button.disabled = false;
    showToast(error.message, 'error');
  }
}

function renderDelegatedAgents() {
  const agents = delegatedAgentCatalog();
  if (
    state.selectedDelegatedAgentId !== '__new__' &&
    !agents.some((agent) => agent.id === state.selectedDelegatedAgentId)
  ) {
    state.selectedDelegatedAgentId = agents[0]?.id || '__new__';
    state.delegatedAgentDetail = null;
  }
  renderDelegatedAgentList();
  renderDelegatedAgentTasks();
  if (
    state.delegatedAgents?.canManageCatalog &&
    state.selectedDelegatedAgentId !== '__new__' &&
    state.delegatedAgentDetail?.id !== state.selectedDelegatedAgentId
  ) {
    fillDelegatedAgentForm(null);
    void selectDelegatedAgent(state.selectedDelegatedAgentId);
  } else {
    fillDelegatedAgentForm(
      state.delegatedAgentDetail?.id === state.selectedDelegatedAgentId
        ? state.delegatedAgentDetail
        : null,
    );
  }
}

async function selectDelegatedAgent(id) {
  state.selectedDelegatedAgentId = id;
  state.delegatedAgentDetail = null;
  renderDelegatedAgentList();
  fillDelegatedAgentForm(null);
  if (id === '__new__' || !state.delegatedAgents?.canManageCatalog) return;
  try {
    const data = await getJson(`/v1/agents/${encodeURIComponent(id)}`);
    if (state.selectedDelegatedAgentId !== id) return;
    state.delegatedAgentDetail = data.agent;
    fillDelegatedAgentForm(data.agent);
  } catch (error) {
    showToast(error.message, 'error');
  }
}

function newDelegatedAgent() {
  state.selectedDelegatedAgentId = '__new__';
  state.delegatedAgentDetail = null;
  renderDelegatedAgentList();
  fillDelegatedAgentForm(null);
  $('#delegated-agent-name').focus();
}

function markDelegatedAgentDirty() {
  state.delegatedAgentDirty = true;
  $('#delegated-agent-save-state').textContent = 'Unsaved changes';
}

async function saveDelegatedAgent(event) {
  event.preventDefault();
  if (!state.delegatedAgents?.canManageCatalog) return;
  const button = $('#save-delegated-agent');
  const id = $('#delegated-agent-id').value.trim();
  if (!id) {
    showToast('Agent ID is required', 'error');
    return;
  }
  setButtonBusy(button, true, 'Saving', 'Save agent');
  try {
    await getJson('/v1/agents', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workspaceId: currentWorkspaceId(),
        id,
        name: $('#delegated-agent-name').value.trim(),
        description: $('#delegated-agent-description').value.trim(),
        instructions: $('#delegated-agent-instructions').value,
        executorId: $('#delegated-agent-executor').value,
        model: $('#delegated-agent-model').value.trim() || undefined,
        skillIds: selectedSkillIds('#delegated-agent-skill-picker'),
        grantKinds: selectedDelegatedAgentGrantKinds(),
        memoryScopes: $$('#delegated-agent-memory-scopes input:checked').map(
          (input) => input.value,
        ),
        networkHosts: $('#delegated-agent-network-hosts')
          .value.split(',')
          .map((host) => host.trim())
          .filter(Boolean),
        maxTurns: Number($('#delegated-agent-max-turns').value),
        timeoutMs: Number($('#delegated-agent-timeout').value) * 1000,
        expectedRevision: state.delegatedAgentDetail?.revision || 0,
      }),
    });
    state.selectedDelegatedAgentId = id.toLowerCase();
    state.delegatedAgentDetail = null;
    await refreshAll({ quiet: true });
    await selectDelegatedAgent(state.selectedDelegatedAgentId);
    showToast('Agent saved');
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    setButtonBusy(button, false, 'Saving', 'Save agent');
  }
}

async function toggleDelegatedAgent() {
  const agent = state.delegatedAgentDetail;
  if (!agent || !state.delegatedAgents?.canManageCatalog) return;
  const button = $('#toggle-delegated-agent');
  const action = agent.enabled ? 'disable' : 'enable';
  const idle = agent.enabled ? 'Disable' : 'Enable';
  setButtonBusy(button, true, agent.enabled ? 'Disabling' : 'Enabling', idle);
  try {
    await getJson(`/v1/agents/${encodeURIComponent(agent.id)}/${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workspaceId: currentWorkspaceId(),
        expectedRevision: agent.revision,
      }),
    });
    state.delegatedAgentDetail = null;
    await refreshAll({ quiet: true });
    await selectDelegatedAgent(agent.id);
    showToast(action === 'disable' ? 'Agent disabled across workers' : 'Agent enabled');
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    setButtonBusy(button, false, 'Disabling', idle);
  }
}

function fillWorkspaceForm() {
  const policy = state.workspace?.workspace;
  const workspace = policy?.workspace || {};
  const identity = policy?.identity || {};
  $('#workspace-policy-name').value = workspace.name || '';
  $('#workspace-agent-name').value = identity.displayName || 'MaxTag';
  $('#workspace-agent-instructions').value = identity.instructions || '';
  fillExecutorSelect(
    $('#workspace-agent-executor'),
    identity.defaultExecutorId || 'codex',
  );
  renderRunnerCapabilities(
    $('#workspace-runner-capabilities'),
    $('#workspace-agent-executor').value,
  );
  const select = $('#workspace-default-project');
  select.replaceChildren();
  for (const project of state.workspace?.projects || []) {
    const option = element('option', '', project.name);
    option.value = project.projectId;
    option.selected = projectMatches(project, workspace.defaultProjectId);
    select.append(option);
  }
  fillWorkspaceCapabilities();
  state.workspaceDirty = false;
  $('#workspace-save-state').textContent = 'No unsaved changes';
}

function fillWorkspaceCapabilities() {
  const policy = state.workspace?.workspace || {};
  renderToolGrid(policy, {
    selector: '#workspace-tool-grid',
    markDirty: markWorkspaceDirty,
  });
  renderSkillPicker('#workspace-skill-picker', policy.skillIds || [], {
    markDirty: markWorkspaceDirty,
  });
  renderKnowledgeSourcePicker(
    '#workspace-source-picker',
    policy.knowledgeSourceIds || [],
    { markDirty: markWorkspaceDirty },
  );
  renderDelegatedAgentPicker('#workspace-agent-picker', policy.agentIds || [], {
    markDirty: markWorkspaceDirty,
  });
  $('#workspace-network-mode').value =
    policy.networkPolicy?.mode || 'deny-by-default';
  $('#workspace-allowed-hosts').value = (
    policy.networkPolicy?.allowedHosts || []
  ).join(', ');
  $('#workspace-tool-approval-mode').value =
    policy.toolApprovalPolicy?.mode === 'disabled'
      ? 'disabled'
      : 'require_approval';
  fillWorkspaceMemoryApproval();
  fillWorkspaceMemoryRetention();
  const count = policy.grants?.length || 0;
  const approvalMode = policy.memoryApprovalPolicy?.mode || 'disabled';
  const toolApprovalMode =
    policy.toolApprovalPolicy?.mode === 'disabled'
      ? 'direct writes'
      : 'write approval';
  $('#workspace-capability-summary').textContent =
    `${count} default tool ${count === 1 ? 'group' : 'groups'} / ${
      approvalMode === 'require_approval' ? 'memory approval' : 'direct memory'
    } / ${toolApprovalMode}`;
}

function openWorkspaceCapabilities() {
  fillWorkspaceCapabilities();
  $('#workspace-capability-dialog').showModal();
}

function markWorkspaceDirty() {
  state.workspaceDirty = true;
  $('#workspace-save-state').textContent = 'Unsaved changes';
}

async function saveWorkspace(event, button = $('#save-workspace')) {
  event.preventDefault();
  const idleLabel =
    button.id === 'save-workspace-capabilities' ? 'Save defaults' : 'Save workspace';
  setButtonBusy(button, true, 'Saving', idleLabel);
  try {
    const identity = state.workspace?.workspace?.identity || {};
    await getJson('/v1/workspace', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workspaceId: currentWorkspaceId(),
        name: $('#workspace-policy-name').value.trim(),
        defaultProjectId: $('#workspace-default-project').value,
        agentId: identity.id || 'opentag',
        agentName: $('#workspace-agent-name').value.trim() || 'MaxTag',
        instructions: $('#workspace-agent-instructions').value,
        executorId: $('#workspace-agent-executor').value,
        skillIds: selectedSkillIds('#workspace-skill-picker'),
        knowledgeSourceIds: selectedKnowledgeSourceIds('#workspace-source-picker'),
        agentIds: selectedDelegatedAgentIds('#workspace-agent-picker'),
        tools: selectedTools('#workspace-tool-grid'),
        toolConstraints: toolConstraints('#workspace-tool-grid'),
        toolApprovalPolicy: {
          mode: $('#workspace-tool-approval-mode').value,
          risks: ['write'],
        },
        networkMode: $('#workspace-network-mode').value,
        allowedHosts: $('#workspace-allowed-hosts')
          .value.split(',')
          .map((host) => host.trim())
          .filter(Boolean),
        memoryApprovalPolicy: workspaceMemoryApprovalPolicyInput(),
        memoryRetentionPolicy: workspaceMemoryRetentionPolicyInput(),
      }),
    });
    await refreshAll({ quiet: true });
    showToast('Workspace agent saved');
    return true;
  } catch (error) {
    showToast(error.message, 'error');
    return false;
  } finally {
    setButtonBusy(button, false, 'Saving', idleLabel);
  }
}

async function saveWorkspaceCapabilities(event) {
  const saved = await saveWorkspace(
    event,
    $('#save-workspace-capabilities'),
  );
  if (saved) $('#workspace-capability-dialog').close();
}

function projectBindings(project) {
  return state.bindings.filter(
    (binding) =>
      binding.workspaceId === project?.workspaceId &&
      projectMatches(project, binding.projectId),
  );
}

function channelPolicyForBinding(binding) {
  return (state.workspace?.channelPolicies || []).find(
    (policy) =>
      policy.workspaceId === binding.workspaceId &&
      projectMatches(policy, binding.projectId) &&
      policy.platform === binding.platform &&
      policy.channelId === (binding.channelId || binding.externalId),
  );
}

function renderProjectBindings(project) {
  const root = $('#project-bindings');
  root.replaceChildren();
  const items = project ? projectBindings(project) : [];
  $('#binding-count-label').textContent = `${items.length} bindings`;
  for (const binding of items) {
    const row = element('div', 'binding-row');
    const copy = element('div');
    copy.append(
      element('strong', '', statusLabel(binding.platform)),
      element('small', '', binding.externalId),
    );
    row.append(
      element('span', '', binding.source || 'configured'),
      copy,
      statePill(binding.activationMode || 'mention'),
    );
    if (binding.scope === 'channel') {
      const policy = channelPolicyForBinding(binding);
      const configure = element(
        'button',
        'text-button',
        policy ? 'Edit policy' : 'Add policy',
      );
      configure.type = 'button';
      configure.addEventListener('click', () => openChannelPolicy(binding));
      row.append(configure);
    } else {
      row.append(element('span', 'binding-topic-label', 'Topic'));
    }
    root.append(row);
  }
  if (!items.length) root.append(element('div', 'empty-state', 'No channel bindings'));
}

function selectedChannelProject() {
  return projectById(state.selectedChannelBinding?.projectId);
}

function channelCapabilityBase() {
  const project = selectedChannelProject();
  if (!project || project.capabilityMode === 'inherit') {
    return state.workspace?.workspace || {};
  }
  return project;
}

function updateChannelInstructionFields() {
  $('#channel-instructions').disabled =
    $('#channel-instruction-mode').value === 'inherit';
}

function updateChannelBudgetFields() {
  const custom = $('#channel-budget-mode').value === 'custom';
  $('#channel-budget-runs').disabled = !custom;
  $('#channel-budget-cost').disabled = !custom;
}

function renderChannelCapabilities(policy) {
  const mode = $('#channel-capability-mode').value;
  const inherited = mode === 'inherit';
  $('#channel-network-fields').hidden = inherited;
  renderToolGrid(inherited ? channelCapabilityBase() : policy || {}, {
    selector: '#channel-tool-grid',
    disabled: inherited,
    markDirty: () => {},
  });
  if (!inherited) {
    $('#channel-network-mode').value =
      policy?.networkPolicy?.mode || 'deny-by-default';
    $('#channel-allowed-hosts').value =
      (policy?.networkPolicy?.allowedHosts || []).join(', ');
  }
}

function openChannelPolicy(binding) {
  state.selectedChannelBinding = binding;
  const policy = channelPolicyForBinding(binding);
  const channelId = binding.channelId || binding.externalId;
  $('#channel-policy-route').textContent =
    `${statusLabel(binding.platform)} / ${channelId}`;
  $('#channel-policy-title').textContent = binding.title || channelId;
  $('#channel-instruction-mode').value = policy?.instructionMode || 'inherit';
  $('#channel-instructions').value = policy?.instructions || '';
  $('#channel-capability-mode').value = policy?.capabilityMode || 'inherit';
  $('#channel-tool-approval-mode').value =
    policy?.toolApprovalPolicy?.mode || 'inherit';
  renderSkillPicker('#channel-skill-picker', policy?.skillIds || []);
  renderKnowledgeSourcePicker(
    '#channel-source-picker',
    policy?.knowledgeSourceIds || [],
  );
  renderDelegatedAgentPicker('#channel-agent-picker', policy?.agentIds || []);
  $('#channel-budget-mode').value = policy?.budgetPolicy?.mode || 'inherit';
  $('#channel-budget-runs').value = policy?.budgetPolicy?.maxRunsPerMonth ?? '';
  $('#channel-budget-cost').value = policy?.budgetPolicy?.maxCostUsdPerMonth ?? '';
  $('#remove-channel-policy').hidden = !policy;
  updateChannelInstructionFields();
  updateChannelBudgetFields();
  renderChannelCapabilities(policy);
  $('#channel-policy-dialog').showModal();
}

async function saveChannelPolicy(event) {
  event.preventDefault();
  const binding = state.selectedChannelBinding;
  if (!binding) return;
  const button = $('#save-channel-policy');
  const capabilityMode = $('#channel-capability-mode').value;
  const budgetMode = $('#channel-budget-mode').value;
  setButtonBusy(button, true, 'Saving', 'Save channel');
  try {
    await getJson('/v1/channel-policies', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workspaceId: binding.workspaceId,
        projectId: binding.projectId,
        platform: binding.platform,
        channelId: binding.channelId || binding.externalId,
        title: binding.title,
        instructionMode: $('#channel-instruction-mode').value,
        instructions: $('#channel-instructions').value,
        capabilityMode,
        skillIds: selectedSkillIds('#channel-skill-picker'),
        knowledgeSourceIds: selectedKnowledgeSourceIds('#channel-source-picker'),
        agentIds: selectedDelegatedAgentIds('#channel-agent-picker'),
        toolApprovalPolicy: {
          mode: $('#channel-tool-approval-mode').value,
          risks: ['write'],
        },
        tools:
          capabilityMode === 'inherit'
            ? undefined
            : selectedTools('#channel-tool-grid'),
        toolConstraints:
          capabilityMode === 'inherit'
            ? undefined
            : toolConstraints('#channel-tool-grid'),
        networkMode:
          capabilityMode === 'inherit'
            ? undefined
            : $('#channel-network-mode').value,
        allowedHosts:
          capabilityMode === 'inherit'
            ? undefined
            : $('#channel-allowed-hosts').value
                .split(',')
                .map((host) => host.trim())
                .filter(Boolean),
        budgetPolicy: {
          mode: budgetMode,
          scope: budgetMode === 'custom' ? 'channel' : undefined,
          maxRunsPerMonth:
            budgetMode === 'custom' && $('#channel-budget-runs').value !== ''
              ? Number($('#channel-budget-runs').value)
              : undefined,
          maxCostUsdPerMonth:
            budgetMode === 'custom' && $('#channel-budget-cost').value !== ''
              ? Number($('#channel-budget-cost').value)
              : undefined,
        },
      }),
    });
    $('#channel-policy-dialog').close();
    await refreshAll({ quiet: true });
    showToast('Channel policy saved');
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    setButtonBusy(button, false, 'Saving', 'Save channel');
  }
}

async function removeChannelPolicy() {
  const binding = state.selectedChannelBinding;
  if (!binding) return;
  const query = new URLSearchParams({
    workspaceId: binding.workspaceId,
    projectId: binding.projectId,
    platform: binding.platform,
    channelId: binding.channelId || binding.externalId,
  });
  try {
    await getJson(`/v1/channel-policies?${query}`, { method: 'DELETE' });
    $('#channel-policy-dialog').close();
    await refreshAll({ quiet: true });
    showToast('Channel now uses project defaults');
  } catch (error) {
    showToast(error.message, 'error');
  }
}

function renderProjectList() {
  const root = $('#project-list');
  root.replaceChildren();
  for (const project of state.workspace?.projects || []) {
    const identity =
      project.agentMode === 'inherit'
        ? state.workspace?.workspace?.identity || project.identity
        : project.identity;
    const button = element('button', 'project-list-item');
    button.type = 'button';
    button.classList.toggle('active', projectMatches(project, state.selectedProjectId));
    button.append(
      element('strong', '', project.name),
      element('span', '', `${identity?.displayName || 'MaxTag'} / ${project.projectId}`),
    );
    button.addEventListener('click', () => selectProject(project.projectId));
    root.append(button);
  }
}

function fillProjectForm(project) {
  const isNew = !project;
  const fallbackIdentity = state.workspace?.workspace?.identity || {};
  const agentMode = project?.agentMode || (isNew ? 'inherit' : 'custom');
  const identity = agentMode === 'inherit' ? fallbackIdentity : project?.identity || fallbackIdentity;
  $('#project-editor-title').textContent = project?.name || 'New project';
  $('#project-policy-state').textContent = isNew ? 'Draft' : 'Configured';
  $('#project-policy-state').className = `state-pill ${isNew ? 'planned' : 'ready'}`;
  $('#project-name').value = project?.name || '';
  $('#project-id').value = project?.projectId || '';
  $('#project-id').disabled = !isNew;
  $('#project-description').value = project?.description || '';
  $('#agent-name').value = identity.displayName || 'MaxTag';
  $('#agent-instructions').value = identity.instructions || '';
  $('#project-agent-mode').value = agentMode;
  $('#agent-mode-label').textContent =
    agentMode === 'inherit' ? 'Workspace profile' : identity.id || 'Custom profile';
  $('#project-memory-mode').value = project?.memoryMode || 'workspace';
  $('#project-memory-label').textContent =
    $('#project-memory-mode').value === 'workspace'
      ? 'Workspace shared'
      : 'Project isolated';
  fillProjectMemoryApproval(project?.memoryApprovalPolicy);
  renderSkillPicker('#project-skill-picker', project?.skillIds || [], {
    markDirty: markProjectDirty,
  });
  renderKnowledgeSourcePicker(
    '#project-source-picker',
    project?.knowledgeSourceIds || [],
    { markDirty: markProjectDirty },
  );
  renderDelegatedAgentPicker('#project-agent-picker', project?.agentIds || [], {
    markDirty: markProjectDirty,
  });
  const workspaceSkillCount = state.workspace?.workspace?.skillIds?.length || 0;
  const projectSkillCount = project?.skillIds?.length || 0;
  $('#project-skill-summary').textContent = `${workspaceSkillCount} workspace / ${projectSkillCount} project`;
  const workspaceSourceCount = state.workspace?.workspace?.knowledgeSourceIds?.length || 0;
  const projectSourceCount = project?.knowledgeSourceIds?.length || 0;
  $('#project-source-summary').textContent = `${workspaceSourceCount} workspace / ${projectSourceCount} project`;
  const workspaceAgentCount = state.workspace?.workspace?.agentIds?.length || 0;
  const projectAgentCount = project?.agentIds?.length || 0;
  $('#project-agent-summary').textContent = `${workspaceAgentCount} workspace / ${projectAgentCount} project`;
  fillMemoryRetention('project', project?.memoryRetentionPolicy, true);
  fillExecutorOptions(identity.defaultExecutorId || 'codex');
  updateProjectAgentFields();
  $('#project-capability-mode').value =
    project?.capabilityMode || (isNew ? 'inherit' : 'custom');
  $('#project-tool-approval-mode').value =
    project?.toolApprovalPolicy?.mode || 'inherit';
  updateProjectCapabilityFields();
  renderProjectBindings(project);
  state.projectDirty = false;
  $('#project-save-state').textContent = 'No unsaved changes';
}

function updateProjectCapabilityFields(policyOverride) {
  const inherited = $('#project-capability-mode').value === 'inherit';
  const policy = inherited
    ? state.workspace?.workspace || {}
    : policyOverride || selectedProject() || {};
  $('#project-capability-label').textContent = inherited
    ? 'Workspace defaults'
    : 'Project custom';
  $('#project-network-label').textContent = inherited
    ? 'Workspace defaults'
    : 'Project custom';
  $('#network-mode').value = policy.networkPolicy?.mode || 'deny-by-default';
  $('#allowed-hosts').value = (policy.networkPolicy?.allowedHosts || []).join(', ');
  $('#project-network-fields').hidden = inherited;
  const networkSummary = $('#project-network-inherited');
  networkSummary.hidden = !inherited;
  if (inherited) {
    const toolRoot = $('#tool-grid');
    toolRoot.replaceChildren();
    const toolSummary = element('div', 'inherited-policy-summary');
    const toolCopy = element('div', 'inherited-policy-copy');
    const toolCount = policy.grants?.length || 0;
    toolCopy.append(
      element(
        'strong',
        '',
        `${toolCount} workspace tool ${toolCount === 1 ? 'group' : 'groups'}`,
      ),
      element('span', '', 'Changes follow the workspace agent automatically'),
    );
    const editTools = element('button', 'text-button', 'Edit defaults');
    editTools.type = 'button';
    editTools.addEventListener('click', openWorkspaceCapabilities);
    toolSummary.append(toolCopy, editTools);
    toolRoot.append(toolSummary);
    const networkCopy = element('div', 'inherited-policy-copy');
    networkCopy.append(
      element(
        'strong',
        '',
        statusLabel(policy.networkPolicy?.mode || 'deny-by-default'),
      ),
      element(
        'span',
        '',
        policy.networkPolicy?.allowedHosts?.length
          ? policy.networkPolicy.allowedHosts.join(', ')
          : 'No hosts explicitly allowed',
      ),
    );
    networkSummary.replaceChildren(networkCopy);
    return;
  }
  renderToolGrid(policy);
}

function updateProjectAgentFields() {
  const inherited = $('#project-agent-mode').value === 'inherit';
  for (const control of [
    $('#agent-name'),
    $('#agent-executor'),
    $('#agent-instructions'),
  ]) {
    control.disabled = inherited;
  }
  $('#agent-mode-label').textContent = inherited
    ? 'Workspace profile'
    : currentAgentId();
  $('#project-memory-label').textContent =
    $('#project-memory-mode').value === 'workspace'
      ? 'Workspace shared'
      : 'Project isolated';
  updateProjectMemoryApprovalFields();
}

function memoryApprovalSelector(prefix, suffix) {
  return $(`#${prefix}-memory-approval-${suffix}`);
}

function fillMemoryApproval(prefix, policy = { mode: 'inherit' }, defaults = {}) {
  const allowedModes = defaults.allowInherit
    ? ['inherit', 'disabled', 'require_approval']
    : ['disabled', 'require_approval'];
  const fallbackMode = defaults.mode || (defaults.allowInherit ? 'inherit' : 'disabled');
  const mode = policy?.mode || fallbackMode;
  memoryApprovalSelector(prefix, 'mode').value = allowedModes.includes(mode)
    ? mode
    : fallbackMode;
  const actions = policy?.actions?.length ? policy.actions : ['remember', 'forget'];
  const scopes = policy?.scopes?.length
    ? policy.scopes
    : defaults.scopes || ['project'];
  memoryApprovalSelector(prefix, 'remember').checked = actions.includes('remember');
  memoryApprovalSelector(prefix, 'forget').checked = actions.includes('forget');
  memoryApprovalSelector(prefix, 'workspace').checked = scopes.includes('workspace');
  memoryApprovalSelector(prefix, 'project').checked = scopes.includes('project');
  memoryApprovalSelector(prefix, 'channel').checked = scopes.includes('channel');
  memoryApprovalSelector(prefix, 'thread').checked = scopes.includes('thread');
}

function fillProjectMemoryApproval(policy = { mode: 'inherit' }) {
  fillMemoryApproval('project', policy, {
    allowInherit: true,
    mode: 'inherit',
    scopes: ['project'],
  });
  updateProjectMemoryApprovalFields();
}

function updateMemoryApprovalOptions(prefix) {
  const mode = memoryApprovalSelector(prefix, 'mode').value;
  const active = mode === 'require_approval';
  const options = $(`#${prefix}-memory-approval-options`);
  options.hidden = !active;
  for (const control of $$(`#${prefix}-memory-approval-options input`)) {
    control.disabled = !active;
  }
  return mode;
}

function updateProjectMemoryApprovalFields() {
  const mode = updateMemoryApprovalOptions('project');
  const boundary =
    $('#project-memory-mode').value === 'workspace'
      ? 'Workspace shared'
      : 'Project isolated';
  const approval =
    mode === 'require_approval'
      ? 'approval gated'
      : mode === 'disabled'
        ? 'direct writes'
        : 'inherited approval';
  $('#project-memory-label').textContent = `${boundary} / ${approval}`;
}

function memoryApprovalPolicyInput(prefix, defaults = {}) {
  const mode = memoryApprovalSelector(prefix, 'mode').value;
  if (mode === 'inherit' || mode === 'disabled') return { mode };
  const actions = [
    memoryApprovalSelector(prefix, 'remember').checked ? 'remember' : undefined,
    memoryApprovalSelector(prefix, 'forget').checked ? 'forget' : undefined,
  ].filter(Boolean);
  const scopes = [
    memoryApprovalSelector(prefix, 'workspace').checked ? 'workspace' : undefined,
    memoryApprovalSelector(prefix, 'project').checked ? 'project' : undefined,
    memoryApprovalSelector(prefix, 'channel').checked ? 'channel' : undefined,
    memoryApprovalSelector(prefix, 'thread').checked ? 'thread' : undefined,
  ].filter(Boolean);
  return {
    mode: 'require_approval',
    actions: actions.length ? actions : ['remember', 'forget'],
    scopes: scopes.length ? scopes : defaults.scopes || ['project'],
  };
}

function projectMemoryApprovalPolicyInput() {
  return memoryApprovalPolicyInput('project', { scopes: ['project'] });
}

function fillWorkspaceMemoryApproval() {
  fillMemoryApproval(
    'workspace',
    state.workspace?.workspace?.memoryApprovalPolicy || { mode: 'disabled' },
    { mode: 'disabled', scopes: ['workspace', 'project'] },
  );
  updateWorkspaceMemoryApprovalFields();
}

function updateWorkspaceMemoryApprovalFields() {
  updateMemoryApprovalOptions('workspace');
}

function workspaceMemoryApprovalPolicyInput() {
  return memoryApprovalPolicyInput('workspace', {
    scopes: ['workspace', 'project'],
  });
}

function fillMemoryRetention(prefix, policy = {}, allowInherit = false) {
  const fallbackMode = allowInherit ? 'inherit' : 'keep';
  const mode = policy?.mode || fallbackMode;
  const allowed = allowInherit
    ? ['inherit', 'keep', 'custom']
    : ['keep', 'custom'];
  $(`#${prefix}-memory-retention-mode`).value = allowed.includes(mode)
    ? mode
    : fallbackMode;
  $(`#${prefix}-memory-retention-days`).value = policy?.days || 90;
  updateMemoryRetentionPolicyFields(prefix);
}

function updateMemoryRetentionPolicyFields(prefix) {
  const custom = $(`#${prefix}-memory-retention-mode`).value === 'custom';
  const field = $(`#${prefix}-memory-retention-days-field`);
  const input = $(`#${prefix}-memory-retention-days`);
  field.hidden = !custom;
  input.disabled = !custom;
}

function memoryRetentionPolicyInput(prefix) {
  const mode = $(`#${prefix}-memory-retention-mode`).value;
  if (mode === 'inherit' || mode === 'keep') return { mode };
  const days = Number($(`#${prefix}-memory-retention-days`).value);
  if (!Number.isInteger(days) || days < 1 || days > 3650) {
    throw new Error('Memory retention must be between 1 and 3650 days');
  }
  return { mode: 'custom', days };
}

function fillWorkspaceMemoryRetention() {
  fillMemoryRetention(
    'workspace',
    state.workspace?.workspace?.memoryRetentionPolicy || { mode: 'keep' },
  );
}

function workspaceMemoryRetentionPolicyInput() {
  return memoryRetentionPolicyInput('workspace');
}

function projectMemoryRetentionPolicyInput() {
  return memoryRetentionPolicyInput('project');
}

function selectProject(projectId) {
  const project = projectById(projectId);
  state.selectedProjectId = project?.projectId || projectId;
  if (!state.memoryProjectId || project) state.memoryProjectId = project?.projectId || projectId;
  renderProjectList();
  fillProjectForm(project);
  fillProjectSelects();
}

function markProjectDirty() {
  state.projectDirty = true;
  $('#project-save-state').textContent = 'Unsaved changes';
}

function newProject() {
  state.selectedProjectId = '__new__';
  renderProjectList();
  fillProjectForm(null);
  $('#project-id').focus();
}

function currentAgentId() {
  const project = selectedProject();
  if ($('#project-agent-mode')?.value === 'inherit') {
    return state.workspace?.workspace?.identity?.id || 'opentag';
  }
  const workspaceAgentId = state.workspace?.workspace?.identity?.id;
  if (
    project?.identity?.id &&
    project.identity.id !== workspaceAgentId
  ) {
    return project.identity.id;
  }
  const projectId = $('#project-id').value.trim() || 'project';
  return `${projectId}-agent`;
}

async function saveProject(event) {
  event.preventDefault();
  const button = $('#save-project');
  const projectId = $('#project-id').value.trim();
  if (!projectId) {
    showToast('Project ID is required', 'error');
    $('#project-id').focus();
    return;
  }
  setButtonBusy(button, true, 'Saving', 'Save project');
  try {
    const customCapabilities = $('#project-capability-mode').value === 'custom';
    await getJson('/v1/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workspaceId: currentWorkspaceId(),
        projectId,
        name: $('#project-name').value.trim() || projectId,
        description: $('#project-description').value,
        agentMode: $('#project-agent-mode').value,
        agentId: currentAgentId(),
        agentName: $('#agent-name').value.trim() || 'MaxTag',
        instructions: $('#agent-instructions').value,
        executorId: $('#agent-executor').value,
        memoryMode: $('#project-memory-mode').value,
        skillIds: selectedSkillIds('#project-skill-picker'),
        knowledgeSourceIds: selectedKnowledgeSourceIds('#project-source-picker'),
        agentIds: selectedDelegatedAgentIds('#project-agent-picker'),
        memoryApprovalPolicy: projectMemoryApprovalPolicyInput(),
        memoryRetentionPolicy: projectMemoryRetentionPolicyInput(),
        toolApprovalPolicy: {
          mode: $('#project-tool-approval-mode').value,
          risks: ['write'],
        },
        capabilityMode: $('#project-capability-mode').value,
        tools: customCapabilities ? selectedTools('#tool-grid') : undefined,
        toolConstraints: customCapabilities
          ? toolConstraints('#tool-grid')
          : undefined,
        networkMode: customCapabilities ? $('#network-mode').value : undefined,
        allowedHosts: customCapabilities
          ? $('#allowed-hosts')
              .value.split(',')
              .map((host) => host.trim())
              .filter(Boolean)
          : undefined,
      }),
    });
    state.selectedProjectId = projectId;
    await refreshAll({ quiet: true });
    showToast('Project policy saved');
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    setButtonBusy(button, false, 'Saving', 'Save project');
  }
}

async function saveBinding() {
  const button = $('#save-binding');
  const project = selectedProject();
  const externalId = $('#binding-external-id').value.trim();
  if (!project || !externalId) {
    showToast('Select a project and enter a channel ID', 'error');
    return;
  }
  setButtonBusy(button, true, 'Binding', 'Bind');
  try {
    await getJson('/v1/bindings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        platform: $('#binding-platform').value,
        externalId,
        channelId: externalId,
        workspaceId: project.workspaceId,
        projectId: project.projectId,
        scope: 'channel',
        source: 'configured',
        activationMode: $('#binding-activation-mode').value,
        requireMention: $('#binding-require-mention').checked,
      }),
    });
    $('#binding-external-id').value = '';
    await refreshAll({ quiet: true });
    showToast('Channel bound');
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    setButtonBusy(button, false, 'Binding', 'Bind');
  }
}

async function generatePairing(event) {
  event.preventDefault();
  const button = $('#generate-pairing');
  const projectId = $('#pairing-project').value;
  const project = projectById(projectId);
  if (!project) {
    showToast('Select a project first', 'error');
    return;
  }
  state.pairingProjectId = project.projectId;
  setButtonBusy(button, true, 'Generating', 'Generate code');
  try {
    state.latestPairing = await getJson('/v1/pairing-invitations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        platform: $('#pairing-platform').value,
        workspaceId: project.workspaceId || currentWorkspaceId(),
        projectId: project.projectId,
        activationMode: $('#pairing-activation-mode').value,
        requireMention: $('#pairing-require-mention').checked,
      }),
    });
    await refreshAll({ quiet: true });
    showToast('Pairing command ready');
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    setButtonBusy(button, false, 'Generating', 'Generate code');
  }
}

async function copyPairingCommand() {
  const command = state.latestPairing?.command;
  if (!command) return;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(command);
    } else {
      const input = document.createElement('textarea');
      input.value = command;
      input.style.position = 'fixed';
      input.style.opacity = '0';
      document.body.append(input);
      input.select();
      document.execCommand('copy');
      input.remove();
    }
    showToast('Command copied');
  } catch (error) {
    showToast(error.message || 'Could not copy command', 'error');
  }
}

async function revokePairing(id) {
  try {
    await getJson(
      `/v1/pairing-invitations/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    );
    if (state.latestPairing?.invitation?.id === id) state.latestPairing = null;
    await refreshAll({ quiet: true });
    showToast('Invitation revoked');
  } catch (error) {
    showToast(error.message, 'error');
  }
}

async function removeBinding(id) {
  try {
    const result = await getJson(`/v1/bindings/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    await refreshAll({ quiet: true });
    const count = result.removed?.length || 1;
    showToast(count > 1 ? `Chat and ${count - 1} topic routes unbound` : 'Chat unbound');
  } catch (error) {
    showToast(error.message, 'error');
  }
}

function routineById(value) {
  return (state.routines?.routines || []).find((routine) => routine.id === value);
}

function routineScheduleLabel(schedule) {
  if (schedule?.kind === 'once') {
    return `Once / ${formatTime(schedule.at, true)}`;
  }
  if (schedule?.kind === 'daily') {
    return `${schedule.time} daily / ${schedule.timeZone}`;
  }
  return `Every ${schedule?.everyMinutes || 0} min`;
}

function localDateTimeInputValue(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 16);
}

function fillRoutineProjectOptions(selectedValue) {
  const select = $('#routine-project');
  select.replaceChildren();
  const workspaceOption = document.createElement('option');
  workspaceOption.value = '';
  workspaceOption.textContent = 'Workspace default';
  workspaceOption.selected = !selectedValue;
  select.append(workspaceOption);
  for (const project of state.workspace?.projects || []) {
    const option = document.createElement('option');
    option.value = project.projectId;
    option.textContent = project.name;
    option.selected = projectMatches(project, selectedValue);
    select.append(option);
  }
}

function updateRoutineScheduleFields() {
  const kind = $('#routine-schedule-kind').value;
  $('#routine-once-at-field').hidden = kind !== 'once';
  $('#routine-interval-field').hidden = kind !== 'interval';
  $('#routine-daily-time-field').hidden = kind !== 'daily';
  $('#routine-time-zone-field').hidden = kind !== 'daily';
}

function updateClientDestinationFields() {
  const bindingPlatform = $('#binding-platform').value;
  const bindingGitHub = bindingPlatform === 'github';
  const bindingSlack = bindingPlatform === 'slack';
  $('#binding-external-id-label').textContent = bindingGitHub
    ? 'Repository'
    : 'Channel ID';
  $('#binding-external-id').placeholder = bindingGitHub
    ? 'owner/repo'
    : bindingSlack
      ? 'C0123456789'
      : 'oc_xxx';

  for (const kind of ['routine', 'workflow']) {
    const platform = $(`#${kind}-platform`).value;
    const github = platform === 'github';
    const slack = platform === 'slack';
    $(`#${kind}-external-id-label`).textContent = github
      ? 'Issue / PR'
      : 'Channel ID';
    $(`#${kind}-external-id`).placeholder = github
      ? 'owner/repo#123'
      : slack
        ? 'C0123456789'
        : 'oc_xxx';
  }
}

function preferredRoutineBinding(projectId, platform) {
  const project = projectById(projectId);
  const candidates = project
    ? projectBindings(project)
    : state.bindings.filter((binding) => binding.workspaceId === currentWorkspaceId());
  return candidates.find((binding) => binding.platform === platform);
}

function fillRoutineDestination(force = false) {
  const externalId = $('#routine-external-id');
  if (!force && externalId.value.trim()) return;
  const binding = preferredRoutineBinding(
    $('#routine-project').value,
    $('#routine-platform').value,
  );
  if (!binding) {
    if (force) externalId.value = '';
    return;
  }
  externalId.value =
    binding.platform === 'github' && !binding.externalId.includes('#')
      ? `${binding.externalId}#`
      : binding.externalId;
}

function routineExecutions(routineId) {
  return (state.routines?.executions || []).filter(
    (execution) => execution.routineId === routineId,
  );
}

function routineNotifications(routineId) {
  return (state.routines?.notifications || []).filter(
    (notification) => notification.routineId === routineId,
  );
}

function routineNotificationLabel(routine) {
  const policy = routine?.notifications || { mode: 'every_result' };
  if (policy.mode === 'silent') return 'Silent';
  if (policy.mode === 'failures_only') {
    return `After ${policy.failureThreshold || 1} failure${policy.failureThreshold === 1 ? '' : 's'}`;
  }
  return 'Every result';
}

function updateRoutineNotificationFields() {
  const failuresOnly = $('#routine-notification-mode').value === 'failures_only';
  $('#routine-failure-threshold-field').hidden = !failuresOnly;
  $('#routine-recovery-field').hidden = !failuresOnly;
}

function renderRoutineExecutions(routine) {
  const root = $('#routine-executions');
  root.replaceChildren();
  const executions = routine ? routineExecutions(routine.id) : [];
  const notifications = routine ? routineNotifications(routine.id) : [];
  $('#routine-execution-count').textContent = notifications.length
    ? `${executions.length} runs / ${notifications.length} notices`
    : `${executions.length} recorded`;
  if (!executions.length) {
    root.append(
      element(
        'div',
        'empty-state',
        routine ? 'No executions yet' : 'Save the routine to create executions',
      ),
    );
    return;
  }
  for (const execution of executions.slice(0, 20)) {
    const row = element('div', 'routine-execution-row');
    const copy = element('div', 'routine-execution-copy');
    copy.append(
      element(
        'strong',
        '',
        `${statusLabel(execution.trigger)} / ${formatTime(execution.scheduledFor, true)}`,
      ),
      element(
        'small',
        '',
        execution.error ||
          execution.summary ||
          (execution.runId ? `Run ${shortId(execution.runId)}` : execution.dedupKey),
      ),
    );
    row.append(
      statePill(execution.status),
      copy,
      element('span', 'routine-execution-time', formatTime(execution.updatedAt, true)),
    );
    if (execution.runId) {
      const open = element('button', 'routine-run-link', 'Open run');
      open.type = 'button';
      open.addEventListener('click', () => void openRoutineRun(execution.runId));
      row.append(open);
    } else {
      row.append(element('span', 'routine-execution-time', 'Not queued'));
    }
    root.append(row);
  }
}

async function openRoutineRun(runId) {
  try {
    state.activityQuery = '';
    state.activitySearchTruncated = false;
    state.selectedActivityProjectId = '';
    state.selectedActivityThreadId = '__all__';
    const data = await getJson(activityRunsUrl());
    state.runs = data.runs || [];
    state.activityRuns = data.runs || [];
    state.selectedRunId = runId;
    showView('activity');
    renderRunTable();
    await openRun(runId);
  } catch (error) {
    showToast(error.message, 'error');
  }
}

function renderRoutineList() {
  const root = $('#routine-list');
  root.replaceChildren();
  const routines = state.routines?.routines || [];
  if (!routines.length) {
    root.append(element('div', 'empty-state', 'No routines configured'));
    return;
  }
  for (const routine of routines) {
    const project = projectById(routine.projectId);
    const latest = routineExecutions(routine.id)[0];
    const button = element('button', 'project-list-item');
    button.type = 'button';
    button.classList.toggle('active', routine.id === state.selectedRoutineId);
    button.append(
      element('strong', '', routine.name),
      element(
        'span',
        '',
        `${routine.enabled ? 'Enabled' : 'Disabled'} / ${project?.name || 'Workspace'} / ${routineScheduleLabel(routine.schedule)}`,
      ),
      element('span', '', routineNotificationLabel(routine)),
      element(
        'span',
        `routine-list-last${latest ? ` ${latest.status}` : ''}`,
        latest
          ? `Last ${statusLabel(latest.status)} / ${formatTime(latest.completedAt || latest.updatedAt, true)}`
          : 'Never run',
      ),
    );
    button.addEventListener('click', () => selectRoutine(routine.id));
    root.append(button);
  }
}

function fillRoutineForm(routine) {
  const isNew = !routine;
  const defaultProjectId = state.workspace?.projects?.[0]?.projectId || '';
  const projectId = routine?.projectId || (isNew ? defaultProjectId : '');
  $('#routine-editor-title').textContent = routine?.name || 'New routine';
  $('#routine-state').textContent = isNew
    ? 'Draft'
    : routine.enabled
      ? 'Enabled'
      : 'Disabled';
  $('#routine-state').className = `state-pill ${isNew ? 'planned' : routine.enabled ? 'enabled' : 'disabled'}`;
  $('#routine-name').value = routine?.name || '';
  fillRoutineProjectOptions(projectId);
  $('#routine-instructions').value = routine?.instructions || '';
  $('#routine-enabled').checked = routine?.enabled ?? true;
  $('#routine-notification-mode').value =
    routine?.notifications?.mode || 'every_result';
  $('#routine-failure-threshold').value =
    routine?.notifications?.failureThreshold || 1;
  $('#routine-recovery').checked = routine?.notifications?.recovery !== false;
  updateRoutineNotificationFields();
  $('#routine-schedule-kind').value = routine?.schedule?.kind || 'interval';
  $('#routine-once-at').value =
    routine?.schedule?.kind === 'once'
      ? localDateTimeInputValue(routine.schedule.at)
      : '';
  $('#routine-every-minutes').value =
    routine?.schedule?.kind === 'interval' ? routine.schedule.everyMinutes : 60;
  $('#routine-daily-time').value =
    routine?.schedule?.kind === 'daily' ? routine.schedule.time : '09:00';
  $('#routine-time-zone').value =
    routine?.schedule?.kind === 'daily' ? routine.schedule.timeZone : 'Asia/Shanghai';
  updateRoutineScheduleFields();
  $('#routine-platform').value = routine?.destination?.platform || 'lark';
  $('#routine-external-id').value = routine?.destination?.externalId || '';
  $('#routine-visibility').value = routine?.destination?.visibility || 'public';
  $('#routine-thread-id').value = routine?.destination?.threadId || '';
  if (isNew) fillRoutineDestination();
  updateClientDestinationFields();
  $('#routine-next-run').textContent = routine?.nextRunAt
    ? `Next ${formatTime(routine.nextRunAt, true)}`
    : 'Not scheduled';
  $('#delete-routine').hidden = isNew;
  $('#trigger-routine').disabled = isNew;
  renderRoutineExecutions(routine);
  state.routineDirty = false;
  $('#routine-save-state').textContent = isNew ? 'New routine' : 'No unsaved changes';
}

function selectRoutine(routineId) {
  if (state.routineDirty && !window.confirm('Discard unsaved routine changes?')) return;
  state.selectedRoutineId = routineId;
  renderRoutineList();
  fillRoutineForm(routineById(routineId));
}

function newRoutine() {
  if (state.routineDirty && !window.confirm('Discard unsaved routine changes?')) return;
  state.selectedRoutineId = '__new__';
  renderRoutineList();
  fillRoutineForm(null);
  $('#routine-name').focus();
}

function markRoutineDirty() {
  state.routineDirty = true;
  $('#routine-save-state').textContent = 'Unsaved changes';
  $('#trigger-routine').disabled = true;
}

function routinePayload() {
  const kind = $('#routine-schedule-kind').value;
  const everyMinutes = Number($('#routine-every-minutes').value);
  const name = $('#routine-name').value.trim();
  const instructions = $('#routine-instructions').value.trim();
  const externalId = $('#routine-external-id').value.trim();
  if (!name || !instructions || !externalId) {
    throw new Error('Name, instructions, and channel ID are required');
  }
  if (
    $('#routine-platform').value === 'github' &&
    !/^[^/#\s]+\/[^/#\s]+#[1-9]\d*$/.test(externalId)
  ) {
    throw new Error('GitHub destination must be owner/repo#issue');
  }
  if (kind === 'interval' && (!Number.isFinite(everyMinutes) || everyMinutes < 1)) {
    throw new Error('Interval must be at least one minute');
  }
  const onceAt = $('#routine-once-at').value;
  if (kind === 'once' && !onceAt) {
    throw new Error('Run-at time is required');
  }
  const failureThreshold = Number($('#routine-failure-threshold').value);
  if (
    $('#routine-notification-mode').value === 'failures_only' &&
    (!Number.isInteger(failureThreshold) || failureThreshold < 1 || failureThreshold > 10)
  ) {
    throw new Error('Failure threshold must be between 1 and 10');
  }
  const existing = routineById(state.selectedRoutineId);
  return {
    id: existing?.id,
    workspaceId: currentWorkspaceId(),
    projectId: $('#routine-project').value || undefined,
    name,
    instructions,
    enabled: $('#routine-enabled').checked,
    schedule:
      kind === 'once'
        ? { kind, at: new Date(onceAt).toISOString() }
        : kind === 'daily'
        ? {
            kind,
            time: $('#routine-daily-time').value,
            timeZone: $('#routine-time-zone').value.trim(),
          }
        : { kind, everyMinutes },
    notifications: {
      mode: $('#routine-notification-mode').value,
      failureThreshold,
      recovery: $('#routine-recovery').checked,
    },
    destination: {
      platform: $('#routine-platform').value,
      externalId,
      channelId: externalId,
      threadId: $('#routine-thread-id').value.trim() || undefined,
      visibility: $('#routine-visibility').value,
      title: name,
    },
  };
}

async function saveRoutine(event) {
  event.preventDefault();
  const button = $('#save-routine');
  setButtonBusy(button, true, 'Saving', 'Save routine');
  try {
    const data = await getJson('/v1/routines', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(routinePayload()),
    });
    state.routines = data.routines;
    state.selectedRoutineId = data.routine.id;
    state.routineDirty = false;
    renderRoutines();
    renderWorkspaceHeader();
    renderSummary();
    showToast('Routine saved');
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    setButtonBusy(button, false, 'Saving', 'Save routine');
  }
}

async function triggerRoutine() {
  const routine = routineById(state.selectedRoutineId);
  if (!routine) return;
  const button = $('#trigger-routine');
  setButtonBusy(button, true, 'Starting', 'Run now');
  try {
    const data = await getJson(`/v1/routines/${encodeURIComponent(routine.id)}/trigger`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    state.routines = data.routines;
    renderRoutines();
    showToast(`Routine accepted / ${statusLabel(data.execution.status)}`);
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    setButtonBusy(button, false, 'Starting', 'Run now');
  }
}

async function deleteRoutine() {
  const routine = routineById(state.selectedRoutineId);
  if (!routine || !window.confirm(`Delete ${routine.name}?`)) return;
  const button = $('#delete-routine');
  setButtonBusy(button, true, 'Deleting', 'Delete');
  try {
    const data = await getJson(`/v1/routines/${encodeURIComponent(routine.id)}`, {
      method: 'DELETE',
    });
    state.routines = data.routines;
    state.selectedRoutineId = state.routines.routines?.[0]?.id || '__new__';
    state.routineDirty = false;
    renderRoutines();
    renderWorkspaceHeader();
    showToast('Routine deleted');
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    setButtonBusy(button, false, 'Deleting', 'Delete');
  }
}

async function tickRoutines() {
  const button = $('#tick-routines');
  setButtonBusy(button, true, 'Ticking', 'Tick now');
  try {
    const data = await getJson('/v1/routines/tick', { method: 'POST' });
    state.routines = data.routines;
    renderRoutines();
    showToast(
      `Staged ${data.result.staged} / queued ${data.result.queued} / failed ${data.result.failed}`,
    );
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    setButtonBusy(button, false, 'Ticking', 'Tick now');
  }
}

function renderRoutines() {
  const scheduler = state.routines?.scheduler || {};
  const schedulerLabel = !scheduler.enabled
    ? 'Disabled'
    : scheduler.mode === 'external'
      ? 'External'
      : scheduler.mode === 'manual'
        ? 'Manual'
        : 'Inline';
  $('#scheduler-state').textContent = schedulerLabel;
  $('#scheduler-state').className = `state-pill ${scheduler.enabled ? 'enabled' : 'disabled'}`;
  const nextRunAt = state.routines?.summary?.nextRunAt;
  const modeDetail = scheduler.mode === 'external'
    ? 'Independent scheduler'
    : scheduler.mode === 'manual'
      ? 'Manual ticks only'
      : 'Server scheduler';
  $('#scheduler-detail').textContent = scheduler.lastTickAt
    ? `${modeDetail} / last ${formatTime(scheduler.lastTickAt, true)} / ${nextRunAt ? `next ${formatTime(nextRunAt, true)}` : 'nothing due'}`
    : nextRunAt
      ? `${modeDetail} / next ${formatTime(nextRunAt, true)}`
      : `${modeDetail} / no enabled routines`;
  const available = state.routines?.routines || [];
  if (
    state.selectedRoutineId !== '__new__' &&
    !routineById(state.selectedRoutineId)
  ) {
    state.selectedRoutineId = available[0]?.id || '__new__';
  }
  renderRoutineList();
  if (!state.routineDirty) {
    fillRoutineForm(routineById(state.selectedRoutineId));
  }
}

function workflowById(value) {
  return (state.workflows?.workflows || []).find((workflow) => workflow.id === value);
}

function workflowTriggerLabel(trigger) {
  return trigger?.kind === 'event' ? trigger.eventType || 'Event' : 'Manual';
}

function workflowProducerLabel(trigger) {
  if (!trigger?.producer) return '';
  if (trigger.producer === 'github-webhook') return 'GitHub webhook';
  if (trigger.producer === 'alertmanager-webhook') return 'Alertmanager webhook';
  if (trigger.producer === 'http-ingress') return 'HTTP producer';
  return statusLabel(trigger.producer);
}

function fillWorkflowEventCatalog() {
  const catalog = $('#workflow-event-catalog');
  catalog.replaceChildren();
  for (const item of state.capabilities?.workflowEventCatalog || []) {
    const option = document.createElement('option');
    option.value = item.value;
    option.label = item.label || item.value;
    catalog.append(option);
  }
}

function updateWorkflowProducerHint() {
  const eventType = $('#workflow-event-type').value.trim();
  const native = (state.capabilities?.workflowEventCatalog || []).some(
    (item) => item.value === eventType,
  );
  $('#workflow-producer-hint').hidden = !native;
  $('#workflow-producer-hint-copy').textContent = eventType.startsWith('alertmanager.')
    ? 'Alertmanager uses a bearer-authenticated route fixed to one project; webhook payload scope is ignored.'
    : 'GitHub PR, issue, and Actions events use the configured repository binding for this project.';
}

function fillWorkflowProducerProjectOptions() {
  const select = $('#workflow-producer-project');
  const current = select.value;
  select.replaceChildren();
  for (const project of state.workspace?.projects || []) {
    const option = document.createElement('option');
    option.value = project.projectId;
    option.textContent = project.name;
    option.selected = projectMatches(project, current || state.selectedProjectId);
    select.append(option);
  }
}

function alertmanagerReceiverUrl(route) {
  return `${window.location.origin}/v1/alertmanager/${encodeURIComponent(route.id)}/events`;
}

function workflowProducerRuntime(routeId) {
  return (state.workflows?.producerRuntime || []).find(
    (runtime) => runtime.routeId === routeId,
  );
}

function updateWorkflowProducerFields() {
  const document = $('#workflow-producer-kind').value === 'lark-document';
  for (const field of $$('.workflow-producer-document-field')) {
    field.hidden = !document;
  }
  $('#workflow-producer-document-id').required = document;
  $('#workflow-producer-poll-interval').required = document;
  $('#workflow-producer-name').placeholder = document
    ? 'Release notes'
    : 'Production alerts';
}

async function copyText(value, success) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
  } else {
    const textarea = document.createElement('textarea');
    textarea.value = value;
    document.body.append(textarea);
    textarea.select();
    document.execCommand('copy');
    textarea.remove();
  }
  showToast(success);
}

function renderWorkflowProducerRoutes() {
  const root = $('#workflow-producer-routes');
  root.replaceChildren();
  const alertmanager = state.workflows?.producerIngress?.alertmanager || {};
  const document = state.workflows?.producerIngress?.larkDocument || {};
  const ready = alertmanager.mode === 'bearer' || document.available;
  $('#workflow-producer-state').textContent = ready ? 'Ready' : 'Setup required';
  $('#workflow-producer-state').className = `state-pill ${ready ? 'enabled' : 'disabled'}`;
  fillWorkflowProducerProjectOptions();
  updateWorkflowProducerFields();
  const routes = state.workflows?.producerRoutes || [];
  if (!routes.length) {
    root.append(element('div', 'empty-state', 'No event sources configured'));
    return;
  }
  for (const route of routes) {
    const row = element('div', 'workflow-producer-route');
    const copy = element('div', 'workflow-producer-route-copy');
    const url = route.kind === 'alertmanager' ? alertmanagerReceiverUrl(route) : undefined;
    const runtime = workflowProducerRuntime(route.id);
    const runtimeState = runtime?.lastError
      ? 'error'
      : runtime?.claimerId
        ? 'running'
        : runtime?.lastSuccessAt
          ? 'enabled'
          : 'planned';
    const details = route.kind === 'lark-document'
      ? [
          projectById(route.projectId)?.name || route.projectId,
          route.documentId,
          runtime?.lastRevisionId === undefined ? 'Awaiting baseline' : `Revision ${runtime.lastRevisionId}`,
          runtime?.lastError || (runtime?.nextPollAt ? `Next ${formatTime(runtime.nextPollAt, true)}` : ''),
        ].filter(Boolean).join(' / ')
      : `${projectById(route.projectId)?.name || route.projectId} / ${url}`;
    copy.append(
      element('strong', '', route.name),
      element('small', '', details),
    );
    const actions = element('div', 'workflow-producer-route-actions');
    const viewer = state.auth?.principal?.role === 'viewer';
    const copyButton = element('button', 'square-button', '⧉');
    copyButton.type = 'button';
    copyButton.title = 'Copy receiver URL';
    copyButton.setAttribute('aria-label', 'Copy receiver URL');
    copyButton.hidden = !url;
    if (url) {
      copyButton.addEventListener('click', () =>
        void copyText(url, 'Receiver URL copied').catch((error) =>
          showToast(error.message || 'Could not copy URL', 'error'),
        ),
      );
    }
    const toggle = element('button', 'text-button', route.enabled ? 'Disable' : 'Enable');
    toggle.type = 'button';
    toggle.disabled = viewer;
    toggle.addEventListener('click', () => void setWorkflowProducerEnabled(route, !route.enabled));
    const archive = element('button', 'danger-text-button', 'Remove');
    archive.type = 'button';
    archive.disabled = viewer;
    archive.addEventListener('click', () => void archiveWorkflowProducer(route));
    actions.append(copyButton, toggle, archive);
    row.append(
      copy,
      statePill(route.enabled ? runtimeState : 'disabled', route.enabled ? statusLabel(runtimeState) : 'Disabled'),
      actions,
    );
    root.append(row);
  }
  applyOperatorCapabilities();
}

async function saveWorkflowProducer(event) {
  event.preventDefault();
  const button = $('#save-workflow-producer');
  setButtonBusy(button, true, 'Adding', 'Add route');
  try {
    const data = await getJson('/v1/workflow-producers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: $('#workflow-producer-kind').value,
        workspaceId: currentWorkspaceId(),
        projectId: $('#workflow-producer-project').value,
        name: $('#workflow-producer-name').value.trim(),
        documentId: $('#workflow-producer-document-id').value.trim() || undefined,
        pollIntervalSeconds: Number($('#workflow-producer-poll-interval').value),
        enabled: $('#workflow-producer-enabled').checked,
      }),
    });
    state.workflows = data.workflows;
    $('#workflow-producer-name').value = '';
    $('#workflow-producer-document-id').value = '';
    renderWorkflows();
    showToast('Event source added');
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    setButtonBusy(button, false, 'Adding', 'Add route');
  }
}

async function setWorkflowProducerEnabled(route, enabled) {
  try {
    const data = await getJson('/v1/workflow-producers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...route, enabled }),
    });
    state.workflows = data.workflows;
    renderWorkflows();
    showToast(enabled ? 'Route enabled' : 'Route disabled');
  } catch (error) {
    showToast(error.message, 'error');
  }
}

async function archiveWorkflowProducer(route) {
  if (!window.confirm(`Remove ${route.name}?`)) return;
  try {
    const data = await getJson(`/v1/workflow-producers/${encodeURIComponent(route.id)}`, {
      method: 'DELETE',
    });
    state.workflows = data.workflows;
    renderWorkflows();
    showToast('Event source removed');
  } catch (error) {
    showToast(error.message, 'error');
  }
}

function workflowExecutions(workflowId) {
  return (state.workflows?.executions || []).filter(
    (execution) => execution.workflowId === workflowId,
  );
}

function fillWorkflowProjectOptions(selectedValue) {
  const select = $('#workflow-project');
  select.replaceChildren();
  for (const project of state.workspace?.projects || []) {
    const option = document.createElement('option');
    option.value = project.projectId;
    option.textContent = project.name;
    option.selected = projectMatches(project, selectedValue);
    select.append(option);
  }
}

function fillWorkflowDestination(force = false) {
  const externalId = $('#workflow-external-id');
  if (!force && externalId.value.trim()) return;
  const binding = preferredRoutineBinding(
    $('#workflow-project').value,
    $('#workflow-platform').value,
  );
  if (!binding) {
    if (force) externalId.value = '';
    return;
  }
  externalId.value =
    binding.platform === 'github' && !binding.externalId.includes('#')
      ? `${binding.externalId}#`
      : binding.externalId;
}

function defaultWorkflowSteps() {
  return [
    {
      id: 'collect',
      name: 'Collect context',
      instructions: '',
      publish: false,
    },
    {
      id: 'analyze',
      name: 'Analyze',
      instructions: '',
      dependsOn: ['collect'],
      publish: false,
    },
    {
      id: 'publish',
      name: 'Publish',
      instructions: '',
      dependsOn: ['analyze'],
      publish: true,
    },
  ];
}

function sequentialWorkflowNodes(nodes) {
  return nodes.every((node, index) => {
    const dependencies = node.dependsOn || [];
    return index === 0
      ? dependencies.length === 0
      : dependencies.length === 1 && dependencies[0] === nodes[index - 1].id;
  });
}

function nextWorkflowStepId() {
  const ids = new Set(state.workflowDraftSteps.map((step) => step.id));
  let index = state.workflowDraftSteps.length + 1;
  while (ids.has(`step-${index}`)) index += 1;
  return `step-${index}`;
}

function markWorkflowDirty() {
  state.workflowDirty = true;
  $('#workflow-save-state').textContent = 'Unsaved changes';
  $('#trigger-workflow').disabled = true;
}

function setWorkflowTriggerKind(kind, dirty = false) {
  state.workflowTriggerKind = kind === 'event' ? 'event' : 'manual';
  for (const button of $$('#workflow-trigger-kind button')) {
    button.classList.toggle(
      'active',
      button.dataset.workflowTrigger === state.workflowTriggerKind,
    );
  }
  const eventTrigger = state.workflowTriggerKind === 'event';
  $('#workflow-event-type-field').hidden = !eventTrigger;
  $('#workflow-trigger-label').textContent = eventTrigger
    ? $('#workflow-event-type').value.trim() || 'Event'
    : 'Manual';
  updateWorkflowProducerHint();
  if (dirty) markWorkflowDirty();
}

function moveWorkflowStep(index, offset) {
  const target = index + offset;
  if (target < 0 || target >= state.workflowDraftSteps.length) return;
  const [step] = state.workflowDraftSteps.splice(index, 1);
  state.workflowDraftSteps.splice(target, 0, step);
  renderWorkflowSteps();
  markWorkflowDirty();
}

function removeWorkflowStep(index) {
  if (state.workflowDraftSteps.length <= 1) return;
  state.workflowDraftSteps.splice(index, 1);
  renderWorkflowSteps();
  markWorkflowDirty();
}

function renderWorkflowSteps() {
  const root = $('#workflow-steps');
  root.replaceChildren();
  const advanced = state.workflowGraphMode === 'advanced';
  const dependencyIds = new Set(
    state.workflowDraftSteps.flatMap((step) => step.dependsOn || []),
  );
  $('#workflow-step-count').textContent = advanced
    ? `${state.workflowDraftSteps.length} graph nodes`
    : `${state.workflowDraftSteps.length} steps`;
  $('#add-workflow-step').hidden = advanced;

  state.workflowDraftSteps.forEach((step, index) => {
    const row = element('div', 'workflow-step-row');
    const marker = element('div', 'workflow-step-marker');
    marker.append(
      element('strong', '', String(index + 1)),
      element(
        'small',
        '',
        advanced
          ? step.publish ?? !dependencyIds.has(step.id)
            ? 'Publish'
            : 'Node'
          : index === state.workflowDraftSteps.length - 1
            ? 'Publish'
            : 'Agent',
      ),
    );

    const fields = element('div', 'workflow-step-fields');
    const nameLabel = element('label', 'field workflow-step-name');
    nameLabel.append(element('span', '', 'Step name'));
    const name = document.createElement('input');
    name.value = step.name || '';
    name.required = true;
    name.autocomplete = 'off';
    name.addEventListener('input', () => {
      step.name = name.value;
      markWorkflowDirty();
    });
    nameLabel.append(name);

    const instructionLabel = element('label', 'field workflow-step-instructions');
    instructionLabel.append(element('span', '', 'Instructions'));
    const instructions = document.createElement('textarea');
    instructions.rows = 3;
    instructions.required = true;
    instructions.spellcheck = true;
    instructions.placeholder = 'What should this agent produce?';
    instructions.value = step.instructions || '';
    instructions.addEventListener('input', () => {
      step.instructions = instructions.value;
      markWorkflowDirty();
    });
    instructionLabel.append(instructions);
    fields.append(nameLabel, instructionLabel);

    const actions = element('div', 'workflow-step-actions');
    for (const action of [
      { label: 'Move step up', symbol: '↑', disabled: index === 0, offset: -1 },
      {
        label: 'Move step down',
        symbol: '↓',
        disabled: index === state.workflowDraftSteps.length - 1,
        offset: 1,
      },
    ]) {
      const button = element('button', 'square-button workflow-step-button', action.symbol);
      button.type = 'button';
      button.title = action.label;
      button.setAttribute('aria-label', action.label);
      button.disabled = advanced || action.disabled;
      button.addEventListener('click', () => moveWorkflowStep(index, action.offset));
      actions.append(button);
    }
    const remove = element('button', 'square-button workflow-step-button remove', '×');
    remove.type = 'button';
    remove.title = 'Remove step';
    remove.setAttribute('aria-label', 'Remove step');
    remove.disabled = advanced || state.workflowDraftSteps.length <= 1;
    remove.addEventListener('click', () => removeWorkflowStep(index));
    actions.append(remove);

    row.append(marker, fields, actions);
    root.append(row);
  });
}

function workflowNodeLabel(execution, nodeId) {
  return (
    execution.workflow?.nodes?.find((node) => node.id === nodeId)?.name || nodeId
  );
}

function renderWorkflowExecutions(workflow) {
  const root = $('#workflow-executions');
  root.replaceChildren();
  const executions = workflow ? workflowExecutions(workflow.id) : [];
  $('#workflow-execution-count').textContent = `${executions.length} recorded`;
  if (!executions.length) {
    root.append(
      element(
        'div',
        'empty-state',
        workflow ? 'No executions yet' : 'Save the workflow to create executions',
      ),
    );
    return;
  }
  for (const execution of executions.slice(0, 20)) {
    const row = element('div', 'workflow-execution-row');
    const copy = element('div', 'workflow-execution-copy');
    copy.append(
      element(
        'strong',
        '',
        `${workflowTriggerLabel(execution.trigger)}${workflowProducerLabel(execution.trigger) ? ` / ${workflowProducerLabel(execution.trigger)}` : ''} / ${formatTime(execution.createdAt, true)}`,
      ),
      element(
        'small',
        '',
        execution.error || execution.summary || shortId(execution.id),
      ),
    );
    const nodes = element('div', 'workflow-node-statuses');
    for (const node of execution.nodes || []) {
      const nodeStatus = element('span', `workflow-node-status ${node.status}`);
      const workflowAttempt = (node.retryCount || 0) + 1;
      nodeStatus.title = `${statusLabel(node.status)}${
        workflowAttempt > 1 ? ` / attempt ${workflowAttempt}` : ''
      }`;
      nodeStatus.append(
        element('i'),
        document.createTextNode(
          `${workflowNodeLabel(execution, node.nodeId)}${
            workflowAttempt > 1 ? ` (${workflowAttempt})` : ''
          }`,
        ),
      );
      if (execution.status === 'failed' && node.status === 'failed') {
        const retry = element('button', 'workflow-node-retry', '↻');
        retry.type = 'button';
        retry.title = `Retry ${workflowNodeLabel(execution, node.nodeId)}`;
        retry.setAttribute('aria-label', retry.title);
        retry.addEventListener('click', () =>
          void retryWorkflowNode(execution.id, node.nodeId, retry),
        );
        nodeStatus.append(retry);
      }
      nodes.append(nodeStatus);
    }
    copy.append(nodes);
    row.append(
      statePill(execution.status),
      copy,
      element('span', 'workflow-execution-time', formatTime(execution.updatedAt, true)),
    );
    const actions = element('div', 'workflow-execution-controls');
    const latestRun = [...(execution.nodes || [])].reverse().find((node) => node.runId);
    if (latestRun) {
      const open = element('button', 'routine-run-link', 'Open run');
      open.type = 'button';
      open.addEventListener('click', () => void openRoutineRun(latestRun.runId));
      actions.append(open);
    } else {
      actions.append(element('span', 'workflow-execution-time', 'Not queued'));
    }
    if (execution.status === 'pending' || execution.status === 'running') {
      const cancel = element('button', 'square-button workflow-execution-control', '×');
      cancel.type = 'button';
      cancel.title = 'Cancel execution';
      cancel.setAttribute('aria-label', cancel.title);
      cancel.addEventListener('click', () =>
        void cancelWorkflowExecution(execution.id, cancel),
      );
      actions.append(cancel);
    }
    row.append(actions);
    root.append(row);
  }
}

async function cancelWorkflowExecution(executionId, button) {
  setButtonBusy(button, true, '…', '×');
  try {
    await getJson(
      `/v1/workflow-executions/${encodeURIComponent(executionId)}/cancel`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason: 'admin_console_cancelled' }),
      },
    );
    await refreshAll({ quiet: true });
    showToast('Workflow cancelled');
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    setButtonBusy(button, false, '…', '×');
  }
}

async function retryWorkflowNode(executionId, nodeId, button) {
  setButtonBusy(button, true, '…', '↻');
  try {
    await getJson(
      `/v1/workflow-executions/${encodeURIComponent(executionId)}/nodes/${encodeURIComponent(nodeId)}/retry`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason: 'admin_console_retried' }),
      },
    );
    await refreshAll({ quiet: true });
    showToast('Workflow node queued for retry');
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    setButtonBusy(button, false, '…', '↻');
  }
}

function renderWorkflowList() {
  const root = $('#workflow-list');
  root.replaceChildren();
  const workflows = state.workflows?.workflows || [];
  if (!workflows.length) {
    root.append(element('div', 'empty-state', 'No workflows configured'));
    return;
  }
  const queueByWorkflow = new Map(
    (state.workflows?.summary?.queues || []).map((queue) => [queue.workflowId, queue]),
  );
  for (const workflow of workflows) {
    const project = projectById(workflow.projectId);
    const queue = queueByWorkflow.get(workflow.id);
    const queueParts = [];
    if (queue?.activeExecutions) queueParts.push(`${queue.activeExecutions} active`);
    if (queue?.queuedNodes) queueParts.push(`${queue.queuedNodes} queued`);
    if (queue?.runningNodes) queueParts.push(`${queue.runningNodes} running`);
    if (queue?.failedExecutions) queueParts.push(`${queue.failedExecutions} failed`);
    const button = element('button', 'project-list-item');
    button.type = 'button';
    button.classList.toggle('active', workflow.id === state.selectedWorkflowId);
    button.append(
      element('strong', '', workflow.name),
      element(
        'span',
        '',
        `${workflow.enabled ? 'Enabled' : 'Disabled'} / ${project?.name || workflow.projectId} / ${workflowTriggerLabel(workflow.trigger)}${queueParts.length ? ` / ${queueParts.join(' / ')}` : ''}`,
      ),
    );
    button.addEventListener('click', () => selectWorkflow(workflow.id));
    root.append(button);
  }
}

function fillWorkflowForm(workflow) {
  const isNew = !workflow;
  const defaultProjectId = state.workspace?.projects?.[0]?.projectId || '';
  const projectId = workflow?.projectId || defaultProjectId;
  $('#workflow-editor-title').textContent = workflow?.name || 'New workflow';
  $('#workflow-state').textContent = isNew
    ? 'Draft'
    : workflow.enabled
      ? 'Enabled'
      : 'Disabled';
  $('#workflow-state').className = `state-pill ${isNew ? 'planned' : workflow.enabled ? 'enabled' : 'disabled'}`;
  $('#workflow-name').value = workflow?.name || '';
  $('#workflow-description').value = workflow?.description || '';
  $('#workflow-enabled').checked = workflow?.enabled ?? true;
  fillWorkflowProjectOptions(projectId);
  $('#workflow-event-type').value =
    workflow?.trigger?.kind === 'event' ? workflow.trigger.eventType : '';
  fillWorkflowEventCatalog();
  setWorkflowTriggerKind(workflow?.trigger?.kind || 'manual');
  $('#workflow-platform').value = workflow?.destination?.platform || 'lark';
  $('#workflow-external-id').value = workflow?.destination?.externalId || '';
  $('#workflow-visibility').value = workflow?.destination?.visibility || 'public';
  $('#workflow-thread-id').value = workflow?.destination?.threadId || '';
  if (isNew) fillWorkflowDestination();
  updateClientDestinationFields();
  const nodes = workflow?.nodes || defaultWorkflowSteps();
  state.workflowGraphMode = sequentialWorkflowNodes(nodes) ? 'sequential' : 'advanced';
  $('#workflow-destination-label').textContent =
    state.workflowGraphMode === 'advanced' ? 'Sink nodes' : 'Final step';
  state.workflowDraftSteps = nodes.map((node) => ({
    id: node.id,
    name: node.name || '',
    instructions: node.instructions || '',
    dependsOn: node.dependsOn ? [...node.dependsOn] : undefined,
    publish: node.publish,
  }));
  renderWorkflowSteps();
  $('#archive-workflow').hidden = isNew;
  $('#trigger-workflow').disabled = isNew;
  renderWorkflowExecutions(workflow);
  state.workflowDirty = false;
  $('#workflow-save-state').textContent = isNew
    ? 'New workflow'
    : `Version ${workflow.version}`;
}

function selectWorkflow(workflowId) {
  if (state.workflowDirty && !window.confirm('Discard unsaved workflow changes?')) return;
  state.selectedWorkflowId = workflowId;
  renderWorkflowList();
  fillWorkflowForm(workflowById(workflowId));
}

function newWorkflow() {
  if (state.workflowDirty && !window.confirm('Discard unsaved workflow changes?')) return;
  state.selectedWorkflowId = '__new__';
  renderWorkflowList();
  fillWorkflowForm(null);
  $('#workflow-name').focus();
}

function addWorkflowStep() {
  if (state.workflowGraphMode === 'advanced') return;
  state.workflowDraftSteps.push({
    id: nextWorkflowStepId(),
    name: '',
    instructions: '',
  });
  renderWorkflowSteps();
  markWorkflowDirty();
  $('#workflow-steps .workflow-step-row:last-child input')?.focus();
}

function workflowPayload() {
  const existing = workflowById(state.selectedWorkflowId);
  const name = $('#workflow-name').value.trim();
  const projectId = $('#workflow-project').value;
  const externalId = $('#workflow-external-id').value.trim();
  const eventType = $('#workflow-event-type').value.trim();
  if (!name || !projectId || !externalId) {
    throw new Error('Name, project, and channel ID are required');
  }
  if (
    $('#workflow-platform').value === 'github' &&
    !/^[^/#\s]+\/[^/#\s]+#[1-9]\d*$/.test(externalId)
  ) {
    throw new Error('GitHub destination must be owner/repo#issue');
  }
  if (state.workflowTriggerKind === 'event' && !eventType) {
    throw new Error('Event type is required');
  }
  if (!state.workflowDraftSteps.length) throw new Error('Add at least one step');
  for (const step of state.workflowDraftSteps) {
    if (!step.name.trim() || !step.instructions.trim()) {
      throw new Error('Every step needs a name and instructions');
    }
  }
  const sequential = state.workflowGraphMode === 'sequential';
  return {
    id: existing?.id,
    workspaceId: currentWorkspaceId(),
    projectId,
    name,
    description: $('#workflow-description').value.trim() || undefined,
    enabled: $('#workflow-enabled').checked,
    trigger:
      state.workflowTriggerKind === 'event'
        ? { kind: 'event', eventType }
        : { kind: 'manual' },
    nodes: state.workflowDraftSteps.map((step, index) => ({
      id: step.id,
      name: step.name.trim(),
      instructions: step.instructions.trim(),
      dependsOn: sequential
        ? index > 0
          ? [state.workflowDraftSteps[index - 1].id]
          : undefined
        : step.dependsOn,
      publish: sequential
        ? index === state.workflowDraftSteps.length - 1
        : step.publish,
    })),
    destination: {
      platform: $('#workflow-platform').value,
      externalId,
      channelId: externalId,
      threadId: $('#workflow-thread-id').value.trim() || undefined,
      visibility: $('#workflow-visibility').value,
      title: name,
    },
  };
}

async function saveWorkflow(event) {
  event.preventDefault();
  const button = $('#save-workflow');
  setButtonBusy(button, true, 'Saving', 'Save workflow');
  try {
    const data = await getJson('/v1/workflows', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(workflowPayload()),
    });
    state.workflows = data.workflows;
    state.selectedWorkflowId = data.workflow.id;
    state.workflowDirty = false;
    renderWorkflows();
    renderWorkspaceHeader();
    renderSummary();
    showToast('Workflow saved');
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    setButtonBusy(button, false, 'Saving', 'Save workflow');
  }
}

async function triggerWorkflow() {
  const workflow = workflowById(state.selectedWorkflowId);
  if (!workflow) return;
  const button = $('#trigger-workflow');
  setButtonBusy(button, true, 'Starting', 'Run now');
  try {
    const data = await getJson(
      `/v1/workflows/${encodeURIComponent(workflow.id)}/trigger`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      },
    );
    state.workflows = data.workflows;
    renderWorkflows();
    showToast(`Workflow accepted / ${statusLabel(data.execution.status)}`);
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    setButtonBusy(button, false, 'Starting', 'Run now');
  }
}

async function archiveWorkflow() {
  const workflow = workflowById(state.selectedWorkflowId);
  if (!workflow || !window.confirm(`Archive ${workflow.name}?`)) return;
  const button = $('#archive-workflow');
  setButtonBusy(button, true, 'Archiving', 'Archive');
  try {
    const data = await getJson(`/v1/workflows/${encodeURIComponent(workflow.id)}`, {
      method: 'DELETE',
    });
    state.workflows = data.workflows;
    state.selectedWorkflowId = state.workflows.workflows?.[0]?.id || '__new__';
    state.workflowDirty = false;
    renderWorkflows();
    renderWorkspaceHeader();
    showToast('Workflow archived');
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    setButtonBusy(button, false, 'Archiving', 'Archive');
  }
}

async function tickWorkflows() {
  const button = $('#tick-workflows');
  setButtonBusy(button, true, 'Ticking', 'Tick now');
  try {
    const data = await getJson('/v1/workflows/tick', { method: 'POST' });
    state.workflows = data.workflows;
    renderWorkflows();
    showToast(
      `Claimed ${data.result.claimed} / queued ${data.result.queued} / failed ${data.result.failed}`,
    );
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    setButtonBusy(button, false, 'Ticking', 'Tick now');
  }
}

function renderWorkflows() {
  const coordinator = state.workflows?.coordinator || {};
  const coordinatorLabel = !coordinator.enabled
    ? 'Disabled'
    : coordinator.mode === 'external'
      ? 'External'
      : coordinator.mode === 'manual'
        ? 'Manual'
        : 'Inline';
  $('#workflow-coordinator-state').textContent = coordinatorLabel;
  $('#workflow-coordinator-state').className = `state-pill ${coordinator.enabled ? 'enabled' : 'disabled'}`;
  const modeDetail = coordinator.mode === 'external'
    ? 'Independent coordinator'
    : coordinator.mode === 'manual'
      ? 'Manual ticks only'
      : 'Server coordinator';
  const interval = coordinator.tickIntervalMs
    ? `${Math.max(1, Math.round(coordinator.tickIntervalMs / 1000))}s poll`
    : 'on demand';
  $('#workflow-coordinator-detail').textContent = coordinator.lastTickAt
    ? `${modeDetail} / ${interval} / last ${formatTime(coordinator.lastTickAt, true)}`
      : `${modeDetail} / ${interval}`;
  renderWorkflowProducerRoutes();
  const available = state.workflows?.workflows || [];
  if (
    state.selectedWorkflowId !== '__new__' &&
    !workflowById(state.selectedWorkflowId)
  ) {
    state.selectedWorkflowId = available[0]?.id || '__new__';
  }
  renderWorkflowList();
  if (!state.workflowDirty) {
    fillWorkflowForm(workflowById(state.selectedWorkflowId));
  }
}

function runTitle(run) {
  if (run.metadata?.source === 'steering') {
    return `Follow-up: ${run.message?.text || run.summary?.split('\n')[0] || shortId(run.id)}`;
  }
  return (
    run.metadata?.workflowName ||
    run.metadata?.routineName ||
    run.title ||
    run.message?.text ||
    run.summary?.split('\n')[0] ||
    shortId(run.id)
  );
}

function runIsLive(run) {
  return ['queued', 'running', 'cancel_requested'].includes(run.status);
}

function runDuration(run) {
  const started = new Date(run.startedAt || run.createdAt).getTime();
  const ended = new Date(
    run.completedAt || run.failedAt || run.cancelledAt || run.updatedAt,
  ).getTime();
  return formatDuration(Math.max(0, ended - started));
}

function runMatchesActivityStatus(run) {
  if (!state.runFilter) return true;
  if (state.runFilter === 'live') return runIsLive(run);
  if (state.runFilter === 'failed') {
    return ['failed', 'cancelled'].includes(run.status);
  }
  return run.status === state.runFilter;
}

function activityRunsUrl({ limit = 50 } = {}) {
  const query = new URLSearchParams({
    workspaceId: currentWorkspaceId(),
    limit: String(state.activityQuery ? Math.max(limit, 100) : limit),
  });
  if (state.activityQuery) query.set('q', state.activityQuery);
  if (state.activityQuery && state.selectedActivityProjectId) {
    query.set('projectId', state.selectedActivityProjectId);
  }
  return `/v1/runs?${query.toString()}`;
}

function renderActivitySearch() {
  const input = $('#activity-query');
  if (document.activeElement !== input && input.value !== state.activityQuery) {
    input.value = state.activityQuery;
  }
  const meta = $('#activity-search-meta');
  if (!state.activityQuery) {
    meta.textContent = `Recent ${state.activityRuns.length} run${state.activityRuns.length === 1 ? '' : 's'}`;
    return;
  }
  meta.textContent = state.activitySearchTruncated
    ? `${state.activityRuns.length}+ matches`
    : `${state.activityRuns.length} match${state.activityRuns.length === 1 ? '' : 'es'}`;
}

async function refreshActivityRuns({ quiet = false } = {}) {
  const requestId = ++activitySearchRequest;
  if (!quiet) $('#activity-search-meta').textContent = 'Searching';
  try {
    const data = await getJson(activityRunsUrl());
    if (requestId !== activitySearchRequest) return;
    state.activityRuns = data.runs || [];
    state.activitySearchTruncated = Boolean(data.truncated);
    if (!state.activityRuns.some((run) => run.id === state.selectedRunId)) {
      state.selectedRunId = null;
      $('#run-detail').replaceChildren(element('div', 'empty-state', 'Select a run'));
    }
    renderActivity();
  } catch (error) {
    if (requestId !== activitySearchRequest) return;
    $('#activity-search-meta').textContent = 'Search failed';
    showToast(error.message, 'error');
  }
}

function filteredRuns() {
  return state.activityRuns
    .filter(
      (run) =>
        !state.selectedActivityProjectId ||
        run.projectId === state.selectedActivityProjectId,
    )
    .filter(runMatchesActivityStatus)
    .filter(
      (run) =>
        state.selectedActivityThreadId === '__all__' ||
        run.threadId === state.selectedActivityThreadId,
    );
}

function activityThreads() {
  const threads = new Map();
  for (const run of state.activityRuns
    .filter(
      (item) =>
        !state.selectedActivityProjectId ||
        item.projectId === state.selectedActivityProjectId,
    )
    .filter(runMatchesActivityStatus)) {
    const current = threads.get(run.threadId) || {
      id: run.threadId,
      title: run.thread?.title || run.title || statusLabel(run.platform),
      platform: run.platform,
      projectId: run.projectId,
      updatedAt: run.updatedAt,
      count: 0,
      live: 0,
      preview: run.message?.text || run.summary || '',
    };
    current.count += 1;
    if (runIsLive(run)) current.live += 1;
    if (run.updatedAt > current.updatedAt) {
      current.updatedAt = run.updatedAt;
      current.preview = run.message?.text || run.summary || current.preview;
    }
    threads.set(run.threadId, current);
  }
  return [...threads.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function renderActivityProjectSelect() {
  const select = $('#activity-project');
  select.replaceChildren();
  const all = document.createElement('option');
  all.value = '';
  all.textContent = 'All projects';
  select.append(all);
  for (const project of state.workspace?.projects || []) {
    const option = document.createElement('option');
    option.value = project.projectId;
    option.textContent = project.name;
    select.append(option);
  }
  select.value = state.selectedActivityProjectId;
}

function renderThreadList() {
  const root = $('#thread-list');
  const threads = activityThreads();
  if (
    state.selectedActivityThreadId !== '__all__' &&
    !threads.some((thread) => thread.id === state.selectedActivityThreadId)
  ) {
    state.selectedActivityThreadId = '__all__';
  }
  $('#thread-count').textContent = `${threads.length} thread${threads.length === 1 ? '' : 's'}`;
  root.replaceChildren();

  const all = element('button', 'thread-row');
  all.type = 'button';
  all.classList.toggle('active', state.selectedActivityThreadId === '__all__');
  const allCopy = element('div');
  allCopy.append(
    element('strong', '', 'All threads'),
    element('small', '', `${threads.reduce((sum, item) => sum + item.count, 0)} runs across this view`),
  );
  all.append(allCopy, element('span', 'thread-run-count', String(threads.length)));
  all.addEventListener('click', () => {
    state.selectedActivityThreadId = '__all__';
    renderActivity();
  });
  root.append(all);

  for (const thread of threads) {
    const row = element('button', 'thread-row');
    row.type = 'button';
    row.classList.toggle('active', thread.id === state.selectedActivityThreadId);
    const copy = element('div');
    const title = element('strong', '', thread.title);
    const preview = element('small', '', thread.preview || 'No message preview');
    copy.append(title, preview);
    const meta = element('div', 'thread-row-meta');
    meta.append(
      thread.live ? statePill('running', `${thread.live} live`) : element('span'),
      element('span', 'thread-run-count', String(thread.count)),
    );
    row.append(copy, meta);
    row.addEventListener('click', () => {
      state.selectedActivityThreadId = thread.id;
      const latest = state.activityRuns.find((run) => run.threadId === thread.id);
      state.selectedRunId = latest?.id || null;
      renderActivity();
      if (state.selectedRunId) void openRun(state.selectedRunId);
    });
    root.append(row);
  }
}

function renderRunTable() {
  const root = $('#run-table');
  root.replaceChildren();
  const items = filteredRuns();
  const steering = state.delivery?.summary?.steering || {};
  const waiting = (steering.pending || 0) + (steering.claimed || 0) + (steering.scheduled || 0);
  $('#steering-count').textContent = `${waiting} follow-up${waiting === 1 ? '' : 's'} waiting`;

  const selectedThread = activityThreads().find(
    (thread) => thread.id === state.selectedActivityThreadId,
  );
  $('#thread-context').textContent = selectedThread
    ? `${statusLabel(selectedThread.platform)} / ${projectById(selectedThread.projectId)?.name || selectedThread.projectId || 'General'}`
    : 'Workspace activity';
  $('#thread-title').textContent = selectedThread?.title || 'All threads';
  $('#thread-meta').textContent = selectedThread
    ? `${shortId(selectedThread.id)} / ${selectedThread.count} run${selectedThread.count === 1 ? '' : 's'} / updated ${formatTime(selectedThread.updatedAt, true)}`
    : `${items.length} run${items.length === 1 ? '' : 's'} in the current view`;

  if (!items.length) {
    root.append(element('div', 'empty-state', 'No runs in this view'));
    return;
  }
  for (const run of items) {
    const row = element('button', 'run-feed-row');
    row.type = 'button';
    row.classList.toggle('active', run.id === state.selectedRunId);
    const marker = element('span', `run-status-marker ${run.status}`);
    const copy = element('div', 'run-feed-copy');
    const head = element('div', 'run-feed-head');
    head.append(element('strong', '', runTitle(run)), statePill(run.status));
    const preview = element(
      'p',
      '',
      run.summary || run.lastError || run.message?.text || 'Waiting for output',
    );
    const meta = element('div', 'run-feed-meta');
    meta.append(
      element('span', '', projectById(run.projectId)?.name || run.projectId || 'General'),
      element('span', '', statusLabel(run.platform)),
      element('span', '', statusLabel(run.executorId || 'executor')),
      element('span', '', runDuration(run)),
      element('span', '', formatTime(run.updatedAt, true)),
    );
    copy.append(head, preview, meta);
    row.append(marker, copy);
    row.addEventListener('click', () => void openRun(run.id));
    root.append(row);
  }
}

function renderActivity() {
  renderToolApprovals();
  renderActivitySearch();
  renderActivityProjectSelect();
  renderThreadList();
  renderRunTable();
}

function assistantProjectId() {
  return (
    state.selectedAssistantProjectId ||
    state.workspace?.workspace?.workspace?.defaultProjectId ||
    state.workspace?.projects?.[0]?.projectId ||
    ''
  );
}

function renderAssistantProjectSelect() {
  const select = $('#assistant-project');
  select.replaceChildren();
  for (const project of state.workspace?.projects || []) {
    const option = document.createElement('option');
    option.value = project.projectId;
    option.textContent = project.name;
    select.append(option);
  }
  if (!projectById(state.selectedAssistantProjectId)) {
    state.selectedAssistantProjectId = assistantProjectId();
  }
  select.value = state.selectedAssistantProjectId || '';
}

function renderAssistantSessions() {
  const root = $('#assistant-session-list');
  root.replaceChildren();
  const sessions = state.assistantSessions.filter(
    (session) => session.projectId === assistantProjectId(),
  );
  $('#assistant-count').textContent = String(state.assistantSessions.length);
  if (!sessions.length) {
    root.append(element('div', 'assistant-empty compact', 'No conversations'));
    return;
  }
  for (const session of sessions) {
    const row = element('button', 'assistant-session-row');
    row.type = 'button';
    row.classList.toggle(
      'active',
      session.id === state.selectedAssistantSessionId,
    );
    const copy = element('div');
    copy.append(
      element('strong', '', session.title || 'New conversation'),
      element('small', '', session.preview || 'No messages yet'),
    );
    row.append(
      copy,
      session.activeRunId
        ? statePill(session.activeRunStatus || 'running')
        : element('span', 'assistant-session-time', formatTime(session.updatedAt, true)),
    );
    row.addEventListener('click', () => void openAssistantSession(session.id));
    root.append(row);
  }
}

function assistantLiveEventCopy(event) {
  const tool = event.metadata?.tool;
  const item = event.metadata?.item;
  if (tool) {
    const delegated = delegatedToolContext(tool.provider);
    return {
      title: delegated
        ? `${delegatedAgentLabel(delegated.agentId)} / ${tool.title || tool.name || 'Tool'}`
        : tool.title || tool.name || 'Tool',
      detail: [
        delegated
          ? 'Delegated tool'
          : tool.source === 'provider-native'
          ? `${statusLabel(tool.provider || 'provider')} native`
          : statusLabel(tool.grantKind || 'tool'),
        Number.isFinite(tool.durationMs) ? `${tool.durationMs} ms` : '',
      ].filter(Boolean).join(' / '),
      status: tool.status || (event.type === 'tool_result' ? 'succeeded' : 'running'),
    };
  }
  if (item) {
    return {
      title: item.label || event.message || 'Working',
      detail: item.detail || '',
      status: item.status || 'running',
    };
  }
  if (event.type === 'artifact') {
    return {
      title: event.metadata?.artifact?.title || 'Artifact ready',
      detail: statusLabel(event.metadata?.artifact?.kind || 'artifact'),
      status: 'done',
    };
  }
  if (event.type === 'memory_retrieval') {
    return {
      title: 'Memory selected',
      detail: `${event.metadata?.selectedLines || 0} relevant lines`,
      status: 'done',
    };
  }
  if (event.type === 'delegation') {
    return {
      title: delegatedAgentLabel(event.metadata?.agentId),
      detail: [
        statusLabel(event.metadata?.executorId || 'agent'),
        delegationUsageCopy(event.metadata?.usage),
      ].filter(Boolean).join(' / '),
      status: event.metadata?.status || 'running',
    };
  }
  return null;
}

function renderAssistantLiveTrace() {
  const root = $('#assistant-live-trace');
  root.replaceChildren();
  const rows = state.assistantLiveEvents
    .map(assistantLiveEventCopy)
    .filter(Boolean)
    .slice(-6);
  root.hidden = rows.length === 0;
  for (const row of rows) {
    const item = element('div', `assistant-live-row ${row.status}`);
    item.append(
      document.createElement('i'),
      element('strong', '', row.title),
      element('span', '', row.detail || statusLabel(row.status)),
    );
    root.append(item);
  }
}

function assistantMarkdownBody(text) {
  const body = element('div', 'assistant-message-body markdown-body');
  const parsed = marked.parse(String(text || ''), {
    async: false,
    breaks: true,
    gfm: true,
  });
  body.innerHTML = DOMPurify.sanitize(parsed, {
    ALLOWED_TAGS: [
      'a', 'blockquote', 'br', 'code', 'del', 'em', 'h1', 'h2', 'h3',
      'h4', 'h5', 'h6', 'hr', 'li', 'ol', 'p', 'pre', 'strong', 'table',
      'tbody', 'td', 'th', 'thead', 'tr', 'ul',
    ],
    ALLOWED_ATTR: ['align', 'href', 'start', 'title'],
    ALLOW_DATA_ATTR: false,
  });
  for (const link of body.querySelectorAll('a')) {
    const href = link.getAttribute('href') || '';
    let url;
    try {
      url = new URL(href, location.origin);
    } catch {
      link.removeAttribute('href');
      continue;
    }
    if (!['http:', 'https:'].includes(url.protocol)) {
      link.removeAttribute('href');
      continue;
    }
    if (url.origin !== location.origin) {
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
    }
  }
  return body;
}

function assistantTraceEvents(runId) {
  return (state.assistantTimeline || []).filter(
    (event) =>
      event.runId === runId &&
      ['progress', 'tool_call', 'tool_result', 'tool_approval', 'artifact', 'memory_retrieval', 'delegation']
        .includes(event.type),
  );
}

function delegatedToolContext(provider) {
  const match = /^delegated:([^:]+):([^:]+):(.+)$/u.exec(String(provider || ''));
  if (!match) return null;
  return { agentId: match[1], invocationId: match[2], provider: match[3] };
}

function delegatedAgentLabel(agentId) {
  return (
    (state.delegatedAgents?.agents || []).find((agent) => agent.id === agentId)?.name ||
    statusLabel(String(agentId || 'Agent').replaceAll('-', ' '))
  );
}

function delegationUsageCopy(usage) {
  if (!usage) return '';
  const tokens = Number(usage.inputTokens || 0) + Number(usage.outputTokens || 0);
  return [
    tokens ? `${tokens.toLocaleString()} tokens` : '',
    Number.isFinite(usage.costUsd) ? `$${Number(usage.costUsd).toFixed(4)}` : '',
  ].filter(Boolean).join(' / ');
}

function delegatedTraceGroups(events) {
  const groups = new Map();
  const ensure = (invocationId, fallback = {}) => {
    const current = groups.get(invocationId) || {
      invocationId,
      agentId: fallback.agentId,
      status: 'running',
      sequence: Number.POSITIVE_INFINITY,
      tools: new Map(),
    };
    if (fallback.agentId && !current.agentId) current.agentId = fallback.agentId;
    groups.set(invocationId, current);
    return current;
  };
  for (const event of events) {
    if (event.type !== 'delegation') continue;
    const metadata = event.metadata || {};
    const invocationId = metadata.invocationId || event.id;
    const group = ensure(invocationId, metadata);
    group.agentId = metadata.agentId || group.agentId;
    group.executorId = metadata.executorId || group.executorId;
    group.status = metadata.status || group.status;
    group.taskPreview = metadata.taskPreview || group.taskPreview;
    group.summaryPreview = metadata.summaryPreview || group.summaryPreview;
    group.usage = metadata.usage || group.usage;
    group.sequence = Math.min(group.sequence, event.sequence);
    if (metadata.status === 'running') group.startedAt = event.at;
    if (metadata.status === 'completed' || metadata.status === 'failed') {
      group.endedAt = event.at;
    }
  }
  for (const event of events) {
    if (!['tool_call', 'tool_result'].includes(event.type)) continue;
    const call = event.metadata?.call || event.metadata?.tool || {};
    const delegated = delegatedToolContext(call.provider);
    if (!delegated) continue;
    const group = ensure(delegated.invocationId, delegated);
    group.sequence = Math.min(group.sequence, event.sequence);
    const key = call.id || event.id;
    const pair = group.tools.get(key) || {};
    if (event.type === 'tool_call') pair.started = event;
    if (event.type === 'tool_result') pair.result = event;
    group.tools.set(key, pair);
  }
  return [...groups.values()].sort((left, right) => left.sequence - right.sequence);
}

function assistantToolTraceCopy(event) {
  const tool = event.metadata?.tool || {};
  return {
    title: tool.title || tool.name || 'Tool',
    detail: [
      tool.source === 'provider-native'
        ? `${statusLabel(delegatedToolContext(tool.provider)?.provider || tool.provider || 'provider')} native`
        : statusLabel(tool.grantKind || 'tool'),
      statusLabel(tool.risk || 'read'),
      Number.isFinite(tool.durationMs) ? `${tool.durationMs} ms` : '',
    ].filter(Boolean).join(' / '),
    status: tool.status || 'recorded',
    sequence: event.sequence,
  };
}

function appendAssistantTraceRow(root, row, className = '') {
  const item = element('div', `assistant-run-trace-row ${row.status} ${className}`.trim());
  item.append(
    document.createElement('i'),
    element('strong', '', row.title),
    element('span', '', row.detail || statusLabel(row.status)),
  );
  root.append(item);
}

function assistantRunTrace(runId, expanded = false) {
  const events = assistantTraceEvents(runId);
  if (!events.length) return null;
  const progress = new Map();
  const tools = new Map();
  const evidence = [];
  const delegations = delegatedTraceGroups(events);
  for (const event of events) {
    if (event.type === 'progress') {
      const item = event.metadata?.item || {};
      progress.set(item.id || event.id, {
        title: item.label || event.message || 'Step',
        detail: '',
        status: item.status || 'running',
        sequence: event.sequence,
      });
    } else if (
      event.type === 'tool_call' ||
      event.type === 'tool_result' ||
      event.type === 'tool_approval'
    ) {
      const tool = event.metadata?.tool || {};
      if (!delegatedToolContext(tool.provider) && tool.name !== 'agent_invoke') {
        tools.set(tool.id || event.id, assistantToolTraceCopy(event));
      }
    } else if (event.type !== 'delegation') {
      const copy = assistantLiveEventCopy(event);
      if (copy) evidence.push({ ...copy, sequence: event.sequence });
    }
  }
  const rows = [
    ...progress.values(),
    ...tools.values(),
    ...evidence,
    ...delegations.map((delegation) => ({ ...delegation, kind: 'delegation' })),
  ]
    .sort((a, b) => a.sequence - b.sequence);
  const details = element('details', 'assistant-run-trace');
  details.open = expanded;
  const summary = document.createElement('summary');
  const label = element('strong', '', 'Run trace');
  const counts = [
    progress.size ? `${progress.size} step${progress.size === 1 ? '' : 's'}` : '',
    delegations.length
      ? `${delegations.length} agent${delegations.length === 1 ? '' : 's'}`
      : '',
    tools.size || delegations.some((delegation) => delegation.tools.size)
      ? `${tools.size + delegations.reduce((total, delegation) => total + delegation.tools.size, 0)} tools`
      : '',
    evidence.length ? `${evidence.length} event${evidence.length === 1 ? '' : 's'}` : '',
  ].filter(Boolean).join(' / ');
  summary.append(label, element('span', '', counts));
  details.append(summary);
  const list = element('div', 'assistant-run-trace-list');
  for (const row of rows) {
    if (row.kind !== 'delegation') {
      appendAssistantTraceRow(list, row);
      continue;
    }
    const agent = element('div', `assistant-agent-trace ${row.status}`);
    appendAssistantTraceRow(
      agent,
      {
        title: delegatedAgentLabel(row.agentId),
        detail: [
          statusLabel(row.status),
          statusLabel(row.executorId || 'agent'),
          delegationUsageCopy(row.usage),
        ].filter(Boolean).join(' / '),
        status: row.status,
      },
      'agent',
    );
    const preview = row.summaryPreview || row.taskPreview;
    if (preview) agent.append(element('p', 'assistant-agent-preview', preview));
    if (row.tools.size) {
      const childTools = element('div', 'assistant-agent-tools');
      for (const pair of row.tools.values()) {
        appendAssistantTraceRow(
          childTools,
          assistantToolTraceCopy(pair.result || pair.started),
          'child',
        );
      }
      agent.append(childTools);
    }
    list.append(agent);
  }
  details.append(list);
  return details;
}

function renderAssistantConversation() {
  renderAssistantProjectSelect();
  renderAssistantSessions();
  const snapshot = state.assistantSnapshot;
  const root = $('#assistant-messages');
  root.replaceChildren();
  if (!snapshot?.session) {
    $('#assistant-title').textContent = 'Select a conversation';
    $('#assistant-route').textContent = 'Workspace assistant';
    $('#assistant-state').className = 'state-pill';
    $('#assistant-state').textContent = 'Idle';
    $('#assistant-stop').hidden = true;
    renderAssistantLiveTrace();
    root.append(element('div', 'assistant-empty', 'Start a project conversation'));
    return;
  }
  const session = snapshot.session;
  $('#assistant-title').textContent = session.title;
  $('#assistant-route').textContent = `${projectById(session.projectId)?.name || session.projectId} / private web thread`;
  $('#assistant-state').className = `state-pill ${session.activeRunStatus || 'ready'}`;
  $('#assistant-state').textContent = session.activeRunStatus
    ? statusLabel(session.activeRunStatus)
    : 'Ready';
  $('#assistant-stop').hidden = !session.activeRunId;
  $('#assistant-stop').dataset.runId = session.activeRunId || '';
  renderAssistantLiveTrace();
  const entries = snapshot.transcript?.entries || [];
  if (!entries.length) {
    root.append(element('div', 'assistant-empty', 'Send the first message'));
  }
  for (const entry of entries) {
    const item = element('article', `assistant-message ${entry.role}`);
    const meta = element('div', 'assistant-message-meta');
    meta.append(
      element('strong', '', entry.role === 'assistant' ? 'MaxTag' : entry.actor?.displayName || 'You'),
      element('span', '', formatTime(entry.at, true)),
    );
    item.append(
      meta,
      entry.role === 'assistant'
        ? assistantMarkdownBody(entry.text)
        : element('div', 'assistant-message-body', entry.text),
    );
    if (entry.role === 'assistant' && entry.runId) {
      const trace = assistantRunTrace(entry.runId);
      if (trace) item.append(trace);
    }
    const artifacts = (snapshot.artifacts || []).filter(
      (artifact) => artifact.runId === entry.runId,
    );
    if (artifacts.length) {
      const artifactList = element('div', 'assistant-artifacts');
      for (const artifact of artifacts) {
        const link = element('a', '', artifact.title || artifact.filename || 'Artifact');
        link.href = `/v1/runs/${encodeURIComponent(artifact.runId)}/artifacts/${encodeURIComponent(artifact.id)}`;
        artifactList.append(link);
      }
      item.append(artifactList);
    }
    root.append(item);
  }
  if (session.activeRunId) {
    const draft = state.assistantDrafts[session.activeRunId] || '';
    const pending = element('article', 'assistant-message assistant pending');
    pending.append(
      element('div', 'assistant-message-meta', 'MaxTag'),
      draft
        ? assistantMarkdownBody(draft)
        : element('div', 'assistant-message-body', 'Working...'),
    );
    const activeTrace = assistantRunTrace(session.activeRunId, true);
    if (activeTrace) pending.append(activeTrace);
    root.append(pending);
  }
  requestAnimationFrame(() => {
    root.scrollTop = root.scrollHeight;
  });
}

function closeAssistantStream() {
  state.assistantStream?.close();
  state.assistantStream = null;
  state.assistantStreamSessionId = null;
}

function scheduleAssistantSnapshotRefresh(sessionId) {
  clearTimeout(scheduleAssistantSnapshotRefresh.timer);
  scheduleAssistantSnapshotRefresh.timer = setTimeout(() => {
    if (state.selectedAssistantSessionId === sessionId) {
      void openAssistantSession(sessionId, { quiet: true, connect: false });
    }
  }, 80);
}

function applyAssistantRunEvent(sessionId, event) {
  const cursor = Number(event.sequence || 0);
  state.assistantStreamCursors[sessionId] = Math.max(
    state.assistantStreamCursors[sessionId] || 0,
    cursor,
  );
  state.assistantTimeline = [
    ...state.assistantTimeline.filter((candidate) => candidate.id !== event.id),
    event,
  ].sort((a, b) => a.sequence - b.sequence).slice(-2_000);
  if (event.type === 'text_delta') {
    state.assistantDrafts[event.runId] =
      (state.assistantDrafts[event.runId] || '') + (event.message || '');
  } else if (
    ['progress', 'tool_call', 'tool_result', 'tool_approval', 'artifact', 'memory_retrieval']
      .includes(event.type)
  ) {
    state.assistantLiveEvents = [
      ...state.assistantLiveEvents.filter((candidate) => candidate.id !== event.id),
      event,
    ].slice(-50);
  }
  const terminal = ['completed', 'failed', 'cancelled'].includes(event.type);
  if (state.assistantSnapshot?.session && !terminal) {
    state.assistantSnapshot.session.activeRunId = event.runId;
    state.assistantSnapshot.session.activeRunStatus = event.runStatus || 'running';
  }
  if (terminal) {
    delete state.assistantDrafts[event.runId];
    state.assistantLiveEvents = state.assistantLiveEvents.filter(
      (candidate) => candidate.runId !== event.runId,
    );
    $('#assistant-composer-state').textContent = 'Live';
    scheduleAssistantSnapshotRefresh(sessionId);
  }
  renderAssistantConversation();
}

function connectAssistantStream(sessionId) {
  if (
    state.assistantStream &&
    state.assistantStreamSessionId === sessionId
  ) {
    if (state.assistantStream.readyState === EventSource.OPEN) {
      $('#assistant-composer-state').textContent = 'Live';
    }
    return;
  }
  closeAssistantStream();
  state.assistantLiveEvents = [];
  const cursor = state.assistantStreamCursors[sessionId] || 0;
  const source = new EventSource(
    `/v1/assistant/sessions/${encodeURIComponent(sessionId)}/events?cursor=${cursor}`,
  );
  state.assistantStream = source;
  state.assistantStreamSessionId = sessionId;
  source.addEventListener('open', () => {
    if (state.assistantStream === source) {
      $('#assistant-composer-state').textContent = 'Live';
    }
  });
  source.addEventListener('run_event', (message) => {
    if (state.assistantStream !== source) return;
    try {
      const event = JSON.parse(message.data).event;
      applyAssistantRunEvent(sessionId, event);
    } catch {
      $('#assistant-composer-state').textContent = 'Stream data unavailable';
    }
  });
  source.addEventListener('stream_error', () => {
    if (state.assistantStream === source) {
      $('#assistant-composer-state').textContent = 'Reconnecting';
    }
  });
  source.addEventListener('error', () => {
    if (state.assistantStream === source) {
      $('#assistant-composer-state').textContent = 'Reconnecting';
    }
  });
}

function renderAssistantAttachments() {
  const root = $('#assistant-attachment-list');
  root.replaceChildren();
  for (const [index, file] of state.assistantFiles.entries()) {
    const item = element('span', 'assistant-attachment');
    item.append(
      element('span', '', file.name),
      element('span', '', `${Math.max(1, Math.ceil(file.size / 1024))} KB`),
    );
    const remove = element('button', '', 'x');
    remove.type = 'button';
    remove.setAttribute('aria-label', `Remove ${file.name}`);
    remove.addEventListener('click', () => {
      state.assistantFiles.splice(index, 1);
      renderAssistantAttachments();
    });
    item.append(remove);
    root.append(item);
  }
}

function fileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => {
      const value = String(reader.result || '');
      resolve(value.slice(value.indexOf(',') + 1));
    });
    reader.addEventListener('error', () => reject(reader.error));
    reader.readAsDataURL(file);
  });
}

async function refreshAssistant({ quiet = false } = {}) {
  if (!state.workspace) return;
  try {
    const workspaceId = encodeURIComponent(currentWorkspaceId());
    const data = await getJson(`/v1/assistant/sessions?workspaceId=${workspaceId}`);
    state.assistantSessions = data.sessions || [];
    const selected =
      state.assistantSessions.find(
        (session) => session.id === state.selectedAssistantSessionId,
      ) ||
      state.assistantSessions.find(
        (session) => session.projectId === assistantProjectId(),
      );
    if (selected) {
      await openAssistantSession(selected.id, { quiet: true });
      return;
    }
    closeAssistantStream();
    state.assistantLiveEvents = [];
    state.assistantDrafts = {};
    state.assistantSnapshot = null;
    renderAssistantConversation();
  } catch (error) {
    if (!quiet) showToast(error.message, 'error');
  }
}

async function openAssistantSession(id, { quiet = false, connect = true } = {}) {
  state.selectedAssistantSessionId = id;
  try {
    state.assistantSnapshot = await getJson(
      `/v1/assistant/sessions/${encodeURIComponent(id)}`,
    );
    state.assistantTimeline = state.assistantSnapshot.timeline || [];
    state.assistantDrafts = state.assistantSnapshot.drafts || {};
    state.assistantStreamCursors[id] = state.assistantSnapshot.eventCursor || 0;
    state.assistantSessions = state.assistantSessions.map((session) =>
      session.id === id ? state.assistantSnapshot.session : session,
    );
    state.selectedAssistantProjectId = state.assistantSnapshot.session.projectId;
    renderAssistantConversation();
    if (connect && !$('#view-assistant').hidden) connectAssistantStream(id);
  } catch (error) {
    if (!quiet) showToast(error.message, 'error');
  }
}

async function createAssistantSession() {
  const projectId = assistantProjectId();
  if (!projectId) return;
  const data = await getJson('/v1/assistant/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      workspaceId: currentWorkspaceId(),
      projectId,
    }),
  });
  state.selectedAssistantSessionId = data.session.id;
  state.assistantSnapshot = data;
  const workspaceId = encodeURIComponent(currentWorkspaceId());
  const sessions = await getJson(
    `/v1/assistant/sessions?workspaceId=${workspaceId}`,
  );
  state.assistantSessions = sessions.sessions || [];
  renderAssistantConversation();
  if (!$('#view-assistant').hidden) connectAssistantStream(data.session.id);
  $('#assistant-prompt').focus();
}

async function sendAssistantMessage(event) {
  event.preventDefault();
  const text = $('#assistant-prompt').value.trim();
  if (!text && !state.assistantFiles.length) return;
  if (!state.selectedAssistantSessionId) await createAssistantSession();
  const sessionId = state.selectedAssistantSessionId;
  if (!sessionId) return;
  const button = $('#assistant-send');
  setButtonBusy(button, true, 'Sending', 'Send');
  $('#assistant-composer-state').textContent = 'Queueing message';
  try {
    const attachments = await Promise.all(
      state.assistantFiles.map(async (file) => ({
        id: crypto.randomUUID(),
        kind: file.type.startsWith('image/') ? 'image' : 'file',
        name: file.name,
        mimeType: file.type || 'application/octet-stream',
        sizeBytes: file.size,
        contentBase64: await fileAsBase64(file),
      })),
    );
    await getJson(
      `/v1/assistant/sessions/${encodeURIComponent(sessionId)}/messages`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, attachments }),
      },
    );
    $('#assistant-prompt').value = '';
    state.assistantFiles = [];
    renderAssistantAttachments();
    $('#assistant-composer-state').textContent = 'Message queued';
    const workspaceId = encodeURIComponent(currentWorkspaceId());
    const sessions = await getJson(
      `/v1/assistant/sessions?workspaceId=${workspaceId}`,
    );
    state.assistantSessions = sessions.sessions || [];
    await openAssistantSession(sessionId, { quiet: true });
  } catch (error) {
    $('#assistant-composer-state').textContent = error.message;
  } finally {
    setButtonBusy(button, false, 'Sending', 'Send');
  }
}

function toolApprovalTarget(approval) {
  const summary = approval.argumentSummary || {};
  if (summary.owner && summary.repo) return `${summary.owner}/${summary.repo}`;
  return (
    summary.documentId ||
    summary.appToken ||
    projectById(approval.projectId)?.name ||
    approval.projectId ||
    'Workspace'
  );
}

function renderToolApprovals() {
  const root = $('#tool-approval-list');
  const active = (state.toolApprovals || []).filter((approval) =>
    ['pending', 'approved', 'executing'].includes(approval.status),
  );
  $('#tool-approval-count').textContent = `${active.length} pending`;
  root.replaceChildren();
  if (!active.length) {
    root.append(
      element('div', 'tool-approval-empty', 'No write operations awaiting review'),
    );
    return;
  }
  for (const approval of active) {
    const row = element('article', 'tool-approval-row');
    const copy = element('div', 'tool-approval-copy');
    const head = element('div', 'tool-approval-row-head');
    head.append(
      element('strong', '', approval.title || statusLabel(approval.toolName)),
      statePill(approval.status),
    );
    const meta = element('div', 'tool-approval-meta');
    meta.append(
      element('span', '', toolApprovalTarget(approval)),
      element('span', '', approval.toolName),
      element('span', '', `Expires ${formatTime(approval.expiresAt, true)}`),
      element('span', '', `digest ${(approval.argumentDigest || '').slice(0, 12)}`),
    );
    const details = element('details', 'tool-approval-arguments');
    const summary = element('summary', '', 'Review exact arguments');
    const exact = element('pre', '', JSON.stringify(approval.arguments || {}, null, 2));
    details.append(summary, exact);
    copy.append(head, meta, details);

    const actions = element('div', 'tool-approval-actions');
    if (approval.status === 'pending') {
      const reject = element('button', 'secondary-button', 'Reject');
      reject.type = 'button';
      reject.disabled = state.auth?.principal?.role === 'viewer';
      reject.addEventListener('click', () =>
        void decideToolApproval(approval.id, 'reject', reject),
      );
      const approve = element('button', 'primary-button', 'Approve and run');
      approve.type = 'button';
      approve.disabled = state.auth?.principal?.role === 'viewer';
      approve.addEventListener('click', () =>
        void decideToolApproval(approval.id, 'approve', approve),
      );
      actions.append(reject, approve);
    } else {
      actions.append(element('span', 'activity-status', 'Execution in progress'));
    }
    row.append(copy, actions);
    root.append(row);
  }
}

async function decideToolApproval(id, action, button) {
  const labels =
    action === 'approve'
      ? { busy: 'Running', idle: 'Approve and run' }
      : { busy: 'Rejecting', idle: 'Reject' };
  setButtonBusy(button, true, labels.busy, labels.idle);
  try {
    const data = await getJson(
      `/v1/tool-approvals/${encodeURIComponent(id)}/${action}`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
    );
    const decided = data.approval;
    state.toolApprovals = state.toolApprovals.map((approval) =>
      approval.id === id ? decided : approval,
    );
    renderToolApprovals();
    showToast(
      decided.status === 'succeeded'
        ? 'Approved operation completed'
        : decided.status === 'rejected'
          ? 'Operation rejected'
          : `Operation ${statusLabel(decided.status).toLowerCase()}`,
      decided.status === 'failed' ? 'error' : 'default',
    );
    await refreshAll({ quiet: true });
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    if (document.contains(button)) {
      setButtonBusy(button, false, labels.busy, labels.idle);
    }
  }
}

async function openRun(runId) {
  state.selectedRunId = runId;
  renderActivity();
  const detail = $('#run-detail');
  detail.replaceChildren(element('div', 'empty-state', 'Loading run'));
  try {
    const data = await getJson(`/v1/runs/${encodeURIComponent(runId)}/events?limit=100`);
    renderRunDetail(
      data.run,
      data.events || [],
      data.steering || [],
      data.sessions || [],
      data.artifacts || [],
      data.usage,
      data.deliveries || {},
      data.threadRuns || [],
    );
  } catch (error) {
    detail.replaceChildren(element('div', 'empty-state', error.message));
  }
}

function runContextItem(label, value, detail) {
  const item = element('div', 'run-context-item');
  item.append(
    element('span', '', label),
    element('strong', '', value),
    element('small', '', detail),
  );
  return item;
}

function activityToolRow(event, className = '') {
  const call = event.metadata?.call || {};
  const delegated = delegatedToolContext(call.provider);
  const row = element('div', `run-tool-row ${className}`.trim());
  const copy = element('div');
  const argumentSummary = Object.entries(call.arguments || {})
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(' / ');
  copy.append(
    element('strong', '', call.title || call.name || event.message || 'Tool call'),
    element(
      'small',
      '',
      [
        delegated
          ? statusLabel(delegated.provider)
          : call.source === 'provider-native'
            ? `${statusLabel(call.provider || 'provider')} native`
            : call.source
              ? statusLabel(call.source)
              : '',
        statusLabel(call.grantKind),
        statusLabel(call.risk),
        Number.isFinite(call.durationMs) ? `${call.durationMs} ms` : '',
        argumentSummary,
      ]
        .filter(Boolean)
        .join(' / '),
    ),
  );
  if (call.resultPreview || call.error) {
    copy.append(element('p', 'run-tool-preview', call.resultPreview || call.error));
  }
  if (call.resultUrl) {
    try {
      const resultUrl = new URL(call.resultUrl);
      if (resultUrl.protocol === 'https:' && !resultUrl.username && !resultUrl.password) {
        const link = element('a', 'run-tool-result-link', '打开外部结果');
        link.href = resultUrl.toString();
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        copy.append(link);
      }
    } catch {
      // Ignore malformed historical result links.
    }
  }
  row.append(copy, statePill(call.status || 'running'));
  return row;
}

function renderRunDetail(
  run,
  events,
  steering = [],
  sessions = [],
  artifacts = [],
  usage,
  deliveries = {},
  threadRuns = [],
) {
  const detail = $('#run-detail');
  detail.replaceChildren();
  const head = element('div', 'run-detail-head');
  const copy = element('div');
  copy.append(
    element('strong', '', runTitle(run)),
    element(
      'small',
      '',
      `${shortId(run.id)} / ${run.executorId || 'executor'} / ${run.workerId || 'unclaimed'}`,
    ),
  );
  head.append(copy, statePill(run.status));
  detail.append(head);

  const textOutput = events
    .filter((event) => event.type === 'text_delta')
    .map((event) => event.message || '')
    .join('');
  const exchange = element('div', 'run-exchange');
  const prompt = element('section', 'run-message prompt');
  prompt.append(
    element('span', 'run-message-role', run.message?.actor?.displayName || 'Requester'),
    element('div', '', run.message?.text || 'No message body recorded'),
  );
  const answer = element('section', 'run-message answer');
  answer.append(
    element('span', 'run-message-role', statusLabel(run.executorId || 'Agent')),
    element(
      'div',
      '',
      run.summary || textOutput || run.lastError || (runIsLive(run) ? 'Working...' : 'No output recorded'),
    ),
  );
  exchange.append(prompt, answer);
  detail.append(exchange);

  const transcriptEvent = [...events]
    .reverse()
    .find((event) => event.type === 'transcript_loaded');
  const transcript = transcriptEvent?.metadata || {};
  const session =
    sessions.find(
      (item) =>
        run.metadata?.providerSessionId &&
        item.sessionId === run.metadata.providerSessionId,
    ) ||
    sessions.find(
      (item) =>
        item.status === 'active' &&
        (!run.executorId || item.providerId === run.executorId),
    ) ||
    sessions.find((item) => !run.executorId || item.providerId === run.executorId);
  const providerSessionId = run.metadata?.providerSessionId || session?.sessionId;
  const contextStrip = element('div', 'run-context-strip');
  contextStrip.append(
    runContextItem(
      'Thread context',
      transcriptEvent
        ? `${transcript.loadedEntries || 0} / ${transcript.totalEntries || 0} entries`
        : 'Not loaded',
      transcript.omittedEntries
        ? `${transcript.omittedEntries} older entries omitted`
        : transcriptEvent
          ? transcript.truncated
            ? 'Context budget applied'
            : 'Full durable history window'
          : 'No context event recorded',
    ),
    runContextItem(
      'Provider session',
      providerSessionId
        ? `${statusLabel(session?.providerId || run.executorId)} / ${statusLabel(session?.status || 'active')}`
        : 'Transcript fallback',
      providerSessionId
        ? `${shortId(providerSessionId)}${run.metadata?.providerSessionResumed ? ' / resumed' : ''}`
        : 'No local provider state required',
    ),
    runContextItem(
      'Follow-ups',
      run.metadata?.steeringMode
        ? statusLabel(run.metadata.steeringMode)
        : 'Pending mode',
      `${steering.length} shared-thread follow-up${steering.length === 1 ? '' : 's'}`,
    ),
    runContextItem(
      'Usage',
      usage
        ? Number.isFinite(usage.metadata?.inputTokens) ||
          Number.isFinite(usage.metadata?.outputTokens)
          ? `${Number(usage.metadata?.inputTokens || 0).toLocaleString()} in / ${Number(usage.metadata?.outputTokens || 0).toLocaleString()} out`
          : 'Tokens not reported'
        : 'Not reported',
      `${usage ? `${usage.runs} run / $${Number(usage.costUsd || 0).toFixed(4)} / ` : ''}${runDuration(run)} / ${threadRuns.length || 1} thread run${(threadRuns.length || 1) === 1 ? '' : 's'}`,
    ),
  );
  detail.append(contextStrip);

  const inputs = run.message?.attachments || [];
  if (inputs.length || artifacts.length) {
    const files = element('div', 'run-files');
    files.append(element('h3', '', 'Files'));
    for (const attachment of inputs) {
      const row = element('div', 'run-file-row');
      const copy = element('div');
      copy.append(
        element('strong', '', attachment.name || statusLabel(attachment.kind)),
        element(
          'small',
          '',
          `Input / ${statusLabel(attachment.kind)} / ${formatBytes(attachment.sizeBytes)}`,
        ),
      );
      row.append(copy, statePill(attachment.metadata?.managed ? 'ready' : 'pending'));
      files.append(row);
    }
    for (const artifact of artifacts) {
      const row = element('div', 'run-file-row');
      const copy = element('div');
      const externalUrl = safeHttpUrl(artifact.url);
      copy.append(
        element('strong', '', artifact.title),
        element(
          'small',
          '',
          `Output / ${statusLabel(artifact.kind)} / ${formatBytes(artifact.sizeBytes)}`,
        ),
      );
      row.append(copy);
      if (artifact.downloadUrl) {
        const download = element('a', 'run-file-download', 'Download');
        download.href = artifact.downloadUrl;
        download.title = `Download ${artifact.title}`;
        row.append(download);
      } else if (externalUrl) {
        const open = element('a', 'run-file-download', 'Open');
        open.href = externalUrl;
        open.target = '_blank';
        open.rel = 'noreferrer';
        row.append(open);
      }
      files.append(row);
    }
    detail.append(files);
  }

  if (['queued', 'running', 'cancel_requested'].includes(run.status)) {
    const controls = element('div', 'run-controls');
    if (run.status !== 'cancel_requested') {
      const form = element('form', 'run-steer-form');
      const input = document.createElement('input');
      input.type = 'text';
      input.name = 'text';
      input.placeholder = 'Add a follow-up';
      input.maxLength = 4000;
      input.required = true;
      const send = element('button', 'primary-button', 'Send');
      send.type = 'submit';
      form.append(input, send);
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        void steerRun(run.id, input, send);
      });
      controls.append(form);
    }
    const cancel = element('button', 'secondary-button', 'Cancel run');
    cancel.type = 'button';
    cancel.addEventListener('click', () => void cancelRun(run.id, cancel));
    controls.append(cancel);
    detail.append(controls);
  }

  if (steering.length) {
    const followUps = element('div', 'run-followups');
    followUps.append(element('h3', '', 'Follow-ups'));
    for (const item of [...steering].sort((a, b) => a.sequence - b.sequence)) {
      const row = element('div', 'run-followup-row');
      const copy = element('div');
      copy.append(
        element('strong', '', item.message?.text || shortId(item.id)),
        element(
          'small',
          '',
          `${item.message?.actor?.displayName || item.message?.actor?.id || 'Operator'} / ${item.mode ? statusLabel(item.mode) : 'Waiting'}`,
        ),
      );
      row.append(copy, statePill(item.status));
      followUps.append(row);
    }
    detail.append(followUps);
  }

  const delegatedRuns = delegatedTraceGroups(events);
  if (delegatedRuns.length) {
    const agents = element('div', 'run-agents');
    agents.append(element('h3', '', 'Delegated agents'));
    for (const delegated of delegatedRuns) {
      const row = element('section', `run-agent-row ${delegated.status}`);
      const head = element('div', 'run-agent-head');
      const copy = element('div');
      const duration = delegated.startedAt && delegated.endedAt
        ? formatDuration(new Date(delegated.endedAt) - new Date(delegated.startedAt))
        : '';
      copy.append(
        element('strong', '', delegatedAgentLabel(delegated.agentId)),
        element(
          'small',
          '',
          [
            statusLabel(delegated.executorId || 'agent'),
            duration,
            delegationUsageCopy(delegated.usage),
            shortId(delegated.invocationId),
          ].filter(Boolean).join(' / '),
        ),
      );
      head.append(copy, statePill(delegated.status));
      row.append(head);
      if (delegated.taskPreview) {
        row.append(element('p', 'run-agent-task', delegated.taskPreview));
      }
      if (delegated.summaryPreview) {
        row.append(element('p', 'run-agent-summary', delegated.summaryPreview));
      }
      if (delegated.tools.size) {
        const childTools = element('div', 'run-agent-tools');
        for (const pair of delegated.tools.values()) {
          childTools.append(activityToolRow(pair.result || pair.started, 'child'));
        }
        row.append(childTools);
      }
      agents.append(row);
    }
    detail.append(agents);
  }

  const toolEvents = events.filter(
    (event) => {
      if (event.type !== 'tool_call' && event.type !== 'tool_result') return false;
      const call = event.metadata?.call || {};
      return !delegatedToolContext(call.provider) && call.name !== 'agent_invoke';
    },
  );
  const toolCalls = new Map();
  for (const event of toolEvents) {
    const call = event.metadata?.call || {};
    const key = call.id || event.id;
    const current = toolCalls.get(key) || {};
    if (event.type === 'tool_call') current.started = event;
    if (event.type === 'tool_result') current.result = event;
    toolCalls.set(key, current);
  }
  if (toolCalls.size) {
    const tools = element('div', 'run-tools');
    tools.append(element('h3', '', 'Tools'));
    for (const pair of toolCalls.values()) {
      const event = pair.result || pair.started;
      tools.append(activityToolRow(event));
    }
    detail.append(tools);
  }

  const deliveryRows = deliveries.turns || [];
  if (deliveryRows.length) {
    const delivery = element('div', 'run-deliveries');
    delivery.append(element('h3', '', 'Delivery receipts'));
    const grouped = new Map();
    for (const item of deliveryRows) {
      const outbound = (deliveries.outbox || []).find(
        (candidate) => candidate.id === item.outboxId,
      );
      const receipt = outbound?.externalId || item.targetId;
      const key = `${item.kind}:${receipt}`;
      const current = grouped.get(key) || {
        ...item,
        receipt,
        count: 0,
      };
      current.count += 1;
      if (item.updatedAt > current.updatedAt) Object.assign(current, item);
      current.receipt = receipt;
      grouped.set(key, current);
    }
    for (const item of [...grouped.values()].sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt),
    )) {
      const row = element('div', 'run-delivery-row');
      const copy = element('div');
      copy.append(
        element(
          'strong',
          '',
          `${statusLabel(item.kind)}${item.count > 1 ? ` x${item.count}` : ''}`,
        ),
        element(
          'small',
          '',
          `${statusLabel(item.platform)} / ${item.receipt || shortId(item.targetId)} / ${formatTime(item.updatedAt, true)}`,
        ),
      );
      row.append(copy, statePill(item.status));
      delivery.append(row);
    }
    detail.append(delivery);
  }

  const timeline = element('div', 'timeline');
  for (const event of events.filter(
    (item) =>
      item.type !== 'tool_call' &&
      item.type !== 'tool_result' &&
      item.type !== 'text_delta' &&
      item.type !== 'delegation',
  )) {
    const row = element('div', 'timeline-row');
    const eventCopy = element('div');
    eventCopy.append(
      element('strong', '', event.message || statusLabel(event.type)),
      element('small', '', `${statusLabel(event.type)} / ${formatTime(event.at, true)}`),
    );
    row.append(eventCopy);
    timeline.append(row);
  }
  if (!events.length) timeline.append(element('div', 'empty-state', 'No timeline events'));
  detail.append(timeline);
}

async function steerRun(runId, input, button) {
  const text = input.value.trim();
  if (!text) return;
  setButtonBusy(button, true, 'Sending', 'Send');
  try {
    await getJson(`/v1/runs/${encodeURIComponent(runId)}/steer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    input.value = '';
    await refreshAll({ quiet: true });
    await openRun(runId);
    showToast('Follow-up queued');
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    setButtonBusy(button, false, 'Sending', 'Send');
  }
}

async function cancelRun(runId, button) {
  setButtonBusy(button, true, 'Cancelling', 'Cancel run');
  try {
    await getJson(`/v1/runs/${encodeURIComponent(runId)}/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'admin_console_cancelled' }),
    });
    await refreshAll({ quiet: true });
    await openRun(runId);
    showToast('Cancellation requested');
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    setButtonBusy(button, false, 'Cancelling', 'Cancel run');
  }
}

function renderLedgerList(root, items, kind) {
  root.replaceChildren();
  if (!items.length) {
    root.append(element('div', 'empty-state', `No ${kind} records`));
    return;
  }
  for (const item of items.slice(0, 8)) {
    const row = element('div', 'ledger-row');
    const copy = element('div');
    const title =
      kind === 'outbound'
        ? item.kind
        : item.metadata?.workflowEventType || item.eventType || item.platform || 'event';
    const detail =
      kind === 'outbound'
        ? `${item.target?.chatId || item.target?.cardId || 'target'} / #${item.sequence}`
        : item.metadata?.producer
          ? `${item.metadata.sourceExternalId || item.externalId} / ${item.metadata.workflowStaged || 0} staged${item.duplicateCount ? ` / ${item.duplicateCount} duplicates` : ''}`
          : `${item.externalId}${item.duplicateCount ? ` / ${item.duplicateCount} duplicates` : ''}`;
    copy.append(element('strong', '', title), element('small', '', detail));
    row.append(copy, statePill(item.status));
    root.append(row);
  }
}

function renderDelivery() {
  renderLedgerList($('#outbox-list'), state.delivery?.outbox || [], 'outbound');
  renderLedgerList($('#inbound-list'), state.delivery?.inboundEvents || [], 'inbound');
}

function fillProjectSelect(select, selectedValue) {
  select.replaceChildren();
  for (const project of state.workspace?.projects || []) {
    const option = document.createElement('option');
    option.value = project.projectId;
    option.textContent = project.name;
    option.selected = projectMatches(project, selectedValue);
    select.append(option);
  }
}

function fillProjectSelects() {
  const fallback = state.workspace?.projects?.[0]?.projectId;
  state.memoryProjectId = projectById(state.memoryProjectId)?.projectId || fallback;
  state.testProjectId =
    projectById(state.testProjectId)?.projectId ||
      projectById(state.selectedProjectId)?.projectId ||
      fallback;
  state.pairingProjectId =
    projectById(state.pairingProjectId)?.projectId ||
    projectById(state.selectedProjectId)?.projectId ||
    fallback;
  fillProjectSelect($('#memory-project'), state.memoryProjectId);
  fillProjectSelect($('#test-project'), state.testProjectId);
  fillProjectSelect($('#pairing-project'), state.pairingProjectId);
}

function memoryThread() {
  const project = projectById(state.memoryProjectId) || state.workspace?.projects?.[0];
  const binding = projectBindings(project)[0];
  const platform = binding?.platform || 'lark';
  const externalId = binding?.externalId || `admin:${project?.projectId || 'general'}`;
  const threadId = binding?.scope === 'thread'
    ? `${platform}:${externalId}`
    : `${platform}:${externalId}:admin`;
  return {
    platform,
    externalId,
    channelId: binding?.channelId || externalId,
    threadId,
    workspaceId: project?.workspaceId || currentWorkspaceId(),
    projectId: project?.projectId || 'general',
    scope: state.memoryScope,
  };
}

function updateMemoryScopeControls() {
  const project = projectById(state.memoryProjectId);
  const isolated = project?.memoryMode === 'isolated';
  const direct = projectBindings(project)[0]?.visibility === 'direct';
  const workspace = $('#memory-scope [data-scope="workspace"]');
  if (workspace) workspace.disabled = isolated || direct;
  const projectButton = $('#memory-scope [data-scope="project"]');
  if (projectButton) projectButton.disabled = direct;
  const channelButton = $('#memory-scope [data-scope="channel"]');
  if (channelButton) channelButton.disabled = direct;
  if (
    (state.memoryScope === 'workspace' && (isolated || direct)) ||
    ((state.memoryScope === 'project' || state.memoryScope === 'channel') && direct)
  ) {
    state.memoryScope = 'thread';
  }
  for (const item of $$('#memory-scope button')) {
    item.classList.toggle('active', item.dataset.scope === state.memoryScope);
  }
}

function renderScopeMap(route) {
  const root = $('#scope-map');
  const scopes = [
    ['Installation', 'Operator controlled'],
    ['Workspace', `${route.workspaceId} / shared projects`],
    ['Project', route.projectId],
    ['Channel', route.channelId || 'current client channel'],
    ['Thread', `${route.threadId} / conversation`],
  ];
  root.replaceChildren();
  for (const [label, value] of scopes) {
    const node = element('div', 'scope-node');
    node.append(element('strong', '', label), element('span', '', value || 'not set'));
    root.append(node);
  }
}

function memoryRevisionSummary(revision) {
  if (revision.action === 'forget') {
    return revision.selector
      ? `Removed lines matching "${revision.selector}"`
      : 'Removed matching lines';
  }
  if (revision.action === 'restore') return 'Restored an earlier snapshot';
  if (revision.action === 'import') return 'Imported legacy memory';
  const lines = String(revision.content || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  return (
    lines
      .at(-1)
      ?.replace(/^-\s+/, '')
      .replace(/^\d{4}-\d{2}-\d{2}T\S+\s+/, '') || 'Saved an empty snapshot'
  );
}

function memoryProposalScopeLabel(proposal) {
  const scope = statusLabel(proposal.scope);
  const projectId = proposal.scopeRef?.projectId || proposal.project?.id;
  if (proposal.scope === 'project' && projectId) return `${scope} / ${projectId}`;
  const channelId = proposal.scopeRef?.channelId || proposal.thread?.channelId;
  if (proposal.scope === 'channel' && channelId) return `${scope} / ${channelId}`;
  const workspaceId = proposal.scopeRef?.workspaceId || proposal.workspace?.id;
  if (proposal.scope === 'workspace' && workspaceId) return `${scope} / ${workspaceId}`;
  if (proposal.scope === 'thread') return `${scope} / ${proposal.thread?.externalId || proposal.thread?.id}`;
  return scope;
}

function memoryProposalActionLabel(action) {
  if (action === 'remember') return 'Add approved fact';
  if (action === 'replace') return 'Replace approved fact';
  if (action === 'merge') return 'Merge approved facts';
  if (action === 'forget') return 'Remove approved fact';
  if (action === 'index') return 'Expand semantic recall';
  return statusLabel(action);
}

function memoryProposalField(label, value, modifier = '') {
  const field = element(
    'div',
    `memory-proposal-field${modifier ? ` ${modifier}` : ''}`,
  );
  field.append(
    element('span', 'memory-proposal-field-label', label),
    element('div', 'memory-proposal-field-value', value || 'Not provided'),
  );
  return field;
}

function renderMemoryProposals(proposals = state.memoryProposals) {
  const root = $('#memory-proposal-list');
  const items = proposals || [];
  const viewer = state.auth?.principal?.role === 'viewer';
  $('#memory-proposal-meta').textContent = `${items.length} pending`;
  updateMemoryProposalBatchControls();
  root.replaceChildren();
  if (!items.length) {
    root.append(element('div', 'empty-state', 'No pending proposals.'));
    return;
  }
  for (const proposal of items) {
    const row = element('div', 'memory-proposal-row');
    const select = document.createElement('input');
    select.className = 'memory-proposal-select';
    select.type = 'checkbox';
    select.value = proposal.id;
    select.disabled = viewer;
    select.setAttribute('aria-label', `Select ${proposal.action} proposal`);
    select.addEventListener('change', updateMemoryProposalBatchControls);
    const status = element('div', 'memory-proposal-status');
    status.append(
      statePill(proposal.status, statusLabel(proposal.action)),
      element('span', '', memoryProposalScopeLabel(proposal)),
    );
    const detail = element('div', 'memory-proposal-detail');
    const heading = element('div', 'memory-proposal-heading');
    heading.append(
      element('strong', '', memoryProposalActionLabel(proposal.action)),
      element('span', '', `${proposal.actorId || 'Unknown actor'} / ${formatTime(proposal.createdAt, true)}`),
    );
    const comparison = element('div', 'memory-proposal-comparison');
    if (['replace', 'merge', 'forget', 'index'].includes(proposal.action)) {
      comparison.append(
        memoryProposalField(
          proposal.action === 'merge' ? 'Current approved facts' : 'Current approved fact',
          proposal.action === 'merge'
            ? (proposal.selectors || []).join('\n')
            : proposal.selector || proposal.value,
          'current',
        ),
      );
    }
    if (
      proposal.action === 'remember' ||
      proposal.action === 'replace' ||
      proposal.action === 'merge'
    ) {
      comparison.append(
        memoryProposalField(
          proposal.action === 'merge' ? 'Merged fact' : 'Proposed fact',
          proposal.value,
          'proposed',
        ),
      );
    }
    if (proposal.action === 'forget') {
      comparison.append(
        memoryProposalField('Proposed result', 'Remove from active memory', 'remove'),
      );
    }
    detail.append(heading, comparison);
    if (proposal.searchAliases?.length) {
      detail.append(
        memoryProposalField(
          'Retrieval aliases',
          proposal.searchAliases.join(' / '),
          'aliases',
        ),
      );
    }
    if (proposal.reason) {
      detail.append(memoryProposalField('Model rationale', proposal.reason, 'rationale'));
    }
    const evidence = [
      proposal.source ? `Source ${proposal.source}` : '',
      proposal.expectedDocumentVersion !== undefined
        ? `Target document v${proposal.expectedDocumentVersion}`
        : '',
      proposal.retentionDays
        ? `Retain ${proposal.retentionDays} days after approval`
        : '',
    ].filter(Boolean);
    if (evidence.length) {
      detail.append(element('div', 'memory-proposal-evidence', evidence.join(' / ')));
    }
    const actions = element('div', 'memory-proposal-actions');
    const approve = element('button', 'secondary-button', 'Approve');
    approve.type = 'button';
    approve.disabled = viewer;
    approve.addEventListener('click', () =>
      void decideMemoryProposal(proposal.id, 'approve', approve),
    );
    const reject = element('button', 'danger-text-button', 'Reject');
    reject.type = 'button';
    reject.disabled = viewer;
    reject.addEventListener('click', () =>
      void decideMemoryProposal(proposal.id, 'reject', reject),
    );
    actions.append(approve, reject);
    row.append(select, status, detail, actions);
    root.append(row);
  }
  updateMemoryProposalBatchControls();
}

function selectedMemoryProposalIds() {
  return $$('.memory-proposal-select:checked')
    .map((input) => input.value)
    .filter(Boolean);
}

function updateMemoryProposalBatchControls() {
  const selectedCount = selectedMemoryProposalIds().length;
  const viewer = state.auth?.principal?.role === 'viewer';
  const approve = $('#approve-memory-proposals');
  const reject = $('#reject-memory-proposals');
  if (approve) approve.disabled = viewer || selectedCount === 0;
  if (reject) reject.disabled = viewer || selectedCount === 0;
}

async function refreshMemoryProposals() {
  if (!state.workspace) return;
  const route = memoryThread();
  const query = new URLSearchParams({
    workspaceId: route.workspaceId,
    projectId: route.projectId,
    scope: state.memoryScope,
    status: 'pending',
    limit: '50',
  });
  try {
    const data = await getJson(`/v1/memory-proposals?${query.toString()}`);
    state.memoryProposals = data.proposals || [];
    renderMemoryProposals();
  } catch (error) {
    state.memoryProposals = [];
    $('#memory-proposal-meta').textContent = 'Unavailable';
    $('#memory-proposal-list').replaceChildren(
      element('div', 'empty-state', error.message),
    );
  }
}

async function decideMemoryProposal(id, action, button) {
  const idleLabel = action === 'approve' ? 'Approve' : 'Reject';
  setButtonBusy(button, true, action === 'approve' ? 'Approving' : 'Rejecting', idleLabel);
  try {
    await getJson(`/v1/memory-proposals/${encodeURIComponent(id)}/${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    await refreshMemory();
    showToast(action === 'approve' ? 'Proposal approved' : 'Proposal rejected');
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    setButtonBusy(button, false, action === 'approve' ? 'Approving' : 'Rejecting', idleLabel);
  }
}

async function decideSelectedMemoryProposals(action, button) {
  const ids = selectedMemoryProposalIds();
  if (!ids.length) {
    showToast('Select at least one proposal', 'error');
    return;
  }
  const idleLabel = action === 'approve' ? 'Approve' : 'Reject';
  setButtonBusy(button, true, action === 'approve' ? 'Approving' : 'Rejecting', idleLabel);
  try {
    const data = await getJson('/v1/memory-proposals/batch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action, ids }),
    });
    await refreshMemory();
    const verb = action === 'approve' ? 'approved' : 'rejected';
    const failed = data.failed ? `, ${data.failed} failed` : '';
    showToast(`${data.decided || 0} proposal${data.decided === 1 ? '' : 's'} ${verb}${failed}`);
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    setButtonBusy(button, false, action === 'approve' ? 'Approving' : 'Rejecting', idleLabel);
    updateMemoryProposalBatchControls();
  }
}

function renderMemoryHistory(history) {
  const root = $('#memory-history-list');
  const revisions = history?.revisions || [];
  root.replaceChildren();
  if (!revisions.length) {
    root.append(element('div', 'empty-state', 'No revisions in this scope.'));
    return;
  }
  const currentRevisionId = history?.document?.latestRevisionId;
  const viewer = state.auth?.principal?.role === 'viewer';
  for (const revision of revisions) {
    const row = element('div', 'memory-revision-row');
    const version = element('div', 'memory-revision-version');
    version.append(
      element('strong', '', `v${revision.version}`),
      element('span', '', statusLabel(revision.action)),
    );
    const detail = element('div', 'memory-revision-detail');
    detail.append(
      element('strong', '', memoryRevisionSummary(revision)),
      element(
        'span',
        '',
        `${revision.actorId || 'Unknown actor'} / ${formatTime(revision.at, true)}`,
      ),
    );
    const current = revision.id === currentRevisionId;
    const restore = element(
      'button',
      'secondary-button',
      current ? 'Current' : 'Restore',
    );
    restore.type = 'button';
    restore.disabled = viewer || current;
    restore.addEventListener('click', () => void restoreMemory(revision.id));
    row.append(version, detail, restore);
    root.append(row);
  }
}

function renderMemorySearch(result) {
  const root = $('#memory-search-results');
  const hits = result?.hits || [];
  state.memorySearchHits = hits;
  root.hidden = false;
  root.replaceChildren();
  $('#memory-search-meta').textContent = `${hits.length} match${hits.length === 1 ? '' : 'es'} / ${result?.scannedDocuments || 0} document${result?.scannedDocuments === 1 ? '' : 's'}`;
  if (!hits.length) {
    root.append(element('div', 'empty-state compact-empty', 'No approved memory matched in this scope.'));
    return;
  }
  for (const hit of hits) {
    const row = element('div', 'memory-search-row');
    const scope = element('div', 'memory-search-scope');
    scope.append(
      element('strong', '', statusLabel(hit.scope?.kind)),
      element('span', '', `v${hit.version} / line ${hit.lineNumber}`),
    );
    const detail = element('div', 'memory-search-detail');
    detail.append(
      element('strong', '', String(hit.line || '').replace(/^-\s+\S+\s+/u, '')),
      element('span', '', `${hit.documentKey} / ${formatTime(hit.updatedAt, true)}`),
    );
    row.append(scope, detail);
    root.append(row);
  }
}

function renderMemoryQuery(result) {
  const root = $('#memory-search-results');
  root.hidden = false;
  root.replaceChildren();
  const row = element('div', 'memory-search-row');
  const scope = element('div', 'memory-search-scope');
  scope.append(
    element('strong', '', 'Semantic'),
    element('span', '', result.executor?.model || result.executor?.label || 'Memory runner'),
  );
  const detail = element('div', 'memory-search-detail');
  detail.append(
    element('strong', '', result.answer || 'No answer'),
    element('span', '', `${(result.scopes || []).join(', ')} / run ${result.sourceRunId || 'unknown'}`),
  );
  row.append(scope, detail);
  root.append(row);
  $('#memory-search-meta').textContent = 'Semantic analysis';
}

async function searchMemory(event) {
  event.preventDefault();
  const value = $('#memory-search-query').value.trim();
  if (!value) {
    showToast('Enter memory to search for', 'error');
    return;
  }
  const button = $('#search-memory');
  setButtonBusy(button, true, 'Searching', 'Search');
  try {
    const query = new URLSearchParams({
      ...memoryThread(),
      q: value,
      limit: '25',
    });
    renderMemorySearch(await getJson(`/v1/memory-search?${query.toString()}`));
  } catch (error) {
    $('#memory-search-meta').textContent = 'Unavailable';
    $('#memory-search-results').hidden = false;
    $('#memory-search-results').replaceChildren(
      element('div', 'empty-state compact-empty', error.message),
    );
  } finally {
    setButtonBusy(button, false, 'Searching', 'Search');
  }
}

async function queryMemory() {
  const value = $('#memory-search-query').value.trim();
  if (!value) {
    showToast('Enter memory to analyze', 'error');
    return;
  }
  const button = $('#query-memory');
  setButtonBusy(button, true, 'Analyzing', 'Analyze');
  try {
    const route = memoryThread();
    renderMemoryQuery(
      await getJson('/v1/memory-query', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...route,
          query: value,
          scopes: [state.memoryScope],
        }),
      }),
    );
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    setButtonBusy(button, false, 'Analyzing', 'Analyze');
  }
}

async function refreshMemoryAnalysisStatus() {
  try {
    const route = memoryThread();
    const statusQuery = new URLSearchParams({
      workspaceId: route.workspaceId,
      projectId: route.projectId,
      threadId: route.threadId,
      platform: route.platform,
    });
    if (route.channelId) statusQuery.set('channelId', route.channelId);
    const status = await getJson(`/v1/memory-analysis?${statusQuery.toString()}`);
    const runner = status.executor;
    $('#memory-analysis-runner').textContent = runner
      ? `${runner.label}${runner.model ? ` / ${runner.model}` : ''}`
      : 'Memory runner';
    $('#memory-analysis-status').textContent = status.enabled
      ? `Analysis ${runner?.model || runner?.label || 'ready'} / query ${status.queryExecutor?.model || status.queryExecutor?.label || 'unavailable'} / wrapup ${status.wrapupExecutor?.model || status.wrapupExecutor?.label || 'unavailable'} / ${status.maxEntries} entries max`
      : 'Configure a live local runner to enable semantic analysis';
    const retrieval = status.retrieval;
    $('#memory-retrieval-status').textContent = retrieval?.enabled
      ? `Retrieval ${retrieval.executor?.model || retrieval.executor?.label || 'ready'} / ${retrieval.indexedFacts || 0} indexed facts / ${retrieval.indexedAliases || 0} aliases / ${retrieval.maxCandidateLines} candidates / ${retrieval.maxSelectedLines} selected / ${Math.round(retrieval.timeoutMs / 1000)}s fallback`
      : 'Per-turn semantic retrieval disabled; bounded local retrieval remains active';
    const wrapup = status.wrapup;
    const wrapupJobs = wrapup?.jobs || {};
    $('#memory-wrapup-status').textContent = wrapup?.enabled
      ? `Automatic wrapup ${wrapup.running ? 'running' : 'ready'} / ${wrapupJobs.pending || 0} pending / ${wrapupJobs.failed || 0} failed`
      : 'Automatic wrapup disabled';
    $('#analyze-thread-memory').disabled = !status.enabled;
    $('#query-memory').disabled = !status.queryEnabled;
  } catch (error) {
    $('#memory-analysis-status').textContent = error.message;
    $('#memory-retrieval-status').textContent = 'Per-turn retrieval unavailable';
    $('#memory-wrapup-status').textContent = 'Automatic wrapup unavailable';
    $('#analyze-thread-memory').disabled = true;
    $('#query-memory').disabled = true;
  }
}

async function analyzeThreadMemory() {
  const button = $('#analyze-thread-memory');
  setButtonBusy(button, true, 'Synthesizing', 'Synthesize thread');
  try {
    const route = memoryThread();
    const report = await getJson('/v1/memory-analysis', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...route,
        scopes: ['workspace', 'project', 'channel', 'thread'],
      }),
    });
    await refreshMemory();
    showToast(
      `${report.proposed?.length || 0} proposal${report.proposed?.length === 1 ? '' : 's'} queued, ${report.skipped?.length || 0} skipped`,
    );
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    setButtonBusy(button, false, 'Synthesizing', 'Synthesize thread');
  }
}

function clearMemorySearch() {
  state.memorySearchHits = [];
  $('#memory-search-results').hidden = true;
  $('#memory-search-results').replaceChildren();
  $('#memory-search-meta').textContent = `${statusLabel(state.memoryScope)} scope`;
}

function updateMemoryRetentionFields() {
  $('#memory-expiry-custom').hidden = $('#memory-retention').value !== 'custom';
}

function selectedMemoryExpiry() {
  const retention = $('#memory-retention').value;
  if (retention === 'policy' || retention === 'keep') return undefined;
  if (retention === 'custom') {
    const value = $('#memory-expiry-date').value;
    if (!value) throw new Error('Choose an expiry date');
    const timestamp = new Date(value);
    if (!Number.isFinite(timestamp.getTime())) throw new Error('Choose a valid expiry date');
    return timestamp.toISOString();
  }
  return new Date(Date.now() + Number(retention) * 24 * 60 * 60 * 1_000).toISOString();
}

function renderMemoryExpiry(expiry, snapshot) {
  state.memoryExpiry = expiry || null;
  const entries = expiry?.entries || [];
  const checkedAt = Date.parse(expiry?.checkedAt || new Date().toISOString());
  const expired = snapshot?.scopes?.[0]?.expiredLines ??
    entries.filter((entry) => Date.parse(entry.expiresAt) <= checkedAt).length;
  $('#memory-expiry-meta').textContent = entries.length
    ? `${entries.length} timed line${entries.length === 1 ? '' : 's'} / ${expired} expired`
    : 'No timed memory';
}

async function refreshMemory() {
  if (!state.workspace) return;
  updateMemoryScopeControls();
  const route = memoryThread();
  const query = new URLSearchParams(route);
  const scopeTarget =
    state.memoryScope === 'channel' ? route.channelId : route.projectId;
  $('#memory-route').textContent = `${statusLabel(state.memoryScope)} / ${scopeTarget}`;
  renderScopeMap(route);
  try {
    const data = await getJson(`/v1/memory?${query.toString()}`);
    const content = data.snapshot?.scopes?.[0]?.content?.trim();
    const document = data.history?.document;
    $('#memory-output').textContent = content || 'No memory in this scope.';
    $('#memory-meta').textContent = document
      ? `v${document.version} / ${formatTime(document.updatedAt, true)}`
      : 'No revisions';
    renderMemoryExpiry(data.expiry, data.snapshot);
    renderMemoryHistory(data.history);
    await refreshMemoryProposals();
    await refreshMemoryAnalysisStatus();
  } catch (error) {
    $('#memory-output').textContent = error.message;
    $('#memory-meta').textContent = 'Unavailable';
    renderMemoryExpiry();
    renderMemoryHistory();
    renderMemoryProposals([]);
  }
}

async function restoreMemory(revisionId) {
  try {
    await getJson('/v1/memory', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...memoryThread(),
        action: 'restore',
        revisionId,
      }),
    });
    await refreshMemory();
    showToast('Memory revision restored');
  } catch (error) {
    showToast(error.message, 'error');
  }
}

async function rememberMemory(event) {
  event.preventDefault();
  const button = $('#save-memory');
  const text = $('#memory-text').value.trim();
  if (!text) {
    showToast('Enter a memory note', 'error');
    return;
  }
  try {
    const expiresAt = selectedMemoryExpiry();
    setButtonBusy(button, true, 'Saving', 'Remember');
    await getJson('/v1/memory', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...memoryThread(),
        action: 'remember',
        text,
        expiresAt,
        retentionOverride:
          $('#memory-retention').value === 'keep' ? 'keep' : undefined,
      }),
    });
    $('#memory-text').value = '';
    await refreshMemory();
    showToast('Memory saved');
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    setButtonBusy(button, false, 'Saving', 'Remember');
  }
}

async function updateMemoryExpiry(clear = false) {
  const selector = $('#memory-text').value.trim();
  if (!selector) {
    showToast('Enter text to match', 'error');
    return;
  }
  const button = clear ? $('#clear-memory-expiry') : $('#set-memory-expiry');
  try {
    const expiresAt = clear ? undefined : selectedMemoryExpiry();
    if (!clear && !expiresAt) throw new Error('Choose a retention period');
    setButtonBusy(button, true, clear ? 'Clearing' : 'Setting', clear ? 'Clear expiry' : 'Set on matching');
    await getJson('/v1/memory-expiry', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...memoryThread(), selector, expiresAt }),
    });
    await refreshMemory();
    showToast(clear ? 'Memory expiry cleared' : 'Memory expiry set');
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    setButtonBusy(button, false, clear ? 'Clearing' : 'Setting', clear ? 'Clear expiry' : 'Set on matching');
  }
}

async function forgetMemory() {
  const button = $('#forget-memory');
  const selector = $('#memory-text').value.trim();
  if (!selector) {
    showToast('Enter text to match', 'error');
    return;
  }
  setButtonBusy(button, true, 'Forgetting', 'Forget matching');
  try {
    await getJson('/v1/memory', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...memoryThread(), action: 'forget', selector }),
    });
    await refreshMemory();
    showToast('Matching memory removed');
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    setButtonBusy(button, false, 'Forgetting', 'Forget matching');
  }
}

function findCardText(cardDoc, prefix) {
  for (const item of cardDoc.elements || []) {
    const content = item.text?.content;
    if (typeof content === 'string' && content.startsWith(prefix)) {
      return content.replace(prefix, '').trim();
    }
  }
  return '';
}

function findChecklist(cardDoc) {
  const markers = ['○ ', '● ', '✓ ', '! ', '- '];
  for (const item of cardDoc.elements || []) {
    const content = item.text?.content;
    if (typeof content !== 'string') continue;
    const lines = content
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => markers.some((marker) => line.startsWith(marker)));
    if (lines.length) return lines;
  }
  return [];
}

function renderCard(cardDoc) {
  const card = $('#card');
  card.className = 'lark-card';
  card.replaceChildren();
  const title = cardDoc.header?.title?.content || 'MaxTag run';
  const template = cardDoc.header?.template || '';
  card.append(element('div', `card-header ${template}`, title));
  const body = element('div', 'card-body');
  const status = findCardText(cardDoc, '**Status:**');
  const summary = findCardText(cardDoc, '**Summary:**');
  body.append(element('div', 'card-line', `Status: ${status || 'unknown'}`));
  if (summary) body.append(element('div', 'card-line', `Summary: ${summary}`));
  const checklist = element('div', 'checklist');
  for (const item of findChecklist(cardDoc)) {
    const row = element('div', 'check-item');
    row.append(
      element('span', 'check-symbol', item.slice(0, 1)),
      element('span', '', item.slice(2)),
    );
    checklist.append(row);
  }
  body.append(checklist);
  card.append(body);
}

async function runTest(event) {
  event.preventDefault();
  if (event.submitter?.value === 'cancel') {
    $('#test-dialog').close();
    return;
  }
  const button = $('#run-test');
  state.testProjectId = $('#test-project').value;
  const project = projectById(state.testProjectId);
  setButtonBusy(button, true, 'Running', 'Run');
  $('#test-route').textContent = 'Running';
  $('#test-result').hidden = false;
  $('#test-output').textContent = 'Waiting for result...';
  try {
    const data = await getJson('/v1/dev/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text: $('#test-prompt').value,
        platform: $('#test-client').value,
        workspaceId: project?.workspaceId || currentWorkspaceId(),
        projectId: project?.projectId || 'opentag',
        projectName: project?.name,
      }),
    });
    const cards = data.larkDryRun?.cards || [];
    const texts = data.larkDryRun?.texts || [];
    const telegramTexts = data.telegramDryRun?.texts || [];
    const telegramEdits = data.telegramDryRun?.edits || [];
    const githubComments = data.githubDryRun?.comments || [];
    const githubUpdates = data.githubDryRun?.updates || [];
    if (cards.length) {
      renderCard(cards.at(-1).card);
    } else if (data.telegramDryRun) {
      const receipt = $('#card');
      receipt.className = 'lark-card telegram-receipt';
      receipt.textContent =
        telegramEdits.at(-1)?.text || telegramTexts[0]?.text || 'No progress receipt';
    } else if (data.githubDryRun) {
      const receipt = $('#card');
      receipt.className = 'lark-card telegram-receipt';
      receipt.textContent =
        githubUpdates.at(-1)?.body || githubComments[0]?.body || 'No progress comment';
    }
    $('#test-output').textContent =
      githubComments.at(-1)?.body ||
      telegramTexts.at(-1)?.text ||
      texts.at(-1)?.text ||
      data.result?.summary ||
      JSON.stringify(data.result, null, 2);
    $('#test-route').textContent = `${data.route?.workspaceId || 'workspace'} / ${data.route?.projectId || 'project'}`;
    await refreshAll({ quiet: true });
  } catch (error) {
    $('#test-output').textContent = error.message;
    $('#test-route').textContent = 'Failed';
  } finally {
    setButtonBusy(button, false, 'Running', 'Run');
  }
}

async function runControl(endpoint, button, labels, body = {}) {
  setButtonBusy(button, true, labels.busy, labels.idle);
  try {
    const data = await getJson(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    await refreshAll({ quiet: true });
    showToast(data.result ? JSON.stringify(data.result) : 'Operation completed');
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    setButtonBusy(button, false, labels.busy, labels.idle);
  }
}

function renderAll() {
  renderHealth();
  renderWorkspaceHeader();
  renderSummary();
  renderOnboarding();
  renderOverviewProjects();
  renderSpend();
  renderAudit();
  renderConnectors();
  renderAccess();
  fillProjectSelects();
  renderConnectorConsole();
  renderLarkSetup();
  renderLarkHistoryImports();
  renderExecutorSetup();
  renderToolIdentities();
  renderOverviewRuns();
  renderProjectList();
  fillWorkspaceForm();
  renderSkills();
  renderKnowledgeSources();
  renderDelegatedAgents();
  renderRoutines();
  renderWorkflows();
  renderActivity();
  renderDelivery();

  const fallback = state.workspace?.projects?.[0]?.projectId;
  if (!projectById(state.selectedProjectId)) state.selectedProjectId = fallback;
  fillProjectForm(selectedProject());
}

async function refreshAll({ quiet = false } = {}) {
  if (refreshInFlight) return;
  refreshInFlight = true;
  const button = $('#refresh-all');
  if (!quiet) setButtonBusy(button, true, 'Refreshing', 'Refresh');
  try {
    const workspaceId = encodeURIComponent(currentWorkspaceId());
    const [
      health,
      capabilities,
      workspace,
      spend,
      access,
      delivery,
      runs,
      bindings,
      routines,
      workflows,
      pairings,
      toolApprovals,
      assistantSessions,
      mcpConnectors,
      toolIdentities,
      skills,
      knowledgeSources,
      delegatedAgents,
      operatorCredentials,
      larkConfig,
      executorConfig,
      larkReadiness,
      larkHistoryImports,
    ] =
      await Promise.all([
        getJson('/health'),
        getJson(`/v1/capabilities?workspaceId=${workspaceId}`),
        getJson(`/v1/workspace?workspaceId=${workspaceId}`),
        getJson(`/v1/spend?workspaceId=${workspaceId}`),
        getJson(`/v1/access?workspaceId=${workspaceId}`),
        getJson(`/v1/deliveries?limit=20&workspaceId=${workspaceId}`),
        getJson(`/v1/runs?limit=50&workspaceId=${workspaceId}`),
        getJson(`/v1/bindings?limit=100&workspaceId=${workspaceId}`),
        getJson(`/v1/routines?workspaceId=${workspaceId}`),
        getJson(`/v1/workflows?workspaceId=${workspaceId}`),
        getJson(`/v1/pairing-invitations?workspaceId=${workspaceId}`),
        getJson(`/v1/tool-approvals?limit=50&workspaceId=${workspaceId}`),
        getJson(`/v1/assistant/sessions?workspaceId=${workspaceId}`),
        getJson(`/v1/mcp-connectors?workspaceId=${workspaceId}`),
        getJson('/v1/tool-identities'),
        getJson(`/v1/skills?workspaceId=${workspaceId}`),
        getJson(`/v1/knowledge-sources?workspaceId=${workspaceId}`),
        getJson(`/v1/agents?workspaceId=${workspaceId}`),
        canManageOperatorCredentials()
          ? getJson('/v1/operator-credentials')
          : Promise.resolve(null),
        canManageOperatorCredentials()
          ? getJson('/v1/config/lark')
          : Promise.resolve(null),
        canManageOperatorCredentials()
          ? getJson('/v1/config/executor')
          : Promise.resolve(null),
        getJson('/v1/lark/readiness'),
        getJson(`/v1/lark/history-imports?workspaceId=${workspaceId}`),
      ]);
    state.health = health;
    state.capabilities = capabilities;
    state.workspace = workspace;
    state.spend = spend;
    state.access = access;
    state.delivery = delivery;
    state.runs = runs.runs || [];
    if (!state.activityQuery) {
      state.activityRuns = state.runs;
      state.activitySearchTruncated = Boolean(runs.truncated);
    }
    state.bindings = bindings.bindings || [];
    state.routines = routines;
    state.workflows = workflows;
    state.pairings = pairings;
    state.toolApprovals = toolApprovals.approvals || [];
    state.assistantSessions = assistantSessions.sessions || [];
    state.mcpConnectors = mcpConnectors;
    state.toolIdentities = toolIdentities;
    state.skills = skills;
    state.knowledgeSources = knowledgeSources;
    state.delegatedAgents = delegatedAgents;
    state.operatorCredentials = operatorCredentials;
    state.larkConfig = larkConfig;
    state.executorConfig = executorConfig;
    state.larkReadiness = larkReadiness;
    state.larkHistoryImports = larkHistoryImports;
    const fallback = workspace.projects?.[0]?.projectId;
    state.selectedProjectId = projectById(state.selectedProjectId)?.projectId || fallback;
    state.selectedAccessProjectId =
      projectById(state.selectedAccessProjectId)?.projectId || fallback;
    state.memoryProjectId = projectById(state.memoryProjectId)?.projectId || fallback;
    renderAll();
    applyOperatorCapabilities();
    $('#sync-label').textContent = `Synced ${formatTime(new Date().toISOString())}`;
    if (!$('#view-memory').hidden) await refreshMemory();
    if (!$('#view-audit').hidden) await refreshAudit();
    if (!$('#view-assistant').hidden) await refreshAssistant({ quiet: true });
    if (state.activityQuery) await refreshActivityRuns({ quiet: true });
  } catch (error) {
    state.health = null;
    renderHealth();
    $('#sync-label').textContent = 'Sync failed';
    if (!quiet) showToast(error.message, 'error');
  } finally {
    refreshInFlight = false;
    if (!quiet) setButtonBusy(button, false, 'Refreshing', 'Refresh');
  }
}

for (const button of $$('[data-view]')) {
  button.addEventListener('click', () => showView(button.dataset.view));
}
window.addEventListener('hashchange', () => {
  const view = location.hash.slice(1);
  showView(viewCopy[view] ? view : 'overview', false);
});
for (const button of $$('[data-go-view]')) {
  button.addEventListener('click', () => showView(button.dataset.goView));
}

$('#auth-form').addEventListener('submit', (event) => void signInOperator(event));
$('#sign-out').addEventListener('click', () => void signOutOperator());
$('#refresh-all').addEventListener('click', () => void refreshAll());
$('#executor-credential-form').addEventListener('submit', (event) =>
  void saveExecutorCredentials(event),
);
$('#remove-executor-credentials').addEventListener('click', (event) =>
  void removeExecutorCredentials(event.currentTarget),
);
$('#executor-provider').addEventListener('change', renderExecutorSetup);
$('#executor-auth-mode').addEventListener('change', updateExecutorAuthFields);
$('#lark-history-range').addEventListener('change', updateLarkHistoryRangeFields);
$('#lark-history-form').addEventListener('submit', (event) =>
  void startLarkHistoryImport(event),
);
$('#preview-lark-history').addEventListener('click', (event) =>
  void previewLarkHistory(event.currentTarget),
);

$('#assistant-project').addEventListener('change', (event) => {
  closeAssistantStream();
  state.assistantLiveEvents = [];
  state.assistantDrafts = {};
  state.selectedAssistantProjectId = event.target.value;
  const first = state.assistantSessions.find(
    (session) => session.projectId === state.selectedAssistantProjectId,
  );
  state.selectedAssistantSessionId = first?.id || null;
  state.assistantSnapshot = null;
  if (first) void openAssistantSession(first.id);
  else renderAssistantConversation();
});
$('#new-assistant-session').addEventListener('click', () =>
  void createAssistantSession(),
);
$('#assistant-form').addEventListener('submit', sendAssistantMessage);
$('#assistant-attach').addEventListener('click', () => $('#assistant-files').click());
$('#assistant-files').addEventListener('change', (event) => {
  state.assistantFiles.push(...event.target.files);
  event.target.value = '';
  renderAssistantAttachments();
});
$('#assistant-prompt').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    $('#assistant-form').requestSubmit();
  }
});
$('#assistant-stop').addEventListener('click', async (event) => {
  const runId = event.currentTarget.dataset.runId;
  if (!runId) return;
  const button = event.currentTarget;
  setButtonBusy(button, true, 'Stopping', 'Stop');
  try {
    await getJson(`/v1/runs/${encodeURIComponent(runId)}/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'web_assistant_stop' }),
    });
    await refreshAssistant({ quiet: true });
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    setButtonBusy(button, false, 'Stopping', 'Stop');
  }
});
$('#audit-filter-form').addEventListener('submit', (event) => {
  event.preventDefault();
  void refreshAudit();
});
$('#export-audit').addEventListener('click', exportAudit);
$('#preview-data-lifecycle').addEventListener('click', () => void previewDataLifecycle());
$('#apply-data-lifecycle').addEventListener('click', () => void applyDataLifecycle());
$('#open-test').addEventListener('click', () => $('#test-dialog').showModal());
$('#test-form').addEventListener('submit', (event) => void runTest(event));
$('#new-project').addEventListener('click', newProject);
$('#new-skill').addEventListener('click', newSkill);
$('#skill-form').addEventListener('submit', (event) => void saveSkill(event));
$('#toggle-skill').addEventListener('click', () => void toggleSkill());
$('#new-source').addEventListener('click', newKnowledgeSource);
$('#source-form').addEventListener('submit', (event) => void saveKnowledgeSource(event));
$('#toggle-source').addEventListener('click', () => void toggleKnowledgeSource());
$('#source-kind').addEventListener('change', updateKnowledgeSourceKind);
$('#source-file').addEventListener('change', (event) => void importKnowledgeSourceFile(event));
$('#refresh-source').addEventListener('click', () => void refreshKnowledgeSource());
$('#new-delegated-agent').addEventListener('click', newDelegatedAgent);
$('#delegated-agent-form').addEventListener('submit', (event) =>
  void saveDelegatedAgent(event),
);
$('#toggle-delegated-agent').addEventListener('click', () =>
  void toggleDelegatedAgent(),
);
$('#workspace-form').addEventListener('submit', (event) => void saveWorkspace(event));
$('#open-workspace-capabilities').addEventListener(
  'click',
  openWorkspaceCapabilities,
);
$('#close-workspace-capabilities').addEventListener('click', () =>
  $('#workspace-capability-dialog').close(),
);
$('#workspace-capability-form').addEventListener('submit', (event) =>
  void saveWorkspaceCapabilities(event),
);
$('#project-form').addEventListener('submit', (event) => void saveProject(event));
$('#access-member-form').addEventListener('submit', (event) => void saveAccessMember(event));
$('#access-policy-form').addEventListener('submit', (event) => void saveAccessPolicy(event));
$('#access-membership-form').addEventListener('submit', (event) =>
  void assignProjectMember(event),
);
$('#operator-credential-form').addEventListener('submit', (event) =>
  void createOperatorCredential(event),
);
$('#close-operator-credential-secret').addEventListener(
  'click',
  closeOperatorCredentialSecret,
);
$('#copy-operator-credential-secret').addEventListener('click', () =>
  void copyText(
    $('#operator-credential-secret').textContent,
    'Operator token copied',
  ),
);
$('#save-binding').addEventListener('click', () => void saveBinding());
$('#binding-platform').addEventListener('change', updateClientDestinationFields);
$('#channel-policy-form').addEventListener('submit', (event) =>
  void saveChannelPolicy(event),
);
$('#close-channel-policy').addEventListener('click', () =>
  $('#channel-policy-dialog').close(),
);
$('#remove-channel-policy').addEventListener('click', () =>
  void removeChannelPolicy(),
);
$('#channel-instruction-mode').addEventListener(
  'change',
  updateChannelInstructionFields,
);
$('#channel-capability-mode').addEventListener('change', () => {
  const binding = state.selectedChannelBinding;
  const policy = binding ? channelPolicyForBinding(binding) : undefined;
  const startsFromInherited =
    $('#channel-capability-mode').value !== 'inherit' &&
    (!policy || policy.capabilityMode === 'inherit');
  renderChannelCapabilities(startsFromInherited ? channelCapabilityBase() : policy);
});
$('#channel-budget-mode').addEventListener('change', updateChannelBudgetFields);
$('#pairing-form').addEventListener('submit', (event) => void generatePairing(event));
$('#copy-pairing').addEventListener('click', () => void copyPairingCommand());
$('#new-routine').addEventListener('click', newRoutine);
$('#routine-form').addEventListener('submit', (event) => void saveRoutine(event));
$('#trigger-routine').addEventListener('click', () => void triggerRoutine());
$('#delete-routine').addEventListener('click', () => void deleteRoutine());
$('#tick-routines').addEventListener('click', () => void tickRoutines());
$('#new-workflow').addEventListener('click', newWorkflow);
$('#workflow-form').addEventListener('submit', (event) => void saveWorkflow(event));
$('#workflow-producer-form').addEventListener('submit', (event) => void saveWorkflowProducer(event));
$('#workflow-producer-kind').addEventListener('change', updateWorkflowProducerFields);
$('#trigger-workflow').addEventListener('click', () => void triggerWorkflow());
$('#archive-workflow').addEventListener('click', () => void archiveWorkflow());
$('#tick-workflows').addEventListener('click', () => void tickWorkflows());
$('#add-workflow-step').addEventListener('click', addWorkflowStep);
$('#memory-form').addEventListener('submit', (event) => void rememberMemory(event));
$('#memory-search-form').addEventListener('submit', (event) => void searchMemory(event));
$('#query-memory').addEventListener('click', () => void queryMemory());
$('#analyze-thread-memory').addEventListener('click', () => void analyzeThreadMemory());
$('#forget-memory').addEventListener('click', () => void forgetMemory());
$('#set-memory-expiry').addEventListener('click', () => void updateMemoryExpiry());
$('#clear-memory-expiry').addEventListener('click', () => void updateMemoryExpiry(true));
$('#memory-retention').addEventListener('change', updateMemoryRetentionFields);
$('#reload-memory').addEventListener('click', () => void refreshMemory());
$('#approve-memory-proposals').addEventListener('click', (event) =>
  void decideSelectedMemoryProposals('approve', event.currentTarget),
);
$('#reject-memory-proposals').addEventListener('click', (event) =>
  void decideSelectedMemoryProposals('reject', event.currentTarget),
);
$('#reload-memory-proposals').addEventListener('click', () => void refreshMemoryProposals());

for (const input of $$('#project-form input, #project-form textarea, #project-form select')) {
  input.addEventListener('input', markProjectDirty);
  input.addEventListener('change', markProjectDirty);
}

for (const input of $$('#skill-form input, #skill-form textarea')) {
  input.addEventListener('input', markSkillDirty);
  input.addEventListener('change', markSkillDirty);
}

for (const input of $$('#source-form input, #source-form textarea, #source-form select')) {
  input.addEventListener('input', markKnowledgeSourceDirty);
  input.addEventListener('change', markKnowledgeSourceDirty);
}

for (const input of $$(
  '#delegated-agent-form input, #delegated-agent-form textarea, #delegated-agent-form select',
)) {
  input.addEventListener('input', markDelegatedAgentDirty);
  input.addEventListener('change', markDelegatedAgentDirty);
}

for (const input of $$('#workspace-form input, #workspace-form textarea, #workspace-form select')) {
  input.addEventListener('input', markWorkspaceDirty);
  input.addEventListener('change', markWorkspaceDirty);
}

$('#workspace-agent-executor').addEventListener('change', (event) =>
  renderRunnerCapabilities($('#workspace-runner-capabilities'), event.target.value),
);

$('#tool-identity-provider').addEventListener('change', updateToolIdentityFields);
$('#tool-identity-form').addEventListener('submit', saveToolIdentity);

$('#agent-executor').addEventListener('change', (event) =>
  renderRunnerCapabilities($('#project-runner-capabilities'), event.target.value),
);

for (const input of $$('#workspace-capability-form input, #workspace-capability-form select')) {
  input.addEventListener('input', markWorkspaceDirty);
  input.addEventListener('change', markWorkspaceDirty);
}

$('#workspace-memory-approval-mode').addEventListener(
  'change',
  updateWorkspaceMemoryApprovalFields,
);
$('#workspace-memory-retention-mode').addEventListener('change', () =>
  updateMemoryRetentionPolicyFields('workspace'),
);
for (const input of $$('#workspace-memory-approval-options input')) {
  input.addEventListener('change', updateWorkspaceMemoryApprovalFields);
}

for (const input of $$('#routine-form input, #routine-form textarea, #routine-form select')) {
  input.addEventListener('input', markRoutineDirty);
  input.addEventListener('change', markRoutineDirty);
}

for (const input of $$('#workflow-form input, #workflow-form select')) {
  input.addEventListener('input', markWorkflowDirty);
  input.addEventListener('change', markWorkflowDirty);
}

for (const button of $$('#workflow-trigger-kind button')) {
  button.addEventListener('click', () =>
    setWorkflowTriggerKind(button.dataset.workflowTrigger, true),
  );
}

$('#workflow-event-type').addEventListener('input', () =>
  setWorkflowTriggerKind('event'),
);

$('#routine-schedule-kind').addEventListener('change', updateRoutineScheduleFields);
$('#routine-notification-mode').addEventListener(
  'change',
  updateRoutineNotificationFields,
);
$('#routine-project').addEventListener('change', () => fillRoutineDestination(true));
$('#routine-platform').addEventListener('change', () => {
  fillRoutineDestination(true);
  updateClientDestinationFields();
});
$('#workflow-project').addEventListener('change', () => fillWorkflowDestination(true));
$('#workflow-platform').addEventListener('change', () => {
  fillWorkflowDestination(true);
  updateClientDestinationFields();
});

$('#project-id').addEventListener('input', () => {
  if (state.selectedProjectId === '__new__') {
    $('#agent-id-label').textContent = currentAgentId();
  }
});

$('#project-agent-mode').addEventListener('change', () => {
  const inherited = $('#project-agent-mode').value === 'inherit';
  if (inherited) {
    const identity = state.workspace?.workspace?.identity || {};
    $('#agent-name').value = identity.displayName || 'MaxTag';
    $('#agent-instructions').value = identity.instructions || '';
    fillExecutorOptions(identity.defaultExecutorId || 'codex');
  }
  updateProjectAgentFields();
});

$('#project-memory-mode').addEventListener('change', updateProjectAgentFields);
$('#project-memory-approval-mode').addEventListener(
  'change',
  updateProjectMemoryApprovalFields,
);
$('#project-memory-retention-mode').addEventListener('change', () =>
  updateMemoryRetentionPolicyFields('project'),
);
for (const input of $$('#project-memory-approval-options input')) {
  input.addEventListener('change', updateProjectMemoryApprovalFields);
}

$('#project-capability-mode').addEventListener('change', () => {
  const project = selectedProject();
  const startsFromWorkspace =
    $('#project-capability-mode').value === 'custom' &&
    project?.capabilityMode !== 'custom';
  updateProjectCapabilityFields(
    startsFromWorkspace ? state.workspace?.workspace : undefined,
  );
});

$('#memory-project').addEventListener('change', (event) => {
  state.memoryProjectId = event.target.value;
  clearMemorySearch();
  void refreshMemory();
});

$('#test-project').addEventListener('change', (event) => {
  state.testProjectId = event.target.value;
});

$('#pairing-project').addEventListener('change', (event) => {
  state.pairingProjectId = event.target.value;
});

$('#access-project').addEventListener('change', (event) => {
  state.selectedAccessProjectId = event.target.value;
  renderProjectAccess();
});

$('#activity-project').addEventListener('change', (event) => {
  state.selectedActivityProjectId = event.target.value;
  state.selectedActivityThreadId = '__all__';
  state.selectedRunId = null;
  $('#run-detail').replaceChildren(element('div', 'empty-state', 'Select a run'));
  if (state.activityQuery) void refreshActivityRuns();
  else renderActivity();
});

$('#activity-search-form').addEventListener('submit', (event) => {
  event.preventDefault();
  clearTimeout(activitySearchTimer);
  state.activityQuery = $('#activity-query').value.trim();
  state.selectedActivityThreadId = '__all__';
  void refreshActivityRuns();
});

$('#activity-query').addEventListener('input', (event) => {
  clearTimeout(activitySearchTimer);
  state.activityQuery = event.target.value.trim();
  state.selectedActivityThreadId = '__all__';
  activitySearchTimer = setTimeout(
    () => void refreshActivityRuns({ quiet: true }),
    250,
  );
});

for (const button of $$('#memory-scope button')) {
  button.addEventListener('click', () => {
    state.memoryScope = button.dataset.scope;
    clearMemorySearch();
    for (const item of $$('#memory-scope button')) {
      item.classList.toggle('active', item === button);
    }
    void refreshMemory();
  });
}

for (const button of $$('#run-filter button')) {
  button.addEventListener('click', () => {
    state.runFilter = button.dataset.status || '';
    for (const item of $$('#run-filter button')) {
      item.classList.toggle('active', item === button);
    }
    renderActivity();
  });
}

$('#worker-pass').addEventListener('click', (event) =>
  void runControl(
    '/v1/runs/worker-pass',
    event.currentTarget,
    { busy: 'Working', idle: 'Worker pass' },
    { limit: 1 },
  ),
);
$('#recover-runs').addEventListener('click', (event) =>
  void runControl(
    '/v1/runs/recover-stale',
    event.currentTarget,
    { busy: 'Recovering', idle: 'Recover runs' },
    { olderThanMs: 120000, reason: 'admin_console_recovery' },
  ),
);
$('#recover-delivery').addEventListener('click', (event) =>
  void runControl(
    '/v1/deliveries/recover-stale',
    event.currentTarget,
    { busy: 'Recovering', idle: 'Recover delivery' },
    {
      workspaceId: currentWorkspaceId(),
      olderThanMs: 120000,
      reason: 'admin_console_recovery',
    },
  ),
);

$('#onboarding-dismiss').addEventListener('click', () => {
  localStorage.setItem(ONBOARDING_DISMISSED_KEY, 'true');
  renderOnboarding();
});
$('#onboarding-reopen').addEventListener('click', () => {
  localStorage.removeItem(ONBOARDING_DISMISSED_KEY);
  renderOnboarding();
  $('#onboarding-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
});
$('#onboarding-primary-action').addEventListener('click', (event) => {
  if (event.currentTarget.dataset.admin === 'true') setAdminMode(true);
  showView(event.currentTarget.dataset.view || 'projects');
});
$('#toggle-admin-mode').addEventListener('click', () => {
  setAdminMode(!$('#app-shell').classList.contains('admin-mode'));
});
$('#test-lark-connection').addEventListener('click', (event) => {
  void testLarkConnection(event.currentTarget);
});
$('#lark-credential-form').addEventListener('submit', (event) => {
  void saveLarkCredentials(event);
});
$('#remove-lark-credentials').addEventListener('click', (event) => {
  void removeLarkCredentials(event.currentTarget);
});

installChineseInterface();
setAdminMode(localStorage.getItem(ADMIN_MODE_KEY) === 'true');
const initialView = location.hash.slice(1);
const initialAdminMode = $('#app-shell').classList.contains('admin-mode');
const allowedInitialView = initialAdminMode || ['overview', 'assistant', 'activity'].includes(initialView);
showView(viewCopy[initialView] && allowedInitialView ? initialView : 'overview', false);
if (await loadOperatorSession()) await refreshAll();

setInterval(() => {
  if (
    document.visibilityState === 'visible' &&
    state.auth?.authenticated &&
    !state.workspaceDirty &&
    !state.projectDirty &&
    !state.skillDirty &&
    !state.knowledgeSourceDirty &&
    !state.delegatedAgentDirty &&
    !state.routineDirty &&
    !state.workflowDirty
  ) {
    void refreshAll({ quiet: true });
  }
}, 10000);
