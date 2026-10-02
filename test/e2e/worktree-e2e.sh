#!/usr/bin/env bash
# Worktree E2E: a real Pi conductor runs in a temp repo that has an uncommitted
# change in the main checkout. It spawns a worker riff, which edits a file and
# commits inside its own fugue/auth worktree. After the riff settles, riff_merge
# brings the change into the main checkout, the owner's uncommitted change is
# still there, and the worktree folder and branch are gone.
#
#   bash test/e2e/worktree-e2e.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
EXT="$ROOT/src/index.ts"
MODEL="${FUGUE_E2E_MODEL:-opencode-go/deepseek-v4.1-flash}"
CHILD_MODEL="opencode-go/deepseek-v4.1-flash:low"
WORK="$(mktemp -d /tmp/fugue-worktree-e2e-XXXXXX)"
export PI_SUBAGENTS_TEMP_ROOT="$WORK/pi-subagents"

cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

run_turn() {
	local cwd="$1" out="$2"
	shift 2
	(cd "$cwd" && timeout 300 pi -p "$@" -e "$EXT" --model "$MODEL" --approve < /dev/null > "$out" 2> "$out.err")
}

# Wait until the auth run's status.json reports a terminal state.
wait_for_state() {
	local wanted="$1" state
	for _ in $(seq 1 120); do
		state="$(python3 - "$PI_SUBAGENTS_TEMP_ROOT" <<'PY'
import glob, json, os, sys
for path in glob.glob(os.path.join(sys.argv[1], "async-subagent-runs", "*", "status.json")):
    try:
        data = json.load(open(path))
    except (OSError, json.JSONDecodeError):
        continue
    if (data.get("lane") or {}).get("key") == "auth":
        print(data.get("state") or "")
        break
PY
)"
		[ "$state" = "$wanted" ] && return 0
		sleep 1
	done
	echo "last state: ${state:-missing}"
	return 1
}

scenario() {
	local n="$1"
	local repo="$WORK/repo-$n" sessions="$WORK/sessions-$n" worktree="$WORK/.fugue-worktrees/repo-$n/auth"
	mkdir -p "$repo" "$sessions"
	git -C "$repo" init -q -b main
	git -C "$repo" config user.email e2e@example.com
	git -C "$repo" config user.name "Fugue E2E"
	printf 'original\n' > "$repo/app.txt"
	printf 'owner original\n' > "$repo/owner.txt"
	git -C "$repo" add app.txt owner.txt
	git -C "$repo" commit -qm base
	# The owner keeps working in the main checkout while the riff runs.
	printf 'owner local edit\n' >> "$repo/owner.txt"

	local child_task='Run these bash commands in order: printf "from the riff\n" > feature.txt; git add feature.txt; git commit -m "add feature". Then reply with the single word: done. Do not push.'
	local spawn_prompt='Call the riff_spawn tool exactly once with these arguments: {"riffs":[{"name":"auth","role":"worker","task":"'"$child_task"'","model":"'"$CHILD_MODEL"'"}]}. After the tool returns, reply with the exact tool result text and nothing else.'
	local merge_prompt='Call the riff_merge tool exactly once with these arguments: {"name":"auth"}. Reply with the exact tool result text and nothing else.'

	echo "== attempt $n: turn 1, spawn worker auth ($CHILD_MODEL) in $repo =="
	run_turn "$repo" "$WORK/turn1-$n.out" --session-id "fugue-worktree-e2e-$n" --session-dir "$sessions" "$spawn_prompt" || {
		echo "pi turn 1 exited non-zero:"; cat "$WORK/turn1-$n.err"; return 1
	}
	local session_file
	session_file="$(find "$sessions" -name "*.jsonl" | head -1)"
	[ -n "$session_file" ] || { echo "no session file"; return 1; }
	[ -d "$worktree" ] || { echo "no worktree at $worktree; turn 1 answer:"; cat "$WORK/turn1-$n.out"; return 1; }
	git -C "$worktree" rev-parse --verify refs/heads/fugue/auth > /dev/null || { echo "branch fugue/auth missing"; return 1; }
	echo "PASS worktree $worktree on branch fugue/auth exists"

	wait_for_state complete || { echo "auth never completed"; return 1; }
	local commits
	commits="$(git -C "$worktree" rev-list --count main..HEAD)"
	[ "$commits" -ge 1 ] || { echo "worktree branch has no commit; child output:"; tail -5 "$WORK/turn1-$n.out"; return 1; }
	git -C "$worktree" show "HEAD:feature.txt" | grep -q "from the riff" || { echo "feature.txt not committed in the worktree"; return 1; }
	echo "PASS child settled complete and committed $commits commit(s) on fugue/auth"
	[ ! -e "$repo/feature.txt" ] || { echo "feature.txt leaked into the main checkout"; return 1; }
	echo "PASS main checkout untouched before merge (feature.txt only in the worktree)"

	echo "== attempt $n: turn 2, riff_merge auth in the same session =="
	run_turn "$repo" "$WORK/turn2-$n.out" --session "$session_file" "$merge_prompt" || {
		echo "pi turn 2 exited non-zero:"; cat "$WORK/turn2-$n.err"; return 1
	}
	grep -q "merged auth:" "$WORK/turn2-$n.out" || { echo "merge did not report success:"; cat "$WORK/turn2-$n.out"; return 1; }
	echo "PASS $(grep -o 'merged auth:.*' "$WORK/turn2-$n.out" | head -1)"

	grep -q "from the riff" "$repo/feature.txt" || { echo "merged feature.txt missing in the main checkout"; return 1; }
	git -C "$repo" show HEAD:feature.txt | grep -q "from the riff" || { echo "feature.txt is not in the main HEAD"; return 1; }
	echo "PASS feature.txt merged into the main checkout"

	git -C "$repo" diff --name-only | grep -qx owner.txt || { echo "owner's uncommitted change is gone"; return 1; }
	grep -q "owner local edit" "$repo/owner.txt" || { echo "owner.txt lost its local edit"; return 1; }
	echo "PASS owner's uncommitted change to owner.txt survived the merge"

	[ ! -d "$worktree" ] || { echo "worktree folder still exists"; return 1; }
	git -C "$repo" rev-parse --verify --quiet refs/heads/fugue/auth > /dev/null && { echo "branch fugue/auth still exists"; return 1; }
	echo "PASS worktree folder and branch are gone"

	python3 - "$session_file" <<'PY'
import json, sys
entries = []
for line in open(sys.argv[1]):
    try:
        entry = json.loads(line)
    except json.JSONDecodeError:
        continue
    if entry.get("type") == "custom" and entry.get("customType") == "fugue.voice":
        entries.append(entry.get("data") or {})
auth = [entry for entry in entries if entry.get("name") == "auth"]
assert auth, "no fugue.voice entry for auth"
worktrees = [entry.get("worktree") for entry in auth if entry.get("worktree")]
assert worktrees, "fugue.voice entry has no worktree"
assert worktrees[0].get("branch") == "fugue/auth", worktrees[0]
assert worktrees[-1].get("status") == "merged", worktrees[-1]
assert any(entry.get("state") == "done" for entry in auth), [entry.get("state") for entry in auth]
print(f"PASS session persisted worktree {worktrees[0]['branch']} active then {worktrees[-1]['status']}")
PY
	return 0
}

for n in 1 2; do
	if scenario "$n"; then
		echo "ALL WORKTREE E2E CHECKS PASSED"
		exit 0
	fi
	echo "note: attempt $n did not pass; retrying" >&2
done
echo "FAIL: worktree E2E did not pass"
exit 1
