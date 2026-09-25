/* ═══════════════════════════════════════════════
   JASA V2 — server/walletCore.js

   Firestore layout (all writes happen here, via Admin SDK):
     config/wallet                              admin-edited settings
     wallets/{uid}                              { balance, totalEarned, totalSpent }
     wallets/{uid}/transactions/{txnId}         ledger; txnId is deterministic so a
                                                retry can never credit/debit twice
     wallet_usages/{groupOrderId}               one wallet hold per checkout
     wallet_stats/summary                       running totals for the admin dashboard

   Wallet hold lifecycle (mirrors couponUsage.js):
     COD order    : 'redeemed'  (balance debited at checkout)
     online order : 'pending'   (balance debited = held)
                    → confirmGroupWallet() on payment success → 'redeemed'
                    → releaseGroupWallet() on failure/cancel   → 'released' (balance credited back)
   ═══════════════════════════════════════════════ */
'use strict';

const { db, admin } = require('./firebase');
const { fail } = require('./authHelpers');
const FieldValue = admin.firestore.FieldValue;

const round2 = n => Math.round((Number(n) || 0) * 100) / 100;
const num    = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };

const PENDING_HOLD_MS = 30 * 60 * 1000;

/* ── Config ─────────────────────────────────── */
const DEFAULT_CFG = {
    enabled:             false,
    cashbackPercent:     0,      // % of the eligible order value credited to the wallet
    minOrderForCashback: 0,      // eligible order value needed to earn cashback
    maxCashbackPerOrder: 0,      // ₹ cap per order (0 = no cap)
    minOrderToUse:       0,      // order total needed before the wallet can be used
    minBalanceToUse:     0,      // wallet balance needed before it can be used
    maxUsePercent:       50,     // max % of an order that may be paid from the wallet
    maxUsePerOrder:      0,      // ₹ cap per order (0 = no cap)
    applyToProducts:     true,
    applyToXerox:        true,
};

function normaliseConfig(raw = {}) {
    const c = { ...DEFAULT_CFG, ...raw };
    return {
        enabled:             c.enabled === true,
        cashbackPercent:     Math.min(100, Math.max(0, num(c.cashbackPercent))),
        minOrderForCashback: Math.max(0, num(c.minOrderForCashback)),
        maxCashbackPerOrder: Math.max(0, num(c.maxCashbackPerOrder)),
        minOrderToUse:       Math.max(0, num(c.minOrderToUse)),
        minBalanceToUse:     Math.max(0, num(c.minBalanceToUse)),
        maxUsePercent:       Math.min(100, Math.max(0, num(c.maxUsePercent, 50))),
        maxUsePerOrder:      Math.max(0, num(c.maxUsePerOrder)),
        applyToProducts:     c.applyToProducts !== false,
        applyToXerox:        c.applyToXerox !== false,
    };
}

async function getWalletConfig() {
    const snap = await db.collection('config').doc('wallet').get();
    return normaliseConfig(snap.exists ? snap.data() : {});
}

/** How much of `payable` (order total before wallet) may be paid from the wallet.
    Always leaves at least ₹1 payable so the Razorpay minimum is never violated.
    wallet-client.js carries an identical copy for live totals. */
function computeUsable(cfg, balance, payable, orderType) {
    if (!cfg.enabled) return 0;
    if (orderType === 'xerox' ? !cfg.applyToXerox : !cfg.applyToProducts) return 0;
    payable = round2(payable); balance = round2(balance);
    if (payable <= 1 || balance <= 0) return 0;
    if (payable < cfg.minOrderToUse) return 0;
    if (balance < cfg.minBalanceToUse) return 0;
    let cap = payable * cfg.maxUsePercent / 100;
    if (cfg.maxUsePerOrder > 0) cap = Math.min(cap, cfg.maxUsePerOrder);
    cap = Math.min(cap, payable - 1);
    return Math.max(0, Math.floor(Math.min(balance, cap) * 100) / 100);
}

/* ── Ledger primitive ───────────────────────────
   Call inside a transaction AFTER all reads. `walletSnap` is the
   already-read wallets/{uid} doc. Returns the new balance.       */
const ISSUE_SOURCES = new Set(['cashback', 'referral_referrer', 'referral_referee', 'admin_adjust']);
const USE_REVERSALS = new Set(['order_refund', 'usage_release']);

function stageTxn(tx, uid, walletSnap, { id, amount, source, refId = '', note = '' }) {
    amount = round2(amount);
    const balance = walletSnap.exists ? round2(walletSnap.data().balance) : 0;
    const next    = round2(balance + amount);
    if (next < 0) fail('Insufficient wallet balance.');

    const wRef = db.collection('wallets').doc(uid);
    tx.set(wRef.collection('transactions').doc(id), {
        userId: uid, type: amount >= 0 ? 'credit' : 'debit', amount: Math.abs(amount),
        source, refId, note, balanceAfter: next, createdAt: FieldValue.serverTimestamp(),
    });

    const wallet = { userId: uid, balance: next, updatedAt: FieldValue.serverTimestamp() };
    if (amount > 0 && ISSUE_SOURCES.has(source))  wallet.totalEarned = FieldValue.increment(amount);
    if (amount < 0 && source === 'order_payment') wallet.totalSpent  = FieldValue.increment(-amount);
    if (amount > 0 && USE_REVERSALS.has(source))  wallet.totalSpent  = FieldValue.increment(-amount);
    tx.set(wRef, wallet, { merge: true });

    const stats = { updatedAt: FieldValue.serverTimestamp() };
    if (ISSUE_SOURCES.has(source)) stats[`issued_${source}`] = FieldValue.increment(amount);
    if (source === 'order_payment')  stats.used = FieldValue.increment(-amount);
    if (USE_REVERSALS.has(source))   stats.used = FieldValue.increment(-amount);
    tx.set(db.collection('wallet_stats').doc('summary'), stats, { merge: true });
    return next;
}

/** Idempotent single credit/debit. Returns { done, balance } — done=false when this txn id already exists. */
async function postTxn(uid, params) {
    const wRef = db.collection('wallets').doc(uid);
    const tRef = wRef.collection('transactions').doc(params.id);
    return db.runTransaction(async tx => {
        const [tSnap, wSnap] = await Promise.all([tx.get(tRef), tx.get(wRef)]);
        if (tSnap.exists) return { done: false, balance: round2(wSnap.data()?.balance) };
        if (!round2(params.amount)) return { done: false, balance: round2(wSnap.data()?.balance) };
        const balance = stageTxn(tx, uid, wSnap, params);
        return { done: true, balance };
    });
}

/* ── Checkout hold ──────────────────────────── */
const safeId = s => String(s || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);

async function holdWallet(uid, { groupOrderId, orderTotal, orderType, online }) {
    const gid = safeId(groupOrderId);
    if (!gid) fail('Missing order reference.');
    const total = num(orderTotal);
    if (!(total > 0)) fail('Invalid order amount.');
    const cfg = await getWalletConfig();
    if (!cfg.enabled) fail('Wallet is not available right now.');

    const uRef = db.collection('wallet_usages').doc(gid);
    const wRef = db.collection('wallets').doc(uid);

    return db.runTransaction(async tx => {
        const [uSnap, wSnap] = await Promise.all([tx.get(uRef), tx.get(wRef)]);
        let attempt = 1;
        if (uSnap.exists) {
            const u = uSnap.data();
            if (u.userId !== uid) fail('Invalid order reference.');
            if (u.status === 'redeemed' || u.status === 'pending') return u.amount;   // idempotent retry
            attempt = (u.attempt || 1) + 1;                                           // re-hold after a release
        }
        const balance = wSnap.exists ? wSnap.data().balance : 0;
        const amount  = computeUsable(cfg, balance, total, orderType);
        if (amount <= 0) fail('Wallet cannot be used on this order.');

        stageTxn(tx, uid, wSnap, {
            id: `redeem__${gid}__a${attempt}`, amount: -amount, source: 'order_payment',
            refId: gid, note: `Used on order ${gid}`,
        });
        tx.set(uRef, {
            userId: uid, groupOrderId: gid, orderType: orderType === 'xerox' ? 'xerox' : 'product',
            amount, attempt, orderTotal: round2(total),
            status: online ? 'pending' : 'redeemed', createdAt: FieldValue.serverTimestamp(),
        });
        return amount;
    });
}

/** Payment succeeded → hold becomes final. */
async function confirmGroupWallet(groupOrderId) {
    const gid = safeId(groupOrderId);
    if (!gid) return false;
    const ref = db.collection('wallet_usages').doc(gid);
    return db.runTransaction(async tx => {
        const s = await tx.get(ref);
        if (!s.exists || s.data().status !== 'pending') return false;
        tx.update(ref, { status: 'redeemed', confirmedAt: FieldValue.serverTimestamp() });
        return true;
    });
}

/** Give a hold back. pending is always releasable; redeemed only with allowRedeemed. */
async function releaseGroupWallet(groupOrderId, uid, { allowPending = true, allowRedeemed = true } = {}) {
    const gid = safeId(groupOrderId);
    if (!gid) return 0;
    const uRef = db.collection('wallet_usages').doc(gid);
    return db.runTransaction(async tx => {
        const uSnap = await tx.get(uRef);
        if (!uSnap.exists) return 0;
        const u = uSnap.data();
        if (uid && u.userId !== uid) return 0;
        const ok = (u.status === 'pending' && allowPending) || (u.status === 'redeemed' && allowRedeemed);
        if (!ok) return 0;
        const wSnap = await tx.get(db.collection('wallets').doc(u.userId));
        stageTxn(tx, u.userId, wSnap, {
            id: `release__${gid}__a${u.attempt || 1}`, amount: u.amount, source: 'usage_release',
            refId: gid, note: `Returned — order ${gid} was not completed`,
        });
        tx.update(uRef, { status: 'released', releasedAt: FieldValue.serverTimestamp() });
        return u.amount;
    });
}

/* ── Order-driven credits (cashback, refunds) ───
   Staff change order status straight from the browser, so instead of hooking every
   status-update path, the customer's app calls sync() and the server verifies each
   order itself. Deterministic txn ids make repeat calls harmless.                    */
const orderStatus = o => String(o.status || '').trim().toLowerCase();
const isDelivered = o => orderStatus(o) === 'delivered';
const isCancelled = o => ['cancelled', 'canceled', 'rejected'].includes(orderStatus(o));

/** Order value that actually came out of the customer's pocket for goods/services (no delivery fee). */
const eligibleBase = o => Math.max(0, round2(num(o.subtotal) - num(o.discountAmount) - num(o.walletAmount)));

function cashbackFor(cfg, o) {
    if (!cfg.enabled || cfg.cashbackPercent <= 0) return 0;
    if (o.type === 'xerox' ? !cfg.applyToXerox : !cfg.applyToProducts) return 0;
    const base = eligibleBase(o);
    if (base <= 0 || base < cfg.minOrderForCashback) return 0;
    let c = base * cfg.cashbackPercent / 100;
    if (cfg.maxCashbackPerOrder > 0) c = Math.min(c, cfg.maxCashbackPerOrder);
    return Math.floor(c * 100) / 100;
}

async function releaseStaleHolds(uid) {
    const snap = await db.collection('wallet_usages')
        .where('userId', '==', uid).where('status', '==', 'pending').get();
    let released = 0;
    for (const d of snap.docs) {
        const u = d.data();
        const age = Date.now() - (u.createdAt?.toMillis?.() || Date.now());
        if (age < PENDING_HOLD_MS) continue;
        const paid = (await db.collection('payments').where('groupOrderId', '==', u.groupOrderId).get())
            .docs.some(p => p.data().status === 'paid');
        if (paid) { await confirmGroupWallet(u.groupOrderId); continue; }
        if (await releaseGroupWallet(u.groupOrderId, uid, { allowRedeemed: false })) released++;
    }
    return released;
}

/** Credit cashback for delivered orders and refund the wallet share of cancelled orders. */
async function settleOrders(uid, orders, cfg) {
    let cashback = 0, refunded = 0;
    for (const { ref, data: o } of orders) {
        if (isDelivered(o) && !o.cashbackCredited) {
            const amt = cashbackFor(cfg, o);
            if (amt > 0) {
                const r = await postTxn(uid, {
                    id: `cashback__${ref.id}`, amount: amt, source: 'cashback', refId: ref.id,
                    note: `${cfg.cashbackPercent}% cashback on order ${o.groupOrderId || ref.id}`,
                });
                if (r.done) cashback += amt;
            }
            await ref.set({ cashbackCredited: amt }, { merge: true });   // 0 = evaluated, nothing earned
        }
        if (isCancelled(o) && num(o.walletAmount) > 0 && !o.walletRefunded) {
            const uSnap = await db.collection('wallet_usages').doc(safeId(o.groupOrderId)).get();
            if (uSnap.exists && uSnap.data().status === 'redeemed') {
                const r = await postTxn(uid, {
                    id: `refund__${ref.id}`, amount: num(o.walletAmount), source: 'order_refund', refId: ref.id,
                    note: `Refund — order ${o.groupOrderId || ref.id} cancelled`,
                });
                if (r.done) refunded += num(o.walletAmount);
                await ref.set({ walletRefunded: true }, { merge: true });
            }
        }
    }
    return { cashback: round2(cashback), refunded: round2(refunded) };
}

async function loadUserOrders(uid) {
    const snap = await db.collection('orders').where('userId', '==', uid).get();
    return snap.docs.map(d => ({ ref: d.ref, data: d.data() }));
}

module.exports = {
    round2, num, safeId, getWalletConfig, computeUsable, stageTxn, postTxn,
    holdWallet, confirmGroupWallet, releaseGroupWallet, releaseStaleHolds,
    settleOrders, loadUserOrders, isDelivered, isCancelled, eligibleBase,
};
