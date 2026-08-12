# Supervised Deployment

The production topology runs three processes against one SQLite WAL database:

```text
TLS reverse proxy -> opentag-server :3077
                         |
                         +-> shared /var/lib/opentag/opentag.sqlite
                              ^              ^
                              |              |
                    opentag-worker     opentag-scheduler
                         :3078 metrics      :3079 metrics
```

`opentag-server` owns callbacks and the operator control plane. The worker owns
agent execution. The scheduler owns routine staging and workflow coordination.
All metrics and health listeners bind to loopback by default.

## Host Preparation

Build with Node.js 20 or newer, then install the immutable application tree at
`/opt/opentag`. Create an `opentag` system user whose home is
`/var/lib/opentag`, and create `/srv/opentag/workspaces` for project checkouts.
Authenticate Codex and Claude as that service user because provider sessions
are intentionally scoped to its home directory.

Install `deploy/systemd/opentag.env.example` as
`/etc/opentag/opentag.env`, replace every credential placeholder, and keep it
owned by `root:opentag` with mode `0640`. Install the four unit files under
`/etc/systemd/system`, then run:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now opentag.target
systemctl status opentag-server opentag-worker opentag-scheduler
```

The units use `ProtectSystem=strict`, a private temporary directory, a writable
systemd state directory, and an optional writable `/srv/opentag/workspaces`.
Adjust the paths or hardening only when the executor genuinely needs another
host resource.

Expose port `3077` only through a TLS reverse proxy. Route Lark callbacks to
`/v1/lark/events`; keep `3078` and `3079` loopback-only. Production deployments
should configure random operator, session, ingress, callback, and metrics
credentials before startup.

## Metrics

The server exposes `/metrics` on port `3077`. The standalone worker and
scheduler expose `/health` and `/metrics` only when their observability ports
are configured. `OPENTAG_METRICS_TOKEN` protects all three metrics endpoints;
health remains unauthenticated for local supervisors.

Prometheus uses its own credentials file. Put the same metrics token in
`/etc/prometheus/opentag-metrics-token`, readable only by the Prometheus user,
then merge `deploy/prometheus/opentag-scrape.yml` into `scrape_configs` and load
`deploy/prometheus/opentag-alerts.yml` through `rule_files`. Validate before
reload when `promtool` is installed:

```bash
promtool check config /etc/prometheus/prometheus.yml
promtool check rules /etc/prometheus/opentag-alerts.yml
```

The exported series deliberately omit workspace, project, thread, run, and
message identifiers. Detailed provenance remains in the authenticated OpenTag
Activity ledger rather than becoming high-cardinality monitoring labels.

## Restart Smoke

Run these checks after each rollout:

```bash
curl http://127.0.0.1:3077/health
curl http://127.0.0.1:3078/health
curl http://127.0.0.1:3079/health
systemctl restart opentag-worker
journalctl -u opentag-worker --since '2 minutes ago'
```

An executing worker renews its durable lease. On SIGTERM it stops claiming new
work, interrupts its local executor, and returns that run to `queued` instead
of recording a user cancellation. The replacement worker then claims it. This
is restart recovery, not instruction-level checkpoint resume: a provider may
need to replay the bounded transcript or resume its provider session.
