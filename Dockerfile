# BUILD
FROM node:26 AS builder

WORKDIR /opt/src

COPY agent agent

RUN cd agent && \
    npm ci && \
    npm run build

# RUN
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

# Basic development essentials (including Git and GitHub tooling: git, gh,
# gnupg for commit signing and openssh-client for SSH authentication)
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      bash \
      build-essential \
      ca-certificates \
      curl \
      git \
      gnupg \
      gzip \
      jq \
      openssh-client \
      perl \
      python3 \
      unzip \
      wget && \
    rm -rf /var/lib/apt/lists/*

# Additional development tools (Python packaging, shellcheck, JDK)
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      default-jdk \
      python3-pip \
      python3-venv \
      shellcheck && \
    rm -rf /var/lib/apt/lists/*

# NodeJS
RUN curl -fsSL https://deb.nodesource.com/setup_26.x -o /tmp/nodesource-setup.sh && \
    bash /tmp/nodesource-setup.sh && \
    apt-get install -y --no-install-recommends nodejs && \
    rm -rf /var/lib/apt/lists/* && \
    rm -f /tmp/nodesource-setup.sh

# GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli-archive-keyring.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list && \
    apt-get update && \
    apt-get install -y --no-install-recommends gh && \
    rm -rf /var/lib/apt/lists/*

# Kubernetes CLI (pinned version, no stable.txt lookup)
ARG KUBECTL_VERSION=v1.37.1
RUN ARCH=$(dpkg --print-architecture) && \
    curl -fsSL "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${ARCH}/kubectl" -o /usr/local/bin/kubectl && \
    chmod +x /usr/local/bin/kubectl

# Helm CLI (pinned version, installed from the official tarball instead of
# piping a remote script into a shell)
ARG HELM_VERSION=v4.3.0
RUN ARCH=$(dpkg --print-architecture) && \
    curl -fsSL "https://get.helm.sh/helm-${HELM_VERSION}-linux-${ARCH}.tar.gz" -o /tmp/helm.tar.gz && \
    tar -C /tmp -xzf /tmp/helm.tar.gz && \
    mv "/tmp/linux-${ARCH}/helm" /usr/local/bin/helm && \
    rm -rf /tmp/helm.tar.gz "/tmp/linux-${ARCH}"

# yq
ARG YQ_VERSION=v4.53.6
RUN ARCH=$(dpkg --print-architecture) && \
    curl -fsSL "https://github.com/mikefarah/yq/releases/download/${YQ_VERSION}/yq_linux_${ARCH}" -o /usr/local/bin/yq && \
    chmod +x /usr/local/bin/yq

# Go
ARG GO_VERSION=1.27.1
RUN ARCH=$(dpkg --print-architecture) && \
    curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-${ARCH}.tar.gz" -o /tmp/go.tar.gz && \
    tar -C /usr/local -xzf /tmp/go.tar.gz && \
    rm -f /tmp/go.tar.gz
ENV PATH="/usr/local/go/bin:${PATH}"

# Rust (pinned toolchain, installed from the rustup-init binary instead of
# piping a remote script into a shell)
ARG RUST_VERSION=1.99.0
ENV RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo \
    PATH="/usr/local/cargo/bin:${PATH}"
RUN ARCH=$(dpkg --print-architecture) && \
    case "$ARCH" in \
      amd64) RUSTUP_ARCH=x86_64-unknown-linux-gnu ;; \
      arm64) RUSTUP_ARCH=aarch64-unknown-linux-gnu ;; \
      *) echo "Unsupported architecture: $ARCH" && exit 1 ;; \
    esac && \
    curl -fsSL "https://static.rust-lang.org/rustup/dist/${RUSTUP_ARCH}/rustup-init" -o /tmp/rustup-init && \
    chmod +x /tmp/rustup-init && \
    /tmp/rustup-init -y --no-modify-path --profile minimal --default-toolchain "${RUST_VERSION}" && \
    rm -f /tmp/rustup-init
# The registry and build caches must be writable by the runtime user; the
# toolchain itself stays in the root-owned RUSTUP_HOME.
ENV CARGO_HOME=/home/agent/.cargo

# Coding agent CLIs (Qoder is the default; the others are selected with
# AGENT_CLI: claude-code, copilot-cli, codex, gemini-cli). Pinned versions
# for reproducible builds.
ARG QODER_CLI_VERSION=1.1.65
ARG CLAUDE_CODE_VERSION=2.1.288
ARG COPILOT_CLI_VERSION=1.0.91
ARG CODEX_CLI_VERSION=0.160.0
ARG GEMINI_CLI_VERSION=0.62.0
RUN npm install -g \
      @qoder-ai/qodercli@${QODER_CLI_VERSION} \
      @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} \
      @github/copilot@${COPILOT_CLI_VERSION} \
      @openai/codex@${CODEX_CLI_VERSION} \
      @google/gemini-cli@${GEMINI_CLI_VERSION}

# Verify all tools are available
RUN node --version && npm --version && git --version && gh --version && \
    kubectl version --client && helm version && yq --version && \
    jq --version && shellcheck --version | head -2 && \
    python3 --version && go version && java --version && \
    cargo --version && rustc --version && qoder --version && \
    claude --version && copilot --version && codex --version && gemini --version

COPY --from=builder /opt/src/agent/node_modules /opt/app/planner-llm-agent/node_modules
COPY --from=builder /opt/src/agent/dist /opt/app/planner-llm-agent/dist
COPY agent/config.json /opt/app/planner-llm-agent/config.json
COPY package.json /opt/app/planner-llm-agent/package.json

# Non-root runtime user: the agent and its CLI children run unprivileged
# (defuses the impact of any file-write escape, e.g. from an attachment
# file name). The ownership of the mounted /data volume on the deployed
# clusters is handled by the securityContext fsGroup of the Kubernetes
# manifests.
RUN groupadd --gid 10001 agent && \
    useradd --uid 10001 --gid agent --create-home --home-dir /home/agent --shell /bin/bash agent && \
    mkdir -p /data && \
    chown -R agent:agent /opt/app/planner-llm-agent /data

WORKDIR /opt/app/planner-llm-agent

USER agent

CMD [ "node", "dist/App.js" ]
