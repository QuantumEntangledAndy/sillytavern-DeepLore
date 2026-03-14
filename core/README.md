# DeepLore Shared Core

This directory contains shared functions used by both **DeepLore** and **DeepLore Enhanced**.

## Canonical Source

The canonical source for `core/` lives in the **Enhanced** repo (`sillytavern-DeepLore-Enhanced/core/`). Do not edit these files directly in the base DeepLore repo.

## Files

| File | Contents |
|------|----------|
| `utils.js` | parseFrontmatter, extractWikiLinks, cleanContent, extractTitle, truncateToSentence, simpleHash, escapeRegex, buildScanText, buildAiChatContext, validateSettings |
| `matching.js` | testEntryMatch, countKeywordOccurrences, applyGating, resolveLinks, formatAndGroup |
| `pipeline.js` | VaultEntry/TagConfig typedefs, parseVaultFile, clearPrompts |
| `sync.js` | takeIndexSnapshot, detectChanges |

## Syncing

From the parent directory (`Sillytavern Testing/`):

```powershell
# Preview what would happen
.\sync-commit.ps1 -DryRun

# Commit both repos
.\sync-commit.ps1
```

The script validates `core/` parity (auto-syncing Enhanced to Base when they diverge), runs tests in both repos, commits with the same message, and pushes both.

## Not in core/

`server/core/obsidian.js` (CommonJS, ~120 lines) is also shared between repos. The sync script handles it the same way.
