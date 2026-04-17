# Missing Anchors Per Patch

## 001-session-hooks.patch
| File | Lines | Globals | Locals |
|------|-------|---------|--------|
| `bootstrap/state.js` | 362-367 | `getSessionId`, `getInitialState`, `STATE` | — |

All **done**.

## 002-claudiverse-sidecar.patch
| File | Lines | Globals | Locals |
|------|-------|---------|--------|
| `cli/structuredIO.js` | 86-89 | ~~`StructuredIO`~~ (class), ~~`jsonStringify`~~ (`BH`) | — |
| `query.js` | 79-41 | `query`, `queryLoop`, `notifyCommandLifecycle` | `params`, `consumedCommandUuids`, `terminal` |

All **done**.

## 003-claudiverse-panel.patch
| File | Lines | Globals | Locals |
|------|-------|---------|--------|
| `components/LogoV2/LogoV2.js` | 443-453 | `LogoV2`, `R8`, `q27`, `createProjectOnboardingFeed`, `createRecentActivityFeed`, `getSteps` | `O`, `A`, `_` |

All **TODO**.

## 004-multi-account-failover.patch
| File | Lines | Globals | Locals |
|------|-------|---------|--------|
| `services/api/withRetry.js` | 137-160 | `th_`, `WQ4`, `iq`, `su`, `sh_`, `F19`, `getClaudeAIOAuthTokens` | `O`, `Y`, `$`, `w`, `K` |
| `utils/auth.js` | 161-170 | `getAnthropicApiKeyWithSource`, `preferThirdPartyAuthentication`, `D0` | `_`, `H` |
| `utils/auth.js` | 770-788 | `getOauthAccountInfo`, `isAnthropicAuthEnabled`, `getGlobalConfig` | — |
| `utils/auth.js` | 1057-1095 | `getClaudeAIOAuthTokens`, `z6`, `J1` | — |

auth.js globals mostly **done** (export map). TODO: `th_`, `WQ4`, `iq`, `su`, `sh_`, `F19`, `z6`, `J1`, `D0`.

## 005-command-hooks.patch
| File | Lines | Globals | Locals |
|------|-------|---------|--------|
| `commands.js` | 509-517 | `g48`, `z6`, `aF` | — |

All **TODO**.

## 006-account-banner.patch
| File | Lines | Globals | Locals |
|------|-------|---------|--------|
| `_tentative/4477_useSwarmBanner.js` | 54-59 | `Mp7`, `Ma_` | `T`, `q`, `Y` |

All **TODO**.
