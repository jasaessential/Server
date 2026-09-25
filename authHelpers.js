/* ═══════════════════════════════════════════════
   JASA V2 — server/authHelpers.js
   Shared by routes/wallet.js and routes/referral.js
   ═══════════════════════════════════════════════ */
'use strict';

const { db, admin } = require('./firebase');

/** Verifies "Authorization: Bearer <Firebase ID token>". Sends 401 and returns null on failure. */
async function verifyUser(req, res) {
    const header = req.headers.authorization || '';
    const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) { res.status(401).json({ error: 'Please sign in to continue.' }); return null; }
    try {
        return await admin.auth().verifyIdToken(token);
    } catch (_) {
        res.status(401).json({ error: 'Session expired. Please sign in again.' });
        return null;
    }
}

/** Same as verifyUser but also requires the users/{uid} doc to carry the 'admin' role. */
async function verifyAdmin(req, res) {
    const user = await verifyUser(req, res);
    if (!user) return null;
    const snap  = await db.collection('users').doc(user.uid).get();
    const d     = snap.exists ? snap.data() : {};
    const roles = d.roles || [d.role || 'user'];
    if (!roles.includes('admin')) { res.status(403).json({ error: 'Admin access required.' }); return null; }
    return user;
}

/** Error whose message is safe to show to the end user (sent as HTTP 400). */
class UserError extends Error {}
const fail = msg => { throw new UserError(msg); };

function sendError(res, err, tag) {
    if (err instanceof UserError) return res.status(400).json({ error: err.message });
    console.error(`[${tag}]`, err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
}

module.exports = { verifyUser, verifyAdmin, UserError, fail, sendError };
