#!/bin/bash
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC_DIR="$(cd "$SCRIPT_DIR/../src" && pwd)"
TOTAL_PASS=0
TOTAL_FAIL=0
FAILED_ANY=0

GJS="${GJS:-gjs}"

if ! command -v "$GJS" &>/dev/null; then
    echo "ERROR: gjs not found. Install gjs to run tests."
    exit 1
fi

run_test() {
    local test_file="$1"
    local test_name="$(basename "$test_file" .js)"
    echo "================================================"
    echo "  RUNNING: $test_name"
    echo "================================================"
    if "$GJS" -I "$SRC_DIR" "$test_file"; then
        echo "  RESULT: $test_name PASSED"
    else
        echo "  RESULT: $test_name FAILED"
        FAILED_ANY=1
    fi
    echo ""
}

if [ $# -eq 0 ]; then
    TEST_FILES=("$SCRIPT_DIR"/test_*.js)
else
    TEST_FILES=("$@")
fi

for tf in "${TEST_FILES[@]}"; do
    [ -f "$tf" ] && run_test "$tf"
done

echo "Test suite"
echo "================================================"
if [ "$FAILED_ANY" -eq 0 ]; then
    echo "  ALL TESTS PASSED"
else
    echo "  SOME TESTS FAILED"
fi
echo "================================================"
exit "$FAILED_ANY"
