/* ═══════════════════════════════════════════════
   JASA V2 — Order quote route
   POST /api/orders/quote
     Body: { groupOrderId, type: 'product' | 'xerox', isPickup,
             groups: [{ shopId, items | documents }] }
     → prices every line on the server, works out each shop's delivery fee and
       saves the result in order_quotes/{groupOrderId}.
     ← { groups: [{ shopId, items | documents, subtotal, deliveryFee }], subtotal, deliveryFee }

   POST /api/orders/cancel-item   { orderId, index }       — customer removes a pending line
   POST /api/orders/attach-file   { orderId, index, ... }  — customer adds a file after ordering

   Firestore rules only accept an order whose items/documents, subtotal and
   deliveryFee equal this quote, and the coupon / wallet routes take their
   amounts from it, so the browser never decides what anything costs.
   ═══════════════════════════════════════════════ */
'use strict';

const express = require('express');
const { db, admin } = require('../firebase');
const { verifyUser, sendError, fail } = require('../authHelpers');
const P = require('../pricing');

const router = express.Router();
const r2 = n => Math.round(n * 100) / 100;

const quoteId = gid => String(gid || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);

router.post('/quote', async (req, res) => {
    const user = await verifyUser(req, res);
    if (!user) return;
    try {
        const { groupOrderId, type, isPickup, groups } = req.body || {};
        const gid = quoteId(groupOrderId);
        if (!gid) fail('Missing order reference.');
        const isXerox = type === 'xerox';
        if (!Array.isArray(groups) || !groups.length || groups.length > 20) fail('Nothing to order.');
        if (isXerox && groups.length !== 1) fail('A xerox order goes to one shop.');

        const ref  = db.collection('order_quotes').doc(gid);
        const prev = await ref.get();
        if (prev.exists && prev.data().userId !== user.uid) fail('Invalid order reference.');
        if (!(await db.collection('orders').where('groupOrderId', '==', gid).limit(1).get()).empty) {
            fail('This checkout was already placed. Please refresh and try again.');
        }

        const shopIds = [...new Set(groups.map(g => String(g?.shopId || '')))];
        if (shopIds.length !== groups.length || shopIds.some(id => !id)) fail('Invalid shop.');
        const realIds   = shopIds.filter(id => id !== 'unknown');
        const shopSnaps = realIds.length ? await db.getAll(...realIds.map(id => db.collection('shops').doc(id))) : [];
        const shops     = Object.fromEntries(shopSnaps.map(s => [s.id, s.exists ? s.data() : null]));
        const xeroxGlobal = isXerox ? await P.loadGlobalXeroxConfig() : null;

        const out = [];
        for (const g of groups) {
            const shopId = String(g.shopId);
            const shop   = shops[shopId];
            if (shopId !== 'unknown' && !shop) fail('A selected shop no longer exists.');
            if (isXerox && !shop) fail('Please choose a xerox shop.');

            let lines, subtotal;
            if (isXerox) {
                ({ documents: lines, subtotal } = P.priceXeroxDocuments(g.documents, P.shopXeroxConfig(shop, xeroxGlobal)));
            } else {
                ({ items: lines, subtotal } = await P.priceProductGroup(g.items));
            }
            const rules = shop?.deliveryPrices?.[isXerox ? 'xerox' : 'others'];
            out.push({
                shopId,
                [isXerox ? 'documents' : 'items']: lines,
                subtotal,
                deliveryFee: P.deliveryFee(rules, subtotal, !!isPickup),
            });
        }

        const quote = {
            userId:      user.uid,
            groupOrderId: gid,
            type:        isXerox ? 'xerox' : 'product',
            isPickup:    !!isPickup,
            groups:      Object.fromEntries(out.map(g => [g.shopId, g])),
            subtotal:    r2(out.reduce((s, g) => s + g.subtotal, 0)),
            deliveryFee: r2(out.reduce((s, g) => s + g.deliveryFee, 0)),
            createdAt:   admin.firestore.FieldValue.serverTimestamp(),
        };
        await ref.set(quote);
        res.json({ groups: out, subtotal: quote.subtotal, deliveryFee: quote.deliveryFee });
    } catch (err) { sendError(res, err, 'orders/quote'); }
});

/* ─────────────────────────────────────────────
   Customer changes to a placed order. Firestore rules don't let customers
   edit items, documents or amounts (a list can't be summed in rules), so
   these two run here and recompute the totals from the stored lines.
   ───────────────────────────────────────────── */
const isPendingStatus = s => !s || String(s).toLowerCase() === 'pending';

/* POST /api/orders/cancel-item  { orderId, index }
   Removes one still-pending line from a Pending order. Cancels the order when
   nothing is left. Not allowed once a coupon, wallet money or an online payment
   is tied to the order (those need a refund — support handles them).         */
router.post('/cancel-item', async (req, res) => {
    const user = await verifyUser(req, res);
    if (!user) return;
    try {
        const { orderId, index } = req.body || {};
        const ref = db.collection('orders').doc(String(orderId || '_'));
        const FV  = admin.firestore.FieldValue;
        const result = await db.runTransaction(async tx => {
            const snap = await tx.get(ref);
            if (!snap.exists || snap.data().userId !== user.uid) fail('Order not found.');
            const o = snap.data();
            if (!isPendingStatus(o.status)) fail('Cannot cancel — the shop has already started on this order.');
            if (Number(o.discountAmount) > 0) fail('This order used a coupon, so items cannot be removed individually. Please contact support.');
            if (Number(o.walletAmount) > 0)   fail('This order was partly paid from your wallet, so items cannot be removed individually. Please contact support.');
            if (['paid', 'partial_paid'].includes(o.paymentStatus)) fail('This order is already paid. Please contact support to cancel an item.');

            const field = o.type === 'xerox' ? 'documents' : 'items';
            let list    = Array.isArray(o[field]) ? [...o[field]] : [];
            const i     = Number(index);
            if (!Number.isInteger(i) || i < 0 || i >= list.length) fail('Item not found.');
            if (!isPendingStatus(list[i]?.status)) fail('Cannot cancel — the shop has already started on this item.');
            /* A combined book's binding charge moves to another file of the book first */
            if (field === 'documents') list = P.moveBookCharge(list.map((d, j) => j === i ? { ...d, status: 'cancelled' } : d));
            list.splice(i, 1);

            if (!list.length) {
                tx.update(ref, { status: 'Cancelled', cancelledAt: FV.serverTimestamp() });
                tx.set(db.collection('order_status').doc(ref.id),
                    { status: 'Cancelled', updatedAt: FV.serverTimestamp(), lastUpdatedBy: 'user' }, { merge: true });
                return { orderCancelled: true };
            }
            const subtotal = r2(list.reduce((s, l) => s + (Number(l.price) || 0) * (field === 'items' ? (Number(l.qty) || 1) : 1), 0));
            const totalAmount = r2(subtotal + (Number(o.deliveryFee) || 0));
            tx.update(ref, { [field]: list, subtotal, totalAmount, balanceDue: totalAmount, updatedAt: FV.serverTimestamp() });
            return { orderCancelled: false, subtotal, totalAmount };
        });
        res.json(result);
    } catch (err) { sendError(res, err, 'orders/cancel-item'); }
});

/* POST /api/orders/attach-file  { orderId, index, uploadStatus: 'uploaded' | 'whatsapp', uploadedUrl? }
   Records a file the customer uploaded (or will send on WhatsApp) after ordering.
   Only uploadedUrl / uploadStatus of that one document change.               */
router.post('/attach-file', async (req, res) => {
    const user = await verifyUser(req, res);
    if (!user) return;
    try {
        const { orderId, index, uploadStatus, uploadedUrl } = req.body || {};
        if (!['uploaded', 'whatsapp'].includes(uploadStatus)) fail('Invalid upload status.');
        const url = uploadStatus === 'whatsapp' ? 'pending_whatsapp' : String(uploadedUrl || '');
        if (uploadStatus === 'uploaded' && (!/^https:\/\/[^\s]+$/.test(url) || url.length > 1000)) fail('Invalid file link.');

        const ref = db.collection('orders').doc(String(orderId || '_'));
        await db.runTransaction(async tx => {
            const snap = await tx.get(ref);
            if (!snap.exists || snap.data().userId !== user.uid) fail('Order not found.');
            const o = snap.data();
            if (['cancelled', 'canceled', 'rejected'].includes(String(o.status || '').toLowerCase())) fail('This order was cancelled.');
            const docs = Array.isArray(o.documents) ? [...o.documents] : [];
            const i    = Number(index);
            if (!Number.isInteger(i) || i < 0 || i >= docs.length) fail('Document not found.');
            docs[i] = { ...docs[i], uploadedUrl: url, uploadStatus };
            tx.update(ref, { documents: docs, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
        });
        res.json({ ok: true });
    } catch (err) { sendError(res, err, 'orders/attach-file'); }
});

/** The caller's quote for a checkout, or null. Used by coupon and wallet redeem. */
async function getQuote(groupOrderId, uid) {
    const gid = quoteId(groupOrderId);
    if (!gid) return null;
    const s = await db.collection('order_quotes').doc(gid).get();
    return s.exists && s.data().userId === uid ? s.data() : null;
}

module.exports = router;
module.exports.getQuote = getQuote;
