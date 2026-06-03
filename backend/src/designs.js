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

// Plan names and quota limits live in one place (./plans.js)
const { planLimit, DEFAULT_PLAN } = require('./plans');

// ---- Helper: refresh quota window if 30 days have passed ----
async function refreshQuotaIfNeeded(user) 
{// Auto-downgrade if cancelled period has ended
  if (user.cancelAt && new Date() >= new Date(user.cancelAt)) {
    await prisma.user.update({
      where: { id: user.id },
      data: {
        plan: DEFAULT_PLAN,
        cancelAt: null,
        designsThisPeriod: 0,
        quotaResetAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
      }
    });
    user.plan = DEFAULT_PLAN;
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
// ---- GET /api/designs/public - public showcase, no auth ----
router.get('/public', async (req, res) => {
  try {
    const designs = await prisma.design.findMany({
      orderBy: { createdAt: 'desc' },
      take: 12,
    });

    // Only return safe public fields - never expose userId or full content blob
    const publicDesigns = designs
      .filter(d => {
        const url = d.content && d.content.imageUrl;
        // Only include designs with permanent Cloudinary URLs
        return url && url.includes('res.cloudinary.com');
      })
      .map(d => ({
        id: d.id,
        title: d.title,
        createdAt: d.createdAt,
        imageUrl: d.content.imageUrl,
        prompt: d.content.prompt,
        spec: {
          name: d.content.spec?.name,
          form: d.content.spec?.form,
          dimensions: d.content.spec?.dimensions,
          clayBody: d.content.spec?.clayBody,
          glaze: d.content.spec?.glaze,
          surfaceTreatment: d.content.spec?.surfaceTreatment,
          firingMethod: d.content.spec?.firingMethod,
        },
      }));

    res.json(publicDesigns);
  } catch (e) {
    console.error('Public gallery fetch error:', e);
    res.status(500).json({ error: 'Failed to load gallery' });
  }
});
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

    const limit = planLimit(user.plan);
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
    const limit = planLimit(user.plan);
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

   // ---- Step 2: gpt-image-1 generates the visual ----
    // (DALL-E 3 was deprecated by OpenAI on May 12, 2026)
    const imageResp = await openai.images.generate({
      model: 'gpt-image-1',
      prompt: designSpec.imagePrompt,
      n: 1,
      size: '1024x1024',
    });

    // gpt-image-1 returns base64-encoded image data, not a URL
    const b64Image = imageResp.data && imageResp.data[0] ? imageResp.data[0].b64_json : null;
    if (!b64Image) {
      return res.status(502).json({ error: 'Image generation failed' });
    }

    // Upload base64 image to Cloudinary for permanent hosted URL
    let imageUrl = null;
    try {
      const uploadResult = await cloudinary.uploader.upload(
        `data:image/png;base64,${b64Image}`,
        { folder: 'clayforge', resource_type: 'image' }
      );
      imageUrl = uploadResult.secure_url;
    } catch (cloudErr) {
      console.error('Cloudinary upload failed:', cloudErr.message);
      return res.status(502).json({ 
        error: 'Image storage failed',
        message: 'Image was generated but could not be saved. Please try again.'
      });
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
            modelImage: 'gpt-image-1',
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
