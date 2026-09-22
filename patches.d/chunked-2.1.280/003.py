import re, sys, pathlib
T = pathlib.Path(sys.argv[1])
STUB = "{ setCursorOffset: () => {}, clearBuffer: () => {}, resetHistory: () => {} };"

# hunk 1 — alias the editor-helpers stub AT ITS DEFINITION SITE. Its name is
# renamed EVERY release ($k .263, iv .265, Ey .278) and on 2.1.280 the whole
# declaration moved out of useSwarmBanner.js, so both the file and the name are
# discovered rather than assumed. The alias is the whole point: hunk 2 injects
# only globalThis.__cvSubmitHelpers and so can never bind a stale identifier.
hits = [f for f in T.rglob("*.js") if ".git" not in f.parts and STUB in f.read_text()]
assert len(hits) == 1, f"stub declaration found in {len(hits)} files"
sp = hits[0]
s = sp.read_text()
m = re.search(r"\nvar (\w+) = \{ setCursorOffset: \(\) => \{\}, clearBuffer: \(\) => \{\}, resetHistory: \(\) => \{\} \};\n", s)
assert m, "stub declaration shape changed"
name, old = m.group(1), m.group(0)
assert s.count(old) == 1
sp.write_text(s.replace(old, old + f"globalThis.__cvSubmitHelpers = {name};\n"))

# hunk 2 — bindHost, scoped to the class the UNIQUE error string identifies.
# `bindHost(x) { this.#t = x; }` occurs three times in this file.
p = T / "components/PromptInput/useSwarmBanner.js"
s = p.read_text()
CLASS = "class PromptSubmitController {"
ANCHOR = "PromptSubmitController used before its host was bound"
assert s.count(CLASS) == 1, f"class anchor count={s.count(CLASS)}"
cls = s.index(CLASS)
m = re.search(r"\n    bindHost\((\w+)\) \{\n        this\.#(\w+) = \1;\n    \}\n", s[cls:])
assert m, "bindHost shape changed"
arg, host = m.group(1), m.group(2)
at = cls + m.start()
assert ANCHOR in s[cls:at + len(m.group(0)) + 600], "bindHost found is not the guarded one"
new = f"""
    bindHost({arg}) {{
        this.#{host} = {arg};
        try {{
            globalThis.__claudiverseSubmit = (__text) => {{
                // 🔴 PRESERVE THE OPERATOR'S HALF-TYPED DRAFT. submit() wipes it
                // whenever the seat is IDLE — exactly when someone is mid
                // sentence. Uses the draft store's OWN stash/popStash, the
                // mechanism Claude Code already uses to carry a draft across a
                // submit (value, cursor offset and pasted contents together).
                let __draft = this.#__DEPSFIELD__?.draft,
                    __stashed = false;
                try {{
                    if (__draft && __draft.stashedPrompt === undefined && __draft.value?.trim()) {{
                        (__draft.stash(), (__stashed = true));
                    }}
                }} catch (__e3) {{}}
                // Not awaited: every draft-clearing path runs in submit's
                // SYNCHRONOUS prefix, before its first await.
                let __result = this.submit(__text, globalThis.__cvSubmitHelpers);
                // Covers paths that RETURN EARLY (an immediate local-jsx slash
                // command, which /model is) and never reach submit's own pop.
                try {{
                    if (__stashed && __draft.stashedPrompt !== undefined)
                        __draft.popStash('outside');
                }} catch (__e4) {{}}
                return __result;
            }};
            // 🔴 WRAP submit ITSELF — a prompt TYPED in the terminal is never
            // mirrored otherwise; only the model's OUTPUT stream is.
            if (!this.__cvWrapped) {{
                let __origSubmit = this.submit.bind(this);
                this.submit = (__text, ...__rest) => {{
                    try {{
                        globalThis.__claudiverseNoteUserPrompt?.(__text);
                    }} catch (__e2) {{}}
                    return __origSubmit(__text, ...__rest);
                }};
                this.__cvWrapped = true;
            }}
        }} catch (__e) {{}}
    }}
"""
# the deps private field is the one assigned in the constructor
dm = re.search(r"\n    constructor\((\w+)\) \{\n        this\.#(\w+) = \1;\n    \}\n", s[cls:])
assert dm, "constructor shape changed"
new = new.replace("__DEPSFIELD__", dm.group(2))
p.write_text(s[:at] + new + s[at + len(m.group(0)):])
print(f"003 ported (stub {name} in {sp.relative_to(T)}, bindHost arg={arg}, host=#{host}, deps=#{dm.group(2)})")
