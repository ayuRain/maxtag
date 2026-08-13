import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { SourceAttachment, SourceMessage, SourceThread } from '@opentag/core';

const DEFAULT_MAX_CONTENT_BYTES = 30 * 1024 * 1024;

export interface ManagedContentStoreOptions {
  rootDir: string;
  maxBytes?: number;
}

export interface ManagedAttachmentInput {
  thread: SourceThread;
  message: SourceMessage;
  attachment: SourceAttachment;
  bytes: Uint8Array;
  mimeType?: string;
  name?: string;
  source: 'lark' | 'telegram' | 'slack' | 'client';
}

export class ManagedContentError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, message: string, statusCode = 422) {
    super(message);
    this.name = 'ManagedContentError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function scopeSegment(value: string | undefined, fallback: string): string {
  const source = value?.trim() || fallback;
  const readable = source.replace(/[^a-zA-Z0-9_.-]/gu, '_').slice(0, 48) || fallback;
  return `${readable}-${sha256(source).slice(0, 10)}`;
}

export function safeContentFilename(value: string | undefined, fallback = 'attachment'): string {
  const basename = path.basename(value?.trim() || fallback);
  const cleaned = basename
    .replace(/[\u0000-\u001f\u007f/\\]/gu, '_')
    .replace(/^\.+/u, '')
    .trim()
    .slice(0, 180);
  return cleaned && cleaned !== '.' && cleaned !== '..' ? cleaned : fallback;
}

export function pathIsWithin(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function ensureScopedDirectory(
  root: string,
  parent: string,
  segment: string,
): Promise<string> {
  const candidate = path.join(parent, segment);
  await fs.mkdir(candidate, { recursive: true, mode: 0o700 });
  const resolved = await fs.realpath(candidate);
  if (!pathIsWithin(root, resolved)) {
    throw new ManagedContentError(
      'attachment_path_invalid',
      'Managed attachment directory escaped the content root.',
      400,
    );
  }
  return resolved;
}

function contentBase64(
  value: string,
  maxBytes: number,
): { bytes: Uint8Array; mimeType?: string } {
  const trimmed = value.trim();
  const dataUrl = /^data:([^;,]+)?;base64,([a-zA-Z0-9+/=\r\n]+)$/u.exec(trimmed);
  const encoded = (dataUrl?.[2] || trimmed).replace(/\s+/gu, '');
  if (!encoded || !/^[a-zA-Z0-9+/]*={0,2}$/u.test(encoded) || encoded.length % 4 === 1) {
    throw new ManagedContentError(
      'attachment_base64_invalid',
      'Client attachment contentBase64 is not valid base64.',
      400,
    );
  }
  if (encoded.length > Math.ceil(maxBytes / 3) * 4 + 4) {
    throw new ManagedContentError(
      'attachment_too_large',
      `Client attachment exceeds the ${maxBytes} byte limit.`,
      413,
    );
  }
  return {
    bytes: new Uint8Array(Buffer.from(encoded, 'base64')),
    mimeType: dataUrl?.[1],
  };
}

async function writeImmutable(
  target: string,
  bytes: Uint8Array,
  digest: string,
): Promise<void> {
  try {
    const handle = await fs.open(
      target,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0),
    );
    let existing: Buffer;
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) {
        throw new ManagedContentError(
          'managed_content_integrity_error',
          'Existing managed content is not a regular file.',
          409,
        );
      }
      existing = await handle.readFile();
    } finally {
      await handle.close();
    }
    if (sha256(existing) !== digest) {
      throw new ManagedContentError(
        'managed_content_integrity_error',
        'Existing managed content does not match its content-addressed path.',
        409,
      );
    }
    return;
  } catch (error) {
    if (error instanceof ManagedContentError) throw error;
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const temporary = `${target}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
  try {
    await fs.link(temporary, target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    await writeImmutable(target, bytes, digest);
  } finally {
    await fs.unlink(temporary).catch(() => undefined);
  }
}

export class ManagedContentStore {
  readonly rootDir: string;
  readonly maxBytes: number;

  constructor(options: ManagedContentStoreOptions) {
    this.rootDir = path.resolve(options.rootDir);
    this.maxBytes = Math.max(1, options.maxBytes ?? DEFAULT_MAX_CONTENT_BYTES);
  }

  async materializeClientAttachment(input: {
    thread: SourceThread;
    message: SourceMessage;
    attachment: SourceAttachment;
  }): Promise<SourceAttachment> {
    const encoded = input.attachment.metadata?.clientContentBase64;
    if (input.attachment.metadata?.clientLocalPathRejected) {
      throw new ManagedContentError(
        'attachment_local_path_not_allowed',
        'Generic clients cannot submit host localPath values. Upload contentBase64 instead.',
        400,
      );
    }
    if (typeof encoded !== 'string') {
      return input.attachment;
    }
    const decoded = contentBase64(encoded, this.maxBytes);
    return this.materializeAttachment({
      ...input,
      bytes: decoded.bytes,
      mimeType: input.attachment.mimeType || decoded.mimeType,
      source: 'client',
    });
  }

  async materializeAttachment(input: ManagedAttachmentInput): Promise<SourceAttachment> {
    const bytes = new Uint8Array(input.bytes);
    if (!bytes.byteLength) {
      throw new ManagedContentError(
        'attachment_empty',
        `Attachment ${input.attachment.name || input.attachment.id} is empty.`,
        400,
      );
    }
    if (bytes.byteLength > this.maxBytes) {
      throw new ManagedContentError(
        'attachment_too_large',
        `Attachment ${input.attachment.name || input.attachment.id} exceeds the ${this.maxBytes} byte limit.`,
        413,
      );
    }

    const digest = sha256(bytes);
    const filename = safeContentFilename(
      input.name || input.attachment.name,
      `${input.attachment.kind}-${digest.slice(0, 12)}`,
    );
    const scopeSegments = [
      'inputs',
      scopeSegment(input.thread.workspaceId, 'workspace'),
      scopeSegment(input.thread.projectId, 'project'),
      scopeSegment(input.thread.id, 'thread'),
      scopeSegment(input.message.id, 'message'),
    ];
    const directory = path.join(this.rootDir, ...scopeSegments);
    await fs.mkdir(this.rootDir, { recursive: true, mode: 0o700 });
    const resolvedRoot = await fs.realpath(this.rootDir);
    let resolvedDirectory = resolvedRoot;
    for (const segment of scopeSegments) {
      resolvedDirectory = await ensureScopedDirectory(
        resolvedRoot,
        resolvedDirectory,
        segment,
      );
    }
    const managedName = `${digest.slice(0, 16)}-${filename}`;
    const target = path.join(directory, managedName);
    const resolvedTarget = path.join(resolvedDirectory, managedName);
    await writeImmutable(resolvedTarget, bytes, digest);

    const metadata = { ...(input.attachment.metadata ?? {}) };
    delete metadata.clientIngress;
    delete metadata.clientContentBase64;
    delete metadata.clientLocalPathRejected;
    delete metadata.clientUrlRejected;
    return {
      ...input.attachment,
      name: filename,
      mimeType: input.mimeType || input.attachment.mimeType,
      sizeBytes: bytes.byteLength,
      localPath: target,
      metadata: {
        ...metadata,
        managed: true,
        source: input.source,
        sha256: digest,
        workspaceId: input.thread.workspaceId,
        projectId: input.thread.projectId,
        threadId: input.thread.id,
        messageId: input.message.id,
      },
    };
  }
}
