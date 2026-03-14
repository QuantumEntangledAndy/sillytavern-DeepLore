/**
 * DeepLore Shared Core — Pipeline Helpers
 * This file is shared between DeepLore and DeepLore Enhanced via git subtree.
 * The canonical source lives in the Enhanced repo. Do not edit in base DeepLore.
 */

import { parseFrontmatter, extractWikiLinks, cleanContent, extractTitle } from './utils.js';

/**
 * @typedef {object} VaultEntry
 * @property {string} filename - Full path in vault
 * @property {string} title - Display title (from H1 or filename)
 * @property {string[]} keys - Trigger keywords from frontmatter
 * @property {string} content - Cleaned markdown content (frontmatter stripped)
 * @property {string} summary - AI selection summary from frontmatter
 * @property {number} priority - Sort priority (lower = higher priority)
 * @property {boolean} constant - Always inject regardless of keywords
 * @property {boolean} seed - Content sent to AI as story context on new chats
 * @property {boolean} bootstrap - Force-inject when chat is short
 * @property {number} tokenEstimate - Rough token count estimate
 * @property {number|null} scanDepth - Per-entry scan depth override (null = use global)
 * @property {boolean} excludeRecursion - Don't scan this entry's content during recursion
 * @property {string[]} links - Wiki-link targets extracted before cleaning
 * @property {string[]} resolvedLinks - Links confirmed to match existing entry titles
 * @property {string[]} tags - All Obsidian tags (excluding the lorebook marker tag)
 * @property {string[]} requires - Entry titles that must all be matched for this entry to activate
 * @property {string[]} excludes - Entry titles that, if any matched, prevent this entry from activating
 * @property {number|null} injectionPosition - Per-entry injection position override (null = use global)
 * @property {number|null} injectionDepth - Per-entry injection depth override (null = use global)
 * @property {number|null} injectionRole - Per-entry injection role override (null = use global)
 * @property {number|null} cooldown - Generations to skip after triggering (null = no cooldown)
 * @property {number|null} warmup - Keyword hit count required before triggering (null = no warmup)
 */

/**
 * @typedef {object} TagConfig
 * @property {string} lorebookTag - Tag that marks an entry as a lorebook entry
 * @property {string} constantTag - Tag for always-inject entries
 * @property {string} neverInsertTag - Tag for entries to skip
 * @property {string} [seedTag] - Tag for seed entries (Enhanced only)
 * @property {string} [bootstrapTag] - Tag for bootstrap entries (Enhanced only)
 */

/**
 * Parse a single vault file into a VaultEntry, or return null if it should be skipped.
 * @param {{ filename: string, content: string }} file - Raw file from server
 * @param {TagConfig} tagConfig - Tag configuration from settings
 * @returns {VaultEntry|null}
 */
export function parseVaultFile(file, tagConfig) {
    const { frontmatter, body } = parseFrontmatter(file.content);

    // Check if this file has the lorebook tag
    const tags = Array.isArray(frontmatter.tags)
        ? frontmatter.tags.map(t => String(t).toLowerCase())
        : [];

    const tagToMatch = tagConfig.lorebookTag.toLowerCase();
    if (!tags.includes(tagToMatch)) {
        return null;
    }

    // Skip entries explicitly disabled via frontmatter
    if (frontmatter.enabled === false) {
        return null;
    }

    // Skip entries with the never-insert tag
    const neverInsertTagToMatch = tagConfig.neverInsertTag ? tagConfig.neverInsertTag.toLowerCase() : '';
    if (neverInsertTagToMatch && tags.includes(neverInsertTagToMatch)) {
        return null;
    }

    // Extract keys
    const keys = Array.isArray(frontmatter.keys)
        ? frontmatter.keys.map(k => String(k))
        : [];

    const title = extractTitle(body, file.filename);
    const links = extractWikiLinks(body);
    const content = cleanContent(body);
    const priority = typeof frontmatter.priority === 'number' ? frontmatter.priority : 100;

    const constantTagToMatch = tagConfig.constantTag ? tagConfig.constantTag.toLowerCase() : '';
    const constant = frontmatter.constant === true || (constantTagToMatch && tags.includes(constantTagToMatch));

    const seedTagToMatch = tagConfig.seedTag ? tagConfig.seedTag.toLowerCase() : '';
    const seed = !!(seedTagToMatch && tags.includes(seedTagToMatch));

    const bootstrapTagToMatch = tagConfig.bootstrapTag ? tagConfig.bootstrapTag.toLowerCase() : '';
    const bootstrap = !!(bootstrapTagToMatch && tags.includes(bootstrapTagToMatch));

    const scanDepth = typeof frontmatter.scanDepth === 'number' ? frontmatter.scanDepth : null;
    const excludeRecursion = frontmatter.excludeRecursion === true;

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

    // Per-entry cooldown and warmup
    const cooldown = typeof frontmatter.cooldown === 'number' && frontmatter.cooldown > 0 ? frontmatter.cooldown : null;
    const warmup = typeof frontmatter.warmup === 'number' && frontmatter.warmup > 1 ? frontmatter.warmup : null;

    // AI selection summary (dedicated frontmatter field, separate from injected content)
    const summary = typeof frontmatter.summary === 'string' ? frontmatter.summary.trim() : '';

    // Preserve all tags except the lorebook marker tag itself
    const entryTags = tags.filter(t => t !== tagToMatch);

    return {
        filename: file.filename,
        title,
        keys,
        content,
        summary,
        priority,
        constant,
        seed,
        bootstrap,
        tokenEstimate: 0,
        scanDepth,
        excludeRecursion,
        links,
        resolvedLinks: [],
        tags: entryTags,
        requires,
        excludes,
        injectionPosition,
        injectionDepth,
        injectionRole,
        cooldown,
        warmup,
    };
}

/**
 * Clear all DeepLore-managed extension prompts from the prompt dictionary.
 * @param {object} extensionPrompts - The extension_prompts dictionary
 * @param {string} promptTagPrefix - Prefix for prompt tags (e.g. 'deeplore_')
 * @param {string} promptTag - The main prompt tag (e.g. 'deeplore_enhanced')
 */
export function clearPrompts(extensionPrompts, promptTagPrefix, promptTag) {
    for (const key of Object.keys(extensionPrompts)) {
        if (key.startsWith(promptTagPrefix) || key === promptTag) {
            delete extensionPrompts[key];
        }
    }
}
