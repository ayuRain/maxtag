# Kubernetes deployment

The Kubernetes topology deliberately keeps the server, worker, scheduler, and
Lark long-connection bridge in one StatefulSet Pod. They share one EBS RWO PVC
and one SQLite WAL database. This is a production-safe migration target for the
current storage model, not horizontal availability. Do not increase replicas
until SQLite and the in-memory transports have been replaced by hosted stores.

The base is a safe shadow deployment: the HTTP server runs while the worker,
scheduler, and Lark bridge remain in standby. The production overlay enables
all three consumers and adds the existing Cloudflare Tunnel as a sidecar.

## Build

```bash
docker build --build-arg VCS_REF="$(git rev-parse HEAD)" -t maxtag:"$(git rev-parse --short=12 HEAD)" .
```

The image contains pinned Codex and Lark CLIs plus `git`, `gh`, `aws`,
`kubectl`, `sqlite3`, and common TLS/JSON utilities. It intentionally does not
contain a Docker daemon or mount a node Docker socket. Image builds should run
as isolated BuildKit/Kaniko Jobs with their own policy and resource limits.

The production overlay also mounts `maxtag-image-build`, a narrow submission
client for the isolated `maxtag-hamer-image-build` CodeBuild project. It only
accepts the `max-insights/hamer` workspace, three reviewed Dockerfile paths,
and valid ECR tags. The command archives a clean Git commit, uploads it under
the dedicated S3 `hamer/` prefix, starts CodeBuild, and returns a build ID.
Use `maxtag-image-build status <build-id>` to query progress. It never mounts a
Docker socket or exposes AWS credentials to the agent container.

## Shadow deployment

Create the runtime secret from the protected host environment file. The helper
uses a pipe and never writes the rendered Secret to disk:

```bash
deploy/kubernetes/scripts/prepare-secrets.sh maxtag /etc/opentag/opentag.env
kubectl apply -k deploy/kubernetes/base
kubectl -n maxtag set image statefulset/maxtag \
  server=REGISTRY/maxtag:SHA worker=REGISTRY/maxtag:SHA \
  scheduler=REGISTRY/maxtag:SHA lark-bridge=REGISTRY/maxtag:SHA
kubectl -n maxtag rollout status statefulset/maxtag
```

Do not expose this shadow server through the production Tunnel. Validate health,
the mounted tools, and service-account permissions first.

## Lark and Cloudflare cutover

The public hostname and Lark developer-console configuration do not change:

- Cloudflare Tunnel hostname: `maxtag.maxinsights.ai`
- Lark event/card callback: `https://maxtag.maxinsights.ai/v1/lark/events`
- Group messages continue to use the Lark long-connection consumer.

During cutover, stop the host Lark bridge before enabling the Kubernetes bridge;
there must never be two long-connection consumers for the same application.
Keep the host Tunnel online until the Kubernetes server is healthy, then start
the Cloudflare sidecar and stop the host Tunnel. Finally verify the public
`/health` endpoint, the Lark URL-verification challenge, one group mention, and
one real card-button callback. Existing cards continue to use the same public
callback URL; they do not need to be recreated solely because of the migration.

## Consistent state migration

Only one side may write SQLite or consume the Lark long connection. For the
final cutover:

1. Stop the host server, worker, scheduler, and Lark bridge.
2. Export state with `scripts/export-host-state.sh`; it refuses to run while a
   writer is active and verifies the copied SQLite database.
3. Scale the StatefulSet to zero and restore the archive with
   `scripts/restore-state.sh`.
4. Create the KMS-encrypted Kubernetes Cloudflare Secret from the existing
   Tunnel config and credentials with `scripts/prepare-secrets.sh`.
5. Apply the production overlay and the immutable image tag.
6. Run `scripts/verify.sh`, then stop the old host Cloudflare process.

The source archive and PVC snapshot are the rollback boundary. If validation
fails, keep the Kubernetes consumers disabled, restore the latest state to the
host, and restart the systemd target. Do not simply restart the old host after
Kubernetes has accepted new messages, because that would discard newer state.

## Credentials and IAM

The manifests contain no credential values. `maxtag-runtime-env` and
`maxtag-cloudflared` must be created out of band; EKS secret encryption should
be enabled with KMS. Annotate the `maxtag` ServiceAccount with a dedicated IRSA
role rather than copying AWS keys. The committed cluster binding grants the
built-in Kubernetes `view` role and cannot read Secrets or mutate resources.

For algorithm image submission, grant that IRSA role only `s3:PutObject` on
the configured build-source `hamer/` prefix, `codebuild:StartBuild` on the
single build project, and `codebuild:BatchGetBuilds`. The CodeBuild service
role should have read access to that source prefix and push access to the ECR
`hamer` repository only. Override the default account-specific names with
`MAXTAG_BUILD_SOURCE_BUCKET`, `MAXTAG_BUILD_CODEBUILD_PROJECT`,
`MAXTAG_BUILD_SUBMIT_ROLE_ARN`, and `MAXTAG_BUILD_AWS_REGION` when needed.

## Resource envelope

The four MaxTag containers request 2 CPU and 4 GiB combined and are limited to
4 CPU and 8 GiB. The PVC starts at 20 GiB. The Cloudflare sidecar adds 50m CPU
and 128 MiB requested memory.
