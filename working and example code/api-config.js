/**
 * API base for shell + QR / Link / Multi / admin.
 *
 * - Self-hosted (slug.ROOT ya custom apex on AlexHost Caddy): same-origin —
 *   /api/* Caddy se Render proxy hota hai; tenant hostname X-Forwarded-Host se resolve.
 * - *.pages.dev · *.onrender.com · localhost: Render (fallback) — wahan same-origin /api nahi.
 *
 * Fallback: `npm run pages:config` (PAGES_API_URL / API_PUBLIC_URL) se overwrite —
 * tab bhi same-origin rule generate hoti hai, sirf fallback URL .env se aata hai.
 */
(function () {
    var fallback = 'https://qrperfect-automation.onrender.com';
    var h =
        typeof location !== 'undefined' && location.hostname
            ? String(location.hostname).toLowerCase()
            : '';
    if (!h) {
        window.__AUTOMATION_API_BASE__ = fallback;
        return;
    }
    var isPagesOrLocal =
        h.endsWith('.pages.dev') ||
        h.endsWith('.onrender.com') ||
        h === 'localhost' ||
        h.startsWith('127.') ||
        h.startsWith('0.0.0.0');
    if (isPagesOrLocal) {
        window.__AUTOMATION_API_BASE__ = fallback;
        return;
    }
    var o = String(location.origin || '');
    if (o.endsWith('/')) o = o.slice(0, -1);
    window.__AUTOMATION_API_BASE__ = o;
})();
