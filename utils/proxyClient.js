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

// UA havuzu
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

const limiters = proxyList.map(() => new Bottleneck({
    minTime: parseInt(process.env.PROXY_MIN_TIME || "3000", 10),
    maxConcurrent: parseInt(process.env.PROXY_MAX_CONCURRENCY || "1", 10), // tek tek gitsin
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

function buildRotatingProxyUrl(proxyUrl) {
    // Sticky session yerine her request için random session üretelim
    const sessionId = crypto.randomBytes(6).toString("hex");
    if (proxyUrl.includes("?")) {
        return `${proxyUrl}&session=${sessionId}`;
    }
    return `${proxyUrl}/?session=${sessionId}`;
}

function buildRotatingProxyUrl(proxyUrl) {
    const sessionId = crypto.randomBytes(6).toString("hex");
    if (proxyUrl.includes("?")) {
        return `${proxyUrl}&session=${sessionId}`;
    }
    return `${proxyUrl}/?session=${sessionId}`;
}

async function axiosGetWithProxy(url, options, userId, retries = 3) {
    if (!proxyList.length) return axios.get(url, options);

    const { idx, proxyUrl } = pickProxy(userId);
    const limiter = limiters[idx];
    const jitter = 500 + Math.floor(Math.random() * 1500);

    return limiter.schedule(async () => {
        for (let attempt = 1; attempt <= retries; attempt++) {
            try {
                const rotatingProxy = buildRotatingProxyUrl(proxyUrl);
                const agent = new HttpsProxyAgent(rotatingProxy);

                const resp = await axios.get(url, {
                    ...options,
                    headers: {
                        ...(options.headers || {}),
                        "User-Agent": getRandomUA(), // 🔹 random UA
                    },
                    httpsAgent: agent,
                    proxy: false,
                    timeout: 45000,
                });

                markSuccess(idx);
                await delay(2000);
                return resp;
            } catch (err) {
                markError(idx);
                console.warn(
                    `❌ Proxy hata [${attempt}/${retries}] userId=${userId} proxy=${proxyUrl}: ${err.message} ${JSON.stringify(err.response?.data)}`
                );

                // 🔹 Eğer 401 gelirse, farklı proxy dene
                if (err.response && err.response.status === 401 && proxyList.length > 1) {
                    console.warn("🔄 401 alındı, başka proxy ile tekrar deneniyor...");
                    const altIdx = (idx + 1) % proxyList.length;
                    const altProxy = buildRotatingProxyUrl(proxyList[altIdx]);
                    const altAgent = new HttpsProxyAgent(altProxy);

                    try {
                        const resp = await axios.get(url, {
                            ...options,
                            headers: {
                                ...(options.headers || {}),
                                "User-Agent": getRandomUA(),
                            },
                            httpsAgent: altAgent,
                            proxy: false,
                            timeout: 45000,
                        });
                        markSuccess(altIdx);
                        return resp;
                    } catch (innerErr) {
                        console.error("❌ Alternatif proxy de hata verdi:", innerErr.message);
                    }
                }

                if (attempt === retries) throw err;
                await new Promise(r => setTimeout(r, 2000 * attempt));
            }
        }
    });
}


module.exports = { axiosGetWithProxy };
