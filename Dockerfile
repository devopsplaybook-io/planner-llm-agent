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

# Kubernetes CLI (version pinned for reproducible builds)
ARG KUBECTL_VERSION=v1.37.1
RUN ARCH=$(dpkg --print-architecture) && \
    curl -fsSL "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${ARCH}/kubectl" -o /usr/local/bin/kubectl && \
    chmod +x /usr/local/bin/kubectl

# Helm CLI (version pinned for reproducible builds, checksum verified)
ARG HELM_VERSION=v4.3.0
RUN ARCH=$(dpkg --print-architecture) && \
    curl -fsSL "https://get.helm.sh/helm-${HELM_VERSION}-linux-${ARCH}.tar.gz" -o /tmp/helm.tar.gz && \
    curl -fsSL "https://get.helm.sh/helm-${HELM_VERSION}-linux-${ARCH}.tar.gz.sha256sum" -o /tmp/helm.tar.gz.sha256sum && \
    echo "$(awk '{print $1}' /tmp/helm.tar.gz.sha256sum)  /tmp/helm.tar.gz" | sha256sum -c - && \
    tar -C /tmp -xzf /tmp/helm.tar.gz && \
    install /tmp/linux-${ARCH}/helm /usr/local/bin/helm && \
    rm -rf /tmp/helm.tar.gz /tmp/helm.tar.gz.sha256sum /tmp/linux-${ARCH}

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

# Rust (rustup-init from the pinned release archive, toolchain pinned for
# reproducible builds)
ARG RUSTUP_VERSION=1.28.2
ARG RUST_TOOLCHAIN=1.99.0
ENV RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo \
    PATH="/usr/local/cargo/bin:${PATH}"
RUN RUSTUP_ARCH=$(case "$(dpkg --print-architecture)" in \
      amd64) echo x86_64 ;; \
      arm64) echo aarch64 ;; \
      *) echo "unsupported architecture for Rust" >&2 && exit 1 ;; \
    esac) && \
    curl -fsSL "https://static.rust-lang.org/rustup/archive/${RUSTUP_VERSION}/${RUSTUP_ARCH}-unknown-linux-gnu/rustup-init" -o /tmp/rustup-init && \
    chmod +x /tmp/rustup-init && \
    /tmp/rustup-init -y --no-modify-path --profile minimal --default-toolchain "${RUST_TOOLCHAIN}" && \
    rm -f /tmp/rustup-init

# Coding agent CLIs (versions pinned for reproducible builds; Qoder is the
# default, the others are selected with AGENT_CLI: claude-code, copilot-cli,
# codex, gemini-cli)
RUN npm install -g \
      @qoder-ai/qodercli@1.1.65 \
      @anthropic-ai/claude-code@2.1.288 \
      @github/copilot@1.0.91 \
      @openai/codex@0.160.0 \
      @google/gemini-cli@0.62.0

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

# Run as a dedicated non-root user (uid/gid 10001). /data is chowned here for
# plain bind mounts; on Kubernetes the securityContext (runAsUser 10001,
# fsGroup 10001) takes ownership of the mounted volume.
RUN useradd --uid 10001 --user-group --create-home --shell /bin/bash planner && \
    mkdir -p /data && \
    chown planner:planner /data

WORKDIR /opt/app/planner-llm-agent

USER planner

CMD [ "node", "dist/App.js" ]
