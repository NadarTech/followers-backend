const User = require('../models/user');
const InstagramUser = require('../models/instagram_user');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const Queue = require("bull");
const { Sequelize } = require("sequelize");

async function getUser(req, res) {
    try {
        const user = await User.findOne({ where: { userId: req.userId } });
        return res.status(200).json(user);
    } catch (error) {
        await User.update({ status: false }, { where: { userId: req.userId } });
        return res.status(500).json({ message: 'Unknown error' });
    }
}

async function deleteAccount(req, res) {
    try {
        const user = await User.findOne({ where: { userId: req.userId } });
        if (user != null) {
            await User.destroy({ where: { userId: req.userId } });
            await InstagramUser.destroy({ where: { ownerId: req.userId } });
            return res.status(200).json({ message: 'ok' });
        } else {
            return res.status(200).json({ message: 'User not found' });
        }
    } catch (error) {
        await User.update({ status: false }, { where: { userId: req.userId } });
        return res.status(500).json({ message: 'Unknown error' });
    }
}

async function unfollow(req, res) {
    try {
        const { targetUserId } = req.body;
        const user = await User.findOne({ where: { userId: req.userId } });
        const userId = req.userId;
        const sessionId = user.sessionId;
        const url = `https://i.instagram.com/api/v1/friendships/destroy/${targetUserId}/`;

        const headers = {
            "User-Agent": "Instagram 200.0.0.29.121 Android",
            "Cookie": `sessionid=${sessionId}; ds_user_id=${userId};`,
            "x-ig-app-id": "936619743392459"
        };
        await delay(3000);

        const response = await axios.post(url, null, { headers });

        if (response.data?.friendship_status) {
            await InstagramUser.destroy({
                where: {
                    userId: targetUserId,
                    ownerId: userId,
                    sourceType: "following",
                },
            });

            await User.decrement("followingCount", { by: 1, where: { userId } });
            return res.status(200).json({ message: 'Success' });
        } else {
            return res.status(400).json({ message: "Instagram request failed" });
        }
    } catch (error) {
        console.log(error);

        await User.update({ status: false }, { where: { userId: req.userId } });
        return res.status(500).json({ message: 'Unknown error' });
    }
}

async function refreshUser(req, res) {
    try {
        const user = await User.findOne({ where: { userId: req.userId } });
        const url = `https://i.instagram.com/api/v1/users/${req.userId}/info/`;

        const headers = {
            "User-Agent": "Instagram 200.0.0.29.121 Android", // fake UA
            "Cookie": `sessionid=${user.sessionId}; ds_user_id=${req.userId};`,
        };

        const response2 = await axios.get(url, { headers });
        const response = response2.data.user;

        const username = response.username;
        const profilePhoto = response.profile_pic_url;
        const followerCount = response.follower_count;
        const followingCount = response.following_count;
        await User.update({ username, profilePhoto, followerCount, followingCount, requestStatus: false }, { where: { userId: req.userId } });
        return res.status(200).json({ message: 'Success' });
    } catch (error) {

        await User.update({ status: false }, { where: { userId: req.userId } });
        return res.status(500).json({ message: 'Unknown error' });
    }
}

async function createUser(req, res) {
    const { sessionId, userId } = req.body;
    try {
        if (!sessionId || !userId) {
            return res.status(400).json({ error: "Account problem" });
        }

        const user = await User.findOne({ where: { userId } });

        if (user != null) {
            await User.update({ sessionId, status: true }, { where: { userId } });
            const accessToken = jwt.sign({ userId }, process.env.ACCESS_TOKEN);
            return res.status(200).json({ accessToken });
        }

        const url = `https://i.instagram.com/api/v1/users/${userId}/info/`;

        const headers = {
            "User-Agent": "Instagram 200.0.0.29.121 Android", // fake UA
            "Cookie": `sessionid=${sessionId}; ds_user_id=${userId};`,
        };

        const response2 = await axios.get(url, { headers });
        const response = response2.data.user;

        const username = response.username;
        const profilePhoto = response.profile_pic_url;
        const followerCount = response.follower_count;
        const followingCount = response.following_count;
        await User.create({ userId, username, profilePhoto, followerCount, followingCount, sessionId });
        const accessToken = jwt.sign({ userId }, process.env.ACCESS_TOKEN);
        return res.status(200).json({ accessToken });
    } catch (error) {
        await User.update({ status: false }, { where: { userId } });
        return res.status(500).json({ message: 'Unknown error' });
    }
}

async function fetchUserData(req, res) {
    await InstagramUser.destroy({ where: { ownerId: req.userId } });
    const user = await User.findOne({ where: { userId: req.userId } });
    const userId = req.userId;
    const sessionId = user.sessionId;

    // Kuyruğa followers + following joblarını ekle
    await fetchQueue.add({ sessionId, userId, type: "followers" });
    await fetchQueue.add({ sessionId, userId, type: "following" });
    return res.json({ status: "queued", userId });
}


const fetchQueue = new Queue("fetchQueue", process.env.REDIS_URL || "redis://127.0.0.1:6379");

// ------------------- HELPERS -------------------
function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchPage(sessionId, userId, type, maxId = null) {
    const url = `https://i.instagram.com/api/v1/friendships/${userId}/${type}/`;
    const headers = {
        "User-Agent": "Instagram 200.0.0.29.121 Android",
        "Cookie": `sessionid=${sessionId}; ds_user_id=${userId};`,
    };

    const fullUrl = maxId ? `${url}?max_id=${maxId}` : url;
    const res = await axios.get(fullUrl, { headers });
    return res.data;
}


// ------------------- WORKER -------------------
fetchQueue.process(async (job) => {
    const { sessionId, userId, type, maxId } = job.data;
    //console.log(`📥 Job başladı: ${type} | userId=${userId} | maxId=${maxId || "ilk sayfa"}`);

    try {
        const data = await fetchPage(sessionId, userId, type, maxId);
        //console.log(`✅ ${type}: ${data.users?.length || 0} kişi geldi`);


        if (data.users && data.users.length > 0) {
            // DB'ye ekle
            const rows = data.users.map((u) => ({
                userId: u.pk_id,
                ownerId: userId,
                username: u.username,
                profilePhoto: u.profile_pic_url,
                isPrivate: u.is_private,
                isVerified: u.is_verified,
                sourceType: type,
            }));

            try {
                await InstagramUser.bulkCreate(rows, { ignoreDuplicates: true });
                console.log(`💾 ${rows.length} kişi kaydedildi (type=${type})`);
            } catch (dbErr) {
                console.error("❌ DB Hatası:", dbErr.message);
            }
        }
        console.log(`bak gelen değere: ${data.next_max_id}`);

        if (data.next_max_id != null) {
            console.log(`➡️ ${type}: sıradaki sayfa kuyruğa alınıyor...`);

            const waitMs = 1000 + Math.floor(Math.random() * 4000);
            console.log(`⏳ ${waitMs / 1000} saniye bekleniyor...`);
            await delay(waitMs);

            await fetchQueue.add(
                { sessionId, userId, type, maxId: data.next_max_id },
                { removeOnComplete: true }
            );
        } else {

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

            // 1. benim takip ettiklerim ama beni etmeyenler
            const notFollowingBack = following.filter(f => !followerSet.has(f.userId));

            // 2. beni takip eden ama benim etmediklerim
            const notFollowingMe = followers.filter(f => !followingSet.has(f.userId));

            // 3. private hesap olan takipçilerim
            const privateFollowers = followers.filter(f => f.isPrivate);

            // 4. verified hesap olan takipçilerim
            const verifiedFollowers = followers.filter(f => f.isVerified);

            let profileViewers = [];
            if (followers.length > 0) {
                const shuffled = followers.sort(() => 0.5 - Math.random());
                profileViewers = shuffled.slice(0, Math.min(8, shuffled.length));
            }


            await User.increment("requestCount", { by: 1, where: { userId } });

            // Kullanıcının güncel requestCount değerini çek
            const user = await User.findOne({ where: { userId } });

            if (user.requestCount >= 2) {
                await User.update(
                    {
                        requestCount: 0,
                        requestStatus: true,
                        notFollowingBackCount: notFollowingBack.length,
                        notFollowingMeCount: notFollowingMe.length,
                        privateFollowersCount: privateFollowers.length,
                        verifiedFollowersCount: verifiedFollowers.length,
                        profileViewersCount: profileViewers.length,
                    },
                    { where: { userId } }
                );
                console.log(`🎯 ${type}: tüm liste tamamlandı!`);
            }
        }
    } catch (err) {
        await User.update({ requestStatus: false }, { where: { userId } })
        console.error("❌ Hata:", err.response?.data || err.message);
    }
});

async function getInstagramUsers(req, res) {
    const { type } = req.body;
    try {
        console.log(type);

        var list;
        if (type == 'notFollowingBack') {
            list = await getNotFollowingBack(req.userId);
        } else if (type == 'notFollowingMe') {
            list = await getNotFollowingMeBack(req.userId);
        } else if (type == 'privateFollowers') {
            list = await getPrivateFollowers(req.userId);
        } else if (type == 'verifiedFollowers') {
            list = await getVerifiedFollowers(req.userId);
        } else if (type == 'profileViewers') {
            list = await getProfileViewers(req.userId);
        }
        console.log(list);

        return res.status(200).json(list);
    } catch (error) {
        await User.update({ status: false }, { where: { userId: req.userId } });
        return res.status(500).json({ message: 'Unknown error' });
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

    // following’de olup followers’ta olmayanlar
    return following.filter(f => !followerSet.has(f.userId));
}

async function getNotFollowingMeBack(userId) {
    // benim followers listem
    const followers = await InstagramUser.findAll({
        where: { ownerId: userId, sourceType: "followers" },
    });

    // benim following listem
    const followingIds = await InstagramUser.findAll({
        where: { ownerId: userId, sourceType: "following" },
    });

    const followingSet = new Set(followingIds.map(f => f.userId));

    // followers’da olup following’de olmayanlar
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

// Verified hesabı olan takipçilerim
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
    const viewers = await InstagramUser.findAll({
        where: { ownerId: userId, sourceType: "followers" },
        order: Sequelize.literal("RAND()"),
        limit: 8,
        attributes: ["userId", "username", "profilePhoto"]
    });

    return viewers;

}



module.exports = { getUser, createUser, fetchUserData, getInstagramUsers, unfollow, refreshUser, deleteAccount }