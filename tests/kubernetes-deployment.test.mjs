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

test('algorithm builder syncs only the clean hamer main branch with a GitHub App token', async () => {
  const tool = await read('deploy/kubernetes/production/algorithm-tools-configmap.yaml');
  assert.match(tool, /maxtag-image-build sync/u);
  assert.match(tool, /GitHubAppInstallationTokenProvider/u);
  assert.match(tool, /MAXTAG_GITHUB_INSTALLATION_TOKEN/u);
  assert.match(tool, /GIT_ASKPASS/u);
  assert.match(tool, /GIT_TERMINAL_PROMPT=0/u);
  assert.match(tool, /git fetch --no-tags origin refs\/heads\/main:refs\/remotes\/origin\/main/u);
  assert.match(tool, /git merge --ff-only refs\/remotes\/origin\/main/u);
  assert.match(tool, /workspace repository is not max-insights\/hamer/u);
  assert.match(tool, /workspace must be on main before sync/u);
  assert.match(tool, /workspace has uncommitted changes/u);
  assert.doesNotMatch(tool, /credential\.helper/u);
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
