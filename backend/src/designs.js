const express = require('express');
const { PrismaClient } = require('@prisma/client');

const router = express.Router();
const prisma = new PrismaClient();

router.get('/', async (req, res) => {
  try {
    const designs = await prisma.design.findMany();
    res.json(designs);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const design = await prisma.design.create({ data: req.body });
    res.json(design);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
