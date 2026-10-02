// Claudiverse Sidecar Client
// Injected as a custom module — initialized from _preamble.js
//
// Mirrors Claude Code sessions to a Phoenix server via WebSocket.
// If server is unreachable, Claude works normally — zero impact.
//
// Env vars:
//   CLAUDIVERSE_TOKEN  — API bearer token (required)
//   CLAUDIVERSE_URL    — Server base URL (default: http://localhost:4000)
//   CLAUDIVERSE_TITLE  — Stable session name (e.g. "decomper"); default: timestamp
//   CLAUDIVERSE_DEBUG  — "1" for debug logging to /tmp/claudiverse.log

var __claudiverse = (function() {
  var WebSocket, http, https, fs;
  try { WebSocket = require("ws"); } catch(e) { try { WebSocket = globalThis.WebSocket; } catch(e2) {} }
  try { http = require("http"); } catch(e) {}
  try { https = require("https"); } catch(e) {}
  try { fs = require("fs"); } catch(e) {}

  var BASE_URL = process.env.CLAUDIVERSE_URL || "http://localhost:4000";
  var WS_URL = BASE_URL.replace(/^http/, "ws") + "/socket/websocket";
  // The token, with a fallback to the --mcp-config file.
  //
  // 🔑 A SEAT MAY NOT CARRY THE TOKEN IN ITS OWN ENVIRONMENT, ONLY IN ITS MCP
  // CONFIG — and the consequence of not finding it is SILENT: no lease, no
  // mirroring, and a seat that looks completely healthy while quietly running on
  // local credentials. MEASURED on watcher-2, which ran the new binary for hours
  // without ever leasing, because its launch script passed the token to the MCP
  // child only. The reasoning there was sound before the lease existed ("the seat
  // process does not need it; only the MCP child does") and simply stopped being
  // true when the seat itself became a consumer.
  //
  // ⚠️ watcher-2.sh has since been fixed to export it directly, so that script is
  // no longer an example of this — but the fallback stays. Any launcher written
  // against the old reasoning has the same silent failure, and nothing about a
  // seat's appearance reveals it. cv-spawn.sh reads the config with jq for the
  // same purpose; this is that idea in-process.
  function tokenFromMcpConfig() {
    try {
      if (!fs) return "";
      var argv = process.argv || [];
      for (var i = 0; i < argv.length; i++) {
        if (argv[i] !== "--mcp-config") continue;
        var cfgPath = argv[i + 1];
        if (!cfgPath) continue;
        var found = "";
        // Walk the whole object: the key sits under mcpServers.<name>.env, but
        // hunting a fixed path would break on any config shaped differently.
        (function walk(node) {
          if (found || !node || typeof node !== "object") return;
          if (typeof node.CLAUDIVERSE_TOKEN === "string" && node.CLAUDIVERSE_TOKEN) {
            found = node.CLAUDIVERSE_TOKEN;
            return;
          }
          for (var k in node) if (Object.prototype.hasOwnProperty.call(node, k)) walk(node[k]);
        })(JSON.parse(fs.readFileSync(cfgPath, "utf8")));
        if (found) return found;
      }
    } catch (e) {}
    return "";
  }

  var TOKEN = process.env.CLAUDIVERSE_TOKEN || tokenFromMcpConfig();
  var DEBUG = process.env.CLAUDIVERSE_DEBUG === "1";

  // --- Anthropic account pool (AnthropicAuths) --------------------------------
  //
  // Which account this process is currently running on. Needed so a 429 can
  // tell the server WHICH account hit the limit — otherwise it would cool the
  // wrong one, or cool nothing and hand back the same exhausted account.
  var leasedAuthId = null;

  // Don't switch for a short wait. If the current account frees up in under a
  // minute, waiting is cheaper than burning the fallback's headroom on a blip —
  // and upstream already handles a short rate limit gracefully. Carried over
  // from the previous disk-based implementation, where it was measured to be
  // the right call.
  var FAILOVER_THRESHOLD_MS = 60000;

  // Apply a leased credential to this process.
  //
  // Mutating process.env is what upstream itself does in its 401 recovery path
  // (recoverFromOAuth401 sets CLAUDE_CODE_OAUTH_TOKEN then clears caches), so
  // this is the sanctioned mechanism rather than a trick.
  //
  // 🔴 THIS DOES NOT INVALIDATE THE TOKEN CACHE — THE CALLER MUST.
  // An earlier version called `getClaudeAIOAuthTokens.cache.clear()` here. DEAD
  // CODE: that binding does not exist in this module's scope. It sat behind a
  // `typeof` guard, so it threw nothing, logged nothing, and simply never ran —
  // the env var would change while the process kept serving the OLD token from
  // the memo. A failover reporting success and changing nothing, which is the
  // failure shape this whole feature keeps producing.
  // On 2.1.263 the invalidator is `Hw()` (coreSchemas.js:35005 -> iH() ->
  // Use()), which IS in scope at the retry-loop patch site. The 401 path needs
  // no call: upstream's recoverFromOAuth401 runs Hw() itself immediately after
  // installing whatever the callback returned.
  function applyLease(body) {
    if (!body || !body.access_token) return false;
    process.env.CLAUDE_CODE_OAUTH_TOKEN = body.access_token;

    // 🔑 SET THE SCOPES TOO, or the session is quietly downgraded.
    // Upstream builds a synthetic credential record from the env var
    // (coreSchemas.js `Dfe`), and its `scopes` come from `x0()`, which falls
    // back to ["user:inference"] when CLAUDE_CODE_OAUTH_SCOPES is unset.
    // Everything gated on scopes.includes("user:profile") then refuses —
    // Remote Control, /code-review ultra — reporting the token as
    // "inference-only", even though the leased token genuinely carries
    // user:profile — the server requests the full set Claude Code itself asks
    // for (org:create_api_key, user:profile, user:inference,
    // user:sessions:claude_code, user:mcp_servers, user:file_upload).
    // These are the token's REAL scopes as returned by the exchange, not a
    // claim we invent; upstream populates the same variable the same way at
    // utils/managedEnvConstants.js:7125.
    if (body.scopes) {
      process.env.CLAUDE_CODE_OAUTH_SCOPES =
        Array.isArray(body.scopes) ? body.scopes.join(" ") : String(body.scopes);
    }

    leasedAuthId = body.auth_id != null ? body.auth_id : leasedAuthId;
    return true;
  }

  // --- what this seat is called ----------------------------------------------
  //
  // Claude Code ALREADY maintains a name for every session and publishes it to
  // ~/.claude/sessions/<pid>.json — a live registry it rewrites continuously,
  // carrying {name, nameSource, sessionId, cwd, status}. Reading that file is
  // strictly better than hooking the naming internals: it is a plain read with
  // no binding to re-anchor when upstream reshuffles, and upstream already
  // solves the hard part for us — cross-process name COLLISIONS, where a second
  // session wanting a taken name yields and takes a suffixed one.
  //
  // PRECEDENCE, most authoritative first:
  //   1. CLAUDIVERSE_TITLE  — absolute. Fleet seats (watcher, orchestrators,
  //      pe-*) must keep a FIXED name: cv_send resolves a seat BY TITLE, so a
  //      name that drifts with the conversation silently breaks addressing.
  //      This is why auto-naming can never be allowed to override it.
  //   2. registry name, nameSource "user"    — someone ran /rename or -n.
  //   3. registry name, nameSource "derived" — Claude auto-named it from the
  //      conversation ("fix-login-bug"). Fine for an ad-hoc seat, and it
  //      improves as the session takes shape.
  //   4. claudeSessionId — resolvable and unique, so an unnamed seat is still
  //      addressable and still joins to the server's claude_session_id.
  //   5. a timestamp — last resort only.
  //
  // ⛔ WHY NOT THE OLD TIMESTAMP DEFAULT. `"Claude " + toLocaleTimeString()`
  //    identifies nothing and COLLIDES: two seats started in the same second get
  //    the same name, and the server resolves titles for addressing. A session
  //    id cannot collide and can be resumed.
  //
  // ⚠️ THE REGISTRY IS NOT THERE AT STARTUP. Measured on three seats: the record
  //    appears some seconds after the process does (mtimes sat ~20s after start,
  //    and mtime is an upper bound on creation since the file is rewritten
  //    continuously). So the first lease is named by env or not at all, and the
  //    name is picked up later — which is what maybeRefreshTitle handles.
  function registryName() {
    try {
      if (!fs) return null;
      var home = process.env.HOME || "";
      if (!home) return null;
      var raw = fs.readFileSync(home + "/.claude/sessions/" + process.pid + ".json", "utf8");
      var rec = JSON.parse(raw);
      if (!rec) return null;
      return {
        name: typeof rec.name === "string" && rec.name ? rec.name : null,
        source: rec.nameSource || null,
        // The record carries Claude's session UUID too, and that is worth
        // having on its own: the sidecar's own claudeSessionId is NOT set yet
        // when a message is mirrored before the session hook fires.
        sessionId: typeof rec.sessionId === "string" && rec.sessionId ? rec.sessionId : null
      };
    } catch (e) {
      // Absent (too early), mid-write, or a layout change upstream. All mean
      // "no name from here"; none is worth a log line every few seconds.
      return null;
    }
  }

  // Set by the server pushing "set_title". Ranks BELOW the env var and above
  // everything Claude Code derives — see resolveTitle.
  var serverTitle = null;

  function resolveTitle() {
    var envTitle = process.env.CLAUDIVERSE_TITLE;
    if (envTitle) return envTitle;

    // ⚠️ SERVER OVERRIDE OUTRANKS THE REGISTRY BUT NOT THE ENV, and the reason
    // is that env WINS ANYWAY over time: a launcher re-applies CLAUDIVERSE_TITLE
    // on every restart, so a server override of a pinned seat would silently
    // revert on the next bounce and leave the operator chasing a name that
    // keeps coming back. Better that the pin is honest and the override is
    // refused than that it appears to work and does not.
    if (serverTitle) return serverTitle;

    var reg = registryName();
    if (reg && reg.name && reg.source !== "derived") return reg.name;

    // 🔴 A NAME THE OPERATOR GAVE THE SESSION OUTRANKS A DERIVED ONE. On a
    // --resume, 2.1.280 writes a freshly DERIVED name into the per-process
    // registry ("ps2-gc-re-f1", nameSource "derived") while the TUI shows the
    // conversation's own custom title, which the resume carried over. MEASURED
    // 2026-09-24: the operator's terminal read "claudiverse-account-failover"
    // and the seat registered as "ps2-gc-re-f1", so every watcher subscribed by
    // name silently lost it. The custom title is a {"type":"custom-title"}
    // record in the transcript, re-appended as the session runs.
    //
    // 🔴 LOOK IT UP BY THE REGISTRY'S SESSION ID FIRST. The 001 hook latches
    // the FIRST getSessionId(), and on --resume 2.1.280+ starts with a
    // placeholder id and switches to the resumed conversation moments later.
    // MEASURED 2026-09-25: claudeSessionId was the placeholder 0b39a4fb, whose
    // transcript does not exist, while the registry held the live 88c1861b —
    // so the lookup found nothing and the seat registered as "ps2-gc-re-51".
    // The registry follows the resume; claudeSessionId is the fallback.
    //
    // ⛔ ONLY THE LOOKUP USES IT — claudeSessionId itself is NOT replaced.
    // The server revives the NEWEST row carrying a given claude_session_id
    // (Sessions.find_reusable_session). This seat's row was created under the
    // placeholder, and the resumed id already owns older, STOPPED rows. Report
    // the resumed id and the next title push revives one of those old rows as
    // a second "running" seat with no live connection, while this seat stays
    // on its own row. Keeping the placeholder keeps every push on this row.
    var custom = (reg && reg.sessionId &&
                  readTranscriptRecord("custom-title", "customTitle", reg.sessionId)) ||
                 readTranscriptRecord("custom-title", "customTitle", claudeSessionId);
    if (custom) return custom;

    if (reg && reg.name) return reg.name;

    // 🔴 THE SESSION ID IS NOT RELIABLY OURS YET. mirrorMessage() calls
    // autoConnect() with NO ARGUMENT, so a message mirrored before the session
    // hook fires leaves claudeSessionId null — and that is the common case, not
    // an edge one. MEASURED: a seat launched without CLAUDIVERSE_TITLE
    // registered as "Claude 10:09:35 AM" rather than its id, because the hook
    // had not run. Falling back to the registry's copy of the same UUID closes
    // that window whenever the record exists.
    if (claudeSessionId) return claudeSessionId;
    if (reg && reg.sessionId) return reg.sessionId;

    // Last resort, and a poor one: this COLLIDES for two seats started in the
    // same second, and the server resolves seats by title. Anything above is
    // better; watchTitle() replaces it as soon as a real name appears.
    //
    // 🔴 COMPUTED ONCE, NEVER AGAIN. Recomputing it made the title "change" on
    // every 30s check, and checkTitle() re-POSTs on a change. With no
    // claudeSessionId the server cannot match the POST to the existing row, so
    // each push INSERTED A NEW SESSION. MEASURED 2026-09-23/24: three id-less
    // processes produced ~6,400 rows titled "Claude <time>" overnight.
    if (!fallbackTitle) fallbackTitle = "Claude " + new Date().toLocaleTimeString();
    return fallbackTitle;
  }
  var fallbackTitle = null;

  // --- the name a HUMAN recognises ------------------------------------------
  //
  // Claude Code runs TWO namers and they are not the same thing:
  //   name     ~/.claude/sessions/<pid>.json, kebab ("runejs-38"). Addressable:
  //            `--resume <name>` resolves it and upstream de-duplicates it
  //            across live processes. This is what resolveTitle uses.
  //   aiTitle  an {"type":"ai-title"} record appended to the transcript,
  //            sentence case ("Knights of Ni dialogue"). This is what the
  //            session picker shows, so it is the name the operator recognises.
  //
  // Both are wanted, for different jobs — one to ADDRESS a seat, one to
  // RECOGNISE it — so this is reported alongside the title rather than instead
  // of it.
  //
  // ⛔ TAIL-READ, NEVER THE WHOLE FILE. Transcripts reach 100MB+ (one on this
  //    machine is 102MB) and ai-title records are APPENDED, so the newest is at
  //    the end. Reading the whole file to find a display string would be a
  //    pathological cost on a hot-ish path.
  var DISPLAY_TAIL_BYTES = 262144;
  var displayTitleCache = null;

  function transcriptPath(sessionId) {
    try {
      var id = sessionId || claudeSessionId;
      if (!id) return null;
      var home = process.env.HOME || "";
      if (!home) return null;
      // Project dirs are the cwd with every "/" replaced by "-".
      var slug = String(process.cwd()).replace(/\//g, "-");
      return home + "/.claude/projects/" + slug + "/" + id + ".jsonl";
    } catch (e) {
      return null;
    }
  }

  // Last value of `field` in the last record of `type` within the transcript's
  // tail, or null. Records of both kinds used here are appended, and re-appended
  // as the session goes on, so the newest one is always near the end.
  function readTranscriptRecord(type, field, sessionId) {
    try {
      if (!fs) return null;
      var path = transcriptPath(sessionId);
      if (!path) return null;

      var st = fs.statSync(path);
      var start = Math.max(0, st.size - DISPLAY_TAIL_BYTES);
      var len = st.size - start;
      if (len <= 0) return null;

      var fd = fs.openSync(path, "r");
      var buf = Buffer.alloc(len);
      try {
        fs.readSync(fd, buf, 0, len, start);
      } finally {
        fs.closeSync(fd);
      }

      // Last occurrence wins: the title is re-generated as the session evolves.
      var text = buf.toString("utf8");
      var idx = text.lastIndexOf('"type":"' + type + '"');
      if (idx === -1) return null;
      var m = new RegExp('"' + field + '":"((?:[^"\\\\]|\\\\.)*)"').exec(text.slice(idx));
      if (!m) return null;
      return JSON.parse('"' + m[1] + '"');
    } catch (e) {
      // No transcript yet, mid-write, or a shape change upstream. Never let
      // the absence of a name disturb anything.
      return null;
    }
  }

  function readDisplayTitle() {
    return readTranscriptRecord("ai-title", "aiTitle");
  }

  // --- who is asking -----------------------------------------------------
  //
  // The pool's bearer token is SHARED by every seat, so a lease request carries
  // no identity: the server decides which account a seat gets and then cannot
  // say which seat got it. MEASURED — "which seat is on Work?" was unanswerable
  // three times in one day, and the fallback (correlating last_leased_at against
  // process start times) collapses the moment two seats start together, which is
  // exactly when workers come up.
  //
  // TWO PARTS, because neither alone is enough:
  //   title — CLAUDIVERSE_TITLE, the human-meaningful seat name ("pe-ceo"). Set
  //           on every seat, including cv-spawn workers (cv-spawn.sh:116). But
  //           it is NOT unique: a restarted seat reuses it, and two seats can be
  //           misconfigured onto the same one.
  //   id    — Claude's own session UUID. Unique, and the server already matches
  //           sessions on it (claude_session_id), so it joins straight to a row.
  //           NOT available during the startup lease, which runs before the
  //           session hook fires — hence a title that is always present and an
  //           id that fills in from the first switch onward.
  //
  // ⛔ ENCODED, NOT INTERPOLATED. A header value must be ASCII, and the fallback
  //    title is `"Claude " + toLocaleTimeString()` — spaces already, and a
  //    non-ASCII CLAUDIVERSE_TITLE would make Node THROW on the request rather
  //    than fail soft. encodeURIComponent also neutralises the "; " separator,
  //    so a title containing it cannot forge a second field.
  // 🔴 THE ONLY IDENTIFIER THAT EXISTS ON THE FIRST REQUEST AND NEVER CHANGES.
  //
  // Minted here, at module load, deliberately NOT derived from anything Claude
  // Code provides — because everything it provides arrives too late or moves:
  //   title  is resolved fresh on every call and CHANGES as the session is
  //          named; it is different at the startup lease than at session
  //          creation moments later.
  //   id     (Claude's session UUID) is null until the session hook fires,
  //          which is AFTER the startup lease.
  //
  // MEASURED, and this is why the field exists: a seat leased under
  // "Claude 11:41:02 AM" (pre-hook, no id) and created its session under its
  // UUID (post-hook) seconds later. The two records shared NO value, so the
  // server could never connect them — every later rename tried to match on a
  // title or an id that the other record had never held. Two attempts at fixing
  // the match order could not work, because the problem was that there was
  // nothing to match ON.
  var INSTANCE_ID = (function () {
    try {
      var c = require("crypto");
      if (c && typeof c.randomUUID === "function") return c.randomUUID();
    } catch (e) {}
    // Fallback for an environment without crypto: still unique enough, since it
    // only has to distinguish concurrent seats on one machine.
    return "i-" + process.pid + "-" + Date.now().toString(36) +
           "-" + Math.floor(Math.random() * 1e9).toString(36);
  })();

  function clientIdentity() {
    try {
      var title = resolveTitle() || "";
      var id = claudeSessionId || "";
      // instance is unconditional: it is the join key, and a request without it
      // is one the server cannot attribute to a seat.
      return "title=" + encodeURIComponent(title) +
             "; id=" + encodeURIComponent(id) +
             "; instance=" + encodeURIComponent(INSTANCE_ID);
    } catch (e) {
      return "";
    }
  }

  // Non-blocking POST. THE ONLY POST THIS MODULE MAKES AFTER STARTUP.
  //
  // 🔴 execSync BLOCKS THE ENTIRE NODE EVENT LOOP, AND THAT BROKE MCP.
  // upgradeAnthropicAccount runs from the WebSocket message handler, at an
  // arbitrary moment mid-session. Using postSync there stalled the process for
  // up to 10s while curl ran — during which nothing could service MCP stdio, so
  // the client timed out and the seat LOST ITS cv_* TOOLS.
  // MEASURED: the server pushed anthropic_auth_upgrade to every connected seat
  // at 14:40; watcher-2 reported losing its MCP tools. Its MCP child process was
  // still alive (pid 88450, parent = the seat), so the server did not crash —
  // the connection timed out because the parent went unresponsive.
  // The startup lease gets away with being synchronous only because it runs
  // BEFORE any MCP server exists. Nothing else does, so nothing else may block:
  // the failover, the upgrade and the 401 renewal all go through here.
  function postAsync(path, payload, cb) {
    try {
      var url = new URL(BASE_URL + path);
      var mod = url.protocol === "https:" ? https : http;
      if (!mod) return cb && cb(new Error("no http module"), null);
      var body = JSON.stringify(payload || {});
      var req = mod.request(
        {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname + url.search,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer " + TOKEN,
            "Content-Length": Buffer.byteLength(body),
            "X-Claudiverse-Client": clientIdentity(),
          },
          timeout: 8000,
        },
        function (res) {
          var data = "";
          res.on("data", function (c) { data += c; });
          res.on("end", function () {
            try { cb && cb(null, JSON.parse(data)); }
            catch (e) { cb && cb(e, null); }
          });
        }
      );
      req.on("error", function (e) { cb && cb(e, null); });
      req.on("timeout", function () { req.destroy(); cb && cb(new Error("timeout"), null); });
      req.write(body);
      req.end();
    } catch (e) {
      cb && cb(e, null);
    }
  }

  // Promise form, for callers that can await.
  function post(path, payload) {
    return new Promise(function (resolve, reject) {
      postAsync(path, payload, function (err, body) {
        if (err) reject(err); else resolve(body);
      });
    });
  }

  // --- mid-session failover, called from the API retry loop on a 429 ---------
  //
  // Returns { switched: bool }. The caller clears its own caches and `continue`s
  // the retry loop, so a switch costs one retry rather than a failed turn.
  //
  // 🔴 WHEN NOTHING IS AVAILABLE WE RETURN switched:false AND DO NOTHING ELSE.
  // That is deliberate: upstream already has a complete rate-limit path
  // (backoff, the "resets at" message, the retry schedule). Substituting our own
  // waiting would replace working behaviour with a worse copy. We only intervene
  // when we can actually help — i.e. when a different usable account exists.
  // 🔴 A 429 ARRIVING JUST AFTER A SWITCH USUALLY BELONGS TO THE OLD ACCOUNT.
  // Requests already in flight when we swap the credential come back 429 a
  // moment later, and the client has no per-request context — it can only
  // attribute them to whatever is leased NOW. So the report cools the account
  // we just switched TO.
  // MEASURED, first live failover: Personal (session 100%) 429'd, we switched to
  // Work correctly, and an in-flight 429 then cooled WORK — with PERSONAL's
  // 12:40 reset time — while Work sat at session 3% / weekly 0%. Both accounts
  // unavailable, and the pool blocked the whole fleet. A failover that disables
  // the account it just rescued you with.
  // A short quiet window after a switch is enough: in-flight requests land in
  // seconds, and a genuine limit on the new account will still 429 after it.
  var FAILOVER_QUIET_MS = 20000;
  var lastSwitchAt = 0;

  // 🔴 DECLINING TO REPORT IS NOT THE SAME AS DECLINING TO ACT.
  // The first version of the quiet window returned switched:false for an
  // in-flight 429, which the hook reads as "fall through to upstream". Upstream
  // then saw a 429 carrying the OLD account's limit headers and did exactly what
  // it does for a live limit: declared the session rate-limited, opened
  // /rate-limit-options and aborted the turn — with the credential ALREADY
  // swapped to an account that had two thirds of its week left.
  // MEASURED 2026-09-18 22:14 on two seats at once: Personal weekly_all 100% ->
  // "Switched to Work" -> "429 420ms after a switch … not reporting" -> dialog.
  // Server showed Work at session 27% / weekly 34%. The seats sat behind a
  // modal until the operator chose "Stop", at which point the very next request
  // went straight through on Work. Nothing was out of quota; the guard had the
  // right diagnosis and the wrong remedy.
  // A 429 attributed to the previous account is simply retried on the current
  // one — that is what a switch MEANS. Bounded, so that if the new account is
  // genuinely limited too we spend a handful of requests and then fall through
  // to upstream as before, rather than burning the retry budget in a tight loop.
  var RETRIES_PER_QUIET_WINDOW = 5;
  var retriesSinceSwitch = 0;

  // 🔴 THE QUIET WINDOW ONLY WORKS IF CONCURRENT 429s COALESCE.
  // This function is ASYNC (the hook site awaits it — see the patch note). That
  // is required so a failover does not block the event loop and stall MCP, but
  // it introduces a race the blocking version could not have: two requests
  // 429ing together both read lastSwitchAt BEFORE either sets it, both pass the
  // guard, and both POST a rate_limited report. The second lands after the
  // switch and cools the account we just moved to — the exact fleet-blocking
  // failure the quiet window exists to prevent, reintroduced by the fix for a
  // different bug.
  // So a failover in flight is shared, not repeated: the second caller awaits
  // the first one's result, which is also the right answer for it.
  var failoverInFlight = null;

  function failoverAnthropicAccount(resetDelayMs, isExtraUsage) {
    if (!TOKEN || !process.env.CLAUDE_CODE_OAUTH_TOKEN) return { switched: false };

    if (failoverInFlight) {
      log("429 while a failover is already in flight — joining it");
      return failoverInFlight;
    }

    var sinceSwitch = Date.now() - lastSwitchAt;
    if (lastSwitchAt && sinceSwitch < FAILOVER_QUIET_MS) {
      if (retriesSinceSwitch < RETRIES_PER_QUIET_WINDOW) {
        retriesSinceSwitch++;
        log("429 " + sinceSwitch + "ms after a switch — in-flight from the previous " +
            "account; retrying on the current one (" + retriesSinceSwitch + "/" +
            RETRIES_PER_QUIET_WINDOW + "), not reporting");
        // Not `switched`: nothing changed hands. The hook treats `retry` the
        // same way — clear the token cache and `continue` — which re-issues the
        // request on the credential the switch already installed.
        return { switched: false, retry: true };
      }
      log("429 " + sinceSwitch + "ms after a switch — retry budget spent; the new " +
          "account may be limited too, letting upstream handle it");
      return { switched: false };
    }

    // Short waits: sit them out rather than spend the fallback.
    if (!isExtraUsage && typeof resetDelayMs === "number" && resetDelayMs >= 0 && resetDelayMs < FAILOVER_THRESHOLD_MS) {
      log("rate limited, resets in " + resetDelayMs + "ms — under threshold, not switching");
      return { switched: false };
    }

    var resetsAt = typeof resetDelayMs === "number" && resetDelayMs > 0
      ? new Date(Date.now() + resetDelayMs).toISOString()
      : null;

    failoverInFlight = (leasedAuthId != null
      ? post("/api/anthropic_auths/" + leasedAuthId + "/rate_limited", {
          resets_at: resetsAt,
          reason: isExtraUsage ? "extra usage required for long context" : "rate limited (429)"
        })
      : post("/api/anthropic_auths/lease", {})
    ).then(function (body) {
      var next = body && body.next ? body.next : body;
      if (applyLease(next)) {
        lastSwitchAt = Date.now();
        retriesSinceSwitch = 0;
        clearAuthCache();
        var msg = "⚠ Switched to Anthropic account '" + (next.label || "?") + "'";
        log(msg);
        // stderr, not stdout: the user should SEE that the account changed —
        // a silent switch makes later usage numbers inexplicable.
        try { process.stderr.write("\n" + msg + "\n\n"); } catch (e) {}
        return { switched: true };
      }
      log("no account available" + (body && body.next_available_at ? ", next at " + body.next_available_at : ""));
      return { switched: false };
    }).catch(function (e) {
      // Server unreachable mid-session — fall through to upstream's own
      // handling rather than failing the turn on top of an existing failure.
      log("failover failed:", String((e && e.message) || e).slice(0, 120));
      return { switched: false };
    }).then(function (r) {
      failoverInFlight = null;
      return r;
    });

    return failoverInFlight;
  }

  // --- server-initiated upgrade back to a preferred account ------------------
  //
  // A failover is one-way on its own: a session that switched to Work stays on
  // Work forever, because nothing re-checks. Meanwhile Personal — the preferred
  // account, and the only one with a SESSION limit rather than just a weekly one
  // — comes back within hours and sits unused. The weekly quotas then diverge:
  // measured 44% on Personal against 1% on Work while Personal was the one being
  // exhausted daily.
  //
  // So the server tells us when a better account is available and we re-lease.
  // Server-push rather than client-poll: the server already knows the moment a
  // cooldown lapses, and N seats polling for it would be N times the work to
  // learn something one party already knows.
  //
  // ⚠️ NOT a switch to whatever is offered — we re-lease and compare. The lease
  // returns the highest-priority usable account, so if we are ALREADY on it,
  // nothing happens. That keeps the decision in one place (the server's ordering)
  // instead of duplicating priority logic here where it could drift.
  //
  // 🔴 THIS ONE IS ASYNC, AND THAT IS NOT A STYLE CHOICE — A SYNC VERSION BROKE
  // MCP. It used postSync, which blocks the Node event loop for the duration of
  // the curl. Unlike the startup lease, this runs at an ARBITRARY moment: the
  // server pushes it the instant a cooldown lapses, to every connected seat at
  // once. A seat holding an in-flight MCP request goes unresponsive for up to
  // 10s and the client gives up on the server. MEASURED: the 14:40 upgrade push
  // went out and watcher-2 lost its cv_* tools; its MCP child (pid 88450) was
  // still alive under the seat, so nothing crashed — the PARENT stopped
  // answering. Nothing here needs the result synchronously; the WebSocket
  // handler discards it.
  function upgradeAnthropicAccount() {
    if (!TOKEN || !process.env.CLAUDE_CODE_OAUTH_TOKEN) return;

    postAsync("/api/anthropic_auths/lease", {}, function (err, body) {
      if (err) {
        log("upgrade failed:", String((err && err.message) || err).slice(0, 120));
        return;
      }
      if (!body || !body.access_token) return;

      if (body.auth_id != null && body.auth_id === leasedAuthId) {
        log("upgrade offered but already on " + (body.label || "?"));
        return;
      }

      var prev = leasedAuthId;
      if (applyLease(body)) {
        // Same quiet window as a failover: an in-flight 429 from the account we
        // just left must not be blamed on the one we just took.
        lastSwitchAt = Date.now();
        retriesSinceSwitch = 0;
        clearAuthCache();
        var msg = "⚠ Moved to preferred Anthropic account '" + (body.label || "?") + "'";
        log(msg + " (was auth " + prev + ")");
        try { process.stderr.write("\n" + msg + "\n\n"); } catch (e) {}
      }
    });
  }

  // Invalidate the memoized credential record.
  //
  // 🔑 The real invalidator (Hw() on 2.1.263) is NOT in this module's scope — an
  // earlier version called a binding that does not exist here and silently did
  // nothing for every swap. The patch registers it on globalThis instead, so the
  // one place that can clear the cache is reachable from the one place that
  // changes the token.
  function clearAuthCache() {
    try {
      if (typeof globalThis.__cvClearAuthCache === "function") {
        globalThis.__cvClearAuthCache();
        return true;
      }
      log("WARNING: no cache invalidator registered — token swap may not take effect");
    } catch (e) {}
    return false;
  }

  // --- token renewal, wired to upstream's SDK refresh callback --------------
  //
  // Fires from recoverFromOAuth401 when there is no local refresh token — which
  // is exactly our state, because CLAUDE_CODE_OAUTH_TOKEN implies refreshToken:
  // null. Upstream then installs whatever we return and clears its caches, so
  // this only has to fetch.
  //
  // The SERVER refreshes; we never hold a refresh token. A plain lease is the
  // right call because the server hands back the highest-priority usable
  // account with a currently-valid token — so this recovers from an expired
  // token AND from an account that went cold since we leased it.
  // Returns a PROMISE, and upstream is fine with that: recoverFromOAuth401 does
  // `let s = await n()` (utils/auth.js:9671), so a thenable is awaited exactly
  // like a value. Worth using — see the postAsync note: blocking the event loop
  // here would stall MCP the same way the upgrade push did, and a 401 recovery
  // fires at an arbitrary moment mid-session.
  // Resolve to null rather than rejecting on failure: upstream treats null as
  // its documented "no token available" branch and logs at debug, whereas a
  // throw is logged as an error at oauth_401_sdk_callback_failed. Not having a
  // spare account is a normal state, not a fault.
  function requestOAuthTokenRefresh() {
    if (!TOKEN) return null;
    return new Promise(function (resolve) {
      postAsync("/api/anthropic_auths/lease", {}, function (err, body) {
        if (err) {
          log("token renewal failed:", String((err && err.message) || err).slice(0, 120));
          return resolve(null);
        }
        if (body && body.access_token) {
          leasedAuthId = body.auth_id != null ? body.auth_id : leasedAuthId;
          log("renewed Anthropic token from pool:", body.label || "?");
          return resolve(body.access_token);
        }
        resolve(null);
      });
    });
  }

  // --- Anthropic account lease (AnthropicAuths) ------------------------------
  //
  // Any session connected to claudiverse takes its Anthropic credentials from
  // the server pool. Not just runner-spawned workers — a hand-launched seat, a
  // long-lived watcher, anything with CLAUDIVERSE_TOKEN set.
  //
  // Setting CLAUDE_CODE_OAUTH_TOKEN is the ENTIRE mechanism. Upstream, that env
  // var makes getClaudeAIOAuthTokens() return a record with refreshToken:null,
  // so refreshOAuthTokenWithLock returns 'no_refresh_token' and NEVER posts to
  // Anthropic. The server becomes the only refresher, with no patch to upstream
  // code at all. MEASURED: a bogus value gives "401 OAuth access token is
  // invalid" and does NOT fall back to the keychain, so precedence holds.
  //
  // 🔴 THIS MUST BE SYNCHRONOUS, and that is the whole reason it looks like
  // this. getClaudeAIOAuthTokens is MEMOIZED and reads process.env on its FIRST
  // call. An async lease races the first API request; if the local keychain
  // still holds valid credentials the request simply succeeds on them, the
  // memo is filled, and the pool is silently never used. The failure mode of
  // getting this wrong is not an error — it is everything appearing to work
  // while the feature does nothing.
  //
  // Costs one curl (~100ms) at startup, once, and only when connected.
  function leaseAnthropicAccount() {
    // An explicitly provided token always wins — someone set it on purpose, and
    // it is also what lets a spawn wrapper pre-lease during a transition.
    if (process.env.CLAUDE_CODE_OAUTH_TOKEN) return;
    if (!TOKEN || !BASE_URL) return;

    try {
      var execSync = require("child_process").execSync;
      // Identity here carries the TITLE ONLY: this runs before the session hook,
      // so claudeSessionId is still null. That is the intended shape — the seat
      // is named from its first request, and the id fills in from the first
      // switch onward. Emitted only when non-empty so an unnamed seat sends no
      // half-formed header.
      var ident = clientIdentity();
      var identArg = ident ? " -H " + JSON.stringify("X-Claudiverse-Client: " + ident) : "";
      var out = execSync(
        "curl -sS -m 6 -X POST " +
          JSON.stringify(BASE_URL + "/api/anthropic_auths/lease") +
          " -H " + JSON.stringify("Authorization: Bearer " + TOKEN) +
          identArg +
          " -H 'Content-Type: application/json' -d '{}'",
        { encoding: "utf8", timeout: 8000, stdio: ["ignore", "pipe", "ignore"] }
      );
      var body = JSON.parse(out);
      if (body && body.access_token) {
        applyLease(body);
        log("leased Anthropic account:", body.label || "(unlabelled)",
            "scopes:", process.env.CLAUDE_CODE_OAUTH_SCOPES || "(default)");
      } else if (body && body.error) {
        // Pool reachable but nothing to give — every account cooling down, or
        // none enrolled. Fall through to local credentials rather than refusing
        // to start: a human at a terminal should not be blocked by pool state,
        // and the local keychain account is usually one of the pooled ones
        // anyway, so it will fail at the API with a real rate-limit message
        // rather than a confusing startup abort.
        log("account lease unavailable:", body.error, body.next_available_at || "");
      }
    } catch (e) {
      // Server down, curl missing, malformed JSON — all mean "no pool today".
      // NEVER let this break startup: the pool is an enhancement, and a seat
      // that cannot reach claudiverse must still run exactly as it does today.
      log("account lease skipped:", String((e && e.message) || e).slice(0, 120));
    }
  }

  // State
  var ws = null;
  var currentJoinRef = null;
  var ref = 0;
  var channelJoined = false;
  var sessionTopic = null;
  var serverSessionId = null;
  // Claude's own session UUID (from the session hook). Stable across
  // reconnects — the server uses it to reuse this session's row.
  var claudeSessionId = null;
  // Single pending reconnect. Without this, every orphaned socket's close
  // handler schedules its own reconnect and sockets MULTIPLY instead of being
  // replaced (observed: 16,000+ ESTABLISHED sockets, ephemeral-port
  // exhaustion, all outbound TCP failing with EADDRNOTAVAIL).
  var reconnectTimer = null;
  var structuredIO = null;
  var messageQueue = [];
  var heartbeatTimer = null;
  var connecting = false;
  var connected = false;

  // --- Helpers ---

  function log() {
    if (DEBUG && fs) {
      try {
        fs.appendFileSync("/tmp/claudiverse.log", Array.from(arguments).join(" ") + "\n");
      } catch(e) {}
    }
  }

  function nextRef() { return String(++ref); }

  // Phoenix V2 protocol: [join_ref, ref, topic, event, payload]
  function send(joinRef, topic, event, payload) {
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify([joinRef, nextRef(), topic, event, payload]));
    }
  }

  function pushChannel(event, payload) {
    if (sessionTopic && channelJoined) {
      send(currentJoinRef, sessionTopic, event, payload);
    }
  }


  // --- adopting Claude Code's name once it exists -----------------------------
  //
  // A seat launched without CLAUDIVERSE_TITLE starts life named by its session
  // id, because the registry record does not exist yet (see resolveTitle). It
  // gets a real name later — auto-derived from the conversation, or from
  // /rename — and the server should follow, or the panel keeps showing a UUID
  // for a session everyone else calls "fix-login-bug".
  //
  // 🔑 NO NEW SERVER SURFACE. Re-POSTing /api/sessions with the same
  // claude_session_id UPDATES the existing row rather than inserting: the server
  // reuses it and lets incoming attrs win ("title/cwd/model may legitimately
  // have changed across a relaunch" — Sessions.create_session/1). start_room is
  // idempotent too, mapping {:already_started, pid} to {:ok, pid}, so a repeat
  // POST cannot 500. Verified in both before relying on it.
  //
  // ⛔ NEVER FOR AN ENV-NAMED SEAT. CLAUDIVERSE_TITLE is how the fleet addresses
  //    watcher and the orchestrators; letting an auto-derived name overwrite it
  //    would break cv_send addressing silently. Those seats never poll at all.
  var titleWatchTimer = null;
  var lastPushedTitle = null;

  function watchTitle() {
    if (process.env.CLAUDIVERSE_TITLE) return;   // pinned by the operator
    if (titleWatchTimer) return;

    // 30s: a name appears within seconds of startup and then changes rarely, so
    // this is a slow poll of one small local file, not a hot loop. Deliberately
    // NOT tied to the 3s cvstate heartbeat — that would be 20x the file reads
    // for a value that moves once or twice in a session's life.
    // An early check as well as the slow poll. A seat that registered under the
    // timestamp is publishing a COLLIDING name until it is replaced, so the
    // first correction should not wait a full interval; after that a name
    // changes rarely and 30s is plenty.
    setTimeout(checkTitle, 5000).unref?.();

    titleWatchTimer = setInterval(checkTitle, 30000);
    if (titleWatchTimer && typeof titleWatchTimer.unref === "function") {
      titleWatchTimer.unref();
    }
  }

  function checkTitle() {
      try {
        if (!serverSessionId) return;
        var next = resolveTitle();
        var disp = readDisplayTitle();
        // Either name changing is worth a push: the addressable one because
        // orchestration resolves on it, the display one because it is what a
        // human is reading in the panel.
        if ((!next || next === lastPushedTitle) && disp === displayTitleCache) return;
        if (disp) displayTitleCache = disp;
        if (!next) return;
        // Re-POST is the update path. Reuse autoConnect's own request by simply
        // recording and letting the next reconnect carry it would be wrong —
        // a stable session never reconnects, so the name would never land.
        pushTitle(next);
      } catch (e) {}
  }

  // Where this seat runs and how it was started, for the app's machine
  // picker, fleet grouping and runner filter (server: sessions.host/fleet/
  // origin). Launchers set the env: cv-spawn exports origin=spawn, cv-runner
  // origin=runner, both with the fleet. A hand-started seat is "manual".
  function seatPlacement() {
    var host = process.env.CLAUDIVERSE_HOST;
    if (!host) {
      try { host = require("os").hostname(); } catch (e) {}
    }
    return {
      host: host || undefined,
      fleet: process.env.CLAUDIVERSE_FLEET || undefined,
      origin: process.env.CLAUDIVERSE_ORIGIN || "manual",
      // May this seat ask for the operator (cv_request_human)? Sent as "1" or
      // "0" every time, so a seat relaunched without the opt-in loses it.
      notify: process.env.CLAUDIVERSE_NOTIFY === "1" ? "1" : "0"
    };
  }

  function pushTitle(title) {
    var placement = seatPlacement();
    var body = JSON.stringify({
      title: title,
      claude_session_id: claudeSessionId || undefined,
      display_title: displayTitleCache || undefined,
      host: placement.host,
      fleet: placement.fleet,
      origin: placement.origin,
      notify: placement.notify
    });
    try {
      var url = new URL(BASE_URL + "/api/sessions");
      var mod = url.protocol === "https:" ? https : http;
      if (!mod) return;
      var req = mod.request({
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + TOKEN,
          "Content-Length": Buffer.byteLength(body),
          "X-Claudiverse-Client": clientIdentity()
        },
        timeout: 5000
      }, function (res) {
        res.resume();
        if (res.statusCode >= 200 && res.statusCode < 300) {
          lastPushedTitle = title;
          log("title is now:", title);
        }
      });
      req.on("error", function () {});
      req.on("timeout", function () { req.destroy(); });
      req.write(body);
      req.end();
    } catch (e) {}
  }

  function startHeartbeat() {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(function() {
      send(null, "phoenix", "heartbeat", {});
    }, 30000);
  }

  // --- Connection ---

  function autoConnect(sessionId) {
    // Remember Claude's session UUID on the first call that supplies it; later
    // reconnects reuse it even if invoked without an argument.
    if (sessionId) claudeSessionId = sessionId;
    if (!TOKEN || !http || connecting || connected) return;
    connecting = true;
    log("Creating session...");

    // The title an orchestrator resolves this seat by, via
    // GET /api/sessions?title=. See resolveTitle() for the precedence —
    // CLAUDIVERSE_TITLE wins absolutely, then Claude Code's own session name,
    // then the session id. It can CHANGE after this point, because a seat that
    // starts unnamed gets auto-named once the conversation takes shape; that is
    // what watchTitle() below is for.
    // claude_session_id is Claude's OWN session UUID. The server matches on it
    // and REUSES the existing row, so a reconnect/blip no longer inserts a new
    // session every time (that churn grew the table to ~38k rows and left
    // same-title zombies that title-resolution could wake).
    var postBody = {
      title: resolveTitle()
    };
    // Display-only; the server keeps it beside the title rather than as one.
    var disp = readDisplayTitle();
    if (disp) {
      postBody.display_title = disp;
      displayTitleCache = disp;
    }
    if (claudeSessionId) postBody.claude_session_id = claudeSessionId;
    var placement = seatPlacement();
    if (placement.host) postBody.host = placement.host;
    if (placement.fleet) postBody.fleet = placement.fleet;
    postBody.origin = placement.origin;
    postBody.notify = placement.notify;
    var postData = JSON.stringify(postBody);
    var parsed = new URL(BASE_URL + "/api/sessions");
    var mod = parsed.protocol === "https:" ? https : http;

    var req = mod.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + TOKEN,
        "Content-Length": Buffer.byteLength(postData),
        // Same identity as the pool calls, so the server can read it in ONE
        // place (the auth plug) for every request rather than per-endpoint.
        "X-Claudiverse-Client": clientIdentity()
      },
      timeout: 3000
    }, function(res) {
      var body = "";
      res.on("data", function(chunk) { body += chunk; });
      res.on("end", function() {
        try {
          var data = JSON.parse(body);
          if (data.session && data.session.id) {
            serverSessionId = data.session.id;
            log("Session:", serverSessionId);
            // Whatever title we just registered under is, by definition, the
            // one the server now holds — record it so the watcher only pushes
            // an actual CHANGE rather than re-POSTing the same value forever.
            lastPushedTitle = resolveTitle();
            connectWs(serverSessionId);
            // Only meaningful once a session exists, and a no-op for a seat
            // pinned by CLAUDIVERSE_TITLE.
            watchTitle();
          } else {
            log("No session in response:", body);
            connecting = false;
          }
        } catch(e) {
          log("Parse error:", e.message);
          connecting = false;
        }
      });
    });

    req.on("error", function(e) { log("HTTP error:", e.message); connecting = false; });
    req.on("timeout", function() { req.destroy(); connecting = false; });
    req.write(postData);
    req.end();
  }

  function connectWs(sessionId) {
    sessionTopic = "session:" + sessionId;
    log("WS connecting...");

    // A pending reconnect is now superseded — cancel it so we never end up with
    // two reconnect chains running in parallel.
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }

    // TEAR DOWN THE PREVIOUS SOCKET FIRST. Reassigning `ws` used to orphan the
    // old socket while it was still OPEN, and its listeners stayed live — so the
    // orphan's own close handler would schedule yet another reconnect. Removing
    // the listeners before closing stops that chain.
    if (ws) {
      try { ws.removeAllListeners(); } catch (e) {}
      try { ws.close(); } catch (e) {}
      ws = null;
    }

    try {
      var url = WS_URL + "?token=" + encodeURIComponent(TOKEN) + "&vsn=2.0.0";
      ws = new WebSocket(url);

      ws.on("open", function() {
        log("WS open");
        currentJoinRef = nextRef();
        send(currentJoinRef, sessionTopic, "phx_join", { role: "sidecar" });
        startHeartbeat();
      });

      ws.on("message", function(raw) {
        try {
          var msg = JSON.parse(typeof raw === "string" ? raw : raw.toString());
          if (!Array.isArray(msg) || msg.length < 4) return;

          // V2: [join_ref, ref, topic, event, payload]
          var jRef = msg[0], mRef = msg[1], topic = msg[2], event = msg[3], payload = msg[4] || {};

          // Handle join reply
          if (topic === sessionTopic && event === "phx_reply" && !channelJoined) {
            if (payload && payload.status === "ok") {
              channelJoined = true;
              connected = true;
              connecting = false;
              log("Joined! Flushing", messageQueue.length, "messages");
              if (messageQueue.length > 0) {
                pushChannel("mirror_messages", { messages: messageQueue });
                messageQueue = [];
              }
            }
          }

          // Handle remote commands
          if (topic === sessionTopic && channelJoined) {
            if (event === "anthropic_auth_upgrade") {
              log("server signalled a preferred account is available");
              upgradeAnthropicAccount();
            }
            // Rename this seat from the server — the remote counterpart of
            // CLAUDIVERSE_TITLE, for fixing a seat that came up misnamed
            // without restarting it.
            if (event === "set_title" && payload && typeof payload.title === "string") {
              var wanted = payload.title.trim();
              if (!wanted) {
                log("set_title ignored: empty title");
              } else if (process.env.CLAUDIVERSE_TITLE) {
                // Refused LOUDLY rather than silently. A pinned seat would
                // revert on its next restart, so accepting this would be a
                // change that quietly undoes itself.
                log("set_title refused: CLAUDIVERSE_TITLE=" +
                    process.env.CLAUDIVERSE_TITLE + " is pinned by the launcher");
              } else {
                serverTitle = wanted;
                // Push immediately rather than waiting for the poll: this is an
                // operator action and should land now.
                if (serverSessionId && wanted !== lastPushedTitle) pushTitle(wanted);
                log("set_title accepted:", wanted);
              }
            }
            if (event === "remote_input" && payload && payload.content) {
              log("Remote input:", payload.content.substring(0, 50));
              try {
                if (typeof globalThis.__claudiverseSubmit === "function") {
                  // Interactive Ink REPL: submit exactly like a local Enter
                  // (idle -> starts a turn; busy -> enqueues and drains).
                  globalThis.__claudiverseSubmit(payload.content);
                } else if (structuredIO) {
                  // stream-json / SDK input mode.
                  structuredIO.prependUserMessage(payload.content);
                } else {
                  log("Remote input dropped: no submit hook / structuredIO yet");
                }
              } catch (e) {
                log("Remote input error:", e.message);
              }
            }
            if (event === "remote_answer" && payload) {
              // Resolve an interactive AskUserQuestion. payload: { tool_use_id?,
              // response? | answer? }. response -> freeform "The user responded:";
              // answer is a structured {answers,annotations,response} merge.
              try {
                var ap = payload.answer || (payload.response ? { response: payload.response } : {});
                var ok = (typeof globalThis.__claudiverseAnswer === "function")
                  ? globalThis.__claudiverseAnswer(payload.tool_use_id || null, ap)
                  : false;
                log("Remote answer:", ok, JSON.stringify(ap).substring(0, 80));
              } catch (e) {
                log("Remote answer error:", e.message);
              }
            }
            if (event === "remote_decline" && payload) {
              try {
                if (typeof globalThis.__claudiverseDecline === "function")
                  globalThis.__claudiverseDecline(payload.tool_use_id || null);
              } catch (e) {
                log("Remote decline error:", e.message);
              }
            }
            if (event === "remote_permission_response" && payload && payload.request_id && structuredIO) {
              log("Remote permission:", payload.request_id, payload.decision);
              var resp;
              if (payload.decision === "allow") {
                resp = {
                  type: "control_response",
                  response: { subtype: "success", request_id: payload.request_id, response: {} }
                };
              } else {
                resp = {
                  type: "control_response",
                  response: { subtype: "error", request_id: payload.request_id, error: "Remote user denied" }
                };
              }
              structuredIO.injectControlResponse(resp);
            }
          }
        } catch(e) {
          log("WS message error:", e.message);
        }
      });

      ws.on("close", function() {
        log("WS closed");
        channelJoined = false;
        connected = false;
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        // Reconnect after 5s — but only ONE pending reconnect at a time.
        if (!reconnectTimer) {
          reconnectTimer = setTimeout(function() {
            reconnectTimer = null;
            if (TOKEN && serverSessionId) connectWs(serverSessionId);
          }, 5000);
        }
      });

      ws.on("error", function(e) {
        log("WS error:", e.message);
        connecting = false;
        // An errored socket may never emit "close"; close it explicitly so the
        // fd is released rather than lingering as an ESTABLISHED orphan.
        try { this.close(); } catch (e2) {}
      });
    } catch(e) {
      log("WS init error:", e.message);
      connecting = false;
    }
  }

  // --- Public API ---

  // --- cvstate fallback heartbeat -------------------------------------------
  //
  // WHY HERE AND NOT IN THE REPL. Patch 010 emits {type:"cvstate"} every ~3s
  // from inside the REPL, reading four locals (status, isLoading, messageQueue,
  // tasks). On the CHUNKED format (2.1.242+) those are minified names inside
  // numbered React-Compiler memo-cache slots with nothing semantic to key on, so
  // 010 is NOT PORTED there — see patches.d/chunked/README.md. That matters
  // because server room.ex has exactly TWO paths to Router.went_idle: patch
  // 008's "idle" event (:377) and 010's cvstate reconcile (:311). With 010 gone
  // a missed idle frame never clears — the seat stays busy, cv_send
  // (reject-busy) bounces forever, and cv_status cannot diagnose it because
  // polling makes the CALLER busy. Unrecoverable without a restart.
  //
  // This module is OUR code, so it carries ZERO minified names and cannot drift
  // with a release.
  //
  // 🔴 IT IS NOT EQUIVALENT TO 010, AND THAT DIFFERENCE IS THE POINT:
  //   010  COMPUTES idle from REPL state -> heals a missed EMISSION *and* a lost
  //                                         message.
  //   this RE-ASSERTS the last SEEN idle -> heals a LOST MESSAGE only. If patch
  //                                         008 never fired at all, there is
  //                                         nothing to re-assert and this stays
  //                                         silent.
  // It closes the transport half of the gap, not the emission half. Do NOT
  // record it as "010 ported".
  //
  // TASKS ARE DELIBERATELY OMITTED. 010 carries a task snapshot; nothing here
  // can see one. The server defaults the field to [] and log_task_change
  // (room.ex:326) explicitly does NOT record an event when tasks are empty and
  // were already empty — so omitting is BLIND, never a false "tasks changed".
  // Asserting a fabricated task list would be exactly the lying-heartbeat hazard
  // that got 010 declined, and a false healthy is worse than a visible absence.
  var cvIdle = false;
  var foreignCvstateAt = 0;
  var emittingOwnCvstate = false;
  var cvstateTimer = null;

  // Self-configuring: if something else (patch 010, on the monolithic build) is
  // already supplying cvstate we SEE it here and stand down, so no flag has to
  // pass between the patch and this module and the same file is correct on both
  // formats.
  function noteMirrored(msg) {
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "cvstate") {
      if (!emittingOwnCvstate) foreignCvstateAt = Date.now();
      return; // never let a heartbeat flip the flag it is reporting
    }
    cvIdle = msg.type === "idle";
  }

  function startCvstateFallback() {
    if (cvstateTimer) return;
    cvstateTimer = setInterval(function () {
      try {
        // A real REPL heartbeat beats every ~3s; 10s of silence means none.
        if (Date.now() - foreignCvstateAt < 10000) return;
        emittingOwnCvstate = true;
        mirrorMessage({ type: "cvstate", idle: cvIdle });
      } catch (e) {
      } finally {
        emittingOwnCvstate = false;
      }
    }, 3000);
    // Must never hold the process open.
    if (cvstateTimer && typeof cvstateTimer.unref === "function") {
      cvstateTimer.unref();
    }
  }

  // --- the operator's own words ----------------------------------------------
  //
  // 🔴 TYPED INPUT WAS NEVER MIRRORED. The sidecar mirrors Claude Code's OUTPUT
  // stream, and the operator's prompt is not in it. MEASURED with a probe typed
  // into the TUI: Claude Code's own Remote Control rendered it as a user turn,
  // and it appeared in NONE of the 180 messages claudiverse had. Every session
  // in the panel was therefore half a conversation — replies with nothing to
  // reply to — and no amount of rendering could recover what was never sent.
  //
  // Patch 003 wraps PromptSubmitController.submit, the single funnel both the
  // REPL (typed) and __claudiverseSubmit (remote) pass through, and calls this.
  var lastUserPrompt = null;

  function noteUserPrompt(text) {
    try {
      if (typeof text !== "string" || !text.trim()) return;
      lastUserPrompt = text;
      mirrorMessage({ type: "user", message: { role: "user", content: text } });
    } catch (e) {}
  }

  // ⛔ REMOTE INPUT IS ECHOED BACK AS AN ASSISTANT MESSAGE, and that echo is
  //    indistinguishable from a real reply — same outer keys, same block shape,
  //    same usage object (measured on a live session, where an injected prompt
  //    was recorded as something Claude said). Now that submit reports the
  //    prompt properly, the echo would render the same words TWICE: once
  //    correctly as the operator, once wrongly as Claude.
  //    Dropping it here is safe because the comparison is exact and scoped to
  //    the prompt we just saw go out.
  function isEchoOfLastPrompt(msg) {
    try {
      if (!lastUserPrompt || !msg || msg.type !== "assistant") return false;
      var blocks = (msg.message && msg.message.content) || [];
      if (blocks.length !== 1 || blocks[0].type !== "text") return false;
      return blocks[0].text === lastUserPrompt;
    } catch (e) {
      return false;
    }
  }

  function mirrorMessage(msg) {
    if (!TOKEN) return;
    if (isEchoOfLastPrompt(msg)) return;
    noteMirrored(msg);
    if (!connected && !connecting) autoConnect();
    if (channelJoined) {
      pushChannel("mirror_messages", { messages: [msg] });
    } else {
      messageQueue.push(msg);
      if (messageQueue.length > 500) messageQueue.shift();
    }
  }

  function setStructuredIO(sio) {
    if (!structuredIO) {
      structuredIO = sio;
      log("StructuredIO captured");
    }
  }

  function isConnected() { return connected; }

  if (TOKEN) log("Token found, will connect on first message");

  // 🔴 SAY SOMETHING WHEN THE SEAT IS CONFIGURED BUT TOKENLESS.
  // A seat with no claudiverse settings at all is deliberately disconnected and
  // must stay silent. But one carrying CLAUDIVERSE_URL or CLAUDIVERSE_TITLE and
  // NO token is a MISCONFIGURATION: it will mirror nothing and lease nothing,
  // while looking completely healthy from outside.
  // That is not hypothetical — watcher-2 ran the new binary for hours on local
  // credentials because its token lives only in the MCP config, and the only
  // way to notice was `ps eww` on the right pid. Debug logging would not have
  // helped either: it is off by default, so the one place this was recorded was
  // a file nobody was writing to.
  // stderr, once, at startup — the cheapest place a human actually looks.
  if (!TOKEN && (process.env.CLAUDIVERSE_URL || process.env.CLAUDIVERSE_TITLE)) {
    try {
      process.stderr.write(
        "\nclaudiverse: configured but NO TOKEN found — not mirroring, not leasing an " +
          "Anthropic account. Set CLAUDIVERSE_TOKEN, or pass --mcp-config with one.\n\n"
      );
    } catch (e) {}
  }
  // Runs at module init, BEFORE any API call can memoize the credential lookup.
  // See the comment on leaseAnthropicAccount for why this cannot be async.
  leaseAnthropicAccount();
  if (TOKEN) startCvstateFallback();

  return {
    connect: autoConnect,
    mirrorMessage: mirrorMessage,
    setStructuredIO: setStructuredIO,
    isConnected: isConnected,
    // Mid-session account switching. Called from the API retry loop on a 429
    // (failover) and from upstream's SDK refresh callback on a 401 (renewal).
    // Both end at the same place: ask claudiverse for a usable credential.
    failoverAnthropicAccount: failoverAnthropicAccount,
    requestOAuthTokenRefresh: requestOAuthTokenRefresh,
    upgradeAnthropicAccount: upgradeAnthropicAccount,
    noteUserPrompt: noteUserPrompt
  };
})();

// Publish onto globalThis as well as the bare `var` — see the same note in
// AAASessionHooks.js. On the CHUNKED format (2.1.242+) this file is its own ESM
// module, so `var __claudiverse` is module-scoped and invisible to the patched
// call sites in other chunks; those sites are `try`-guarded, so without this the
// mirroring is silently absent. No-op on the monolithic path.
// 🔴 SAY WHAT THIS BUILD CANNOT DO. A binary built from a partially ported
// patch set compiles, runs and reports the right version while the missing
// hooks simply never fire — invisible from the outside, and this project has
// shipped that failure before. 013-unwired-features sets the list; builds with
// a complete patch set set nothing and this logs nothing.
try {
  if (Array.isArray(globalThis.__claudiverseUnwired) && globalThis.__claudiverseUnwired.length) {
    var __cvMissing = "\u26a0 claudiverse: features NOT wired in this binary: " +
      globalThis.__claudiverseUnwired.join(", ");
    try { log(__cvMissing); } catch (e) {}
    try { process.stderr.write("\n" + __cvMissing + "\n\n"); } catch (e) {}
  }
} catch (e) {}

try {
  globalThis.__claudiverse = __claudiverse;
  // Patch 003 wraps PromptSubmitController.submit and calls this for every
  // prompt, typed or injected. Registered as its own global rather than reached
  // through __claudiverse, so the patch site stays a one-line call that cannot
  // break on a shape change in this module.
  globalThis.__claudiverseNoteUserPrompt = __claudiverse.noteUserPrompt;
} catch (e) {}

// Register with session hooks (runs on first getSessionId call).
// The hook passes Claude's own session UUID; we forward it to the server so a
// reconnect reuses this session's row rather than creating another.
//
// Reads __sessionHooks THROUGH globalThis with a bare-var fallback: this is a
// CROSS-MODULE reference on the chunked format, where the other file's `var`
// does not reach here. Ordering is not a concern in either format —
// AAASessionHooks sorts first (AAA…) in the monolithic concat, and on the
// chunked path both modules are imported by the entry before any hook can run.
try {
  var __cvHooks =
    (typeof globalThis !== 'undefined' && globalThis.__sessionHooks) ||
    (typeof __sessionHooks !== 'undefined' ? __sessionHooks : null);
  __cvHooks.push(function (sessionId) {
    __claudiverse.connect(sessionId);
  });
} catch (e) {}
