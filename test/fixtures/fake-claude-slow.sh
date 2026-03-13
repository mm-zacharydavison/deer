#!/bin/sh
# Slow fake claude stub for E2E tests that need a long-running agent.
# Sleeps for 60 seconds — long enough for kill/cancel action tests to run.
echo "Claude Code 1.0.0 (fake)"
echo "● Working on the task..."
sleep 60
echo "● Done."
exit 0
