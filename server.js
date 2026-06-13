const express = require('express');
const path = require('path');
const compression = require('compression');
const helmet = require('helmet');
const { Resend } = require('resend');

const app = express();
const PORT = process.env.PORT || 3000;

// Security & performance
app.use(helmet({
  contentSecurityPolicy: false, // Allow inline styles for SSR
  crossOriginEmbedderPolicy: false
}));
app.use(compression());
app.use(express.urlencoded({ extended: true }));
app.use(express.json({ limit: '10mb' }));

// Static files
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '1h',
  etag: true
}));

// View engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Shared template data
const siteData = {
  siteName: 'Ridgeline Finance OS',
  siteTitle: 'Ridgeline Finance OS',
  legalName: 'Ridgeline Foods, Inc.',
  tagline: 'Agentic finance and accounting command center. First loop: freight accrual.',
  belief: 'Everyone can do what AI practitioners do — with the right training, the right tools, and the right partner.',
  founder: 'Ore Phillips',
  year: new Date().getFullYear(),
  links: {
    myaiforone: 'https://myaiforone.com',
    finney: 'https://finney.finance',
    substack: 'https://orephillips.substack.com',
    slack: '#', // TBD
    booking: 'https://calendly.com/ore-agenticledger/30min',
    linkedin: '#' // TBD
  }
};

// ─── Finance OS — operational surfaces + run actions (persisted) ──
const financeOsRouter = require('./routes/financeOs');
const fosApiRouter = require('./routes/fosApi');
app.use('/api/fos', fosApiRouter);
app.use('/', financeOsRouter);

app.get('/marketing/services', (req, res) => {
  res.render('services', {
    ...siteData,
    pageTitle: 'Services — Orphil',
    pageDescription: 'AI Strategy & Planning, Advisory, and Execution services for finance, accounting, and consulting firms. From roadmaps to deployed agents.',
    canonicalUrl: '/services',
    pageType: 'Service'
  });
});

app.get('/product', (req, res) => {
  res.render('product', {
    ...siteData,
    pageTitle: 'myaiforone — Orphil',
    pageDescription: 'myaiforone is a local AI operating system — specialized AI agents running on your computer, powered by your own AI subscription. Zero platform fees. Full data privacy.',
    canonicalUrl: '/product',
    pageType: 'Product'
  });
});

app.get('/resources', (req, res) => {
  res.render('resources', {
    ...siteData,
    pageTitle: 'Resources — Orphil',
    pageDescription: 'Free resources for finance professionals exploring AI. finney.finance knowledge base, AI in Finance Slack community, and original writing.',
    canonicalUrl: '/resources',
    pageType: 'WebPage'
  });
});

app.get('/about', (req, res) => {
  res.render('about', {
    ...siteData,
    pageTitle: 'About — Orphil',
    pageDescription: 'Ore Phillips Advisory (dba Orphil LLC) was founded to help finance, accounting, and consulting firms navigate AI transformation with the right training, tools, and partner.',
    canonicalUrl: '/about',
    pageType: 'AboutPage'
  });
});

app.get('/contact', (req, res) => {
  res.render('contact', {
    ...siteData,
    pageTitle: 'Contact — Orphil',
    pageDescription: 'Get in touch with Orphil. Schedule a conversation about AI transformation for your finance, accounting, or consulting firm.',
    canonicalUrl: '/contact',
    pageType: 'ContactPage'
  });
});

app.post('/contact', async (req, res) => {
  const { name, email, company, message } = req.body;

  try {
    const resend = new Resend(process.env.RESEND_API_KEY);

    await resend.emails.send({
      from: 'Orphil Website <onboarding@resend.dev>',
      replyTo: email,
      to: 'ore@agenticledger.ai',
      subject: `New inquiry from ${name}${company ? ` (${company})` : ''}`,
      html: `<h3>New Contact Form Submission</h3>
<p><strong>Name:</strong> ${name}</p>
<p><strong>Email:</strong> ${email}</p>
<p><strong>Firm:</strong> ${company || 'Not provided'}</p>
<hr>
<p>${message.replace(/\n/g, '<br>')}</p>`
    });
  } catch (err) {
    console.error('Email send failed:', err.message);
  }

  res.render('contact', {
    ...siteData,
    pageTitle: 'Contact — Orphil',
    pageDescription: 'Get in touch with Orphil.',
    canonicalUrl: '/contact',
    pageType: 'ContactPage',
    formSuccess: true
  });
});

// AI discoverability endpoints
app.get('/robots.txt', (req, res) => {
  res.type('text/plain').send(`User-agent: *
Allow: /

Sitemap: https://orphiladvisory.com/sitemap.xml
`);
});

app.get('/sitemap.xml', (req, res) => {
  const baseUrl = 'https://orphiladvisory.com';
  const pages = ['/', '/services', '/product', '/resources', '/about', '/contact'];
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${pages.map(p => `  <url>
    <loc>${baseUrl}${p}</loc>
    <changefreq>${p === '/' ? 'weekly' : 'monthly'}</changefreq>
    <priority>${p === '/' ? '1.0' : '0.8'}</priority>
  </url>`).join('\n')}
</urlset>`;
  res.type('application/xml').send(xml);
});

// llms.txt — AI agent discovery
app.get('/llms.txt', (req, res) => {
  res.type('text/plain').send(`# Orphil LLC
> Ore Phillips Advisory (dba Orphil LLC) — AI Transformation Partner for Finance, Accounting & Consulting Firms

## About
Orphil helps finance, accounting, and consulting firms adopt AI with confidence. Founded by Ore Phillips, we provide Strategy & Planning, Advisory, and Execution services — from AI roadmaps to deployed agents and applications.

## Services
- Strategy & Planning: AI training, transformation roadmaps, resourcing & staff augmentation
- Advisory: Specialist AI counsel, governance & oversight, community & thought leadership
- Execution: AI transformation delivery, agent development, application development

## Delivery Models
- Project: Fixed scope, defined deliverable
- Retainer: Ongoing monthly advisory + delivery
- Embedded: Fractional CAIO — attend meetings, own the AI roadmap

## Product
- myaiforone: Local AI operating system — agents on your computer, your AI subscription, zero platform fees. https://myaiforone.com

## Resources
- finney.finance: Open-source finance AI knowledge base (wiki, news, guides, tools, jobs)
- AI in Finance Slack: Practitioner community
- Substack: https://orephillips.substack.com

## Core Belief
Everyone can do what AI practitioners do — with the right training, the right tools, and the right partner.

## Links
- Website: https://orphiladvisory.com
- Product: https://myaiforone.com
- Knowledge Base: https://finney.finance
- Substack: https://orephillips.substack.com
`);
});

// ─── Admin Login ───────────────────────────────────────────────────
const { generateToken, ADMIN_PASSWORD } = require('./middleware/adminAuth');

app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (!password || password !== ADMIN_PASSWORD) {
    return res.status(401).json({ ok: false, error: 'Invalid password' });
  }
  res.json({ ok: true, data: { token: generateToken() } });
});

// ─── Agent Platform API Routes ─────────────────────────────────────
const agentsRouter = require('./routes/agents');
const chatRouter = require('./routes/chat');
const agentDocumentsRouter = require('./routes/agentDocuments');
const agentMemoryRouter = require('./routes/agentMemory');
const capabilitiesRouter = require('./routes/capabilities');
const agentCapabilitiesRouter = require('./routes/agentCapabilities');
const llmConfigRouter = require('./routes/llmConfig');
const settingsRouter = require('./routes/settings');

app.use('/api/agents', agentsRouter);
app.use('/api/chat', chatRouter);
app.use('/api/agents', agentDocumentsRouter);
app.use('/api/agents', agentMemoryRouter);
app.use('/api/capabilities', capabilitiesRouter);
app.use('/api/agents', agentCapabilitiesRouter);
app.use('/api/llm-config', llmConfigRouter);
app.use('/api/settings', settingsRouter);

// ─── Chat page (SSR) ──────────────────────────────────────────────
// Chat now lives at /agents — keep /chat as a redirect so old links work.
app.get('/chat', (req, res) => {
  const agent = req.query.agent ? '?agent=' + encodeURIComponent(req.query.agent) : '';
  res.redirect('/agents' + agent);
});

// ─── Admin panel (SSR) ────────────────────────────────────────────
app.get('/admin', (req, res) => {
  res.render('admin', {
    ...siteData,
    pageTitle: 'Admin — Orphil',
    pageDescription: 'Orphil platform administration.',
    canonicalUrl: '/admin',
    pageType: 'WebPage'
  });
});

// Health check for Railway
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Global error handler — returns JSON for API, HTML for pages
app.use((err, req, res, next) => {
  console.error(`[ERROR] ${req.method} ${req.path}:`, err.message, err.stack?.split('\n').slice(0, 3).join('\n'));
  if (req.path.startsWith('/api/')) {
    return res.status(500).json({ ok: false, error: err.message || 'Internal server error' });
  }
  res.status(500).send('Internal Server Error');
});

// 404
app.use((req, res) => {
  res.status(404).render('404', {
    ...siteData,
    pageTitle: 'Page Not Found — Orphil',
    pageDescription: 'The page you are looking for does not exist.',
    canonicalUrl: req.path,
    pageType: 'WebPage'
  });
});

app.listen(PORT, () => {
  console.log(`Ridgeline Finance OS running on port ${PORT} — http://localhost:${PORT}`);
  seedDefaultAgent();
  bootSupervision();
});

// Ensure every process has its Owner Agent and start proactive supervision.
async function bootSupervision() {
  try {
    const { backfillOwnerAgents } = require('./services/accrual/processAgentService');
    const out = await backfillOwnerAgents({ refresh: false });
    const provisioned = out.filter((o) => o.status !== 'already-owned');
    if (provisioned.length) console.log('Owner agents provisioned:', provisioned.map((o) => o.slug).join(', '));
  } catch (e) {
    console.error('Owner-agent backfill failed (non-critical):', e.message);
  }
  try {
    const { startScheduler } = require('./services/accrual/supervisorService');
    startScheduler({ intervalMs: 15 * 60 * 1000 });
  } catch (e) {
    console.error('Supervisor scheduler failed to start (non-critical):', e.message);
  }
}

// ─── Startup Seed ─────────────────────────────────────────────────
async function seedDefaultAgent() {
  try {
    const prisma = require('./services/db');
    const count = await prisma.agent.count({ where: { isActive: true } });
    if (count > 0) return; // Already has agents

    await prisma.agent.create({
      data: {
        name: 'Orphil Advisory',
        slug: 'orphil-advisory',
        description: 'AI assistant for Orphil LLC — answers questions about AI transformation services for finance, accounting, and consulting firms.',
        instructions: `You are the Orphil AI Advisory assistant. You represent Ore Phillips Advisory (dba Orphil LLC), an AI Transformation Partner for Finance, Accounting & Consulting Firms.

Your role:
- Answer questions about Orphil's services: Strategy & Planning, Advisory, and Execution
- Explain the fractional CAIO (Chief AI Officer) engagement model
- Describe the myaiforone product — a local AI operating system
- Share info about free resources: finney.finance, AI in Finance Slack, Substack at orephillips.substack.com
- Guide visitors toward booking a conversation with Ore Phillips

Key facts about Orphil:
- Founded by Ore Phillips
- Serves finance, accounting, and consulting firms
- Three service tiers: Strategy & Planning | Advisory | Execution
- Delivery models: Project (fixed scope), Retainer (ongoing monthly), Embedded (fractional CAIO)
- Core belief: "Everyone can do what AI practitioners do — with the right training, the right tools, and the right partner."
- Booking link: https://calendly.com/ore-agenticledger/30min
- Email: ore@agenticledger.ai
- Website: https://orphiladvisory.com

Be helpful, professional, and concise. If asked about pricing, invite them to book a discovery call.`,
        defaultModel: null,
        features: {},
      },
    });

    console.log('Default Orphil Advisory agent seeded successfully');
  } catch (err) {
    console.error('Seed error (non-critical):', err.message);
  }
}
