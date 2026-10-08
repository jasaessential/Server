/* ═══════════════════════════════════════════════
   JASA V2 — server/routes/files.js
   Customer files (xerox documents, poster photos) in the private Supabase
   bucket "files". Browsers never get a Supabase key: this route holds the
   service-role key and hands out short-lived signed URLs after checking who
   is asking.

   POST /api/files/upload-url  { kind: 'xerox' | 'poster' | 'order', name, orderId? }
        → { uploadUrl, fileUrl }   PUT the file body to uploadUrl; store fileUrl.
   POST /api/files/view-url    { orderId, url }   or (admin)  { path }
        → { url }  signed for 15 min. Allowed for the order's customer, admins,
          and sellers / employees of the order's shop (same as firestore.rules).
   GET  /api/files/list?prefix=     (admin)  → { files: [{ name, fullPath, created_at, metadata }] }
   POST /api/files/delete  { paths } (admin) → { deleted }

   Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (secret — server only)
   ═══════════════════════════════════════════════ */
'use strict';

const express = require('express');
const { db } = require('../firebase');
const { verifyUser, verifyAdmin, sendError, fail } = require('../authHelpers');

const router = express.Router();

const BUCKET      = 'files';
const VIEW_TTL_S  = 15 * 60;
const sbUrl = () => (process.env.SUPABASE_URL || '').replace(/\/+$/, '');

async function sb(path, init = {}) {
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!sbUrl() || !key) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not configured');
    const res = await fetch(`${sbUrl()}/storage/v1${path}`, {
        ...init,
        headers: { Authorization: `Bearer ${key}`, apikey: key, 'Content-Type': 'application/json', ...(init.headers || {}) },
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Supabase ${res.status}: ${body.message || body.error || 'request failed'}`);
    return body;
}

const encPath   = p => p.split('/').map(encodeURIComponent).join('/');
const cleanName = n => String(n || 'file').replace(/[^a-zA-Z0-9.\-_]/g, '_').slice(-120) || 'file';
const safeId    = s => String(s || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 128);

/** The object path inside "files" for any link we ever stored (public / sign / bare). */
function pathFromUrl(url) {
    const m = String(url || '').match(/\/storage\/v1\/object\/(?:public\/|sign\/|authenticated\/)?files\/([^?#]+)/);
    if (!m) return null;
    const p = decodeURIComponent(m[1]);
    return p.split('/').some(seg => !seg || seg === '..' || seg === '.') ? null : p;
}

/** The canonical link stored on orders (not fetchable once the bucket is private). */
const fileUrlFor = path => `${sbUrl()}/storage/v1/object/public/${BUCKET}/${encPath(path)}`;

async function rolesOf(uid) {
    const s = await db.collection('users').doc(uid).get();
    const d = s.exists ? s.data() : {};
    return d.roles || [d.role || 'user'];
}

/** Mirrors the orders read rule: owner, admin, or seller/employee of the order's shop. */
async function canReadOrder(uid, order) {
    if (order.userId === uid) return true;
    const roles = await rolesOf(uid);
    if (roles.includes('admin')) return true;
    if (!roles.includes('seller') && !roles.includes('employee')) return false;
    if (!order.shopId) return false;
    const shop = await db.collection('shops').doc(String(order.shopId)).get();
    const sd = shop.exists ? shop.data() : {};
    return (sd.owners || []).includes(uid) || (sd.employees || []).includes(uid);
}

/** Paths of every file attached to an order (xerox documents and custom poster photos). */
function orderFilePaths(order) {
    const links = [
        ...(order.documents || []).map(d => d?.uploadedUrl),
        ...(order.items || []).map(i => i?.customPhoto),
    ];
    return new Set(links.map(pathFromUrl).filter(Boolean));
}

router.post('/upload-url', async (req, res) => {
    const user = await verifyUser(req, res);
    if (!user) return;
    try {
        const { kind, name, orderId } = req.body || {};
        const file = `${Date.now()}_${cleanName(name)}`;
        let path;
        if (kind === 'xerox')       path = `xerox-uploads/${user.uid}/${file}`;
        else if (kind === 'poster') path = `poster-uploads/${user.uid}/${file}`;
        else if (kind === 'order') {
            const id = safeId(orderId);
            const snap = id && await db.collection('orders').doc(id).get();
            if (!snap || !snap.exists || snap.data().userId !== user.uid) fail('Order not found.');
            path = `xerox-orders/${id}/${file}`;
        } else fail('Invalid upload type.');

        const { url } = await sb(`/object/upload/sign/${BUCKET}/${encPath(path)}`, { method: 'POST', body: '{}' });
        res.json({ uploadUrl: `${sbUrl()}/storage/v1${url}`, fileUrl: fileUrlFor(path) });
    } catch (err) { sendError(res, err, 'files/upload-url'); }
});

router.post('/view-url', async (req, res) => {
    const user = await verifyUser(req, res);
    if (!user) return;
    try {
        const { orderId, url, path: rawPath } = req.body || {};
        let path;
        if (rawPath) {
            // Admin storage browser — no order context
            if (!(await rolesOf(user.uid)).includes('admin')) fail('File not found.');
            path = pathFromUrl(`/storage/v1/object/files/${rawPath}`);
        } else {
            path = pathFromUrl(url);
            const id = safeId(orderId);
            const snap = path && id && await db.collection('orders').doc(id).get();
            if (!snap || !snap.exists) fail('File not found.');
            const order = snap.data();
            if (!orderFilePaths(order).has(path) || !(await canReadOrder(user.uid, order))) fail('File not found.');
        }
        if (!path) fail('File not found.');

        const { signedURL } = await sb(`/object/sign/${BUCKET}/${encPath(path)}`,
            { method: 'POST', body: JSON.stringify({ expiresIn: VIEW_TTL_S }) });
        res.json({ url: `${sbUrl()}/storage/v1${signedURL}` });
    } catch (err) { sendError(res, err, 'files/view-url'); }
});

/* ── Admin storage browser (admin-cloud.html) ── */
async function listRecursive(prefix, depth = 0) {
    if (depth > 4) return [];
    const items = await sb(`/object/list/${BUCKET}`, {
        method: 'POST',
        body: JSON.stringify({ prefix, limit: 1000, offset: 0, sortBy: { column: 'name', order: 'asc' } }),
    });
    let out = [];
    for (const it of items) {
        if (it.name === '.emptyFolderPlaceholder') continue;
        if (!it.id) out = out.concat(await listRecursive(`${prefix}${it.name}/`, depth + 1));
        else out.push({ name: it.name, fullPath: prefix + it.name, created_at: it.created_at, metadata: { size: it.metadata?.size } });
    }
    return out;
}

router.get('/list', async (req, res) => {
    if (!(await verifyAdmin(req, res))) return;
    try {
        const prefix = String(req.query.prefix || '').replace(/^\/+/, '');
        res.json({ files: await listRecursive(prefix && !prefix.endsWith('/') ? `${prefix}/` : prefix) });
    } catch (err) { sendError(res, err, 'files/list'); }
});

router.post('/delete', async (req, res) => {
    if (!(await verifyAdmin(req, res))) return;
    try {
        const paths = (req.body?.paths || []).map(p => pathFromUrl(`/storage/v1/object/files/${p}`)).filter(Boolean);
        if (!paths.length || paths.length > 500) fail('Choose 1–500 files.');
        const deleted = await sb(`/object/${BUCKET}`, { method: 'DELETE', body: JSON.stringify({ prefixes: paths }) });
        res.json({ deleted: Array.isArray(deleted) ? deleted.length : 0 });
    } catch (err) { sendError(res, err, 'files/delete'); }
});

module.exports = { router, pathFromUrl };
