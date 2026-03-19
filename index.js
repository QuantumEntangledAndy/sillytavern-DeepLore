/**
 * DeepLore — Entry Point
 * Wires up the generation interceptor, event listeners, and UI initialization.
 */
import {
    setExtensionPrompt,
    extension_prompts,
    saveSettingsDebounced,
    saveChatDebounced,
    chat,
    chat_metadata,
} from '../../../../script.js';
import { renderExtensionTemplateAsync } from '../../../extensions.js';
import { eventSource, event_types } from '../../../events.js';
import { applyGating, formatAndGroup } from './core/matching.js';
import { clearPrompts } from './core/pipeline.js';
import { getSettings, PROMPT_TAG_PREFIX, PROMPT_TAG } from './settings.js';
import {
    vaultIndex, indexEverLoaded,
    cooldownTracker, generationCount, injectionHistory,
    lastWarningRatio, lastInjectionSources,
    setGenerationCount, setLastWarningRatio, setLastInjectionSources,
} from './src/state.js';
import { buildIndex, ensureIndexFresh } from './src/vault.js';
import { matchEntries, matchTextForExternal } from './src/pipeline.js';
import { setupSyncPolling } from './src/sync.js';
import { loadSettingsUI, bindSettingsEvents } from './src/settings-ui.js';
import { registerSlashCommands } from './src/commands.js';
import { injectSourcesButton, showSourcesPopup } from './src/cartographer.js';

// ============================================================================
// Generation Interceptor
// ============================================================================

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

    // Clear stale source data (after quiet check so quiet generations don't wipe real sources)
    setLastInjectionSources(null);

    // Clear all previous DeepLore prompts
    clearPrompts(extension_prompts, PROMPT_TAG_PREFIX, PROMPT_TAG);

    // Track whether the pipeline ran far enough to need generation tracking
    let pipelineRan = false;
    let injectedEntries = [];

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

        // From here on, generation tracking must run even if no entries match
        pipelineRan = true;

        // Match entries (now takes chat array for per-entry scan depth)
        const { matched, matchedKeys } = matchEntries(chat);

        // Re-injection cooldown: filter out recently injected non-constant entries
        let filteredEntries = matched;
        if (settings.reinjectionCooldown > 0) {
            filteredEntries = matched.filter(entry => {
                if (entry.constant) return true;
                const lastInjected = injectionHistory.get(entry.title);
                if (lastInjected !== undefined && (generationCount - lastInjected) < settings.reinjectionCooldown) {
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
        let gated = applyGating(filteredEntries);

        if (settings.debugMode && gated.length < filteredEntries.length) {
            const removed = filteredEntries.filter(e => !gated.includes(e));
            console.log(`[DeepLore] Gating removed ${removed.length} entries:`,
                removed.map(e => ({ title: e.title, requires: e.requires, excludes: e.excludes })));
        }

        if (gated.length === 0) {
            if (settings.debugMode) {
                console.debug('[DeepLore] All entries removed by gating rules');
            }
            return;
        }

        // Strip duplicate injections from recent generations
        if (settings.stripDuplicateInjections && chat_metadata.deeplore_injection_log?.length > 0) {
            const recentEntries = new Set();
            const lookback = settings.stripLookbackDepth;
            const log = chat_metadata.deeplore_injection_log;
            const recentLogs = log.slice(-lookback);
            for (const logEntry of recentLogs.flatMap(l => l.entries)) {
                recentEntries.add(`${logEntry.title}|${logEntry.pos}|${logEntry.depth}|${logEntry.role}`);
            }

            const before = gated.length;
            gated = gated.filter(e => {
                if (e.constant) return true; // Constants always inject
                const key = `${e.title}|${e.injectionPosition ?? settings.injectionPosition}|${e.injectionDepth ?? settings.injectionDepth}|${e.injectionRole ?? settings.injectionRole}`;
                if (recentEntries.has(key)) {
                    if (settings.debugMode) {
                        console.debug(`[DeepLore] Strip: "${e.title}" already injected in recent ${lookback} gen(s) — skipping`);
                    }
                    return false;
                }
                return true;
            });
            if (settings.debugMode && gated.length < before) {
                console.log(`[DeepLore] Strip dedup removed ${before - gated.length} entries`);
            }
        }

        // Format with budget, grouped by injection position
        const { groups, count: injectedCount, totalTokens } = formatAndGroup(gated, getSettings(), PROMPT_TAG_PREFIX);

        injectedEntries = gated.slice(0, injectedCount);

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

            // Capture injection sources for Context Cartographer
            setLastInjectionSources(injectedEntries.map(e => ({
                title: e.title,
                filename: e.filename,
                matchedBy: matchedKeys.get(e.title) || '?',
                priority: e.priority,
                tokens: e.tokenEstimate,
            })));

            // Context usage warning — reset ratio when it drops below threshold
            if (contextSize > 0) {
                const ratio = totalTokens / contextSize;
                if (ratio > 0.20 && ratio > lastWarningRatio + 0.05) {
                    const pct = Math.round(ratio * 100);
                    toastr.warning(
                        `${injectedCount} entries injected (~${totalTokens} tokens, ${pct}% of context). Consider setting a token budget.`,
                        'DeepLore',
                        { preventDuplicates: true, timeOut: 8000 },
                    );
                    setLastWarningRatio(ratio);
                } else if (ratio <= 0.15) {
                    // Reset when ratio drops well below threshold to allow re-warning if it climbs again
                    setLastWarningRatio(0);
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

        // Set cooldowns for injected entries; record injection history
        // Uses generationCount + 1 because the increment happens in finally
        for (const entry of injectedEntries) {
            if (entry.cooldown !== null && entry.cooldown > 0) {
                cooldownTracker.set(entry.title, entry.cooldown);
            }
            injectionHistory.set(entry.title, generationCount + 1);
        }

        // Record injection for deduplication
        if (settings.stripDuplicateInjections) {
            if (!chat_metadata.deeplore_injection_log) {
                chat_metadata.deeplore_injection_log = [];
            }
            chat_metadata.deeplore_injection_log.push({
                gen: generationCount + 1,
                entries: injectedEntries.map(e => ({
                    title: e.title,
                    pos: e.injectionPosition ?? settings.injectionPosition,
                    depth: e.injectionDepth ?? settings.injectionDepth,
                    role: e.injectionRole ?? settings.injectionRole,
                })),
            });
            const maxHistory = settings.stripLookbackDepth + 1;
            if (chat_metadata.deeplore_injection_log.length > maxHistory) {
                chat_metadata.deeplore_injection_log = chat_metadata.deeplore_injection_log.slice(-maxHistory);
            }
            saveChatDebounced();
        }

        // Update analytics
        const analytics = settings.analyticsData || {};
        for (const entry of matched) {
            if (!analytics[entry.title]) {
                analytics[entry.title] = { matched: 0, injected: 0, lastTriggered: 0 };
            }
            analytics[entry.title].matched++;
            analytics[entry.title].lastTriggered = Date.now();
        }
        for (const entry of injectedEntries) {
            if (!analytics[entry.title]) {
                analytics[entry.title] = { matched: 0, injected: 0, lastTriggered: 0 };
            }
            analytics[entry.title].injected++;
        }
        settings.analyticsData = analytics;
        saveSettingsDebounced();
    } catch (err) {
        console.error('[DeepLore] Error during generation:', err);
    } finally {
        // Generation tracking must always run when the pipeline was entered,
        // even if no entries matched — otherwise cooldown timers freeze permanently
        if (pipelineRan) {
            setGenerationCount(generationCount + 1);

            // Decrement cooldown counters; remove expired ones
            for (const [title, remaining] of cooldownTracker) {
                if (remaining <= 1) {
                    cooldownTracker.delete(title);
                } else {
                    cooldownTracker.set(title, remaining - 1);
                }
            }
        }
    }
}

// Register the interceptor on globalThis so SillyTavern can find it
globalThis.deepLore_onGenerate = onGenerate;

// External API: match vault entries against arbitrary text
globalThis.deepLore_matchText = matchTextForExternal;

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
        bindSettingsEvents(buildIndex);
        registerSlashCommands();
        setupSyncPolling(buildIndex);

        // Context Cartographer: click handler (event delegation — registered once)
        $(document).on('click', '.mes_deeplore_sources', function () {
            const messageId = $(this).closest('.mes').attr('mesid');
            const message = chat[messageId];
            const sources = message?.extra?.deeplore_sources;
            if (!sources || sources.length === 0) return;
            showSourcesPopup(sources);
        });

        // Context Cartographer: store sources and inject button on character message render
        eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, (messageId) => {
            const settings = getSettings();

            // Store sources on the message object
            if (settings.showLoreSources && lastInjectionSources && lastInjectionSources.length > 0) {
                const message = chat[messageId];
                if (message && !message.is_user) {
                    message.extra = message.extra || {};
                    message.extra.deeplore_sources = lastInjectionSources;
                    setLastInjectionSources(null);
                    saveChatDebounced();
                }
            }

            // Inject button for messages that have sources
            if (settings.showLoreSources) {
                injectSourcesButton(messageId);
            }
        });

        // Reset per-chat state on chat change + re-inject Cartographer buttons
        eventSource.on(event_types.CHAT_CHANGED, () => {
            injectionHistory.clear();
            cooldownTracker.clear();
            setGenerationCount(0);
            setLastWarningRatio(0);
            // Re-inject Cartographer buttons for messages that have stored sources
            setTimeout(() => {
                const settings = getSettings();
                if (!settings.showLoreSources) return;
                for (let i = 0; i < chat.length; i++) {
                    if (chat[i]?.extra?.deeplore_sources) {
                        injectSourcesButton(i);
                    }
                }
            }, 100);
        });

        console.log('[DeepLore] Client extension initialized');
    } catch (err) {
        console.error('[DeepLore] Failed to initialize:', err);
    }
});
