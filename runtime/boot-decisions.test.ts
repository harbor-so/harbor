// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * The boot decisions, tested at their exact boundaries and with nothing mocked.
 *
 * There is nothing to mock, which is the point of `boot-decisions.ts` existing
 * separately from `supervisor.ts`. Every case below is a pure function call with
 * literal arguments, so the tunnel timeout is asserted at precisely its limit
 * rather than by sleeping and hoping, and the buffer overflow is asserted at
 * exactly `limit` and `limit + 1` rather than "a lot".
 *
 * The cases that earn their place are the ones that encode a decision somebody
 * will later be tempted to simplify: the full tunnel-file matrix, the hook
 * fatality asymmetry, and the guarantee that one partition produces one gap
 * marker.
 */

import { describe, expect, it } from "vitest";
import { BOOT_MODES } from "../app/contracts/index.js";
import {
	TUNNEL_ENV_PATH,
	TUNNEL_SANDBOX_ID_KEY,
	pushDecision,
	formatDotenv,
	hookPolicy,
	parseDotenv,
	pushBounded,
	reconnectDelayMs,
	resolveBootMode,
	shouldClone,
	tunnelFileDecision,
	tunnelWaitVerdict,
	type BufferEntry,
} from "./boot-decisions.js";

describe("resolveBootMode", () => {
	it("defaults to fresh when nothing asked for a mode", () => {
		for (const requested of [null, undefined, "", "   "]) {
			const result = resolveBootMode({
				requested,
				snapshotsEnabled: false,
				workspacePopulated: false,
				bakedWorkspacePopulated: false,
			});
			expect(result).toEqual({
				kind: "resolved",
				mode: "fresh",
				reason: "unspecified",
				degradedFrom: null,
				warning: null,
			});
		}
	});

	it("refuses a string that is not a boot mode instead of falling back to fresh", () => {
		const result = resolveBootMode({
			requested: "warm",
			snapshotsEnabled: true,
			workspacePopulated: true,
			bakedWorkspacePopulated: false,
		});
		expect(result.kind).toBe("refused");
		if (result.kind !== "refused") throw new Error("unreachable");
		expect(result.reason).toBe("unrecognised");
		// The message has to name setup.sh, because that is the consequence the
		// operator needs to understand and it is not obvious from "invalid boot mode".
		expect(result.message).toContain("setup.sh");
	});

	it("build resolves to a provisioning boot: clone the SHA and run setup fatally", () => {
		// The image pipeline boots the base image in this mode. A populated workspace is
		// irrelevant — a build starts from an empty base and clones — so the resolution
		// does not depend on it.
		const result = resolveBootMode({
			requested: "build",
			snapshotsEnabled: false,
			workspacePopulated: false,
			bakedWorkspacePopulated: false,
		});
		expect(result).toMatchObject({ kind: "resolved", mode: "build", reason: "build_provisioning" });
	});

	it("repo_image uses the baked checkout when present, and degrades to fresh when empty", () => {
		// The decision is about the BAKED path, not the workspace, which is empty at boot
		// until the copy this resolution gates.
		expect(
			resolveBootMode({
				requested: "repo_image",
				snapshotsEnabled: false,
				workspacePopulated: false,
				bakedWorkspacePopulated: true,
			}),
		).toMatchObject({ kind: "resolved", mode: "repo_image", reason: "image_workspace_present" });

		// An image that baked no checkout must not skip setup on a tree that never had it
		// run: degrade to a fresh clone plus setup, with a warning naming the cause.
		const empty = resolveBootMode({
			requested: "repo_image",
			snapshotsEnabled: false,
			workspacePopulated: false,
			bakedWorkspacePopulated: false,
		});
		expect(empty).toMatchObject({
			kind: "resolved",
			mode: "fresh",
			reason: "image_yielded_empty_workspace",
			degradedFrom: "repo_image",
		});
		if (empty.kind !== "resolved" || empty.warning === null) throw new Error("expected a warning");
		expect(empty.warning.code).toBe("boot.repo_image_empty");
	});

	it("covers every mode in the contract, so a new one cannot be silently ignored", () => {
		// Not a formality: if BOOT_MODES grows and resolveBootMode is not updated, the
		// new member lands in the `unrecognised` branch, which reads to an operator as
		// "Harbor does not know its own contract". All four are now implemented, so none
		// is refused as unsupported.
		for (const mode of BOOT_MODES) {
			const result = resolveBootMode({
				requested: mode,
				snapshotsEnabled: true,
				workspacePopulated: true,
				bakedWorkspacePopulated: true,
			});
			expect(result.kind).toBe("resolved");
			if (result.kind !== "resolved") throw new Error("unreachable");
			expect(["fresh", "snapshot_restore", "build", "repo_image"]).toContain(result.mode);
		}
	});

	describe("the snapshot matrix", () => {
		const restore = (snapshotsEnabled: boolean, workspacePopulated: boolean) =>
			resolveBootMode({
				requested: "snapshot_restore",
				snapshotsEnabled,
				workspacePopulated,
				bakedWorkspacePopulated: false,
			});

		it("honours a restore when snapshots are on and the tree is there", () => {
			const result = restore(true, true);
			expect(result).toMatchObject({
				kind: "resolved",
				mode: "snapshot_restore",
				reason: "restored_workspace_present",
				degradedFrom: null,
				warning: null,
			});
		});

		it("degrades to fresh — with a warning — when the restore produced nothing", () => {
			// The dangerous alternative is trusting the request: skipping setup.sh on a
			// box that has never had it run leaves the agent in a tree with no
			// dependencies and no indication anything is wrong.
			const result = restore(true, false);
			expect(result.kind).toBe("resolved");
			if (result.kind !== "resolved") throw new Error("unreachable");
			expect(result.mode).toBe("fresh");
			expect(result.reason).toBe("restore_yielded_empty_workspace");
			expect(result.degradedFrom).toBe("snapshot_restore");
			expect(result.warning?.code).toBe("boot.snapshot_restore_empty");
		});

		it("degrades to fresh with a warning when snapshots are off and nothing is on disk", () => {
			const result = restore(false, false);
			expect(result.kind).toBe("resolved");
			if (result.kind !== "resolved") throw new Error("unreachable");
			expect(result.mode).toBe("fresh");
			expect(result.reason).toBe("snapshots_disabled_workspace_empty");
			expect(result.degradedFrom).toBe("snapshot_restore");
			expect(result.warning?.code).toBe("boot.snapshots_disabled");
		});

		it("refuses when snapshots are off and there is a populated tree it must not clone over", () => {
			const result = restore(false, true);
			expect(result.kind).toBe("refused");
			if (result.kind !== "refused") throw new Error("unreachable");
			expect(result.reason).toBe("restore_gate_conflict");
			expect(result.message).toContain("HARBOR_ENABLE_SNAPSHOTS");
		});
	});

	it("never degrades without saying so", () => {
		// A silent downgrade is how a snapshot feature appears to work for months
		// while never once restoring, so the two are tied together here.
		for (const snapshotsEnabled of [true, false]) {
			for (const workspacePopulated of [true, false]) {
				const result = resolveBootMode({
					requested: "snapshot_restore",
					snapshotsEnabled,
					workspacePopulated,
					bakedWorkspacePopulated: false,
				});
				if (result.kind !== "resolved") continue;
				expect(result.degradedFrom === null).toBe(result.warning === null);
			}
		}
	});
});

describe("hookPolicy", () => {
	it("makes setup non-fatal and start fatal on a fresh boot", () => {
		const setup = hookPolicy("setup", "fresh");
		const start = hookPolicy("start", "fresh");

		expect(setup).toEqual({
			run: true,
			hook: "setup",
			mode: "fresh",
			fatality: "non_fatal",
			timeoutSetting: "setupTimeoutMs",
		});
		expect(start).toEqual({
			run: true,
			hook: "start",
			mode: "fresh",
			fatality: "fatal",
			timeoutSetting: "startTimeoutMs",
		});

		// Stated as one assertion because the asymmetry is the design, not an
		// accident of two independent defaults: a broken provisioning step degrades,
		// a broken runtime step deceives, and only the second must stop the world.
		expect(setup.run && setup.fatality).not.toBe(start.run && start.fatality);
	});

	it("skips setup wherever its output already exists, with a distinguishable reason", () => {
		expect(hookPolicy("setup", "repo_image")).toEqual({
			run: false,
			hook: "setup",
			mode: "repo_image",
			skipReason: "already_applied_in_image",
		});
		expect(hookPolicy("setup", "snapshot_restore")).toEqual({
			run: false,
			hook: "setup",
			mode: "snapshot_restore",
			skipReason: "already_in_filesystem",
		});
	});

	it("runs setup fatally at image build time", () => {
		// The one place permissiveness is permanent: a broken image is inherited by
		// every box started from it, with no warning anywhere.
		expect(hookPolicy("setup", "build")).toMatchObject({ run: true, fatality: "fatal" });
	});

	it("runs start on every boot that will host an agent, including a restored one", () => {
		// A snapshot captures a filesystem, never a running process tree, so a
		// restored box has no services until start.sh puts them back.
		for (const mode of ["fresh", "repo_image", "snapshot_restore"] as const) {
			expect(hookPolicy("start", mode)).toMatchObject({ run: true, fatality: "fatal" });
		}
		expect(hookPolicy("start", "build")).toMatchObject({
			run: false,
			skipReason: "no_runtime_at_build_time",
		});
	});

	it("answers for every mode in the contract", () => {
		for (const mode of BOOT_MODES) {
			expect(() => hookPolicy("setup", mode)).not.toThrow();
			expect(() => hookPolicy("start", mode)).not.toThrow();
		}
	});
});

describe("shouldClone", () => {
	it("clones for the modes that start from an empty tree", () => {
		expect(shouldClone("fresh")).toBe(true);
		expect(shouldClone("build")).toBe(true);
	});

	it("does not clone over a workspace an image or snapshot already populated", () => {
		expect(shouldClone("repo_image")).toBe(false);
		expect(shouldClone("snapshot_restore")).toBe(false);
	});

	it("answers for every mode in the contract", () => {
		for (const mode of BOOT_MODES) expect(() => shouldClone(mode)).not.toThrow();
	});
});

describe("the tunnel file matrix", () => {
	const ours = "sbx_current";
	const file = (id: string | null, extra = "PREVIEW_URL=https://a.example") =>
		id === null ? extra : `${TUNNEL_SANDBOX_ID_KEY}=${id}\n${extra}`;

	it("keeps a file whose id matches — the backend's write can legitimately land first", () => {
		// The tempting simplification is "a file present at startup must be stale".
		// It is not: on a fast provider the control plane publishes ports and writes
		// this file before the container entrypoint has finished starting Node, and
		// waiting anyway adds the whole tunnel wait to every fast boot.
		const decision = tunnelFileDecision({ contents: file(ours), sandboxId: ours });
		expect(decision.action).toBe("keep");
		if (decision.action !== "keep") throw new Error("unreachable");
		expect(decision.vars.PREVIEW_URL).toBe("https://a.example");
		expect(decision.vars[TUNNEL_SANDBOX_ID_KEY]).toBe(ours);
	});

	it("clears a file inherited from another sandbox and names the stale owner", () => {
		const decision = tunnelFileDecision({ contents: file("sbx_previous"), sandboxId: ours });
		expect(decision).toEqual({
			action: "clear_and_wait",
			reason: "id_mismatch",
			staleSandboxId: "sbx_previous",
		});
	});

	it("clears a file that cannot prove it is ours", () => {
		// A wrong URL is worse than a missing one: missing fails fast and says so,
		// wrong brings a service up on a hostname that resolves somewhere else.
		expect(tunnelFileDecision({ contents: file(null), sandboxId: ours })).toEqual({
			action: "clear_and_wait",
			reason: "id_missing",
		});
		expect(
			tunnelFileDecision({ contents: `${TUNNEL_SANDBOX_ID_KEY}=\nX=1`, sandboxId: ours }),
		).toEqual({ action: "clear_and_wait", reason: "id_missing" });
	});

	it("waits when there is no file at all", () => {
		expect(tunnelFileDecision({ contents: null, sandboxId: ours })).toEqual({
			action: "wait",
			reason: "absent",
		});
	});

	describe("the wait, at its exact boundary", () => {
		const waitMs = 30_000;

		it("keeps waiting up to but not including the limit", () => {
			expect(
				tunnelWaitVerdict({ contents: null, sandboxId: ours, elapsedMs: 0, waitMs }),
			).toEqual({ kind: "keep_waiting", remainingMs: 30_000 });
			expect(
				tunnelWaitVerdict({ contents: null, sandboxId: ours, elapsedMs: waitMs - 1, waitMs }),
			).toEqual({ kind: "keep_waiting", remainingMs: 1 });
		});

		it("times out at exactly the limit, and proceeds rather than failing the boot", () => {
			const verdict = tunnelWaitVerdict({
				contents: null,
				sandboxId: ours,
				elapsedMs: waitMs,
				waitMs,
			});
			expect(verdict.kind).toBe("proceed_without_tunnels");
			if (verdict.kind !== "proceed_without_tunnels") throw new Error("unreachable");
			expect(verdict.logCode).toBe("tunnel.env_file_wait_timeout");
			expect(verdict.warning.code).toBe("tunnel.env_file_wait_timeout");
			expect(verdict.warning.message).toContain(TUNNEL_ENV_PATH);
		});

		it("treats a zero wait as no wait rather than one poll", () => {
			// `>=` not `>`. With `>`, HARBOR_TUNNEL_WAIT_MS=0 would mean "wait for one
			// poll interval", which is the off-by-one that only shows up in somebody's
			// CI where the value was set to zero to make tests fast.
			expect(
				tunnelWaitVerdict({ contents: null, sandboxId: ours, elapsedMs: 0, waitMs: 0 }).kind,
			).toBe("proceed_without_tunnels");
		});

		it("reports ready the moment a matching file appears, even past the deadline", () => {
			const verdict = tunnelWaitVerdict({
				contents: file(ours),
				sandboxId: ours,
				elapsedMs: waitMs * 10,
				waitMs,
			});
			expect(verdict.kind).toBe("ready");
		});

		it("does not accept a mismatched file as ready however long it has waited", () => {
			const verdict = tunnelWaitVerdict({
				contents: file("sbx_other"),
				sandboxId: ours,
				elapsedMs: 1,
				waitMs,
			});
			expect(verdict.kind).toBe("keep_waiting");
		});
	});
});

describe("dotenv", () => {
	it("round-trips the format the three consumers agree on", () => {
		const text = formatDotenv({ TUNNEL_SANDBOX_ID: "sbx_1", PREVIEW_URL: "https://x.example:8443/p?a=b" });
		expect(text).toBe("TUNNEL_SANDBOX_ID=sbx_1\nPREVIEW_URL=https://x.example:8443/p?a=b\n");
		expect(parseDotenv(text)).toEqual({
			TUNNEL_SANDBOX_ID: "sbx_1",
			PREVIEW_URL: "https://x.example:8443/p?a=b",
		});
	});

	it("skips junk rather than throwing, because this runs on the boot path", () => {
		expect(parseDotenv("# comment\n\nnot a line\n=novalue\n1BAD=x\nGOOD=y\n")).toEqual({ GOOD: "y" });
	});

	it("refuses a value containing a newline instead of escaping it", () => {
		// In a format where a line is a variable, this is variable injection into
		// every process started with --env-file, not a formatting inconvenience.
		expect(() => formatDotenv({ URL: "https://x\nAWS_SECRET_ACCESS_KEY=stolen" })).toThrow(
			/newline or NUL/,
		);
		expect(() => formatDotenv({ "not-an-identifier": "x" })).toThrow(/shell identifier/);
	});
});

describe("pushBounded", () => {
	const at = "2026-01-01T00:00:00.000Z";
	const fill = (n: number, limit: number): Array<BufferEntry<number>> => {
		let buffer: Array<BufferEntry<number>> = [];
		for (let i = 1; i <= n; i += 1) buffer = pushBounded(buffer, i, limit, at).buffer;
		return buffer;
	};

	it("does not drop at exactly the limit", () => {
		const buffer = fill(4, 4);
		expect(buffer).toHaveLength(4);
		expect(buffer.every((entry) => entry.kind === "event")).toBe(true);
	});

	it("drops exactly one and marks it at limit + 1", () => {
		const limit = 4;
		let buffer = fill(limit, limit);
		const push = pushBounded(buffer, 5, limit, at);
		buffer = push.buffer;

		expect(push.droppedNow).toBe(1);
		expect(push.gap).toBe("created");
		expect(buffer[0]).toEqual({ kind: "gap", droppedEvents: 1, firstDroppedAt: at, lastDroppedAt: at });
		expect(events(buffer)).toEqual([2, 3, 4, 5]);
	});

	it("emits exactly one gap marker for a whole partition and keeps the newest events", () => {
		// The alternative — one marker per dropped event — turns a thousand-event
		// partition into a thousand markers, which is a different way of making the
		// transcript unreadable.
		const limit = 3;
		let buffer: Array<BufferEntry<number>> = [];
		for (let i = 1; i <= 100; i += 1) {
			buffer = pushBounded(buffer, i, limit, `2026-01-01T00:00:${String(i % 60).padStart(2, "0")}.000Z`)
				.buffer;
		}

		const gaps = buffer.filter((entry) => entry.kind === "gap");
		expect(gaps).toHaveLength(1);
		expect(buffer[0]?.kind).toBe("gap");
		expect(gaps[0]).toMatchObject({ droppedEvents: 97 });
		expect(events(buffer)).toEqual([98, 99, 100]);
	});

	it("counts events against the limit and the marker against nothing", () => {
		// Counting the marker means that at limit 1 the buffer oscillates between one
		// event and one marker and retains nothing at all.
		const limit = 1;
		let buffer = fill(1, limit);
		buffer = pushBounded(buffer, 2, limit, at).buffer;
		expect(events(buffer)).toEqual([2]);
		buffer = pushBounded(buffer, 3, limit, at).buffer;
		expect(events(buffer)).toEqual([3]);
		expect(buffer.filter((entry) => entry.kind === "gap")).toHaveLength(1);
	});

	it("honours a zero limit as 'buffer nothing' and still accounts for the loss", () => {
		let buffer: Array<BufferEntry<number>> = [];
		for (let i = 1; i <= 5; i += 1) buffer = pushBounded(buffer, i, 0, at).buffer;
		expect(events(buffer)).toEqual([]);
		expect(buffer).toEqual([
			{ kind: "gap", droppedEvents: 5, firstDroppedAt: at, lastDroppedAt: at },
		]);
	});

	it("widens the existing marker rather than adding a second", () => {
		const limit = 2;
		let buffer = fill(3, limit);
		expect(buffer.filter((e) => e.kind === "gap")).toHaveLength(1);
		const push = pushBounded(buffer, 4, limit, "2026-01-01T00:05:00.000Z");
		expect(push.gap).toBe("extended");
		expect(push.buffer.filter((e) => e.kind === "gap")).toHaveLength(1);
		expect(push.buffer[0]).toMatchObject({
			droppedEvents: 2,
			firstDroppedAt: at,
			lastDroppedAt: "2026-01-01T00:05:00.000Z",
		});
	});

	it("does not mutate the buffer it was given", () => {
		const original = fill(2, 2);
		const snapshot = JSON.stringify(original);
		pushBounded(original, 99, 2, at);
		expect(JSON.stringify(original)).toBe(snapshot);
	});

	function events(buffer: ReadonlyArray<BufferEntry<number>>): number[] {
		return buffer.flatMap((entry) => (entry.kind === "event" ? [entry.event] : []));
	}
});

describe("reconnectDelayMs", () => {
	const baseMs = 1_000;
	const ceilingMs = 45_000;

	it("is bounded by the ceiling however long the outage lasts", () => {
		// An unbounded doubling reaches hours, and a sandbox that reconnects in two
		// hours has already been reaped as stale and is burning money doing nothing.
		for (const attempt of [1, 5, 10, 40, 1_024, 4_096, Number.MAX_SAFE_INTEGER]) {
			for (const random of [0, 0.5, 0.999_999]) {
				const delay = reconnectDelayMs({ attempt, baseMs, ceilingMs, random });
				expect(delay).toBeGreaterThan(0);
				expect(delay).toBeLessThanOrEqual(ceilingMs);
			}
		}
	});

	it("keeps a floor at half the window so a hard-down control plane is not spun on", () => {
		expect(reconnectDelayMs({ attempt: 1, baseMs, ceilingMs, random: 0 })).toBe(500);
		expect(reconnectDelayMs({ attempt: 1, baseMs, ceilingMs, random: 1 })).toBe(1_000);
		expect(reconnectDelayMs({ attempt: 2, baseMs, ceilingMs, random: 0 })).toBe(1_000);
		expect(reconnectDelayMs({ attempt: 3, baseMs, ceilingMs, random: 0 })).toBe(2_000);
	});

	it("saturates exactly at the ceiling and stays there", () => {
		// base * 2^(n-1) first reaches 45_000 at n = 7 (64_000), so 6 is the last
		// attempt below the cap.
		expect(reconnectDelayMs({ attempt: 6, baseMs, ceilingMs, random: 1 })).toBe(32_000);
		expect(reconnectDelayMs({ attempt: 7, baseMs, ceilingMs, random: 1 })).toBe(45_000);
		expect(reconnectDelayMs({ attempt: 8, baseMs, ceilingMs, random: 1 })).toBe(45_000);
	});

	it("is monotonically non-decreasing in the attempt number for a fixed random draw", () => {
		let previous = 0;
		for (let attempt = 1; attempt <= 30; attempt += 1) {
			const delay = reconnectDelayMs({ attempt, baseMs, ceilingMs, random: 0.25 });
			expect(delay).toBeGreaterThanOrEqual(previous);
			previous = delay;
		}
	});

	it("survives degenerate inputs rather than returning NaN", () => {
		// A NaN delay becomes setTimeout(NaN) which fires immediately and forever,
		// which is the reconnect storm this function exists to prevent.
		for (const input of [
			{ attempt: 0, baseMs: 0, ceilingMs: 0, random: 0 },
			{ attempt: -5, baseMs: -1, ceilingMs: -1, random: Number.NaN },
			{ attempt: 3, baseMs: 10_000, ceilingMs: 1_000, random: 0.5 },
		]) {
			const delay = reconnectDelayMs(input);
			expect(Number.isFinite(delay)).toBe(true);
			expect(delay).toBeGreaterThan(0);
		}
	});
});

describe("pushDecision", () => {
	const base = { branch: "harbor/lse_7f3a", commits: 1, dirty: false, repoPresent: true };

	it("pushes exactly when there is at least one commit not on a remote", () => {
		// The whole product turns on this boundary: zero is a session that produces
		// no pull request, one is a session that does.
		expect(pushDecision({ ...base, commits: 0 }).push).toBe(false);
		expect(pushDecision({ ...base, commits: 1 }).push).toBe(true);
	});

	it("names the branch it was given rather than deriving one", () => {
		const verdict = pushDecision({ ...base, branch: "harbor/lse_c204" });
		expect(verdict).toEqual({ push: true, branch: "harbor/lse_c204", commits: 1, dirty: false });
	});

	it("pushes committed work even when the agent left the tree dirty", () => {
		// Harbor does NOT commit on the agent's behalf: `GIT_AUTHOR_*` is the
		// prompting human, so a commit Harbor made would carry their name on work
		// they never wrote. The dirt is reported, not resolved.
		const verdict = pushDecision({ ...base, commits: 2, dirty: true });
		expect(verdict).toEqual({ push: true, branch: base.branch, commits: 2, dirty: true });
	});

	it("distinguishes 'nothing committed' from 'nothing changed' in the reason it gives", () => {
		const clean = pushDecision({ ...base, commits: 0, dirty: false });
		const dirty = pushDecision({ ...base, commits: 0, dirty: true });
		expect(clean.push).toBe(false);
		expect(dirty.push).toBe(false);
		if (clean.push || dirty.push) throw new Error("unreachable");
		expect(clean.reason).toBe("nothing_to_push");
		expect(dirty.reason).toBe("nothing_to_push");
		// Same verdict, different sentence: "made no commits" sends somebody to the
		// agent, "changed files but committed nothing" sends them to the diff.
		expect(dirty.detail).toContain("committed nothing");
		expect(clean.detail).not.toContain("committed nothing");
	});

	it("treats a missing branch as 'the feature is off', not as an error", () => {
		for (const branch of [null, "", "   "]) {
			const verdict = pushDecision({ ...base, branch });
			expect(verdict.push).toBe(false);
			if (verdict.push) throw new Error("unreachable");
			expect(verdict.reason).toBe("no_branch");
		}
	});

	it("refuses a branch that would not be a safe git ref", () => {
		// The value reaches `git push origin HEAD:refs/heads/<branch>`. It arrives
		// from the Harbor-controlled region of the prompt command, so this is defence
		// in depth — but a ref built from junk is a failure nobody can read.
		for (const branch of [
			"-delete-everything",
			"has space",
			"harbor/lse_a..b",
			"harbor//double",
			"trailing/",
			"branch.lock",
			"ends.",
			"../../etc/passwd",
			"emoji🙂",
		]) {
			const verdict = pushDecision({ ...base, branch });
			expect(verdict.push, branch).toBe(false);
			if (verdict.push) throw new Error("unreachable");
			expect(verdict.reason, branch).toBe("branch_malformed");
		}
	});

	it("accepts the branch shapes Harbor actually produces", () => {
		for (const branch of ["harbor/lse_7f3a", "harbor/lse_0f8c1d2e-3a4b-5c6d-7e8f-9a0b1c2d3e4f", "main"]) {
			expect(pushDecision({ ...base, branch }).push, branch).toBe(true);
		}
	});

	it("refuses before anything else when there is no repository", () => {
		// Ordered first deliberately: with no work tree the commit count is
		// meaningless, and reporting `nothing_to_push` would send somebody looking
		// at the agent instead of at the clone that failed.
		const verdict = pushDecision({ ...base, repoPresent: false, commits: 0, branch: null });
		expect(verdict.push).toBe(false);
		if (verdict.push) throw new Error("unreachable");
		expect(verdict.reason).toBe("no_repo");
	});

	it("survives a commit count that could not be parsed rather than pushing on NaN", () => {
		// `git rev-list --count` output goes through parseInt, and a failed git
		// invocation yields NaN. NaN must not read as "some commits".
		for (const commits of [Number.NaN, Number.POSITIVE_INFINITY, -3]) {
			const verdict = pushDecision({ ...base, commits });
			expect(verdict.push, String(commits)).toBe(false);
			if (verdict.push) throw new Error("unreachable");
			expect(verdict.reason, String(commits)).toBe("nothing_to_push");
		}
	});
});
