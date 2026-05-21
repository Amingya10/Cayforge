require('dotenv').config();
const express = require('express');
const cors = require('cors');

const authRoutes = require('./auth');
const designRoutes = require('./designs');
const paymentRoutes = require('./payments');
const webhookRoutes = require('./routes/webhooks');
const contactRoutes = require('./contact');
const { router: verificationRoutes } = require('./verification');
const { rateLimit } = require('./rate-limit');
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
// Rate limit specific auth endpoints BEFORE the general auth router mount.
// Order matters: express tries middlewares in registration order.
app.use('/api/auth/register', rateLimit('register'));
app.use('/api/auth/login', rateLimit('login'));
app.use('/api/auth/verification/resend', rateLimit('register'));
app.use('/api/designs', rateLimit('designs'));

// Mount verification BEFORE the general /api/auth router so its routes win.
// /api/auth/verification/* hits verificationRoutes; everything else falls
// through to authRoutes (register, login, me).
app.use('/api/auth/verification', verificationRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/designs', designRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/contact', contactRoutes);
app.use((err, req, res, next) => {
  res.status(err.status || 500).json({ error: err.message || 'Server error' });
});

app.listen(PORT, () => console.log(`Clayforge API running on port ${PORT}`));
module.exports = app;
