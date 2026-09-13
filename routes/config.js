/* ═══════════════════════════════════════════════
   JASA V2 — server/routes/config.js

   GET  /api/config/public
        Returns all client-safe config (Firebase,
        Cloudinary, Supabase, Worker URL, Razorpay
        key_id only — never the secret).
        This is what env-config.js fetches at boot.

   POST /api/config/admin-token
        Verifies a Firebase ID token and returns
        the ADMIN_SECRET_KEY only if the user has
        the 'admin' role in their Firestore profile.
   ═══════════════════════════════════════════════ */
'use strict';

const express        = require('express');
const { verifyIdToken, getDb } = require('../firebase');

const router = express.Router();

/* ── GET /api/config/public ─────────────────── */
router.get('/public', (_req, res) => {
    const e = process.env;
    res.json({
        firebase: {
            apiKey:            e.FIREBASE_API_KEY            || '',
            authDomain:        e.FIREBASE_AUTH_DOMAIN        || '',
            projectId:         e.FIREBASE_PROJECT_ID         || '',
            storageBucket:     e.FIREBASE_STORAGE_BUCKET     || '',
            messagingSenderId: e.FIREBASE_MESSAGING_SENDER_ID || '',
            appId:             e.FIREBASE_APP_ID             || '',
            measurementId:     e.FIREBASE_MEASUREMENT_ID     || '',
        },
        cloudinary: {
            cloudName:    e.CLOUDINARY_CLOUD_NAME    || '',
            uploadPreset: e.CLOUDINARY_UPLOAD_PRESET || '',
            apiKey:       e.CLOUDINARY_API_KEY       || '',
        },
        supabase: {
            url:     e.SUPABASE_URL      || '',
            anonKey: e.SUPABASE_ANON_KEY || '',
        },
        workerUrl:     e.WORKER_URL        || '',
        razorpayKeyId: e.RAZORPAY_KEY_ID && !e.RAZORPAY_KEY_ID.includes('XXXX')
                        ? e.RAZORPAY_KEY_ID
                        : null,
    });
});

/* ── POST /api/config/admin-token ────────────── */
router.post('/admin-token', async (req, res) => {
    const { idToken } = req.body || {};
    if (!idToken) return res.status(400).json({ error: 'idToken required.' });

    try {
        // 1. Verify Firebase ID token
        const decoded = await verifyIdToken(idToken);

        // 2. Check admin role in Firestore users/{uid}
        const db   = getDb();
        const snap = await db.collection('users').doc(decoded.uid).get();
        if (!snap.exists) return res.status(403).json({ error: 'User not found.' });

        const data  = snap.data();
        const roles = data.roles || (data.role ? [data.role] : []);

        if (!roles.includes('admin')) {
            return res.status(403).json({ error: 'Access denied. Admin role required.' });
        }

        // 3. Return ADMIN_SECRET_KEY — never logs this value
        const adminKey = process.env.ADMIN_SECRET_KEY;
        if (!adminKey) return res.status(503).json({ error: 'Admin key not configured.' });

        return res.json({
            token:     adminKey,
            expiresIn: 3600,   // hint to the client to re-fetch after 1 hour
        });

    } catch (err) {
        console.error('[admin-token]', err.message);
        return res.status(401).json({ error: 'Token verification failed.' });
    }
});

module.exports = router;
