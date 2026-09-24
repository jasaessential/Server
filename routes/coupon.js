/* ═══════════════════════════════════════════════
   JASA V2 — server/routes/coupon.js

   POST /api/coupon/validate
        Body: { code, subtotal, orderType, shopIds? }
        Checks every coupon rule and returns the discount
        (preview only — nothing is recorded).

   POST /api/coupon/redeem
        Body: { code, groupOrderId, subtotal, orderType, shopIds?, paymentMode? }
        Re-validates inside a transaction and writes a coupon_usages record.
        COD (default): counted immediately (status 'redeemed').
        paymentMode 'online': status 'pending', NOT counted until the payment
        is confirmed by /api/payment/verify or the Razorpay webhook
        (see couponUsage.js). Idempotent per (groupOrderId, code).

   POST /api/coupon/release
        Body: { groupOrderId }
        Undoes a usage that never became a paid/placed order.

   Auth: Authorization: Bearer <Firebase ID token>
   ═══════════════════════════════════════════════ */
'use strict';

const express = require('express');
const { db, admin } = require('../firebase');
const { releaseGroupCoupons } = require('../couponUsage');

const PENDING_WINDOW_MS = 30 * 60 * 1000;

const router = express.Router();
const FieldValue = admin.firestore.FieldValue;

async function verifyUser(req, res) {
    const header = req.headers.authorization || '';
    const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) { res.status(401).json({ error: 'Please sign in to use a coupon.' }); return null; }
    try {
        return await admin.auth().verifyIdToken(token);
    } catch (_) {
        res.status(401).json({ error: 'Session expired. Please sign in again.' });
        return null;
    }
}

const normCode = c => String(c || '').trim().toUpperCase();
const round2   = n => Math.round(n * 100) / 100;

function toDate(v) {
    if (!v) return null;
    if (typeof v.toDate === 'function') return v.toDate();
    const d = new Date(v);
    return isNaN(d) ? null : d;
}

class CouponError extends Error {}
const fail = msg => { throw new CouponError(msg); };

/* Pure rule check + discount calculation.
   `usage` = { total, perUser } counters read by the caller. */
function evaluate(coupon, { subtotal, orderType, shopIds }, usage, isFirstOrder) {
    if (!coupon.active) fail('This coupon is not active.');

    const now  = new Date();
    const from = toDate(coupon.validFrom);
    const till = toDate(coupon.validTill);
    if (from && now < from) fail('This coupon is not valid yet.');
    if (till && now > till) fail('This coupon has expired.');

    const totalLimit = Number(coupon.totalUsageLimit) || 0;
    if (totalLimit > 0 && usage.total >= totalLimit) fail('This coupon has reached its usage limit.');

    const perUserLimit = Number(coupon.perUserLimit) || 0;
    if (perUserLimit > 0 && usage.perUser >= perUserLimit) {
        fail(perUserLimit === 1
            ? 'You have already used this coupon.'
            : `You can use this coupon only ${perUserLimit} times.`);
    }

    const applicable = coupon.applicableTo || 'all';
    if (applicable !== 'all' && applicable !== orderType) {
        fail(`This coupon is valid only for ${applicable} orders.`);
    }

    const allowedShops = Array.isArray(coupon.shopIds) ? coupon.shopIds : [];
    if (allowedShops.length && !(shopIds || []).some(s => allowedShops.includes(s))) {
        fail('This coupon is not valid for the selected shop.');
    }

    if (coupon.firstOrderOnly && !isFirstOrder) fail('This coupon is valid only on your first order.');

    const minOrder = Number(coupon.minOrderAmount) || 0;
    if (subtotal < minOrder) fail(`Add items worth ₹${minOrder} or more to use this coupon.`);

    let discount = coupon.type === 'percentage'
        ? subtotal * (Number(coupon.value) || 0) / 100
        : Number(coupon.value) || 0;

    const cap = Number(coupon.maxDiscount) || 0;
    if (coupon.type === 'percentage' && cap > 0) discount = Math.min(discount, cap);
    discount = round2(Math.min(discount, subtotal));
    if (discount <= 0) fail('This coupon gives no discount on this order.');
    return discount;
}

function parseBody(req) {
    const { code, subtotal, orderType, shopIds, groupOrderId } = req.body || {};
    const c = normCode(code);
    const sub = Number(subtotal);
    if (!c) fail('Enter a coupon code.');
    if (!Number.isFinite(sub) || sub <= 0) fail('Invalid order amount.');
    return {
        code: c, subtotal: sub, groupOrderId,
        orderType: orderType === 'xerox' ? 'xerox' : 'product',
        shopIds: Array.isArray(shopIds) ? shopIds.map(String) : [],
    };
}

async function isFirstOrder(uid) {
    const snap = await db.collection('orders').where('userId', '==', uid).limit(1).get();
    return snap.empty;
}

function sendError(res, err) {
    if (err instanceof CouponError) return res.status(400).json({ error: err.message });
    console.error('[coupon]', err);
    return res.status(500).json({ error: 'Could not process the coupon. Please try again.' });
}

/* ── POST /validate ───────────────────────────── */
router.post('/validate', async (req, res) => {
    const user = await verifyUser(req, res);
    if (!user) return;
    try {
        const b    = parseBody(req);
        const snap = await db.collection('coupons').doc(b.code).get();
        if (!snap.exists) fail('Invalid coupon code.');
        const coupon = snap.data();

        const uSnap = await db.collection('coupon_user_usage').doc(`${b.code}__${user.uid}`).get();
        const usage = { total: coupon.usedCount || 0, perUser: uSnap.exists ? (uSnap.data().count || 0) : 0 };
        const first = coupon.firstOrderOnly ? await isFirstOrder(user.uid) : true;

        const discount = evaluate(coupon, b, usage, first);
        res.json({
            valid: true, code: b.code, discount,
            name: coupon.name || b.code, description: coupon.description || '',
            type: coupon.type, value: coupon.value,
            maxDiscount: coupon.maxDiscount || 0,
            minOrderAmount: coupon.minOrderAmount || 0,
        });
    } catch (err) { sendError(res, err); }
});

/* ── POST /redeem ─────────────────────────────── */
router.post('/redeem', async (req, res) => {
    const user = await verifyUser(req, res);
    if (!user) return;
    try {
        const b = parseBody(req);
        if (!b.groupOrderId) fail('Missing order reference.');

        const couponRef = db.collection('coupons').doc(b.code);
        const userRef   = db.collection('coupon_user_usage').doc(`${b.code}__${user.uid}`);
        const usageRef  = db.collection('coupon_usages').doc(`${b.groupOrderId}__${b.code}`);

        const firstNeeded = (await couponRef.get()).data()?.firstOrderOnly;
        const first = firstNeeded ? await isFirstOrder(user.uid) : true;

        /* online orders are only counted once payment is confirmed; until then the
           usage is 'pending' and this user's other pending checkouts (last 30 min)
           are treated as already used so a coupon can't be stacked before paying */
        const online = req.body?.paymentMode === 'online';
        let otherPending = 0;
        if (online) {
            const cutoff = Date.now() - PENDING_WINDOW_MS;
            const pend = await db.collection('coupon_usages')
                .where('userId', '==', user.uid).where('couponCode', '==', b.code).where('status', '==', 'pending').get();
            otherPending = pend.docs.filter(d => d.data().groupOrderId !== b.groupOrderId
                && (toDate(d.data().usedAt)?.getTime() || 0) > cutoff).length;
        }

        const discount = await db.runTransaction(async tx => {
            const [cSnap, uSnap, usageSnap] = await Promise.all([tx.get(couponRef), tx.get(userRef), tx.get(usageRef)]);
            if (!cSnap.exists) fail('Invalid coupon code.');

            if (usageSnap.exists) {
                const u = usageSnap.data();
                if (u.userId !== user.uid) fail('Invalid order reference.');
                if (u.status === 'redeemed' || u.status === 'pending') return u.discountAmount;   // idempotent retry
            }

            const coupon = cSnap.data();
            const usage  = { total: coupon.usedCount || 0, perUser: (uSnap.exists ? (uSnap.data().count || 0) : 0) + otherPending };
            const amount = evaluate(coupon, b, usage, first);

            if (!online) {
                tx.update(couponRef, { usedCount: FieldValue.increment(1), updatedAt: FieldValue.serverTimestamp() });
                tx.set(userRef, { couponCode: b.code, userId: user.uid, count: FieldValue.increment(1), lastUsedAt: FieldValue.serverTimestamp() }, { merge: true });
            }
            tx.set(usageRef, {
                couponCode: b.code, couponName: coupon.name || b.code,
                userId: user.uid, groupOrderId: b.groupOrderId,
                orderType: b.orderType, shopIds: b.shopIds,
                orderAmount: b.subtotal, discountAmount: amount,
                discountType: coupon.type, discountValue: coupon.value,
                status: online ? 'pending' : 'redeemed', usedAt: FieldValue.serverTimestamp(),
            });
            return amount;
        });

        res.json({ redeemed: true, code: b.code, discount });
    } catch (err) { sendError(res, err); }
});

/* ── POST /release ────────────────────────────── */
router.post('/release', async (req, res) => {
    const user = await verifyUser(req, res);
    if (!user) return;
    try {
        const { groupOrderId } = req.body || {};
        if (!groupOrderId) fail('Missing order reference.');

        /* A client may only undo a redemption that never became an order:
           - once payment succeeded nothing can be released
           - a counted ('redeemed') usage can be released only if no order exists for it */
        const gid  = String(groupOrderId);
        const paid = (await db.collection('payments').where('groupOrderId', '==', gid)
            .where('userId', '==', user.uid).get()).docs.some(p => p.data().status === 'paid');
        const hasOrder = !(await db.collection('orders').where('groupOrderId', '==', gid)
            .where('userId', '==', user.uid).limit(1).get()).empty;

        const released = paid ? 0 : await releaseGroupCoupons(gid, user.uid, { allowRedeemed: !hasOrder });
        res.json({ released });
    } catch (err) { sendError(res, err); }
});

module.exports = router;
