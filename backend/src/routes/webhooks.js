const express = require('express');
const Stripe = require('stripe');
const { PrismaClient } = require('@prisma/client');

const router = express.Router();
const prisma = new PrismaClient();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

router.post('/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (e) {
    return res.status(400).send('Webhook Error: ' + e.message);
  }
  try {
    if (event.type === 'customer.subscription.created' || event.type === 'customer.subscription.updated') {
      const sub = event.data.object;
      const plan = sub.metadata?.plan || 'STONEWARE';
      const userId = sub.metadata?.userId;
      if (userId) {
        const status = ['active', 'trialing'].includes(sub.status) ? plan : 'FREE';
        await prisma.user.update({ where: { id: userId }, data: { plan: status } });
      }
    }
    if (event.type === 'customer.subscription.deleted') {
      const sub = event.data.object;
      const userId = sub.metadata?.userId;
      if (userId) await prisma.user.update({ where: { id: userId }, data: { plan: 'FREE' } });
    }
    res.json({ received: true });
  } catch (e) {
    res.status(500).json({ error: 'Webhook failed' });
  }
});

module.exports = router;
