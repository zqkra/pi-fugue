#!/usr/bin/env bash
# Crash test: kill the conductor while a background voice runs, then resume the
# session twice and prove exactly one fugue.notice is delivered.
#
#   bash test/e2e/crash-test.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
HARNESS="$ROOT/test/e2e/harness.ts"
# Hermetic: an installed Fugue in the owner's settings would conflict with this harness.
SUBAGENTS_EXT="${PI_SUBAGENTS_EXT:-${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/npm/node_modules/pi-subagents/index.js}"
[ -f "$SUBAGENTS_EXT" ] || { echo "pi-subagents not found at $SUBAGENTS_EXT; set PI_SUBAGENTS_EXT" >&2; exit 1; }
TMP="$(mktemp -d /tmp/fugue-e2e-crash.XXXXXX)"
SESSION_DIR="$TMP/sessions"
CONDUCTOR_MODEL="${FUGUE_E2E_CONDUCTOR_MODEL:-opencode-go/deepseek-v4.1-flash}"
RESULTS_DIR="${PI_SUBAGENTS_TEMP_ROOT:-/tmp/pi-subagents-uid-$(id -u)}/async-subagent-results"

mkdir -p "$SESSION_DIR"
echo "== crash test in $TMP"

# 1. Conductor whose first turn spawns a sleeping background voice, then holds.
env FUGUE_E2E_DIR="$TMP" FUGUE_E2E_SPAWN=1 FUGUE_E2E_HOLD_MS=60000 \
	pi -ne -p "say ok" --session-dir "$SESSION_DIR" --model "$CONDUCTOR_MODEL" --thinking low \
	-e "$SUBAGENTS_EXT" -e "$HARNESS" < /dev/null > "$TMP/first.out" 2> "$TMP/first.err" &
CONDUCTOR_PID=$!
echo "conductor pid=$CONDUCTOR_PID"

for _ in $(seq 1 240); do
	[ -f "$TMP/run.json" ] && break
	kill -0 "$CONDUCTOR_PID" 2>/dev/null || { echo "conductor died early"; cat "$TMP/first.err"; exit 1; }
	sleep 0.5
done
[ -f "$TMP/run.json" ] || { echo "no run.json"; tail -20 "$TMP/first.err"; exit 1; }
RUN_ID="$(python3 -c "import json;print(json.load(open('$TMP/run.json'))['runId'])")"
ASYNC_DIR="$(python3 -c "import json;print(json.load(open('$TMP/run.json'))['asyncDir'])")"
echo "run=$RUN_ID"

for _ in $(seq 1 240); do
	[ -f "$ASYNC_DIR/status.json" ] && break
	kill -0 "$CONDUCTOR_PID" 2>/dev/null || { echo "conductor died before status.json"; cat "$TMP/first.err"; exit 1; }
	sleep 0.5
done
[ -f "$ASYNC_DIR/status.json" ] || { echo "no status.json at $ASYNC_DIR"; exit 1; }
kill -9 "$CONDUCTOR_PID"
wait "$CONDUCTOR_PID" 2>/dev/null || true
echo "killed conductor with -9 while child ran"

# 2. Wait for the detached runner's result file.
RESULT_FILE="$RESULTS_DIR/$RUN_ID.json"
for _ in $(seq 1 360); do
	[ -f "$RESULT_FILE" ] && break
	sleep 0.5
done
[ -f "$RESULT_FILE" ] || { echo "no result file at $RESULT_FILE"; exit 1; }
python3 - "$RESULT_FILE" <<'PY'
import json, sys
payload = json.load(open(sys.argv[1]))
assert payload.get("notificationDeliveredAt") is None, "result was delivered before the resume"
assert payload.get("state") in ("complete", "failed"), f"unexpected state {payload.get('state')}"
print(f"result present: state={payload.get('state')} session={payload.get('sessionId')}")
PY

SESSION_FILE="$(cat "$TMP/session.txt")"
echo "session=$SESSION_FILE"

# 3. First resume: the grace scan must deliver exactly one notice and mark the payload.
env FUGUE_E2E_DIR="$TMP" FUGUE_E2E_HOLD_MS=12000 \
	pi -ne -p "say ok" --session "$SESSION_FILE" --model "$CONDUCTOR_MODEL" --thinking low \
	-e "$SUBAGENTS_EXT" -e "$HARNESS" < /dev/null > "$TMP/resume1.out" 2> "$TMP/resume1.err"
echo "resume 1 done"
python3 - "$SESSION_FILE" "$RUN_ID" "$RESULT_FILE" <<'PY'
import json, sys
session, run_id, result = sys.argv[1:4]
notices = [e for e in map(json.loads, open(session))
           if e.get("type") == "custom_message" and e.get("customType") == "fugue.notice"]
runs = [r for n in notices for r in ((n.get("details") or {}).get("runIds") or [])]
assert runs == [run_id], f"resume 1 notices named {runs}, expected [{run_id}]"
content = notices[0].get("content", "")
assert run_id[:8] in content or "sleepy" in content or "worker" in content, f"notice did not name the voice: {content!r}"
payload = json.load(open(result))
assert isinstance(payload.get("notificationDeliveredAt"), (int, float)), "payload not marked delivered"
print(f"resume 1: notices=1, runIds={runs}, notificationDeliveredAt={payload['notificationDeliveredAt']}")
PY

# 4. Second resume: no second notice.
env FUGUE_E2E_DIR="$TMP" FUGUE_E2E_HOLD_MS=10000 \
	pi -ne -p "say ok" --session "$SESSION_FILE" --model "$CONDUCTOR_MODEL" --thinking low \
	-e "$SUBAGENTS_EXT" -e "$HARNESS" < /dev/null > "$TMP/resume2.out" 2> "$TMP/resume2.err"
python3 - "$SESSION_FILE" "$RUN_ID" <<'PY'
import json, sys
session, run_id = sys.argv[1:3]
notices = [e for e in map(json.loads, open(session))
           if e.get("type") == "custom_message" and e.get("customType") == "fugue.notice"]
runs = [r for n in notices for r in ((n.get("details") or {}).get("runIds") or [])]
assert runs == [run_id], f"resume 2 notices named {runs}, expected exactly one notice for [{run_id}]"
print(f"resume 2: notice count still {len(notices)}")
PY

echo "PASS crash test: exactly one fugue.notice for $RUN_ID"
