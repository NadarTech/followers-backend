const router = require('express').Router();
const controller = require('../controllers/payment');

router.post('/webhook', controller.handleRevenueCatWebhook);

module.exports = router;