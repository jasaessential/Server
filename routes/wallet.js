/* ═══════════════════════════════════════════════
   JASA V2 — server/routes/wallet.js

   POST /api/wallet/redeem
        Body: { groupOrderId, orderTotal, orderType, paymentMode? }
        Re-computes how much wallet money this order may use (admin limits in
        config/wallet) and debits it. COD → 'redeemed'; paymentMode 'online' →
        'pending' (held until /api/payment/verify or the webhook confirms).
        Idempotent per groupOrderId.

   POST /api/wallet/release
        Body: { groupOrderId }   Gives a hold back when checkout never became an order.

   POST /api/wallet/sync
        Credits cashback for Delivered orders, refunds the wallet share of
        Cancelled orders, pays referral rewards, frees stale holds.
        Safe to call any time — every credit has a deterministic id.

   POST /api/wallet/admin/adjust        (admin only)
        Body: { uid, amount (+credit / −debit), note }

   Auth: Authorization: Bearer <Firebase ID token>
   ═══════════════════════════════════════════════ */
'use strict';

const express = require('express');
const { db } = require('../firebase');
const { verifyUser, verifyAdmin, sendError, fail } = require('../authHelpers');
const W = require('../walletCore');
const { processReferral } = require('../referralCore');

const router = express.Router();

router.post('/redeem', async (req, res) => {
    const user = await verifyUser(req, res);
    if (!user) return;
    try {
        const { groupOrderId, orderTotal, orderType, paymentMode } = req.body || {};
        const amount = await W.holdWallet(user.uid, {
            groupOrderId, orderTotal, orderType: orderType === 'xerox' ? 'xerox' : 'product',
            online: paymentMode === 'online',
        });
        res.json({ redeemed: true, amount });
    } catch (err) { sendError(res, err, 'wallet/redeem'); }
});

router.post('/release', async (req, res) => {
    const user = await verifyUser(req, res);
    if (!user) return;
    try {
        const gid = W.safeId((req.body || {}).groupOrderId);
        if (!gid) fail('Missing order reference.');

        /* same rule as coupons: nothing can be released once paid, and a counted
           ('redeemed') hold only if no order was ever created for it */
        const paid = (await db.collection('payments').where('groupOrderId', '==', gid)
            .where('userId', '==', user.uid).get()).docs.some(p => p.data().status === 'paid');
        const hasOrder = !(await db.collection('orders').where('groupOrderId', '==', gid)
            .where('userId', '==', user.uid).limit(1).get()).empty;

        const released = paid ? 0 : await W.releaseGroupWallet(gid, user.uid, { allowRedeemed: !hasOrder });
        res.json({ released });
    } catch (err) { sendError(res, err, 'wallet/release'); }
});

router.post('/sync', async (req, res) => {
    const user = await verifyUser(req, res);
    if (!user) return;
    try {
        const cfg = await W.getWalletConfig();
        const staleReleased = await W.releaseStaleHolds(user.uid);
        const orders = await W.loadUserOrders(user.uid);
        const { cashback, refunded } = await W.settleOrders(user.uid, orders, cfg);
        let referral = null;
        try { referral = await processReferral(user.uid, orders); }
        catch (e) { console.error('[wallet/sync] referral:', e.message); }

        const w = await db.collection('wallets').doc(user.uid).get();
        res.json({
            balance: W.round2(w.exists ? w.data().balance : 0),
            cashback, refunded, staleReleased, referral,
        });
    } catch (err) { sendError(res, err, 'wallet/sync'); }
});

router.post('/admin/adjust', async (req, res) => {
    const admin = await verifyAdmin(req, res);
    if (!admin) return;
    try {
        const { uid, amount, note } = req.body || {};
        const amt = W.round2(amount);
        if (!uid || typeof uid !== 'string') fail('Choose a user.');
        if (!amt) fail('Enter a non-zero amount.');
        if (Math.abs(amt) > 100000) fail('Amount is too large.');
        if (!String(note || '').trim()) fail('A reason is required for manual adjustments.');
        if (!(await db.collection('users').doc(uid).get()).exists) fail('User not found.');

        const r = await W.postTxn(uid, {
            id: `admin__${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            amount: amt, source: 'admin_adjust', refId: admin.uid,
            note: String(note).trim().slice(0, 200),
        });
        res.json({ ok: true, balance: r.balance });
    } catch (err) { sendError(res, err, 'wallet/admin/adjust'); }
});

module.exports = router;
