/**
 * DeepLore — Slash Commands
 */
import {
    getRequestHeaders,
    sendMessageAsUser,
    Generate,
    chat,
} from '../../../../script.js';
import { saveSettingsDebounced } from '../../../../script.js';
import { escapeHtml } from '../../../utils.js';
import { callGenericPopup, POPUP_TYPE } from '../../../popup.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
import { applyGating, formatAndGroup } from '../core/matching.js';
import { getSettings, PLUGIN_BASE, PROMPT_TAG_PREFIX } from '../settings.js';
import {
    vaultIndex, indexTimestamp,
    setVaultIndex, setIndexTimestamp,
} from './state.js';
import { buildIndex, ensureIndexFresh, getMaxResponseTokens } from './vault.js';
import { matchEntries } from './pipeline.js';
import { runHealthCheck } from './diagnostics.js';

export function registerSlashCommands() {
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'deeplore-refresh',
        callback: async () => {
            setVaultIndex([]);
            setIndexTimestamp(0);
            await buildIndex();
            const msg = `Indexed ${vaultIndex.length} entries.`;
            toastr.success(msg, 'DeepLore');
            return msg;
        },
        helpString: 'Force refresh the DeepLore vault index cache.',
        returns: 'Status message',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'deeplore-status',
        callback: async () => {
            const settings = getSettings();
            const constants = vaultIndex.filter(e => e.constant).length;
            const seeds = vaultIndex.filter(e => e.seed).length;
            const bootstraps = vaultIndex.filter(e => e.bootstrap).length;
            const totalTokens = vaultIndex.reduce((sum, e) => sum + e.tokenEstimate, 0);
            const lines = [
                `Enabled: ${settings.enabled}`,
                `Port: ${settings.obsidianPort}`,
                `Lorebook Tag: #${settings.lorebookTag}`,
                `Always-Send Tag: ${settings.constantTag ? '#' + settings.constantTag : '(none)'}`,
                `Never-Insert Tag: ${settings.neverInsertTag ? '#' + settings.neverInsertTag : '(none)'}`,
                `Seed Tag: ${settings.seedTag ? '#' + settings.seedTag : '(none)'}`,
                `Bootstrap Tag: ${settings.bootstrapTag ? '#' + settings.bootstrapTag : '(none)'} (threshold: ${settings.newChatThreshold} messages)`,
                `Entries: ${vaultIndex.length} (${constants} always-send, ${seeds} seed, ${bootstraps} bootstrap, ~${totalTokens} tokens)`,
                `Budget: ${settings.unlimitedBudget ? 'unlimited' : settings.maxTokensBudget + ' tokens'}`,
                `Max Entries: ${settings.unlimitedEntries ? 'unlimited' : settings.maxEntries}`,
                `Recursive: ${settings.recursiveScan ? 'on (max ' + settings.maxRecursionSteps + ' steps)' : 'off'}`,
                `Cache: ${indexTimestamp ? Math.round((Date.now() - indexTimestamp) / 1000) + 's old' : 'none'} / TTL ${settings.cacheTTL}s`,
            ];
            const msg = lines.join('\n');
            toastr.info(msg, 'DeepLore', { timeOut: 10000 });
            return msg;
        },
        helpString: 'Show DeepLore connection status and index stats.',
        returns: 'Status information',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'deeplore-review',
        callback: async (_args, userPrompt) => {
            await ensureIndexFresh();

            if (vaultIndex.length === 0) {
                toastr.warning('No entries indexed. Check your connection and lorebook tag settings.', 'DeepLore');
                return '';
            }

            const settings = getSettings();
            const totalTokens = vaultIndex.reduce((sum, e) => sum + e.tokenEstimate, 0);

            const confirmed = await callGenericPopup(
                `<p>This will send <b>${vaultIndex.length}</b> entries (~${totalTokens} tokens) as a message and generate an AI response.</p><p>This may be expensive. Continue?</p>`,
                POPUP_TYPE.CONFIRM, '', {},
            );
            if (!confirmed) return '';

            const loreDump = vaultIndex.map(entry => {
                return `## ${entry.title}\n${entry.content}`;
            }).join('\n\n---\n\n');

            const responseTokens = settings.reviewResponseTokens > 0
                ? settings.reviewResponseTokens
                : getMaxResponseTokens();
            const budgetHint = `\n\nKeep your response under ${responseTokens} tokens.`;
            const defaultQuestion = 'Review this lorebook/world-building vault. Comment on consistency, gaps, interesting connections between entries, and any suggestions for improvement.';
            const question = (userPrompt && userPrompt.trim()) ? userPrompt.trim() : defaultQuestion;

            const message = `[DeepLore Review — ${vaultIndex.length} entries, ~${totalTokens} tokens]\n\n${loreDump}\n\n---\n\n${question}${budgetHint}`;
            if (settings.debugMode) {
                console.log('[DeepLore] Lore review prompt:', message);
            }

            toastr.info(`Sending ${vaultIndex.length} entries (~${totalTokens} tokens)...`, 'DeepLore', { timeOut: 5000 });

            await sendMessageAsUser(message, '');
            await Generate('normal');

            return '';
        },
        helpString: 'Send the entire Obsidian vault to the AI for review. Optionally provide a custom question, e.g. /deeplore-review What inconsistencies do you see?',
        returns: 'AI review posted to chat',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'deeplore-analytics',
        callback: async () => {
            const settings = getSettings();
            const analytics = settings.analyticsData || {};
            const titles = Object.keys(analytics).sort((a, b) => (analytics[b].injected || 0) - (analytics[a].injected || 0));

            let html = '<table style="width:100%;border-collapse:collapse;font-size:0.9em;">';
            html += '<tr><th style="text-align:left;border-bottom:1px solid #666;padding:4px;">Entry</th><th style="border-bottom:1px solid #666;padding:4px;">Matched</th><th style="border-bottom:1px solid #666;padding:4px;">Injected</th><th style="border-bottom:1px solid #666;padding:4px;">Last Used</th></tr>';

            for (const title of titles) {
                const d = analytics[title];
                const lastUsed = d.lastTriggered ? new Date(d.lastTriggered).toLocaleString() : 'Never';
                html += `<tr><td style="padding:4px;">${escapeHtml(title)}</td><td style="text-align:center;padding:4px;">${d.matched || 0}</td><td style="text-align:center;padding:4px;">${d.injected || 0}</td><td style="text-align:center;padding:4px;">${lastUsed}</td></tr>`;
            }
            html += '</table>';

            // Dead entries: indexed but never injected
            const neverInjected = vaultIndex.filter(e => !analytics[e.title] || (analytics[e.title].injected || 0) === 0);
            if (neverInjected.length > 0) {
                html += '<hr><h4>Never Injected</h4><ul>';
                for (const e of neverInjected) {
                    html += `<li>${escapeHtml(e.title)} (${e.keys.length} keys, priority ${e.priority})</li>`;
                }
                html += '</ul>';
            }

            if (titles.length === 0 && neverInjected.length === 0) {
                html = '<p>No analytics data yet. Generate some messages first.</p>';
            }

            await callGenericPopup(html, POPUP_TYPE.TEXT, '', { wide: true, large: true, allowVerticalScrolling: true });
            return '';
        },
        helpString: 'Show entry usage analytics: how often each entry was matched and injected.',
        returns: 'Analytics popup',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'deeplore-health',
        callback: async () => {
            await ensureIndexFresh();
            if (vaultIndex.length === 0) {
                toastr.warning('No entries indexed.', 'DeepLore');
                return '';
            }

            const { issues } = runHealthCheck();

            let html;
            if (issues.length === 0) {
                html = '<p>No issues found! All entries look healthy.</p>';
            } else {
                const grouped = {};
                for (const issue of issues) {
                    if (!grouped[issue.type]) grouped[issue.type] = [];
                    grouped[issue.type].push(issue);
                }

                html = '';
                for (const [type, items] of Object.entries(grouped)) {
                    html += `<h4>${escapeHtml(type)} (${items.length})</h4><ul>`;
                    for (const item of items) {
                        html += `<li><strong>${escapeHtml(item.entry)}</strong>: ${escapeHtml(item.detail)}</li>`;
                    }
                    html += '</ul>';
                }
            }

            await callGenericPopup(html, POPUP_TYPE.TEXT, '', { wide: true, large: true, allowVerticalScrolling: true });
            return '';
        },
        helpString: 'Audit vault entries for common issues: empty keys, orphaned requires/excludes, oversized entries, duplicate keywords.',
        returns: 'Health check popup',
    }));
}
