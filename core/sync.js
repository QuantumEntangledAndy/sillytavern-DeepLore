/**
 * DeepLore Shared Core — Vault Change Detection
 * This file is shared between DeepLore and DeepLore Enhanced via git subtree.
 * The canonical source lives in the Enhanced repo. Do not edit in base DeepLore.
 */

import { simpleHash } from './utils.js';

/**
 * Take a snapshot of the current vault index for change detection.
 * @param {import('./pipeline.js').VaultEntry[]} vaultIndex
 * @returns {{ contentHashes: Map<string, string>, titleMap: Map<string, string>, keyMap: Map<string, string>, timestamp: number }}
 */
export function takeIndexSnapshot(vaultIndex) {
    const snapshot = {
        contentHashes: new Map(),
        titleMap: new Map(),
        keyMap: new Map(),
        timestamp: Date.now(),
    };

    for (const entry of vaultIndex) {
        snapshot.contentHashes.set(entry.filename, simpleHash(entry.content));
        snapshot.titleMap.set(entry.filename, entry.title);
        snapshot.keyMap.set(entry.filename, JSON.stringify(entry.keys));
    }

    return snapshot;
}

/**
 * Detect changes between two vault index snapshots.
 * @param {{ contentHashes: Map, titleMap: Map, keyMap: Map }|null} oldSnapshot
 * @param {{ contentHashes: Map, titleMap: Map, keyMap: Map }} newSnapshot
 * @returns {{ added: string[], removed: string[], modified: string[], keysChanged: string[], hasChanges: boolean }}
 */
export function detectChanges(oldSnapshot, newSnapshot) {
    const changes = { added: [], removed: [], modified: [], keysChanged: [], hasChanges: false };

    if (!oldSnapshot) return changes;

    const oldFiles = new Set(oldSnapshot.contentHashes.keys());
    const newFiles = new Set(newSnapshot.contentHashes.keys());

    // New entries
    for (const file of newFiles) {
        if (!oldFiles.has(file)) {
            changes.added.push(newSnapshot.titleMap.get(file) || file);
        }
    }

    // Removed entries
    for (const file of oldFiles) {
        if (!newFiles.has(file)) {
            changes.removed.push(oldSnapshot.titleMap.get(file) || file);
        }
    }

    // Modified entries (exist in both, content hash differs)
    for (const file of newFiles) {
        if (oldFiles.has(file)) {
            if (oldSnapshot.contentHashes.get(file) !== newSnapshot.contentHashes.get(file)) {
                changes.modified.push(newSnapshot.titleMap.get(file) || file);
            }
            // Keyword changes (separate from content)
            if (oldSnapshot.keyMap.get(file) !== newSnapshot.keyMap.get(file)) {
                const title = newSnapshot.titleMap.get(file) || file;
                if (!changes.modified.includes(title)) {
                    changes.keysChanged.push(title);
                }
            }
        }
    }

    changes.hasChanges = changes.added.length > 0 || changes.removed.length > 0
        || changes.modified.length > 0 || changes.keysChanged.length > 0;

    return changes;
}
