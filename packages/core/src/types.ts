export type PlatformKind =
  | 'lark'
  | 'telegram'
  | 'slack'
  | 'github'
  | 'linear'
  | (string & {});

export type ThreadVisibility = 'public' | 'private' | 'direct';

export type ClientStatus = 'ready' | 'partial' | 'planned';

export type MemoryScopeKind = 'global' | 'workspace' | 'project' | 'thread';

export interface Workspace {
  id: string;
  name: string;
  defaultProjectId?: string;
  platformTenantIds?: Partial<Record<PlatformKind, string>>;
  metadata?: Record<string, unknown>;
}

export interface Project {
  id: string;
  workspaceId: string;
  key: string;
  name: string;
  description?: string;
  platformBindings?: Array<{
    platform: PlatformKind;
    externalId: string;
    channelId?: string;
  }>;
  metadata?: Record<string, unknown>;
}

export interface MemoryScope {
  kind: MemoryScopeKind;
  workspaceId?: string;
  projectId?: string;
  threadId?: string;
  label: string;
}

export interface ScopedMemorySnapshot {
  loadedAt: string;
  scopes: Array<{
    scope: MemoryScope;
    content: string;
  }>;
  text: string;
}

export interface MemoryQuery {
  thread: SourceThread;
  workspace?: Workspace;
  project?: Project;
  scopes?: MemoryScopeKind[];
}

export interface MemoryWriteRequest extends MemoryQuery {
  scope: MemoryScopeKind;
  text: string;
}

export interface MemoryForgetRequest extends MemoryQuery {
  scope: MemoryScopeKind;
  selector: string;
}

export interface SourceThread {
  id: string;
  platform: PlatformKind;
  externalId: string;
  workspaceId?: string;
  projectId?: string;
  channelId?: string;
  rootMessageId?: string;
  topicId?: string;
  title?: string;
  visibility: ThreadVisibility;
  permalink?: string;
  metadata?: Record<string, unknown>;
}

export interface SourceActor {
  id: string;
  displayName?: string;
  platformUserId?: string;
  isBot?: boolean;
}

export interface SourceAttachment {
  id: string;
  kind: 'image' | 'file' | 'audio' | 'video' | 'link';
  name?: string;
  mimeType?: string;
  sizeBytes?: number;
  url?: string;
  localPath?: string;
  metadata?: Record<string, unknown>;
}

export interface SourceMessage {
  id: string;
  threadId: string;
  platform: PlatformKind;
  text: string;
  actor: SourceActor;
  createdAt: string;
  mentionsAgent: boolean;
  replyToMessageId?: string;
  attachments?: SourceAttachment[];
  metadata?: Record<string, unknown>;
}

export interface AgentIdentity {
  id: string;
  displayName: string;
  description?: string;
  instructions: string;
  defaultExecutorId: string;
  avatarUrl?: string;
}

export type ToolGrantKind =
  | 'github'
  | 'lark-docs'
  | 'lark-base'
  | 'browser'
  | 'shell'
  | 'memory'
  | (string & {});

export interface ToolGrant {
  id: string;
  kind: ToolGrantKind;
  scope: 'thread' | 'channel' | 'workspace' | 'project' | 'global';
  label: string;
  constraints?: Record<string, unknown>;
}

export interface AccessBundle {
  id: string;
  threadId: string;
  workspaceId?: string;
  projectId?: string;
  grants: ToolGrant[];
  networkPolicy: {
    mode: 'deny-by-default' | 'allow-all' | 'restricted';
    allowedHosts: string[];
  };
}

export interface ChecklistItem {
  id: string;
  label: string;
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped';
  detail?: string;
}

export interface ProgressState {
  runId: string;
  title: string;
  status: 'queued' | 'running' | 'blocked' | 'completed' | 'failed' | 'cancelled';
  summary?: string;
  checklist: ChecklistItem[];
  updatedAt: string;
}

export interface ProgressSurface {
  create(state: ProgressState): Promise<{ surfaceId: string }>;
  update(surfaceId: string, state: ProgressState): Promise<void>;
  complete(surfaceId: string, state: ProgressState): Promise<void>;
}

export type ArtifactKind =
  | 'message'
  | 'file'
  | 'patch'
  | 'pull-request'
  | 'report'
  | 'chart'
  | 'link'
  | (string & {});

export interface Artifact {
  id: string;
  kind: ArtifactKind;
  title: string;
  url?: string;
  path?: string;
  metadata?: Record<string, unknown>;
}

export type AgentRunEvent =
  | { type: 'progress'; item: ChecklistItem; message?: string }
  | { type: 'text_delta'; text: string }
  | { type: 'artifact'; artifact: Artifact }
  | { type: 'log'; level: 'debug' | 'info' | 'warn' | 'error'; message: string };

export interface AgentRunRequest {
  runId: string;
  workspace?: Workspace;
  project?: Project;
  thread: SourceThread;
  message: SourceMessage;
  identity: AgentIdentity;
  access: AccessBundle;
  memory: string;
  memorySnapshot?: ScopedMemorySnapshot;
  abortSignal?: AbortSignal;
  onEvent?: (event: AgentRunEvent) => void | Promise<void>;
}

export interface AgentRunResult {
  summary: string;
  artifacts: Artifact[];
}

export interface Executor {
  id: string;
  label: string;
  run(request: AgentRunRequest): Promise<AgentRunResult>;
}

export interface PlatformCapabilities {
  supportsThreads: boolean;
  supportsCards: boolean;
  supportsFiles: boolean;
  supportsReactions: boolean;
  supportsMentions: boolean;
}

export interface PlatformAdapter {
  kind: PlatformKind;
  capabilities: PlatformCapabilities;
  createProgressSurface(thread: SourceThread): ProgressSurface;
  sendMessage(thread: SourceThread, text: string, artifacts?: Artifact[]): Promise<void>;
}

export interface MemoryStore {
  loadThreadMemory(thread: SourceThread): Promise<string>;
  loadMemory?(query: MemoryQuery): Promise<ScopedMemorySnapshot>;
  remember(thread: SourceThread, text: string): Promise<void>;
  rememberScoped?(request: MemoryWriteRequest): Promise<void>;
  forget(thread: SourceThread, selector: string): Promise<void>;
  forgetScoped?(request: MemoryForgetRequest): Promise<void>;
}

export interface ThreadConfigContext {
  workspace?: Workspace;
  project?: Project;
}

export interface ThreadConfigStore {
  getWorkspace?(thread: SourceThread): Promise<Workspace>;
  getProject?(thread: SourceThread, workspace?: Workspace): Promise<Project>;
  getIdentity(thread: SourceThread): Promise<AgentIdentity>;
  getAccessBundle(
    thread: SourceThread,
    context?: ThreadConfigContext,
  ): Promise<AccessBundle>;
}

export interface RuntimeDependencies {
  platform: PlatformAdapter;
  executor: Executor;
  memory: MemoryStore;
  threadConfig: ThreadConfigStore;
  clock?: () => Date;
}
