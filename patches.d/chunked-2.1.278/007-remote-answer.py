import re, sys, pathlib
T = pathlib.Path(sys.argv[1])
p = T / "services/dialogs/dialogStore.js"
s = p.read_text()
# The store local was `v` on 2.1.263 and is `dialogStore` on 2.1.278 (the
# deobfuscator now derives a real name for it). Injected code must name the
# CURRENT one, so it is threaded in rather than hardcoded.
DECL = "function createDialogStore() {"
assert s.count(DECL) == 1, f"createDialogStore count={s.count(DECL)}"
start = s.index(DECL)
# The factory's return is FILE-UNIQUE, so scope by that plus an ordering
# assertion rather than by computing the function's extent — the extent
# calculation is what kept mis-firing, and a unique string needs no extent.
m = re.search(r"\n    return ([A-Za-z_$][A-Za-z0-9_$]*);\n", s[start:])
assert m, "store return not found after the factory declaration"
store = m.group(1)
ret = f"\n    return {store};\n"
assert s.count(ret) == 1, f"store return not file-unique ({s.count(ret)})"
at = s.index(ret)
assert at > start, "the return precedes the factory declaration"
block = f"""
    try {{
        var __cvOpen = function () {{
            return {store}.getState().open.filter((d) => d && d.kind === 'permission_ask_user_question');
        }};
        var __cvPick = function (toolUseId) {{
            var open = __cvOpen();
            return toolUseId
                ? open.find((d) => d.payload && d.payload.requestId === toolUseId)
                : open[open.length - 1];
        }};
        globalThis.__claudiverseListQuestions = function () {{
            return __cvOpen().map((d) => ({{
                toolUseId: d.payload && d.payload.requestId,
                questions: d.payload && d.payload.questions,
            }}));
        }};
        globalThis.__claudiverseAnswer = function (toolUseId, answerPayload) {{
            var req = __cvPick(toolUseId);
            if (!req) return false;
            {store}.answer(req.id, {{
                behavior: 'allow',
                updatedInput: Object.assign({{}}, req.payload.input, answerPayload),
            }});
            return true;
        }};
        globalThis.__claudiverseDecline = function (toolUseId) {{
            var req = __cvPick(toolUseId);
            if (!req) return false;
            {store}.answer(req.id, {{ behavior: 'deny' }});
            return true;
        }};
    }} catch (__e) {{}}
"""
p.write_text(s[:at] + block + s[at + 1 :])
print(f"007 ported (store local: {store})")
