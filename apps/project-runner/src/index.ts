import { startProjectRunnerServer } from '@opentag/project-runner';

function numberEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const server = startProjectRunnerServer({
  workspaceRoot: process.env.OPENTAG_PROJECT_RUNNER_WORKSPACE_ROOT || '/srv/opentag/workspaces',
  token: process.env.OPENTAG_PROJECT_RUNNER_TOKEN || '',
  allowedCommands: (process.env.OPENTAG_PROJECT_RUNNER_COMMANDS || '*')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
  host: process.env.OPENTAG_PROJECT_RUNNER_HOST || '0.0.0.0',
  port: numberEnv('OPENTAG_PROJECT_RUNNER_PORT', 3081),
  maxTimeoutMs: numberEnv('OPENTAG_PROJECT_RUNNER_MAX_TIMEOUT_MS', 600_000),
  maxOutputBytes: numberEnv('OPENTAG_PROJECT_RUNNER_MAX_OUTPUT_BYTES', 512 * 1_024),
});

const stop = (): void => {
  server.close(() => process.exit(0));
};
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
