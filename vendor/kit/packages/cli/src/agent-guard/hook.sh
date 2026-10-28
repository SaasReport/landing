#!/bin/bash
# The agent-guard hook client (docs/AGENT-GUARD.md). Bash builtins only: no curl, no cat, no node, no fork on the hot path. It talks to the
# resident decision daemon over loopback TCP (127.0.0.1, the port and a per-daemon key are in .claude/guard.addr, mode 0600).
#
#   hook.sh [start]                        a Claude Code or Codex hook: the payload on stdin, the answer on stdout; exit 2 HOLDS the action
#   hook.sh git pre-commit|commit-msg|pre-push [args]   a git hook: exit 1 holds the git action
#
# FAIL CLOSED: the address file missing, the connection refused, a reply that is not HTTP 200 (a 500, a bad key, a truncated reply), anything:
# the daemon is started once and asked again; if that also fails the action is held. (A Claude Code hook that exits 1, crashes or times out
# lets the action through; only exit 2 blocks, so every failure path here ends in `exit 2`.)
#
# THE DAEMON'S LIFETIME differs by caller. A Claude Code hook (or Codex) keeps the resident daemon it had to start: the next hook, a few seconds later,
# is the reason it exists, and it exits by itself when idle. A GIT hook must leave nothing behind (a commit, a push from CI or a script has no next
# hook): if a git hook had to start the daemon, it stops exactly that one (by pid, verified by the daemon itself) when the hook ends; a daemon that was
# already running is reused and kept.
export LC_ALL=C
HERE="${BASH_SOURCE[0]%/*}"
ROOT="${CLAUDE_PROJECT_DIR:-$PWD}"
ADDR="$ROOT/.claude/guard.addr"
FAIL=2
[ "$1" = git ] && FAIL=1
RESP=""

ask() {      # ask BODY → RESP, status 0 only for an HTTP 200
  local P K r
  { read -r P K < "$ADDR"; } 2>/dev/null || return 1        # the group, so a missing file prints nothing (the redirect error belongs to the group)
  { exec 3</dev/tcp/127.0.0.1/"$P"; } 2>/dev/null || return 1      # a socket is read-write whatever the redirect says: < is enough, and the grammar cannot parse <>
  printf 'POST /decide HTTP/1.0\r\nx-guard-key: %s\r\ncontent-length: %d\r\n\r\n%s' "$K" "${#1}" "$1" >&3 2>/dev/null || { exec 3>&-; return 1; }
  local rc
  IFS= read -r -t 2 -d '' r <&3; rc=$?      # bounded: a slow daemon HOLDS (exit 2), it never times the hook out into an allow
  exec 3>&-
  [ "$rc" -gt 128 ] && return 1
  case "$r" in
    HTTP/1.?\ 200*) ;;
    *) return 1 ;;
  esac
  case "$r" in
    *$'\r\nx-guard-proof: '"$K"$'\r\n'*) ;;      # the daemon proves it holds the per-daemon key
    *) return 1 ;;
  esac
  RESP="${r#*$'\r\n\r\n'}"
  [[ "$RESP" == \{*\} ]] || return 1          # anything that is not a JSON object is not an answer
  return 0
}

STARTED_PID=""      # git hooks only: the pid of the daemon THIS hook started
held() {     # held BODY: ask, start the daemon once if needed, ask again, else hold
  ask "$1" && return 0
  local out; out="$(node "$HERE/daemon.mjs" ensure 2>/dev/null)"
  [ "$FAIL" = 1 ] && [[ $out == *'"started":true'* && $out =~ \"pid\":([0-9]+) ]] && STARTED_PID="${BASH_REMATCH[1]}"
  ask "$1" && return 0
  echo "agent-guard: the decision daemon did not answer, so the action is held (fail closed). Start it: node $HERE/daemon.mjs ensure" >&2
  exit "$FAIL"
}

esc() {      # JSON-escape $1 into ESC
  local s="$1"
  s="${s//\\/\\\\}"; s="${s//\"/\\\"}"; s="${s//$'\n'/\\n}"; s="${s//$'\r'/\\r}"; s="${s//$'\t'/\\t}"
  ESC="$s"
}

if [ "$1" != git ]; then
  [ "$1" = start ] && node "$HERE/daemon.mjs" ensure >/dev/null 2>&1      # SessionStart: bring the daemon up first
  IFS= read -r -d '' IN
  held "$IN"
  printf '%s' "$RESP"
  exit 0
fi

# ---- git boundary: the daemon runs git itself (warm, cached by blob hash); the hook only says what happened
stop_started() { [ -n "$STARTED_PID" ] && node "$HERE/daemon.mjs" stop --expect-pid "$STARTED_PID" >/dev/null 2>&1; }
trap stop_started EXIT        # a git hook leaves no daemon behind: the one it started is stopped when the hook ends, whatever the exit
shift
WHAT="$1"; shift
esc "$PWD"; CWD="$ESC"
esc "${GIT_INDEX_FILE:-}"; IDX="$ESC"
case "$WHAT" in
  pre-commit) BODY="{\"hook_event_name\":\"GitCommit\",\"cwd\":\"$CWD\",\"index\":\"$IDX\"}" ;;
  commit-msg)
    esc "$1"; MSG="$ESC"; esc "${KIT_AGENT_ID:-}"; AID="$ESC"
    BODY="{\"hook_event_name\":\"GitCommitMsg\",\"cwd\":\"$CWD\",\"index\":\"$IDX\",\"file\":\"$MSG\",\"agent_id\":\"$AID\"}" ;;
  pre-push)
    REFS=""
    while IFS=' ' read -r lr ls rr rs; do
      [ -z "$rr" ] && continue
      esc "$rr"; D=false; [[ $ls =~ ^0+$ ]] && D=true
      REFS="$REFS{\"remote\":\"$ESC\",\"delete\":$D},"
    done
    BODY="{\"hook_event_name\":\"GitPush\",\"cwd\":\"$CWD\",\"refs\":[${REFS%,}]}" ;;
  *) echo "agent-guard: unknown git hook $WHAT" >&2; exit 1 ;;
esac
held "$BODY"
case "$RESP" in
  *'"decision":"deny"'*) echo "agent-guard: ${RESP}" >&2; exit 1 ;;
esac
if [ "$WHAT" = commit-msg ] && [[ $RESP =~ \"trailer_text\":\"([^\"]*)\" ]]; then
  T="${BASH_REMATCH[1]//\\n/$'\n'}"
  [ -n "$T" ] && printf '\n%s\n' "$T" >> "$1"
fi
exit 0
