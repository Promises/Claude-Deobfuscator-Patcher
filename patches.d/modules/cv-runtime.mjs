// Claudiverse runtime, loaded from disk by the in-binary bootstrap.
//
// WHY THIS IS A FILE AND NOT INJECTED CODE. From Claude Code 2.1.278 we can no
// longer rebuild the binary (the TUI calls Bun.ant.CellSegmenter, which exists
// only in Anthropic's private bun fork), so hooks are spliced into the binary
// they ship. Each splice must be LENGTH-NEUTRAL, paid for out of that module's
// ~600-byte licence banner — which the real logic could never fit in. So the
// binary carries thin guarded calls and everything substantial lives here.
//
// Loaded via `import($CLAUDIVERSE_RUNTIME)` from the entry module. With that
// variable unset nothing loads and every hook no-ops, so the binary is stock.
//
// ⚠️ EVERY EXPORT HERE IS A HOOK TARGET. The names are referenced from inside
// the binary by the injected call sites; renaming one silently disables that
// hook rather than breaking a build. Keep them in step with tools/cvinject.py.

// This seat is a claudiverse seat through the PATCHED runtime: the
// claudiverse-seat mod (mods/claudiverse-seat) reads this and stays inert, so
// a patched seat with the mod installed never registers or mirrors twice.
process.env.CLAUDIVERSE_PATCHED_RUNTIME = "1";

const log = (...a) => {
    if (!process.env.CLAUDIVERSE_DEBUG) return;
    try {
        require("fs").appendFileSync("/tmp/cv-runtime.log", a.join(" ") + "\n");
    } catch (e) {
        try {
            Bun.write(Bun.file("/tmp/cv-runtime.log"), a.join(" ") + "\n");
        } catch (_) {}
    }
};

// --- the sidecar (001 + the substance of 002) -------------------------------
// SidecarClient.js is 1,332 lines — the WebSocket client, session creation,
// remote input, account leasing. It could never fit in a banner, so in the
// in-place world it is simply imported here and publishes globalThis.
// __claudiverse and __claudiverseNoteUserPrompt itself.
//
// ⚠️ IMPORTED, NOT INLINED. It is CJS-shaped and calls require("http"),
// require("https"), require("fs"), require("ws"). Bun resolves those when it
// loads the file as its OWN module; pasting the text into this ESM file would
// leave `require` undefined, and every one of those calls is inside a
// try/catch, so the failure is SILENT — `http` stays undefined and autoConnect
// returns at `if (!TOKEN || !http ...)` having logged nothing. Measured as
// imported: reaches "WS open" and joins a real session.
// ⛔ NOT EVERY PROCESS FROM THIS BINARY IS A SEAT. From 2.1.280 an interactive
// seat spawns Claude Code's background daemon (`<bin> daemon run`), which keeps a
// pty host (`--bg-pty-host`) and a warm spare (`--bg-spare`) alive. They inherit
// the seat's environment — and with the self-locating default they would find
// this file anyway — so each one loaded the sidecar and registered a "session".
// None has a Claude session id, so every title push INSERTED a new row: three
// processes, one push every 30s, ~6,400 junk rows overnight (2026-09-23 20:31Z
// onward, all type=sidecar mode=json, titled "Claude <time>"). Skip the sidecar
// entirely in these processes; every hook then no-ops, as it would on stock.
// Known cost: a spare that gets CLAIMED by `claude --bg` is not mirrored. The
// fleet does not use --bg.
const cvBackground =
    process.argv.includes("--bg-spare") ||
    process.argv.includes("--bg-pty-host") ||
    (process.argv.includes("daemon") && process.argv.includes("run"));

try {
    if (cvBackground) log("background process, sidecar skipped:", process.argv.slice(1, 4).join(" "));
    else await import("./SidecarClient.js");
} catch (e) {
    try {
        process.stderr.write("cv: sidecar failed to load: " + e.message + "\n");
    } catch (_) {}
}

// --- 012: upstream's auth-credential cache clear ----------------------------
// The sidecar calls globalThis.__cvClearAuthCache after swapping the token, so
// the process stops serving the memoised old one. The binary cannot hand us the
// function — only a reference to it — for two measured reasons recorded in
// cvinject: an import list cannot be extended by editing its text, and none of
// the modules that already import it is evaluated on the interactive path.
//
// A bun standalone chunk IS importable by its virtual path, so we resolve it
// here. Done EAGERLY at load, not lazily inside the clear: the sidecar calls
// that synchronously and a dynamic import would resolve after the retry had
// already re-read the credential.
//
// ⚠️ This evaluates that chunk, possibly earlier than upstream otherwise would.
// It is a shared library chunk of definitions, and the alternative is a failover
// that swaps a token nothing picks up.
try {
    const [chunkPath, exportName] = globalThis.__cvClearRef || [];
    if (chunkPath) {
        const chunk = await import(chunkPath);
        if (typeof chunk[exportName] === "function") {
            globalThis.__cvClearAuthCache = chunk[exportName];
            log("authCacheClear resolved from", chunkPath);
        } else {
            log("authCacheClear MISSING export", exportName);
        }
    }
} catch (e) {
    log("authCacheClear resolve failed:", e.message);
}

// --- 001-session-hooks ------------------------------------------------------
// Hand Claude's OWN session UUID to the sidecar. The server matches on it and
// REUSES this session's row, so a reconnect no longer inserts a new one — that
// churn is what grew the table to ~38k rows and left same-title zombies.
//
// 🔴 THE HANDOFF RUNS IN BOTH DIRECTIONS, because the ordering is genuinely
// undetermined: the in-binary bootstrap does NOT await its import() of this
// file, so getSessionId() can fire either side of this module finishing. The
// hook site therefore also stashes the id in __cvSid, and we pick that up here
// if the call already happened. Latched, since getSessionId is a hot path.
let cvConnected = false;
function cvConnect(sessionId) {
    if (cvConnected) return;
    cvConnected = true;
    try {
        globalThis.__claudiverse?.connect?.(sessionId);
        log("connect", sessionId);
    } catch (e) {}
    // 012's 401-renewal leg. Registered HERE rather than at runtime load: the
    // registrar dereferences the root session, which does not exist that early.
    // By the time getSessionId has fired, it does.
    try {
        if (globalThis.__cvSetRefreshCb && globalThis.__claudiverse?.requestOAuthTokenRefresh) {
            globalThis.__cvSetRefreshCb(() =>
                globalThis.__claudiverse.requestOAuthTokenRefresh());
            log("oauth refresh callback registered");
        }
    } catch (e) {}
}
globalThis.__cvSession = cvConnect;
if (globalThis.__cvSid) cvConnect(globalThis.__cvSid);

// --- 002-structio ----------------------------------------------------------
// The sidecar needs a handle on StructuredIO to inject prompts in stream-json
// mode. The hook hands it over the first time a prompt is prepended.
globalThis.__cvSetIO = function (io) {
    globalThis.__claudiverseStructuredIO = io;
    try {
        globalThis.__claudiverse?.setStructuredIO?.(io);
        log("structIO set");
    } catch (e) {}
};

// --- 002-querytap ----------------------------------------------------------
// Wraps the async generator that query() delegates to, so every mirrored
// message passes through here on its way to the operator's stream.
//
// 🔴 MUST PRESERVE GENERATOR SEMANTICS EXACTLY. The call site is
// `g = yield* __cvTap(inner, params)`, so this has to forward the RETURN value
// as well as the yields — `g` is the turn's result and dropping it silently
// truncates the turn. It also has to forward `throw`/`return` inward, or an
// interrupted turn leaks the inner generator instead of unwinding it.
//
// ⛔ AUXILIARY QUERIES ARE NOT THE CONVERSATION. query() also serves internal
// side-requests — prompt suggestion, session titling, memory extraction — which
// run with skipTranscript and never reach the local transcript. Mirroring them
// put phantom assistant messages in claudiverse: the suggestion fork predicts
// what the OPERATOR would type, so the panel showed Claude saying "status?".
// This is upstream's own main/subagent/auxiliary split.
function isConversation(params) {
    const qs = params && params.querySource;
    if (typeof qs !== "string") return true;
    return (
        qs.startsWith("repl_main_thread") ||
        qs === "sdk" ||
        qs.startsWith("agent:") ||
        qs === "hook_agent"
    );
}

globalThis.__cvTap = async function* (inner, params) {
    const mirror = isConversation(params);
    let result;
    try {
        while (true) {
            const step = await inner.next();
            if (step.done) {
                result = step.value;
                break;
            }
            if (mirror) {
                try {
                    globalThis.__claudiverse?.mirrorMessage?.(step.value);
                    log("tap", step.value && step.value.type);
                } catch (e) {}
            }
            yield step.value;
        }
        if (mirror) {
            try {
                if (!params?.toolUseContext?.agentId) {
                    globalThis.__claudiverse?.mirrorMessage?.({ type: "turn_complete" });
                    log("tap turn_complete");
                }
            } catch (e) {}
        }
    } finally {
        // Unwind the inner generator on interrupt, or it is left suspended.
        try {
            if (typeof inner.return === "function") await inner.return(undefined);
        } catch (e) {}
    }
    return result;
};

// --- 003-inject ------------------------------------------------------------
// Remote input into the interactive REPL, plus draft preservation.
//
// `deps` is handed across by the hook because it is a PRIVATE class field —
// the runtime cannot reach it from outside the class body.
globalThis.__cvBindHost = function (controller, deps) {
    // The editor-helpers stub upstream passes to submit(). Supplying our own
    // here retires a whole hunk the patch route needed: it used to alias the
    // in-binary stub at its definition site because that identifier is renamed
    // EVERY release ($k -> iv -> Ey -> nm across four of them). An object of
    // no-ops is equivalent and cannot drift.
    const helpers = {
        setCursorOffset() {},
        clearBuffer() {},
        resetHistory() {},
    };

    globalThis.__claudiverseSubmit = (text) => {
        // 🔴 PRESERVE THE OPERATOR'S HALF-TYPED DRAFT. submit() clears it
        // whenever the seat is idle — exactly when someone is mid-sentence —
        // so a message arriving from claudiverse used to delete what they were
        // typing. Uses the draft store's OWN stash/popStash, which restores
        // value, cursor offset and pasted contents together.
        const draft = deps && deps.draft;
        let stashed = false;
        try {
            if (draft && draft.stashedPrompt === undefined && draft.value?.trim()) {
                draft.stash();
                stashed = true;
            }
        } catch (e) {}
        // Not awaited: every draft-clearing path runs in submit's synchronous
        // prefix, before its first await.
        const r = controller.submit(text, helpers);
        // Covers paths that return EARLY (an immediate local-jsx slash command,
        // which /model is) and so never reach submit's own stash-pop.
        try {
            if (stashed && draft.stashedPrompt !== undefined) draft.popStash("outside");
        } catch (e) {}
        return r;
    };

    // 🔴 WRAP submit ITSELF. A prompt TYPED in the terminal is never mirrored
    // otherwise — only the model's OUTPUT stream is, so the operator's own
    // words never reached claudiverse. submit is the one funnel both typed and
    // remote input pass through.
    if (!controller.__cvWrapped) {
        const orig = controller.submit.bind(controller);
        controller.submit = (text, ...rest) => {
            try {
                globalThis.__claudiverse?.noteUserPrompt?.(text);
                log("prompt", String(text).slice(0, 40));
            } catch (e) {}
            return orig(text, ...rest);
        };
        controller.__cvWrapped = true;
    }
    log("bindHost wired", typeof controller.submit, !!(deps && deps.draft));
};

// --- 007-remote-answer ------------------------------------------------------
// Let an orchestrator answer or decline an interactive AskUserQuestion. The
// contract is unchanged from the patch route:
//   __claudiverseListQuestions() -> [{toolUseId, questions}]
//   __claudiverseAnswer(toolUseId|null, payload) -> bool
//   __claudiverseDecline(toolUseId|null)         -> bool
// A null toolUseId targets the most recently opened question. `payload` merges
// into the tool input: {response:"text"} for freeform, or
// {answers:{[question]:"label,label"}} for a structured selection.
//
// The store is handed ACROSS by the hook rather than looked up, for the same
// reason 003 passes its deps: there is no module-scope binding to capture. The
// store is built by a factory called once from useState() in AppStateProvider
// and distributed through React context, so the only place it is reachable
// outside a render is inside the factory itself.
globalThis.__cvDialogStore = function (store) {
    const open = () =>
        store
            .getState()
            .open.filter((d) => d && d.kind === "permission_ask_user_question");
    const pick = (toolUseId) => {
        const o = open();
        return toolUseId
            ? o.find((d) => d.payload && d.payload.requestId === toolUseId)
            : o[o.length - 1];
    };
    globalThis.__claudiverseListQuestions = () =>
        open().map((d) => ({
            toolUseId: d.payload && d.payload.requestId,
            questions: d.payload && d.payload.questions,
        }));
    globalThis.__claudiverseAnswer = (toolUseId, answerPayload) => {
        const req = pick(toolUseId);
        if (!req) return false;
        // `behavior` is the one field the dialog result schema requires on
        // 2.1.280 — verified against the kind registry, not assumed.
        store.answer(req.id, {
            behavior: "allow",
            updatedInput: Object.assign({}, req.payload.input, answerPayload),
        });
        return true;
    };
    globalThis.__claudiverseDecline = (toolUseId) => {
        const req = pick(toolUseId);
        if (!req) return false;
        store.answer(req.id, { behavior: "deny" });
        return true;
    };
    log("dialogStore wired");
};

// --- 008-idle-signal + 010-cvstate-heartbeat --------------------------------
// The hook hands over the main-loop controller and its host once, at bindHost.
//
// 008 emits {type:"idle"} when the seat is at REST AND READY FOR INSTRUCTION —
// the signal turn_complete is NOT: turn_complete fires once per agentic run but
// still fires while a queued message will auto-continue, so events sent on it
// collide with in-flight work.
//
// 🔴 READINESS IS TASK-INDEPENDENT, ON PURPOSE. We use upstream's own
// `isMainLoopBusy` (isLoading || userInputOnProcessing || queue length > 0) and
// deliberately NOT any status derived from the task registry. A LINGERING or
// ZOMBIE background subagent pins a task-derived status busy forever, so the
// seat would sit at the prompt looking idle to a human and never emit an idle
// frame. Foreground subagents keep isLoading true for the whole turn, so they
// still register busy; only DETACHED background tasks stop pinning it — and 010
// reports those separately so they stay visible.
//
// 010 mirrors {type:"cvstate"} every 3s with the live readiness PLUS the exact
// non-terminal tasks. The server reconciles its idle flag from it, so a missed
// idle frame self-heals within ~3s, and a 13h-old "running" in_process_teammate
// is unmistakable next to a live foreground one that is seconds old.
const CV_TERMINAL_TASK = new Set(["completed", "failed", "killed"]);

// 🔴 STATE LIVES OUT HERE, NOT IN THE HOOK CLOSURE. bindHost is called on every
// re-render — measured 12 times in 12 seconds at a bare prompt. With the edge
// guard held in the callback's own closure each call got a FRESH wasReady=false
// and re-subscribed, so a motionless seat emitted 15 idle frames. Module scope
// makes the rising edge global and the subscription once-per-controller.
let cvMain = null;
let cvWasReady = false;
let cvIdleTimer = null;

function cvReady() {
    if (!cvMain) return false;
    try {
        // A blocking dialog means the seat waits on a human, not that it is
        // idle. Asked of the controller rather than recomputed: it owns this.
        if (cvMain.controller._isBlockingDialogOpen?.()) return false;
        return !cvMain.controller.isMainLoopBusy;
    } catch (e) {
        return false;
    }
}

function cvTasks() {
    try {
        const t = cvMain.host.store.getState().tasks;
        return Object.values(t || {})
            .filter((x) => x && !CV_TERMINAL_TASK.has(x.status))
            .map((x) => ({
                id: x.id,
                type: x.type,
                status: x.status,
                desc: x.description,
                ageMs: x.startTime ? Date.now() - x.startTime : null,
            }));
    } catch (e) {
        return [];
    }
}

// Debounced 400ms: an agent flickers between steps, and an idle frame emitted
// in the gap between two tool calls is a lie. Rising edge only — 010's
// heartbeat is what reconciles a frame that goes missing.
function cvSettle() {
    if (cvIdleTimer) {
        clearTimeout(cvIdleTimer);
        cvIdleTimer = null;
    }
    if (!cvReady()) {
        cvWasReady = false;
        return;
    }
    if (cvWasReady) return;
    cvIdleTimer = setTimeout(() => {
        cvIdleTimer = null;
        if (!cvReady() || cvWasReady) return;
        cvWasReady = true;
        try {
            globalThis.__claudiverse?.mirrorMessage?.({ type: "idle" });
            log("idle");
        } catch (e) {}
    }, 400);
}

globalThis.__cvMainLoop = function (controller, host) {
    // Always refresh — the host object is rebuilt on re-render, and a stale one
    // would make the heartbeat report another render's state.
    cvMain = { controller, host };

    if (!controller.__cvWiredML) {
        controller.__cvWiredML = true;
        try { controller.subscribe?.(cvSettle); } catch (e) {}
        try { host.messageQueue?.subscribe?.(cvSettle); } catch (e) {}
        try { host.dialogStore?.subscribe?.(cvSettle); } catch (e) {}
        log("mainLoop wired", typeof controller.isMainLoopBusy, !!host.messageQueue);
    }

    if (!globalThis.__cvHeartbeat) {
        globalThis.__cvHeartbeat = setInterval(() => {
            try {
                globalThis.__claudiverse?.mirrorMessage?.({
                    type: "cvstate",
                    idle: cvReady(),
                    tasks: cvTasks(),
                });
            } catch (e) {}
        }, 3000);
        // Or the heartbeat alone keeps the process alive after the REPL exits.
        try { globalThis.__cvHeartbeat.unref?.(); } catch (e) {}
    }

    cvSettle();
};

// --- 005-command-hooks ------------------------------------------------------
// A registry for custom slash commands. The hook wraps the memoised builtin
// command table so whatever is registered here is appended to it.
//
// ⚠️ NOTHING REGISTERS INTO THIS YET, AND THAT IS NOT AN OVERSIGHT. Its only
// historical consumers were /accounts and /account-reauth from patch 004
// (MultiAccountManager), which is DISABLED — account selection moved
// server-side into the sidecar's pool leasing, so both commands address state
// that no longer exists in this design. The mechanism is ported and live; it
// surfaces nothing until something calls register().
//
// The table is memoised with `??=`, so registrations must happen before the
// first slash-command lookup — i.e. at runtime load, which is where this is.
globalThis.__commandHooks = (function () {
    const commands = [];
    return {
        register(cmd) {
            commands.push({
                type: "local",
                name: cmd.name,
                description: cmd.description || "",
                aliases: cmd.aliases || [],
                isEnabled: cmd.isEnabled || (() => true),
                isHidden: cmd.isHidden || false,
                supportsNonInteractive: cmd.supportsNonInteractive !== false,
                load: () => Promise.resolve({ call: cmd.call }),
            });
        },
        getCommands: () => commands.slice(),
    };
})();

globalThis.__cvCommands = function (table) {
    try {
        const extra = globalThis.__commandHooks.getCommands();
        if (!extra.length) return table;
        log("commands appended", extra.length);
        return table.concat(extra);
    } catch (e) {
        // Never let this break the command table — a seat with no slash
        // commands at all is far worse than a seat missing ours.
        return table;
    }
};

log("runtime loaded", new Date().toISOString());
try {
    process.stderr.write("⚡ claudiverse runtime loaded\n");
} catch (e) {}
