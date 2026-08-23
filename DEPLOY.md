# Deploying Harbor

Six shapes, in increasing order of effort. Pick the smallest one that fits.

Everything Harbor needs is a Node process and a Postgres database. Shapes 1–4
require an account with nobody. Shapes 5 and 6 are for running Harbor on somebody
else's infrastructure, which is a choice rather than a requirement.

**Whatever you pick, Harbor is two processes.** The Next.js app serves the
dashboard and the API and deliberately starts no timers — it is serverless-shaped
and may have zero warm instances, so a `setInterval` there is a promise the
runtime cannot keep. The `mcp` process owns every background sweep: expired
leases, sandbox deadlines, event compaction, orphan reconciliation, Devin
polling. **Run only the first and nothing ever sweeps.** The escape hatch is
`HARBOR_MAINTENANCE_TOKEN` plus a cron hitting `POST /api/loops/tick`.

| Target | Dashboard | Worker | |
|---|---|---|---|
| Laptop / one VM | yes | yes | full |
| Docker Compose | yes | yes | full |
| Kubernetes | yes | yes | full |
| Fly.io | yes | yes | full |
| Render / Railway | yes | yes (worker service) | full — must be always-on |
| **Vercel** | degraded | **no** | see below |

Vercel cannot run the worker at all: there is no long-lived process, so the
`harbor-agent` MCP surface cannot be served and background agents lose
`report_progress`, `record_artifact`, `spawn_child` and `get_session_context`.
SSE routes survive only to the function's max duration, and each holds a
dedicated Postgres connection for its life, which exhausts a serverless
connection cap quickly. There is deliberately no `vercel.json` in this
repository: committing one would read as an endorsement of a shape that silently
drops a documented feature.

---

## 1. Your laptop

For evaluating it, and for a single engineer running agents against their own
repositories.

```bash
docker compose up -d
npm install && cp .env.example .env
openssl rand -base64 32   # HARBOR_ENCRYPTION_KEY
openssl rand -base64 32   # AUTH_SECRET
npm run db:migrate && npm run db:seed
npm run sandbox:build
npm run dev
```

Sign-in is bypassed outside production when `GITHUB_CLIENT_ID` is unset, and the
dashboard says so in a banner on every page. The bypass refuses to engage when
`NODE_ENV=production` regardless of configuration, because the failure mode of
getting that backwards is an unauthenticated dashboard on the internet.

---

## 2. One VM

The shape most teams should run. A single host with Docker, Postgres and Harbor,
behind whatever ingress you already have.

```
┌─ your VM ────────────────────────────────────┐
│  nginx / Caddy  →  Harbor (Node, :3000)      │
│                    Harbor MCP     (:8788)    │
│                    Postgres       (:5432)    │
│                    Docker socket → sandboxes │
└──────────────────────────────────────────────┘
```

**Sizing.** A sandbox is a container with a clone of your repository and its
dependencies. Budget 2 vCPU and 4 GB per concurrent session, plus 2 vCPU and 4 GB
for Harbor and Postgres. Eight concurrent sessions is comfortable on a 16-core,
64 GB box.

**The Docker socket.** Harbor's `docker` provider talks to the daemon, so the
Harbor process can create containers on that host. That is the same privilege
level as root on the machine. Run Harbor as its own user in the `docker` group on
a host that does nothing else, and read [docs/SECURITY.md](./docs/SECURITY.md)
before deciding it is acceptable.

**Ingress.** Two things need to work through your proxy: Server-Sent Events, and
long-lived connections. Nginx buffers SSE into uselessness by default; Harbor
sends `x-accel-buffering: no`, which nginx honours, but check your own config for
a `proxy_buffering on` that overrides it.

```nginx
location / {
  proxy_pass http://127.0.0.1:3000;
  proxy_http_version 1.1;
  proxy_buffering off;
  proxy_read_timeout 3600s;
  proxy_set_header Connection "";
}
```

**Postgres.** Harbor opens one dedicated connection per open event stream, on top
of its pool, because `LISTEN` occupies a connection for as long as it is
listening. A `max_connections` of 100 supports roughly 80 simultaneously open
dashboards. Raise it, or put PgBouncer in front in *session* pooling mode —
**not** transaction pooling, which breaks `LISTEN/NOTIFY` and advisory locks, and
breaks them silently: the product appears to work and the dashboard simply stops
updating.

**Backups.** Everything is in Postgres. `pg_dump` is a complete backup, with one
exception: encrypted values are useless without `HARBOR_ENCRYPTION_KEY`, so store
that key somewhere your database backup is not.

---

## 3. Kubernetes

Harbor is a stateless deployment plus a Postgres you already run. The only real
decision is where sandboxes go.

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: harbor
spec:
  replicas: 2            # safe: the scheduler is advisory-locked, not a singleton
  template:
    spec:
      containers:
        - name: harbor
          image: your-registry/harbor:latest
          ports: [{ containerPort: 3000 }]
          envFrom: [{ secretRef: { name: harbor-env } }]
          readinessProbe:
            httpGet: { path: /api/health, port: 3000 }
          livenessProbe:
            # Note the ?probe=live. Readiness depends on Postgres; liveness must
            # not. Point the liveness probe at the readiness path and a database
            # blip restarts every replica simultaneously, turning a recoverable
            # dependency failure into a total outage plus a cold start.
            httpGet: { path: /api/health?probe=live, port: 3000 }
```

More than one replica is safe. The automation scheduler takes a Postgres advisory
lock rather than being a designated singleton, and the session runner takes one
per session, so replicas cooperate without electing a leader.

**Sandboxes on Kubernetes.** Do not mount the node's Docker socket into the Harbor
pod — that is root on the node, for a pod that runs attacker-influenced text as
instructions. Either run the Harbor deployment on a dedicated node pool with the
`docker` provider and accept that, or use one of the VM-isolated remote providers,
which is what `deploy/k8s/configmap.yaml` defaults to. A first-class Kubernetes
Job provider does not exist yet and is the obvious contribution — it is the only
way to get a real isolation boundary that stays inside your own cluster — and the
provider contract test suite is what proves one correct.

The full provider list is `SANDBOX_PROVIDER_NAMES` in `app/sandbox/registry.ts`,
and their isolation tiers are in [docs/SECURITY.md](./docs/SECURITY.md). It is
deliberately not restated here — this document carried "the shipped providers are
`docker` and `local`" for three releases after that stopped being true.

Committed manifests live in [`deploy/k8s/`](./deploy/k8s/):

```bash
kubectl kustomize deploy/k8s        # render offline, no cluster required
kubectl apply -k deploy/k8s
```

---

## 4. Hosted Postgres

Change one line.

```bash
DATABASE_URL=postgres://user:pass@db.example.neon.tech/harbor?sslmode=verify-full
```

Nothing else in the codebase constructs a database client, so Supabase, Neon, RDS
and Cloud SQL all work unchanged. Three caveats, and the first is a security one.

- **Use `verify-full`, not `require`.** This document recommended `require` until
  recently, and that was wrong. postgres.js maps the DSN's `sslmode` onto its own
  `ssl` option and then does:

  ```js
  if (ssl === 'require' || ssl === 'allow' || ssl === 'prefer')
    options.rejectUnauthorized = false
  ```

  So `sslmode=require` gives you an encrypted connection with **certificate
  verification switched off** — anyone who can answer for that hostname can read
  and rewrite everything, including the ciphertext of every encrypted secret.
  `verify-full` falls through to Node's TLS defaults and actually checks the
  chain and the hostname. The name is the trap: `require` requires *encryption*,
  not *identity*.

  If `verify-full` fails against a provider with a private CA — AWS RDS is the
  common one — point `NODE_EXTRA_CA_CERTS` at their bundle rather than weakening
  the mode.

- **`LISTEN/NOTIFY` must survive your pooler.** Supabase's pooled connection
  string (port 6543) is transaction-pooled and will break live updates. Use the
  direct connection string (port 5432). The same applies to PgBouncer in its
  default mode and to **RDS Proxy**, which pins the connection for `LISTEN` and
  session advisory locks anyway — defeating the proxy while breaking the
  notification path. Connect to the RDS writer endpoint directly.

- **Connection limits are lower than you think** on serverless tiers. See the
  note above about one connection per open stream.

Harbor checks both of these at startup and prints a warning naming the problem —
`describeDatabaseTls` in `core/schema/tls.ts`. It warns rather than rewriting your
DSN, because `require` plus `NODE_EXTRA_CA_CERTS` is a legitimate configuration
and silently upgrading it would break exactly the deployments that chose it
deliberately. `docker run <image> doctor` prints the same report on demand.

---

## 5. Containers

`Dockerfile` at the repository root builds the control plane. (`sandbox/Dockerfile`
is a different image — the box an *agent* runs in.) One image serves all three
processes, chosen by the first argument:

```bash
npm run docker:build                      # or: docker build -t harbor:latest .

docker run harbor web       # the dashboard        :3000
docker run harbor mcp       # loops + MCP surfaces :8788
docker run harbor migrate   # one-shot, then exits
docker run harbor doctor    # print resolved config, construct every provider
```

Published on every push to `main`:

```
ghcr.io/<owner>/harbor:latest
ghcr.io/<owner>/harbor-sandbox:latest
```

**`doctor` is the command to run first.** It needs no database, no credentials and
no network — provider construction is lazy, so every vendor client is built on
first call rather than at startup — and it prints your resolved addressing, your
database TLS posture, and whether all thirteen sandbox providers load. It exits
non-zero on a real problem, so it works as a CI gate too. `GET /api/health/config`
shows the same settings but requires a signed-in session, which is exactly what
you do not have when the dashboard will not start.

The whole stack:

```bash
cp .env.example .env      # fill in HARBOR_ENCRYPTION_KEY and AUTH_SECRET
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

That is an *overlay* on the base compose file, which still means what the README
says it means: `docker compose up -d` alone gives you Postgres and nothing else.
The overlay adds a one-shot `migrate` that both long-lived services wait on.

**Migrations never run on app boot.** Drizzle's postgres-js migrator takes no
advisory lock, so replicas starting together race on `__drizzle_migrations`.
Sequence the `migrate` verb with whatever your platform provides — compose's
`service_completed_successfully`, Fly's `release_command`, a Kubernetes Job.

**`HARBOR_PUBLIC_URL` in a container is the setting that goes wrong first.** It is
the address a *sandbox* uses to call Harbor back, which is not the address you
type into a browser:

| Deployment | Value |
|---|---|
| Laptop, no containers | `http://localhost:3000` |
| Docker Desktop | `http://host.docker.internal:3000` |
| Docker on Linux | `http://172.17.0.1:3000` — the docker0 gateway |
| Any remote sandbox provider | `https://harbor.example.com`, publicly resolvable |

Sandbox containers are created by the *host* daemon with no `--network`, so they
are not on the compose network and cannot resolve the service name `app`. Getting
this wrong does not error: the box boots, reports nothing, and is reaped when its
heartbeat never arrives. Harbor refuses to spawn at all when the variable is
unset, for that reason.

---

## 6. Managed platforms

Templates in [`deploy/`](./deploy/). None is a first-class target at the expense
of the others; each is thin and honest about what it cannot do.

**Fly.io** — [`deploy/fly/fly.toml`](./deploy/fly/fly.toml). Two `[processes]` from
one image, with `release_command` running migrations before the release takes
traffic. `auto_stop_machines = false` and `min_machines_running = 1` are
**correctness settings, not cost preferences**: scaling to zero kills the process
holding the `LISTEN` connections, severs open SSE streams, and stops the sweeps
with no request to wake them. Use a smaller `[[vm]]` if cost is the constraint.

**Render** — [`deploy/render/render.yaml`](./deploy/render/render.yaml). A web
service plus a worker plus managed Postgres. Render only reads a Blueprint at
`./render.yaml`, so **copy it to the repository root**. Free and starter instances
spin down when idle, which breaks the same two things Fly's auto-stop does; both
services need a paid always-on plan.

**Railway** — no committed file, deliberately. Railway's config-as-code describes
a single service and cannot express web plus worker, so the file would buy nothing
over the dashboard. Create two services from the same image with start commands
`web` and `mcp`. Railway injects `PORT` into every service, which is why the MCP
server reads `HARBOR_MCP_PORT` first — without that the worker would bind the web
port and fail its health check with no clue why.

**AWS (ECS/Fargate + RDS)** — no committed file; the paragraph is the valuable
part. Run two task definitions from one image, plus a one-shot for `migrate`, and
pull secrets from Secrets Manager. **Do not put RDS Proxy in front of Harbor**:
`LISTEN` and session advisory locks both force the proxy to pin the connection,
which defeats the proxy and, on some configurations, silently breaks the
notification path. Connect to the writer endpoint directly with
`?sslmode=verify-full`, and set `NODE_EXTRA_CA_CERTS` to the regional bundle if
that fails against Node's default CA store.

---

## Configuration

Every tunable is an environment variable with a documented default. On a running
deployment:

```bash
# The endpoint returns 401 to an anonymous caller, so this needs the dashboard
# session cookie from a signed-in browser.
curl -s --cookie "$SESSION_COOKIE" \
  localhost:3000/api/health/config | jq '.settings[] | {key, value, source}'

# No session — a container, or a deployment that will not start? Same data:
docker run --rm --env-file .env ghcr.io/<owner>/harbor:latest doctor --all
```

That prints the resolved value, whether it came from a repository override, an
environment variable or the default, and the prose reason the default is what it
is. The alternative is archaeology across a Helm chart and a Dockerfile at 2am
while sandboxes are dying.

The three to look at first:

| Variable | Default | Change it when |
|---|---|---|
| `HARBOR_SANDBOX_BOOT_TIMEOUT_MS` | 480000 | your repository takes longer than eight minutes to clone and install |
| `HARBOR_SANDBOX_INACTIVITY_TIMEOUT_MS` | 2100000 | the single largest lever on cost |
| `HARBOR_MAX_SPEND_PER_DAY_MICRO_USD` | 50000000 | $50/day per org is not your number |

Per-repository overrides live in `repos.config` and beat the environment, so one
slow monorepo does not make every other repository wait.

---

## Monitoring

```bash
curl -s localhost:3000/api/metrics
```

Prometheus text format, scrapeable by Prometheus and by every OTLP collector and
agent you might already run. Set `HARBOR_METRICS_TOKEN` to require a bearer token;
unset, the endpoint is open, which is right for a sidecar scraper on a private
network and is why it is the default.

The four alerts worth having on day one:

| Alert | Expression | Means |
|---|---|---|
| Provider down | `harbor_circuit_breaker_open > 0` | the sandbox provider is failing; sessions are being refused |
| Boots degrading | `harbor_sandbox_time_to_ready_seconds{quantile="0.99"} > 300` | one user in a hundred is waiting five minutes, which is enough for them to stop using it |
| Approaching the cap | `harbor_spend_today_micro_usd / on(org) harbor_spend_cap_micro_usd > 0.8` | new claims will start being refused today |
| Provider flapping | `increase(harbor_circuit_breaker_trips_total[1h]) > 2` | the breaker keeps opening; a gauge alone misses trips that close between scrapes |
| Agents dying | `rate(harbor_claim_expiries_total[1h]) > 0` | leases lapsing means agents are crashing mid-task, or the lease default is too short for the work |

---

## Upgrading

From source:

```bash
git pull && npm install && npm run db:migrate
```

From an image — migrations are a separate one-shot, never part of app boot:

```bash
docker pull ghcr.io/<owner>/harbor:latest
docker run --rm --env-file .env ghcr.io/<owner>/harbor:latest migrate
# then roll the web and mcp services
```

Migrations are forward-only and additive. Restart replicas one at a time; the
advisory locks make a mixed-version fleet safe for the duration of a rolling
restart — *for that duration*, not indefinitely, which is why Harbor ships one
image rather than separate web and worker images that could drift apart.

---

## Sandbox images

`npm run sandbox:build` produces `harbor-sandbox:latest`: Debian, Node 22, git,
and the Harbor runtime. Agent CLIs are build arguments, so the base image is
usable without any of them.

```bash
docker build -f sandbox/Dockerfile \
  --build-arg INSTALL_CLAUDE_CODE=1 \
  --build-arg INSTALL_CODEX=1 \
  -t harbor-sandbox:latest .
```

For a faster first prompt, bake your repository's dependencies in. Harbor also
runs `.harbor/setup.sh` from your repository on a fresh boot — non-fatal, so a
broken provisioning step still leaves a usable box — and `.harbor/start.sh` on
every boot, which is strict, because a broken runtime step means the agent works
in an environment that lies to it and produces confidently wrong work.

**Any provider other than `docker` needs that image somewhere the vendor can pull
it.** A local tag is not a smaller version of the right thing there:

```bash
HARBOR_SANDBOX_IMAGE=ghcr.io/<you>/harbor-sandbox:v1 npm run sandbox:push
```

That builds `linux/amd64,linux/arm64` and pushes. Two things it will tell you and
this document should too: **GHCR packages are private by default**, and Harbor has
no per-provider registry credential to offer — so make the package public or every
remote pull fails with an auth error Harbor cannot diagnose. And a registry push
is only *sufficient* for five of the eleven remote providers; the rest want a
vendor-side template, snapshot or blueprint id built from that image.

[docs/sandbox-images.md](./docs/sandbox-images.md) has the per-provider table.

---

## Troubleshooting

**Sandboxes die seconds after becoming ready.** `HARBOR_SANDBOX_STALE_HEARTBEAT_MS`
is at or below `HARBOR_SANDBOX_HEARTBEAT_INTERVAL_MS`. `validateConfig()` refuses
this at startup, so you will have seen the error — it names both variables and the
symptom.

**The dashboard stops updating but the API works.** `LISTEN/NOTIFY` is not
reaching you. Almost always a transaction-pooled connection string, or
`proxy_buffering on` in front of the SSE endpoint.

**Every spawn is refused with `circuit_open`.** The shared breaker is open for
that provider. `curl localhost:3000/api/metrics | grep circuit` shows which and
how many failures. It closes itself after the cooldown; if it reopens immediately,
`harbor_provider_errors_total` says whether the failures are `transient` (wait) or
`invalid_config` (fix your image or credentials).

**A pull request was opened by the bot instead of by a person.** That user has no
source-control token, and Harbor warned about it at use time. The self-approval
guarantee does not hold for that PR. Have them sign in through GitHub rather than
SSO.
