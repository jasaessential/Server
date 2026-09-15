/* ═══════════════════════════════════════════════
   JASA V2 — server/routes/upload.js

   Cloudflare R2 — Product Image Upload / Delete
   ─────────────────────────────────────────────
   POST /api/upload/product-image
        Accepts a single multipart file (field: "image").
        Validates type (jpg/png/webp) and size (≤ 2 MB).
        Uploads to R2 under the key:
          products/<category>/<itemId>/<uuid>.<ext>
        Returns: { url, key }

   DELETE /api/upload/product-image
        Body: { key: "products/..." }
        Deletes the object from R2.
        Returns: { deleted: true }

   GET /api/upload/product-images
        Optional query param: ?prefix=products/<category>/
        Lists all objects (up to 1000) under the prefix.
        Returns: { objects: [{ key, url, size, lastModified }] }

   Auth: All three endpoints require x-server-secret header
         matching ADMIN_SECRET_KEY env var.
   ═══════════════════════════════════════════════ */
'use strict';

const express  = require('express');
const multer   = require('multer');
const { v4: uuidv4 } = require('uuid');
const {
    S3Client,
    PutObjectCommand,
    DeleteObjectCommand,
    ListObjectsV2Command,
} = require('@aws-sdk/client-s3');

const router = express.Router();

/* ── R2 client (S3-compatible) ─────────────────── */
function getR2Client() {
    const accountId = process.env.R2_ACCOUNT_ID;
    if (!accountId) throw new Error('R2_ACCOUNT_ID not configured');
    return new S3Client({
        region: 'auto',
        endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
        credentials: {
            accessKeyId:     process.env.R2_ACCESS_KEY_ID     || '',
            secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || '',
        },
    });
}

const BUCKET = () => process.env.R2_BUCKET_NAME || 'jasa-product-images';

/* ── Multer — memory storage, 2 MB limit ───────── */
const upload = multer({
    storage: multer.memoryStorage(),
    limits:  { fileSize: 2 * 1024 * 1024 },   // 2 MB
    fileFilter(_req, file, cb) {
        const allowed = ['image/jpeg', 'image/png', 'image/webp'];
        if (!allowed.includes(file.mimetype)) {
            // multer v2: pass an error object (not a string)
            return cb(Object.assign(new Error('Only JPEG, PNG, and WebP images are allowed.'), { code: 'INVALID_MIME' }));
        }
        cb(null, true);
    },
});

/* ── Auth middleware ───────────────────────────── */
function requireSecret(req, res, next) {
    const secret = process.env.ADMIN_SECRET_KEY;
    if (!secret) return res.status(503).json({ error: 'Server not configured.' });
    const provided = req.headers['x-server-secret'];
    if (!provided || provided !== secret) {
        return res.status(403).json({ error: 'Forbidden.' });
    }
    next();
}

/* ── MIME → extension map ──────────────────────── */
const EXT_MAP = {
    'image/jpeg': 'jpg',
    'image/png':  'png',
    'image/webp': 'webp',
};

/* ══════════════════════════════════════════════
   POST /api/upload/product-image
   ══════════════════════════════════════════════ */
router.post(
    '/product-image',
    requireSecret,
    upload.single('image'),
    async (req, res) => {
        if (!req.file) {
            return res.status(400).json({ error: 'No image file provided.' });
        }

        const { category = 'general', itemId = 'unknown' } = req.body;
        const ext = EXT_MAP[req.file.mimetype] || 'jpg';
        const key = `products/${category}/${itemId}/${uuidv4()}.${ext}`;

        try {
            const r2  = getR2Client();
            await r2.send(new PutObjectCommand({
                Bucket:      BUCKET(),
                Key:         key,
                Body:        req.file.buffer,
                ContentType: req.file.mimetype,
                // Cache 1 year — images are immutable (new key on every upload)
                CacheControl: 'public, max-age=31536000, immutable',
            }));

            const publicUrl = `${(process.env.R2_PUBLIC_URL || '').replace(/\/$/, '')}/${key}`;
            return res.status(201).json({ url: publicUrl, key });
        } catch (err) {
            console.error('[R2 Upload]', err.message);
            return res.status(500).json({ error: 'R2 upload failed: ' + err.message });
        }
    }
);

/* ══════════════════════════════════════════════
   DELETE /api/upload/product-image
   ══════════════════════════════════════════════ */
router.delete('/product-image', requireSecret, async (req, res) => {
    const { key } = req.body || {};
    if (!key || typeof key !== 'string') {
        return res.status(400).json({ error: 'key is required.' });
    }
    // Safety: only allow deleting objects inside the products/ prefix
    if (!key.startsWith('products/')) {
        return res.status(400).json({ error: 'Key must start with products/.' });
    }

    try {
        const r2 = getR2Client();
        await r2.send(new DeleteObjectCommand({ Bucket: BUCKET(), Key: key }));
        return res.json({ deleted: true, key });
    } catch (err) {
        console.error('[R2 Delete]', err.message);
        return res.status(500).json({ error: 'R2 delete failed: ' + err.message });
    }
});

/* ══════════════════════════════════════════════
   GET /api/upload/product-images
   ══════════════════════════════════════════════ */
router.get('/product-images', requireSecret, async (req, res) => {
    const prefix    = req.query.prefix || 'products/';
    const publicBase = (process.env.R2_PUBLIC_URL || '').replace(/\/$/, '');

    try {
        const r2  = getR2Client();
        const out = await r2.send(new ListObjectsV2Command({
            Bucket: BUCKET(),
            Prefix: prefix,
            MaxKeys: 1000,
        }));

        const objects = (out.Contents || []).map(obj => ({
            key:          obj.Key,
            url:          `${publicBase}/${obj.Key}`,
            size:         obj.Size,
            lastModified: obj.LastModified,
        }));

        return res.json({ objects, count: objects.length });
    } catch (err) {
        console.error('[R2 List]', err.message);
        return res.status(500).json({ error: 'R2 list failed: ' + err.message });
    }
});

/* ── Multer error handler ──────────────────────── */
router.use((err, _req, res, _next) => {
    if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'Image must be under 2 MB.' });
    }
    return res.status(400).json({ error: err.message || 'Upload error.' });
});

module.exports = router;
