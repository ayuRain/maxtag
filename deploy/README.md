# Supervised Deployment

The production topology runs four processes against one SQLite WAL database:

```text
TLS reverse proxy -> opentag-server :3077
                         |
                         +-> opentag-lark-bridge :3080 metrics
                         |
                         +-> shared /var/lib/opentag/opentag.sqlite
                              ^              ^
                              |              |
                    opentag-worker     opentag-scheduler
                         :3078 metrics      :3079 metrics
```

`opentag-server` owns callbacks, generic client ingress, and the operator
control plane. `opentag-lark-bridge` owns Feishu/Lark long-connection event
consumption and feeds the loopback server, so Lark production ingress does not
need a public callback URL. Installation owners can save App ID and App Secret
in the MaxTag Web console. MaxTag validates them against the OpenAPI token
endpoint, encrypts them at rest with AES-256-GCM under `/var/lib/opentag`, and
the systemd path unit reloads server, worker, and bridge after a successful
change. The bridge materializes a short-lived `lark-cli` profile only inside
its private temporary directory, then deletes it on shutdown. Environment
credentials and `OPENTAG_LARK_CLI_PROFILE` remain a deployment fallback. The
profile's `feishu`/`lark` brand controls WebSocket ingress independently of
`OPENTAG_LARK_DOMAIN`, which controls OpenAPI delivery; validate both on the
deployment host.

After both consumers are ready and then once per configured interval, MaxTag
silently scans the gap since its durable checkpoint for every currently bound
Lark channel. Recovered messages re-enter
the normal idempotent client ingress, so routing, mention rules, actor access,
budget checks, and thread continuation stay unchanged. The checkpoint advances
only after a complete channel scan; successful channels advance independently,
while failures or the configured message ceiling retain that channel's old
checkpoint and raise `OpenTagLarkBridgeBackfillFailure`. Long gaps are scanned
in bounded time slices until caught up. Grant the bot one
of Lark's message-history read scopes and keep
`OPENTAG_LARK_BACKFILL_STATE_FILE` on persistent storage. The worker
owns agent execution. The scheduler owns routine staging and workflow
coordination. All metrics and health listeners bind to loopback by default.

## Host Preparation

Build with Node.js 20 or newer, then install the immutable application tree at
`/opt/opentag`. Create an `opentag` system user whose home is
`/var/lib/opentag`, and create `/srv/opentag/workspaces` for project checkouts.
Authenticate Codex and Claude as that service user because provider sessions
are intentionally scoped to its home directory.

Install `deploy/systemd/opentag.env.example` as
`/etc/opentag/opentag.env`, replace the non-Lark credential placeholders, and
keep it owned by `root:opentag` with mode `0640`. Install the service, target,
and Lark reload path units under `/etc/systemd/system`, then run:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now opentag.target
sudo systemctl enable --now opentag-lark-config-reload.path
systemctl status opentag-server opentag-lark-bridge opentag-worker opentag-scheduler
```

The units use `ProtectSystem=strict`, a private temporary directory, a writable
systemd state directory, and an optional writable `/srv/opentag/workspaces`.
Adjust the paths or hardening only when the executor genuinely needs another
host resource.

Expose port `3077` only through a TLS reverse proxy when HTTP callbacks or the
operator console need external access. Long-connection Lark ingress can keep all
event flow on loopback. The server refuses a non-loopback bind when operator
authentication is disabled. Set `OPENTAG_LARK_EVENT_MODE=webhook` and configure
a Verification Token or Encrypt Key before routing Lark callbacks to
`/v1/lark/events`; the endpoint is disabled in long-connection mode.
keep `3078`, `3079`, and `3080` loopback-only. Production deployments should
configure random operator, session, ingress, callback, and metrics credentials
before startup.

## Metrics

The server exposes `/metrics` on port `3077`. The standalone Lark bridge,
worker, and scheduler expose `/health` and `/metrics` only when their
observability ports are configured. `OPENTAG_METRICS_TOKEN` protects all four
metrics endpoints; health remains unauthenticated for local supervisors.

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
message identifiers. Detailed provenance remains in the authenticated MaxTag
Activity ledger rather than becoming high-cardinality monitoring labels.
Tool approval metrics expose only lifecycle status counts and oldest-status age.
Exact arguments remain in the workspace-scoped operator API and are never
exported as metric labels or audit payloads.

## Restart Smoke

Run these checks after each rollout:

```bash
curl http://127.0.0.1:3077/health
curl http://127.0.0.1:3078/health
curl http://127.0.0.1:3079/health
curl http://127.0.0.1:3080/health
systemctl restart opentag-lark-bridge
journalctl -u opentag-lark-bridge --since '2 minutes ago'
systemctl restart opentag-worker
journalctl -u opentag-worker --since '2 minutes ago'
```

An executing worker renews its durable lease. On SIGTERM it stops claiming new
work, interrupts its local executor, and returns that run to `queued` instead
of recording a user cancellation. The replacement worker then claims it. This
is restart recovery, not instruction-level checkpoint resume: a provider may
need to replay the bounded transcript or resume its provider session.
