#!/usr/bin/env bash
# Reboot recovery E2E: spawn a slow voice, kill the conductor and the runner,
# delete the pi-subagents temp root (tmpfs after a reboot), then resume the
# session. The hydrated voice must settle as stopped with the missing-run-files
# error instead of staying queued forever. Not part of `npm test`.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
EXT="$ROOT/src/index.ts"
MODEL="${FUGUE_E2E_MODEL:-opencode-go/deepseek-v4.1-flash}"
CHILD_MODEL="opencode-go/deepseek-v4.1-flash:low"
WORK="$(mktemp -d /tmp/fugue-reboot-e2e-XXXXXX)"
export PI_SUBAGENTS_TEMP_ROOT="$WORK/pi-subagents"

CONDUCTOR_PID=""
cleanup() {
	[ -n "$CONDUCTOR_PID" ] && kill -9 "$CONDUCTOR_PID" 2>/dev/null || true
	rm -rf "$WORK"
}
trap cleanup EXIT

spawn_prompt='Call the riff_spawn tool exactly once with these arguments: {"voices":[{"name":"zombie","role":"scout","task":"Run the bash command `sleep 60` and then reply with the word: alive","model":"'"$CHILD_MODEL"'"}]}. After the tool returns, reply with the exact tool result text and nothing else.'

echo "== spawn a slow voice, then kill the conductor and the runner =="
timeout 300 pi -p "$spawn_prompt" -e "$EXT" --model "$MODEL" --approve --session-id fugue-reboot-e2e --session-dir "$WORK/sessions" > "$WORK/turn1.out" 2> "$WORK/turn1.err" &
CONDUCTOR_PID=$!

RUNNER_PID=""
for _ in $(seq 1 120); do
	STATUS="$(find "$PI_SUBAGENTS_TEMP_ROOT" -path "*async-subagent-runs/*/status.json" 2>/dev/null | head -1 || true)"
	if [ -n "$STATUS" ]; then
		RUNNER_PID="$(python3 -c "import json,sys; print(json.load(open('$STATUS')).get('pid') or '')" 2>/dev/null || true)"
		[ -n "$RUNNER_PID" ] && break
	fi
	sleep 1
done
[ -n "$RUNNER_PID" ] || { echo "FAIL: voice never started"; cat "$WORK/turn1.err"; exit 1; }
sleep 3 # let the spawn turn and its fugue.voice entry flush
kill -9 "$CONDUCTOR_PID" 2>/dev/null || true
wait "$CONDUCTOR_PID" 2>/dev/null || true
CONDUCTOR_PID=""
kill -9 "$RUNNER_PID" 2>/dev/null || true
rm -rf "$PI_SUBAGENTS_TEMP_ROOT"
SESSION_FILE="$(find "$WORK/sessions" -name "*fugue-reboot-e2e.jsonl" | head -1)"
[ -n "$SESSION_FILE" ] || { echo "FAIL: no session file"; exit 1; }
grep -q '"customType":"fugue.voice"' "$SESSION_FILE" || { echo "FAIL: fugue.voice entry missing"; exit 1; }
echo "PASS conductor killed, runner killed, temp root deleted (run files gone)"

echo "== resume the session and ask for the zombie voice =="
timeout 300 pi -p 'Call the riff_status tool with name "zombie" and reply with the exact tool result text and nothing else.' \
	--session "$SESSION_FILE" -e "$EXT" --model "$MODEL" --approve < /dev/null > "$WORK/turn2.out" 2> "$WORK/turn2.err" || {
	echo "FAIL: resume exited non-zero; stderr:"; cat "$WORK/turn2.err"; exit 1
}
grep -q "zombie" "$WORK/turn2.out" || { echo "FAIL: zombie missing from status:"; cat "$WORK/turn2.out"; exit 1; }
grep -q "stopped" "$WORK/turn2.out" || { echo "FAIL: zombie not stopped:"; cat "$WORK/turn2.out"; exit 1; }
grep -q "run files missing (machine restarted?)" "$WORK/turn2.out" || { echo "FAIL: missing-files error absent:"; cat "$WORK/turn2.out"; exit 1; }
echo "PASS resumed status: $(tr '\n' ' ' < "$WORK/turn2.out" | sed 's/  */ /g')"

echo "== the settled state is persisted for the next session =="
python3 - "$SESSION_FILE" <<'PY'
import json, sys
states = []
for line in open(sys.argv[1]):
    entry = json.loads(line)
    if entry.get("type") == "custom" and entry.get("customType") == "fugue.voice":
        data = entry.get("data") or {}
        if data.get("name") == "zombie":
            states.append(data.get("state"))
assert states[-1] == "stopped", states
assert any(state != "queued" for state in states), states
print(f"PASS persisted fugue.voice states: {states}")
PY
echo "ALL REBOOT E2E CHECKS PASSED"
