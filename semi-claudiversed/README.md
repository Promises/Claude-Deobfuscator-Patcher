# semi-claudiversed

A second build of the claudiverse Claude Code binary, for retiring binary
patches one at a time. Each feature is either still a **patch** or has been
**replaced** by something that needs no patch (the API proxy, an MCP channel,
a Claude Code hook). Production (`../claude`, `../claude-rel`, and the runtime
in `../patches.d/modules`) is never touched by anything here.

| File | What it is |
| --- | --- |
| `features.json` | Per feature: `patch`, `replaced` or `off`, and what replaces it. |
| `build.sh [version]` | Builds `claude-semi` from `../versionref/<v>-bin` with only the hooks still in state `patch`. |
| `launch.sh <title>` | Starts a test seat on `claude-semi` in tmux, routed through the proxy. |
| `overlay/` | How this runtime differs from production: `*.patch` (unified diffs, applied in name order; a hunk that no longer applies fails the build) or whole files. |
| `patches.d/modules/` | Generated: this variant's own runtime. Not edited by hand. |
| `BUILD.txt` | Generated: stock version, hooks, overlay and sha of the current build. |

Version readouts say `[semi-claudiversed]`, so a semi seat is never mistaken
for a production one.

## Retiring a patch

1. Build its replacement and check it on a seat that still has the patch
   (both systems then record the same traffic).
2. Set the feature to `replaced` in `features.json`; if the runtime must
   change too, put the changed file in `overlay/`.
3. `./build.sh`, then `./launch.sh <title>` and test the feature with only the
   replacement in place.
4. Commit `features.json` (and `overlay/`) with what was tested.

One feature per step: if something breaks, the last flip is the cause.

## Coupled hooks

- `001-session` also publishes upstream's OAuth refresh registrar, which
  012's 401-renewal leg needs.
- `003-inject` and `008-010-idle` hook the same module; each can still be
  dropped on its own.

## Pooled seats (012 replaced)

With `012-failover` replaced, `launch.sh` starts the seat with
`CLAUDE_CODE_OAUTH_TOKEN=cv-pool`. The seat holds no Anthropic credential:
the API proxy swaps the placeholder for the pool's current token on every
request and handles 429/401 failover itself (server `11b85b5`).
`overlay/pooled-seat-no-local-credentials.patch` stops the sidecar handing
such a seat a real token through its lease, the switch-back push, or the
401 refresh callback. A pooled seat only works through the proxy.

## Clean seats (011 replaced)

With `011-trust` replaced (which requires 012 replaced: a clean config has no
login), `launch.sh` gives each seat its own `CLAUDE_CONFIG_DIR` under
`~/claudiverse-semi/.config/<title>` — none of the operator's MCP servers,
hooks, plugins or global CLAUDE.md — and pre-writes only onboarding-done and
the work dir's trust. That entry is what replaces patch 011; without it the
trust dialog appears (the control run). Work dirs default to
`/Users/Shared/claudiverse-semi/<title>`: Claude Code reads `.claude/CLAUDE.md`
in every ancestor of the work dir, so a seat under `$HOME` still inherits
`~/.claude/CLAUDE.md`. `DISABLE_AUTOUPDATER=1` is always set — the binary is
pinned, and the updater otherwise takes it for the user's install.
