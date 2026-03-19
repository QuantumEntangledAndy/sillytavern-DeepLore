/**
 * DeepLore — Health check diagnostics
 */
import { getSettings } from '../settings.js';
import { vaultIndex } from './state.js';

/**
 * Run health checks on the vault index.
 * @returns {{ issues: Array<{type: string, entry: string, detail: string}> }}
 */
export function runHealthCheck() {
    const issues = [];
    const allTitlesLower = new Set(vaultIndex.map(e => e.title.toLowerCase()));
    const keywordMap = new Map(); // keyword -> [titles]

    for (const entry of vaultIndex) {
        // Empty keys on non-constant, non-bootstrap entries
        if (!entry.constant && !entry.bootstrap && entry.keys.length === 0) {
            issues.push({ type: 'Empty Keys', entry: entry.title, detail: 'No trigger keywords defined' });
        }

        // Orphaned requires (case-insensitive to match applyGating behavior)
        for (const req of entry.requires) {
            if (!allTitlesLower.has(req.toLowerCase())) {
                issues.push({ type: 'Orphaned Requires', entry: entry.title, detail: `References "${req}" which doesn't exist` });
            }
        }

        // Orphaned excludes (case-insensitive to match applyGating behavior)
        for (const exc of entry.excludes) {
            if (!allTitlesLower.has(exc.toLowerCase())) {
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

    return { issues };
}
