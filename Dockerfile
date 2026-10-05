# twitch-party-overlay — the compiled single binary in an otherwise empty image.
#
#   builder  oven/bun (pinned)  bun install + `bun build --compile` → one static musl binary with the pages embedded
#   runtime  scratch            that binary, the three shared libraries bun's musl build still needs (the musl loader,
#                               libstdc++, libgcc_s), the Mozilla CA bundle (TLS to Twitch / StreamElements / Ko-fi), a
#                               passwd line for the unprivileged user, and nothing else. No shell, no package manager.
#
# Data (config.json, ledger.sqlite, mods.json) lives on the /data volume; the secrets file is mounted by docker-compose.yml.
# Build:  just build      (docker compose build — passes VERSION / GIT_SHA from package.json and git)
ARG BUN_VERSION=1.4.2

FROM oven/bun:${BUN_VERSION}-alpine AS builder
ARG TARGETARCH
WORKDIR /app
COPY package.json bun.lock tsconfig.json ./
RUN bun install --frozen-lockfile
COPY src ./src
# TARGETARCH is amd64 | arm64 (Docker's names); bun wants x64 | arm64. `-musl` = statically linked, so it runs on scratch.
RUN ARCH=$([ "$TARGETARCH" = "amd64" ] && echo x64 || echo "$TARGETARCH") \
 && bun build --compile --minify --target="bun-linux-${ARCH}-musl" src/main.ts --outfile /out/twitch-party-overlay
# What `ldd` says the binary needs (dereferenced, so scratch gets real files), a writable /tmp and the /data mount point
# owned by the runtime user (uid 1000), and a passwd line for it.
RUN mkdir -p /out/lib /out/usr/lib /out/tmp /out/data \
 && cp -L /lib/ld-musl-*.so.1 /out/lib/ && cp -L /usr/lib/libstdc++.so.6 /usr/lib/libgcc_s.so.1 /out/usr/lib/ \
 && chown -R 1000:1000 /out && chmod 1777 /out/tmp \
 && echo "overlay:x:1000:1000::/data:/sbin/nologin" > /out/passwd && echo "overlay:x:1000:" > /out/group

FROM scratch
ARG VERSION=dev
ARG GIT_SHA=unknown
LABEL org.opencontainers.image.title="twitch-party-overlay" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${GIT_SHA}" \
      org.opencontainers.image.source="https://github.com/goproslowyo/twitch-party-overlay" \
      org.opencontainers.image.licenses="MIT"
COPY --from=builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=builder /out/passwd /etc/passwd
COPY --from=builder /out/group /etc/group
COPY --from=builder /out/lib /lib
COPY --from=builder /out/usr/lib /usr/lib
COPY --from=builder /out/tmp /tmp
COPY --from=builder /out/data /data
COPY --from=builder /out/twitch-party-overlay /twitch-party-overlay
# IN_DOCKER=1: no browser to open and no power manager to hold here (src/main.ts).
ENV BIND_ALL=1 IN_DOCKER=1 DATA_DIR=/data SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt TMPDIR=/tmp
USER overlay
VOLUME /data
EXPOSE 8700 8701 8702
ENTRYPOINT ["/twitch-party-overlay"]
