// utils/proxyClient.js
const axios = require("axios");
const { HttpsProxyAgent } = require("https-proxy-agent");
const Bottleneck = require("bottleneck");
const crypto = require("crypto");

// .env üzerinden proxy listesi
// Örn: PROXIES=http://user:pass@1.2.3.4:8000,http://user:pass@5.6.7.8:8000
const proxyList = (process.env.PROXIES || "")
    .split(",")
    .map(p => p.trim())
    .filter(Boolean);

const state = proxyList.map(url => ({
    url,
    errorCount: 0,
    pausedUntil: 0,
}));

const limiters = proxyList.map(() => new Bottleneck({
    minTime: parseInt(process.env.PROXY_MIN_TIME || "3000", 10),
    maxConcurrent: parseInt(process.env.PROXY_MAX_CONCURRENCY || "2", 10),
}));

const ERROR_THRESHOLD = parseInt(process.env.PROXY_ERROR_THRESHOLD || "4", 10);
const COOLDOWN_MS = parseInt(process.env.PROXY_COOLDOWN_MS || (15 * 60 * 1000), 10);

function hashToIndex(key, mod) {
    const h = crypto.createHash("md5").update(String(key)).digest("hex");
    const num = parseInt(h.slice(0, 8), 16);
    return num % mod;
}

function pickProxy(userId) {
    if (!proxyList.length) return { idx: -1, proxyUrl: null };
    const startIdx = hashToIndex(userId, proxyList.length);
    const now = Date.now();
    for (let i = 0; i < proxyList.length; i++) {
        const idx = (startIdx + i) % proxyList.length;
        if (!state[idx].pausedUntil || state[idx].pausedUntil <= now) {
            return { idx, proxyUrl: state[idx].url };
        }
    }
    return { idx: startIdx, proxyUrl: state[startIdx].url };
}

function markError(idx) {
    if (idx < 0) return;
    state[idx].errorCount++;
    if (state[idx].errorCount >= ERROR_THRESHOLD) {
        state[idx].pausedUntil = Date.now() + COOLDOWN_MS;
        state[idx].errorCount = 0;
        console.warn(`⚠️ Proxy ${state[idx].url} cooldowna alındı.`);
    }
}

function markSuccess(idx) {
    if (idx < 0) return;
    state[idx].errorCount = 0;
}

async function axiosGetWithProxy(url, options, userId, retries = 3) {
    if (!proxyList.length) return axios.get(url, options);

    const { idx, proxyUrl } = pickProxy(userId);
    const limiter = limiters[idx];
    const jitter = Math.floor(Math.random() * 800);

    return limiter.schedule(async () => {
        for (let attempt = 1; attempt <= retries; attempt++) {
            try {
                const agent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;
                const resp = await axios.get(url, {
                    ...options,
                    httpsAgent: agent,
                    timeout: 45000, // biraz arttırdım
                });
                markSuccess(idx);
                // küçük jitter
                if (jitter) await new Promise(r => setTimeout(r, jitter));
                return resp;
            } catch (err) {
                markError(idx);
                console.warn(`❌ Proxy hata [${attempt}/${retries}] userId=${userId} proxy=${proxyUrl}: ${err.message}`);
                if (attempt === retries) throw err;
                // retry öncesi kısa bekleme
                await new Promise(r => setTimeout(r, 2000 * attempt));
            }
        }
    });
}


module.exports = { axiosGetWithProxy };
