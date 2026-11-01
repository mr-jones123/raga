#!/bin/sh
# Installs raga, the coding harness from https://github.com/mr-jones123/raga.
#
#   curl -fsSL https://raw.githubusercontent.com/mr-jones123/raga/main/install.sh | sh
#
# What it does, in order:
#   1. Checks for Node.js 22.19+ and npm, and offers to install them.
#   2. Installs the raga-cli npm package globally (under ~/.local if npm's global directory is not writable).
#   3. Offers to install uv, which raga uses to create the Python environment for its kernel.
#   4. Asks whether to log in to a subscription or add an API key; raga then opens its login screen.
#   5. Recommends installing Bend, so the bundled bend skill can check proofs.
#
# Set RAGA_VERSION to install a specific raga-cli version (default: latest).

RAGA_PACKAGE="raga-cli"
RAGA_CMD="raga"
RAGA_VERSION_SPEC="${RAGA_VERSION:-latest}"
# Matches `raga update`, so a fresh release installs even when npm is configured with a minimum release age.
RAGA_NPM_INSTALL_MIN_AGE_ARG="--min-release-age=0"
RAGA_BEND_INSTALLER="https://bend-lang.com/install.sh"
RAGA_UV_INSTALLER="https://astral.sh/uv/install.sh"
RAGA_ESC=$(printf '\033')
RAGA_CR=$(printf '\r')
RAGA_ETX=$(printf '\003')
readonly RAGA_PACKAGE RAGA_CMD RAGA_VERSION_SPEC RAGA_NPM_INSTALL_MIN_AGE_ARG RAGA_BEND_INSTALLER RAGA_UV_INSTALLER RAGA_ESC RAGA_CR RAGA_ETX

raga_installer_main() {
  set -eu

  check_file="${TMPDIR:-/tmp}/raga-installer-checks.$$"
  run_preflight_checks >"$check_file" &
  check_pid=$!

  raga_logo_animation

  if wait "$check_pid"; then
    check_status=0
  else
    check_status=$?
  fi

  printf '\033[1m  Raga Installer\033[0m\n\033[2m  Every turn of the wheel makes the next run smoother\033[0m\n\n'
  if [ "$check_status" -eq 0 ]; then
    cat "$check_file"
  fi
  rm -f "$check_file"

  if [ "$check_status" -ne 0 ]; then
    if ! install_node_npm_interactive; then
      exit "$check_status"
    fi

    check_file="${TMPDIR:-/tmp}/raga-installer-checks.$$"
    if run_preflight_checks >"$check_file"; then
      check_status=0
    else
      check_status=$?
    fi
    cat "$check_file"
    rm -f "$check_file"

    if [ "$check_status" -ne 0 ]; then
      exit "$check_status"
    fi
  fi

  RAGA_EXISTING_PATH=$(command -v "$RAGA_CMD" 2>/dev/null || true)
  if ! RAGA_NPM_INSTALL_PREFIX=$(select_npm_install_prefix); then
    exit 1
  fi
  RAGA_NPM_UNINSTALL_PREFIX=$(select_npm_uninstall_prefix "$RAGA_EXISTING_PATH")

  choose_raga_action "$RAGA_EXISTING_PATH"
  case "$RAGA_INSTALL_ACTION" in
    uninstall)
      uninstall_raga_package
      printf '\nRaga was uninstalled. Your logins, settings, and sessions in %s were kept.\n' "$(raga_agent_dir)"
      exit 0
      ;;
    none)
      exit 0
      ;;
  esac

  install_raga_package
  if [ "$RAGA_INSTALL_ACTION" = reinstall ]; then
    printf '\nRaga was reinstalled successfully.\n'
  else
    printf '\nRaga was installed successfully.\n'
  fi
  printf 'Update raga later with: raga update\n'

  if installed_raga_is_first_on_path; then
    if [ "${RAGA_NODE_INSTALLED_STANDALONE:-0}" = 1 ]; then
      printf '\nIf node is not found in your shell yet, add this to your shell profile:\n\n'
      printf '  export PATH="%s:$PATH"\n' "$RAGA_STANDALONE_NODE_BIN"
    fi
  else
    printf '\n'
    print_raga_not_on_path_message
  fi

  prompt_install_uv
  prompt_login
  prompt_install_bend
  prompt_start_raga
}

run_preflight_checks() {
  status=0

  if command -v node >/dev/null 2>&1; then
    node_version=$(node --version)
    if ! node -e 'const [maj,min,patch] = process.versions.node.split(".").map(Number); process.exit(maj > 22 || (maj === 22 && (min > 19 || (min === 19 && patch >= 0))) ? 0 : 1)' >/dev/null; then
      printf 'error: Raga requires Node.js 22.19.0 or newer. Found %s.\n' "$node_version"
      status=1
    fi
  else
    printf 'error: Node.js 22.19.0 or newer is required to install Raga.\n'
    status=1
  fi

  if ! command -v npm >/dev/null 2>&1; then
    printf 'error: npm is required to install Raga.\n'
    status=1
  fi

  if [ "$status" -ne 0 ]; then
    printf '\n'
  fi

  return "$status"
}

# ---------------------------------------------------------------------------
# Prompts
# ---------------------------------------------------------------------------

tty_available() {
  ( : <>/dev/tty ) 2>/dev/null
}

# Ask a yes/no question on the terminal. Prints nothing and returns $2 (0 = yes) when there is no terminal.
ask_yes_no() {
  question="$1"
  default_yes="$2"
  tty_available || return "$default_yes"

  if [ "$default_yes" -eq 0 ]; then
    hint='[Y/n]'
  else
    hint='[y/N]'
  fi
  exec 3<>/dev/tty
  printf '%s %s ' "$question" "$hint" >&3
  if ! IFS= read -r answer <&3; then
    answer=
  fi
  exec 3>&-
  case "$answer" in
    y|Y|yes|YES|Yes) return 0 ;;
    n|N|no|NO|No) return 1 ;;
    *) return "$default_yes" ;;
  esac
}

style() {
  if [ -t 1 ] && [ "${TERM:-}" != "dumb" ]; then
    printf '%s[%sm' "$RAGA_ESC" "$1"
  fi
}

section() {
  printf '\n%s%s%s\n' "$(style 1)" "$1" "$(style 0)"
}

raga_agent_dir() {
  if [ -n "${RAGA_CODING_AGENT_DIR:-}" ]; then
    printf '%s' "$RAGA_CODING_AGENT_DIR"
  else
    printf '%s/.raga/agent' "$HOME"
  fi
}

# True when auth.json holds at least one saved login or API key.
raga_has_saved_credentials() {
  auth_file="$(raga_agent_dir)/auth.json"
  [ -f "$auth_file" ] && grep -q '"[^"]*"[[:space:]]*:' "$auth_file"
}

# Provider API keys raga reads from the environment. Prints the first one that is set.
raga_env_api_key_name() {
  for key_name in ANTHROPIC_API_KEY OPENAI_API_KEY GEMINI_API_KEY OPENROUTER_API_KEY XAI_API_KEY GROQ_API_KEY MISTRAL_API_KEY DEEPSEEK_API_KEY; do
    eval "key_value=\${$key_name:-}"
    if [ -n "$key_value" ]; then
      printf '%s' "$key_name"
      return 0
    fi
  done
  return 1
}

prompt_install_uv() {
  if command -v uv >/dev/null 2>&1; then
    return 0
  fi

  section 'Python runtime'
  printf 'Raga runs its Python kernel in an environment it creates with uv. uv is not installed.\n'
  printf 'Without uv, raga uses python3 from PATH, which must be Python 3.11 or newer.\n\n'
  if ! tty_available; then
    printf 'Install uv later with:\n\n  curl -LsSf %s | sh\n' "$RAGA_UV_INSTALLER"
    return 0
  fi
  if ! ask_yes_no 'Install uv now? (recommended)' 0; then
    printf 'Skipped. Install uv later with:\n\n  curl -LsSf %s | sh\n' "$RAGA_UV_INSTALLER"
    return 0
  fi

  printf '\n'
  if [ "$(uname -s)" = Darwin ] && command -v brew >/dev/null 2>&1; then
    uv_status=0
    brew install uv || uv_status=$?
  else
    uv_status=0
    curl -LsSf "$RAGA_UV_INSTALLER" | sh || uv_status=$?
  fi
  if [ "$uv_status" -ne 0 ]; then
    printf '\n%suv installation failed.%s Raga still works with python3 3.11+. Retry with:\n\n  curl -LsSf %s | sh\n' "$(style 31)" "$(style 0)" "$RAGA_UV_INSTALLER"
    return 0
  fi
  # The uv installer puts uv in ~/.local/bin and updates shell profiles, which take effect in new shells only.
  case ":$PATH:" in
    *":$HOME/.local/bin:"*) ;;
    *) PATH="$HOME/.local/bin:$PATH"; export PATH ;;
  esac
  hash -r
}

prompt_login() {
  RAGA_OPEN_LOGIN=0

  section 'Log in'
  printf 'Raga needs a model provider. You can sign in with a subscription you already pay for\n'
  printf '(Claude Pro/Max, ChatGPT Plus/Pro, GitHub Copilot, and others) or paste an API key.\n\n'

  default_answer=0
  if raga_has_saved_credentials; then
    printf 'Saved logins found in %s/auth.json.\n' "$(raga_agent_dir)"
    default_answer=1
  elif env_key=$(raga_env_api_key_name); then
    printf '%s is set in your environment; raga can use it without logging in.\n' "$env_key"
    default_answer=1
  fi

  if ! tty_available; then
    printf 'Log in later: run raga --login, or type /login inside raga.\n'
    return 0
  fi
  if ask_yes_no 'Log in or add an API key now?' "$default_answer"; then
    RAGA_OPEN_LOGIN=1
    printf 'Raga will open its login screen when it starts, after the next step.\n'
  else
    printf 'Skipped. Log in later with raga --login, or type /login inside raga.\n'
  fi
}

# Bend publishes builds for macOS and Linux on arm64 and x64. Prints the reason when this machine is not one.
bend_unsupported_reason() {
  case "${PREFIX:-}" in
    */com.termux/*)
      printf 'Bend does not support Android yet: its Linux build needs glibc.'
      return 0
      ;;
  esac
  case "$(uname -s)" in
    Darwin|Linux) ;;
    MINGW*|MSYS*|CYGWIN*|Windows*)
      printf 'Bend needs Linux, macOS, or WSL. Install raga inside WSL to use Bend on Windows.'
      return 0
      ;;
    *)
      printf 'Bend runs on Linux and macOS, not %s.' "$(uname -s)"
      return 0
      ;;
  esac
  case "$(uname -m)" in
    arm64|aarch64|x86_64|amd64) ;;
    *)
      printf 'Bend runs on arm64 and x64 CPUs, not %s.' "$(uname -m)"
      return 0
      ;;
  esac
  return 1
}

bend_home() {
  printf '%s' "${BEND_HOME:-$HOME/.bend}"
}

existing_bend_path() {
  if [ -n "${BEND_BIN:-}" ] && [ -x "$BEND_BIN" ]; then
    printf '%s' "$BEND_BIN"
  elif command -v bend >/dev/null 2>&1; then
    command -v bend
  elif [ -x "$(bend_home)/bin/bend" ]; then
    printf '%s' "$(bend_home)/bin/bend"
  else
    return 1
  fi
}

prompt_install_bend() {
  section 'Bend (recommended)'
  printf 'Raga ships a bend skill: it turns rules you state in plain words into Bend laws and\n'
  printf 'checks the proofs with the bend CLI. A checked proof replaces "the agent says it works",\n'
  printf 'which cuts down on AI slop in code that has to stay correct.\n\n'

  if bend_path=$(existing_bend_path); then
    printf 'Bend is already installed at %s. Update it later with: bend update\n' "$bend_path"
    return 0
  fi
  if reason=$(bend_unsupported_reason); then
    printf 'Skipping Bend on this machine. %s\n' "$reason"
    return 0
  fi
  if ! tty_available; then
    printf 'Install Bend later with:\n\n  curl -fsSL %s | sh\n' "$RAGA_BEND_INSTALLER"
    return 0
  fi
  if ! ask_yes_no 'Install Bend now? (recommended)' 0; then
    printf 'Skipped. The bend skill asks for Bend when it needs it. Install it later with:\n\n  curl -fsSL %s | sh\n' "$RAGA_BEND_INSTALLER"
    return 0
  fi

  printf '\n'
  bend_status=0
  curl -fsSL "$RAGA_BEND_INSTALLER" | sh || bend_status=$?
  if [ "$bend_status" -ne 0 ]; then
    printf '%sBend installation failed.%s Retry with:\n\n  curl -fsSL %s | sh\n' "$(style 31)" "$(style 0)" "$RAGA_BEND_INSTALLER"
    return 0
  fi
  # The bend skill also finds ~/.bend/bin/bend without PATH; the PATH entry is for running bend yourself.
  case ":$PATH:" in
    *":$(bend_home)/bin:"*) ;;
    *) prompt_add_path_to_profile "$(bend_home)/bin" || true ;;
  esac
}

# The installer runs as a child process and cannot change the calling shell's PATH, so offer to start the
# installed raga by its full path. This makes the first run work even when the shell needs a restart to find it.
prompt_start_raga() {
  start_raga_path=$(raga_installed_path)
  [ -n "$start_raga_path" ] && [ -x "$start_raga_path" ] || return 0
  [ -t 1 ] || return 0
  tty_available || return 0

  if [ "$RAGA_OPEN_LOGIN" = 1 ]; then
    printf '\n'
    ask_yes_no 'Start raga now and open the login screen?' 0 || {
      printf 'Run raga --login when you are ready.\n'
      return 0
    }
    printf '\n'
    exec "$start_raga_path" --login </dev/tty
  fi

  printf '\n'
  ask_yes_no 'Start raga now?' 0 || return 0
  printf '\n'
  exec "$start_raga_path" </dev/tty
}

# ---------------------------------------------------------------------------
# Install, reinstall, uninstall
# ---------------------------------------------------------------------------

raga_install_spec() {
  printf '%s@%s' "$RAGA_PACKAGE" "$RAGA_VERSION_SPEC"
}

select_npm_install_prefix() {
  npm_prefix=$(npm_global_prefix)
  if [ -n "$npm_prefix" ] && npm_prefix_supports_global_install "$npm_prefix"; then
    return 0
  fi

  if [ -n "$npm_prefix" ] && [ -e "$npm_prefix/bin/$RAGA_CMD" ]; then
    printf "npm's global directory is not writable: %s\n" "$npm_prefix" >&2
    printf 'Raga is already installed at: %s/bin/%s\n\n' "$npm_prefix" "$RAGA_CMD" >&2
    printf 'Installing another copy under %s/.local could leave your shell using the old global raga, so this installer stopped.\n\n' "$HOME" >&2
    printf 'Update or remove the existing global install first:\n\n' >&2
    printf '  sudo npm install -g --ignore-scripts %s %s\n\n' "$RAGA_NPM_INSTALL_MIN_AGE_ARG" "$(raga_install_spec)" >&2
    printf 'or\n\n  sudo npm uninstall -g %s\n\n' "$RAGA_PACKAGE" >&2
    printf 'Then run this installer again.\n' >&2
    return 1
  fi

  printf '%s/.local' "$HOME"
}

select_npm_uninstall_prefix() {
  existing_raga_path="$1"
  [ -n "$existing_raga_path" ] || return 0

  npm_prefix=$(npm_global_prefix)
  if [ -n "$npm_prefix" ] && [ "$existing_raga_path" = "$npm_prefix/bin/$RAGA_CMD" ]; then
    return 0
  fi

  raga_bin_suffix="/bin/$RAGA_CMD"
  case "$existing_raga_path" in
    *"$raga_bin_suffix") printf '%s' "${existing_raga_path%"$raga_bin_suffix"}" ;;
  esac
}

raga_install_bin_dir() {
  if [ -n "${RAGA_NPM_INSTALL_PREFIX:-}" ]; then
    printf '%s/bin' "$RAGA_NPM_INSTALL_PREFIX"
  else
    npm_prefix=$(npm_global_prefix)
    if [ -n "$npm_prefix" ]; then
      printf '%s/bin' "$npm_prefix"
    fi
  fi
}

raga_installed_path() {
  raga_bin_dir=$(raga_install_bin_dir)
  if [ -n "$raga_bin_dir" ]; then
    printf '%s/%s' "$raga_bin_dir" "$RAGA_CMD"
  fi
}

installed_raga_is_first_on_path() {
  installed_raga_path=$(raga_installed_path)
  [ -n "$installed_raga_path" ] || return 1

  active_raga_path=$(command -v "$RAGA_CMD" 2>/dev/null) || return 1
  [ "$active_raga_path" = "$installed_raga_path" ]
}

print_raga_not_on_path_message() {
  raga_bin_dir=$(raga_install_bin_dir)
  active_raga_path=$(command -v "$RAGA_CMD" 2>/dev/null || true)

  printf 'Raga was installed, but your shell is not using that install yet.\n'
  if [ -n "$active_raga_path" ]; then
    printf 'Your shell currently resolves raga to: %s\n' "$active_raga_path"
  fi

  if [ -n "$raga_bin_dir" ]; then
    prompt_add_path_to_profile "$raga_bin_dir" || true
    command=$(path_update_command "$raga_bin_dir")
    printf 'Restart your shell or run:\n\n'
    printf '  %s\n\n' "$command"
    printf 'Then run: raga\n'
  else
    printf "Check npm's global prefix with:\n\n"
    printf '  npm prefix -g\n\n'
    printf 'Then add its bin directory to your shell PATH.\n'
  fi
}

default_raga_action() {
  if [ -n "$1" ]; then
    printf 'reinstall'
  else
    printf 'install'
  fi
}

choose_raga_action() {
  existing_raga_path="$1"

  if ! tty_available; then
    print_raga_action_menu "$existing_raga_path"
    printf 'No terminal detected; continuing without confirmation.\n'
    RAGA_INSTALL_ACTION=$(default_raga_action "$existing_raga_path")
    print_raga_action_selection "$RAGA_INSTALL_ACTION"
    return 0
  fi

  exec 3<>/dev/tty
  trap 'exec 3>&-; trap - INT TERM; exit 130' INT TERM
  print_raga_action_menu "$existing_raga_path" >&3

  while :; do
    key=$(read_tty_key)

    case "$key" in
      ""|" "|"$RAGA_CR"|y|Y)
        RAGA_INSTALL_ACTION=$(default_raga_action "$existing_raga_path")
        break
        ;;
      u|U)
        if [ -n "$existing_raga_path" ]; then
          RAGA_INSTALL_ACTION=uninstall
          break
        fi
        ;;
      "$RAGA_ETX")
        exit 130
        ;;
      n|N|"$RAGA_ESC")
        RAGA_INSTALL_ACTION=none
        break
        ;;
    esac

    printf 'Please choose one of the listed keys.\n' >&3
  done

  print_raga_action_selection "$RAGA_INSTALL_ACTION" >&3
  exec 3>&-
  trap - INT TERM
}

print_raga_action_menu() {
  existing_raga_path="$1"
  reset=$(style 0)
  dim=$(style 2)
  bold=$(style 1)
  violet=$(style '38;2;167;152;215')
  green=$(style 32)
  red=$(style 31)

  if [ -n "$existing_raga_path" ]; then
    printf '%sRaga is already installed at:%s\n\n' "$bold" "$reset"
    printf '  %s\n\n' "$existing_raga_path"
  fi

  if [ -n "${RAGA_NPM_INSTALL_PREFIX:-}" ]; then
    printf "npm's global directory is not writable; Raga will be installed under %s.\n\n" "$RAGA_NPM_INSTALL_PREFIX"
  fi

  if [ -n "$existing_raga_path" ]; then
    printf '%sReinstall command:%s\n\n  ' "$bold" "$reset"
  else
    printf '%sInstall command:%s\n\n  ' "$bold" "$reset"
  fi
  print_raga_install_command
  printf '\n\n'

  printf '%sChoose an action:%s\n\n' "$bold" "$reset"
  if [ -n "$existing_raga_path" ]; then
    printf '  %s%-4s%s %sReinstall Raga%s %s(default)%s\n' "$violet" 'y' "$reset" "$green" "$reset" "$dim" "$reset"
    printf '  %s%-4s%s %sUninstall Raga%s\n' "$violet" 'u' "$reset" "$red" "$reset"
  else
    printf '  %s%-4s%s %sInstall Raga%s %s(default)%s\n' "$violet" 'y' "$reset" "$green" "$reset" "$dim" "$reset"
  fi
  printf '  %s%-4s%s %sDo nothing%s\n' "$violet" 'n' "$reset" "$dim" "$reset"
}

print_raga_action_selection() {
  case "$1" in
    install) message="Will install Raga." ;;
    reinstall) message="Will reinstall Raga." ;;
    uninstall) message="Will uninstall Raga." ;;
    none) message="Chose to do nothing. Exiting." ;;
  esac
  printf '\n%s\n\n' "$message"
}

print_raga_install_command() {
  if [ -n "${RAGA_NPM_INSTALL_PREFIX:-}" ]; then
    printf 'npm install -g --ignore-scripts %s --prefix %s %s' "$RAGA_NPM_INSTALL_MIN_AGE_ARG" "$RAGA_NPM_INSTALL_PREFIX" "$(raga_install_spec)"
  else
    printf 'npm install -g --ignore-scripts %s %s' "$RAGA_NPM_INSTALL_MIN_AGE_ARG" "$(raga_install_spec)"
  fi
}

install_raga_package() {
  if [ -t 1 ] && [ "${TERM:-}" != "dumb" ]; then
    install_raga_package_with_progress
  else
    printf 'Installing Raga...\n\n'
    run_npm_install_raga error
  fi
}

run_npm_install_raga() {
  npm_loglevel="$1"
  if [ -n "${RAGA_NPM_INSTALL_PREFIX:-}" ]; then
    npm install -g --ignore-scripts "$RAGA_NPM_INSTALL_MIN_AGE_ARG" --prefix "$RAGA_NPM_INSTALL_PREFIX" --no-fund --no-audit "--loglevel=$npm_loglevel" --progress=false "$(raga_install_spec)"
  else
    npm install -g --ignore-scripts "$RAGA_NPM_INSTALL_MIN_AGE_ARG" --no-fund --no-audit "--loglevel=$npm_loglevel" --progress=false "$(raga_install_spec)"
  fi
}

npm_package_is_installed_for_uninstall() {
  if [ -n "${RAGA_NPM_UNINSTALL_PREFIX:-}" ]; then
    npm ls -g --prefix "$RAGA_NPM_UNINSTALL_PREFIX" --depth=0 "$RAGA_PACKAGE" >/dev/null 2>&1
  else
    npm ls -g --depth=0 "$RAGA_PACKAGE" >/dev/null 2>&1
  fi
}

uninstall_raga_package() {
  if ! npm_package_is_installed_for_uninstall; then
    printf 'I found raga at:\n\n  %s\n\n' "$RAGA_EXISTING_PATH" >&2
    printf 'but npm does not show %s installed there. It may be a source checkout or another package manager.\n' "$RAGA_PACKAGE" >&2
    printf 'Nothing was removed.\n' >&2
    exit 1
  fi

  printf 'Uninstalling Raga...\n\n'
  if [ -n "${RAGA_NPM_UNINSTALL_PREFIX:-}" ]; then
    npm uninstall -g --prefix "$RAGA_NPM_UNINSTALL_PREFIX" --no-fund --no-audit --loglevel=error --progress=false "$RAGA_PACKAGE"
  else
    npm uninstall -g --no-fund --no-audit --loglevel=error --progress=false "$RAGA_PACKAGE"
  fi
  hash -r

  if [ -e "$RAGA_EXISTING_PATH" ] || [ -L "$RAGA_EXISTING_PATH" ]; then
    printf '\nnpm uninstall finished, but raga is still present at:\n\n  %s\n' "$RAGA_EXISTING_PATH" >&2
    exit 1
  fi
}

install_raga_package_with_progress() {
  log_file="${TMPDIR:-/tmp}/raga-installer-npm.$$"
  rm -f "$log_file"
  : >"$log_file"

  run_npm_install_raga verbose >"$log_file" 2>&1 &
  npm_pid=$!

  printf '\033[?25l'
  animate_npm_install "$log_file" &
  progress_pid=$!
  trap 'kill "$npm_pid" 2>/dev/null || true; finish_install_progress "$progress_pid"; exit 130' INT TERM

  if wait "$npm_pid"; then
    status=0
  else
    status=$?
  fi

  finish_install_progress "$progress_pid"
  trap - INT TERM

  if [ "$status" -ne 0 ]; then
    printf '\033[31mInstallation failed.\033[0m\n\n'
    cat "$log_file"
    rm -f "$log_file"
    exit "$status"
  fi

  rm -f "$log_file"
  if terminal_supports_unicode; then
    printf '  \033[32m✓\033[0m install complete\n'
  else
    printf '  \033[32mok\033[0m install complete\n'
  fi
}

# ---------------------------------------------------------------------------
# Progress bars
# ---------------------------------------------------------------------------

animate_npm_install() {
  log_file="$1"

  if terminal_supports_unicode; then
    full="█"
    empty="░"
    frame_count=10
  else
    full="#"
    empty="-"
    frame_count=4
  fi

  step=0
  label="starting npm install"
  while :; do
    frame=$(spinner_frame "$step" "$frame_count")
    if [ $((step % 5)) -eq 0 ]; then
      label=$(npm_install_progress_label "$log_file" "$label")
    fi
    draw_install_progress "$step" "$frame" "$label" "$full" "$empty"
    step=$((step + 1))
    sleep 0.08
  done
}

npm_install_progress_label() {
  log_file="$1"
  label="$2"
  metadata_cache_count=0
  metadata_fetch_count=0
  tarball_cache_count=0
  tarball_fetch_count=0

  while IFS= read -r line; do
    line=${line%"$RAGA_CR"}
    case "$line" in
      npm\ verbose\ title\ npm\ install*)
        label="resolving packages"
        ;;
      npm\ http\ fetch\ GET\ *https://registry.npmjs.org/*.tgz*)
        tarball_fetch_count=$((tarball_fetch_count + 1))
        label="fetching tarballs (${tarball_fetch_count})"
        ;;
      npm\ http\ cache\ *@https://registry.npmjs.org/*.tgz*)
        tarball_cache_count=$((tarball_cache_count + 1))
        if [ "$tarball_fetch_count" -gt 0 ]; then
          label="fetching tarballs (${tarball_fetch_count})"
        else
          label="checking tarballs (${tarball_cache_count})"
        fi
        ;;
      npm\ http\ fetch\ GET\ *https://registry.npmjs.org/*)
        metadata_fetch_count=$((metadata_fetch_count + 1))
        label="fetching package metadata (${metadata_fetch_count})"
        ;;
      npm\ http\ cache\ https://registry.npmjs.org/*)
        metadata_cache_count=$((metadata_cache_count + 1))
        if [ "$metadata_fetch_count" -gt 0 ]; then
          label="fetching package metadata (${metadata_fetch_count})"
        else
          label="checking cached metadata (${metadata_cache_count})"
        fi
        ;;
      changed\ *|added\ *|removed\ *|updated\ *|up\ to\ date\ *)
        label="$line"
        ;;
    esac
  done < "$log_file"

  printf '%s' "$label"
}

# A comet of wheel colors runs along the bar: gold hub, lavender handles, violet rim, deep violet spokes.
draw_install_progress() {
  step="$1"; frame="$2"; label="$3"; full="$4"; empty="$5"; title="${6:-Installing Raga}"

  reset="${RAGA_ESC}[0m"
  dim="${RAGA_ESC}[2m"
  gold="${RAGA_ESC}[38;2;232;190;92m"
  lavender="${RAGA_ESC}[38;2;201;193;230m"
  violet="${RAGA_ESC}[38;2;167;152;215m"
  deep="${RAGA_ESC}[38;2;125;120;200m"
  bold="${RAGA_ESC}[1m"

  width=28
  trail=8
  head=$((step % (width + trail)))
  bar=""

  i=0
  while [ "$i" -lt "$width" ]; do
    age=$((head - i))
    if [ "$age" -ge 0 ] && [ "$age" -lt "$trail" ]; then
      case "$age" in
        0|1) cell="${gold}${full}${reset}" ;;
        2|3) cell="${lavender}${full}${reset}" ;;
        4|5) cell="${violet}${full}${reset}" ;;
        *) cell="${deep}${full}${reset}" ;;
      esac
    else
      cell="${dim}${empty}${reset}"
    fi
    bar="${bar}${cell}"
    i=$((i + 1))
  done

  printf '\r\033[K  %s%s%s %s %s%s%s %s' "$violet" "$frame" "$reset" "$bar" "$bold" "$title" "$reset" "$label"
}

# ---------------------------------------------------------------------------
# Logo
# ---------------------------------------------------------------------------

# The Mahoraga wheel assembles like falling pieces: the rim drops in, the hub and spokes drop into it, and the
# eight handles lock on clockwise. Then it takes a hit (two flashes) and adapts: it turns one handle clockwise.
raga_logo_animation() {
  if [ ! -t 1 ] || [ "${TERM:-}" = "dumb" ]; then
    print_static_logo
    return
  fi
  # Apple Terminal misaligns braille, so it gets the wordmark, as the raga TUI does.
  if [ "${TERM_PROGRAM:-}" = "Apple_Terminal" ]; then
    printf '\n  %s[1;38;5;141mraga%s[0m\n\n' "$RAGA_ESC" "$RAGA_ESC"
    return
  fi

  H="${RAGA_ESC}[38;2;232;190;92m"
  S="${RAGA_ESC}[38;2;125;120;200m"
  R="${RAGA_ESC}[38;2;167;152;215m"
  K="${RAGA_ESC}[38;2;201;193;230m"
  W="${RAGA_ESC}[38;2;255;255;255m"
  Z="${RAGA_ESC}[0m"
  E="${RAGA_ESC}[K"
  home="${RAGA_ESC}[H"

  trap 'printf "%s%s[?25h\n" "$Z" "$RAGA_ESC"; trap - INT TERM; exit 130' INT TERM
  printf '%s[?25l%s[2J%s' "$RAGA_ESC" "$RAGA_ESC" "$home"

  for step in $RAGA_LOGO_SEQUENCE; do
    raga_logo_frame "${step%%:*}"
    draw_raga_logo_frame
    sleep "${step#*:}"
  done

  printf '%s%s[?25h\n' "$Z" "$RAGA_ESC"
  trap - INT TERM
}

draw_raga_logo_frame() {
  printf '%b' "${home}${E}\n${RAGA_LOGO_FRAME}\n" 2>/dev/null || true
}

print_static_logo() {
  H='' S='' R='' K='' W='' Z='' E=''
  raga_logo_frame "$RAGA_LOGO_FINAL_FRAME"
  printf '\n%b\n\n' "$RAGA_LOGO_FRAME"
}

# ---------------------------------------------------------------------------
# Node.js, PATH, and terminal helpers (shared with the pi installer)
# ---------------------------------------------------------------------------

install_node_npm_interactive() {
  method=$(detect_node_install_method)
  case "$method" in
    homebrew) label="Homebrew" ;;
    apt) label="apt" ;;
    apk) label="apk" ;;
    standalone) label="standalone Node.js" ;;
  esac

  if ! ( : <>/dev/tty ) 2>/dev/null; then
    printf 'No terminal detected; install Node.js 22.19.0 or newer and npm, then run this installer again.\n'
    return 1
  fi
  exec 3<>/dev/tty

  printf 'Raga needs Node.js 22.19.0 or newer and npm. Install them now with %s? [Y/n] ' "$label" >&3
  if ! IFS= read -r answer <&3; then
    answer=
  fi
  exec 3>&-
  case "$answer" in
    n|N|no|NO) printf '\nInstall Node.js 22.19.0 or newer and npm, then run this installer again.\n'; return 1 ;;
    *) ;;
  esac

  install_node_npm "$method" "$label"
}

detect_node_install_method() {
  case "$(uname -s)" in
    Darwin)
      if command -v brew >/dev/null 2>&1; then
        printf 'homebrew'
      else
        printf 'standalone'
      fi
      ;;
    Linux)
      if command -v apt-cache >/dev/null 2>&1 && command -v apt-get >/dev/null 2>&1 && apt_node_candidate_is_new_enough; then
        printf 'apt'
      elif command -v apk >/dev/null 2>&1 && apk_node_candidate_is_new_enough; then
        printf 'apk'
      else
        printf 'standalone'
      fi
      ;;
    *)
      printf 'standalone'
      ;;
  esac
}

apt_node_candidate_is_new_enough() {
  version=$(apt-cache policy nodejs 2>/dev/null | awk '/Candidate:/ { print $2; exit }')
  [ -n "$version" ] && [ "$version" != "(none)" ] && node_version_string_is_new_enough "$version"
}

apk_node_candidate_is_new_enough() {
  version=$(apk search -x nodejs 2>/dev/null | awk -F- '/^nodejs-/ { print $2; exit }')
  [ -n "$version" ] && node_version_string_is_new_enough "$version"
}

node_version_string_is_new_enough() {
  version="${1#v}"
  case "$version" in
    [0-9]*) ;;
    *) return 1 ;;
  esac
  version="${version%%[!0-9.]*}"
  version_ifs=${IFS- }
  IFS=.
  set -- $version
  IFS=$version_ifs
  major="${1:-}"
  minor="${2:-0}"
  patch="${3:-0}"
  case "$major" in ''|*[!0-9]*) return 1 ;; esac
  case "$minor" in ''|*[!0-9]*) minor=0 ;; esac
  case "$patch" in ''|*[!0-9]*) patch=0 ;; esac

  [ "$major" -gt 22 ] && return 0
  [ "$major" -eq 22 ] && [ "$minor" -gt 19 ] && return 0
  [ "$major" -eq 22 ] && [ "$minor" -eq 19 ] && [ "$patch" -ge 0 ] && return 0
  return 1
}

install_node_npm() {
  method="$1"; label="$2"

  if [ -t 1 ] && [ "${TERM:-}" != "dumb" ]; then
    install_node_npm_with_progress "$method" "$label"
  else
    printf '\nInstalling Node.js and npm with %s...\n\n' "$label"
    run_node_install_method "$method"
    printf '\nNode.js and npm are installed.\n'
  fi

  if [ "$method" = standalone ]; then
    load_standalone_node
    RAGA_NODE_INSTALLED_STANDALONE=1
  fi
  hash -r
  printf '\n'
}

install_node_npm_with_progress() {
  method="$1"; label="$2"
  log_file="${TMPDIR:-/tmp}/raga-installer-node.$$"
  rm -f "$log_file"
  : >"$log_file"

  run_node_install_method "$method" >"$log_file" 2>&1 &
  install_pid=$!

  printf '\033[?25l'
  animate_node_install "$log_file" "$label" &
  progress_pid=$!
  trap 'kill "$install_pid" 2>/dev/null || true; finish_install_progress "$progress_pid"; exit 130' INT TERM

  if wait "$install_pid"; then
    status=0
  else
    status=$?
  fi

  finish_install_progress "$progress_pid"
  trap - INT TERM

  if [ "$status" -ne 0 ]; then
    printf '\033[31mNode.js installation failed.\033[0m\n\n'
    cat "$log_file"
    rm -f "$log_file"
    return "$status"
  fi

  rm -f "$log_file"
  if terminal_supports_unicode; then
    printf '  \033[32m✓\033[0m Node.js and npm install complete\n'
  else
    printf '  \033[32mok\033[0m Node.js and npm install complete\n'
  fi
}

run_node_install_method() {
  case "$1" in
    homebrew) install_node_with_homebrew ;;
    apt) install_node_with_apt ;;
    apk) install_node_with_apk ;;
    standalone) install_node_standalone ;;
  esac
}

install_node_with_homebrew() {
  if brew list node >/dev/null 2>&1; then
    brew upgrade node
  else
    brew install node
  fi
}

install_node_with_apt() {
  print_sudo_note
  if [ "${EUID:-$(id -u)}" -eq 0 ]; then
    apt-get update
    apt-get install -y nodejs npm
  else
    sudo sh -c 'apt-get update && apt-get install -y nodejs npm'
  fi
}

install_node_with_apk() {
  print_sudo_note
  run_with_sudo apk add --update-cache nodejs npm
}

install_node_standalone() {
  node_platform=$(detect_node_binary_platform) || {
    printf 'Unsupported operating system for automatic Node.js install: %s\n' "$(uname -s)"
    return 1
  }
  node_arch=$(detect_node_binary_arch) || {
    printf 'Unsupported CPU architecture for automatic Node.js install: %s\n' "$(uname -m)"
    return 1
  }
  node_dist_base="https://nodejs.org/dist/latest-v22.x"
  node_base_dir=$(node_standalone_base_dir)
  node_tmp_dir="${TMPDIR:-/tmp}/raga-node.$$"

  rm -rf "$node_tmp_dir"
  mkdir -p "$node_tmp_dir" "$node_base_dir"

  printf 'Resolving Node.js binary for %s-%s\n' "$node_platform" "$node_arch"
  curl -fsSL "$node_dist_base/SHASUMS256.txt" -o "$node_tmp_dir/SHASUMS256.txt"
  node_file=$(awk -v suffix="-$node_platform-$node_arch.tar.xz" '
    index($2, "node-v") == 1 && length($2) >= length(suffix) && substr($2, length($2) - length(suffix) + 1) == suffix { print $2; exit }
  ' "$node_tmp_dir/SHASUMS256.txt")
  if [ -z "$node_file" ]; then
    printf 'No Node.js binary is available for %s-%s.\n' "$node_platform" "$node_arch"
    rm -rf "$node_tmp_dir"
    return 1
  fi

  printf 'Downloading Node.js %s\n' "${node_file%.tar.xz}"
  curl -fsSL "$node_dist_base/$node_file" -o "$node_tmp_dir/$node_file"
  verify_node_standalone_download "$node_tmp_dir" "$node_file"
  ensure_node_standalone_extract_tools "$node_platform"

  node_dir="$node_base_dir/${node_file%.tar.xz}"
  rm -rf "$node_dir"
  printf 'Extracting Node.js to %s\n' "$node_dir"
  tar -xf "$node_tmp_dir/$node_file" -C "$node_base_dir"
  rm -f "$node_base_dir/current"
  ln -s "$node_dir" "$node_base_dir/current"
  rm -rf "$node_tmp_dir"
  printf 'Node.js installed at %s\n' "$node_dir"
}

verify_node_standalone_download() {
  checksum_dir="$1"
  checksum_file_name="$2"
  awk -v file="$checksum_file_name" '$2 == file { print }' "$checksum_dir/SHASUMS256.txt" > "$checksum_dir/SHASUMS256.selected"

  if command -v sha256sum >/dev/null 2>&1; then
    printf 'Verifying Node.js download\n'
    (cd "$checksum_dir" && sha256sum -c SHASUMS256.selected)
  elif command -v shasum >/dev/null 2>&1; then
    printf 'Verifying Node.js download\n'
    (cd "$checksum_dir" && shasum -a 256 -c SHASUMS256.selected)
  fi
}

ensure_node_standalone_extract_tools() {
  extract_platform="$1"

  if [ "$extract_platform" = linux ] && ! command -v xz >/dev/null 2>&1; then
    printf 'Installing xz-utils for Node.js archive extraction\n'
    print_sudo_note
    if command -v apt-get >/dev/null 2>&1; then
      run_with_sudo apt-get update
      run_with_sudo apt-get install -y xz-utils
    elif command -v apk >/dev/null 2>&1; then
      run_with_sudo apk add --update-cache xz
    else
      printf 'xz is required to extract Node.js. Install xz and run this installer again.\n'
      return 1
    fi
  fi
}

load_standalone_node() {
  RAGA_STANDALONE_NODE_BIN="$(node_standalone_base_dir)/current/bin"
  PATH="$RAGA_STANDALONE_NODE_BIN:$PATH"
  export RAGA_STANDALONE_NODE_BIN PATH
}

node_standalone_base_dir() {
  if [ -n "${XDG_DATA_HOME:-}" ]; then
    printf '%s/raga-node' "$XDG_DATA_HOME"
  else
    printf '%s/.local/share/raga-node' "$HOME"
  fi
}

detect_node_binary_platform() {
  case "$(uname -s)" in
    Darwin) printf 'darwin' ;;
    Linux) printf 'linux' ;;
    *) return 1 ;;
  esac
}

detect_node_binary_arch() {
  case "$(uname -m)" in
    x86_64|amd64) printf 'x64' ;;
    arm64|aarch64) printf 'arm64' ;;
    armv7l) printf 'armv7l' ;;
    ppc64le) printf 'ppc64le' ;;
    s390x) printf 's390x' ;;
    *) return 1 ;;
  esac
}

print_sudo_note() {
  if [ "${EUID:-$(id -u)}" -ne 0 ]; then
    printf 'This may ask for your sudo password.\n\n'
  fi
}

run_with_sudo() {
  if [ "${EUID:-$(id -u)}" -eq 0 ]; then
    "$@"
  else
    sudo "$@"
  fi
}

npm_global_prefix() {
  npm prefix -g 2>/dev/null || npm config get prefix 2>/dev/null
}

npm_prefix_supports_global_install() {
  prefix="$1"
  path_is_writable_or_creatable "$prefix/lib/node_modules" && path_is_writable_or_creatable "$prefix/bin"
}

path_is_writable_or_creatable() {
  check_path="$1"
  while [ ! -e "$check_path" ]; do
    parent=${check_path%/*}
    if [ -z "$parent" ] || [ "$parent" = "$check_path" ]; then
      return 1
    fi
    check_path="$parent"
  done

  [ -d "$check_path" ] && [ -w "$check_path" ]
}

shell_config_file() {
  current_shell=$(basename "${SHELL:-sh}")
  case "$current_shell" in
    fish) printf '%s/.config/fish/config.fish' "$HOME" ;;
    zsh) printf '%s/.zshrc' "${ZDOTDIR:-$HOME}" ;;
    bash)
      if [ -f "$HOME/.bashrc" ]; then
        printf '%s/.bashrc' "$HOME"
      else
        printf '%s/.profile' "$HOME"
      fi
      ;;
    *) printf '%s/.profile' "$HOME" ;;
  esac
}

path_update_command() {
  bin_dir="$1"
  current_shell=$(basename "${SHELL:-sh}")
  if [ "$bin_dir" = "$HOME/.local/bin" ]; then
    bin_expr='$HOME/.local/bin'
  else
    bin_expr="$bin_dir"
  fi

  case "$current_shell" in
    fish) printf 'fish_add_path "%s"' "$bin_expr" ;;
    *) printf 'export PATH="%s:$PATH"' "$bin_expr" ;;
  esac
}

config_file_mentions_path() {
  config_file="$1"
  command="$2"

  [ -f "$config_file" ] || return 1
  grep -Fxq "$command" "$config_file"
}

prompt_add_path_to_profile() {
  bin_dir="$1"
  if ! ( : <>/dev/tty ) 2>/dev/null; then
    return 1
  fi

  config_file=$(shell_config_file)
  command=$(path_update_command "$bin_dir")

  if config_file_mentions_path "$config_file" "$command"; then
    printf 'A PATH update for %s already exists in %s.\n' "$bin_dir" "$config_file"
    return 0
  fi

  exec 3<>/dev/tty
  printf 'Add %s to your PATH in %s now? [Y/n] ' "$bin_dir" "$config_file" >&3
  if ! IFS= read -r answer <&3; then
    answer=
  fi
  exec 3>&-
  case "$answer" in
    n|N|no|NO) return 1 ;;
    *) ;;
  esac

  mkdir -p "${config_file%/*}"
  touch "$config_file"
  printf '\n# Raga\n%s\n' "$command" >> "$config_file"
  printf 'Added %s to %s.\n' "$bin_dir" "$config_file"
}

restore_tty_state() {
  tty_state="$1"
  [ -n "$tty_state" ] || return 0
  stty "$tty_state" < /dev/tty 2>/dev/null || true
}

read_tty_key() {
  old_tty_state=$(stty -g < /dev/tty 2>/dev/null || true)
  trap 'restore_tty_state "$old_tty_state"; trap - INT TERM; exit 130' INT TERM
  stty -icanon -echo min 1 time 0 < /dev/tty 2>/dev/null || true
  if ! key=$(dd bs=1 count=1 2>/dev/null < /dev/tty); then
    key=
  fi
  restore_tty_state "$old_tty_state"
  trap - INT TERM
  printf '%s' "$key"
}

finish_install_progress() {
  progress_pid="$1"

  kill "$progress_pid" 2>/dev/null || true
  wait "$progress_pid" 2>/dev/null || true
  printf '\r\033[K\033[?25h'
}

terminal_supports_unicode() {
  locale="${LC_ALL:-${LC_CTYPE:-${LANG:-}}}"

  case "$locale" in
    *UTF-8*|*utf-8*|*UTF8*|*utf8*) return 0 ;;
  esac

  case "${TERM_PROGRAM:-}" in
    Apple_Terminal|iTerm.app|vscode|WezTerm) return 0 ;;
  esac

  return 1
}

spinner_frame() {
  frame_step="$1"
  frame_count="$2"

  if [ "$frame_count" -eq 10 ]; then
    case $((frame_step % 10)) in
      0) printf '⠋' ;;
      1) printf '⠙' ;;
      2) printf '⠹' ;;
      3) printf '⠸' ;;
      4) printf '⠼' ;;
      5) printf '⠴' ;;
      6) printf '⠦' ;;
      7) printf '⠧' ;;
      8) printf '⠇' ;;
      *) printf '⠏' ;;
    esac
  else
    case $((frame_step % 4)) in
      0) printf '-' ;;
      1) printf '\\' ;;
      2) printf '|' ;;
      *) printf '/' ;;
    esac
  fi
}

animate_node_install() {
  log_file="$1"
  method_label="$2"

  if terminal_supports_unicode; then
    full="█"
    empty="░"
    frame_count=10
  else
    full="#"
    empty="-"
    frame_count=4
  fi

  step=0
  label="starting ${method_label} install"
  while :; do
    frame=$(spinner_frame "$step" "$frame_count")
    if [ $((step % 5)) -eq 0 ]; then
      label=$(node_install_progress_label "$log_file" "$label")
    fi
    draw_install_progress "$step" "$frame" "$label" "$full" "$empty" "Installing Node.js"
    step=$((step + 1))
    sleep 0.08
  done
}

node_install_progress_label() {
  log_file="$1"
  label="$2"

  while IFS= read -r line; do
    line=${line##*"$RAGA_CR"}
    case "$line" in
      "") ;;
      Resolving\ Node.js*) label="resolving Node.js binary" ;;
      Downloading\ Node.js*) label="$line" ;;
      Verifying\ Node.js*) label="verifying download" ;;
      Installing\ xz-utils*) label="installing xz-utils" ;;
      Extracting\ Node.js*) label="extracting Node.js" ;;
      Node.js\ installed*) label="Node.js installed" ;;
      Hit:*|Get:*|Ign:*) label="updating package lists" ;;
      Reading\ package\ lists*) label="reading package lists" ;;
      Building\ dependency\ tree*) label="resolving dependencies" ;;
      The\ following\ NEW\ packages*) label="installing dependencies" ;;
      Need\ to\ get*|Fetched\ *) label="$line" ;;
      Selecting\ previously\ unselected\ package*) label="selecting packages" ;;
      Preparing\ to\ unpack*) label="preparing packages" ;;
      Unpacking\ *|Setting\ up\ *) label="$line" ;;
      fetch\ *) label="fetching packages" ;;
      *Installing\ nodejs*) label="$line" ;;
      OK:\ *) label="$line" ;;
      ==\>\ Downloading*) label="downloading packages" ;;
      ==\>\ Installing*|==\>\ Upgrading*) label="$line" ;;
      ==\>\ Pouring*) label="installing package" ;;
      *already\ installed*) label="$line" ;;
    esac
  done < "$log_file"

  if [ "${#label}" -gt 64 ]; then
    label=$(printf '%.61s...' "$label")
  fi
  printf '%s' "$label"
}

# BEGIN GENERATED LOGO FRAMES (node scripts/generate-install-logo.mjs)
# Wheel frames for raga_logo_animation. Each frame is 8 lines of braille with color variables
# H (hub), S (spokes), R (rim), K (handles), W (flash), Z (reset), and E (clear to end of line).
raga_logo_frame() {
  case "$1" in
    0) RAGA_LOGO_FRAME="    ${R}⠈⣿⡇      ⢸⣿⠁${Z}${E}\n     ${R}⠙⣿⣦⣀⣀⣀⣀⣴⣿⠋${Z}${E}\n       ${R}⠙⠛⠛⠟⠛⠋${Z}${E}\n${Z}${E}\n${Z}${E}\n${Z}${E}\n${Z}${E}\n${Z}${E}" ;;
    1) RAGA_LOGO_FRAME="     ${R}⣿⡇      ⢸⣿${Z}${E}\n    ${R}⠈⣿⡇      ⢸⣿⠁${Z}${E}\n     ${R}⠙⣿⣦⣀⣀⣀⣀⣴⣿⠋${Z}${E}\n       ${R}⠙⠛⠛⠟⠛⠋${Z}${E}\n${Z}${E}\n${Z}${E}\n${Z}${E}\n${Z}${E}" ;;
    2) RAGA_LOGO_FRAME="     ${R}⣠⣿⠟⠉⠉⠉⠉⠻⣿⣄${Z}${E}\n     ${R}⣿⡇      ⢸⣿${Z}${E}\n    ${R}⠈⣿⡇      ⢸⣿⠁${Z}${E}\n     ${R}⠙⣿⣦⣀⣀⣀⣀⣴⣿⠋${Z}${E}\n       ${R}⠙⠛⠛⠟⠛⠋${Z}${E}\n${Z}${E}\n${Z}${E}\n${Z}${E}" ;;
    3) RAGA_LOGO_FRAME="       ${R}⣠⣤⣤⣦⣤⣄${Z}${E}\n     ${R}⣠⣿⠟⠉⠉⠉⠉⠻⣿⣄${Z}${E}\n     ${R}⣿⡇      ⢸⣿${Z}${E}\n    ${R}⠈⣿⡇      ⢸⣿⠁${Z}${E}\n     ${R}⠙⣿⣦⣀⣀⣀⣀⣴⣿⠋${Z}${E}\n       ${R}⠙⠛⠛⠟⠛⠋${Z}${E}\n${Z}${E}\n${Z}${E}" ;;
    4) RAGA_LOGO_FRAME="${Z}${E}\n       ${R}⣠⣤⣤⣦⣤⣄${Z}${E}\n     ${R}⣠⣿⠟⠉⠉⠉⠉⠻⣿⣄${Z}${E}\n     ${R}⣿⡇      ⢸⣿${Z}${E}\n    ${R}⠈⣿⡇      ⢸⣿⠁${Z}${E}\n     ${R}⠙⣿⣦⣀⣀⣀⣀⣴⣿⠋${Z}${E}\n       ${R}⠙⠛⠛⠟⠛⠋${Z}${E}\n${Z}${E}" ;;
    5) RAGA_LOGO_FRAME="      ${S}⢈⠉${H}⡩⠛⡟⢍${S}⠉⡁${Z}${E}\n       ${R}⣨⣤⣤⣧⣤⣅${Z}${E}\n     ${R}⣠⣿⠟⠉⠉⠉⠉⠻⣿⣄${Z}${E}\n     ${R}⣿⡇      ⢸⣿${Z}${E}\n    ${R}⠈⣿⡇      ⢸⣿⠁${Z}${E}\n     ${R}⠙⣿⣦⣀⣀⣀⣀⣴⣿⠋${Z}${E}\n       ${R}⠙⠛⠛⠟⠛⠋${Z}${E}\n${Z}${E}" ;;
    6) RAGA_LOGO_FRAME="      ${S}⠈ ⠑${H}⣤⣧${S}⠊ ⠁${Z}${E}\n      ${S}⢈${R}⣩⣭${H}⣿${R}⣿⣭⣍${S}⡁${Z}${E}\n     ${R}⣠⣿⠟⠍⠉⠏⠩⠻⣿⣄${Z}${E}\n     ${R}⣿⡇      ⢸⣿${Z}${E}\n    ${R}⠈⣿⡇      ⢸⣿⠁${Z}${E}\n     ${R}⠙⣿⣦⣀⣀⣀⣀⣴⣿⠋${Z}${E}\n       ${R}⠙⠛⠛⠟⠛⠋${Z}${E}\n${Z}${E}" ;;
    7) RAGA_LOGO_FRAME="       ${S}⢀⠂ ⡆⠐⡀${Z}${E}\n      ${S}⠈${R}⣠⣵⣤⣧⣮⣄${S}⠁${Z}${E}\n     ${R}⣠⣿⠟⡩⠛${H}⡟${R}⢍⠻⣿⣄${Z}${E}\n     ${R}⣿⡇${S}⠈⠄ ⠇⠠⠁${R}⢸⣿${Z}${E}\n    ${R}⠈⣿⡇      ⢸⣿⠁${Z}${E}\n     ${R}⠙⣿⣦⣀⣀⣀⣀⣴⣿⠋${Z}${E}\n       ${R}⠙⠛⠛⠟⠛⠋${Z}${E}\n${Z}${E}" ;;
    8) RAGA_LOGO_FRAME="${Z}${E}\n       ${R}⣠⣦⣤⣦⣴⣄${Z}${E}\n     ${R}⣠⣿⠟⠙${H}⣭⣯${R}⠋⠻⣿⣄${Z}${E}\n     ${R}⣿⣏${S}⠉${H}⡩⠛⡟⢍${S}⠉${R}⣹⣿${Z}${E}\n    ${R}⠈⣿⡇${S}⠈⠄ ⠇⠠⠁${R}⢸⣿⠁${Z}${E}\n     ${R}⠙⣿⣦⣀⣀⣀⣀⣴⣿⠋${Z}${E}\n       ${R}⠙⠛⠛⠟⠛⠋${Z}${E}\n${Z}${E}" ;;
    9) RAGA_LOGO_FRAME="${Z}${E}\n       ${R}⣠⣤⣤⣦⣤⣄${Z}${E}\n     ${R}⣠⣿⢟⠋⠉${S}⡏${R}⠙⡻⣿⣄${Z}${E}\n     ${R}⣿⡏ ${S}⠑${H}⣤⣧${S}⠊ ${R}⢹⣿${Z}${E}\n    ${R}⠈⣿⣏${S}⠉${H}⡩⠛⡟⢍${S}⠉${R}⣹⣿⠁${Z}${E}\n     ${R}⠙⣿⣮⣄⣀${S}⣇${R}⣠⣵⣿⠋${Z}${E}\n       ${R}⠙⠛⠛⠟⠛⠋${Z}${E}\n${Z}${E}" ;;
    10) RAGA_LOGO_FRAME="         ${K}⣴⣦${Z}${E}\n    ${K}⢠⣶⠄${R}⣠⣤⣬⣧⣤⣄${K}⠠⣶⡄${Z}${E}\n     ${R}⣡⣿⢟⠋⠉${S}⡏${R}⠙⡻⣿⣌${Z}${E}\n  ${K}⢀⣤⡀${R}⣿⡏ ${S}⠑${H}⣤⣧${S}⠊ ${R}⢹⣿${K}⢀⣤⡀${Z}${E}\n  ${K}⠈⠛⠉${R}⣿⣏${S}⠉${H}⡩⠛⡟⢍${S}⠉${R}⣹⣿⠉${K}⠛⠁${Z}${E}\n     ${R}⡙⣿⣮⣄⣀${S}⣇${R}⣠⣵⣿⢋${Z}${E}\n    ${K}⠘⠿⠂${R}⠙⠛⢛⡟⠛⠋${K}⠐⠿⠃${Z}${E}\n         ${K}⠻⠟${Z}${E}" ;;
    11) RAGA_LOGO_FRAME="         ${W}⣴⣦${Z}${E}\n    ${W}⢠⣶⠄⣠⣤⣬⣧⣤⣄⠠⣶⡄${Z}${E}\n     ${W}⣡⣿⢟⠋⠉⡏⠙⡻⣿⣌${Z}${E}\n  ${W}⢀⣤⡀⣿⡏ ⠑⣤⣧⠊ ⢹⣿⢀⣤⡀${Z}${E}\n  ${W}⠈⠛⠉⣿⣏⠉⡩⠛⡟⢍⠉⣹⣿⠉⠛⠁${Z}${E}\n     ${W}⡙⣿⣮⣄⣀⣇⣠⣵⣿⢋${Z}${E}\n    ${W}⠘⠿⠂⠙⠛⢛⡟⠛⠋⠐⠿⠃${Z}${E}\n         ${W}⠻⠟${Z}${E}" ;;
    12) RAGA_LOGO_FRAME="         ${K}⢠⣶⡄${Z}${E}\n     ${K}⢾⢇${R}⣠⣤⣤⣽⣤⣄ ${K}⣠⣄${Z}${E}\n     ${R}⣠⣾⠟⡋⠉${S}⡿${R}⠙⠻⣷⣎${K}⠉${Z}${E}\n  ${K}⢠⣶⣄${R}⣿⣏${S}⡀⠑${H}⣤⣧${S}⠊⠁${R}⢹⣿ ${K}⣀${Z}${E}\n   ${K}⠉ ${R}⣿⣏${S}⢉${H}⡩⠛⡟⢍${S}⠙${R}⣻⣿${K}⠚⠿⠃${Z}${E}\n    ${K}⣀${R}⡹⢿⣦⣄${S}⣰⣇⣨${R}⣴⡿⠋${Z}${E}\n    ${K}⠙⠋ ${R}⠙⠛⣻⠛⠛⠋${K}⢱⡷${Z}${E}\n        ${K}⠘⠿⠃${Z}${E}" ;;
    13) RAGA_LOGO_FRAME="      ${K}⣀   ⣠⣶⡀${Z}${E}\n     ${K}⠘⠿${R}⣂⣴⣦⣬⣯⣀⡀ ${K}⣀${Z}${E}\n   ${K}⢀ ${R}⢰⣿⡟⠍⠉${S}⢹${R}⠛⠿⣿${K}⡜⠟⠃${Z}${E}\n  ${K}⠘⢿⠧${R}⣿⣏${S}⣀${H}⣈⣤⣾${S}⠐⠈${R}⢸⣿⠆${Z}${E}\n    ${R}⠰⣿⡇${S}⡀${H}⠌⢻⠟⡓${S}⠒${R}⣾⣿${K}⢴⣷⡄${Z}${E}\n   ${K}⢠⣴${R}⡜⣿⣶⣄${S}⣸${R}⣀⣐⣼⣿⠇ ${K}⠁${Z}${E}\n    ${K}⠉ ${R}⠈⠉⣛⡟⠻⠟⠩${K}⣶⡄${Z}${E}\n       ${K}⠈⠿⠋   ⠉${Z}${E}" ;;
    14) RAGA_LOGO_FRAME="      ${K}⢀⣠⡀  ⢀⣤⡀${Z}${E}\n      ${K}⠈⣫${R}⣥⣴⣦⣌${K}⣟⠁${Z}${E}\n   ${K}⣴⣦${R}⢠⣿⠿⠹${S}⡉${R}⠉⡟⢻⣿⣄${K}⢴⣆${Z}${E}\n   ${K}⠈⢉${R}⣿⡟${S}⠤${H}⣀⣥⣼${S}⠡⠔${R}⢺⣿${K}⡈⠁${Z}${E}\n   ${K}⢀${R}⡈⣿⡧${S}⠔${H}⠂⢻⢛⠲${S}⠤${R}⣼⡿⢁${K}⡀${Z}${E}\n   ${K}⠹⠗${R}⠙⣿⣧⣤${S}⣃⣈⣆${R}⣶⣿⠋${K}⠻⠟${Z}${E}\n      ${K}⢀⣭${R}⡟⠻⠟⢛⣫${K}⡀${Z}${E}\n      ${K}⠈⠛⠁  ⠈⠋⠁${Z}${E}" ;;
    15) RAGA_LOGO_FRAME="        ${K}⣤⡄   ⣀${Z}${E}\n    ${K}⣀⡀ ${R}⣠⣽⣦⣶⣤⣈${K}⡿⠇${Z}${E}\n   ${K}⠘⠟${R}⢧⣾⡟⠋⠋${S}⠉${R}⢙⠿⣷⣄${Z}${E}\n    ${R}⢠⣿⡏${S}⠓${H}⢤⣼⣤⣋ ${R}⢽⣿${K}⠞⠿${Z}${E}\n   ${K}⣶${R}⡴⣿⣗ ${H}⠉⡿⡟${S}⢤⡀${R}⣸⣿⠃${Z}${E}\n     ${R}⠙⢿⣶${S}⣞${R}⣀⣠⣠⣼⡿⢧${K}⣴⡄${Z}${E}\n     ${K}⢰⣶${R}⡋⠛⠿⠻⣟⠋ ${K}⠈⠉${Z}${E}\n      ${K}⠉   ⠘⠛${Z}${E}" ;;
    16) RAGA_LOGO_FRAME="        ${K}⢠⣴⡄${Z}${E}\n    ${K}⣤⣤ ${R}⣠⣬⣶⣴⣦⡀${K}⢺⣿${Z}${E}\n    ${K}⠙${R}⢹⣾⡿⠛${S}⢹${R}⠉⠙⣿⣿⣄${Z}${E}\n   ${K}⣀${R}⠰⣿⡏${S}⠙⠢${H}⣬⣤⢎${S}⣀${R}⣻⣿⡔${K}⣶⡀${Z}${E}\n  ${K}⠈⠿${R}⠜⣿⣯${S}⠉${H}⢁⠟⡻⢄ ${R}⣸⣿⠆${K}⠉${Z}${E}\n     ${R}⠙⢿⣷${S}⣏⣀⣇${R}⣤⣿⣿${K}⣁⣄${Z}${E}\n     ${K}⣿⡯${R}⠉⠻⠟⠿⡛⠋ ${K}⠛⠛${Z}${E}\n         ${K}⠘⠟⠃${Z}${E}" ;;
    17) RAGA_LOGO_FRAME="         ${K}⣴⡦${Z}${E}\n    ${K}⢰⣶ ${R}⣠⣤⣼⣦⣤⣄${K}⢰⣶⡆${Z}${E}\n    ${K}⠈${R}⣩⣾⡿⠋⠙⠈⠙⣿⣿⣅${Z}${E}\n  ${K}⢀⣄${R}⢀⣿⠏${S}⠈⠢${H}⣬⣤⢞${S}⠁${R}⣹⣿⣀${K}⣤⡀${Z}${E}\n  ${K}⠈⠛⠉${R}⣿⣏ ${H}⢁⠟⡻${S}⣄ ${R}⣰⣿⠁${K}⠙⠁${Z}${E}\n     ${R}⠙⢿⣷⣅⡀⣄${S}⣨${R}⣿⣿⣋${K}⡀${Z}${E}\n    ${K}⠸⠿⠇${R}⠙⠛⠻⡟⠛⠋${K}⠈⠿⠇${Z}${E}\n         ${K}⠺⠟${Z}${E}" ;;
    18) RAGA_LOGO_FRAME="         ${K}⣴⣦${Z}${E}\n    ${K}⢰⣶⡄${R}⣠⣤⣴⣮⣤⣄${K}⢠⣶⡆${Z}${E}\n     ${R}⣩⣾⡿⠋⠑⠋⠙⣿⣿⣍${Z}${E}\n  ${K}⢀⣤⢄${R}⣿⣏${S}⠈⠢${H}⣬⣤⢞${S}⠁${R}⡹⣿⡀${K}⣤⡀${Z}${E}\n  ${K}⠈⠛${R}⠈⣿⣎ ${H}⢁⠟⡻${S}⣄ ${R}⣹⣿⠑${K}⠛⠁${Z}${E}\n     ${R}⣙⢿⣷⣅⣠${S}⢄${R}⣨⣿⣿⣋${Z}${E}\n    ${K}⠸⠿⠃${R}⠙⠛⡻⠟⠛⠋${K}⠘⠿⠇${Z}${E}\n         ${K}⠻⠟${Z}${E}" ;;
  esac
}
RAGA_LOGO_FINAL_FRAME=10
RAGA_LOGO_SEQUENCE="0:0.06 1:0.06 2:0.06 3:0.06 4:0.06 5:0.06 6:0.06 7:0.06 8:0.06 9:0.06 9:0.05 9:0.05 9:0.05 9:0.05 9:0.05 9:0.05 9:0.05 9:0.05 10:0.25 11:0.08 10:0.08 11:0.08 10:0.12 10:0.05 10:0.05 12:0.05 13:0.05 14:0.05 15:0.05 16:0.05 17:0.05 18:0.05 10:0.45"
# END GENERATED LOGO FRAMES

raga_installer_main "$@"
