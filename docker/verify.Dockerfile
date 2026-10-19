FROM node:26.2.0-bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
RUN npm install --prefix /opt/pnpm pnpm@10.16.1
ENV PATH="/opt/pnpm/node_modules/.bin:${PATH}" VOID_REMOTE=0 WRANGLER_SEND_METRICS=false
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches patches
COPY packages packages
COPY examples examples
COPY scripts scripts
RUN pnpm install --frozen-lockfile
CMD ["node", "scripts/verify-builds.mjs"]
