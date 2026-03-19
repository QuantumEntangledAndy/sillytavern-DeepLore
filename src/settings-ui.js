/**
 * DeepLore — Settings UI: load, bind, stats
 */
import {
    getRequestHeaders,
    saveSettingsDebounced,
    chat,
} from '../../../../script.js';
import { escapeHtml } from '../../../utils.js';
import { callGenericPopup, POPUP_TYPE } from '../../../popup.js';
import { applyGating, formatAndGroup } from '../core/matching.js';
import { getSettings, PLUGIN_BASE, PROMPT_TAG_PREFIX } from '../settings.js';
import {
    vaultIndex, indexTimestamp,
    setVaultIndex, setIndexTimestamp,
} from './state.js';
import { buildIndex } from './vault.js';
import { matchEntries } from './pipeline.js';
import { setupSyncPolling } from './sync.js';

// ============================================================================
// Index Stats
// ============================================================================

export function updateIndexStats() {
    const statsEl = document.getElementById('deeplore_index_stats');
    if (statsEl) {
        if (vaultIndex.length > 0) {
            const totalKeys = vaultIndex.reduce((sum, e) => sum + e.keys.length, 0);
            const constants = vaultIndex.filter(e => e.constant).length;
            const totalTokens = vaultIndex.reduce((sum, e) => sum + e.tokenEstimate, 0);
            statsEl.textContent = `${vaultIndex.length} entries (${totalKeys} keywords, ${constants} always-send, ~${totalTokens} total tokens)`;
        } else {
            statsEl.textContent = 'No index loaded.';
        }
    }
}

// ============================================================================
// Load Settings into UI
// ============================================================================

export function loadSettingsUI() {
    const settings = getSettings();

    $('#deeplore_enabled').prop('checked', settings.enabled);
    $('#deeplore_enabled').closest('.inline-drawer-content').find('> :not(:first-child)').css('opacity', settings.enabled ? 1 : 0.5);
    $('#deeplore_port').val(settings.obsidianPort);
    $('#deeplore_api_key').val(settings.obsidianApiKey);
    $('#deeplore_tag').val(settings.lorebookTag);
    $('#deeplore_constant_tag').val(settings.constantTag);
    $('#deeplore_never_insert_tag').val(settings.neverInsertTag);
    $('#deeplore_seed_tag').val(settings.seedTag);
    $('#deeplore_bootstrap_tag').val(settings.bootstrapTag);
    $('#deeplore_new_chat_threshold').val(settings.newChatThreshold);
    $('#deeplore_scan_depth').val(settings.scanDepth);
    $('#deeplore_max_entries').val(settings.maxEntries);
    $('#deeplore_unlimited_entries').prop('checked', settings.unlimitedEntries);
    $('#deeplore_max_entries').prop('disabled', settings.unlimitedEntries);
    $('#deeplore_token_budget').val(settings.maxTokensBudget);
    $('#deeplore_unlimited_budget').prop('checked', settings.unlimitedBudget);
    $('#deeplore_token_budget').prop('disabled', settings.unlimitedBudget);
    $('#deeplore_template').val(settings.injectionTemplate);
    $(`input[name="deeplore_position"][value="${settings.injectionPosition}"]`).prop('checked', true);
    $('#deeplore_depth').val(settings.injectionDepth);
    $('#deeplore_role').val(settings.injectionRole);
    // Depth/role only apply for in-chat position (value 1)
    const isInChat = settings.injectionPosition === 1;
    $('#deeplore_depth, #deeplore_role').prop('disabled', !isInChat).css('opacity', isInChat ? 1 : 0.4);
    $('#deeplore_allow_wi_scan').prop('checked', settings.allowWIScan);
    $('#deeplore_recursive_scan').prop('checked', settings.recursiveScan);
    $('#deeplore_max_recursion').val(settings.maxRecursionSteps);
    $('#deeplore_max_recursion').prop('disabled', !settings.recursiveScan);
    $('#deeplore_cache_ttl').val(settings.cacheTTL);
    $('#deeplore_review_tokens').val(settings.reviewResponseTokens);
    $('#deeplore_case_sensitive').prop('checked', settings.caseSensitive);
    $('#deeplore_match_whole_words').prop('checked', settings.matchWholeWords);
    $('#deeplore_char_context_scan').prop('checked', settings.characterContextScan);
    $('#deeplore_debug').prop('checked', settings.debugMode);
    $('#deeplore_reinjection_cooldown').val(settings.reinjectionCooldown);
    $('#deeplore_sync_interval').val(settings.syncPollingInterval);
    $('#deeplore_show_sync_toasts').prop('checked', settings.showSyncToasts);

    updateIndexStats();
}

// ============================================================================
// Bind Settings Events
// ============================================================================

/**
 * @param {Function} buildIndexFn - The buildIndex function, passed to avoid circular imports
 */
export function bindSettingsEvents(buildIndexFn) {
    const settings = getSettings();

    $('#deeplore_enabled').on('change', function () {
        settings.enabled = $(this).prop('checked');
        saveSettingsDebounced();
        setupSyncPolling(buildIndexFn); // stop/start polling based on enabled state
        $(this).closest('.inline-drawer-content').find('> :not(:first-child)').css('opacity', settings.enabled ? 1 : 0.5);
    });

    $('#deeplore_port').on('input', function () {
        const val = Number($(this).val());
        settings.obsidianPort = isNaN(val) ? 27123 : val;
        saveSettingsDebounced();
        $('#deeplore_connection_status').text('').removeClass('success failure');
    });

    $('#deeplore_api_key').on('input', function () {
        settings.obsidianApiKey = String($(this).val());
        saveSettingsDebounced();
        $('#deeplore_connection_status').text('').removeClass('success failure');
    });

    $('#deeplore_tag').on('input', function () {
        settings.lorebookTag = String($(this).val()).trim() || 'lorebook';
        saveSettingsDebounced();
    });

    $('#deeplore_constant_tag').on('input', function () {
        settings.constantTag = String($(this).val()).trim();
        saveSettingsDebounced();
    });

    $('#deeplore_never_insert_tag').on('input', function () {
        settings.neverInsertTag = String($(this).val()).trim();
        saveSettingsDebounced();
    });

    $('#deeplore_seed_tag').on('input', function () {
        settings.seedTag = String($(this).val()).trim();
        saveSettingsDebounced();
    });

    $('#deeplore_bootstrap_tag').on('input', function () {
        settings.bootstrapTag = String($(this).val()).trim();
        saveSettingsDebounced();
    });

    $('#deeplore_new_chat_threshold').on('input', function () {
        const val = Number($(this).val());
        settings.newChatThreshold = isNaN(val) ? 3 : val;
        saveSettingsDebounced();
    });

    $('#deeplore_scan_depth').on('input', function () {
        const val = Number($(this).val());
        settings.scanDepth = isNaN(val) ? 4 : val;
        saveSettingsDebounced();
    });

    $('#deeplore_max_entries').on('input', function () {
        settings.maxEntries = Number($(this).val()) || 10;
        saveSettingsDebounced();
    });

    $('#deeplore_unlimited_entries').on('change', function () {
        settings.unlimitedEntries = $(this).prop('checked');
        $('#deeplore_max_entries').prop('disabled', settings.unlimitedEntries);
        saveSettingsDebounced();
    });

    $('#deeplore_token_budget').on('input', function () {
        settings.maxTokensBudget = Number($(this).val()) || 2048;
        saveSettingsDebounced();
    });

    $('#deeplore_unlimited_budget').on('change', function () {
        settings.unlimitedBudget = $(this).prop('checked');
        $('#deeplore_token_budget').prop('disabled', settings.unlimitedBudget);
        saveSettingsDebounced();
    });

    $('#deeplore_template').on('input', function () {
        settings.injectionTemplate = String($(this).val());
        saveSettingsDebounced();
    });

    $('input[name="deeplore_position"]').on('change', function () {
        settings.injectionPosition = Number($(this).val());
        const inChat = settings.injectionPosition === 1;
        $('#deeplore_depth, #deeplore_role').prop('disabled', !inChat).css('opacity', inChat ? 1 : 0.4);
        saveSettingsDebounced();
    });

    $('#deeplore_depth').on('input', function () {
        const val = Number($(this).val());
        settings.injectionDepth = isNaN(val) ? 4 : val;
        saveSettingsDebounced();
    });

    $('#deeplore_role').on('change', function () {
        settings.injectionRole = Number($(this).val());
        saveSettingsDebounced();
    });

    $('#deeplore_allow_wi_scan').on('change', function () {
        settings.allowWIScan = $(this).prop('checked');
        saveSettingsDebounced();
    });

    $('#deeplore_recursive_scan').on('change', function () {
        settings.recursiveScan = $(this).prop('checked');
        $('#deeplore_max_recursion').prop('disabled', !settings.recursiveScan);
        saveSettingsDebounced();
    });

    $('#deeplore_max_recursion').on('input', function () {
        settings.maxRecursionSteps = Number($(this).val()) || 3;
        saveSettingsDebounced();
    });

    $('#deeplore_cache_ttl').on('input', function () {
        const val = Number($(this).val());
        settings.cacheTTL = isNaN(val) ? 300 : val;
        saveSettingsDebounced();
    });

    $('#deeplore_review_tokens').on('input', function () {
        settings.reviewResponseTokens = Number($(this).val()) || 0;
        saveSettingsDebounced();
    });

    $('#deeplore_case_sensitive').on('change', function () {
        settings.caseSensitive = $(this).prop('checked');
        saveSettingsDebounced();
    });

    $('#deeplore_match_whole_words').on('change', function () {
        settings.matchWholeWords = $(this).prop('checked');
        saveSettingsDebounced();
    });

    $('#deeplore_char_context_scan').on('change', function () {
        settings.characterContextScan = $(this).is(':checked');
        saveSettingsDebounced();
    });

    $('#deeplore_debug').on('change', function () {
        settings.debugMode = $(this).prop('checked');
        saveSettingsDebounced();
    });

    // Test Connection button
    $('#deeplore_test_connection').on('click', async function () {
        const statusEl = $('#deeplore_connection_status');
        statusEl.text('Testing...').removeClass('success failure');

        try {
            const response = await fetch(`${PLUGIN_BASE}/test`, {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({
                    port: settings.obsidianPort,
                    apiKey: settings.obsidianApiKey,
                }),
            });

            if (!response.ok) {
                throw new Error(`Server returned HTTP ${response.status}`);
            }

            const data = await response.json();

            if (data.ok) {
                const authStatus = data.authenticated ? 'authenticated' : 'not authenticated';
                statusEl.text(`Connected (${authStatus})`).addClass('success').removeClass('failure');
            } else {
                statusEl.text(`Failed: ${data.error}`).addClass('failure').removeClass('success');
            }
        } catch (err) {
            statusEl.text(`Error: ${err.message}`).addClass('failure').removeClass('success');
        }
    });

    // Refresh Index button
    $('#deeplore_refresh').on('click', async function () {
        const $btn = $(this);
        const $icon = $btn.find('i');
        $btn.prop('disabled', true);
        $icon.removeClass('fa-rotate').addClass('fa-spinner fa-spin');
        try {
            setVaultIndex([]);
            setIndexTimestamp(0);
            await buildIndexFn();
        } finally {
            $btn.prop('disabled', false);
            $icon.removeClass('fa-spinner fa-spin').addClass('fa-rotate');
        }
    });

    // Test Match button
    $('#deeplore_test_match').on('click', async function () {
        const settings = getSettings();

        if (!chat || chat.length === 0) {
            toastr.warning('No active chat. Start a conversation first.', 'DeepLore');
            return;
        }

        if (vaultIndex.length === 0) {
            toastr.warning('No vault index. Click "Refresh Index" first.', 'DeepLore');
            return;
        }

        const { matched, matchedKeys } = matchEntries(chat);

        const gated = applyGating(matched);
        const gatedRemoved = matched.filter(e => !gated.includes(e));

        const { groups, count: injectedCount, totalTokens } = formatAndGroup(gated, settings, PROMPT_TAG_PREFIX);
        const budgetRemoved = gated.slice(injectedCount);
        const injected = gated.slice(0, injectedCount);

        // Position labels
        const positionLabels = { 0: 'After', 1: 'In-chat', 2: 'Before' };
        const roleLabels = { 0: 'System', 1: 'User', 2: 'Asst' };

        let html = `<div style="font-family: monospace; font-size: 0.9em;">`;
        html += `<div style="margin-bottom: 10px;">`;
        html += `<b>${vaultIndex.length}</b> indexed &rarr; `;
        html += `<b>${matched.length}</b> keyword matched &rarr; `;
        html += `<b>${gated.length}</b> after gating &rarr; `;
        html += `<b style="color: var(--SmartThemeQuoteColor, #4caf50);">${injectedCount}</b> would inject (~${totalTokens} tokens)`;
        html += `</div>`;

        if (injected.length > 0) {
            html += `<h3>Would Inject (${injectedCount} entries, ~${totalTokens} tokens)</h3>`;
            html += `<table style="width: 100%; border-collapse: collapse; margin-bottom: 15px;">`;
            html += `<tr style="border-bottom: 1px solid var(--SmartThemeBorderColor, rgba(255,255,255,0.2));">`;
            html += `<th style="text-align: left; padding: 4px;">Title</th>`;
            html += `<th style="text-align: left; padding: 4px;">Matched By</th>`;
            html += `<th style="text-align: right; padding: 4px;">Priority</th>`;
            html += `<th style="text-align: right; padding: 4px;">Tokens</th>`;
            html += `<th style="text-align: left; padding: 4px;">Position</th>`;
            html += `</tr>`;
            for (const entry of injected) {
                const pos = entry.injectionPosition ?? settings.injectionPosition;
                const depth = entry.injectionDepth ?? settings.injectionDepth;
                const role = entry.injectionRole ?? settings.injectionRole;
                const posLabel = pos === 1
                    ? `In-chat @${depth} (${roleLabels[role] || '?'})`
                    : (positionLabels[pos] || '?');
                html += `<tr style="border-bottom: 1px solid var(--SmartThemeBorderColor, rgba(255,255,255,0.1));">`;
                html += `<td style="padding: 4px;">${escapeHtml(entry.title)}</td>`;
                html += `<td style="padding: 4px; opacity: 0.8;">${escapeHtml(matchedKeys.get(entry.title) || '?')}</td>`;
                html += `<td style="text-align: right; padding: 4px;">${entry.priority}</td>`;
                html += `<td style="text-align: right; padding: 4px;">${entry.tokenEstimate}</td>`;
                html += `<td style="padding: 4px; opacity: 0.8;">${posLabel}</td>`;
                html += `</tr>`;
            }
            html += `</table>`;
        } else {
            html += `<p style="color: var(--warning, #ff9800);">No entries would be injected.</p>`;
        }

        if (gatedRemoved.length > 0) {
            html += `<h3 style="color: var(--warning, #ff9800);">Removed by Gating (${gatedRemoved.length})</h3>`;
            html += `<ul style="margin: 0 0 15px 20px;">`;
            for (const entry of gatedRemoved) {
                const reasons = [];
                if (entry.requires.length > 0) reasons.push(`requires: ${entry.requires.join(', ')}`);
                if (entry.excludes.length > 0) reasons.push(`excludes: ${entry.excludes.join(', ')}`);
                html += `<li>${escapeHtml(entry.title)} — ${escapeHtml(reasons.join('; ') || 'dependency chain')}</li>`;
            }
            html += `</ul>`;
        }

        if (budgetRemoved.length > 0) {
            html += `<h3 style="color: var(--warning, #ff9800);">Cut by Budget/Max (${budgetRemoved.length})</h3>`;
            html += `<ul style="margin: 0 0 15px 20px;">`;
            for (const entry of budgetRemoved) {
                html += `<li>${escapeHtml(entry.title)} (pri ${entry.priority}, ~${entry.tokenEstimate} tokens)</li>`;
            }
            html += `</ul>`;
        }

        html += `</div>`;
        callGenericPopup(html, POPUP_TYPE.TEXT, '', { wide: true, large: true, allowVerticalScrolling: true });
    });

    $('#deeplore_reinjection_cooldown').on('input', function () {
        const val = Number($(this).val());
        settings.reinjectionCooldown = isNaN(val) ? 0 : val;
        saveSettingsDebounced();
    });

    $('#deeplore_sync_interval').on('input', function () {
        const val = Number($(this).val());
        settings.syncPollingInterval = isNaN(val) ? 0 : val;
        saveSettingsDebounced();
        setupSyncPolling(buildIndexFn);
    });

    $('#deeplore_show_sync_toasts').on('change', function () {
        settings.showSyncToasts = $(this).prop('checked');
        saveSettingsDebounced();
    });
}
