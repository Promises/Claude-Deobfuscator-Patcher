// Fake claudiverse pool server, run as its OWN process so the sidecar's
// synchronous startup lease (execSync curl) cannot deadlock it.
const http = require("http");
const hits = { lease: 0, rate_limited: 0, other: 0 };
http.createServer((req, res) => {
  let b = ""; req.on("data", c => b += c); req.on("end", () => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/__hits") return res.end(JSON.stringify(hits));
    if (req.url === "/api/anthropic_auths/lease") { hits.lease++;
      return res.end(JSON.stringify({ access_token: "tok-personal", auth_id: 3, label: "Personal" })); }
    if (/^\/api\/anthropic_auths\/\d+\/rate_limited$/.test(req.url)) { hits.rate_limited++;
      return res.end(JSON.stringify({ next: { access_token: "tok-work", auth_id: 4, label: "Work" } })); }
    hits.other++; res.statusCode = 404; res.end("{}");
  });
}).listen(Number(process.argv[2]), "127.0.0.1", () => console.log("ready"));
