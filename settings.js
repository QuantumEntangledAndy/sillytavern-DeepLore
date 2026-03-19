/**
 * DeepLore — Settings module
 * Default settings, constraints, getSettings()
 */
import {
    extension_settings,
} from '../../../extensions.js';
import { validateSettings } from './core/utils.js';

export const MODULE_NAME = 'deeplore';
export const PROMPT_TAG = 'deeplore';
export const PROMPT_TAG_PREFIX = 'deeplore_';
export const PLUGIN_BASE = '/api/plugins/deeplore';

export const defaultSettings = {
    enabled: false,
    obsidianPort: 27123,
    obsidianApiKey: '',
    lorebookTag: 'lorebook',
    constantTag: 'lorebook-always',
    neverInsertTag: 'lorebook-never',
    seedTag: 'lorebook-seed',
    bootstrapTag: 'lorebook-bootstrap',
    newChatThreshold: 3,
    scanDepth: 4,
    maxEntries: 10,
    unlimitedEntries: true,
    maxTokensBudget: 2048,
    unlimitedBudget: true,
    injectionPosition: 1,   // extension_prompt_types.IN_CHAT
    injectionDepth: 4,
    injectionRole: 0,        // extension_prompt_roles.SYSTEM
    injectionTemplate: '<{{title}}>\n{{content}}\n</{{title}}>',
    allowWIScan: false,
    recursiveScan: false,
    maxRecursionSteps: 3,
    matchWholeWords: false,
    caseSensitive: false,
    cacheTTL: 300,
    reviewResponseTokens: 0,
    debugMode: false,
    // Vault Sync settings
    syncPollingInterval: 0,
    showSyncToasts: true,
    // Chat History Tracking
    reinjectionCooldown: 0,
    // Matching extras
    characterContextScan: false,
    // Analytics
    analyticsData: {},
};

/** Validation constraints for numeric settings */
export const settingsConstraints = {
    obsidianPort: { min: 1, max: 65535 },
    scanDepth: { min: 0, max: 100 },
    maxEntries: { min: 1, max: 100 },
    maxTokensBudget: { min: 100, max: 100000 },
    injectionDepth: { min: 0, max: 9999 },
    maxRecursionSteps: { min: 1, max: 10 },
    cacheTTL: { min: 0, max: 86400 },
    reviewResponseTokens: { min: 0, max: 100000 },
    syncPollingInterval: { min: 0, max: 3600 },
    reinjectionCooldown: { min: 0, max: 50 },
    newChatThreshold: { min: 1, max: 20 },
};

/** @returns {typeof defaultSettings} */
export function getSettings() {
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = {};
    }
    // Fill in any missing defaults
    for (const [key, value] of Object.entries(defaultSettings)) {
        if (extension_settings[MODULE_NAME][key] === undefined) {
            extension_settings[MODULE_NAME][key] = value;
        }
    }
    validateSettings(extension_settings[MODULE_NAME], settingsConstraints);
    return extension_settings[MODULE_NAME];
}
