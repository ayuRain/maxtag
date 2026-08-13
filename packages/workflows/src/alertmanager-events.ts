import { createHash } from 'node:crypto';

export const ALERTMANAGER_WORKFLOW_EVENT_CATALOG = [
  { value: 'alertmanager.firing', label: 'Alertmanager / Firing' },
  { value: 'alertmanager.resolved', label: 'Alertmanager / Resolved' },
] as const;

export interface AlertmanagerWorkflowEvent {
  provider: 'alertmanager';
  eventType: 'alertmanager.firing' | 'alertmanager.resolved';
  eventId: string;
  actor: string;
  payload: Record<string, unknown>;
  alertCount: number;
  truncatedAlerts: number;
}

function bounded(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, max) : undefined;
}

function safeRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringMap(
  value: unknown,
  limit: number,
  valueLimit: number,
): Record<string, string> | undefined {
  const source = safeRecord(value);
  if (!source) return undefined;
  const selected = Object.entries(source)
    .sort(([left], [right]) => left.localeCompare(right))
    .slice(0, limit)
    .flatMap(([rawKey, rawValue]) => {
      const key = bounded(rawKey, 120);
      const normalized = bounded(rawValue, valueLimit);
      return key && normalized ? [[key, normalized] as const] : [];
    });
  return selected.length ? Object.fromEntries(selected) : undefined;
}

function timestamp(value: unknown): string | undefined {
  const normalized = bounded(value, 80);
  return normalized && Number.isFinite(Date.parse(normalized))
    ? normalized
    : undefined;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonical(item)]),
  );
}

function digest(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
}

function normalizeAlert(value: unknown): Record<string, unknown> | undefined {
  const alert = safeRecord(value);
  if (!alert) return undefined;
  const status = bounded(alert.status, 20)?.toLowerCase();
  const labels = stringMap(alert.labels, 16, 160);
  if ((status !== 'firing' && status !== 'resolved') || !labels) {
    return undefined;
  }
  const normalized: Record<string, unknown> = {
    status,
    labels,
    annotations: stringMap(alert.annotations, 6, 500),
    startsAt: timestamp(alert.startsAt),
    endsAt: timestamp(alert.endsAt),
    generatorURL: bounded(alert.generatorURL, 2_000),
    fingerprint: bounded(alert.fingerprint, 200),
  };
  normalized.fingerprint ||= digest(normalized).slice(0, 40);
  return normalized;
}

export function normalizeAlertmanagerWorkflowEvent(
  value: unknown,
): AlertmanagerWorkflowEvent {
  const body = safeRecord(value);
  if (!body) throw new Error('alertmanager_payload_invalid');
  if (bounded(body.version, 10) !== '4') {
    throw new Error('alertmanager_version_unsupported');
  }
  const status = bounded(body.status, 20)?.toLowerCase();
  if (status !== 'firing' && status !== 'resolved') {
    throw new Error('alertmanager_status_invalid');
  }
  const groupKey = bounded(body.groupKey, 1_000);
  const receiver = bounded(body.receiver, 300);
  if (
    !groupKey ||
    !receiver ||
    !Array.isArray(body.alerts) ||
    body.alerts.length === 0
  ) {
    throw new Error('alertmanager_group_receiver_alerts_required');
  }
  const normalizedAlerts = body.alerts
    .map(normalizeAlert)
    .filter((alert): alert is Record<string, unknown> => Boolean(alert));
  if (normalizedAlerts.length !== body.alerts.length) {
    throw new Error('alertmanager_alerts_invalid');
  }
  normalizedAlerts.sort((left, right) =>
    String(left.fingerprint).localeCompare(String(right.fingerprint)),
  );
  const alerts = normalizedAlerts.slice(0, 8);
  const reportedTruncated =
    typeof body.truncatedAlerts === 'number' &&
    Number.isSafeInteger(body.truncatedAlerts) &&
    body.truncatedAlerts >= 0
      ? body.truncatedAlerts
      : 0;
  const truncatedAlerts = Math.min(
    1_000_000,
    reportedTruncated + Math.max(0, body.alerts.length - alerts.length),
  );
  const eventType = `alertmanager.${status}` as const;
  const payload: Record<string, unknown> = {
    schemaVersion: 1,
    provider: 'alertmanager',
    eventType,
    source: {
      kind: 'webhook',
      version: '4',
      receiver,
      groupKey,
      notificationReason: bounded(body.notification_reason, 80),
      externalURL: bounded(body.externalURL, 2_000),
    },
    status,
    groupLabels: stringMap(body.groupLabels, 12, 160),
    commonLabels: stringMap(body.commonLabels, 12, 160),
    commonAnnotations: stringMap(body.commonAnnotations, 6, 500),
    alertCount: body.alerts.length + reportedTruncated,
    truncatedAlerts,
    alertStateDigest: digest(normalizedAlerts),
    alerts,
  };
  return {
    provider: 'alertmanager',
    eventType,
    eventId: digest(payload),
    actor: `alertmanager:${receiver.slice(0, 100)}`,
    payload,
    alertCount: body.alerts.length + reportedTruncated,
    truncatedAlerts,
  };
}
