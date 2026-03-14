/**
 * DeepLore unit tests
 * Run with: node tests.js
 *
 * Tests pure functions extracted from index.js.
 * These are duplicated here to avoid ESM/browser import issues.
 */

// ============================================================================
// Functions under test (copied from index.js for standalone testing)
// ============================================================================

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

        if (/^\s+-\s+/.test(trimmed) && currentKey) {
            const value = trimmed.replace(/^\s+-\s+/, '').trim();
            if (!currentArray) {
                currentArray = [];
                frontmatter[currentKey] = currentArray;
            }
            currentArray.push(value);
            continue;
        }

        const kvMatch = trimmed.match(/^(\w[\w-]*)\s*:\s*(.*)/);
        if (kvMatch) {
            currentKey = kvMatch[1];
            const rawValue = kvMatch[2].trim();
            currentArray = null;

            if (rawValue === '' || rawValue === '[]') {
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
                frontmatter[currentKey] = rawValue.replace(/^['"]|['"]$/g, '');
            }
        }
    }

    return { frontmatter, body };
}

function cleanContent(content) {
    let cleaned = content;
    cleaned = cleaned.replace(/%%deeplore-exclude%%[\s\S]*?%%\/deeplore-exclude%%/g, '');
    cleaned = cleaned.replace(/%%[\s\S]*?%%/g, '');
    cleaned = cleaned.replace(/<\/?div[^>]*>/g, '');
    cleaned = cleaned.replace(/^#\s+.+$/m, '');
    cleaned = cleaned.replace(/!\[\[.*?\]\]/g, '');
    cleaned = cleaned.replace(/!\[.*?\]\(.*?\)/g, '');
    cleaned = cleaned.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2');
    cleaned = cleaned.replace(/\[\[([^\]]+)\]\]/g, '$1');
    cleaned = cleaned.replace(/\n{3,}/g, '\n\n');
    return cleaned.trim();
}

function extractTitle(body, filename) {
    const h1Match = body.match(/^#\s+(.+)$/m);
    if (h1Match) {
        return h1Match[1].trim();
    }
    const parts = filename.split('/');
    const name = parts[parts.length - 1];
    return name.replace(/\.md$/, '');
}

function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

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

function extractWikiLinks(body) {
    const links = new Set();
    const regex = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
    let match;
    while ((match = regex.exec(body)) !== null) {
        if (match.index > 0 && body[match.index - 1] === '!') continue;
        links.add(match[1].trim());
    }
    return [...links];
}

function truncateToSentence(text, maxLen) {
    if (text.length <= maxLen) return text;
    const truncated = text.substring(0, maxLen);
    const lastSentence = truncated.search(/[.!?][^.!?]*$/);
    if (lastSentence > maxLen * 0.4) {
        return truncated.substring(0, lastSentence + 1);
    }
    return truncated.trimEnd() + '...';
}

function simpleHash(text) {
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
        const char = text.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash |= 0;
    }
    return `${text.length}:${hash}`;
}

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
            if (entry.requires && entry.requires.length > 0) {
                const allPresent = entry.requires.every(r => activeTitles.has(r.toLowerCase()));
                if (!allPresent) { changed = true; return false; }
            }
            if (entry.excludes && entry.excludes.length > 0) {
                const anyPresent = entry.excludes.some(r => activeTitles.has(r.toLowerCase()));
                if (anyPresent) { changed = true; return false; }
            }
            return true;
        });
    }

    return result;
}

function buildScanText(chat, depth) {
    if (depth <= 0) return '';
    const recentMessages = chat.slice(-Math.min(depth, chat.length));
    return recentMessages.map(m => `${m.name || ''}: ${m.mes || ''}`).join('\n');
}

const settingsConstraints = {
    obsidianPort: { min: 1, max: 65535 },
    scanDepth: { min: 1, max: 100 },
    maxEntries: { min: 1, max: 100 },
    maxTokensBudget: { min: 100, max: 100000 },
    injectionDepth: { min: 0, max: 9999 },
    maxRecursionSteps: { min: 1, max: 10 },
    cacheTTL: { min: 0, max: 86400 },
    reviewResponseTokens: { min: 0, max: 100000 },
};

function validateSettings(settings) {
    for (const [key, { min, max }] of Object.entries(settingsConstraints)) {
        if (typeof settings[key] === 'number') {
            settings[key] = Math.max(min, Math.min(max, Math.round(settings[key])));
        }
    }
    if (typeof settings.lorebookTag === 'string') {
        settings.lorebookTag = settings.lorebookTag.trim() || 'lorebook';
    }
}

// ============================================================================
// Test runner
// ============================================================================

let passed = 0;
let failed = 0;

function assert(condition, message) {
    if (condition) {
        passed++;
    } else {
        failed++;
        console.error(`  FAIL: ${message}`);
    }
}

function assertEqual(actual, expected, message) {
    if (JSON.stringify(actual) === JSON.stringify(expected)) {
        passed++;
    } else {
        failed++;
        console.error(`  FAIL: ${message}`);
        console.error(`    expected: ${JSON.stringify(expected)}`);
        console.error(`    actual:   ${JSON.stringify(actual)}`);
    }
}

function test(name, fn) {
    console.log(`\n${name}`);
    fn();
}

// ============================================================================
// Tests
// ============================================================================

test('parseFrontmatter: basic key-value pairs', () => {
    const input = '---\ntitle: Test Note\npriority: 10\nenabled: true\n---\n# Body';
    const result = parseFrontmatter(input);
    assertEqual(result.frontmatter.title, 'Test Note', 'should parse string value');
    assertEqual(result.frontmatter.priority, 10, 'should parse number value');
    assertEqual(result.frontmatter.enabled, true, 'should parse boolean true');
    assertEqual(result.body, '# Body', 'should extract body');
});

test('parseFrontmatter: arrays', () => {
    const input = '---\ntags:\n  - lorebook\n  - character\nkeys:\n  - Eris\n  - goddess\n---\nContent';
    const result = parseFrontmatter(input);
    assertEqual(result.frontmatter.tags, ['lorebook', 'character'], 'should parse tags array');
    assertEqual(result.frontmatter.keys, ['Eris', 'goddess'], 'should parse keys array');
});

test('parseFrontmatter: empty arrays', () => {
    const input = '---\nkeys: []\n---\nContent';
    const result = parseFrontmatter(input);
    assertEqual(result.frontmatter.keys, [], 'should parse empty array');
});

test('parseFrontmatter: boolean false', () => {
    const input = '---\nenabled: false\n---\nContent';
    const result = parseFrontmatter(input);
    assertEqual(result.frontmatter.enabled, false, 'should parse boolean false');
});

test('parseFrontmatter: quoted strings', () => {
    const input = '---\ntitle: "Hello World"\n---\nContent';
    const result = parseFrontmatter(input);
    assertEqual(result.frontmatter.title, 'Hello World', 'should strip quotes');
});

test('parseFrontmatter: no frontmatter', () => {
    const input = '# Just a heading\nSome content';
    const result = parseFrontmatter(input);
    assertEqual(result.frontmatter, {}, 'should return empty frontmatter');
    assertEqual(result.body, input, 'should return full content as body');
});

test('cleanContent: strips image embeds', () => {
    assertEqual(cleanContent('Before ![[image.png]] after'), 'Before  after', 'should strip wiki image embeds');
    assertEqual(cleanContent('Before ![alt](http://img.png) after'), 'Before  after', 'should strip markdown image embeds');
});

test('cleanContent: converts wiki links', () => {
    assertEqual(cleanContent('See [[Target Page]]'), 'See Target Page', 'should convert simple wiki links');
    assertEqual(cleanContent('See [[Target|Display Text]]'), 'See Display Text', 'should convert aliased wiki links');
});

test('cleanContent: collapses blank lines', () => {
    assertEqual(cleanContent('Line 1\n\n\n\n\nLine 2'), 'Line 1\n\nLine 2', 'should collapse 5 newlines to 2');
});

test('extractTitle: from H1', () => {
    assertEqual(extractTitle('# My Title\nContent', 'test.md'), 'My Title', 'should extract H1');
});

test('extractTitle: from filename', () => {
    assertEqual(extractTitle('No heading here', 'folder/My Note.md'), 'My Note', 'should fall back to filename');
});

test('extractTitle: nested path', () => {
    assertEqual(extractTitle('Content', 'World/Characters/Alice.md'), 'Alice', 'should use last path segment');
});

test('testEntryMatch: case insensitive substring', () => {
    const entry = { keys: ['Eris'] };
    const settings = { caseSensitive: false, matchWholeWords: false };
    assertEqual(testEntryMatch(entry, 'I met eris today', settings), 'Eris', 'should match case-insensitively');
    assertEqual(testEntryMatch(entry, 'No match here', settings), null, 'should return null for no match');
});

test('testEntryMatch: case sensitive', () => {
    const entry = { keys: ['Eris'] };
    const settings = { caseSensitive: true, matchWholeWords: false };
    assertEqual(testEntryMatch(entry, 'I met eris today', settings), null, 'should not match wrong case');
    assertEqual(testEntryMatch(entry, 'I met Eris today', settings), 'Eris', 'should match exact case');
});

test('testEntryMatch: whole words', () => {
    const entry = { keys: ['war'] };
    const settings = { caseSensitive: false, matchWholeWords: true };
    assertEqual(testEntryMatch(entry, 'The warning was clear', settings), null, 'should not match partial word');
    assertEqual(testEntryMatch(entry, 'The war began', settings), 'war', 'should match whole word');
});

test('testEntryMatch: empty keys', () => {
    const entry = { keys: [] };
    const settings = { caseSensitive: false, matchWholeWords: false };
    assertEqual(testEntryMatch(entry, 'any text', settings), null, 'should return null for empty keys');
});

test('testEntryMatch: regex special chars in key', () => {
    const entry = { keys: ['C++ programming'] };
    const settings = { caseSensitive: false, matchWholeWords: false };
    assertEqual(testEntryMatch(entry, 'I love c++ programming', settings), 'C++ programming', 'should handle regex special chars');
});

test('validateSettings: clamps values', () => {
    const settings = { obsidianPort: 99999, scanDepth: -5, cacheTTL: 100000 };
    validateSettings(settings);
    assertEqual(settings.obsidianPort, 65535, 'should clamp port to max');
    assertEqual(settings.scanDepth, 1, 'should clamp scanDepth to min');
    assertEqual(settings.cacheTTL, 86400, 'should clamp cacheTTL to max');
});

test('validateSettings: rounds floats', () => {
    const settings = { scanDepth: 4.7 };
    validateSettings(settings);
    assertEqual(settings.scanDepth, 5, 'should round float to integer');
});

test('validateSettings: trims lorebook tag', () => {
    const settings = { lorebookTag: '  custom-tag  ' };
    validateSettings(settings);
    assertEqual(settings.lorebookTag, 'custom-tag', 'should trim whitespace');
});

test('validateSettings: defaults empty lorebook tag', () => {
    const settings = { lorebookTag: '   ' };
    validateSettings(settings);
    assertEqual(settings.lorebookTag, 'lorebook', 'should default empty tag to lorebook');
});

// ============================================================================
// New tests for bug fixes
// ============================================================================

test('parseFrontmatter: negative numbers', () => {
    const input = '---\npriority: -10\n---\nContent';
    const result = parseFrontmatter(input);
    assertEqual(result.frontmatter.priority, -10, 'should parse negative number');
});

test('parseFrontmatter: float numbers', () => {
    const input = '---\npriority: 3.5\n---\nContent';
    const result = parseFrontmatter(input);
    assertEqual(result.frontmatter.priority, 3.5, 'should parse float number');
});

test('parseFrontmatter: inline arrays', () => {
    const input = '---\nkeys: [Wren, wren, The Bird]\n---\nContent';
    const result = parseFrontmatter(input);
    assertEqual(result.frontmatter.keys, ['Wren', 'wren', 'The Bird'], 'should parse inline array');
});

test('parseFrontmatter: inline arrays with quotes', () => {
    const input = '---\nkeys: ["Wren Smith", \'The Bird\']\n---\nContent';
    const result = parseFrontmatter(input);
    assertEqual(result.frontmatter.keys, ['Wren Smith', 'The Bird'], 'should strip quotes from inline array items');
});

test('parseFrontmatter: inline array with spaces', () => {
    const input = '---\ntags: [ lorebook , character ]\n---\nContent';
    const result = parseFrontmatter(input);
    assertEqual(result.frontmatter.tags, ['lorebook', 'character'], 'should trim whitespace in inline array items');
});

test('cleanContent: strips deeplore-exclude regions', () => {
    assertEqual(
        cleanContent('Before\n%%deeplore-exclude%%\nHidden stuff\n%%/deeplore-exclude%%\nAfter'),
        'Before\n\nAfter',
        'should strip deeplore-exclude region and contents',
    );
    assertEqual(
        cleanContent('Start %%deeplore-exclude%%secret%%/deeplore-exclude%% end'),
        'Start  end',
        'should strip inline deeplore-exclude',
    );
});

test('cleanContent: strips Obsidian %% comment blocks', () => {
    assertEqual(cleanContent('Before %%inline comment%% after'), 'Before  after',
        'should strip inline %% blocks');
    assertEqual(
        cleanContent('Before\n%%aat-inline-event\nstart-date: 2025\ntimelines: [test]\n%%\nAfter'),
        'Before\n\nAfter',
        'should strip multiline %% blocks',
    );
    assertEqual(cleanContent('%%aat-event-end-of-body%%'), '',
        'should strip standalone %% markers');
});

test('cleanContent: strips HTML div tags', () => {
    assertEqual(
        cleanContent('<div class="meta-block">[Species: vampire]</div>'),
        '[Species: vampire]',
        'should strip div tags but keep content',
    );
    assertEqual(cleanContent('Text <div>inner</div> more'), 'Text inner more',
        'should strip plain div tags');
});

test('cleanContent: strips H1 heading', () => {
    assertEqual(cleanContent('# Eris\nContent here'), 'Content here',
        'should strip H1 heading');
    assertEqual(cleanContent('## Subheading\nContent'), '## Subheading\nContent',
        'should NOT strip H2 headings');
});

// ============================================================================
// Backported feature tests
// ============================================================================

test('extractWikiLinks: simple links', () => {
    assertEqual(extractWikiLinks('See [[Alice]] and [[Bob]]'), ['Alice', 'Bob'], 'should extract simple links');
});

test('extractWikiLinks: aliased links', () => {
    assertEqual(extractWikiLinks('See [[Alice|The Queen]]'), ['Alice'], 'should extract target from aliased links');
});

test('extractWikiLinks: skips image embeds', () => {
    assertEqual(extractWikiLinks('Text ![[image.png]] and [[Alice]]'), ['Alice'], 'should skip image embeds');
});

test('extractWikiLinks: deduplicates', () => {
    assertEqual(extractWikiLinks('[[Alice]] mentions [[Alice]] again'), ['Alice'], 'should deduplicate links');
});

test('extractWikiLinks: no links', () => {
    assertEqual(extractWikiLinks('No links here'), [], 'should return empty for no links');
});

test('truncateToSentence: short text unchanged', () => {
    assertEqual(truncateToSentence('Hello world.', 50), 'Hello world.', 'should not truncate short text');
});

test('truncateToSentence: cuts at sentence boundary', () => {
    const text = 'First sentence. Second sentence. Third sentence is very long.';
    const result = truncateToSentence(text, 35);
    assertEqual(result, 'First sentence. Second sentence.', 'should cut at last sentence boundary');
});

test('truncateToSentence: falls back to ellipsis', () => {
    const text = 'This is one very long sentence that has no periods or breaks at all and just keeps going';
    const result = truncateToSentence(text, 30);
    assert(result.endsWith('...'), 'should end with ellipsis when no sentence boundary');
    assert(result.length <= 33, 'should be within limit plus ellipsis');
});

test('simpleHash: consistent hashing', () => {
    const hash1 = simpleHash('hello world');
    const hash2 = simpleHash('hello world');
    assertEqual(hash1, hash2, 'same input should produce same hash');
});

test('simpleHash: different inputs produce different hashes', () => {
    const hash1 = simpleHash('hello');
    const hash2 = simpleHash('world');
    assert(hash1 !== hash2, 'different inputs should produce different hashes');
});

test('simpleHash: includes length prefix', () => {
    const hash = simpleHash('test');
    assert(hash.startsWith('4:'), 'should start with length prefix');
});

test('applyGating: passes entries with no rules', () => {
    const entries = [
        { title: 'Alice', requires: [], excludes: [] },
        { title: 'Bob', requires: [], excludes: [] },
    ];
    assertEqual(applyGating(entries).length, 2, 'should pass all entries with no gating rules');
});

test('applyGating: requires removes missing dependency', () => {
    const entries = [
        { title: 'Alice', requires: [], excludes: [] },
        { title: 'Secret', requires: ['Bob'], excludes: [] },
    ];
    const result = applyGating(entries);
    assertEqual(result.length, 1, 'should remove entry with missing requirement');
    assertEqual(result[0].title, 'Alice', 'should keep entry without requirements');
});

test('applyGating: requires keeps when dependency present', () => {
    const entries = [
        { title: 'Alice', requires: [], excludes: [] },
        { title: 'Bob', requires: [], excludes: [] },
        { title: 'Secret', requires: ['Bob'], excludes: [] },
    ];
    assertEqual(applyGating(entries).length, 3, 'should keep entry when requirement is present');
});

test('applyGating: excludes removes when blocker present', () => {
    const entries = [
        { title: 'Alice', requires: [], excludes: [] },
        { title: 'Bob', requires: [], excludes: ['Alice'] },
    ];
    const result = applyGating(entries);
    assertEqual(result.length, 1, 'should remove entry excluded by present entry');
    assertEqual(result[0].title, 'Alice', 'should keep the non-excluded entry');
});

test('applyGating: cascading removal', () => {
    const entries = [
        { title: 'Alice', requires: [], excludes: [] },
        { title: 'Bob', requires: ['Charlie'], excludes: [] },
        { title: 'Secret', requires: ['Bob'], excludes: [] },
    ];
    const result = applyGating(entries);
    assertEqual(result.length, 1, 'should cascade - removing Bob also removes Secret');
    assertEqual(result[0].title, 'Alice', 'should only keep Alice');
});

test('applyGating: case insensitive matching', () => {
    const entries = [
        { title: 'Alice', requires: [], excludes: [] },
        { title: 'Secret', requires: ['alice'], excludes: [] },
    ];
    assertEqual(applyGating(entries).length, 2, 'should match requires case-insensitively');
});

test('buildScanText: returns empty for depth 0', () => {
    const chat = [{ name: 'User', mes: 'Hello' }];
    assertEqual(buildScanText(chat, 0), '', 'should return empty string for depth 0');
});

test('buildScanText: returns empty for negative depth', () => {
    const chat = [{ name: 'User', mes: 'Hello' }];
    assertEqual(buildScanText(chat, -1), '', 'should return empty string for negative depth');
});

test('buildScanText: returns messages for positive depth', () => {
    const chat = [
        { name: 'User', mes: 'Hello' },
        { name: 'Bot', mes: 'Hi there' },
    ];
    const result = buildScanText(chat, 1);
    assert(result.includes('Hi there'), 'should include last message');
    assert(!result.includes('Hello'), 'should not include message beyond depth');
});

test('parseFrontmatter: requires and excludes arrays', () => {
    const input = '---\nrequires:\n  - Alice\n  - Bob\nexcludes:\n  - Charlie\n---\nContent';
    const result = parseFrontmatter(input);
    assertEqual(result.frontmatter.requires, ['Alice', 'Bob'], 'should parse requires array');
    assertEqual(result.frontmatter.excludes, ['Charlie'], 'should parse excludes array');
});

test('parseFrontmatter: injection position overrides', () => {
    const input = '---\nposition: in_chat\ndepth: 2\nrole: user\n---\nContent';
    const result = parseFrontmatter(input);
    assertEqual(result.frontmatter.position, 'in_chat', 'should parse position string');
    assertEqual(result.frontmatter.depth, 2, 'should parse depth number');
    assertEqual(result.frontmatter.role, 'user', 'should parse role string');
});

// ============================================================================
// Results
// ============================================================================

console.log(`\n${'='.repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
    process.exit(1);
}
