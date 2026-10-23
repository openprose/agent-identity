# agent-identity: in agent shells only, act as your GitHub App's bot on your
# org's repositories (git identity, git auth, gh). install.sh sources it from
# ~/.zshenv, ~/.zshrc and ~/.bashrc. Human shells are unaffected.
#
# A shell counts as an agent shell when any variable named in
# AGENT_IDENTITY_DETECT is non-empty. The default list covers harnesses that
# mark their shells; add your own (for example an orchestrator's session id
# variable) in ${XDG_CONFIG_HOME:-~/.config}/agent-identity/env.sh.

AGENT_IDENTITY_DETECT=${AGENT_IDENTITY_DETECT:-"AGENT_IDENTITY_AGENT CLAUDECODE AI_AGENT"}
_agent_identity_config="${XDG_CONFIG_HOME:-$HOME/.config}/agent-identity"
[ -f "$_agent_identity_config/env.sh" ] && . "$_agent_identity_config/env.sh"

_agent_identity_is_agent=""
case "$AGENT_IDENTITY_DETECT" in
  *[!A-Za-z0-9_\ ]*) AGENT_IDENTITY_DETECT="AGENT_IDENTITY_AGENT CLAUDECODE AI_AGENT" ;;  # names and spaces only; else defaults
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
  export GIT_CONFIG_COUNT=1
  export GIT_CONFIG_KEY_0=include.path
  export GIT_CONFIG_VALUE_0="$_agent_identity_config/agent.gitconfig"
fi
unset _agent_identity_is_agent _agent_identity_var _agent_identity_value _agent_identity_bin _agent_identity_config
