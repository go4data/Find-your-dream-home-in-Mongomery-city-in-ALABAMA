/* ============================================================
   Bright Data Crawl API — Client-Side Wrapper (Dev/Single-user Mode)
   
   Graceful integration: works in demo mode without an API key.
   When no key is configured, all functions return mock responses
   and friendly messages — NEVER throws an error.
   ============================================================ */

const BrightData = (() => {
    // ---------- Constants ----------
    const STORAGE_KEY = 'settings.integrations.brightdata';
    const BASE_URL = 'https://api.brightdata.com/datasets/v3';
    const MAX_POLL_MINUTES = 15;
    const DIAGNOSTICS_MAX = 10;

    // ---------- State ----------
    let diagnosticsLog = [];
    let activeAbortController = null;

    // ---------- Config Helpers ----------
    function getConfig() {
        try {
            const stored = localStorage.getItem(STORAGE_KEY);
            return stored ? JSON.parse(stored) : {};
        } catch { return {}; }
    }

    function saveConfig(config) {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
            return true;
        } catch { return false; }
    }

    function clearConfig() {
        try {
            localStorage.removeItem(STORAGE_KEY);
            return true;
        } catch { return false; }
    }

    function hasApiKey() {
        const cfg = getConfig();
        return !!(cfg.apiKey && cfg.apiKey.trim());
    }

    function hasDatasetId() {
        const cfg = getConfig();
        return !!(cfg.datasetId && cfg.datasetId.trim());
    }

    // ---------- Diagnostics ----------
    function logDiagnostic(entry) {
        entry.timestamp = new Date().toISOString();
        diagnosticsLog.unshift(entry);
        if (diagnosticsLog.length > DIAGNOSTICS_MAX) diagnosticsLog.pop();
    }

    function getDiagnostics() {
        return [...diagnosticsLog];
    }

    // ---------- Demo / Mock Helpers ----------
    function demoResponse(method, endpoint, mockData, message) {
        const entry = {
            method, endpoint,
            status: 'demo',
            duration: '0ms',
            message: message || 'Demo mode — no API key configured.'
        };
        logDiagnostic(entry);
        console.info(`[BrightData Demo] ${method} ${endpoint}: ${message || 'No API key configured. Returning mock data.'}`);
        return {
            ok: false,
            demo: true,
            message: message || 'Configure your Bright Data API key in Settings to enable live crawling.',
            data: mockData
        };
    }

    // ---------- Real API Call ----------
    async function apiCall(method, path, body = null, queryParams = {}, signal = null) {
        const cfg = getConfig();
        const url = new URL(`${BASE_URL}${path}`);
        Object.entries(queryParams).forEach(([k, v]) => {
            if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
        });

        const startTime = performance.now();
        const options = {
            method,
            headers: {
                'Authorization': `Bearer ${cfg.apiKey}`,
                'Content-Type': 'application/json'
            }
        };
        if (body) options.body = JSON.stringify(body);
        if (signal) options.signal = signal;

        try {
            const resp = await fetch(url.toString(), options);
            const duration = Math.round(performance.now() - startTime);
            let data;
            const contentType = resp.headers.get('content-type') || '';
            if (contentType.includes('json')) {
                data = await resp.json();
            } else {
                data = await resp.text();
            }

            logDiagnostic({
                method, endpoint: path, status: resp.status,
                duration: `${duration}ms`, error: resp.ok ? null : data
            });

            return { ok: resp.ok, status: resp.status, data, demo: false };
        } catch (err) {
            const duration = Math.round(performance.now() - startTime);
            const errMsg = err.name === 'AbortError' ? 'Request cancelled' :
                           err.message.includes('Failed to fetch') ? 'Network error (possible CORS issue — consider using a server proxy).' :
                           err.message;
            logDiagnostic({
                method, endpoint: path, status: 'error',
                duration: `${duration}ms`, error: errMsg
            });
            return { ok: false, status: 'error', data: null, demo: false, message: errMsg };
        }
    }

    // ---------- Public API ----------

    /**
     * Trigger a crawl with a list of URLs.
     * Returns { snapshot_id } on success, or demo response if no key.
     */
    async function triggerCrawl(urls) {
        if (!hasApiKey()) {
            return demoResponse('POST', '/trigger', { snapshot_id: 'demo_snap_001' },
                'No API key configured. In live mode, this would start crawling your URLs.');
        }
        const cfg = getConfig();
        if (!cfg.datasetId) {
            return demoResponse('POST', '/trigger', null, 'Dataset ID is required. Please set it in Settings.');
        }

        const body = urls.map(u => ({ url: u.trim() })).filter(u => u.url);
        const params = {
            dataset_id: cfg.datasetId,
            include_errors: cfg.includeErrors !== false,
        };
        if (cfg.outputFields) params.custom_output_fields = cfg.outputFields;

        return apiCall('POST', '/trigger', body, params);
    }

    /**
     * Poll progress for a snapshot.
     */
    async function getProgress(snapshotId) {
        if (!hasApiKey()) {
            return demoResponse('GET', `/progress/${snapshotId}`, {
                snapshot_id: snapshotId, dataset_id: 'demo', status: 'ready'
            }, 'Demo mode — snapshot would be polled here.');
        }
        return apiCall('GET', `/progress/${snapshotId}`);
    }

    /**
     * Download snapshot data.
     */
    async function downloadSnapshot(snapshotId, opts = {}) {
        if (!hasApiKey()) {
            return demoResponse('GET', `/snapshot/${snapshotId}`, [
                { url: 'https://example.com', title: 'Demo Property', markdown: '# Demo\nThis is a test result.' }
            ], 'Demo mode — would download real crawl data here.');
        }
        const cfg = getConfig();
        const params = {
            format: opts.format || cfg.downloadFormat || 'json',
        };
        if (opts.compress || cfg.compress) params.compress = true;
        if (opts.batch_size || cfg.batchSize) params.batch_size = opts.batch_size || cfg.batchSize;
        if (opts.part) params.part = opts.part;

        return apiCall('GET', `/snapshot/${snapshotId}`, null, params);
    }

    /**
     * List snapshots for the configured dataset.
     */
    async function listSnapshots(filters = {}) {
        if (!hasApiKey()) {
            return demoResponse('GET', '/snapshots', [
                { snapshot_id: 'demo_snap_001', status: 'ready', created_at: new Date().toISOString() }
            ], 'Demo mode — would list real snapshots here.');
        }
        const cfg = getConfig();
        const params = { dataset_id: cfg.datasetId, ...filters };
        return apiCall('GET', '/snapshots', null, params);
    }

    /**
     * Cancel a running snapshot.
     */
    async function cancelSnapshot(snapshotId) {
        if (!hasApiKey()) {
            return demoResponse('POST', `/snapshot/${snapshotId}/cancel`, null, 'Demo mode — nothing to cancel.');
        }
        return apiCall('POST', `/snapshot/${snapshotId}/cancel`);
    }

    /**
     * Get snapshot parts info (for batched downloads).
     */
    async function getSnapshotParts(snapshotId) {
        if (!hasApiKey()) {
            return demoResponse('GET', `/snapshot/${snapshotId}/parts`, { parts: 1 }, 'Demo mode.');
        }
        return apiCall('GET', `/snapshot/${snapshotId}/parts`);
    }

    /**
     * Deliver a snapshot to an external destination (S3, GCS, webhook, etc.)
     */
    async function deliverSnapshot(snapshotId, deliveryConfig, notifyUrl = null) {
        if (!hasApiKey()) {
            return demoResponse('POST', `/deliver/${snapshotId}`, { delivery_id: 'demo_del_001' }, 'Demo mode — delivery not available.');
        }
        const params = {};
        if (notifyUrl) params.notify = notifyUrl;
        return apiCall('POST', `/deliver/${snapshotId}`, deliveryConfig, params);
    }

    /**
     * Monitor delivery status.
     */
    async function getDeliveryStatus(deliveryId) {
        if (!hasApiKey()) {
            return demoResponse('GET', `/delivery/${deliveryId}`, { status: 'completed' }, 'Demo mode.');
        }
        return apiCall('GET', `/delivery/${deliveryId}`);
    }

    /**
     * Test connection by listing snapshots (harmless endpoint).
     */
    async function testConnection() {
        if (!hasApiKey()) {
            return {
                ok: false, demo: true,
                message: 'No API key configured. Enter your key and click Test again.'
            };
        }
        const result = await listSnapshots({ limit: 1 });
        if (result.ok) {
            return { ok: true, demo: false, message: 'Connected successfully! API key and Dataset ID are valid.' };
        }
        return { ok: false, demo: false, message: `Connection failed: ${result.data?.message || result.message || 'Unknown error'}` };
    }

    /**
     * Poll progress with exponential backoff until ready/failed.
     * Returns the final status. Supports cancellation via AbortController.
     * @param {string} snapshotId
     * @param {function} onUpdate — called with status object on each poll
     * @returns {Promise<object>}
     */
    async function pollUntilDone(snapshotId, onUpdate) {
        activeAbortController = new AbortController();
        const signal = activeAbortController.signal;

        let delay = 1000; // start 1s
        const maxDelay = 10000;
        const maxTime = MAX_POLL_MINUTES * 60 * 1000;
        const start = Date.now();

        while (Date.now() - start < maxTime) {
            if (signal.aborted) {
                return { status: 'cancelled', message: 'Polling was cancelled.' };
            }

            const result = await getProgress(snapshotId);
            if (result.demo) {
                if (onUpdate) onUpdate({ status: 'ready', progress: 100 });
                return { status: 'ready', demo: true };
            }

            const status = result.data?.status;
            if (onUpdate) onUpdate(result.data);

            if (status === 'ready' || status === 'failed') {
                activeAbortController = null;
                return result.data;
            }

            // Wait with jitter
            const jitter = Math.random() * 500;
            await new Promise(r => {
                const timer = setTimeout(r, delay + jitter);
                signal.addEventListener('abort', () => { clearTimeout(timer); r(); }, { once: true });
            });

            delay = Math.min(delay * 2, maxDelay);
        }

        activeAbortController = null;
        return { status: 'timeout', message: `Polling timed out after ${MAX_POLL_MINUTES} minutes.` };
    }

    /**
     * Cancel active polling.
     */
    function cancelPolling() {
        if (activeAbortController) {
            activeAbortController.abort();
            activeAbortController = null;
        }
    }

    // ---------- Expose Public API ----------
    return {
        getConfig,
        saveConfig,
        clearConfig,
        hasApiKey,
        hasDatasetId,
        getDiagnostics,
        triggerCrawl,
        getProgress,
        downloadSnapshot,
        listSnapshots,
        cancelSnapshot,
        getSnapshotParts,
        deliverSnapshot,
        getDeliveryStatus,
        testConnection,
        pollUntilDone,
        cancelPolling
    };
})();
