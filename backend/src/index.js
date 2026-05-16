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
const allowedOrigins = [
  'https://clayforge.app',
  'https://www.clayforge.app',
  'https://cayforge.vercel.app',
  process.env.FRONTEND_URL
].filter(Boolean);

app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (mobile apps, curl, server-to-server)
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error(`CORS blocked: ${origin}`), false);
  },
  credentials: true
}));
app.get('/health', (req, res) => res.json({ status: 'ok' }));
app.use('/api/auth', authRoutes);
app.use('/api/designs', designRoutes);
app.use('/api/payments', paymentRoutes);

app.use((err, req, res, next) => {
  res.status(err.status || 500).json({ error: err.message || 'Server error' });
});

app.listen(PORT, () => console.log(`Clayforge API running on port ${PORT}`));
module.exports = app;
