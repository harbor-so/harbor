# Connectors

Written for a security reviewer. It says what Harbor reads, what it writes, and
which credentials it needs to do either.

The table of outbound writes at the bottom is **generated from the code** by
`npm run docs:connectors`, and a test fails the build when this file disagrees
with the connector registry. That is deliberate: a security document that drifts
from the implementation is worse than no document, because it is a false assurance
somebody approved a deployment on. A connector cannot gain an outbound capability
without this file changing in the same commit.

---

## The shape of a connector

One file implementing one interface, plus a line in the registry. Not a separately
deployed service. Seven members:

| Member | Purpose |
|---|---|
| `verifyWebhook` | HMAC over the **raw bytes**, before anything parses them |
| `resolveAccount` | which external account sent this, read from the verified payload |
| `handleWebhook` | turn a verified payload into a task, a session or a queued prompt |
| `route` | decide which repository or environment the work belongs to |
| `postActivity` | progress back to the thread it came from |
| `linkArtifact` | link the resulting pull request back to the source |
| `outboundWrites` | a declaration of everything above that touches the outside world |

---

## Verification, in order

The ordering inside `app/api/webhooks/[connector]/route.ts` is the security
model, and each step may only use facts established by the one before it.

**1. Signature, against the raw bytes.** Verifying a re-serialised object is the
classic way to make signature checking useless: `JSON.parse` followed by
`JSON.stringify` does not reproduce the sender's whitespace or key order, so
either the check fails for valid payloads or somebody "fixes" it by trusting the
parse.

**2. Every installed row's secret is tried.** A deployment with two Slack
workspaces has two secrets, and which one signed a given delivery is not knowable
in advance — that verification *is* the tenant resolution.

**3. The account, from the verified payload.** Never from a header or a query
parameter. The sender must not be able to assert which tenant it belongs to.

**4. The org, from the row whose secret verified.** A payload naming a different
account than the row that verified it is refused with a 409, not processed.

A missing secret and a bad signature are indistinguishable to the sender, because
telling an unauthenticated caller which of the two it was tells them whether the
endpoint is worth attacking. The distinction is logged.

### Replay

Slack deliveries carry a timestamp inside the signed material and are rejected
outside a five-minute window in **either** direction. A one-sided check accepts
anything stamped in the future, which is trivially forgeable by whoever controls
the timestamp being signed over. Without a replay check at all, one captured
`app_mention` is a sandbox-spawning primitive forever.

### Multi-tenancy

`connectors.external_account_id` holds the Slack team id, GitHub installation id
or Linear organisation id, with a unique index. This closed a bug the README used
to document as known and open: ingest selected the connector row by `type` alone,
so a deployment serving two organisations that both used Linear delivered each
org's issues into whichever row happened to be first.

---

## What Harbor reads

### Slack
Message text, the sending user id, the channel id, and the thread timestamp — for
messages that **@-mention the bot**, or that are replies in a thread Harbor
already has a session for. A plain channel message that is neither is ignored
rather than classified, because reading every message in a channel and deciding
which were meant for us is exactly the guess this design refuses to make.

Harbor does not read channel history, does not enumerate members, and does not
request `channels:history`.

### Linear
Issue id, identifier, title, description and state type, on `create` and `update`
of an `Issue`. `sourceRef` stores the **UUID**, not the `ACM-482` identifier: the
identifier is not stable across team moves, and the API takes UUIDs.

### GitHub
Issue and pull-request number, title, body and state, for a fixed set of actions.
The installation id, as the tenant key.

Repository *contents* are not read through the connector. Cloning happens inside
the sandbox with a short-lived brokered credential — see
[docs/SECURITY.md](./docs/SECURITY.md).

---

## Scopes

Request the narrowest that works. Harbor's ingest paths do not use anything wider.

| Service | Scopes | Why |
|---|---|---|
| Slack | `app_mentions:read`, `chat:write`, `im:history` | read what is addressed to the bot; reply in thread |
| Linear | read issues, write comments | inbound sync; progress comments |
| GitHub App | `issues:read`, `pull_requests:read`, `metadata:read` | inbound sync only |

The GitHub App additionally needs `contents:write` and `pull_requests:write` for
the *execution* path — pushing a branch and opening a pull request. Those are used
by `app/git/`, under the prompting user's own token where the API allows it, and
are declared there rather than in the connector's `outboundWrites`. Listing them
in both places would let the two declarations disagree, and this file is the one a
reviewer reads.

---

## What Harbor writes

<!-- BEGIN GENERATED: outbound writes -->

### github

**Harbor writes nothing to this service through the connector.** Inbound sync only.

### gitlab

**Harbor writes nothing to this service through the connector.** Inbound sync only.

### linear

| Call | Scope needed | What it does | When |
|---|---|---|---|
| `commentCreate` | `write (comments)` | Adds a comment to the issue a session came from. Harbor never changes issue state, assignee, labels or estimates — full two-way state sync is an explicit non-goal, because two state machines mean webhook ordering decides which system wins. | A session starting, reaching a progress inflection point, producing an artifact, or a task being completed with a summary. |

### slack

| Call | Scope needed | What it does | When |
|---|---|---|---|
| `chat.postMessage` | `chat:write` | Posts a threaded reply in the channel the request came from. Never posts to a channel Harbor was not addressed in, and never posts at the top level of a channel — every message is a thread reply. | A session starting, reaching one of five progress inflection points, producing an artifact, or needing the target clarified. |

<!-- END GENERATED: outbound writes -->

### What is deliberately absent

**No issue state changes.** Harbor never closes, assigns, labels or estimates.
Full two-way state sync is an explicit non-goal: two state machines mean webhook
ordering decides which system wins, and the loser is somebody's manual edit.

**No top-level channel posts.** Every Slack message is a thread reply.

**No writes on behalf of a user without their token.** Where the API supports it —
opening a pull request — Harbor uses the requesting user's own credential, and
says so loudly when it cannot.

---

## Failure behaviour

An outbound call that fails is **logged, not thrown**. Both Slack and Linear retry
a non-2xx webhook delivery, and a retry re-runs the inbound handler — so letting a
failed progress comment escape would create a second session, or a duplicate task,
every time the outbound service had a bad minute.

A connector row with no credential logs an error naming what is missing and
returns. A silently skipped reply reads to the user as the agent ignoring them.

---

## Adding one

1. Implement `Connector` in `app/connectors/<name>.ts`.
2. Add it to the array in `app/connectors/registry.ts`.
3. Declare every outbound call in `outboundWrites`.
4. Run `npm run docs:connectors`.

Step 4 is not optional — a test fails without it.
