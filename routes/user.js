const router = require('express').Router();
const controller = require('../controllers/user');
const userTokenVerify = require('../middlewares/user_token_verify');

router.get('/', userTokenVerify, controller.getUser);
router.post('/', controller.createUser);
router.get('/all', userTokenVerify, controller.fetchUserData);
router.post('/instagram', userTokenVerify, controller.getInstagramUsers);
router.post('/unfollow', userTokenVerify, controller.unfollow);
router.get('/refresh', userTokenVerify, controller.refreshUser);
router.delete('/delete', userTokenVerify, controller.deleteAccount);

module.exports = router;