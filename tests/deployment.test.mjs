import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

const unitNames = [
  'opentag-server.service',
  'opentag-worker.service',
  'opentag-scheduler.service',
];

test('systemd services share a hardened, graceful runtime contract', async () => {
  const units = await Promise.all(
    unitNames.map(async (name) => ({
      name,
      text: await fs.readFile(`deploy/systemd/${name}`, 'utf8'),
    })),
  );
  for (const unit of units) {
    assert.match(unit.text, /^\[Unit\]/m, unit.name);
    assert.match(unit.text, /^\[Service\]/m, unit.name);
    assert.match(
      unit.text,
      /^EnvironmentFile=\/etc\/opentag\/opentag\.env$/m,
      unit.name,
    );
    assert.match(unit.text, /^Restart=always$/m, unit.name);
    assert.match(unit.text, /^KillSignal=SIGTERM$/m, unit.name);
    assert.match(unit.text, /^TimeoutStopSec=30s$/m, unit.name);
    assert.match(unit.text, /^StateDirectory=opentag$/m, unit.name);
    assert.match(unit.text, /^ProtectSystem=strict$/m, unit.name);
    assert.match(unit.text, /^NoNewPrivileges=yes$/m, unit.name);
  }
  assert.match(units[0].text, /^Before=.*opentag-worker\.service/m);
  assert.match(units[1].text, /^After=.*opentag-server\.service/m);
  assert.match(units[2].text, /^After=.*opentag-server\.service/m);
});

test('deployment environment and Prometheus targets stay aligned', async () => {
  const [environment, scrape, alerts] = await Promise.all([
    fs.readFile('deploy/systemd/opentag.env.example', 'utf8'),
    fs.readFile('deploy/prometheus/opentag-scrape.yml', 'utf8'),
    fs.readFile('deploy/prometheus/opentag-alerts.yml', 'utf8'),
  ]);
  const expected = [
    ['OPENTAG_PORT', '3077'],
    ['OPENTAG_WORKER_OBSERVABILITY_PORT', '3078'],
    ['OPENTAG_SCHEDULER_OBSERVABILITY_PORT', '3079'],
  ];
  for (const [name, port] of expected) {
    assert.match(environment, new RegExp(`^${name}=${port}$`, 'm'));
    assert.match(scrape, new RegExp(`127\\.0\\.0\\.1:${port}`));
  }
  assert.match(environment, /^OPENTAG_AGENT_WORKER=manual$/m);
  assert.match(environment, /^OPENTAG_ROUTINE_SCHEDULER=external$/m);
  assert.match(environment, /^OPENTAG_WORKFLOW_COORDINATOR=external$/m);
  assert.match(environment, /^OPENTAG_AGENT_RUN_HEARTBEAT_MS=15000$/m);
  assert.match(scrape, /credentials_file: \/etc\/prometheus\/opentag-metrics-token/);
  assert.match(alerts, /alert: OpenTagRunLeaseStale/);
  assert.match(alerts, /alert: OpenTagOutboxStale/);
  assert.doesNotMatch(scrape, /workspace|project|thread|run_id/iu);
});
