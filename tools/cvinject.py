#!/usr/bin/env python3
"""Inject claudiverse hooks into a shipped Claude Code binary, in place.

WHY NOT PATCHES. From 2.1.278 the TUI calls Bun.ant.CellSegmenter, which exists
only in Anthropic's private bun fork. Anything we recompile with public bun
compiles, answers --version, and dies at REPL start. So we stop recompiling and
edit the binary they ship, keeping their runtime.

HOW IT STAYS SAFE. Every edit is LENGTH-NEUTRAL: code is spliced in at the hook
site and an equal number of bytes is taken from the module's leading licence
banner. Nothing moves, so no StringPointer needs updating — which matters
because 13% of the module graph is records we cannot decode, and rebuilding it
drops them. See bunpack.repack's docstring.

THE HOOKS ARE THIN. The real runtime (SidecarClient and friends, ~2,343 lines)
cannot fit in ~600 bytes of banner, so it lives in a file on disk loaded by the
bootstrap via $CLAUDIVERSE_RUNTIME. Each hook is a guarded call — if the runtime
is absent every hook is a no-op and the binary behaves exactly like stock.
"""
import re
import struct
import subprocess
import sys

sys.path.insert(0, __file__.rsplit("/", 1)[0])
from bunpack import Graph, banner_slab  # noqa: E402


def splice_paid(contents, at, code):
    """Insert `code` at byte offset `at`, paying for it out of the banner.

    Returns new contents of IDENTICAL length. Raises if the banner cannot cover
    the cost — better a loud refusal than a binary whose offsets silently rot.
    """
    start, stop = banner_slab(contents)
    if at <= stop:
        raise SystemExit("hook site is inside the banner we are spending")
    room = stop - start
    need = len(code)
    if need + 3 > room:
        raise SystemExit(f"hook needs {need}B but banner room is {room}B")
    pad = room - need - 3                      # "//" + filler + "\n"
    banner = b"//" + b" " * pad + b"\n"
    out = contents[:start] + banner + contents[stop:at] + code + contents[at:]
    assert len(out) == len(contents), (len(out), len(contents))
    return out


def replace_paid(contents, old, new):
    """Swap `old` for `new`, paying the size difference out of the banner.

    Some hooks cannot be a bare inserted call — the query mirror has to WRAP the
    iterator the generator delegates to, so the statement itself changes.
    """
    if contents.count(old) != 1:
        raise SystemExit(f"replace anchor occurs {contents.count(old)}x, need 1")
    start, stop = banner_slab(contents)
    room = stop - start
    delta = len(new) - len(old)
    if delta + 3 > room:
        raise SystemExit(f"replacement costs {delta}B but banner room is {room}B")
    pad = room - delta - 3
    banner = b"//" + b" " * pad + b"\n"
    out = contents[:start] + banner + contents[stop:].replace(old, new, 1)
    assert len(out) == len(contents), (len(out), len(contents))
    return out


def find_module(g, token, label):
    hits = [m for m in g.modules if token in m.contents]
    if len(hits) != 1:
        raise SystemExit(f"{label}: token matched {len(hits)} modules, need exactly 1")
    return hits[0]


# --- the hook table --------------------------------------------------------
#
# `token`  locates the module (must be unique across all 2,213)
# `anchor` locates the site inside it (must be unique within the module)
# `code`   is spliced immediately BEFORE the anchor
#
# Every hook is guarded so an unconfigured binary is stock.

def _trust(c, g=None):
    # Capture the config local rather than assume `e` — it is minified and
    # renames per release. Only `trustAccepted` is original-source.
    mm = re.search(rb"if\(([\w$]+)\.trustAccepted\)return!0;", c)
    if not mm:
        raise SystemExit("011: trust gate shape changed")
    return splice_paid(c, mm.start(),
                       b"if(process.env.CLAUDIVERSE_SKIP_TRUST)return!0;")


def _structio(c, g=None):
    mm = re.search(rb"prependUserMessage\(([\w$]+)\)\{", c)
    if not mm:
        raise SystemExit("002-io: prependUserMessage shape changed")
    return splice_paid(c, mm.end(), b"try{globalThis.__cvSetIO?.(this)}catch(e){}")


def _querytap(c, g=None):
    # `g=yield* COND ? tap(e,…) : loop(e,…)` — every identifier here is
    # minified, so all of them are captured. Two shapes are live:
    #   ≤2.1.282  d=yield*cVt()?mm(e,n,s):Gl(e,n,s)            (statement start)
    #   2.1.286   u=yield*sYt()?lc(e,o,r,s):s.through(bl(e,o,r,s))
    #             — one more argument, the loop wrapped by a `using` resource,
    #             and the assignment sits INSIDE a comma expression
    #             (`try{await vqe(…),u=yield*…}`).
    # The tap wraps the iterator so the runtime sees each yielded value; it
    # cannot be a bare call, hence replace rather than insert. The replacement
    # must be a pure EXPRESSION: a `let …;` prefix is a syntax error inside a
    # comma expression, so the iterator is bound by an arrow parameter instead.
    pat = (rb"([\w$]+)=yield\*\s*([\w$]+\(\))\?([\w$]+)\(([\w$]+)((?:,[\w$]+)*)\):"
           rb"([\w$]+\(\4\5\)|[\w$]+\.[\w$]+\([\w$]+\(\4\5\)\))")
    hits = list(re.finditer(pat, c))
    if len(hits) != 1:
        raise SystemExit(f"002-query: delegation shape changed ({len(hits)} matches, need 1)")
    res, cond, tap, prm, rest, other = hits[0].groups()
    new = (res + b"=yield*((__cvI)=>globalThis.__cvTap?globalThis.__cvTap(__cvI," + prm
           + b"):__cvI)(" + cond + b"?" + tap + b"(" + prm + rest + b"):" + other + b")")
    return replace_paid(c, hits[0].group(0), new)


def _bindhost(c, g=None):
    """003 — hand the submit controller and its deps to the runtime.

    🔴 THE DEPS OBJECT MUST BE PASSED OUT, NOT FETCHED. Draft preservation needs
    `this.#e.draft`, and #e is a PRIVATE field — unreachable from the runtime.
    Inside the class body it is in scope, so the hook passes it across.

    Scoped to the class the unique error string identifies: `bindHost(x){this.#y=x}`
    is a shape other classes share.
    """
    ANCHOR = b"PromptSubmitController used before its host was bound"
    k = c.find(ANCHOR)
    if k < 0:
        raise SystemExit("003: controller anchor absent")
    head = c.rfind(b"class ", 0, k)
    mm = re.search(rb"constructor\(([\w$]+)\)\{this\.#([\w$]+)=\1\}bindHost\(([\w$]+)\)\{this\.#([\w$]+)=\3\}",
                   c[head:k])
    if not mm:
        raise SystemExit("003: constructor/bindHost shape changed")
    deps, host_arg, host = mm.group(2), mm.group(3), mm.group(4)
    at = head + mm.end() - 1          # just before bindHost's closing brace
    code = (b";try{globalThis.__cvBindHost?.(this,this.#" + deps + b")}catch(e){}")
    return splice_paid(c, at, code)


def _auth_cache_clear(g):
    """(name, chunk) of upstream's OAuth-credential cache invalidator.

    🔴 THIS IS THE HALF THAT MAKES THE OTHER HALF MEAN ANYTHING. Raising the
    stale flag only forces the gate to fire so `<cred>=await <getter>()` runs
    again. The getter is MEMOISED — without invalidating that memo it hands back
    the credential we just failed over from, which is precisely the 2.1.263 bug:
    every "switched" failover re-sent the stale token.

    ⛔ IT CANNOT BE FOUND BY NAME. On 2.1.263 it is `Hw` in coreSchemas.js — and
    there is a DIFFERENT `Hw` in main.js, exported as `main`. The 2.1.263 patch
    imports it under an alias for exactly that reason. I hit the same collision
    from the other side: I grepped `function Hw(` in the merged deobfuscated file,
    found the unrelated store accessor `return <store>.of(<host>)`, concluded the
    call was a no-op, and dropped it. It is not a no-op.

    So it is bound by an OBSERVABLE instead: upstream calls it immediately after
    testing for the CLAUDE_CODE_OAUTH_TOKEN env var by name, and an env var name
    survives minification. That site is unique across all modules.
    """
    PAT = rb'includes\("CLAUDE_CODE_OAUTH_TOKEN"\)\)([\w$]+)\(\)'
    hits = [(m.index, mm.group(1)) for m in g.modules
            for mm in re.finditer(PAT, m.contents)]
    names = {n for _, n in hits}
    if len(names) != 1:
        raise SystemExit(f"012: auth-cache clear resolved to {sorted(names)}, need 1")
    name = names.pop()
    im = re.search(rb'import\{[^}]*\b' + re.escape(name) + rb'\b[^}]*\}from"([^"]+)"',
                   g.modules[hits[0][0]].contents)
    if not im:
        raise SystemExit("012: auth-cache clear is not a shared-chunk import")
    return name, im.group(1)


def _mode_setter(g):
    """013 — (chunk path, export name) of upstream's permission-mode setter.

    The setter is what the interactive REPL's own `set_permission_mode` handler
    and the headless bridge apply a mode through: it validates the mode, runs
    the full transition (plan's prePlanMode save/restore, auto's side effects)
    and emits the mode-change event. Writing toolPermissionContext.mode
    directly would skip all three.

    Nothing is spliced. Like 012's auth-cache clear, the binary only carries the
    REFERENCE and the runtime imports the chunk by its virtual path.

    Bound by an OBSERVABLE: the setter's module is the one carrying the refusal
    text for a mode the session was not launched with, and the setter is the
    4-argument function whose first statement validates `(mode, context)` and
    which returns `{ok:!0,mode:...}`. Exactly one such function must exist.
    """
    ANCHOR = b"because the session was not launched with --dangerously-skip-permissions"
    mods = [m for m in g.modules if ANCHOR in m.contents]
    if len(mods) != 1:
        raise SystemExit(f"013: mode-setter anchor in {len(mods)} modules, need 1")
    c = mods[0].contents
    PAT = (rb'function ([\w$]+)\(([\w$]+),([\w$]+),([\w$]+),([\w$]+)\)'
           rb'\{let ([\w$]+)=[\w$]+\(\2,\3\);if\(!\6\.ok\)return \6;')
    fns = [mm.group(1) for mm in re.finditer(PAT, c)
           if b"{ok:!0,mode:" in c[mm.end():mm.end() + 400]]
    if len(fns) != 1:
        raise SystemExit(f"013: mode setter resolved to {fns}, need 1")
    local = fns[0]
    ex = re.search(rb'export\{([^}]*)\}', c)
    names = {}
    for part in (ex.group(1).split(b",") if ex else []):
        bits = part.strip().split(b" as ")
        names[bits[0]] = bits[-1]
    if local not in names:
        raise SystemExit(f"013: mode setter {local!r} is not exported")
    return mods[0].name.encode(), names[local]


def _failover(c, g=None):
    """012 — mid-session account failover on a 429.

    🔴 THREE INJECTIONS, AND THE FLAG IS NOT OPTIONAL. `continue` alone re-enters
    the retry loop holding the credential object it ALREADY has: the getter is
    only re-run when the predicate at the top of the try fires, and no arm of it
    is true for a 429. MEASURED on 2.1.263 (2026-09-20): "Switched to Work", then
    five 429s ~1s apart against an account at weekly 10%, then the weekly-limit
    dialog. The failover had never once completed inside a turn — only the NEXT
    query() picked up the new token, which is why "choose Stop, then it goes
    through" was the pattern from the very first live failover. So a flag is
    raised at the 429 and consumed as a new arm of that predicate, at the one
    place the getter is legitimately re-run.

    ⛔ HOW THE EARLIER ATTEMPTS BROKE, so they are not repeated.
      - A bare `if(<cred>===null||` matched the wrong site (8 in this module);
        the first hit is unrelated code -> "Unexpected token '.'" at startup.
      - An attempt before that ran past a `?` and landed inside a ternary ->
        "Unexpected token ','. Expected ':'".
      - The error CLASS cannot be bound from the caught variable: the catch binds
        `wt`, but the gate tests a persisted last-error `w`. Binding on the wrong
        one raised "cannot bind the API error class".
    The gate is now bound by PROXIMITY — find the refetch (unique), search
    BACKWARD for the nearest gate, and assert the refetch sits exactly one brace
    deeper, so it really is inside that gate's block.

    ⚠️ SPLICE ORDER IS LOAD-BEARING, AND RE-SEARCHING IS NOT AN OPTION HERE.
    splice_paid pays for an insert out of the leading banner, so bytes BEFORE the
    insert point shift back by len(code) while bytes AT OR AFTER it keep their
    absolute offset. The gate therefore has to go in FIRST: the clear sits after
    it and survives untouched, whereas doing the clear first would move the gate.
    Re-deriving instead would not work — each injection destroys the pattern the
    other is found by (the clear splits `h=await e(),Le=...`, and the arm splits
    `if(h===null||`), so the second search returns 0 matches. Measured: that is
    exactly the "credential refetch matched 0x" failure this ordering fixes.

    The 2.1.263 patch also calls the auth-cache clear here, and so do we — see
    _auth_cache_clear for why omitting it silently reproduces the original bug.
    """
    if g is None:
        raise SystemExit("012: needs the module graph to bind the auth-cache clear")

    # ⛔ THE CLEAR CANNOT BE IMPORTED INTO THIS MODULE. It lives in a shared chunk
    # this module does not import, and adding a name to an import statement's
    # TEXT does not create a binding: bun links the standalone graph from
    # precomputed module records, so the edited specifier list is ignored.
    # MEASURED — splicing `,KC as __cvKC` into the import list built cleanly and
    # then died at startup with "ReferenceError: __cvKC is not defined". Loud,
    # which is the good failure, but the technique is invalid. Referencing an
    # ALREADY-IMPORTED name in spliced text is fine; only new bindings fail.
    # So _clearreg publishes it from modules that already import it, and this
    # site reaches it through globalThis.
    _clear_name, _chunk = _auth_cache_clear(g)   # validates it is still findable

    RF = rb"(([\w$]+)=await [\w$]+\(\),)[\w$]+=[\w$]+\(\)\?[\w$]+\(\)\?\.accessToken:void 0"

    def locate_gate(buf):
        """(gate_offset, refetch_match) — the credential gate and its refetch."""
        rf = list(re.finditer(RF, buf))
        if len(rf) != 1:
            raise SystemExit(f"012: credential refetch matched {len(rf)}x, need 1")
        cred = rf[0].group(2)
        k = buf.rfind(b"if(" + cred + b"===null||", 0, rf[0].start())
        if k < 0:
            raise SystemExit("012: no credential gate precedes the refetch")
        span = buf[k:rf[0].start()]
        depth = span.count(b"{") - span.count(b"}")
        if depth != 1:
            raise SystemExit(f"012: refetch is {depth} braces inside the gate, expected 1")
        return k, rf[0]

    # Both argument helpers are captured by BODY, never by name: the 2.1.263
    # names (Ako, Mot) are deobfuscator renames and do not exist in the binary.
    # 2.1.286 added a clock parameter — `hMo(e,n){…Math.round(s*1000-n.now())…}`
    # where ≤2.1.282 had `NSo(e){…Date.now()…}` — so the call below always passes
    # `Date` as the clock; an older one-parameter helper ignores it.
    mm = re.search(rb'function ([\w$]+)\([\w$]+(?:,[\w$]+)?\)\{let [\w$]+=[\w$]+\.headers\?\.get\?\.'
                   rb'\("anthropic-ratelimit-unified-reset"\);', c)
    if not mm:
        raise SystemExit("012: reset-delay helper shape changed")
    reset_delay = mm.group(1)

    mm = re.search(rb'function ([\w$]+)\([\w$]+\)\{return [\w$]+\.includes\('
                   rb'"Extra usage is required for long context"\)', c)
    if not mm:
        raise SystemExit("012: extra-usage helper shape changed")
    extra_usage = mm.group(1)

    # The API error class, read out of the gate's own 401 test. It is NOT the
    # catch binding: the gate tests a persisted last-error variable instead.
    k, _rf = locate_gate(c)
    ec = re.search(rb"instanceof ([\w$]+)&&[\w$]+\.status===401", c[k:k + 500])
    if not ec:
        raise SystemExit("012: cannot bind the API error class from the gate")
    errclass = ec.group(1)

    # --- 1. the 429 -> failover decision, right after upstream's onError ---
    oe = re.search(rb"let [\w$]+=await ([\w$]+)\.onError\?\.\(([\w$]+)\);", c)
    if not oe:
        raise SystemExit("012: onError site shape changed")
    err = oe.group(2)

    # The attempt counter is NOT decremented, unlike upstream's own retry path
    # just below. Deliberate: it bounds how many failovers one turn can perform,
    # so a pool that keeps handing back usable-looking credentials cannot spin.
    code = (b"try{if(" + err + b" instanceof " + errclass + b"&&" + err
            + b".status===429){let __cvF=await globalThis.__claudiverse"
            b"?.failoverAnthropicAccount?.(" + reset_delay + b"(" + err + b",Date),"
            + extra_usage + b"(" + err + b'.message??""));'
            b"if(__cvF&&(__cvF.switched||__cvF.retry)){globalThis.__cvStale=!0;"
            b"globalThis.__cvClearAuthCache?.();continue}}}catch(__e){}")
    out = splice_paid(c, oe.end(), code)

    # --- 2 & 3. the predicate arm, then the clear ---
    k2, rf = locate_gate(out)
    clear_at = rf.end(1)                 # just past `<cred>=await <getter>(),`

    # Arm first (earlier offset), so clear_at stays valid across the splice.
    out = splice_paid(out, k2 + 3, b"globalThis.__cvStale===!0||")

    # Belt and braces: clear_at was computed before the previous splice, so
    # prove it still points where we think rather than trusting the arithmetic.
    if out[clear_at - 1:clear_at] != b"," or b"=await " not in out[clear_at - 24:clear_at]:
        raise SystemExit("012: refetch offset did not survive the gate splice")
    return splice_paid(out, clear_at, b"globalThis.__cvStale=!1,")


def _session(c, g=None):
    """001 — hand Claude's own session UUID to the runtime.

    getSessionId() is `function K(){return g()?.sessionId??n().id}` on 2.1.280.
    Anchored by that RETURN EXPRESSION, not by the name: K/g/n are all minified.

    Latched in the binary (`if(!__cvSid)`) because getSessionId is a hot path —
    without the latch the override lookup runs twice on every single call.

    The id is STASHED as well as handed over. The bootstrap does not await its
    import() of the runtime, so getSessionId can fire before the runtime exists;
    the runtime reads __cvSid on load to cover that ordering.
    """
    mm = re.search(rb"function [\w$]+\(\)\{(?=return ([\w$]+)\(\)\?\.sessionId\?\?([\w$]+)\(\)\.id\})", c)
    if not mm:
        raise SystemExit("001: getSessionId shape changed")
    ov, root = mm.group(1), mm.group(2)
    code = (b"if(!globalThis.__cvSid)try{globalThis.__cvSid=" + ov + b"()?.sessionId??"
            + root + b"().id,globalThis.__cvSession?.(globalThis.__cvSid)}catch(e){}")
    out = splice_paid(c, mm.end(), code)

    # 012's 401-renewal leg. Upstream re-asks a registered callback for a fresh
    # credential on a 401; pointing it at the sidecar is what makes the pool the
    # source of truth for renewals as well as failovers.
    #
    # A REFERENCE IS PUBLISHED, NOT A CALL. The registrar dereferences the root
    # session, which does not exist at module-eval time — the 2.1.263 patch
    # registers from inside app startup for that reason. Here the runtime calls
    # it from the session-connect path instead, where the session provably
    # exists, and the policy stays in editable JS.
    reg = re.search(rb"function ([\w$]+)\(([\w$]+)\)\{[\w$]+\(\)\.host\.credentialSlots"
                    rb"\.replaceSdkOAuthTokenRefreshCallback\(\2\)\}", out)
    if not reg:
        raise SystemExit("001/012: SDK OAuth refresh registrar shape changed")
    return splice_paid(out, reg.end(),
                       b"globalThis.__cvSetRefreshCb=" + reg.group(1) + b";")


def _compact(c, g=None):
    """009 — emit {type:"compact"} so a watcher knows context was dropped.

    markPostCompaction is the single chokepoint every compaction path funnels
    through: full auto-compact, manual /compact, and the partial-compaction
    runner all call it exactly once. Anchored on its BODY (the requestJournal
    local feeding replacePendingPostCompaction(!0)) — the property that makes it
    the chokepoint — rather than on the minified name.

    Known and accepted: no agentId is in scope here, so a SUBAGENT compacting
    also emits. The watcher reads that as "the worker compacted" and holds a
    re-brief, which reject-busy gates anyway.
    """
    pat = (rb"function [\w$]+\([^)]*\)\{(?=let ([\w$]+)=[\w$]+\(\)\.requestJournal;"
           rb"if\(\1\.replacePendingPostCompaction\(!0\))")
    hits = list(re.finditer(pat, c))
    if len(hits) != 1:
        raise SystemExit(f"009: markPostCompaction matched {len(hits)}x, need 1")
    return splice_paid(c, hits[0].end(),
                       b'try{globalThis.__claudiverse?.mirrorMessage?.({type:"compact"})}catch(e){}')


def _dialogstore(c, g=None):
    """007 — hand the dialog store to the runtime so questions can be answered.

    🔴 THE STORE MUST BE PASSED OUT, NOT LOOKED UP. It is built by a factory
    called once from useState() in AppStateProvider and distributed through React
    context, so there is NO module-scope binding to capture. Inside the factory it
    is in scope, and the factory runs outside render — so the globals exist
    without waiting for any component to mount.

    Anchored on the last method of the store literal (dismissKind, whose body
    self-references the store) immediately before `return <store>`, which pins the
    insertion to the fully-built object.
    """
    pat = (rb"dismissKind\(([\w$]+)\)\{for\(let ([\w$]+) of [\w$]+\.getState\(\)\.open\)"
           rb"if\(\2\.kind===\1\)([\w$]+)\.dismiss\(\2\.id\)\}\};(?=return \3\})")
    hits = list(re.finditer(pat, c))
    if len(hits) != 1:
        raise SystemExit(f"007: dialog store matched {len(hits)}x, need 1")
    return splice_paid(c, hits[0].end(),
                       b"try{globalThis.__cvDialogStore?.(" + hits[0].group(3) + b")}catch(e){}")


def _mainloop(c, g=None):
    """008 + 010 — hand the main-loop controller and its host to the runtime.

    🔴 THIS REPLACES THE PATCH-ROUTE REACT EFFECT, DELIBERATELY. 2.1.280's REPL is
    React-Compiler output — the readiness locals the 2.1.238 patches spliced
    between (`_h`, `mi`, `z`, `He`) no longer exist as a destructure; they are
    slots in a memo cache array. Splicing an effect in there would mean binding
    four minified names with nothing to pin them, and a silent rebind means the
    fleet believes a busy seat is idle. That is the one failure mode 008 exists to
    avoid.

    So we hook a CLASS instead. bindHost(h) receives the host, which carries
    {store, dialogStore, messageQueue}, and `this` exposes upstream's own
    isMainLoopBusy — isLoading || userInputOnProcessing || queue length > 0. That
    predicate is TASK-INDEPENDENT, so a zombie background subagent cannot pin the
    seat busy; 008's own notes cite this getter as corroboration that upstream
    reached the same basis. Readiness is now READ FROM upstream rather than
    recomputed alongside it.

    Scoped by the _mount/_host shape in the lookahead: `bindHost(x){this.#y=x}` is
    a shape other classes in this module share (003 hooks one of them).
    """
    pat = (rb"bindHost\(([\w$]+)\)\{(?=let ([\w$]+)=this\._host===null;"
           rb"if\(this\._host=\1,\2\)this\._mount\(\1\))")
    hits = list(re.finditer(pat, c))
    if len(hits) != 1:
        raise SystemExit(f"008/010: main-loop bindHost matched {len(hits)}x, need 1")
    return splice_paid(c, hits[0].end(),
                       b"try{globalThis.__cvMainLoop?.(this," + hits[0].group(1) + b")}catch(e){}")


def _commands(c, g=None):
    """005 — let the runtime append slash commands to the builtin table.

    ⛔ DO NOT ANCHOR ON THE ARRAY LITERAL. The patch route appended inside the
    table's `...[],` tail slot; on 2.1.280 that shape has a LOOKALIKE — the TOOL
    list (it carries underlyingV1ToolName) has two such slots, so a blind match
    injects slash commands into the tool table. Hooking the memoised accessor
    binds by the NAME builtinCommandTable, which the tool list does not share, and
    it is the same one-shot: the `??=` means the builder runs exactly once.
    """
    mm = re.search(rb"([\w$]+)\.builtinCommandTable\?\?=([\w$]+)\(\)", c)
    if not mm:
        raise SystemExit("005: builtin command table accessor shape changed")
    holder, builder = mm.group(1), mm.group(2)
    new = (holder + b".builtinCommandTable??=(globalThis.__cvCommands?"
           b"globalThis.__cvCommands(" + builder + b"()):" + builder + b"())")
    return replace_paid(c, mm.group(0), new)


def _canary(c, g=None):
    """006 (version canary) — make every version readout identifiably patched.

    getVersionSuffix() is the common suffix already interpolated by all seven
    readouts (--version fast path, commander .version(), /status, /version,
    --print, doctor, logo), and its body is just `return""` — no build metadata,
    so unlike the banner template literals it does not change every release.

    ⚠️ THIS IS THE ONE HOOK THAT IS NOT INERT WITHOUT THE RUNTIME. It is a CANARY:
    its purpose is to answer "is this binary patched?" before any runtime loads,
    so gating it on $CLAUDIVERSE_RUNTIME would defeat it. The cost is that
    --version no longer byte-matches stock.
    """
    old = b'}.BUILD_REF_NAME){return""}'
    if c.count(old) != 1:
        raise SystemExit(f"006: version suffix occurs {c.count(old)}x, need 1")
    return replace_paid(c, old, b'}.BUILD_REF_NAME){return"' + VERSION_SUFFIX + b'"}')


# What 006 appends to every version readout. Overridable (--suffix) so a build
# that carries only SOME hooks — the semi-claudiversed variant — can never be
# mistaken for the full production build.
VERSION_SUFFIX = b" [claudiverse]"

HOOKS = [
    # The only hook needing no runtime at all — it reads the environment
    # directly, so it works even with $CLAUDIVERSE_RUNTIME unset.
    dict(name="011-spawn-trust", token=b"trustAccepted)return!0", build=_trust),
    dict(name="001-session",     token=b"replacePendingPostCompaction", build=_session),
    dict(name="009-compact",     token=b"replacePendingPostCompaction", build=_compact),
    dict(name="005-commands",   token=b"builtinCommandTable??=", build=_commands),
    dict(name="006-canary",     token=b"BUILD_REF_NAME",         build=_canary),
    dict(name="007-remote-answer", token=b"DialogStoreContext provider", build=_dialogstore),
    dict(name="002-structio",    token=b"prependedLines",         build=_structio),
    dict(name="002-querytap",    token=b"queryWithObserverTap",   build=_querytap),
    dict(name="008-010-mainloop", token=b"PromptSubmitController used before",
         build=_mainloop),
    dict(name="003-inject",      token=b"PromptSubmitController used before",
         build=_bindhost),
    # 012 is LAST on purpose: it is the biggest spend out of module 342's
    # banner, and 005 also draws from it. Ordering here is the spend order.
    dict(name="012-failover",    token=b"api_request_no_response_exhausted",
         build=_failover),
]


def apply_hooks(binary, out_path, names=None, bootstrap=True):
    g = Graph(binary)
    edits = {}

    if bootstrap:
        ep = g.modules[g.entry_point_id]
        # 012 needs upstream's auth-cache clear, which lives in a shared chunk.
        # ⛔ NEITHER OBVIOUS ROUTE WORKS. It cannot be imported into the retry
        # loop's module (editing an import list does not create a binding — see
        # _failover), and it cannot be published from the modules that DO import
        # it: measured, not one of the five is evaluated on the interactive REPL
        # path, so the global was still absent 38s into a session. What does work
        # is that a bun standalone chunk is importable by its virtual path at
        # runtime — verified: 1216 exports, the clear among them. So the binary
        # carries only the REFERENCE and the runtime resolves it.
        clear_name, chunk = _auth_cache_clear(g)
        # 🔴 THE RUNTIME IS FOUND NEXT TO THE BINARY when $CLAUDIVERSE_RUNTIME is
        # unset: <dir of process.execPath>/patches.d/modules/cv-runtime.mjs.
        # Without this the binary is only usable by launch paths that set the
        # variable — and none do: cv-spawn.sh builds an explicit env prefix with
        # no pass-through, and hand-written tmux lines predate it. Swapping the
        # binary in would then give every restarted seat a healthy-looking TUI
        # and NO claudiverse, silently. Measured: process.execPath inside the
        # standalone binary is the binary's own path.
        # An explicit $CLAUDIVERSE_RUNTIME still wins. A binary copied somewhere
        # with no runtime beside it fails the import SILENTLY and runs as stock —
        # the load error is only printed when the variable was set on purpose.
        # 013 is opt-in by name: it is no HOOKS entry (it edits no module) and
        # an unnamed build — production — does not publish it.
        mode_ref = b""
        if names and "013-permission-mode" in names:
            mode_chunk, mode_name = _mode_setter(g)
            mode_ref = b'globalThis.__cvModeRef=["' + mode_chunk + b'","' + mode_name + b'"];'
            print(f"  013-permission-mode -> {mode_chunk.decode()} [{mode_name.decode()}]")
        boot = (b'globalThis.__cvClearRef=["' + chunk + b'","' + clear_name + b'"];' + mode_ref +
                b'try{let f=process.env.CLAUDIVERSE_RUNTIME,x=!f,p=process.execPath;'
                b'if(x)f=p.slice(0,p.lastIndexOf("/"))+"/patches.d/modules/cv-runtime.mjs";'
                b'import(f).catch(e=>{if(!x)try{process.stderr.write("cv-load-failed "+e.message+"\\n")}catch(_){}'
                b'})}catch(e){}')
        start, stop = banner_slab(ep.contents)
        pad = (stop - start) - len(boot) - 3
        if pad < 0:
            raise SystemExit("bootstrap does not fit in the entry banner")
        edits[ep.index] = (ep.contents[:start] + boot + b"//" + b" " * pad + b"\n"
                           + ep.contents[stop:])
        print(f"  bootstrap      -> module[{ep.index}] ({len(boot)}B)")

    for h in HOOKS:
        if names and h["name"] not in names:
            continue
        m = find_module(g, h["token"], h["name"])
        base = edits.get(m.index, m.contents)
        edits[m.index] = h["build"](base, g)
        print(f"  {h['name']:16} -> module[{m.index}]")

    raw = bytearray(g.raw)
    for i, new in edits.items():
        assert len(new) == len(g.modules[i].contents)
        off, ln = struct.unpack_from("<II", g.blob, g.modules_off + i * 52 + 8)
        raw[g.blob_start + off : g.blob_start + off + ln] = new
        if g.hashes_off is not None:
            # Or JSC matches the OLD source and runs the OLD bytecode: a hook
            # that is present in the file and never executes.
            struct.pack_into("<I", raw, g.blob_start + g.hashes_off + i * 4, 0)
    assert len(raw) == len(g.raw), "file size must not change"

    with open(out_path, "wb") as fh:
        fh.write(raw)
    subprocess.run(["chmod", "+x", out_path], check=True)
    r = subprocess.run(["codesign", "-f", "-s", "-", out_path],
                       capture_output=True, text=True)
    if r.returncode:
        raise SystemExit("codesign: " + r.stderr.strip())
    print(f"  wrote {out_path} ({len(edits)} module(s) edited, length-neutral)")


if __name__ == "__main__":
    args = sys.argv[1:]
    if "--suffix" in args:
        i = args.index("--suffix")
        VERSION_SUFFIX = args[i + 1].encode()
        if b'"' in VERSION_SUFFIX or b"\\" in VERSION_SUFFIX:
            raise SystemExit("--suffix must not contain quotes or backslashes")
        del args[i:i + 2]
    apply_hooks(args[0], args[1], names=args[2:] or None)
