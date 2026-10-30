ARG RUNTIME_IMAGE
FROM ${RUNTIME_IMAGE}
ADD root.tar /
ENTRYPOINT ["/usr/local/bin/node", "/app/packages/cli/src/preview/backend.mjs"]
CMD []
LABEL io.fogd.runtime.mode="preview-backend-candidate"
