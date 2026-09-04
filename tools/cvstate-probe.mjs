#!/usr/bin/env node
/**
 * cvstate probe — measures whether the SidecarClient fallback heartbeat ACTUALLY
 * FIRES, rather than reasoning that it should from source.
 *
 * WHY THIS EXISTS. The fallback covers the transport half of the unported
 * 010-cvstate-heartbeat gap. Two claims about it were, until now, code-reading
 * arguments and not measurements:
 *   1. it FIRES at all (a ~3s {type:"cvstate"} frame reaches the wire)
 *   2. the STAND-DOWN engages (it goes quiet when something else supplies
 *      cvstate, so a monolithic build with patch 010 does not get two emitters)
 * Two hypotheses died today from exactly that gap between reasoning and evidence,
 * so this stands the claims up on observed frames.
 *
 * It impersonates the claudiverse server: POST /api/sessions, then a Phoenix v2
 * WebSocket carrying `mirror_messages`. Nothing is written to the real fleet
 * server and no fleet session is touched.
 *
 * Usage:  node /tmp/cvstate-probe.mjs <port> <seconds>
 * Prints one line per received frame, then a verdict.
 */
import http from "http";
import crypto from "crypto";

const PORT = Number(process.argv[2] || 4599);
const SECS = Number(process.argv[3] || 20);
const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"; // RFC 6455

const seen = { cvstate: [], other: [] };
const t0 = Date.now();
const at = () => ((Date.now() - t0) / 1000).toFixed(1) + "s";

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (req.url.startsWith("/api/sessions")) {
      console.log(`[${at()}] POST ${req.url} ${body.slice(0, 120)}`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ session: { id: "probe-session-1" } }));
      return;
    }
    res.writeHead(404).end("{}");
  });
});

// --- minimal RFC6455 server frame decoder (client->server frames are masked) ---
function decodeFrames(buf, onText) {
  let off = 0;
  while (off + 2 <= buf.length) {
    const b1 = buf[off], b2 = buf[off + 1];
    const opcode = b1 & 0x0f;
    const masked = (b2 & 0x80) !== 0;
    let len = b2 & 0x7f;
    let p = off + 2;
    if (len === 126) { len = buf.readUInt16BE(p); p += 2; }
    else if (len === 127) { len = Number(buf.readBigUInt64BE(p)); p += 8; }
    let mask = null;
    if (masked) { mask = buf.slice(p, p + 4); p += 4; }
    if (p + len > buf.length) return buf.slice(off); // incomplete; keep remainder
    const payload = buf.slice(p, p + len);
    if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
    if (opcode === 1) onText(payload.toString("utf8"));
    off = p + len;
  }
  return buf.slice(off);
}

server.on("upgrade", (req, socket) => {
  const key = req.headers["sec-websocket-key"];
  const accept = crypto.createHash("sha1").update(key + GUID).digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\nConnection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  console.log(`[${at()}] WS upgraded`);

  let rest = Buffer.alloc(0);
  socket.on("data", (chunk) => {
    rest = decodeFrames(Buffer.concat([rest, chunk]), (text) => {
      let msg;
      try { msg = JSON.parse(text); } catch { return; }
      if (!Array.isArray(msg)) return;
      const [joinRef, ref, topic, event, payload] = msg;
      if (event === "phx_join") {
        // Reply so the client marks the channel joined and starts pushing.
        const reply = [joinRef, ref, topic, "phx_reply",
          { status: "ok", response: {} }];
        const data = Buffer.from(JSON.stringify(reply));
        const head = data.length < 126
          ? Buffer.from([0x81, data.length])
          : Buffer.concat([Buffer.from([0x81, 126]),
              (() => { const b = Buffer.alloc(2); b.writeUInt16BE(data.length); return b; })()]);
        socket.write(Buffer.concat([head, data]));
        console.log(`[${at()}] phx_join -> replied ok`);
        return;
      }
      if (event === "mirror_messages") {
        for (const m of payload.messages || []) {
          if (m.type === "cvstate") {
            seen.cvstate.push({ t: at(), idle: m.idle, hasTasks: "tasks" in m });
            console.log(`[${at()}] >>> cvstate  idle=${m.idle}  tasks-field=${"tasks" in m}`);
          } else {
            seen.other.push(m.type);
            console.log(`[${at()}]     ${m.type}`);
          }
        }
      }
    });
  });
  socket.on("error", () => {});
});

server.listen(PORT, () => console.log(`probe listening on ${PORT}, ${SECS}s`));

setTimeout(() => {
  const n = seen.cvstate.length;
  console.log("\n=== VERDICT ===");
  console.log(`cvstate frames received : ${n}`);
  console.log(`other frames            : ${seen.other.length} [${[...new Set(seen.other)].join(", ")}]`);
  if (n >= 2) {
    const gaps = [];
    for (let i = 1; i < seen.cvstate.length; i++) {
      gaps.push(+(parseFloat(seen.cvstate[i].t) - parseFloat(seen.cvstate[i - 1].t)).toFixed(1));
    }
    console.log(`inter-frame gaps (s)    : ${gaps.join(", ")}  (expect ~3.0)`);
    console.log("FIRES: YES");
  } else if (n === 1) {
    console.log("FIRES: ONCE ONLY — timer may not be repeating");
  } else {
    console.log("FIRES: NO");
  }
  process.exit(0);
}, SECS * 1000);
