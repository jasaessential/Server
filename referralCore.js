/* ═══════════════════════════════════════════════
   JASA V2 — server/referralCore.js

   Firestore layout (written only by this server):
     config/referral               admin-edited program settings
     referral_codes/{CODE}         { uid }  — doc id is the code, so codes are unique by construction
     referrals/{refereeUid}        one doc per referred account → a user can redeem a code ONLY ONCE
     users/{uid}.referralCode      the user's own shareable code
     users/{uid}.referredBy        uid of whoever referred them

   Rewards are paid into the wallet (walletCore.postTxn):
     trigger 'signup'      → both sides are paid as soon as the code is applied (fixed amounts only)
     trigger 'first_order' → paid when the referee's first qualifying order is Delivered
   ═══════════════════════════════════════════════ */
'use strict';

const { db, admin } = require('./firebase');
const { fail } = require('./authHelpers');
const { round2, num, postTxn, isDelivered, eligibleBase } = require('./walletCore');
const FieldValue = admin.firestore.FieldValue;

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // no 0/O/1/I/L
const CODE_LENGTH   = 7;

/* ── Config ─────────────────────────────────── */
const DEFAULT_CFG = {
    enabled:             false,
    trigger:             'first_order',   // 'signup' | 'first_order'
    referrerRewardType:  'fixed',         // 'fixed' (₹) | 'percent' (% of the referee's first order)
    referrerRewardValue: 0,
    referrerMaxReward:   0,               // ₹ cap for percent rewards (0 = no cap)
    refereeRewardType:   'fixed',
    refereeRewardValue:  0,
    refereeMaxReward:    0,
    minFirstOrderValue:  0,               // first_order trigger: order value that qualifies
    maxReferralsPerUser: 0,               // rewarded referrals one person can earn from (0 = unlimited)
    newUsersOnly:        true,            // code can only be applied before the account's first order
};

const rewardType = t => (t === 'percent' ? 'percent' : 'fixed');

function normaliseConfig(raw = {}) {
    const c = { ...DEFAULT_CFG, ...raw };
    return {
        enabled:             c.enabled === true,
        trigger:             c.trigger === 'signup' ? 'signup' : 'first_order',
        referrerRewardType:  rewardType(c.referrerRewardType),
        referrerRewardValue: Math.max(0, num(c.referrerRewardValue)),
        referrerMaxReward:   Math.max(0, num(c.referrerMaxReward)),
        refereeRewardType:   rewardType(c.refereeRewardType),
        refereeRewardValue:  Math.max(0, num(c.refereeRewardValue)),
        refereeMaxReward:    Math.max(0, num(c.refereeMaxReward)),
        minFirstOrderValue:  Math.max(0, num(c.minFirstOrderValue)),
        maxReferralsPerUser: Math.max(0, Math.floor(num(c.maxReferralsPerUser))),
        newUsersOnly:        c.newUsersOnly !== false,
    };
}

async function getReferralConfig() {
    const snap = await db.collection('config').doc('referral').get();
    return normaliseConfig(snap.exists ? snap.data() : {});
}

/** ₹ reward for one side. Percent rewards need an order to take the percent of. */
function rewardAmount(type, value, max, base) {
    let amt = type === 'percent' ? (base > 0 ? base * value / 100 : 0) : value;
    if (type === 'percent' && max > 0) amt = Math.min(amt, max);
    return Math.floor(Math.max(0, amt) * 100) / 100;
}

/* ── Codes ──────────────────────────────────── */
function randomCode() {
    let s = '';
    for (let i = 0; i < CODE_LENGTH; i++) s += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
    return s;
}

const normCode = c => String(c || '').trim().toUpperCase();

/** Returns the user's referral code, creating one if they have none. Safe to call repeatedly. */
async function ensureReferralCode(uid) {
    const userRef = db.collection('users').doc(uid);
    for (let attempt = 0; attempt < 10; attempt++) {
        const code = randomCode();
        try {
            const result = await db.runTransaction(async tx => {
                const uSnap = await tx.get(userRef);
                if (!uSnap.exists) fail('Profile not found. Please complete your account first.');
                const existing = uSnap.data().referralCode;
                if (existing) {
                    const cSnap = await tx.get(db.collection('referral_codes').doc(existing));
                    if (cSnap.exists && cSnap.data().uid === uid) return existing;
                }
                tx.create(db.collection('referral_codes').doc(code), { uid, createdAt: FieldValue.serverTimestamp() });
                tx.update(userRef, { referralCode: code });
                return code;
            });
            return result;
        } catch (e) {
            if (e.code === 6 || /already exists/i.test(e.message || '')) continue;   // code collision → retry
            throw e;
        }
    }
    throw new Error('Could not generate a unique referral code.');
}

/* ── Applying a code (once per account) ─────── */
const firstName = n => String(n || '').trim().split(/\s+/)[0] || 'Friend';

async function applyReferralCode(uid, rawCode) {
    const cfg = await getReferralConfig();
    if (!cfg.enabled) fail('The referral program is not active right now.');

    const code = normCode(rawCode);
    if (!/^[A-Z0-9]{4,12}$/.test(code)) fail('Enter a valid referral code.');

    const cSnap = await db.collection('referral_codes').doc(code).get();
    if (!cSnap.exists) fail('This referral code does not exist.');
    const referrerUid = cSnap.data().uid;
    if (referrerUid === uid) fail("You can't use your own referral code.");

    const [mine, back] = await Promise.all([
        db.collection('referrals').doc(uid).get(),
        db.collection('referrals').doc(referrerUid).get(),
    ]);
    if (mine.exists) fail('You have already used a referral code on this account.');
    if (back.exists && back.data().referrerUid === uid) fail('This referral code cannot be used.');

    if (cfg.newUsersOnly) {
        const hasOrder = !(await db.collection('orders').where('userId', '==', uid).limit(1).get()).empty;
        if (hasOrder) fail('Referral codes can only be added before your first order.');
    }
    if (cfg.maxReferralsPerUser > 0) {
        const n = (await db.collection('referrals').where('referrerUid', '==', referrerUid)
            .where('status', 'in', ['pending', 'rewarded']).count().get()).data().count;
        if (n >= cfg.maxReferralsPerUser) fail('This referral code has reached its limit.');
    }

    const [meSnap, referrerSnap] = await Promise.all([
        db.collection('users').doc(uid).get(),
        db.collection('users').doc(referrerUid).get(),
    ]);
    if (!meSnap.exists) fail('Profile not found. Please complete your account first.');

    const refDoc = db.collection('referrals').doc(uid);
    await db.runTransaction(async tx => {
        if ((await tx.get(refDoc)).exists) fail('You have already used a referral code on this account.');
        tx.create(refDoc, {
            refereeUid: uid, referrerUid, code, status: 'pending', trigger: cfg.trigger,
            refereeName: firstName(meSnap.data().fullName), referrerName: firstName(referrerSnap.data()?.fullName),
            referrerReward: 0, refereeReward: 0, appliedAt: FieldValue.serverTimestamp(),
        });
        tx.update(db.collection('users').doc(uid), { referredBy: referrerUid, referredByCode: code });
    });

    let reward = null;
    if (cfg.trigger === 'signup') reward = await rewardReferral(uid, { base: 0, orderId: '' });
    return { code, trigger: cfg.trigger, reward };
}

/* ── Paying the rewards ─────────────────────── */
async function rewardReferral(refereeUid, { base, orderId }) {
    const refRef = db.collection('referrals').doc(refereeUid);
    const snap = await refRef.get();
    if (!snap.exists || snap.data().status !== 'pending') return null;
    const ref = snap.data();
    const cfg = await getReferralConfig();

    let referrerAmt = rewardAmount(cfg.referrerRewardType, cfg.referrerRewardValue, cfg.referrerMaxReward, base);
    const refereeAmt = rewardAmount(cfg.refereeRewardType, cfg.refereeRewardValue, cfg.refereeMaxReward, base);

    if (cfg.maxReferralsPerUser > 0) {
        const paid = (await db.collection('referrals')
            .where('referrerUid', '==', ref.referrerUid).where('status', '==', 'rewarded').count().get()).data().count;
        if (paid >= cfg.maxReferralsPerUser) referrerAmt = 0;
    }

    /* credit first (deterministic ids → a retry can't double-pay), then close the referral */
    if (referrerAmt > 0) await postTxn(ref.referrerUid, {
        id: `referral_referrer__${refereeUid}`, amount: referrerAmt, source: 'referral_referrer', refId: refereeUid,
        note: `Referral bonus — ${ref.refereeName || 'a friend'} joined with your code`,
    });
    if (refereeAmt > 0) await postTxn(refereeUid, {
        id: `referral_referee__${refereeUid}`, amount: refereeAmt, source: 'referral_referee', refId: ref.referrerUid,
        note: `Welcome bonus for using referral code ${ref.code}`,
    });
    await refRef.update({
        status: 'rewarded', referrerReward: referrerAmt, refereeReward: refereeAmt,
        orderId: orderId || '', rewardedAt: FieldValue.serverTimestamp(),
    });
    return { referrerReward: referrerAmt, refereeReward: refereeAmt };
}

/** Called from wallet sync for the referee: pays out once the trigger condition is met. */
async function processReferral(uid, orders) {
    const snap = await db.collection('referrals').doc(uid).get();
    if (!snap.exists || snap.data().status !== 'pending') return null;
    const cfg = await getReferralConfig();
    if (!cfg.enabled) return null;

    if (cfg.trigger === 'signup') return rewardReferral(uid, { base: 0, orderId: '' });

    const qualifying = orders
        .filter(({ data: o }) => isDelivered(o) && eligibleBase(o) > 0 && eligibleBase(o) >= cfg.minFirstOrderValue)
        .sort((a, b) => (a.data.createdAt?.toMillis?.() || 0) - (b.data.createdAt?.toMillis?.() || 0));
    if (!qualifying.length) return null;
    const first = qualifying[0];
    return rewardReferral(uid, { base: eligibleBase(first.data), orderId: first.ref.id });
}

/* ── Summary for the "Refer a Friend" page ──── */
async function referralSummary(uid) {
    const snap = await db.collection('referrals').where('referrerUid', '==', uid).get();
    const list = snap.docs.map(d => d.data())
        .sort((a, b) => (b.appliedAt?.toMillis?.() || 0) - (a.appliedAt?.toMillis?.() || 0));
    return {
        total:    list.length,
        rewarded: list.filter(r => r.status === 'rewarded').length,
        pending:  list.filter(r => r.status === 'pending').length,
        earned:   round2(list.reduce((s, r) => s + num(r.referrerReward), 0)),
        friends:  list.slice(0, 30).map(r => ({
            name: r.refereeName || 'Friend', status: r.status, reward: num(r.referrerReward),
            at: r.appliedAt?.toMillis?.() || null,
        })),
    };
}

module.exports = {
    normaliseConfig, getReferralConfig, ensureReferralCode, applyReferralCode,
    rewardReferral, processReferral, referralSummary, normCode,
};
