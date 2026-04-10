require('dotenv').config();
const express = require('express');
const cors = require('cors');

const authRoutes = require('./auth');
const designRoutes = require('./designs');
const paymentRoutes = require('./payments');
const webhookRoutes = require('./routes/webhooks');
const app = express();
const PORT = process.env.PORT || 3001;

app.use('/api/webhooks', webhookRoutes);
app.use(express.json());
app.use(cors({ origin: process.env.FRONTEND_URL || '*', credentials: true }));

app.get('/health', (req, res) => res.json({ status: 'ok' }));
app.use('/api/auth', authRoutes);
app.use('/api/designs', designRoutes);
app.use('/api/payments', paymentRoutes);

app.use((err, req, res, next) => {
  res.status(err.status || 500).json({ error: err.message || 'Server error' });
});

app.listen(PORT, () => console.log(`Clayforge API running on port ${PORT}`));
module.exports = app;
