# BUILD
FROM node:26 AS builder

WORKDIR /opt/src

COPY agent agent

RUN cd agent && \
    npm ci && \
    npm run build && \
    npm prune --omit=dev

# RUN
FROM ubuntu:26.04

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

# NodeJS (official tarball: version pinned, checksum verified against the
# SHASUMS256.txt of the same versioned directory)
ARG NODE_VERSION=26.13.0
RUN ARCH=$(dpkg --print-architecture) && \
    case "$ARCH" in \
      amd64) NODE_ARCH=x64 ;; \
      arm64) NODE_ARCH=arm64 ;; \
      *) echo "unsupported architecture for Node.js" >&2; exit 1 ;; \
    esac && \
    curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.gz" -o "/tmp/node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.gz" && \
    curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt" -o /tmp/SHASUMS256.txt && \
    (cd /tmp && grep " node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.gz\$" SHASUMS256.txt | sha256sum -c -) && \
    tar -xzf "/tmp/node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.gz" -C /usr/local --strip-components=1 --no-same-owner && \
    rm -f "/tmp/node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.gz" /tmp/SHASUMS256.txt

# GitHub CLI (apt keyring checksum pinned; apt then installs gh through the
# signature-verified repository. Refresh the checksum after a GitHub CLI
# signing-key rotation:
# curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | sha256sum)
ARG GH_CLI_KEYRING_SHA256=6084d5d7bd8e288441e0e94fc6275570895da18e6751f70f057485dc2d1a811b
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli-archive-keyring.gpg && \
    echo "${GH_CLI_KEYRING_SHA256}  /usr/share/keyrings/githubcli-archive-keyring.gpg" | sha256sum -c - && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list && \
    apt-get update && \
    apt-get install -y --no-install-recommends gh && \
    rm -rf /var/lib/apt/lists/*

# Kubernetes CLI (version pinned, checksum verified against the vendor
# .sha256 published next to the binary)
ARG KUBECTL_VERSION=v1.37.2
RUN ARCH=$(dpkg --print-architecture) && \
    curl -fsSL "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${ARCH}/kubectl" -o /usr/local/bin/kubectl && \
    curl -fsSL "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${ARCH}/kubectl.sha256" -o /tmp/kubectl.sha256 && \
    echo "$(cat /tmp/kubectl.sha256)  /usr/local/bin/kubectl" | sha256sum -c - && \
    chmod +x /usr/local/bin/kubectl && \
    rm -f /tmp/kubectl.sha256

# Helm CLI (version pinned for reproducible builds, checksum verified)
ARG HELM_VERSION=v4.3.1
RUN ARCH=$(dpkg --print-architecture) && \
    curl -fsSL "https://get.helm.sh/helm-${HELM_VERSION}-linux-${ARCH}.tar.gz" -o /tmp/helm.tar.gz && \
    curl -fsSL "https://get.helm.sh/helm-${HELM_VERSION}-linux-${ARCH}.tar.gz.sha256sum" -o /tmp/helm.tar.gz.sha256sum && \
    echo "$(awk '{print $1}' /tmp/helm.tar.gz.sha256sum)  /tmp/helm.tar.gz" | sha256sum -c - && \
    tar -C /tmp -xzf /tmp/helm.tar.gz && \
    install /tmp/linux-${ARCH}/helm /usr/local/bin/helm && \
    rm -rf /tmp/helm.tar.gz /tmp/helm.tar.gz.sha256sum /tmp/linux-${ARCH}

# yq (version pinned, SHA-256 pinned per architecture from the SHA-256 column
# of the vendor checksums file:
# https://github.com/mikefarah/yq/releases/download/v4.54.1/checksums)
ARG YQ_VERSION=v4.54.1
ARG YQ_SHA256_AMD64=8e34fc298390875de416e6a4afcb8cabeceb25d9aa8506c1a2f9353cf702ea5f
ARG YQ_SHA256_ARM64=189088da0c6429ec5178dfaab1a114805f6cab0b61b165ab236efedf1d57a71b
RUN ARCH=$(dpkg --print-architecture) && \
    case "$ARCH" in \
      amd64) YQ_SHA256=${YQ_SHA256_AMD64} ;; \
      arm64) YQ_SHA256=${YQ_SHA256_ARM64} ;; \
      *) echo "unsupported architecture for yq" >&2; exit 1 ;; \
    esac && \
    curl -fsSL "https://github.com/mikefarah/yq/releases/download/${YQ_VERSION}/yq_linux_${ARCH}" -o /usr/local/bin/yq && \
    echo "${YQ_SHA256}  /usr/local/bin/yq" | sha256sum -c - && \
    chmod +x /usr/local/bin/yq

# Go (version pinned, SHA-256 pinned per architecture from
# https://go.dev/dl/?mode=json&include=all)
ARG GO_VERSION=1.27.3
ARG GO_SHA256_AMD64=65efbc80fdc1fa2cd2631cad5b481777a68e8725f34e89f50fc6ac714e379b40
ARG GO_SHA256_ARM64=a06e99309dbcbdca1a8ccd2282c3ee146e55930886e26b4f1193269587165f49
RUN ARCH=$(dpkg --print-architecture) && \
    case "$ARCH" in \
      amd64) GO_SHA256=${GO_SHA256_AMD64} ;; \
      arm64) GO_SHA256=${GO_SHA256_ARM64} ;; \
      *) echo "unsupported architecture for Go" >&2; exit 1 ;; \
    esac && \
    curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-${ARCH}.tar.gz" -o /tmp/go.tar.gz && \
    echo "${GO_SHA256}  /tmp/go.tar.gz" | sha256sum -c - && \
    tar -C /usr/local -xzf /tmp/go.tar.gz && \
    rm -f /tmp/go.tar.gz
ENV PATH="/usr/local/go/bin:${PATH}"

# Rust (rustup-init from the pinned release archive, vendor .sha256 verified;
# toolchain pinned for reproducible builds)
ARG RUSTUP_VERSION=1.29.2
ARG RUST_TOOLCHAIN=1.99.1
ENV RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo \
    PATH="/usr/local/cargo/bin:${PATH}"
RUN RUSTUP_ARCH=$(case "$(dpkg --print-architecture)" in \
      amd64) echo x86_64 ;; \
      arm64) echo aarch64 ;; \
      *) echo "unsupported architecture for Rust" >&2 && exit 1 ;; \
    esac) && \
    curl -fsSL "https://static.rust-lang.org/rustup/archive/${RUSTUP_VERSION}/${RUSTUP_ARCH}-unknown-linux-gnu/rustup-init" -o /tmp/rustup-init && \
    curl -fsSL "https://static.rust-lang.org/rustup/archive/${RUSTUP_VERSION}/${RUSTUP_ARCH}-unknown-linux-gnu/rustup-init.sha256" -o /tmp/rustup-init.sha256 && \
    echo "$(awk '{print $1}' /tmp/rustup-init.sha256)  /tmp/rustup-init" | sha256sum -c - && \
    chmod +x /tmp/rustup-init && \
    /tmp/rustup-init -y --no-modify-path --profile minimal --default-toolchain "${RUST_TOOLCHAIN}" && \
    rm -f /tmp/rustup-init /tmp/rustup-init.sha256

# Coding agent CLIs (versions pinned for reproducible builds; Qoder is the
# default, the others are selected with AGENT_CLI: claude-code, copilot-cli,
# codex, gemini-cli)
RUN npm install -g \
      @qoder-ai/qodercli@1.1.81 \
      @anthropic-ai/claude-code@2.1.316 \
      @github/copilot@1.0.105 \
      @openai/codex@0.166.0 \
      @google/gemini-cli@0.66.0

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
COPY agent/skills /opt/app/planner-llm-agent/skills

# Fail the build if pruning removed a runtime dependency.
RUN cd /opt/app/planner-llm-agent && \
    node -e "require('fs-extra'); require('yaml'); require('@devopsplaybook.io/otel-utils')"

# Run as a dedicated non-root user (uid/gid 10001). /data is chowned here for
# plain bind mounts; on Kubernetes the securityContext (runAsUser 10001,
# fsGroup 10001) takes ownership of the mounted volume.
RUN useradd --uid 10001 --user-group --create-home --shell /bin/bash planner && \
    mkdir -p /data && \
    chown planner:planner /data

WORKDIR /opt/app/planner-llm-agent

USER planner

CMD [ "node", "dist/App.js" ]
