/**
 * DeepLore — Popup modules
 * showBrowsePopup, runSimulation, showSimulationPopup, showGraphPopup
 */
import { escapeHtml } from '../../../utils.js';
import { callGenericPopup, POPUP_TYPE } from '../../../popup.js';
import { simpleHash, buildScanText } from '../core/utils.js';
import { testEntryMatch } from '../core/matching.js';
import { getSettings } from '../settings.js';
import { vaultIndex } from './state.js';
import { ensureIndexFresh } from './vault.js';

/**
 * Build an obsidian:// URI to open a note in Obsidian.
 * @param {string} vaultName - Name of the Obsidian vault
 * @param {string} filename - File path within the vault
 * @returns {string|null} URI string, or null if vault name not configured
 */
export function buildObsidianURI(vaultName, filename) {
    if (!vaultName) return null;
    const encodedVault = encodeURIComponent(vaultName);
    const encodedFile = filename.split('/').map(s => encodeURIComponent(s)).join('/');
    return `obsidian://open?vault=${encodedVault}&file=${encodedFile}`;
}

/**
 * Show a searchable, filterable popup of all indexed vault entries.
 */
export async function showBrowsePopup() {
    await ensureIndexFresh();
    if (vaultIndex.length === 0) {
        toastr.warning('No entries indexed.', 'DeepLore');
        return;
    }

    const settings = getSettings();
    const analytics = settings.analyticsData || {};
    const allTags = [...new Set(vaultIndex.flatMap(e => e.tags))].sort();

    const container = document.createElement('div');
    container.style.textAlign = 'left';
    container.innerHTML = `
        <h3>Entry Browser (${vaultIndex.length} entries)</h3>
        <div style="display: flex; gap: 8px; margin-bottom: 10px; flex-wrap: wrap;">
            <input id="deeplore_browse_search" type="text" class="text_pole" placeholder="Search titles, keywords, content..." style="flex: 2; min-width: 200px;" />
            <select id="deeplore_browse_status" class="text_pole" style="flex: 1; min-width: 120px;">
                <option value="all">All Status</option>
                <option value="constant">Constants</option>
                <option value="seed">Seeds</option>
                <option value="bootstrap">Bootstrap</option>
                <option value="regular">Regular</option>
            </select>
            <select id="deeplore_browse_tag" class="text_pole" style="flex: 1; min-width: 120px;">
                <option value="">All Tags</option>
                ${allTags.map(t => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join('')}
            </select>
        </div>
        <div id="deeplore_browse_list" style="max-height: 60vh; overflow-y: auto;"></div>
        <small id="deeplore_browse_count" style="opacity: 0.6;"></small>
    `;

    function renderList() {
        const searchEl = container.querySelector('#deeplore_browse_search');
        const statusEl = container.querySelector('#deeplore_browse_status');
        const tagEl = container.querySelector('#deeplore_browse_tag');
        const listEl = container.querySelector('#deeplore_browse_list');
        const countEl = container.querySelector('#deeplore_browse_count');

        const search = (searchEl?.value || '').toLowerCase();
        const status = statusEl?.value || 'all';
        const tag = tagEl?.value || '';

        let filtered = vaultIndex.filter(e => {
            if (status === 'constant' && !e.constant) return false;
            if (status === 'seed' && !e.seed) return false;
            if (status === 'bootstrap' && !e.bootstrap) return false;
            if (status === 'regular' && (e.constant || e.seed || e.bootstrap)) return false;
            if (tag && !e.tags.includes(tag)) return false;
            if (search) {
                const haystack = `${e.title} ${e.keys.join(' ')} ${e.content}`.toLowerCase();
                if (!haystack.includes(search)) return false;
            }
            return true;
        });

        filtered.sort((a, b) => a.priority - b.priority);
        countEl.textContent = `Showing ${filtered.length} of ${vaultIndex.length} entries`;

        let html = '';
        for (const entry of filtered) {
            const statusBadges = [];
            if (entry.constant) statusBadges.push('<span style="color: #4caf50; font-size: 0.8em;">[constant]</span>');
            if (entry.seed) statusBadges.push('<span style="color: #2196f3; font-size: 0.8em;">[seed]</span>');
            if (entry.bootstrap) statusBadges.push('<span style="color: #ff9800; font-size: 0.8em;">[bootstrap]</span>');

            const keysDisplay = entry.keys.slice(0, 5).map(k => escapeHtml(k)).join(', ') + (entry.keys.length > 5 ? '...' : '');
            const a = analytics[entry.title];
            const usageStr = a ? `matched: ${a.matched || 0}, injected: ${a.injected || 0}` : 'never used';
            const entryId = simpleHash(entry.filename);

            const obsidianUri = buildObsidianURI(settings.obsidianVaultName, entry.filename);
            const obsidianLink = obsidianUri
                ? ` <a href="${escapeHtml(obsidianUri)}" target="_blank" style="font-size: 0.8em; opacity: 0.7;">Open in Obsidian</a>`
                : '';

            html += `<div style="border: 1px solid var(--SmartThemeBorderColor, #444); border-radius: 4px; padding: 8px; margin-bottom: 4px;">`;
            html += `<div style="display: flex; justify-content: space-between; align-items: center; cursor: pointer;" onclick="document.getElementById('deeplore_entry_${entryId}').style.display = document.getElementById('deeplore_entry_${entryId}').style.display === 'none' ? 'block' : 'none'">`;
            html += `<strong>${escapeHtml(entry.title)}</strong> ${statusBadges.join(' ')}`;
            html += `<span style="opacity: 0.6; font-size: 0.85em;">pri ${entry.priority} · ~${entry.tokenEstimate}tok · ${usageStr}</span>`;
            html += `</div>`;
            html += `<div style="font-size: 0.8em; opacity: 0.7;">${keysDisplay || '<em>no keywords</em>'}</div>`;
            html += `<div id="deeplore_entry_${entryId}" style="display: none; margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--SmartThemeBorderColor, #333);">`;
            html += `<div style="white-space: pre-wrap; font-size: 0.85em; max-height: 300px; overflow-y: auto; background: var(--SmartThemeBlurTintColor, #1a1a2e); padding: 8px; border-radius: 4px;">${escapeHtml(entry.content)}</div>`;
            html += `<div style="margin-top: 6px; font-size: 0.8em; opacity: 0.7;">`;
            html += `Links: ${entry.resolvedLinks.length > 0 ? entry.resolvedLinks.map(l => escapeHtml(l)).join(', ') : 'none'}`;
            html += ` · Tags: ${entry.tags.length > 0 ? entry.tags.map(t => escapeHtml(t)).join(', ') : 'none'}`;
            if (entry.requires.length > 0) html += ` · Requires: ${entry.requires.map(r => escapeHtml(r)).join(', ')}`;
            if (entry.excludes.length > 0) html += ` · Excludes: ${entry.excludes.map(r => escapeHtml(r)).join(', ')}`;
            if (entry.probability != null) html += ` · Probability: ${entry.probability}`;
            html += obsidianLink;
            html += `</div></div></div>`;
        }
        listEl.innerHTML = html || '<p style="opacity: 0.5;">No entries match filters.</p>';
    }

    await callGenericPopup(container, POPUP_TYPE.TEXT, '', {
        wide: true,
        large: true,
        allowVerticalScrolling: true,
        onOpen: async () => {
            renderList();
            container.querySelector('#deeplore_browse_search')?.addEventListener('input', renderList);
            container.querySelector('#deeplore_browse_status')?.addEventListener('change', renderList);
            container.querySelector('#deeplore_browse_tag')?.addEventListener('change', renderList);
        },
    });
}

/**
 * Replay chat history step-by-step, running keyword matching at each message.
 * @param {object[]} chatMsgs
 * @returns {Array<{messageIndex: number, speaker: string, active: string[], newlyActivated: string[], deactivated: string[]}>}
 */
export function runSimulation(chatMsgs) {
    const settings = getSettings();
    const timeline = [];
    let previousActive = new Set();

    for (let i = 1; i <= chatMsgs.length; i++) {
        const slicedChat = chatMsgs.slice(0, i);
        const scanText = buildScanText(slicedChat, settings.scanDepth);
        const currentActive = new Set();

        // Always include constants
        for (const entry of vaultIndex) {
            if (entry.constant) currentActive.add(entry.title);
        }

        // Bootstrap
        if (i <= settings.newChatThreshold) {
            for (const entry of vaultIndex) {
                if (entry.bootstrap) currentActive.add(entry.title);
            }
        }

        // Keyword matching (skip probability/warmup/cooldown for clean simulation)
        if (settings.scanDepth > 0) {
            for (const entry of vaultIndex) {
                if (entry.constant) continue;
                const entryText = entry.scanDepth !== null
                    ? buildScanText(slicedChat, entry.scanDepth)
                    : scanText;
                const key = testEntryMatch(entry, entryText, settings);
                if (key) currentActive.add(entry.title);
            }
        }

        const newlyActivated = [...currentActive].filter(t => !previousActive.has(t));
        const deactivated = [...previousActive].filter(t => !currentActive.has(t));

        const msg = chatMsgs[i - 1];
        timeline.push({
            messageIndex: i - 1,
            speaker: msg.is_user ? 'User' : (msg.name || 'AI'),
            active: [...currentActive],
            newlyActivated,
            deactivated,
        });

        previousActive = currentActive;
    }

    return timeline;
}

/**
 * Show simulation results in a scrollable timeline popup.
 */
export function showSimulationPopup(timeline) {
    let html = '<div style="text-align: left;">';
    html += `<h3>Activation Simulation (${timeline.length} messages)</h3>`;
    html += '<div style="max-height: 60vh; overflow-y: auto;">';

    for (const step of timeline) {
        const hasChanges = step.newlyActivated.length > 0 || step.deactivated.length > 0;
        const borderColor = hasChanges ? 'var(--SmartThemeQuoteColor, #4caf50)' : 'var(--SmartThemeBorderColor, #444)';

        html += `<div style="border-left: 3px solid ${borderColor}; padding: 4px 8px; margin-bottom: 2px; font-size: 0.85em;">`;
        html += `<strong>#${step.messageIndex + 1} ${escapeHtml(step.speaker)}</strong>`;
        html += ` <small style="opacity: 0.6;">(${step.active.length} active)</small>`;

        if (step.newlyActivated.length > 0) {
            html += `<br><span style="color: #4caf50;">+ ${step.newlyActivated.map(t => escapeHtml(t)).join(', ')}</span>`;
        }
        if (step.deactivated.length > 0) {
            html += `<br><span style="color: #f44336;">- ${step.deactivated.map(t => escapeHtml(t)).join(', ')}</span>`;
        }
        html += '</div>';
    }

    html += '</div></div>';
    callGenericPopup(html, POPUP_TYPE.TEXT, '', { wide: true, large: true, allowVerticalScrolling: true });
}

/**
 * Show an interactive force-directed graph of entry relationships.
 */
export async function showGraphPopup() {
    await ensureIndexFresh();
    if (vaultIndex.length === 0) {
        toastr.warning('No entries indexed.', 'DeepLore');
        return;
    }

    // Build node and edge data
    const nodes = vaultIndex.map((e, i) => ({
        id: i,
        title: e.title,
        type: e.constant ? 'constant' : e.seed ? 'seed' : e.bootstrap ? 'bootstrap' : 'regular',
        tokens: e.tokenEstimate,
        x: Math.random() * 800 - 400,
        y: Math.random() * 600 - 300,
        vx: 0, vy: 0,
    }));

    const titleToIdx = new Map(vaultIndex.map((e, i) => [e.title.toLowerCase(), i]));
    const edges = [];

    for (let i = 0; i < vaultIndex.length; i++) {
        const entry = vaultIndex[i];
        for (const link of entry.resolvedLinks) {
            const j = titleToIdx.get(link.toLowerCase());
            if (j !== undefined && j !== i) {
                edges.push({ from: i, to: j, type: 'link' });
            }
        }
        for (const req of entry.requires) {
            const j = titleToIdx.get(req.toLowerCase());
            if (j !== undefined && j !== i) {
                edges.push({ from: i, to: j, type: 'requires' });
            }
        }
        for (const ex of entry.excludes) {
            const j = titleToIdx.get(ex.toLowerCase());
            if (j !== undefined && j !== i) {
                edges.push({ from: i, to: j, type: 'excludes' });
            }
        }
        for (const cl of (entry.cascadeLinks || [])) {
            const j = titleToIdx.get(cl.toLowerCase());
            if (j !== undefined && j !== i) {
                edges.push({ from: i, to: j, type: 'cascade' });
            }
        }
    }

    // Detect circular requires
    const circularPairs = [];
    for (const edge of edges) {
        if (edge.type === 'requires') {
            const reverse = edges.find(e => e.type === 'requires' && e.from === edge.to && e.to === edge.from);
            if (reverse) {
                const key = [Math.min(edge.from, edge.to), Math.max(edge.from, edge.to)].join(',');
                if (!circularPairs.some(p => p === key)) circularPairs.push(key);
            }
        }
    }

    const container = document.createElement('div');
    container.style.textAlign = 'left';
    const circularWarning = circularPairs.length > 0
        ? `<p style="color: #f44336; font-size: 0.85em;">${circularPairs.length} circular require pair(s) detected</p>`
        : '';
    container.innerHTML = `
        <h3>Entry Relationship Graph (${nodes.length} nodes, ${edges.length} edges)</h3>
        ${circularWarning}
        <div style="display: flex; gap: 10px; margin-bottom: 8px; font-size: 0.8em; flex-wrap: wrap;">
            <span><span style="color: #4caf50;">&#9679;</span> Regular</span>
            <span><span style="color: #ff9800;">&#9679;</span> Constant</span>
            <span><span style="color: #2196f3;">&#9679;</span> Seed</span>
            <span><span style="color: #9c27b0;">&#9679;</span> Bootstrap</span>
            <span style="opacity: 0.7;">&#8212;</span>
            <span><span style="color: #aac8ff;">&#8212;</span> Link</span>
            <span><span style="color: #4caf50;">&#8212;</span> Requires</span>
            <span><span style="color: #f44336;">&#8212;</span> Excludes</span>
            <span><span style="color: #ff9800;">&#8212;</span> Cascade</span>
        </div>
        <canvas id="deeplore_graph_canvas" width="900" height="600" style="border: 1px solid var(--SmartThemeBorderColor, #444); border-radius: 4px; cursor: grab; width: 100%; background: var(--SmartThemeBlurTintColor, #0d0d1a);"></canvas>
        <small style="opacity: 0.5;">Drag nodes to reposition. Scroll to zoom. Hover a node to see info.</small>
    `;

    callGenericPopup(container, POPUP_TYPE.TEXT, '', { wide: true, large: true, allowVerticalScrolling: false });

    // Wait for canvas to be in DOM
    await new Promise(r => setTimeout(r, 100));
    const canvas = document.getElementById('deeplore_graph_canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * (window.devicePixelRatio || 1);
    canvas.height = rect.height * (window.devicePixelRatio || 1);
    ctx.scale(window.devicePixelRatio || 1, window.devicePixelRatio || 1);
    const W = rect.width;
    const H = rect.height;

    for (const n of nodes) {
        n.x = (Math.random() - 0.5) * W * 0.8;
        n.y = (Math.random() - 0.5) * H * 0.8;
    }

    let panX = W / 2, panY = H / 2, zoom = 1;
    let dragNode = null, hoverNode = null;
    let isRunning = true;

    const nodeColors = { constant: '#ff9800', seed: '#2196f3', bootstrap: '#9c27b0', regular: '#4caf50' };
    const edgeColors = { link: '#aac8ff', requires: '#4caf50', excludes: '#f44336', cascade: '#ff9800' };

    function toScreen(x, y) { return { x: x * zoom + panX, y: y * zoom + panY }; }
    function toWorld(sx, sy) { return { x: (sx - panX) / zoom, y: (sy - panY) / zoom }; }

    function simulate() {
        const k = 0.01, repulsion = 5000, damping = 0.85, gravity = 0.02;
        for (let i = 0; i < nodes.length; i++) {
            for (let j = i + 1; j < nodes.length; j++) {
                let dx = nodes[j].x - nodes[i].x;
                let dy = nodes[j].y - nodes[i].y;
                const dist = Math.sqrt(dx * dx + dy * dy) || 1;
                const force = repulsion / (dist * dist);
                const fx = (dx / dist) * force;
                const fy = (dy / dist) * force;
                nodes[i].vx -= fx; nodes[i].vy -= fy;
                nodes[j].vx += fx; nodes[j].vy += fy;
            }
        }
        for (const edge of edges) {
            const a = nodes[edge.from], b = nodes[edge.to];
            const dx = b.x - a.x, dy = b.y - a.y;
            const dist = Math.sqrt(dx * dx + dy * dy) || 1;
            const force = k * (dist - 100);
            const fx = (dx / dist) * force;
            const fy = (dy / dist) * force;
            a.vx += fx; a.vy += fy;
            b.vx -= fx; b.vy -= fy;
        }
        for (const n of nodes) {
            n.vx -= n.x * gravity;
            n.vy -= n.y * gravity;
        }
        for (const n of nodes) {
            if (n === dragNode) continue;
            n.vx *= damping; n.vy *= damping;
            n.x += n.vx; n.y += n.vy;
        }
    }

    function draw() {
        ctx.clearRect(0, 0, W, H);
        ctx.lineWidth = 1;
        for (const edge of edges) {
            const a = toScreen(nodes[edge.from].x, nodes[edge.from].y);
            const b = toScreen(nodes[edge.to].x, nodes[edge.to].y);
            ctx.strokeStyle = edgeColors[edge.type] || '#555';
            ctx.globalAlpha = 0.4;
            if (edge.type === 'excludes') { ctx.setLineDash([4, 4]); } else { ctx.setLineDash([]); }
            ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
        }
        ctx.setLineDash([]); ctx.globalAlpha = 1;
        for (const n of nodes) {
            const s = toScreen(n.x, n.y);
            const r = Math.max(4, Math.min(12, Math.sqrt(n.tokens / 10)));
            ctx.fillStyle = n === hoverNode ? '#ffffff' : (nodeColors[n.type] || '#4caf50');
            ctx.beginPath(); ctx.arc(s.x, s.y, r * zoom, 0, Math.PI * 2); ctx.fill();
        }
        ctx.fillStyle = '#ddd'; ctx.font = `${Math.max(9, 11 * zoom)}px monospace`; ctx.textAlign = 'center';
        for (const n of nodes) {
            const s = toScreen(n.x, n.y);
            if (n === hoverNode || zoom > 1.5 || nodes.length < 30) {
                ctx.fillText(n.title, s.x, s.y - 10 * zoom);
            }
        }
        if (hoverNode) {
            const s = toScreen(hoverNode.x, hoverNode.y);
            const entry = vaultIndex[hoverNode.id];
            const info = `${hoverNode.title} (~${hoverNode.tokens} tok, pri ${entry.priority})`;
            const connections = edges.filter(e => e.from === hoverNode.id || e.to === hoverNode.id).length;
            const tooltip = `${info} — ${connections} connection(s)`;
            ctx.fillStyle = 'rgba(0,0,0,0.8)';
            const tw = ctx.measureText(tooltip).width + 12;
            ctx.fillRect(s.x - tw / 2, s.y + 14 * zoom, tw, 18);
            ctx.fillStyle = '#fff'; ctx.fillText(tooltip, s.x, s.y + 27 * zoom);
        }
    }

    function tick() {
        if (!isRunning) return;
        if (!document.getElementById('deeplore_graph_canvas')) { isRunning = false; return; }
        simulate(); draw(); requestAnimationFrame(tick);
    }

    canvas.addEventListener('mousedown', (e) => {
        const rect = canvas.getBoundingClientRect();
        const mx = e.clientX - rect.left, my = e.clientY - rect.top;
        const w = toWorld(mx, my);
        let closest = null, closestDist = 20 / zoom;
        for (const n of nodes) {
            const d = Math.sqrt((n.x - w.x) ** 2 + (n.y - w.y) ** 2);
            if (d < closestDist) { closest = n; closestDist = d; }
        }
        if (closest) { dragNode = closest; canvas.style.cursor = 'grabbing'; }
    });
    canvas.addEventListener('mousemove', (e) => {
        const rect = canvas.getBoundingClientRect();
        const mx = e.clientX - rect.left, my = e.clientY - rect.top;
        if (dragNode) {
            const w = toWorld(mx, my); dragNode.x = w.x; dragNode.y = w.y; dragNode.vx = 0; dragNode.vy = 0;
        } else {
            const w = toWorld(mx, my);
            let closest = null, closestDist = 15 / zoom;
            for (const n of nodes) {
                const d = Math.sqrt((n.x - w.x) ** 2 + (n.y - w.y) ** 2);
                if (d < closestDist) { closest = n; closestDist = d; }
            }
            hoverNode = closest;
            canvas.style.cursor = closest ? 'pointer' : 'grab';
        }
    });
    canvas.addEventListener('mouseup', () => { dragNode = null; canvas.style.cursor = 'grab'; });
    canvas.addEventListener('wheel', (e) => {
        e.preventDefault();
        const zoomFactor = e.deltaY < 0 ? 1.1 : 0.9;
        const rect = canvas.getBoundingClientRect();
        const mx = e.clientX - rect.left, my = e.clientY - rect.top;
        panX = mx - (mx - panX) * zoomFactor; panY = my - (my - panY) * zoomFactor;
        zoom *= zoomFactor; zoom = Math.max(0.2, Math.min(5, zoom));
    }, { passive: false });
    tick();
}
