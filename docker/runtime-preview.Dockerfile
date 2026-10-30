ARG STORAGE_IMAGE
ARG RUNTIME_IMAGE
FROM ${STORAGE_IMAGE} AS storage
FROM ${RUNTIME_IMAGE}
COPY --from=storage /usr/local/bin/minio /usr/local/bin/minio
COPY app/ /app/
ENTRYPOINT ["/usr/local/bin/node", "/app/preview/backend.mjs"]
CMD []
LABEL io.fogd.runtime.mode="preview-backend-candidate"
