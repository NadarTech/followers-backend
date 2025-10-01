// utils/proxyClient.js
const axios = require("axios");
const { HttpsProxyAgent } = require("https-proxy-agent");
const Bottleneck = require("bottleneck");
const crypto = require("crypto");

const proxyList = (process.env.PROXIES || "")
    .split(",")
    .map(p => p.trim())
    .filter(Boolean);

const state = proxyList.map(url => ({
    url,
    errorCount: 0,
    pausedUntil: 0,
}));

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

const userAgents = [
    "Instagram 293.0.0.36.101 Android",
    "Instagram 289.0.0.77.109 Android",
    "Instagram 250.0.0.21.109 iOS",
    "Instagram 260.0.0.19.109 Android",
    "Instagram 280.0.0.21.111 iOS"
];

function getRandomUA() {
    return userAgents[Math.floor(Math.random() * userAgents.length)];
}

// DEÄžÄ°ÅžTÄ°: 3000'den 10000'e Ã§Ä±karÄ±ldÄ±
// Instagram "wait a few minutes" diyordu, Ã§ok hÄ±zlÄ± buluyordu
const limiters = proxyList.map(() => new Bottleneck({
    minTime: parseInt(process.env.PROXY_MIN_TIME || "10000", 10),
    maxConcurrent: parseInt(process.env.PROXY_MAX_CONCURRENCY || "1", 10),
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
        console.warn(`Proxy ${state[idx].url} cooldowna alÄ±ndÄ±.`);
    }
}

function markSuccess(idx) {
    if (idx < 0) return;
    state[idx].errorCount = 0;
}

function buildRotatingProxyUrl(proxyUrl) {
    const sessionId = crypto.randomBytes(6).toString("hex");
    if (proxyUrl.includes("?")) {
        return `${proxyUrl}&session=${sessionId}`;
    }
    return `${proxyUrl}/?session=${sessionId}`;
}

// YENÄ° FONKSÄ°YON: 401 geldiÄŸinde tÃ¼m proxy'leri dene
// Eski kod sadece 1 alternatif deniyordu
async function tryAllProxies(url, options, userId, startIdx) {
    const triedIndexes = new Set();
    let lastError;

    for (let i = 0; i < proxyList.length; i++) {
        const idx = (startIdx + i) % proxyList.length;
        
        if (triedIndexes.has(idx)) continue;
        triedIndexes.add(idx);

        const proxyUrl = state[idx].url;
        
        if (state[idx].pausedUntil > Date.now()) {
            console.log(`â­Proxy ${idx} cooldown'da, atlanÄ±yor...`);
            continue;
        }

        try {
            console.log(`Proxy ${idx} deneniyor... (${i + 1}/${proxyList.length})`);
            
            const rotatingProxy = buildRotatingProxyUrl(proxyUrl);
            const agent = new HttpsProxyAgent(rotatingProxy);

            const resp = await axios.get(url, {
                ...options,
                headers: {
                    ...(options.headers || {}),
                    "User-Agent": getRandomUA(),
                },
                httpsAgent: agent,
                proxy: false,
                timeout: 45000,
            });

            markSuccess(idx);
            console.log(`Proxy ${idx} baÅŸarÄ±lÄ±!`);
            return resp;

        } catch (err) {
            lastError = err;
            console.warn(`Proxy ${idx} baÅŸarÄ±sÄ±z: ${err.message}`);
            
            // 401 dÄ±ÅŸÄ±ndaki hatalar iÃ§in proxy'yi cezalandÄ±r
            if (err.response?.status !== 401) {
                markError(idx);
            }
        }

        await delay(2000);
    }

    throw lastError;
}

async function axiosGetWithProxy(url, options, userId, retries = 3) {
    if (!proxyList.length) return axios.get(url, options);

    const { idx, proxyUrl } = pickProxy(userId);
    const limiter = limiters[idx];

    return limiter.schedule(async () => {
        for (let attempt = 1; attempt <= retries; attempt++) {
            try {
                const rotatingProxy = buildRotatingProxyUrl(proxyUrl);
                const agent = new HttpsProxyAgent(rotatingProxy);

                const resp = await axios.get(url, {
                    ...options,
                    headers: {
                        ...(options.headers || {}),
                        "User-Agent": getRandomUA(),
                    },
                    httpsAgent: agent,
                    proxy: false,
                    timeout: 45000,
                });

                markSuccess(idx);
                
                // Ä°nsan gibi davranmak iÃ§in 2-5 saniye random bekle
                const humanDelay = 2000 + Math.floor(Math.random() * 3000);
                await delay(humanDelay);
                
                return resp;

            } catch (err) {
                const status = err.response?.status;
                const errorData = err.response?.data;

                console.warn(
                    `Proxy hata [${attempt}/${retries}] userId=${userId} status=${status}: ${err.message}`
                );

                // DEÄžÄ°ÅžTÄ°: 401 yÃ¶netimi tamamen yeniden yazÄ±ldÄ±
                if (status === 401) {
                    console.warn(`401 Unauthorized! Instagram: "${errorData?.message}"`);

                    // "wait a few minutes" mesajÄ± varsa 60 saniye bekle
                    if (errorData?.message?.includes("wait a few minutes")) {
                        console.warn("Instagram rate limit! 60 saniye bekleniyor...");
                        await delay(60000);
                    }

                    // TÃ¼m proxy'leri dene
                    console.log("TÃ¼m proxy'ler deneniyor...");
                    try {
                        const resp = await tryAllProxies(url, options, userId, idx);
                        return resp;
                    } catch (allProxiesErr) {
                        console.error("TÃ¼m proxy'ler 401 verdi!");
                        
                        if (attempt < retries) {
                            console.log(`â³ 30 saniye bekleyip tekrar deneniyor...`);
                            await delay(30000);
                            continue;
                        }
                        
                        throw allProxiesErr;
                    }
                }

                // 429 rate limit
                if (status === 429) {
                    console.warn("429 Rate Limit! 2 dakika bekleniyor...");
                    await delay(120000);
                    continue;
                }

                markError(idx);

                if (attempt === retries) {
                    throw err;
                }

                // Exponential backoff
                const backoffTime = 2000 * Math.pow(2, attempt - 1);
                console.log(`${backoffTime / 1000} saniye bekleyip tekrar deneniyor...`);
                await delay(backoffTime);
            }
        }
    });
}

module.exports = { axiosGetWithProxy };