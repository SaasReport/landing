#!/bin/bash
# The managed-policy launcher (docs/AGENT-GUARD.md): `kit agent-guard managed` embeds the text of this file as the hook command of the managed
# settings (a file, an MDM profile, the registry, the admin console, a Codex requirements.toml). It runs on every hook event in every session that
# loads the managed policy, finds the repository the call is about (a multi-repository cloud session loads no repository hook), and hands the call
# to THAT repository's hook client, which asks its decision daemon. A repository with no guard pack refuses every write (fail closed). Bash only.
export LC_ALL=C
IFS= read -r -d '' IN
cwd=""; fp=""; ev=""; tool=""
[[ $IN =~ \"cwd\"[[:space:]]*:[[:space:]]*\"([^\"]*)\" ]] && cwd="${BASH_REMATCH[1]}"
[[ $IN =~ \"(file_path|notebook_path)\"[[:space:]]*:[[:space:]]*\"([^\"]*)\" ]] && fp="${BASH_REMATCH[2]}"
[[ $IN =~ \"hook_event_name\"[[:space:]]*:[[:space:]]*\"([^\"]*)\" ]] && ev="${BASH_REMATCH[1]}"
[[ $IN =~ \"tool_name\"[[:space:]]*:[[:space:]]*\"([^\"]*)\" ]] && tool="${BASH_REMATCH[1]}"
dir="$cwd"
if [ -n "$fp" ]; then d="${fp%/*}"; [ -d "$d" ] || d="${d%/*}"; [ -d "$d" ] && dir="$d"; fi
[ -d "$dir" ] || dir="$PWD"
root=$(git -C "$dir" rev-parse --show-toplevel 2>/dev/null)
hook=""
# the one hook client this repository's guard sync wrote (.claude/hooks/agent-guard.sh, protected): nothing here reads a configuration
# file to find enforcement, so nothing an agent can write decides which hook runs
[ -n "$root" ] && [ -f "$root/.claude/hooks/agent-guard.sh" ] && hook="$root/.claude/hooks/agent-guard.sh"
if [ -n "$hook" ]; then
  printf '%s' "$IN" | CLAUDE_PROJECT_DIR="$root" bash "$hook"
  rc=$?
  # fail closed: only 0 (decided, its answer on stdout) and 2 (refused) are answers; anything else (a missing target, a crash) refuses
  [ "$rc" -eq 0 ] && exit 0
  [ "$rc" -eq 2 ] || echo "agent-guard (managed policy): the hook client failed (exit $rc), so this action is refused." >&2
  exit 2
fi
case "$ev:$tool" in
  PreToolUse:Bash|PreToolUse:Write|PreToolUse:Edit|PreToolUse:MultiEdit|PreToolUse:NotebookEdit|PreToolUse:Agent|PreToolUse:Task|PreToolUse:mcp__github__*)
    echo "agent-guard (managed policy): this repository has no guard pack (.claude/hooks/agent-guard.sh), so this action is refused. Run kit agent-guard sync and commit .claude/." >&2
    exit 2 ;;
esac
exit 0
