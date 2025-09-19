const Sequelize = require("sequelize");

module.exports = new Sequelize(process.env.DB_NAME, process.env.DB_USERNAME, process.env.DB_PASSWORD, {
    dialect: process.env.DIALECT,
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    timezone: '+03:00',
    define: {
        timestamps: false
    }
});