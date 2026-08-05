#!/usr/bin/env bash
# Concord relay monitor.
#
# Runs for the lifetime of an interactive session. Every line it prints becomes
# a notification in that session, which is the only channel that reaches an
# agent sitting idle at the prompt — hooks fire only when the agent is already
# doing something. `concord inbox drain` prints nothing on an empty inbox, so a
# quiet workspace stays quiet.
set -uo pipefail

CONCORD_BIN="${CONCORD_BIN:-concord}"
CONCORD_INBOX_POLL_SECONDS="${CONCORD_INBOX_POLL_SECONDS:-2}"

# Identity needs no configuration: Claude Code exports CLAUDE_CODE_SESSION_ID
# into this process, and `concord inbox drain` derives the agent id from it.
# CONCORD_AGENT_ID overrides it when a human wants to name the agents.

# Once installed, this plugin loads in every session, most of which have nothing
# to do with Concord. Exit immediately rather than leaving a poll loop spawning
# a subprocess every couple of seconds for the life of an unrelated project.
if ! "${CONCORD_BIN}" inbox status >/dev/null 2>&1; then
  exit 0
fi

while true; do
  # Never let a transient failure (a locked database, a mid-write config) kill
  # the monitor: a dead monitor silently stops delivering messages.
  "${CONCORD_BIN}" inbox drain --format monitor 2>/dev/null || true
  sleep "${CONCORD_INBOX_POLL_SECONDS}"
done
