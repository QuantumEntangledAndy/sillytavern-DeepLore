/**
 * DeepLore Shared Core — Utility Functions
 * This file is shared between DeepLore and DeepLore Enhanced via git subtree.
 * The canonical source lives in the Enhanced repo. Do not edit in base DeepLore.
 */

/**
 * Parse simple YAML frontmatter from markdown content.
 * Handles basic key-value pairs and arrays (indented with - ).
 * @param {string} content - Raw markdown content
 * @returns {{ frontmatter: object, body: string }}
 */
export function parseFrontmatter(content) {
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
                    // Quote-aware split: respects commas inside quoted values
                    const items = [];
                    let current = '';
                    let inQuote = false;
                    let quoteChar = '';
                    for (const ch of inner) {
                        if (!inQuote && (ch === '"' || ch === "'")) { inQuote = true; quoteChar = ch; }
                        else if (inQuote && ch === quoteChar) { inQuote = false; }
                        else if (!inQuote && ch === ',') {
                            items.push(current.trim().replace(/^['"]|['"]$/g, ''));
                            current = '';
                            continue;
                        }
                        current += ch;
                    }
                    if (current.trim()) items.push(current.trim().replace(/^['"]|['"]$/g, ''));
                    frontmatter[currentKey] = items;
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
export function extractWikiLinks(body) {
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
export function cleanContent(content) {
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
export function extractTitle(body, filename) {
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
 * Truncate text at the nearest sentence boundary before maxLen.
 * @param {string} text
 * @param {number} maxLen
 * @returns {string}
 */
export function truncateToSentence(text, maxLen) {
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
 * Compute a simple hash for cache comparison.
 * @param {string} text
 * @returns {string}
 */
export function simpleHash(text) {
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
        const char = text.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash |= 0; // Convert to 32-bit integer
    }
    return `${text.length}:${hash}`;
}

/**
 * Escape a string for use in a regex.
 * @param {string} str
 * @returns {string}
 */
export function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build scan text from chat messages.
 * @param {object[]} chat - Chat messages array
 * @param {number} depth - Number of recent messages to scan
 * @returns {string}
 */
export function buildScanText(chat, depth) {
    if (depth <= 0) return '';
    const recentMessages = chat.slice(-Math.min(depth, chat.length));
    return recentMessages
        .map(m => `${m.name || ''}: ${typeof m.mes === 'string' ? m.mes : ''}`)
        .join('\n');
}

/**
 * Build annotated chat context for AI search.
 * Marks speakers as (user) or (character) to clarify conversation roles.
 * @param {object[]} chat - Chat messages array
 * @param {number} depth - Number of recent messages to scan
 * @returns {string}
 */
export function buildAiChatContext(chat, depth) {
    if (depth <= 0) return '';
    const recentMessages = chat.slice(-Math.min(depth, chat.length));
    return recentMessages
        .map(m => {
            const speaker = m.name || 'Unknown';
            const role = m.is_user ? '(user)' : '(character)';
            return `${speaker} ${role}: ${typeof m.mes === 'string' ? m.mes : ''}`;
        })
        .join('\n');
}

/**
 * Clamp a numeric setting to [min, max] and log if clamped.
 * @param {object} obj - Settings object
 * @param {string} key - Setting key
 * @param {number} min
 * @param {number} max
 * @param {string} label - Human-readable label for logging
 */
function clampWithLog(obj, key, min, max, label) {
    const before = obj[key];
    obj[key] = Math.max(min, Math.min(max, Math.round(obj[key])));
    if (before !== obj[key]) {
        console.info(`[DeepLore] ${label} clamped from ${before} to ${obj[key]} (range: ${min}-${max})`);
    }
}

/**
 * Validate and clamp settings to their allowed ranges.
 * @param {object} settings - Settings object to validate in-place
 * @param {object} constraints - Map of setting key to { min, max, label }
 */
export function validateSettings(settings, constraints) {
    for (const [key, { min, max, label }] of Object.entries(constraints)) {
        if (typeof settings[key] === 'number') {
            clampWithLog(settings, key, min, max, label || key);
        }
    }
    // Ensure tags are trimmed strings
    if (typeof settings.lorebookTag === 'string') {
        settings.lorebookTag = settings.lorebookTag.trim() || 'lorebook';
    }
}
