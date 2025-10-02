const User = require('../models/user');
const InstagramUser = require('../models/instagram_user');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const Queue = require("bull");
const { Sequelize } = require("sequelize");
const { axiosGetWithProxy } = require("../utils/proxyClient");

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
        console.error("deleteAccount Hata:", error.response?.data || error.message);
        return res.status(500).json({ message: error.response?.data || error.message });
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
        console.error("unfollow Hata:", error.response?.data || error.message);
        await User.update({ status: false }, { where: { userId: req.userId } });
        return res.status(500).json({ message: error.response?.data || error.message });
    }
}

async function refreshUser(req, res) {
    try {
        const user = await User.findOne({ where: { userId: req.userId } });
        const url = `https://i.instagram.com/api/v1/users/${req.userId}/info/`;

        const headers = {
            "User-Agent": "Instagram 293.0.0.36.101 Android",
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
        console.error("refreshUser Hata:", error.response?.data || error.message);
        await User.update({ status: false }, { where: { userId: req.userId } });
        return res.status(500).json({ message: error.response?.data || error.message });
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
            "User-Agent": "Instagram 293.0.0.36.101 Android",
            "Cookie": `sessionid=${sessionId}; ds_user_id=${userId};`,
        };

        const response2 = await axios.get(url, { headers });
        const response = response2.data.user;
        console.log(response);

        const username = response.username;
        const profilePhoto = response.profile_pic_url;
        const followerCount = response.follower_count;
        const followingCount = response.following_count;
        await User.create({ userId, username, profilePhoto, followerCount, followingCount, sessionId });
        const accessToken = jwt.sign({ userId }, process.env.ACCESS_TOKEN);
        return res.status(200).json({ accessToken });
    } catch (error) {
        console.error("createUser Hata1: " + error.message);
        console.log(error.response?.data);

        await User.update({ status: false }, { where: { userId } });
        return res.status(500).json({ message: error.response?.data || error.message });
    }
}

async function fetchUserData(req, res) {
    await InstagramUser.destroy({ where: { ownerId: req.userId } });
    const user = await User.findOne({ where: { userId: req.userId } });
    const userId = req.userId;
    const sessionId = user.sessionId;
    console.log(req.body);
    await fetchQueue.removeJobs(`${userId}-followers`);
    await fetchQueue.removeJobs(`${userId}-following`);
    await fetchQueue.add(
        { sessionId, userId, type: "followers" },
        { jobId: `${userId}-followers`, removeOnComplete: true, removeOnFail: true }
    );

    console.log("geldi");

    await fetchQueue.add(
        { sessionId, userId, type: "following" },
        { jobId: `${userId}-following`, removeOnComplete: true, removeOnFail: true }
    );

    console.log("geldi2");

    return res.json({ status: "queued", userId });
}


const fetchQueue = new Queue("fetchQueue", process.env.REDIS_URL || "redis://127.0.0.1:6379");

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// DEĞİŞTİ: 401 yönetimi eklendi
async function fetchPage(sessionId, userId, type, endCursor) {
    console.log("fetch page started");

    const userAgents = [
        "Instagram 293.0.0.36.101 Android",
        "Instagram 289.0.0.77.109 Android",
        "Instagram 250.0.0.21.109 iOS",
        "Instagram 260.0.0.19.109 Android",
        "Instagram 280.0.0.21.111 iOS"
    ];
    const randomUA = userAgents[Math.floor(Math.random() * userAgents.length)];

    const queryHash = type === "followers"
        ? "c76146de99bb02f6415203be841dd25a"
        : "d04b0a864b4b54837c0d870b0e77e076";

    const variables = {
        id: userId.toString(),
        first: 50
    };
    console.log(variables);

    if (endCursor) variables.after = endCursor;

    console.log('endCursor ', endCursor);
    console.log('variables ', variables);

    const url = `https://www.instagram.com/graphql/query/?query_hash=${queryHash}&variables=${encodeURIComponent(JSON.stringify(variables))}`;

    const headers = {
        "User-Agent": randomUA,
        "Cookie": `sessionid=${sessionId}; ds_user_id=${userId};`
    };

    // YENİ: 401 hatası yakala ve kullanıcıyı pasif yap
    try {
        const res = await axiosGetWithProxy(url, { headers }, userId);
        return res.data;
    } catch (error) {
        if (error.response?.status === 401) {
            console.error(`401 Hatası (userId=${userId}): Session geçersiz`);

            await User.update(
                { status: false, requestStatus: false },
                { where: { userId } }
            );

            throw new Error("SESSION_EXPIRED");
        }

        throw error;
    }
}


fetchQueue.process(5, async (job) => {
    const { sessionId, userId, type, endCursor } = job.data;
    console.log(`🔥 İş başladı: userId=${userId}, type=${type}`);

    try {
        const data = await fetchPage(sessionId, userId, type, endCursor);
        console.log("dataLog: " + data);

        const edges = type === "followers"
            ? data.data.user.edge_followed_by.edges
            : data.data.user.edge_follow.edges;

        if (edges && edges.length > 0) {
            const rows = edges.map(({ node }) => ({
                userId: node.id,
                ownerId: userId,
                username: node.username,
                profilePhoto: node.profile_pic_url,
                isPrivate: node.is_private,
                isVerified: node.is_verified,
                sourceType: type,
            }));

            try {
                await InstagramUser.bulkCreate(rows, { ignoreDuplicates: true });
                console.log(`💾 ${rows.length} kişi kaydedildi (type=${type})`);
            } catch (dbErr) {
                console.error("❌ DB Hatası:", dbErr.message);
            }
        }
        console.log("data:", data);
        const pageInfo = data?.data?.user?.edge_follow?.page_info
            || data?.data?.user?.edge_followed_by?.page_info;
        console.log("page_info:", pageInfo);

        if (pageInfo?.has_next_page && pageInfo?.end_cursor) {
            console.log(`➡️ ${type}: sıradaki sayfa kuyruğa alınıyor...`);
            const endCursor = pageInfo.end_cursor;

            await fetchQueue.add(
                { sessionId, userId, type, endCursor },
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

            const notFollowingBack = following.filter(f => !followerSet.has(f.userId));
            const notFollowingMe = followers.filter(f => !followingSet.has(f.userId));
            const privateFollowers = followers.filter(f => f.isPrivate);
            const verifiedFollowers = followers.filter(f => f.isVerified);

            await User.increment("requestCount", { by: 1, where: { userId } });

            const user = await User.findOne({ where: { userId } });

            if (user.requestCount >= 2) {
                let profileViewers = [];
                if (followers.length > 0) {
                    const shuffled = followers.sort(() => 0.5 - Math.random());

                    let randomLimit = Math.floor(Math.random() * (16 - 4 + 1)) + 4;

                    randomLimit = Math.min(randomLimit, shuffled.length);

                    profileViewers = shuffled.slice(0, randomLimit);
                    console.log(`🎲 seçilen limit=${randomLimit}, takipçi=${followers.length}, slice=${profileViewers.length}`);
                }
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
                console.log(`${type}: tüm liste tamamlandı!`);
            }
        }
    } catch (error) {
        // DEĞİŞTİ: SESSION_EXPIRED özel olarak ele alınıyor
        if (error.message === "SESSION_EXPIRED") {
            console.error(`userId=${userId} session expired, kullanıcı pasif`);
            await User.update(
                { requestStatus: false, requestCount: 0, status: false },
                { where: { userId } }
            );
            return;
        }

        console.error("process Hata:", error.response?.data || error.message);
        await User.update(
            { requestStatus: false, requestCount: 0, status: false },
            { where: { userId } }
        );
        return;
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

        return res.status(200).json(list);
    } catch (error) {
        await User.update({ status: false }, { where: { userId: req.userId } });
        console.error("getInstagramUsers Hata:", error.response?.data || error.message);
        return res.status(500).json({ message: error.response?.data || error.message });
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
    console.log(user.profileViewersCount);

    const viewers = await InstagramUser.findAll({
        where: { ownerId: userId, sourceType: "followers" },
        order: Sequelize.literal("RAND()"),
        limit: user.profileViewersCount,
    });
    return viewers;

}

module.exports = { getUser, createUser, fetchUserData, getInstagramUsers, unfollow, refreshUser, deleteAccount }