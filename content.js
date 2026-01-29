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
  const conversationsWhereTheySharedCTA = new Set(); // Don't reply anymore once IG/Snap CTA exists in history
  const partnerNamesByConversation = {}; // { [conversationId]: "Sam" } - extracted from GraphQL response
  let gqlConversationCache = {}; // { [conversationId]: [{ text, isOutgoing }] } - messages from GraphQL
  const yourTurnMatchesFromGraphQL = new Set(); // userIds from MutualInboxMatches where isYourTurn === true

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
    ctaType: 'instagram',
    // CTA timing: request CTA after you have sent this many messages in that chat
    // 0 means "allow anytime"
    ctaAfterMessages: 3,
    // CTA enable/disable
    ctaEnabled: true,
    // Custom invisible characters for CTA obfuscation (blank = default)
    ctaInvisibleChars: '',
    // Unmatch mode: auto-unmatch chats where IG/Snap was shared
    unmatchCtaEnabled: false,
    // Swipe settings
    swipeEnabled: false,
    swipeLikePercent: 50,
    swipeIntervalSecondsMin: 4,
    swipeIntervalSecondsMax: 8
  };

  /**
   * Normalize settings coming from DB/popup (types + bounds).
   * This prevents NaN/strings from breaking delay logic (setTimeout with NaN becomes ~0ms).
   */
  function normalizeSettings(input) {
    const out = { ...input };
    // Numbers
    out.replyDelayMin = Number(out.replyDelayMin);
    out.replyDelayMax = Number(out.replyDelayMax);
    out.chatSwitchDelay = Number(out.chatSwitchDelay);

    if (!Number.isFinite(out.replyDelayMin)) out.replyDelayMin = 3;
    if (!Number.isFinite(out.replyDelayMax)) out.replyDelayMax = 8;
    if (!Number.isFinite(out.chatSwitchDelay)) out.chatSwitchDelay = 30;

    // Bounds (seconds)
    out.replyDelayMin = Math.max(1, Math.min(30, out.replyDelayMin));
    out.replyDelayMax = Math.max(2, Math.min(60, out.replyDelayMax));
    if (out.replyDelayMax < out.replyDelayMin) out.replyDelayMax = Math.min(60, out.replyDelayMin + 3);

    out.chatSwitchDelay = Math.max(5, Math.min(300, out.chatSwitchDelay));

    // Booleans
    out.autoMode = !!out.autoMode;
    out.autoSend = out.autoSend !== false;
    out.randomBreakMode = !!out.randomBreakMode;

    // CTA
    out.ctaEnabled = out.ctaEnabled !== false;
    out.ctaInvisibleChars = typeof out.ctaInvisibleChars === 'string' ? out.ctaInvisibleChars : '';
    out.unmatchCtaEnabled = !!out.unmatchCtaEnabled;

    // Swipe numeric bounds are normalized in updateSwipeMode, but keep types sane
    out.swipeEnabled = !!out.swipeEnabled;
    out.swipeLikePercent = Number(out.swipeLikePercent);
    if (!Number.isFinite(out.swipeLikePercent)) out.swipeLikePercent = 50;
    out.swipeLikePercent = Math.max(0, Math.min(100, out.swipeLikePercent));
    out.swipeIntervalSecondsMin = Number(out.swipeIntervalSecondsMin);
    out.swipeIntervalSecondsMax = Number(out.swipeIntervalSecondsMax);
    if (!Number.isFinite(out.swipeIntervalSecondsMin)) out.swipeIntervalSecondsMin = 4;
    if (!Number.isFinite(out.swipeIntervalSecondsMax)) out.swipeIntervalSecondsMax = 8;

    return out;
  }

  // Swipe state
  let swipeIntervalId = null; // legacy name (now used as timeout id)
  let swipeSessionId = 0;
  let isSwiping = false;

  // High-level mode rotation (between Discover swipe and Matches chat)
  let modeRotationIntervalId = null;
  let currentWorkMode = null; // 'chat' | 'swipe' | null
  let nextModeSwitchAtMs = 0;

  /**
   * Get random number between min and max
   */
  function randomBetween(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  /**
   * Schedule the next break time
   */
  function scheduleNextBreak(force = false) {
    if (!settings.randomBreakMode) {
      nextBreakTime = null;
      return;
    }

    // IMPORTANT: Don't refresh/re-roll the break timer if one is already scheduled in the future.
    // This prevents "break mode resets" when the page navigates to another chat in the SPA.
    if (!force && nextBreakTime && Number.isFinite(nextBreakTime) && nextBreakTime > Date.now()) {
      return;
    }
    
    const intervalMin = settings.breakIntervalMin * 60 * 1000; // Convert to ms
    const intervalMax = settings.breakIntervalMax * 60 * 1000;
    const nextInterval = randomBetween(intervalMin, intervalMax);
    
    nextBreakTime = Date.now() + nextInterval;
    const minutesUntilBreak = Math.round(nextInterval / 60000);
    const secondsUntilBreak = Math.round((nextInterval % 60000) / 1000);
    console.log(`[AI Assistant] ☕ Next break scheduled in ${minutesUntilBreak}m ${secondsUntilBreak}s (at ${new Date(nextBreakTime).toLocaleTimeString()})`);

    // Persist nextBreakTime so it survives SPA navigation/reloads
    try {
      chrome.storage.local.get('breakState', (res) => {
        const prev = res.breakState && typeof res.breakState === 'object' ? res.breakState : {};
        chrome.storage.local.set({
          breakState: {
            ...prev,
            isOnBreak: !!isOnBreak,
            breakEndTime: breakEndTime || null,
            nextBreakTime
          }
        });
      });
    } catch (_) {}
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
    
    const startedAt = Date.now();
    // Save break state to storage (so popup can show it)
    await chrome.storage.local.set({
      breakState: {
        isOnBreak: true,
        breakEndTime: breakEndTime,
        startedAt
      }
    });
    
    // Notify background so it can close this Match tab and reopen after break
    try {
      chrome.runtime.sendMessage(
        {
          action: 'startBreakAndCloseTab',
          breakEndTime,
          startedAt,
          resumeUrl: window.location.href
        },
        () => {
          // Ignore response errors; background might not handle this on older versions
          const err = chrome.runtime.lastError;
          if (err) {
            console.warn('[AI Assistant] Background break-close notification error:', err.message || String(err));
          } else {
            console.log('[AI Assistant] Informed background about break; tab may be closed during break.');
          }
        }
      );
    } catch (err) {
      console.warn('[AI Assistant] Failed to notify background about break:', err);
    }
    
    // Update button (until tab is closed or navigated away)
    updateButtonForBreak();

    // Local fallback: if background fails to close the tab, navigate away from Match
    // after a short delay so the page stops sending Match.com network traffic.
    try {
      setTimeout(() => {
        try {
          // Attempt to close the window (only works for windows opened by script)
          window.close();
        } catch (_) {}
        // Ensure we leave Match.com page even if window.close is ignored
        if (window.location && window.location.href && window.location.href.includes('match.com')) {
          window.location.href = 'about:blank';
        }
      }, 1500);
    } catch (_) {}
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
    
    // Schedule next break (force a new schedule after a break completes)
    scheduleNextBreak(true);
    
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
    if (!nextBreakTime) {
      // If nextBreakTime is null/undefined, schedule it now (but don't refresh if already set)
      scheduleNextBreak(false);
      return;
    }
    
    if (now >= nextBreakTime) {
      console.log(`[AI Assistant] ☕ Break time reached! (scheduled: ${new Date(nextBreakTime).toLocaleTimeString()}, now: ${new Date(now).toLocaleTimeString()})`);
      await startBreak();
    } else {
      // Log occasionally (every ~30 seconds) to show we're checking
      const timeUntilBreak = nextBreakTime - now;
      if (timeUntilBreak % 30000 < 5000) { // Log roughly every 30 seconds
        const minutesLeft = Math.floor(timeUntilBreak / 60000);
        const secondsLeft = Math.floor((timeUntilBreak % 60000) / 1000);
        console.log(`[AI Assistant] ☕ Break check: ${minutesLeft}m ${secondsLeft}s until break`);
      }
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
      } else {
        // Restore next scheduled break time (prevents reset on SPA navigation)
        const t = result.breakState?.nextBreakTime;
        if (t && Number.isFinite(t)) {
          nextBreakTime = t;
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
      settings = normalizeSettings({ ...settings, ...apiSettings });

      // Instagram/Snapchat/CTA type + swipe: stored in local storage only; overlay from chrome.storage.local
      const local = await new Promise((resolve) => {
        chrome.storage.local.get(['instagramHandle', 'snapchatHandle', 'ctaType', 'swipeEnabled', 'swipeLikePercent', 'swipeIntervalSecondsMin', 'swipeIntervalSecondsMax'], resolve);
      });
      if (local.instagramHandle != null) settings.instagramHandle = String(local.instagramHandle);
      if (local.snapchatHandle != null) settings.snapchatHandle = String(local.snapchatHandle);
      if (local.ctaType != null) settings.ctaType = String(local.ctaType);
      if (local.swipeEnabled != null) settings.swipeEnabled = !!local.swipeEnabled;
      if (local.swipeLikePercent != null) settings.swipeLikePercent = Number(local.swipeLikePercent);
      if (local.swipeIntervalSecondsMin != null) settings.swipeIntervalSecondsMin = Number(local.swipeIntervalSecondsMin);
      if (local.swipeIntervalSecondsMax != null) settings.swipeIntervalSecondsMax = Number(local.swipeIntervalSecondsMax);
      console.log('[AI Assistant] Effective settings after merge (social + swipe from local storage):', settings);

      await loadBreakState();
      updateAutoMode();
      console.log('[AI Assistant] ✅ Settings loaded (DB + local storage)');
    } catch (error) {
      console.error('[AI Assistant] Error loading settings from API:', error);
      // Use default settings if API fails
      console.log('[AI Assistant] ⚠️ Using default settings (API unavailable)');
      const local = await new Promise((resolve) => {
        chrome.storage.local.get(['instagramHandle', 'snapchatHandle', 'ctaType', 'swipeEnabled', 'swipeLikePercent', 'swipeIntervalSecondsMin', 'swipeIntervalSecondsMax'], resolve);
      });
      if (local.instagramHandle != null) settings.instagramHandle = String(local.instagramHandle);
      if (local.snapchatHandle != null) settings.snapchatHandle = String(local.snapchatHandle);
      if (local.ctaType != null) settings.ctaType = String(local.ctaType);
      if (local.swipeEnabled != null) settings.swipeEnabled = !!local.swipeEnabled;
      if (local.swipeLikePercent != null) settings.swipeLikePercent = Number(local.swipeLikePercent);
      if (local.swipeIntervalSecondsMin != null) settings.swipeIntervalSecondsMin = Number(local.swipeIntervalSecondsMin);
      if (local.swipeIntervalSecondsMax != null) settings.swipeIntervalSecondsMax = Number(local.swipeIntervalSecondsMax);
      await loadBreakState();
      updateAutoMode();
    }
  }

  /**
   * Listen for settings changes from popup
   * When popup saves settings, it sends a message with the new settings
   */
  // Listen for settings changes from popup
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'settingsUpdated') {
      console.log('[AI Assistant] 📥 Received settings update from popup:', request.settings);
      // Update settings from the message
      settings = normalizeSettings({ ...settings, ...request.settings });
      updateAutoMode();
      updateSwipeMode();
      sendResponse({ success: true });
      return true; // Keep channel open for async response
    }
    
    // Listen for GraphQL responses from debugger API (background script)
    if (request.action === 'graphqlResponse') {
      try {
        const op = request.operation;
        const requestJson = request.requestJson || null;
        if (op === 'MutualInboxConversationHistory') {
          console.log('[AI Assistant] 📥 Received MutualInboxConversationHistory response from debugger API');
          processMutualInboxResponse(request.data, requestJson);
        } else if (op === 'MutualInboxMatches') {
          console.log('[AI Assistant] 📥 Received MutualInboxMatches response from debugger API');
          processMutualInboxMatchesResponse(request.data);
        }
      } catch (err) {
        console.error('[AI Assistant] Error processing debugger GraphQL response:', err);
      }
      sendResponse({ success: true });
      return true;
    }
    
    return false;
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
   * Get the partner's display name from GraphQL cache only (MutualInboxConversationHistory.handle).
   * No DOM extraction.
   */
  function getPartnerDisplayName() {
    const convId = getConversationId();
    if (convId && partnerNamesByConversation[convId]) {
      const name = partnerNamesByConversation[convId];
      console.log(`[AI Assistant] 📛 Using partner name from GraphQL: "${name}"`);
      return name;
    }
    const keys = Object.keys(partnerNamesByConversation);
    if (keys.length > 0) {
      const latestKey = keys[keys.length - 1];
      const name = partnerNamesByConversation[latestKey];
      if (name) {
        console.log(`[AI Assistant] 📛 Using partner name from GraphQL (by key ${latestKey}): "${name}"`);
        return name;
      }
    }
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
   * Detect if ANY CTA info exists anywhere in the full chat history (either side).
   * If true, we should not reply anymore to this conversation.
   *
   * IMPORTANT: CTA info ONLY includes Instagram/IG or Snapchat/Snap.
   * Phone numbers and other keywords are NOT considered CTA.
   */
  function chatHistoryContainsAnyCTA(messages) {
    if (!messages || !messages.length) return false;
    const allText = messages.map(m => (m.text || '')).join(' ').trim();
    if (!allText) return false;

    // Basic signals (Instagram/Snapchat only)
    const hasInstagram = /\b(instagram|ig)\b/i.test(allText);
    const hasSnapchat = /\b(snapchat|snap)\b/i.test(allText);

    // Strong patterns that indicate sharing CTA info (either side)
    const strongPatterns = [
      /\b(my\s+)?(ig|instagram)\s*(is|:)?\s*[@\w.-]{3,}/i,
      /\b(my\s+)?(snap|snapchat)\s*(is|:)?\s*[\w.-]{3,}/i,
      /\badd\s+me\s+on\s+(snap|snapchat|ig|instagram)\b/i,
      /\bfind\s+me\s+on\s+(snap|snapchat|ig|instagram)\b/i,
      /\bmine\s+is\s+[@\w.-]{3,}/i
    ];

    if (strongPatterns.some(re => re.test(allText))) return true;
    if (hasInstagram || hasSnapchat) return true;

    return false;
  }

  /**
   * Try to unmatch the current conversation when CTA has been shared.
   * This is best-effort and relies on finding an \"Unmatch\" button in the UI.
   */
  function clickFirstUnmatchButton() {
    try {
      const candidates = queryAll('button, [role=\"button\"], a, div');
      for (const el of candidates) {
        const text = (el.textContent || el.value || '').trim().toLowerCase();
        if (!text) continue;
        if (text.includes('unmatch')) {
          el.click();
          console.log('[AI Assistant] ⚠️ Clicked \"Unmatch\" for current conversation.');
          return true;
        }
      }
    } catch (err) {
      console.error('[AI Assistant] Error while searching for Unmatch button:', err);
    }
    console.log('[AI Assistant] ⚠️ Could not find an \"Unmatch\" button for current conversation.');
    return false;
  }

  async function unmatchCurrentConversationIfEnabled(convId) {
    if (!settings.unmatchCtaEnabled) return false;
    if (!isMatchesPage()) return false;
    const id = convId || getConversationId();
    if (!id) return false;
    console.log(`[AI Assistant] 🔥 Unmatch mode ON – attempting to unmatch conversation ${id} due to CTA.`);
    const clicked = clickFirstUnmatchButton();
    if (clicked) {
      conversationsWhereTheySharedCTA.add(id);
      // Give the UI a moment to complete the unmatch action
      try {
        await new Promise(r => setTimeout(r, 1500));
      } catch (_) {}
      return true;
    }
    return false;
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
   * Detect if we are on the Discover swipe page (/home)
   */
  function isDiscoverPage() {
    try {
      const path = (window.location.pathname || '').toLowerCase();
      return path === '/home' || path.startsWith('/home/');
    } catch (_) {
      return false;
    }
  }

  /**
   * Try to detect if we're on a Matches/chat page.
   * (We already have isMessagesPage(), but this helper is used for rotation.)
   */
  function isMatchesPage() {
    return isMessagesPage();
  }

  /**
   * Try to navigate to the Discover page by clicking the site's own navigation.
   * Fallback: set window.location to /home.
   */
  function goToDiscoverPage() {
    try {
      // Prefer a link or button with visible text "Discover"
      const candidates = queryAll('a, button, [role="button"]');
      for (const el of candidates) {
        const text = ((el.textContent || '') + '').trim().toLowerCase();
        if (text === 'discover') {
          el.click();
          console.log('[AI Assistant] [Rotate] Navigating to Discover via nav button.');
          return;
        }
      }

      // Fallback: any link pointing to /home
      for (const el of candidates) {
        try {
          const href = el.getAttribute && el.getAttribute('href');
          if (href && href.toLowerCase().includes('/home')) {
            el.click();
            console.log('[AI Assistant] [Rotate] Navigating to Discover via /home link.');
            return;
          }
        } catch (_) {}
      }
    } catch (err) {
      console.warn('[AI Assistant] [Rotate] Error clicking Discover nav, falling back to direct URL:', err);
    }

    try {
      window.location.href = 'https://www.match.com/home';
      console.log('[AI Assistant] [Rotate] Navigating to Discover via direct URL.');
    } catch (_) {}
  }

  /**
   * Try to navigate to the Matches page (where conversations live).
   */
  function goToMatchesPage() {
    try {
      const candidates = queryAll('a, button, [role="button"]');
      for (const el of candidates) {
        const text = ((el.textContent || '') + '').trim().toLowerCase();
        if (text === 'matches' || text.includes('messages')) {
          el.click();
          console.log('[AI Assistant] [Rotate] Navigating to Matches via nav button.');
          return;
        }
      }

      for (const el of candidates) {
        try {
          const href = el.getAttribute && el.getAttribute('href');
          if (href && href.toLowerCase().includes('/matches')) {
            el.click();
            console.log('[AI Assistant] [Rotate] Navigating to Matches via /matches link.');
            return;
          }
        } catch (_) {}
      }
    } catch (err) {
      console.warn('[AI Assistant] [Rotate] Error clicking Matches nav, falling back to direct URL:', err);
    }

    try {
      window.location.href = 'https://www.match.com/matches';
      console.log('[AI Assistant] [Rotate] Navigating to Matches via direct URL.');
    } catch (_) {}
  }

  /**
   * Start/stop high-level rotation between Discover swipe and Matches chat.
   * This only runs when BOTH auto chat and swipe are enabled.
   */
  function updateModeRotation() {
    // Clear existing interval if any
    if (modeRotationIntervalId) {
      clearInterval(modeRotationIntervalId);
      modeRotationIntervalId = null;
    }

    // Only rotate when both features are enabled
    if (!settings.autoMode || !settings.swipeEnabled) {
      currentWorkMode = null;
      nextModeSwitchAtMs = 0;
      console.log('[AI Assistant] [Rotate] Mode rotation disabled (requires auto chat + swipe both ON).');
      return;
    }

    // Helper to schedule next switch within 2–5 minutes
    const scheduleNextSwitch = () => {
      const minMs = 2 * 60 * 1000;
      const maxMs = 5 * 60 * 1000;
      const delta = randomBetween(minMs, maxMs);
      nextModeSwitchAtMs = Date.now() + delta;
      console.log(
        `[AI Assistant] [Rotate] Next mode switch (${currentWorkMode}) scheduled in ~${Math.round(
          delta / 60000
        )} minute(s).`
      );
    };

    // Initialize currentWorkMode from current page
    if (isDiscoverPage()) {
      currentWorkMode = 'swipe';
    } else if (isMatchesPage()) {
      currentWorkMode = 'chat';
    } else {
      currentWorkMode = null;
    }

    scheduleNextSwitch();

    modeRotationIntervalId = setInterval(() => {
      try {
        if (!settings.autoMode || !settings.swipeEnabled) {
          // Safety: turn off rotation if either was disabled while running
          clearInterval(modeRotationIntervalId);
          modeRotationIntervalId = null;
          currentWorkMode = null;
          nextModeSwitchAtMs = 0;
          console.log('[AI Assistant] [Rotate] Stopping mode rotation (settings changed).');
          return;
        }

        const now = Date.now();
        // Re-detect current page to keep state honest
        if (isDiscoverPage()) {
          currentWorkMode = 'swipe';
        } else if (isMatchesPage()) {
          currentWorkMode = 'chat';
        }

        if (!nextModeSwitchAtMs || now < nextModeSwitchAtMs) {
          return;
        }

        // Time to switch modes
        if (currentWorkMode === 'swipe') {
          console.log('[AI Assistant] [Rotate] Time to switch: Discover → Matches (chat).');
          goToMatchesPage();
          currentWorkMode = 'chat';
        } else {
          console.log('[AI Assistant] [Rotate] Time to switch: Matches → Discover (swipe).');
          goToDiscoverPage();
          currentWorkMode = 'swipe';
        }

        scheduleNextSwitch();
      } catch (err) {
        console.error('[AI Assistant] [Rotate] Error during rotation tick:', err);
      }
    }, 15000); // check every 15 seconds
  }

  /**
   * Utility to choose a visible button by text (case-insensitive)
   */
  function findButtonByText(text, options = {}) {
    const label = text.toLowerCase();
    const candidates = queryAll('button, [role="button"], input[type="button"], input[type="submit"]');
    for (const el of candidates) {
      try {
        const raw = ((el.textContent || el.value || '') + '').trim();
        const t = raw.toLowerCase();
        if (!t) continue;
        if (options.exact) {
          if (t === label) return el;
        } else {
          if (t.includes(label)) return el;
        }
      } catch (_) {
        continue;
      }
    }
    return null;
  }

  /**
   * Helper: determine whether a button label represents the normal "Like"
   * action on Discover (and NOT "Super Like").
   */
  function isNormalLikeText(textLower) {
    if (!textLower) return false;
    const t = textLower.trim();
    if (!t.includes('like')) return false;
    if (t.includes('super like')) return false;
    return true;
  }

  /**
   * Specifically find the normal "Like" button on Discover, NOT "Super Like".
   * We prefer text that is exactly "like", and explicitly ignore any button
   * whose text includes "super like".
   */
  function findPrimaryLikeButton() {
    const candidates = queryAll('button, [role="button"], input[type="button"], input[type="submit"]');
    let best = null;
    for (const el of candidates) {
      try {
        const textLower = ((el.textContent || el.value || '') + '').toLowerCase();
        if (!isNormalLikeText(textLower)) continue;
        const text = textLower.trim();
        // Ideal case: text is exactly "like"
        if (text === 'like') {
          best = el;
          break;
        }
        // Fallback: any other label that still clearly contains "like"
        if (!best) {
          best = el;
        }
      } catch (_) {
        continue;
      }
    }
    return best;
  }

  /**
   * Try to locate the main swipe action row (Skip / Super Like / Like)
   * and return the specific Skip and Like buttons from that row.
   * This avoids accidentally picking some other "Skip" on the page.
   */
  function getSwipeRowButtons() {
    const allButtons = queryAll('button, [role="button"], input[type="button"], input[type="submit"]');

    // Pass 1: Start from the visible "Like" button, walk up to find a sibling "Skip".
    try {
      for (const btn of allButtons) {
        const textLower = ((btn.textContent || btn.value || '') + '').toLowerCase();
        if (!isNormalLikeText(textLower)) continue;

        // Walk up a few levels to find a container that also has a Skip button.
        let container = btn.parentElement;
        for (let depth = 0; depth < 4 && container; depth++) {
          const rowButtons = Array.from(
            container.querySelectorAll('button, [role="button"], input[type="button"], input[type="submit"]')
          );
          let likeBtn = null;
          let skipBtn = null;
          for (const rb of rowButtons) {
            const rbTextLower = ((rb.textContent || rb.value || '') + '').toLowerCase();
            if (!isNormalLikeText(rbTextLower)) {
              const trimmed = rbTextLower.trim();
              if (trimmed === 'skip') {
                skipBtn = rb;
              }
              continue;
            }
            const trimmed = rbTextLower.trim();
            if (trimmed === 'like') {
              likeBtn = rb;
            } else if (!likeBtn) {
              // any other valid like-labeled button
              likeBtn = rb;
            }
          }
          if (likeBtn && skipBtn) {
            return { likeButton: likeBtn, skipButton: skipBtn };
          }
          container = container.parentElement;
        }
      }
    } catch (_) {
      // ignore and try fallback strategy
    }

    // Pass 2: Fallback to starting from a Skip button, as before.
    for (const btn of allButtons) {
      try {
        const textLower = ((btn.textContent || btn.value || '') + '').toLowerCase();
        if (!textLower.trim().includes('skip')) continue;
        const parent = btn.parentElement;
        if (!parent) continue;
        const rowButtons = Array.from(
          parent.querySelectorAll('button, [role="button"], input[type="button"], input[type="submit"]')
        );
        let likeBtn = null;
        let skipBtn = null;
        for (const rb of rowButtons) {
          const rbTextLower = ((rb.textContent || rb.value || '') + '').toLowerCase();
          const trimmed = rbTextLower.trim();
          if (trimmed === 'skip') {
            skipBtn = rb;
            continue;
          }
          if (!isNormalLikeText(rbTextLower)) continue;
          if (!likeBtn || trimmed === 'like') {
            likeBtn = rb;
          }
        }
        if (likeBtn && skipBtn) {
          return { likeButton: likeBtn, skipButton: skipBtn };
        }
      } catch (_) {
        continue;
      }
    }

    // Final fallback to generic finders (still avoiding Super Like).
    return {
      likeButton: findPrimaryLikeButton(),
      skipButton: findButtonByText('skip', { exact: true })
    };
  }

  /**
   * Perform a single swipe decision on Discover page:
   * - With probability swipeLikePercent%, click "Like"
   * - Otherwise click "Skip"
   * After Liking, click "Next profile" or "Skip" if such buttons appear.
   */
  async function performSwipeTick(sessionIdForCall) {
    if (!settings.swipeEnabled) return;
    if (!isDiscoverPage()) return;
    if (sessionIdForCall !== swipeSessionId) return;
    if (isSwiping) return;

    isSwiping = true;
    try {
      // Always aim to click LIKE first; never click initial Skip / Super Like.
      // If Like button is not yet present, just wait for the next tick.

      // IMPORTANT: only use the normal Like button from the main swipe row, never Super Like
      const { likeButton } = getSwipeRowButtons();

      if (!likeButton) {
        console.log('[AI Assistant] [Swipe] Like button not found yet – waiting for it to appear.');
        return;
      }

      likeButton.click();
      console.log('[AI Assistant] [Swipe] Clicked Like on current profile.');

      // Wait briefly for any post-like UI (e.g. "Next profile", "Skip") to appear,
      // then use those ONLY to move to the next profile.
      await new Promise((r) => setTimeout(r, 1500));

      const nextProfileButton = findButtonByText('next profile', { exact: false });
      const postLikeSkip = findButtonByText('skip', { exact: false });

      if (nextProfileButton) {
        nextProfileButton.click();
        console.log('[AI Assistant] [Swipe] Clicked Next profile after Like.');
      } else if (postLikeSkip) {
        postLikeSkip.click();
        console.log('[AI Assistant] [Swipe] Clicked Skip after Like (no Next profile button).');
      }
    } catch (err) {
      console.error('[AI Assistant] [Swipe] Error during swipe tick:', err);
    } finally {
      isSwiping = false;
    }
  }

  /**
   * Start/stop swipe automation based on settings and current page.
   */
  function updateSwipeMode() {
    swipeSessionId++;

    if (swipeIntervalId) {
      clearTimeout(swipeIntervalId);
      swipeIntervalId = null;
    }

    if (!settings.swipeEnabled) {
      console.log('[AI Assistant] [Swipe] Swipe mode disabled in settings.');
      return;
    }

    if (!isDiscoverPage()) {
      console.log('[AI Assistant] [Swipe] Not on Discover page (/home) – swipe mode idle.');
      return;
    }

    const minSec = Number(settings.swipeIntervalSecondsMin) || 4;
    const maxSec = Number(settings.swipeIntervalSecondsMax) || minSec + 2;
    const safeMinSec = Math.max(2, Math.min(60, minSec));
    const safeMaxSec = Math.max(safeMinSec, Math.min(60, maxSec));
    const sessionAtStart = swipeSessionId;

    const pickDelayMs = () => {
      const sec = randomBetween(
      Math.round(safeMinSec),
      Math.round(safeMaxSec)
      );
      return sec * 1000;
    };

    console.log(
      `[AI Assistant] [Swipe] Activating auto-swipe on Discover – random delay ${safeMinSec}-${safeMaxSec}s between swipes, like ~${settings.swipeLikePercent}% of profiles.`
    );

    const scheduleNext = () => {
      if (sessionAtStart !== swipeSessionId) return;
      if (!settings.swipeEnabled) return;
      if (!isDiscoverPage()) return;

      const delayMs = pickDelayMs();
      console.log(`[AI Assistant] [Swipe] Next swipe in ${Math.round(delayMs / 1000)}s`);
      swipeIntervalId = setTimeout(async () => {
        try {
          await performSwipeTick(sessionAtStart);
        } catch (err) {
          console.error('[AI Assistant] [Swipe] Error in swipe loop:', err);
        } finally {
          scheduleNext();
        }
      }, delayMs);
    };

    // Start the randomized loop
    scheduleNext();

    // Refresh rotation whenever swipe mode changes
    updateModeRotation();
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

    let yourTurnItems;
    // Prefer GraphQL "isYourTurn" information when available
    if (yourTurnMatchesFromGraphQL.size > 0) {
      yourTurnItems = items.filter(item => yourTurnMatchesFromGraphQL.has(item.id));
      if (yourTurnItems.length === 0) {
        console.log('[AI Assistant] ⚠️ GraphQL reported your-turn matches, but none are visible in sidebar; falling back to DOM badges.');
      } else {
        console.log(
          `[AI Assistant] 📋 Building sequence from MutualInboxMatches isYourTurn flags for ${yourTurnItems.length} chats.`
        );
      }
    }

    // Fallback: use DOM "Your turn" badge detection
    if (!yourTurnItems || yourTurnItems.length === 0) {
      yourTurnItems = items.filter(item => item.hasYourTurn);
    }

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
        let yourTurnItems;
        if (yourTurnMatchesFromGraphQL.size > 0) {
          yourTurnItems = items.filter(i => yourTurnMatchesFromGraphQL.has(i.id));
        }
        if (!yourTurnItems || yourTurnItems.length === 0) {
          yourTurnItems = items.filter(i => i.hasYourTurn);
        }
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
    
    // Fallback: build sequence from current DOM state and/or GraphQL flags
    const items = getConversationItemsInOrder();
    if (items.length === 0) return null;
    
    // Filter to only "Your turn" chats.
    let yourTurnItems;
    if (yourTurnMatchesFromGraphQL.size > 0) {
      yourTurnItems = items.filter(item => yourTurnMatchesFromGraphQL.has(item.id));
    }
    if (!yourTurnItems || yourTurnItems.length === 0) {
      // Use DOM badge detection as source of truth when GraphQL is unavailable
      yourTurnItems = items.filter(item => {
        // Prefer the hasYourTurn flag if available, fallback to text check
        return item.hasYourTurn || item.textLower.includes('your turn');
      });
    }
    
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
    const requiredDelayMs = (settings.chatSwitchDelay || 30) * 1000;
    
    // CRITICAL: Enforce chat switch delay BEFORE switching
    // Priority 1: Check nextAutoSwitchAt (set by previous switches or other code paths)
    if (nextAutoSwitchAt > 0 && now < nextAutoSwitchAt) {
      const remainingSeconds = Math.ceil((nextAutoSwitchAt - now) / 1000);
      console.log(`[AI Assistant] ⏳ Chat switch blocked by nextAutoSwitchAt. Waiting ${remainingSeconds}s more (${settings.chatSwitchDelay}s delay required)`);
      return false;
    }
    
    // Priority 2: Check if enough time has passed since last reply OR last switch (whichever is more recent)
    const mostRecentActionTime = Math.max(lastReplyTime || 0, lastAutoSwitchTime || 0);
    if (mostRecentActionTime > 0) {
      const timeSinceMostRecent = now - mostRecentActionTime;
      if (timeSinceMostRecent < requiredDelayMs) {
        const remainingSeconds = Math.ceil((requiredDelayMs - timeSinceMostRecent) / 1000);
        console.log(`[AI Assistant] ⏳ Chat switch delay not met. Waiting ${remainingSeconds}s more (${settings.chatSwitchDelay}s required since last action at ${new Date(mostRecentActionTime).toLocaleTimeString()})`);
        // Update nextAutoSwitchAt to enforce the delay
        nextAutoSwitchAt = mostRecentActionTime + requiredDelayMs;
        return false;
      }
    }
    
    // Use "Your turn" sequence so we advance chat-by-chat, not the first/sidebar order
    const nextId = findNextYourTurnConversationId(currentConvId, true);
    if (!nextId) {
      console.log('[AI Assistant] ⚠️ No next "Your turn" chat found to switch to');
      return false;
    }
    
    const clicked = clickConversationById(nextId);
    if (clicked) {
      lastAutoSwitchTime = now;
      lastAutoSwitchedToConversationId = nextId;
      currentChatEnteredAt = now;
      lastSeenConversationId = nextId;
      // Set nextAutoSwitchAt to prevent immediate re-switching
      nextAutoSwitchAt = now + requiredDelayMs;
      // After switching, allow immediate reply even if hash doesn't "change"
      allowInitialAutoReply = true;
      lastMessageHash = '';
      console.log(`[AI Assistant] 🔁 Switched to next chat: ${nextId} (delay: ${settings.chatSwitchDelay}s enforced, next switch allowed after ${new Date(nextAutoSwitchAt).toLocaleTimeString()})`);
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
      '[placeholder*="Start message" i], [placeholder*="conversation" i], [placeholder*="Say something" i]');
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
   * Extract messages from GraphQL cache only (MutualInboxConversationHistory, type=Message).
   * No DOM extraction.
   */
  function extractMessages() {
    const convId = getConversationId();

    if (convId && convId in gqlConversationCache) {
      const gqlMessages = gqlConversationCache[convId];
      const arr = Array.isArray(gqlMessages) ? gqlMessages : [];
      console.log(`[AI Assistant] 📋 Using ${arr.length} messages from GraphQL cache (by convId: ${convId}) - FULL HISTORY`);
      return arr; // Return full history, not limited
    }

    const cachedKeys = Object.keys(gqlConversationCache);
    if (cachedKeys.length > 0) {
      const latestKey = cachedKeys[cachedKeys.length - 1];
      const gqlMessages = gqlConversationCache[latestKey];
      if (gqlMessages && Array.isArray(gqlMessages)) {
        console.log(`[AI Assistant] 📋 Using ${gqlMessages.length} messages from GraphQL cache (by key: ${latestKey}) - FULL HISTORY`);
        return gqlMessages; // Return full history, not limited
      }
    }

    console.log(`[AI Assistant] 📋 No GraphQL cache for conversation – returning []`);
    return [];
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
      const ctaEnabled = settings.ctaEnabled !== false;
      // CTA timing is controlled by settings.ctaAfterMessages:
      // turnCount is how many messages we have ALREADY sent.
      // We want to trigger CTA on the N‑th message the user configured,
      // so we base the check on the *next* message number (turnCount + 1).
      const ctaAfter = Number.isFinite(settings.ctaAfterMessages) ? settings.ctaAfterMessages : 3;
      const nextTurnCount = turnCount + 1;
      let shouldRequestCTA = false;
      if (ctaEnabled && !ctaSent) {
        if (ctaAfter <= 0) {
          // 0 means "allow anytime": first eligible reply can be CTA.
          shouldRequestCTA = true;
        } else {
          shouldRequestCTA = nextTurnCount >= ctaAfter;
        }
      }
      console.log(`[AI Assistant] CTA check: turnCount=${turnCount}, nextTurnCount=${nextTurnCount}, ctaAfter=${ctaAfter}, ctaSent=${ctaSent}, shouldRequestCTA=${shouldRequestCTA}`);

      const partnerName = getPartnerDisplayName();
      // Send FULL chat history (not limited) with explicit direction labels
      // IMPORTANT: order newest → oldest so backend/AI sees latest first
      const orderedMessages = [...messages].reverse();
      const payload = {
        messages: orderedMessages.map(m => ({
          text: m.text,
          isOutgoing: m.isOutgoing,
          direction: m.isOutgoing ? 'sent' : 'received' // Explicit label for AI context
        })),
        // Send the turn count that includes the reply we are about to send,
        // so the backend knows how many messages we've sent in total.
        turnCount: nextTurnCount,
        requestCTA: shouldRequestCTA,
        partnerName: partnerName || undefined,
        // Include social handles for CTA customization
        instagramHandle: settings.instagramHandle,
        snapchatHandle: settings.snapchatHandle,
        ctaType: settings.ctaType,
        // CTA controls
        ctaEnabled: ctaEnabled,
        ctaInvisibleChars: (settings.ctaInvisibleChars || '')
      };
      
      console.log(`[AI Assistant] 📤 Sending ${messages.length} messages to backend (full history)`);

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
        // Verify invisible characters are present in CTA replies
        const customChars = (settings.ctaInvisibleChars || '').trim();
        const invisibleCharCount = customChars
          ? data.reply.split('').filter((ch) => customChars.includes(ch)).length
          : (data.reply.match(/[\u200B\u200C\u200D\u200E\u200F]/g) || []).length;
        console.log(`[AI Assistant] ✅ CTA reply received: length=${data.reply.length}, invisible chars=${invisibleCharCount}, preview="${data.reply.substring(0, 50)}..."`);
        if (invisibleCharCount === 0) {
          console.error(`[AI Assistant] ⚠️ WARNING: CTA reply has NO invisible characters!`);
        }
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
    const minSec = Number(settings.replyDelayMin);
    const maxSec = Number(settings.replyDelayMax);
    const safeMinSec = Number.isFinite(minSec) ? Math.max(1, Math.min(60, minSec)) : 3;
    const safeMaxSec = Number.isFinite(maxSec) ? Math.max(safeMinSec, Math.min(60, maxSec)) : Math.max(safeMinSec, 8);
    const min = safeMinSec * 1000;
    const max = safeMaxSec * 1000;
    const delay = Math.floor(Math.random() * (max - min + 1)) + min;
    if (!Number.isFinite(delay) || delay < 0) return 3000;
    return delay;
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
    
    // Debug: Log that we're running (only occasionally to avoid spam)
    if (Math.random() < 0.01) { // Log ~1% of the time
      console.log('[AI Assistant] 🔄 checkAndAutoReply running...', { session, autoSessionId, autoModeActive });
    }

    // Always refresh message input (may not be set yet on empty "You're a match" view)
    if (!messageInput || (document.body && !document.body.contains(messageInput))) {
      messageInput = findMessageInput();
    }

    // Get current conversation ID early so we can run empty-conversation check before requiring messageInput
    const currentConvId = getConversationId();
    
    // Check break status
    await checkBreakStatus();
    if (!isAutoSessionActive(session)) return;
    if (isOnBreak) {
      console.log('[AI Assistant] ☕ On break, skipping auto-reply');
      logSkipReason('currently on break');
      return;
    }

    // CRITICAL: Run empty-conversation check BEFORE requiring messageInput, so we send greeting on "You're a match" view
    const messages = extractMessages();
    if (messages.length === 0) {
      const convId = getConversationId();
      const hasGraphQLMessages = convId && gqlConversationCache[convId] && gqlConversationCache[convId].length > 0;
      const conversationIdForTurnCount = currentConvId || convId;
      
      // CRITICAL: Check GraphQL cache for CTA even if DOM is empty
      if (hasGraphQLMessages) {
        const gqlMessages = gqlConversationCache[convId];
        if (gqlMessages && gqlMessages.length > 0 && chatHistoryContainsAnyCTA(gqlMessages)) {
          conversationsWhereTheySharedCTA.add(convId);
          console.log(`[AI Assistant] 🚫 CTA detected in GraphQL cache (empty DOM) – handling according to settings.`);
          logSkipReason('CTA info exists in GraphQL cache (Instagram/Snapchat) — skipping empty conversation greeting');
          // If unmatch mode is enabled, attempt to unmatch instead of just skipping.
          await unmatchCurrentConversationIfEnabled(convId);
          const nextChatId = findNextYourTurnConversationId(convId, true);
          if (nextChatId) {
            autoSwitchToNextChat(convId);
          }
          return;
        }
      }
      
      // Also check if this conversation is already marked as having CTA
      if (conversationsWhereTheySharedCTA.has(convId)) {
        console.log(`[AI Assistant] 🚫 Conversation ${convId} already marked as having CTA – handling according to settings.`);
        logSkipReason('conversation already marked as having CTA');
        await unmatchCurrentConversationIfEnabled(convId);
        const nextChatId = findNextYourTurnConversationId(convId, true);
        if (nextChatId) {
          autoSwitchToNextChat(convId);
        }
        return;
      }
      
      const { turnCount } = await getTurnCount(conversationIdForTurnCount);
      if (!hasGraphQLMessages && turnCount === 0) {
        messageInput = messageInput || findMessageInput();
        if (messageInput) {
          console.log('[AI Assistant] 💬 Empty conversation – sending first greeting');
          isProcessingAuto = true;
          try {
            if (floatingButton) {
              floatingButton.disabled = true;
              floatingButton.textContent = '🤖 Generating greeting...';
              floatingButton.classList.add('match-ai-reply-button--processing');
            }
            const greeting = await generateAIReply([], 0, false);
            if (!isAutoSessionActive(session)) return;
            await new Promise(r => setTimeout(r, getRandomDelay()));
            if (!isAutoSessionActive(session)) return;
            messageInput = findMessageInput();
            if (!messageInput) {
              console.error('[AI Assistant] Message input lost');
              return;
            }
            insertReplyIntoInput(greeting);
            if (settings.autoSend) {
              await new Promise(r => setTimeout(r, 800));
              if (!isAutoSessionActive(session)) return;
              const sent = clickSendButton();
              if (sent) {
                await incrementTurnCount(conversationIdForTurnCount);
                lastReplyTime = Date.now();
                lastConversationId = conversationIdForTurnCount;
                await new Promise(r => setTimeout(r, 2500));
                lastMessageHash = getMessagesHash();
                repliedToInThisCycle.add(conversationIdForTurnCount);
                // Note: autoSwitchToNextChat() now enforces chatSwitchDelay internally
                // It will check if enough time has passed since lastReplyTime before switching
                const nextId = findNextYourTurnConversationId(conversationIdForTurnCount, true);
                if (nextId) {
                  const switched = autoSwitchToNextChat(conversationIdForTurnCount);
                  if (!switched) {
                    console.log(`[AI Assistant] ⏳ Chat switch delayed - will retry on next checkAndAutoReply cycle`);
                  }
                }
              }
            }
          } catch (e) {
            console.error('[AI Assistant] Error sending greeting:', e);
          } finally {
            isProcessingAuto = false;
            restoreButtonState();
          }
          return;
        }
        logSkipReason('empty conversation but no message input yet');
        nextAutoSwitchAt = Math.max(nextAutoSwitchAt || 0, Date.now() + 2000);
        return;
      }
      if (hasGraphQLMessages) {
        logSkipReason('GraphQL has messages but DOM empty – waiting');
        nextAutoSwitchAt = Math.max(nextAutoSwitchAt || 0, Date.now() + 2000);
        return;
      }
      if (turnCount > 0) {
        logSkipReason('no messages but turnCount > 0');
        nextAutoSwitchAt = Math.max(nextAutoSwitchAt || 0, Date.now() + 3000);
        return;
      }
      logSkipReason('empty conversation – waiting for input');
      nextAutoSwitchAt = Math.max(nextAutoSwitchAt || 0, Date.now() + 2000);
      return;
    }

    // If we're not inside an open conversation (no input), try switching to one
    if (!messageInput) {
      if (!nextAutoSwitchAt) nextAutoSwitchAt = Date.now();
      if (Date.now() >= nextAutoSwitchAt) autoSwitchToNextChat(currentConvId);
      return;
    }
    
    // Periodically reset cycle tracking (every 5 minutes) to handle new "Your turn" chats
    if (Date.now() - lastCycleResetTime > 5 * 60 * 1000) {
      console.log('[AI Assistant] 🔄 Resetting cycle tracking (5 min elapsed)');
      repliedToInThisCycle.clear();
      lastCycleResetTime = Date.now();
    }
    
    // CRITICAL: Early CTA check - if ANY CTA exists in messages, handle (skip / unmatch) this conversation immediately.
    // This must happen BEFORE any other reply logic to prevent sending messages.
    if (messages.length > 0) {
      if (conversationsWhereTheySharedCTA.has(currentConvId) || chatHistoryContainsAnyCTA(messages)) {
        if (!conversationsWhereTheySharedCTA.has(currentConvId)) {
          conversationsWhereTheySharedCTA.add(currentConvId);
          console.log(`[AI Assistant] 🚫 CTA detected in chat history (early check) – marking conversation.`);
        } else {
          console.log(`[AI Assistant] 🚫 Conversation already marked as having CTA (early check).`);
        }
        logSkipReason('CTA info exists in chat history (Instagram/Snapchat) — skipping replies for this conversation');
        // If unmatch mode is enabled, attempt to unmatch this chat instead of only skipping.
        await unmatchCurrentConversationIfEnabled(currentConvId);
        const nextChatId = findNextYourTurnConversationId(currentConvId, true);
        if (nextChatId) {
          autoSwitchToNextChat(currentConvId);
        }
        return;
      }
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
    
    // Check if there's a new message that needs a reply (messages already from early extractMessages() when non-empty)
    const currentHash = getMessagesHash();
    const messagesChanged = currentHash !== lastMessageHash;
    
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
      // CRITICAL: If ANY CTA info exists in the chat history (either side), do not reply anymore.
      if (conversationsWhereTheySharedCTA.has(currentConvId) || (messages.length > 0 && chatHistoryContainsAnyCTA(messages))) {
        conversationsWhereTheySharedCTA.add(currentConvId);
        console.log(`[AI Assistant] 🚫 CTA detected in chat history – not replying. Switching to next chat.`);
        logSkipReason('CTA info exists in chat history (Instagram/Snapchat) — skipping replies for this conversation');
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
      
      // CRITICAL CHECK: Final CTA check before generating reply (safety net)
      if (conversationsWhereTheySharedCTA.has(currentConversationId) || (messages.length > 0 && chatHistoryContainsAnyCTA(messages))) {
        if (!conversationsWhereTheySharedCTA.has(currentConversationId)) {
          conversationsWhereTheySharedCTA.add(currentConversationId);
        }
        console.log(`[AI Assistant] 🚫 CTA detected in final check before reply generation – aborting.`);
        logSkipReason('CTA info detected in final safety check before reply generation');
        // If unmatch mode is enabled, attempt to unmatch here as well.
        await unmatchCurrentConversationIfEnabled(currentConversationId);
        isProcessingAuto = false;
        restoreButtonState();
        const nextChat = findNextYourTurnConversationId(currentConversationId, true);
        if (nextChat) {
          autoSwitchToNextChat(currentConversationId);
        }
        return;
      }
      
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
    console.log('[AI Assistant] updateAutoMode called:', { autoMode: settings.autoMode, isMessagesPage: isMessagesPage(), messageInput: !!messageInput });
    
    const shouldBeActive = !!(settings.autoMode && isMessagesPage());
    const breakShouldBeActive = shouldBeActive && settings.randomBreakMode && !isOnBreak;

    // Only bump session + reset intervals when turning OFF, or when turning ON from OFF.
    // This prevents break timers from resetting on every SPA navigation/chat switch.
    const wasActive = !!autoModeActive;
    const turningOn = shouldBeActive && !wasActive;
    const turningOff = !shouldBeActive && wasActive;

    if (turningOn || turningOff) {
      autoSessionId++;
    }

    // Clear intervals only when turning off, or when not supposed to be active
    if (!shouldBeActive) {
      if (autoModeInterval) {
        clearInterval(autoModeInterval);
        autoModeInterval = null;
      }
      if (breakCheckInterval) {
        clearInterval(breakCheckInterval);
        breakCheckInterval = null;
      }
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

    // Start/keep auto mode if enabled
    if (shouldBeActive) {
      console.log('[AI Assistant] ✅ Starting auto mode - conditions met');
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
      
      // Start checking for new messages (only create interval once)
      if (!autoModeInterval) {
        autoModeInterval = setInterval(() => {
          try {
            checkAndAutoReply();
          } catch (err) {
            console.error('[AI Assistant] ❌ Error in checkAndAutoReply:', err);
          }
        }, CONFIG.AUTO_CHECK_INTERVAL);
      }
      
      console.log(`[AI Assistant] 🤖 Auto mode ACTIVATED - interval set to ${CONFIG.AUTO_CHECK_INTERVAL}ms`);
      
      // If break mode is enabled, schedule breaks
      if (breakShouldBeActive) {
        scheduleNextBreak(false);
        // Also run break check more frequently (every 5 seconds) to catch break time accurately
        if (!breakCheckInterval) {
          breakCheckInterval = setInterval(() => {
            checkBreakStatus().catch(err => {
              console.error('[AI Assistant] Error in break check interval:', err);
            });
          }, 5000);
        }
        console.log('[AI Assistant] ☕ Break mode enabled - break check every 5s');
      } else {
        // If breaks are not enabled now, stop break checks but DO NOT clear nextBreakTime (so enabling again resumes schedule)
        if (breakCheckInterval) {
          clearInterval(breakCheckInterval);
          breakCheckInterval = null;
        }
      }
    } else {
      autoModeActive = false;
      nextBreakTime = null;
      allowInitialAutoReply = false;
      nextAutoSwitchAt = 0;
      isProcessingAuto = false;
      if (!settings.autoMode) {
        console.log('[AI Assistant] Auto mode deactivated - settings.autoMode is false');
      } else if (!isMessagesPage()) {
        console.log('[AI Assistant] Auto mode deactivated - not on messages page');
      }
    }

    // Whenever auto/chat mode configuration changes, also refresh rotation logic
    updateModeRotation();
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
    // Always load settings first (for both chat and swipe modes)
    await loadSettings();

    // Chat features only apply on messages page
    if (isMessagesPage()) {
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
    } else {
      // If not on messages page, ensure auto mode timers are stopped
      updateAutoMode();
    }

    // Swipe mode only applies on Discover (/home)
    updateSwipeMode();

    // Ensure rotation timer reflects latest settings + current page
    updateModeRotation();
  }

  /**
   * Hook into fetch to intercept GraphQL responses and extract conversation data
   */
  /**
   * Process MutualInboxConversationHistory GraphQL response
   * Extracts partner name (handle) and messages (type=Message only)
   */
  function processMutualInboxResponse(json, requestJson) {
    try {
      // Support both camelCase and PascalCase response keys
      const historyPayload = json?.data?.mutualInboxConversationHistory ?? json?.data?.MutualInboxConversationHistory;
      const history = historyPayload?.matchesHistory;
      
      if (!history) {
        console.warn('[AI Assistant] ⚠️ No matchesHistory in GraphQL response');
        return;
      }
      
      // Try to get conversation ID from current URL first
      let convId = getConversationId();
      
      // Extract userId from request variables
      const requestUserId = requestJson?.variables?.userId;
      
      // Use userId from response (matchesHistory.userId) or request as fallback
      const historyUserId = history.userId;
      if (!convId && requestUserId) convId = requestUserId;
      if (!convId && historyUserId) convId = historyUserId;
      
      const cacheKey = convId || requestUserId || historyUserId;
      
      console.log(`[AI Assistant] 📥 Received MutualInboxConversationHistory response for userId: ${historyUserId || requestUserId || 'unknown'}, cacheKey: ${cacheKey}`);
      
      // Extract partner name (handle) - store by all known IDs for lookup
      if (history.handle) {
        for (const id of [convId, requestUserId, historyUserId].filter(Boolean)) {
          partnerNamesByConversation[id] = history.handle;
        }
        if (cacheKey) {
          console.log(`[AI Assistant] 📛 Extracted partner name from GraphQL: "${history.handle}" for conversation ${cacheKey}`);
        }
      } else {
        console.warn('[AI Assistant] ⚠️ No handle (partner name) in GraphQL response');
      }
      
      // Extract messages from GraphQL: only type=Message counts; type=Like has message=null
      if (history.items && Array.isArray(history.items)) {
        const totalItems = history.items.length;
        const messages = history.items
          .filter(item => item.type === 'Message' && item.message && (item.message + '').trim())
          .map(item => ({
            text: item.message,
            isOutgoing: item.direction === 'Sent',
            timestamp: new Date(item.sentDate).getTime()
          }));

        // IMPORTANT: Normalize order to oldest → newest so "latest message" is always the LAST element.
        // Match.com GraphQL often returns newest-first; our skip/turn logic assumes newest-last.
        messages.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
        
        console.log(`[AI Assistant] 📋 GraphQL response: ${totalItems} total items, ${messages.length} type=Message items`);
        
        // Always store cache for this conversation: [] = confirmed no messages (e.g. only "Like" items)
        if (cacheKey) {
          gqlConversationCache[cacheKey] = messages;
          if (messages.length > 0) {
            console.log(`[AI Assistant] 📋 Cached ${messages.length} messages from GraphQL for conversation ${cacheKey}`);
          } else {
            console.log(`[AI Assistant] 📋 Cached 0 messages (empty/conversation or only Like items) for ${cacheKey} - eligible for first greeting`);
          }
        } else {
          console.warn('[AI Assistant] ⚠️ No cacheKey available - cannot store messages');
        }
      } else {
        console.warn('[AI Assistant] ⚠️ No items array in GraphQL response');
      }
    } catch (err) {
      console.error('[AI Assistant] ❌ Error processing MutualInboxConversationHistory response:', err);
    }
  }

  /**
   * Process MutualInboxMatches GraphQL response
   * Uses "isYourTurn" flags to know which conversations need our reply.
   */
  function processMutualInboxMatchesResponse(json) {
    try {
      const matchesPayload = json?.data?.mutualInbox?.matches ?? json?.data?.MutualInbox?.matches;
      const items = matchesPayload?.items;
      if (!items || !Array.isArray(items)) {
        console.warn('[AI Assistant] ⚠️ No matches.items in MutualInboxMatches response');
        return;
      }

      yourTurnMatchesFromGraphQL.clear();

      items.forEach((item) => {
        try {
          const convId = item.userId || item.id;
          if (!convId) return;
          if (item.isYourTurn === true) {
            yourTurnMatchesFromGraphQL.add(String(convId));
          }
        } catch (_) {
          // ignore per-item errors
        }
      });

      console.log(
        `[AI Assistant] 📋 MutualInboxMatches: ${yourTurnMatchesFromGraphQL.size} conversations are currently "your turn" according to GraphQL.`
      );

      // Rebuild sequence if auto mode is active so we immediately use freshest list.
      if (autoModeActive) {
        buildYourTurnChatSequence();
      }
    } catch (err) {
      console.error('[AI Assistant] ❌ Error processing MutualInboxMatches response:', err);
    }
  }

  /**
   * Hook window.fetch to intercept GraphQL responses
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
        
        // Check if this is MutualInboxConversationHistory or MutualInboxMatches request
        let requestBody = null;
        let requestJson = null;
        if (init && init.body) {
          requestBody = typeof init.body === 'string' ? init.body : JSON.stringify(init.body);
          try {
            requestJson = JSON.parse(requestBody);
          } catch (_) {}
        }
        
        // Check both operationName field and string match for reliability
        const opName = requestJson?.operationName;
        const lowerBody = requestBody && requestBody.toLowerCase();
        const isHistoryRequest =
          opName === 'MutualInboxConversationHistory' ||
          (lowerBody && lowerBody.includes('mutualinboxconversationhistory'));
        const isMatchesRequest =
          opName === 'MutualInboxMatches' || (lowerBody && lowerBody.includes('mutualinboxmatches'));

        const json = await clonedResponse.json().catch(() => null);
        if (json) {
          if (isHistoryRequest) {
            processMutualInboxResponse(json, requestJson);
          } else if (isMatchesRequest) {
            processMutualInboxMatchesResponse(json);
          }
        }
      } catch (err) {
        // Silently ignore errors - don't break the page
        console.warn('[AI Assistant] Error intercepting GraphQL fetch response:', err);
      }
      
      return response;
    };
  })();

  /**
   * Hook XMLHttpRequest to intercept GraphQL responses (fallback for requests not using fetch)
   */
  (function hookGraphQLXHR() {
    if (typeof window === 'undefined' || !window.XMLHttpRequest) return;
    
    const originalXHROpen = XMLHttpRequest.prototype.open;
    const originalXHRSend = XMLHttpRequest.prototype.send;
    const originalXHRSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
    
    XMLHttpRequest.prototype.open = function(method, url, ...args) {
      this._url = url;
      this._method = method;
      return originalXHROpen.apply(this, [method, url, ...args]);
    };
    
    XMLHttpRequest.prototype.send = function(body) {
      this._requestBody = body;
      this._requestJson = null;
      
      // Try to parse request body if it's JSON
      if (body && typeof body === 'string') {
        try {
          this._requestJson = JSON.parse(body);
        } catch (_) {}
      }
      
      // Set up response interceptor
      const originalOnReadyStateChange = this.onreadystatechange;
      this.onreadystatechange = function() {
        if (this.readyState === 4 && this.status === 200) {
          try {
            const url = this._url || '';
            if (url.includes('/graphql')) {
              const requestJson = this._requestJson;
              const bodyLower = this._requestBody && String(this._requestBody).toLowerCase();
              const opName = requestJson?.operationName;
              const isHistoryRequest =
                opName === 'MutualInboxConversationHistory' ||
                (bodyLower && bodyLower.includes('mutualinboxconversationhistory'));
              const isMatchesRequest =
                opName === 'MutualInboxMatches' || (bodyLower && bodyLower.includes('mutualinboxmatches'));

              try {
                const json = JSON.parse(this.responseText);
                if (isHistoryRequest) {
                  processMutualInboxResponse(json, requestJson);
                } else if (isMatchesRequest) {
                  processMutualInboxMatchesResponse(json);
                }
              } catch (err) {
                console.warn('[AI Assistant] Error parsing XHR GraphQL response:', err);
              }
            }
          } catch (err) {
            console.warn('[AI Assistant] Error intercepting GraphQL XHR response:', err);
          }
        }
        
        // Call original handler if it exists
        if (originalOnReadyStateChange) {
          originalOnReadyStateChange.apply(this, arguments);
        }
      };
      
      // Also handle addEventListener('readystatechange')
      const originalAddEventListener = this.addEventListener;
      this.addEventListener = function(type, listener, ...args) {
        if (type === 'readystatechange' || type === 'load') {
          const wrappedListener = function() {
            if (this.readyState === 4 && this.status === 200) {
              try {
                const url = this._url || '';
                if (url.includes('/graphql')) {
                  const requestJson = this._requestJson;
                  const bodyLower = this._requestBody && String(this._requestBody).toLowerCase();
                  const opName = requestJson?.operationName;
                  const isHistoryRequest =
                    opName === 'MutualInboxConversationHistory' ||
                    (bodyLower && bodyLower.includes('mutualinboxconversationhistory'));
                  const isMatchesRequest =
                    opName === 'MutualInboxMatches' || (bodyLower && bodyLower.includes('mutualinboxmatches'));

                  try {
                    const json = JSON.parse(this.responseText);
                    if (isHistoryRequest) {
                      processMutualInboxResponse(json, requestJson);
                    } else if (isMatchesRequest) {
                      processMutualInboxMatchesResponse(json);
                    }
                  } catch (err) {
                    console.warn('[AI Assistant] Error parsing XHR GraphQL response:', err);
                  }
                }
              } catch (err) {
                console.warn('[AI Assistant] Error intercepting GraphQL XHR response:', err);
              }
            }
            listener.apply(this, arguments);
          };
          return originalAddEventListener.apply(this, [type, wrappedListener, ...args]);
        }
        return originalAddEventListener.apply(this, arguments);
      };
      
      return originalXHRSend.apply(this, arguments);
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
