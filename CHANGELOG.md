# Changelog

## 0.12-ALPHA

### New Features
- **Active Character Boost** -- New `characterContextScan` setting. When enabled, automatically matches the active character's vault entry by name or keyword, ensuring their lore is available whenever they're in the conversation.

### Internal
- 130 passing tests
- Bumped version to 0.12-ALPHA

## 0.11-ALPHA

### Refactor: Shared Core Extraction
- **Shared `core/` directory** -- Extracted ~800 lines of duplicated functions into 4 shared ES module files (`core/utils.js`, `core/matching.js`, `core/pipeline.js`, `core/sync.js`). Both DeepLore and DeepLore Enhanced now import from these shared modules instead of maintaining inline copies.
- **Shared `server/core/obsidian.js`** -- Extracted Obsidian REST API helpers (obsidianRequest, encodeVaultPath, listAllFiles) into a shared CommonJS module.
- **Parameterized functions** -- Functions that previously referenced module-level constants now accept them as arguments: `validateSettings(settings, constraints)`, `formatAndGroup(entries, settings, promptTagPrefix)`, `resolveLinks(vaultIndex)`, `takeIndexSnapshot(vaultIndex)`, `clearPrompts(extensionPrompts, promptTagPrefix, promptTag)`.
- **New `parseVaultFile()`** -- Replaces the ~80-line inline parsing loop in `buildIndex()` with a single shared function.
- **Tests migrated to ESM** -- `tests.js` replaced by `tests.mjs` importing from `./core/` instead of duplicating functions. 130 passing tests.
- **No behavior changes** -- Pure refactor. All existing functionality preserved.

### Internal
- New shared files: `core/utils.js`, `core/matching.js`, `core/pipeline.js`, `core/sync.js`, `core/README.md`, `server/core/obsidian.js`
- Git subtree workflow documented in `core/README.md` (Enhanced owns `core/`, base pulls via subtree)
- 130 passing tests
- Bumped version to 0.11-ALPHA

## 0.10-ALPHA

### New Features
- **Conditional Gating (requires/excludes)** -- Entries can declare dependencies on other entries. `requires: [Eris, Dark Council]` means ALL listed entries must be matched. `excludes: [Draft Notes]` blocks this entry if ANY listed entry is matched. Cascading resolution.
- **Per-Entry Injection Position** -- Override global injection position via frontmatter: `position` (before/after/in_chat), `depth`, and `role` (system/user/assistant). Entries are grouped and injected separately.
- **Cooldown Tags** -- Per-entry `cooldown: N` frontmatter field. After an entry triggers, it's skipped for the next N generations before becoming eligible again.
- **Warmup Tags** -- Per-entry `warmup: N` frontmatter field. An entry's keywords must appear N or more times in the scan text before it triggers for the first time.
- **Re-injection Cooldown** -- New global setting to skip re-injecting an entry for N generations after it was last injected. Helps save context by avoiding redundant lore repetition. Constants are exempt.
- **Vault Change Detection** -- Index rebuilds now compare against the previous snapshot and report added, removed, modified entries and keyword changes via toast notifications.
- **Auto-Sync Polling** -- New setting for automatic index rebuild on a configurable interval (0-3600 seconds).
- **Entry Usage Analytics** -- Tracks how often each entry is matched and injected across generations. View with `/deeplore-analytics`. Shows a table sorted by injection count plus a "Never Injected" section for dead entry detection.
- **Entry Health Check** -- `/deeplore-health` audits all vault entries for common issues: empty keys on non-constant entries, orphaned requires/excludes references, oversized entries (>1500 tokens), and duplicate keywords shared across entries.

### Settings
- New "Re-injection Cooldown" setting in Matching section (0 = disabled, N = skip for N generations).
- New "Auto-Sync Interval" setting in Index & Debug section (seconds between auto-refresh, 0 to disable).
- New "Show Sync Change Toasts" toggle in Index & Debug section.
- Scan Depth minimum changed from 1 to 0 (allows disabling keyword scanning).
- Added injection hint about per-entry frontmatter overrides in Injection section.

### New Frontmatter Fields
| Field | Type | Description |
|-------|------|-------------|
| `requires` | string[] | Entry titles that must all be matched for this entry to activate |
| `excludes` | string[] | Entry titles that, if any matched, block this entry |
| `position` | string | Injection position: `before`, `after`, or `in_chat` |
| `depth` | number | Injection depth (for `in_chat` position) |
| `role` | string | Message role: `system`, `user`, or `assistant` |
| `cooldown` | number | Generations to skip after triggering |
| `warmup` | number | Keyword occurrence count required before first trigger |

### New Slash Commands
| Command | Description |
|---------|-------------|
| `/deeplore-analytics` | Show entry usage analytics popup |
| `/deeplore-health` | Audit entries for common issues |

### Internal
- New functions: `applyGating()`, `formatAndGroup()`, `clearDeeplorePrompts()`, `takeIndexSnapshot()`, `detectChanges()`, `showChangesToast()`, `setupSyncPolling()`, `countKeywordOccurrences()`
- New globals: `cooldownTracker`, `generationCount`, `injectionHistory`, `previousIndexSnapshot`, `syncIntervalId`
- New imports: `eventSource`, `event_types`, `callGenericPopup`, `POPUP_TYPE`, `escapeHtml`
- Session state (cooldownTracker, injectionHistory, generationCount) resets on CHAT_CHANGED
- 77 passing tests
- Bumped version to 0.10-ALPHA

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
