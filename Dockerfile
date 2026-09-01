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

# Qoder CLI
RUN npm install -g @qoder-ai/qodercli

COPY --from=builder /opt/src/agent/node_modules /opt/app/planner-llm-agent/node_modules
COPY --from=builder /opt/src/agent/dist /opt/app/planner-llm-agent/dist
COPY agent/config.json /opt/app/planner-llm-agent/config.json
COPY package.json /opt/app/planner-llm-agent/package.json

WORKDIR /opt/app/planner-llm-agent

CMD [ "node", "dist/App.js" ]
