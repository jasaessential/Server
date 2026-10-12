/* ═══════════════════════════════════════════════
   JASA V2 — wall-layouts.js
   Poster wall builder: poster sizes, "Build Your Wall" layouts, poster-pack
   arrangements and their prices. Used by the storefront (wall-builder.js) and
   the payment server (server/pricing.js), so a wall is drawn, priced and
   checked the same way everywhere.

   ⚠ server/wallLayouts.js is an identical copy (the server deploys on its own).
     Change both together — `diff wall-layouts.js server/wallLayouts.js` must be empty.

   Prices live in Firestore poster_config/main (Poster Setup page):
     wall: { layouts: { <key>: { enabled, priceOriginal, priceDiscount } } }
     pack: { sizes: { A5|A4|A3|P13: { enabled, adjustPercent } },
             packs: [{ count, priceOriginal, priceDiscount }] }   ← A4 prices
   ═══════════════════════════════════════════════ */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.WallLayouts = api;
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    /** printW / printH: pixels at 300 DPI — the size customer photos are rendered to. */
    const SIZES = {
        A5:  { key: 'A5',  label: 'A5',     name: 'A5 poster',         widthCm: 14.8, heightCm: 21,   printW: 1748, printH: 2480 },
        A4:  { key: 'A4',  label: 'A4',     name: 'A4 poster',         widthCm: 21,   heightCm: 29.7, printW: 2480, printH: 3508 },
        A3:  { key: 'A3',  label: 'A3',     name: 'A3 poster',         widthCm: 29.7, heightCm: 42,   printW: 3508, printH: 4961 },
        P13: { key: 'P13', label: '13×19"', name: '13×19 inch poster', widthCm: 33,   heightCm: 48.3, printW: 3900, printH: 5700 },
    };
    const PACK_SIZES = ['A5', 'A4', 'A3', 'P13'];
    const MAX_SLOTS = 60;
    const GAP = 3;   // cm between posters

    const c = (items, dy) => ({ items, dy: dy || 0 });

    /** Each column: posters top to bottom; an array is a row side by side. */
    const LAYOUTS = {
        compact:   { name: 'Compact Wall',   description: 'A3 centrepiece with 4 A4 posters', cols: [c(['A4', 'A4']), c(['A3']), c(['A4', 'A4'])] },
        classic:   { name: 'Classic Wall',   description: '8 A4 posters in zigzag columns', cols: [c(['A4', 'A4']), c(['A4', 'A4'], 9), c(['A4', 'A4']), c(['A4', 'A4'], 9)] },
        grid:      { name: 'Gallery Grid',   description: '9 A4 posters in a neat 3 × 3 grid', cols: [c(['A4', 'A4', 'A4']), c(['A4', 'A4', 'A4']), c(['A4', 'A4', 'A4'])] },
        studio:    { name: 'Studio Wall',    description: '10 A4 posters in zigzag columns', cols: [c(['A4', 'A4']), c(['A4', 'A4'], 9), c(['A4', 'A4']), c(['A4', 'A4'], 9), c(['A4', 'A4'])] },
        feature:   { name: 'Feature Wall',   description: 'A3 centre framed by 4 A4 and 6 A5 posters', cols: [c(['A5', 'A5', 'A5']), c(['A4', 'A4']), c(['A3']), c(['A4', 'A4']), c(['A5', 'A5', 'A5'])] },
        panorama:  { name: 'Panorama Wall',  description: '13×19" centre with 4 A4 and 8 A5 in a wave', cols: [c(['A5', 'A5'], 6), c(['A5', 'A5'], -6), c(['A4', 'A4']), c(['P13']), c(['A4', 'A4']), c(['A5', 'A5'], -6), c(['A5', 'A5'], 6)] },
        large:     { name: 'Large Wall',     description: 'A3 centre with 6 A4 and 8 A5 posters', cols: [c(['A5', 'A5']), c(['A4', 'A4', 'A4']), c([['A5', 'A5'], 'A3', ['A5', 'A5']]), c(['A4', 'A4', 'A4']), c(['A5', 'A5'])] },
        cinema:    { name: 'Cinema Wall',    description: '13×19" centre with 4 A3 and 10 A4 posters', cols: [c(['A4', 'A4', 'A4']), c(['A3', 'A3']), c([['A4', 'A4'], 'P13', ['A4', 'A4']]), c(['A3', 'A3']), c(['A4', 'A4', 'A4'])] },
        mosaic:    { name: 'Mosaic Wall',    description: 'A3 with 14 A4 and 6 A5 posters, staggered', cols: [c(['A5', 'A5'], -10), c(['A4', 'A4'], 6), c(['A4', 'A4', 'A4']), c(['A3', ['A5', 'A5']]), c(['A4', 'A4', 'A4']), c(['A4', 'A4'], -6), c(['A5', 'A5'], 10)] },
        statement: { name: 'Statement Wall', description: '13×19" centre with 4 A3, 10 A4 and 8 A5 posters', cols: [c(['A5', 'A5', 'A5', 'A5']), c(['A4', 'A4', 'A4']), c(['A3', 'A3']), c([['A4', 'A4'], 'P13', ['A4', 'A4']]), c(['A3', 'A3']), c(['A4', 'A4', 'A4']), c(['A5', 'A5', 'A5', 'A5'])] },
        grand:     { name: 'Grand Wall',     description: '13×19" centre with 4 A3, 16 A4 and 8 A5 posters', cols: [c(['A4', 'A4', 'A4'], 10), c(['A5', 'A5', 'A5', 'A5']), c(['A4', 'A4', 'A4']), c(['A3', 'A3']), c([['A4', 'A4'], 'P13', ['A4', 'A4']]), c(['A3', 'A3']), c(['A4', 'A4', 'A4']), c(['A5', 'A5', 'A5', 'A5']), c(['A4', 'A4', 'A4'], 10)] },
    };

    const r2 = n => Math.round(n * 100) / 100;
    const list = i => (Array.isArray(i) ? i : [i]);
    const itemW = i => list(i).reduce((s, k) => s + SIZES[k].widthCm, 0) + GAP * (list(i).length - 1);
    const itemH = i => Math.max(...list(i).map(k => SIZES[k].heightCm));

    /** Poster sizes in slot order: column by column, top to bottom, rows left to right. */
    const slotSizes = layout => layout.cols.flatMap(col => col.items.flatMap(list));

    /** Slot rectangles in cm (slot order) and the wall's size. */
    function geometry(layout) {
        const cols = layout.cols.map(col => ({
            col,
            w: Math.max(...col.items.map(itemW)),
            h: col.items.reduce((s, i) => s + itemH(i), 0) + GAP * (col.items.length - 1),
        }));
        const tallest = Math.max(...cols.map(k => k.h));
        const tops = cols.map(k => (tallest - k.h) / 2 + (k.col.dy || 0));
        const minTop = Math.min(...tops);
        const slots = [];
        let x = 0, height = 0;
        cols.forEach((k, ci) => {
            let y = tops[ci] - minTop;
            for (const item of k.col.items) {
                const h = itemH(item);
                let ix = x + (k.w - itemW(item)) / 2;
                for (const s of list(item)) {
                    const d = SIZES[s];
                    slots.push({ size: s, x: r2(ix), y: r2(y + (h - d.heightCm) / 2), w: d.widthCm, h: d.heightCm });
                    ix += d.widthCm + GAP;
                }
                y += h + GAP;
            }
            height = Math.max(height, y - GAP);
            x += k.w + GAP;
        });
        return { width: r2(x - GAP), height: r2(height), slots };
    }

    const feet = layout => {
        const g = geometry(layout);
        return `${(g.width / 30.48).toFixed(1)} × ${(g.height / 30.48).toFixed(1)} ft`;
    };

    /* ── Pack arrangements (preview only — every arrangement prints the same posters) ── */
    const ARRANGEMENTS = { grid: 'Grid', zigzag: 'Zigzag', cascade: 'Cascade', gallery: 'Gallery' };

    function evenColumns(n, s) {
        const d = SIZES[s];
        let bestCols = 1, best = Infinity;
        for (let c2 = 1; c2 <= n; c2++) {
            const extra = n % c2;
            if (c2 % 2 === 0 && extra % 2 === 1) continue;
            const rows = Math.floor(n / c2) + (extra > 0 ? 1 : 0);
            const score = Math.abs(Math.log((c2 * d.widthCm) / (rows * d.heightCm) / 1.7)) + (extra > 0 ? 0.3 : 0);
            if (score < best) { best = score; bestCols = c2; }
        }
        const counts = Array.from({ length: bestCols }, () => Math.floor(n / bestCols));
        let extra = n % bestCols;
        if (extra % 2 === 1) { counts[Math.floor(bestCols / 2)]++; extra--; }
        let left = Math.floor(bestCols / 2) - 1, right = bestCols - 1 - left;
        while (extra > 0) { counts[left--]++; counts[right++]++; extra -= 2; }
        return counts;
    }

    function galleryColumns(n, cols) {
        let c2 = cols % 2 === 0 ? cols + 1 : cols;
        if (c2 > n) c2 = n % 2 === 1 ? n : n - 1;
        const mid = Math.floor(c2 / 2);
        const weight = Array.from({ length: c2 }, (_, i) => 1 + Math.min(i, c2 - 1 - i));
        const counts = Array.from({ length: c2 }, () => 1);
        let rem = n - c2;
        if (rem % 2 === 1) { counts[mid]++; rem--; }
        while (rem >= 2) {
            let pick = mid, bestRatio = weight[mid] / counts[mid];
            for (let i = 0; i < mid; i++) {
                const r = weight[i] / counts[i];
                if (r > bestRatio) { bestRatio = r; pick = i; }
            }
            if (pick === mid) counts[mid] += 2;
            else { counts[pick]++; counts[c2 - 1 - pick]++; }
            rem -= 2;
        }
        return counts;
    }

    const packCache = new Map();
    function packLayout(style, size, count) {
        const key = `${style}-${size}-${count}`;
        if (packCache.has(key)) return packCache.get(key);
        const d = SIZES[size];
        const even = evenColumns(count, size);
        let counts = even;
        if (style === 'gallery') {
            const rows = Math.max(...even);
            for (let c2 = even.length; ; c2 += 2) {
                counts = galleryColumns(count, c2);
                if (Math.max(...counts) <= rows + 1 || c2 >= count) break;
            }
        }
        const layout = {
            name: ARRANGEMENTS[style] || style,
            description: `${count} ${d.label} posters`,
            cols: counts.map((k, i) => ({
                items: Array.from({ length: k }, () => size),
                dy: style === 'zigzag' ? (i % 2 === 1 ? d.heightCm * 0.35 : 0) : style === 'cascade' ? i * d.heightCm * 0.22 : 0,
            })),
        };
        packCache.set(key, layout);
        return layout;
    }

    function arrangementsFor(size, count) {
        const shape = l => l.cols.map(col => col.items.length).join();
        return ['grid',
            ...(count > 2 ? ['zigzag', 'cascade'] : []),
            ...(count > 4 && shape(packLayout('gallery', size, count)) !== shape(packLayout('grid', size, count)) ? ['gallery'] : [])];
    }

    /* ── Prices (rupees, same MRP / offer rule as every other product) ── */
    const num = v => Number(v) || 0;
    function offer(o, d) {
        o = num(o); d = num(d);
        const hasDisc = d > 0 && d < o;
        return { original: o, price: hasDisc ? d : o, discountPercent: hasDisc ? Math.round((o - d) / o * 100) : 0 };
    }

    /** Price of a wall layout, or null when it is not offered. */
    function wallPrice(cfg, key) {
        const l = cfg && cfg.wall && cfg.wall.layouts && cfg.wall.layouts[key];
        if (!LAYOUTS[key] || !l || l.enabled === false || !(num(l.priceOriginal) > 0)) return null;
        return offer(l.priceOriginal, l.priceDiscount);
    }

    /** Price of a pack of `count` posters in `size` (A4 price ± the size's percent), or null. */
    function packPrice(cfg, size, count) {
        const sz = cfg && cfg.pack && cfg.pack.sizes && cfg.pack.sizes[size];
        const pk = cfg && cfg.pack && (cfg.pack.packs || []).find(p => num(p.count) === count);
        if (!PACK_SIZES.includes(size) || !sz || sz.enabled === false || !pk || !(num(pk.priceOriginal) > 0) || count > MAX_SLOTS) return null;
        const f = 1 + num(sz.adjustPercent) / 100;
        return offer(Math.round(num(pk.priceOriginal) * f), num(pk.priceDiscount) > 0 ? Math.round(num(pk.priceDiscount) * f) : 0);
    }

    const enabledLayouts = cfg => Object.keys(LAYOUTS).filter(k => wallPrice(cfg, k));
    const enabledPackSizes = cfg => PACK_SIZES.filter(s => (cfg?.pack?.packs || []).some(p => packPrice(cfg, s, num(p.count))));
    const enabledPacks = (cfg, size) => (cfg?.pack?.packs || []).map(p => num(p.count)).filter(n => packPrice(cfg, size, n)).sort((a, b) => a - b);

    return {
        SIZES, PACK_SIZES, MAX_SLOTS, LAYOUTS, ARRANGEMENTS,
        slotSizes, geometry, feet, packLayout, arrangementsFor,
        wallPrice, packPrice, enabledLayouts, enabledPackSizes, enabledPacks,
    };
});
