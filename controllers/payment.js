const User = require('../models/user');


async function handleRevenueCatWebhook(req, res) {
    try {
        const { event } = req.body;
        console.log(event);

        const userId = event.app_user_id;
        const type = event.type;

        const rawProductId = event.product_id || '';
        const productId = rawProductId.includes(':') ? rawProductId.split(':')[0] : rawProductId;

        console.log(`📩 Webhook event: ${type} for userId: ${userId} | productId: ${productId}`);


        if (type === 'TRANSFER') {
            console.log(`🟡 TRANSFER by user: ${userId}`);
            const fromId = event.transferred_from?.[0];
            const toId = event.transferred_to?.[0];

            if (!fromId || !toId) {
                return res.status(400).json({ message: 'Missing transferred user IDs' });
            }

            const oldUser = await User.findOne({ where: { userId: fromId } });
            if (!oldUser) return res.status(404).json({ message: 'Old user not found' });

            await User.update(
                {
                    premium: true,                    
                    revenueExpirationDate: oldUser.revenueExpirationDate
                },
                { where: { id: toId } }
            );

            await oldUser.update({
                premium: false,
                revenueExpirationDate: null
            });

            return res.status(200).json({ message: 'Transfer completed' });
        }

        const user = await User.findOne({ where: { userId } });
        if (!user) return res.status(404).json({ message: 'User not found' });

        if (['INITIAL_PURCHASE', 'RENEWAL', 'PRODUCT_CHANGE'].includes(type)) {
            console.log(`🟡 ${type} by user: ${userId}`);

            await user.update({
                premium: event.expiration_at_ms > Date.now(),
                revenueExpirationDate: event.expiration_at_ms,
            });

            return res.status(200).json({ message: `${type} processed` });
        }

        if (type === 'EXPIRATION') {
            console.log(`🟡 EXPIRATION by user: ${userId}`);
            if (!user.revenueExpirationDate || event.expiration_at_ms >= user.revenueExpirationDate) {
                await user.update({
                    premium: false,
                    revenueExpirationDate: event.expiration_at_ms,
                });
            }
            return res.status(200).json({ message: 'Expiration processed' });
        }

        if (type === 'CANCELLATION') {
            console.log(`🟡 Subscription cancelled by user: ${userId}`);
            return res.status(200).json({ message: 'Cancellation logged' });
        }

        return res.status(400).json({ message: 'Unhandled event type' });

    } catch (error) {
        console.error('RevenueCat Webhook Error:', error);
        return res.status(500).json({ message: String(error) });
    }
}

module.exports = { handleRevenueCatWebhook };
