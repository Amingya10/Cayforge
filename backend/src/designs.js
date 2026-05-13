const express = require('express');
const { PrismaClient } = require('@prisma/client');
const Anthropic = require('@anthropic-ai/sdk');
const OpenAI = require('openai');
const cloudinary = require('cloudinary').v2;
// Configure Cloudinary explicitly from env vars
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true,
});
const jwt = require('jsonwebtoken');
const auth = function (req, res, next) {
  try {
    const header = req.headers.authorization;
    if (!header) return res.status(401).json({ error: 'Not authenticated' });
    const parts = header.split(' ');
    if (parts.length !== 2 || parts[0] !== 'Bearer') {
      return res.status(401).json({ error: 'Invalid authorization header' });
    }
    const decoded = jwt.verify(parts[1], process.env.JWT_SECRET);
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
const router = express.Router();
const prisma = new PrismaClient();

// AI clients
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Plan limits (designs per 30-day period)
const PLAN_LIMITS = {
  FREE: 3,
  STONEWARE: 25,
  PORCELAIN: 100,
};

// ---- Helper: refresh quota window if 30 days have passed ----
async function refreshQuotaIfNeeded(user) 
{// Auto-downgrade if cancelled period has ended
  if (user.cancelAt && new Date() >= new Date(user.cancelAt)) {
    await prisma.user.update({
      where: { id: user.id },
      data: {
        plan: 'FREE',
        cancelAt: null,
        designsThisPeriod: 0,
        quotaResetAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
      }
    });
    user.plan = 'FREE';
    user.cancelAt = null;
  }
  const now = new Date();
  if (now >= user.quotaResetAt) {
    const newReset = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    return await prisma.user.update({
      where: { id: user.id },
      data: { designsThisPeriod: 0, quotaResetAt: newReset },
    });
  }
  return user;
}

// ---- GET /api/designs - list current user's designs ----
router.get('/', auth, async (req, res) => {
  try {
    const designs = await prisma.design.findMany({
      where: { userId: req.user.userId },
      orderBy: { createdAt: 'desc' },
    });
    res.json(designs);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- GET /api/designs/:id - fetch single design ----
router.get('/:id', auth, async (req, res) => {
  try {
    const design = await prisma.design.findUnique({ where: { id: req.params.id } });
    if (!design) return res.status(404).json({ error: 'Design not found' });
    if (design.userId !== req.user.userId) {
      return res.status(403).json({ error: 'Not your design' });
    }
    res.json(design);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- GET /api/designs/quota/status - check remaining quota ----
router.get('/quota/status', auth, async (req, res) => {
  try {
    let user = await prisma.user.findUnique({ where: { id: req.user.userId } });
    if (!user) return res.status(404).json({ error: 'User not found' });

    user = await refreshQuotaIfNeeded(user);

    const limit = PLAN_LIMITS[user.plan] || PLAN_LIMITS.FREE;
    const remaining = Math.max(0, limit - user.designsThisPeriod);

    res.json({
      plan: user.plan,
      used: user.designsThisPeriod,
      limit,
      remaining,
      resetsAt: user.quotaResetAt,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- POST /api/designs/generate - the main AI generation flow ----
router.post('/generate', auth, async (req, res) => {
  try {
    const { prompt, title } = req.body;

    if (!prompt || typeof prompt !== 'string' || prompt.trim().length < 5) {
      return res.status(400).json({ error: 'Prompt must be at least 5 characters' });
    }
    if (prompt.length > 1000) {
      return res.status(400).json({ error: 'Prompt too long (max 1000 chars)' });
    }

    // Load user, refresh quota if needed
    let user = await prisma.user.findUnique({ where: { id: req.user.userId } });
    if (!user) return res.status(404).json({ error: 'User not found' });
    user = await refreshQuotaIfNeeded(user);

    // Hard block at limit
    const limit = PLAN_LIMITS[user.plan] || PLAN_LIMITS.FREE;
    if (user.designsThisPeriod >= limit) {
      return res.status(403).json({
        error: 'Quota exceeded',
        message: `You've used all ${limit} designs in this period. Upgrade your plan or wait until ${user.quotaResetAt.toISOString()}.`,
        plan: user.plan,
        used: user.designsThisPeriod,
        limit,
        resetsAt: user.quotaResetAt,
      });
    }

    // ---- Step 1: Claude generates rich design specification ----
    const claudeResp = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content: `You are a master ceramicist designing a custom pottery piece. Based on the user's request below, produce a structured design specification in JSON format with these exact fields:
{
  "name": "short evocative name for the piece",
  "form": "the shape and silhouette (vase, bowl, vessel, etc.)",
  "dimensions": "approximate height and width",
  "clayBody": "type of clay (stoneware, porcelain, earthenware, etc.)",
  "glaze": "glaze description and color palette",
  "surfaceTreatment": "texture, carving, or finishing details",
  "firingMethod": "how it should be fired (oxidation, reduction, raku, etc.)",
  "imagePrompt": "a single richly detailed photographic prompt suitable for an image generator, emphasizing studio lighting, clean background, and ceramic authenticity"
}

Respond with only the JSON object, no preamble or commentary.

User request: ${prompt}`,
        },
      ],
    });

    // Extract Claude's response
    const claudeText =
      claudeResp.content && claudeResp.content[0] && claudeResp.content[0].text
        ? claudeResp.content[0].text.trim()
        : '';

    let designSpec;
    try {
      // Strip code fences if Claude added any
      const cleaned = claudeText.replace(/^```json\s*|\s*```$/g, '').replace(/^```\s*|\s*```$/g, '');
      designSpec = JSON.parse(cleaned);
    } catch (parseErr) {
      console.error('Claude returned non-JSON:', claudeText);
      return res.status(502).json({
        error: 'AI design generation failed',
        message: 'Could not parse design specification. Please try a different prompt.',
      });
    }

    if (!designSpec.imagePrompt) {
      return res.status(502).json({ error: 'Design spec missing image prompt' });
    }

    // ---- Step 2: DALL-E 3 generates the visual ----
    const imageResp = await openai.images.generate({
      model: 'dall-e-3',
      prompt: designSpec.imagePrompt,
      n: 1,
      size: '1024x1024',
      quality: 'standard',
    });

    const tempImageUrl = imageResp.data && imageResp.data[0] ? imageResp.data[0].url : null;
if (!tempImageUrl) {
  return res.status(502).json({ error: 'Image generation failed' });
}

// Upload to Cloudinary for permanent storage
let imageUrl = tempImageUrl;
try {
  const uploadResult = await cloudinary.uploader.upload(tempImageUrl, {
    folder: 'clayforge',
    resource_type: 'image',
  });
  imageUrl = uploadResult.secure_url;
} catch (cloudErr) {
  console.error('Cloudinary upload failed, using temp URL:', cloudErr.message);
  // Fall back to temp URL if Cloudinary fails — not ideal but won't break generation
}

    // ---- Step 3: Save design + increment quota in single transaction ----
    const designTitle = title && title.trim().length > 0 ? title.trim() : designSpec.name || 'Untitled design';

    const [design] = await prisma.$transaction([
      prisma.design.create({
        data: {
          title: designTitle,
          userId: user.id,
          content: {
            prompt,
            spec: designSpec,
            imageUrl,
            imageUrlExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
            generatedAt: new Date().toISOString(),
            modelText: 'claude-sonnet-4-5',
            modelImage: 'dall-e-3',
          },
        },
      }),
      prisma.user.update({
        where: { id: user.id },
        data: { designsThisPeriod: { increment: 1 } },
      }),
    ]);

    res.json({
      design,
      quota: {
        plan: user.plan,
        used: user.designsThisPeriod + 1,
        limit,
        remaining: limit - user.designsThisPeriod - 1,
        resetsAt: user.quotaResetAt,
      },
      warning: 'Image URL expires in 1 hour. Save the image locally if needed.',
    });
  } catch (e) {
    console.error('Design generation error:', e);

    // Surface meaningful errors back to the client
    if (e.status === 401 || /api[_-]?key/i.test(e.message || '')) {
      return res.status(500).json({ error: 'AI service authentication failed' });
    }
    if (e.status === 429) {
      return res.status(429).json({ error: 'AI service rate limit exceeded, try again shortly' });
    }
    if (/quota|billing|insufficient[_-]?credit/i.test(e.message || '')) {
      return res.status(503).json({ error: 'AI service credits exhausted, contact support' });
    }

    res.status(500).json({ error: 'Generation failed', detail: e.message });
  }
});

// ---- DELETE /api/designs/:id - remove a design ----
router.delete('/:id', auth, async (req, res) => {
  try {
    const design = await prisma.design.findUnique({ where: { id: req.params.id } });
    if (!design) return res.status(404).json({ error: 'Design not found' });
    if (design.userId !== req.user.userId) {
      return res.status(403).json({ error: 'Not your design' });
    }
    await prisma.design.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
