/**
 * DeepLore Shared Core — Matching, Gating & Formatting
 * This file is shared between DeepLore and DeepLore Enhanced via git subtree.
 * The canonical source lives in the Enhanced repo. Do not edit in base DeepLore.
 */

import { escapeRegex } from './utils.js';

/**
 * Test if an entry's keys match against the given text.
 * @param {import('./pipeline.js').VaultEntry} entry
 * @param {string} scanText
 * @param {{ caseSensitive: boolean, matchWholeWords: boolean }} settings
 * @returns {string|null} The matched key, or null if no match
 */
export function testEntryMatch(entry, scanText, settings) {
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
 * Count how many times an entry's keywords appear in the scan text.
 * Respects case sensitivity and whole-word matching settings.
 * @param {import('./pipeline.js').VaultEntry} entry
 * @param {string} scanText
 * @param {{ caseSensitive: boolean, matchWholeWords: boolean }} settings
 * @returns {number} Total keyword occurrence count
 */
export function countKeywordOccurrences(entry, scanText, settings) {
    let count = 0;
    const text = settings.caseSensitive ? scanText : scanText.toLowerCase();
    for (const rawKey of entry.keys) {
        const key = settings.caseSensitive ? rawKey : rawKey.toLowerCase();
        if (settings.matchWholeWords) {
            const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const regex = new RegExp(`\\b${escaped}\\b`, settings.caseSensitive ? 'g' : 'gi');
            const matches = scanText.match(regex);
            if (matches) count += matches.length;
        } else {
            let idx = 0;
            while ((idx = text.indexOf(key, idx)) !== -1) {
                count++;
                idx += key.length;
            }
        }
    }
    return count;
}

/**
 * Apply conditional gating rules (requires/excludes) to matched entries.
 * Iterates until stable since removing a gated entry may affect another's requires.
 * @param {import('./pipeline.js').VaultEntry[]} entries - Matched entries (already merged)
 * @returns {import('./pipeline.js').VaultEntry[]}
 */
export function applyGating(entries) {
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
            if (entry.requires && entry.requires.length > 0) {
                const allPresent = entry.requires.every(r => activeTitles.has(r.toLowerCase()));
                if (!allPresent) {
                    changed = true;
                    return false;
                }
            }
            // Check excludes: NONE should be in the active set
            if (entry.excludes && entry.excludes.length > 0) {
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
 * Resolve raw wiki-link targets to confirmed entry titles in the vault index.
 * Must be called after vaultIndex is fully populated.
 * @param {import('./pipeline.js').VaultEntry[]} vaultIndex
 */
export function resolveLinks(vaultIndex) {
    const titleMap = new Map(vaultIndex.map(e => [e.title.toLowerCase(), e.title]));
    for (const entry of vaultIndex) {
        entry.resolvedLinks = entry.links
            .map(l => titleMap.get(l.toLowerCase()))
            .filter(Boolean);
    }
}

/**
 * Format matched entries for injection, respecting budget limits, grouped by injection position.
 * Entries can override the global injection position/depth/role via frontmatter.
 * @param {import('./pipeline.js').VaultEntry[]} entries - Matched entries sorted by priority
 * @param {{ injectionTemplate: string, injectionPosition: number, injectionDepth: number, injectionRole: number, maxEntries: number, unlimitedEntries: boolean, maxTokensBudget: number, unlimitedBudget: boolean }} settings
 * @param {string} promptTagPrefix - Prefix for prompt tags (e.g. 'deeplore_')
 * @returns {{ groups: Array<{ tag: string, text: string, position: number, depth: number, role: number }>, count: number, totalTokens: number }}
 */
export function formatAndGroup(entries, settings, promptTagPrefix) {
    const template = settings.injectionTemplate || '<{{title}}>\n{{content}}\n</{{title}}>';
    let totalTokens = 0;
    let count = 0;

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
    const groupMap = new Map();
    for (const item of accepted) {
        const key = `${promptTagPrefix}p${item.position}_d${item.depth}_r${item.role}`;
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
