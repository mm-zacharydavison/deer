#!/bin/sh
# Fake claude stub for E2E tests.
# Accepts any arguments (like the real claude binary) and exits quickly.

# Respond to --version quickly so preflight passes
case "$1" in --version) echo "1.0.0 (fake)"; exit 0;; esac

echo "Claude Code 1.0.0 (fake)"
sleep 1
echo "● Implementing the task..."
sleep 2
echo "● Done. Changes committed."
exit 0
