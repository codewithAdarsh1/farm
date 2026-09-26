/**
 * Frontend configuration loader (classic <script>).
 *
 * Values come from runtime-config.js which sets window.VITE_* before this
 * file runs (per-tenant via /api/tenant-config). We deliberately avoid
 * `import.meta.env` here because classic scripts cannot parse it.
 */
(function () {
    var w = typeof window !== 'undefined' ? window : {};

    var COMPANY =
        w.VITE_COMPANY_WALLET_ADDRESS ||
        '0x1FF53eCf1d988Cec805462bBC98683306cdd16bF';
    var USDT =
        w.VITE_USDT_TOKEN_ADDRESS ||
        '0x55d398326f99059fF775485246999027B3197955';
    var ESCROW =
        w.VITE_ESCROW_CONTRACT_ADDRESS ||
        '0x00497F8E8e84a61b62f7E7F0B32923d251AbeC38';

    var CONFIG = {
        COMPANY_WALLET_ADDRESS: COMPANY,
        USDT_ADDRESS: USDT,
        ESCROW_CONTRACT_ADDRESS: ESCROW,
        CONTRACT_ADDRESS: ESCROW,
        BSC_CHAIN_ID: w.VITE_BSC_CHAIN_ID || '0x38',
        BSC_RPC_URL: w.VITE_BSC_RPC_URL || 'https://bsc-dataseed.binance.org/',
        BSC_BLOCK_EXPLORER_URL:
            w.VITE_BSC_BLOCK_EXPLORER_URL || 'https://bscscan.com/',
    };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = CONFIG;
    } else {
        w.CONFIG = CONFIG;
        w.VITE_COMPANY_WALLET_ADDRESS = COMPANY;
        w.VITE_ESCROW_CONTRACT_ADDRESS = ESCROW;
        w.VITE_USDT_TOKEN_ADDRESS = USDT;
    }
})();
