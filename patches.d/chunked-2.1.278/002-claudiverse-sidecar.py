import sys, pathlib
T = pathlib.Path(sys.argv[1])

# --- hunk 1: structuredIO.prependUserMessage -------------------------------
p = T / "cli/structuredIO.js"
s = p.read_text()
old = "    prependUserMessage(s) {\n        (this.prependedLines.push(\n"
new = ("    prependUserMessage(s) {\n"
       "        try {\n"
       "            globalThis.__claudiverse.setStructuredIO(this);\n"
       "        } catch (__e) {}\n"
       "        (this.prependedLines.push(\n")
assert s.count(old) == 1, f"hunk1 anchor count={s.count(old)}"
p.write_text(s.replace(old, new))

# --- hunk 2: the query() mirror loop ---------------------------------------
# 2.1.278 renamed the two locals this hook threads through: o -> s, d -> g.
# They appear in the hunk CONTEXT as well, which is why 002 failed loudly here
# instead of applying and mirroring nothing.
p = T / "services/compact/precomputedCompact.js"
s = p.read_text()
old = ("    try {\n"
       "        g = yield* isObserverAgentsEnabled() ? queryWithObserverTap(params, consumedCommandUuids, s) : queryLoop(params, consumedCommandUuids, s);\n")
new = """    try {
        // ⛔ AUXILIARY QUERIES ARE NOT THE CONVERSATION. query() also serves
        // Claude Code's internal side-requests — prompt suggestion, session
        // title, memory extraction, away summary, narration — which fork the
        // full context, run with skipTranscript, and never reach the local
        // JSONL. Mirroring them put phantom assistant messages in claudiverse:
        // the prompt-suggestion fork predicts what the OPERATOR would type
        // next, so the panel showed Claude saying "status?".
        // Upstream's own split (coreSchemas: repl_main_thread*/sdk = main,
        // agent:*/hook_agent = subagent, undefined = main, else auxiliary),
        // spelled out so no minified name lands on an added line.
        let __qs = params.querySource,
            __mirror =
                typeof __qs !== 'string' ||
                __qs.startsWith('repl_main_thread') ||
                __qs === 'sdk' ||
                __qs.startsWith('agent:') ||
                __qs === 'hook_agent';
        let __it = isObserverAgentsEnabled()
                ? queryWithObserverTap(params, consumedCommandUuids, s)
                : queryLoop(params, consumedCommandUuids, s),
            __st;
        while (!(__st = await __it.next()).done) {
            if (__mirror) {
                try {
                    globalThis.__claudiverse.mirrorMessage(__st.value);
                } catch (__e) {}
            }
            yield __st.value;
        }
        g = __st.value;
        try {
            if (__mirror && !params.toolUseContext.agentId)
                globalThis.__claudiverse.mirrorMessage({ type: 'turn_complete' });
        } catch (__e) {}
"""
assert s.count(old) == 1, f"hunk2 anchor count={s.count(old)}"
p.write_text(s.replace(old, new))
print("002 ported")
