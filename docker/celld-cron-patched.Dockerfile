# Experimental image: the source stage must contain the labelled patches.
ARG CELLD_TESTED_IMAGE=fogd-celld-cron-build4:local
ARG CELLD_BASE_IMAGE=ghcr.io/denoland/celld:0.6.2@sha256:b85983dcf410bcf710bbc30f400d8654123cb2b541ca4d84d7e299009a6ee97a
FROM ${CELLD_TESTED_IMAGE} AS built
FROM ${CELLD_BASE_IMAGE}
COPY --from=built /out/celld /usr/local/bin/celld
ARG CELLD_PATCHES=preaccept-attachment,cron-retry-candidate4
ARG CELLD_PATCH_DIGESTS=unrecorded
LABEL io.fogd.celld.base-revision="90b43017241f81189453d326d05948f388b34652" \
      io.fogd.celld.patch="${CELLD_PATCHES}" \
      io.fogd.celld.patch-digests="${CELLD_PATCH_DIGESTS}"
