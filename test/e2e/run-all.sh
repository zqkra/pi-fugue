#!/usr/bin/env bash
# Run every Fugue end-to-end script that exists, in order, stopping at the
# first failure and printing a summary. Each script drives real Pi and cheap
# deepseek children; this is not part of `npm test`.
#
#   npm run e2e
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

SCRIPTS=(core-e2e.sh crash-test.sh reboot-e2e.sh gates-test.sh worktree-e2e.sh)
ran=0
passed=0
failed=""

for script in "${SCRIPTS[@]}"; do
	path="test/e2e/$script"
	if [ ! -f "$path" ]; then
		echo "== skip $script (not present)"
		continue
	fi
	ran=$((ran + 1))
	start=$(date +%s)
	echo ""
	echo "========================================================================"
	echo "== e2e: $script"
	echo "========================================================================"
	if bash "$path"; then
		passed=$((passed + 1))
		echo "== PASS $script ($(($(date +%s) - start))s)"
	else
		failed="$script"
		echo "== FAIL $script ($(($(date +%s) - start))s)"
		break
	fi
done

echo ""
echo "========================================================================"
if [ -n "$failed" ]; then
	echo "E2E summary: FAILED after $ran script(s); stopped at $failed ($passed passed)"
	exit 1
fi
echo "E2E summary: all $passed script(s) passed"
