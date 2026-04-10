const express = require('express');
const { PrismaClient } = require('@prisma/client');
const authMiddleware = require('./middleware/auth');
const router = express.Router();
const prisma = new PrismaClient();

router.get('/status', authMiddleware, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    res.json({ plan: user.plan });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
