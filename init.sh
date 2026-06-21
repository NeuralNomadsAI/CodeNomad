#!/bin/bash
set -e

echo "=== Harness Initialization ==="

# Check if test script exists in package.json
if grep -q '"test"' package.json; then
  echo "=== pnpm test ==="
  pnpm test
else
  echo "=== pnpm test (skipped - no test script defined) ==="
fi

echo "=== pnpm build ==="
pnpm build

echo "=== Verification Complete ==="
echo ""
echo "Next steps:"
echo "1. Read feature_list.json to see current feature state"
echo "2. Pick ONE unfinished feature to work on"
echo "3. Implement only that feature"
echo "4. Re-run verification before claiming done"
