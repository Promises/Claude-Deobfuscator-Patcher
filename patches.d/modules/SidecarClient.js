// Claudiverse Sidecar Client
// Injected as a custom module — initialized from _preamble.js
//
// Mirrors Claude Code sessions to a Phoenix server via WebSocket.
// If server is unreachable, Claude works normally — zero impact.
//
// Env vars:
//   CLAUDIVERSE_TOKEN  — API bearer token (required)
//   CLAUDIVERSE_URL    — Server base URL (default: http://localhost:4000)
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

  // State
  var ws = null;
  var currentJoinRef = null;
  var ref = 0;
  var channelJoined = false;
  var sessionTopic = null;
  var serverSessionId = null;
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

  function autoConnect() {
    if (!TOKEN || !http || connecting || connected) return;
    connecting = true;
    log("Creating session...");

    var postData = JSON.stringify({
      title: "Claude " + new Date().toLocaleTimeString()
    });
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
          if (topic === sessionTopic && channelJoined && structuredIO) {
            if (event === "remote_input" && payload && payload.content) {
              log("Remote input:", payload.content.substring(0, 50));
              structuredIO.prependUserMessage(payload.content);
            }
            if (event === "remote_permission_response" && payload && payload.request_id) {
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
        // Reconnect after 5s
        setTimeout(function() {
          if (TOKEN && serverSessionId) connectWs(serverSessionId);
        }, 5000);
      });

      ws.on("error", function(e) {
        log("WS error:", e.message);
        connecting = false;
      });
    } catch(e) {
      log("WS init error:", e.message);
      connecting = false;
    }
  }

  // --- Public API ---

  function mirrorMessage(msg) {
    if (!TOKEN) return;
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

  return {
    connect: autoConnect,
    mirrorMessage: mirrorMessage,
    setStructuredIO: setStructuredIO,
    isConnected: isConnected
  };
})();

// Register with session hooks (runs on first getSessionId call)
try { __sessionHooks.push(function() { __claudiverse.connect(); }); } catch(e) {}
