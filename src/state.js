/**
 * DeepLore — Shared mutable state
 * All globals live here; modules import and read/write directly.
 */

/** @type {import('../core/pipeline.js').VaultEntry[]} */
export let vaultIndex = [];
export let indexTimestamp = 0;
export let indexing = false;
/** @type {Promise<void>|null} In-progress build promise for deduplication */
export let buildPromise = null;
/** Whether vault has ever successfully loaded */
export let indexEverLoaded = false;

/** Vault Sync: previous index snapshot for change detection */
export let previousIndexSnapshot = null;

/** Cooldown tracking: title -> remaining generations to skip */
export let cooldownTracker = new Map();

/** Generation counter (reset per chat) */
export let generationCount = 0;

/** Re-injection tracking: title -> generation number when last injected */
export let injectionHistory = new Map();

/** Vault Sync: polling interval ID */
export let syncIntervalId = null;

/** Track last warning ratio to avoid spamming toasts */
export let lastWarningRatio = 0;

// ── Setter functions ──
// ES modules export live bindings but `let` exports can only be reassigned
// from within the module that declared them. These setters allow other
// modules to update the state.

export function setVaultIndex(v) { vaultIndex = v; }
export function setIndexTimestamp(v) { indexTimestamp = v; }
export function setIndexing(v) { indexing = v; }
export function setBuildPromise(v) { buildPromise = v; }
export function setIndexEverLoaded(v) { indexEverLoaded = v; }
export function setPreviousIndexSnapshot(v) { previousIndexSnapshot = v; }
export function setCooldownTracker(v) { cooldownTracker = v; }
export function setGenerationCount(v) { generationCount = v; }
export function setInjectionHistory(v) { injectionHistory = v; }
export function setSyncIntervalId(v) { syncIntervalId = v; }
export function setLastWarningRatio(v) { lastWarningRatio = v; }
