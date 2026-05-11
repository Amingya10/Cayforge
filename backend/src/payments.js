const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY;

const PLAN_AMOUNTS = {
  STONEWARE: 850000,   // ₦8,500 in kobo
  PORCELAIN: 2200000,  // ₦22,000 in kobo
};

// Shared auth helper — verifies JWT and returns decoded payload, or null
function getUserFromAuth(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return null;
  const token = authHeader.split(' ')[1];
  if (!token) return null;
  try {
    return jwt.verify(token, process.env.JWT_SECRET);
  } catch (e) {
    return null;
  }
}

// ── GET /api/payments/status ──
// Returns the authenticated user's plan and cancellation state
router.get('/status', async (req, res) => {
  try {
    const decoded = getUserFromAuth(req);
    if (!decoded) return res.json({ plan: 'FREE', cancelAt: null });

    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      select: { plan: true, cancelAt: true },
    });

    res.json({
      plan: user?.plan || 'FREE',
      cancelAt: user?.cancelAt || null,
    });
  } catch (e) {
    console.error('Status error:', e);
    res.status(500).json({ error: 'Failed to load status' });
  }
});

// ── POST /api/payments/paystack/initialize ──
router.post('/paystack/initialize', async (req, res) => {
  try {
    const decoded = getUserFromAuth(req);
    if (!decoded) return res.status(401).json({ error: 'Not authenticated' });

    const user = await prisma.user.findUnique({ where: { id: decoded.userId } });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const { plan } = req.body;
    if (!plan || !PLAN_AMOUNTS[plan]) {
      return res.status(400).json({ error: 'Invalid plan' });
    }

    const amount = PLAN_AMOUNTS[plan];
    const reference = `CF-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;

    const response = await fetch('https://api.paystack.co/transaction/initialize', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${PAYSTACK_SECRET}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email: user.email,
        amount,
        reference,
        currency: 'NGN',
        metadata: {
          userId: user.id,
          plan,
          custom_fields: [
            { display_name: 'Plan', variable_name: 'plan', value: plan },
          ],
        },
        callback_url: `${process.env.FRONTEND_URL || 'https://cayforge.vercel.app'}?payment=success&reference=${reference}`,
      }),
    });

    const data = await response.json();
    if (!data.status) {
      return res.status(400).json({ error: data.message || 'Paystack initialization failed' });
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { paystackRef: reference },
    }).catch(() => {}); // ignore if field doesn't exist yet

    res.json({
      url: data.data.authorization_url,
      reference: data.data.reference,
    });
  } catch (e) {
    console.error('Paystack init error:', e);
    res.status(500).json({ error: e.message || 'Payment initialization failed' });
  }
});

// ── POST /api/payments/paystack/verify ──
router.post('/paystack/verify', async (req, res) => {
  try {
    const { reference } = req.body;
    if (!reference) return res.status(400).json({ error: 'Reference required' });

    const response = await fetch(`https://api.paystack.co/transaction/verify/${reference}`, {
      headers: { 'Authorization': `Bearer ${PAYSTACK_SECRET}` },
    });
    const data = await response.json();

    if (!data.status || data.data.status !== 'success') {
      return res.status(400).json({ error: 'Payment not successful' });
    }

    const { userId, plan } = data.data.metadata;
    if (!userId || !plan) {
      return res.status(400).json({ error: 'Invalid payment metadata' });
    }

    // Upgrade user plan AND clear any pending cancellation
    // AND reset the quota window so they get a fresh 30 days
    const now = new Date();
    const quotaResetAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    const user = await prisma.user.update({
      where: { id: userId },
      data: { plan, cancelAt: null, quotaResetAt, designsThisPeriod: 0 },
      select: { id: true, email: true, name: true, plan: true },
    });

    res.json({ success: true, user });
  } catch (e) {
    console.error('Paystack verify error:', e);
    res.status(500).json({ error: e.message || 'Payment verification failed' });
  }
});

// ── POST /api/payments/paystack/webhook ──
router.post('/paystack/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const crypto = require('crypto');
    const hash = crypto
      .createHmac('sha512', PAYSTACK_SECRET)
      .update(JSON.stringify(req.body))
      .digest('hex');

    if (hash !== req.headers['x-paystack-signature']) {
      return res.status(401).send('Invalid signature');
    }

    const event = req.body;

    if (event.event === 'charge.success') {
      const { userId, plan } = event.data.metadata || {};
      if (userId && plan) {
        await prisma.user.update({
          where: { id: userId },
          data: { plan, cancelAt: null },
        });
      }
    }

    if (event.event === 'subscription.disable') {
      const email = event.data.customer?.email;
      if (email) {
        await prisma.user.update({
          where: { email },
          data: { plan: 'FREE', cancelAt: null },
        });
      }
    }

    res.sendStatus(200);
  } catch (e) {
    console.error('Webhook error:', e);
    res.sendStatus(200);
  }
});

// ── POST /api/payments/cancel ──
router.post('/cancel', async (req, res) => {
  try {
    const decoded = getUserFromAuth(req);
    if (!decoded) return res.status(401).json({ error: 'Not authenticated' });

    const user = await prisma.user.findUnique({ where: { id: decoded.userId } });
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.plan === 'FREE') return res.status(400).json({ error: 'No active subscription to cancel' });
    if (user.cancelAt) return res.status(400).json({ error: 'Subscription already cancelled' });

    const cancelDate = user.quotaResetAt || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    await prisma.user.update({
      where: { id: decoded.userId },
      data: { cancelAt: cancelDate },
    });

    res.json({
      success: true,
      message: 'Subscription cancelled. Access continues until end of period.',
      accessUntil: cancelDate,
    });
  } catch (e) {
    console.error('Cancel error:', e);
    res.status(500).json({ error: 'Failed to cancel subscription' });
  }
});

module.exports = router;
