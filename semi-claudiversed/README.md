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
| `overlay/` | Runtime files that differ from production. Copied over `patches.d/modules/` at build. |
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
