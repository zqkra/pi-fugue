#!/usr/bin/env bash
# Core engine E2E (DESIGN §6): a real Pi conductor spawns one cheap voice
# through riff_spawn, the run's status.json carries the lane key, the next
# session turn lists the voice through riff_status, and a second spawn of the
# same name becomes probe-2. Not part of `npm test`.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
EXT="$ROOT/src/index.ts"
# Hermetic: an installed Fugue in the owner's settings would conflict with this worktree.
SUBAGENTS_EXT="${PI_SUBAGENTS_EXT:-${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/npm/node_modules/pi-subagents/index.js}"
[ -f "$SUBAGENTS_EXT" ] || { echo "pi-subagents not found at $SUBAGENTS_EXT; set PI_SUBAGENTS_EXT" >&2; exit 1; }
MODEL="${FUGUE_E2E_MODEL:-opencode-go/deepseek-v4.1-flash}"
CHILD_MODEL="opencode-go/deepseek-v4.1-flash:low"
WORK="$(mktemp -d /tmp/fugue-core-e2e-XXXXXX)"
export PI_SUBAGENTS_TEMP_ROOT="$WORK/pi-subagents"

cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

run_turn() {
	local out="$1"
	shift
	timeout 300 pi -ne -p "$@" -e "$SUBAGENTS_EXT" -e "$EXT" --model "$MODEL" --approve < /dev/null > "$out" 2> "$out.err" || {
		echo "FAIL: pi exited non-zero; stderr:"
		cat "$out.err"
		exit 1
	}
}

# The conductor model is nondeterministic: retry a turn once when the expected
# text is missing. The status-file assertions below are the real evidence.
run_turn_until() {
	local out="$1" pattern="$2"
	shift 2
	run_turn "$out" "$@"
	if ! grep -q "$pattern" "$out"; then
		echo "note: retrying turn, first answer was: $(cat "$out")"
		run_turn "$out.retry" "$@"
		mv "$out.retry" "$out"
	fi
}

spawn_prompt='Call the riff_spawn tool exactly once with these arguments: {"riffs":[{"name":"probe","role":"scout","task":"Reply with exactly the word: pong. Do not use tools.","model":"'"$CHILD_MODEL"'"}]}. After the tool returns, reply with the exact tool result text and nothing else.'
status_prompt='Call the riff_status tool with no arguments. Reply with the exact tool result text and nothing else.'

check_lane() {
	python3 - "$PI_SUBAGENTS_TEMP_ROOT" "$CHILD_MODEL" "$SESSION_FILE" "$@" <<'PY'
import json, sys, glob, os
root, model, session_file = sys.argv[1], sys.argv[2], sys.argv[3]
wanted = sys.argv[4:]
seen = {}
for path in glob.glob(os.path.join(root, "async-subagent-runs", "*", "status.json")):
    data = json.load(open(path))
    key = data.get("lane", {}).get("key")
    if key in wanted:
        step = (data.get("steps") or [{}])[0]
        assert data["lane"]["key"] == key, data["lane"]
        assert step["lane"]["key"] == key, step["lane"]
        assert step["model"] == model, step["model"]
        assert data["state"] == "complete", data["state"]
        seen[key] = {"run": data["runId"], "state": data["state"], "model": step["model"]}
missing = [key for key in wanted if key not in seen]
assert not missing, f"missing lane keys {missing}; seen {sorted(seen)}"
tool_results = []
for line in open(session_file):
    try:
        entry = json.loads(line)
    except json.JSONDecodeError:
        continue
    message = entry.get("message") or {}
    if message.get("role") == "toolResult":
        for part in message.get("content") or []:
            if isinstance(part, dict) and part.get("type") == "text":
                tool_results.append(part.get("text") or "")
for key in wanted:
    run_id = seen[key]["run"]
    assert any(f"run {run_id}" in text for text in tool_results), f"no tool result with full run id for {key}"
    print(f"PASS status.json lane.key={key} state={seen[key]['state']} model={seen[key]['model']} run={run_id[:8]}")
    print(f"PASS tool result prints full run id {run_id} for {key}")
PY
}

echo "== turn 1: spawn probe ($CHILD_MODEL) =="
run_turn "$WORK/turn1.out" --session-id fugue-core-e2e --session-dir "$WORK/sessions" "$spawn_prompt"
SESSION_FILE="$(find "$WORK/sessions" -name "*fugue-core-e2e.jsonl" | head -1)"
[ -n "$SESSION_FILE" ] || { echo "FAIL: no session file"; exit 1; }
check_lane probe
grep -q '"customType":"fugue.voice"' "$SESSION_FILE" || { echo "FAIL: no fugue.voice entry in session"; exit 1; }
echo "PASS fugue.voice persisted; turn 1 answer: $(head -1 "$WORK/turn1.out")"

echo "== turn 2: riff_status in the same session =="
run_turn_until "$WORK/turn2.out" "probe" --session "$SESSION_FILE" "$status_prompt"
echo "PASS same session lists probe: $(grep -o 'probe.*' "$WORK/turn2.out" | head -1)"

echo "== turn 3: spawn probe again for the collision =="
run_turn "$WORK/turn3.out" --session "$SESSION_FILE" "$spawn_prompt"
if ! grep -q "probe-2" "$WORK/turn3.out" && ! check_lane probe-2 > /dev/null 2>&1; then
	echo "note: retrying turn 3, first answer was: $(cat "$WORK/turn3.out")"
	run_turn "$WORK/turn3.out" --session "$SESSION_FILE" "$spawn_prompt"
fi
check_lane probe probe-2
echo "PASS second spawn produced lane.key=probe-2; turn 3 answer: $(head -1 "$WORK/turn3.out")"
echo "ALL E2E CHECKS PASSED"
