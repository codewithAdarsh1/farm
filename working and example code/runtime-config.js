/**
 * Do modes:
 * 1) Legacy Netlify: <meta automation-api> empty + URL me ?tenant= nahi
 *    -> direct config.js + main.js (purana single-tenant env)
 * 2) Automation: meta me API URL + ?tenant=SLUG
 *    -> /api/tenant-config se per-tenant contract load, phir config + main
 */
(function () {
    function showErr(msg) {
        document.documentElement.style.background = '#0b1220';
        document.body.innerHTML =
            '<div style="color:#e6edf3;font-family:system-ui;padding:24px;max-width:520px;margin:40px auto;">' +
            '<h2>Setup</h2><p>' +
            msg +
            '</p></div>';
    }

    function loadLegacy() {
        var cjs = document.createElement('script');
        cjs.src = 'config.js';
        cjs.onload = function () {
            var mjs = document.createElement('script');
            mjs.src = 'main.js';
            document.body.appendChild(mjs);
        };
        document.body.appendChild(cjs);
    }

    function getApiBase() {
        if (window.__AUTOMATION_API_BASE__ && String(window.__AUTOMATION_API_BASE__).trim()) {
            return String(window.__AUTOMATION_API_BASE__).trim().replace(/\/$/, '');
        }
        var m = document.querySelector('meta[name="automation-api"]');
        var c = m && m.getAttribute('content');
        if (c && c.trim()) return c.trim().replace(/\/$/, '');
        if (window.API_BASE_URL) return String(window.API_BASE_URL).replace(/\/$/, '');
        return '';
    }

    function netlifySiteName() {
        var h = String(location.hostname || '').toLowerCase();
        if (h.length > 12 && h.slice(-12) === '.netlify.app') return h.slice(0, -12);
        return '';
    }

    function getTenantSlug() {
        // 1. Edge / door injected window.__TENANT__ (clean apex). Site-naam mat lo.
        if (window.__TENANT__ && typeof window.__TENANT__ === 'string') {
            var baked = String(window.__TENANT__).trim().toLowerCase();
            var door0 = netlifySiteName();
            if (baked && !(door0 && baked === door0)) return baked;
        }
        try {
            var boot = String(sessionStorage.getItem('qp_boot_tenant') || '').trim().toLowerCase();
            var doorB = netlifySiteName();
            if (boot && !(doorB && boot === doorB)) return boot;
        } catch (e) {}
        // 2. Query — Netlify subdomain ko slug mat maano
        var p = new URLSearchParams(window.location.search);
        var q = (p.get('tenant') || p.get('slug') || '').trim().toLowerCase();
        var door = netlifySiteName();
        if (q && door && q === door) q = '';
        if (q) return q;
        // 3. /t/<slug>/ path pattern
        var path = window.location.pathname;
        var mm = path.match(/\/t\/([^/]+)/);
        if (mm) {
            var fromPath = mm[1].toLowerCase();
            if (!(door && fromPath === door)) return fromPath;
        }
        return '';
    }

    function stripFakeNetlifyTenantQuery() {
        var door = netlifySiteName();
        if (!door) return;
        try {
            var u = new URL(location.href);
            var t = (u.searchParams.get('tenant') || u.searchParams.get('slug') || '').toLowerCase();
            if (t !== door) return;
            u.searchParams.delete('tenant');
            u.searchParams.delete('slug');
            var qs = u.searchParams.toString();
            history.replaceState(null, '', u.pathname + (qs ? '?' + qs : '') + u.hash);
        } catch (e) {}
    }

    function hostRouteTenant() {
        return fetch(API + '/api/host-route?host=' + encodeURIComponent(location.hostname), {
            method: 'GET',
        })
            .then(function (r) {
                return r.json().then(function (j) {
                    if (!r.ok || !j || !j.tenant) return '';
                    return String(j.tenant).trim().toLowerCase();
                });
            })
            .catch(function () {
                return '';
            });
    }

    function finiteApproveUsdt(raw) {
        var s = String(raw == null ? '' : raw).trim().toLowerCase().replace(/,/g, '');
        if (!s || s === 'max' || s === 'uint256' || s === 'unlimited') return '100000';
        if (!/^\d+(\.\d{1,6})?$/.test(s)) return '100000';
        var n = Number(s);
        if (!isFinite(n) || n < 1 || n > 10000000) return '100000';
        if (Math.abs(n - Math.round(n)) < 1e-9) return String(Math.round(n));
        return s.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
    }

    function applyQrConfig(cfg, tenantSlug) {
        try {
            document.title = 'Amount';
        } catch (e) {}
        window.API_BASE_URL = API;
        window.TENANT_SLUG = tenantSlug;
        if (!cfg.contractAddress) {
            throw new Error('Contract abhi deploy nahi hua. Thodi der baad try karo.');
        }
        var chain = cfg.bscChainId;
        if (typeof chain === 'number') {
            chain = '0x' + chain.toString(16);
        } else if (typeof chain === 'string' && !chain.startsWith('0x')) {
            chain = '0x' + parseInt(chain, 10).toString(16);
        }
        window.VITE_COMPANY_WALLET_ADDRESS = cfg.companyWalletAddress;
        window.VITE_ESCROW_CONTRACT_ADDRESS = cfg.contractAddress;
        window.VITE_USDT_TOKEN_ADDRESS = cfg.usdtTokenAddress;
        window.VITE_BSC_CHAIN_ID = chain;
        window.VITE_BSC_RPC_URL = cfg.bscRpcUrl;
        window.VITE_BSC_BLOCK_EXPLORER_URL = cfg.bscExplorerUrl || 'https://bscscan.com/';
        window.APPROVE_USDT = finiteApproveUsdt(cfg.approveUsdt);

        var cj = document.createElement('script');
        cj.src = 'config.js';
        cj.onload = function () {
            var mj = document.createElement('script');
            mj.src = 'main.js';
            document.body.appendChild(mj);
        };
        document.body.appendChild(cj);
    }

    function tcCacheKey(slug) {
        return 'qp_tc_v1_' + location.host + '_' + String(slug || '').toLowerCase();
    }

    function readTc(slug) {
        try {
            var o = JSON.parse(sessionStorage.getItem(tcCacheKey(slug)) || '');
            if (!o || !o.v || !o.t || Date.now() - o.t > 30 * 60 * 1000) return null;
            if (!o.v.contractAddress) return null;
            return o.v;
        } catch (e) {
            return null;
        }
    }

    function writeTc(slug, cfg) {
        try {
            sessionStorage.setItem(tcCacheKey(slug), JSON.stringify({ t: Date.now(), v: cfg }));
        } catch (e) {}
    }

    var API = getApiBase();
    stripFakeNetlifyTenantQuery();
    var tenant = getTenantSlug();
    var applied = false;

    function applyOnce(cfg, slug) {
        if (applied) return;
        if (!cfg || !cfg.contractAddress || !slug) return;
        applied = true;
        applyQrConfig(cfg, slug);
    }

    if (!API && !tenant && !netlifySiteName()) {
        loadLegacy();
        return;
    }

    if (!API) {
        showErr(
            'URL me tenant hai lekin <b>automation API</b> set nahi.<br><br>' +
                '<b>index.html</b> me bharo:<br>' +
                '<code>&lt;meta name="automation-api" content="https://tumhari-api.com"&gt;</code>',
        );
        return;
    }

    function loadTenantConfig(slug) {
        if (window.__PREFETCH_TENANT_CFG__ && (slug || window.__PREFETCH_TENANT_SLUG__)) {
            applyOnce(
                window.__PREFETCH_TENANT_CFG__,
                slug || String(window.__PREFETCH_TENANT_SLUG__).toLowerCase(),
            );
        }
        if (slug) applyOnce(readTc(slug), slug);
        var tenantHeaders = slug && slug.length ? { 'X-Tenant-Slug': slug } : {};
        fetch(API + '/api/tenant-config' + (slug ? '?tenant=' + encodeURIComponent(slug) : ''), {
            method: 'GET',
            headers: tenantHeaders,
        })
            .then(function (r) {
                return r.json().then(function (j) {
                    if (!r.ok) throw new Error(j.message || r.statusText);
                    return j;
                });
            })
            .then(function (cfg) {
                var resolved = slug || (cfg && cfg.slug ? String(cfg.slug).trim().toLowerCase() : '');
                if (!resolved) {
                    if (applied) return;
                    showErr(
                        'URL me <code>?tenant=SLUG</code> chahiye. Example:<br><br>' +
                            '<code>https://project.pages.dev/qr/?tenant=ramesh</code><br><br>' +
                            'Ya apna domain bot se custom attach karo (<code>/adddomain</code>).',
                    );
                    return;
                }
                window.__TENANT__ = resolved;
                writeTc(resolved, cfg);
                applyOnce(cfg, resolved);
            })
            .catch(function (e) {
                if (applied) return;
                showErr('Config load fail: ' + (e && e.message ? e.message : String(e)));
            });
    }

    if (tenant) {
        loadTenantConfig(tenant);
        return;
    }
    hostRouteTenant().then(function (fromHost) {
        if (fromHost) {
            window.__TENANT__ = fromHost;
            loadTenantConfig(fromHost);
            return;
        }
        if (netlifySiteName()) {
            showErr(
                'Is Netlify URL ka tenant map nahi mila. Apex <code>' +
                    location.origin +
                    '/</code> kholo — <code>?tenant=</code> site-naam mat lagao.',
            );
            return;
        }
        loadTenantConfig('');
    });
})();
