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

# Basic development essentials
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      bash \
      build-essential \
      ca-certificates \
      curl \
      git \
      gzip \
      jq \
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

# Kubernetes CLI
RUN ARCH=$(dpkg --print-architecture) && \
    KUBECTL_VERSION=$(curl -fsSL https://dl.k8s.io/release/stable.txt) && \
    curl -fsSL "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${ARCH}/kubectl" -o /usr/local/bin/kubectl && \
    chmod +x /usr/local/bin/kubectl

# Helm CLI
RUN curl -fsSL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash

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

# Rust
ENV RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo \
    PATH="/usr/local/cargo/bin:${PATH}"
RUN curl -fsSL https://sh.rustup.rs | sh -s -- -y --no-modify-path --profile minimal

# Qoder CLI
RUN npm install -g @qoder-ai/qodercli

# Verify all tools are available
RUN node --version && npm --version && git --version && gh --version && \
    kubectl version --client && helm version && yq --version && \
    jq --version && shellcheck --version | head -2 && \
    python3 --version && go version && java --version && \
    cargo --version && rustc --version && qoder --version

COPY --from=builder /opt/src/agent/node_modules /opt/app/planner-llm-agent/node_modules
COPY --from=builder /opt/src/agent/dist /opt/app/planner-llm-agent/dist
COPY agent/config.json /opt/app/planner-llm-agent/config.json
COPY package.json /opt/app/planner-llm-agent/package.json

WORKDIR /opt/app/planner-llm-agent

CMD [ "node", "dist/App.js" ]
