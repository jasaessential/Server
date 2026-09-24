/* ═══════════════════════════════════════════════
   JASA V2 — server/couponUsage.js

   Lifecycle of a coupon_usages record:
     COD order      : created as 'redeemed' (counted immediately)
     online order   : created as 'pending'  (not counted yet)
                      → confirmGroupCoupons() on payment success  → 'redeemed' (counted)
                      → releaseGroupCoupons() on failure/cancel   → 'released' (never counted)

   Counters that change only on confirmation:
     coupons/{CODE}.usedCount
     coupon_user_usage/{CODE}__{uid}.count
   ═══════════════════════════════════════════════ */
'use strict';

const { db, admin } = require('./firebase');
const FieldValue = admin.firestore.FieldValue;

async function usagesForGroup(groupOrderId, uid) {
    let q = db.collection('coupon_usages').where('groupOrderId', '==', String(groupOrderId));
    if (uid) q = q.where('userId', '==', uid);
    return (await q.get()).docs;
}

/** Payment succeeded: count every pending usage of this checkout. Idempotent. */
async function confirmGroupCoupons(groupOrderId) {
    if (!groupOrderId) return 0;
    let confirmed = 0;
    for (const d of await usagesForGroup(groupOrderId)) {
        if (d.data().status !== 'pending') continue;
        const done = await db.runTransaction(async tx => {
            const fresh = await tx.get(d.ref);
            if (!fresh.exists || fresh.data().status !== 'pending') return false;
            const u = fresh.data();
            tx.update(db.collection('coupons').doc(u.couponCode), {
                usedCount: FieldValue.increment(1),
                updatedAt: FieldValue.serverTimestamp(),
            });
            tx.set(db.collection('coupon_user_usage').doc(`${u.couponCode}__${u.userId}`), {
                couponCode: u.couponCode, userId: u.userId,
                count: FieldValue.increment(1), lastUsedAt: FieldValue.serverTimestamp(),
            }, { merge: true });
            tx.update(d.ref, { status: 'redeemed', confirmedAt: FieldValue.serverTimestamp() });
            return true;
        });
        if (done) confirmed++;
    }
    return confirmed;
}

/** Payment failed / cancelled / order aborted. Pending → released; redeemed → counters reversed. */
async function releaseGroupCoupons(groupOrderId, uid, { allowPending = true, allowRedeemed = true } = {}) {
    if (!groupOrderId) return 0;
    const allowed = s => (s === 'pending' && allowPending) || (s === 'redeemed' && allowRedeemed);
    let released = 0;
    for (const d of await usagesForGroup(groupOrderId, uid)) {
        if (!allowed(d.data().status)) continue;
        const done = await db.runTransaction(async tx => {
            const fresh = await tx.get(d.ref);
            if (!fresh.exists) return false;
            const u = fresh.data();
            if (!allowed(u.status)) return false;
            if (u.status === 'redeemed') {
                tx.update(db.collection('coupons').doc(u.couponCode), { usedCount: FieldValue.increment(-1) });
                tx.set(db.collection('coupon_user_usage').doc(`${u.couponCode}__${u.userId}`),
                    { count: FieldValue.increment(-1) }, { merge: true });
            }
            tx.update(d.ref, { status: 'released', releasedAt: FieldValue.serverTimestamp() });
            return true;
        });
        if (done) released++;
    }
    return released;
}

module.exports = { confirmGroupCoupons, releaseGroupCoupons };
