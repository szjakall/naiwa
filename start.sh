#!/bin/sh
# Starry supervisor launcher (Linux / macOS / Docker ENTRYPOINT).
#
# Usage:
#   ./start.sh                            foreground (Ctrl-C to stop)
#   nohup ./start.sh >starry.log 2>&1 &  background
#   ./start.sh -addr :9000                extra args are passed through to starry
#
# It does one thing: run starry, and on exit decide whether to relaunch by exit code.
#
#   0      clean user stop          → leave the loop
#   75     restart requested        → relaunch now (one-click update / rollback)
#   other  crash                    → relaunch after backoff (1→2→4…→60s)
#
# Download / SHA256 verify / binary swap are intentionally NOT done here — that logic
# lives in Go (the selfupdate package) and runs when starry starts, so there is a
# single tested path for the one step that must never go wrong: putting a runnable
# binary in place. A broken binary here would just be relaunched forever.
set -u

cd "$(dirname "$0")" || exit 1

BIN=./starry
[ -x "$BIN" ] || { echo "[starry] executable not found: $BIN" >&2; exit 1; }

RESTART_CODE=75
MAX_DELAY=60

child=0
stopping=0

# Forward stop signals to starry. Required under Docker: `docker stop` sends SIGTERM to
# PID 1 (this script), not the child — without forwarding, starry never shuts down
# gracefully and is SIGKILLed after the grace period, cutting running tasks off mid-flight.
forward() {
	stopping=1
	[ "$child" -ne 0 ] && kill -TERM "$child" 2>/dev/null || true
}
trap forward INT TERM

delay=1
while :; do
	"$BIN" "$@" &
	child=$!

	# A signal interrupts wait and makes it return >128; the child is still shutting down,
	# so wait again to get its real exit code.
	wait "$child"
	code=$?
	if [ "$code" -gt 128 ]; then
		wait "$child"
		code=$?
	fi
	child=0

	if [ "$stopping" -eq 1 ]; then
		echo "[starry] stopped"
		exit 0
	fi

	case "$code" in
		0)
			echo "[starry] exited cleanly"
			exit 0
			;;
		"$RESTART_CODE")
			echo "[starry] restart requested (applying new version)…"
			delay=1
			;;
		*)
			echo "[starry] crashed (code=$code), restarting in ${delay}s" >&2
			sleep "$delay"
			delay=$((delay * 2))
			[ "$delay" -gt "$MAX_DELAY" ] && delay=$MAX_DELAY
			;;
	esac
done
