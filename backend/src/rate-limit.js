// backend/src/rate-limit.js
// IP-based rate limiting middleware. Same in-memory pattern as contact.js —
// counters live in process memory and reset whenever Railway redeploys
// (which is fine for soft launch with 1 replica).
//
// USAGE:
//   const { rateLimit } = require('./rate-limit');
//   app.use('/api/auth/register', rateLimit('register'), authRoutes);
//
// LIMITS:
//   register: 3 requests per IP per hour
//   login:    10 requests per IP per 15 minutes
//   designs:  20 requests per IP per hour
//
// If a limit is hit, the middleware responds with 429 and stops the request
// before it reaches the actual route.

const LIMITS = {
  register: { max: 3,  windowMs: 60 * 60 * 1000 },       // 3 / hour
  login:    { max: 10, windowMs: 15 * 60 * 1000 },       // 10 / 15min
  designs:  { max: 20, windowMs: 60 * 60 * 1000 },       // 20 / hour
};

// Separate log per bucket so a user's login attempts don't eat into their
// register quota (or vice versa).
const logs = {
  register: new Map(),
  login: new Map(),
  designs: new Map(),
};

function getClientIp(req) {
  // Railway puts the real client IP in x-forwarded-for. Take the first
  // entry (the original client) since proxies append, not prepend.
  const xff = req.headers['x-forwarded-for'];
  if (xff) {
    const first = String(xff).split(',')[0].trim();
    if (first) return first;
  }
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

function rateLimit(bucket) {
  const config = LIMITS[bucket];
  if (!config) {
    throw new Error(`rateLimit: unknown bucket "${bucket}"`);
  }

  return function rateLimitMiddleware(req, res, next) {
    const ip = getClientIp(req);
    const now = Date.now();
    const cutoff = now - config.windowMs;

    const recent = (logs[bucket].get(ip) || []).filter(t => t > cutoff);

    if (recent.length >= config.max) {
      // Find when the oldest request in the window will expire,
      // so we can tell the client how long to wait.
      const oldestInWindow = recent[0];
      const retryAfterMs = (oldestInWindow + config.windowMs) - now;
      const retryAfterSec = Math.max(1, Math.ceil(retryAfterMs / 1000));

      logs[bucket].set(ip, recent); // save filtered log back
      console.warn(`[rate-limit] ${bucket} blocked: ip=${ip} retry=${retryAfterSec}s`);

      res.set('Retry-After', String(retryAfterSec));
      return res.status(429).json({
        error: 'Too many requests. Please try again later.',
        retryAfter: retryAfterSec,
      });
    }

    recent.push(now);
    logs[bucket].set(ip, recent);
    return next();
  };
}

// Optional housekeeping: every 10 minutes, drop entries whose entire window
// has expired. Keeps the Map from growing unbounded if your service runs
// for weeks without a redeploy.
setInterval(() => {
  const now = Date.now();
  for (const [bucket, log] of Object.entries(logs)) {
    const windowMs = LIMITS[bucket].windowMs;
    const cutoff = now - windowMs;
    for (const [ip, timestamps] of log.entries()) {
      const fresh = timestamps.filter(t => t > cutoff);
      if (fresh.length === 0) {
        log.delete(ip);
      } else if (fresh.length !== timestamps.length) {
        log.set(ip, fresh);
      }
    }
  }
}, 10 * 60 * 1000).unref(); // .unref() so this timer doesn't keep the process alive

module.exports = { rateLimit };
