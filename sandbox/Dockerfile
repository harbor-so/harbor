# syntax=docker/dockerfile:1.7
#
# The Harbor sandbox image.
#
# Two stages, and the split exists to keep one promise: **the running sandbox has
# no `node_modules` and runs `npm install` at no point during a boot.** The build
# stage has the full toolchain and compiles the TypeScript runtime to plain ESM;
# the final stage copies the emitted `.js` and nothing else. A boot that shells out
# to a package registry is a minute of latency and a network dependency at the
# worst possible moment — the moment a user is watching a spinner — and it fails
# closed on exactly the day the registry is having a bad afternoon.
#
# The base is Debian slim rather than Alpine. Agents shell out constantly, and the
# things they shell out to — prebuilt native modules, `node-gyp` output, anything
# shipping a manylinux wheel — are built against glibc. musl turns "install the
# dependencies" into a source build or a segfault, and the person who hits it is a
# self-hoster on their first afternoon.

ARG NODE_VERSION=22

# ---------------------------------------------------------------------------
# Stage 1 — compile the runtime
# ---------------------------------------------------------------------------

FROM node:${NODE_VERSION}-bookworm-slim AS build
WORKDIR /build

# Dependencies first so the layer caches across runtime edits. `npm ci` here is on
# the *builder*, never in the shipped image.
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

# Only what the in-sandbox runtime actually imports. The rest of `core/schema`,
# the rest of `core/kernel`, `app/lib` and the Next.js app are deliberately
# absent: if the runtime ever grows an import into them, this build fails rather
# than silently pulling a database driver and a web framework into a container
# whose entire job is to run one agent.
#
# Paths mirror the repository layout rather than being flattened, because the
# runtime's own specifiers are relative — `../../app/activity/types.js`,
# `../../core/kernel/config.js` — and only resolve if the tree shape survives.
COPY runtime ./runtime
COPY app/contracts ./app/contracts
COPY app/activity ./app/activity
COPY core/kernel/config.ts ./core/kernel/config.ts
# Type-only, and it is here for exactly that: the activity normalizers import
# `ActivityKind` from the schema. `import type` is erased in the emit, so no
# drizzle-orm reaches the shipped image — but the compiler still has to resolve it.
COPY core/schema/schema.ts ./core/schema/schema.ts

# NodeNext resolution, so `./adapters/index.js` in the source resolves to
# `adapters/index.ts` at compile time and stays `./adapters/index.js` in the emit —
# which is the specifier Node will actually look for at runtime.
RUN cat > tsconfig.sandbox.json <<'EOF'
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2023"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "outDir": "dist",
    "rootDir": ".",
    "sourceMap": true,
    "declaration": false
  },
  "include": ["runtime/**/*.ts", "app/**/*.ts", "core/**/*.ts"],
  "exclude": ["**/*.test.ts"]
}
EOF
# The schema's emit is deleted rather than kept. Nothing imports it at runtime —
# every reference to it is `import type`, which tsc erases — so shipping the
# compiled file would put the one module that pulls in drizzle-orm into an image
# with no node_modules, where loading it throws. Deleting it makes "no database
# driver in the sandbox" true of the filesystem and not just of the call graph.
RUN npx tsc -p tsconfig.sandbox.json \
	&& rm -rf dist/core/schema \
	&& printf '{"type":"module"}\n' > dist/package.json

# ---------------------------------------------------------------------------
# Stage 2 — the image a session actually runs in
# ---------------------------------------------------------------------------

FROM node:${NODE_VERSION}-bookworm-slim AS runtime

# `ripgrep` because every coding agent shells out to it and the fallback path
# (`grep -r` over a monorepo) is slow enough to change what the agent decides to
# look at. `build-essential` and `python3` because half of npm still compiles
# something. `ca-certificates` because without it every HTTPS call in the box
# fails with a certificate error that reads like a Harbor bug.
RUN apt-get update && apt-get install -y --no-install-recommends \
		bash \
		build-essential \
		ca-certificates \
		curl \
		git \
		gnupg \
		jq \
		less \
		openssh-client \
		procps \
		python3 \
		ripgrep \
		tini \
		unzip \
		zip \
	&& rm -rf /var/lib/apt/lists/*

# ---------------------------------------------------------------------------
# Agent CLIs — every one optional
# ---------------------------------------------------------------------------
#
# Off by default, and that is a strategic choice rather than a size optimisation.
# Harbor's claim is "bring your own agent"; an image that bakes in one agent makes
# that claim false in the first place anybody looks. An operator standardised on an
# in-house CLI builds this image with all three flags off and installs their own in
# `.harbor/setup.sh`, and nothing about the platform notices.
#
#   docker build -f sandbox/Dockerfile --build-arg INSTALL_CLAUDE_CODE=1 .
ARG INSTALL_CLAUDE_CODE=0
ARG INSTALL_CODEX=0
ARG INSTALL_OPENCODE=0

RUN set -eux; \
	if [ "$INSTALL_CLAUDE_CODE" = "1" ]; then npm install -g @anthropic-ai/claude-code; fi; \
	if [ "$INSTALL_CODEX" = "1" ]; then npm install -g @openai/codex; fi; \
	if [ "$INSTALL_OPENCODE" = "1" ]; then npm install -g opencode-ai; fi; \
	npm cache clean --force

# ---------------------------------------------------------------------------
# A non-root user
# ---------------------------------------------------------------------------
#
# The agent is running attacker-influenced text as instructions; root inside the
# container is one kernel bug or one careless bind mount away from root outside it.
# UID 10001 rather than the `node` user's 1000 because 1000 collides with the first
# human account on most hosts, and a bind-mounted workspace then comes out owned by
# a stranger.
RUN groupadd --gid 10001 harbor \
	&& useradd --uid 10001 --gid 10001 --create-home --shell /bin/bash harbor \
	&& mkdir -p /workspace /opt/harbor \
	&& chown -R harbor:harbor /workspace /opt/harbor

COPY --from=build --chown=harbor:harbor /build/dist /opt/harbor

# git looks up `git-credential-<name>` on PATH when `credential.helper` is a bare
# word, so the helper is installed under exactly that name. A shim rather than a
# `!node …` config value: the bang form is evaluated by a shell, and a repository
# path containing a space then becomes two arguments.
RUN printf '#!/bin/sh\nexec node /opt/harbor/runtime/git-credential-helper.js "$@"\n' \
		> /usr/local/bin/git-credential-harbor \
	&& chmod 0755 /usr/local/bin/git-credential-harbor

USER harbor
WORKDIR /workspace

# Declared so a provider that does not bind-mount still gets a writable layer with
# its own lifetime — and so `docker inspect` says where the state is, which is the
# first question anyone debugging a lost workspace asks.
VOLUME ["/workspace"]

ENV HARBOR_WORKSPACE_ROOT=/workspace \
	NODE_ENV=production \
	NO_COLOR=1 \
	GIT_TERMINAL_PROMPT=0 \
	PATH=/home/harbor/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# `tini` as PID 1. Without an init, the supervisor inherits every orphaned child an
# agent leaves behind — a dev server, a watcher, a package manager — and those
# become zombies that hold the workspace and the port for the life of the box. It
# also forwards SIGTERM properly, which is what gives the bridge its chance to
# drain before the container dies; without it the timeline stops mid-sentence.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "/opt/harbor/runtime/supervisor.js"]
