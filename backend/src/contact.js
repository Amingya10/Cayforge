// backend/src/contact.js
// Contact form route — receives form submissions and sends them via Resend

const express = require('express');
const { Resend } = require('resend');

const resend = process.env.RESEND_API_KEY
  ? new Resend(process.env.RESEND_API_KEY)
  : null;

const FROM = 'Clayforge Contact <noreply@send.clayforge.app>';
const TO = 'hello@clayforge.app';

// Simple in-memory rate limit: max 5 submissions per IP per hour.
// Resets when the server restarts (Railway redeploys = fresh slate, which is fine).
const submissionLog = new Map(); // ip -> [timestamp, timestamp, ...]
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour

function isRateLimited(ip) {
  const now = Date.now();
  const cutoff = now - RATE_LIMIT_WINDOW_MS;
  const recent = (submissionLog.get(ip) || []).filter(t => t > cutoff);

  if (recent.length >= RATE_LIMIT_MAX) {
    submissionLog.set(ip, recent);
    return true;
  }

  recent.push(now);
  submissionLog.set(ip, recent);
  return false;
}

// Escape HTML so visitor input can't inject markup into the email
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function looksLikeEmail(s) {
  return typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length <= 254;
}

const router = express.Router();

router.post('/', async (req, res) => {
  try {
    if (!resend) {
      console.error('[contact] RESEND_API_KEY not set — cannot send email');
      return res.status(500).json({ error: 'Email service not configured' });
    }

    const ip =
      (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
      req.socket && req.socket.remoteAddress ||
      'unknown';

    if (isRateLimited(ip)) {
      console.warn('[contact] Rate limited:', ip);
      return res.status(429).json({ error: 'Too many submissions. Please try again later.' });
    }

    const body = req.body || {};
    const name = String(body.name || '').trim().slice(0, 100);
    const email = String(body.email || '').trim().slice(0, 254);
    const role = String(body.role || '').trim().slice(0, 50);
    const type = String(body.type || '').trim().slice(0, 80);
    const subject = String(body.subject || '').trim().slice(0, 200);
    const message = String(body.message || '').trim().slice(0, 5000);
    const source = String(body.source || '').trim().slice(0, 80);

    if (!name) return res.status(400).json({ error: 'Name is required' });
    if (!looksLikeEmail(email)) return res.status(400).json({ error: 'Valid email is required' });
    if (!type) return res.status(400).json({ error: 'Inquiry type is required' });
    if (!subject) return res.status(400).json({ error: 'Subject is required' });
    if (!message) return res.status(400).json({ error: 'Message is required' });

    const emailSubject = `[Clayforge] ${type}: ${subject}`;

    const html = `
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 600px; margin: 0 auto; color: #2a1f15;">
  <div style="background: linear-gradient(135deg, #c4714a, #8b4a2f); color: #faf6f0; padding: 20px 24px; border-radius: 10px 10px 0 0;">
    <h2 style="margin: 0; font-family: Georgia, serif; font-size: 20px;">New Contact Inquiry</h2>
    <p style="margin: 4px 0 0; font-size: 13px; opacity: 0.9;">${escapeHtml(type)}</p>
  </div>
  <div style="background: #faf6f0; padding: 24px; border: 1px solid #e8d8c4; border-top: none; border-radius: 0 0 10px 10px;">
    <table cellpadding="0" cellspacing="0" style="width: 100%; font-size: 14px; line-height: 1.6;">
      <tr><td style="padding: 6px 0; color: #9e8e7e; width: 100px;"><strong>From:</strong></td><td style="padding: 6px 0;">${escapeHtml(name)}</td></tr>
      <tr><td style="padding: 6px 0; color: #9e8e7e;"><strong>Email:</strong></td><td style="padding: 6px 0;"><a href="mailto:${escapeHtml(email)}" style="color: #c4714a;">${escapeHtml(email)}</a></td></tr>
      ${role ? `<tr><td style="padding: 6px 0; color: #9e8e7e;"><strong>Role:</strong></td><td style="padding: 6px 0;">${escapeHtml(role)}</td></tr>` : ''}
      <tr><td style="padding: 6px 0; color: #9e8e7e;"><strong>Type:</strong></td><td style="padding: 6px 0;">${escapeHtml(type)}</td></tr>
      <tr><td style="padding: 6px 0; color: #9e8e7e;"><strong>Subject:</strong></td><td style="padding: 6px 0;"><strong>${escapeHtml(subject)}</strong></td></tr>
      ${source ? `<tr><td style="padding: 6px 0; color: #9e8e7e;"><strong>Source:</strong></td><td style="padding: 6px 0;">${escapeHtml(source)}</td></tr>` : ''}
    </table>
    <hr style="border: none; border-top: 1px solid #e8d8c4; margin: 18px 0;">
    <div style="font-size: 11px; color: #9e8e7e; text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 8px;">Message</div>
    <div style="font-size: 14px; line-height: 1.7; white-space: pre-wrap;">${escapeHtml(message)}</div>
  </div>
  <p style="font-size: 11px; color: #9e8e7e; text-align: center; margin-top: 14px;">
    Sent from clayforge.app/contact.html · Reply directly to respond to ${escapeHtml(name)}
  </p>
</div>`.trim();

    const text = [
      `New Clayforge contact inquiry`,
      ``,
      `From:    ${name}`,
      `Email:   ${email}`,
      role ? `Role:    ${role}` : null,
      `Type:    ${type}`,
      `Subject: ${subject}`,
      source ? `Source:  ${source}` : null,
      ``,
      `--- Message ---`,
      ``,
      message,
      ``,
      `---`,
      `Reply directly to respond to ${name} at ${email}.`,
    ].filter(Boolean).join('\n');

    const { data, error } = await resend.emails.send({
      from: FROM,
      to: TO,
      replyTo: email,
      subject: emailSubject,
      html,
      text,
    });

    if (error) {
      console.error('[contact] Resend error:', error);
      return res.status(502).json({ error: 'Failed to send message. Please email hello@clayforge.app directly.' });
    }

    console.log('[contact] Email sent:', data && data.id, 'from:', email);
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[contact] Unexpected error:', err);
    return res.status(500).json({ error: 'Server error. Please email hello@clayforge.app directly.' });
  }
});

module.exports = router;
