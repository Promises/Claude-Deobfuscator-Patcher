#!/bin/bash
set -euo pipefail
export PYTHONDONTWRITEBYTECODE=1

# ── Constants & Paths ─────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TOOLS_PY="$SCRIPT_DIR/tools"
TOOLS_TS="$SCRIPT_DIR/tools-ts"
SOURCE_REF="$SCRIPT_DIR/../claude-code"
STATE_FILE="$SCRIPT_DIR/.build-state.json"
VERSIONS_DIR="$HOME/.local/share/claude/versions"
RENAME_DB="$TOOLS_TS/rename-db.json"
DEOB_DIR="$SCRIPT_DIR/deobfuscated"
PATCHES_DIR="$SCRIPT_DIR/patches.d"
FORCE=0

STEPS=(extract deob modrecon rename prettify patch reassemble compile)

# ── Color & Formatting ───────────────────────────────────────────────────────
if [[ -t 1 ]]; then
  C_RESET='\033[0m'; C_BOLD='\033[1m'; C_DIM='\033[2m'
  C_GREEN='\033[32m'; C_RED='\033[31m'; C_YELLOW='\033[33m'
  C_CYAN='\033[36m'; C_MAGENTA='\033[35m'
else
  C_RESET=''; C_BOLD=''; C_DIM=''; C_GREEN=''; C_RED=''; C_YELLOW=''; C_CYAN=''; C_MAGENTA=''
fi

info()  { printf "${C_CYAN}>>>${C_RESET} %s\n" "$*"; }
ok()    { printf "${C_GREEN} ✓${C_RESET} %s\n" "$*"; }
warn()  { printf "${C_YELLOW} !${C_RESET} %s\n" "$*"; }
err()   { printf "${C_RED} ✗${C_RESET} %s\n" "$*" >&2; exit 1; }
header() { printf "\n${C_BOLD}=== %s ===${C_RESET}\n" "$*"; }

# ── Version Detection ─────────────────────────────────────────────────────────
detect_binary() {
  local bin
  bin=$(ls -v "$VERSIONS_DIR" 2>/dev/null | tail -1)
  [[ -z "$bin" ]] && err "No Claude versions found in $VERSIONS_DIR"
  echo "$VERSIONS_DIR/$bin"
}

detect_version() {
  basename "$(detect_binary)"
}

# ── State Management (.build-state.json) ──────────────────────────────────────
state_init() {
  local version="$1" binary="$2"
  python3 -c "
import json, datetime
json.dump({
  'version': '$version',
  'binary_path': '$binary',
  'started_at': datetime.datetime.utcnow().isoformat()+'Z',
  'steps': {s: {'done': False} for s in '$( IFS=,; echo "${STEPS[*]}" )'.split(',')}
}, open('$STATE_FILE','w'), indent=2)
"
}

state_read() {
  # Usage: state_read "steps.extract.done" → "true" / "false" / ""
  [[ ! -f "$STATE_FILE" ]] && echo "" && return
  python3 -c "
import json
s=json.load(open('$STATE_FILE'))
keys='$1'.split('.')
v=s
for k in keys:
  if isinstance(v,dict) and k in v: v=v[k]
  else: v=None; break
print('' if v is None else str(v).lower())
" 2>/dev/null || echo ""
}

state_mark_done() {
  local step="$1" duration="${2:-0}"
  python3 -c "
import json, datetime
f='$STATE_FILE'
s=json.load(open(f))
s['steps']['$step']={'done':True,'at':datetime.datetime.utcnow().isoformat()+'Z','duration_s':$duration}
json.dump(s,open(f,'w'),indent=2)
"
}

state_reset_step() {
  [[ ! -f "$STATE_FILE" ]] && return
  python3 -c "
import json
f='$STATE_FILE'
s=json.load(open(f))
if '$1' in s.get('steps',{}): s['steps']['$1']={'done':False}
json.dump(s,open(f,'w'),indent=2)
"
}

state_get_version() {
  state_read "version"
}

# Invalidate this step and all downstream steps
invalidate_from() {
  local found=0
  for s in "${STEPS[@]}"; do
    [[ "$s" == "$1" ]] && found=1
    [[ $found -eq 1 ]] && state_reset_step "$s"
  done
}

# Check if step is done
is_done() {
  [[ "$(state_read "steps.$1.done")" == "true" ]]
}

# Check prerequisite step
require_step() {
  is_done "$1" || err "Step '$1' must be completed first. Run: $0 $1"
}

# ── Step Functions ────────────────────────────────────────────────────────────

run_step() {
  local step="$1"
  # Skip if already done (unless --force)
  if [[ $FORCE -eq 0 ]] && is_done "$step"; then
    ok "Step '$step' already done (use --force to re-run)"
    return 0
  fi
  # If forcing, invalidate downstream
  if [[ $FORCE -eq 1 ]] || is_done "$step"; then
    invalidate_from "$step"
  fi
  local start_ts
  start_ts=$(date +%s)
  "step_$step"
  local end_ts
  end_ts=$(date +%s)
  state_mark_done "$step" "$((end_ts - start_ts))"
  ok "Step '$step' completed in $((end_ts - start_ts))s"
}

step_extract() {
  header "Step 1: Extract JS source"
  local binary version
  binary="$(detect_binary)"
  version="$(detect_version)"

  # Init or check state
  local state_ver
  state_ver="$(state_get_version)"
  if [[ -z "$state_ver" || ! -f "$STATE_FILE" ]]; then
    state_init "$version" "$binary"
  elif [[ "$state_ver" != "$version" ]]; then
    warn "State is for v$state_ver but binary is v$version. Resetting."
    state_init "$version" "$binary"
  fi

  info "Source: $binary (v$version)"
  python3 << PYEOF
data = open('$binary', 'rb').read()
start_marker = b'(function(exports, require, module, __filename, __dirname) {// Claude Code'
start = data.find(start_marker)
if start == -1: raise SystemExit('Could not find JS source start')
end_marker = b'cli_after_main_complete'
end = data.find(end_marker, start)
if end == -1: raise SystemExit('Could not find JS source end marker')
close = data.find(b'})\\n', end)
if close == -1: close = data.find(b'})\\x00', end)
if close == -1: raise SystemExit('Could not find closing })')
close += 2
source = data[start:close].decode('utf-8', errors='replace')
source += '({}, require, module, __filename, __dirname)'
open('$SCRIPT_DIR/source.js', 'w').write(source)
print(f'  Extracted {len(source):,} bytes')
PYEOF
}

step_deob() {
  require_step "extract"
  header "Step 2: Deobfuscate (Python split + TS AST match)"
  rm -rf "$SCRIPT_DIR/.deob_cache" "$DEOB_DIR"
  cd "$TOOLS_TS"
  local sigs_flag=""
  if [ "${REGEN_SIGS:-0}" = "1" ]; then
    info "Regenerating signatures from $SOURCE_REF"
    sigs_flag="--regen-sigs $SOURCE_REF"
  fi
  bun run src/deob.ts "$SCRIPT_DIR/source.js" "$DEOB_DIR" $sigs_flag
  cd "$SCRIPT_DIR"
}

step_modrecon() {
  require_step "deob"
  header "Step 2.5: Module reconstruction"
  cd "$TOOLS_TS"
  bun run src/module-reconstruct.ts "$DEOB_DIR"
  cd "$SCRIPT_DIR"
}

step_rename() {
  require_step "modrecon"
  header "Step 2.6: Rename identifiers"
  cd "$TOOLS_TS"
  if [ "${LEGACY_RENAME:-0}" = "1" ]; then
    info "Legacy renamer enabled (LEGACY_RENAME=1)"
    if [ -f "$RENAME_DB" ]; then
      bun run src/renamer.ts "$DEOB_DIR" "$SOURCE_REF" "$DEOB_DIR/_mapping.json" "$RENAME_DB"
    else
      bun run src/renamer.ts "$DEOB_DIR" "$SOURCE_REF" "$DEOB_DIR/_mapping.json"
    fi
  else
    info "Skipping legacy renamer (set LEGACY_RENAME=1 to enable)"
    # Global anchor renames still need to run (legacy renamer includes them)
    bun run src/apply-global-renames.ts "$DEOB_DIR" "$TOOLS_TS/anchor-rules.json"
  fi
  cd "$SCRIPT_DIR"
}

step_prettify() {
  require_step "rename"
  header "Step 2.7: Prettify"
  cd "$TOOLS_TS"
  bun run src/prettify.ts "$DEOB_DIR"

  # Apply scoped param/local renames from anchor rules (post-prettify)
  bun run src/apply-scoped-renames.ts "$DEOB_DIR" "$TOOLS_TS/anchor-rules.json"

  cd "$SCRIPT_DIR"

  # Create git baseline AFTER prettify so patches target formatted code
  cd "$DEOB_DIR"
  rm -rf .git
  git init -q
  git add -A
  git commit -q -m "baseline: after rename+prettify (v$(detect_version))"
  git tag -f baseline
  cd "$SCRIPT_DIR"
  ok "Git baseline tagged in deobfuscated/"
}

step_patch() {
  require_step "prettify"
  header "Step 3: Apply patches"
  if [[ ! -d "$PATCHES_DIR" ]]; then
    warn "No patches.d/ directory — skipping"
    return 0
  fi

  cd "$DEOB_DIR"
  # Reset to baseline before applying
  git checkout -q -- .
  git clean -qfd

  local count=0
  for patch in "$PATCHES_DIR"/*.patch; do
    [[ -f "$patch" ]] || continue
    local name
    name="$(basename "$patch")"
    info "Applying $name..."

    if git apply "$patch" 2>&1; then
      :
    else
      warn "Exact match failed, trying with fuzz..."
      git apply -C0 "$patch" 2>&1 || warn "FAILED: $name"
    fi

    # Commit and tag
    local num
    num=$(echo "$name" | grep -oE '^[0-9]+' || echo "$count")
    git add -A
    git commit -q -m "patch: $name" --allow-empty
    git tag -f "after-${num}"
    count=$((count + 1))
  done
  cd "$SCRIPT_DIR"
  ok "Applied $count patches"
}

step_reassemble() {
  require_step "patch"
  header "Step 4: Reassemble"
  cd "$TOOLS_TS"
  bun run src/reassembler.ts "$DEOB_DIR" "$SCRIPT_DIR/cli-runnable.js"
  cd "$SCRIPT_DIR"
}

step_compile() {
  require_step "reassemble"
  header "Step 5: Compile"
  BUN_CONFIG_FILE="" bun build "$SCRIPT_DIR/cli-runnable.js" --compile --outfile "$SCRIPT_DIR/claude" 2>&1
  info "Binary: $SCRIPT_DIR/claude"
  info "Version: $("$SCRIPT_DIR/claude" --version 2>&1 || echo 'unknown')"
}

# ── Patch Generation ──────────────────────────────────────────────────────────

cmd_genpatch() {
  local name="${1:-}"
  local after=""
  shift || true

  # Parse --after flag
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --after) after="$2"; shift 2 ;;
      --after=*) after="${1#--after=}"; shift ;;
      *) err "Unknown flag: $1" ;;
    esac
  done

  [[ -z "$name" ]] && err "Usage: $0 genpatch <name> [--after NNN]"
  [[ ! -d "$DEOB_DIR/.git" ]] && err "No git repo in deobfuscated/. Run 'rename' step first."

  cd "$DEOB_DIR"

  # Check for changes
  if git diff --quiet && git diff --cached --quiet; then
    err "No changes in working tree to generate patch from"
  fi

  # Determine the next patch number
  local max_num=0
  for f in "$PATCHES_DIR"/*.patch; do
    [[ -f "$f" ]] || continue
    local n
    n=$(basename "$f" | grep -oE '^[0-9]+' || echo "0")
    [[ $n -gt $max_num ]] && max_num=$n
  done
  local next_num
  next_num=$(printf "%03d" $((max_num + 1)))

  local patch_file="$PATCHES_DIR/${next_num}-${name}.patch"
  local base_ref="baseline"
  local depends="none"

  if [[ -n "$after" ]]; then
    base_ref="after-${after}"
    depends="$after"
    if ! git rev-parse "$base_ref" >/dev/null 2>&1; then
      err "Tag '$base_ref' not found. Available tags: $(git tag | tr '\n' ' ')"
    fi
  fi

  # Generate the patch
  {
    echo "# patch: ${next_num}-${name}"
    echo "# depends: $depends"
    echo "# generated: $(date +%Y-%m-%d)"
    echo ""
    git diff "$base_ref"
  } > "$patch_file"

  cd "$SCRIPT_DIR"
  ok "Generated: $patch_file"
  info "Base: $base_ref | Depends: $depends"
  info "$(wc -l < "$patch_file") lines, $(grep -c '^@@' "$patch_file" || echo 0) hunks"
}

# ── Display Commands ──────────────────────────────────────────────────────────

cmd_status() {
  local ver
  ver="$(state_get_version)"
  [[ -z "$ver" ]] && ver="(not started)"

  printf "\n${C_BOLD}  Claude Code Deobfuscation Pipeline${C_RESET}  ${C_CYAN}v%s${C_RESET}\n" "$ver"
  printf "  ════════════════════════════════════════════\n"
  printf "  ${C_DIM}%-18s  %-10s  %s${C_RESET}\n" "Step" "Status" "Duration"
  printf "  ${C_DIM}%-18s  %-10s  %s${C_RESET}\n" "──────────────────" "──────────" "────────"

  local i=1
  for step in "${STEPS[@]}"; do
    local done dur icon label
    done="$(state_read "steps.$step.done")"
    dur="$(state_read "steps.$step.duration_s")"
    if [[ "$done" == "true" ]]; then
      icon="${C_GREEN}✓${C_RESET}"
      label="done"
      [[ -n "$dur" && "$dur" != "none" ]] && dur="${dur}s" || dur="-"
    else
      icon="${C_DIM}·${C_RESET}"
      label="${C_DIM}pending${C_RESET}"
      dur="-"
    fi
    printf "  %s. %-16s  %b %-8b  %s\n" "$i" "$step" "$icon" "$label" "$dur"
    i=$((i + 1))
  done

  # Summary stats
  echo ""
  if [[ -f "$DEOB_DIR/_mapping.json" ]]; then
    local sections matched
    sections=$(python3 -c "import json; m=json.load(open('$DEOB_DIR/_mapping.json')); print(m['section_count'])" 2>/dev/null || echo "?")
    matched=$(python3 -c "import json; m=json.load(open('$DEOB_DIR/_mapping.json')); print(m['matched_count'])" 2>/dev/null || echo "?")
    printf "  ${C_DIM}Modules: %s sections, %s matched${C_RESET}\n" "$sections" "$matched"
  fi
  if [[ -f "$RENAME_DB" ]]; then
    local renames suppressed
    renames=$(python3 -c "
import json; db=json.load(open('$RENAME_DB'))
print(sum(len(f.get('renames',{})) for f in db['files'].values()))
" 2>/dev/null || echo "?")
    suppressed=$(python3 -c "
import json; db=json.load(open('$RENAME_DB'))
print(sum(len(f.get('suppressed',{})) for f in db['files'].values()))
" 2>/dev/null || echo "?")
    printf "  ${C_DIM}Renames: %s entries, %s suppressed${C_RESET}\n" "$renames" "$suppressed"
  fi
  local patch_count=0 module_count=0
  for f in "$PATCHES_DIR"/*.patch; do [[ -f "$f" ]] && patch_count=$((patch_count+1)); done
  for f in "$PATCHES_DIR"/modules/*.js; do [[ -f "$f" ]] && module_count=$((module_count+1)); done
  printf "  ${C_DIM}Patches: %s patches, %s custom modules${C_RESET}\n\n" "$patch_count" "$module_count"
}

cmd_refactors() {
  printf "\n${C_BOLD}  Refactors & Patches${C_RESET}\n"
  printf "  ═══════════════════\n\n"

  # Rename DB
  if [[ -f "$RENAME_DB" ]]; then
    printf "  ${C_BOLD}Rename Database${C_RESET}: %s\n" "$RENAME_DB"
    printf "  ──────────────────────────\n"
    python3 -c "
import json
db = json.load(open('$RENAME_DB'))
files = db['files']
total_renames = sum(len(f.get('renames', {})) for f in files.values())
manual = sum(1 for f in files.values() for r in f.get('renames', {}).values() if r.get('source') == 'manual')
suppressed = sum(len(f.get('suppressed', {})) for f in files.values())
by_kind = {}
for f in files.values():
    for r in f.get('renames', {}).values():
        k = r.get('kind', '?')
        by_kind[k] = by_kind.get(k, 0) + 1
print(f'  Files:      {len(files)}')
print(f'  Renames:    {total_renames} ({manual} manual)')
print(f'  Suppressed: {suppressed}')
print(f'  By kind:')
for k, c in sorted(by_kind.items(), key=lambda x: -x[1]):
    print(f'    {k}: {c}')

# Top suppression files
sup_files = [(p, len(f.get('suppressed', {}))) for p, f in files.items() if f.get('suppressed')]
sup_files.sort(key=lambda x: -x[1])
if sup_files:
    print(f'  Top suppressed:')
    for p, c in sup_files[:5]:
        print(f'    {p}: {c}')
" 2>/dev/null || warn "Could not read rename-db.json"
  else
    printf "  ${C_DIM}No rename-db.json found${C_RESET}\n"
  fi

  # Patches
  echo ""
  printf "  ${C_BOLD}Patches${C_RESET}: %s\n" "$PATCHES_DIR"
  printf "  ──────────────────────────\n"
  if [[ -d "$PATCHES_DIR" ]]; then
    for patch in "$PATCHES_DIR"/*.patch; do
      [[ -f "$patch" ]] || continue
      local name depends hunks
      name="$(basename "$patch")"
      depends=$(grep -m1 '^# depends:' "$patch" 2>/dev/null | sed 's/^# depends: *//' || echo "?")
      hunks=$(grep -c '^@@' "$patch" 2>/dev/null || echo "0")
      local files_changed
      files_changed=$(grep -c '^diff --git' "$patch" 2>/dev/null || echo "0")
      printf "  %-40s  %s files, %s hunks" "$name" "$files_changed" "$hunks"
      [[ "$depends" != "none" && "$depends" != "?" && -n "$depends" ]] && printf "  ${C_YELLOW}(depends: %s)${C_RESET}" "$depends"
      echo ""
    done
  fi

  # Custom modules
  if [[ -d "$PATCHES_DIR/modules" ]]; then
    echo ""
    printf "  ${C_BOLD}Custom Modules${C_RESET}: %s/modules/\n" "$PATCHES_DIR"
    printf "  ──────────────────────────\n"
    for mod in "$PATCHES_DIR"/modules/*.js; do
      [[ -f "$mod" ]] || continue
      printf "  %s\n" "$(basename "$mod")"
    done
  fi
  echo ""
}

cmd_versions() {
  printf "\n${C_BOLD}  Installed Claude Versions${C_RESET}\n"
  printf "  ═════════════════════════\n"
  local current
  current="$(state_get_version)"
  for v in $(ls -v "$VERSIONS_DIR" 2>/dev/null); do
    if [[ "$v" == "$current" ]]; then
      printf "  ${C_GREEN}* %s${C_RESET} (active)\n" "$v"
    else
      printf "  ${C_DIM}  %s${C_RESET}\n" "$v"
    fi
  done
  echo ""
}

cmd_build() {
  for step in "${STEPS[@]}"; do
    run_step "$step"
  done
  echo ""
  ok "Build complete!"
}

cmd_reset() {
  local target="${1:-all}"
  if [[ "$target" == "all" ]]; then
    [[ -f "$STATE_FILE" ]] && rm "$STATE_FILE"
    ok "State reset"
  else
    invalidate_from "$target"
    ok "Reset '$target' and all downstream steps"
  fi
}

cmd_clean() {
  rm -rf "$SCRIPT_DIR/source.js" "$SCRIPT_DIR/.deob_cache" "$DEOB_DIR" \
         "$SCRIPT_DIR/cli-runnable.js" "$STATE_FILE"
  ok "Cleaned all artifacts"
}

cmd_help() {
  cat << 'EOF'

  Usage: entrypoint.sh [command|step...] [--force]

  Pipeline steps (can pass multiple to run in sequence):
    build         Run all steps (skip completed)
    extract       Step 1: Extract JS from binary
    deob          Step 2: Split + match modules
    modrecon      Step 2.5: Add import/export
    rename        Step 2.6: Scope-aware renaming
    prettify      Step 2.7: Format source
    patch         Step 3: Apply patches
    reassemble    Step 4: Concatenate to single JS
    compile       Step 5: Compile binary

  Patch tools:
    genpatch <name> [--after NNN]   Generate patch from working tree

  Info:
    status        Show pipeline status
    refactors     Show rename-db & patch details
    versions      List installed Claude versions

  Management:
    reset [step]  Reset step (+ downstream) or all
    clean         Remove all artifacts
    help          This message

  Flags:
    --force       Re-run even if step is done

  No arguments: interactive TUI menu

EOF
}

# ── TUI Menu ──────────────────────────────────────────────────────────────────

cmd_tui() {
  while true; do
    clear
    cmd_status

    PS3=$'\n  Select: '
    local options=(
      "Build all"
      "Build all (clean)"
      "─── Steps ───"
      "extract"
      "deob"
      "modrecon"
      "rename"
      "patch"
      "reassemble"
      "compile"
      "─── Tools ───"
      "Generate patch"
      "Show refactors"
      "Show versions"
      "Reset state"
      "Clean all"
      "Quit"
    )

    select opt in "${options[@]}"; do
      case "$opt" in
        "Build all")        cmd_build ;;
        "Build all (clean)") FORCE=1; cmd_clean; cmd_build; FORCE=0 ;;
        "extract"|"deob"|"modrecon"|"rename"|"patch"|"reassemble"|"compile")
                            run_step "$opt" ;;
        "Generate patch")
          echo ""
          read -rp "  Patch name: " pname
          read -rp "  Depends on (patch number, or empty for none): " pdep
          if [[ -n "$pdep" ]]; then
            cmd_genpatch "$pname" --after "$pdep"
          else
            cmd_genpatch "$pname"
          fi
          ;;
        "Show refactors")   cmd_refactors ;;
        "Show versions")    cmd_versions ;;
        "Reset state")      cmd_reset; ;;
        "Clean all")        cmd_clean ;;
        "Quit")             exit 0 ;;
        "─── Steps ───"|"─── Tools ───") continue ;;
        *)                  warn "Invalid selection" ;;
      esac
      echo ""
      read -rp "  Press Enter to continue..." _
      break
    done
  done
}

# ── CLI Dispatch ──────────────────────────────────────────────────────────────

is_pipeline_step() {
  case "$1" in
    extract|deob|modrecon|rename|prettify|patch|reassemble|compile) return 0 ;;
    *) return 1 ;;
  esac
}

main() {
  local cmd="${1:-}"
  shift || true

  # Parse global flags from remaining args
  local args=()
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --force) FORCE=1; shift ;;
      --help|-h) cmd_help; exit 0 ;;
      *) args+=("$1"); shift ;;
    esac
  done

  # Multi-step: ./entrypoint.sh extract deob modrecon rename prettify
  if [[ -n "$cmd" ]] && is_pipeline_step "$cmd" && [[ ${#args[@]} -gt 0 ]]; then
    local steps=("$cmd" "${args[@]}")
    for s in "${steps[@]}"; do
      is_pipeline_step "$s" || err "Not a pipeline step: $s"
      run_step "$s"
    done
    return
  fi

  case "$cmd" in
    "")           cmd_tui ;;
    build)        cmd_build ;;
    extract|deob|modrecon|rename|prettify|patch|reassemble|compile)
                  run_step "$cmd" ;;
    genpatch)     cmd_genpatch "${args[@]}" ;;
    status)       cmd_status ;;
    refactors)    cmd_refactors ;;
    versions)     cmd_versions ;;
    reset)        cmd_reset "${args[0]:-all}" ;;
    clean)        cmd_clean ;;
    help|--help|-h) cmd_help ;;
    *)            err "Unknown command: $cmd. Run $0 help" ;;
  esac
}

main "$@"
