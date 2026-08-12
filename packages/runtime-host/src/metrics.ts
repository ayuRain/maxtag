import { timingSafeEqual } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type {
  DeliveryStore,
  DeliverySummary,
} from '@opentag/delivery';
import type {
  FileRoutineStore,
  RoutineSummary,
} from '@opentag/routines';
import type {
  FileWorkflowStore,
  WorkflowSummary,
} from '@opentag/workflows';

export interface OpenTagRuntimeLoopMetrics {
  name: string;
  running: boolean;
  lastRunAt?: string;
  iterations?: number;
  lastItems?: Record<string, number>;
}

export interface OpenTagProcessMetrics {
  service: string;
  startedAt: string;
  activeRuns?: number;
  storage?: {
    driver: string;
    wal: boolean;
  };
  loops?: OpenTagRuntimeLoopMetrics[];
}

export interface OpenTagMetricsSnapshot {
  process: OpenTagProcessMetrics;
  delivery?: DeliverySummary;
  routines?: RoutineSummary;
  workflows?: WorkflowSummary;
}

export async function collectOpenTagMetricsSnapshot(input: {
  process: OpenTagProcessMetrics;
  deliveryStore: Pick<DeliveryStore, 'summarize'>;
  routineStore: Pick<FileRoutineStore, 'summarize'>;
  workflowStore: Pick<FileWorkflowStore, 'summarize'>;
}): Promise<OpenTagMetricsSnapshot> {
  const [delivery, routines, workflows] = await Promise.all([
    input.deliveryStore.summarize(),
    input.routineStore.summarize(),
    input.workflowStore.summarize(),
  ]);
  return {
    process: input.process,
    delivery,
    routines,
    workflows,
  };
}

function escapeHelp(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('\n', '\\n');
}

function escapeLabel(value: string): string {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll('\n', '\\n')
    .replaceAll('"', '\\"');
}

function labelSet(labels: Record<string, string | undefined>): string {
  const entries = Object.entries(labels)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  if (!entries.length) return '';
  return `{${entries
    .map(([name, value]) => `${name}="${escapeLabel(value)}"`)
    .join(',')}}`;
}

function numeric(value: number | undefined): string {
  return Number.isFinite(value) ? String(value) : '0';
}

function timestampSeconds(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? milliseconds / 1000 : undefined;
}

function ageSeconds(
  value: string | undefined,
  nowMilliseconds: number,
): number | undefined {
  const timestamp = timestampSeconds(value);
  return timestamp === undefined
    ? undefined
    : Math.max(0, nowMilliseconds / 1000 - timestamp);
}

class PrometheusText {
  private readonly lines: string[] = [];

  family(
    name: string,
    help: string,
    type: 'counter' | 'gauge',
    samples: Array<{
      labels?: Record<string, string | undefined>;
      value: number;
    }>,
  ): void {
    if (!samples.length) return;
    this.lines.push(`# HELP ${name} ${escapeHelp(help)}`);
    this.lines.push(`# TYPE ${name} ${type}`);
    for (const sample of samples) {
      this.lines.push(
        `${name}${labelSet(sample.labels ?? {})} ${numeric(sample.value)}`,
      );
    }
  }

  render(): string {
    return `${this.lines.join('\n')}\n`;
  }
}

function countSamples(
  counts: Record<string, number>,
  label: string,
  baseLabels: Record<string, string> = {},
): Array<{ labels: Record<string, string>; value: number }> {
  return Object.entries(counts).map(([status, value]) => ({
    labels: { ...baseLabels, [label]: status },
    value,
  }));
}

function ageSamples(
  timestamps: Partial<Record<string, string>>,
  nowMilliseconds: number,
  baseLabels: Record<string, string> = {},
): Array<{ labels: Record<string, string>; value: number }> {
  return Object.entries(timestamps).flatMap(([status, updatedAt]) => {
    const age = ageSeconds(updatedAt, nowMilliseconds);
    return age === undefined
      ? []
      : [{ labels: { ...baseLabels, status }, value: age }];
  });
}

export function renderOpenTagPrometheusMetrics(
  snapshot: OpenTagMetricsSnapshot,
  now = new Date(),
): string {
  const metrics = new PrometheusText();
  const service = snapshot.process.service;
  const startedAt = timestampSeconds(snapshot.process.startedAt);
  metrics.family('opentag_process_up', 'Whether the OpenTag process is running.', 'gauge', [
    { labels: { service }, value: 1 },
  ]);
  if (startedAt !== undefined) {
    metrics.family(
      'opentag_process_start_time_seconds',
      'Unix timestamp when the OpenTag process started.',
      'gauge',
      [{ labels: { service }, value: startedAt }],
    );
    metrics.family(
      'opentag_process_uptime_seconds',
      'OpenTag process uptime in seconds.',
      'gauge',
      [
        {
          labels: { service },
          value: Math.max(0, now.getTime() / 1000 - startedAt),
        },
      ],
    );
  }
  if (snapshot.process.activeRuns !== undefined) {
    metrics.family(
      'opentag_process_active_runs',
      'Agent runs currently executing in this process.',
      'gauge',
      [{ labels: { service }, value: snapshot.process.activeRuns }],
    );
  }
  if (snapshot.process.storage) {
    metrics.family(
      'opentag_storage_info',
      'OpenTag storage backend information.',
      'gauge',
      [
        {
          labels: {
            service,
            driver: snapshot.process.storage.driver,
            wal: String(snapshot.process.storage.wal),
          },
          value: 1,
        },
      ],
    );
  }

  const loops = snapshot.process.loops ?? [];
  metrics.family(
    'opentag_runtime_loop_running',
    'Whether an OpenTag background loop is currently executing a pass.',
    'gauge',
    loops.map((loop) => ({
      labels: { service, loop: loop.name },
      value: loop.running ? 1 : 0,
    })),
  );
  metrics.family(
    'opentag_runtime_loop_last_run_timestamp_seconds',
    'Unix timestamp of the last completed OpenTag background-loop pass.',
    'gauge',
    loops.flatMap((loop) => {
      const value = timestampSeconds(loop.lastRunAt);
      return value === undefined
        ? []
        : [{ labels: { service, loop: loop.name }, value }];
    }),
  );
  metrics.family(
    'opentag_runtime_loop_iterations_total',
    'Completed OpenTag background-loop passes since process start.',
    'counter',
    loops.flatMap((loop) =>
      loop.iterations === undefined
        ? []
        : [
            {
              labels: { service, loop: loop.name },
              value: loop.iterations,
            },
          ],
    ),
  );
  metrics.family(
    'opentag_runtime_loop_last_items',
    'Items observed in the last completed OpenTag background-loop pass.',
    'gauge',
    loops.flatMap((loop) =>
      Object.entries(loop.lastItems ?? {}).map(([result, value]) => ({
        labels: { service, loop: loop.name, result },
        value,
      })),
    ),
  );

  const delivery = snapshot.delivery;
  if (delivery) {
    metrics.family(
      'opentag_delivery_outbox_records',
      'Durable outbound delivery records by status.',
      'gauge',
      countSamples(delivery.outbox, 'status', { service }),
    );
    metrics.family(
      'opentag_delivery_outbox_oldest_age_seconds',
      'Age of the oldest outbound delivery record by status.',
      'gauge',
      ageSamples(delivery.oldestStatusUpdatedAt.outbox, now.getTime(), {
        service,
      }),
    );
    metrics.family(
      'opentag_delivery_turn_records',
      'Durable turn-delivery records by status.',
      'gauge',
      countSamples(delivery.turnDeliveries, 'status', { service }),
    );
    metrics.family(
      'opentag_delivery_turn_oldest_age_seconds',
      'Age of the oldest durable turn-delivery record by status.',
      'gauge',
      ageSamples(
        delivery.oldestStatusUpdatedAt.turnDeliveries,
        now.getTime(),
        { service },
      ),
    );
    metrics.family(
      'opentag_delivery_inbound_events',
      'Durable inbound callback records by status.',
      'gauge',
      countSamples(
        Object.fromEntries(
          Object.entries(delivery.inboundEvents).filter(
            ([status]) => status !== 'duplicates',
          ),
        ),
        'status',
        { service },
      ),
    );
    metrics.family(
      'opentag_delivery_inbound_duplicates',
      'Duplicate inbound callbacks retained in the durable ledger.',
      'gauge',
      [{ labels: { service }, value: delivery.inboundEvents.duplicates }],
    );
    metrics.family(
      'opentag_delivery_inbound_oldest_age_seconds',
      'Age of the oldest durable inbound callback by status.',
      'gauge',
      ageSamples(
        delivery.oldestStatusUpdatedAt.inboundEvents,
        now.getTime(),
        { service },
      ),
    );
    metrics.family(
      'opentag_agent_runs',
      'Durable agent runs by status.',
      'gauge',
      countSamples(delivery.agentRuns, 'status', { service }),
    );
    metrics.family(
      'opentag_agent_run_oldest_age_seconds',
      'Age of the oldest durable agent run by status.',
      'gauge',
      ageSamples(delivery.oldestStatusUpdatedAt.agentRuns, now.getTime(), {
        service,
      }),
    );
    metrics.family(
      'opentag_agent_steering',
      'Durable follow-up steering records by status.',
      'gauge',
      countSamples(delivery.steering, 'status', { service }),
    );
    metrics.family(
      'opentag_agent_steering_oldest_age_seconds',
      'Age of the oldest durable follow-up steering record by status.',
      'gauge',
      ageSamples(delivery.oldestStatusUpdatedAt.steering, now.getTime(), {
        service,
      }),
    );
    metrics.family(
      'opentag_agent_sessions',
      'Durable provider sessions by status.',
      'gauge',
      countSamples(delivery.sessions, 'status', { service }),
    );
    metrics.family(
      'opentag_agent_session_oldest_age_seconds',
      'Age of the oldest durable provider session by status.',
      'gauge',
      ageSamples(delivery.oldestStatusUpdatedAt.sessions, now.getTime(), {
        service,
      }),
    );
    metrics.family(
      'opentag_thread_bindings',
      'Configured and observed client thread bindings.',
      'gauge',
      [{ labels: { service }, value: delivery.bindings }],
    );
  }

  const routines = snapshot.routines;
  if (routines) {
    metrics.family(
      'opentag_routines',
      'Standing-work routines by enabled state.',
      'gauge',
      countSamples(routines.routines, 'state', { service }),
    );
    metrics.family(
      'opentag_routine_executions',
      'Routine executions by status.',
      'gauge',
      countSamples(routines.executions, 'status', { service }),
    );
    metrics.family(
      'opentag_routine_execution_oldest_age_seconds',
      'Age of the oldest routine execution by status.',
      'gauge',
      ageSamples(routines.oldestExecutionUpdatedAt, now.getTime(), { service }),
    );
    const nextRunAt = timestampSeconds(routines.nextRunAt);
    if (nextRunAt !== undefined) {
      metrics.family(
        'opentag_routine_next_run_timestamp_seconds',
        'Unix timestamp of the next enabled routine run.',
        'gauge',
        [{ labels: { service }, value: nextRunAt }],
      );
    }
  }

  const workflows = snapshot.workflows;
  if (workflows) {
    metrics.family(
      'opentag_workflows',
      'Workflow definitions by enabled state.',
      'gauge',
      countSamples(workflows.workflows, 'state', { service }),
    );
    metrics.family(
      'opentag_workflow_executions',
      'Workflow executions by status.',
      'gauge',
      countSamples(workflows.executions, 'status', { service }),
    );
    metrics.family(
      'opentag_workflow_execution_oldest_age_seconds',
      'Age of the oldest workflow execution by status.',
      'gauge',
      ageSamples(workflows.oldestExecutionUpdatedAt, now.getTime(), { service }),
    );
    metrics.family(
      'opentag_workflow_nodes',
      'Workflow node executions by status.',
      'gauge',
      countSamples(workflows.nodes, 'status', { service }),
    );
    metrics.family(
      'opentag_workflow_node_oldest_age_seconds',
      'Age of the oldest workflow node execution by status.',
      'gauge',
      ageSamples(workflows.oldestNodeUpdatedAt, now.getTime(), { service }),
    );
  }

  return metrics.render();
}

function safeTokenEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return (
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

function bearerToken(request: IncomingMessage): string | undefined {
  const match = /^Bearer\s+([^\s]+)$/iu.exec(request.headers.authorization || '');
  return match?.[1];
}

function sendJson(
  response: ServerResponse,
  statusCode: number,
  value: Record<string, unknown>,
): void {
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(`${JSON.stringify(value)}\n`);
}

export interface OpenTagObservabilityServer {
  host: string;
  port: number;
  close(): Promise<void>;
}

export interface OpenTagObservabilityServerOptions {
  host?: string;
  port: number;
  service: string;
  metricsToken?: string;
  health(): Record<string, unknown> | Promise<Record<string, unknown>>;
  metrics(): OpenTagMetricsSnapshot | Promise<OpenTagMetricsSnapshot>;
}

export async function startOpenTagObservabilityServer(
  options: OpenTagObservabilityServerOptions,
): Promise<OpenTagObservabilityServer> {
  const host = options.host?.trim() || '127.0.0.1';
  const token = options.metricsToken?.trim();
  const server: Server = createServer(async (request, response) => {
    try {
      const url = new URL(
        request.url || '/',
        `http://${request.headers.host || 'localhost'}`,
      );
      if (request.method === 'GET' && url.pathname === '/health') {
        sendJson(response, 200, {
          ok: true,
          service: options.service,
          ...(await options.health()),
        });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/metrics') {
        const provided = bearerToken(request);
        if (token && (!provided || !safeTokenEqual(provided, token))) {
          response.writeHead(401, {
            'content-type': 'text/plain; charset=utf-8',
            'www-authenticate': 'Bearer realm="OpenTag metrics"',
            'cache-control': 'no-store',
          });
          response.end('metrics_auth_required\n');
          return;
        }
        response.writeHead(200, {
          'content-type': 'text/plain; version=0.0.4; charset=utf-8',
          'cache-control': 'no-store',
        });
        response.end(renderOpenTagPrometheusMetrics(await options.metrics()));
        return;
      }
      sendJson(response, 404, { ok: false, error: 'not_found' });
    } catch (error) {
      sendJson(response, 503, {
        ok: false,
        error: 'observability_snapshot_failed',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : options.port;
  let closed = false;
  return {
    host,
    port,
    close: async () => {
      if (closed || !server.listening) return;
      closed = true;
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeIdleConnections?.();
      });
    },
  };
}
