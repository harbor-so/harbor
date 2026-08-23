# The in-sandbox runtime

Everything that runs *inside* a Harbor sandbox: `runtime/supervisor.ts`,
`runtime/bridge.ts`, `runtime/boot-decisions.ts`, `runtime/git-credential-helper.ts`
and the image in `sandbox/Dockerfile`.

Two constraints shape all of it, and neither is negotiable.

**Zero npm dependencies at runtime.** The image contains no `node_modules`. Only
`node:` builtins and global `fetch`. `npm install` inside a booting sandbox is a
minute of latency and a network dependency at the exact moment a user is watching
a spinner, and it fails closed on the afternoon the registry is having a bad day.
The TypeScript is compiled to plain ESM in a *builder* stage that has the full
toolchain; the shipped stage copies the emitted `.js` and nothing else.

**Decisions are separated from effects.** `boot-decisions.ts` is pure — no `fs`,
no `child_process`, no clock, no `process.env`, not even `setting()`. It is tested
with zero mocks at exact boundary values. `supervisor.ts` and `bridge.ts` resolve
configuration, read files and spawn processes, and they ask `boot-decisions.ts`
what to do rather than deciding for themselves.

That second constraint exists because the supervisor is the least observable
component in the system and also the first one to run. A supervisor that branches
on boot mode at a dozen scattered call sites cannot be read: answering "what does
a `snapshot_restore` boot actually do" means finding every branch, so nobody
answers it, and the code drifts unchallenged. Keeping the branching in one pure,
zero-mock module makes that question a single file to read and a test to run.

---

## The boot sequence

```
1. resolve boot mode           → exported as HARBOR_BOOT_MODE
2. configure git               → credential.helper harbor, useHttpPath true
3. clone repos                 → /workspace/<name>, side by side  (fresh only)
4. .harbor/setup.sh            → fresh boots only, NON-FATAL
5. wait for tunnel URLs        → bounded by tunnelWaitMs, then proceed either way
6. .harbor/start.sh            → every boot, FATAL
7. boot_ready, then serve commands
```

### Exactly one boot mode

`resolveBootMode()` runs once, and its answer is exported as `HARBOR_BOOT_MODE`
into the environment of every hook, so a `start.sh` that branches on the mode
branches on the same answer the supervisor used. All four modes are implemented:
`fresh` and `snapshot_restore`, plus `build` (the image pipeline clones the pinned
SHA and runs `setup.sh` fatally, with no agent — see ADR 0007) and `repo_image` (a
session boots a published per-repo image whose dependencies are baked in, so
`setup.sh` is skipped). An unrecognised string is still refused by name rather than
approximated as `fresh`, because each mode implies a different answer to "has
`setup.sh` already run", and approximating that answer either installs dependencies
twice or not at all with no error either way.

The snapshot matrix is decided on two inputs — is the feature enabled in *this
box*, and is the workspace actually populated:

| requested | snapshots on | workspace populated | result |
|---|---|---|---|
| *(unset)* | — | — | `fresh` |
| `fresh` | — | — | `fresh` |
| `snapshot_restore` | yes | yes | `snapshot_restore` |
| `snapshot_restore` | yes | no | `fresh`, degraded, **warned** |
| `snapshot_restore` | no | no | `fresh`, degraded, **warned** |
| `snapshot_restore` | no | yes | **refused** — `restore_gate_conflict` |

The supervisor does not perform the restore; the provider did, before the
entrypoint ran. So "was a snapshot actually restored" is a question about the
filesystem, not about the request — a snapshot can expire, be garbage-collected,
or restore into an empty tree, and in each case the box comes up with
`HARBOR_BOOT_MODE=snapshot_restore` and nothing on disk. Trusting the request
there skips `setup.sh` on a box that has never had it run.

The last row refuses because both alternatives are destructive: clone over a tree
that may hold uncommitted work, or run in state this runtime was configured not to
trust. One environment variable fixes it; neither alternative is recoverable.

### The hook fatality asymmetry

| hook | `build` | `fresh` | `repo_image` | `snapshot_restore` |
|---|---|---|---|---|
| `.harbor/setup.sh` | run, **fatal** | run, **non-fatal** | skip | skip |
| `.harbor/start.sh` | skip | run, **fatal** | run, **fatal** | run, **fatal** |

`setup.sh` provisions. When it fails, the box is still a box: the repository is
checked out, git works, the agent can read every file, and it will discover the
missing dependency the first time it runs the tests — with a real error naming the
real problem. Killing the boot converts "degraded environment, here is the
warning" into "your session failed".

`start.sh` runs services the agent is *told exist*. When it fails silently the
environment **lies**: the agent runs the suite, sees connection refused, concludes
the code is broken, and confidently "fixes" working code. Confidently wrong work
costs more than no work — the tokens, plus a human's review, plus the trust they
had in the last ten things the agent said.

**A broken provisioning step degrades; a broken runtime step deceives.**

`setup.sh` is fatal in `build` mode alone, because that is the one place where
permissiveness is permanent: a broken image is inherited by every box started from
it, forever, with no warning anywhere.

### Boot warnings go two places

Every degradation produces a `BootWarning` with a stable `code` and prose
`message`. Warnings are written to `/workspace/.harbor/boot-warnings.json` **and**
emitted over the bridge as `log` events with `level: "warning"`.

Only the second one matters in practice. Nobody reads a sandbox's log; the file
exists for someone already shelled into the box. The timeline copy is the one a
user sees before they spend twenty minutes wondering why the dev server is not up.

---

## Tunnel URLs: `/workspace/.tunnels.env`

Plain dotenv, `KEY=value`, no quoting, no interpolation, no sections — because the
consumers are `node --env-file`, `bun --env-file` and `docker compose --env-file`,
all three of which read exactly this and none of which read anything cleverer. A
JSON file would need a parser in every adopting repository's `start.sh`, and the
parser people write in bash is `grep | cut`, which is a dotenv parser with bugs.

```
TUNNEL_SANDBOX_ID=sbx_01J…
PREVIEW_URL=https://sbx-01j.tunnels.example
API_URL=https://sbx-01j-8080.tunnels.example
```

`TUNNEL_SANDBOX_ID` makes the file self-identifying, and that line is what stops a
restored box from advertising the *previous* box's URLs — they were on disk when
the snapshot was taken.

On boot:

| file state | action |
|---|---|
| id matches this sandbox | **keep**, do not wait |
| id belongs to another sandbox | **delete**, then wait |
| present but no id line | **delete**, then wait |
| absent | wait |

Keeping a matching file is not an optimisation to be cleaned up later. The control
plane publishes ports and writes this file as part of spawning, and on a fast
provider that write legitimately lands before the container has finished starting
Node. Always waiting adds the full `tunnelWaitMs` to every fast boot and then times
out, turning the best case into the worst one.

The mismatch case deletes the file *before anything can read it*, which is
fail-closed and deliberately so: a wrong URL is worse than a missing one. Missing
makes `start.sh` fail fast and say so; wrong brings a service up bound to a
hostname that resolves somewhere else entirely.

**On timeout the boot proceeds.** It logs `tunnel.env_file_wait_timeout`, emits a
warning to the session timeline, and carries on. Failing a boot because a port
forward was slow trades a local, recoverable, possibly irrelevant problem for a
total one. The comparison is `elapsed >= waitMs`, so `HARBOR_TUNNEL_WAIT_MS=0`
means "do not wait" rather than "wait one poll interval".

---

## The bridge

SSE down, HTTP POST up. Not WebSockets: a background agent platform is adopted by
being put behind whatever ingress the company already runs, and every ALB, proxy
and ingress controller handles POST and `text/event-stream` without configuration
while a meaningful fraction mangle a protocol upgrade. The traffic is lopsided
anyway — thousands of events up, four verbs down.

```
POST {control}/api/sandbox/{id}/events     {"events":[SandboxEvent, …]}
GET  {control}/api/sandbox/{id}/commands   text/event-stream of BridgeCommand
POST {control}/api/sandbox/{id}/credentials
```

Every call carries `authorization: Bearer <HARBOR_SANDBOX_TOKEN>` **and**
`x-harbor-fencing-token: <HARBOR_FENCING_TOKEN>`. Authentication alone cannot
catch the case fencing exists for: a sandbox whose lease lapsed still holds a
genuine token. A `409` from either endpoint is a verdict, not a blip — the bridge
shuts down rather than backing off and retrying, because retrying is what keeps a
zombie connected long enough to be handed a prompt.

### The invariant

**Lifecycle state is authoritative over transport.** Losing the connection does
not stop the agent, does not fail the turn and does not discard work. A
thirty-second network blip must not cost twenty minutes of an agent's work.

### Bounded buffering, and the hole that is in the record

While disconnected the bridge buffers up to `bridgeBufferLimit` events. At the cap
it drops the **oldest** and emits a **visible gap marker** into the stream, as a
`log` event carrying `code: "bridge.buffer_overflow"` and `dropped_events`.

Both alternatives are worse in different ways. Unbounded buffering OOM-kills the
sandbox during a partition and takes the agent's in-flight work with it, turning a
connectivity problem into lost work. Silent dropping puts an invisible hole in the
transcript, and a reader seeing a continuous sequence that is missing forty minutes
reasonably concludes the agent did nothing.

Two properties fall out of the data structure rather than out of caller
discipline:

- **The limit counts events, not entries.** A gap marker is O(1) metadata. Counting
  it against the cap means that at `limit = 1` the buffer oscillates between one
  event and one marker and retains nothing.
- **One partition produces exactly one marker.** Events are appended at the tail
  and evicted from the head, so the head is the only place a hole forms; once a
  marker is there, every further eviction widens it. A caller that emitted one
  marker per dropped event would turn a thousand-event partition into a thousand
  markers, which is a different way of making the transcript unreadable.

Flushing removes entries **by identity**, never "the first N" — if an overflow
evicts from the head while a POST is in flight, the first N are no longer the N
that were sent, and a successful flush would delete events that never left the box.
Batches are capped at `maxSnapshotEvents`, which is the ingest endpoint's own
limit, so a full buffer drains over several POSTs instead of being refused with a
413 during exactly the outage the buffer exists for.

### Reconnection

Exponential with half-range jitter, bounded:

- **base** = `sandboxHeartbeatIntervalMs / 16` — an ordinary blip is recovered from
  well inside one heartbeat and never shows up as a missed one.
- **ceiling** = `sandboxStaleHeartbeatMs` — there is no value in a reconnect
  scheduled past the point where the control plane has written this box off; by
  then the session has failed over and coming back adds a second writer.
- **jitter** is half-range (50–100% of the window), not full. Full jitter produces
  near-zero delays often enough that a box spins on connect attempts when the
  control plane is hard-down.

A clean end of stream — a proxy idle timeout, a rolling restart — is *not* counted
as a failure. Counting it would push every sandbox in the fleet into a 45-second
delay on every deploy.

### Prompts are deduplicated by id

Commands are derived from persisted state rather than an in-memory queue, so that
a bridge reconnecting to a different replica still receives its prompt. The price
of that design is redelivery, and the bridge pays it: a prompt id already seen is
logged and ignored. Without this, a flaky connection pays for the same turn
several times over against the same workspace.

### Git identity is refused, never guessed

Before every turn the bridge resolves a `GitIdentity` and writes it with
`git config user.name` / `user.email` in the workspace, in addition to the
`GIT_AUTHOR_*` the adapter sets in the child's environment. Both, because agents
shell out to things — a Makefile target, a husky hook, a `gh` wrapper — and
environment inheritance survives most of those and not all of them.

- explicit `mode: "agent-only"` → the bot identity. A real, explicit choice for a
  scheduled dependency bump nobody is claiming authorship of.
- complete `author` + `author_email` → attributed to the human.
- **anything else raises**, including an identity mode this image does not
  recognise.

Commit attribution is the trust anchor of the PR model: the human authors, the bot
commits, therefore the human cannot approve their own agent's work. A guess here —
the bot, the session creator, the last person who spoke — makes the repository
history lie about who asked for a change, silently, and it is discovered months
later by someone auditing a merge. The refusal is surfaced on the timeline as an
`agent_failed` event with `reason: "git_identity_unavailable"`, because the fix
belongs to the person who sent the prompt and they are not reading stderr.

### Shutdown

`SIGTERM` and `SIGINT` both drain the buffer before exiting, bounded by one
heartbeat interval. The events sitting in the buffer at that moment are the ones
that explain *why* the session ended; losing them means the timeline stops
mid-sentence. The bound exists because a shutdown that takes longer than a
heartbeat looks like a dead box to the liveness check, and a sandbox that refuses
to exit is killed by the provider anyway.

`tini` is PID 1 for the same reason: without an init the supervisor inherits every
orphan an agent leaves behind, and those become zombies holding the workspace and
the port for the life of the box.

---

## The git credential helper

Installed as `git config --global credential.helper harbor`; git execs
`git-credential-harbor <op>` with the request on stdin. **Nothing else in the
sandbox ever holds a token** — no `.git-credentials`, no `~/.netrc`, no
`url.insteadOf` with a PAT in it, no `GITHUB_TOKEN` in the agent's environment.

That last point is the reason it exists. A token in the environment is a token in
every `ps` line, every crash dump, every `env` an agent prints while debugging. A
token in `.git-credentials` is a token in the next filesystem snapshot, which
outlives the session by the whole snapshot retention window.

### The cache window

`credentialCacheMs` defaults to **5 seconds**, and the coupling is the trade:

- **Too short:** one `git push` makes several authenticated calls — ref
  advertisement, pack upload, sometimes a follow-up fetch — and each becomes a
  round trip. A brief control-plane blip mid-push then fails a push that was
  working, and the agent tries to "fix" it in the repository.
- **Too long:** revoking an installation, removing a user or pausing a session
  stops mattering for as long as the cache lasts. Revocation taking effect *now* is
  the property people expect from a brokered credential.

A few seconds covers one composite git operation and no more. Revocation takes
effect within one window.

The cache is on **disk** (`$TMPDIR/harbor-credential-<sandbox>.json`, mode 0600),
which is forced rather than chosen: git spawns a fresh helper process per
invocation, so an in-process cache would live for one call. It is never in
`/workspace` — that is what the agent reads, what an over-eager `git add -A`
commits, and what a snapshot captures. The cache key is host + repository +
operation, not just host, so a read-only clone token can never be replayed for a
push.

`git credential erase` — which git calls when a credential was rejected — drops the
cache, so a token revoked mid-session is not replayed for the rest of its window.

### Authorisation: fail closed

| condition | result |
|---|---|
| operation is not `get` | decline (`not_a_get`) |
| `HARBOR_SCM_HOST` unset | decline (`scm_host_unconfigured`) |
| protocol is not `https` | decline (`insecure_protocol`) |
| no host in the request | decline (`host_missing`) |
| host ≠ `HARBOR_SCM_HOST` (exact, port included) | decline (`host_not_authorised`) |
| otherwise | authorise |

This is an **authority** question — "may this caller act as the installation?" — so
every uncertainty resolves against the caller. The opposite convention governs
liveness elsewhere in Harbor: `DEAD_SANDBOX_STATUSES` is a deny-list, so an unknown
sandbox status means *alive*, because abandoning a working box is unrecoverable
while refusing one credential costs a clear error message. Handing a token to a
host we could not identify is not recoverable at all — it is exfiltration,
performed by us, on request.

Host matching is exact and includes the port, because a prefix or suffix
comparison is how `github.com.evil.example` gets a token.

Authorising exactly one host still serves the case that matters: a `setup.sh`
cloning *other* private repositories the installation can reach — a shared
component library, a private registry backed by a repo — because those live on the
same SCM host.

**Declining is an empty reply with exit code 0**, never a non-zero exit. That is
git's protocol for "I have nothing": git then falls through, or prompts, or fails
with its own message naming the host. A non-zero exit aborts the whole operation
with a message about the helper, hiding "this sandbox is not authorised for
bitbucket.org" behind "credential helper failed".

### The operation is stated, never inferred

git's credential protocol carries **no** operation — the same invocation serves a
clone and a force-push. So the supervisor states it in the environment of the
process it is about to start:

- boot clone → `HARBOR_GIT_OPERATION=clone`
- agent turn → `HARBOR_GIT_OPERATION=push`
- anything else → defaults to `fetch`, the least privileged of the three

A stray push from an unlabelled process gets a read-only token and fails with a
permissions error, which is a clear one-line fix. The other default — assuming
`push` — hands write access to every unattended operation in the box and fails
silently, once, badly.

`credential.useHttpPath true` is set at boot so git includes the repository path;
without it the broker has nothing to scope the token to and must either refuse or
issue an installation-wide credential to an unattended boot clone.

---

## The environment contract

Injected by the control plane when the box is created. Everything is required
unless marked optional; `readSupervisorConfig()` reports **all** missing variables
at once, because the feedback loop here is a container rebuild.

| variable | meaning |
|---|---|
| `HARBOR_CONTROL_URL` | origin of the control plane |
| `HARBOR_SANDBOX_ID` | this box's row id |
| `HARBOR_SESSION_ID` | the session it serves |
| `HARBOR_SANDBOX_TOKEN` | bearer token for the three endpoints |
| `HARBOR_FENCING_TOKEN` | positive integer; presented on every privileged call |
| `HARBOR_AGENT_RUNTIME` | one of `AGENT_RUNTIMES`; refused, never defaulted |
| `HARBOR_REPOS` | JSON `[{name, url, ref?}]`; the first is primary |
| `HARBOR_BOOT_MODE` | *(optional)* absent means `fresh` |
| `HARBOR_SCM_HOST` | *(optional)* derived from the primary repo URL when absent |
| `HARBOR_TRACE_ID` | *(optional)* carried through to every event and header |
| `HARBOR_WORKSPACE_ROOT` | *(optional)* defaults to `/workspace` |

`HARBOR_REPOS` is JSON rather than a delimited string because a git URL can contain
almost any punctuation and every delimiter someone picks is legal in some URL; the
failure of the delimited version is a clone against a truncated URL, which reads as
"that repository does not exist". Repository names are restricted to
`[A-Za-z0-9._-]+` because the name becomes a path segment, and a `..` there writes a
clone outside the workspace.

Exit code **78** (`EX_CONFIG`) means the supervisor refused to start on
configuration, as distinct from a boot that ran and failed — which a provider
otherwise reports identically as "container exited".

---

## The image

```
docker build -f sandbox/Dockerfile -t harbor-sandbox:latest .
docker build -f sandbox/Dockerfile --build-arg INSTALL_CLAUDE_CODE=1 .
```

Debian slim, not Alpine: agents shell out constantly, and the things they shell out
to — prebuilt native modules, `node-gyp` output, manylinux wheels — are built
against glibc. musl turns "install the dependencies" into a source build or a
segfault, and the person who hits it is a self-hoster on their first afternoon.

Agent CLIs are `ARG`-gated and **off by default**. Harbor's claim is "bring your own
agent"; an image that bakes one in makes that claim false in the first place anyone
looks. An operator standardised on an in-house CLI builds with all three off and
installs their own in `.harbor/setup.sh`.

The builder stage copies only `runtime/`, `app/contracts/`, `app/activity/`,
`core/kernel/config.ts` and `core/schema/schema.ts` (type-only, for the activity
normalizers). The rest of `core/schema`, the rest of `core/kernel`, `app/lib` and
the Next.js app are deliberately absent: if the runtime ever grows an import into
them the build fails, rather than silently pulling a database driver and a web
framework into a container whose entire job is to run one agent.

Non-root, UID 10001 — not the `node` user's 1000, which collides with the first
human account on most hosts and leaves a bind-mounted workspace owned by a
stranger.

---

## Known gaps

- **There is no gap-marker event type.** The overflow marker rides on `log` with a
  structured payload, because inventing a `SandboxEventType` in the sandbox is
  exactly the drift `app/contracts` exists to prevent.
- **Reconnect backoff has no dedicated setting.** Base and ceiling are derived from
  `sandboxHeartbeatIntervalMs` and `sandboxStaleHeartbeatMs`. The derivation is
  defensible and documented, but an operator cannot tune the backoff independently
  of the heartbeat.
