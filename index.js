import {
    setExtensionPrompt,
    getRequestHeaders,
    saveSettingsDebounced,
    sendMessageAsUser,
    Generate,
    amount_gen,
    main_api,
    name2,
    chat,
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
import { parseFrontmatter, extractWikiLinks, cleanContent, extractTitle, truncateToSentence, simpleHash, escapeRegex, buildScanText, validateSettings } from './core/utils.js';
import { testEntryMatch, countKeywordOccurrences, applyGating, resolveLinks, formatAndGroup } from './core/matching.js';
import { parseVaultFile, clearPrompts } from './core/pipeline.js';
import { takeIndexSnapshot, detectChanges } from './core/sync.js';

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
    // Matching extras
    characterContextScan: false,
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
    validateSettings(extension_settings[MODULE_NAME], settingsConstraints);
    return extension_settings[MODULE_NAME];
}

// ============================================================================
// Vault Index Cache
// ============================================================================

/** @type {import('./core/pipeline.js').VaultEntry[]} */
let vaultIndex = [];
let indexTimestamp = 0;
let indexing = false;
/** Whether vault has ever successfully loaded */
let indexEverLoaded = false;

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

        const tagConfig = {
            lorebookTag: settings.lorebookTag,
            constantTag: settings.constantTag,
            neverInsertTag: settings.neverInsertTag,
        };

        const entries = [];
        for (const file of data.files) {
            const entry = parseVaultFile(file, tagConfig);
            if (entry) {
                entries.push(entry);
            }
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
        resolveLinks(vaultIndex);

        // Vault change detection
        const newSnapshot = takeIndexSnapshot(vaultIndex);
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

        indexEverLoaded = true;
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
                if (entry.warmup !== null) {
                    const count = countKeywordOccurrences(entry, scanText, settings);
                    if (count < entry.warmup) {
                        continue;
                    }
                }
                matchedSet.add(entry);
                matchedKeys.set(entry.title, key);
            }
        }

        // Active Character Boost: auto-match active character's vault entry
        if (settings.characterContextScan && name2) {
            const charEntry = vaultIndex.find(e =>
                e.title.toLowerCase() === name2.toLowerCase() ||
                e.keys.some(k => k.toLowerCase() === name2.toLowerCase())
            );
            if (charEntry && !matchedSet.has(charEntry)) {
                matchedSet.add(charEntry);
                matchedKeys.set(charEntry.title, '(active character)');
            }
        }

        // Cascade links: explicitly pull in linked entries from matched entries
        const titleMap = new Map(vaultIndex.map(e => [e.title.toLowerCase(), e]));
        const cascadeSource = [...matchedSet];
        for (const entry of cascadeSource) {
            if (!entry.cascadeLinks || entry.cascadeLinks.length === 0) continue;
            for (const linkTitle of entry.cascadeLinks) {
                const linked = titleMap.get(linkTitle.toLowerCase());
                if (linked && !matchedSet.has(linked)) {
                    matchedSet.add(linked);
                    matchedKeys.set(linked.title, `(cascade from: ${entry.title})`);
                }
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
                const MAX_RECURSION_TEXT = 50000;
                let recursionText = [...newlyMatched]
                    .filter(e => !e.excludeRecursion)
                    .map(e => e.content)
                    .join('\n');
                if (recursionText.length > MAX_RECURSION_TEXT) {
                    if (settings.debugMode) console.debug('[DeepLore] Recursion text truncated from', recursionText.length, 'to', MAX_RECURSION_TEXT, 'chars');
                    recursionText = recursionText.substring(0, MAX_RECURSION_TEXT);
                }

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
    clearPrompts(extension_prompts, PROMPT_TAG_PREFIX, PROMPT_TAG);

    try {
        // Ensure index is fresh
        await ensureIndexFresh();

        if (vaultIndex.length === 0) {
            if (!indexEverLoaded) {
                toastr.warning('No vault entries loaded. Check Obsidian connection.', 'DeepLore', { timeOut: 8000, preventDuplicates: true });
            }
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
        const { groups, count: injectedCount, totalTokens } = formatAndGroup(gated, getSettings(), PROMPT_TAG_PREFIX);

        const injectedEntries = gated.slice(0, injectedCount);

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
                console.table(injectedEntries.map(e => ({
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
        }

        // Post-injection tracking — always runs regardless of budget/groups
        generationCount++;

        // Decrement all active cooldowns
        for (const [title, remaining] of cooldownTracker.entries()) {
            if (remaining <= 1) {
                cooldownTracker.delete(title);
            } else {
                cooldownTracker.set(title, remaining - 1);
            }
        }

        // Set cooldowns for injected entries; record injection history
        for (const entry of injectedEntries) {
            if (entry.cooldown !== null && entry.cooldown > 0) {
                cooldownTracker.set(entry.title, entry.cooldown);
            }
            injectionHistory.set(entry.title, generationCount);
        }

        // Update analytics
        const analytics = settings.analyticsData || {};
        for (const entry of matched) {
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
    const { groups, count, totalTokens } = formatAndGroup(gated, getSettings(), PROMPT_TAG_PREFIX);

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
    $('#deeplore_enabled').closest('.inline-drawer-content').find('> :not(:first-child)').css('opacity', settings.enabled ? 1 : 0.5);
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
    // Depth/role only apply for in-chat position (value 1)
    const isInChat = settings.injectionPosition === 1;
    $('#deeplore_depth, #deeplore_role').prop('disabled', !isInChat).css('opacity', isInChat ? 1 : 0.4);
    $('#deeplore_allow_wi_scan').prop('checked', settings.allowWIScan);
    $('#deeplore_recursive_scan').prop('checked', settings.recursiveScan);
    $('#deeplore_max_recursion').val(settings.maxRecursionSteps);
    $('#deeplore_max_recursion').prop('disabled', !settings.recursiveScan);
    $('#deeplore_cache_ttl').val(settings.cacheTTL);
    $('#deeplore_review_tokens').val(settings.reviewResponseTokens);
    $('#deeplore_case_sensitive').prop('checked', settings.caseSensitive);
    $('#deeplore_match_whole_words').prop('checked', settings.matchWholeWords);
    $('#deeplore_char_context_scan').prop('checked', settings.characterContextScan);
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
        setupSyncPolling(); // #41: stop/start polling based on enabled state
        $(this).closest('.inline-drawer-content').find('> :not(:first-child)').css('opacity', settings.enabled ? 1 : 0.5);
    });

    $('#deeplore_port').on('input', function () {
        const val = Number($(this).val());
        settings.obsidianPort = isNaN(val) ? 27123 : val;
        saveSettingsDebounced();
        $('#deeplore_connection_status').text('').removeClass('success failure');
    });

    $('#deeplore_api_key').on('input', function () {
        settings.obsidianApiKey = String($(this).val());
        saveSettingsDebounced();
        $('#deeplore_connection_status').text('').removeClass('success failure');
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
        const inChat = settings.injectionPosition === 1;
        $('#deeplore_depth, #deeplore_role').prop('disabled', !inChat).css('opacity', inChat ? 1 : 0.4);
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

    $('#deeplore_char_context_scan').on('change', function () {
        settings.characterContextScan = $(this).is(':checked');
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
        const $btn = $(this);
        const $icon = $btn.find('i');
        $btn.prop('disabled', true);
        $icon.removeClass('fa-rotate').addClass('fa-spinner fa-spin');
        try {
            vaultIndex = [];
            indexTimestamp = 0;
            await buildIndex();
        } finally {
            $btn.prop('disabled', false);
            $icon.removeClass('fa-spinner fa-spin').addClass('fa-rotate');
        }
    });

    // Test Match button
    $('#deeplore_test_match').on('click', async function () {
        const settings = getSettings();

        if (!chat || chat.length === 0) {
            toastr.warning('No active chat. Start a conversation first.', 'DeepLore');
            return;
        }

        if (vaultIndex.length === 0) {
            toastr.warning('No vault index. Click "Refresh Index" first.', 'DeepLore');
            return;
        }

        const { matched, matchedKeys } = matchEntries(chat);

        const gated = applyGating(matched);
        const gatedRemoved = matched.filter(e => !gated.includes(e));

        const { groups, count: injectedCount, totalTokens } = formatAndGroup(gated, settings, PROMPT_TAG_PREFIX);
        const budgetRemoved = gated.slice(injectedCount);
        const injected = gated.slice(0, injectedCount);

        // Position labels
        const positionLabels = { 0: 'After', 1: 'In-chat', 2: 'Before' };
        const roleLabels = { 0: 'System', 1: 'User', 2: 'Asst' };

        let html = `<div style="font-family: monospace; font-size: 0.9em;">`;
        html += `<div style="margin-bottom: 10px;">`;
        html += `<b>${vaultIndex.length}</b> indexed &rarr; `;
        html += `<b>${matched.length}</b> keyword matched &rarr; `;
        html += `<b>${gated.length}</b> after gating &rarr; `;
        html += `<b style="color: var(--SmartThemeQuoteColor, #4caf50);">${injectedCount}</b> would inject (~${totalTokens} tokens)`;
        html += `</div>`;

        if (injected.length > 0) {
            html += `<h3>Would Inject (${injectedCount} entries, ~${totalTokens} tokens)</h3>`;
            html += `<table style="width: 100%; border-collapse: collapse; margin-bottom: 15px;">`;
            html += `<tr style="border-bottom: 1px solid var(--SmartThemeBorderColor, rgba(255,255,255,0.2));">`;
            html += `<th style="text-align: left; padding: 4px;">Title</th>`;
            html += `<th style="text-align: left; padding: 4px;">Matched By</th>`;
            html += `<th style="text-align: right; padding: 4px;">Priority</th>`;
            html += `<th style="text-align: right; padding: 4px;">Tokens</th>`;
            html += `<th style="text-align: left; padding: 4px;">Position</th>`;
            html += `</tr>`;
            for (const entry of injected) {
                const pos = entry.injectionPosition ?? settings.injectionPosition;
                const depth = entry.injectionDepth ?? settings.injectionDepth;
                const role = entry.injectionRole ?? settings.injectionRole;
                const posLabel = pos === 1
                    ? `In-chat @${depth} (${roleLabels[role] || '?'})`
                    : (positionLabels[pos] || '?');
                html += `<tr style="border-bottom: 1px solid var(--SmartThemeBorderColor, rgba(255,255,255,0.1));">`;
                html += `<td style="padding: 4px;">${escapeHtml(entry.title)}</td>`;
                html += `<td style="padding: 4px; opacity: 0.8;">${escapeHtml(matchedKeys.get(entry.title) || '?')}</td>`;
                html += `<td style="text-align: right; padding: 4px;">${entry.priority}</td>`;
                html += `<td style="text-align: right; padding: 4px;">${entry.tokenEstimate}</td>`;
                html += `<td style="padding: 4px; opacity: 0.8;">${posLabel}</td>`;
                html += `</tr>`;
            }
            html += `</table>`;
        } else {
            html += `<p style="color: var(--warning, #ff9800);">No entries would be injected.</p>`;
        }

        if (gatedRemoved.length > 0) {
            html += `<h3 style="color: var(--warning, #ff9800);">Removed by Gating (${gatedRemoved.length})</h3>`;
            html += `<ul style="margin: 0 0 15px 20px;">`;
            for (const entry of gatedRemoved) {
                const reasons = [];
                if (entry.requires.length > 0) reasons.push(`requires: ${entry.requires.join(', ')}`);
                if (entry.excludes.length > 0) reasons.push(`excludes: ${entry.excludes.join(', ')}`);
                html += `<li>${escapeHtml(entry.title)} — ${escapeHtml(reasons.join('; ') || 'dependency chain')}</li>`;
            }
            html += `</ul>`;
        }

        if (budgetRemoved.length > 0) {
            html += `<h3 style="color: var(--warning, #ff9800);">Cut by Budget/Max (${budgetRemoved.length})</h3>`;
            html += `<ul style="margin: 0 0 15px 20px;">`;
            for (const entry of budgetRemoved) {
                html += `<li>${escapeHtml(entry.title)} (pri ${entry.priority}, ~${entry.tokenEstimate} tokens)</li>`;
            }
            html += `</ul>`;
        }

        html += `</div>`;
        callGenericPopup(html, POPUP_TYPE.TEXT, '', { wide: true, large: true, allowVerticalScrolling: true });
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

            const settings = getSettings();
            const totalTokens = vaultIndex.reduce((sum, e) => sum + e.tokenEstimate, 0);

            const confirmed = await callGenericPopup(
                `<p>This will send <b>${vaultIndex.length}</b> entries (~${totalTokens} tokens) as a message and generate an AI response.</p><p>This may be expensive. Continue?</p>`,
                POPUP_TYPE.CONFIRM, '', {},
            );
            if (!confirmed) return '';

            const loreDump = vaultIndex.map(entry => {
                return `## ${entry.title}\n${entry.content}`;
            }).join('\n\n---\n\n');

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

            await callGenericPopup(html, POPUP_TYPE.TEXT, '', { wide: true, large: true, allowVerticalScrolling: true });
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

                // Build keyword map for duplicate detection; also flag short keywords
                for (const key of entry.keys) {
                    if (key.length <= 2) {
                        issues.push({ type: 'Short Keywords', entry: entry.title, detail: `Keyword "${key}" is ${key.length} char(s) — may match too aggressively` });
                    }
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

            await callGenericPopup(html, POPUP_TYPE.TEXT, '', { wide: true, large: true, allowVerticalScrolling: true });
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
