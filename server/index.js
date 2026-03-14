const { obsidianRequest, encodeVaultPath, listAllFiles } = require('./core/obsidian');

const info = {
    id: 'deeplore',
    name: 'DeepLore',
    description: 'Proxies requests to Obsidian Local REST API for vault-based lorebook functionality',
};

async function init(router) {
    // Parse JSON bodies
    const express = require('express');
    router.use(express.json({ limit: '5mb' }));

    /**
     * POST /test - Test connection to Obsidian REST API
     */
    router.post('/test', async (req, res) => {
        try {
            const { port, apiKey } = req.body;

            if (!port) {
                return res.status(400).json({ error: 'Missing port' });
            }

            // The root endpoint / doesn't require auth and returns server info
            const result = await obsidianRequest({
                port,
                apiKey: apiKey || '',
                path: '/',
            });

            if (result.status === 200) {
                const serverInfo = JSON.parse(result.data);
                return res.json({
                    ok: true,
                    authenticated: serverInfo.authenticated || false,
                    versions: serverInfo.versions || {},
                });
            }

            return res.json({ ok: false, error: `HTTP ${result.status}` });
        } catch (err) {
            return res.json({ ok: false, error: err.message });
        }
    });

    /**
     * POST /files - List all files in the vault
     */
    router.post('/files', async (req, res) => {
        try {
            const { port, apiKey } = req.body;

            if (!port || !apiKey) {
                return res.status(400).json({ error: 'Missing port or apiKey' });
            }

            const files = await listAllFiles(port, apiKey);
            return res.json({ files });
        } catch (err) {
            return res.status(500).json({ error: err.message });
        }
    });

    /**
     * POST /file - Get a single file's content
     */
    router.post('/file', async (req, res) => {
        try {
            const { port, apiKey, filename } = req.body;

            if (!port || !apiKey || !filename) {
                return res.status(400).json({ error: 'Missing port, apiKey, or filename' });
            }

            if (filename.includes('..')) {
                return res.status(400).json({ error: 'Invalid filename: path traversal not allowed' });
            }

            const result = await obsidianRequest({
                port,
                apiKey,
                path: `/vault/${encodeVaultPath(filename)}`,
                accept: 'text/markdown',
            });

            if (result.status === 200) {
                return res.json({ content: result.data });
            }

            return res.status(result.status).json({ error: `HTTP ${result.status}` });
        } catch (err) {
            return res.status(500).json({ error: err.message });
        }
    });

    /**
     * POST /index - Fetch all .md files and return their contents
     * This is the main endpoint used by the client extension to build the vault index.
     */
    router.post('/index', async (req, res) => {
        try {
            const { port, apiKey } = req.body;

            if (!port || !apiKey) {
                return res.status(400).json({ error: 'Missing port or apiKey' });
            }

            // List all files
            const allFiles = await listAllFiles(port, apiKey);
            const mdFiles = allFiles.filter(f => f.endsWith('.md'));

            // Fetch content in parallel batches of 10
            const BATCH_SIZE = 10;
            const results = [];

            for (let i = 0; i < mdFiles.length; i += BATCH_SIZE) {
                const batch = mdFiles.slice(i, i + BATCH_SIZE);
                const batchResults = await Promise.all(
                    batch.map(async (filename) => {
                        try {
                            const result = await obsidianRequest({
                                port,
                                apiKey,
                                path: `/vault/${encodeVaultPath(filename)}`,
                                accept: 'text/markdown',
                            });
                            if (result.status === 200) {
                                return { filename, content: result.data };
                            }
                            return null;
                        } catch {
                            return null;
                        }
                    }),
                );
                results.push(...batchResults.filter(Boolean));
            }

            return res.json({ files: results, total: mdFiles.length });
        } catch (err) {
            return res.status(500).json({ error: err.message });
        }
    });

    console.log('[DeepLore] Server plugin initialized');
}

async function exit() {
    console.log('[DeepLore] Server plugin shutting down');
}

module.exports = { info, init, exit };
