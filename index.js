/* ═══════════════════════════════════════════════
   JASA V2 — Payment Server (Express)
   ═══════════════════════════════════════════════ */
'use strict';

require('dotenv').config();

const express      = require('express');
const cors         = require('cors');
const paymentRoute = require('./routes/payment');
const configRoute  = require('./routes/config');
const uploadRoute  = require('./routes/upload');
const couponRoute  = require('./routes/coupon');

const app  = express();
const PORT = process.env.PORT || 3001;

/* ── CORS ─────────────────────────────────────────
   In development we allow all localhost/127.0.0.1
   origins regardless of port so any local dev
   server (Live Server, Vite, etc.) works.
   In production only the listed origins are allowed.
   ─────────────────────────────────────────────── */
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map(o => o.trim().replace(/\/+$/, ''))  // strip trailing slashes
    .filter(Boolean);

const isDev = process.env.NODE_ENV !== 'production';

app.use(cors({
    origin: (origin, cb) => {
        // No origin = server-to-server or curl — always allow
        if (!origin) return cb(null, true);

        // Dev: allow any localhost / 127.0.0.1 origin
        if (isDev && (
            origin.startsWith('http://localhost:') ||
            origin.startsWith('http://127.0.0.1:')
        )) return cb(null, true);

        // Production: check against allow-list
        if (allowedOrigins.includes(origin)) return cb(null, true);

        cb(new Error(`CORS: origin ${origin} not allowed`));
    },
    methods:      ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-server-secret'],
    credentials:  true,
}));

/* ── Raw body for webhook (must be before express.json) ── */
app.use('/api/payment/webhook', express.raw({ type: 'application/json' }));

/* ── JSON body for everything else ── */
app.use(express.json());

/* ── Routes ── */
app.use('/api/payment', paymentRoute);
app.use('/api/config',  configRoute);
app.use('/api/upload',  uploadRoute);
app.use('/api/coupon',  couponRoute);

/* ── Health check ── */
app.get('/health', (_req, res) => res.json({ status: 'ok', ts: Date.now() }));

/* ── 404 ── */
app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

/* ── Global error handler ──────────────────────
   Always add CORS header so the browser can read
   the error body even on 500s.
   ─────────────────────────────────────────────── */
app.use((err, req, res, _next) => {
    const origin = req.headers.origin || '';
    if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
    console.error('[Server Error]', err.message);
    res.status(500).json({ error: err.message || 'Internal server error' });
});

app.listen(PORT, () => {
    console.log(`JASA Payment Server running on port ${PORT}`);
    console.log(`Mode: ${isDev ? 'development (all localhost origins allowed)' : 'production'}`);
    console.log(`Allowed origins: ${allowedOrigins.join(', ') || '(none listed)'}`);
});

module.exports = app;
