import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export type ManagedExecutorProvider = 'codex' | 'claude';
export type ManagedExecutorAuthMode = 'cli' | 'api-key';

export interface ManagedExecutorCredential {
  revision: number;
  provider: ManagedExecutorProvider;
  authMode: ManagedExecutorAuthMode;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  updatedAt: string;
  updatedBy: string;
}

export interface ManagedExecutorCredentialSummary {
  configured: boolean;
  revision: number;
  provider: ManagedExecutorProvider;
  authMode: ManagedExecutorAuthMode;
  model?: string;
  baseUrl?: string;
  hasApiKey: boolean;
  updatedAt?: string;
  updatedBy?: string;
}

export interface ManagedExecutorRuntimeSettings {
  mode: 'local-cli';
  sessionMode: 'provider' | 'transcript';
  defaultExecutorId: ManagedExecutorProvider;
  enabledExecutorIds: ManagedExecutorProvider[];
  codexModel?: string;
  codexCommandPrefixArgs?: string[];
  codexEnvironment?: Record<string, string>;
  claudeModel?: string;
  claudeEnvironment?: Record<string, string>;
}

interface EncryptedExecutorCredentialFile {
  version: 1;
  algorithm: 'aes-256-gcm';
  iv: string;
  tag: string;
  ciphertext: string;
}

export class ExecutorCredentialRevisionConflictError extends Error {
  constructor(readonly currentRevision: number) {
    super('executor_credential_revision_conflict');
    this.name = 'ExecutorCredentialRevisionConflictError';
  }
}

function provider(value: unknown): ManagedExecutorProvider {
  if (value === 'codex' || value === 'claude') return value;
  throw new Error('executor_invalid_provider');
}

function authMode(value: unknown): ManagedExecutorAuthMode {
  if (value === 'cli' || value === 'api-key') return value;
  throw new Error('executor_invalid_auth_mode');
}

function optionalModel(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (
    typeof value !== 'string' ||
    value.length > 160 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u.test(value)
  ) {
    throw new Error('executor_invalid_model');
  }
  return value;
}

export function normalizeManagedExecutorBaseUrl(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || value.length > 500) {
    throw new Error('executor_invalid_base_url');
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('executor_invalid_base_url');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.hash ||
    !url.hostname
  ) {
    throw new Error('executor_invalid_base_url');
  }
  url.pathname = url.pathname.replace(/\/+$/u, '') || '/';
  url.search = '';
  return url.toString().replace(/\/$/u, '');
}

function optionalApiKey(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (
    typeof value !== 'string' ||
    value.length < 8 ||
    value.length > 4096 ||
    /[\0\r\n]/u.test(value)
  ) {
    throw new Error('executor_invalid_api_key');
  }
  return value;
}

function normalize(value: unknown): ManagedExecutorCredential {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('executor_credential_invalid');
  }
  const item = value as Partial<ManagedExecutorCredential>;
  if (
    !Number.isInteger(item.revision) ||
    (item.revision ?? 0) < 1 ||
    typeof item.updatedAt !== 'string' ||
    typeof item.updatedBy !== 'string'
  ) {
    throw new Error('executor_credential_invalid');
  }
  const normalizedProvider = provider(item.provider);
  const normalizedAuthMode = authMode(item.authMode);
  const apiKey = optionalApiKey(item.apiKey);
  if (normalizedAuthMode === 'api-key' && !apiKey) {
    throw new Error('executor_api_key_required');
  }
  const updatedBy = item.updatedBy.replace(/[\0\r\n]/gu, '').trim();
  if (!updatedBy || updatedBy.length > 200) {
    throw new Error('executor_credential_invalid_actor');
  }
  return {
    revision: item.revision as number,
    provider: normalizedProvider,
    authMode: normalizedAuthMode,
    model: optionalModel(item.model),
    baseUrl: normalizeManagedExecutorBaseUrl(item.baseUrl),
    apiKey,
    updatedAt: new Date(item.updatedAt).toISOString(),
    updatedBy,
  };
}

function summary(
  credential?: ManagedExecutorCredential,
): ManagedExecutorCredentialSummary {
  return credential
    ? {
        configured: true,
        revision: credential.revision,
        provider: credential.provider,
        authMode: credential.authMode,
        model: credential.model,
        baseUrl: credential.baseUrl,
        hasApiKey: Boolean(credential.apiKey),
        updatedAt: credential.updatedAt,
        updatedBy: credential.updatedBy,
      }
    : {
        configured: false,
        revision: 0,
        provider: 'codex',
        authMode: 'cli',
        hasApiKey: false,
      };
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

export function managedExecutorRuntimeSettings(
  credential: ManagedExecutorCredential,
): ManagedExecutorRuntimeSettings {
  const shared = {
    mode: 'local-cli' as const,
    // The Project is the long-lived Agent boundary. Keep the provider-owned
    // conversation when the selected CLI supports resume, while MaxTag's
    // durable Project transcript remains the restart/context-loss fallback.
    sessionMode: 'provider' as const,
    defaultExecutorId: credential.provider,
    enabledExecutorIds: [credential.provider],
  };
  if (credential.provider === 'codex') {
    if (credential.authMode === 'cli') {
      return { ...shared, codexModel: credential.model };
    }
    const baseUrl = credential.baseUrl || 'https://api.openai.com/v1';
    return {
      ...shared,
      codexModel: credential.model || 'gpt-5.5',
      codexEnvironment: {
        MAXTAG_EXECUTOR_API_KEY: credential.apiKey!,
      },
      codexCommandPrefixArgs: [
        '-c',
        `model_provider=${tomlString('maxtag_managed')}`,
        '-c',
        `model_providers.maxtag_managed.name=${tomlString('MaxTag managed API')}`,
        '-c',
        `model_providers.maxtag_managed.base_url=${tomlString(baseUrl)}`,
        '-c',
        `model_providers.maxtag_managed.wire_api=${tomlString('responses')}`,
        '-c',
        `model_providers.maxtag_managed.env_key=${tomlString('MAXTAG_EXECUTOR_API_KEY')}`,
      ],
    };
  }
  return {
    ...shared,
    claudeModel: credential.model,
    claudeEnvironment: credential.authMode === 'api-key'
      ? {
          ANTHROPIC_API_KEY: credential.apiKey!,
          ...(credential.baseUrl ? { ANTHROPIC_BASE_URL: credential.baseUrl } : {}),
        }
      : undefined,
  };
}

export class FileExecutorCredentialStore {
  readonly stateFile: string;
  readonly keyFile: string;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(rootDir: string) {
    this.stateFile = path.join(rootDir, 'executor.enc.json');
    this.keyFile = path.join(rootDir, 'executor.key');
  }

  private async key(create: boolean): Promise<Buffer | undefined> {
    try {
      const value = await fs.readFile(this.keyFile);
      if (value.byteLength !== 32) throw new Error('executor_key_invalid');
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (!create) return undefined;
      await fs.mkdir(path.dirname(this.keyFile), { recursive: true, mode: 0o700 });
      const value = randomBytes(32);
      try {
        await fs.writeFile(this.keyFile, value, { flag: 'wx', mode: 0o600 });
        return value;
      } catch (writeError) {
        if ((writeError as NodeJS.ErrnoException).code !== 'EEXIST') throw writeError;
        const existing = await fs.readFile(this.keyFile);
        if (existing.byteLength !== 32) throw new Error('executor_key_invalid');
        return existing;
      }
    }
  }

  async get(): Promise<ManagedExecutorCredential | undefined> {
    let encrypted: EncryptedExecutorCredentialFile;
    try {
      encrypted = JSON.parse(
        await fs.readFile(this.stateFile, 'utf8'),
      ) as EncryptedExecutorCredentialFile;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    if (
      encrypted.version !== 1 ||
      encrypted.algorithm !== 'aes-256-gcm' ||
      typeof encrypted.iv !== 'string' ||
      typeof encrypted.tag !== 'string' ||
      typeof encrypted.ciphertext !== 'string'
    ) {
      throw new Error('executor_credential_file_invalid');
    }
    const key = await this.key(false);
    if (!key) throw new Error('executor_key_missing');
    try {
      const decipher = createDecipheriv(
        'aes-256-gcm',
        key,
        Buffer.from(encrypted.iv, 'base64url'),
      );
      decipher.setAuthTag(Buffer.from(encrypted.tag, 'base64url'));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(encrypted.ciphertext, 'base64url')),
        decipher.final(),
      ]).toString('utf8');
      return normalize(JSON.parse(plaintext));
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('executor_')) throw error;
      throw new Error('executor_credential_decryption_failed');
    }
  }

  async getSummary(): Promise<ManagedExecutorCredentialSummary> {
    return summary(await this.get());
  }

  private async write(credential: ManagedExecutorCredential): Promise<void> {
    const key = await this.key(true);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key!, iv);
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(credential), 'utf8'),
      cipher.final(),
    ]);
    const encrypted: EncryptedExecutorCredentialFile = {
      version: 1,
      algorithm: 'aes-256-gcm',
      iv: iv.toString('base64url'),
      tag: cipher.getAuthTag().toString('base64url'),
      ciphertext: ciphertext.toString('base64url'),
    };
    await fs.mkdir(path.dirname(this.stateFile), { recursive: true, mode: 0o700 });
    const temporary = `${this.stateFile}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(encrypted, null, 2)}\n`, {
      mode: 0o600,
    });
    await fs.rename(temporary, this.stateFile);
    await fs.chmod(this.stateFile, 0o600);
  }

  async save(input: {
    provider: ManagedExecutorProvider;
    authMode: ManagedExecutorAuthMode;
    model?: string;
    baseUrl?: string;
    apiKey?: string;
    expectedRevision?: number;
    actor: string;
  }): Promise<ManagedExecutorCredentialSummary> {
    let result!: ManagedExecutorCredentialSummary;
    const operation = this.mutationQueue.then(async () => {
      const current = await this.get();
      const currentRevision = current?.revision ?? 0;
      if (
        input.expectedRevision !== undefined &&
        input.expectedRevision !== currentRevision
      ) {
        throw new ExecutorCredentialRevisionConflictError(currentRevision);
      }
      const credential = normalize({
        revision: currentRevision + 1,
        provider: input.provider,
        authMode: input.authMode,
        model: input.model,
        baseUrl: input.baseUrl,
        apiKey: input.authMode === 'api-key' ? input.apiKey : undefined,
        updatedAt: new Date().toISOString(),
        updatedBy: input.actor,
      });
      await this.write(credential);
      result = summary(credential);
    });
    this.mutationQueue = operation.catch(() => {});
    await operation;
    return result;
  }

  async remove(input: { expectedRevision?: number } = {}): Promise<ManagedExecutorCredentialSummary> {
    let result!: ManagedExecutorCredentialSummary;
    const operation = this.mutationQueue.then(async () => {
      const current = await this.get();
      const currentRevision = current?.revision ?? 0;
      if (
        input.expectedRevision !== undefined &&
        input.expectedRevision !== currentRevision
      ) {
        throw new ExecutorCredentialRevisionConflictError(currentRevision);
      }
      try {
        await fs.unlink(this.stateFile);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      result = summary();
    });
    this.mutationQueue = operation.catch(() => {});
    await operation;
    return result;
  }
}
