# Source-build candidate only; this recipe does not authorize runtime enrollment.
FROM --platform=linux/arm64 @@NODE_IMAGE@@ AS native-inputs
WORKDIR /inputs
COPY docker/runtime-native-inputs.json docker/runtime-native-inputs.mjs ./
RUN node runtime-native-inputs.mjs runtime-native-inputs.json /out

FROM --platform=linux/arm64 @@RUST_IMAGE@@ AS native
WORKDIR /src
ENV CARGO_INCREMENTAL=0
COPY --from=native-inputs /out/rusty-v8.a.gz /out/rusty-v8-bindings.rs /opt/fogd-native/
ENV RUSTY_V8_ARCHIVE=/opt/fogd-native/rusty-v8.a.gz
ENV RUSTY_V8_SRC_BINDING_PATH=/opt/fogd-native/rusty-v8-bindings.rs
COPY native/ ./
RUN test "$(rustc --version | cut -d ' ' -f 2)" = '1.98.1' && \
    test "$(rustc -vV | sed -n 's/^host: //p')" = 'aarch64-unknown-linux-gnu'
RUN rustup component add clippy --toolchain 1.98.1
RUN cargo build --release --locked -p celld
# Public upstream cargo tests may execute zero cases. Qualification needs its
# separate native lifecycle evidence even when this compilation/lint stage passes.
RUN cargo test --release --locked && \
    cargo clippy --release --all-targets --locked -- -D warnings
RUN mkdir /out && install -m 755 target/release/celld /out/celld && \
    rustc -vV > /out/toolchain.txt && cargo --version >> /out/toolchain.txt

FROM --platform=linux/arm64 @@NODE_IMAGE@@ AS runtime
WORKDIR /app
RUN node -e "if (process.version !== 'v26.2.0' || process.platform !== 'linux' || process.arch !== 'arm64') process.exit(1)"
COPY docker/runtime-tools/ /opt/pnpm/
RUN npm ci --prefix /opt/pnpm --omit=dev --ignore-scripts
ENV PATH="/opt/pnpm/node_modules/.bin:/app/packages/runtime/node_modules/workerd/bin:${PATH}"
RUN test "$(pnpm --version)" = '10.16.1'
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches/ patches/
COPY packages/runtime/package.json packages/runtime/package.json
COPY packages/platform/package.json packages/platform/package.json
RUN pnpm install --filter @fogd/runtime --filter @fogd/platform --prod --frozen-lockfile --ignore-scripts
COPY packages/runtime/src/ packages/runtime/src/
COPY packages/platform/src/ packages/platform/src/
COPY docker/runtime-workerd.mjs docker/runtime-workerd.mjs
RUN node docker/runtime-workerd.mjs
COPY --from=native /out/celld /usr/local/bin/celld
COPY --from=native /etc/ssl/certs /etc/ssl/certs
COPY --from=native /out/toolchain.txt /usr/share/fogd-build/native-toolchain.txt
COPY --from=native-inputs /out/receipt.json /usr/share/fogd-build/native-inputs.json
COPY native/LICENSE native/NOTICE /usr/share/doc/celld/
COPY docker/celld-supervisor.sh /usr/local/bin/celld-supervisor
RUN /usr/local/bin/celld --version && workerd --version && \
    sha256sum /usr/local/bin/celld /usr/local/bin/celld-supervisor
CMD ["node", "packages/runtime/src/serve.mjs"]
