#!/usr/bin/env bash
# Gates test: one passing and one failing check in a temp project, called
# through a real pi -p turn that invokes the registered fugue_gate tool.
#
#   bash test/e2e/gates-test.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
HARNESS="$ROOT/test/e2e/harness.ts"
TMP="$(mktemp -d /tmp/fugue-e2e-gates.XXXXXX)"
CONDUCTOR_MODEL="${FUGUE_E2E_CONDUCTOR_MODEL:-opencode-go/deepseek-v4.1-flash}"

mkdir -p "$TMP/.pi" "$TMP/sessions"
cat > "$TMP/.pi/fugue.json" <<'JSON'
{
  "gates": [
    { "name": "build", "run": "echo build-ok" },
    { "name": "test", "run": "echo test-broken; exit 3" }
  ]
}
JSON

echo "== gates test in $TMP"
(
	cd "$TMP"
	env FUGUE_E2E_HOLD_MS=0 \
		pi -ne -p "Call the fugue_gate tool with no arguments now. Do not explain, just call it." \
		--session-dir "$TMP/sessions" --model "$CONDUCTOR_MODEL" --thinking low \
		--no-builtin-tools --tools fugue_gate \
		-e "$HARNESS" < /dev/null > "$TMP/run.out" 2> "$TMP/run.err"
)

SESSION_FILE="$(find "$TMP/sessions" -maxdepth 1 -name '*.jsonl' | head -1)"
[ -n "$SESSION_FILE" ] || { echo "no session file"; cat "$TMP/run.err"; exit 1; }
echo "session=$SESSION_FILE"

python3 - "$SESSION_FILE" <<'PY'
import json, sys
session = sys.argv[1]
results = []
for line in open(session):
    entry = json.loads(line)
    message = entry.get("message") if entry.get("type") == "message" else None
    if message and message.get("role") == "toolResult" and message.get("toolName") == "fugue_gate":
        text = "".join(block.get("text", "") for block in message.get("content", []) if block.get("type") == "text")
        results.append(text)
assert results, "the pi turn never called fugue_gate"
report = results[0]
print("---- fugue_gate tool result ----")
print(report)
print("--------------------------------")
assert "gates 1/2 passed" in report, "report summary missing"
assert "PASS build (echo build-ok) exit 0" in report, "passing check missing"
assert "build-ok" in report, "passing tail missing"
assert "FAIL test (echo test-broken; exit 3) exit 3" in report, "failing check missing"
assert "test-broken" in report, "failing tail missing"
PY

echo "PASS gates test"
