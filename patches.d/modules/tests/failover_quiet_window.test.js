// Regression test for the post-switch quiet window in SidecarClient.js.
//
// Run:  node patches.d/modules/tests/failover_quiet_window.test.js
// Takes ~25s: it waits out the real 20s quiet window once rather than mocking
// time, so the test exercises the same clock the code does.
//
// Drives the REAL module (loaded into the global context — hence the
// globalThis.require shim) against a fake pool server in a CHILD process. The
// child is not optional: the sidecar's startup lease is a synchronous curl that
// blocks this event loop, so an in-process server could never answer it.
//
// WHAT IT PINS (2026-09-18). A 429 inside the quiet window is attributed to the
// account just left. The sidecar must NOT report it (that would cool the
// account just switched to — the fleet-blocking bug the window exists for), and
// must NOT fall through to upstream either (that opened /rate-limit-options on
// two seats with the credential already on a healthy account). It must return
// retry:true, bounded, and the budget must reset on the next switch.
//
// POSITIVE CONTROL: against the pre-fix module this fails exactly the six
// retry checks and passes the rest — including "no extra reports", which is
// how we know the old code had the right diagnosis and the wrong remedy.
// Drives the REAL SidecarClient.js failover path against a fake pool server.
const http = require("http"), fs = require("fs"), vm = require("vm");
globalThis.require = require; // the sidecar is loaded into the global context, where require is not a global
const SRC = require("path").join(__dirname, "..", "SidecarClient.js");

const { spawn } = require("child_process");
const PORT = 40000 + Math.floor(Math.random() * 20000);
const pool = spawn(process.execPath, [__dirname + "/fake_pool.js", String(PORT)], { stdio: ["ignore", "pipe", "inherit"] });
const hitsNow = () => new Promise((res) => http.get("http://127.0.0.1:" + PORT + "/__hits", r => { let b=""; r.on("data", c => b+=c); r.on("end", () => res(JSON.parse(b))); }));
const hits = {};
pool.stdout.once("data", () => main());
async function main() {
  const port = PORT;
  process.env.CLAUDIVERSE_URL = "http://127.0.0.1:" + port;
  process.env.CLAUDIVERSE_TOKEN = "test-token";
  delete process.env.CLAUDIVERSE_DEBUG;            // must not touch /tmp/claudiverse.log
  process.env.CLAUDIVERSE_TITLE = "failover-unit";

  const stderr = [];
  const origWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (s) => { stderr.push(String(s)); return true; };

  vm.runInThisContext(fs.readFileSync(SRC, "utf8") + "\n;globalThis.__cvTest = __claudiverse;", { filename: "SidecarClient.js" });
  const cv = globalThis.__cvTest;
  process.stderr.write = origWrite;

  const results = [];
  const check = (label, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    results.push({ label, ok, got });
    console.log((ok ? "PASS " : "FAIL ") + label + "  ->", JSON.stringify(got));
  };

  Object.assign(hits, await hitsNow());
  console.log("startup: token env =", process.env.CLAUDE_CODE_OAUTH_TOKEN, " lease hits =", hits.lease);
  const TWO_HOURS = 2 * 3600 * 1000;

  // 1) a real limit on the current account: report + switch
  check("real 429 -> switched", await cv.failoverAnthropicAccount(TWO_HOURS, false), { switched: true });
  check("credential now Work", process.env.CLAUDE_CODE_OAUTH_TOKEN, "tok-work");
  Object.assign(hits, await hitsNow());
  const reportsAfterSwitch = hits.rate_limited;

  // 2) stale 429s inside the quiet window: RETRY, and never report
  for (let i = 1; i <= 5; i++)
    check(`stale 429 #${i} in window -> retry`, await cv.failoverAnthropicAccount(TWO_HOURS, false), { switched: false, retry: true });
  check("6th -> budget spent, falls through", await cv.failoverAnthropicAccount(TWO_HOURS, false), { switched: false });
  Object.assign(hits, await hitsNow());
  check("no extra rate_limited reports sent during window", hits.rate_limited - reportsAfterSwitch, 0);
  check("credential still Work (no churn)", process.env.CLAUDE_CODE_OAUTH_TOKEN, "tok-work");

  // 3) window expires -> a 429 is a real report again, and the budget resets
  console.log("waiting 21s for the quiet window to expire…");
  await new Promise(r => setTimeout(r, 21000));
  check("after window: real 429 -> switched (new report)", await cv.failoverAnthropicAccount(TWO_HOURS, false), { switched: true });
  Object.assign(hits, await hitsNow());
  check("exactly one more report", hits.rate_limited - reportsAfterSwitch, 1);
  check("budget reset: stale 429 -> retry again", await cv.failoverAnthropicAccount(TWO_HOURS, false), { switched: false, retry: true });

  const failed = results.filter(r => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  pool.kill();
  process.exit(failed ? 1 : 0);
}
