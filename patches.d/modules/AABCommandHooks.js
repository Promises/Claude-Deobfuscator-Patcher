// Command Hooks
// Foundational module — provides a registry for custom slash commands.
// Other modules register commands here instead of patching commands.js directly.
//
// Usage from other modules:
//   __commandHooks.register({
//     name: 'my-command',
//     description: 'Does a thing',
//     call: async (args) => ({ type: 'text', value: 'result' })
//   });
//
// The patch on commands.js appends these to the built-in command list.

var __commandHooks = (function () {
  var commands = [];

  function register(cmd) {
    commands.push({
      type: "local",
      name: cmd.name,
      description: cmd.description || "",
      aliases: cmd.aliases || [],
      isEnabled: cmd.isEnabled || function () { return true; },
      isHidden: cmd.isHidden || false,
      supportsNonInteractive: cmd.supportsNonInteractive !== false,
      load: function () {
        return Promise.resolve({ call: cmd.call });
      },
    });
  }

  function getCommands() {
    return commands.slice();
  }

  return {
    register: register,
    getCommands: getCommands,
  };
})();
