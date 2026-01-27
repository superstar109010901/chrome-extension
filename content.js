/**
 * Match.com AI Reply Assistant - Content Script
 * 
 * This script:
 * 1. Detects when user is on messages page
 * 2. Reads conversation messages from DOM
 * 3. Injects floating "Generate AI Reply" button
 * 4. Tracks conversation turn count per conversation
 * 5. Handles AI reply generation and CTA suggestions
 * 6. Supports AUTO MODE for fully automated responses
 */

(function() {
  'use strict';

  // Configuration
  const CONFIG = {
    BACKEND_URL: 'https://chrome-extension-bjw9.onrender.com',
    MIN_TURNS_FOR_CTA: 3,
    MAX_TURNS_FOR_CTA: 4,
    MAX_MESSAGES_TO_SEND: 6,
    POLL_INTERVAL: 2000,
    AUTO_CHECK_INTERVAL: 2000, // Check for new messages every 2 seconds in auto mode
    CONVERSATION_ID_ATTRIBUTE: 'data-conversation-id'
  };

  /**
   * Helper: log a clear reason whenever we decide to skip replying
   */
  function logSkipReason(reason) {
    try {
      console.log(`[AI Assistant] ⏭️ Skipping this chat: ${reason}`);
    } catch (_) {
      // ignore logging errors
    }
  }

  // State
  let currentConversationId = null;
  let messageInput = null;
  let floatingButton = null;
  let observer = null;
  let autoModeInterval = null;
  let breakCheckInterval = null;
  let lastMessageCount = 0;
  let lastMessageHash = '';
  let isProcessingAuto = false;
  let autoModeActive = false;
  let isOnBreak = false;
  let breakEndTime = null;
  let nextBreakTime = null;
  let autoModeStartTime = null;
  let lastReplyTime = 0; // Timestamp of last reply to ANY conversation (global cooldown)
  let lastConversationId = null; // Track which conversation we last replied to
  let allowInitialAutoReply = false; // Allow one reply even if hash unchanged (on enable)
  let lastIncomingMessage = ''; // Used for SPA navigation resets (avoid ReferenceError)
  let lastAutoSwitchTime = 0; // Throttle auto-switch clicking
  let lastAutoSwitchedToConversationId = null;
  let currentChatEnteredAt = 0;
  let lastSeenConversationId = null;
  let nextAutoSwitchAt = 0;
  let autoSessionId = 0; // increments whenever auto mode is (re)configured, cancels in-flight runs
  const lastAttemptedAutoReplyByConversation = {}; // { [conversationId]: { hash: string, ts: number } }
  const AUTO_REPLY_RETRY_BACKOFF_MS = 15000;
  const repliedToInThisCycle = new Set(); // Track chats we've replied to in current cycle
  let lastCycleResetTime = 0;
  let yourTurnChatSequence = []; // Remembered sequence of "Your turn" chat IDs (preserves order before list reordering)
  let currentSequenceIndex = 0; // Current position in the sequence
  const repliedToIncomingMessages = {}; // { [conversationId]: Set of incoming message hashes we've replied to }
  const conversationsWhereTheySharedCTA = new Set(); // Don't reply anymore once they shared their IG/Snap/phone
  const partnerNamesByConversation = {}; // { [conversationId]: "Sam" } - extracted from GraphQL response
  let gqlConversationCache = {}; // { [conversationId]: [{ text, isOutgoing }] } - messages from GraphQL

  // Settings (loaded from storage)
  let settings = {
    autoMode: false,
    autoSend: true,
    replyDelayMin: 3,
    replyDelayMax: 8,
    chatSwitchDelay: 30, // Delay between switching to different chats (seconds)
    // Break mode
    randomBreakMode: false,
    breakDurationMin: 5,
    breakDurationMax: 15,
    breakIntervalMin: 45,
    breakIntervalMax: 75,
    // Social handles
    instagramHandle: '',
    snapchatHandle: '',
    ctaType: 'instagram'
  };

  /**
   * Get random number between min and max
   */
  function randomBetween(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  /**
   * Schedule the next break time
   */
  function scheduleNextBreak() {
    if (!settings.randomBreakMode) {
      nextBreakTime = null;
      return;
    }
    
    const intervalMin = settings.breakIntervalMin * 60 * 1000; // Convert to ms
    const intervalMax = settings.breakIntervalMax * 60 * 1000;
    const nextInterval = randomBetween(intervalMin, intervalMax);
    
    nextBreakTime = Date.now() + nextInterval;
    console.log(`[AI Assistant] Next break scheduled in ${Math.round(nextInterval / 60000)} minutes`);
  }

  /**
   * Start a break
   */
  async function startBreak() {
    const durationMin = settings.breakDurationMin * 60 * 1000;
    const durationMax = settings.breakDurationMax * 60 * 1000;
    const breakDuration = randomBetween(durationMin, durationMax);
    
    isOnBreak = true;
    breakEndTime = Date.now() + breakDuration;
    
    console.log(`[AI Assistant] ☕ Taking a break for ${Math.round(breakDuration / 60000)} minutes`);
    
    // Save break state to storage (so popup can show it)
    await chrome.storage.local.set({
      breakState: {
        isOnBreak: true,
        breakEndTime: breakEndTime,
        startedAt: Date.now()
      }
    });
    
    // Update button
    updateButtonForBreak();
  }

  /**
   * End the break
   */
  async function endBreak() {
    isOnBreak = false;
    breakEndTime = null;
    
    console.log('[AI Assistant] ☕ Break ended, resuming auto mode');
    
    // Clear break state
    await chrome.storage.local.set({
      breakState: {
        isOnBreak: false,
        breakEndTime: null
      }
    });
    
    // Schedule next break
    scheduleNextBreak();
    
    // Update button
    if (floatingButton) {
      floatingButton.textContent = '🤖 Auto Mode ON';
      floatingButton.classList.remove('match-ai-reply-button--break');
      floatingButton.classList.add('match-ai-reply-button--auto');
    }
  }

  /**
   * Update button appearance for break mode
   */
  function updateButtonForBreak() {
    if (floatingButton && isOnBreak) {
      const remainingMin = Math.ceil((breakEndTime - Date.now()) / 60000);
      floatingButton.textContent = `☕ Break (${remainingMin}m)`;
      floatingButton.classList.add('match-ai-reply-button--break');
      floatingButton.classList.remove('match-ai-reply-button--auto');
    }
  }

  /**
   * Check break status and handle break timing
   */
  async function checkBreakStatus() {
    if (!settings.autoMode || !settings.randomBreakMode) {
      return;
    }
    
    const now = Date.now();
    
    // If on break, check if it's time to end
    if (isOnBreak) {
      if (now >= breakEndTime) {
        await endBreak();
      } else {
        updateButtonForBreak();
      }
      return;
    }
    
    // If not on break, check if it's time to take one
    if (nextBreakTime && now >= nextBreakTime) {
      await startBreak();
    }
  }

  /**
   * Load break state from storage
   */
  async function loadBreakState() {
    try {
      const result = await chrome.storage.local.get('breakState');
      if (result.breakState?.isOnBreak) {
        const now = Date.now();
        if (result.breakState.breakEndTime > now) {
          // Resume break
          isOnBreak = true;
          breakEndTime = result.breakState.breakEndTime;
          console.log(`[AI Assistant] Resuming break, ${Math.ceil((breakEndTime - now) / 60000)} minutes remaining`);
          updateButtonForBreak();
        } else {
          // Break has ended while away
          await endBreak();
        }
      }
    } catch (error) {
      console.error('Error loading break state:', error);
    }
  }

  /**
   * Load settings from MongoDB via backend API
   */
  async function loadSettings() {
    try {
      const response = await fetch(`${CONFIG.BACKEND_URL.replace(/\/$/, '')}/settings`, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' }
      });
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      const apiSettings = await response.json();
      console.log('[AI Assistant] Raw settings from DB:', apiSettings);

      // Merge API settings with defaults to ensure all fields exist
      settings = { ...settings, ...apiSettings };
      console.log('[AI Assistant] Effective settings after merge:', settings);

      await loadBreakState();
      updateAutoMode();
      console.log('[AI Assistant] ✅ Settings loaded from MongoDB');
    } catch (error) {
      console.error('[AI Assistant] Error loading settings from API:', error);
      // Use default settings if API fails
      console.log('[AI Assistant] ⚠️ Using default settings (API unavailable)');
      await loadBreakState();
      updateAutoMode();
    }
  }

  /**
   * Listen for settings changes from popup
   * When popup saves settings, it sends a message with the new settings
   */
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'settingsUpdated') {
      // Update settings from the message
      settings = { ...settings, ...request.settings };
      updateAutoMode();
      sendResponse({ success: true });
    }
  });

  // Listen for settings updates from popup (popup sends message after saving to API)
  // Note: We no longer listen to chrome.storage changes for settings (they're in MongoDB now)
  // But we still listen for breakState changes (break state is still in Chrome storage)
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    // Only listen for breakState changes (settings are now in MongoDB)
    if (changes.breakState?.newValue) {
      // Keep button state consistent if break mode changes via popup
      loadBreakState().then(() => restoreButtonState()).catch(() => {});
    }
  });

  function isAutoSessionActive(session) {
    return settings.autoMode && session === autoSessionId;
  }

  /**
   * Generate a unique conversation ID based on URL or conversation elements
   */
  function getConversationId() {
    const path = window.location.pathname || '';
    const urlParams = new URLSearchParams(window.location.search);
    const hash = window.location.hash;

    // Prefer exact /matches/ID, then any path containing /matches/ID (e.g. /matches/ID/ or /matches/ID/chat)
    const exact = path.match(/^\/matches\/([^/]+)$/i);
    if (exact) return exact[1];
    const anyMatch = path.match(/\/matches\/([^/]+)/i);
    if (anyMatch) return anyMatch[1];

    const conversationElement = document.querySelector('[data-conversation-id], [data-thread-id], .conversation-thread');
    if (conversationElement) {
      const id = conversationElement.getAttribute('data-conversation-id') ||
                 conversationElement.getAttribute('data-thread-id') ||
                 conversationElement.id ||
                 urlParams.get('conversation') ||
                 urlParams.get('thread');
      if (id) return String(id);
    }

    return path + (window.location.search || '') + (hash || '');
  }

  /**
   * Get the partner's display name from GraphQL cache first, then fallback to DOM.
   * Used so the AI uses the correct name instead of inventing one.
   */
  function getPartnerDisplayName() {
    // Method 0: Check GraphQL cache first (most reliable)
    const convId = getConversationId();
    if (convId && partnerNamesByConversation[convId]) {
      const name = partnerNamesByConversation[convId];
      console.log(`[AI Assistant] 📛 Using partner name from GraphQL: "${name}"`);
      return name;
    }
    
    try {
      // Method 1: Look for name in main conversation header (most reliable)
      // The name is in an h1 element within main (e.g., <h1 class="css-1gx31cz">Raddoc</h1>)
      // "Matches" is the page/platform name, NOT the partner name
      // The partner name h1 is usually inside a button or div in the conversation header area
      const main = document.querySelector('main, [role="main"]');
      if (main) {
        // Strategy: Find h1 elements, but prioritize those in the conversation header area
        // The partner name h1 is typically inside a button or specific container structure
        // Look for h1 inside button first (conversation header), then other containers
        const h1InButton = main.querySelector('button h1, button[class*="css-"] h1');
        if (h1InButton) {
          const text = (h1InButton.textContent || '').trim();
          if (text && text.length >= 2 && text.length <= 50 &&
              text.toLowerCase() !== 'matches' &&
              !/^(matches?|messages?|chat|conversation|match\.com|active|your\s+turn|home|profile|settings)/i.test(text)) {
            console.log(`[AI Assistant] 📛 Found partner name in button h1: "${text}"`);
            return text;
          }
        }
        
        // Priority 2: Check all h1 elements, but prioritize those in conversation header structure
        // The partner name h1 is in the same DOM position for all chats (inside button with css-* classes)
        const h1Elements = main.querySelectorAll('h1');
        for (const h1 of h1Elements) {
          const text = (h1.textContent || '').trim();
          
          // Skip "Matches" explicitly (it's the page name, not a partner name)
          if (text.toLowerCase() === 'matches') {
            continue;
          }
          
          // Check if this h1 is in a button or has css-* class (indicates conversation header)
          const parent = h1.parentElement;
          const isInButton = parent && (parent.tagName === 'BUTTON' || parent.closest('button'));
          const hasCssClass = h1.className && typeof h1.className === 'string' && h1.className.includes('css-');
          const parentHasCssClass = parent && parent.className && typeof parent.className === 'string' && parent.className.includes('css-');
          
          // Partner name h1 is usually in button or has css-* classes (same position for all chats)
          if (text && text.length >= 2 && text.length <= 50 &&
              !/^(matches?|messages?|chat|conversation|match\.com|active|your\s+turn|home|profile|settings)/i.test(text)) {
            // If it's in a button or has css classes, it's likely the partner name (like "Ethan Reich", "Raddoc", etc.)
            if (isInButton || hasCssClass || parentHasCssClass) {
              console.log(`[AI Assistant] 📛 Found partner name in h1: "${text}" (in button: ${isInButton}, has css: ${hasCssClass || parentHasCssClass})`);
              return text;
            }
          }
        }
        
        // Fallback: Try other name/title elements, but exclude "Matches"
        const nameSelectors = 'h2, [class*="title" i], [class*="name" i], [class*="profile" i], [class*="header" i]';
        const nameEls = main.querySelectorAll(nameSelectors);
        for (const nameEl of nameEls) {
          const t = (nameEl.textContent || '').trim();
          // Extract first word/phrase (name before comma, age, etc.)
          const namePart = t.split(/[\n,]/)[0].trim();
          if (namePart && namePart.length >= 2 && namePart.length <= 50 &&
              namePart.toLowerCase() !== 'matches' &&
              !/^(matches?|messages?|chat|conversation|match\.com|active|your\s+turn|home|profile|settings)/i.test(namePart)) {
            console.log(`[AI Assistant] 📛 Found partner name in header element: "${namePart}"`);
            return namePart;
          }
        }
      }
      
      // Method 2: Extract from conversation list item (sidebar)
      const convId = getConversationId();
      const items = getConversationItemsInOrder();
      const cur = items.find(i => i.id === convId);
      if (cur && cur.el) {
        // Get text, remove "Your turn" badge text, extract first part
        const raw = (cur.el.textContent || '').replace(/\byour\s+turn\b/gi, '').trim();
        const namePart = raw.split(/[\n,]/)[0].trim();
        // Filter out common non-name patterns, especially "Matches" (page name)
        if (namePart && namePart.length >= 2 && namePart.length <= 40 &&
            namePart.toLowerCase() !== 'matches' &&
            !/^(matches?|messages?|chat|conversation|match|active)/i.test(namePart)) {
          console.log(`[AI Assistant] 📛 Found partner name in sidebar: "${namePart}"`);
          return namePart;
        }
      }
      
      // Method 3: Look for name in message bubbles (sender name)
      const messageElements = document.querySelectorAll('[class*="message" i], [class*="bubble" i]');
      for (const msgEl of Array.from(messageElements).slice(-5)) { // Check last 5 messages
        const text = (msgEl.textContent || '').trim();
        // Look for patterns like "Name:" or sender indicators
        const nameMatch = text.match(/^([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)[:,\s]/);
        if (nameMatch && nameMatch[1] && nameMatch[1].length >= 2 && nameMatch[1].length <= 30) {
          console.log(`[AI Assistant] 📛 Found partner name in message: "${nameMatch[1]}"`);
          return nameMatch[1];
        }
      }
    } catch (err) {
      console.warn('[AI Assistant] ⚠️ Error extracting partner name:', err);
    }
    console.log('[AI Assistant] ⚠️ Could not extract partner name from DOM');
    return null;
  }

  /**
   * Detect if the other person shared their CTA (Instagram/Snapchat) in incoming messages.
   * When true, we should not reply anymore to this conversation.
   */
  function incomingMessagesContainTheirCTA(messages) {
    if (!messages || !messages.length) return false;
    const incoming = messages
      .filter(m => !m.isOutgoing)
      .map(m => (m.text || '').toLowerCase());
    const combined = incoming.join(' ');
    // Only treat as their CTA when they clearly share an Instagram/Snapchat handle.
    const patterns = [
      // "my instagram is @handle" / "my ig is @handle"
      /\b(my\s+)?(ig|instagram)\s*(is|:)?\s*[@\w.-]{3,}/i,
      // "my snap is username" / "my snapchat is username"
      /\b(my\s+)?(snap|snapchat)\s*(is|:)?\s*[\w.-]{3,}/i,
      // "add me on snap/ig/instagram"
      /\badd\s+me\s+on\s+(snap|ig|instagram)\b/i,
      // "find me on instagram/snapchat"
      /\bfind\s+me\s+on\s+(instagram|ig|snapchat|snap)\b/i,
      // generic "mine is @handle"
      /\bmine\s+is\s+[@\w.-]{3,}/i
    ];
    return patterns.some(re => re.test(combined));
  }

  /**
   * Query selector in document and inside shadow roots
   */
  function queryOne(selector, root = document) {
    try {
      const el = root.querySelector(selector);
      if (el) return el;
      for (const node of root.querySelectorAll('*')) {
        if (node.shadowRoot) {
          const found = queryOne(selector, node.shadowRoot);
          if (found) return found;
        }
      }
    } catch (_) {}
    return null;
  }

  function queryAll(selector, root = document) {
    const out = [];
    try {
      out.push(...root.querySelectorAll(selector));
      for (const node of root.querySelectorAll('*')) {
        if (node.shadowRoot) {
          out.push(...queryAll(selector, node.shadowRoot));
        }
      }
    } catch (_) {}
    return out;
  }

  /**
   * Safely get an element's className as a lowercase string.
   * Some DOM nodes (notably SVG) expose className as an object, not a string.
   */
  function getClassNameLower(el) {
    if (!el) return '';
    try {
      const cn = el.className;
      if (typeof cn === 'string') return cn.toLowerCase();
      // SVGAnimatedString / similar shapes
      if (cn && typeof cn.baseVal === 'string') return cn.baseVal.toLowerCase();
      if (cn && typeof cn.animVal === 'string') return cn.animVal.toLowerCase();
      const attr = el.getAttribute && el.getAttribute('class');
      if (typeof attr === 'string') return attr.toLowerCase();
      return '';
    } catch (_) {
      return '';
    }
  }

  /** Find SEND button */
  function findSendButtonNearInput(input) {
    let parent = input && input.parentElement;
    for (let i = 0; i < 6 && parent; i++) {
      const candidates = parent.querySelectorAll('button, [role="button"], input[type="submit"]');
      for (const btn of candidates) {
        const t = (btn.textContent || btn.value || '').trim().toUpperCase();
        if (t === 'SEND') return { parent, sendButton: btn };
      }
      parent = parent.parentElement;
    }
    return null;
  }

  function parseConversationIdFromHref(href) {
    if (!href) return null;
    try {
      const url = new URL(href, window.location.origin);
      const m = url.pathname.match(/^\/matches\/([^/]+)$/);
      return m ? m[1] : null;
    } catch (_) {
      // Fallback for relative/non-URL href strings
      const m = String(href).match(/\/matches\/([^/?#]+)/);
      return m ? m[1] : null;
    }
  }

  function getConversationListRoot() {
    // Prefer the left sidebar list that contains "Active Conversations"
    const candidates = Array.from(document.querySelectorAll(
      'aside, nav, [role="navigation"], [class*="sidebar" i], [class*="conversations" i], [class*="matches" i]'
    ));
    for (const el of candidates) {
      const t = (el && el.textContent) ? el.textContent.toLowerCase() : '';
      if (t.includes('active conversations')) return el;
    }
    return null;
  }

  function getConversationItemsInOrder() {
    const root = getConversationListRoot() || document;
    const links = Array.from(root.querySelectorAll('a[href*="/matches/"]'));
    const seen = new Set();
    const items = [];
    for (const a of links) {
      const convId = parseConversationIdFromHref(a.getAttribute('href') || a.href);
      if (!convId || seen.has(convId)) continue;
      seen.add(convId);
      
      // Check if this chat has a "Your turn" badge/label in the DOM
      // Look for the badge in the link itself, parent container, or siblings
      const linkText = (a.textContent || '').toLowerCase();
      const parent = a.parentElement;
      const parentText = parent ? (parent.textContent || '').toLowerCase() : '';
      
      // Look for badge elements more comprehensively
      // Check link, parent, siblings, and common badge containers
      // CRITICAL: Must check VISIBILITY, not just existence (CSS may hide badge)
      let hasYourTurnBadge = false;
      
      // Helper function to check if element is actually visible (not just in DOM)
      const isElementVisible = (el) => {
        if (!el) return false;
        try {
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.display !== 'none' &&
                 style.visibility !== 'hidden' &&
                 style.opacity !== '0' &&
                 rect.width > 0 &&
                 rect.height > 0 &&
                 el.offsetParent !== null; // Element is in layout flow
        } catch (_) {
          return false;
        }
      };
      
      // Method 1: Check for explicit badge elements (buttons, spans, divs with "Your turn")
      const badgeSelectors = 'button, span, div, [class*="badge"], [class*="label"], [class*="turn"], [class*="indicator"]';
      const badgeInLink = a.querySelector(badgeSelectors);
      const badgeInParent = parent?.querySelector(badgeSelectors);
      const badgeInSibling = a.nextElementSibling?.querySelector?.(badgeSelectors) || 
                            a.previousElementSibling?.querySelector?.(badgeSelectors);
      
      // Check each badge element for "Your turn" text AND visibility
      const checkBadgeElement = (el) => {
        if (!el) return false;
        const text = el.textContent?.toLowerCase().trim();
        return (text === 'your turn' || text.includes('your turn')) && isElementVisible(el);
      };
      
      if (checkBadgeElement(badgeInLink)) {
        hasYourTurnBadge = true;
      } else if (checkBadgeElement(badgeInParent)) {
        hasYourTurnBadge = true;
      } else if (checkBadgeElement(badgeInSibling)) {
        hasYourTurnBadge = true;
      }
      
      // Method 2: Check all potential badge elements in parent container (more thorough)
      if (!hasYourTurnBadge && parent) {
        const allBadgeElements = parent.querySelectorAll(badgeSelectors);
        for (const badgeEl of allBadgeElements) {
          if (checkBadgeElement(badgeEl)) {
            hasYourTurnBadge = true;
            break;
          }
        }
      }
      
      items.push({ 
        id: convId, 
        el: a, 
        textLower: linkText,
        hasYourTurn: hasYourTurnBadge
      });
    }
    return items;
  }

  function findNextConversationId(currentConvId, predicate) {
    const items = getConversationItemsInOrder();
    if (items.length === 0) return null;
    const startIdx = Math.max(0, items.findIndex(x => x.id === currentConvId));
    for (let offset = 1; offset <= items.length; offset++) {
      const idx = (startIdx + offset) % items.length;
      const item = items[idx];
      if (!item || (currentConvId && item.id === currentConvId)) continue;
      if (predicate && !predicate(item)) continue;
      return item.id;
    }
    return null;
  }

  function buildYourTurnChatSequence() {
    const items = getConversationItemsInOrder();
    const yourTurnItems = items.filter(item => item.hasYourTurn);
    yourTurnChatSequence = yourTurnItems.map(item => item.id);
    currentSequenceIndex = 0;
    console.log(`[AI Assistant] 📋 Built sequence of ${yourTurnChatSequence.length} "Your turn" chats: ${yourTurnChatSequence.join(', ')}`);
    return yourTurnChatSequence;
  }

  function findNextYourTurnConversationId(currentConvId, excludeReplied = true) {
    // If we have a remembered sequence, use it (preserves order before list reordering)
    if (yourTurnChatSequence.length > 0) {
      const currentIdx = yourTurnChatSequence.indexOf(currentConvId);

      // When current is NOT in the sequence, use DOM order so we don't always jump to first
      if (currentIdx === -1) {
        const items = getConversationItemsInOrder();
        const yourTurnItems = items.filter(i => i.hasYourTurn);
        const domIdx = yourTurnItems.findIndex(i => i.id === currentConvId);
        if (domIdx >= 0) {
          for (let o = 1; o <= yourTurnItems.length; o++) {
            const j = (domIdx + o) % yourTurnItems.length;
            const cand = yourTurnItems[j].id;
            if (excludeReplied && repliedToInThisCycle.has(cand)) continue;
            currentSequenceIndex = yourTurnChatSequence.indexOf(cand);
            if (currentSequenceIndex < 0) currentSequenceIndex = j;
            return cand;
          }
        }
        // Current not in DOM "Your turn" list — return first available from sequence (not always [0] if replied)
        for (let i = 0; i < yourTurnChatSequence.length; i++) {
          const id = yourTurnChatSequence[i];
          if (excludeReplied && repliedToInThisCycle.has(id)) continue;
          const item = items.find(it => it.id === id);
          if (item && item.hasYourTurn) {
            currentSequenceIndex = i;
            return id;
          }
        }
        // All chats in sequence have been replied to - reset cycle
        console.log('[AI Assistant] 🔄 All chats in sequence handled; resetting cycle and rebuilding sequence');
        repliedToInThisCycle.clear();
        return buildYourTurnChatSequence()[0] || null;
      }

      // Current is in sequence: return the next element in the initially remembered array (1st -> 2nd -> 3rd -> …)
      // Never return self (would “switch” to same chat and can bounce back to first). Never return someone we already replied to.
      for (let offset = 1; offset <= yourTurnChatSequence.length; offset++) {
        const idx = (currentIdx + offset) % yourTurnChatSequence.length;
        const nextId = yourTurnChatSequence[idx];
        if (nextId === currentConvId) continue; // don’t “switch” to current chat
        if (excludeReplied && repliedToInThisCycle.has(nextId)) continue;
        currentSequenceIndex = idx;
        return nextId;
      }
      
      // All others replied or only option was self — check if we've completed a full cycle
      // If all chats in sequence have been replied to, reset cycle and start from beginning
      const allReplied = excludeReplied && yourTurnChatSequence.every(id => 
        id === currentConvId || repliedToInThisCycle.has(id)
      );
      
      if (allReplied) {
        // All chats have been handled - reset cycle and start from first
        console.log('[AI Assistant] 🔄 All chats in sequence handled; resetting cycle and starting from first');
        repliedToInThisCycle.clear();
        const rebuilt = buildYourTurnChatSequence();
        return rebuilt[0] || null;
      }
      
      // Not all replied yet, but current position has no available next chat
      const rebuilt = buildYourTurnChatSequence();
      const firstId = rebuilt[0] || null;
      const currentReplied = excludeReplied && repliedToInThisCycle.has(currentConvId);
      if (firstId && excludeReplied && repliedToInThisCycle.has(firstId) && !currentReplied) {
        return null; // we're on 2nd, 1st already replied — don’t jump back to 1st
      }
      console.log('[AI Assistant] 🔄 All chats in sequence handled; rebuilding sequence');
      return firstId;
    }
    
    // Fallback: build sequence from current DOM state
    const items = getConversationItemsInOrder();
    if (items.length === 0) return null;
    
    // Filter to only "Your turn" chats - use DOM badge detection as source of truth
    const yourTurnItems = items.filter(item => {
      // Prefer the hasYourTurn flag if available, fallback to text check
      return item.hasYourTurn || item.textLower.includes('your turn');
    });
    
    if (yourTurnItems.length === 0) {
      console.log('[AI Assistant] ⚠️ No "Your turn" chats found in DOM');
      return null;
    }
    
    console.log(`[AI Assistant] 📋 Found ${yourTurnItems.length} "Your turn" chats: ${yourTurnItems.map(i => i.id).join(', ')}`);
    
    // If excluding replied chats, filter them out
    const availableItems = excludeReplied 
      ? yourTurnItems.filter(item => !repliedToInThisCycle.has(item.id))
      : yourTurnItems;
    
    if (availableItems.length === 0) {
      // All "Your turn" chats have been handled - reset cycle
      console.log('[AI Assistant] 🔄 All "Your turn" chats handled; resetting cycle');
      repliedToInThisCycle.clear();
      return yourTurnItems.length > 0 ? yourTurnItems[0].id : null;
    }
    
    // Find next chat after current one
    const currentIdx = availableItems.findIndex(x => x.id === currentConvId);
    const startIdx = currentIdx >= 0 ? currentIdx : -1;
    
    for (let offset = 1; offset <= availableItems.length; offset++) {
      const idx = (startIdx + offset) % availableItems.length;
      const item = availableItems[idx];
      if (item && item.id !== currentConvId) {
        return item.id;
      }
    }
    
    return null;
  }

  function findNextConversationIdInList(currentConvId) {
    return findNextConversationId(currentConvId);
  }

  function clickConversationById(convId) {
    if (!convId) return false;
    const root = getConversationListRoot() || document;
    const links = Array.from(root.querySelectorAll(`a[href^="/matches/${convId}"]`));
    const a = links[0];
    if (!a) return false;
    a.scrollIntoView({ block: 'center' });
    a.click();
    return true;
  }

  function autoSwitchToNextChat(currentConvId) {
    const now = Date.now();
    // Use "Your turn" sequence so we advance chat-by-chat, not the first/sidebar order
    const nextId = findNextYourTurnConversationId(currentConvId, true);
    if (!nextId) return false;
    const clicked = clickConversationById(nextId);
    if (clicked) {
      lastAutoSwitchTime = now;
      lastAutoSwitchedToConversationId = nextId;
      currentChatEnteredAt = now;
      lastSeenConversationId = nextId;
      nextAutoSwitchAt = now + Math.max(1500, (settings.chatSwitchDelay || 0) * 1000);
      // After switching, allow immediate reply even if hash doesn't "change"
      allowInitialAutoReply = true;
      lastMessageHash = '';
      console.log(`[AI Assistant] 🔁 Switched to next chat: ${nextId}`);
    }
    return clicked;
  }

  /**
   * Find the message input field
   */
  function findMessageInput() {
    const q = (sel) => queryOne(sel);

    const byPlaceholder = q('textarea[placeholder*="message" i], textarea[placeholder*="start" i], ' +
      'input[placeholder*="message" i], input[placeholder*="start" i], ' +
      'textarea[aria-label*="message" i], textarea[role="textbox"], ' +
      '[placeholder*="Start message" i]');
    if (byPlaceholder) return byPlaceholder;

    const contentEditable = q('[contenteditable="true"][role="textbox"], [contenteditable="true"][aria-label*="message" i]');
    if (contentEditable) return contentEditable;

    const sendButtons = queryAll('button, [role="button"], input[type="submit"]');
    for (const btn of sendButtons) {
      const text = (btn.textContent || btn.value || '').trim().toUpperCase();
      if (text !== 'SEND') continue;
      const parent = btn.parentElement;
      if (!parent) continue;
      const input = parent.querySelector('textarea, [contenteditable="true"], input[type="text"]:not([type="submit"])');
      if (input) return input;
      const prev = btn.previousElementSibling;
      if (prev && (prev.matches('textarea, input, [contenteditable="true"]'))) return prev;
    }

    const messageContainer = q('[class*="message" i], [class*="compose" i], [class*="input" i]');
    if (messageContainer) {
      const input = messageContainer.querySelector('textarea, [contenteditable="true"], input[type="text"]');
      if (input) return input;
    }

    return null;
  }

  /**
   * Extract messages from GraphQL cache first, then fallback to DOM scraping
   * More precise extraction to avoid picking up navigation/footer text
   */
  function extractMessages() {
    // Try GraphQL cache first (most reliable)
    const convId = getConversationId();
    
    // Check cache by conversation ID
    if (convId && gqlConversationCache[convId] && gqlConversationCache[convId].length > 0) {
      const gqlMessages = gqlConversationCache[convId];
      console.log(`[AI Assistant] 📋 Using ${gqlMessages.length} messages from GraphQL cache (by convId: ${convId})`);
      return gqlMessages.slice(-CONFIG.MAX_MESSAGES_TO_SEND);
    }
    
    // Also check if we can find messages by any userId key (in case URL-based ID doesn't match)
    const cachedKeys = Object.keys(gqlConversationCache);
    if (cachedKeys.length > 0) {
      // Use the most recent cache entry if current convId not found
      const latestKey = cachedKeys[cachedKeys.length - 1];
      const gqlMessages = gqlConversationCache[latestKey];
      if (gqlMessages && gqlMessages.length > 0) {
        console.log(`[AI Assistant] 📋 Using ${gqlMessages.length} messages from GraphQL cache (by key: ${latestKey})`);
        return gqlMessages.slice(-CONFIG.MAX_MESSAGES_TO_SEND);
      }
    }
    
    // Fallback to DOM extraction
    const messages = [];
    
    // First, try to find the conversation/message container near the input
    const input = findMessageInput();
    let conversationContainer = null;

    const messageSelectors = [
      '[class*="message" i][class*="bubble" i]',
      '[class*="message" i][class*="text" i]',
      '[class*="message" i][class*="content" i]',
      '[data-message-id]',
      '[role="listitem"][class*="message" i]',
      'div[class*="message" i]:not([class*="input" i]):not([class*="compose" i])',
      'article[class*="message" i]',
      'li[class*="message" i]'
    ];

    function looksLikeSidebar(el) {
      const t = (el && el.textContent) ? el.textContent.toLowerCase() : '';
      return t.includes('active conversations');
    }

    function findConversationRootFromInput(inp) {
      if (!inp) return null;
      // Prefer main content areas
      const main = inp.closest('main, [role="main"]');
      if (main && !looksLikeSidebar(main)) return main;

      // Otherwise walk up and pick the smallest ancestor that contains multiple message-like elements
      let p = inp.parentElement;
      for (let depth = 0; depth < 14 && p; depth++) {
        if (!looksLikeSidebar(p)) {
          let count = 0;
          for (const sel of messageSelectors) {
            count += p.querySelectorAll(sel).length;
            if (count >= 2) return p;
          }
        }
        p = p.parentElement;
      }
      return null;
    }
    
    if (input) {
      // Walk up the DOM tree from input to find the conversation container
      let parent = input.parentElement;
      for (let i = 0; i < 10 && parent; i++) {
        const classes = getClassNameLower(parent);
        const id = (parent.id || '').toLowerCase();
        if (classes.includes('conversation') || classes.includes('thread') || 
            classes.includes('messages') || classes.includes('chat') ||
            id.includes('conversation') || id.includes('thread') ||
            id.includes('messages') || id.includes('chat')) {
          conversationContainer = parent;
          break;
        }
        parent = parent.parentElement;
      }
    }
    
    // If no container found, try common selectors
    if (!conversationContainer) {
      const candidates = [
        '[class*="conversation" i]',
        '[class*="thread" i]',
        '[class*="messages" i]',
        '[class*="chat" i]',
        '[id*="conversation" i]',
        '[id*="thread" i]',
        '[id*="messages" i]',
        '[id*="chat" i]'
      ];
      
      for (const selector of candidates) {
        const found = queryOne(selector);
        if (found) {
          conversationContainer = found;
          break;
        }
      }
    }

    // Search scope: strictly constrain to the currently open conversation UI.
    // Falling back to `document` is what caused "off-topic" replies (it can pull messages from other chats / sidebar).
    let searchRoot = conversationContainer || findConversationRootFromInput(input);
    let messageElements = [];
    
    // AGGRESSIVE FALLBACK: If strict root detection fails, use input's visual context
    if (!searchRoot && input) {
      const inputRect = input.getBoundingClientRect();
      const viewportHeight = window.innerHeight;
      
      // Find the main content area (exclude sidebar which is typically on the left)
      const mainContent = document.querySelector('main, [role="main"], [class*="main" i], [class*="content" i]');
      const fallbackRoot = mainContent || document.body;
      
      console.log(`[AI Assistant] 🔍 Visual fallback: searching in ${fallbackRoot.tagName} for messages above input`);
      
      // Search for message-like elements visually positioned above the input
      // Use a broader search to catch all potential message containers
      const allCandidates = fallbackRoot.querySelectorAll('div, li, article, p, span, [role="listitem"]');
      const visualCandidates = Array.from(allCandidates).filter(el => {
        // Exclude sidebar explicitly
        if (looksLikeSidebar(el) || looksLikeSidebar(el.parentElement)) return false;
        if (el.closest('aside, nav, [role="navigation"], [class*="sidebar" i]')) return false;
        
        const rect = el.getBoundingClientRect();
        const text = el.textContent?.trim();
        
        // Must be above the input and within reasonable bounds (more permissive)
        if (rect.bottom > inputRect.top + 50) return false; // Allow some overlap
        if (rect.top < -200 || rect.bottom > viewportHeight + 500) return false; // More permissive viewport check
        
        // Must have message-like text (more permissive)
        if (!text || text.length < 3 || text.length > 2000) return false;
        const words = text.split(/\s+/).filter(w => w.length > 0);
        if (words.length < 1) return false; // Allow single words too
        
        // Exclude navigation/footer text
        const textLower = text.toLowerCase();
        const excludeWords = ['privacy', 'terms', 'cookie', 'success stories', 'help', 
                             'about', 'contact', 'sign in', 'sign up', 'log in', 'log out',
                             'settings', 'profile', 'matches', 'search', 'consumer heal',
                             'active conversations', 'your turn', 'check out our safety'];
        if (excludeWords.some(word => textLower.includes(word))) return false;
        
        // Exclude buttons, inputs, links
        if (el.matches('a, button, input, select, nav, header, footer')) return false;
        if (el.closest('nav, header, footer, [role="navigation"]')) return false;
        
        // Exclude if it's the input field itself or too close to it
        if (el === input || el.contains(input)) return false;
        
        return true;
      });
      
      // Sort by vertical position (top to bottom, closest to input first)
      visualCandidates.sort((a, b) => {
        const rectA = a.getBoundingClientRect();
        const rectB = b.getBoundingClientRect();
        return rectB.bottom - rectA.bottom; // Bottom-most first (closest to input)
      });
      
      if (visualCandidates.length > 0) {
        searchRoot = fallbackRoot;
        messageElements = visualCandidates.slice(0, 30); // Increased limit
        console.log(`[AI Assistant] ✅ Using visual fallback: found ${visualCandidates.length} candidate messages above input`);
      } else {
        console.log(`[AI Assistant] ⚠️ Visual fallback found 0 candidates`);
      }
    }
    
    // ULTIMATE FALLBACK: If we still have no root, use input's parent chain more aggressively
    if (!searchRoot && input) {
      console.log(`[AI Assistant] 🔍 Ultimate fallback: using input's parent chain`);
      let parent = input.parentElement;
      for (let depth = 0; depth < 20 && parent; depth++) {
        if (parent === document.body || parent === document.documentElement) break;
        if (!looksLikeSidebar(parent)) {
          // Check if this parent has message-like children
          const potentialMessages = parent.querySelectorAll('div, li, article, p');
          const messageCount = Array.from(potentialMessages).filter(el => {
            const text = el.textContent?.trim();
            return text && text.length >= 3 && text.length <= 2000 && 
                   !el.matches('a, button, input') &&
                   !el.closest('nav, header, footer');
          }).length;
          
          if (messageCount >= 2) {
            searchRoot = parent;
            console.log(`[AI Assistant] ✅ Found conversation root at depth ${depth} with ${messageCount} potential messages`);
            break;
          }
        }
        parent = parent.parentElement;
      }
    }
    
    if (!searchRoot) {
      console.warn('[AI Assistant] ⚠️ Could not locate conversation root after all fallbacks');
      // Last resort: try to extract from main content area anyway
      const mainContent = document.querySelector('main, [role="main"]');
      if (mainContent && input) {
        const inputRect = input.getBoundingClientRect();
        const candidates = mainContent.querySelectorAll('div, li, article, p');
        const nearInput = Array.from(candidates).filter(el => {
          const rect = el.getBoundingClientRect();
          return rect.bottom < inputRect.top && rect.top > 0 && 
                 el.textContent?.trim().length >= 3 &&
                 !el.closest('aside, nav');
        });
        if (nearInput.length > 0) {
          searchRoot = mainContent;
          messageElements = nearInput.slice(0, 20);
          console.log(`[AI Assistant] ⚠️ Using last-resort extraction: ${nearInput.length} messages`);
        }
      }
      
      if (!searchRoot) {
        console.warn('[AI Assistant] ⚠️ All extraction methods failed - returning empty array');
        return [];
      }
    }

    // Try specific message selectors if we don't have visual fallback results
    if (messageElements.length === 0) {
      for (const selector of messageSelectors) {
        const found = searchRoot.querySelectorAll(selector);
        if (found.length > 0) {
          messageElements = Array.from(found);
          break;
        }
      }
    }

    // Fallback: look for elements with message-like structure
    if (messageElements.length === 0 && conversationContainer) {
      // Find all divs/li/article within conversation container
      const candidates = conversationContainer.querySelectorAll('div, li, article, p');
      messageElements = Array.from(candidates).filter(el => {
        const text = el.textContent?.trim();
        if (!text || text.length < 3 || text.length > 1000) return false;
        
        // Exclude navigation, buttons, inputs, links
        if (el.matches('a, button, input, select, nav, header, footer')) return false;
        if (el.closest('nav, header, footer, [role="navigation"]')) return false;
        
        // Exclude if contains common navigation words
        const excludeWords = ['privacy', 'terms', 'cookie', 'success stories', 'help', 
                             'about', 'contact', 'sign in', 'sign up', 'log in', 'log out',
                             'settings', 'profile', 'matches', 'search', 'consumer heal'];
        const textLower = text.toLowerCase();
        if (excludeWords.some(word => textLower.includes(word))) return false;
        
        // Must have some actual message-like content (not just single words)
        const words = text.split(/\s+/).filter(w => w.length > 0);
        if (words.length < 2) return false;
        
        return true;
      });
    }

    // Process and filter messages
    messageElements.forEach((element, index) => {
      const text = element.textContent?.trim() || '';
      if (!text || text.length < 3) return;
      
      // Additional filtering: exclude if looks like navigation
      const textLower = text.toLowerCase();
      const excludePatterns = ['privacy', 'cookie', 'success stories', 'consumer heal', 
                               'check out our safety', 'reminder:', 'avoid scammers',
                               'terms of use', 'delivered', 'read', 'sent at'];
      if (excludePatterns.some(pattern => textLower.includes(pattern))) {
        return;
      }
      
      // Exclude if it's just a timestamp or status
      if (/^\d{1,2}:\d{2}\s*(AM|PM)$/i.test(text.trim()) || 
          /^(delivered|read|sent)$/i.test(text.trim())) {
        return;
      }

      const classes = getClassNameLower(element);
      const ariaLabel = element.getAttribute('aria-label')?.toLowerCase() || '';
      const parentClasses = getClassNameLower(element.parentElement);
      const parentParentClasses = getClassNameLower(element.parentElement?.parentElement);
      
      // More precise detection of outgoing messages
      const isOutgoing = 
        classes.includes('sent') ||
        classes.includes('outgoing') ||
        classes.includes('me') ||
        classes.includes('self') ||
        classes.includes('own') ||
        classes.includes('right') ||
        classes.includes('from-me') ||
        ariaLabel.includes('sent') ||
        ariaLabel.includes('you') ||
        ariaLabel.includes('from you') ||
        parentClasses.includes('sent') ||
        parentClasses.includes('outgoing') ||
        parentClasses.includes('from-me') ||
        parentParentClasses.includes('sent') ||
        parentParentClasses.includes('outgoing') ||
        (element.offsetLeft > (window.innerWidth / 2) && element.offsetLeft > 0);

      messages.push({
        text: text,
        isOutgoing: isOutgoing,
        timestamp: Date.now() - (messageElements.length - index) * 60000,
        element: element
      });
    });

    // Remove duplicates (same text, keep only one)
    const seen = new Set();
    const uniqueMessages = messages.filter(msg => {
      const key = msg.text.substring(0, 100).toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    console.log(`[AI Assistant] Extracted ${uniqueMessages.length} messages from ${messageElements.length} elements`);
    
    return uniqueMessages.slice(-CONFIG.MAX_MESSAGES_TO_SEND);
  }

  /**
   * Get a hash of current messages to detect changes
   */
  function getMessagesHash() {
    const messages = extractMessages();
    if (messages.length === 0) return '';
    // Use full message text for more accurate change detection
    return messages.map(m => `${m.isOutgoing ? 'OUT' : 'IN'}:${m.text}`).join('||');
  }

  /**
   * Check if the last message is incoming (needs a reply)
   * STRICT CHECK: Must verify it's actually incoming, not misclassified
   */
  function needsReply() {
    const messages = extractMessages();
    if (messages.length === 0) {
      console.log('[AI Assistant] needsReply: No messages found');
      return false;
    }
    
    // Get the last few messages to verify classification
    const lastMessages = messages.slice(-3);
    const lastMessage = lastMessages[lastMessages.length - 1];
    
    // STRICT CHECK: Last message MUST be incoming (not outgoing)
    if (lastMessage.isOutgoing) {
      console.log(`[AI Assistant] needsReply: Last message is OUTGOING ("${lastMessage.text.substring(0, 50)}...") - NOT our turn`);
      return false;
    }
    
    // Additional verification: Check if we have consecutive outgoing messages (we just replied)
    let consecutiveOutgoing = 0;
    for (let i = lastMessages.length - 1; i >= 0; i--) {
      if (lastMessages[i].isOutgoing) {
        consecutiveOutgoing++;
      } else {
        break;
      }
    }
    
    if (consecutiveOutgoing > 0) {
      console.log(`[AI Assistant] needsReply: Found ${consecutiveOutgoing} consecutive outgoing messages - we just replied, NOT our turn`);
      return false;
    }
    
    const result = !lastMessage.isOutgoing;
    
    // Debug logging to help diagnose misclassification
    const lastFew = lastMessages.map(m => `${m.isOutgoing ? 'OUT' : 'IN'}: "${m.text.substring(0, 30)}..."`);
    console.log(`[AI Assistant] needsReply: Last 3 messages: ${lastFew.join(' | ')} → needsReply=${result}`);
    
    return result;
  }

  /**
   * Get conversation turn count from storage
   */
  async function getTurnCount(conversationId) {
    try {
      const result = await chrome.storage.local.get([`turnCount_${conversationId}`, `ctaSent_${conversationId}`]);
      return {
        turnCount: result[`turnCount_${conversationId}`] || 0,
        ctaSent: result[`ctaSent_${conversationId}`] || false
      };
    } catch (error) {
      console.error('Error getting turn count:', error);
      return { turnCount: 0, ctaSent: false };
    }
  }

  /**
   * Increment turn count
   */
  async function incrementTurnCount(conversationId) {
    try {
      const { turnCount } = await getTurnCount(conversationId);
      await chrome.storage.local.set({
        [`turnCount_${conversationId}`]: turnCount + 1
      });
      return turnCount + 1;
    } catch (error) {
      console.error('Error incrementing turn count:', error);
      return 0;
    }
  }

  /**
   * Mark CTA as sent
   */
  async function markCTASent(conversationId) {
    try {
      await chrome.storage.local.set({
        [`ctaSent_${conversationId}`]: true
      });
    } catch (error) {
      console.error('Error marking CTA as sent:', error);
    }
  }

  /**
   * Send messages to backend API and get AI reply
   */
  async function generateAIReply(messages, turnCount, ctaSent) {
    try {
      const shouldRequestCTA = 
        !ctaSent &&
        turnCount >= CONFIG.MIN_TURNS_FOR_CTA &&
        turnCount <= CONFIG.MAX_TURNS_FOR_CTA;

      const partnerName = getPartnerDisplayName();
      const payload = {
        messages: messages.map(m => ({
          text: m.text,
          isOutgoing: m.isOutgoing
        })),
        turnCount: turnCount,
        requestCTA: shouldRequestCTA,
        partnerName: partnerName || undefined,
        // Include social handles for CTA customization
        instagramHandle: settings.instagramHandle,
        snapchatHandle: settings.snapchatHandle,
        ctaType: settings.ctaType
      };

      const data = await new Promise((resolve, reject) => {
        try {
          chrome.runtime.sendMessage(
            { action: 'generateReply', backendUrl: CONFIG.BACKEND_URL, payload },
            (resp) => {
              const err = chrome.runtime.lastError;
              if (err) return reject(new Error(err.message || String(err)));
              if (!resp || !resp.ok) return reject(new Error(resp?.error || 'Unknown background error'));
              resolve(resp.data);
            }
          );
        } catch (e) {
          reject(e);
        }
      });
      
      if (data.isCTA) {
        await markCTASent(currentConversationId);
      }

      return data.reply;
    } catch (error) {
      console.error('Error generating AI reply:', error);
      throw error;
    }
  }

  /**
   * Insert reply text into message input field
   */
  function insertReplyIntoInput(reply) {
    if (!messageInput) {
      console.error('Message input not found');
      return;
    }

    if (messageInput.tagName === 'TEXTAREA' || messageInput.tagName === 'INPUT') {
      messageInput.value = reply;
      messageInput.dispatchEvent(new Event('input', { bubbles: true }));
      messageInput.dispatchEvent(new Event('change', { bubbles: true }));
    } else if (messageInput.contentEditable === 'true') {
      messageInput.textContent = reply;
      messageInput.dispatchEvent(new Event('input', { bubbles: true }));
    }

    messageInput.focus();
  }

  /**
   * Click the SEND button to send the message
   */
  function clickSendButton() {
    const near = findSendButtonNearInput(messageInput);
    if (near && near.sendButton) {
      near.sendButton.click();
      return true;
    }
    return false;
  }

  /**
   * Get random delay within configured range
   */
  function getRandomDelay() {
    const min = settings.replyDelayMin * 1000;
    const max = settings.replyDelayMax * 1000;
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  /**
   * Handle AUTO mode - check for new messages and respond
   */
  async function checkAndAutoReply() {
    const session = autoSessionId;
    // Skip if not in auto mode or already processing
    if (!settings.autoMode || isProcessingAuto) {
      if (!settings.autoMode) {
        logSkipReason('auto mode is OFF');
      } else if (isProcessingAuto) {
        logSkipReason('already processing another auto-reply');
      }
      return;
    }

    // If we're not currently inside an open conversation, try switching to one
    if (!messageInput) {
      const currentConvId = getConversationId();
      // If we're on the list page, keep rotating to open chats
      if (!nextAutoSwitchAt) nextAutoSwitchAt = Date.now();
      if (Date.now() >= nextAutoSwitchAt) autoSwitchToNextChat(currentConvId);
      return;
    }
    
    // Check break status first
    await checkBreakStatus();
    if (!isAutoSessionActive(session)) return;
    
    // Skip if on break
    if (isOnBreak) {
      console.log('[AI Assistant] ☕ On break, skipping auto-reply');
      logSkipReason('currently on break');
      return;
    }

    // Get current conversation ID
    const currentConvId = getConversationId();
    
    // Periodically reset cycle tracking (every 5 minutes) to handle new "Your turn" chats
    if (Date.now() - lastCycleResetTime > 5 * 60 * 1000) {
      console.log('[AI Assistant] 🔄 Resetting cycle tracking (5 min elapsed)');
      repliedToInThisCycle.clear();
      lastCycleResetTime = Date.now();
    }
    
    // Track chat entry time to support continuous rotation
    if (!lastSeenConversationId) {
      lastSeenConversationId = currentConvId;
      currentChatEnteredAt = Date.now();
      nextAutoSwitchAt = Date.now() + Math.max(1500, (settings.chatSwitchDelay || 0) * 1000);
    } else if (currentConvId !== lastSeenConversationId) {
      lastSeenConversationId = currentConvId;
      currentChatEnteredAt = Date.now();
      allowInitialAutoReply = true;
      lastMessageHash = '';
      nextAutoSwitchAt = Date.now() + Math.max(1500, (settings.chatSwitchDelay || 0) * 1000);
    }
    
    // Check if we switched to a different conversation
    const switchedConversation = lastConversationId !== null && lastConversationId !== currentConvId;
    
    if (switchedConversation && lastReplyTime > 0) {
      // Check if enough time has passed since last reply to any conversation
      const timeSinceLastReply = Date.now() - lastReplyTime;
      const requiredDelay = settings.chatSwitchDelay * 1000; // Convert to milliseconds
      
      if (timeSinceLastReply < requiredDelay) {
        const remainingSeconds = Math.ceil((requiredDelay - timeSinceLastReply) / 1000);
        console.log(`[AI Assistant] ⏳ Switched to different chat (${currentConvId}). Waiting ${remainingSeconds}s before replying (chat switch delay: ${settings.chatSwitchDelay}s)`);
        return;
      } else {
        console.log(`[AI Assistant] ✅ Chat switch delay satisfied (${Math.floor(timeSinceLastReply / 1000)}s since last reply)`);
      }
    }
    
    // Check if there's a new message that needs a reply
    const currentHash = getMessagesHash();
    const messagesChanged = currentHash !== lastMessageHash;
    const messages = extractMessages();
    
    // CRITICAL: Check DOM order of "Received:" and "Sent:" indicators
    // If first "Received:" is above first "Sent:" → they sent most recent → we should reply
    // If first "Sent:" is above first "Received:" → we sent most recent → don't reply, skip chat
    function checkLastMessageForSentIndicator() {
      try {
        const main = document.querySelector('main, [role="main"]');
        if (!main) {
          console.log('[AI Assistant] ⚠️ Could not find main conversation area');
          return 'not_found'; // Can't determine, go to next chat
        }
        
        // Find all elements containing "Received:" or "Sent:" text
        const allElements = main.querySelectorAll('*');
        let firstReceivedElement = null;
        let firstSentElement = null;
        let firstReceivedIndex = -1;
        let firstSentIndex = -1;
        
        // Search through all elements to find first "Received:" and first "Sent:"
        for (let i = 0; i < allElements.length; i++) {
          const el = allElements[i];
          const text = (el.textContent || '').trim();
          
          // Check for "Received:" (case-sensitive as shown in DOM)
          if (!firstReceivedElement && (text === 'Received:' || text.startsWith('Received:'))) {
            firstReceivedElement = el;
            firstReceivedIndex = i;
          }
          
          // Check for "Sent:" (case-sensitive as shown in DOM)
          if (!firstSentElement && (text === 'Sent:' || text.startsWith('Sent:'))) {
            firstSentElement = el;
            firstSentIndex = i;
          }
          
          // If we found both, we can stop searching
          if (firstReceivedElement && firstSentElement) {
            break;
          }
        }
        
        // If we found both indicators, compare their DOM order
        if (firstReceivedElement && firstSentElement) {
          if (firstReceivedIndex < firstSentIndex) {
            // "Received:" appears first (above) → they sent most recent → we should reply
            console.log(`[AI Assistant] ✅ First "Received:" (index ${firstReceivedIndex}) is above first "Sent:" (index ${firstSentIndex}) - they sent most recent, we can reply`);
            return 'sent_not_found'; // They sent it, we can proceed
          } else {
            // "Sent:" appears first (above) → we sent most recent → don't reply
            console.log(`[AI Assistant] 🚫 First "Sent:" (index ${firstSentIndex}) is above first "Received:" (index ${firstReceivedIndex}) - we sent most recent, skipping chat`);
            return 'sent_found'; // We sent it, don't reply, skip this chat
          }
        }
        
        // If we only found "Sent:" but not "Received:", we likely sent the most recent
        if (firstSentElement && !firstReceivedElement) {
          console.log('[AI Assistant] 🚫 Found "Sent:" but no "Received:" - we likely sent most recent, skipping chat');
          return 'sent_found'; // We sent it, don't reply
        }
        
        // If we only found "Received:" but not "Sent:", they likely sent the most recent
        if (firstReceivedElement && !firstSentElement) {
          console.log('[AI Assistant] ✅ Found "Received:" but no "Sent:" - they likely sent most recent, we can reply');
          return 'sent_not_found'; // They sent it, we can proceed
        }
        
        // Neither found - can't determine
        console.log('[AI Assistant] ⚠️ Could not find "Received:" or "Sent:" indicators in DOM');
        return 'not_found'; // Can't determine, go to next chat
      } catch (err) {
        console.warn('[AI Assistant] Error checking DOM order of "Received:" and "Sent:" indicators:', err);
        return 'not_found'; // Error, go to next chat
      }
    }
    
    // Check the last message div for "Sent:" indicator
    const sentCheckResult = checkLastMessageForSentIndicator();
    if (sentCheckResult === 'sent_found') {
      // "Sent:" found in last div - we sent it, don't reply
      console.log(`[AI Assistant] 🚫 Last message div has "Sent:" indicator - we sent it. Not replying. Switching to next chat.`);
      const nextChat = findNextYourTurnConversationId(currentConvId, true);
      if (nextChat) {
        autoSwitchToNextChat(currentConvId);
      }
      return;
    } else if (sentCheckResult === 'not_found') {
      // Can't find last div structure - go to next chat
      console.log(`[AI Assistant] ⚠️ Could not determine last message structure - switching to next chat.`);
      const nextChat = findNextYourTurnConversationId(currentConvId, true);
      if (nextChat) {
        autoSwitchToNextChat(currentConvId);
      }
      return;
    }
    // sentCheckResult === 'sent_not_found' - they sent it, we can proceed with reply
    
    // CRITICAL: Also check extracted messages - if the most recent message is one we sent, do NOT reply
    if (messages.length > 0) {
      const lastMsg = messages[messages.length - 1];
      if (lastMsg.isOutgoing) {
        console.log(`[AI Assistant] 🚫 Last message is OUTGOING (we sent it) - not replying. Switching to next chat.`);
        const nextChat = findNextYourTurnConversationId(currentConvId, true);
        if (nextChat) {
          autoSwitchToNextChat(currentConvId);
        }
        return;
      }
    }
    
    // Use DOM badge as primary indicator, but also verify with message extraction
    const shouldReply = needsReply();
    
    if (!shouldReply && messages.length > 0) {
      const lastMsg = messages[messages.length - 1];
      console.log(`[AI Assistant] ⚠️ Chat has "Your turn" badge but last message is ${lastMsg.isOutgoing ? 'OUTGOING' : 'INCOMING'}. Badge may be stale or DOM not updated.`);
    }
    
    // CRITICAL: 1:1 reply ratio - check if we've already replied to this specific incoming message
    let alreadyRepliedToThisMessage = false;
    if (messages.length > 0) {
      
      // Check if we've already replied to the last incoming message
      const lastIncomingMsg = messages.filter(m => !m.isOutgoing).pop();
      if (lastIncomingMsg) {
        // Create a stable hash of the incoming message (text only - message count can change)
        const incomingMsgHash = `IN:${lastIncomingMsg.text.substring(0, 150).toLowerCase().trim()}`;
        
        // Initialize Set for this conversation if needed
        if (!repliedToIncomingMessages[currentConvId]) {
          repliedToIncomingMessages[currentConvId] = new Set();
        }
        
        // Check if we've already replied to this exact incoming message
        alreadyRepliedToThisMessage = repliedToIncomingMessages[currentConvId].has(incomingMsgHash);
        
        if (alreadyRepliedToThisMessage) {
          console.log(`[AI Assistant] 🚫 Already replied to this incoming message ("${lastIncomingMsg.text.substring(0, 50)}...") - 1:1 ratio enforced. Switching to next chat.`);
          const nextChat = findNextYourTurnConversationId(currentConvId, true);
          if (nextChat) {
            autoSwitchToNextChat(currentConvId);
          }
          return;
        }
      }
    }
    
    const attempt = lastAttemptedAutoReplyByConversation[currentConvId];
    const alreadyAttemptedThisState =
      attempt &&
      attempt.hash === currentHash &&
      (Date.now() - attempt.ts) < AUTO_REPLY_RETRY_BACKOFF_MS;

    // Enhanced logging for debugging
    if (messages.length > 0) {
      const lastMsg = messages[messages.length - 1];
      console.log(`[AI Assistant] Auto check: ${messages.length} messages, last: "${lastMsg.text.substring(0, 50)}..." (${lastMsg.isOutgoing ? 'outgoing' : 'incoming'})`);
      console.log(`[AI Assistant] Hash check: changed=${messagesChanged}, needsReply=${shouldReply}`);
    } else {
      console.log('[AI Assistant] ⚠️ No messages found in conversation');
    }

    // CRITICAL: If messages array is empty, check if this is a new conversation
    // If so, send a first greeting message
    if (messages.length === 0) {
      // Check if we've already sent a greeting to this conversation
      const { turnCount } = await getTurnCount(currentConvId);
      
      if (turnCount === 0) {
        // This is a brand new conversation - send first greeting
        console.log('[AI Assistant] 💬 Empty conversation detected - sending first greeting');
        isProcessingAuto = true;
        
        try {
          // Update button to show processing
          if (floatingButton) {
            floatingButton.disabled = true;
            floatingButton.textContent = '🤖 Generating greeting...';
            floatingButton.classList.add('match-ai-reply-button--processing');
          }

          const partnerName = getPartnerDisplayName();
          const greeting = await generateAIReply([], 0, false); // Empty messages, turnCount 0, no CTA
          console.log('[AI Assistant] Got greeting:', greeting);
          if (!isAutoSessionActive(session)) return;
          
          // Wait for human-like delay
          const delay = getRandomDelay();
          console.log(`[AI Assistant] Waiting ${delay}ms before typing greeting...`);
          await new Promise(resolve => setTimeout(resolve, delay));
          if (!isAutoSessionActive(session)) return;
          
          // Re-find message input
          messageInput = findMessageInput();
          if (!messageInput) {
            console.error('[AI Assistant] Message input lost!');
            return;
          }
          if (!isAutoSessionActive(session)) return;
          
          // Insert greeting into input
          insertReplyIntoInput(greeting);
          console.log('[AI Assistant] Greeting inserted into input');
          if (!isAutoSessionActive(session)) return;
          
          // Auto-send if enabled
          if (settings.autoSend) {
            await new Promise(resolve => setTimeout(resolve, 800));
            if (!isAutoSessionActive(session)) return;
            
            const sent = clickSendButton();
            if (sent) {
              console.log('[AI Assistant] ✅ First greeting sent automatically!');
              
              // Update turn count
              await incrementTurnCount(currentConvId);
              lastReplyTime = Date.now();
              lastConversationId = currentConvId;
              
              // Wait for DOM to update
              await new Promise(resolve => setTimeout(resolve, 2500));
              lastMessageHash = getMessagesHash();
              repliedToInThisCycle.add(currentConvId);
              
              // Switch to next chat after greeting
              const nextChatId = findNextYourTurnConversationId(currentConvId, true);
              if (nextChatId) {
                autoSwitchToNextChat(currentConvId);
              }
            }
          }
        } catch (error) {
          console.error('[AI Assistant] Error sending greeting:', error);
        } finally {
          isProcessingAuto = false;
          restoreButtonState();
        }
        return;
      } else {
        // Messages empty but we've already sent something - wait for DOM to load
        console.log('[AI Assistant] ⚠️ No messages extracted yet; waiting before deciding to switch');
        logSkipReason('no messages extracted yet');
        nextAutoSwitchAt = Math.max(nextAutoSwitchAt, Date.now() + 3000);
        return;
      }
    }
    
    // CRITICAL CHECK: If we just replied to this conversation, don't reply again - switch instead
    const justRepliedToThisChat = lastConversationId === currentConvId && 
                                  lastReplyTime > 0 && 
                                  (Date.now() - lastReplyTime) < 5000; // Within last 5 seconds
    
    if (justRepliedToThisChat && messages.length > 0) {
      const lastMsg = messages[messages.length - 1];
      // If last message is outgoing (from us), we just replied - switch away immediately
      if (lastMsg.isOutgoing) {
        console.log('[AI Assistant] 🔄 Just replied to this chat; switching to next "Your turn" chat');
        logSkipReason('just replied to this chat (last message is our own)');
        const nextChatId = findNextYourTurnConversationId(currentConvId, true);
        if (nextChatId) {
          autoSwitchToNextChat(currentConvId);
        } else {
          console.log('[AI Assistant] ⚠️ No other "Your turn" chats found');
          // Still prevent re-reply by pushing timer forward
          nextAutoSwitchAt = Date.now() + (settings.chatSwitchDelay || 30) * 1000;
        }
        return;
      }
    }
    
    // CRITICAL: If we've already replied to this chat in this cycle, skip it
    if (repliedToInThisCycle.has(currentConvId) && messages.length > 0) {
      const lastMsg = messages[messages.length - 1];
      if (lastMsg.isOutgoing) {
        console.log(`[AI Assistant] ⏭️ Already replied to ${currentConvId} in this cycle; switching to next chat`);
        logSkipReason('already replied to this conversation in this cycle');
        const nextChatId = findNextYourTurnConversationId(currentConvId, true);
        if (nextChatId) {
          autoSwitchToNextChat(currentConvId);
        }
        return;
      }
    }
    
    // PRIORITY 1: If it's our turn AND we have "Your turn" badge, ALWAYS try to reply (never switch away)
    // Note: hasYourTurnBadge is already verified above - if false, we would have returned early
    if (shouldReply) {
      // CRITICAL: If they already shared their CTA (IG/Snap/phone), don't reply anymore – switch to next immediately
      if (conversationsWhereTheySharedCTA.has(currentConvId)) {
        console.log(`[AI Assistant] 🚫 They shared their CTA earlier – not replying. Switching to next chat.`);
        logSkipReason('user already shared their own CTA earlier in this chat');
        const nextChatId = findNextYourTurnConversationId(currentConvId, true);
        if (nextChatId) {
          autoSwitchToNextChat(currentConvId);
        }
        return;
      }
      // CRITICAL: Check if they just shared their CTA in current messages - if so, mark and switch immediately
      if (messages.length > 0 && incomingMessagesContainTheirCTA(messages)) {
        conversationsWhereTheySharedCTA.add(currentConvId);
        console.log(`[AI Assistant] 🚫 They shared their CTA (Instagram/Snap/number) – not replying anymore. Switching to next chat.`);
        logSkipReason('this incoming message contains their CTA (Instagram/Snap/number)');
        const nextChatId = findNextYourTurnConversationId(currentConvId, true);
        if (nextChatId) {
          autoSwitchToNextChat(currentConvId);
        }
        return;
      }
      // CRITICAL: Push switch timer far into the future so we never switch while it's our turn
      nextAutoSwitchAt = Date.now() + (settings.chatSwitchDelay || 30) * 1000 * 10; // 10x delay to prevent switching
      
      // Check if we should proceed (or wait for backoff)
      if (alreadyAttemptedThisState && attempt && attempt.hash === currentHash) {
        const elapsed = Date.now() - attempt.ts;
        const remaining = Math.max(0, AUTO_REPLY_RETRY_BACKOFF_MS - elapsed);
        if (remaining > 0) {
          console.log(`[AI Assistant] ⏳ On turn; waiting ${Math.ceil(remaining / 1000)}s before retrying reply (backoff)`);
          return;
        }
        // Backoff expired - allow retry
        console.log('[AI Assistant] ✅ Backoff expired; proceeding with reply');
      } else if (!messagesChanged && !allowInitialAutoReply) {
        // Hash unchanged but we haven't attempted - allow one attempt
        allowInitialAutoReply = true;
        console.log('[AI Assistant] ✅ It\'s our turn; allowing reply attempt (hash unchanged)');
      }
      
      // Proceed to reply (we're guaranteed shouldReply=true here)
    } else {
      // Not our turn - handle switching logic
      const lastMsg = messages[messages.length - 1];
      console.log(`[AI Assistant] Last message is outgoing, skipping. Last: "${lastMsg?.text?.substring(0, 50) || 'N/A'}..." (outgoing: ${lastMsg?.isOutgoing})`);
      logSkipReason('last message is outgoing (it is not our turn)');
      
      // Continuous rotation: only switch when it's NOT our turn AND we have messages to confirm it
      // Double-check: if we just switched to this chat, give it a moment before switching away
      const timeSinceEntry = currentChatEnteredAt > 0 ? (Date.now() - currentChatEnteredAt) : Infinity;
      if (timeSinceEntry < 2000) {
        console.log(`[AI Assistant] ⏳ Just entered this chat ${Math.floor(timeSinceEntry / 1000)}s ago; waiting before switching`);
        return;
      }
      
      if (Date.now() >= nextAutoSwitchAt) {
        console.log('[AI Assistant] 🔄 Not our turn; switching to next chat');
        autoSwitchToNextChat(currentConvId);
      }
      return;
    }
    
    // If we reach here, shouldReply=true and we're proceeding to reply

    // Update hash to prevent duplicate processing
    lastMessageHash = currentHash;
    allowInitialAutoReply = false;
    lastAttemptedAutoReplyByConversation[currentConvId] = { hash: currentHash, ts: Date.now() };

    console.log('[AI Assistant] 🚀 New incoming message detected! Starting auto-reply...');
    isProcessingAuto = true;

    try {
      // Update button to show processing
      if (floatingButton) {
        floatingButton.disabled = true;
        floatingButton.textContent = '🤖 Generating...';
        floatingButton.classList.add('match-ai-reply-button--processing');
      }

      // Get conversation context
      currentConversationId = getConversationId();
      const messages = extractMessages();
      
      // CRITICAL CHECK: Before generating, verify there's an incoming message to reply to
      if (messages.length > 0) {
        const lastMessage = messages[messages.length - 1];
        if (lastMessage.isOutgoing) {
          console.log(`[AI Assistant] 🚫 Last message is OUTGOING ("${lastMessage.text.substring(0, 50)}...") - no new incoming message. Aborting.`);
          isProcessingAuto = false;
          restoreButtonState();
          // Switch to next chat in sequence
          const nextChat = findNextYourTurnConversationId(currentConversationId, true);
          if (nextChat) {
            autoSwitchToNextChat(currentConversationId);
          }
          return;
        }
        
        // CRITICAL: Double-check we haven't already replied to this incoming message (prevent duplicates)
        const lastIncomingMsg = messages.filter(m => !m.isOutgoing).pop();
        if (lastIncomingMsg) {
          const incomingMsgHash = `IN:${lastIncomingMsg.text.substring(0, 150).toLowerCase().trim()}`;
          if (repliedToIncomingMessages[currentConversationId]?.has(incomingMsgHash)) {
            console.log(`[AI Assistant] 🚫 Already replied to this incoming message ("${lastIncomingMsg.text.substring(0, 50)}...") - preventing duplicate. Switching to next.`);
            isProcessingAuto = false;
            restoreButtonState();
            const nextChat = findNextYourTurnConversationId(currentConversationId, true);
            if (nextChat) {
              autoSwitchToNextChat(currentConversationId);
            }
            return;
          }
        }
        
        console.log(`[AI Assistant] ✅ Last message is INCOMING ("${lastMessage.text.substring(0, 50)}...") - proceeding with reply`);
      }
      
      const { turnCount, ctaSent } = await getTurnCount(currentConversationId);
      if (!isAutoSessionActive(session)) return;
      
      console.log('[AI Assistant] Generating reply for', messages.length, 'messages, turn:', turnCount);
      
      // Generate AI reply
      const reply = await generateAIReply(messages, turnCount, ctaSent);
      console.log('[AI Assistant] Got reply:', reply);
      if (!isAutoSessionActive(session)) return;
      
      // Wait for human-like delay
      const delay = getRandomDelay();
      console.log(`[AI Assistant] Waiting ${delay}ms before typing...`);
      await new Promise(resolve => setTimeout(resolve, delay));
      if (!isAutoSessionActive(session)) return;
      
      // Re-find message input (might have changed)
      messageInput = findMessageInput();
      if (!messageInput) {
        console.error('[AI Assistant] Message input lost!');
        return;
      }
      if (!isAutoSessionActive(session)) return;
      
      // Insert reply into input
      insertReplyIntoInput(reply);
      console.log('[AI Assistant] Reply inserted into input');
      if (!isAutoSessionActive(session)) return;
      
      // Auto-send if enabled
      if (settings.autoSend) {
        await new Promise(resolve => setTimeout(resolve, 800));
        if (!isAutoSessionActive(session)) return;
        
        // FINAL CHECK: Re-verify last message is still incoming before sending
        const finalMessages = extractMessages();
        if (finalMessages.length > 0) {
          const finalLastMessage = finalMessages[finalMessages.length - 1];
          if (finalLastMessage.isOutgoing) {
            console.log(`[AI Assistant] 🚫 FINAL CHECK: Last message became OUTGOING before send - aborting send`);
            isProcessingAuto = false;
            restoreButtonState();
            return;
          }
        }
        
        const sent = clickSendButton();
        if (sent) {
          console.log('[AI Assistant] ✅ Message sent automatically!');
          
          // CRITICAL: Mark the incoming message we just replied to (1:1 ratio tracking)
          // Only mark AFTER successful send - if send fails, we can retry
          if (messages.length > 0) {
            const lastIncomingMsg = messages.filter(m => !m.isOutgoing).pop();
            if (lastIncomingMsg) {
              const incomingMsgHash = `IN:${lastIncomingMsg.text.substring(0, 150).toLowerCase().trim()}`;
              if (!repliedToIncomingMessages[currentConversationId]) {
                repliedToIncomingMessages[currentConversationId] = new Set();
              }
              repliedToIncomingMessages[currentConversationId].add(incomingMsgHash);
              console.log(`[AI Assistant] 📝 Marked incoming message as replied to: "${lastIncomingMsg.text.substring(0, 50)}..."`);
            }
          }
          
          // Update global cooldown: record when we last replied
          lastReplyTime = Date.now();
          lastConversationId = currentConversationId;
          
          // CRITICAL: After replying, mark this conversation as "just replied" to prevent immediate re-reply
          await incrementTurnCount(currentConversationId);
          
          // Wait longer for DOM to fully update with our sent message (chat list reorders)
          await new Promise(resolve => setTimeout(resolve, 2500));
          
          // Re-extract messages to verify our message is now the last one
          const updatedMessages = extractMessages();
          if (updatedMessages.length > 0) {
            const lastMsg = updatedMessages[updatedMessages.length - 1];
            if (!lastMsg.isOutgoing) {
              console.warn('[AI Assistant] ⚠️ DOM may not have updated yet; last message still incoming');
            }
          }
          
          // Update hash to reflect the new state (our message is now the last one)
          lastMessageHash = getMessagesHash();
          
          // CRITICAL: Mark this chat as replied to in this cycle
          repliedToInThisCycle.add(currentConversationId);
          
          // CRITICAL: Immediately switch to next "Your turn" chat after replying once (1:1 ratio)
          console.log('[AI Assistant] 🔄 Reply sent (1:1 ratio); switching to next "Your turn" chat');
          const nextChatId = findNextYourTurnConversationId(currentConversationId, true);
          if (nextChatId) {
            console.log(`[AI Assistant] 📋 Found next chat: ${nextChatId} (${repliedToInThisCycle.size} chats handled this cycle)`);
            autoSwitchToNextChat(currentConversationId);
          } else {
            console.log('[AI Assistant] ⚠️ No other "Your turn" chats found; staying in current chat');
            // Still reset timers to prevent immediate re-reply
            currentChatEnteredAt = Date.now();
            nextAutoSwitchAt = Date.now() + Math.max(1500, (settings.chatSwitchDelay || 0) * 1000);
          }
        } else {
          console.log('[AI Assistant] ⚠️ Could not find send button, message ready to send manually');
          await incrementTurnCount(currentConversationId);
          lastReplyTime = Date.now();
          lastConversationId = currentConversationId;
        }
      } else {
        console.log('[AI Assistant] ✅ Reply generated (auto-send disabled, send manually)');
        // Even if not auto-sent, update cooldown when reply is generated (user will send manually)
        lastReplyTime = Date.now();
        lastConversationId = currentConversationId;
        await incrementTurnCount(currentConversationId);
        // Reset hash and timers to prevent immediate re-reply
        await new Promise(resolve => setTimeout(resolve, 500));
        lastMessageHash = getMessagesHash();
        currentChatEnteredAt = Date.now();
        nextAutoSwitchAt = Date.now() + Math.max(1500, (settings.chatSwitchDelay || 0) * 1000);
      }
      
    } catch (error) {
      console.error('[AI Assistant] Auto-reply error:', error);
      // Allow retry after backoff instead of ping-pong switching
      lastAttemptedAutoReplyByConversation[currentConvId] = { hash: currentHash, ts: Date.now() };
    } finally {
      isProcessingAuto = false;
      restoreButtonState();
    }
  }

  /**
   * Start or stop auto mode based on settings
   */
  function updateAutoMode() {
    // Bump session to cancel any in-flight auto work
    autoSessionId++;
    // Clear existing intervals
    if (autoModeInterval) {
      clearInterval(autoModeInterval);
      autoModeInterval = null;
    }
    if (breakCheckInterval) {
      clearInterval(breakCheckInterval);
      breakCheckInterval = null;
    }

    // Update button text and style
    if (floatingButton) {
      if (isOnBreak) {
        updateButtonForBreak();
      } else if (settings.autoMode) {
        floatingButton.textContent = settings.randomBreakMode ? '🤖 Auto + Break' : '🤖 Auto Mode ON';
        floatingButton.classList.add('match-ai-reply-button--auto');
        floatingButton.classList.remove('match-ai-reply-button--break');
      } else {
        floatingButton.textContent = '✨ Generate AI Reply';
        floatingButton.classList.remove('match-ai-reply-button--auto');
        floatingButton.classList.remove('match-ai-reply-button--break');
      }
    }

    // Start auto mode if enabled
    if (settings.autoMode && isMessagesPage()) {
      const wasAutoActive = autoModeActive; // Only "navigate to first" when turning ON, not when re-applying
      // Initialize message hash to current state (don't reply to existing messages)
      lastMessageHash = getMessagesHash();
      // But allow ONE reply immediately if user is currently "on turn"
      allowInitialAutoReply = true;
      // Initialize rotation timer
      lastSeenConversationId = getConversationId();
      currentChatEnteredAt = Date.now();
      nextAutoSwitchAt = Date.now() + Math.max(1500, (settings.chatSwitchDelay || 0) * 1000);
      autoModeActive = true;
      autoModeStartTime = Date.now();
      // Reset cycle tracking only when freshly starting auto mode (not when already on and settings changed)
      if (!wasAutoActive) {
        repliedToInThisCycle.clear();
        lastCycleResetTime = Date.now();
        conversationsWhereTheySharedCTA.clear();
        Object.keys(repliedToIncomingMessages).forEach(key => {
          repliedToIncomingMessages[key].clear();
        });
      }
      // CRITICAL: Build and remember sequence of "Your turn" chats at start
      buildYourTurnChatSequence();
      
      // Navigate to first ONLY when freshly turning auto mode ON (never when already active — that would pull us back from 2nd to 1st)
      if (yourTurnChatSequence.length > 0 && !wasAutoActive) {
        const currentConvId = getConversationId();
        const firstChatId = yourTurnChatSequence[0];
        if (currentConvId !== firstChatId) {
          console.log(`[AI Assistant] 🎯 Navigating to first chat in sequence: ${firstChatId}`);
          setTimeout(() => {
            clickConversationById(firstChatId);
          }, 500); // Small delay to ensure DOM is ready
        }
      }
      
      // Start checking for new messages
      autoModeInterval = setInterval(checkAndAutoReply, CONFIG.AUTO_CHECK_INTERVAL);
      
      // If break mode is enabled, schedule breaks
      if (settings.randomBreakMode && !isOnBreak) {
        scheduleNextBreak();
        // Also run break check periodically
        breakCheckInterval = setInterval(checkBreakStatus, 30000); // Check every 30 seconds
      }
      
      console.log('[AI Assistant] 🤖 Auto mode ACTIVATED');
      if (settings.randomBreakMode) {
        console.log('[AI Assistant] ☕ Break mode enabled');
      }
    } else {
      autoModeActive = false;
      nextBreakTime = null;
      allowInitialAutoReply = false;
      nextAutoSwitchAt = 0;
      isProcessingAuto = false;
      console.log('[AI Assistant] Auto mode deactivated');
    }
  }

  /**
   * Handle click on floating button (manual mode)
   */
  async function handleGenerateReply() {
    if (!messageInput) {
      alert('Message input not found. Please navigate to a conversation.');
      return;
    }

    if (floatingButton) {
      floatingButton.disabled = true;
      floatingButton.textContent = '⏳ Generating...';
    }

    try {
      currentConversationId = getConversationId();
      const messages = extractMessages();
      
      if (messages.length === 0) {
        alert('No messages found in this conversation.');
        restoreButtonState();
        return;
      }

      const { turnCount, ctaSent } = await getTurnCount(currentConversationId);
      const reply = await generateAIReply(messages, turnCount, ctaSent);
      
      insertReplyIntoInput(reply);
      await incrementTurnCount(currentConversationId);
      
      // Update global cooldown (even for manual mode, so auto mode respects it)
      lastReplyTime = Date.now();
      lastConversationId = currentConversationId;
      
    } catch (error) {
      console.error('Error in handleGenerateReply:', error);
      alert('Failed to generate reply. Please try again.');
    } finally {
      restoreButtonState();
    }
  }

  /**
   * Restore button to correct state based on settings
   */
  function restoreButtonState() {
    if (!floatingButton) return;
    
    floatingButton.disabled = false;
    floatingButton.classList.remove('match-ai-reply-button--processing');
    
    if (isOnBreak) {
      updateButtonForBreak();
    } else if (settings.autoMode) {
      floatingButton.textContent = settings.randomBreakMode ? '🤖 Auto + Break' : '🤖 Auto Mode ON';
      floatingButton.classList.add('match-ai-reply-button--auto');
      floatingButton.classList.remove('match-ai-reply-button--break');
    } else {
      floatingButton.textContent = '✨ Generate AI Reply';
      floatingButton.classList.remove('match-ai-reply-button--auto');
      floatingButton.classList.remove('match-ai-reply-button--break');
    }
  }

  /**
   * Create and inject floating button
   */
  function createFloatingButton() {
    if (floatingButton) {
      floatingButton.remove();
      floatingButton = null;
    }

    floatingButton = document.createElement('button');
    floatingButton.id = 'match-ai-reply-button';
    floatingButton.type = 'button';
    floatingButton.addEventListener('click', handleGenerateReply);
    
    // Set initial button state
    if (isOnBreak) {
      updateButtonForBreak();
    } else if (settings.autoMode) {
      floatingButton.textContent = settings.randomBreakMode ? '🤖 Auto + Break' : '🤖 Auto Mode ON';
      floatingButton.classList.add('match-ai-reply-button--auto');
    } else {
      floatingButton.textContent = '✨ Generate AI Reply';
    }

    const near = findSendButtonNearInput(messageInput);
    if (near && near.sendButton) {
      const insertParent = near.sendButton.parentElement;
      if (insertParent) {
        try {
          insertParent.insertBefore(floatingButton, near.sendButton);
          floatingButton.classList.add('match-ai-reply-button--inline');
        } catch (_) {
          document.body.appendChild(floatingButton);
        }
      } else {
        document.body.appendChild(floatingButton);
      }
    } else {
      document.body.appendChild(floatingButton);
    }
  }

  /**
   * Check if we're on a messages page
   */
  function isMessagesPage() {
    const url = window.location.href.toLowerCase();
    const path = window.location.pathname.toLowerCase();

    const isMatchesPage = /^\/matches\/[^/]+/.test(path);
    const isMessagesURL =
      isMatchesPage ||
      url.includes('/messages') ||
      url.includes('/conversation') ||
      url.includes('/chat') ||
      url.includes('/inbox');

    const hasMessageInput = findMessageInput() !== null;

    return isMessagesURL || hasMessageInput;
  }

  /**
   * Initialize the extension
   */
  async function init() {
    if (!isMessagesPage()) {
      return;
    }

    // Load settings first
    await loadSettings();

    messageInput = findMessageInput();
    
    if (!messageInput) {
      setTimeout(init, CONFIG.POLL_INTERVAL);
      return;
    }

    createFloatingButton();
    updateAutoMode();

    if (observer) {
      observer.disconnect();
    }

    observer = new MutationObserver(() => {
      // Re-find message input if lost
      if (!messageInput || !document.body.contains(messageInput)) {
        messageInput = findMessageInput();
        if (messageInput && settings.autoMode) {
          console.log('[AI Assistant] Message input re-found');
        }
      }
      
      // Check for conversation change
      const newConversationId = getConversationId();
      if (newConversationId !== currentConversationId) {
        console.log('[AI Assistant] Conversation changed:', newConversationId);
        currentConversationId = newConversationId;
        lastMessageHash = ''; // Reset hash for new conversation
        isProcessingAuto = false; // Reset processing state
        
        // Note: We keep lastConversationId to detect conversation switches
        // It will be updated when we actually reply to this new conversation
        
        // Re-initialize auto mode for new conversation
        if (settings.autoMode) {
          setTimeout(() => {
            lastMessageHash = getMessagesHash();
            console.log('[AI Assistant] New conversation hash:', lastMessageHash.substring(0, 50));
          }, 500);
        }
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true
    });
  }

  /**
   * Hook into fetch to intercept GraphQL responses and extract conversation data
   */
  (function hookGraphQLFetch() {
    if (typeof window === 'undefined' || !window.fetch) return;
    
    const originalFetch = window.fetch;
    window.fetch = async function(input, init) {
      const response = await originalFetch.apply(this, arguments);
      
      try {
        const url = typeof input === 'string' ? input : (input?.url || '');
        if (!url || !url.includes('/graphql')) {
          return response;
        }
        
        // Clone response so we can read it without consuming it
        const clonedResponse = response.clone();
        
        // Check if this is MutualInboxConversationHistory request
        let requestBody = null;
        if (init && init.body) {
          requestBody = typeof init.body === 'string' ? init.body : JSON.stringify(init.body);
        }
        
        if (requestBody && requestBody.includes('MutualInboxConversationHistory')) {
          const json = await clonedResponse.json().catch(() => null);
          
          if (json?.data?.mutualInboxConversationHistory?.matchesHistory) {
            const history = json.data.mutualInboxConversationHistory.matchesHistory;
            
            // Try to get conversation ID from current URL first
            let convId = getConversationId();
            
            // Also try to extract userId from request body to match conversations
            let requestUserId = null;
            try {
              if (requestBody) {
                const reqJson = JSON.parse(requestBody);
                requestUserId = reqJson?.variables?.userId;
              }
            } catch (_) {}
            
            // Use userId as fallback conversation identifier if URL-based ID not available
            if (!convId && requestUserId) {
              convId = requestUserId;
            }
            
            // Extract partner name (handle) - store by both convId and userId for lookup
            if (history.handle) {
              if (convId) {
                partnerNamesByConversation[convId] = history.handle;
                console.log(`[AI Assistant] 📛 Extracted partner name from GraphQL: "${history.handle}" for conversation ${convId}`);
              }
              if (requestUserId && requestUserId !== convId) {
                partnerNamesByConversation[requestUserId] = history.handle;
              }
            }
            
            // Extract messages from GraphQL response
            if (history.items && Array.isArray(history.items)) {
              const messages = history.items
                .filter(item => item.type === 'Message' && item.message && item.message.trim())
                .map(item => ({
                  text: item.message,
                  isOutgoing: item.direction === 'Sent',
                  timestamp: new Date(item.sentDate).getTime()
                }));
              
              if (messages.length > 0) {
                // Store by conversation ID (URL-based) if available, otherwise by userId
                const cacheKey = convId || requestUserId;
                if (cacheKey) {
                  gqlConversationCache[cacheKey] = messages;
                  console.log(`[AI Assistant] 📋 Cached ${messages.length} messages from GraphQL for conversation ${cacheKey}`);
                }
              }
            }
          }
        }
      } catch (err) {
        // Silently ignore errors - don't break the page
        console.warn('[AI Assistant] Error intercepting GraphQL response:', err);
      }
      
      return response;
    };
  })();

  // Initialize when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Re-initialize on navigation (for SPAs)
  let lastURL = window.location.href;
  setInterval(() => {
    if (window.location.href !== lastURL) {
      lastURL = window.location.href;
      lastIncomingMessage = '';
      init();
    }
  }, 1000);

})();
