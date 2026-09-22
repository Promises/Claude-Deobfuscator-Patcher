import re, sys, pathlib
T = pathlib.Path(sys.argv[1])
# The trust gate. `trustAccepted` is an original-source property; the local it
# hangs off is minified and the FILE moved (coreSchemas .278 -> config .280,
# now pinned). Discover both rather than hardcode — hardcoding "e.trustAccepted"
# is precisely what broke this script between .278 and .280.
hits = [f for f in T.rglob("*.js")
        if ".git" not in f.parts and re.search(r"\n    if \(\w+\.trustAccepted\) return !0;\n", f.read_text())]
assert len(hits) == 1, f"trust gate found in {len(hits)} files"
p = hits[0]
s = p.read_text()
m = re.search(r"\n    if \(\w+\.trustAccepted\) return !0;\n", s)
old = m.group(0)
assert s.count(old) == 1, f"gate count={s.count(old)}"
new = ("\n    try {\n"
       "        if (process.env.CLAUDIVERSE_SKIP_TRUST) return !0;\n"
       "    } catch (__e) {}" + old)
p.write_text(s.replace(old, new))
print(f"011 ported ({p.relative_to(T)})")
