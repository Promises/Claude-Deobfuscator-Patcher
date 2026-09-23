import re, sys, pathlib
T = pathlib.Path(sys.argv[1])
# hunk 1 — StructuredIO.prependUserMessage. Param is minified and renames every
# release (t on .263, s on .278, n on .280), so CAPTURE it, never hardcode.
p = T / "cli/structuredIO.js"
s = p.read_text()
m = re.search(r"\n    prependUserMessage\((\w+)\) \{\n        \(this\.prependedLines\.push\(\n", s)
assert m, "prependUserMessage anchor not found"
arg = m.group(1)
old = m.group(0)
assert s.count(old) == 1, f"anchor count={s.count(old)}"
new = (f"\n    prependUserMessage({arg}) {{\n"
       "        try {\n"
       "            globalThis.__claudiverse.setStructuredIO(this);\n"
       "        } catch (__e) {}\n"
       "        (this.prependedLines.push(\n")
p.write_text(s.replace(old, new))

# hunk 2 — the query() mirror loop. Locals renamed o->s, d->g since .263; both
# appear in context, so capture them from the yield* line rather than assume.
# DISCOVER the query module by the one name that RESOLVES across layouts.
# Everything else here is renamed per layout: the generator itself, its params
# object, and queryLoop (Em on an unpinned 2.1.280 tree). queryWithObserverTap
# survives because its own error string anchors the rename rule, so the yield*
# delegation line is the anchor — and every identifier is captured FROM it.
#
# Pinning this module to a fixed path was tried and REVERTED: two modules then
# share one emitted file, the merge drops exports, and the tree stops bundling
# (_unmatched/1114_FORK_AGENT.js: "No matching export"). The patch follows the
# module rather than forcing the module to the patch.
pat = re.compile(
    r"\n    try \{\n        (\w+) = yield\* isObserverAgentsEnabled\(\) \? "
    r"queryWithObserverTap\((\w+), (\w+), (\w+)\) : (\w+)\(\2, \3, \4\);\n")
hits = [(f, pat.search(f.read_text())) for f in T.rglob("*.js") if ".git" not in f.parts]
hits = [(f, m) for f, m in hits if m]
assert len(hits) == 1, f"query delegation found in {len(hits)} files"
p, m = hits[0]
s = p.read_text()
res, prm, cmds, acc, loop = m.groups()
old = m.group(0)
assert s.count(old) == 1, f"delegation count={s.count(old)}"
new = f"""
    try {{
        // AUXILIARY QUERIES ARE NOT THE CONVERSATION. query() also serves
        // Claude Code's internal side-requests — prompt suggestion, session
        // title, memory extraction, narration — which fork the full context,
        // run with skipTranscript, and never reach the local JSONL. Mirroring
        // them put phantom assistant messages in claudiverse: the suggestion
        // fork predicts what the OPERATOR would type, so the panel showed
        // Claude saying "status?". Upstream's own main/subagent/auxiliary
        // split, spelled out so no minified name is injected.
        let __qs = {prm}.querySource,
            __mirror =
                typeof __qs !== 'string' ||
                __qs.startsWith('repl_main_thread') ||
                __qs === 'sdk' ||
                __qs.startsWith('agent:') ||
                __qs === 'hook_agent';
        let __it = isObserverAgentsEnabled()
                ? queryWithObserverTap({prm}, {cmds}, {acc})
                : {loop}({prm}, {cmds}, {acc}),
            __st;
        while (!(__st = await __it.next()).done) {{
            if (__mirror) {{
                try {{
                    globalThis.__claudiverse.mirrorMessage(__st.value);
                }} catch (__e) {{}}
            }}
            yield __st.value;
        }}
        {res} = __st.value;
        try {{
            if (__mirror && !{prm}.toolUseContext.agentId)
                globalThis.__claudiverse.mirrorMessage({{ type: 'turn_complete' }});
        }} catch (__e) {{}}
"""
p.write_text(s.replace(old, new))
print(f"002 ported (structuredIO arg={arg}; query in {p.relative_to(T)}, params={prm}, loop={loop})")
