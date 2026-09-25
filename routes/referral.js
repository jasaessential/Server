/* ═══════════════════════════════════════════════
   JASA V2 — server/routes/referral.js

   GET  /api/referral/me
        Returns (creating it if needed) the caller's referral code, their
        referral stats and whether they can still enter someone else's code.

   POST /api/referral/apply
        Body: { code }   One code per account, ever.

   POST /api/referral/admin/void         (admin only)
        Body: { refereeUid }  Rejects a still-pending referral (fraud / mistake) so it never pays out.

   POST /api/referral/admin/backfill     (admin only)
        Body: { after? }  Generates codes for existing users that have none,
        200 users per call. Call again with the returned `after` until done.

   Auth: Authorization: Bearer <Firebase ID token>
   ═══════════════════════════════════════════════ */
'use strict';

const express = require('express');
const { db, admin } = require('../firebase');
const { verifyUser, verifyAdmin, sendError } = require('../authHelpers');
const R = require('../referralCore');

const router = express.Router();

router.get('/me', async (req, res) => {
    const user = await verifyUser(req, res);
    if (!user) return;
    try {
        const [code, cfg, summary, mine] = await Promise.all([
            R.ensureReferralCode(user.uid),
            R.getReferralConfig(),
            R.referralSummary(user.uid),
            db.collection('referrals').doc(user.uid).get(),
        ]);

        let canApply = cfg.enabled && !mine.exists;
        if (canApply && cfg.newUsersOnly) {
            canApply = (await db.collection('orders').where('userId', '==', user.uid).limit(1).get()).empty;
        }
        res.json({
            code, config: cfg, summary, canApply,
            usedCode: mine.exists ? { code: mine.data().code, status: mine.data().status } : null,
        });
    } catch (err) { sendError(res, err, 'referral/me'); }
});

router.post('/apply', async (req, res) => {
    const user = await verifyUser(req, res);
    if (!user) return;
    try {
        const out = await R.applyReferralCode(user.uid, (req.body || {}).code);
        res.json({ applied: true, ...out });
    } catch (err) { sendError(res, err, 'referral/apply'); }
});

router.post('/admin/void', async (req, res) => {
    const adminUser = await verifyAdmin(req, res);
    if (!adminUser) return;
    try {
        const uid = String((req.body || {}).refereeUid || '');
        if (!uid) return res.status(400).json({ error: 'Missing referral.' });
        const ref = db.collection('referrals').doc(uid);
        const result = await db.runTransaction(async tx => {
            const s = await tx.get(ref);
            if (!s.exists) return 'missing';
            if (s.data().status !== 'pending') return 'not-pending';
            tx.update(ref, {
                status: 'rejected', rejectedBy: adminUser.uid,
                rejectedAt: admin.firestore.FieldValue.serverTimestamp(),
            });
            return 'ok';
        });
        if (result === 'missing')     return res.status(404).json({ error: 'Referral not found.' });
        if (result === 'not-pending') return res.status(400).json({ error: 'Only pending referrals can be rejected — rewards were already paid.' });
        res.json({ ok: true });
    } catch (err) { sendError(res, err, 'referral/admin/void'); }
});

router.post('/admin/backfill', async (req, res) => {
    const adminUser = await verifyAdmin(req, res);
    if (!adminUser) return;
    try {
        const after = (req.body || {}).after;
        let q = db.collection('users').orderBy(admin.firestore.FieldPath.documentId()).limit(200);
        if (after) q = q.startAfter(String(after));
        const snap = await q.get();

        let generated = 0;
        for (const d of snap.docs) {
            if (d.data().referralCode) continue;
            try { await R.ensureReferralCode(d.id); generated++; }
            catch (e) { console.warn('[referral/backfill] skip', d.id, e.message); }
        }
        res.json({
            processed: snap.size, generated,
            after: snap.size ? snap.docs[snap.size - 1].id : null,
            done: snap.size < 200,
        });
    } catch (err) { sendError(res, err, 'referral/admin/backfill'); }
});

module.exports = router;
