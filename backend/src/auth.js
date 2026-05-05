const jwt = require('jsonwebtoken');

/**
 * JWT authentication middleware.
 * Verifies the Authorization header, decodes the token,
 * and attaches { userId } to req.user.
 *
 * Usage:
 *   const auth = require('../middleware/auth');
 *   router.post('/protected', auth, async (req, res) => {
 *     const userId = req.user.userId;
 *     ...
 *   });
 */
module.exports = function auth(req, res, next) {
  try {
    const header = req.headers.authorization;
    if (!header) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const parts = header.split(' ');
    if (parts.length !== 2 || parts[0] !== 'Bearer') {
      return res.status(401).json({ error: 'Invalid authorization header' });
    }

    const token = parts[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    if (!decoded || !decoded.userId) {
      return res.status(401).json({ error: 'Invalid token' });
    }

    req.user = { userId: decoded.userId };
    next();
  } catch (e) {
    if (e.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired' });
    }
    return res.status(401).json({ error: 'Invalid token' });
  }
};
