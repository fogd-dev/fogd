# Build the pinned celld source with its upstream test stage before using this.
ARG CELLD_TESTED_IMAGE=fogd-celld-tested:local
ARG CELLD_BASE_IMAGE=ghcr.io/denoland/celld:0.6.2@sha256:b85983dcf410bcf710bbc30f400d8654123cb2b541ca4d84d7e299009a6ee97a
FROM ${CELLD_TESTED_IMAGE} AS tested
FROM ${CELLD_BASE_IMAGE}
COPY --from=tested /out/celld /usr/local/bin/celld
LABEL io.fogd.celld.base-revision="90b43017241f81189453d326d05948f388b34652" \
      io.fogd.celld.patch-sha256="9a46a9d878df615eb3efad73ac501e1e5202b4b629c9c4082dbfb33c99e9b2dd" \
      io.fogd.celld.patch="preaccept-attachment"
