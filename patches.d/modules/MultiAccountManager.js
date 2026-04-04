// Multi-Account Manager
// Injected as a custom module — manages multiple Anthropic accounts with failover.
//
// Stores account registry in global config alongside existing oauthAccount.
// On 429 quota exhaustion, switches to next available account automatically.
//
// Env vars:
//   CLAUDE_MULTI_ACCOUNT_DEBUG — "1" for debug logging to /tmp/claude-multi-account.log

var __multiAccount = (function () {
  var fs;
  try {
    fs = require("fs");
  } catch (e) {}

  var DEBUG = process.env.CLAUDE_MULTI_ACCOUNT_DEBUG === "1";
  var FAILOVER_THRESHOLD_MS = 60000; // only switch if retry-after > 60s
  var DEFAULT_COOLDOWN_MS = 300000; // 5 min default cooldown

  // ── Runtime state (not persisted, resets each session) ──

  var activeAccountId = null;
  var registry = null;
  var credentialStore = {};
  var listeners = [];

  // ── Logging ──

  function log(msg) {
    if (!DEBUG || !fs) return;
    try {
      fs.appendFileSync(
        "/tmp/claude-multi-account.log",
        new Date().toISOString() + " " + msg + "\n"
      );
    } catch (e) {}
  }

  // ── UUID generation ──

  function uuid() {
    var crypto;
    try {
      crypto = require("crypto");
      return crypto.randomUUID();
    } catch (e) {}
    // fallback
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(
      /[xy]/g,
      function (c) {
        var r = (Math.random() * 16) | 0;
        return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
      }
    );
  }

  // ── Registry persistence ──
  // These are stubs — the patch wires them to config.js's getGlobalConfig/saveGlobalConfig

  var _getGlobalConfig = null;
  var _saveGlobalConfig = null;
  var _secureStorageRead = null;
  var _secureStorageUpdate = null;

  function bindConfig(getGlobalConfig, saveGlobalConfig) {
    _getGlobalConfig = getGlobalConfig;
    _saveGlobalConfig = saveGlobalConfig;
    log("Config bound");
  }

  function bindSecureStorage(readFn, updateFn) {
    _secureStorageRead = readFn;
    _secureStorageUpdate = updateFn;
    log("Secure storage bound");
  }

  // ── Registry CRUD ──

  function loadRegistry() {
    if (registry) return registry;
    if (!_getGlobalConfig) {
      log("Config not bound, returning empty registry");
      return null;
    }
    var config = _getGlobalConfig();
    if (config && config.accountRegistry) {
      registry = config.accountRegistry;
      log("Loaded registry: " + registry.accounts.length + " accounts");
      return registry;
    }
    // Migration: synthesize from single oauthAccount if present
    if (config && config.oauthAccount && config.oauthAccount.accountUuid) {
      var entry = {
        id: uuid(),
        label: "default",
        type: "oauth",
        accountUuid: config.oauthAccount.accountUuid,
        emailAddress: config.oauthAccount.emailAddress || null,
        organizationUuid: config.oauthAccount.organizationUuid || null,
      };
      registry = {
        version: 1,
        primaryAccountId: entry.id,
        accounts: [entry],
      };
      saveRegistry();
      log("Migrated single account to registry: " + entry.id);
      return registry;
    }
    return null;
  }

  function saveRegistry() {
    if (!_saveGlobalConfig || !registry) return;
    _saveGlobalConfig(function (config) {
      return Object.assign({}, config, { accountRegistry: registry });
    });
    log("Registry saved");
  }

  function getAccounts() {
    var reg = loadRegistry();
    return reg ? reg.accounts.slice() : [];
  }

  function addAccount(entry) {
    var reg = loadRegistry();
    if (!reg) {
      reg = { version: 1, primaryAccountId: null, accounts: [] };
      registry = reg;
    }
    var account = Object.assign({ id: uuid() }, entry);
    reg.accounts.push(account);
    if (!reg.primaryAccountId) {
      reg.primaryAccountId = account.id;
    }
    saveRegistry();
    log("Added account: " + account.label + " (" + account.id + ")");
    return account;
  }

  function removeAccount(idOrLabel) {
    var reg = loadRegistry();
    if (!reg) return false;
    var idx = findAccountIndex(idOrLabel);
    if (idx === -1) return false;
    var removed = reg.accounts.splice(idx, 1)[0];
    // Clean up credentials
    deleteCredentials(removed.id);
    // Fix primary if removed
    if (reg.primaryAccountId === removed.id) {
      reg.primaryAccountId = reg.accounts.length > 0 ? reg.accounts[0].id : null;
    }
    // Reset active if removed
    if (activeAccountId === removed.id) {
      activeAccountId = null;
    }
    saveRegistry();
    log("Removed account: " + removed.label);
    return true;
  }

  function setPrimary(idOrLabel) {
    var reg = loadRegistry();
    if (!reg) return false;
    var idx = findAccountIndex(idOrLabel);
    if (idx === -1) return false;
    reg.primaryAccountId = reg.accounts[idx].id;
    saveRegistry();
    log("Set primary: " + reg.accounts[idx].label);
    return true;
  }

  function reorderAccounts(orderedIdsOrLabels) {
    var reg = loadRegistry();
    if (!reg) return false;
    var reordered = [];
    for (var i = 0; i < orderedIdsOrLabels.length; i++) {
      var idx = findAccountIndex(orderedIdsOrLabels[i]);
      if (idx === -1) return false;
      reordered.push(reg.accounts[idx]);
    }
    // Append any accounts not in the order list
    for (var j = 0; j < reg.accounts.length; j++) {
      var found = false;
      for (var k = 0; k < reordered.length; k++) {
        if (reordered[k].id === reg.accounts[j].id) {
          found = true;
          break;
        }
      }
      if (!found) reordered.push(reg.accounts[j]);
    }
    reg.accounts = reordered;
    saveRegistry();
    log("Reordered accounts");
    return true;
  }

  function findAccountIndex(idOrLabel) {
    var reg = loadRegistry();
    if (!reg) return -1;
    for (var i = 0; i < reg.accounts.length; i++) {
      if (
        reg.accounts[i].id === idOrLabel ||
        reg.accounts[i].label === idOrLabel
      ) {
        return i;
      }
    }
    return -1;
  }

  function getAccountById(id) {
    var reg = loadRegistry();
    if (!reg) return null;
    for (var i = 0; i < reg.accounts.length; i++) {
      if (reg.accounts[i].id === id) return reg.accounts[i];
    }
    return null;
  }

  // ── Active account management ──

  function getActiveAccount() {
    var reg = loadRegistry();
    if (!reg || reg.accounts.length === 0) return null;
    if (activeAccountId) {
      var acc = getAccountById(activeAccountId);
      if (acc) return acc;
    }
    // Fall back to primary
    return getAccountById(reg.primaryAccountId) || reg.accounts[0];
  }

  function setActiveAccount(idOrLabel) {
    var idx = findAccountIndex(idOrLabel);
    if (idx === -1) return false;
    var reg = loadRegistry();
    var prev = activeAccountId;
    activeAccountId = reg.accounts[idx].id;
    log(
      "Active account switched: " +
        (prev || "primary") +
        " → " +
        reg.accounts[idx].label
    );
    notifyListeners("switch", reg.accounts[idx]);
    return true;
  }

  function resetToDefault() {
    activeAccountId = null;
    log("Reset to primary account");
  }

  // ── Cooldown management ──

  function markCoolingDown(accountId, untilMs) {
    var reg = loadRegistry();
    if (!reg) return;
    for (var i = 0; i < reg.accounts.length; i++) {
      if (reg.accounts[i].id === accountId) {
        reg.accounts[i].cooldownUntil = untilMs;
        log(
          "Account " +
            reg.accounts[i].label +
            " cooling down until " +
            new Date(untilMs).toISOString()
        );
        break;
      }
    }
    // Don't persist cooldowns — they're session-only
  }

  function clearCooldown(accountId) {
    var reg = loadRegistry();
    if (!reg) return;
    for (var i = 0; i < reg.accounts.length; i++) {
      if (reg.accounts[i].id === accountId) {
        delete reg.accounts[i].cooldownUntil;
        log("Cleared cooldown for " + reg.accounts[i].label);
        break;
      }
    }
  }

  function isOnCooldown(account) {
    return account.cooldownUntil && Date.now() < account.cooldownUntil;
  }

  // ── Failover logic ──

  function getNextFallbackAccount() {
    var reg = loadRegistry();
    if (!reg || reg.accounts.length <= 1) return null;
    var current = getActiveAccount();
    if (!current) return null;
    var currentIdx = -1;
    for (var i = 0; i < reg.accounts.length; i++) {
      if (reg.accounts[i].id === current.id) {
        currentIdx = i;
        break;
      }
    }
    // Search forward from current position, wrapping around
    for (var j = 1; j < reg.accounts.length; j++) {
      var candidate = reg.accounts[(currentIdx + j) % reg.accounts.length];
      if (!isOnCooldown(candidate)) {
        log("Next fallback: " + candidate.label);
        return candidate;
      }
    }
    log("No fallback available — all accounts on cooldown");
    return null;
  }

  /**
   * Called from withRetry on 429. Returns true if failover happened.
   * @param {number|null} resetDelayMs — retry-after from response headers
   * @returns {{ switched: boolean, account: object|null, message: string|null }}
   */
  function handleRateLimitFailover(resetDelayMs) {
    var reg = loadRegistry();
    if (!reg || reg.accounts.length <= 1) {
      return { switched: false, account: null, message: null };
    }

    // Don't switch for short waits
    if (resetDelayMs !== null && resetDelayMs < FAILOVER_THRESHOLD_MS) {
      log(
        "Reset delay " +
          resetDelayMs +
          "ms < threshold " +
          FAILOVER_THRESHOLD_MS +
          "ms, not switching"
      );
      return { switched: false, account: null, message: null };
    }

    var current = getActiveAccount();
    var next = getNextFallbackAccount();
    if (!next) {
      return { switched: false, account: null, message: null };
    }

    var cooldownMs = resetDelayMs || DEFAULT_COOLDOWN_MS;
    markCoolingDown(current.id, Date.now() + cooldownMs);
    setActiveAccount(next.id);

    var msg =
      "⟳ Switched to account '" +
      next.label +
      "' (rate limited on '" +
      current.label +
      "')";
    log(msg);

    return { switched: true, account: next, message: msg };
  }

  // ── Per-account credential management ──

  function getCredentials(accountId) {
    // Check in-memory cache first
    if (credentialStore[accountId]) return credentialStore[accountId];
    // Try secure storage
    if (_secureStorageRead) {
      try {
        var data = _secureStorageRead();
        if (data && data.accountCredentials && data.accountCredentials[accountId]) {
          credentialStore[accountId] = data.accountCredentials[accountId];
          return credentialStore[accountId];
        }
      } catch (e) {
        log("Error reading credentials: " + e.message);
      }
    }
    return null;
  }

  function saveCredentials(accountId, creds) {
    credentialStore[accountId] = creds;
    if (_secureStorageUpdate) {
      try {
        _secureStorageUpdate(function (data) {
          if (!data.accountCredentials) data.accountCredentials = {};
          data.accountCredentials[accountId] = creds;
          return data;
        });
        log("Saved credentials for " + accountId);
      } catch (e) {
        log("Error saving credentials: " + e.message);
      }
    }
  }

  function deleteCredentials(accountId) {
    delete credentialStore[accountId];
    if (_secureStorageUpdate) {
      try {
        _secureStorageUpdate(function (data) {
          if (data.accountCredentials) {
            delete data.accountCredentials[accountId];
          }
          return data;
        });
      } catch (e) {
        log("Error deleting credentials: " + e.message);
      }
    }
  }

  /**
   * Returns the OAuth tokens or API key for the currently active account.
   * This is called by the patched auth.js to override the singleton credential.
   * @returns {{ type: 'oauth', accessToken: string, refreshToken: string|null, ... } | { type: 'api-key', apiKey: string } | null}
   */
  function getActiveCredentials() {
    var account = getActiveAccount();
    if (!account) return null;
    var creds = getCredentials(account.id);
    if (!creds) return null;
    if (account.type === "oauth" && creds.accessToken) {
      return {
        type: "oauth",
        accessToken: creds.accessToken,
        refreshToken: creds.refreshToken || null,
        expiresAt: creds.expiresAt || null,
        scopes: creds.scopes || ["user:inference"],
        subscriptionType: creds.subscriptionType || null,
        rateLimitTier: creds.rateLimitTier || null,
      };
    }
    if (account.type === "api-key" && creds.apiKey) {
      return { type: "api-key", apiKey: creds.apiKey };
    }
    return null;
  }

  // ── Event listeners ──

  function onAccountSwitch(fn) {
    listeners.push(fn);
    return function () {
      listeners = listeners.filter(function (l) {
        return l !== fn;
      });
    };
  }

  function notifyListeners(event, account) {
    for (var i = 0; i < listeners.length; i++) {
      try {
        listeners[i](event, account);
      } catch (e) {
        log("Listener error: " + e.message);
      }
    }
  }

  // ── Status ──

  function getStatus() {
    var reg = loadRegistry();
    if (!reg || reg.accounts.length === 0) {
      return { enabled: false, accounts: [], activeLabel: null };
    }
    var active = getActiveAccount();
    return {
      enabled: reg.accounts.length > 1,
      accounts: reg.accounts.map(function (a) {
        return {
          id: a.id,
          label: a.label,
          type: a.type,
          email: a.emailAddress || null,
          isPrimary: a.id === reg.primaryAccountId,
          isActive: active && a.id === active.id,
          onCooldown: isOnCooldown(a),
          cooldownUntil: a.cooldownUntil || null,
        };
      }),
      activeLabel: active ? active.label : null,
    };
  }

  function isMultiAccountEnabled() {
    var reg = loadRegistry();
    return reg && reg.accounts.length > 1;
  }

  // ── Public API ──
  return {
    // Config binding (called from patches)
    bindConfig: bindConfig,
    bindSecureStorage: bindSecureStorage,

    // Registry CRUD
    getAccounts: getAccounts,
    addAccount: addAccount,
    removeAccount: removeAccount,
    setPrimary: setPrimary,
    reorderAccounts: reorderAccounts,
    getAccountById: getAccountById,

    // Active account
    getActiveAccount: getActiveAccount,
    setActiveAccount: setActiveAccount,
    resetToDefault: resetToDefault,

    // Credentials
    getCredentials: getCredentials,
    saveCredentials: saveCredentials,
    deleteCredentials: deleteCredentials,
    getActiveCredentials: getActiveCredentials,

    // Failover
    handleRateLimitFailover: handleRateLimitFailover,
    getNextFallbackAccount: getNextFallbackAccount,
    markCoolingDown: markCoolingDown,
    clearCooldown: clearCooldown,

    // Events
    onAccountSwitch: onAccountSwitch,

    // Status
    getStatus: getStatus,
    isMultiAccountEnabled: isMultiAccountEnabled,

    // Constants (exposed for patch tuning)
    FAILOVER_THRESHOLD_MS: FAILOVER_THRESHOLD_MS,
    DEFAULT_COOLDOWN_MS: DEFAULT_COOLDOWN_MS,
  };
})();
