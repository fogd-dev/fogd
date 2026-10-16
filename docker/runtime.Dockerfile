FROM ghcr.io/denoland/celld:0.6.2@sha256:b85983dcf410bcf710bbc30f400d8654123cb2b541ca4d84d7e299009a6ee97a AS celld
FROM node:26.2.0-bookworm-slim
WORKDIR /app
RUN npm install --prefix /opt/pnpm pnpm@10.16.1
ENV PATH="/opt/pnpm/node_modules/.bin:/app/packages/runtime/node_modules/.bin:${PATH}"
COPY --from=celld /usr/local/bin/celld /usr/local/bin/celld
COPY --from=celld /etc/ssl/certs /etc/ssl/certs
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/runtime/package.json packages/runtime/package.json
COPY packages/platform/package.json packages/platform/package.json
RUN pnpm install --filter @fogd/runtime --filter @fogd/platform --prod --frozen-lockfile
COPY packages/runtime packages/runtime
COPY packages/platform packages/platform
COPY docker/celld-supervisor.sh /usr/local/bin/celld-supervisor
CMD ["node", "packages/runtime/src/serve.mjs"]
