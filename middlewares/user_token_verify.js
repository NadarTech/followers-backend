const jwt = require('jsonwebtoken');
const User = require('../models/user');

module.exports = async (req, res, next) => {
    try {
        const bearerHeader = req.headers['authorization'];
        console.log(bearerHeader);
        const token = bearerHeader.split(' ')[1];        
        const decodedToken = jwt.verify(token, process.env.ACCESS_TOKEN);
        req.userId = decodedToken.userId;
        next();
    } catch (error) {
        return res.status(401).json({ message: 'Token Not Valid' });
    }
}

