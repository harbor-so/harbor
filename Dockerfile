# syntax=docker/dockerfile:1.7
#
# The Harbor control plane.
#
# Not to be confused with `sandbox/Dockerfile`, which builds the box an *agent*
# runs in. This one builds Harbor itself: the Next.js dashboard, the MCP server
# that owns every background loop, and the migration runner. `DEPLOY.md` told
# operators to run `your-registry/harbor:latest` for a long time before anything
# in the repository built it.
#
# ---------------------------------------------------------------------------
# One image, three processes, chosen by the first argument
# ---------------------------------------------------------------------------
#
#   docker run harbor web       the dashboard          (:3000)
#   docker run harbor mcp       loops + MCP surfaces   (:8788)
#   docker run harbor migrate   one-shot, then exits
#   docker run harbor doctor    print resolved config, construct every provider
#
# One image rather than two because the two processes are one npm package sharing
# a schema and a migrations directory. Two tags make version skew *representable*,
# and the advisory locks only make a mixed-version fleet safe for the duration of
# a rolling restart — not indefinitely. One tag makes the bad state impossible to
# express rather than merely unlikely.
#
# ---------------------------------------------------------------------------
# Why not `output: "standalone"`
# ---------------------------------------------------------------------------
#
# Standalone traces the web server's imports and ships only those, which would cut
# this image a long way. It is not used here for two reasons, and the second is
# the decisive one:
#
#   1. The saving evaporates in a combined image. The MCP process runs from source
#      through `tsx` and needs a real `node_modules` regardless, so a standalone
#      build would mean shipping both trees rather than one.
#   2. Tracing is exactly where `@codesandbox/sdk` (via `blessed`) and `modal` (via
#      `protobufjs` and `@grpc/grpc-js`) break — all three resolve modules by
#      computed expression, which no static tracer can follow. The fix would be a
#      hand-maintained `outputFileTracingIncludes` list that silently rots every
#      time a vendor SDK changes its internals, and whose failure mode is a
#      provider throwing MODULE_NOT_FOUND in production.
#
# If image size ever becomes the binding constraint, the exit is to split into
# `harbor-web` (standalone) and `harbor-mcp` (prod deps). `docker/entrypoint.sh`
# already isolates the only difference between them, so that split is a build
# change and not a code change.

ARG NODE_VERSION=22

# ---------------------------------------------------------------------------
# Stage 1 — dependencies
# ---------------------------------------------------------------------------

FROM node:${NODE_VERSION}-bookworm-slim AS deps
WORKDIR /app

# Manifests only, so this layer caches across every source edit.
COPY package.json package-lock.json ./
RUN npm ci

# ---------------------------------------------------------------------------
# Stage 2 — build the Next.js app
# ---------------------------------------------------------------------------

FROM node:${NODE_VERSION}-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# No DATABASE_URL is set here on purpose. Every page is `force-dynamic` or a route
# handler, so nothing touches Postgres at build time — and if that ever stops
# being true, this build fails rather than quietly baking a build-time database
# connection into an image that will run somewhere else entirely.
RUN npm run build

# ---------------------------------------------------------------------------
# Stage 3 — production dependencies only
# ---------------------------------------------------------------------------
#
# A second clean install rather than pruning stage 1, because `npm prune` leaves
# the dev tree's layout behind and the result is larger than a fresh install.
#
# `tsx` is a production dependency, not a dev one, and that is deliberate: the MCP
# server genuinely runs TypeScript through it in production. The alternative — a
# second `tsc` configuration emitting `dist/` for eight source directories — buys
# a smaller image and a whole new failure class ("works under tsx, the emit is
# subtly different in prod") for a process nothing else compiles separately.
# `next.config.js` already makes this trade explicitly for the same reason.

FROM node:${NODE_VERSION}-bookworm-slim AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --omit=optional && npm cache clean --force

# ---------------------------------------------------------------------------
# Stage 4 — the image that actually runs
# ---------------------------------------------------------------------------

FROM node:${NODE_VERSION}-bookworm-slim AS runtime
WORKDIR /app

# `tini` for the same reason as the sandbox image: both the `docker` provider and
# `app/lib/runner.ts` spawn children, and without an init those become zombies
# that outlive the request that made them. It also forwards SIGTERM, which is what
# gives an in-flight SSE stream its chance to close cleanly on a rolling restart.
# `ca-certificates` because every provider and connector call is HTTPS, and
# without it they fail with a certificate error that reads like a Harbor bug.
RUN apt-get update && apt-get install -y --no-install-recommends \
		ca-certificates \
		tini \
	&& rm -rf /var/lib/apt/lists/*

# ---------------------------------------------------------------------------
# The docker CLI — on by default, and worth the megabytes
# ---------------------------------------------------------------------------
#
# `docker` is Harbor's DEFAULT sandbox provider, and `app/sandbox/providers/docker.ts`
# shells out to the binary. An image without it means the out-of-the-box
# configuration fails its first spawn with ENOENT, which is a bad first run for
# the exact deployment shape the README promises. The client only — never the
# daemon; the socket is mounted from the host, with everything that implies (see
# docs/SECURITY.md).
#
#   --build-arg INSTALL_DOCKER_CLI=0   for a deployment on a remote provider
ARG INSTALL_DOCKER_CLI=1
RUN set -eux; \
	if [ "$INSTALL_DOCKER_CLI" = "1" ]; then \
		apt-get update; \
		apt-get install -y --no-install-recommends ca-certificates curl gnupg; \
		install -m 0755 -d /etc/apt/keyrings; \
		curl -fsSL https://download.docker.com/linux/debian/gpg \
			| gpg --dearmor -o /etc/apt/keyrings/docker.gpg; \
		chmod a+r /etc/apt/keyrings/docker.gpg; \
		echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
			> /etc/apt/sources.list.d/docker.list; \
		apt-get update; \
		apt-get install -y --no-install-recommends docker-ce-cli; \
		rm -rf /var/lib/apt/lists/*; \
	fi

# UID 10001 rather than the `node` user's 1000, matching sandbox/Dockerfile and
# for the same reason: 1000 is the first human account on most hosts, so a
# bind-mounted path comes out owned by a stranger.
#
# One consequence to plan for: this user cannot read /var/run/docker.sock, which
# is root:docker. A deployment using the `docker` provider must add the host's
# docker gid — `group_add: ["${DOCKER_GID:-999}"]` in compose. Running as root to
# avoid that trades a documented step for an undocumented privilege.
RUN groupadd --gid 10001 harbor \
	&& useradd --uid 10001 --gid 10001 --create-home --shell /bin/bash harbor

COPY --from=prod-deps --chown=harbor:harbor /app/node_modules ./node_modules
COPY --from=build --chown=harbor:harbor /app/.next ./.next
# No `public/` COPY: the repository has no public directory, and a COPY of a
# missing path fails the build. Add one here if static assets are ever added.

# Runtime source. `core/`, `app/`, `runtime/` and `scripts/` because the MCP server
# and the scripts are executed from TypeScript; `drizzle/` because the migrator
# resolves `./drizzle` relative to the working directory and a missing directory
# there is a migration that silently applies nothing.
#
# `tsconfig.json` is not here for the compiler — nothing compiles in this image —
# but because `tsx` reads the `@core/*` and `@app/*` path aliases from it. Without
# that file every aliased import in the MCP process fails to resolve at boot.
#
# `instrumentation.ts` rides along on the same line. `next build` compiles it into
# `.next`, so `next start` does not read the source — but it is the one source
# file Next resolves from the repository root and nowhere else, and before the
# zone split it shipped as part of the source tree without anyone naming it.
# Copying it costs a line; omitting it is how the web tier's boot checks stop
# running without anybody noticing, which is the exact failure it exists to prevent.
#
# The zones are copied lowest-first, `core/` before `app/`: core is the Apache-2.0
# layer that nothing outside it may import, so it is also the layer that changes
# least often, and putting it first keeps an edit confined to `app/` from
# invalidating its layer.
COPY --chown=harbor:harbor package.json next.config.js postcss.config.js tsconfig.json next-env.d.ts instrumentation.ts ./
COPY --chown=harbor:harbor core ./core
COPY --chown=harbor:harbor app ./app
COPY --chown=harbor:harbor runtime ./runtime
COPY --chown=harbor:harbor scripts ./scripts
COPY --chown=harbor:harbor drizzle ./drizzle
COPY --chown=harbor:harbor docker/entrypoint.sh /usr/local/bin/harbor-entrypoint

RUN chmod 0755 /usr/local/bin/harbor-entrypoint

USER harbor

# HOST=0.0.0.0 is set HERE rather than changing the default in app/mcp/server.ts.
# The source default stays loopback so `npm run mcp` on a laptop is not silently
# published to a shared network; inside a container 0.0.0.0 binds only this
# container's namespace, and what is actually reachable is decided by which ports
# are published. Both properties, neither traded for the other.
ENV NODE_ENV=production \
	NEXT_TELEMETRY_DISABLED=1 \
	HOST=0.0.0.0 \
	PORT=3000 \
	HARBOR_MCP_PORT=8788

EXPOSE 3000 8788

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/harbor-entrypoint"]
CMD ["web"]
