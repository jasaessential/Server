/* ═══════════════════════════════════════════════
   JASA V2 — server/pricing.js
   Server-side prices for an order, so totals never come from the browser.

   priceProductGroup()  — cart items → price from items/{id}
   priceXeroxGroup()    — xerox documents → price from the shop's xerox config
   deliveryFee()        — shop delivery rules (deliveryPrices.others / .xerox)

   The xerox maths mirrors calculatePrices() / printCost() in xerox-order.js;
   change both together.
   ═══════════════════════════════════════════════ */
'use strict';

const { db } = require('./firebase');
const { fail } = require('./authHelpers');
const { pathFromUrl } = require('./routes/files');

const num = v => Number(v) || 0;
const r2  = n => Math.round(n * 100) / 100;

/* ── Products ─────────────────────────────────── */

/** Selling price of an item doc — same rule as the storefront (item-details.js). */
function productPrice(item, size) {
    const sp = size && item.sizePrices && item.sizePrices[size];
    const o = num(sp ? sp.priceOriginal : (item.priceOriginal ?? item.price));
    const d = num(sp ? sp.priceDiscount : (item.priceDiscount ?? item.sellingPrice));
    return d > 0 && (o <= 0 || d < o) ? d : o;
}

/** Cart line id of a sized item is "<itemId>__<size>" (item ids never contain "__").
    A customer-photo poster adds "__<tag>" so each upload is its own line.   */
function splitLineId(id) {
    const [baseId, size = '', ...rest] = String(id || '_').split('__');
    return { baseId, size, tag: rest.join('__').replace(/[^A-Za-z0-9-]/g, '').slice(0, 40) };
}

/** Re-prices the cart lines of one shop. Lines keep their display fields; price,
    originalPrice, discountPercent and name come from items/{id}.            */
async function priceProductGroup(lines) {
    if (!Array.isArray(lines) || !lines.length || lines.length > 100) fail('Your cart is empty or too large.');
    const parts = lines.map(l => splitLineId(l?.id));
    const snaps = await db.getAll(...parts.map(p => db.collection('items').doc(p.baseId)));
    let subtotal = 0;
    const items = lines.map((line, i) => {
        const s = snaps[i];
        if (!s.exists) fail(`"${line?.name || 'An item'}" is no longer available. Please remove it from your cart.`);
        const it  = s.data();
        const qty = Math.floor(num(line.qty));
        if (qty < 1 || qty > 999) fail(`Invalid quantity for "${it.name || line.name}".`);
        const size = parts[i].size;
        if (size && !(it.sizePrices && it.sizePrices[size])) fail(`"${it.name || line.name}" is no longer available in size ${size}.`);
        const price    = productPrice(it, size);
        if (!(price > 0)) fail(`"${it.name || line.name}" cannot be ordered right now.`);
        const sp       = size ? it.sizePrices[size] : null;
        const original = num(sp ? sp.priceOriginal : (it.priceOriginal ?? it.price)) || price;
        /* Customer-photo poster: the line must carry the uploaded photo */
        const custom = {};
        if (it.customUpload) {
            const photo = String(line.customPhoto || '');
            if (photo.length > 600 || !pathFromUrl(photo)?.startsWith('poster-uploads/')) fail(`Please upload your photo for "${it.name || line.name}".`);
            custom.customPhoto = photo;
            custom.customNote  = String(line.customNote || '').trim().slice(0, 300);
        }
        const { customPhoto: _p, customNote: _n, ...rest } = line;
        const tag = size && parts[i].tag ? `__${parts[i].tag}` : '';
        subtotal += price * qty;
        return {
            ...rest, ...custom,
            id: size ? `${s.id}__${size}${tag}` : s.id, qty,
            name:            (size ? `${it.name || line.name || ''} (${size})` : (it.name || line.name || '')),
            price,
            originalPrice:   original,
            discountPercent: original > price ? Math.round((original - price) / original * 100) : 0,
        };
    });
    return { items, subtotal: r2(subtotal) };
}

/* ── Delivery ─────────────────────────────────── */

/** Fee from a shop's delivery rules ({min, max, fee}[]); a fee-0 rule whose min is
    reached makes delivery free. Pickup is always free.                       */
function deliveryFee(rules, subtotal, isPickup) {
    if (isPickup || !Array.isArray(rules) || !rules.length) return 0;
    const free = rules.find(r => num(r.fee) === 0);
    if (free && subtotal >= num(free.min)) return 0;
    const rule = rules.find(r => subtotal >= num(r.min) && (r.max == null || subtotal <= num(r.max)));
    return rule ? num(rule.fee) : 0;
}

/* ── Xerox ────────────────────────────────────── */

async function loadGlobalXeroxConfig() {
    const load = async name => (await db.collection(name).get()).docs.map(d => ({ id: d.id, ...d.data() }));
    const [paper, binding, lamination] = await Promise.all([
        load('xerox_config_paper'), load('xerox_config_binding'), load('xerox_config_lamination'),
    ]);
    return { paper, binding, lamination };
}

/** Port of getShopXeroxConfig() in xerox-order.js — only prices matter here. */
function shopXeroxConfig(shop, global) {
    const xc = shop.xeroxConfig;
    if (!xc) {
        if (Array.isArray(shop.paperConfig) && shop.paperConfig.length) return { ...global, paper: shop.paperConfig };
        return global;
    }
    if (Array.isArray(xc)) return { ...global, paper: xc };
    if (Array.isArray(xc.paper) || Array.isArray(xc.binding) || Array.isArray(xc.lamination)) {
        const pick = (k) => Array.isArray(xc[k]) && xc[k].length ? xc[k] : global[k];
        return { paper: pick('paper'), binding: pick('binding'), lamination: pick('lamination') };
    }
    const map = k => (xc[k] && typeof xc[k] === 'object' && !Array.isArray(xc[k])) ? xc[k] : {};
    const pm = map('paper'), bm = map('binding'), lm = map('lamination');
    const has = m => Object.keys(m).length > 0;
    return {
        paper: has(pm) ? global.paper.filter(p => pm[p.id]?.enabled === true).map(p => {
            const s = pm[p.id];
            return {
                ...p,
                bwPrices:    (s.bwPrices    && (s.bwPrices.frontOnly    || s.bwPrices.frontBack))    ? s.bwPrices    : p.bwPrices,
                colorPrices: (s.colorPrices && (s.colorPrices.frontOnly || s.colorPrices.frontBack)) ? s.colorPrices : p.colorPrices,
            };
        }) : global.paper,
        binding: has(bm) ? global.binding.filter(b => bm[b.id]?.enabled === true)
            .map(b => ({ ...b, price: bm[b.id].price != null ? bm[b.id].price : b.price })) : global.binding,
        lamination: has(lm) ? global.lamination.filter(l => lm[l.id]?.enabled === true)
            .map(l => ({ ...l, price: lm[l.id].price != null ? lm[l.id].price : l.price })) : global.lamination,
    };
}

function rateFor(priceObj, format) {
    const p = priceObj || {};
    return format === 'both' ? num(p.frontBack ?? p.frontOnly) : num(p.frontOnly);
}

/** "1, 3, 5-8" → Set of pages within 1..maxPage (invalid tokens ignored) */
function colourPageSet(text, maxPage) {
    const set = new Set();
    String(text || '').replace(/\s*-\s*/g, '-').split(/[,\s]+/).filter(Boolean).forEach(tok => {
        const m = tok.match(/^(\d+)(?:-(\d+))?$/);
        if (!m) return;
        let a = parseInt(m[1], 10), b = m[2] ? parseInt(m[2], 10) : a;
        if (a > b) [a, b] = [b, a];
        if (a < 1 || b > maxPage) return;
        for (let p = a; p <= b; p++) set.add(p);
    });
    return set;
}

/** Same per-sheet rule as printCost() in xerox-order.js */
function printCost(pages, isColourPage, ratio, format, bwRate, colourRate) {
    const perSide = ratio === '1:2' ? 2 : 1;
    const sides   = Math.ceil(pages / perSide);
    const colourSide = s => {
        for (let p = s * perSide + 1; p <= Math.min((s + 1) * perSide, pages); p++) if (isColourPage(p)) return true;
        return false;
    };
    let cost = 0;
    if (format === 'both') {
        for (let s = 0; s < sides; s += 2) {
            const front = colourSide(s);
            const back  = s + 1 < sides ? colourSide(s + 1) : front;
            cost += front && back ? colourRate : (front || back) ? (bwRate + colourRate) / 2 : bwRate;
        }
    } else {
        for (let s = 0; s < sides; s++) cost += colourSide(s) ? colourRate : bwRate;
    }
    return cost;
}

/** Re-prices the documents of one xerox order. Each document keeps every field
    the browser sent except `price`. A combined book's binding is charged once,
    on its first file (lowest bindingSet.position).                          */
function priceXeroxDocuments(documents, cfg) {
    if (!Array.isArray(documents) || !documents.length || documents.length > 50) fail('Add at least one document.');
    const bookDocs = documents.filter(d => d?.config?.bindingSet);
    const bookLead = bookDocs.length
        ? bookDocs.reduce((a, b) => num(b.config.bindingSet.position) < num(a.config.bindingSet.position) ? b : a)
        : null;

    let subtotal = 0;
    const priced = documents.map(d => {
        const c     = d?.config || {};
        const pages = Math.floor(num(d.pages));
        const qty   = Math.floor(num(c.quantity));
        if (pages < 1 || pages > 5000) fail(`"${d?.name || 'A document'}" has an invalid page count.`);
        if (qty < 1 || qty > 9999)     fail(`"${d?.name || 'A document'}" has an invalid quantity.`);
        if (c.colorMode === 'custom')  fail('Please update the app and choose your colour pages again.');

        const paper = cfg.paper.find(p => p.id === c.paperId);
        if (!paper) fail(`The paper chosen for "${d.name}" is not offered by this shop.`);
        const bwRate     = rateFor(paper.bwPrices,    c.format);
        const colourRate = rateFor(paper.colorPrices, c.format);
        const colourSet  = c.color === 'mixed' ? colourPageSet(c.colorPages, pages) : null;
        if (c.color === 'mixed' && !colourSet.size) fail(`Choose the colour pages for "${d.name}".`);
        const isColourPage = c.color === 'color' ? () => true : colourSet ? p => colourSet.has(p) : () => false;

        const chargeBinding = !c.bindingSet || d === bookLead;
        const binding    = chargeBinding && c.bindingId && c.bindingId !== 'none'
            ? cfg.binding.find(b => b.id === c.bindingId) : null;
        if (c.bindingId && c.bindingId !== 'none' && chargeBinding && !binding) fail(`The binding chosen for "${d.name}" is not offered by this shop.`);
        const lamination = c.laminationId && c.laminationId !== 'none'
            ? cfg.lamination.find(l => l.id === c.laminationId) : null;
        if (c.laminationId && c.laminationId !== 'none' && !lamination) fail(`The lamination chosen for "${d.name}" is not offered by this shop.`);

        const price = r2((printCost(pages, isColourPage, c.ratio, c.format, bwRate, colourRate)
                          + num(binding?.price) + num(lamination?.price)) * qty);
        subtotal += price;
        /* Record where the book's binding is charged, so it can be moved to another
           file if this one is rejected or cancelled (see moveBookCharge). */
        const config = c.bindingSet
            ? { ...c, bindingSet: { ...c.bindingSet, chargedHere: d === bookLead,
                                    bindingCharge: d === bookLead ? r2(num(binding?.price) * qty) : 0 } }
            : c;
        return { ...d, pages, price, config };
    });
    return { documents: priced, subtotal: r2(subtotal) };
}

const inactive = d => ['rejected', 'cancelled'].includes(String(d?.status || '').toLowerCase());

/** A combined book's binding is charged on one file. If that file is gone
    (rejected / cancelled / removed), move the charge to the book's next active
    file so the order still pays for the binding. Returns a new array.
    Same logic as moveBookCharge() in xerox-book.js (staff pages).            */
function moveBookCharge(docs) {
    const list = docs.map(d => d);
    const lead = list.findIndex(d => d?.config?.bindingSet?.chargedHere && !inactive(d));
    if (lead !== -1) return list;
    const charge = list.reduce((s, d) => s + (d?.config?.bindingSet?.chargedHere ? num(d.config.bindingSet.bindingCharge) : 0), 0);
    if (!(charge > 0)) return list;
    const next = list
        .map((d, i) => ({ d, i }))
        .filter(({ d }) => d?.config?.bindingSet && !inactive(d))
        .sort((a, b) => num(a.d.config.bindingSet.position) - num(b.d.config.bindingSet.position))[0];
    if (!next) return list;   // whole book gone — nothing to bind
    list.forEach((d, i) => {
        if (d?.config?.bindingSet?.chargedHere) {
            list[i] = { ...d, price: r2(num(d.price) - charge),
                        config: { ...d.config, bindingSet: { ...d.config.bindingSet, chargedHere: false, bindingCharge: 0 } } };
        }
    });
    const n = list[next.i];
    list[next.i] = { ...n, price: r2(num(n.price) + charge),
                     config: { ...n.config, bindingSet: { ...n.config.bindingSet, chargedHere: true, bindingCharge: charge } } };
    return list;
}

module.exports = {
    moveBookCharge,
    productPrice, priceProductGroup, deliveryFee,
    loadGlobalXeroxConfig, shopXeroxConfig, priceXeroxDocuments, printCost, colourPageSet,
};
