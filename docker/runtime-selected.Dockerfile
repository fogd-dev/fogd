FROM fogd-runtime:cron-v2-dependency-base
COPY packages/ /app/packages/
LABEL io.fogd.runtime.family="celld-cron-v2-linux-arm64"
