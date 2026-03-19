/**
 * DeepLore — Health check diagnostics
 */
import { getSettings } from '../settings.js';
import { vaultIndex, indexTimestamp } from './state.js';

/**
 * Run comprehensive health checks on the vault index and settings.
 * @returns {{ issues: Array<{type: string, severity: 'error'|'warning'|'info', entry: string, detail: string}>, errors: number, warnings: number }}
 */
export function runHealthCheck() {
    const settings = getSettings();
    const issues = [];

    // --- Settings checks (no vault needed) ---

    if (!settings.obsidianApiKey) {
        issues.push({ type: 'Settings', severity: 'warning', entry: '—', detail: 'No Obsidian API key configured' });
    }

    if (settings.scanDepth === 0) {
        issues.push({ type: 'Settings', severity: 'error', entry: '—', detail: 'Scan depth is 0 — nothing will ever match via keywords' });
    }

    if (!settings.unlimitedBudget && settings.maxTokensBudget < 200) {
        issues.push({ type: 'Settings', severity: 'warning', entry: '—', detail: `Token budget very low (${settings.maxTokensBudget})` });
    }

    if (settings.recursiveScan && settings.maxRecursionSteps === 1) {
        issues.push({ type: 'Settings', severity: 'info', entry: '—', detail: 'Recursive scan enabled but max steps is 1 — only one extra pass' });
    }

    if (settings.cacheTTL === 0) {
        issues.push({ type: 'Settings', severity: 'info', entry: '—', detail: 'Cache disabled — vault will be fetched every generation' });
    }

    if (indexTimestamp > 0 && settings.cacheTTL > 0 && Date.now() - indexTimestamp > settings.cacheTTL * 1000 * 3) {
        issues.push({ type: 'Settings', severity: 'warning', entry: '—', detail: 'Index is very stale (more than 3x cache TTL old)' });
    }

    // --- Vault entry checks (require vaultIndex) ---
    if (vaultIndex.length === 0) {
        const errors = issues.filter(i => i.severity === 'error').length;
        const warnings = issues.filter(i => i.severity === 'warning').length;
        return { issues, errors, warnings };
    }

    const allTitlesLower = new Set(vaultIndex.map(e => e.title.toLowerCase()));
    const titleCounts = new Map();
    const keywordMap = new Map();
    let constantTokenTotal = 0;

    for (const entry of vaultIndex) {
        // Duplicate titles
        titleCounts.set(entry.title, (titleCounts.get(entry.title) || 0) + 1);

        // Empty keys on non-constant, non-bootstrap entries
        if (!entry.constant && !entry.bootstrap && entry.keys.length === 0) {
            issues.push({ type: 'Entry Config', severity: 'warning', entry: entry.title, detail: 'No trigger keywords defined' });
        }

        // Empty content
        if (!entry.content || !entry.content.trim()) {
            issues.push({ type: 'Entry Config', severity: 'warning', entry: entry.title, detail: 'Entry has no content' });
        }

        // Orphaned requires (case-insensitive to match applyGating behavior)
        for (const req of entry.requires) {
            if (!allTitlesLower.has(req.toLowerCase())) {
                issues.push({ type: 'Gating', severity: 'error', entry: entry.title, detail: `Requires "${req}" which doesn't exist in the vault` });
            }
        }

        // Orphaned excludes (case-insensitive to match applyGating behavior)
        for (const exc of entry.excludes) {
            if (!allTitlesLower.has(exc.toLowerCase())) {
                issues.push({ type: 'Gating', severity: 'error', entry: entry.title, detail: `Excludes "${exc}" which doesn't exist in the vault` });
            }
        }

        // Orphaned cascade_links
        if (entry.cascadeLinks) {
            for (const cl of entry.cascadeLinks) {
                if (!allTitlesLower.has(cl.toLowerCase())) {
                    issues.push({ type: 'Gating', severity: 'warning', entry: entry.title, detail: `Cascade link "${cl}" doesn't exist in the vault` });
                }
            }
        }

        // Requires AND excludes same title
        if (entry.requires.length > 0 && entry.excludes.length > 0) {
            for (const req of entry.requires) {
                if (entry.excludes.some(exc => exc.toLowerCase() === req.toLowerCase())) {
                    issues.push({ type: 'Gating', severity: 'error', entry: entry.title, detail: `Requires and excludes "${req}" simultaneously` });
                }
            }
        }

        // Oversized entries
        if (entry.tokenEstimate > 1500) {
            issues.push({ type: 'Size', severity: 'warning', entry: entry.title, detail: `~${entry.tokenEstimate} tokens (>1500)` });
        }

        // Short keywords
        for (const key of entry.keys) {
            if (key.length <= 2) {
                issues.push({ type: 'Keywords', severity: 'info', entry: entry.title, detail: `Keyword "${key}" is ${key.length} char(s) — may match too aggressively` });
            }
            const lower = key.toLowerCase();
            if (!keywordMap.has(lower)) keywordMap.set(lower, []);
            keywordMap.get(lower).push(entry.title);
        }

        // Cooldown on constant entries
        if (entry.constant && entry.cooldown !== null) {
            issues.push({ type: 'Entry Config', severity: 'info', entry: entry.title, detail: 'Cooldown on constant entry has no effect' });
        }

        // Warmup unlikely to trigger
        if (entry.warmup !== null && entry.warmup > 1 && entry.keys.length > 0 && entry.keys.every(k => k.length <= 3)) {
            issues.push({ type: 'Entry Config', severity: 'warning', entry: entry.title, detail: `Warmup ${entry.warmup} unlikely to trigger — all keywords are 3 chars or fewer` });
        }

        // Bootstrap with no keys and not constant
        if (entry.bootstrap && !entry.constant && entry.keys.length === 0) {
            issues.push({ type: 'Entry Config', severity: 'warning', entry: entry.title, detail: 'Bootstrap entry has no keywords — only active during cold start' });
        }

        // Seed entries with large content
        if (entry.seed && entry.tokenEstimate > 2000) {
            issues.push({ type: 'Size', severity: 'warning', entry: entry.title, detail: `Seed entry is large — ~${entry.tokenEstimate} tokens sent as AI context on new chats` });
        }

        // Depth override without in_chat position
        const effectivePosition = entry.injectionPosition ?? settings.injectionPosition;
        if (entry.injectionDepth !== null && effectivePosition !== 1) {
            issues.push({ type: 'Injection', severity: 'warning', entry: entry.title, detail: 'Depth override ignored — effective position is not in_chat' });
        }

        // Role override without in_chat position
        if (entry.injectionRole !== null && effectivePosition !== 1) {
            issues.push({ type: 'Injection', severity: 'warning', entry: entry.title, detail: 'Role override ignored — effective position is not in_chat' });
        }

        // Unresolved wiki-links
        if (entry.links.length > 0 && entry.resolvedLinks.length < entry.links.length) {
            const resolvedLower = new Set(entry.resolvedLinks.map(r => r.toLowerCase()));
            const unresolved = entry.links.filter(l => !resolvedLower.has(l.toLowerCase()));
            if (unresolved.length > 0) {
                issues.push({ type: 'Links', severity: 'info', entry: entry.title, detail: `Unresolved wiki-links: ${unresolved.join(', ')}` });
            }
        }

        // Excluded from recursion with no direct keywords
        if (entry.excludeRecursion && entry.keys.length === 0 && !entry.constant) {
            issues.push({ type: 'Entry Config', severity: 'warning', entry: entry.title, detail: "Entry won't match via recursion and has no keywords" });
        }

        // Probability zero
        if (entry.probability === 0) {
            issues.push({ type: 'Entry Config', severity: 'warning', entry: entry.title, detail: 'Entry will never trigger (probability is 0)' });
        }

        // Track constant token total
        if (entry.constant) {
            constantTokenTotal += entry.tokenEstimate;
        }
    }

    // Duplicate titles
    for (const [title, count] of titleCounts) {
        if (count > 1) {
            issues.push({ type: 'Entry Config', severity: 'error', entry: title, detail: `Duplicate title — ${count} entries share this name` });
        }
    }

    // Duplicate keywords across entries
    for (const [keyword, titles] of keywordMap) {
        if (titles.length > 1) {
            issues.push({ type: 'Keywords', severity: 'info', entry: titles.join(', '), detail: `Keyword "${keyword}" shared by ${titles.length} entries` });
        }
    }

    // Circular requires: A requires B, B requires A
    for (const entry of vaultIndex) {
        for (const req of entry.requires) {
            const target = vaultIndex.find(e => e.title.toLowerCase() === req.toLowerCase());
            if (target && target.requires.some(r => r.toLowerCase() === entry.title.toLowerCase())) {
                // Only report once (alphabetically first)
                if (entry.title < target.title) {
                    issues.push({ type: 'Gating', severity: 'error', entry: `${entry.title} / ${target.title}`, detail: 'Circular requires — these entries require each other and will both be gated out' });
                }
            }
        }
    }

    // Constants total tokens exceed budget
    if (!settings.unlimitedBudget && constantTokenTotal > settings.maxTokensBudget) {
        issues.push({ type: 'Size', severity: 'warning', entry: '—', detail: `Constants alone total ~${constantTokenTotal} tokens, exceeding budget of ${settings.maxTokensBudget}` });
    }

    const errors = issues.filter(i => i.severity === 'error').length;
    const warnings = issues.filter(i => i.severity === 'warning').length;
    return { issues, errors, warnings };
}
