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

function buildStickyProxyUrl(proxyUrl, userId) {
  // session id üretelim (her userId için sabit kalır)
  const sessionId = crypto.createHash("md5").update(String(userId)).digest("hex").slice(0, 8);
  // proxy URL’sine session param ekle
  if (proxyUrl.includes("?")) {
    return `${proxyUrl}&session=${sessionId}`;
  }
  return `${proxyUrl}/?session=${sessionId}`;
}

async function axiosGetWithProxy(url, options, userId, retries = 3) {
  if (!proxyList.length) return axios.get(url, options);

  const { idx, proxyUrl } = pickProxy(userId);
  const stickyProxy = buildStickyProxyUrl(proxyUrl, userId);
  const limiter = limiters[idx];
  const jitter = Math.floor(Math.random() * 800);

  return limiter.schedule(async () => {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const agent = stickyProxy ? new HttpsProxyAgent(stickyProxy) : undefined;
        const resp = await axios.get(url, {
          ...options,
          httpsAgent: agent,
          proxy: false,
          timeout: 45000,
        });
        markSuccess(idx);
        if (jitter) await new Promise(r => setTimeout(r, jitter));
        return resp;
      } catch (err) {
        markError(idx);
        console.warn(`❌ Proxy hata [${attempt}/${retries}] userId=${userId} proxy=${stickyProxy}: ${err.message}`);
        if (attempt === retries) throw err;
        await new Promise(r => setTimeout(r, 2000 * attempt));
      }
    }
  });
}

module.exports = { axiosGetWithProxy };
