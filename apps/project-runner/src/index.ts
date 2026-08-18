import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { GitHubAppInstallationTokenProvider } from '@opentag/platform-github';
import { startProjectRunnerServer } from '@opentag/project-runner';

function numberEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function githubTokenProvider(): GitHubAppInstallationTokenProvider | undefined {
  const appId = process.env.OPENTAG_GITHUB_APP_ID?.trim();
  const installationId = process.env.OPENTAG_GITHUB_APP_INSTALLATION_ID?.trim();
  const privateKeyFile = process.env.OPENTAG_GITHUB_APP_PRIVATE_KEY_FILE?.trim();
  if (!appId && !installationId && !privateKeyFile) return undefined;
  if (!appId || !installationId || !privateKeyFile) {
    throw new Error('project_runner_github_app_incomplete');
  }
  return new GitHubAppInstallationTokenProvider({
    appId,
    installationId,
    privateKeyFile,
    baseUrl: process.env.OPENTAG_GITHUB_BASE_URL,
  });
}

function run(command: string, args: string[], env: Record<string, string>): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${String(chunk)}`.slice(-4_096);
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(
        `project_runner_buildx_prepare_failed:${code ?? signal ?? 'unknown'}:${stderr.trim()}`,
      ));
    });
  });
}

async function prepareBuildRuntime(input: {
  home: string;
  command: string;
  env: Record<string, string>;
  signal: AbortSignal;
}): Promise<void> {
  const buildkitHost = process.env.OPENTAG_PROJECT_RUNNER_BUILDKIT_HOST?.trim();
  if (!buildkitHost) return;
  const dockerConfig = path.join(input.home, '.docker');
  await fs.mkdir(dockerConfig, { recursive: true, mode: 0o700 });
  const registryConfig = process.env.OPENTAG_PROJECT_RUNNER_REGISTRY_CONFIG_FILE?.trim();
  if (registryConfig) {
    // Several tool calls may prepare the same long-lived Project home at the
    // same time. Never copy directly over the shared Docker config: concurrent
    // truncate/chmod operations previously surfaced as intermittent EACCES.
    const destination = path.join(dockerConfig, 'config.json');
    const temporary = path.join(
      dockerConfig,
      `.config.json.${process.pid}.${randomUUID()}.tmp`,
    );
    try {
      await fs.copyFile(registryConfig, temporary);
      await fs.chmod(temporary, 0o600);
      await fs.rename(temporary, destination);
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
    }
  }
  input.env.DOCKER_CONFIG = dockerConfig;
  input.env.BUILDKIT_HOST = buildkitHost;
  input.env.DOCKER_BUILDKIT = '1';
  const marker = path.join(dockerConfig, '.maxtag-buildx-ready');
  if (await fs.stat(marker).then(() => true).catch(() => false)) return;
  try {
    await run('docker', ['buildx', 'inspect', 'maxtag'], input.env);
  } catch {
    await run(
      'docker',
      ['buildx', 'create', '--name', 'maxtag', '--driver', 'remote', buildkitHost],
      input.env,
    );
  }
  await run('docker', ['buildx', 'use', 'maxtag'], input.env);
  let lastError: unknown;
  for (let attempt = 0; attempt < 30 && !input.signal.aborted; attempt += 1) {
    try {
      await run('docker', ['buildx', 'inspect', '--bootstrap', 'maxtag'], input.env);
      await fs.writeFile(marker, `${new Date().toISOString()}\n`, { mode: 0o600 });
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
  throw lastError ?? new Error('project_runner_buildkit_unavailable');
}

const github = githubTokenProvider();

const server = startProjectRunnerServer({
  workspaceRoot: process.env.OPENTAG_PROJECT_RUNNER_WORKSPACE_ROOT || '/srv/opentag/workspaces',
  token: process.env.OPENTAG_PROJECT_RUNNER_TOKEN || '',
  allowedCommands: (process.env.OPENTAG_PROJECT_RUNNER_COMMANDS || '*')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
  host: process.env.OPENTAG_PROJECT_RUNNER_HOST || '0.0.0.0',
  port: numberEnv('OPENTAG_PROJECT_RUNNER_PORT', 3081),
  maxTimeoutMs: numberEnv(
    'OPENTAG_PROJECT_RUNNER_MAX_TIMEOUT_MS',
    2 * 60 * 60_000,
  ),
  maxOutputBytes: numberEnv('OPENTAG_PROJECT_RUNNER_MAX_OUTPUT_BYTES', 512 * 1_024),
  homeRoot: process.env.OPENTAG_PROJECT_RUNNER_HOME_ROOT,
  async environment({ home }) {
    const env: Record<string, string | undefined> = {
      DOCKER_CONFIG: path.join(home, '.docker'),
      BUILDKIT_HOST: process.env.OPENTAG_PROJECT_RUNNER_BUILDKIT_HOST,
      DOCKER_BUILDKIT: process.env.OPENTAG_PROJECT_RUNNER_BUILDKIT_HOST ? '1' : undefined,
      GIT_ASKPASS: process.env.OPENTAG_PROJECT_RUNNER_GIT_ASKPASS,
      GIT_TERMINAL_PROMPT: '0',
      MAXTAG_MAXHANDSV2_RUNTIME_ENV:
        process.env.OPENTAG_PROJECT_RUNNER_MAXHANDSV2_RUNTIME_ENV_FILE,
    };
    if (github) {
      try {
        const token = await github.getToken();
        env.GITHUB_TOKEN = token;
        env.GH_TOKEN = token;
      } catch (error) {
        process.stderr.write(`${JSON.stringify({
          at: new Date().toISOString(),
          service: 'opentag-project-runner',
          event: 'github_token_unavailable',
          error: error instanceof Error ? error.message : 'unknown',
        })}\n`);
      }
    }
    return env;
  },
  prepare: prepareBuildRuntime,
});

const stop = (): void => {
  server.close(() => process.exit(0));
};
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
