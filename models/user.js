const Sequelize = require("sequelize");
const db = require("../config/database");

module.exports = db.define("users", {
    userId: {
        type: Sequelize.STRING,
        allowNull: false,
        primaryKey: true,
    },
    sessionId: {
        type: Sequelize.STRING,
        allowNull: true,
    },
    username: {
        type: Sequelize.STRING,
        allowNull: false,
    },
    profilePhoto: {
        type: Sequelize.STRING,
        allowNull: false,
    },
    followerCount: {
        type: Sequelize.INTEGER,
        allowNull: false,
    },
    status: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: true,
    },
    requestStatus: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: false
    },
    followingCount: {
        type: Sequelize.INTEGER,
        allowNull: false,
    },
    revenueExpirationDate: {
        type: Sequelize.BIGINT,
        allowNull: true,
    },
    premium: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: false,
    },    
    notFollowingBackCount: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0,
    },
    notFollowingMeCount: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0,
    },
    requestCount: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0,
    },
    privateFollowersCount: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0,
    },
    verifiedFollowersCount: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0,
    },
    createdAt: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.NOW,
    },
});