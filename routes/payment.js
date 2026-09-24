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
   • subtotal − discount + delivery === totalAmount per order
   • any discount is backed by a server-written coupon_usages
     record (see routes/coupon.js) for this user + group
   • the requested amount equals the full total, or the
     configured online deposit of it
   ───────────────────────────────────────────── */
async function verifyOrderAmount({ uid, trusted, groupOrderId, orderIds, amount }) {
    const snaps = await db.getAll(...orderIds.map(id => db.collection('orders').doc(String(id))));

    let total = 0, discount = 0, couponCode = null;
    for (const s of snaps) {
        if (!s.exists) return 'Order not found.';
        const o = s.data();
        if (!trusted && o.userId !== uid) return 'Order does not belong to you.';
        if (o.groupOrderId !== groupOrderId) return 'Order does not match this checkout.';
        if (o.paymentStatus === 'paid' || o.paymentStatus === 'partial_paid') return 'Order is already paid.';

        const sub = Number(o.subtotal) || 0;
        const fee = Number(o.deliveryFee) || 0;
        const dis = Number(o.discountAmount) || 0;
        const tot = Number(o.totalAmount) || 0;
        if (dis < 0 || Math.abs(sub - dis + fee - tot) > 0.01) return 'Order total does not add up.';

        if (dis > 0) {
            if (!o.couponCode || (couponCode && couponCode !== o.couponCode)) return 'Invalid coupon on order.';
            couponCode = o.couponCode;
        }
        total    += tot;
        discount += dis;
    }

    if (discount > 0) {
        const uSnap = await db.collection('coupon_usages').doc(`${groupOrderId}__${couponCode}`).get();
        const u = uSnap.exists ? uSnap.data() : null;
        if (!u || u.status !== 'redeemed' || (!trusted && u.userId !== uid)) return 'Coupon was not redeemed for this order.';
        if (Math.abs(u.discountAmount - discount) > 0.05) return 'Coupon discount does not match.';
    }

    const cfg = await db.collection('config').doc('payment').get();
    const pct = Number(cfg.exists && cfg.data().onlineDepositPercent) || 30;
    const deposit = Math.ceil(total * pct / 100);
    const a = Number(amount);
    const isFull    = Math.abs(a - total) <= 0.01;
    const isDeposit = Math.abs(a - deposit) <= 1.01;
    if (!isFull && !isDeposit) {
        return `Amount mismatch — expected ₹${total.toFixed(2)} (or ${pct}% deposit ₹${deposit}).`;
    }
    return null;
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
        const amountError = await verifyOrderAmount({
            uid, trusted, groupOrderId, orderIds: [...new Set(orderIds)], amount,
        });
        if (amountError) {
            console.warn('[create-order] rejected:', amountError, { uid, groupOrderId, amount });
            return res.status(400).json({ error: amountError });
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
                paymentMethod:   'razorpay',
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

        const batch = db.batch();

        /* 5. Update payment doc */
        batch.update(db.collection('payments').doc(razorpay_order_id), {
            razorpayPaymentId: razorpay_payment_id,
            razorpaySignature: razorpay_signature,
            status:            'paid',
            paidAmountPaise:   rzpPayment.amount,
            paidAt:            admin.firestore.FieldValue.serverTimestamp(),
            updatedAt:         admin.firestore.FieldValue.serverTimestamp(),
            method:            rzpPayment.method || 'unknown',
        });

        /* 6. Update every linked order in Firestore */
        for (const ordId of (payData.firestoreOrderIds || [])) {
            batch.set(db.collection('orders').doc(ordId), {
                paymentStatus:     'paid',
                razorpayPaymentId: razorpay_payment_id,
                paidAt:            admin.firestore.FieldValue.serverTimestamp(),
                updatedAt:         admin.firestore.FieldValue.serverTimestamp(),
            }, { merge: true });
            /* Also update order_status collection */
            batch.set(db.collection('order_status').doc(ordId), {
                paymentStatus: 'paid',
                updatedAt:     admin.firestore.FieldValue.serverTimestamp(),
            }, { merge: true });
        }

        await batch.commit();

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

    const batch = db.batch();

    batch.update(db.collection('payments').doc(rzpOrderId), {
        razorpayPaymentId: rzpPaymentId,
        status:            'paid',
        paidAmountPaise:   payment.amount,
        paidAt:            admin.firestore.FieldValue.serverTimestamp(),
        updatedAt:         admin.firestore.FieldValue.serverTimestamp(),
        method:            payment.method || 'unknown',
        webhookProcessed:  true,
    });

    for (const ordId of (payData.firestoreOrderIds || [])) {
        batch.set(db.collection('orders').doc(ordId), {
            paymentStatus:     'paid',
            razorpayPaymentId: rzpPaymentId,
            paidAt:            admin.firestore.FieldValue.serverTimestamp(),
            updatedAt:         admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
        batch.set(db.collection('order_status').doc(ordId), {
            paymentStatus: 'paid',
            updatedAt:     admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
    }

    await batch.commit();
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
    console.log(`[webhook] payment.failed processed: ${rzpOrderId}`);
}

module.exports = router;
