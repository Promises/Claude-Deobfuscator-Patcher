import re, sys, pathlib
T = pathlib.Path(sys.argv[1])
p = T / "services/compact/precomputedCompact.js"
s = p.read_text()

# ⛔ `...[],` OCCURS TWICE in this file. Scope to the command registry — the
# function whose result is filtered by command .name — rather than replacing
# blind. The enclosing function is minified (Wds on 2.1.263, GP on 2.1.278), so
# it is located by that consumer shape, not by name.
CONSUMER = "().filter((w) => !r.has(w.name))"
assert s.count(CONSUMER) == 1, f"registry consumer count={s.count(CONSUMER)}"
# The registry's name is in the consumer text itself; the nearest preceding
# "function " belongs to whatever scope the CALL sits in, not the callee.
m = re.search(r"([A-Za-z_$][A-Za-z0-9_$]*)\(\)\.filter\(\(w\) => !r\.has\(w\.name\)\)", s)
assert m, "registry consumer not matched"
fn = m.group(1)
decl = f"function {fn}() {{"
assert s.count(decl) == 1, f"registry decl count={s.count(decl)}"
start = s.index(decl)
end = s.index("\n}\n", start)

SLOT = "        ...[],\n"
assert s.count(SLOT, start, end) == 1, "injection slot not unique inside the registry"
at = s.index(SLOT, start, end)
add = "        ...(globalThis.__commandHooks ? globalThis.__commandHooks.getCommands() : []),\n"
p.write_text(s[: at + len(SLOT)] + add + s[at + len(SLOT) :])
print(f"005 ported (registry function: {fn})")
