import { lookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';
import {
  FileKnowledgeSourceRefreshStore,
  FileKnowledgeSourceStore,
  KnowledgeSourceRevisionConflictError,
  type KnowledgeSourceRefreshJob,
} from '@opentag/config';
import {
  extractKnowledgeContent,
  MAX_KNOWLEDGE_INPUT_BYTES,
} from './knowledge-content-extraction.js';

const SENSITIVE_HOSTS = new Set([
  'localhost', 'metadata.google.internal', 'metadata.aws.internal',
  '169.254.169.254', 'metadata',
]);

export interface KnowledgeSourceRefreshServiceOptions {
  store: FileKnowledgeSourceRefreshStore;
  knowledgeStore: FileKnowledgeSourceStore;
  workerId: string;
  enabled?: boolean;
  batchSize?: number;
  leaseMs?: number;
  retryBaseMs?: number;
  timeoutMs?: number;
  fetch?: typeof fetch;
  resolve?: (hostname: string) => Promise<string[]>;
  now?: () => Date;
}

export interface KnowledgeSourceRefreshPassResult {
  scheduled: number;
  claimed: number;
  updated: number;
  unchanged: number;
  notModified: number;
  stale: number;
  retried: number;
  failed: number;
  jobs: KnowledgeSourceRefreshJob[];
}

function privateIp(value: string): boolean {
  const normalized = value.toLowerCase();
  if (normalized.includes(':')) {
    return normalized === '::' || normalized === '::1' || normalized.startsWith('fc') ||
      normalized.startsWith('fd') || /^(?:fe[89ab])/u.test(normalized) ||
      normalized.startsWith('::ffff:127.') || normalized.startsWith('::ffff:10.') ||
      normalized.startsWith('::ffff:192.168.') || normalized.startsWith('::ffff:169.254.');
  }
  const octets = normalized.split('.').map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part))) return true;
  const [first, second] = octets;
  return first === 0 || first === 10 || first === 127 ||
    (first === 169 && second === 254) || (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) || (first === 100 && second >= 64 && second <= 127) ||
    first >= 224;
}

function approvedUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('knowledge_refresh_uri_invalid');
  }
  const host = url.hostname.toLowerCase().replace(/\.$/u, '');
  if (
    url.protocol !== 'https:' || url.username || url.password || !host ||
    isIP(host) !== 0 || SENSITIVE_HOSTS.has(host) || host.endsWith('.localhost') ||
    host.endsWith('.local') || host.endsWith('.internal')
  ) throw new Error('knowledge_refresh_host_denied');
  return url;
}

function compactError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/\s+/gu, ' ').trim().slice(0, 1_000) || 'knowledge_refresh_failed';
}

async function responseBuffer(response: Response): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > MAX_KNOWLEDGE_INPUT_BYTES) throw new Error('knowledge_refresh_response_too_large');
  if (!response.body) throw new Error('knowledge_refresh_response_empty');
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let received = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    const chunk = Buffer.from(next.value);
    received += chunk.byteLength;
    if (received > MAX_KNOWLEDGE_INPUT_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error('knowledge_refresh_response_too_large');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function pinnedHttpsFetch(
  url: URL,
  headers: Record<string, string>,
  signal: AbortSignal,
  address: string,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest({
      protocol: 'https:',
      hostname: address,
      port: url.port || 443,
      path: `${url.pathname}${url.search}`,
      method: 'GET',
      servername: url.hostname,
      headers: { ...headers, host: url.host },
      signal,
      agent: false,
    }, (response) => {
      const responseHeaders = new Headers();
      for (let index = 0; index < response.rawHeaders.length; index += 2) {
        responseHeaders.append(response.rawHeaders[index], response.rawHeaders[index + 1]);
      }
      const status = response.statusCode ?? 500;
      const body = status === 204 || status === 304
        ? null
        : Readable.toWeb(response) as ReadableStream<Uint8Array>;
      resolve(new Response(body, {
        status,
        statusText: response.statusMessage,
        headers: responseHeaders,
      }));
    });
    request.once('error', reject);
    request.end();
  });
}

export class KnowledgeSourceRefreshService {
  readonly enabled: boolean;
  private pass?: Promise<KnowledgeSourceRefreshPassResult>;
  private readonly active = new Set<AbortController>();
  private shuttingDown = false;
  private _passCount = 0;
  private _lastPassAt?: string;
  private _lastPassResult?: KnowledgeSourceRefreshPassResult;

  constructor(private readonly options: KnowledgeSourceRefreshServiceOptions) {
    this.enabled = options.enabled ?? true;
  }

  get running(): boolean {
    return Boolean(this.pass);
  }

  get passCount(): number {
    return this._passCount;
  }

  get lastPassAt(): string | undefined {
    return this._lastPassAt;
  }

  get lastPassResult(): KnowledgeSourceRefreshPassResult | undefined {
    return this._lastPassResult ? structuredClone(this._lastPassResult) : undefined;
  }

  status(): Record<string, unknown> {
    return {
      enabled: this.enabled,
      running: this.running,
      batchSize: Math.max(1, Math.min(this.options.batchSize ?? 2, 20)),
      maxInputBytes: MAX_KNOWLEDGE_INPUT_BYTES,
      passCount: this.passCount,
      lastPassAt: this.lastPassAt,
      lastPassResult: this.lastPassResult
        ? {
            scheduled: this.lastPassResult.scheduled,
            claimed: this.lastPassResult.claimed,
            updated: this.lastPassResult.updated,
            unchanged: this.lastPassResult.unchanged,
            notModified: this.lastPassResult.notModified,
            stale: this.lastPassResult.stale,
            retried: this.lastPassResult.retried,
            failed: this.lastPassResult.failed,
          }
        : undefined,
    };
  }

  beginShutdown(): void {
    this.shuttingDown = true;
    for (const controller of this.active) controller.abort('knowledge_refresh_shutdown');
  }

  async waitForIdle(): Promise<void> {
    await this.pass?.then(() => undefined, () => undefined);
  }

  async runPass(limit = this.options.batchSize ?? 2): Promise<KnowledgeSourceRefreshPassResult> {
    if (this.pass) return this.pass;
    if (!this.enabled || this.shuttingDown) return this.emptyResult();
    this.pass = this.executePass(limit);
    try {
      const result = await this.pass;
      this._passCount += 1;
      this._lastPassAt = new Date().toISOString();
      this._lastPassResult = structuredClone(result);
      return result;
    } finally {
      this.pass = undefined;
    }
  }

  private emptyResult(): KnowledgeSourceRefreshPassResult {
    return { scheduled: 0, claimed: 0, updated: 0, unchanged: 0, notModified: 0, stale: 0, retried: 0, failed: 0, jobs: [] };
  }

  private async executePass(limit: number): Promise<KnowledgeSourceRefreshPassResult> {
    const result = this.emptyResult();
    const scheduled = await this.options.store.enqueueDue({
      sources: await this.options.knowledgeStore.listScheduledRefreshSources(),
      requestedBy: this.options.workerId,
      now: this.options.now?.().toISOString(),
    });
    result.scheduled = scheduled.queued.length;
    const claimed = await this.options.store.claim({
      workerId: this.options.workerId,
      limit: Math.max(1, Math.min(limit, 20)),
      leaseMs: this.options.leaseMs,
    });
    result.claimed = claimed.length;
    for (const job of claimed) {
      if (this.shuttingDown) break;
      let terminal: KnowledgeSourceRefreshJob;
      try {
        terminal = await this.refresh(job);
      } catch (error) {
        const message = compactError(error);
        if (
          error instanceof KnowledgeSourceRevisionConflictError ||
          message === 'knowledge_source_not_found' || message === 'knowledge_source_disabled'
        ) {
          terminal = await this.options.store.stale({
            id: job.id, workerId: this.options.workerId, error: message,
          });
        } else {
          const retryBaseMs = Math.max(1_000, Math.min(this.options.retryBaseMs ?? 5_000, 300_000));
          terminal = await this.options.store.retry({
            id: job.id, workerId: this.options.workerId, error: message,
            retryAfterMs: retryBaseMs * 2 ** Math.max(0, job.attempts - 1),
          });
        }
      }
      result.jobs.push(terminal);
      if (terminal.status === 'completed') {
        if (terminal.outcome === 'updated') result.updated += 1;
        else if (terminal.outcome === 'not-modified') result.notModified += 1;
        else result.unchanged += 1;
      } else if (terminal.status === 'stale') result.stale += 1;
      else if (terminal.status === 'failed') result.failed += 1;
      else result.retried += 1;
    }
    return result;
  }

  private async publicAddresses(hostname: string): Promise<string[]> {
    const addresses = this.options.resolve
      ? await this.options.resolve(hostname)
      : (await lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address);
    if (
      !addresses.length ||
      addresses.some((address) => isIP(address) === 0 || privateIp(address))
    ) throw new Error('knowledge_refresh_host_resolves_private');
    return addresses;
  }

  private async refresh(job: KnowledgeSourceRefreshJob): Promise<KnowledgeSourceRefreshJob> {
    const currentSource = await this.options.knowledgeStore.get(job.workspaceId, job.sourceId);
    if (
      !currentSource || currentSource.kind !== 'url' || !currentSource.enabled ||
      currentSource.revision !== job.sourceRevision || currentSource.sourceUri !== job.sourceUri
    ) {
      throw new KnowledgeSourceRevisionConflictError(currentSource?.revision ?? 0);
    }
    const controller = new AbortController();
    this.active.add(controller);
    const timeout = setTimeout(
      () => controller.abort('knowledge_refresh_timeout'),
      Math.max(1_000, Math.min(this.options.timeoutMs ?? 30_000, 120_000)),
    );
    timeout.unref?.();
    try {
      let current = approvedUrl(job.sourceUri);
      const originalOrigin = current.origin;
      for (let redirects = 0; redirects <= 5; redirects += 1) {
        const addresses = await this.publicAddresses(current.hostname);
        const headers: Record<string, string> = {
          accept: 'text/plain,text/markdown,text/html,application/json,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document;q=0.9',
          'user-agent': 'opentag-knowledge-refresh/0.1',
        };
        if (job.etag) headers['if-none-match'] = job.etag;
        if (job.lastModified) headers['if-modified-since'] = job.lastModified;
        const response = this.options.fetch
          ? await this.options.fetch(current, {
            method: 'GET', redirect: 'manual', headers, signal: controller.signal,
          })
          : await pinnedHttpsFetch(current, headers, controller.signal, addresses[0]);
        if (response.status === 304) {
          return this.options.store.complete({
            id: job.id, workerId: this.options.workerId, outcome: 'not-modified',
            resolvedUri: current.href, sourceRevision: currentSource.revision,
            contentHash: currentSource.contentHash, mediaType: currentSource.mediaType,
            extractor: currentSource.extraction?.extractor,
            inputBytes: currentSource.extraction?.inputBytes,
            etag: response.headers.get('etag') || job.etag,
            lastModified: response.headers.get('last-modified') || job.lastModified,
          });
        }
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get('location');
          if (!location) throw new Error(`knowledge_refresh_http_${response.status}:redirect_missing`);
          const next = approvedUrl(new URL(location, current).href);
          if (next.origin !== originalOrigin) throw new Error('knowledge_refresh_cross_origin_redirect_denied');
          await response.body?.cancel().catch(() => undefined);
          current = next;
          continue;
        }
        if (!response.ok) throw new Error(`knowledge_refresh_http_${response.status}`);
        const responseMediaType = response.headers.get('content-type') || '';
        const buffer = await responseBuffer(response);
        const extracted = await extractKnowledgeContent({
          buffer,
          mediaType: responseMediaType,
          fileName: current.pathname.split('/').filter(Boolean).at(-1),
        });
        const applied = await this.options.knowledgeStore.applyRemoteRefresh({
          workspaceId: job.workspaceId, id: job.sourceId,
          expectedRevision: job.sourceRevision, expectedSourceUri: job.sourceUri,
          content: extracted.content, mediaType: extracted.mediaType,
          extraction: extracted.extraction,
          actor: `knowledge-refresh:${job.requestedBy}`,
        });
        return this.options.store.complete({
          id: job.id, workerId: this.options.workerId,
          outcome: applied.changed ? 'updated' : 'unchanged',
          resolvedUri: current.href, sourceRevision: applied.source.revision,
          contentHash: applied.source.contentHash, mediaType: extracted.extraction.sourceMediaType,
          extractor: extracted.extraction.extractor, inputBytes: extracted.extraction.inputBytes,
          etag: response.headers.get('etag') || undefined,
          lastModified: response.headers.get('last-modified') || undefined,
        });
      }
      throw new Error('knowledge_refresh_redirect_limit_exceeded');
    } finally {
      clearTimeout(timeout);
      this.active.delete(controller);
    }
  }
}
