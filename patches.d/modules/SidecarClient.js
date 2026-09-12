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
  var TOKEN = process.env.CLAUDIVERSE_TOKEN || "";
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
  // this is the sanctioned mechanism rather than a trick. The cache clear is
  // NOT optional: getClaudeAIOAuthTokens is memoized, so without it the process
  // keeps serving the old token from the memo and the swap does nothing.
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
    // user:profile (we request org:create_api_key + user:profile +
    // user:inference at authorize time).
    // These are the token's REAL scopes as returned by the exchange, not a
    // claim we invent; upstream populates the same variable the same way at
    // utils/managedEnvConstants.js:7125.
    if (body.scopes) {
      process.env.CLAUDE_CODE_OAUTH_SCOPES =
        Array.isArray(body.scopes) ? body.scopes.join(" ") : String(body.scopes);
    }

    leasedAuthId = body.auth_id != null ? body.auth_id : leasedAuthId;
    try {
      if (typeof getClaudeAIOAuthTokens !== "undefined" && getClaudeAIOAuthTokens.cache && getClaudeAIOAuthTokens.cache.clear) {
        getClaudeAIOAuthTokens.cache.clear();
      }
    } catch (e) {}
    return true;
  }

  // One synchronous POST to claudiverse. Sync for the same reason the startup
  // lease is: the retry loop reads the result immediately and cannot await.
  function postSync(path, payload) {
    var execSync = require("child_process").execSync;
    var out = execSync(
      "curl -sS -m 8 -X POST " + JSON.stringify(BASE_URL + path) +
        " -H " + JSON.stringify("Authorization: Bearer " + TOKEN) +
        " -H 'Content-Type: application/json' -d " + JSON.stringify(JSON.stringify(payload || {})),
      { encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "ignore"] }
    );
    return JSON.parse(out);
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
  function failoverAnthropicAccount(resetDelayMs, isExtraUsage) {
    if (!TOKEN || !process.env.CLAUDE_CODE_OAUTH_TOKEN) return { switched: false };

    // Short waits: sit them out rather than spend the fallback.
    if (!isExtraUsage && typeof resetDelayMs === "number" && resetDelayMs >= 0 && resetDelayMs < FAILOVER_THRESHOLD_MS) {
      log("rate limited, resets in " + resetDelayMs + "ms — under threshold, not switching");
      return { switched: false };
    }

    try {
      var resetsAt = typeof resetDelayMs === "number" && resetDelayMs > 0
        ? new Date(Date.now() + resetDelayMs).toISOString()
        : null;
      var body = leasedAuthId != null
        ? postSync("/api/anthropic_auths/" + leasedAuthId + "/rate_limited", {
            resets_at: resetsAt,
            reason: isExtraUsage ? "extra usage required for long context" : "rate limited (429)"
          })
        : postSync("/api/anthropic_auths/lease", {});

      var next = body && body.next ? body.next : body;
      if (applyLease(next)) {
        var msg = "⚠ Switched to Anthropic account '" + (next.label || "?") + "'";
        log(msg);
        // stderr, not stdout: the user should SEE that the account changed —
        // a silent switch makes later usage numbers inexplicable.
        try { process.stderr.write("\n" + msg + "\n\n"); } catch (e) {}
        return { switched: true };
      }

      log("no account available" + (body && body.next_available_at ? ", next at " + body.next_available_at : ""));
      return { switched: false };
    } catch (e) {
      // Server unreachable mid-session — fall through to upstream's own
      // handling rather than failing the turn on top of an existing failure.
      log("failover failed:", String((e && e.message) || e).slice(0, 120));
      return { switched: false };
    }
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
  function requestOAuthTokenRefresh() {
    if (!TOKEN) return null;
    try {
      var body = postSync("/api/anthropic_auths/lease", {});
      if (body && body.access_token) {
        leasedAuthId = body.auth_id != null ? body.auth_id : leasedAuthId;
        log("renewed Anthropic token from pool:", body.label || "?");
        return body.access_token;
      }
    } catch (e) {
      log("token renewal failed:", String((e && e.message) || e).slice(0, 120));
    }
    return null;
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
      var out = execSync(
        "curl -sS -m 6 -X POST " +
          JSON.stringify(BASE_URL + "/api/anthropic_auths/lease") +
          " -H " + JSON.stringify("Authorization: Bearer " + TOKEN) +
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

    // CLAUDIVERSE_TITLE gives this instance a stable, human-friendly name
    // (e.g. "decomper" / "tester") so an orchestrator can resolve it by title
    // via GET /api/sessions?title=. Falls back to a timestamp when unset.
    // claude_session_id is Claude's OWN session UUID. The server matches on it
    // and REUSES the existing row, so a reconnect/blip no longer inserts a new
    // session every time (that churn grew the table to ~38k rows and left
    // same-title zombies that title-resolution could wake).
    var postBody = {
      title: process.env.CLAUDIVERSE_TITLE || ("Claude " + new Date().toLocaleTimeString())
    };
    if (claudeSessionId) postBody.claude_session_id = claudeSessionId;
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
        "Content-Length": Buffer.byteLength(postData)
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
            connectWs(serverSessionId);
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

  function mirrorMessage(msg) {
    if (!TOKEN) return;
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
    requestOAuthTokenRefresh: requestOAuthTokenRefresh
  };
})();

// Publish onto globalThis as well as the bare `var` — see the same note in
// AAASessionHooks.js. On the CHUNKED format (2.1.242+) this file is its own ESM
// module, so `var __claudiverse` is module-scoped and invisible to the patched
// call sites in other chunks; those sites are `try`-guarded, so without this the
// mirroring is silently absent. No-op on the monolithic path.
try {
  globalThis.__claudiverse = __claudiverse;
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
