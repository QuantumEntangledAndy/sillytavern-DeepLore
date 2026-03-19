/**
 * DeepLore Shared Core — Obsidian REST API Helpers (CommonJS)
 * This file is shared between DeepLore and DeepLore Enhanced.
 * The canonical source lives in the Enhanced repo.
 */

const http = require('node:http');

/**
 * Makes an HTTP request to the Obsidian Local REST API.
 * @param {object} options
 * @param {number} options.port - Obsidian REST API port
 * @param {string} options.apiKey - Bearer token
 * @param {string} options.path - API path (e.g. /vault/)
 * @param {string} [options.method='GET'] - HTTP method
 * @param {string} [options.accept='application/json'] - Accept header
 * @param {string|null} [options.body=null] - Request body
 * @param {string|null} [options.contentType=null] - Content-Type header
 * @returns {Promise<{status: number, data: string}>}
 */
function obsidianRequest({ port, apiKey, path, method = 'GET', accept = 'application/json', body = null, contentType = null }) {
    return new Promise((resolve, reject) => {
        const headers = {
            'Authorization': `Bearer ${apiKey}`,
            'Accept': accept,
        };

        if (body !== null && contentType) {
            headers['Content-Type'] = contentType;
            headers['Content-Length'] = Buffer.byteLength(body);
        }

        const req = http.request({
            hostname: '127.0.0.1',
            port: port,
            path: path,
            method: method,
            headers: headers,
            timeout: 30000,
        }, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                resolve({ status: res.statusCode, data: data });
            });
        });

        req.on('error', (err) => {
            reject(err);
        });

        req.on('timeout', () => {
            req.destroy();
            reject(new Error('Request timed out'));
        });

        if (body !== null) {
            req.write(body);
        }

        req.end();
    });
}

/**
 * Encode a vault path for use in the Obsidian REST API URL.
 * Encodes each path segment individually to preserve slashes.
 * @param {string} vaultPath - Path like "LA World/Characters/Alice.md"
 * @returns {string} URL-encoded path like "LA%20World/Characters/Alice.md"
 */
function encodeVaultPath(vaultPath) {
    return vaultPath.split('/').map(segment => encodeURIComponent(segment)).join('/');
}

/**
 * Recursively collects all file paths from the Obsidian vault directory listing.
 * The Obsidian REST API returns { files: [...] } where entries ending in / are directories.
 * Note: The API returns paths relative to the queried directory.
 * @param {number} port
 * @param {string} apiKey
 * @param {string} directory - Directory path (e.g. '' for root, 'LA World')
 * @param {number} [depth=0] - Current recursion depth
 * @returns {Promise<string[]>} Array of full file paths
 */
async function listAllFiles(port, apiKey, directory = '', depth = 0) {
    if (depth >= 20) {
        throw new Error(`Directory nesting too deep at "${directory}"`);
    }
    const urlPath = directory ? `/vault/${encodeVaultPath(directory)}/` : '/vault/';
    const res = await obsidianRequest({ port, apiKey, path: urlPath });

    if (res.status !== 200) {
        throw new Error(`Failed to list files at "${directory}": HTTP ${res.status}`);
    }

    let listing;
    try {
        listing = JSON.parse(res.data);
    } catch (e) {
        throw new Error(`Failed to parse directory listing for "${directory || '/'}": ${e.message}`);
    }
    const files = listing.files || [];
    const allFiles = [];
    const prefix = directory ? directory + '/' : '';

    for (const file of files) {
        if (file.endsWith('/')) {
            // It's a directory, recurse with the full path
            const dirName = file.slice(0, -1); // Remove trailing /
            const fullDirPath = prefix + dirName;
            const subFiles = await listAllFiles(port, apiKey, fullDirPath, depth + 1);
            allFiles.push(...subFiles);
        } else {
            allFiles.push(prefix + file);
        }
    }

    return allFiles;
}

module.exports = { obsidianRequest, encodeVaultPath, listAllFiles };
