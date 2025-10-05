// utils/proxyClient.js
const axios = require("axios");
const { HttpsProxyAgent } = require("https-proxy-agent");
const Bottleneck = require("bottleneck");
const crypto = require("crypto");
const { IgApiClient } = require('instagram-private-api');
const User = require('../models/user');

// Tek proxy URL
const PROXY_URL = process.env.PROXY_URL || "";

// Rate limiter - her istek arası 1.5 saniye bekle
const limiter = new Bottleneck({
    minTime: 1500,
    maxConcurrent: parseInt(process.env.MAX_CONCURRENT || "5", 10),
});

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Proxy URL'ine random session ID ekle
function buildProxyUrlWithSession(baseUrl) {
    if (!baseUrl) return null;

    const sessionId = crypto.randomBytes(8).toString("hex");

    if (baseUrl.includes("?")) {
        return `${baseUrl}&session=${sessionId}`;
    }
    return `${baseUrl}?session=${sessionId}`;
}

// Ana request fonksiyonu
async function axiosGetWithProxy(url, options, userId, userAgent) {
    // Proxy yoksa direkt istek at
    if (!PROXY_URL) {
        console.log("⚠️ Proxy yok, direkt istek atılıyor");
        return axios.get(url, options);
    }

    return limiter.schedule(async () => {
        try {
            // Her istekte yeni session ID
            const proxyWithSession = buildProxyUrlWithSession(PROXY_URL);
            const agent = new HttpsProxyAgent(proxyWithSession);

            const response = await axios.get(url, {
                ...options,
                headers: {
                    ...(options.headers || {}),
                    "User-Agent": userAgent,
                },
                httpsAgent: agent,
                proxy: false,
                timeout: 45000,
            });

            console.log(`✅ Başarılı - Status: ${response.status}`);
            return response;

        } catch (error) {
            const status = error.response?.status;
            const message = error.response?.data?.message || error.message;
            console.warn(`Kullanıcı verileri çekerken hata aldı ve\nstatus: ${status}\nmessage:${message}`);

            await delay(10000);

            if (userId) {
                try {
                    console.log("Tekrar login yapılıyor");

                    await loginAgain(userId);

                    console.log("✅ Login başarılı, istek tekrar deneniyor...");
                    // Login başarılıysa devam et, döngü tekrar deneyecek
                    return await axiosGetWithProxy(url, options, userId, userAgent);

                } catch (loginErr) {
                    console.warn("❌ Login tekrar başarısız:", loginErr.message);
                    await User.update({ status: false }, { where: { userId } });
                    throw new Error(`Login tekrar başarısız`);
                }
            } else {
                console.warn("⚠️ User model veya userId yok, tekrar giriş yapılamadı");
                throw new Error(`User model veya userId yok tekrar giriş yapılamadı`);
            }

        }

    });
}

// Login fonksiyonu (401 durumunda çağrılacak)
async function loginAgain(userId) {

    try {
        // Kullanıcıyı veritabanından çek
        const dbUser = await User.findOne({ where: { userId } });

        if (!dbUser) {
            throw new Error('Kullanıcı bulunamadı');
        }

        const ig = new IgApiClient();

        // Proxy ayarı
        if (PROXY_URL) {
            const proxyWithSession = buildProxyUrlWithSession(PROXY_URL);
            ig.state.proxyUrl = proxyWithSession;
        }

        // Mobildeki cihaz ayarlarını koru (bunları createUser'da kaydettiysen)
        if (dbUser.deviceId) ig.state.deviceId = dbUser.deviceId;
        if (dbUser.userAgent) ig.state.appUserAgent = dbUser.userAgent;
        ig.state.generateDevice(dbUser.username);

        // 1️⃣ Önce var olan session'ı geri yükle
        if (dbUser.sessionId && dbUser.userId) {
            await ig.state.deserialize({
                cookies: JSON.stringify({
                    version: 'tough-cookie@2.5.0',
                    storeType: 'MemoryCookieStore',
                    rejectPublicSuffixes: true,
                    cookies: [
                        { key: 'sessionid', value: dbUser.sessionId, domain: '.instagram.com', path: '/' },
                        { key: 'ds_user_id', value: dbUser.userId, domain: '.instagram.com', path: '/' },
                        { key: 'csrftoken', value: dbUser.csrftoken || 'missing', domain: '.instagram.com', path: '/', },
                    ],
                }),
            });
        }
    } catch (error) {
        console.log(`kullanıcı için hata geldi ${error.message}`);

    }

    /*  if (!dbUser.username || !dbUser.password) {
         console.error(`❌ Login bilgileri eksik: ${userId}`);
 
         // Status'u false yap        
         await User.update({ status: false }, { where: { userId } });
         throw new Error('Login bilgileri eksik - Status false yapıldı');
     }
 
     try {
         console.log(`🔄 Tekrar login yapılıyor: ${dbUser.username}`);
 
         const user = await ig.account.login(dbUser.username, dbUser.password);
         const token = ig.state.authorization;
 
         await ig.challenge.auto(true);
 
         let sessionId = null;
 
         // Token'dan sessionid çıkar
         if (token && token.startsWith('Bearer IGT:2:')) {
             const base64 = token.split('Bearer IGT:2:')[1];
             const json = JSON.parse(Buffer.from(base64, 'base64').toString('utf8'));
             console.log('🔓 Decoded IGT token:', json);
 
             // Session ID'yi bul
             sessionId = json.sessionid || ig.state.cookieUserId;
         }
 
         // Kullanıcıyı veritabanında güncelle
         if (sessionId) {
             await User.update({ status: true, sessionId: sessionId }, { where: { userId } });
             console.log(`✅ SessionId güncellendi: ${dbUser.username} -> ${sessionId}`);
         }
 
         return { sessionId, user };
 
     } catch (err) {
         console.error(`❌ Login hatası (${dbUser.username}):`, err.message);
 
         const errorMessage = err.message || '';
         const statusCode = err.response?.statusCode || err.statusCode;
 
         // 401 dışındaki hatalar için status:false yap
         // Örnek: 400 (bad password), 403 (banned), 429 (rate limit), network errors
         if (statusCode && statusCode !== 401) {
             console.warn(`⚠️ 401 dışında hata (${statusCode}) - Status false yapılıyor`);
             await User.update({ status: false }, { where: { userId } });
         } else if (!statusCode && !errorMessage.includes('challenge')) {
             // Network hatası veya beklenmeyen hata
             console.warn(`⚠️ Beklenmeyen hata - Status false yapılıyor`);
             await User.update({ status: false }, { where: { userId } });
         }
 
         throw err;
     } */
}

module.exports = { axiosGetWithProxy };