// WhatsApp Web - Monitoramento resiliente com LOGS e fallback de container
function captureMessages() {
    // ========= CONFIG DE LOG =========
    const SHOW_LOGS = 0; // 1 = mostrar logs no console, 0 = ocultar todos os logs
    const LEVELS = { ERROR: 0, WARN: 1, INFO: 2, DEBUG: 3, VERBOSE: 4 };
    const LOG_LEVEL = "VERBOSE";
    const CURRENT = LEVELS[LOG_LEVEL] ?? LEVELS.DEBUG;
    const log = (level, scope, msg, data) => {
        if (!SHOW_LOGS) return;
        const lvl = LEVELS[level] ?? LEVELS.INFO;
        if (lvl > CURRENT) return;
        const time = new Date().toLocaleTimeString();
        const prefix = `%c[WPP][${time}][${level}][${scope}]`;
        const style = level === "ERROR" ? "color:#ef4444;font-weight:bold"
            : level === "WARN" ? "color:#f59e0b;font-weight:bold"
                : level === "INFO" ? "color:#3b82f6;font-weight:bold"
                    : level === "DEBUG" ? "color:#10b981;font-weight:bold"
                        : "color:#a855f7;font-weight:bold";
        (data !== undefined) ? console.log(prefix, style, msg, data) : console.log(prefix, style, msg);
    };
    const group = (scope, label) => { if (!SHOW_LOGS) return; console.groupCollapsed(`%c[WPP][${scope}] ${label}`, "color:#7c3aed;font-weight:bold"); };
    const groupEnd = () => { if (!SHOW_LOGS) return; console.groupEnd(); };

    log("INFO", "INIT", "🔍 Iniciando monitoramento do WhatsApp Web...");

    let observer = null;
    let lastChat = "";
    let currentEmail = null;
    let currentPassword = null;
    let lydiaToken = localStorage.getItem('lydiaToken') || null;
    let peopleId;
    const blockedNumbers = new Set();

    // ======== STATE / STORAGE ========
    const getSentMessages = () => {
        const stored = localStorage.getItem("sentMessageIds");
        try {
            const set = stored ? new Set(JSON.parse(stored)) : new Set();
            log("DEBUG", "STATE", `sentMessageIds carregado (${set.size} itens)`);
            return set;
        } catch (e) {
            log("WARN", "STATE", "Falha ao parsear sentMessageIds. Limpando...", e);
            localStorage.removeItem("sentMessageIds");
            return new Set();
        }
    };
    const saveSentMessages = (set) => {
        localStorage.setItem("sentMessageIds", JSON.stringify(Array.from(set)));
        log("DEBUG", "STATE", `sentMessageIds salvo (${set.size} itens)`);
    };
    let sentMessages = getSentMessages();
    const pendingMessageIds = new Set();

    // ======== AUTH ========
    const loginAndGetToken = async (email, password) => {
        group("AUTH", "Tentando login e obtenção do token");
        const formData = new FormData();
        formData.append('username', email);
        formData.append('password', password);
        try {
            const res = await fetch('https://apilydia.lydia.com.br/login', { method: 'POST', body: formData });
            log("INFO", "AUTH", `Status da resposta: ${res.status}`);
            const text = await res.text();
            let data;
            try { data = JSON.parse(text); } catch { log("ERROR","AUTH","JSON inválido de login", text); groupEnd(); return null; }
            const token = data?.data?.TOKEN_LYDIA;
            peopleId = data?.data?.PEOPLE_ID;
            log("DEBUG","AUTH","Campos extraídos",{ hasToken:!!token, peopleId });
            if (!token) { log("ERROR","AUTH","Token não encontrado"); groupEnd(); return null; }
            localStorage.setItem('lydiaToken', token);
            lydiaToken = token;
            log("INFO","AUTH","Token salvo no localStorage");
            groupEnd();
            return token;
        } catch (error) {
            log("ERROR", "AUTH", "Erro ao obter o token", error);
            groupEnd();
            return null;
        }
    };

    const askForCredentials = () => new Promise((resolve) => {
        group("AUTH", "Abrindo modal de credenciais");
        const savedEmail = localStorage.getItem('userEmail') || '';
        const savedPassword = localStorage.getItem('userPassword') || '';
        const style = document.createElement('style');
        style.innerHTML = `#emailInput::placeholder,#passwordInput::placeholder{color:black!important}`;
        document.head.appendChild(style);
        const modal = document.createElement('div');
        modal.style = `position:fixed;inset:0;background:rgba(0,0,0,0.6);display:flex;justify-content:center;align-items:center;z-index:9999;`;
        modal.innerHTML = `
            <div style="background:white;padding:20px;border-radius:10px;text-align:center;min-width:300px;box-shadow:0 0 15px rgba(0,0,0,0.3);">
                <h3 style="margin-bottom:10px;">Informe seu e-mail e senha</h3>
                <input type="email" id="emailInput" placeholder="E-mail" value="${savedEmail}"
                    style="padding:8px;width:90%;margin-bottom:10px;border:2px solid #ccc;border-radius:5px;font-size:16px;color:black;" />
                <input type="password" id="passwordInput" placeholder="Senha" value="${savedPassword}"
                    style="padding:8px;width:90%;border:2px solid #ccc;border-radius:5px;font-size:16px;color:black;" />
                <br><br>
                <button id="confirmBtn" style="padding:10px 20px;font-size:16px;" disabled>Confirmar</button>
            </div>`;
        document.body.appendChild(modal);
        const emailInput = modal.querySelector('#emailInput');
        const passwordInput = modal.querySelector('#passwordInput');
        const confirmBtn = modal.querySelector('#confirmBtn');
        const updateValidation = () => {
            const validEmail = emailInput.value.includes('@');
            const validPassword = passwordInput.value.length >= 3;
            confirmBtn.disabled = !(validEmail && validPassword);
            emailInput.style.borderColor = validEmail ? 'green' : 'red';
            passwordInput.style.borderColor = validPassword ? 'green' : 'red';
            log("VERBOSE","AUTH","Validação",{validEmail,validPassword});
        };
        emailInput.addEventListener('keyup', updateValidation);
        passwordInput.addEventListener('keyup', updateValidation);
        setTimeout(updateValidation, 100);
        confirmBtn.addEventListener('click', async () => {
            currentEmail = emailInput.value.trim();
            currentPassword = passwordInput.value;
            localStorage.setItem('userEmail', currentEmail);
            localStorage.setItem('userPassword', currentPassword);
            log("INFO","AUTH","Credenciais informadas",{email:currentEmail, passLen: currentPassword.length});
            document.body.removeChild(modal);
            const token = await loginAndGetToken(currentEmail, currentPassword);
            if (!token) alert("Erro ao fazer login. Verifique suas credenciais."); else resolve();
        });
        groupEnd();
    });

    // ======== DOM HELPERS ========
    const findChatContainer = () => {
        const candidates = [
            'main[tabindex="-1"]',                 // layout atual do WA
            'main[role="main"]',                   // variação possível
            '#app',                                // raiz principal
            'div[role="application"]'              // seletor antigo
        ];
        for (const sel of candidates) {
            const el = document.querySelector(sel);
            if (el) { log("INFO","DOM","Container selecionado", {selector: sel}); return { el, selector: sel }; }
        }
        log("WARN","DOM","Nenhum container conhecido encontrado. Usando document.body (fallback).");
        return { el: document.body, selector: "document.body" };
    };

    const getChatName = () => {
        // tenta vários seletores para título do chat
        const sels = [
            'header [data-testid="conversation-info-header-chat-title"]',
            'header [data-testid="conversation-info-header"] span[dir="auto"]',
            'header div[role="button"] span[dir="auto"]',
            'header span[title]'
        ];
        for (const s of sels) {
            const el = document.querySelector(s);
            if (el?.textContent?.trim()) {
                const name = el.textContent.trim();
                log("VERBOSE","CHAT","Nome do chat atual", { name, selector: s });
                return name;
            }
        }
        log("VERBOSE","CHAT","Nome do chat não encontrado em seletores conhecidos");
        return "";
    };

    const parseWhatsAppTime = (el) => {
        try {
            const raw = el.getAttribute("data-pre-plain-text");
            if (!raw) return null;
            // exemplo: [16:12, 21/08/2025] Nome:
            const match = raw.match(/\[(\d{2}:\d{2}),\s*(\d{1,2}\/\d{1,2}\/\d{4})\]/);
            if (!match) { log("DEBUG","UTIL","Regex não casou para data/hora", raw); return null; }
            const [_, hora, data] = match;
            const [dia, mes, ano] = data.split('/').map(Number);
            const [horas, minutos] = hora.split(':').map(Number);
            const dt = new Date(ano, mes - 1, dia, horas, minutos);
            return isNaN(dt.getTime()) ? null : dt;
        } catch (e) { log("ERROR","UTIL","Exceção no parseWhatsAppTime", e); return null; }
    };

    const getSenderNumber = (msg) => {
        try {
            const container = msg.closest('[data-id*="@c.us"]');
            const dataId = container?.getAttribute('data-id') || '';
            const match = dataId.match(/_(\d+)@c\.us/);
            return match ? match[1] : null;
        } catch { return null; }
    };

    const getPhoneNumber = () => {
        try {
            const el = document.querySelector("[data-id*='@c.us']");
            const dataId = el?.getAttribute("data-id") || '';
            const match = dataId.match(/_(\d+)@c\.us/);
            return match ? match[1] : null;
        } catch { return null; }
    };

    const formatDateTime = (time) => `${String(time.getDate()).padStart(2, '0')}/${String(time.getMonth() + 1).padStart(2, '0')}/${time.getFullYear()} ${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}`;

    const arrayBufferToBase64 = (buffer) => {
        let binary = '';
        const bytes = new Uint8Array(buffer);
        const chunkSize = 0x8000;
        for (let i = 0; i < bytes.length; i += chunkSize) {
            const chunk = bytes.subarray(i, i + chunkSize);
            binary += String.fromCharCode.apply(null, chunk);
        }
        return btoa(binary);
    };

    const dataUrlToMedia = (src) => {
        try {
            const match = src.match(/^data:(.+);base64,(.+)$/);
            if (!match) return null;
            const [, mimeType, base64] = match;
            return { mimeType: mimeType || 'application/octet-stream', base64 };
        } catch (error) {
            log("WARN", "MEDIA", "Falha ao converter data URL em base64", error);
            return null;
        }
    };

    const fetchMediaAsBase64 = async (src) => {
        try {
            const response = await fetch(src);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const blob = await response.blob();
            const buffer = await blob.arrayBuffer();
            return {
                mimeType: blob.type || 'application/octet-stream',
                base64: arrayBufferToBase64(buffer)
            };
        } catch (error) {
            log("WARN", "MEDIA", "Falha ao buscar mídia para base64", { src, error });
            return null;
        }
    };

    const findImageElementsInMessage = (msg) => {
        const container = msg.closest('[data-id]') || msg;
        if (!container) return [];
        const candidates = Array.from(container.querySelectorAll('img'));
        const results = [];
        const seenSrc = new Set();
        candidates.forEach(img => {
            const src = img.getAttribute('src') || '';
            if (!src) return;
            if (seenSrc.has(src)) return;
            const testId = (img.getAttribute('data-testid') || '').toLowerCase();
            if (testId.includes('emoji') || testId.includes('sticker') || testId.includes('avatar')) return;
            if (img.closest('[data-testid="quoted-message"]')) return;
            if (img.closest('[data-testid="chatlist-profile-picture"]') || img.closest('[data-testid="avatar"]')) return;
            const alt = img.getAttribute('alt') || '';
            const isBlobOrData = src.startsWith('blob:') || src.startsWith('data:');
            const isWhatsappMedia = src.includes('mmg.whatsapp.net') || src.includes('media.whatsapp.net');
            const flaggedByTestId = testId.includes('image') || !!img.closest('[data-testid*="image"]');
            if (!isBlobOrData && !isWhatsappMedia && !flaggedByTestId) return;
            if (!flaggedByTestId && alt.length > 0 && alt.length <= 2) return;
            seenSrc.add(src);
            results.push({ img, src });
        });
        return results;
    };

    const collectImageAttachments = async (imageEntries) => {
        const attachments = [];
        for (const { img, src } of imageEntries) {
            let mediaData = null;
            if (src.startsWith('data:')) {
                mediaData = dataUrlToMedia(src);
            } else {
                mediaData = await fetchMediaAsBase64(src);
            }
            if (!mediaData) continue;
            if (mediaData.mimeType === 'image/svg+xml') continue;
            attachments.push({
                type: 'image',
                mimeType: mediaData.mimeType,
                base64: mediaData.base64,
                name: img.getAttribute('alt') || null
            });
        }
        return attachments;
    };

    // ======== API ========
    const sendBatchToAPI = async (messages) => {
        const { selector } = findChatContainer();
        group("API", `📤 Enviando lote (${messages.length}) | root=${selector}`);
        log("DEBUG","API","Payload (amostra até 3)", messages.slice(0,3));

        try {
            const res = await fetch('https://apilydia.lydia.com.br/crmlydia/message', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + lydiaToken },
                body: JSON.stringify(messages)
            });

            log("INFO","API",`Resposta da API status: ${res.status}`);
            const raw = await res.text();
            let data = null;
            try {
                data = JSON.parse(raw);
                log("DEBUG","API","JSON parseado", data);
            } catch {
                log("WARN","API","⚠️ Resposta inesperada (não-JSON)", raw);
            }

            if (data?.data?.status === 2 && data?.data?.phone) {
                blockedNumbers.add(data.data.phone);
                log("WARN","API",`🛑 Número bloqueado por status 2: ${data.data.phone}`);
            }

            if (!res.ok) {
                log("WARN","API","❌ Lote não aceito pela API", { status: res.status, body: raw });
                return false;
            }

            log("INFO","API","✅ Lote enviado com sucesso");
            return true;
        } catch (error) {
            log("ERROR","API","❌ Erro ao enviar lote", error);
            return false;
        } finally {
            groupEnd();
        }
    };

    // ======== CAPTURA (últimas 24h) ========
    const buildPayloadFromMessage = async (msg, now, windowStart, skipped, batchIds) => {
        const messageText = msg.innerText?.trim() || '';
        const imageEntries = findImageElementsInMessage(msg);
        const hasText = !!messageText;
        const hasImages = imageEntries.length > 0;
        if (!hasText && !hasImages) { skipped.empty++; return null; }

        const sentByMe = msg.closest(".message-out") !== null;
        const time = parseWhatsAppTime(msg);
        if (!time) { skipped.invalidTime++; return null; }

        const senderNumber = getSenderNumber(msg);
        if (senderNumber && blockedNumbers.has(senderNumber)) { skipped.blocked++; return null; }

        const container = msg.closest('[data-id]');
        const dataId = container?.getAttribute('data-id')
            || `${messageText}-${time.toISOString()}-${sentByMe ? 'you' : 'them'}`;

        if (sentMessages.has(dataId) || pendingMessageIds.has(dataId) || batchIds.has(dataId)) {
            skipped.duplicate++;
            return null;
        }

        if (time < windowStart || time > now) {
            skipped.outOfWindow++;
            return null;
        }

        let media = [];
        if (hasImages) {
            media = await collectImageAttachments(imageEntries);
            if (media.length === 0 && !hasText) { skipped.empty++; return null; }
        }

        batchIds.add(dataId);

        const payload = {
            email: currentEmail,
            phone: getPhoneNumber(),
            sender: senderNumber,
            idPeople: peopleId,
            messageId: dataId,
            dateTime: formatDateTime(time),
            incoming: sentByMe ? 0 : 1,
            message: messageText,
            type: media.length > 0 ? 'image' : 'text'
        };

        if (media.length > 0) payload.media = media;
        return payload;
    };

    const captureMessagesFromLast24Hours = async () => {
        const { selector } = findChatContainer();
        group("CAPTURE", `📥 Capturando últimas 24h | root=${selector}`);
        const all = Array.from(document.querySelectorAll(".copyable-text[data-pre-plain-text]"));
        log("INFO","CAPTURE",`Mensagens no DOM: ${all.length}`);

        const now = new Date();
        const twentyFourHoursAgo = new Date(now.getTime() - (24 * 60 * 60 * 1000));
        const payloadList = [];
        const skipped = { empty:0, invalidTime:0, blocked:0, duplicate:0, outOfWindow:0 };
        const batchIds = new Set();
        const newMessageIds = [];

        for (const msg of all) {
            const payload = await buildPayloadFromMessage(msg, now, twentyFourHoursAgo, skipped, batchIds);
            if (payload) {
                payloadList.push(payload);
                newMessageIds.push(payload.messageId);
                pendingMessageIds.add(payload.messageId);
            }
        }

        log("INFO","CAPTURE",`Payload pronto: ${payloadList.length}`);
        log("DEBUG","CAPTURE","Estatísticas de descarte", skipped);
        if (payloadList.length > 0) {
            const success = await sendBatchToAPI(payloadList);
            if (success) {
                newMessageIds.forEach(id => {
                    pendingMessageIds.delete(id);
                    sentMessages.add(id);
                });
                saveSentMessages(sentMessages);
            } else {
                newMessageIds.forEach(id => pendingMessageIds.delete(id));
                log("WARN","CAPTURE","Lote não enviado; mensagens removidas da fila pendente", { count: newMessageIds.length });
            }
        }
        groupEnd();
    };

    // ======== OBSERVER (tempo real) ========
    const setupObserver = () => {
        const { el: root, selector } = findChatContainer();
        group("OBSERVER", `Configurando MutationObserver | root=${selector}`);

        if (!root) { log("ERROR","OBSERVER","Root indefinido"); groupEnd(); return; }

        // evita múltiplos observers
        if (observer) {
            observer.disconnect();
            log("INFO","OBSERVER","Observer antigo desconectado");
        }

        observer = new MutationObserver(mutations => {
            const processMutations = async () => {
                const now = new Date();
                const twentyFourHoursAgo = new Date(now.getTime() - (24 * 60 * 60 * 1000));
                const payloadList = [];
                const skipped = { empty:0, invalidTime:0, blocked:0, duplicate:0, outOfWindow:0 };
                const batchIds = new Set();
                const newMessageIds = [];
                let seen = 0;

                for (const mutation of mutations) {
                    for (const node of mutation.addedNodes) {
                        if (node.nodeType !== 1) continue;
                        const elements = [];
                        if (node.matches?.(".copyable-text[data-pre-plain-text]")) elements.push(node);
                        if (node.querySelectorAll) {
                            elements.push(...Array.from(node.querySelectorAll(".copyable-text[data-pre-plain-text]")));
                        }

                        for (const msg of elements) {
                            seen++;
                            const payload = await buildPayloadFromMessage(msg, now, twentyFourHoursAgo, skipped, batchIds);
                            if (payload) {
                                payloadList.push(payload);
                                newMessageIds.push(payload.messageId);
                                pendingMessageIds.add(payload.messageId);
                            }
                        }
                    }
                }

                log("INFO","OBSERVER",`Mutations processadas: ${seen} → payload ${payloadList.length}`);
                log("DEBUG","OBSERVER","Estatísticas de descarte", skipped);
                if (payloadList.length > 0) {
                    const success = await sendBatchToAPI(payloadList);
                    if (success) {
                        newMessageIds.forEach(id => {
                            pendingMessageIds.delete(id);
                            sentMessages.add(id);
                        });
                        saveSentMessages(sentMessages);
                    } else {
                        newMessageIds.forEach(id => pendingMessageIds.delete(id));
                        log("WARN","OBSERVER","Lote não enviado; mensagens removidas da fila pendente", { count: newMessageIds.length });
                    }
                }
            };

            processMutations().catch(error => log("ERROR","OBSERVER","Erro ao processar mutations", error));
        });

        observer.observe(root, { childList: true, subtree: true });
        // diagnóstico
        const currentCount = document.querySelectorAll(".copyable-text[data-pre-plain-text]").length;
        log("INFO","OBSERVER",`Observação iniciada. Mensagens visíveis agora: ${currentCount}`);
        groupEnd();
    };

    // ======== CHAT CHANGE ========
    const checkForChatChange = async () => {
        const currentChat = getChatName();
        if (currentChat && currentChat !== lastChat) {
            log("INFO","CHAT",`Mudança de chat detectada: "${lastChat}" -> "${currentChat}"`);
            lastChat = currentChat;
            // roda direto sem depender de waitForChat
            await captureMessagesFromLast24Hours();
            setupObserver();
        } else {
            log("VERBOSE","CHAT","Sem mudança de chat", { lastChat, currentChat });
        }
    };

    // ======== INIT ========
    const initMonitoring = async () => {
        group("INIT","Inicializando fluxo");
        if (lydiaToken) log("INFO","INIT","Reutilizando token do localStorage");
        await askForCredentials();
        log("INFO","INIT","Credenciais OK", { email: currentEmail, hasToken: !!lydiaToken });

        // dispara imediatamente (sem aguardar seletor específico)
        await captureMessagesFromLast24Hours();
        setupObserver();

        // monitora troca de conversa
        setInterval(() => { checkForChatChange(); }, 1000);

        // diagnósticos extras
        const { selector } = findChatContainer();
        const existsMap = ['main[tabindex="-1"]','#app','div[role="application"]','body'].reduce((acc, s) => {
            acc[s] = !!document.querySelector(s) || (s==='body');
            return acc;
        }, {});
        log("DEBUG","INIT","Seletores disponíveis", existsMap);
        groupEnd();
    };

    window.addEventListener('beforeunload', () => {
        log("INFO","INIT","Página descarregando. Salvando estado...");
        if (pendingMessageIds.size === 0) {
            saveSentMessages(sentMessages);
        } else {
            log("WARN","INIT",`Pulando persistência: ${pendingMessageIds.size} mensagens pendentes`);
        }
        if (observer) observer.disconnect();
    });

    initMonitoring();
}

// bootstrap
if (document.readyState === 'complete') {
    console.log("[WPP][BOOT] document.readyState=complete -> iniciando captureMessages()");
    captureMessages();
} else {
    console.log("[WPP][BOOT] aguardando window.load para iniciar captureMessages()");
    window.addEventListener('load', captureMessages);
}
