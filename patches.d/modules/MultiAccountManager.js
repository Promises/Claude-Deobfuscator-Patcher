// Multi-Account Manager
// Injected as a custom module — manages multiple Anthropic accounts with failover.
//
// Credential storage: config.accountCredentials in ~/.claude.json (disk).
// The macOS keychain singleton is left untouched to avoid cross-account clobbering.
// On 429 quota exhaustion, switches to next available account automatically.
// On 401, clears in-memory cache and re-reads from disk (another process may have refreshed).
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
    // If config isn't bound yet (session hooks haven't fired), read ~/.claude.json
    // directly. This is needed because the header renders before session init.
    if (!_getGlobalConfig) {
      try {
        var raw = fs.readFileSync(
          require("path").join(require("os").homedir(), ".claude.json"), "utf8"
        );
        var directConfig = JSON.parse(raw);
        if (directConfig && directConfig.accountRegistry) {
          registry = directConfig.accountRegistry;
          // Also grab credentials since getCredentials needs them
          if (directConfig.accountCredentials) {
            var ids = Object.keys(directConfig.accountCredentials);
            for (var i = 0; i < ids.length; i++) {
              if (!credentialStore[ids[i]]) {
                credentialStore[ids[i]] = directConfig.accountCredentials[ids[i]];
              }
            }
          }
          log("Loaded registry directly from disk (pre-init): " + registry.accounts.length + " accounts");
          return registry;
        }
      } catch (e) {
        log("Direct config read failed: " + e.message);
      }
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
   * @param {boolean} isExtraUsage — true if "Extra usage is required for long context"
   * @returns {{ switched: boolean, account: object|null, message: string|null }}
   */
  function handleRateLimitFailover(resetDelayMs, isExtraUsage) {
    var reg = loadRegistry();
    if (!reg || reg.accounts.length <= 1) {
      return { switched: false, account: null, message: null };
    }

    // For extra-usage errors, always try to switch (no threshold)
    // For rate limits, don't switch for short waits
    if (!isExtraUsage && resetDelayMs !== null && resetDelayMs < FAILOVER_THRESHOLD_MS) {
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

    var cooldownMs = isExtraUsage ? DEFAULT_COOLDOWN_MS : (resetDelayMs || DEFAULT_COOLDOWN_MS);
    markCoolingDown(current.id, Date.now() + cooldownMs);
    setActiveAccount(next.id);

    var reason = isExtraUsage
      ? "extra usage required for 1M context on '" + current.label + "'"
      : "rate limited on '" + current.label + "'";
    var msg = "⚠ Switched to account '" + next.label + "' (" + reason + ")";
    log(msg);

    // Write warning to stderr so user sees it
    try {
      process.stderr.write("\n" + msg + "\n\n");
    } catch (e) {}

    return { switched: true, account: next, message: msg };
  }

  // ── Per-account credential management ──

  /**
   * Clear in-memory credential cache for a specific account or all accounts.
   * Next getCredentials() call will re-read from disk (config.accountCredentials).
   * This is critical for 401 recovery: another process may have refreshed tokens
   * and written them to disk while our in-memory copy is stale.
   * @param {string} [accountId] — if omitted, clears all cached credentials
   */
  function clearCredentialCache(accountId) {
    if (accountId) {
      delete credentialStore[accountId];
      log("Cleared credential cache for " + accountId);
    } else {
      credentialStore = {};
      log("Cleared all credential caches");
    }
  }

  function getCredentials(accountId) {
    // Check in-memory cache first
    if (credentialStore[accountId]) return credentialStore[accountId];
    // Read from disk (config.accountCredentials — the source of truth)
    if (_getGlobalConfig) {
      try {
        var config = _getGlobalConfig();
        if (config && config.accountCredentials && config.accountCredentials[accountId]) {
          credentialStore[accountId] = config.accountCredentials[accountId];
          return credentialStore[accountId];
        }
      } catch (e) {
        log("Error reading credentials from config: " + e.message);
      }
    }
    // Try secure storage as fallback
    if (_secureStorageRead) {
      try {
        var data = _secureStorageRead();
        if (data && data.accountCredentials && data.accountCredentials[accountId]) {
          credentialStore[accountId] = data.accountCredentials[accountId];
          return credentialStore[accountId];
        }
      } catch (e) {
        log("Error reading credentials from storage: " + e.message);
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
   * Called after OAuth token refresh to persist new tokens to disk and in-memory cache.
   * This is the ONLY place refreshed tokens should be saved for multi-account — the
   * keychain singleton (saveOAuthTokensIfNeeded) is suppressed to avoid cross-account
   * clobbering.
   * @param {object} tokenObj — the refreshed token object from FBH()
   */
  function saveRefreshedTokens(tokenObj) {
    var account = getActiveAccount();
    if (!account || account.type !== "oauth") return;

    // Merge with existing credentials to preserve fields the refresh doesn't return
    var existing = getCredentials(account.id) || {};
    var updated = {
      accessToken: tokenObj.accessToken,
      refreshToken: "refreshToken" in tokenObj ? tokenObj.refreshToken : existing.refreshToken,
      expiresAt: "expiresAt" in tokenObj ? tokenObj.expiresAt : existing.expiresAt,
      scopes: tokenObj.scopes || existing.scopes || ["user:inference"],
      subscriptionType: tokenObj.subscriptionType || existing.subscriptionType || null,
      rateLimitTier: tokenObj.rateLimitTier || existing.rateLimitTier || null,
    };
    // Update in-memory cache
    credentialStore[account.id] = updated;
    // Persist to config.accountCredentials on disk (source of truth)
    if (_saveGlobalConfig) {
      try {
        _saveGlobalConfig(function (config) {
          var creds = config.accountCredentials || {};
          creds[account.id] = updated;
          return Object.assign({}, config, { accountCredentials: creds });
        });
        log("Saved refreshed tokens for " + account.label + " (expiresAt=" + updated.expiresAt + ")");
      } catch (e) {
        log("Error saving refreshed tokens: " + e.message);
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
      log("Serving OAuth creds for: " + account.label + " (sub=" + (creds.subscriptionType || "?") + ")");
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

  /**
   * Called after /login completes to capture fresh tokens into the correct account.
   * Matches by organizationUuid first (so logging into a different org goes to the
   * right slot), then falls back to accountUuid, then active account.
   * @param {object} tokens — the OAuthTokens object from installOAuthTokens
   * @param {object} [accountInfo] — { accountUuid, emailAddress, organizationUuid }
   */
  function handlePostLogin(tokens, accountInfo) {
    var reg = loadRegistry();
    if (!reg || reg.accounts.length === 0) return;

    // Try to match the login to an existing account by orgUuid or accountUuid
    var account = null;
    if (accountInfo) {
      for (var i = 0; i < reg.accounts.length; i++) {
        var a = reg.accounts[i];
        if (accountInfo.organizationUuid && a.organizationUuid &&
            accountInfo.organizationUuid === a.organizationUuid) {
          account = a;
          log("Post-login: matched by orgUuid → " + a.label);
          break;
        }
      }
      if (!account) {
        for (var i = 0; i < reg.accounts.length; i++) {
          var a = reg.accounts[i];
          if (accountInfo.accountUuid && a.accountUuid &&
              accountInfo.accountUuid === a.accountUuid) {
            account = a;
            log("Post-login: matched by accountUuid → " + a.label);
            break;
          }
        }
      }
    }
    // Fall back to active account if no match
    if (!account) {
      account = getActiveAccount();
      log("Post-login: no org/account match, falling back to active → " + (account ? account.label : "none"));
    }
    if (!account) return;

    // Update account info if provided
    if (accountInfo) {
      for (var i = 0; i < reg.accounts.length; i++) {
        if (reg.accounts[i].id === account.id) {
          if (accountInfo.accountUuid) reg.accounts[i].accountUuid = accountInfo.accountUuid;
          if (accountInfo.emailAddress) reg.accounts[i].emailAddress = accountInfo.emailAddress;
          if (accountInfo.organizationUuid !== undefined) reg.accounts[i].organizationUuid = accountInfo.organizationUuid;
          break;
        }
      }
      saveRegistry();
    }

    // Save fresh credentials to disk
    var updated = {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken || null,
      expiresAt: tokens.expiresAt || null,
      scopes: tokens.scopes || ["user:inference"],
      subscriptionType: tokens.subscriptionType || null,
      rateLimitTier: tokens.rateLimitTier || null,
    };
    credentialStore[account.id] = updated;
    if (_saveGlobalConfig) {
      try {
        _saveGlobalConfig(function (config) {
          var creds = config.accountCredentials || {};
          creds[account.id] = updated;
          return Object.assign({}, config, { accountCredentials: creds });
        });
        log("Post-login: saved fresh tokens for " + account.label);
      } catch (e) {
        log("Post-login: error saving tokens: " + e.message);
      }
    }

    // Clear cooldown since we just got fresh auth
    clearCooldown(account.id);

    try {
      process.stderr.write("\n✓ Multi-account: updated credentials for '" + account.label + "'\n\n");
    } catch (e) {}
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
    saveRefreshedTokens: saveRefreshedTokens,
    clearCredentialCache: clearCredentialCache,
    handlePostLogin: handlePostLogin,

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

// Register with session hooks for late init (secure storage, oauthAccount sync)
try {
  __sessionHooks.push(function () {
    __multiAccount.bindConfig(getGlobalConfig, saveGlobalConfig);
    __multiAccount.bindSecureStorage(
      function () { return U4().read(); },
      function (updater) { return U4().update(updater); }
    );
    // Sync oauthAccount in config to active account so direct config readers see correct data
    if (__multiAccount.isMultiAccountEnabled()) {
      var __active = __multiAccount.getActiveAccount();
      if (__active) {
        saveGlobalConfig(function (config) {
          var __prev = config.oauthAccount || {};
          // Only update if the active account differs from what's in config
          if (__prev.accountUuid === __active.accountUuid) return config;
          return Object.assign({}, config, {
            oauthAccount: {
              accountUuid: __active.accountUuid,
              emailAddress: __active.emailAddress,
              organizationUuid: __active.organizationUuid,
            },
          });
        });
      }
    }
  });
} catch (e) {}

// Register /accounts command
try {
  __commandHooks.register({
    name: "accounts",
    description: "Show and manage multi-account configuration",
    call: async function (args) {
      var status = __multiAccount.getStatus();
      if (!status.enabled && status.accounts.length === 0) {
        return {
          type: "text",
          value: "No accounts configured. Use the account-tool.js script to add accounts.",
        };
      }
      var lines = [];
      lines.push("Accounts (" + status.accounts.length + "):\n");
      for (var i = 0; i < status.accounts.length; i++) {
        var a = status.accounts[i];
        var flags = [];
        if (a.isPrimary) flags.push("PRIMARY");
        if (a.isActive) flags.push("ACTIVE");
        if (a.onCooldown) flags.push("COOLDOWN until " + new Date(a.cooldownUntil).toLocaleTimeString());
        var flagStr = flags.length > 0 ? " [" + flags.join(", ") + "]" : "";
        var email = a.email ? " (" + a.email + ")" : "";
        lines.push("  " + a.label + flagStr + " \u2014 " + a.type + email);
      }

      // Parse subcommands from args
      var parts = (args || "").trim().split(/\s+/);
      var subcmd = parts[0] || "";
      var target = parts[1] || "";

      if (subcmd === "switch" && target) {
        var ok = __multiAccount.setActiveAccount(target);
        if (ok) {
          // Clear OAuth token cache to force re-read
          try {
            if (typeof getClaudeAIOAuthTokens !== "undefined" &&
                getClaudeAIOAuthTokens.cache &&
                getClaudeAIOAuthTokens.cache.clear) {
              getClaudeAIOAuthTokens.cache.clear();
            }
          } catch (e) {}
          lines.push("\n\u2713 Switched active account to '" + target + "'");
        } else {
          lines.push("\n\u2717 Account '" + target + "' not found");
        }
      } else if (subcmd === "primary" && target) {
        var ok2 = __multiAccount.setPrimary(target);
        if (ok2) {
          lines.push("\n\u2713 Set '" + target + "' as primary");
        } else {
          lines.push("\n\u2717 Account '" + target + "' not found");
        }
      } else if (subcmd === "reset") {
        __multiAccount.resetToDefault();
        try {
          if (typeof getClaudeAIOAuthTokens !== "undefined" &&
              getClaudeAIOAuthTokens.cache &&
              getClaudeAIOAuthTokens.cache.clear) {
            getClaudeAIOAuthTokens.cache.clear();
          }
        } catch (e) {}
        lines.push("\n\u2713 Reset to primary account");
      } else if (subcmd && subcmd !== "") {
        lines.push("\nSubcommands:");
        lines.push("  /accounts                  Show all accounts");
        lines.push("  /accounts switch <label>   Switch active account");
        lines.push("  /accounts primary <label>  Set primary account");
        lines.push("  /accounts reset            Reset to primary");
      }

      return { type: "text", value: lines.join("\n") };
    },
  });
} catch (e) {}

// Register /account-reauth command (Option C: manual credential refresh from keychain)
try {
  __commandHooks.register({
    name: "account-reauth",
    description: "Re-read current keychain tokens into the active multi-account",
    call: async function () {
      var account = __multiAccount.getActiveAccount();
      if (!account) {
        return { type: "text", value: "No active account." };
      }

      // Read fresh tokens from the keychain (what /login just wrote)
      var keychainTokens = null;
      try {
        var storageData = U4().read();
        keychainTokens = storageData && storageData.claudeAiOauth;
      } catch (e) {
        return { type: "text", value: "Error reading keychain: " + e.message };
      }

      if (!keychainTokens || !keychainTokens.accessToken) {
        return { type: "text", value: "No OAuth tokens found in keychain. Run /login first." };
      }

      // Also grab the oauthAccount info from config
      var config = getGlobalConfig();
      var accountInfo = config && config.oauthAccount ? {
        accountUuid: config.oauthAccount.accountUuid,
        emailAddress: config.oauthAccount.emailAddress,
        organizationUuid: config.oauthAccount.organizationUuid,
      } : null;

      __multiAccount.handlePostLogin(keychainTokens, accountInfo);

      // Clear the memoize cache so next API call uses the fresh tokens
      try {
        if (typeof getClaudeAIOAuthTokens !== "undefined" &&
            getClaudeAIOAuthTokens.cache &&
            getClaudeAIOAuthTokens.cache.clear) {
          getClaudeAIOAuthTokens.cache.clear();
        }
      } catch (e) {}

      var email = accountInfo && accountInfo.emailAddress || "?";
      return {
        type: "text",
        value: "Updated credentials for '" + account.label + "' (" + email + ")\n" +
               "Token expires: " + (keychainTokens.expiresAt ? new Date(keychainTokens.expiresAt).toLocaleString() : "unknown") + "\n" +
               "Has refresh token: " + (keychainTokens.refreshToken ? "yes" : "no"),
      };
    },
  });
} catch (e) {}
