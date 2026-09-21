import sys, pathlib
T = pathlib.Path(sys.argv[1])
p = T / "components/PromptInput/useSwarmBanner.js"
s = p.read_text()

# hunk 1 — alias the editor-helpers stub AT ITS DEFINITION SITE.
# The stub is renamed every single release: $k (2.1.263) -> iv (2.1.265) ->
# Ey (2.1.278). That is exactly why the alias exists: hunk 2's added lines name
# only globalThis.__cvSubmitHelpers, so they cannot bind a stale identifier, and
# this hunk fails loudly if the declaration it keys on ever changes shape.
old1 = "var Ey = { setCursorOffset: () => {}, clearBuffer: () => {}, resetHistory: () => {} };\n"
new1 = old1 + "globalThis.__cvSubmitHelpers = Ey;\n"
assert s.count(old1) == 1, f"stub anchor count={s.count(old1)}"
s = s.replace(old1, new1)

# hunk 2 — bindHost. Private fields #e/#t are UNCHANGED from 2.1.263; only the
# parameter renamed (w -> h). #e is referenced on an added line and is carried
# in this hunk's own context (`this.#e = h;`), so a rename fails the apply.
old2 = """    bindHost(h) {
        this.#t = h;
    }
"""
new2 = """    bindHost(h) {
        this.#t = h;
        try {
            globalThis.__claudiverseSubmit = (__text) => {
                // 🔴 PRESERVE THE OPERATOR'S HALF-TYPED DRAFT. submit() wipes it
                // whenever the seat is IDLE, which is when someone is most
                // likely mid-sentence. Uses the draft store's OWN stash/popStash
                // — the mechanism Claude Code already uses to carry a draft
                // across a submit, restoring value, cursor offset and pasted
                // contents together.
                let __draft = this.#e?.draft,
                    __stashed = false;
                try {
                    if (
                        __draft &&
                        __draft.stashedPrompt === undefined &&
                        __draft.value?.trim()
                    ) {
                        (__draft.stash(), (__stashed = true));
                    }
                } catch (__e3) {}
                // Not awaited: every draft-clearing path runs in submit's
                // SYNCHRONOUS prefix, before its first await.
                let __result = this.submit(__text, globalThis.__cvSubmitHelpers);
                // Covers the paths that RETURN EARLY (an immediate local-jsx
                // slash command, which /model is), which never reach submit's
                // own pop.
                try {
                    if (__stashed && __draft.stashedPrompt !== undefined)
                        __draft.popStash('outside');
                } catch (__e4) {}
                return __result;
            };
            // 🔴 WRAP submit ITSELF. A prompt TYPED IN THE TERMINAL is never
            // mirrored otherwise — only the model's OUTPUT stream is. submit is
            // the one funnel both typed and remote input pass through.
            if (!this.__cvWrapped) {
                let __origSubmit = this.submit.bind(this);
                this.submit = (__text, ...__rest) => {
                    try {
                        globalThis.__claudiverseNoteUserPrompt?.(__text);
                    } catch (__e2) {}
                    return __origSubmit(__text, ...__rest);
                };
                this.__cvWrapped = true;
            }
        } catch (__e) {}
    }
"""
# ⛔ `bindHost(h) { this.#t = h; }` OCCURS THREE TIMES in this file — a plain
# replace would patch the wrong class, or all of them. Scope to the class the
# UNIQUE string anchor identifies (1 occurrence tree-wide), then take the first
# bindHost inside it, and assert that anchor really is in the region edited.
CLASS = "class PromptSubmitController {"
ANCHOR = "PromptSubmitController used before its host was bound"
assert s.count(CLASS) == 1, f"class anchor count={s.count(CLASS)}"
cls = s.index(CLASS)
at = s.index(old2, cls)
region = s[cls:at + len(old2) + 400]
assert ANCHOR in region, "the bindHost found is not the one guarded by the unique string"
s = s[:at] + new2 + s[at + len(old2):]
p.write_text(s)
print("003 ported")
