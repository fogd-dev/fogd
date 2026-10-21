# One-time cleanup record, not reproducible from the seed. Ordinary packaging
# trusts the exact cached clean parentImage in build-selected-runtime.mjs.
# Seed: sha256:1ee29c8d41f6b4e46db616413c2f6676fbe1639283658196e11891af8237bdae
FROM fogd-runtime:cron-v2-seed
RUN rm -rf /app/packages/platform/src /app/packages/runtime/src /app/packages/platform/test /app/packages/runtime/test
