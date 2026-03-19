/**
 * DeepLore — Context Cartographer
 * Shows which entries were injected per message.
 */
import { escapeHtml } from '../../../../utils.js';
import { callGenericPopup, POPUP_TYPE } from '../../../../popup.js';
import { simpleHash } from '../core/utils.js';
import { getSettings } from '../settings.js';
import { vaultIndex } from './state.js';
import { buildObsidianURI } from './popups.js';

/**
 * Inject a "Lore Sources" button into a message's action bar.
 * @param {number} messageId - Index in the chat array
 */
export function injectSourcesButton(messageId) {
    const mesEl = $(`.mes[mesid="${messageId}"]`);
    if (mesEl.length === 0) return;
    if (mesEl.find('.mes_deeplore_sources').length > 0) return;

    const btn = $('<div title="Lore Sources" class="mes_button mes_deeplore_sources fa-solid fa-book-open"></div>');
    mesEl.find('.extraMesButtons').prepend(btn);
}

/**
 * Show a popup with lore source details for a message.
 * @param {Array<{title: string, filename: string, matchedBy: string, priority: number, tokens: number}>} sources
 */
export function showSourcesPopup(sources) {
    const settings = getSettings();
    const vaultName = settings.obsidianVaultName;
    const totalTokens = sources.reduce((sum, s) => sum + s.tokens, 0);
    const maxTokens = Math.max(...sources.map(s => s.tokens), 1);
    const positionLabels = { 0: 'After Main Prompt', 1: 'In-chat', 2: 'Before Main Prompt' };

    // Group sources by injection position
    const groups = new Map();
    for (const src of sources) {
        const entry = vaultIndex.find(e => e.title === src.title);
        const pos = entry?.injectionPosition ?? settings.injectionPosition;
        const depth = entry?.injectionDepth ?? settings.injectionDepth;
        const posKey = pos === 1 ? `In-chat @depth ${depth}` : (positionLabels[pos] || 'Unknown');
        if (!groups.has(posKey)) groups.set(posKey, []);
        groups.get(posKey).push({ ...src, entry });
    }

    let html = `<div style="text-align: left;">`;
    html += `<h3>Context Map (${sources.length} entries, ~${totalTokens} tokens)</h3>`;

    for (const [posLabel, groupSources] of groups) {
        const groupTokens = groupSources.reduce((sum, s) => sum + s.tokens, 0);
        html += `<h4 style="margin: 12px 0 6px;">${escapeHtml(posLabel)} (~${groupTokens} tokens)</h4>`;

        for (const src of groupSources) {
            const pct = Math.max(2, Math.round((src.tokens / maxTokens) * 100));
            const uri = buildObsidianURI(vaultName, src.filename);
            const titleHtml = uri
                ? `<a href="${escapeHtml(uri)}" target="_blank" style="color: var(--SmartThemeQuoteColor, #aac8ff); text-decoration: none;">${escapeHtml(src.title)}</a>`
                : escapeHtml(src.title);
            const entryId = simpleHash(src.filename + '_ctx');
            const contentPreview = src.entry ? escapeHtml(src.entry.content.substring(0, 300)) + (src.entry.content.length > 300 ? '...' : '') : '';

            html += `<div style="margin-bottom: 6px; padding: 6px; border: 1px solid var(--SmartThemeBorderColor, #444); border-radius: 4px;">`;
            html += `<div style="display: flex; justify-content: space-between; align-items: center; cursor: pointer;" onclick="document.getElementById('deeplore_ctx_${entryId}').style.display = document.getElementById('deeplore_ctx_${entryId}').style.display === 'none' ? 'block' : 'none'">`;
            html += `<span><strong>${titleHtml}</strong> <small style="opacity: 0.6;">pri ${src.priority}</small></span>`;
            html += `<small>~${src.tokens} tok</small>`;
            html += `</div>`;
            html += `<div style="background: var(--SmartThemeBorderColor, #333); border-radius: 2px; height: 6px; margin: 4px 0;">`;
            html += `<div style="background: var(--SmartThemeQuoteColor, #4caf50); height: 100%; width: ${pct}%; border-radius: 2px;"></div>`;
            html += `</div>`;
            html += `<small style="opacity: 0.7;">${escapeHtml(src.matchedBy)}</small>`;
            if (contentPreview) {
                html += `<div id="deeplore_ctx_${entryId}" style="display: none; margin-top: 6px; padding: 6px; background: var(--SmartThemeBlurTintColor, #1a1a2e); border-radius: 4px; font-size: 0.85em; white-space: pre-wrap;">${contentPreview}</div>`;
            }
            html += `</div>`;
        }
    }

    html += vaultName
        ? '<p style="opacity: 0.6; font-size: 0.8em; margin-top: 8px;">Click entry names to open in Obsidian. Click entries to expand content preview.</p>'
        : '<p style="opacity: 0.6; font-size: 0.8em; margin-top: 8px;">Set Obsidian Vault Name in settings to enable deep links.</p>';
    html += '</div>';

    callGenericPopup(html, POPUP_TYPE.TEXT, '', { wide: true, large: true, allowVerticalScrolling: true });
}
