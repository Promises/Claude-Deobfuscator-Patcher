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
p = T / "services/compact/precomputedCompact.js"
s = p.read_text()
m = re.search(
    r"\n    try \{\n        (\w+) = yield\* isObserverAgentsEnabled\(\) \? "
    r"queryWithObserverTap\(params, consumedCommandUuids, (\w+)\) : "
    r"queryLoop\(params, consumedCommandUuids, \2\);\n", s)
assert m, "query yield* anchor not found"
res, acc = m.group(1), m.group(2)
old = m.group(0)
assert s.count(old) == 1, f"query anchor count={s.count(old)}"
new = f"""
    try {{
        // ⛔ AUXILIARY QUERIES ARE NOT THE CONVERSATION. query() also serves
        // Claude Code's internal side-requests — prompt suggestion, session
        // title, memory extraction, narration — which fork the full context,
        // run with skipTranscript, and never reach the local JSONL. Mirroring
        // them put phantom assistant messages in claudiverse: the suggestion
        // fork predicts what the OPERATOR would type, so the panel showed
        // Claude saying "status?".
        // Upstream's own split, spelled out so no minified name is injected.
        let __qs = params.querySource,
            __mirror =
                typeof __qs !== 'string' ||
                __qs.startsWith('repl_main_thread') ||
                __qs === 'sdk' ||
                __qs.startsWith('agent:') ||
                __qs === 'hook_agent';
        let __it = isObserverAgentsEnabled()
                ? queryWithObserverTap(params, consumedCommandUuids, {acc})
                : queryLoop(params, consumedCommandUuids, {acc}),
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
            if (__mirror && !params.toolUseContext.agentId)
                globalThis.__claudiverse.mirrorMessage({{ type: 'turn_complete' }});
        }} catch (__e) {{}}
"""
p.write_text(s.replace(old, new))
print(f"002 ported (structuredIO arg={arg}, query result={res} acc={acc})")
