// Session Hooks
// Foundational module — provides a callback registry for getSessionId().
// Other modules push their init callbacks here instead of patching getSessionId() directly.
//
// Usage from other modules:
//   __sessionHooks.push(function(sessionId) { __myModule.init(sessionId); });
//
// Callbacks receive Claude's own session UUID (passed through from
// getSessionId()). The sidecar reports it to the server so a reconnect REUSES
// its existing session row instead of inserting a new one on every blip.

var __sessionHooks = (function () {
  var callbacks = [];
  var hasRun = false;

  function push(fn) {
    callbacks.push(fn);
  }

  function runAll(sessionId) {
    if (hasRun) return;
    hasRun = true;
    for (var i = 0; i < callbacks.length; i++) {
      try {
        callbacks[i](sessionId);
      } catch (e) {
        try {
          require("fs").appendFileSync("/tmp/claude-session-hooks.log",
            new Date().toISOString() + " hook[" + i + "] error: " + e.message + "\n" + e.stack + "\n");
        } catch (e2) {}
      }
    }
  }

  return {
    push: push,
    runAll: runAll,
  };
})();

// Publish onto globalThis as well as the bare `var`.
//
// REQUIRED BY THE CHUNKED BUNDLE FORMAT (2.1.242+). A monolithic build
// concatenates every section into ONE shared scope, so a top-level `var` here
// is visible to every patched call site. A chunked build is a real ESM graph:
// this file becomes its own module and the `var` is MODULE-SCOPED, so patched
// call sites in other chunks see nothing at all. Because they guard with
// `typeof __sessionHooks !== 'undefined'`, that absence is SILENT — the hooks
// simply never fire and the build still reports success.
// Assigning to globalThis is a no-op on the monolithic path (the `var` already
// works there) and is what makes the chunked call sites resolve.
try {
  globalThis.__sessionHooks = __sessionHooks;
} catch (e) {}
