import sys, pathlib
T = pathlib.Path(sys.argv[1])
p = T / "entrypoints/sdk/coreSchemas.js"
s = p.read_text()
# The trust gate. Keyed on `trustAccepted`, an original-source property name:
# MEASURED exactly one occurrence tree-wide on 2.1.278. The enclosing function
# and the config getter are both minified and both renamed since 2.1.263
# (Bo->qo, Q->te), which is why the old hunk's context failed — but the injected
# lines name neither, only process.env.
old = "    if (e.trustAccepted) return !0;\n"
new = ("    try {\n"
       "        if (process.env.CLAUDIVERSE_SKIP_TRUST) return !0;\n"
       "    } catch (__e) {}\n") + old
assert s.count(old) == 1, f"trust anchor count={s.count(old)}"
p.write_text(s.replace(old, new))
print("011 ported")
