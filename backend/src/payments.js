const express = require('express');

const router = express.Router();

router.get('/status', async (req, res) => {
  res.json({ plan: 'FREE' });
});

module.exports = router;
