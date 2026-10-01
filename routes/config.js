/* ═══════════════════════════════════════════════
   JASA V2 — server/routes/config.js

   GET  /api/config/public
        Returns all client-safe config (Firebase,
        Cloudinary, Supabase, Worker URL, Razorpay
        key_id only — never the secret).
        This is what env-config.js fetches at boot.

   ═══════════════════════════════════════════════ */
'use strict';

const express        = require('express');

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
        r2: {
            publicUrl:  e.R2_PUBLIC_URL   || '',
            bucketName: e.R2_BUCKET_NAME  || '',
        },
    });
});

/* POST /api/config/admin-token was removed: it handed the shared ADMIN_SECRET_KEY
   to admin browsers. Admin calls now carry the user's Firebase ID token, checked by
   the Worker (verifyAdmin) and routes/upload.js.                                  */

module.exports = router;
