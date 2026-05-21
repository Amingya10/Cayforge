// backend/src/verification.js
// Email verification system — token generation, email sending via Resend,
// and the verify endpoint. Tokens are 64-char hex (32 bytes of entropy),
// valid for 24 hours, single-use.

const express = require('express');
const crypto = require('crypto');
const { PrismaClient } = require('@prisma/client');
const { Resend } = require('resend');

const prisma = new PrismaClient();

const resend = process.env.RESEND_API_KEY
  ? new Resend(process.env.RESEND_API_KEY)
  : null;

const FROM = 'Clayforge <noreply@send.clayforge.app>';
const TOKEN_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://clayforge.app';

// HTML escape for any user input that ends up in email HTML
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Generate a 64-char hex token (32 bytes of entropy = 256 bits)
function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

// Build the verification email HTML — terracotta + earth tones to match the site
function buildVerificationEmailHtml(name, verifyUrl) {
  const safeName = escapeHtml(name || 'there');
  return `
<!DOCTYPE html>
<html>
<body style="margin: 0; padding: 0; background: #faf6f0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;">
  <div style="max-width: 560px; margin: 0 auto; padding: 24px;">
    <div style="background: linear-gradient(135deg, #c4714a, #8b4a2f); color: #faf6f0; padding: 28px 28px 24px; border-radius: 12px 12px 0 0; text-align: center;">
      <div style="font-family: Georgia, 'Cormorant Garamond', serif; font-size: 28px; font-weight: 600; letter-spacing: 0.02em;">Clayforge</div>
      <div style="font-size: 12px; opacity: 0.85; letter-spacing: 0.12em; text-transform: uppercase; margin-top: 6px;">Where Clay Meets Creative Intelligence</div>
    </div>
    <div style="background: #faf6f0; padding: 32px 28px; border: 1px solid #e8d8c4; border-top: none; border-radius: 0 0 12px 12px; color: #2a1f15;">
      <h2 style="margin: 0 0 16px; font-family: Georgia, serif; font-size: 22px; font-weight: 400;">Welcome, ${safeName} 🏺</h2>
      <p style="margin: 0 0 18px; font-size: 15px; line-height: 1.65;">
        Thanks for joining Clayforge. To unlock the full studio — saving designs, exporting PDFs, and upgrading your plan — we need to confirm this is really your email address.
      </p>
      <div style="text-align: center; margin: 28px 0;">
        <a href="${verifyUrl}" style="display: inline-block; background: linear-gradient(135deg, #c4714a, #8b4a2f); color: #faf6f0; padding: 14px 32px; border-radius: 8px; text-decoration: none; font-family: Georgia, serif; font-style: italic; font-size: 16px; font-weight: 500; box-shadow: 0 4px 12px rgba(196,113,74,0.25);">Verify my email →</a>
      </div>
      <p style="margin: 0 0 8px; font-size: 13px; color: #6e5e4e; line-height: 1.6;">
        Or paste this link into your browser:
      </p>
      <p style="margin: 0 0 24px; font-size: 12px; color: #9e8e7e; word-break: break-all; background: rgba(196,113,74,0.06); padding: 10px 12px; border-radius: 6px;">
        ${escapeHtml(verifyUrl)}
      </p>
      <hr style="border: none; border-top: 1px solid #e8d8c4; margin: 22px 0;">
      <p style="margin: 0 0 8px; font-size: 12px; color: #9e8e7e; line-height: 1.7;">
        This link expires in 24 hours. If you didn't sign up for Clayforge, you can safely ignore this email — no account will be created.
      </p>
      <p style="margin: 16px 0 0; font-size: 12px; color: #9e8e7e; line-height: 1.7;">
        Questions? Reply to this email or write to <a href="mailto:hello@clayforge.app" style="color: #c4714a; text-decoration: none;">hello@clayforge.app</a>.
      </p>
    </div>
    <p style="text-align: center; font-size: 11px; color: #9e8e7e; margin-top: 16px;">
      Clayforge · Made in Kano, Nigeria 🇳🇬
    </p>
  </div>
</body>
</html>`.trim();
}

function buildVerificationEmailText(name, verifyUrl) {
  return [
    `Welcome to Clayforge, ${name || 'there'}!`,
    ``,
    `To unlock the full studio — saving designs, exporting PDFs, and upgrading your plan — we need to confirm this is really your email address.`,
    ``,
    `Verify your email by visiting this link:`,
    verifyUrl,
    ``,
    `This link expires in 24 hours.`,
    ``,
    `If you didn't sign up for Clayforge, you can safely ignore this email.`,
    ``,
    `Questions? Reply to this email or write to hello@clayforge.app.`,
    ``,
    `— Clayforge`,
    `Made in Kano, Nigeria`,
  ].join('\n');
}

// Send a verification email to a user. Generates a fresh token, saves it to
// the DB (overwriting any previous one), and emails the link via Resend.
// Returns { ok: true } on success or { ok: false, error: '...' } on failure.
async function sendVerificationEmail(user) {
  if (!resend) {
    console.error('[verification] RESEND_API_KEY not set');
    return { ok: false, error: 'Email service not configured' };
  }

  const token = generateToken();
  const expiry = new Date(Date.now() + TOKEN_EXPIRY_MS);

  // Save token to DB (overwrites any existing token for this user)
  await prisma.user.update({
    where: { id: user.id },
    data: {
      verificationToken: token,
      verificationTokenExpiry: expiry,
    },
  });

  const verifyUrl = `${FRONTEND_URL}/verify.html?token=${token}`;

  try {
    const { data, error } = await resend.emails.send({
      from: FROM,
      to: user.email,
      subject: 'Verify your Clayforge email',
      html: buildVerificationEmailHtml(user.name, verifyUrl),
      text: buildVerificationEmailText(user.name, verifyUrl),
    });

    if (error) {
      console.error('[verification] Resend error:', error);
      return { ok: false, error: 'Failed to send verification email' };
    }

    console.log('[verification] Sent:', data && data.id, 'to:', user.email);
    return { ok: true };
  } catch (err) {
    console.error('[verification] Send exception:', err);
    return { ok: false, error: 'Failed to send verification email' };
  }
}

const router = express.Router();

// POST /api/auth/verification/resend
// Body: { email }
// Sends a fresh verification email (or no-op if user is already verified
// or doesn't exist — we don't reveal which to prevent email enumeration).
router.post('/resend', async (req, res) => {
  try {
    const email = String((req.body || {}).email || '').trim().toLowerCase();
    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    const user = await prisma.user.findUnique({ where: { email } });

    // Don't reveal whether the email exists or is already verified —
    // always return success so attackers can't enumerate accounts.
    if (!user || user.emailVerified) {
      return res.status(200).json({ ok: true });
    }

    const result = await sendVerificationEmail(user);
    if (!result.ok) {
      return res.status(502).json({ error: result.error });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[verification] resend handler error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/auth/verification/verify?token=xxx
// Verifies the token, marks the user as verified, and clears the token.
// Returns success or appropriate error.
router.get('/verify', async (req, res) => {
  try {
    const token = String((req.query || {}).token || '').trim();
    if (!token || token.length !== 64) {
      return res.status(400).json({ error: 'Invalid verification link' });
    }

    const user = await prisma.user.findFirst({
      where: { verificationToken: token },
    });

    if (!user) {
      return res.status(400).json({ error: 'Verification link is invalid or has already been used' });
    }

    // Check expiry
    if (user.verificationTokenExpiry && user.verificationTokenExpiry < new Date()) {
      return res.status(400).json({ error: 'Verification link has expired. Please request a new one.' });
    }

    // Mark verified and clear the token (single-use)
    await prisma.user.update({
      where: { id: user.id },
      data: {
        emailVerified: true,
        verificationToken: null,
        verificationTokenExpiry: null,
      },
    });

    console.log('[verification] Verified user:', user.email);
    return res.status(200).json({
      ok: true,
      email: user.email,
      name: user.name,
    });
  } catch (err) {
    console.error('[verification] verify handler error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// Middleware: blocks request if the authenticated user has not verified
// their email. Use this on routes that require verification.
//
// Expects req.user to be set by upstream auth middleware (the existing
// JWT-checking middleware in auth.js). Returns 403 with a clear error
// the frontend can recognize.
async function requireVerifiedEmail(req, res, next) {
  try {
    if (!req.user || !req.user.id) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { emailVerified: true },
    });

    if (!user) {
      return res.status(401).json({ error: 'User not found' });
    }

    if (!user.emailVerified) {
      return res.status(403).json({
        error: 'Email verification required',
        code: 'EMAIL_NOT_VERIFIED',
      });
    }

    return next();
  } catch (err) {
    console.error('[verification] requireVerifiedEmail error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}

module.exports = {
  router,
  sendVerificationEmail,
  requireVerifiedEmail,
};
