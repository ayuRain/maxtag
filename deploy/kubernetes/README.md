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
control-plane Pod and denies all runner egress by default. Command names must
pass both the Project capability grant and the runner-wide executable ceiling;
arguments are executed without a shell.

The temporary reviewed `maxtag-image-build` wrapper remains a control-plane
boundary command via `OPENTAG_LOCAL_BOUNDARY_COMMANDS`; it needs brokered AWS
submission and GitHub App identity that are intentionally absent from the
runner. Ordinary tools such as `git`, `npm`, and `node` never use that path.

Create the independent auth Secret before applying the production overlay:

```bash
deploy/kubernetes/scripts/prepare-project-runner-auth.sh maxtag
```

The initial production ceiling is `git,node,npm,npx,python,python3,pytest,make,cmake`.
This enables local inspect/edit/test/rebase work without exposing `aws`,
`kubectl`, `gh`, a Docker socket, or external credentials. Private fetch,
registry publishing, and cloud operations remain brokered boundary operations;
do not solve them by mounting control-plane credentials into this Pod.

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
`kubectl`, `sqlite3`, and common TLS/JSON utilities. It intentionally does not
contain a Docker daemon or mount a node Docker socket. Image builds should run
as isolated BuildKit/Kaniko Jobs with their own policy and resource limits.

The production overlay currently mounts `maxtag-image-build`, an optional,
temporary accelerator for the first Hamer acceptance case. It is not the
MaxTag execution model: the agent should use the generic Project sandbox to
inspect failures and repair repository state, and may choose this wrapper only
for the final isolated image submission. The client only
accepts the `max-insights/hamer` workspace, three reviewed Dockerfile paths,
and valid OCI image tags. The command archives a clean Git commit, uploads it under
the dedicated S3 `hamer/` prefix, starts CodeBuild, and returns a build ID.
Run `maxtag-image-build sync` first to select the clean remote
`maxhandsv2-c4.03-stable` commit, the reviewed Maxflow release line. Use
`maxtag-image-build sync main` only when the caller explicitly requests the
moving `main` branch. Both forms use a short-lived GitHub App installation token. The sync only
accepts those two branches and `max-insights/hamer`; it checks out the exact
remote commit in detached mode so local branch state cannot affect a build.
The token is never written to Git configuration, command arguments, or the
persistent workspace.
Use `maxtag-image-build status <build-id>` to query progress. It never mounts a
Docker socket or exposes AWS credentials to the agent container. The build
target is configured once for the capability package (currently the
organization-owned
`registry.maxinsights.ai/max-infra/hamer-maxhandsv2-business` repository), so
chat users only choose a tag and optional reviewed Dockerfile. Registry
credentials are injected into CodeBuild from AWS Secrets Manager; they are not
available to the MaxTag Pod, model, Project memory, or chat users. Successful
status responses load the immutable registry digest from a build result object
under the protected S3 `hamer/results/` prefix for the final card. Projects may
disable the extra tool-confirmation layer when this narrow
wrapper is already the approved execution boundary; repository, branch,
Dockerfile, IAM, and registry restrictions remain enforced by the wrapper and
AWS roles.

## Shadow deployment

Create the runtime secret from the protected host environment file. The helper
uses a pipe and never writes the rendered Secret to disk:

```bash
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

For algorithm image submission, grant that IRSA role only `s3:PutObject` on
the configured build-source `hamer/` prefix, `codebuild:StartBuild` on the
single build project, `codebuild:BatchGetBuilds`, and `s3:GetObject` on the
`hamer/results/` prefix. The CodeBuild service role should have read access to
the source prefix, write access to the result prefix, and read access to the
single Secrets Manager registry credential. Override the default
account-specific names with
`MAXTAG_BUILD_SOURCE_BUCKET`, `MAXTAG_BUILD_CODEBUILD_PROJECT`,
`MAXTAG_BUILD_SUBMIT_ROLE_ARN`, and `MAXTAG_BUILD_AWS_REGION` when needed.

## Resource envelope

The four MaxTag containers request 2 CPU and 4 GiB combined and are limited to
4 CPU and 8 GiB. The PVC starts at 20 GiB. The Cloudflare sidecar adds 50m CPU
and 128 MiB requested memory.
