/**
 * DeepLore — Vault change detection and sync polling
 */
import { escapeHtml } from '../../../utils.js';
import { getSettings } from '../settings.js';
import { syncIntervalId, indexing, setSyncIntervalId } from './state.js';

/**
 * Show a toast notification summarizing vault changes.
 * @param {{ added: string[], removed: string[], modified: string[], keysChanged: string[] }} changes
 */
export function showChangesToast(changes) {
    const truncList = (arr, max = 3) => {
        const shown = arr.slice(0, max).map(s => escapeHtml(s)).join(', ');
        return arr.length > max ? shown + '...' : shown;
    };

    const parts = [];
    if (changes.added.length > 0) {
        parts.push(`+${changes.added.length} new: ${truncList(changes.added)}`);
    }
    if (changes.removed.length > 0) {
        parts.push(`-${changes.removed.length} removed: ${truncList(changes.removed)}`);
    }
    if (changes.modified.length > 0) {
        parts.push(`~${changes.modified.length} modified: ${truncList(changes.modified)}`);
    }
    if (changes.keysChanged.length > 0) {
        parts.push(`Keys changed: ${truncList(changes.keysChanged)}`);
    }

    if (parts.length > 0) {
        toastr.info(parts.join('<br>'), 'DeepLore - Vault Updated', {
            timeOut: 8000,
            extendedTimeOut: 12000,
            progressBar: true,
            closeButton: true,
            enableHtml: true,
        });
    }
}

/**
 * Set up or tear down periodic vault sync polling.
 * buildIndex is passed as a parameter to avoid circular imports.
 * @param {Function} [buildIndexFn] - The buildIndex function
 */
export function setupSyncPolling(buildIndexFn) {
    const settings = getSettings();

    if (syncIntervalId) {
        clearInterval(syncIntervalId);
        setSyncIntervalId(null);
    }

    if (settings.syncPollingInterval > 0 && settings.enabled && buildIndexFn) {
        setSyncIntervalId(setInterval(async () => {
            if (!settings.enabled || indexing) return;
            await buildIndexFn();
        }, settings.syncPollingInterval * 1000));
    }
}
