/**
 * DeepLore — Vault change detection and sync polling
 */
import { escapeHtml } from '../../../utils.js';
import { getSettings } from '../settings.js';
import { syncIntervalId, indexing, setSyncIntervalId } from './state.js';

/**
 * Show a toast notification with vault change details.
 * @param {{ added: string[], removed: string[], modified: string[], keysChanged: string[] }} changes
 */
export function showChangesToast(changes) {
    const maxShow = 3;
    const parts = [];
    if (changes.added.length > 0) {
        const names = changes.added.slice(0, maxShow).map(n => escapeHtml(n)).join(', ');
        const extra = changes.added.length > maxShow ? ` +${changes.added.length - maxShow} more` : '';
        parts.push(`<b>Added:</b> ${names}${extra}`);
    }
    if (changes.removed.length > 0) {
        const names = changes.removed.slice(0, maxShow).map(n => escapeHtml(n)).join(', ');
        const extra = changes.removed.length > maxShow ? ` +${changes.removed.length - maxShow} more` : '';
        parts.push(`<b>Removed:</b> ${names}${extra}`);
    }
    if (changes.modified.length > 0) {
        const names = changes.modified.slice(0, maxShow).map(n => escapeHtml(n)).join(', ');
        const extra = changes.modified.length > maxShow ? ` +${changes.modified.length - maxShow} more` : '';
        parts.push(`<b>Modified:</b> ${names}${extra}`);
    }
    if (changes.keysChanged.length > 0) {
        const names = changes.keysChanged.slice(0, maxShow).map(n => escapeHtml(n)).join(', ');
        const extra = changes.keysChanged.length > maxShow ? ` +${changes.keysChanged.length - maxShow} more` : '';
        parts.push(`<b>Keys changed:</b> ${names}${extra}`);
    }
    if (parts.length > 0) {
        toastr.info(parts.join('<br>'), 'DeepLore - Vault Updated', { timeOut: 8000, escapeHtml: false });
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
