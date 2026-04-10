const express = require('express');
const { PrismaClient } = require('@prisma/client');
const authMiddleware = require('./middleware/auth');

const router = express.Router();
const prisma = new PrismaClient();

router.get('/', authMiddleware, async (req, res) => {
  try {
    const designs = await prisma.design.findMany({ where: { userId: req.user.id } });
    res.json(designs);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/', authMiddleware, async (req, res) => {
  try {
    const design = await prisma.design.create({ data: { ...req.body, userId: req.user.id } });
    res.json(design);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
