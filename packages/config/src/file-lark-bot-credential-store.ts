import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export type ManagedLarkDomain = 'feishu' | 'lark';

export interface ManagedLarkBotCredential {
  revision: number;
  appId: string;
  appSecret: string;
  domain: ManagedLarkDomain;
  verificationToken?: string;
  encryptKey?: string;
  updatedAt: string;
  updatedBy: string;
}

export interface ManagedLarkBotCredentialSummary {
  configured: boolean;
  revision: number;
  appId?: string;
  domain: ManagedLarkDomain;
  verificationTokenConfigured: boolean;
  encryptionKeyConfigured: boolean;
  updatedAt?: string;
  updatedBy?: string;
}

interface EncryptedLarkBotCredentialFile {
  version: 1;
  algorithm: 'aes-256-gcm';
  iv: string;
  tag: string;
  ciphertext: string;
}

export class LarkBotCredentialRevisionConflictError extends Error {
  constructor(readonly currentRevision: number) {
    super('lark_bot_credential_revision_conflict');
    this.name = 'LarkBotCredentialRevisionConflictError';
  }
}

function normalizeAppId(value: string): string {
  const appId = value.trim();
  if (
    appId.length < 3 ||
    appId.length > 128 ||
    !/^[A-Za-z0-9_-]+$/u.test(appId)
  ) {
    throw new Error('lark_bot_invalid_app_id');
  }
  return appId;
}

function normalizeAppSecret(value: string): string {
  const appSecret = value.trim();
  if (
    appSecret.length < 8 ||
    appSecret.length > 512 ||
    /[\0\r\n]/u.test(appSecret)
  ) {
    throw new Error('lark_bot_invalid_app_secret');
  }
  return appSecret;
}

function normalizeOptionalCallbackSecret(
  value: string | undefined,
  errorCode: string,
): string | undefined {
  if (value === undefined) return undefined;
  const secret = value.trim();
  if (!secret) return undefined;
  if (secret.length > 512 || /[\0\r\n]/u.test(secret)) {
    throw new Error(errorCode);
  }
  return secret;
}

function normalizeDomain(value: string | undefined): ManagedLarkDomain {
  if (!value || value === 'feishu') return 'feishu';
  if (value === 'lark') return 'lark';
  throw new Error('lark_bot_invalid_domain');
}

function normalizeCredential(value: unknown): ManagedLarkBotCredential {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('lark_bot_credential_invalid');
  }
  const item = value as Partial<ManagedLarkBotCredential>;
  if (
    !Number.isInteger(item.revision) ||
    (item.revision ?? 0) < 1 ||
    typeof item.appId !== 'string' ||
    typeof item.appSecret !== 'string' ||
    typeof item.updatedAt !== 'string' ||
    typeof item.updatedBy !== 'string'
  ) {
    throw new Error('lark_bot_credential_invalid');
  }
  const updatedBy = item.updatedBy.replace(/[\0\r\n]/gu, '').trim();
  if (!updatedBy || updatedBy.length > 200) {
    throw new Error('lark_bot_credential_invalid_actor');
  }
  return {
    revision: item.revision as number,
    appId: normalizeAppId(item.appId),
    appSecret: normalizeAppSecret(item.appSecret),
    domain: normalizeDomain(item.domain),
    verificationToken: normalizeOptionalCallbackSecret(
      item.verificationToken,
      'lark_bot_invalid_verification_token',
    ),
    encryptKey: normalizeOptionalCallbackSecret(
      item.encryptKey,
      'lark_bot_invalid_encrypt_key',
    ),
    updatedAt: new Date(item.updatedAt).toISOString(),
    updatedBy,
  };
}

function summary(
  credential: ManagedLarkBotCredential | undefined,
): ManagedLarkBotCredentialSummary {
  return credential
    ? {
        configured: true,
        revision: credential.revision,
        appId: credential.appId,
        domain: credential.domain,
        verificationTokenConfigured: Boolean(credential.verificationToken),
        encryptionKeyConfigured: Boolean(credential.encryptKey),
        updatedAt: credential.updatedAt,
        updatedBy: credential.updatedBy,
      }
    : {
        configured: false,
        revision: 0,
        domain: 'feishu',
        verificationTokenConfigured: false,
        encryptionKeyConfigured: false,
      };
}

export class FileLarkBotCredentialStore {
  readonly stateFile: string;
  readonly keyFile: string;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(rootDir: string) {
    this.stateFile = path.join(rootDir, 'lark-bot.enc.json');
    this.keyFile = path.join(rootDir, 'lark-bot.key');
  }

  private async key(create: boolean): Promise<Buffer | undefined> {
    try {
      const value = await fs.readFile(this.keyFile);
      if (value.byteLength !== 32) throw new Error('lark_bot_key_invalid');
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
        if (existing.byteLength !== 32) throw new Error('lark_bot_key_invalid');
        return existing;
      }
    }
  }

  async get(): Promise<ManagedLarkBotCredential | undefined> {
    let encrypted: EncryptedLarkBotCredentialFile;
    try {
      encrypted = JSON.parse(await fs.readFile(this.stateFile, 'utf8')) as EncryptedLarkBotCredentialFile;
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
      throw new Error('lark_bot_credential_file_invalid');
    }
    const key = await this.key(false);
    if (!key) throw new Error('lark_bot_key_missing');
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
      return normalizeCredential(JSON.parse(plaintext));
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('lark_bot_')) throw error;
      throw new Error('lark_bot_credential_decryption_failed');
    }
  }

  async getSummary(): Promise<ManagedLarkBotCredentialSummary> {
    return summary(await this.get());
  }

  private async write(credential: ManagedLarkBotCredential): Promise<void> {
    const key = await this.key(true);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key!, iv);
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(credential), 'utf8'),
      cipher.final(),
    ]);
    const encrypted: EncryptedLarkBotCredentialFile = {
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
    appId: string;
    appSecret: string;
    domain?: ManagedLarkDomain;
    verificationToken?: string;
    encryptKey?: string;
    expectedRevision?: number;
    actor: string;
  }): Promise<ManagedLarkBotCredentialSummary> {
    let result!: ManagedLarkBotCredentialSummary;
    const operation = this.mutationQueue.then(async () => {
      const current = await this.get();
      const currentRevision = current?.revision ?? 0;
      if (
        input.expectedRevision !== undefined &&
        input.expectedRevision !== currentRevision
      ) {
        throw new LarkBotCredentialRevisionConflictError(currentRevision);
      }
      const credential = normalizeCredential({
        revision: currentRevision + 1,
        appId: input.appId,
        appSecret: input.appSecret,
        domain: input.domain,
        verificationToken: input.verificationToken,
        encryptKey: input.encryptKey,
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

  async remove(input: {
    expectedRevision?: number;
  } = {}): Promise<ManagedLarkBotCredentialSummary> {
    let result!: ManagedLarkBotCredentialSummary;
    const operation = this.mutationQueue.then(async () => {
      const current = await this.get();
      const currentRevision = current?.revision ?? 0;
      if (
        input.expectedRevision !== undefined &&
        input.expectedRevision !== currentRevision
      ) {
        throw new LarkBotCredentialRevisionConflictError(currentRevision);
      }
      try {
        await fs.unlink(this.stateFile);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      result = summary(undefined);
    });
    this.mutationQueue = operation.catch(() => {});
    await operation;
    return result;
  }
}
