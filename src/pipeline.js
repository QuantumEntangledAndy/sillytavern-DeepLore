/**
 * DeepLore — Pipeline runner
 * matchEntries, matchTextForExternal
 */
import { getSettings, PROMPT_TAG_PREFIX } from '../settings.js';
import { buildScanText } from '../core/utils.js';
import { testEntryMatch, countKeywordOccurrences, applyGating, formatAndGroup } from '../core/matching.js';
import { vaultIndex, cooldownTracker } from './state.js';
import { ensureIndexFresh } from './vault.js';
import { name2 } from '../../../../script.js';

/**
 * Match vault entries against chat messages, with recursive scanning support.
 * @param {object[]} chat - Chat messages array
 * @returns {{ matched: VaultEntry[], matchedKeys: Map<string, string> }} Matched entries sorted by priority, and which key matched each
 */
export function matchEntries(chat) {
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

    // Collect bootstrap entries when chat is short (cold-start injection)
    if (chat.length <= settings.newChatThreshold) {
        for (const entry of vaultIndex) {
            if (entry.bootstrap && !matchedSet.has(entry)) {
                matchedSet.add(entry);
                matchedKeys.set(entry.title, '(bootstrap)');
            }
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

/**
 * External API: match vault entries against arbitrary text.
 * Used by other extensions to get lore without going through the interceptor.
 * @param {string|object[]} scanInput - Text string or array of {name, mes, is_user} chat objects
 * @returns {Promise<{text: string, count: number, tokens: number}>}
 */
export async function matchTextForExternal(scanInput) {
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
