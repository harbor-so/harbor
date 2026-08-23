# Adding a sandbox provider

A provider is the only part of Harbor that touches a compute backend. Everything
above it — spawn admission, fencing, reconciliation, the circuit breaker, cost
accounting — is written once against `app/sandbox/provider.ts` and does not know
whether a box is a container on a laptop or a machine in someone's VPC.

This document is the prose half. **The executable half is
`app/sandbox/providers/provider-contract.test.ts`, and it is the half that
counts.** A checklist gets skimmed; a suite that fails the build does not.

---

## 1. Pick your kind. It is a type, not a boolean.

`SandboxProvider` is a discriminated union with three members. Choose the one you
can actually keep the promise of:

| kind | adds | what "resume" means |
|---|---|---|
| `ephemeral` | nothing | there is no resume; a stopped box is gone |
| `snapshot` | `snapshot()`, `restoreFromSnapshot()` | a **new** box, booted from saved filesystem state, with a **new external id** |
| `persistent` | `pause()`, `resume()` | **the same** box, disk intact, **same external id** |

These are not interchangeable and the union exists so that nobody can treat them
as though they are. A manager that thinks a restore is a resume leaves the
original box running and registers the new one against the old row; a manager
that thinks a resume is a restore allocates a second row for a box whose id never
changed.

Pick the weaker kind when both are technically possible. `docker` can do
`docker start` on a stopped container, so it *could* be `persistent` — it is
`snapshot` because a container lives on exactly one daemon and the ordinary
things a self-hoster does (`compose down -v`, a prune, moving the control plane
to another machine) destroy it, and a persistent resume with no box to resume has
nowhere to fall back to. A committed image survives all of that and degrades to a
fresh boot. **Advertise the capability you can honour on a bad day.**

`capabilities: SandboxCapabilities` is still required, for the health endpoint and
the UI. Nothing may branch on it. Control flow branches on `kind`, which the
compiler checks.

---

## 2. The four methods every provider owes

```ts
create(config: CreateSandboxConfig): Promise<CreatedSandbox>
stop(externalId: string, options?: StopOptions): Promise<StopOutcome>
inspect(externalId: string): Promise<SandboxInspection | null>
findByAttemptId(attemptId: string): Promise<SandboxInspection | null>
```

### `create`

- Attach `config.attemptId` to the box as a **label, tag or equivalent searchable
  metadata, as part of the creation call itself.** This is the single most
  important line in your provider. It is what makes a box created by a call whose
  response we never received *discoverable* instead of an invisible orphan.
- Validate every value that becomes a command-line argument. Removing the shell
  removes command injection; it does not remove **argument** injection, and
  `--privileged` arriving as an image name is a container that owns the host. See
  `ARG_SAFE` in `providers/docker.ts`.
- Honour `config.timeoutMs`. It was resolved from `setting("sandboxBootTimeoutMs")`
  by the caller. Do not substitute your own.
- Refuse any key in `config.features` that you do not implement
  (`assertFeaturesSupported` does this). **Never ignore one.** An operator who
  believes `network_disabled` took effect and is wrong has a worse mental model
  than one who got an error.

### `stop`

Idempotent, and it says which kind of nothing it did: `stopped` /
`already_stopped` / `absent`. A `void` return forces the lifecycle manager to
either write duplicate `sandbox_stopped` events on every retry or none at all.

Do not delete the box's record on stop unless your backend gives you no choice.
Exit codes and logs are the only post-mortem available for a failed boot, and
`findByAttemptId` must keep answering "yes, that attempt produced a box" after
the box has stopped — otherwise a reconciler concludes the attempt never happened
and starts another one.

### `inspect` and the state mapping

Normalise your backend's states into `ProviderSandboxState` with
`normalizeProviderState`, or with your own mapping written as a **deny-list**:
only strings you positively know mean "not running" may produce a dead state,
and anything unrecognised becomes `unknown`.

### `findByAttemptId`

The reconciliation primitive. Read the next section before writing it.

---

## 3. The asymmetry, which is the part people get wrong

**Liveness fails OPEN. Authority fails CLOSED.** Two rules that look
contradictory, point the same way in consequence, and must both be preserved.

- **Liveness** — "is this box still alive?" An indeterminate answer resolves to
  **live** (`isLive("unknown") === true`). Being wrong costs one wasted probe next
  sweep. Being wrong the other way reaps a box whose agent is mid-turn, and the
  user watches their work vanish with nothing in the logs.
- **Authority** — "does a box for this attempt exist?" An indeterminate answer is
  **not** `null`. `null` means *definitively absent*, because the caller's
  response to `null` is to create another box. A provider that returns `null` when
  its backend is unreachable turns one network blip into two agents pushing to the
  same branch, and the second one is invisible to the first.

So in `findByAttemptId`:

```ts
// The daemon answered and has no such box.
if (backendSaysEmpty) return null;
// We could not reach the daemon.
throw new SandboxProviderError({ errorType: "transient", ... });
```

Both sites carry a comment saying which rule they follow and why the other one is
the opposite. Keep them. Someone will eventually try to make them consistent.

---

## 4. Classify every failure

Every throw is a `SandboxProviderError` with an `errorType: ProviderErrorType`.
The circuit breaker acts on it, and only these count towards opening the circuit
(`CIRCUIT_TRIPPING_ERROR_TYPES`): `transient`, `rate_limited`, `quota_exceeded`,
`unknown`.

The classification that matters most is the one that must **not** trip the
breaker: a bad image name, a missing binary, an unsupported feature and a
malformed argument are all `invalid_config` or `not_found`. Counting a typo in
`HARBOR_SANDBOX_IMAGE` as a provider failure opens the circuit across the whole
deployment and then hides the next real outage behind a configuration error — in
the exact place an operator will be looking for the real outage.

Classify from the backend's own output, not from a default of `transient`. See
`classifyDockerFailure`, including the note on why repository-existence patterns
are checked before authorization ones.

---

## 5. No constants. Ever.

Every timeout, threshold and limit comes from `setting()` in
`core/kernel/config.ts`, and `scripts/lint-config.mjs` fails the build on a
module-level one. If your provider needs a number that has no setting, either
derive it from an existing one and **write the derivation down in a comment**
(see `probeTimeoutMs` in the docker provider: a probe budget of one heartbeat
interval, because an answer that arrives later cannot inform a decision that is
still current), or propose a new entry in the `SETTINGS` registry. Do not invent
a local constant; the self-hoster whose environment needs a different number
cannot change it without forking.

---

## 6. Run the contract suite

```ts
// in app/sandbox/providers/provider-contract.test.ts
describeProviderContract({
  label: "yourprovider",
  provider: yourProvider(),
  config: () => ({ /* a throwaway box */ }),
  brokenImageConfig: () => ({ /* an image that cannot possibly work */ }),
  cleanup: async (config) => { /* remove everything it left behind */ },
});
```

You inherit:

1. create → inspect → stop, with the box reading as live in between;
2. `findByAttemptId` returns the box after create, and `null` for an attempt id
   that never existed;
3. `stop` is idempotent and returns a typed outcome;
4. an impossible image is `not_found` or `invalid_config`, never `transient`, and
   `tripsCircuit === false`;
5. an unsupported feature is refused rather than ignored.

Run it against the **real** backend. If the backend is unavailable in a given
environment, skip **loudly** — `console.warn` saying which backend and why, plus
`describe.skip`. A suite that silently passes without testing anything is worse
than one that fails, because it is trusted.

---

## 7. Register it

`app/sandbox/registry.ts`: add the name to `SANDBOX_PROVIDER_NAMES` and the case
to the switch. The switch has no `default`, so omitting the case is a compile
error.

There are no stubs in the registry. A provider that is not implemented is absent
from the union, so `HARBOR_SANDBOX_PROVIDER=yours` fails immediately with a
message listing what actually works — rather than after the operator has written
their compose file, their secrets and their first session.

---

## 8. Say what your provider does not do

The `local` provider runs agents as host processes with no isolation whatsoever,
and its file header says so in the first line. Write the equivalent sentence for
yours. An adopter choosing a backend is making a security decision, and the honest
description of the weak option is what makes the strong default credible.

---

## 9. Your write side and your read side must be tested together

There is one bug this checklist could not have prevented and a test almost did
not either, so it gets its own section.

The Fly provider stamped `harbor_managed: "true"` on every Machine it created,
and `listManaged` queried `?metadata.harbor_managed=1`. `"true" !== "1"`, so it
returned `[]` for every Machine Harbor had ever created and the orphan sweep
silently reaped nothing. It shipped, and it shipped with `findByAttemptId`
coverage, a `listManaged` fail-closed test, and a green suite.

The reason is worth internalising: the tests used **canned response fixtures**.
The author writes the provider's read side, then writes a fixture containing what
they believe the write side produces — and they write both from the same
misunderstanding, so the two agree with each other and disagree with reality. A
write/read mismatch is *structurally invisible* to that style of test.

So, for any provider:

**Write at least one test where `create` and the reconciliation reads talk to the
same stateful stand-in.** The stand-in must:

1. **Store what `create` actually sent** and echo it back verbatim. It must never
   hardcode a Harbor metadata key or value — the moment it does, it is a canned
   fixture again.
2. **Apply the vendor's own query semantics** — parse the label/tag/metadata
   filter out of the request the provider built and filter its store by it. This
   is what catches a wrong *server-side* query, not just a wrong client-side
   filter.

`fly.test.ts` (`statefulFly`) is the smallest complete example; `e2b.test.ts`
(`filteringProvider`) shows the narrower version, where the fake only needs to
honour one query parameter.

**Recorded HTTP cassettes are not a substitute.** A cassette cannot be
regenerated by a contributor with no vendor account, it rots invisibly when the
vendor changes, and — decisively — a cassette recorded against the buggy Fly
provider would have faithfully recorded `listManaged → []` and enshrined the bug
as expected behaviour.

Finally: `provider-contract.test.ts` asserts that the set of providers with a
contract block equals `SANDBOX_PROVIDER_NAMES`. Adding a backend to the registry
without a contract entry fails the build, which is what makes step 6 genuinely
not optional rather than merely stated to be.
