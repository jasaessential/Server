/* ═══════════════════════════════════════════════
   JASA V2 — server/settle.js
   Scheduled clean-up, so money doesn't wait for a customer to open the app.

   settleAll():
     1. Online checkouts left unpaid for 30+ min → orders Cancelled, coupon /
        wallet holds released (the browser does this on dismiss; this catches
        closed tabs and failed payments).
     2. For every customer with something to settle — a pending wallet hold,
        a recent Delivered order not yet checked for cashback, a recent
        Cancelled order with an unrefunded wallet share, or a pending
        referral — run the same steps as POST /api/wallet/sync.

   Runs every 15 min inside the server (index.js) and on
   POST /api/wallet/settle-all (x-server-secret), which the Cloudflare
   Worker cron calls so it also runs after Render has been asleep.
   ═══════════════════════════════════════════════ */
'use strict';

const { db, admin } = require('./firebase');
const W = require('./walletCore');
const { releaseGroupCoupons } = require('./couponUsage');
const { processReferral } = require('./referralCore');

const ABANDON_AFTER_MS = 30 * 60 * 1000;
const LOOKBACK_MS      = 60 * 24 * 60 * 60 * 1000;   // orders older than 60 days are left alone

const ms = t => t?.toMillis?.() || 0;

/** Cancel online checkouts that were never paid. Returns the number of orders cancelled. */
async function cancelAbandonedCheckouts() {
    const cutoff = Date.now() - ABANDON_AFTER_MS;
    /* Pending orders only — a small, bounded set (active orders) */
    const snap = await db.collection('orders').where('status', '==', 'Pending').get();
    const groups = new Map();
    for (const d of snap.docs) {
        const o = d.data();
        if (!['razorpay', 'partial'].includes(o.paymentMethod)) continue;
        if (!['pending', 'failed'].includes(o.paymentStatus)) continue;
        if (!ms(o.createdAt) || ms(o.createdAt) > cutoff) continue;
        if (!groups.has(o.groupOrderId)) groups.set(o.groupOrderId, []);
        groups.get(o.groupOrderId).push(d);
    }

    const FV = admin.firestore.FieldValue;
    let cancelled = 0;
    for (const [gid, docs] of groups) {
        const paid = (await db.collection('payments').where('groupOrderId', '==', gid).get())
            .docs.some(p => p.data().status === 'paid');
        if (paid) continue;   // verify/webhook will (or did) mark these paid

        const batch = db.batch();
        for (const d of docs) {
            batch.set(d.ref, { status: 'Cancelled', paymentStatus: 'abandoned', cancelledAt: FV.serverTimestamp() }, { merge: true });
            batch.set(db.collection('order_status').doc(d.id),
                { status: 'Cancelled', paymentStatus: 'abandoned', updatedAt: FV.serverTimestamp(), lastUpdatedBy: 'system' }, { merge: true });
            cancelled++;
        }
        await batch.commit();
        try { await releaseGroupCoupons(gid, null, { allowRedeemed: false }); } catch (e) { console.error('[settle] coupon release:', e.message); }
        try { await W.releaseGroupWallet(gid, null, { allowRedeemed: false }); } catch (e) { console.error('[settle] wallet release:', e.message); }
    }
    return cancelled;
}

/** Customers with a pending hold, unsettled recent order or pending referral */
async function usersToSettle() {
    const uids = new Set();
    (await db.collection('wallet_usages').where('status', '==', 'pending').get())
        .docs.forEach(d => d.data().userId && uids.add(d.data().userId));

    const since = admin.firestore.Timestamp.fromMillis(Date.now() - LOOKBACK_MS);
    (await db.collection('orders').where('createdAt', '>=', since).get()).docs.forEach(d => {
        const o = d.data();
        if (!o.userId) return;
        const status = String(o.status || '').toLowerCase();
        if (status === 'delivered' && o.cashbackCredited == null) uids.add(o.userId);
        if (W.isCancelled(o) && W.num(o.walletAmount) > 0 && !o.walletRefunded) uids.add(o.userId);
    });

    (await db.collection('referrals').where('status', '==', 'pending').get())
        .docs.forEach(d => uids.add(d.id));
    return [...uids];
}

let running = false;

async function settleAll() {
    if (running) return { skipped: true };
    running = true;
    const started = Date.now();
    try {
        const abandoned = await cancelAbandonedCheckouts();
        const cfg  = await W.getWalletConfig();
        const uids = await usersToSettle();
        let cashback = 0, refunded = 0, released = 0, referrals = 0, failed = 0;
        for (const uid of uids) {
            try {
                released += await W.releaseStaleHolds(uid);
                const orders = await W.loadUserOrders(uid);
                const r = await W.settleOrders(uid, orders, cfg);
                cashback += r.cashback; refunded += r.refunded;
                if (await processReferral(uid, orders)) referrals++;
            } catch (e) {
                failed++;
                console.error('[settle] user', uid, e.message);
            }
        }
        const result = { abandoned, users: uids.length, cashback: W.round2(cashback), refunded: W.round2(refunded),
                         released, referrals, failed, ms: Date.now() - started };
        console.log('[settle]', JSON.stringify(result));
        return result;
    } finally {
        running = false;
    }
}

module.exports = { settleAll, cancelAbandonedCheckouts };
