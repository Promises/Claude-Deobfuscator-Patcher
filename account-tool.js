#!/usr/bin/env node
// Helper script for managing multi-account registry
// Usage:
//   node account-tool.js list
//   node account-tool.js add-key <label> <api-key>
//   node account-tool.js add-oauth <label>          (migrates current login)
//   node account-tool.js remove <label>
//   node account-tool.js set-primary <label>
//   node account-tool.js status

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CONFIG_PATH = path.join(process.env.HOME, '.claude.json');

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    console.error('Could not read ~/.claude.json');
    process.exit(1);
  }
}

function writeConfig(config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
}

function getRegistry(config) {
  if (config.accountRegistry) return config.accountRegistry;
  // Auto-migrate from single account
  if (config.oauthAccount?.accountUuid) {
    const entry = {
      id: crypto.randomUUID(),
      label: 'default',
      type: 'oauth',
      accountUuid: config.oauthAccount.accountUuid,
      emailAddress: config.oauthAccount.emailAddress || null,
      organizationUuid: config.oauthAccount.organizationUuid || null,
    };
    return {
      version: 1,
      primaryAccountId: entry.id,
      accounts: [entry],
    };
  }
  return { version: 1, primaryAccountId: null, accounts: [] };
}

const [,, cmd, ...args] = process.argv;

const config = readConfig();
const registry = getRegistry(config);

switch (cmd) {
  case 'list':
  case 'status': {
    if (registry.accounts.length === 0) {
      console.log('No accounts configured.');
      break;
    }
    console.log(`Accounts (${registry.accounts.length}):\n`);
    for (const a of registry.accounts) {
      const primary = a.id === registry.primaryAccountId ? ' [PRIMARY]' : '';
      const email = a.emailAddress ? ` (${a.emailAddress})` : '';
      const prefix = a.apiKeyPrefix ? ` (${a.apiKeyPrefix}...)` : '';
      console.log(`  ${a.label}${primary} — ${a.type}${email}${prefix}`);
      console.log(`    id: ${a.id}`);
    }
    break;
  }

  case 'add-key': {
    const [label, apiKey] = args;
    if (!label || !apiKey) {
      console.error('Usage: add-key <label> <api-key>');
      process.exit(1);
    }
    const entry = {
      id: crypto.randomUUID(),
      label,
      type: 'api-key',
      apiKeyPrefix: apiKey.substring(0, 12),
    };
    registry.accounts.push(entry);
    if (!registry.primaryAccountId) registry.primaryAccountId = entry.id;
    config.accountRegistry = registry;

    // Store the key in accountCredentials within the config
    // (For V1, we store keys in config rather than keychain for simplicity)
    if (!config.accountCredentials) config.accountCredentials = {};
    config.accountCredentials[entry.id] = { apiKey };

    writeConfig(config);
    console.log(`Added API key account "${label}" (${entry.id})`);
    break;
  }

  case 'add-oauth': {
    const [label] = args;
    if (!label) {
      console.error('Usage: add-oauth <label>');
      process.exit(1);
    }
    if (!config.oauthAccount?.accountUuid) {
      console.error('No OAuth account logged in. Run `claude auth login` first.');
      process.exit(1);
    }
    // Check if this OAuth account is already in the registry
    const existing = registry.accounts.find(
      a => a.type === 'oauth' && a.accountUuid === config.oauthAccount.accountUuid
    );
    if (existing) {
      console.log(`OAuth account already in registry as "${existing.label}"`);
      break;
    }
    const entry = {
      id: crypto.randomUUID(),
      label,
      type: 'oauth',
      accountUuid: config.oauthAccount.accountUuid,
      emailAddress: config.oauthAccount.emailAddress || null,
      organizationUuid: config.oauthAccount.organizationUuid || null,
    };
    registry.accounts.push(entry);
    if (!registry.primaryAccountId) registry.primaryAccountId = entry.id;
    config.accountRegistry = registry;
    writeConfig(config);
    console.log(`Added OAuth account "${label}" (${entry.id})`);
    console.log('Note: OAuth tokens are read from the keychain (existing login).');
    break;
  }

  case 'remove': {
    const [target] = args;
    if (!target) {
      console.error('Usage: remove <label-or-id>');
      process.exit(1);
    }
    const idx = registry.accounts.findIndex(a => a.label === target || a.id === target);
    if (idx === -1) {
      console.error(`Account "${target}" not found.`);
      process.exit(1);
    }
    const removed = registry.accounts.splice(idx, 1)[0];
    if (registry.primaryAccountId === removed.id) {
      registry.primaryAccountId = registry.accounts[0]?.id || null;
    }
    if (config.accountCredentials?.[removed.id]) {
      delete config.accountCredentials[removed.id];
    }
    config.accountRegistry = registry;
    writeConfig(config);
    console.log(`Removed account "${removed.label}"`);
    break;
  }

  case 'set-primary': {
    const [target] = args;
    if (!target) {
      console.error('Usage: set-primary <label-or-id>');
      process.exit(1);
    }
    const account = registry.accounts.find(a => a.label === target || a.id === target);
    if (!account) {
      console.error(`Account "${target}" not found.`);
      process.exit(1);
    }
    registry.primaryAccountId = account.id;
    config.accountRegistry = registry;
    writeConfig(config);
    console.log(`Set "${account.label}" as primary.`);
    break;
  }

  default:
    console.log('Usage: node account-tool.js <command> [args]');
    console.log('');
    console.log('Commands:');
    console.log('  list                      List all accounts');
    console.log('  add-key <label> <key>     Add an API key account');
    console.log('  add-oauth <label>         Add current OAuth login as an account');
    console.log('  remove <label>            Remove an account');
    console.log('  set-primary <label>       Set primary account');
    break;
}
