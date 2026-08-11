export type PlatformKind =
  | 'lark'
  | 'telegram'
  | 'slack'
  | 'github'
  | 'linear'
  | (string & {});

export type ThreadVisibility = 'public' | 'private' | 'direct';

export interface SourceThread {
  id: string;
  platform: PlatformKind;
  externalId: string;
  workspaceId?: string;
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
  scope: 'thread' | 'channel' | 'workspace' | 'global';
  label: string;
  constraints?: Record<string, unknown>;
}

export interface AccessBundle {
  id: string;
  threadId: string;
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
  thread: SourceThread;
  message: SourceMessage;
  identity: AgentIdentity;
  access: AccessBundle;
  memory: string;
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
  remember(thread: SourceThread, text: string): Promise<void>;
  forget(thread: SourceThread, selector: string): Promise<void>;
}

export interface ThreadConfigStore {
  getIdentity(thread: SourceThread): Promise<AgentIdentity>;
  getAccessBundle(thread: SourceThread): Promise<AccessBundle>;
}

export interface RuntimeDependencies {
  platform: PlatformAdapter;
  executor: Executor;
  memory: MemoryStore;
  threadConfig: ThreadConfigStore;
  clock?: () => Date;
}

