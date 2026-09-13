/* ═══════════════════════════════════════════════
   JASA V2 — Razorpay Instance
   Lazily initialised — only throws when a payment
   route is actually called, not on server startup.
   This allows the server to run even before
   Razorpay keys are configured.
   ═══════════════════════════════════════════════ */
'use strict';

const Razorpay = require('razorpay');

let _instance = null;

function getRazorpay() {
    if (_instance) return _instance;

    const keyId     = process.env.RAZORPAY_KEY_ID;
    const keySecret = process.env.RAZORPAY_KEY_SECRET;

    if (!keyId || !keySecret ||
        keyId.includes('XXXX') || keySecret.includes('XXXX')) {
        throw new Error(
            'Razorpay is not configured yet. ' +
            'Add RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET to server/.env'
        );
    }

    _instance = new Razorpay({ key_id: keyId, key_secret: keySecret });
    return _instance;
}

module.exports = { getRazorpay };
