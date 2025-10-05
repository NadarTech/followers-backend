const Sequelize = require("sequelize");
const db = require("../config/database");

InstagramUsers = db.define("instagram_users", {
    userId: {
        type: Sequelize.STRING,
        allowNull: false,
    },
    username: {
        type: Sequelize.STRING,
        allowNull: false,
    },
    fullName: {
        type: Sequelize.STRING,
        allowNull: true,
    },
    isVerified: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
    },
    isPrivate: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
    },
    profilePhoto: {
        type: Sequelize.STRING,
        allowNull: false,
    },
    ownerId: {
        type: Sequelize.STRING,
        allowNull: false,
    },
    sourceType: {
        type: Sequelize.STRING,
        allowNull: false,
    },
    createdAt: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.NOW,
    },
});

InstagramUsers.removeAttribute('id');

module.exports = InstagramUsers;