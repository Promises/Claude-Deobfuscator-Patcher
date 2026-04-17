# Anchor Rules TODO

Tracking which functions need anchor rules for the multi-account patches (see `MULTI-ACCOUNT-PATCHES.md`).

## bootstrap/state.js

| Target | Status | Strategy |
|--------|--------|----------|
| `getSessionId` | done | export map |
| `getInitialState` | done | string_literal: "userSettings" |
| `flushInteractionTime_inner` | done | only_bare_call from export map |
| `STATE` | done | member_access_target |
| all 212 exports | done | export map |

## utils/config.js

| Target | Status | Strategy |
|--------|--------|----------|
| `getGlobalConfig` | done | anchored (string_literal: "approved" chain) |
| `saveGlobalConfig` | done | export map |
| all 32 exports | done | export map |
| `logEvent` (`Q`) | done | call_string_arg from saveGlobalConfig |
| `logForDebugging` (`h`) | done | call_string_contains from saveGlobalConfig |
| `wouldLoseAuthState` (`$Z_`) | TODO | not exported, checks `oauthAccount`/`hasCompletedOnboarding` |

## utils/auth.js

| Target | Status | Strategy |
|--------|--------|----------|
| `getClaudeAIOAuthTokens` (`Kq`) | TODO | string: `claudeAiOauth` |
| `getAnthropicApiKeyWithSource` (`$z`) | TODO | string: `skipRetrievingKeyFromApiKeyHelper` |
| `isClaudeAISubscriber` (`t8`) | TODO | export map would cover |
| `checkAndRefreshOAuthTokenIfNeeded` (`FO`) | TODO | export map would cover |
| all ~90 exports | TODO | export map (needs one anchor in the file first) |

## utils/envUtils.js

| Target | Status | Strategy |
|--------|--------|----------|
| `isBareMode` (`J1`) | TODO | env var check pattern |

## services/api/withRetry.js

| Target | Status | Strategy |
|--------|--------|----------|
| `getRateLimitResetDelayMs` (`WQ4`) | TODO | string: `anthropic-ratelimit-unified-reset` |
| `RetryError` class (`su`) | TODO | string: `RetryError` |
| main retry generator (`th_`) | TODO | string: `tengu_api_retry` |

## utils/secureStorage/

| Target | Status | Strategy |
|--------|--------|----------|
| `U4()` secure storage singleton | N/A | stable ref, no rename needed |
