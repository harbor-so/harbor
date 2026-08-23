#!/bin/sh
#
# One image, four verbs. See the Dockerfile header for why the two long-lived
# processes share an image rather than getting one each.
#
# `exec` in every branch, so the real process becomes PID 1's child directly and
# receives SIGTERM. A shell that waits on a child instead swallows the signal, and
# the visible symptom is a rolling restart that takes the full 30-second grace
# period on every pod and cuts every open SSE stream off mid-frame.

set -eu

case "${1:-web}" in

	web)
		# `next start` reads PORT. The `-p 3000` that used to be baked into the
		# npm script is gone for exactly this reason: Render and Railway inject
		# PORT, and a hardcoded port means the platform's health check hits a
		# closed door.
		exec node_modules/.bin/next start
		;;

	mcp)
		# The MCP surfaces AND every background loop — claim sweeps, automations,
		# sandbox deadlines, session ticks, compaction, orphan sweeps, Devin
		# polling. A deployment that runs only `web` runs none of those; see
		# HARBOR_MAINTENANCE_TOKEN in .env.example for the cron escape hatch.
		exec node_modules/.bin/tsx app/mcp/server.ts
		;;

	migrate)
		# One-shot, sequenced by the platform — compose's
		# `service_completed_successfully`, Fly's `release_command`, a Kubernetes
		# Job. Deliberately NOT run on app boot: drizzle's postgres-js migrator
		# takes no advisory lock, so N replicas starting together race each other
		# on `__drizzle_migrations`.
		#
		# HARBOR_SINGLE_CONNECTION keeps the pool at one connection so the process
		# exits when the work is done instead of being held open by an idle pool.
		HARBOR_SINGLE_CONNECTION=1 exec node_modules/.bin/tsx scripts/migrate.ts
		;;

	doctor)
		# What an operator runs at 2am, and what CI runs to prove the image is
		# assembled correctly. Needs no database, no credentials and no network:
		# provider construction is lazy — every vendor client is built on first
		# call, not in the constructor — so "can this image load all thirteen
		# providers" is answerable offline. That makes it the one end-to-end check
		# of the image that works without an account anywhere.
		exec node_modules/.bin/tsx scripts/doctor.ts
		;;

	*)
		# Anything else is run verbatim, so `docker run harbor sh` and
		# `docker run harbor node_modules/.bin/tsx scripts/seed.ts` both work.
		#
		# `seed` is deliberately NOT a verb of its own: scripts/seed.ts opens with
		# `truncate ... cascade` over fourteen tables, and a one-word entrypoint
		# for that is a production incident waiting for a typo. Making it verbose
		# is the point.
		exec "$@"
		;;

esac
