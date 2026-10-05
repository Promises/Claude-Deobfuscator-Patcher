// Mock Anthropic API for the seeded-429 failover gate: 429 for tok-personal,
// a minimal streamed answer for anything else. Records the token per request.
const http = require("http");
const seen = [];
http.createServer((req, res) => {
  let b = ""; req.on("data", c => b += c); req.on("end", () => {
    if (req.url === "/__seen") { res.setHeader("content-type", "application/json"); return res.end(JSON.stringify(seen)); }
    const tok = (req.headers["authorization"] || req.headers["x-api-key"] || "").replace(/^Bearer /, "");
    if (!req.url.startsWith("/v1/messages") || req.url.includes("count_tokens")) { res.statusCode = 200; res.setHeader("content-type", "application/json"); return res.end("{}"); }
    seen.push(tok);
    if (tok === "tok-personal") {
      res.writeHead(429, { "content-type": "application/json", "retry-after": "0",
        "anthropic-ratelimit-unified-status": "rejected",
        "anthropic-ratelimit-unified-reset": String(Math.floor(Date.now() / 1000) + 3600) });
      return res.end(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "seeded 429" } }));
    }
    let stream = false; try { stream = JSON.parse(b).stream; } catch {}
    const msg = { id: "msg_mock", type: "message", role: "assistant", model: "claude-mock", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } };
    if (!stream) { res.setHeader("content-type", "application/json"); return res.end(JSON.stringify({ ...msg, content: [{ type: "text", text: "MOCK-OK" }], stop_reason: "end_turn" })); }
    res.writeHead(200, { "content-type": "text/event-stream" });
    const ev = (t, d) => res.write(`event: ${t}\ndata: ${JSON.stringify(d)}\n\n`);
    ev("message_start", { type: "message_start", message: msg });
    ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "MOCK-OK" } });
    ev("content_block_stop", { type: "content_block_stop", index: 0 });
    ev("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } });
    ev("message_stop", { type: "message_stop" });
    res.end();
  });
}).listen(Number(process.argv[2]), "127.0.0.1", () => console.log("ready"));
