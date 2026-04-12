const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// Paystack plan codes — set these in Railway env vars
// PAYSTACK_SECRET_KEY=sk_live_xxx
// PAYSTACK_STONEWARE_PLAN=PLN_xxx (monthly ₦8,500)
// PAYSTACK_PORCELAIN_PLAN=PLN_xxx (monthly ₦22,000)

const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY;

const PLAN_AMOUNTS = {
  STONEWARE: 850000,   // ₦8,500 in kobo
  PORCELAIN: 2200000,  // ₦22,000 in kobo
};

// ── GET /api/payments/status ──
// Returns current user's plan
router.get('/status', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.json({ plan: 'FREE' });

    const token = authHeader.split(' ')[1];
    const jwt = require('jsonwebtoken');
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      select: { plan: true }
    });

    res.json({ plan: user?.plan || 'FREE' });
  } catch (e) {
    res.json({ plan: 'FREE' });
  }
});

// ── POST /api/payments/paystack/initialize ──
// Starts a Paystack subscription checkout
router.post('/paystack/initialize', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'Not authenticated' });

    const token = authHeader.split(' ')[1];
    const jwt = require('jsonwebtoken');
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const user = await prisma.user.findUnique({ where: { id: decoded.userId } });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const { plan } = req.body;
    if (!plan || !PLAN_AMOUNTS[plan]) {
      return res.status(400).json({ error: 'Invalid plan' });
    }

    const amount = PLAN_AMOUNTS[plan];
    const reference = `CF-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;

    // Initialize Paystack transaction
    const response = await fetch('https://api.paystack.co/transaction/initialize', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${PAYSTACK_SECRET}`,
        'Content-Type': 'application/json'
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
            { display_name: 'Plan', variable_name: 'plan', value: plan }
          ]
        },
        callback_url: `${process.env.FRONTEND_URL || 'https://cayforge.vercel.app'}?payment=success&reference=${reference}`
      })
    });

    const data = await response.json();

    if (!data.status) {
      return res.status(400).json({ error: data.message || 'Paystack initialization failed' });
    }

    // Store pending payment reference
    await prisma.user.update({
      where: { id: user.id },
      data: { paystackRef: reference }
    }).catch(() => {}); // ignore if field doesn't exist yet

    res.json({
      url: data.data.authorization_url,
      reference: data.data.reference
    });

  } catch (e) {
    console.error('Paystack init error:', e);
    res.status(500).json({ error: e.message || 'Payment initialization failed' });
  }
});

// ── POST /api/payments/paystack/verify ──
// Verifies payment and upgrades user plan
router.post('/paystack/verify', async (req, res) => {
  try {
    const { reference } = req.body;
    if (!reference) return res.status(400).json({ error: 'Reference required' });

    // Verify with Paystack
    const response = await fetch(`https://api.paystack.co/transaction/verify/${reference}`, {
      headers: { 'Authorization': `Bearer ${PAYSTACK_SECRET}` }
    });

    const data = await response.json();

    if (!data.status || data.data.status !== 'success') {
      return res.status(400).json({ error: 'Payment not successful' });
    }

    const { userId, plan } = data.data.metadata;

    if (!userId || !plan) {
      return res.status(400).json({ error: 'Invalid payment metadata' });
    }

    // Upgrade user plan
    const user = await prisma.user.update({
      where: { id: userId },
      data: { plan },
      select: { id: true, email: true, name: true, plan: true }
    });

    res.json({ success: true, user });

  } catch (e) {
    console.error('Paystack verify error:', e);
    res.status(500).json({ error: e.message || 'Payment verification failed' });
  }
});

// ── POST /api/payments/paystack/webhook ──
// Handles Paystack webhook events (subscription renewals etc.)
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
          data: { plan }
        });
      }
    }

    if (event.event === 'subscription.disable') {
      const email = event.data.customer?.email;
      if (email) {
        await prisma.user.update({
          where: { email },
          data: { plan: 'FREE' }
        });
      }
    }

    res.sendStatus(200);
  } catch (e) {
    console.error('Webhook error:', e);
    res.sendStatus(200); // always 200 to Paystack
  }
});

module.exports = router;
