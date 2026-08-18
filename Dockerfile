# syntax=docker/dockerfile:1.7

FROM node:24.15.0-bookworm-slim AS build
WORKDIR /app

COPY . .
RUN npm ci \
    && npm run clean \
    && npm run build \
    && npm prune --omit=dev

FROM docker/buildx-bin:0.13.1 AS buildx

FROM node:24.15.0-bookworm-slim AS runtime

ARG CODEX_VERSION=0.144.4
ARG LARK_CLI_VERSION=1.0.31
ARG KUBECTL_VERSION=v1.32.3
ARG VCS_REF=unknown

LABEL org.opencontainers.image.source="https://github.com/ayuRain/maxtag" \
      org.opencontainers.image.revision="${VCS_REF}"

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      ca-certificates curl git jq openssh-client sqlite3 tini \
    && rm -rf /var/lib/apt/lists/*

# Keep runtime components in bounded layers. Besides improving cache locality,
# this avoids depending on registries accepting one very large monolithic blob.
RUN apt-get update \
    && apt-get install -y --no-install-recommends awscli gh \
    && rm -rf /var/lib/apt/lists/*

# The build-enabled Project runtime uses the ordinary Docker CLI and Buildx
# against a separate rootless BuildKit sidecar. No Docker daemon or host socket
# is included in this image.
RUN apt-get update \
    && apt-get install -y --no-install-recommends docker.io \
    && rm -rf /var/lib/apt/lists/*

COPY --from=buildx /buildx /usr/libexec/docker/cli-plugins/docker-buildx

RUN curl -fsSLo /usr/local/bin/kubectl "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/amd64/kubectl" \
    && curl -fsSLo /tmp/kubectl.sha256 "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/amd64/kubectl.sha256" \
    && echo "$(cat /tmp/kubectl.sha256)  /usr/local/bin/kubectl" | sha256sum -c - \
    && chmod 0755 /usr/local/bin/kubectl \
    && rm -f /tmp/kubectl.sha256

RUN npm install --global "@openai/codex@${CODEX_VERSION}" \
    && npm cache clean --force

RUN npm install --global "@larksuite/cli@${LARK_CLI_VERSION}" \
    && npm cache clean --force

WORKDIR /app
COPY --from=build --chown=node:node /app /app
RUN chmod 0755 /app/deploy/kubernetes/github-askpass.sh

ENV NODE_ENV=production \
    HOME=/var/lib/opentag \
    OPENTAG_DATA_DIR=/var/lib/opentag \
    OPENTAG_ARTIFACT_ROOT=/var/lib/opentag/artifacts \
    OPENTAG_EXECUTOR_WORKSPACE_ROOT=/srv/opentag/workspaces \
    OPENTAG_STORAGE_DRIVER=sqlite \
    OPENTAG_SQLITE_PATH=/var/lib/opentag/opentag.sqlite

USER node
ENTRYPOINT ["/usr/bin/tini", "--", "/app/deploy/kubernetes/role-entrypoint.sh"]
CMD ["server"]
