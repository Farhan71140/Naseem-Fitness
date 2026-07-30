/* ================================================================
   NF NASEEM FITNESS — AI Customer Assistant (Powered by Groq — FREE)

   SETUP — 2 simple steps:
   1. Deploy the Cloudflare Worker below (workers.cloudflare.com — free,
      no card required)
   2. Paste your Worker URL into WORKER_URL below

   ── CLOUDFLARE WORKER CODE ──────────────────────────────────────
   Go to workers.cloudflare.com → sign up (free) → Create Worker →
   delete the sample code → paste this in:

   export default {
     async fetch(request) {
       if (request.method === 'OPTIONS') {
         return new Response(null, {
           headers: {
             'Access-Control-Allow-Origin': '*',
             'Access-Control-Allow-Methods': 'POST',
             'Access-Control-Allow-Headers': 'Content-Type',
           }
         });
       }
       const body = await request.json();
       const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
         method: 'POST',
         headers: {
           'Content-Type': 'application/json',
           'Authorization': 'Bearer YOUR_GROQ_API_KEY_HERE'
         },
         body: JSON.stringify(body)
       });
       const data = await response.json();
       return new Response(JSON.stringify(data), {
         headers: {
           'Content-Type': 'application/json',
           'Access-Control-Allow-Origin': '*'
         }
       });
     }
   };
   ────────────────────────────────────────────────────────────────
   1. Get a free Groq API key at console.groq.com/keys
   2. Replace YOUR_GROQ_API_KEY_HERE above with that key
   3. Click Deploy → copy the Worker URL (looks like
      https://nf-ai.yourname.workers.dev) → paste it below
================================================================ */

(function () {

  /* ── PASTE YOUR CLOUDFLARE WORKER URL HERE ── */
  const WORKER_URL = 'https://withered-silence-f59b.mfarhanuddin47.workers.dev/';

  /* ── STORE INFO (kept in sync with the site) ── */
  const STORE_INFO = `
NF Naseem Fitness — Official Mumbai Branch
Address: Ground Floor, Shop 2, Kajipura Haji Kasam Chawl No. 23, Maulana Azad Road, Nagpada, Two Tank, Mumbai, Maharashtra 400008
Phone / WhatsApp: +91 77382 42258
Hours: Mon–Sun, 10:00 AM – 9:30 PM
Delivery: Free shipping across Mumbai on orders ₹999+, same-day delivery available
Authenticity: Every tub sold is batch-verified before it reaches the customer — customers can verify their batch code on the "Verify Product" section of the site. 100% genuine stock, no fakes.
Categories: Whey protein, creatine, pre-workouts, multivitamins, and general gym supplements.
`;

  /* Builds a live product catalog snippet from whatever is loaded on the page right now (window.PRODUCTS, populated by the store's own product loader). Falls back gracefully if products haven't loaded yet. */
  function getProductCatalog() {
    try {
      const list = window.PRODUCTS;
      if (!Array.isArray(list) || list.length === 0) {
        return 'Live product catalog is loading — if unsure of exact current stock/price, tell the customer to check the Shop section or ask on WhatsApp for the latest price.';
      }
      return list.slice(0, 60).map(p => {
        const price = p.price ? `₹${Number(p.price).toLocaleString('en-IN')}` : 'price on request';
        const brand = p.brand ? `${p.brand} ` : '';
        const cat = p.category ? ` | ${p.category}` : '';
        const stockStatus = (p.stock === undefined || p.stock === null) ? '' : (Number(p.stock) > 0 ? ` | In Stock (${Number(p.stock)} left)` : ' | OUT OF STOCK');
        return `- ${brand}${p.name} | ${price}${cat}${stockStatus}`;
      }).join('\n');
    } catch (e) {
      return 'Live product catalog unavailable right now — direct the customer to the Shop section or WhatsApp.';
    }
  }

  function getSystemPrompt() {
    return `You are Merlin, a friendly and knowledgeable AI assistant for NF Naseem Fitness — a verified, genuine supplement store in Nagpada, Mumbai.

Your job is to help customers:
1. Find the right supplement (whey protein, creatine, pre-workout, multivitamins) for their goals
2. Answer questions about products, prices, authenticity, delivery, and store hours
3. Guide them to WhatsApp for orders or questions you can't fully answer

${STORE_INFO}

Current product catalog (live from the store):
${getProductCatalog()}

Guidelines:
- Be warm, helpful, and concise. Use simple language.
- When recommending a product, mention its name and price if you have it.
- If a customer asks whether a specific product (by name or brand, e.g. "Mars Whey Protein") is available: check the "Current product catalog" list above. If it's marked OUT OF STOCK, tell them it's currently out of stock and offer to check on WhatsApp or suggest a similar in-stock alternative from the catalog. If it doesn't appear in the catalog at all, tell them it's not currently listed. Otherwise confirm it's in stock and give its price.
- If a customer asks their goal (bulking, cutting, general fitness), ask 1 clarifying question if needed, then recommend accordingly.
- Always mention that stock is 100% genuine and batch-verified when relevant.
- Keep responses short — max 4-5 lines. Use bullet points when listing products.
- Do NOT answer questions unrelated to supplements, fitness, or the shop.
- End with an offer to connect them to WhatsApp for ordering when appropriate.
- Respond in the same language the customer uses (Hindi or English).`;
  }

  /* ── CONVERSATION HISTORY ── */
  let chatHistory = [];

  /* ── INJECT STYLES ── */
  const style = document.createElement('style');
  style.textContent = `
    #nf-chat-widget {
      position: fixed;
      bottom: 24px;
      right: 20px;
      z-index: 99999;
      font-family: 'Space Mono', monospace;
    }
    #nf-chat-widget.nf-dragging #nf-chat-toggle {
      transition: none;
      box-shadow: 0 10px 34px rgba(255,210,74,0.55);
    }

    #nf-chat-toggle {
      height: 52px;
      padding: 0 20px 0 16px;
      border-radius: 50px;
      background: linear-gradient(135deg, var(--teal, #FFD24A), var(--amber, #FFE27A));
      border: none;
      cursor: grab;
      touch-action: none;
      user-select: none;
      -webkit-user-select: none;
      box-shadow: 0 6px 24px rgba(255,210,74,0.35);
      display: flex;
      align-items: center;
      gap: 9px;
      position: relative;
      transition: transform 0.2s, box-shadow 0.2s;
    }
    #nf-chat-toggle:active { cursor: grabbing; }
    #nf-chat-toggle:hover {
      transform: scale(1.05);
      box-shadow: 0 8px 30px rgba(255,210,74,0.5);
    }
    #nf-chat-toggle .toggle-icon { width: 40px; height: 40px; border-radius: 50%; object-fit: cover; display: block; flex-shrink: 0; }
    #nf-chat-toggle .toggle-label {
      color: #0A0806;
      font-size: 12.5px;
      font-weight: 700;
      letter-spacing: 0.5px;
      white-space: nowrap;
      text-transform: uppercase;
    }
    #nf-chat-toggle .chat-notif {
      position: absolute;
      top: -3px; right: -3px;
      width: 15px; height: 15px;
      background: #2ECC71;
      border-radius: 50%;
      border: 2px solid #0A0806;
      animation: nfPulse 2s infinite;
    }
    @keyframes nfPulse {
      0%,100% { transform: scale(1); }
      50%      { transform: scale(1.25); }
    }

    #nf-chat-box {
      position: absolute;
      bottom: 64px;
      right: 0;
      width: 370px;
      max-height: 540px;
      background: var(--steel, #17130D);
      border: 1px solid var(--line, rgba(255,210,74,0.18));
      border-radius: 18px;
      overflow: hidden;
      display: flex;
      flex-direction: column;
      box-shadow: 0 20px 60px rgba(0,0,0,0.7), 0 0 0 1px rgba(255,210,74,0.08);
      transform: scale(0.85) translateY(20px);
      transform-origin: bottom right;
      opacity: 0;
      pointer-events: none;
      transition: transform 0.3s cubic-bezier(.34,1.56,.64,1), opacity 0.25s ease;
    }
    #nf-chat-box.open {
      transform: scale(1) translateY(0);
      opacity: 1;
      pointer-events: all;
    }
    /* Orientation flips applied by drag logic so the panel never opens off-screen,
       no matter where the toggle icon has been dragged to. */
    #nf-chat-box.pos-top {
      bottom: auto;
      top: 64px;
      transform-origin: top right;
    }
    #nf-chat-box.pos-left {
      right: auto;
      left: 0;
      transform-origin: bottom left;
    }
    #nf-chat-box.pos-top.pos-left {
      transform-origin: top left;
    }

    .nf-chat-header {
      background: var(--iron, #241D13);
      border-bottom: 1px solid var(--line, rgba(255,210,74,0.18));
      padding: 14px 16px;
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .nf-chat-avatar {
      width: 40px; height: 40px;
      border-radius: 50%;
      background: linear-gradient(135deg, var(--teal, #FFD24A), var(--amber, #FFE27A));
      display: flex; align-items: center; justify-content: center;
      overflow: hidden;
      flex-shrink: 0;
      box-shadow: 0 0 12px rgba(255,210,74,0.35);
    }
    .nf-chat-avatar img {
      width: 100%; height: 100%;
      object-fit: cover;
    }
    .nf-chat-header-info strong {
      display: block;
      color: #FFFFFF;
      font-size: 15px;
      font-weight: 700;
      font-family: 'Anton', sans-serif;
      letter-spacing: 0.4px;
      text-shadow: 0 1px 2px rgba(0,0,0,0.6);
    }
    .nf-chat-header-info span {
      font-size: 12px;
      color: #4ADE80;
      font-weight: 600;
    }
    .nf-chat-header-info span::before { content: '● '; font-size: 8px; }
    .nf-chat-close {
      margin-left: auto;
      background: none; border: none;
      color: var(--paper-dim, #B8AD95);
      font-size: 19px; cursor: pointer;
      padding: 4px; line-height: 1;
      transition: color 0.2s;
    }
    .nf-chat-close:hover { color: var(--teal, #FFD24A); }

    .nf-chat-messages {
      flex: 1;
      overflow-y: auto;
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 12px;
      scrollbar-width: thin;
      scrollbar-color: rgba(255,210,74,0.3) transparent;
    }
    .nf-chat-messages::-webkit-scrollbar { width: 4px; }
    .nf-chat-messages::-webkit-scrollbar-thumb { background: rgba(255,210,74,0.3); border-radius: 4px; }

    .nf-msg {
      max-width: 88%;
      padding: 10px 14px;
      border-radius: 14px;
      font-size: 13px;
      line-height: 1.55;
      animation: nfMsgIn 0.25s ease;
    }
    @keyframes nfMsgIn {
      from { opacity: 0; transform: translateY(8px); }
      to   { opacity: 1; transform: translateY(0); }
    }
    .nf-msg.bot {
      background: rgba(255,210,74,0.07);
      border: 1px solid var(--line, rgba(255,210,74,0.18));
      color: var(--paper, #F5EEDD);
      align-self: flex-start;
      border-bottom-left-radius: 4px;
    }
    .nf-msg.user {
      background: linear-gradient(135deg, var(--teal, #FFD24A), var(--amber, #FFE27A));
      color: #0A0806;
      align-self: flex-end;
      border-bottom-right-radius: 4px;
      font-weight: 600;
    }
    .nf-msg a { color: var(--teal, #FFD24A); text-decoration: underline; }
    .nf-msg.user a { color: #0A0806; }
    .nf-msg ul { margin: 6px 0 0 0; padding-left: 16px; }
    .nf-msg ul li { margin-bottom: 3px; }

    .nf-typing {
      display: flex; gap: 5px; align-items: center;
      padding: 12px 14px;
      background: rgba(255,210,74,0.06);
      border: 1px solid var(--line, rgba(255,210,74,0.18));
      border-radius: 14px;
      border-bottom-left-radius: 4px;
      align-self: flex-start;
      animation: nfMsgIn 0.2s ease;
    }
    .nf-typing span {
      width: 7px; height: 7px;
      background: var(--teal, #FFD24A);
      border-radius: 50%;
      animation: nfDot 1.2s infinite;
      opacity: 0.6;
    }
    .nf-typing span:nth-child(2) { animation-delay: 0.2s; }
    .nf-typing span:nth-child(3) { animation-delay: 0.4s; }
    @keyframes nfDot {
      0%,80%,100% { transform: scale(0.7); opacity: 0.4; }
      40%          { transform: scale(1.1); opacity: 1; }
    }

    .nf-suggestions {
      display: flex; flex-wrap: wrap; gap: 6px;
      padding: 0 16px 10px;
    }
    .nf-suggestion-btn {
      background: rgba(255,210,74,0.08);
      border: 1px solid var(--line, rgba(255,210,74,0.18));
      color: var(--teal, #FFD24A);
      border-radius: 20px;
      padding: 5px 12px;
      font-size: 11.5px;
      cursor: pointer;
      font-family: 'Space Mono', monospace;
      transition: background 0.2s, color 0.2s;
      white-space: nowrap;
    }
    .nf-suggestion-btn:hover {
      background: rgba(255,210,74,0.2);
      color: var(--gold-light, #FFF2B5);
    }

    .nf-chat-input-wrap {
      padding: 12px 14px;
      border-top: 1px solid var(--line, rgba(255,210,74,0.18));
      display: flex; gap: 8px;
      background: var(--ink-black, #0A0806);
    }
    #nf-chat-input {
      flex: 1;
      background: rgba(255,255,255,0.05);
      border: 1px solid var(--line, rgba(255,210,74,0.18));
      border-radius: 24px;
      padding: 9px 16px;
      color: var(--paper, #F5EEDD);
      font-size: 13px;
      font-family: 'Space Mono', monospace;
      outline: none;
      transition: border-color 0.2s;
    }
    #nf-chat-input:focus { border-color: var(--teal, #FFD24A); }
    #nf-chat-input::placeholder { color: var(--paper-dim, #B8AD95); }

    #nf-chat-send {
      width: 40px; height: 40px;
      border-radius: 50%;
      background: linear-gradient(135deg, var(--teal, #FFD24A), var(--amber, #FFE27A));
      border: none; cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      flex-shrink: 0;
      transition: transform 0.15s, box-shadow 0.15s;
      box-shadow: 0 3px 12px rgba(255,210,74,0.3);
    }
    #nf-chat-send:hover { transform: scale(1.08); }
    #nf-chat-send svg { pointer-events: none; }

    @media (max-width: 600px) {
      #nf-chat-widget { right: 14px; bottom: 16px; }
      #nf-chat-box {
        width: calc(100vw - 28px);
        right: -6px;
        bottom: 60px;
        max-height: min(70vh, 560px);
      }
      #nf-chat-box.pos-left { right: auto; left: -6px; }
      #nf-chat-box.pos-top { bottom: auto; top: 60px; }
      #nf-chat-toggle {
        height: 48px;
        padding: 0;
        width: 48px;
        justify-content: center;
        border-radius: 50%;
      }
      #nf-chat-toggle .toggle-label { display: none; }
      #nf-chat-toggle .toggle-icon { width: 40px; height: 40px; }
      .nf-chat-header { padding: 12px 14px; }
      .nf-chat-avatar { width: 36px; height: 36px; }
      .nf-chat-header-info strong { font-size: 13.5px; }
      .nf-chat-header-info span { font-size: 11px; }
      .nf-chat-messages { padding: 12px; gap: 10px; }
      .nf-msg { font-size: 12.5px; max-width: 90%; }
      .nf-suggestions { padding: 0 12px 8px; gap: 5px; }
      .nf-suggestion-btn { font-size: 11px; padding: 4px 10px; }
      .nf-chat-input-wrap { padding: 10px 12px; }
      #nf-chat-input { font-size: 13px; padding: 8px 14px; }
      #nf-chat-send { width: 36px; height: 36px; }
    }
    @media (max-width: 360px) {
      #nf-chat-box { width: calc(100vw - 20px); right: -4px; }
      #nf-chat-box.pos-left { right: auto; left: -4px; }
    }
  `;
  document.head.appendChild(style);

  /* ── BUILD HTML ── */
  const widget = document.createElement('div');
  widget.id = 'nf-chat-widget';
  widget.innerHTML = `
    <div id="nf-chat-box">
      <div class="nf-chat-header">
        <div class="nf-chat-avatar"><img src="assets/chat-bot-icon.webp" alt="Merlin AI"></div>
        <div class="nf-chat-header-info">
          <strong>Merlin — NF Assistant</strong>
          <span>Online now</span>
        </div>
        <button class="nf-chat-close" id="nf-chat-close" aria-label="Close">✕</button>
      </div>
      <div class="nf-chat-messages" id="nf-chat-messages"></div>
      <div class="nf-suggestions" id="nf-suggestions">
        <button class="nf-suggestion-btn">💪 Best whey protein?</button>
        <button class="nf-suggestion-btn">✅ Is stock genuine?</button>
        <button class="nf-suggestion-btn">🚚 Delivery info</button>
        <button class="nf-suggestion-btn">📍 Store location</button>
      </div>
      <div class="nf-chat-input-wrap">
        <input type="text" id="nf-chat-input" placeholder="Ask about products, stock, delivery…" autocomplete="off" />
        <button id="nf-chat-send" aria-label="Send">
          <svg width="18" height="18" fill="none" stroke="#0A0806" stroke-width="2.2" viewBox="0 0 24 24">
            <line x1="22" y1="2" x2="11" y2="13"/>
            <polygon points="22 2 15 22 11 13 2 9 22 2"/>
          </svg>
        </button>
      </div>
    </div>

    <button id="nf-chat-toggle" aria-label="Open AI Chat">
      <img class="toggle-icon" src="assets/chat-bot-icon.webp" alt="AI Assistant">
      <span class="toggle-label">Ask Merlin</span>
      <span class="chat-notif"></span>
    </button>
  `;
  document.body.appendChild(widget);

  /* ── ELEMENTS ── */
  const chatBox       = document.getElementById('nf-chat-box');
  const toggleBtn      = document.getElementById('nf-chat-toggle');
  const closeBtn       = document.getElementById('nf-chat-close');
  const messagesEl     = document.getElementById('nf-chat-messages');
  const inputEl        = document.getElementById('nf-chat-input');
  const sendBtn        = document.getElementById('nf-chat-send');
  const suggestionsEl  = document.getElementById('nf-suggestions');

  /* ── OPEN / CLOSE ── */
  function openChat() {
    chatBox.classList.add('open');
    const dot = toggleBtn.querySelector('.chat-notif');
    if (dot) dot.remove();
    if (chatHistory.length === 0) showWelcome();
    setTimeout(() => inputEl.focus(), 300);
  }
  function closeChat() { chatBox.classList.remove('open'); }

  let suppressNextToggleClick = false;
  toggleBtn.addEventListener('click', (e) => {
    if (suppressNextToggleClick) {
      suppressNextToggleClick = false;
      e.stopImmediatePropagation();
      e.preventDefault();
      return;
    }
    chatBox.classList.contains('open') ? closeChat() : openChat();
  });
  closeBtn.addEventListener('click', closeChat);

  /* ── DRAGGABLE WIDGET ──
     The chat icon can float over content the visitor is trying to read or tap, so
     it can be dragged anywhere on screen. Position is remembered per-visitor
     (localStorage) so it stays where they left it on their next visit. */
  (function initDraggableWidget() {
    const POS_KEY = 'nf_chat_widget_pos';
    const DRAG_THRESHOLD = 6;
    let dragging = false;
    let moved = false;
    let startPointerX = 0, startPointerY = 0, startLeft = 0, startTop = 0;

    function clamp(left, top) {
      const rect = widget.getBoundingClientRect();
      const w = rect.width || 60;
      const h = rect.height || 60;
      const maxLeft = Math.max(6, window.innerWidth - w - 6);
      const maxTop = Math.max(6, window.innerHeight - h - 6);
      return {
        left: Math.min(Math.max(6, left), maxLeft),
        top: Math.min(Math.max(6, top), maxTop)
      };
    }

    function applyPosition(left, top) {
      widget.style.left = left + 'px';
      widget.style.top = top + 'px';
      widget.style.right = 'auto';
      widget.style.bottom = 'auto';
    }

    function updateChatBoxOrientation() {
      const rect = widget.getBoundingClientRect();
      const openDownward = rect.top < window.innerHeight * 0.5;
      const openToRight = rect.left < window.innerWidth * 0.5;
      chatBox.classList.toggle('pos-top', openDownward);
      chatBox.classList.toggle('pos-left', openToRight);
    }

    function savePosition(left, top) {
      try { localStorage.setItem(POS_KEY, JSON.stringify({ left, top })); } catch (e) {}
    }

    function loadSavedPosition() {
      let saved = null;
      try { saved = JSON.parse(localStorage.getItem(POS_KEY)); } catch (e) {}
      if (saved && typeof saved.left === 'number' && typeof saved.top === 'number') {
        const c = clamp(saved.left, saved.top);
        applyPosition(c.left, c.top);
      }
      updateChatBoxOrientation();
    }

    function onPointerDown(e) {
      if (e.button !== undefined && e.button !== 0) return; // primary button / touch only
      dragging = true;
      moved = false;
      const rect = widget.getBoundingClientRect();
      startLeft = rect.left;
      startTop = rect.top;
      startPointerX = e.clientX;
      startPointerY = e.clientY;
      try { toggleBtn.setPointerCapture(e.pointerId); } catch (err) {}
      document.addEventListener('pointermove', onPointerMove);
      document.addEventListener('pointerup', onPointerUp);
    }

    function onPointerMove(e) {
      if (!dragging) return;
      const dx = e.clientX - startPointerX;
      const dy = e.clientY - startPointerY;
      if (!moved && (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD)) {
        moved = true;
        widget.classList.add('nf-dragging');
        closeChat(); // avoid a half-open panel trailing behind while dragging
      }
      if (moved) {
        const c = clamp(startLeft + dx, startTop + dy);
        applyPosition(c.left, c.top);
      }
    }

    function onPointerUp() {
      if (!dragging) return;
      dragging = false;
      document.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('pointerup', onPointerUp);
      widget.classList.remove('nf-dragging');
      if (moved) {
        const rect = widget.getBoundingClientRect();
        savePosition(rect.left, rect.top);
        updateChatBoxOrientation();
        suppressNextToggleClick = true; // this was a drag, not a tap — don't toggle the chat
      }
    }

    toggleBtn.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('resize', () => {
      if (!widget.style.left) return; // still at default CSS position, nothing to clamp
      const rect = widget.getBoundingClientRect();
      const c = clamp(rect.left, rect.top);
      applyPosition(c.left, c.top);
      updateChatBoxOrientation();
    });

    loadSavedPosition();
  })();

  /* ── MESSAGES ── */
  function addMessage(text, role) {
    const div = document.createElement('div');
    div.className = `nf-msg ${role}`;
    const formatted = text
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.*?)\*/g, '<em>$1</em>')
      .replace(/`(.*?)`/g, '<code>$1</code>')
      .replace(/\n- /g, '\n• ')
      .replace(/• (.*?)(?=\n•|\n\n|$)/gs, (m, item) => `<li>${item.trim()}</li>`)
      .replace(/(<li>.*<\/li>)/gs, '<ul>$1</ul>')
      .replace(/\n/g, '<br>');
    div.innerHTML = formatted;
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return div;
  }

  function showTyping() {
    const div = document.createElement('div');
    div.className = 'nf-typing';
    div.id = 'nf-typing';
    div.innerHTML = '<span></span><span></span><span></span>';
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }
  function removeTyping() {
    const t = document.getElementById('nf-typing');
    if (t) t.remove();
  }

  function showWelcome() {
    addMessage(
      `👋 Hi! I'm **Merlin**, your NF Naseem Fitness assistant.\n\nAsk me about products, prices, genuine stock verification, or delivery — what do you need today?`,
      'bot'
    );
  }

  /* ── SUGGESTIONS ── */
  suggestionsEl.querySelectorAll('.nf-suggestion-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const text = btn.textContent.replace(/^[^\w]+/, '').trim();
      sendMessage(text);
      suggestionsEl.style.display = 'none';
    });
  });

  /* ── SEND MESSAGE ── */
  async function sendMessage(text) {
    text = (text || inputEl.value).trim();
    if (!text) return;

    inputEl.value = '';
    suggestionsEl.style.display = 'none';
    addMessage(text, 'user');
    chatHistory.push({ role: 'user', content: text });

    showTyping();
    sendBtn.disabled = true;

    try {
      const groqMessages = [
        { role: 'system', content: getSystemPrompt() },
        ...chatHistory
      ];

      // API key lives only inside the Cloudflare Worker — never exposed in the browser
      const response = await fetch(WORKER_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'openai/gpt-oss-20b',
          max_tokens: 500,
          temperature: 0.7,
          messages: groqMessages
        })
      });

      const data = await response.json();
      removeTyping();

      const reply = data?.choices?.[0]?.message?.content
        || "Sorry, I couldn't get a response. Please WhatsApp us at +91 77382 42258 for help!";
      addMessage(reply, 'bot');
      chatHistory.push({ role: 'assistant', content: reply });

    } catch (err) {
      removeTyping();
      addMessage("⚠️ Connection issue. Please WhatsApp us at **+91 77382 42258** for instant help!", 'bot');
      console.error('NF Naseem Fitness AI error:', err);
    }

    sendBtn.disabled = false;
    inputEl.focus();
  }

  sendBtn.addEventListener('click', () => sendMessage());
  inputEl.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

})();
