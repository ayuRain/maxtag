import { createSign } from 'node:crypto';
import fs from 'node:fs/promises';

export interface GitHubTokenProvider {
  getToken(): Promise<string>;
}

export interface GitHubAppInstallationTokenProviderOptions {
  appId: string | number;
  installationId: string | number;
  privateKey?: string;
  privateKeyFile?: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  now?: () => Date;
}

interface InstallationTokenResponse {
  token?: string;
  expires_at?: string;
  message?: string;
}

function positiveInteger(value: string | number, code: string): string {
  const normalized = String(value).trim();
  if (!/^[1-9][0-9]*$/u.test(normalized)) throw new Error(code);
  return normalized;
}

function base64Url(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url');
}

function safeErrorMessage(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  const message = (value as Record<string, unknown>).message;
  return typeof message === 'string'
    ? message.replace(/[\0\r\n]/gu, ' ').trim().slice(0, 240)
    : '';
}

export class GitHubAppInstallationTokenProvider implements GitHubTokenProvider {
  readonly appId: string;
  readonly installationId: string;
  readonly baseUrl: string;
  private readonly privateKey?: string;
  private readonly privateKeyFile?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private cached?: { token: string; refreshAt: number };
  private refreshing?: Promise<string>;

  constructor(options: GitHubAppInstallationTokenProviderOptions) {
    this.appId = positiveInteger(options.appId, 'github_app_id_invalid');
    this.installationId = positiveInteger(
      options.installationId,
      'github_app_installation_id_invalid',
    );
    const privateKey = options.privateKey?.trim();
    const privateKeyFile = options.privateKeyFile?.trim();
    if (Boolean(privateKey) === Boolean(privateKeyFile)) {
      throw new Error('github_app_private_key_source_invalid');
    }
    this.privateKey = privateKey;
    this.privateKeyFile = privateKeyFile;
    this.baseUrl = (options.baseUrl || 'https://api.github.com').replace(/\/+$/u, '');
    const parsedBaseUrl = new URL(this.baseUrl);
    if (parsedBaseUrl.protocol !== 'https:' || parsedBaseUrl.username || parsedBaseUrl.password) {
      throw new Error('github_app_base_url_invalid');
    }
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? (() => new Date());
  }

  async getToken(): Promise<string> {
    const timestamp = this.now().getTime();
    if (this.cached && timestamp < this.cached.refreshAt) return this.cached.token;
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.exchangeToken().finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  invalidate(): void {
    this.cached = undefined;
  }

  private async loadPrivateKey(): Promise<string> {
    const value = this.privateKey ?? await fs.readFile(this.privateKeyFile!, 'utf8');
    const normalized = value.trim();
    if (
      normalized.length < 64 ||
      normalized.length > 64 * 1024 ||
      !normalized.includes('PRIVATE KEY-----')
    ) {
      throw new Error('github_app_private_key_invalid');
    }
    return normalized;
  }

  private async appJwt(): Promise<string> {
    const nowSeconds = Math.floor(this.now().getTime() / 1_000);
    const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const payload = base64Url(JSON.stringify({
      iat: nowSeconds - 60,
      exp: nowSeconds + 9 * 60,
      iss: this.appId,
    }));
    const unsigned = `${header}.${payload}`;
    const signer = createSign('RSA-SHA256');
    signer.update(unsigned);
    signer.end();
    const signature = signer.sign(await this.loadPrivateKey()).toString('base64url');
    return `${unsigned}.${signature}`;
  }

  private async exchangeToken(): Promise<string> {
    const response = await this.fetchImpl(
      `${this.baseUrl}/app/installations/${encodeURIComponent(this.installationId)}/access_tokens`,
      {
        method: 'POST',
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${await this.appJwt()}`,
          'content-type': 'application/json; charset=utf-8',
          'user-agent': 'MaxTag',
          'x-github-api-version': '2022-11-28',
        },
        body: '{}',
      },
    );
    const text = await response.text();
    let parsed: InstallationTokenResponse = {};
    try {
      parsed = text ? JSON.parse(text) as InstallationTokenResponse : {};
    } catch {
      // The raw body may contain deployment details; never include it in errors.
    }
    if (!response.ok) {
      const detail = safeErrorMessage(parsed);
      throw new Error(
        `github_app_token_exchange_http_${response.status}${detail ? `:${detail}` : ''}`,
      );
    }
    const token = parsed.token?.trim();
    const expiresAt = Date.parse(parsed.expires_at || '');
    const timestamp = this.now().getTime();
    if (!token || token.length > 2_000 || !Number.isFinite(expiresAt)) {
      throw new Error('github_app_token_exchange_invalid_response');
    }
    if (expiresAt <= timestamp + 60_000) {
      throw new Error('github_app_token_exchange_expiry_invalid');
    }
    this.cached = {
      token,
      refreshAt: Math.max(timestamp + 30_000, expiresAt - 5 * 60_000),
    };
    return token;
  }
}
