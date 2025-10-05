const User = require('../models/user');
const InstagramUser = require('../models/instagram_user');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const Queue = require("bull");
const { Sequelize } = require("sequelize");
const { axiosGetWithProxy } = require("../utils/proxyClient");
const admin = require('firebase-admin');

//const fetchQueue = new Queue("fetchQueue", process.env.REDIS_URL || "redis://127.0.0.1:6379");
const fetchQueue = new Queue("fetchQueue", "redis://127.0.0.1:6379");

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getUser(req, res) {
    try {
        const user = await User.findOne({ where: { userId: req.userId } });

        if (!user) {
            return res.status(404).json({
                success: false,
                message: "User not found",
            });
        }

        return res.status(200).json(user);
    } catch (error) {
        try {
            await User.update({ status: false }, { where: { userId: req.userId } });
        } catch (updateErr) {
            console.error("Failed to update user status:", updateErr.message);
        }

        console.error(
            "GetUser Hata:",
            error.message,
            error.response ? JSON.stringify(error.response.data, null, 2) : ""
        );

        return res.status(500).json({
            message: "Internal server error",
            error: error.message,
        });
    }
}

async function saveToken(req, res) {
    const { token } = req.body;
    try {
        const user = await User.findOne({ where: { userId: req.userId } });

        if (!user) {
            return res.status(404).json({
                success: false,
                message: "User not found",
            });
        }
        await User.update({ fcmToken: token }, { where: { userId: req.userId } });
        return res.status(200).json({ message: 'success' });
    } catch (error) {
        try {
            await User.update({ status: false }, { where: { userId: req.userId } });
        } catch (updateErr) {
            console.error("Failed to update user status:", updateErr.message);
        }

        console.error(
            "GetUser Hata:",
            error.message,
            error.response ? JSON.stringify(error.response.data, null, 2) : ""
        );

        return res.status(500).json({
            message: "Internal server error",
            error: error.message,
        });
    }
}

async function deleteAccount(req, res) {
    try {
        const user = await User.findOne({ where: { userId: req.userId } });

        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        // Kullanıcı bulunduysa silme işlemleri
        await Promise.all([
            User.destroy({ where: { userId: req.userId } }),
            InstagramUser.destroy({ where: { ownerId: req.userId } }),
        ]);

        return res.status(200).json({ message: 'Account deleted successfully' });

    } catch (error) {
        // Silme sırasında hata olursa, kullanıcıyı pasife çek
        await User.update({ status: false }, { where: { userId: req.userId } });

        const errorMessage = error?.response?.data || error.message || 'Unexpected error';
        console.error('❌ deleteAccount error:', errorMessage);

        return res.status(500).json({ message: errorMessage });
    }
}

async function createUser(req, res) {
    const { sessionId, userId, password, deviceId, userAgent, csrfToken } = req.body;
    console.log(req.body);
    
    try {
        if (!sessionId || !userId) {
            return res.status(400).json({ error: "Account problem" });
        }

        const user = await User.findOne({ where: { userId } });

        if (user != null) {
            await User.update({ sessionId, status: true, deviceId, userAgent, csrfToken }, { where: { userId } });
            const accessToken = jwt.sign({ userId }, process.env.ACCESS_TOKEN);
            return res.status(200).json({ accessToken });
        }

        const url = `https://i.instagram.com/api/v1/users/${userId}/info/`;

        const headers = {
            "User-Agent": userAgent,
            "Cookie": `sessionid=${sessionId}; ds_user_id=${userId};`,
        };

        const response2 = await axios.get(url, { headers });
        const response = response2.data.user;
        console.log(response);

        const username = response.username;
        const profilePhoto = response.profile_pic_url;
        const followerCount = response.follower_count;
        const followingCount = response.following_count;
        await User.create({ userId, username, profilePhoto, followerCount, followingCount, sessionId, deviceId, userAgent, csrfToken });
        const accessToken = jwt.sign({ userId }, process.env.ACCESS_TOKEN);
        return res.status(200).json({ accessToken });
    } catch (error) {
        console.log(error.response?.data);

        await User.update({ status: false }, { where: { userId } });
        return res.status(500).json({ message: error.response?.data || error.message });
    }
}

async function unfollow(req, res) {
    const { targetUserId } = req.body;
    const userId = req.userId;

    try {
        const user = await User.findOne({ where: { userId } });

        // Eğer user bulunamazsa önce status: false yap, sonra 404 dön
        if (!user) {
            await User.update({ status: false }, { where: { userId } });
            console.warn(`unfollow: user not found -> set status=false for userId=${userId}`);
            return res.status(404).json({ message: "User not found" });
        }

        if (!user.sessionId) {
            console.warn(`unfollow: sessionId missing for userId=${userId}`);
            return res.status(403).json({ message: "User session not found" });
        }

        const sessionId = user.sessionId;
        const url = `https://i.instagram.com/api/v1/friendships/destroy/${targetUserId}/`;

        const headers = {
            "User-Agent": user.userAgent,
            "Cookie": `sessionid=${sessionId}; ds_user_id=${userId};`,
            "x-ig-app-id": "936619743392459",
        };

        // Küçük gecikme (isteğe bağlı)
        await delay(2000);

        const response = await axios.post(url, null, { headers });

        if (response.data?.friendship_status) {
            // Veritabanı güncellemelerini paralel çalıştır
            await Promise.all([
                InstagramUser.destroy({
                    where: {
                        userId: targetUserId,
                        ownerId: userId,
                        sourceType: "following",
                    },
                }),
                User.decrement("followingCount", { by: 1, where: { userId } }),
            ]);

            return res.status(200).json({ message: "Unfollow successful" });
        } else {
            // Instagram isteği beklenen formatta dönmediyse
            console.warn("unfollow: instagram request returned unexpected body", response.data);
            return res.status(400).json({ message: "Instagram request failed" });
        }
    } catch (error) {
        const errorMessage = error?.response?.data || error.message || "Unexpected error";
        console.error("❌ Unfollow error:", errorMessage);

        // Hata durumunda kullanıcıyı pasif hale getir
        try {
            await User.update({ status: false }, { where: { userId } });
        } catch (e) {
            console.error("❌ Failed to set user status=false after error:", e?.message || e);
        }

        return res.status(500).json({ message: errorMessage });
    }
}

async function refreshUser(req, res) {
    const userId = req.userId;
    try {
        const user = await User.findOne({ where: { userId } });

        if (!user || !user.sessionId) {
            await User.update({ status: false }, { where: { userId } });
            console.warn(`refreshUser: User not found or sessionId missing (userId=${userId})`);
            return res.status(404).json({ message: "User not found or session invalid" });
        }

        const url = `https://i.instagram.com/api/v1/users/${userId}/info/`;

        const headers = {
            "User-Agent": user.userAgent,
            "Cookie": `sessionid=${user.sessionId}; ds_user_id=${userId};`,
        };

        const { data } = await axios.get(url, { headers });

        if (!data || !data.user) {
            throw new Error("Invalid response from Instagram");
        }

        const igUser = data.user;

        await User.update(
            {
                username: igUser.username,
                profilePhoto: igUser.profile_pic_url,
                followerCount: igUser.follower_count,
                followingCount: igUser.following_count,
                requestStatus: false,
                fetchStatus: 'completed'
            },
            { where: { userId } }
        );

        return res.status(200).json({ message: "User data refreshed successfully" });

    } catch (error) {
        const errorMessage = error?.response?.data || error.message || "Unknown error";

        console.error("❌ refreshUser error:", errorMessage);

        // Kullanıcıyı pasif duruma al
        try {
            await User.update({ status: false }, { where: { userId } });
        } catch (e) {
            console.error("⚠️ Failed to set status=false for user after error:", e.message);
        }

        return res.status(500).json({ message: errorMessage });
    }
}

async function fetchUserData(req, res) {
    await InstagramUser.destroy({ where: { ownerId: req.userId } });
    const user = await User.findOne({ where: { userId: req.userId } });
    console.log("user güncellendi");

    await User.update(
        { fetchStatus: 'loading', requestCount: 0 },
        { where: { userId: req.userId } }
    );
    const userId = req.userId;
    const sessionId = user.sessionId;
    const deviceId = user.deviceId;
    const userAgent = user.userAgent;
    if (user.requestStatus == false || user.fetchStatus == 'failed') {
        await fetchQueue.removeJobs(`${userId}-followers`);
        await fetchQueue.removeJobs(`${userId}-following`);
    }
    await fetchQueue.add(
        { sessionId, userId, type: "followers", deviceId, userAgent },
        { jobId: `${userId}-followers`, removeOnComplete: true, removeOnFail: true }
    );
    await fetchQueue.add(
        { sessionId, userId, type: "following", deviceId, userAgent },
        { jobId: `${userId}-following`, removeOnComplete: true, removeOnFail: true }
    );
    return res.json({ status: "queued", userId });
}

async function fetchPage(sessionId, userId, type, deviceId, userAgent, endCursor) {
    const queryHash = type === "followers"
        ? "c76146de99bb02f6415203be841dd25a"
        : "d04b0a864b4b54837c0d870b0e77e076";

    const variables = {
        id: userId.toString(),
        first: 50
    };

    if (endCursor) variables.after = endCursor;

    const url = `https://www.instagram.com/graphql/query/?query_hash=${queryHash}&variables=${encodeURIComponent(JSON.stringify(variables))}`;

    const headers = {
        "User-Agent": userAgent,
        "Cookie": `sessionid=${sessionId}; ds_user_id=${userId};`
    };
    try {
        const res = await axiosGetWithProxy(url, { headers }, userId, userAgent);
        return res.data;
    } catch (error) {
        console.warn(`user fetch page error: ${error}`);
        throw error;
    }
}

fetchQueue.process(5, async (job) => {
    const { sessionId, userId, type, deviceId, userAgent, endCursor } = job.data;
    console.log(`🔥 İş başladı: userId=${userId}, type=${type}`);

    try {
        await delay(2500);
        const data = await fetchPage(sessionId, userId, type, deviceId, userAgent, endCursor);
        const edges = type === "followers"
            ? data?.data?.user?.edge_followed_by?.edges
            : data?.data?.user?.edge_follow?.edges;

        if (edges && edges.length > 0) {
            const rows = edges.map(({ node }) => ({
                userId: node.id,
                ownerId: userId,
                username: node.username,
                fullName: node.full_name,
                profilePhoto: node.profile_pic_url,
                isPrivate: node.is_private,
                isVerified: node.is_verified,
                sourceType: type,
            }));

            try {
                await InstagramUser.bulkCreate(rows, { ignoreDuplicates: true });
                console.log(`💾 ${rows.length} kişi kaydedildi (type=${type})`);
            } catch (dbErr) {
                await User.update(
                    { requestStatus: false, requestCount: 0, status: false, fetchStatus: 'failed' },
                    { where: { userId } }
                );
                console.error("❌ DB Hatası:", dbErr.message);
            }
        } else {
            await User.update(
                { requestStatus: false, requestCount: 0, status: false, fetchStatus: 'failed' },
                { where: { userId } }
            );
            console.log("⚠️ edges boş geldi");
        }

        const pageInfo = data?.data?.user?.[type === "followers" ? "edge_followed_by" : "edge_follow"]?.page_info;

        if (pageInfo?.has_next_page && pageInfo?.end_cursor) {
            console.log(`➡️ ${type}: sıradaki sayfa kuyruğa alınıyor...`);
            await fetchQueue.add(
                { sessionId, userId, type, deviceId, userAgent, endCursor: pageInfo.end_cursor },
                { removeOnComplete: true }
            );
        } else {
            console.log(`✅ ${type} için tüm sayfalar çekildi. Veriler işleniyor...`);
            await processFinalData(userId);
        }

    } catch (error) {
        console.error("❌ process Hata:", error.response?.data || error.message);
        await User.update(
            { requestStatus: false, requestCount: 0, status: false, fetchStatus: 'failed' },
            { where: { userId } }
        );
    }
});


async function processFinalData(userId) {
    try {
        const followers = await InstagramUser.findAll({
            where: { ownerId: userId, sourceType: "followers" },
            attributes: ["userId", "username", "isPrivate", "isVerified"],
        });

        const following = await InstagramUser.findAll({
            where: { ownerId: userId, sourceType: "following" },
            attributes: ["userId"],
        });

        const followerSet = new Set(followers.map(f => f.userId));
        const followingSet = new Set(following.map(f => f.userId));

        const notFollowingBack = following.filter(f => !followerSet.has(f.userId));
        const notFollowingMe = followers.filter(f => !followingSet.has(f.userId));
        const privateFollowers = followers.filter(f => f.isPrivate);
        const verifiedFollowers = followers.filter(f => f.isVerified);

        // Güncelleme yapılmadan önce requestCount kontrol edilecek
        await User.increment("requestCount", { by: 1, where: { userId } });
        const user = await User.findOne({ where: { userId } });

        if (user.requestCount >= 2) {
            console.log('requestCount artırıldı');

            let profileViewers = [];

            if (followers.length > 0) {
                const shuffled = followers.sort(() => 0.5 - Math.random());
                const randomLimit = Math.min(
                    Math.floor(Math.random() * (16 - 4 + 1)) + 4,
                    shuffled.length
                );
                profileViewers = shuffled.slice(0, randomLimit);
                console.log(`🎲 ProfileViewers: ${randomLimit} kişi seçildi`);
            }

            await User.update(
                {
                    requestCount: 0,
                    requestStatus: true,
                    fetchStatus: 'completed',
                    notFollowingBackCount: notFollowingBack.length,
                    notFollowingMeCount: notFollowingMe.length,
                    privateFollowersCount: privateFollowers.length,
                    verifiedFollowersCount: verifiedFollowers.length,
                    profileViewersCount: profileViewers.length,
                },
                { where: { userId } }
            );
            if (user.fcmToken != null) {
                const message = {
                    token: user.fcmToken,
                    notification: { title: 'All Set! 🎉', body: 'We’ve successfully synced your Instagram account data.' },
                    android: { priority: 'high' },
                    apns: { headers: { 'apns-priority': '10' } },
                };
                return admin.messaging().send(message);
            }
            console.log(`✅ Kullanıcı verileri başarıyla güncellendi`);
        } else {
            console.log(`ℹ️ Şimdilik sadece requestCount artırıldı`);
        }
    } catch (error) {
        console.error("❌ Final işlem hatası:", error.message);
        await User.update(
            { requestStatus: false, requestCount: 0, status: false, fetchStatus: 'failed' },
            { where: { userId } }
        );
    }
}

async function getInstagramUsers(req, res) {
    const { type } = req.body;
    const userId = req.userId;
    try {
        const handlers = {
            notFollowingBack: getNotFollowingBack,
            notFollowingMe: getNotFollowingMeBack,
            privateFollowers: getPrivateFollowers,
            verifiedFollowers: getVerifiedFollowers,
            profileViewers: getProfileViewers,
        };
        const handlerFn = handlers[type];

        if (!handlerFn) {
            console.warn(`⚠️ Geçersiz type: ${type}`);
            return res.status(400).json({ message: "Invalid type parameter" });
        }
        const list = await handlerFn(userId);
        return res.status(200).json(list);
    } catch (error) {
        console.error("❌ getInstagramUsers Hata:", error.response?.data || error.message);

        try {
            await User.update({ status: false }, { where: { userId } });
        } catch (dbErr) {
            console.error("⚠️ Kullanıcı status=false yapılırken hata:", dbErr.message);
        }

        return res.status(500).json({
            message: error.response?.data || error.message || "Unknown error"
        });
    }
}

async function getNotFollowingBack(userId) {
    const following = await InstagramUser.findAll({
        where: { ownerId: userId, sourceType: "following" },
    });

    const followerIds = await InstagramUser.findAll({
        where: { ownerId: userId, sourceType: "followers" },
    });

    const followerSet = new Set(followerIds.map(f => f.userId));

    return following.filter(f => !followerSet.has(f.userId));
}

async function getNotFollowingMeBack(userId) {
    const followers = await InstagramUser.findAll({
        where: { ownerId: userId, sourceType: "followers" },
    });

    const followingIds = await InstagramUser.findAll({
        where: { ownerId: userId, sourceType: "following" },
    });

    const followingSet = new Set(followingIds.map(f => f.userId));

    return followers.filter(f => !followingSet.has(f.userId));
}

async function getPrivateFollowers(userId) {
    const privateFollowers = await InstagramUser.findAll({
        where: {
            ownerId: userId,
            sourceType: "followers",
            isPrivate: true
        },
    });
    return privateFollowers;
}

async function getVerifiedFollowers(userId) {
    const verifiedFollowers = await InstagramUser.findAll({
        where: {
            ownerId: userId,
            sourceType: "followers",
            isVerified: true
        },
    });
    return verifiedFollowers;
}

async function getProfileViewers(userId) {
    const user = await User.findOne({ where: { userId } });
    const viewers = await InstagramUser.findAll({
        where: { ownerId: userId, sourceType: "followers" },
        order: Sequelize.literal("RAND()"),
        limit: user.profileViewersCount,
    });
    return viewers;

}

module.exports = { getUser, createUser, fetchUserData, getInstagramUsers, unfollow, refreshUser, deleteAccount, saveToken }