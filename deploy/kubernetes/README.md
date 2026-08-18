# Kubernetes deployment

The Kubernetes topology deliberately keeps the server, worker, scheduler, and
Lark long-connection bridge in one control-plane StatefulSet Pod. They share one EBS RWO PVC
and one SQLite WAL database. This is a production-safe migration target for the
current storage model, not horizontal availability. Do not increase replicas
until SQLite and the in-memory transports have been replaced by hosted stores.

The base is a safe shadow deployment: the HTTP server runs while the worker,
scheduler, and Lark bridge remain in standby. The production overlay enables
all three consumers, adds the existing Cloudflare Tunnel as a sidecar, and
runs project commands in a separate Project Runner Deployment.

## Project Runner isolation

`workspace_run` is sent to `maxtag-project-runner`, not spawned in the
control-plane Pod. The runner mounts only the managed Project workspace and a
dedicated bearer-auth Secret. It does not mount the MaxTag runtime Secret,
GitHub App key, Cloudflare credentials, Kubernetes service-account token, or
platform database. A NetworkPolicy accepts requests only from the MaxTag
control-plane Pod and denies all runner egress by default. A Project capability
grant may expose every executable installed in the runtime with `commands: ["*"]`.
The Pod, Project-only filesystem, workload identity, and egress policy are the
security boundary—not a workflow-specific executable list. Commands may use an
ordinary shell when the agent needs pipelines or multi-step diagnostics.

Create the independent auth Secret before applying the production overlay:

```bash
deploy/kubernetes/scripts/prepare-project-runner-auth.sh maxtag
```

Production uses the wildcard runtime grant. This enables AgentDock-style
inspect/edit/test/retry loops with whichever ordinary programs are installed in
the image. It does not create credentials, a Docker socket, Kubernetes access,
or network access. Private GitHub, registry publishing, and cloud operations
remain scoped capability boundaries; do not solve them by mounting control-plane
secrets into this Pod.

`NetworkPolicy` resources are enforced by the cluster CNI, not Kubernetes
itself. On EKS, enable Amazon VPC CNI network-policy support in the add-on/IaC
source of truth (`enableNetworkPolicy: true`) and ensure the `aws-node`
node-agent runs with `--enable-network-policy=true`. Merely applying
`project-runner-network-policy.yaml` is not sufficient. Before granting any
Project command, prove both authenticated execution and isolation:

```bash
deploy/kubernetes/scripts/verify-project-runner.sh maxtag
```

The check fails if the runner inherits Kubernetes, GitHub App, AWS, or Lark
credentials, or if it can reach `api.github.com` directly. Keep the add-on
setting in Terraform/Helm rather than relying on an ad-hoc live patch that a
future reconciliation could overwrite.

## Build

```bash
docker build --build-arg VCS_REF="$(git rev-parse HEAD)" -t maxtag:"$(git rev-parse --short=12 HEAD)" .
```

The image contains pinned Codex and Lark CLIs plus `git`, `gh`, `aws`,
`kubectl`, `sqlite3`, Docker CLI/Buildx, and common TLS/JSON utilities. It does
not contain a Docker daemon or mount a node Docker socket. The production
algorithm Project is routed to a dedicated runtime Pod with a rootless BuildKit
sidecar and persistent cache. The Agent therefore uses ordinary `git`, tests,
and `docker buildx build` commands exactly as it would in a full workstation:
it can inspect logs, edit files, and retry without translating the task into a
CodeBuild or Hamer workflow.

Image delivery is intentionally not represented by a Hamer-specific wrapper in
the production overlay. The general agent inspects the repository, chooses the
real Dockerfile and build arguments, diagnoses failures, and verifies the final
digest. GitHub App, Registry and project build-secret mounts exist only in the
dedicated algorithm runtime; the default Project Runner remains networkless and
credential-free. Rotate the Registry credential to a path-scoped publisher
identity before granting additional projects access to this runtime.

## Shadow deployment

Create the runtime secret from the protected host environment file. The helper
uses a pipe and never writes the rendered Secret to disk:

```bash
kubectl -n maxtag create secret generic maxtag-registry \
  --from-file=.dockerconfigjson=/path/to/protected/docker-config.json \
  --type=kubernetes.io/dockerconfigjson
deploy/kubernetes/scripts/prepare-secrets.sh maxtag /etc/opentag/opentag.env
kubectl apply -k deploy/kubernetes/base
kubectl -n maxtag set image statefulset/maxtag \
  server=REGISTRY/maxtag:SHA worker=REGISTRY/maxtag:SHA \
  scheduler=REGISTRY/maxtag:SHA lark-bridge=REGISTRY/maxtag:SHA
kubectl -n maxtag set image deployment/maxtag-project-runner \
  project-runner=REGISTRY/maxtag:SHA
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

The production overlay also expects a `maxtag-github-app` Secret with the keys
`app-id`, `installation-id`, and `private-key.pem`. The private key is mounted
read-only into the server and worker; it must never be committed or placed in
the general runtime environment Secret. One organization-owned GitHub App can
cover multiple repositories. MaxTag project grants remain the authorization
boundary for which repository a route may operate on.

The algorithm runtime does not need AWS credentials merely to build and publish
an image. GitHub access is a short-lived installation token generated inside
the runtime from `maxtag-github-app`; Registry authentication comes from
`maxtag-registry`; and build-time files come from
`maxtag-algorithm-build-secrets`. These are Project runtime capabilities, not
prompt text or memory. Do not copy their values into the control-plane runtime
Secret or a workspace file.

## Resource envelope

The four MaxTag containers request 2 CPU and 4 GiB combined and are limited to
4 CPU and 8 GiB. The PVC starts at 20 GiB. The Cloudflare sidecar adds 50m CPU
and 128 MiB requested memory.
