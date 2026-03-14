import {
    setExtensionPrompt,
    getRequestHeaders,
    saveSettingsDebounced,
    sendMessageAsUser,
    Generate,
    amount_gen,
    main_api,
} from '../../../../script.js';
import {
    extension_settings,
    extension_prompts,
    renderExtensionTemplateAsync,
} from '../../../extensions.js';
import { oai_settings } from '../../../openai.js';
import { getTokenCountAsync } from '../../../tokenizers.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
import { eventSource, event_types } from '../../../events.js';
import { callGenericPopup, POPUP_TYPE } from '../../../popup.js';
import { escapeHtml } from '../../../utils.js';

const MODULE_NAME = 'deeplore';
const PROMPT_TAG = 'deeplore';
const PROMPT_TAG_PREFIX = 'deeplore_';
const PLUGIN_BASE = '/api/plugins/deeplore';

// ============================================================================
// Settings
// ============================================================================

const defaultSettings = {
    enabled: false,
    obsidianPort: 27123,
    obsidianApiKey: '',
    lorebookTag: 'lorebook',
    constantTag: 'lorebook-always',
    neverInsertTag: 'lorebook-never',
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
    // Analytics
    analyticsData: {},
};

/** Validation constraints for numeric settings */
const settingsConstraints = {
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
};

/**
 * Validate and clamp settings to their allowed ranges.
 * @param {object} settings
 */
function validateSettings(settings) {
    for (const [key, { min, max }] of Object.entries(settingsConstraints)) {
        if (typeof settings[key] === 'number') {
            settings[key] = Math.max(min, Math.min(max, Math.round(settings[key])));
        }
    }
    // Ensure tags are trimmed strings
    if (typeof settings.lorebookTag === 'string') {
        settings.lorebookTag = settings.lorebookTag.trim() || 'lorebook';
    }
}

/** @returns {typeof defaultSettings} */
function getSettings() {
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = {};
    }
    // Fill in any missing defaults
    for (const [key, value] of Object.entries(defaultSettings)) {
        if (extension_settings[MODULE_NAME][key] === undefined) {
            extension_settings[MODULE_NAME][key] = value;
        }
    }
    validateSettings(extension_settings[MODULE_NAME]);
    return extension_settings[MODULE_NAME];
}

// ============================================================================
// Vault Index Cache
// ============================================================================

/**
 * @typedef {object} VaultEntry
 * @property {string} filename - Full path in vault
 * @property {string} title - Display title (from H1 or filename)
 * @property {string[]} keys - Trigger keywords from frontmatter
 * @property {string} content - Cleaned markdown content (frontmatter stripped)
 * @property {number} priority - Sort priority (lower = higher priority)
 * @property {boolean} constant - Always inject regardless of keywords
 * @property {number} tokenEstimate - Rough token count estimate
 * @property {number|null} scanDepth - Per-entry scan depth override (null = use global)
 * @property {boolean} excludeRecursion - Don't scan this entry's content during recursion
 * @property {string[]} links - Wiki-link targets extracted before cleaning
 * @property {string[]} resolvedLinks - Links confirmed to match existing entry titles
 * @property {string[]} requires - Entry titles that must all be matched for this entry to activate
 * @property {string[]} excludes - Entry titles that, if any matched, prevent this entry from activating
 * @property {number|null} injectionPosition - Per-entry injection position override (null = use global)
 * @property {number|null} injectionDepth - Per-entry injection depth override (null = use global)
 * @property {number|null} injectionRole - Per-entry injection role override (null = use global)
 * @property {number|null} cooldown - Generations to skip after triggering (null = no cooldown)
 * @property {number|null} warmup - Keyword hit count required before triggering (null = no warmup)
 */

/** @type {VaultEntry[]} */
let vaultIndex = [];
let indexTimestamp = 0;
let indexing = false;

/** Vault Sync: previous index snapshot for change detection */
let previousIndexSnapshot = null;

/** Vault Sync: polling interval ID */
let syncIntervalId = null;

/** Cooldown tracking: title → remaining generations to skip */
let cooldownTracker = new Map();

/** Generation counter (reset per chat) */
let generationCount = 0;

/** Re-injection tracking: title → generation number when last injected */
let injectionHistory = new Map();

/**
 * Parse simple YAML frontmatter from markdown content.
 * Handles basic key-value pairs and arrays (indented with - ).
 * @param {string} content - Raw markdown content
 * @returns {{ frontmatter: object, body: string }}
 */
function parseFrontmatter(content) {
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
    if (!match) {
        return { frontmatter: {}, body: content };
    }

    const yamlText = match[1];
    const body = match[2];
    const frontmatter = {};
    let currentKey = null;
    let currentArray = null;

    for (const line of yamlText.split('\n')) {
        const trimmed = line.trimEnd();

        // Array item: "  - value"
        if (/^\s+-\s+/.test(trimmed) && currentKey) {
            const value = trimmed.replace(/^\s+-\s+/, '').trim();
            if (!currentArray) {
                currentArray = [];
                frontmatter[currentKey] = currentArray;
            }
            currentArray.push(value);
            continue;
        }

        // Key-value pair: "key: value" or "key:"
        const kvMatch = trimmed.match(/^(\w[\w-]*)\s*:\s*(.*)/);
        if (kvMatch) {
            currentKey = kvMatch[1];
            const rawValue = kvMatch[2].trim();
            currentArray = null;

            if (rawValue === '' || rawValue === '[]') {
                // Value will come as array items on next lines, or is empty
                frontmatter[currentKey] = [];
                currentArray = frontmatter[currentKey];
            } else if (rawValue.startsWith('[') && rawValue.endsWith(']')) {
                // Inline YAML array: [value1, value2, "quoted value"]
                const inner = rawValue.slice(1, -1).trim();
                if (inner === '') {
                    frontmatter[currentKey] = [];
                } else {
                    frontmatter[currentKey] = inner.split(',').map(item => {
                        return item.trim().replace(/^['"]|['"]$/g, '');
                    });
                }
                currentArray = frontmatter[currentKey];
            } else if (rawValue === 'true') {
                frontmatter[currentKey] = true;
            } else if (rawValue === 'false') {
                frontmatter[currentKey] = false;
            } else if (/^-?\d+(\.\d+)?$/.test(rawValue)) {
                frontmatter[currentKey] = Number(rawValue);
            } else {
                // Strip surrounding quotes if present
                frontmatter[currentKey] = rawValue.replace(/^['"]|['"]$/g, '');
            }
        }
    }

    return { frontmatter, body };
}

/**
 * Extract wiki-link targets from raw markdown body before cleaning.
 * Handles [[Target]] and [[Target|Display]] forms.
 * Excludes image embeds (![[...]]).
 * @param {string} body - Raw markdown body (before cleanContent)
 * @returns {string[]} Deduplicated array of link target page names
 */
function extractWikiLinks(body) {
    const links = new Set();
    const regex = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
    let match;
    while ((match = regex.exec(body)) !== null) {
        // Skip image embeds (prefixed with !)
        if (match.index > 0 && body[match.index - 1] === '!') continue;
        links.add(match[1].trim());
    }
    return [...links];
}

/**
 * Clean markdown content for prompt injection.
 * @param {string} content - Raw markdown body (frontmatter already stripped)
 * @returns {string} Cleaned content
 */
function cleanContent(content) {
    let cleaned = content;

    // Strip %%deeplore-exclude%%...%%/deeplore-exclude%% regions (user-controlled exclusion)
    cleaned = cleaned.replace(/%%deeplore-exclude%%[\s\S]*?%%\/deeplore-exclude%%/g, '');

    // Strip remaining Obsidian %%...%% comment/plugin blocks (timeline annotations, dataview, etc.)
    cleaned = cleaned.replace(/%%[\s\S]*?%%/g, '');

    // Strip HTML div tags (keep content inside)
    cleaned = cleaned.replace(/<\/?div[^>]*>/g, '');

    // Strip the first H1 heading (already used as entry title in XML wrapper)
    cleaned = cleaned.replace(/^#\s+.+$/m, '');

    // Strip image embeds: ![[image.png]] or ![alt](url)
    cleaned = cleaned.replace(/!\[\[.*?\]\]/g, '');
    cleaned = cleaned.replace(/!\[.*?\]\(.*?\)/g, '');

    // Convert wiki links: [[Link|Display]] -> Display, [[Link]] -> Link
    cleaned = cleaned.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2');
    cleaned = cleaned.replace(/\[\[([^\]]+)\]\]/g, '$1');

    // Collapse excessive blank lines
    cleaned = cleaned.replace(/\n{3,}/g, '\n\n');

    return cleaned.trim();
}

/**
 * Extract title from markdown content.
 * @param {string} body - Markdown body
 * @param {string} filename - Fallback filename
 * @returns {string}
 */
function extractTitle(body, filename) {
    const h1Match = body.match(/^#\s+(.+)$/m);
    if (h1Match) {
        return h1Match[1].trim();
    }
    // Fallback: filename without extension and path
    const parts = filename.split('/');
    const name = parts[parts.length - 1];
    return name.replace(/\.md$/, '');
}

/**
 * Truncate text at a sentence boundary.
 * @param {string} text
 * @param {number} maxLen
 * @returns {string}
 */
function truncateToSentence(text, maxLen) {
    if (text.length <= maxLen) return text;
    const truncated = text.substring(0, maxLen);
    // Find the last sentence boundary (., !, ?) before the limit
    const lastSentence = truncated.search(/[.!?][^.!?]*$/);
    if (lastSentence > maxLen * 0.4) {
        return truncated.substring(0, lastSentence + 1);
    }
    // No good sentence boundary found; fall back to hard cut with ellipsis
    return truncated.trimEnd() + '...';
}

/**
 * Resolve raw wiki-link targets to confirmed entry titles in the vault index.
 * Must be called after vaultIndex is fully populated.
 */
function resolveLinks() {
    const titleMap = new Map(vaultIndex.map(e => [e.title.toLowerCase(), e.title]));
    for (const entry of vaultIndex) {
        entry.resolvedLinks = entry.links
            .map(l => titleMap.get(l.toLowerCase()))
            .filter(Boolean);
    }
}

/**
 * Compute a simple hash for cache comparison.
 * @param {string} text
 * @returns {string}
 */
function simpleHash(text) {
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
        const char = text.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash |= 0; // Convert to 32-bit integer
    }
    return `${text.length}:${hash}`;
}

/**
 * Take a snapshot of the current vault index for change detection.
 * @returns {{ contentHashes: Map<string, string>, titleMap: Map<string, string>, keyMap: Map<string, string>, timestamp: number }}
 */
function takeIndexSnapshot() {
    const snapshot = {
        contentHashes: new Map(),
        titleMap: new Map(),
        keyMap: new Map(),
        timestamp: Date.now(),
    };
    for (const entry of vaultIndex) {
        snapshot.contentHashes.set(entry.filename, simpleHash(entry.content));
        snapshot.titleMap.set(entry.filename, entry.title);
        snapshot.keyMap.set(entry.filename, JSON.stringify(entry.keys));
    }
    return snapshot;
}

/**
 * Detect changes between two index snapshots.
 * @param {ReturnType<typeof takeIndexSnapshot>} oldSnapshot
 * @param {ReturnType<typeof takeIndexSnapshot>} newSnapshot
 * @returns {{ added: string[], removed: string[], modified: string[], keysChanged: string[], hasChanges: boolean }}
 */
function detectChanges(oldSnapshot, newSnapshot) {
    const changes = { added: [], removed: [], modified: [], keysChanged: [], hasChanges: false };
    if (!oldSnapshot) return changes;

    const oldFiles = new Set(oldSnapshot.contentHashes.keys());
    const newFiles = new Set(newSnapshot.contentHashes.keys());

    for (const file of newFiles) {
        if (!oldFiles.has(file)) {
            changes.added.push(newSnapshot.titleMap.get(file) || file);
        }
    }
    for (const file of oldFiles) {
        if (!newFiles.has(file)) {
            changes.removed.push(oldSnapshot.titleMap.get(file) || file);
        }
    }
    for (const file of newFiles) {
        if (oldFiles.has(file)) {
            if (oldSnapshot.contentHashes.get(file) !== newSnapshot.contentHashes.get(file)) {
                changes.modified.push(newSnapshot.titleMap.get(file) || file);
            }
            if (oldSnapshot.keyMap.get(file) !== newSnapshot.keyMap.get(file)) {
                const title = newSnapshot.titleMap.get(file) || file;
                if (!changes.modified.includes(title)) {
                    changes.keysChanged.push(title);
                }
            }
        }
    }

    changes.hasChanges = changes.added.length > 0 || changes.removed.length > 0
        || changes.modified.length > 0 || changes.keysChanged.length > 0;
    return changes;
}

/**
 * Show a toast notification with vault change details.
 * @param {{ added: string[], removed: string[], modified: string[], keysChanged: string[] }} changes
 */
function showChangesToast(changes) {
    const maxShow = 3;
    const parts = [];
    if (changes.added.length > 0) {
        const names = changes.added.slice(0, maxShow).map(n => escapeHtml(n)).join(', ');
        const extra = changes.added.length > maxShow ? ` +${changes.added.length - maxShow} more` : '';
        parts.push(`<b>Added:</b> ${names}${extra}`);
    }
    if (changes.removed.length > 0) {
        const names = changes.removed.slice(0, maxShow).map(n => escapeHtml(n)).join(', ');
        const extra = changes.removed.length > maxShow ? ` +${changes.removed.length - maxShow} more` : '';
        parts.push(`<b>Removed:</b> ${names}${extra}`);
    }
    if (changes.modified.length > 0) {
        const names = changes.modified.slice(0, maxShow).map(n => escapeHtml(n)).join(', ');
        const extra = changes.modified.length > maxShow ? ` +${changes.modified.length - maxShow} more` : '';
        parts.push(`<b>Modified:</b> ${names}${extra}`);
    }
    if (changes.keysChanged.length > 0) {
        const names = changes.keysChanged.slice(0, maxShow).map(n => escapeHtml(n)).join(', ');
        const extra = changes.keysChanged.length > maxShow ? ` +${changes.keysChanged.length - maxShow} more` : '';
        parts.push(`<b>Keys changed:</b> ${names}${extra}`);
    }
    if (parts.length > 0) {
        toastr.info(parts.join('<br>'), 'DeepLore - Vault Updated', { timeOut: 8000, escapeHtml: false });
    }
}

/**
 * Set up automatic vault sync polling.
 */
function setupSyncPolling() {
    if (syncIntervalId) {
        clearInterval(syncIntervalId);
        syncIntervalId = null;
    }
    const settings = getSettings();
    if (settings.syncPollingInterval > 0) {
        syncIntervalId = setInterval(async () => {
            if (!settings.enabled || indexing) return;
            await buildIndex();
        }, settings.syncPollingInterval * 1000);
    }
}

/**
 * Count total keyword occurrences for an entry in the given text.
 * Used for warmup threshold checking.
 * @param {VaultEntry} entry
 * @param {string} scanText
 * @param {typeof defaultSettings} settings
 * @returns {number}
 */
function countKeywordOccurrences(entry, scanText, settings) {
    let total = 0;
    for (const rawKey of entry.keys) {
        if (settings.matchWholeWords) {
            const regex = new RegExp(`\\b${escapeRegex(rawKey)}\\b`, 'g' + (settings.caseSensitive ? '' : 'i'));
            const matches = scanText.match(regex);
            total += matches ? matches.length : 0;
        } else {
            const haystack = settings.caseSensitive ? scanText : scanText.toLowerCase();
            const key = settings.caseSensitive ? rawKey : rawKey.toLowerCase();
            let idx = 0;
            while ((idx = haystack.indexOf(key, idx)) !== -1) {
                total++;
                idx += key.length;
            }
        }
    }
    return total;
}

/**
 * Build the vault index by fetching all files from the server plugin.
 */
async function buildIndex() {
    const settings = getSettings();

    if (indexing) {
        console.debug('[DeepLore] Index build already in progress');
        return;
    }

    indexing = true;

    try {
        const response = await fetch(`${PLUGIN_BASE}/index`, {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                port: settings.obsidianPort,
                apiKey: settings.obsidianApiKey,
            }),
        });

        if (!response.ok) {
            throw new Error(`Server plugin returned HTTP ${response.status}`);
        }

        const data = await response.json();

        if (!data.files || !Array.isArray(data.files)) {
            throw new Error('Invalid response from server plugin');
        }

        const entries = [];
        const tagToMatch = settings.lorebookTag.toLowerCase();
        const constantTagToMatch = settings.constantTag ? settings.constantTag.toLowerCase() : '';
        const neverInsertTagToMatch = settings.neverInsertTag ? settings.neverInsertTag.toLowerCase() : '';

        for (const file of data.files) {
            const { frontmatter, body } = parseFrontmatter(file.content);

            // Check if this file has the lorebook tag
            const tags = Array.isArray(frontmatter.tags)
                ? frontmatter.tags.map(t => String(t).toLowerCase())
                : [];

            if (!tags.includes(tagToMatch)) {
                continue;
            }

            // Skip entries explicitly disabled via frontmatter
            if (frontmatter.enabled === false) {
                continue;
            }

            // Skip entries with the never-insert tag
            if (neverInsertTagToMatch && tags.includes(neverInsertTagToMatch)) {
                continue;
            }

            // Extract keys
            const keys = Array.isArray(frontmatter.keys)
                ? frontmatter.keys.map(k => String(k))
                : [];

            const title = extractTitle(body, file.filename);
            const links = extractWikiLinks(body);
            const content = cleanContent(body);
            const priority = typeof frontmatter.priority === 'number' ? frontmatter.priority : 100;
            const constant = frontmatter.constant === true || (constantTagToMatch && tags.includes(constantTagToMatch));
            const scanDepth = typeof frontmatter.scanDepth === 'number' ? frontmatter.scanDepth : null;
            const excludeRecursion = frontmatter.excludeRecursion === true;
            const cooldown = typeof frontmatter.cooldown === 'number' ? frontmatter.cooldown : null;
            const warmup = typeof frontmatter.warmup === 'number' ? frontmatter.warmup : null;

            // Conditional gating
            const requires = Array.isArray(frontmatter.requires)
                ? frontmatter.requires.map(r => String(r).trim()).filter(Boolean) : [];
            const excludes = Array.isArray(frontmatter.excludes)
                ? frontmatter.excludes.map(r => String(r).trim()).filter(Boolean) : [];

            // Per-entry injection position overrides
            const positionMap = { before: 2, after: 0, in_chat: 1 };
            const roleMap = { system: 0, user: 1, assistant: 2 };

            const injectionPosition = typeof frontmatter.position === 'string'
                ? (positionMap[frontmatter.position.toLowerCase()] ?? null) : null;
            const injectionDepth = typeof frontmatter.depth === 'number'
                ? frontmatter.depth : null;
            const injectionRole = typeof frontmatter.role === 'string'
                ? (roleMap[frontmatter.role.toLowerCase()] ?? null) : null;

            entries.push({
                filename: file.filename,
                title,
                keys,
                content,
                priority,
                constant,
                tokenEstimate: 0,
                scanDepth,
                excludeRecursion,
                links,
                resolvedLinks: [],
                requires,
                excludes,
                injectionPosition,
                injectionDepth,
                injectionRole,
                cooldown,
                warmup,
            });
        }

        // Compute accurate token counts using SillyTavern's tokenizer
        await Promise.all(entries.map(async (entry) => {
            try {
                entry.tokenEstimate = await getTokenCountAsync(entry.content);
            } catch {
                // Fallback to rough estimate if tokenizer unavailable
                entry.tokenEstimate = Math.ceil(entry.content.length / 3.5);
            }
        }));

        vaultIndex = entries;
        indexTimestamp = Date.now();

        // Resolve wiki-links to confirmed entry titles
        resolveLinks();

        // Vault change detection
        const newSnapshot = takeIndexSnapshot();
        if (previousIndexSnapshot) {
            const changes = detectChanges(previousIndexSnapshot, newSnapshot);
            if (changes.hasChanges) {
                if (settings.showSyncToasts) {
                    showChangesToast(changes);
                }
                if (settings.debugMode) {
                    console.log('[DeepLore] Vault changes detected:', changes);
                }
            }
        }
        previousIndexSnapshot = newSnapshot;

        console.log(`[DeepLore] Indexed ${entries.length} entries from ${data.total} vault files`);
        updateIndexStats();
    } catch (err) {
        console.error('[DeepLore] Failed to build index:', err);
        toastr.error(String(err), 'DeepLore', { preventDuplicates: true });
    } finally {
        indexing = false;
    }
}

/**
 * Get the max response token length from the current connection profile.
 * @returns {number}
 */
function getMaxResponseTokens() {
    return main_api === 'openai' ? oai_settings.openai_max_tokens : amount_gen;
}

/**
 * Ensure the vault index is fresh, rebuilding if cache has expired.
 */
async function ensureIndexFresh() {
    const settings = getSettings();
    const ttlMs = settings.cacheTTL * 1000;
    const now = Date.now();

    if (vaultIndex.length === 0 || ttlMs === 0 || now - indexTimestamp > ttlMs) {
        await buildIndex();
    }
}

// ============================================================================
// Keyword Matching
// ============================================================================

/**
 * Escape a string for use in a regex.
 * @param {string} str
 * @returns {string}
 */
function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build scan text from chat messages.
 * @param {object[]} chat - Chat messages array
 * @param {number} depth - Number of recent messages to scan
 * @returns {string}
 */
function buildScanText(chat, depth) {
    if (depth <= 0) return '';
    const recentMessages = chat.slice(-Math.min(depth, chat.length));
    return recentMessages
        .map(m => `${m.name || ''}: ${m.mes || ''}`)
        .join('\n');
}

/**
 * Test if an entry's keys match against the given text.
 * @param {VaultEntry} entry
 * @param {string} scanText
 * @param {typeof defaultSettings} settings
 * @returns {string|null} The matched key, or null if no match
 */
function testEntryMatch(entry, scanText, settings) {
    if (entry.keys.length === 0) return null;

    const haystack = settings.caseSensitive ? scanText : scanText.toLowerCase();

    for (const rawKey of entry.keys) {
        const key = settings.caseSensitive ? rawKey : rawKey.toLowerCase();

        if (settings.matchWholeWords) {
            const regex = new RegExp(`\\b${escapeRegex(key)}\\b`, settings.caseSensitive ? '' : 'i');
            if (regex.test(scanText)) return rawKey;
        } else {
            if (haystack.includes(key)) return rawKey;
        }
    }
    return null;
}

/**
 * Match vault entries against chat messages, with recursive scanning support.
 * @param {object[]} chat - Chat messages array
 * @returns {{ matched: VaultEntry[], matchedKeys: Map<string, string> }} Matched entries sorted by priority, and which key matched each
 */
function matchEntries(chat) {
    const settings = getSettings();
    /** @type {Set<VaultEntry>} */
    const matchedSet = new Set();
    /** @type {Map<string, string>} entry title -> matched key */
    const matchedKeys = new Map();

    // Always collect constants regardless of scan depth
    for (const entry of vaultIndex) {
        if (entry.constant) {
            matchedSet.add(entry);
            matchedKeys.set(entry.title, '(constant)');
        }
    }

    // Keyword matching: skip entirely when scanDepth is 0
    if (settings.scanDepth > 0) {
        const globalScanText = buildScanText(chat, settings.scanDepth);

        // Initial scan pass
        for (const entry of vaultIndex) {
            if (entry.constant) continue; // Already added above

            // Skip entries on cooldown
            if (entry.cooldown !== null && cooldownTracker.has(entry.title) && cooldownTracker.get(entry.title) > 0) {
                continue;
            }

            // Use per-entry scan depth if set, otherwise use global scan text
            const scanText = entry.scanDepth !== null
                ? buildScanText(chat, entry.scanDepth)
                : globalScanText;

            const key = testEntryMatch(entry, scanText, settings);
            if (key) {
                // Warmup check: require N keyword occurrences before triggering
                if (entry.warmup !== null && entry.warmup > 1) {
                    const count = countKeywordOccurrences(entry, scanText, settings);
                    if (count < entry.warmup) {
                        continue;
                    }
                }
                matchedSet.add(entry);
                matchedKeys.set(entry.title, key);
            }
        }

        // Recursive scanning: scan matched entry content for more matches
        if (settings.recursiveScan && settings.maxRecursionSteps > 0) {
            let step = 0;
            /** @type {Set<VaultEntry>} Entries added in the previous step (seed with initial matches) */
            let newlyMatched = new Set(matchedSet);

            while (newlyMatched.size > 0 && step < settings.maxRecursionSteps) {
                step++;

                // Only scan content from entries added in the previous step
                const recursionText = [...newlyMatched]
                    .filter(e => !e.excludeRecursion)
                    .map(e => e.content)
                    .join('\n');

                if (!recursionText.trim()) break;

                newlyMatched = new Set();

                for (const entry of vaultIndex) {
                    if (matchedSet.has(entry)) continue;
                    if (entry.constant) continue; // Already added

                    const key = testEntryMatch(entry, recursionText, settings);
                    if (key) {
                        matchedSet.add(entry);
                        newlyMatched.add(entry);
                        matchedKeys.set(entry.title, `${key} (recursion step ${step})`);
                    }
                }
            }
        }
    }

    // Sort by priority (ascending - lower number = higher priority)
    const matched = [...matchedSet].sort((a, b) => a.priority - b.priority);

    return { matched, matchedKeys };
}

/**
 * Apply conditional gating rules (requires/excludes) to matched entries.
 * Iterates until stable since removing a gated entry may affect another's requires.
 * @param {VaultEntry[]} entries - Matched entries (already merged)
 * @returns {VaultEntry[]}
 */
function applyGating(entries) {
    let result = [...entries];
    let changed = true;
    let iterations = 0;
    const MAX_ITERATIONS = 10;

    while (changed && iterations < MAX_ITERATIONS) {
        changed = false;
        iterations++;
        const activeTitles = new Set(result.map(e => e.title.toLowerCase()));

        result = result.filter(entry => {
            // Check requires: ALL must be in the active set
            if (entry.requires.length > 0) {
                const allPresent = entry.requires.every(r => activeTitles.has(r.toLowerCase()));
                if (!allPresent) {
                    changed = true;
                    return false;
                }
            }
            // Check excludes: NONE should be in the active set
            if (entry.excludes.length > 0) {
                const anyPresent = entry.excludes.some(r => activeTitles.has(r.toLowerCase()));
                if (anyPresent) {
                    changed = true;
                    return false;
                }
            }
            return true;
        });
    }

    return result;
}

/**
 * @typedef {object} PromptGroup
 * @property {string} tag - Prompt tag key for setExtensionPrompt
 * @property {string} text - Combined formatted text for this group
 * @property {number} position - extension_prompt_types value
 * @property {number} depth - Injection depth
 * @property {number} role - extension_prompt_roles value
 */

/**
 * Format matched entries for injection, respecting budget limits, grouped by injection position.
 * Entries can override the global injection position/depth/role via frontmatter.
 * @param {VaultEntry[]} entries - Matched entries sorted by priority
 * @returns {{ groups: PromptGroup[], count: number, totalTokens: number }}
 */
function formatAndGroup(entries) {
    const settings = getSettings();
    const template = settings.injectionTemplate || '<{{title}}>\n{{content}}\n</{{title}}>';
    let totalTokens = 0;
    let count = 0;

    /** @type {{ entry: VaultEntry, position: number, depth: number, role: number }[]} */
    const accepted = [];

    for (const entry of entries) {
        if (!settings.unlimitedEntries && count >= settings.maxEntries) break;
        if (!settings.unlimitedBudget && totalTokens + entry.tokenEstimate > settings.maxTokensBudget && count > 0) break;

        accepted.push({
            entry,
            position: entry.injectionPosition ?? settings.injectionPosition,
            depth: entry.injectionDepth ?? settings.injectionDepth,
            role: entry.injectionRole ?? settings.injectionRole,
        });
        totalTokens += entry.tokenEstimate;
        count++;
    }

    // Group by (position, depth, role)
    /** @type {Map<string, { tag: string, position: number, depth: number, role: number, texts: string[] }>} */
    const groupMap = new Map();
    for (const item of accepted) {
        const key = `${PROMPT_TAG_PREFIX}p${item.position}_d${item.depth}_r${item.role}`;
        if (!groupMap.has(key)) {
            groupMap.set(key, {
                tag: key,
                position: item.position,
                depth: item.depth,
                role: item.role,
                texts: [],
            });
        }
        const text = template
            .replace(/\{\{title\}\}/g, item.entry.title)
            .replace(/\{\{content\}\}/g, item.entry.content);
        groupMap.get(key).texts.push(text);
    }

    const groups = [...groupMap.values()].map(g => ({
        tag: g.tag,
        text: g.texts.join('\n\n'),
        position: g.position,
        depth: g.depth,
        role: g.role,
    }));

    return { groups, count, totalTokens };
}

/**
 * Clear all DeepLore-managed extension prompts from the prompt dictionary.
 * Prevents stale prompts from previous runs persisting when injection positions change.
 */
function clearDeeplorePrompts() {
    for (const key of Object.keys(extension_prompts)) {
        if (key.startsWith(PROMPT_TAG_PREFIX) || key === PROMPT_TAG) {
            delete extension_prompts[key];
        }
    }
}

// ============================================================================
// Generation Interceptor
// ============================================================================

/** Track last warning ratio to avoid spamming toasts */
let lastWarningRatio = 0;

/**
 * Called by SillyTavern's generation interceptor system.
 * @param {object[]} chat - Array of chat messages
 * @param {number} contextSize - Context size
 * @param {function} abort - Abort callback
 * @param {string} type - Generation type
 */
async function onGenerate(chat, contextSize, abort, type) {
    const settings = getSettings();

    if (type === 'quiet' || !settings.enabled) {
        return;
    }

    // Clear all previous DeepLore prompts
    clearDeeplorePrompts();

    try {
        // Ensure index is fresh
        await ensureIndexFresh();

        if (vaultIndex.length === 0) {
            if (settings.debugMode) {
                console.debug('[DeepLore] No entries indexed, skipping');
            }
            return;
        }

        // Match entries (now takes chat array for per-entry scan depth)
        const { matched, matchedKeys } = matchEntries(chat);

        // Re-injection cooldown: filter out recently injected non-constant entries
        let filteredEntries = matched;
        if (settings.reinjectionCooldown > 0) {
            const threshold = generationCount - settings.reinjectionCooldown;
            filteredEntries = matched.filter(entry => {
                if (entry.constant) return true;
                const lastInjected = injectionHistory.get(entry.title);
                if (lastInjected !== undefined && lastInjected > threshold) {
                    if (settings.debugMode) {
                        console.log(`[DeepLore] Skipping "${entry.title}" (injected ${generationCount - lastInjected} gen ago, cooldown ${settings.reinjectionCooldown})`);
                    }
                    return false;
                }
                return true;
            });
        }

        if (filteredEntries.length === 0) {
            if (settings.debugMode) {
                console.debug('[DeepLore] No entries matched');
            }
            return;
        }

        // Apply conditional gating (requires/excludes)
        const gated = applyGating(filteredEntries);

        if (settings.debugMode && gated.length < matched.length) {
            const removed = matched.filter(e => !gated.includes(e));
            console.log(`[DeepLore] Gating removed ${removed.length} entries:`,
                removed.map(e => ({ title: e.title, requires: e.requires, excludes: e.excludes })));
        }

        if (gated.length === 0) {
            if (settings.debugMode) {
                console.debug('[DeepLore] All entries removed by gating rules');
            }
            return;
        }

        // Format with budget, grouped by injection position
        const { groups, count: injectedCount, totalTokens } = formatAndGroup(gated);

        if (groups.length > 0) {
            for (const group of groups) {
                setExtensionPrompt(
                    group.tag,
                    group.text,
                    group.position,
                    group.depth,
                    settings.allowWIScan,
                    group.role,
                );
            }

            // Context usage warning
            if (contextSize > 0) {
                const ratio = totalTokens / contextSize;
                if (ratio > 0.20 && ratio > lastWarningRatio + 0.05) {
                    const pct = Math.round(ratio * 100);
                    toastr.warning(
                        `${injectedCount} entries injected (~${totalTokens} tokens, ${pct}% of context). Consider setting a token budget.`,
                        'DeepLore',
                        { preventDuplicates: true, timeOut: 8000 },
                    );
                    lastWarningRatio = ratio;
                }
            }

            if (settings.debugMode) {
                console.log(`[DeepLore] ${matched.length} matched, ${gated.length} after gating, ${injectedCount} injected (~${totalTokens} tokens) in ${groups.length} group(s)` +
                    (contextSize > 0 ? ` (${Math.round(totalTokens / contextSize * 100)}% of ${contextSize} context)` : ''));
                console.table(gated.slice(0, injectedCount).map(e => ({
                    title: e.title,
                    matchedBy: matchedKeys.get(e.title) || '?',
                    priority: e.priority,
                    tokens: e.tokenEstimate,
                    constant: e.constant,
                })));
                if (groups.length > 1) {
                    console.log('[DeepLore] Injection groups:', groups.map(g =>
                        `${g.tag}: pos=${g.position} depth=${g.depth} role=${g.role}`));
                }
            }

            // Track generation count and update cooldowns
            generationCount++;

            // Decrement all active cooldowns
            for (const [title, remaining] of cooldownTracker.entries()) {
                if (remaining <= 1) {
                    cooldownTracker.delete(title);
                } else {
                    cooldownTracker.set(title, remaining - 1);
                }
            }

            // Set cooldowns for newly injected entries
            const injectedEntries = gated.slice(0, injectedCount);
            for (const entry of injectedEntries) {
                if (entry.cooldown !== null && entry.cooldown > 0) {
                    cooldownTracker.set(entry.title, entry.cooldown);
                }
                // Record injection history
                injectionHistory.set(entry.title, generationCount);
            }

            // Update analytics
            const analytics = settings.analyticsData || {};
            for (const entry of filteredEntries) {
                if (!analytics[entry.title]) {
                    analytics[entry.title] = { matched: 0, injected: 0, lastTriggered: 0 };
                }
                analytics[entry.title].matched++;
            }
            for (const entry of injectedEntries) {
                if (!analytics[entry.title]) {
                    analytics[entry.title] = { matched: 0, injected: 0, lastTriggered: 0 };
                }
                analytics[entry.title].injected++;
                analytics[entry.title].lastTriggered = Date.now();
            }
            settings.analyticsData = analytics;
            saveSettingsDebounced();
        }
    } catch (err) {
        console.error('[DeepLore] Error during generation:', err);
    }
}

// Register the interceptor on globalThis so SillyTavern can find it
globalThis.deepLore_onGenerate = onGenerate;

/**
 * External API: match vault entries against arbitrary text.
 * Used by other extensions to get lore without going through the interceptor.
 * @param {string|object[]} scanInput - Text string or array of {name, mes, is_user} chat objects
 * @returns {Promise<{text: string, count: number, tokens: number}>}
 */
async function matchTextForExternal(scanInput) {
    const settings = getSettings();
    if (!settings.enabled) return { text: '', count: 0, tokens: 0 };

    await ensureIndexFresh();
    if (vaultIndex.length === 0) return { text: '', count: 0, tokens: 0 };

    const fakeChat = typeof scanInput === 'string'
        ? [{ name: 'context', mes: scanInput, is_user: true }]
        : scanInput;

    const { matched } = matchEntries(fakeChat);
    const gated = applyGating(matched);
    const { groups, count, totalTokens } = formatAndGroup(gated);

    const combinedText = groups.map(g => g.text).join('\n\n');
    return { text: combinedText, count, tokens: totalTokens };
}

globalThis.deepLore_matchText = matchTextForExternal;

// ============================================================================
// UI & Settings Binding
// ============================================================================

function updateIndexStats() {
    const statsEl = document.getElementById('deeplore_index_stats');
    if (statsEl) {
        if (vaultIndex.length > 0) {
            const totalKeys = vaultIndex.reduce((sum, e) => sum + e.keys.length, 0);
            const constants = vaultIndex.filter(e => e.constant).length;
            const totalTokens = vaultIndex.reduce((sum, e) => sum + e.tokenEstimate, 0);
            statsEl.textContent = `${vaultIndex.length} entries (${totalKeys} keywords, ${constants} always-send, ~${totalTokens} total tokens)`;
        } else {
            statsEl.textContent = 'No index loaded.';
        }
    }
}

function loadSettingsUI() {
    const settings = getSettings();

    $('#deeplore_enabled').prop('checked', settings.enabled);
    $('#deeplore_port').val(settings.obsidianPort);
    $('#deeplore_api_key').val(settings.obsidianApiKey);
    $('#deeplore_tag').val(settings.lorebookTag);
    $('#deeplore_constant_tag').val(settings.constantTag);
    $('#deeplore_never_insert_tag').val(settings.neverInsertTag);
    $('#deeplore_scan_depth').val(settings.scanDepth);
    $('#deeplore_max_entries').val(settings.maxEntries);
    $('#deeplore_unlimited_entries').prop('checked', settings.unlimitedEntries);
    $('#deeplore_max_entries').prop('disabled', settings.unlimitedEntries);
    $('#deeplore_token_budget').val(settings.maxTokensBudget);
    $('#deeplore_unlimited_budget').prop('checked', settings.unlimitedBudget);
    $('#deeplore_token_budget').prop('disabled', settings.unlimitedBudget);
    $('#deeplore_template').val(settings.injectionTemplate);
    $(`input[name="deeplore_position"][value="${settings.injectionPosition}"]`).prop('checked', true);
    $('#deeplore_depth').val(settings.injectionDepth);
    $('#deeplore_role').val(settings.injectionRole);
    $('#deeplore_allow_wi_scan').prop('checked', settings.allowWIScan);
    $('#deeplore_recursive_scan').prop('checked', settings.recursiveScan);
    $('#deeplore_max_recursion').val(settings.maxRecursionSteps);
    $('#deeplore_max_recursion').prop('disabled', !settings.recursiveScan);
    $('#deeplore_cache_ttl').val(settings.cacheTTL);
    $('#deeplore_review_tokens').val(settings.reviewResponseTokens);
    $('#deeplore_case_sensitive').prop('checked', settings.caseSensitive);
    $('#deeplore_match_whole_words').prop('checked', settings.matchWholeWords);
    $('#deeplore_debug').prop('checked', settings.debugMode);
    $('#deeplore_reinjection_cooldown').val(settings.reinjectionCooldown);
    $('#deeplore_sync_interval').val(settings.syncPollingInterval);
    $('#deeplore_show_sync_toasts').prop('checked', settings.showSyncToasts);

    updateIndexStats();
}

function bindSettingsEvents() {
    const settings = getSettings();

    $('#deeplore_enabled').on('change', function () {
        settings.enabled = $(this).prop('checked');
        saveSettingsDebounced();
    });

    $('#deeplore_port').on('input', function () {
        settings.obsidianPort = Number($(this).val()) || 27123;
        saveSettingsDebounced();
    });

    $('#deeplore_api_key').on('input', function () {
        settings.obsidianApiKey = String($(this).val());
        saveSettingsDebounced();
    });

    $('#deeplore_tag').on('input', function () {
        settings.lorebookTag = String($(this).val()).trim() || 'lorebook';
        saveSettingsDebounced();
    });

    $('#deeplore_constant_tag').on('input', function () {
        settings.constantTag = String($(this).val()).trim();
        saveSettingsDebounced();
    });

    $('#deeplore_never_insert_tag').on('input', function () {
        settings.neverInsertTag = String($(this).val()).trim();
        saveSettingsDebounced();
    });

    $('#deeplore_scan_depth').on('input', function () {
        const val = Number($(this).val());
        settings.scanDepth = isNaN(val) ? 4 : val;
        saveSettingsDebounced();
    });

    $('#deeplore_max_entries').on('input', function () {
        settings.maxEntries = Number($(this).val()) || 10;
        saveSettingsDebounced();
    });

    $('#deeplore_unlimited_entries').on('change', function () {
        settings.unlimitedEntries = $(this).prop('checked');
        $('#deeplore_max_entries').prop('disabled', settings.unlimitedEntries);
        saveSettingsDebounced();
    });

    $('#deeplore_token_budget').on('input', function () {
        settings.maxTokensBudget = Number($(this).val()) || 2048;
        saveSettingsDebounced();
    });

    $('#deeplore_unlimited_budget').on('change', function () {
        settings.unlimitedBudget = $(this).prop('checked');
        $('#deeplore_token_budget').prop('disabled', settings.unlimitedBudget);
        saveSettingsDebounced();
    });

    $('#deeplore_template').on('input', function () {
        settings.injectionTemplate = String($(this).val());
        saveSettingsDebounced();
    });

    $('input[name="deeplore_position"]').on('change', function () {
        settings.injectionPosition = Number($(this).val());
        saveSettingsDebounced();
    });

    $('#deeplore_depth').on('input', function () {
        const val = Number($(this).val());
        settings.injectionDepth = isNaN(val) ? 4 : val;
        saveSettingsDebounced();
    });

    $('#deeplore_role').on('change', function () {
        settings.injectionRole = Number($(this).val());
        saveSettingsDebounced();
    });

    $('#deeplore_allow_wi_scan').on('change', function () {
        settings.allowWIScan = $(this).prop('checked');
        saveSettingsDebounced();
    });

    $('#deeplore_recursive_scan').on('change', function () {
        settings.recursiveScan = $(this).prop('checked');
        $('#deeplore_max_recursion').prop('disabled', !settings.recursiveScan);
        saveSettingsDebounced();
    });

    $('#deeplore_max_recursion').on('input', function () {
        settings.maxRecursionSteps = Number($(this).val()) || 3;
        saveSettingsDebounced();
    });

    $('#deeplore_cache_ttl').on('input', function () {
        const val = Number($(this).val());
        settings.cacheTTL = isNaN(val) ? 300 : val;
        saveSettingsDebounced();
    });

    $('#deeplore_review_tokens').on('input', function () {
        settings.reviewResponseTokens = Number($(this).val()) || 0;
        saveSettingsDebounced();
    });

    $('#deeplore_case_sensitive').on('change', function () {
        settings.caseSensitive = $(this).prop('checked');
        saveSettingsDebounced();
    });

    $('#deeplore_match_whole_words').on('change', function () {
        settings.matchWholeWords = $(this).prop('checked');
        saveSettingsDebounced();
    });

    $('#deeplore_debug').on('change', function () {
        settings.debugMode = $(this).prop('checked');
        saveSettingsDebounced();
    });

    // Test Connection button
    $('#deeplore_test_connection').on('click', async function () {
        const statusEl = $('#deeplore_connection_status');
        statusEl.text('Testing...').removeClass('success failure');

        try {
            const response = await fetch(`${PLUGIN_BASE}/test`, {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({
                    port: settings.obsidianPort,
                    apiKey: settings.obsidianApiKey,
                }),
            });

            if (!response.ok) {
                throw new Error(`Server returned HTTP ${response.status}`);
            }

            const data = await response.json();

            if (data.ok) {
                const authStatus = data.authenticated ? 'authenticated' : 'not authenticated';
                statusEl.text(`Connected (${authStatus})`).addClass('success').removeClass('failure');
            } else {
                statusEl.text(`Failed: ${data.error}`).addClass('failure').removeClass('success');
            }
        } catch (err) {
            statusEl.text(`Error: ${err.message}`).addClass('failure').removeClass('success');
        }
    });

    // Refresh Index button
    $('#deeplore_refresh').on('click', async function () {
        $('#deeplore_index_stats').text('Refreshing...');
        vaultIndex = [];
        indexTimestamp = 0;
        await buildIndex();
    });

    $('#deeplore_reinjection_cooldown').on('input', function () {
        const val = Number($(this).val());
        settings.reinjectionCooldown = isNaN(val) ? 0 : val;
        saveSettingsDebounced();
    });

    $('#deeplore_sync_interval').on('input', function () {
        const val = Number($(this).val());
        settings.syncPollingInterval = isNaN(val) ? 0 : val;
        saveSettingsDebounced();
        setupSyncPolling();
    });

    $('#deeplore_show_sync_toasts').on('change', function () {
        settings.showSyncToasts = $(this).prop('checked');
        saveSettingsDebounced();
    });
}

// ============================================================================
// Slash Commands
// ============================================================================

function registerSlashCommands() {
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'deeplore-refresh',
        callback: async () => {
            vaultIndex = [];
            indexTimestamp = 0;
            await buildIndex();
            const msg = `Indexed ${vaultIndex.length} entries.`;
            toastr.success(msg, 'DeepLore');
            return msg;
        },
        helpString: 'Force refresh the DeepLore vault index cache.',
        returns: 'Status message',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'deeplore-status',
        callback: async () => {
            const settings = getSettings();
            const constants = vaultIndex.filter(e => e.constant).length;
            const totalTokens = vaultIndex.reduce((sum, e) => sum + e.tokenEstimate, 0);
            const lines = [
                `Enabled: ${settings.enabled}`,
                `Port: ${settings.obsidianPort}`,
                `Lorebook Tag: #${settings.lorebookTag}`,
                `Always-Send Tag: ${settings.constantTag ? '#' + settings.constantTag : '(none)'}`,
                `Never-Insert Tag: ${settings.neverInsertTag ? '#' + settings.neverInsertTag : '(none)'}`,
                `Entries: ${vaultIndex.length} (${constants} always-send, ~${totalTokens} tokens)`,
                `Budget: ${settings.unlimitedBudget ? 'unlimited' : settings.maxTokensBudget + ' tokens'}`,
                `Max Entries: ${settings.unlimitedEntries ? 'unlimited' : settings.maxEntries}`,
                `Recursive: ${settings.recursiveScan ? 'on (max ' + settings.maxRecursionSteps + ' steps)' : 'off'}`,
                `Cache: ${indexTimestamp ? Math.round((Date.now() - indexTimestamp) / 1000) + 's old' : 'none'} / TTL ${settings.cacheTTL}s`,
            ];
            const msg = lines.join('\n');
            toastr.info(msg, 'DeepLore', { timeOut: 10000 });
            return msg;
        },
        helpString: 'Show DeepLore connection status and index stats.',
        returns: 'Status information',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'deeplore-review',
        callback: async (_args, userPrompt) => {
            await ensureIndexFresh();

            if (vaultIndex.length === 0) {
                toastr.warning('No entries indexed. Check your connection and lorebook tag settings.', 'DeepLore');
                return '';
            }

            const loreDump = vaultIndex.map(entry => {
                return `## ${entry.title}\n${entry.content}`;
            }).join('\n\n---\n\n');

            const settings = getSettings();
            const totalTokens = vaultIndex.reduce((sum, e) => sum + e.tokenEstimate, 0);
            const responseTokens = settings.reviewResponseTokens > 0
                ? settings.reviewResponseTokens
                : getMaxResponseTokens();
            const budgetHint = `\n\nKeep your response under ${responseTokens} tokens.`;
            const defaultQuestion = 'Review this lorebook/world-building vault. Comment on consistency, gaps, interesting connections between entries, and any suggestions for improvement.';
            const question = (userPrompt && userPrompt.trim()) ? userPrompt.trim() : defaultQuestion;

            const message = `[DeepLore Review — ${vaultIndex.length} entries, ~${totalTokens} tokens]\n\n${loreDump}\n\n---\n\n${question}${budgetHint}`;
            if (settings.debugMode) {
                console.log('[DeepLore] Lore review prompt:', message);
            }

            toastr.info(`Sending ${vaultIndex.length} entries (~${totalTokens} tokens)...`, 'DeepLore', { timeOut: 5000 });

            await sendMessageAsUser(message, '');
            await Generate('normal');

            return '';
        },
        helpString: 'Send the entire Obsidian vault to the AI for review. Optionally provide a custom question, e.g. /deeplore-review What inconsistencies do you see?',
        returns: 'AI review posted to chat',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'deeplore-analytics',
        callback: async () => {
            const settings = getSettings();
            const analytics = settings.analyticsData || {};
            const titles = Object.keys(analytics).sort((a, b) => (analytics[b].injected || 0) - (analytics[a].injected || 0));

            let html = '<table style="width:100%;border-collapse:collapse;font-size:0.9em;">';
            html += '<tr><th style="text-align:left;border-bottom:1px solid #666;padding:4px;">Entry</th><th style="border-bottom:1px solid #666;padding:4px;">Matched</th><th style="border-bottom:1px solid #666;padding:4px;">Injected</th><th style="border-bottom:1px solid #666;padding:4px;">Last Used</th></tr>';

            for (const title of titles) {
                const d = analytics[title];
                const lastUsed = d.lastTriggered ? new Date(d.lastTriggered).toLocaleString() : 'Never';
                html += `<tr><td style="padding:4px;">${escapeHtml(title)}</td><td style="text-align:center;padding:4px;">${d.matched || 0}</td><td style="text-align:center;padding:4px;">${d.injected || 0}</td><td style="text-align:center;padding:4px;">${lastUsed}</td></tr>`;
            }
            html += '</table>';

            // Dead entries: indexed but never injected
            const neverInjected = vaultIndex.filter(e => !analytics[e.title] || (analytics[e.title].injected || 0) === 0);
            if (neverInjected.length > 0) {
                html += '<hr><h4>Never Injected</h4><ul>';
                for (const e of neverInjected) {
                    html += `<li>${escapeHtml(e.title)} (${e.keys.length} keys, priority ${e.priority})</li>`;
                }
                html += '</ul>';
            }

            if (titles.length === 0 && neverInjected.length === 0) {
                html = '<p>No analytics data yet. Generate some messages first.</p>';
            }

            await callGenericPopup(html, POPUP_TYPE.TEXT, '', { wide: true, large: true });
            return '';
        },
        helpString: 'Show entry usage analytics: how often each entry was matched and injected.',
        returns: 'Analytics popup',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'deeplore-health',
        callback: async () => {
            await ensureIndexFresh();
            if (vaultIndex.length === 0) {
                toastr.warning('No entries indexed.', 'DeepLore');
                return '';
            }

            const issues = [];
            const allTitles = new Set(vaultIndex.map(e => e.title));
            const keywordMap = new Map(); // keyword → [titles]

            for (const entry of vaultIndex) {
                // Empty keys on non-constant entries
                if (!entry.constant && entry.keys.length === 0) {
                    issues.push({ type: 'Empty Keys', entry: entry.title, detail: 'No trigger keywords defined' });
                }

                // Orphaned requires
                for (const req of entry.requires) {
                    if (!allTitles.has(req)) {
                        issues.push({ type: 'Orphaned Requires', entry: entry.title, detail: `References "${req}" which doesn't exist` });
                    }
                }

                // Orphaned excludes
                for (const exc of entry.excludes) {
                    if (!allTitles.has(exc)) {
                        issues.push({ type: 'Orphaned Excludes', entry: entry.title, detail: `References "${exc}" which doesn't exist` });
                    }
                }

                // Oversized entries
                if (entry.tokenEstimate > 1500) {
                    issues.push({ type: 'Oversized', entry: entry.title, detail: `~${entry.tokenEstimate} tokens (>1500)` });
                }

                // Build keyword map for duplicate detection
                for (const key of entry.keys) {
                    const lower = key.toLowerCase();
                    if (!keywordMap.has(lower)) keywordMap.set(lower, []);
                    keywordMap.get(lower).push(entry.title);
                }
            }

            // Duplicate keywords
            for (const [keyword, titles] of keywordMap) {
                if (titles.length > 1) {
                    issues.push({ type: 'Duplicate Keywords', entry: titles.join(', '), detail: `Keyword "${keyword}" shared by ${titles.length} entries` });
                }
            }

            let html;
            if (issues.length === 0) {
                html = '<p>No issues found! All entries look healthy.</p>';
            } else {
                const grouped = {};
                for (const issue of issues) {
                    if (!grouped[issue.type]) grouped[issue.type] = [];
                    grouped[issue.type].push(issue);
                }

                html = '';
                for (const [type, items] of Object.entries(grouped)) {
                    html += `<h4>${escapeHtml(type)} (${items.length})</h4><ul>`;
                    for (const item of items) {
                        html += `<li><strong>${escapeHtml(item.entry)}</strong>: ${escapeHtml(item.detail)}</li>`;
                    }
                    html += '</ul>';
                }
            }

            await callGenericPopup(html, POPUP_TYPE.TEXT, '', { wide: true, large: true });
            return '';
        },
        helpString: 'Audit vault entries for common issues: empty keys, orphaned requires/excludes, oversized entries, duplicate keywords.',
        returns: 'Health check popup',
    }));
}

// ============================================================================
// Initialization
// ============================================================================

jQuery(async function () {
    try {
        const settingsHtml = await renderExtensionTemplateAsync(
            'third-party/sillytavern-DeepLore',
            'settings',
        );
        $('#extensions_settings2').append(settingsHtml);

        loadSettingsUI();
        bindSettingsEvents();
        registerSlashCommands();
        setupSyncPolling();

        // Reset per-chat state on chat change
        eventSource.on(event_types.CHAT_CHANGED, () => {
            injectionHistory.clear();
            cooldownTracker.clear();
            generationCount = 0;
        });

        console.log('[DeepLore] Client extension initialized');
    } catch (err) {
        console.error('[DeepLore] Failed to initialize:', err);
    }
});
