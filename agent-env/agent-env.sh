# agent-identity: in agent shells only, act as your GitHub App's bot on your
# org's repositories (git identity, git auth, gh). install.sh sources it from
# ~/.zshenv, ~/.zshrc and ~/.bashrc. Human shells are unaffected.
#
# A shell counts as an agent shell when any variable named in
# AGENT_IDENTITY_DETECT is non-empty. The default list covers harnesses that
# mark their shells; add your own (for example an orchestrator's session id
# variable) in ${XDG_CONFIG_HOME:-~/.config}/agent-identity/env.sh.

AGENT_IDENTITY_DETECT=${AGENT_IDENTITY_DETECT:-"AGENT_IDENTITY_AGENT CLAUDECODE AI_AGENT CODEX_THREAD_ID"}
_agent_identity_config="${XDG_CONFIG_HOME:-$HOME/.config}/agent-identity"
[ -f "$_agent_identity_config/env.sh" ] && . "$_agent_identity_config/env.sh"

_agent_identity_is_agent=""
case "$AGENT_IDENTITY_DETECT" in
  *[!A-Za-z0-9_\ ]*) AGENT_IDENTITY_DETECT="AGENT_IDENTITY_AGENT CLAUDECODE AI_AGENT CODEX_THREAD_ID" ;;  # names and spaces only; else defaults
esac
# Command substitution word-splits in both bash and zsh.
for _agent_identity_var in $(printf '%s\n' "$AGENT_IDENTITY_DETECT"); do
  case "$_agent_identity_var" in
    ''|[!A-Za-z_]*|*[!A-Za-z0-9_]*) continue ;;  # only plain variable names
  esac
  eval "_agent_identity_value=\${$_agent_identity_var:-}"
  [ -n "$_agent_identity_value" ] && _agent_identity_is_agent=1
done

if [ -n "$_agent_identity_is_agent" ] && [ -z "${AGENT_IDENTITY_DISABLE:-}" ]; then
  export AGENT_IDENTITY_AGENT=1
  _agent_identity_bin="$HOME/.local/share/agent-identity/bin"
  case ":$PATH:" in
    ":$_agent_identity_bin:"*) ;;
    *) PATH="$_agent_identity_bin:$(printf %s "$PATH" | tr ':' '\n' | grep -vxF "$_agent_identity_bin" | paste -sd: -)"; export PATH ;;
  esac
  # Append the include after any GIT_CONFIG_* entries already set (by a
  # harness, or by an outer shell that already added it), never overwrite.
  _agent_identity_n=${GIT_CONFIG_COUNT:-0}
  case "$_agent_identity_n" in ''|*[!0-9]*) _agent_identity_n=0 ;; esac
  _agent_identity_have=""
  _agent_identity_i=0
  while [ "$_agent_identity_i" -lt "$_agent_identity_n" ]; do
    eval "_agent_identity_value=\${GIT_CONFIG_VALUE_$_agent_identity_i:-}"
    [ "$_agent_identity_value" = "$_agent_identity_config/agent.gitconfig" ] && _agent_identity_have=1
    _agent_identity_i=$((_agent_identity_i + 1))
  done
  if [ -z "$_agent_identity_have" ]; then
    eval "export GIT_CONFIG_KEY_$_agent_identity_n=include.path"
    eval "export GIT_CONFIG_VALUE_$_agent_identity_n=\"\$_agent_identity_config/agent.gitconfig\""
    export GIT_CONFIG_COUNT=$((_agent_identity_n + 1))
  fi
fi
unset _agent_identity_is_agent _agent_identity_var _agent_identity_value _agent_identity_bin _agent_identity_config
unset _agent_identity_n _agent_identity_have _agent_identity_i
