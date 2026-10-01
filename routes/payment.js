/* ═══════════════════════════════════════════════
   JASA V2 — Payment Routes
   POST /api/payment/create-order   → Razorpay order + save pending payment in Firestore
   POST /api/payment/verify         → verify signature + update Firestore order status
   POST /api/payment/webhook        → Razorpay webhook (server-side event backup)
   GET  /api/payment/key            → expose Razorpay key_id to frontend safely
   ═══════════════════════════════════════════════ */
'use strict';

const express   = require('express');
const crypto    = require('crypto');
const { getRazorpay } = require('../razorpay');
const { db, admin } = require('../firebase');
const { confirmGroupCoupons, releaseGroupCoupons } = require('../couponUsage');
const { confirmGroupWallet, releaseGroupWallet } = require('../walletCore');

const router = express.Router();

/* ─────────────────────────────────────────────
   HELPER — verify Firebase ID token from header
   Authorization: Bearer <idToken>
   ───────────────────────────────────────────── */
async function verifyUser(req, res) {
    const header = req.headers.authorization || '';
    const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) {
        res.status(401).json({ error: 'Missing auth token' });
        return null;
    }
    try {
        const decoded = await admin.auth().verifyIdToken(token);
        return decoded;
    } catch (e) {
        res.status(401).json({ error: 'Invalid or expired auth token' });
        return null;
    }
}

/* ─────────────────────────────────────────────
   HELPER — recompute what the customer owes from the
   order docs already in Firestore, so the charged amount
   is never taken on the client's word alone.

   Checks (returns an error string, or null when OK):
   • every order exists, belongs to the caller and to this group
   • no order is already paid
   • subtotal − discount − wallet + delivery === totalAmount per order
   • any discount is backed by a server-written coupon_usages
     record (see routes/coupon.js) for this user + group
   • any wallet amount is backed by a wallet_usages hold (routes/wallet.js)
   • the requested amount equals the full total, or — only in
     'partial_online' mode — the configured online deposit of it

   Returns { error } or { kind: 'full' | 'deposit', orderTotals }.
   ───────────────────────────────────────────── */
async function verifyOrderAmount({ uid, trusted, groupOrderId, orderIds, amount }) {
    const snaps = await db.getAll(...orderIds.map(id => db.collection('orders').doc(String(id))));
    const fail  = error => ({ error });

    let total = 0, discount = 0, wallet = 0, couponCode = null;
    const orderTotals = {};
    for (const s of snaps) {
        if (!s.exists) return fail('Order not found.');
        const o = s.data();
        if (!trusted && o.userId !== uid) return fail('Order does not belong to you.');
        if (o.groupOrderId !== groupOrderId) return fail('Order does not match this checkout.');
        if (o.paymentStatus === 'paid' || o.paymentStatus === 'partial_paid') return fail('Order is already paid.');

        const sub = Number(o.subtotal) || 0;
        const fee = Number(o.deliveryFee) || 0;
        const dis = Number(o.discountAmount) || 0;
        const wal = Number(o.walletAmount) || 0;
        const tot = Number(o.totalAmount) || 0;
        if (dis < 0 || wal < 0 || Math.abs(sub - dis - wal + fee - tot) > 0.01) return fail('Order total does not add up.');

        if (dis > 0) {
            if (!o.couponCode || (couponCode && couponCode !== o.couponCode)) return fail('Invalid coupon on order.');
            couponCode = o.couponCode;
        }
        orderTotals[s.id] = tot;
        total    += tot;
        discount += dis;
        wallet   += wal;
    }

    if (discount > 0) {
        const uSnap = await db.collection('coupon_usages').doc(`${groupOrderId}__${couponCode}`).get();
        const u = uSnap.exists ? uSnap.data() : null;
        if (!u || (u.status !== 'redeemed' && u.status !== 'pending') || (!trusted && u.userId !== uid)) return fail('Coupon was not redeemed for this order.');
        if (Math.abs(u.discountAmount - discount) > 0.05) return fail('Coupon discount does not match.');
    }

    if (wallet > 0) {
        const wSnap = await db.collection('wallet_usages').doc(String(groupOrderId)).get();
        const w = wSnap.exists ? wSnap.data() : null;
        if (!w || (w.status !== 'redeemed' && w.status !== 'pending') || (!trusted && w.userId !== uid)) return fail('Wallet was not reserved for this order.');
        if (Math.abs(w.amount - wallet) > 0.05) return fail('Wallet amount does not match.');
    }

    const cfgSnap = await db.collection('config').doc('payment').get();
    const cfg     = cfgSnap.exists ? cfgSnap.data() : {};
    const pct     = Number(cfg.onlineDepositPercent) || 30;
    const deposit = Math.ceil(total * pct / 100);
    const a = Number(amount);
    if (Math.abs(a - total) <= 0.01) return { kind: 'full', orderTotals };
    if (Math.abs(a - deposit) <= 1.01) {
        if ((cfg.mode || 'both') !== 'partial_online') return fail('A deposit payment is not allowed right now. Please pay the full amount.');
        return { kind: 'deposit', orderTotals };
    }
    return fail(`Amount mismatch — expected ₹${total.toFixed(2)}${cfg.mode === 'partial_online' ? ` (or ${pct}% deposit ₹${deposit})` : ''}.`);
}

/* ─────────────────────────────────────────────
   HELPER — what each order of a paid checkout records.
   A deposit is split across the group's orders in proportion to their
   totals (the last order takes the rounding remainder).
   ───────────────────────────────────────────── */
function paidShares(payData, paidINR) {
    const totals = payData.orderTotals || {};
    const ids    = payData.firestoreOrderIds || [];
    const sum    = ids.reduce((s, id) => s + (Number(totals[id]) || 0), 0);
    const r2     = n => Math.round(n * 100) / 100;
    const full   = payData.kind !== 'deposit';
    let left = paidINR;
    return ids.map((id, i) => {
        const tot  = Number(totals[id]) || 0;
        const paid = full ? tot
            : i === ids.length - 1 ? r2(left)
            : r2(sum > 0 ? paidINR * tot / sum : paidINR / ids.length);
        left -= paid;
        return {
            id,
            paymentStatus: full ? 'paid' : 'partial_paid',
            amountPaid:    paid,
            balanceDue:    full ? 0 : Math.max(0, r2(tot - paid)),
        };
    });
}

/* Mark a checkout paid on its payment record, orders and order_status docs.
   Shared by /verify and the payment.captured webhook.                      */
async function markGroupPaid(payData, rzpOrderId, { paymentId, amountPaise, method, signature, webhook }) {
    const FV    = admin.firestore.FieldValue;
    if (!payData.orderTotals) {
        /* Payment created before kind/orderTotals were recorded — read them from the orders */
        const ids   = payData.firestoreOrderIds || [];
        const snaps = ids.length ? await db.getAll(...ids.map(id => db.collection('orders').doc(String(id)))) : [];
        const orderTotals = {};
        snaps.forEach(s => { orderTotals[s.id] = Number(s.exists && s.data().totalAmount) || 0; });
        const sum = Object.values(orderTotals).reduce((a, b) => a + b, 0);
        payData = { ...payData, orderTotals,
                    kind: (Number(amountPaise) || 0) / 100 < sum - 0.01 ? 'deposit' : 'full' };
    }
    const batch = db.batch();
    batch.update(db.collection('payments').doc(rzpOrderId), {
        razorpayPaymentId: paymentId,
        ...(signature ? { razorpaySignature: signature } : {}),
        status:            'paid',
        paidAmountPaise:   amountPaise,
        paidAt:            FV.serverTimestamp(),
        updatedAt:         FV.serverTimestamp(),
        method:            method || 'unknown',
        ...(webhook ? { webhookProcessed: true } : {}),
    });
    for (const s of paidShares(payData, (Number(amountPaise) || payData.amountPaise) / 100)) {
        batch.set(db.collection('orders').doc(s.id), {
            paymentStatus:     s.paymentStatus,
            amountPaid:        s.amountPaid,
            balanceDue:        s.balanceDue,
            razorpayPaymentId: paymentId,
            paidAt:            FV.serverTimestamp(),
            updatedAt:         FV.serverTimestamp(),
        }, { merge: true });
        batch.set(db.collection('order_status').doc(s.id), {
            paymentStatus: s.paymentStatus,
            updatedAt:     FV.serverTimestamp(),
        }, { merge: true });
    }
    await batch.commit();
}

/* ─────────────────────────────────────────────
   GET /api/payment/key
   Returns Razorpay key_id (safe to expose).
   Returns null if Razorpay not yet configured.
   ───────────────────────────────────────────── */
router.get('/key', (_req, res) => {
    const keyId = process.env.RAZORPAY_KEY_ID;
    const configured = keyId && !keyId.includes('XXXX');
    res.json({
        key:        configured ? keyId : null,
        configured: !!configured,
    });
});

/* ─────────────────────────────────────────────
   POST /api/payment/create-order
   Body: {
     amount:        number   (in INR — will be converted to paise)
     groupOrderId:  string   (JASA-XXXXXX)
     firestoreOrderIds: string[]  (Firestore doc IDs of the placed orders)
     notes?: object
   }
   Returns: { orderId, amount, currency, key }
   ───────────────────────────────────────────── */
router.post('/create-order', async (req, res) => {
    /* 1. Auth — accept Firebase ID token OR a server-side secret for trusted calls */
    let uid = null;
    let trusted = false;
    const serverSecret = req.headers['x-server-secret'];
    if (serverSecret && serverSecret === process.env.SERVER_SECRET) {
        // Trusted server-to-server call: uid comes from body
        uid = req.body.userId || 'server';
        trusted = true;
    } else {
        const user = await verifyUser(req, res);
        if (!user) return;
        uid = user.uid;
    }

    /* Support both field names:
       - jasaOrderIds  (sent by cart.js frontend)
       - firestoreOrderIds (direct API calls) */
    const {
        amount,
        groupOrderId,
        jasaOrderIds,
        firestoreOrderIds,
        userEmail = '',
        userName  = 'Customer',
        notes     = {},
    } = req.body;

    const orderIds = jasaOrderIds || firestoreOrderIds || [];

    if (!amount || isNaN(amount) || Number(amount) <= 0) {
        return res.status(400).json({ error: 'Invalid amount' });
    }
    if (!groupOrderId) {
        return res.status(400).json({ error: 'groupOrderId is required' });
    }
    if (!Array.isArray(orderIds) || orderIds.length === 0) {
        return res.status(400).json({ error: 'jasaOrderIds must be a non-empty array' });
    }

    const amountPaise = Math.round(Number(amount) * 100); // INR → paise

    if (amountPaise < 100) {
        return res.status(400).json({ error: 'Amount must be at least ₹1 (100 paise)' });
    }


    try {
        const check = await verifyOrderAmount({
            uid, trusted, groupOrderId, orderIds: [...new Set(orderIds)], amount,
        });
        if (check.error) {
            console.warn('[create-order] rejected:', check.error, { uid, groupOrderId, amount });
            return res.status(400).json({ error: check.error });
        }

        const safeStr = (str) => String(str || '').replace(/[^\x20-\x7E]/g, '').substring(0, 40);
        const cleanNotes = {
            groupOrderId: safeStr(groupOrderId || 'unknown'),
            userId:       safeStr(uid || 'guest'),
            userName:     safeStr(userName || 'Customer')
        };
        console.log('[create-order] passing notes:', cleanNotes);

        /* 2. Create Razorpay order */
        const rzpOrder = await getRazorpay().orders.create({
            amount:   amountPaise,
            currency: 'INR',
            receipt:  String(groupOrderId || 'unknown').substring(0, 40),
            notes:    cleanNotes,
        });

        /* 3. Write pending payment record to Firestore */
        const batch = db.batch();

        const paymentRef = db.collection('payments').doc(rzpOrder.id);
        batch.set(paymentRef, {
            razorpayOrderId:   rzpOrder.id,
            groupOrderId,
            firestoreOrderIds: orderIds,
            userId:            uid,
            userName,
            userEmail,
            amountINR:         Number(amount),
            amountPaise,
            kind:              check.kind,          // 'full' | 'deposit'
            orderTotals:       check.orderTotals,   // per order, to split a deposit
            currency:          'INR',
            status:            'created',      // created → paid / failed
            createdAt:         admin.firestore.FieldValue.serverTimestamp(),
            updatedAt:         admin.firestore.FieldValue.serverTimestamp(),
        });

        /* 4. Stamp each Firestore order with razorpayOrderId + paymentStatus */
        for (const ordId of orderIds) {
            batch.set(db.collection('orders').doc(ordId), {
                razorpayOrderId: rzpOrder.id,
                paymentStatus:   'pending',
                paymentMethod:   check.kind === 'deposit' ? 'partial' : 'razorpay',
                updatedAt:       admin.firestore.FieldValue.serverTimestamp(),
            }, { merge: true });
        }

        await batch.commit();

        /* Return field names matching what cart.js expects */
        return res.json({
            razorpayOrderId: rzpOrder.id,  // cart.js destructures this
            orderId:         rzpOrder.id,  // alias
            amount:          rzpOrder.amount,
            currency:        rzpOrder.currency,
            keyId:           process.env.RAZORPAY_KEY_ID,  // cart.js destructures keyId
            key:             process.env.RAZORPAY_KEY_ID,  // alias
        });

    } catch (err) {
        console.error('[create-order]', err);
        return res.status(500).json({ error: 'Failed to create payment order', details: err.message || err.error?.description || String(err) });
    }
});

/* ─────────────────────────────────────────────
   POST /api/payment/verify
   Body: {
     razorpay_order_id:   string
     razorpay_payment_id: string
     razorpay_signature:  string
   }
   On success: updates Firestore orders → paymentStatus: 'paid'
   ───────────────────────────────────────────── */
router.post('/verify', async (req, res) => {
    /* 1. Auth — accept Firebase ID token OR server secret */
    let uid = null;
    const serverSecret = req.headers['x-server-secret'];
    if (serverSecret && serverSecret === process.env.SERVER_SECRET) {
        uid = req.body.jasaOrder?.userId || 'server';
    } else {
        const user = await verifyUser(req, res);
        if (!user) return;
        uid = user.uid;
    }

    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
        return res.status(400).json({ error: 'Missing payment fields' });
    }

    /* 2. Verify HMAC-SHA256 signature */
    const body      = `${razorpay_order_id}|${razorpay_payment_id}`;
    const expected  = crypto
        .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
        .update(body)
        .digest('hex');

    if (expected !== razorpay_signature) {
        console.warn('[verify] Signature mismatch for order', razorpay_order_id);
        return res.status(400).json({ error: 'Payment verification failed — invalid signature' });
    }

    /* 3. Fetch payment record from Firestore */
    try {
        const paySnap = await db.collection('payments').doc(razorpay_order_id).get();
        if (!paySnap.exists) {
            return res.status(404).json({ error: 'Payment record not found' });
        }
        const payData = paySnap.data();

        /* Security: ensure payment belongs to authenticated user (skip for server-secret calls) */
        if (!serverSecret && payData.userId !== uid) {
            return res.status(403).json({ error: 'Forbidden' });
        }

        /* 4. Fetch payment details from Razorpay to get the actual amount */
        const rzpPayment = await getRazorpay().payments.fetch(razorpay_payment_id);
        if (rzpPayment.order_id !== razorpay_order_id) {
            return res.status(400).json({ error: 'Payment does not belong to this order' });
        }

        /* 5. Payment record + every linked order (paid or partial_paid, amountPaid, balanceDue) */
        if (payData.status !== 'paid') {
            await markGroupPaid(payData, razorpay_order_id, {
                paymentId: razorpay_payment_id, amountPaise: rzpPayment.amount,
                method: rzpPayment.method, signature: razorpay_signature,
            });
        }

        /* Payment is confirmed → this is the moment a coupon use is counted */
        try { await confirmGroupCoupons(payData.groupOrderId); }
        catch (e) { console.error('[verify] coupon confirm failed:', e.message); }
        try { await confirmGroupWallet(payData.groupOrderId); }
        catch (e) { console.error('[verify] wallet confirm failed:', e.message); }

        return res.json({ success: true, paymentId: razorpay_payment_id });

    } catch (err) {
        console.error('[verify]', err.message);
        return res.status(500).json({ error: 'Verification failed', details: err.message });
    }
});

/* ─────────────────────────────────────────────
   POST /api/payment/webhook
   Razorpay signed webhook — backup event sink.
   Set this URL in Razorpay Dashboard → Webhooks.
   Events handled: payment.captured, payment.failed
   ───────────────────────────────────────────── */
router.post('/webhook', async (req, res) => {
    const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;

    /* Verify webhook signature if secret is configured */
    if (webhookSecret) {
        const signature = req.headers['x-razorpay-signature'] || '';
        const expected  = crypto
            .createHmac('sha256', webhookSecret)
            .update(req.body) // raw Buffer (express.raw middleware)
            .digest('hex');

        if (expected !== signature) {
            console.warn('[webhook] Invalid signature');
            return res.status(400).json({ error: 'Invalid webhook signature' });
        }
    }

    let event;
    try {
        event = JSON.parse(req.body.toString());
    } catch (e) {
        return res.status(400).json({ error: 'Invalid JSON payload' });
    }

    const eventType = event.event;
    const payload   = event.payload?.payment?.entity || {};

    console.log(`[webhook] Event: ${eventType} | Order: ${payload.order_id}`);

    try {
        if (eventType === 'payment.captured') {
            await handlePaymentCaptured(payload);
        } else if (eventType === 'payment.failed') {
            await handlePaymentFailed(payload);
        }
        // Acknowledge all other events silently
        return res.json({ received: true });
    } catch (err) {
        console.error('[webhook] Handler error:', err.message);
        // Return 200 anyway so Razorpay doesn't retry indefinitely
        return res.json({ received: true });
    }
});

/* ─────────────────────────────────────────────
   Webhook sub-handlers
   ───────────────────────────────────────────── */
async function handlePaymentCaptured(payment) {
    const rzpOrderId  = payment.order_id;
    const rzpPaymentId = payment.id;
    if (!rzpOrderId) return;

    const paySnap = await db.collection('payments').doc(rzpOrderId).get();
    if (!paySnap.exists) return;

    const payData = paySnap.data();
    // Skip if already marked paid (verify endpoint may have beaten webhook)
    if (payData.status === 'paid') return;

    await markGroupPaid(payData, rzpOrderId, {
        paymentId: rzpPaymentId, amountPaise: payment.amount, method: payment.method, webhook: true,
    });
    try { await confirmGroupCoupons(payData.groupOrderId); }
    catch (e) { console.error('[webhook] coupon confirm failed:', e.message); }
    try { await confirmGroupWallet(payData.groupOrderId); }
    catch (e) { console.error('[webhook] wallet confirm failed:', e.message); }
    console.log(`[webhook] payment.captured processed: ${rzpPaymentId}`);
}

async function handlePaymentFailed(payment) {
    const rzpOrderId = payment.order_id;
    if (!rzpOrderId) return;

    const paySnap = await db.collection('payments').doc(rzpOrderId).get();
    if (!paySnap.exists) return;

    const payData = paySnap.data();
    const batch   = db.batch();

    batch.update(db.collection('payments').doc(rzpOrderId), {
        status:           'failed',
        failureReason:    payment.error_description || 'Payment failed',
        updatedAt:        admin.firestore.FieldValue.serverTimestamp(),
        webhookProcessed: true,
    });

    for (const ordId of (payData.firestoreOrderIds || [])) {
        batch.set(db.collection('orders').doc(ordId), {
            paymentStatus: 'failed',
            updatedAt:     admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
    }

    await batch.commit();
    try { await releaseGroupCoupons(payData.groupOrderId, null, { allowRedeemed: false }); }
    catch (e) { console.error('[webhook] coupon release failed:', e.message); }
    try { await releaseGroupWallet(payData.groupOrderId, null, { allowRedeemed: false }); }
    catch (e) { console.error('[webhook] wallet release failed:', e.message); }
    console.log(`[webhook] payment.failed processed: ${rzpOrderId}`);
}

module.exports = router;
