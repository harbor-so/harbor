# Security

Written for whoever has to approve running this inside your network. It states
what Harbor guarantees, and — more usefully — what it does not, in terms of the
concrete thing that goes wrong rather than the abstract property that is missing.

That distinction is the point of this document. It is easy to write "Harbor is
single-tenant; the organisation is the trust boundary" and for every reader to
nod and move on. It is harder, and much more useful, to write down that this
means *any engineer who can start a session on a repository can read that
repository's production secrets out of the agent's environment*. Both sentences
describe the same design. Only the second one gets read by the person who would
have objected.

---

## The trust boundary is the organisation

One Harbor deployment serves one organisation's engineers, and every one of them
is trusted with everything that organisation's Harbor instance can reach.

### What that actually means

**1. Anyone who can start a session on a repository can read that repository's
secrets.**

Repository-scoped secrets are injected into the sandbox as environment
variables — that is what they are for; `start.sh` needs the database URL. The
agent runs inside that sandbox and will happily print its own environment if
asked, and the person who started the session is reading the agent's output. So
"can start a session on repo X" is operationally identical to "has read access to
every secret scoped to repo X."

If your production credentials are in Harbor and your contractors can start
sessions, your contractors have your production credentials. Scope secrets
narrowly, and prefer an environment scope containing only what that environment
needs.

**2. `.harbor/setup.sh` is arbitrary code execution, and merge access to a repo
is what grants it.**

The hook runs as the sandbox user with the brokered git credential available to
it. Anyone who can merge to a repository's default branch can therefore run code
in every future sandbox for that repository, with read access to everything the
App installation can reach.

This is not a flaw so much as the entire premise of a build hook, but it moves
the security boundary: **protect `.harbor/` with the same care as CI
configuration**, because it is the same category of thing. Require review on that
path.

**3. There is no per-user repository allowlist inside an org.**

Harbor checks that the *user* can access a repository before creating a session
against it (`verifyRepoAccess`, using their own source-control token — see
below). It does not implement a second, Harbor-specific permission layer on top.
If your source control says they can read it, Harbor lets them work in it.

**4. The link to a session is the credential for that session.**

`/s/<key>` is 110 bits of entropy and possession of the link is what grants
access — the same model as an unlisted document. This is deliberate: requiring an
invite per participant is the friction that stops anyone sharing, and sharing is
the feature. But it means a session key pasted into a public channel is a session
anyone can join and prompt.

### What would be required for real multi-tenancy

Stated so nobody has to reverse-engineer it:

- Per-tenant source-control App installations, rather than one shared installation.
- Tenant isolation asserted in every query — the schema already carries `orgId`
  on every table, and the connector layer now resolves tenant from the verified
  webhook payload, so the remaining work is an audit rather than a redesign.
- Secret scopes that cannot be widened by adding a repository to an environment.
- A sandbox network policy per tenant.

---

## What Harbor does guarantee

### Pull requests are authored by the human, not by the bot

The sandbox pushes a branch using short-lived brokered credentials and reports
the branch name. The control plane then opens the pull request **with the
prompting user's own source-control token**.

The consequence is the one that matters: GitHub does not let a pull request's
author approve it, so an engineer cannot rubber-stamp their own agent's work.
Unreviewed agent code becomes structurally impossible rather than
policy-prohibited.

Two properties, and they are independent — Harbor tests them separately:

| Property | Comes from |
|---|---|
| Pull request author | the OAuth token used to call the API |
| Commit author and committer | git commit metadata set inside the sandbox |

Target state is `Author: <the human>`, `Committer: Harbor <bot@…>`.

**When it does not hold, Harbor says so loudly.** A user signed in through SSO
with no source-control identity has no token to open a PR with. Harbor pushes the
branch, returns a compare URL, and emits a warning naming the lost property —
both at startup, if the deployment has no SCM OAuth configured at all, and at the
moment of use. It does not silently open the PR as the bot, because that
degradation is invisible and takes the guarantee with it.

Note also that the guarantee is about *approval*, not about *merging*. Whether an
unapproved PR can reach your default branch is a function of your branch
protection rules and who can bypass them. Harbor cannot see those and does not
claim to enforce them.

### Credentials are brokered, never embedded

Git credentials are fetched from the control plane per operation by an in-sandbox
credential helper. They are never placed in the environment or in a remote URL.

The failure this avoids is specific: a long-running session with an embedded
token dies at the moment the agent is finally ready to push, which is the worst
possible moment and the hardest to reproduce. The helper caches for a few seconds
— long enough that one `git push` making several authenticated calls does not
make several round trips, short enough that a revoked installation stops working
almost immediately. That coupling is deliberate.

The helper authorises HTTPS **only for the configured source-control host**, so a
setup hook cloning another private repository the installation can reach still
works, and nothing else gets a credential.

### Credentials never travel in a session snapshot

Clients fetch sandbox access from an authenticated endpoint. Nothing in the
snapshot or the broadcast stream contains a token.

This is a severity argument rather than a defence in depth argument: a bug in
snapshot assembly then leaks *state*, which is embarrassing, rather than
*secrets*, which is an incident.

### Long-lived refresh tokens never enter a sandbox

A sandbox holds only its own session-scoped token. When it needs model access or
git access it asks the control plane, which holds the refresh token and returns
something short-lived. The long-lived secret stays on one side of the boundary.

### Secrets at rest

AES-256-GCM, a fresh random 96-bit IV per encryption, authenticated so a modified
ciphertext fails loudly rather than decrypting to garbage. The envelope is
`v1.<key_id>.<payload>`.

`key_id` is present although rotation is not implemented. Without it, rotating a
key requires decrypting every secret in the system with the key you are trying to
retire — which is to say, at the exact moment you most want to rotate, the format
forces you to load the suspect key and touch every row with it.

`HARBOR_ENCRYPTION_KEY` has no development fallback and Harbor will not generate
one. A key invented at boot changes at the next boot, and every secret already
stored becomes permanently unreadable with no error until somebody tries to start
a session.

### Webhooks

Signatures are verified against the **raw bytes**, before anything parses them.
Verifying a re-serialised object is the classic way to make signature checking
useless, because `JSON.parse` then `JSON.stringify` does not reproduce the
sender's whitespace or key order.

Slack deliveries additionally carry a timestamp inside the signed material and
are rejected outside a five-minute window in **either** direction. A one-sided
check accepts anything stamped in the future, which is trivially forgeable by
whoever controls the timestamp they are signing over. Without a replay check at
all, one captured `app_mention` is a sandbox-spawning primitive forever.

The tenant is resolved from the *verified* payload, and the org is read off the
row whose secret verified the signature — a sender cannot assert which
organisation it belongs to.

### Multi-tenant connector isolation

This was a known bug and it is fixed. Webhook ingest used to select the connector
row by type alone, so a deployment serving two organisations that both used
Linear delivered each org's issues into whichever row happened to be first.
`connectors.external_account_id` now carries the Slack team, GitHub installation
or Linear organisation id, with a unique index, and a payload whose account
cannot be resolved is refused rather than guessed at.

---

## The sandbox boundary depends on your provider

Harbor's provider abstraction spans a real range of isolation, and the range is
wide enough that it must be stated rather than implied.

| Tier | Providers | Boundary | Safe for |
|---|---|---|---|
| None | `local` | The agent runs as the server user, on the server's filesystem and network. | Your own laptop, your own repo. Nothing else. |
| Container | `docker`, `modal`, `daytona`, `cloudflare`, `northflank` | Kernel shared with the host or the vendor's node. `modal` is gVisor-isolated, a stronger container boundary than the default — but still not a VM. | A single-tenant deployment; for the hosted four, whatever the vendor's own multi-tenancy is worth. |
| VM / microVM | `fly`, `morph`, `blaxel`, `codesandbox`, `vercel` | Hardware virtualisation — a VM or microVM per sandbox. | The strongest boundary Harbor can offer. |
| Unrecorded | `e2b`, `runloop` | Both vendors advertise microVM isolation, and Harbor's integration neither states nor verifies it. | Treat it as the vendor's claim until somebody confirms it. |

Each tier comes from what the provider module itself documents
(`app/sandbox/providers/*.ts`), because that is the only claim this repository can
be held to. **Do not infer a tier from the vendor's marketing.** An earlier version
of this table put `modal` and `daytona` in the VM row and `codesandbox` in the
container row; `modal.ts` says "a real, gVisor-isolated container", `daytona.ts`
says "containers booted from a snapshot", and `codesandbox.ts` says "a hosted
micro-VM sandbox". All three were backwards, in the document a reviewer reads to
decide whether the boundary is good enough.

The authoritative list is `SANDBOX_PROVIDER_NAMES` in
`app/sandbox/registry.ts` — a second list in prose is a list that rots, and this
table said "`local` and `docker` are the ONLY shipped providers" for three
releases after that stopped being true.

One thing follows that the tiers alone do not say. Every provider with a hardware
virtualisation boundary buys it by running your source on somebody else's
hardware, which is the opposite of the trade a self-hosted deployment is usually
making. **A VM boundary inside your own infrastructure does not exist yet.** If
that is the requirement, the honest answer today is `docker` on a dedicated host,
and the contract suite in `app/sandbox/providers/provider-contract.test.ts` is
what would prove a contributed Kubernetes or Firecracker backend correct.

**Choosing a remote provider moves your secrets across a vendor boundary.** This
is the sentence this document most needed and did not contain. `buildSandboxEnv`
(`app/sandbox/env.ts`) resolves repository secrets and injects them **decrypted**
into the box's environment, because that is the only way an agent can use them.
On `docker` those plaintext values never leave your host. On any remote provider
they are transmitted to, and held in memory by, a third party — and Harbor cannot
verify a vendor's isolation claim, only repeat it. A stronger *isolation* tier and
a smaller *trust* surface are not the same axis, and for some deployments `docker`
on a dedicated host is the right answer precisely because it is the weaker one.

**The `cloudflare` provider's reconciliation is weaker than the other ten.** Its
attempt index is a Cloudflare KV lookup
(`integrations/cloudflare-sandbox-worker/src/index.ts`), and KV reads are
eventually consistent with edge-cached negative results. A `findByAttemptId`
issued shortly after `create` can therefore miss a box that genuinely exists,
which is the fail-open direction: the caller may start a second sandbox on the
same branch. Every other provider answers that question from a strongly
consistent list.

`local` is off unless `HARBOR_ENABLE_RUNNER=1` and `HARBOR_WORKSPACE_DIR` are
both set, the runtime must be one of a known set of binaries, and the prompt is
passed as an argv element rather than through a shell. Those guards make it
usable; they do not make it a sandbox. Shipping `spawn()` and calling it a
platform is how you ship a remote code execution vulnerability with a dashboard
on top.

`docker` is the default because it is the one that lets somebody evaluate the
whole product without a vendor relationship. It is a container, not a VM: a
kernel escape reaches the host. For a single-tenant deployment on a dedicated
host that is a reasonable trade, and for anything else it is not.

### Running Harbor itself in a container with the docker socket

`docker-compose.prod.yml` and `deploy/k8s/` run the control plane in a container,
and the `docker` provider needs the daemon. Mounting `/var/run/docker.sock` into
the Harbor container **is root on that host**, laundered through a process that
executes attacker-influenced text as instructions. The socket has no scopes: a
process that can reach it can start a privileged container with the host root
filesystem bind-mounted.

Both files ship with that mount commented out, deliberately. If you uncomment it:

- run Harbor on a host or node pool that does nothing else;
- do not run it as root to reach the socket — the image runs as uid 10001, and the
  supported route is `group_add` with the host's docker gid;
- prefer a remote provider, which is why `deploy/k8s/configmap.yaml` defaults to
  one. Letting a vendor own the isolation boundary is the trade this whole section
  is about.

On Kubernetes specifically: do not mount the node's socket into the Harbor pod.
A first-class Kubernetes Job provider does not exist yet, and the provider
contract suite (`app/sandbox/providers/provider-contract.test.ts`) is what would
prove one correct.

---

## Spend as a security property

A background agent platform has at least four independent amplification paths —
scheduled automations, child sessions, connectors turning every inbound issue
into a session, and retries — and each is a loop with no human in it. An
uncapped one is a denial-of-wallet vulnerability, and it does not require an
attacker: a misconfigured hourly automation against a repo that always fails is
enough.

Harbor accounts for spend server-side from the first migration, attributes it to
the lease it was spent under, and enforces `HARBOR_MAX_SPEND_PER_DAY_MICRO_USD`
**atomically with lease admission** rather than as a read-then-check. Concurrent
admissions serialise on a lock; twenty simultaneous claims against a cap that
permits five admit exactly five.

On breach, Harbor stops admitting new claims and does **not** kill running work.
Killing mid-turn wastes everything already spent.

---

## Reporting

Open a GitHub issue for anything that is not itself exploitable. For anything
that is, email the maintainers rather than filing publicly.

## Known and open

- `local` provider is not an isolation boundary, as stated above.
- Encryption key rotation is not implemented, though the envelope format supports
  it.
- A session link is a bearer credential with no revocation.
- Harbor does not enforce your branch protection rules and cannot see them.
