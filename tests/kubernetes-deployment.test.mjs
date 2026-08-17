import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

const read = (path) => fs.readFile(path, 'utf8');

test('container image pins runtime clients and runs without root', async () => {
  const dockerfile = await read('Dockerfile');
  assert.match(dockerfile, /FROM node:24\.15\.0-bookworm-slim AS runtime/u);
  assert.match(dockerfile, /CODEX_VERSION=0\.144\.4/u);
  assert.match(dockerfile, /LARK_CLI_VERSION=1\.0\.31/u);
  assert.match(dockerfile, /sha256sum -c -/u);
  assert.match(dockerfile, /^USER node$/mu);
  assert.match(dockerfile, /role-entrypoint\.sh/u);
  assert.doesNotMatch(dockerfile, /docker\.sock|privileged/iu);
});

test('Kubernetes base is a single-PVC shadow deployment', async () => {
  const [config, pvc, statefulSet, rbac] = await Promise.all([
    read('deploy/kubernetes/base/configmap.yaml'),
    read('deploy/kubernetes/base/pvc.yaml'),
    read('deploy/kubernetes/base/statefulset.yaml'),
    read('deploy/kubernetes/base/rbac-readonly.yaml'),
  ]);
  assert.match(statefulSet, /^kind: StatefulSet$/mu);
  assert.match(statefulSet, /^  replicas: 1$/mu);
  for (const name of ['server', 'worker', 'scheduler', 'lark-bridge']) {
    assert.match(statefulSet, new RegExp(`name: ${name}`));
  }
  assert.match(statefulSet, /claimName: maxtag-state/u);
  assert.match(statefulSet, /readOnlyRootFilesystem: true/u);
  assert.match(statefulSet, /allowPrivilegeEscalation: false/u);
  assert.match(statefulSet, /drop: \["ALL"\]/u);
  assert.match(pvc, /storage: 20Gi/u);
  assert.match(pvc, /ReadWriteOnce/u);
  for (const name of [
    'OPENTAG_K8S_WORKER_ENABLED',
    'OPENTAG_K8S_SCHEDULER_ENABLED',
    'OPENTAG_K8S_LARK_BRIDGE_ENABLED',
  ]) {
    assert.match(config, new RegExp(`${name}: "false"`));
  }
  assert.match(rbac, /^  name: view$/mu);
  assert.doesNotMatch(rbac, /secrets/iu);
});

test('production overlay explicitly enables singleton consumers and Tunnel', async () => {
  const [runtime, tunnel, githubApp, kustomization, docs] = await Promise.all([
    read('deploy/kubernetes/production/enable-runtime.yaml'),
    read('deploy/kubernetes/production/cloudflared-sidecar.yaml'),
    read('deploy/kubernetes/production/github-app-patch.yaml'),
    read('deploy/kubernetes/production/kustomization.yaml'),
    read('deploy/kubernetes/README.md'),
  ]);
  assert.equal((runtime.match(/: "true"/gu) ?? []).length, 3);
  assert.match(tunnel, /cloudflare\/cloudflared:2026\.8\.1/u);
  assert.match(tunnel, /secretName: maxtag-cloudflared/u);
  assert.match(kustomization, /github-app-patch\.yaml/u);
  assert.match(githubApp, /secretName: maxtag-github-app/u);
  assert.match(githubApp, /OPENTAG_GITHUB_APP_ID/u);
  assert.match(githubApp, /OPENTAG_GITHUB_APP_INSTALLATION_ID/u);
  assert.match(githubApp, /OPENTAG_GITHUB_APP_PRIVATE_KEY_FILE/u);
  assert.match(githubApp, /mountPath: \/var\/run\/secrets\/maxtag-github-app/u);
  assert.match(githubApp, /defaultMode: 256/u);
  assert.match(docs, /Do not increase replicas/u);
  assert.match(docs, /Do not simply restart the old host/u);
});

test('production project commands run outside the credential-bearing control plane', async () => {
  const [deployment, account, policy, patch, kustomization, docs, config] = await Promise.all([
    read('deploy/kubernetes/production/project-runner-deployment.yaml'),
    read('deploy/kubernetes/production/project-runner-service-account.yaml'),
    read('deploy/kubernetes/production/project-runner-network-policy.yaml'),
    read('deploy/kubernetes/production/project-runner-control-plane-patch.yaml'),
    read('deploy/kubernetes/production/kustomization.yaml'),
    read('deploy/kubernetes/README.md'),
    read('deploy/kubernetes/base/configmap.yaml'),
  ]);
  assert.match(deployment, /^kind: Deployment$/mu);
  assert.match(deployment, /app\.kubernetes\.io\/name: maxtag-project-runner/u);
  assert.match(deployment, /args: \["project-runner"\]/u);
  assert.match(deployment, /automountServiceAccountToken: false/u);
  assert.match(deployment, /secretKeyRef:\n\s+name: maxtag-project-runner-auth/u);
  assert.match(deployment, /subPath: workspaces/u);
  assert.match(deployment, /OPENTAG_PROJECT_RUNNER_COMMANDS[\s\S]*value: "\*"/u);
  assert.doesNotMatch(deployment, /maxtag-runtime-env|maxtag-github-app|maxtag-cloudflared/u);
  assert.doesNotMatch(deployment, /aws,kubectl|docker\.sock|privileged/iu);
  assert.match(account, /automountServiceAccountToken: false/u);
  assert.match(policy, /component: project-runner/u);
  assert.match(policy, /name: maxtag-project-runner/u);
  assert.match(policy, /component: control-plane/u);
  assert.match(policy, /egress: \[\]/u);
  assert.match(patch, /OPENTAG_PROJECT_RUNNER_URL/u);
  assert.match(patch, /OPENTAG_PROJECT_RUNNER_TOKEN/u);
  assert.match(kustomization, /project-runner-deployment\.yaml/u);
  assert.doesNotMatch(kustomization, /algorithm-tools/u);
  assert.match(config, /OPENTAG_LOCAL_BOUNDARY_COMMANDS: ""/u);
  assert.match(docs, /does not mount the MaxTag runtime Secret/u);
  assert.match(docs, /denies all runner egress by default/u);
});

test('production does not hard-code a Hamer workflow as the agent execution model', async () => {
  const entries = await fs.readdir('deploy/kubernetes/production');
  assert.equal(entries.includes('algorithm-tools-configmap.yaml'), false);
  assert.equal(entries.includes('algorithm-tools-patch.yaml'), false);
  await assert.rejects(read('deploy/aws/codebuild/hamer-buildspec.yml'), /ENOENT/u);
});

test('state export refuses live writers and restore requires a scaled-down Pod', async () => {
  const [exportScript, restoreScript] = await Promise.all([
    read('deploy/kubernetes/scripts/export-host-state.sh'),
    read('deploy/kubernetes/scripts/restore-state.sh'),
  ]);
  assert.match(exportScript, /systemctl is-active --quiet/u);
  assert.match(exportScript, /PRAGMA quick_check/u);
  assert.match(exportScript, /sha256sum/u);
  assert.match(restoreScript, /must be scaled to zero/u);
  assert.match(restoreScript, /persistentVolumeClaim/u);
  assert.match(restoreScript, /chown -R 1000:1000/u);
});

test('Kubernetes verification selects only the control-plane Pod', async () => {
  const [verify, runnerVerify] = await Promise.all([
    read('deploy/kubernetes/scripts/verify.sh'),
    read('deploy/kubernetes/scripts/verify-project-runner.sh'),
  ]);
  assert.match(verify, /app\.kubernetes\.io\/component=control-plane/u);
  assert.doesNotMatch(verify, /exec statefulset\/maxtag/u);
  assert.match(runnerVerify, /project-runner-ok/u);
  assert.match(runnerVerify, /api\.github\.com/u);
  assert.match(runnerVerify, /unexpected direct internet egress/u);
  assert.match(runnerVerify, /maxtag-github-app\/private-key\.pem/u);
});
