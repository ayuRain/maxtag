import { createHash } from 'node:crypto';
import type { SourceThread, ToolGrant } from '@opentag/core';
import type { FileThreadConfigStore } from '@opentag/config';
import type {
  FileWorkflowStore,
  WorkflowProducerClaim,
  WorkflowProducerRoute,
} from '@opentag/workflows';

export interface LarkDocumentWatcherTickResult {
  at: string;
  claimed: number;
  baseline: number;
  changed: number;
  unchanged: number;
  staged: number;
  duplicates: number;
  failed: number;
  routeIds: string[];
}

export interface LarkDocumentWatcherOptions {
  workflowStore: FileWorkflowStore;
  threadConfigStore: FileThreadConfigStore;
  watcherId: string;
  enabled?: boolean;
  available?: boolean;
  claimStaleMs?: number;
  batchSize?: number;
  rawRequestIntervalMs?: number;
  request: <T>(
    pathname: string,
    options: { method: 'GET'; signal?: AbortSignal },
  ) => Promise<T>;
  now?: () => Date;
}

interface LarkDocumentMetadataResponse {
  document?: {
    document_id?: string;
    revision_id?: number | string;
    title?: string;
  };
}

interface LarkDocumentRawContentResponse {
  content?: string;
}

function permissionAllows(grant: ToolGrant): boolean {
  const permissions = grant.constraints?.permissions;
  if (!Array.isArray(permissions)) return true;
  return permissions.some((item) => item === 'read');
}

function constraintStrings(grant: ToolGrant, ...keys: string[]): string[] {
  for (const key of keys) {
    const value = grant.constraints?.[key];
    if (!Array.isArray(value)) continue;
    return value
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

function resourceMatches(pattern: string, value: string): boolean {
  const normalizedPattern = pattern.toLowerCase();
  const normalizedValue = value.toLowerCase();
  if (normalizedPattern === '*') return true;
  if (normalizedPattern.endsWith('/*')) {
    return normalizedValue.startsWith(normalizedPattern.slice(0, -1));
  }
  return normalizedPattern === normalizedValue;
}

function hasDocumentReadGrant(grants: ToolGrant[], documentId: string): boolean {
  return grants.some(
    (grant) =>
      grant.kind === 'lark-docs' &&
      permissionAllows(grant) &&
      constraintStrings(grant, 'documentIds', 'documents').some((pattern) =>
        resourceMatches(pattern, documentId),
      ),
  );
}

function watcherThread(route: WorkflowProducerRoute): SourceThread {
  return {
    id: `lark-document:${route.id}`,
    platform: 'lark',
    externalId: route.documentId || route.id,
    workspaceId: route.workspaceId,
    projectId: route.projectId,
    visibility: 'direct',
    title: route.name,
    metadata: {
      source: 'lark-document-watcher',
      documentId: route.documentId,
    },
  };
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function boundedUtf8(value: string, maxBytes: number): {
  value: string;
  truncated: boolean;
} {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) {
    return { value, truncated: false };
  }
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, middle), 'utf8') <= maxBytes) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return { value: value.slice(0, low), truncated: true };
}

function revisionId(value: number | string | undefined): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error('lark_document_revision_invalid');
  }
  return parsed;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class LarkDocumentWatcherService {
  readonly enabled: boolean;
  readonly available: boolean;
  private readonly workflowStore: FileWorkflowStore;
  private readonly threadConfigStore: FileThreadConfigStore;
  private readonly watcherId: string;
  private readonly claimStaleMs: number;
  private readonly batchSize: number;
  private readonly rawRequestIntervalMs: number;
  private readonly request: LarkDocumentWatcherOptions['request'];
  private readonly now: () => Date;
  private tickPass?: Promise<LarkDocumentWatcherTickResult>;
  private _tickCount = 0;
  private _lastTickAt?: string;
  private _lastTickResult?: LarkDocumentWatcherTickResult;
  private lastRawRequestAt = 0;

  constructor(options: LarkDocumentWatcherOptions) {
    this.workflowStore = options.workflowStore;
    this.threadConfigStore = options.threadConfigStore;
    this.watcherId = options.watcherId;
    this.enabled = options.enabled ?? true;
    this.available = options.available ?? true;
    this.claimStaleMs = options.claimStaleMs ?? 120_000;
    this.batchSize = Math.max(1, Math.min(options.batchSize ?? 5, 20));
    this.rawRequestIntervalMs = Math.max(0, options.rawRequestIntervalMs ?? 220);
    this.request = options.request;
    this.now = options.now ?? (() => new Date());
  }

  get running(): boolean {
    return Boolean(this.tickPass);
  }

  get tickCount(): number {
    return this._tickCount;
  }

  get lastTickAt(): string | undefined {
    return this._lastTickAt;
  }

  get lastTickResult(): LarkDocumentWatcherTickResult | undefined {
    return this._lastTickResult
      ? structuredClone(this._lastTickResult)
      : undefined;
  }

  async waitForIdle(): Promise<void> {
    await this.tickPass?.then(
      () => undefined,
      () => undefined,
    );
  }

  async tick(options: { force?: boolean } = {}): Promise<LarkDocumentWatcherTickResult> {
    if (this.tickPass) return this.tickPass;
    this.tickPass = this.runTick(options.force === true);
    try {
      return await this.tickPass;
    } finally {
      this.tickPass = undefined;
    }
  }

  private async rawContent(documentId: string): Promise<string> {
    const waitMs = Math.max(
      0,
      this.lastRawRequestAt + this.rawRequestIntervalMs - Date.now(),
    );
    if (waitMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
    }
    this.lastRawRequestAt = Date.now();
    const response = await this.request<LarkDocumentRawContentResponse>(
      `/open-apis/docx/v1/documents/${encodeURIComponent(documentId)}/raw_content`,
      { method: 'GET' },
    );
    if (typeof response.content !== 'string') {
      throw new Error('lark_document_content_missing');
    }
    return response.content;
  }

  private async pollClaim(
    claim: WorkflowProducerClaim,
    result: LarkDocumentWatcherTickResult,
  ): Promise<void> {
    const { route, runtime } = claim;
    const documentId = route.documentId;
    if (!documentId) throw new Error('workflow_producer_document_id_required');
    const policy = await this.threadConfigStore.resolveThreadPolicy(
      watcherThread(route),
    );
    if (
      policy.workspace.id !== route.workspaceId ||
      policy.project.key !== route.projectId ||
      !hasDocumentReadGrant(policy.access.grants, documentId)
    ) {
      throw new Error('lark_document_watch_grant_required');
    }
    const metadata = await this.request<LarkDocumentMetadataResponse>(
      `/open-apis/docx/v1/documents/${encodeURIComponent(documentId)}`,
      { method: 'GET' },
    );
    const nextRevisionId = revisionId(metadata.document?.revision_id);
    const title = metadata.document?.title?.trim().slice(0, 500) || route.name;
    if (runtime.lastRevisionId === nextRevisionId) {
      await this.workflowStore.completeProducerPoll(
        {
          routeId: route.id,
          claimerId: this.watcherId,
          revisionId: nextRevisionId,
          contentHash: runtime.lastContentHash,
          title,
        },
        this.now(),
      );
      result.unchanged += 1;
      return;
    }

    const content = await this.rawContent(documentId);
    const contentHash = sha256(content);
    const baseline = runtime.lastRevisionId === undefined;
    if (!baseline) {
      const bounded = boundedUtf8(content, 60_000);
      const staged = await this.workflowStore.triggerEvent(
        {
          workspaceId: route.workspaceId,
          projectId: route.projectId,
          eventType: 'lark.document.changed',
          eventId: `${documentId}:${nextRevisionId}`,
          actor: `lark-document:${documentId}`,
          producer: 'lark-document-watcher',
          sourceExternalId: documentId,
          payload: {
            schemaVersion: 1,
            provider: 'lark',
            eventType: 'lark.document.changed',
            source: {
              kind: 'document-watcher',
              routeId: route.id,
              documentId,
            },
            documentId,
            title,
            revisionId: nextRevisionId,
            previousRevisionId: runtime.lastRevisionId,
            contentHash,
            content: bounded.value,
            truncated: bounded.truncated,
            detectedAt: this.now().toISOString(),
          },
        },
        this.now(),
      );
      result.changed += 1;
      result.staged += staged.staged.length;
      result.duplicates += staged.duplicates.length;
    } else {
      result.baseline += 1;
    }

    await this.workflowStore.completeProducerPoll(
      {
        routeId: route.id,
        claimerId: this.watcherId,
        revisionId: nextRevisionId,
        contentHash,
        title,
        changed: !baseline,
      },
      this.now(),
    );
  }

  private async runTick(force: boolean): Promise<LarkDocumentWatcherTickResult> {
    const at = this.now();
    const result: LarkDocumentWatcherTickResult = {
      at: at.toISOString(),
      claimed: 0,
      baseline: 0,
      changed: 0,
      unchanged: 0,
      staged: 0,
      duplicates: 0,
      failed: 0,
      routeIds: [],
    };
    if (this.enabled && this.available) {
      const claims = await this.workflowStore.claimDueProducerRoutes(
        {
          kind: 'lark-document',
          claimerId: this.watcherId,
          staleAfterMs: this.claimStaleMs,
          limit: this.batchSize,
          force,
        },
        at,
      );
      result.claimed = claims.length;
      for (const claim of claims) {
        result.routeIds.push(claim.route.id);
        try {
          await this.pollClaim(claim, result);
        } catch (error) {
          result.failed += 1;
          try {
            await this.workflowStore.failProducerPoll(
              {
                routeId: claim.route.id,
                claimerId: this.watcherId,
                error: errorMessage(error),
              },
              this.now(),
            );
          } catch (claimError) {
            if (errorMessage(claimError) !== 'workflow_producer_claim_lost') {
              throw claimError;
            }
          }
        }
      }
    }
    this._tickCount += 1;
    this._lastTickAt = this.now().toISOString();
    this._lastTickResult = structuredClone(result);
    return result;
  }
}
