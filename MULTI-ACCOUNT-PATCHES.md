# Multi-Account Patches — Modification Reference

This document describes the patches needed against the deobfuscated Claude Code source to wire up `__multiAccount` (from `patches.d/modules/MultiAccountManager.js`).

All line numbers reference the **prettified deobfuscated** output. Function names reference the **renamed** identifiers. Where a function is still obfuscated, the obfuscated name is given with a description.

---

## Patch 003: Multi-Account Config Binding

**File: `bootstrap/state.js`**

Bind `__multiAccount` to config functions during initialization (similar to how `__claudiverse.connect()` is wired).

```diff
 function getSessionId() {
+    try {
+        if (typeof __multiAccount !== 'undefined') {
+            __multiAccount.bindConfig(getGlobalConfig, saveGlobalConfig);
+        }
+    } catch (e) {}
     try {
         __claudiverse.connect();
     } catch (e) {}
     return R_.sessionId;
 }
```

**Why here:** `getSessionId()` runs early in bootstrap, after config is available. The `getGlobalConfig` and `saveGlobalConfig` functions are already in scope in `state.js` (or imported from `config.js`).

**Renamer dependency:** Needs `getGlobalConfig` and `saveGlobalConfig` to be renamed. These are high-confidence renames (unique string anchors in config.js). If they're still obfuscated, match by:
- `getGlobalConfig` → the function that reads `Gd.config` cache and calls `createDefaultGlobalConfig`
- `saveGlobalConfig` → the function that calls `saveConfigWithLock` with the config file path

---

## Patch 004: Secure Storage Binding

**File: `utils/secureStorage/index.js`** (or wherever `U4()` is defined — the secure storage singleton)

The `__multiAccount` module needs read/update access to secure storage for per-account credentials.

```diff
 // After secure storage initialization (look for the U4 or equivalent singleton getter)
+try {
+    if (typeof __multiAccount !== 'undefined') {
+        __multiAccount.bindSecureStorage(
+            function() { return U4().read(); },
+            function(updater) { return U4().update(updater); }
+        );
+    }
+} catch (e) {}
```

**Renamer dependency:** `U4()` is the secure storage singleton. Match by: function that returns object with `.read()`, `.update()`, `.readAsync()` methods and references `claudeAiOauth`.

**Alternative placement:** If secure storage init is hard to patch, this can go in `getSessionId()` alongside the config binding, provided `U4` is in scope there.

---

## Patch 005: Auth Credential Override

**File: `utils/auth.js`**

### 5a. Override `getClaudeAIOAuthTokens` for multi-account

The memoized `getClaudeAIOAuthTokens` function (defined via `z6(...)` near end of file) needs to check `__multiAccount` first.

**Target:** The `z6(() => { ... })` block that defines `getClaudeAIOAuthTokens`

```diff
 getClaudeAIOAuthTokens = z6(() => {
     if (isBareMode()) return null;
+    // Multi-account override
+    try {
+        if (typeof __multiAccount !== 'undefined' && __multiAccount.isMultiAccountEnabled()) {
+            var __creds = __multiAccount.getActiveCredentials();
+            if (__creds && __creds.type === 'oauth') {
+                return {
+                    accessToken: __creds.accessToken,
+                    refreshToken: __creds.refreshToken,
+                    expiresAt: __creds.expiresAt,
+                    scopes: __creds.scopes,
+                    subscriptionType: __creds.subscriptionType,
+                    rateLimitTier: __creds.rateLimitTier,
+                };
+            }
+        }
+    } catch (__e) {}
     if (process.env.CLAUDE_CODE_OAUTH_TOKEN)
```

**Renamer dependency:** `getClaudeAIOAuthTokens` — high confidence, matched by the `claudeAiOauth` string anchor and `z6()` memoization wrapper.

### 5b. Override `getAnthropicApiKeyWithSource` for multi-account API keys

**Target:** `getAnthropicApiKeyWithSource(H = {})` — at the start, after bare mode check

```diff
 function getAnthropicApiKeyWithSource(H = {}) {
     if (isBareMode()) {
         ...
     }
+    // Multi-account API key override
+    try {
+        if (typeof __multiAccount !== 'undefined' && __multiAccount.isMultiAccountEnabled()) {
+            var __creds = __multiAccount.getActiveCredentials();
+            if (__creds && __creds.type === 'api-key' && __creds.apiKey) {
+                return { key: __creds.apiKey, source: 'multi-account' };
+            }
+        }
+    } catch (__e) {}
     let _ = shouldMaintainProjectWorkingDir() ? void 0 : process.env.ANTHROPIC_API_KEY;
```

**Renamer dependency:** `getAnthropicApiKeyWithSource` — high confidence, matched by `'ANTHROPIC_API_KEY'` string literal and `skipRetrievingKeyFromApiKeyHelper` property.

---

## Patch 006: Failover in withRetry

**File: `services/api/withRetry.js`**

### 6a. Account failover on 429

**Target:** Inside the 429 handler block, **after** the fast-mode fallback logic (lines ~102-119), before the general retry delay calculation.

Look for the pattern where fast-mode cooldown is triggered (`triggerFastModeCooldown()`). The failover goes right after that block's closing brace.

```diff
             // ... existing fast-mode 429 handling ...
             triggerFastModeCooldown(...);
             $.fastMode = !1;
         }
+        // Multi-account failover on 429
+        try {
+            if (typeof __multiAccount !== 'undefined') {
+                var __resetMs = getRateLimitResetDelayMs(Y);
+                var __failover = __multiAccount.handleRateLimitFailover(__resetMs);
+                if (__failover.switched) {
+                    // Force client re-creation on next iteration
+                    O = null;
+                    // Clear OAuth token cache so fresh creds are loaded
+                    if (typeof getClaudeAIOAuthTokens !== 'undefined' &&
+                        getClaudeAIOAuthTokens.cache &&
+                        getClaudeAIOAuthTokens.cache.clear) {
+                        getClaudeAIOAuthTokens.cache.clear();
+                    }
+                    continue; // retry immediately with new account
+                }
+            }
+        } catch (__e) {}
```

**Key variables in scope:**
- `Y` — the caught error (APIError with .status)
- `O` — the current API client instance (set to null to force re-creation)
- `$` — the context object (has `.fastMode`)
- `getRateLimitResetDelayMs` — existing function that parses `anthropic-ratelimit-unified-reset` header
- `getClaudeAIOAuthTokens` — imported, has `.cache.clear()` for memoization invalidation

**Renamer dependency:** 
- `getRateLimitResetDelayMs` — matched by `anthropic-ratelimit-unified-reset` string anchor
- `triggerFastModeCooldown` — matched by fast mode related strings
- Variable names `O`, `Y`, `$` are positional — the patch context lines must match

### 6b. Clear cooldown on successful request

**Target:** After a successful API response in the main loop (before yielding chunks). Look for the success path where messages are yielded.

```diff
+        // Clear cooldown on success
+        try {
+            if (typeof __multiAccount !== 'undefined') {
+                var __active = __multiAccount.getActiveAccount();
+                if (__active) __multiAccount.clearCooldown(__active.id);
+            }
+        } catch (__e) {}
```

**Placement:** Right after `O = await H()` succeeds and before the response streaming begins.

---

## Patch 007: Client Re-creation Awareness

**File: `services/api/client.js`**

No structural changes needed. The existing client creation flow in `getAnthropicClient()` already:
1. Calls `checkAndRefreshOAuthTokenIfNeeded()` (line 66)
2. Calls `getClaudeAIOAuthTokens()?.accessToken` for subscriber auth (line 178)
3. Calls `getAnthropicApiKey()` for API key auth (line 178)

Since patches 5a and 5b override these functions to return the active account's credentials, client re-creation (forced by `O = null` in patch 6a) will automatically pick up the new account's credentials.

**No patch needed for client.js** — it works through the auth.js overrides.

---

## Summary: Patch Files to Create

| Patch File | Files Modified | Depends On |
|------------|---------------|------------|
| `003-multi-account-config-bind.patch` | `bootstrap/state.js` | 001 (sidecar) |
| `004-multi-account-storage-bind.patch` | `utils/secureStorage/index.js` or `bootstrap/state.js` | 003 |
| `005-multi-account-auth-override.patch` | `utils/auth.js` | 003, 004 |
| `006-multi-account-failover.patch` | `services/api/withRetry.js` | 005 |

---

## Renamer Requirements

The following renamed identifiers are **required** for patches to apply correctly. These should already be high-confidence renames, but verify they're in your `_renames.json`:

| Identifier | File | Match Strategy |
|------------|------|----------------|
| `getGlobalConfig` | `utils/config.js` | Unique: reads `Gd.config` cache, calls `createDefaultGlobalConfig` |
| `saveGlobalConfig` | `utils/config.js` | Unique: calls `saveConfigWithLock` with config path |
| `getClaudeAIOAuthTokens` | `utils/auth.js` | String anchor: `claudeAiOauth`, wrapped in `z6()` |
| `getAnthropicApiKeyWithSource` | `utils/auth.js` | String: `'ANTHROPIC_API_KEY'`, param `skipRetrievingKeyFromApiKeyHelper` |
| `getRateLimitResetDelayMs` | `services/api/withRetry.js` | String: `anthropic-ratelimit-unified-reset` |
| `getSessionId` | `bootstrap/state.js` | Already renamed (used by sidecar patch) |
| `checkAndRefreshOAuthTokenIfNeeded` | `utils/auth.js` | Pattern: singleton promise cache (`ZUH`), calls impl with retry |
| `isBareMode` | `utils/auth.js` | String: `CLAUDE_CODE_BARE_MODE` or similar bare-mode env check |
| `isClaudeAISubscriber` | `services/api/client.js` | Pattern: checked before selecting apiKey vs authToken |

---

## Testing

1. **Build with module only (no patches):** Verify `__multiAccount` loads without errors
   ```bash
   ./entrypoint.sh build
   CLAUDE_MULTI_ACCOUNT_DEBUG=1 ./claude --version
   # Should start normally, /tmp/claude-multi-account.log should NOT exist (no bind calls yet)
   ```

2. **Build with config binding patch:** Verify binding works
   ```bash
   ./entrypoint.sh build
   CLAUDE_MULTI_ACCOUNT_DEBUG=1 ./claude "say hi"
   cat /tmp/claude-multi-account.log
   # Should see: "Config bound"
   ```

3. **Full build with all patches:** Test failover
   ```bash
   ./entrypoint.sh build
   # Add two accounts via the module's API (or manual config edit)
   # Trigger 429 on first account → verify automatic switch
   ```

---

## CLI Commands (Future Patch)

CLI commands (`claude auth accounts ...`) require patching `cli/handlers/auth.js` and `main.tsx`. These are larger patches that depend on the ink/React UI components. Recommend implementing these after the core failover is proven working.

A simpler interim approach: expose account management via environment variables or a config file that users edit directly:

```json
// In ~/.claude.json (global config), manually add:
{
  "accountRegistry": {
    "version": 1,
    "primaryAccountId": "uuid-1",
    "accounts": [
      { "id": "uuid-1", "label": "personal", "type": "oauth" },
      { "id": "uuid-2", "label": "work", "type": "api-key", "apiKeyPrefix": "sk-ant-a..." }
    ]
  }
}
```

And credentials in the keychain via `__multiAccount.saveCredentials(id, { apiKey: "..." })` called from a debug console or helper script.
