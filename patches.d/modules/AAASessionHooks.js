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
