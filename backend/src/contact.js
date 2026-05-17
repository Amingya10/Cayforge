// backend/src/contact.js
// Contact form route — receives form submissions and sends them via Resend

import { Resend } from 'resend';

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
    submissionLog.set(ip, recent); // keep cleaned list
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

// Basic email shape check (not exhaustive, just a sanity filter)
function looksLikeEmail(s) {
  return typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length <= 254;
}

export async function handleContactSubmission(req, res) {
  try {
    // Guard: Resend not configured
    if (!resend) {
      console.error('[contact] RESEND_API_KEY not set — cannot send email');
      return res.status(500).json({ error: 'Email service not configured' });
    }

    // Get client IP for rate limiting (Railway sits behind a proxy)
    const ip =
      (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
      req.socket?.remoteAddress ||
      'unknown';

    if (isRateLimited(ip)) {
      console.warn('[contact] Rate limited:', ip);
      return res.status(429).json({ error: 'Too many submissions. Please try again later.' });
    }

    // Pull and validate fields
    const {
      name = '',
      email = '',
      role = '',
      type = '',
      subject = '',
      message = '',
      source = '',
    } = req.body || {};

    const cleanName = String(name).trim().slice(0, 100);
    const cleanEmail = String(email).trim().slice(0, 254);
    const cleanRole = String(role).trim().slice(0, 50);
    const cleanType = String(type).trim().slice(0, 80);
    const cleanSubject = String(subject).trim().slice(0, 200);
    const cleanMessage = String(message).trim().slice(0, 5000);
    const cleanSource = String(source).trim().slice(0, 80);

    if (!cleanName) return res.status(400).json({ error: 'Name is required' });
    if (!looksLikeEmail(cleanEmail)) return res.status(400).json({ error: 'Valid email is required' });
    if (!cleanType) return res.status(400).json({ error: 'Inquiry type is required' });
    if (!cleanSubject) return res.status(400).json({ error: 'Subject is required' });
    if (!cleanMessage) return res.status(400).json({ error: 'Message is required' });

    // Build the email
    const emailSubject = `[Clayforge] ${cleanType}: ${cleanSubject}`;

    const html = `
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 600px; margin: 0 auto; color: #2a1f15;">
  <div style="background: linear-gradient(135deg, #c4714a, #8b4a2f); color: #faf6f0; padding: 20px 24px; border-radius: 10px 10px 0 0;">
    <h2 style="margin: 0; font-family: Georgia, serif; font-size: 20px;">New Contact Inquiry</h2>
    <p style="margin: 4px 0 0; font-size: 13px; opacity: 0.9;">${escapeHtml(cleanType)}</p>
  </div>
  <div style="background: #faf6f0; padding: 24px; border: 1px solid #e8d8c4; border-top: none; border-radius: 0 0 10px 10px;">
    <table cellpadding="0" cellspacing="0" style="width: 100%; font-size: 14px; line-height: 1.6;">
      <tr><td style="padding: 6px 0; color: #9e8e7e; width: 100px;"><strong>From:</strong></td><td style="padding: 6px 0;">${escapeHtml(cleanName)}</td></tr>
      <tr><td style="padding: 6px 0; color: #9e8e7e;"><strong>Email:</strong></td><td style="padding: 6px 0;"><a href="mailto:${escapeHtml(cleanEmail)}" style="color: #c4714a;">${escapeHtml(cleanEmail)}</a></td></tr>
      ${cleanRole ? `<tr><td style="padding: 6px 0; color: #9e8e7e;"><strong>Role:</strong></td><td style="padding: 6px 0;">${escapeHtml(cleanRole)}</td></tr>` : ''}
      <tr><td style="padding: 6px 0; color: #9e8e7e;"><strong>Type:</strong></td><td style="padding: 6px 0;">${escapeHtml(cleanType)}</td></tr>
      <tr><td style="padding: 6px 0; color: #9e8e7e;"><strong>Subject:</strong></td><td style="padding: 6px 0;"><strong>${escapeHtml(cleanSubject)}</strong></td></tr>
      ${cleanSource ? `<tr><td style="padding: 6px 0; color: #9e8e7e;"><strong>Source:</strong></td><td style="padding: 6px 0;">${escapeHtml(cleanSource)}</td></tr>` : ''}
    </table>
    <hr style="border: none; border-top: 1px solid #e8d8c4; margin: 18px 0;">
    <div style="font-size: 11px; color: #9e8e7e; text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 8px;">Message</div>
    <div style="font-size: 14px; line-height: 1.7; white-space: pre-wrap;">${escapeHtml(cleanMessage)}</div>
  </div>
  <p style="font-size: 11px; color: #9e8e7e; text-align: center; margin-top: 14px;">
    Sent from clayforge.app/contact.html · Reply directly to respond to ${escapeHtml(cleanName)}
  </p>
</div>`.trim();

    // Plaintext fallback for clients that don't render HTML
    const text = [
      `New Clayforge contact inquiry`,
      ``,
      `From:    ${cleanName}`,
      `Email:   ${cleanEmail}`,
      cleanRole ? `Role:    ${cleanRole}` : null,
      `Type:    ${cleanType}`,
      `Subject: ${cleanSubject}`,
      cleanSource ? `Source:  ${cleanSource}` : null,
      ``,
      `--- Message ---`,
      ``,
      cleanMessage,
      ``,
      `---`,
      `Reply directly to respond to ${cleanName} at ${cleanEmail}.`,
    ].filter(Boolean).join('\n');

    const { data, error } = await resend.emails.send({
      from: FROM,
      to: TO,
      replyTo: cleanEmail, // hitting "Reply" in Gmail sends to the visitor
      subject: emailSubject,
      html,
      text,
    });

    if (error) {
      console.error('[contact] Resend error:', error);
      return res.status(502).json({ error: 'Failed to send message. Please email hello@clayforge.app directly.' });
    }

    console.log('[contact] Email sent:', data?.id, 'from:', cleanEmail);
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[contact] Unexpected error:', err);
    return res.status(500).json({ error: 'Server error. Please email hello@clayforge.app directly.' });
  }
}
