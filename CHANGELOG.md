# Changelog

## 0.8-ALPHA

> **Server plugin updated.** You must re-install the server plugin after updating. Run `install-server.bat` (Windows) or `install-server.sh` (Linux/Mac), or manually copy `server/index.js` to `SillyTavern/plugins/deeplore/index.js`. Restart SillyTavern after replacing.

### Bug Fixes
- **Frontmatter: negative numbers and floats** -- `priority: -10` and `priority: 3.5` now parse correctly as numbers instead of being treated as strings and silently defaulting to 100.
- **Frontmatter: inline YAML arrays** -- `keys: [Eris, goddess]` now parses correctly. Previously only the `- item` list format worked; inline arrays were stored as a raw string, causing zero keyword matches.
- **Settings: cacheTTL=0 rejected** -- Setting Cache TTL to 0 ("always fetch fresh") from the UI was impossible because `0 || 300` fell back to 300. Fixed with `isNaN` check.
- **Settings: injectionDepth=0 rejected** -- Depth 0 ("end of chat") was impossible to set from the UI for the same reason. Fixed.
- **Settings: scanDepth=0 rejected** -- Same `|| fallback` issue. Fixed.
- **Constants skipped on empty chat** -- When `scanText` was empty (e.g., first message with no content), the interceptor returned early before constant entries could be collected. Constants are now always processed.
- **Tooltip referenced wrong command** -- Review Response Tokens tooltip said `/obsidian-lore-review` instead of `/deeplore-review`.
- **Manifest homePage URL casing** -- Fixed to match the actual GitHub repo URL.

### Server Plugin Fixes
- **Path traversal protection** -- The `/file` endpoint now rejects filenames containing `..` to prevent reading files outside the vault.
- **Recursion depth limit** -- `listAllFiles` now caps directory recursion at 20 levels to prevent stack overflow from circular symlinks or extreme nesting.

### Improvements
- **Content cleaning: Obsidian comments** -- `%%...%%` blocks (timeline annotations, dataview, comments) are now stripped from injected content.
- **Content cleaning: deeplore-exclude** -- New `%%deeplore-exclude%%...%%/deeplore-exclude%%` markers let you exclude specific sections of a note from injection.
- **Content cleaning: HTML div tags** -- `<div>` and `</div>` tags are stripped (content inside is preserved). Meta-blocks no longer inject raw HTML.
- **Content cleaning: H1 heading** -- The first `# Heading` is stripped since it's redundant with the title in the XML wrapper.
- **Tests expanded** -- 33 → 47 passing tests covering all new behavior.

### Internal
- Bumped version to 0.8-ALPHA.

## 0.7-ALPHA

### Improvements
- **Accurate token counting** -- Uses SillyTavern's built-in tokenizer instead of the rough `length / 3.5` estimate. Token budgets and stats are now much more accurate. Falls back to estimation if the tokenizer is unavailable.
- **Better recursive scanning** -- Recursive matching now only scans content from newly matched entries each step, avoiding redundant work and preventing wasted cycles when entries reference each other.
- **Runtime settings validation** -- Numeric settings are clamped to valid ranges on load and save. Invalid values (e.g., port > 65535, negative scan depth) are corrected automatically.
- **Consistent CSS naming** -- Renamed all CSS classes and HTML IDs from `obsidian_lorebook_` to `deeplore_` to match the extension's branding.
- **Added package.json** -- Provides version tracking and repository metadata.
- **Added unit tests** -- Test coverage for frontmatter parsing, content cleaning, title extraction, keyword matching, and settings validation. Run with `node tests.js`.

### Internal
- Bumped version to 0.7-ALPHA.

## 0.6-ALPHA

- Initial public release.
- Keyword-triggered lorebook injection from Obsidian vault.
- Recursive scanning, token budgets, configurable injection.
- Server installer scripts.
