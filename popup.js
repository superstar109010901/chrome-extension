/**
 * Match.com AI Reply Assistant - Popup Script
 * 
 * Handles settings management for:
 * - Auto/Manual mode
 * - Auto-send toggle
 * - Random Break mode
 * - Social media handles (Instagram, Snapchat)
 * - CTA preferences
 */

// Backend API URL (same one used by content script)
const BACKEND_URL = 'https://match-ai-backend.onrender.com';

document.addEventListener('DOMContentLoaded', () => {
  // Elements
  const statusEl = document.getElementById('status');
  const autoModeEl = document.getElementById('autoMode');
  const autoSendEl = document.getElementById('autoSend');
  const autoSendRowEl = document.getElementById('autoSendRow');
  const delayRowEl = document.getElementById('delayRow');
  const autoWarningEl = document.getElementById('autoWarning');
  const replyDelayEl = document.getElementById('replyDelay');
  const replyDelayMaxEl = document.getElementById('replyDelayMax');
  const chatSwitchDelayEl = document.getElementById('chatSwitchDelay');
  
  // Break mode elements
  const breakSectionEl = document.getElementById('breakSection');
  const randomBreakModeEl = document.getElementById('randomBreakMode');
  const breakSettingsRowEl = document.getElementById('breakSettingsRow');
  const breakDurationMinEl = document.getElementById('breakDurationMin');
  const breakDurationMaxEl = document.getElementById('breakDurationMax');
  const breakIntervalMinEl = document.getElementById('breakIntervalMin');
  const breakIntervalMaxEl = document.getElementById('breakIntervalMax');
  const breakStatusEl = document.getElementById('breakStatus');
  const breakStatusTextEl = document.getElementById('breakStatusText');
  
  // Social media elements
  const instagramHandleEl = document.getElementById('instagramHandle');
  const snapchatHandleEl = document.getElementById('snapchatHandle');
  const ctaTypeEl = document.getElementById('ctaType');
  const ctaAfterMessagesEl = document.getElementById('ctaAfterMessages');
  const openaiApiKeyEl = document.getElementById('openaiApiKey');
  const removeOpenaiApiKeyEl = document.getElementById('removeOpenaiApiKey');
  const saveBtnEl = document.getElementById('saveBtn');

  // Swipe tab elements
  const swipeEnabledEl = document.getElementById('swipeEnabled');
  const swipeLikePercentEl = document.getElementById('swipeLikePercent');
  const swipeIntervalSecondsMinEl = document.getElementById('swipeIntervalSecondsMin');
  const swipeIntervalSecondsMaxEl = document.getElementById('swipeIntervalSecondsMax');
  const tabs = Array.from(document.querySelectorAll('.tab'));
  const tabContents = {
    chat: document.getElementById('chatTab'),
    swipe: document.getElementById('swipeTab')
  };

  // Default settings
  const DEFAULT_SETTINGS = {
    autoMode: false,
    autoSend: true,
    replyDelayMin: 3,
    replyDelayMax: 8,
    chatSwitchDelay: 30, // Delay between switching to different chats (seconds)
    // Break mode settings
    randomBreakMode: false,
    breakDurationMin: 5,
    breakDurationMax: 15,
    breakIntervalMin: 45,
    breakIntervalMax: 75,
    // Social handles
    instagramHandle: '',
    snapchatHandle: '',
    ctaType: 'instagram',
    // CTA timing
    ctaAfterMessages: 3,
    // OpenAI API key (stored in DB)
    openaiApiKey: '',
    // Swipe settings
    swipeEnabled: false,
    swipeLikePercent: 50,
    swipeIntervalSecondsMin: 4,
    swipeIntervalSecondsMax: 8
  };

  // Load settings directly from backend API (MongoDB)
  async function loadSettings() {
    try {
      const response = await fetch(`${BACKEND_URL.replace(/\/$/, '')}/settings`, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' }
      });
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      const settingsFromDB = await response.json();
      console.log('[Popup] Settings from DB:', settingsFromDB);

      // Merge DB settings into DEFAULT_SETTINGS so the "extension defaults"
      // become whatever is stored in the database.
      const mergedSettings = { ...DEFAULT_SETTINGS, ...settingsFromDB };
      console.log('[Popup] Merged settings (applied as defaults):', mergedSettings);
      Object.assign(DEFAULT_SETTINGS, mergedSettings);

      // Use the merged/defaults (now seeded from DB) to populate the UI
      autoModeEl.checked = DEFAULT_SETTINGS.autoMode;
      autoSendEl.checked = DEFAULT_SETTINGS.autoSend;
      replyDelayEl.value = DEFAULT_SETTINGS.replyDelayMin;
      replyDelayMaxEl.value = DEFAULT_SETTINGS.replyDelayMax;
      chatSwitchDelayEl.value = DEFAULT_SETTINGS.chatSwitchDelay || 30;
      
      // Break mode
      randomBreakModeEl.checked = DEFAULT_SETTINGS.randomBreakMode;
      breakDurationMinEl.value = DEFAULT_SETTINGS.breakDurationMin;
      breakDurationMaxEl.value = DEFAULT_SETTINGS.breakDurationMax;
      breakIntervalMinEl.value = DEFAULT_SETTINGS.breakIntervalMin;
      breakIntervalMaxEl.value = DEFAULT_SETTINGS.breakIntervalMax;
      
      // Social handles
      instagramHandleEl.value = DEFAULT_SETTINGS.instagramHandle;
      snapchatHandleEl.value = DEFAULT_SETTINGS.snapchatHandle;
      ctaTypeEl.value = DEFAULT_SETTINGS.ctaType;
      ctaAfterMessagesEl.value = DEFAULT_SETTINGS.ctaAfterMessages ?? 3;
      openaiApiKeyEl.value = DEFAULT_SETTINGS.openaiApiKey || '';
      if (removeOpenaiApiKeyEl) removeOpenaiApiKeyEl.checked = false;
      // Swipe
      swipeEnabledEl.checked = DEFAULT_SETTINGS.swipeEnabled;
      swipeLikePercentEl.value = DEFAULT_SETTINGS.swipeLikePercent ?? 50;
      swipeIntervalSecondsMinEl.value = DEFAULT_SETTINGS.swipeIntervalSecondsMin ?? 4;
      swipeIntervalSecondsMaxEl.value = DEFAULT_SETTINGS.swipeIntervalSecondsMax ?? 8;
      
      updateUIVisibility();
      
      // Load break state from Chrome storage (break state is still local)
      chrome.storage.local.get('breakState', (result) => {
        if (result.breakState?.isOnBreak) {
          updateBreakStatus(result.breakState);
        }
      });
    } catch (error) {
      console.error('Error loading settings from API:', error);
      // Fallback to defaults if API fails
      const settings = DEFAULT_SETTINGS;
      autoModeEl.checked = settings.autoMode;
      autoSendEl.checked = settings.autoSend;
      replyDelayEl.value = settings.replyDelayMin;
      replyDelayMaxEl.value = settings.replyDelayMax;
      chatSwitchDelayEl.value = settings.chatSwitchDelay || 30;
      randomBreakModeEl.checked = settings.randomBreakMode;
      breakDurationMinEl.value = settings.breakDurationMin;
      breakDurationMaxEl.value = settings.breakDurationMax;
      breakIntervalMinEl.value = settings.breakIntervalMin;
      breakIntervalMaxEl.value = settings.breakIntervalMax;
      instagramHandleEl.value = settings.instagramHandle;
      snapchatHandleEl.value = settings.snapchatHandle;
      ctaTypeEl.value = settings.ctaType;
      ctaAfterMessagesEl.value = settings.ctaAfterMessages ?? 3;
      openaiApiKeyEl.value = settings.openaiApiKey || '';
      if (removeOpenaiApiKeyEl) removeOpenaiApiKeyEl.checked = false;
      swipeEnabledEl.checked = settings.swipeEnabled;
      swipeLikePercentEl.value = settings.swipeLikePercent ?? 50;
      swipeIntervalSecondsMinEl.value = settings.swipeIntervalSecondsMin ?? 4;
      swipeIntervalSecondsMaxEl.value = settings.swipeIntervalSecondsMax ?? 8;
      updateUIVisibility();
    }
  }

  // Save settings directly to backend API (MongoDB)
  async function saveSettings() {
    const settings = {
      autoMode: autoModeEl.checked,
      autoSend: autoSendEl.checked,
      replyDelayMin: parseInt(replyDelayEl.value) || 3,
      replyDelayMax: parseInt(replyDelayMaxEl.value) || 8,
      chatSwitchDelay: parseInt(chatSwitchDelayEl.value) || 30,
      // Break mode
      randomBreakMode: randomBreakModeEl.checked,
      breakDurationMin: parseInt(breakDurationMinEl.value) || 5,
      breakDurationMax: parseInt(breakDurationMaxEl.value) || 15,
      breakIntervalMin: parseInt(breakIntervalMinEl.value) || 45,
      breakIntervalMax: parseInt(breakIntervalMaxEl.value) || 75,
      // Social handles
      instagramHandle: instagramHandleEl.value.trim(),
      snapchatHandle: snapchatHandleEl.value.trim(),
      ctaType: ctaTypeEl.value,
      ctaAfterMessages: parseInt(ctaAfterMessagesEl.value, 10),
      swipeEnabled: swipeEnabledEl.checked,
      swipeLikePercent: parseInt(swipeLikePercentEl.value, 10),
      swipeIntervalSecondsMin: parseInt(swipeIntervalSecondsMinEl.value, 10),
      swipeIntervalSecondsMax: parseInt(swipeIntervalSecondsMaxEl.value, 10)
    };

    // OpenAI key behavior:
    // - If "Remove API Key" is checked: explicitly delete it by sending empty string.
    // - Else if user typed a key: send it.
    // - Else (blank): do NOT send openaiApiKey field (backend will keep existing DB value).
    const removeKey = !!(removeOpenaiApiKeyEl && removeOpenaiApiKeyEl.checked);
    const typedKey = (openaiApiKeyEl?.value || '').trim();
    if (removeKey) {
      settings.openaiApiKey = '';
    } else if (typedKey) {
      settings.openaiApiKey = typedKey;
    }

    if (!Number.isFinite(settings.ctaAfterMessages) || settings.ctaAfterMessages < 0) settings.ctaAfterMessages = 0;
    if (settings.ctaAfterMessages > 50) settings.ctaAfterMessages = 50;

    // Validate swipe values
    if (!Number.isFinite(settings.swipeLikePercent)) settings.swipeLikePercent = 50;
    settings.swipeLikePercent = Math.min(100, Math.max(0, settings.swipeLikePercent));
    if (!Number.isFinite(settings.swipeIntervalSecondsMin)) settings.swipeIntervalSecondsMin = 4;
    if (!Number.isFinite(settings.swipeIntervalSecondsMax)) settings.swipeIntervalSecondsMax = 8;
    if (settings.swipeIntervalSecondsMin < 2) settings.swipeIntervalSecondsMin = 2;
    if (settings.swipeIntervalSecondsMax < settings.swipeIntervalSecondsMin) {
      settings.swipeIntervalSecondsMax = settings.swipeIntervalSecondsMin + 2;
    }
    if (settings.swipeIntervalSecondsMax > 60) settings.swipeIntervalSecondsMax = 60;

    // Validate delay values
    if (settings.replyDelayMin < 1) settings.replyDelayMin = 1;
    if (settings.replyDelayMax < settings.replyDelayMin) {
      settings.replyDelayMax = settings.replyDelayMin + 3;
    }
    if (settings.chatSwitchDelay < 5) settings.chatSwitchDelay = 5;
    if (settings.chatSwitchDelay > 300) settings.chatSwitchDelay = 300;
    
    // Validate break values
    if (settings.breakDurationMin < 1) settings.breakDurationMin = 1;
    if (settings.breakDurationMax < settings.breakDurationMin) {
      settings.breakDurationMax = settings.breakDurationMin + 5;
    }
    if (settings.breakIntervalMin < 15) settings.breakIntervalMin = 15;
    if (settings.breakIntervalMax < settings.breakIntervalMin) {
      settings.breakIntervalMax = settings.breakIntervalMin + 15;
    }

    try {
      const response = await fetch(`${BACKEND_URL.replace(/\/$/, '')}/settings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(settings)
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      // Show saved feedback
      saveBtnEl.textContent = '✓ Saved!';
      saveBtnEl.classList.add('saved');
      
      setTimeout(() => {
        saveBtnEl.textContent = 'Save Settings';
        saveBtnEl.classList.remove('saved');
      }, 1500);

      // Notify content script of settings change
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]?.id) {
          chrome.tabs.sendMessage(tabs[0].id, { 
            action: 'settingsUpdated', 
            settings 
          }).catch(() => {
            // Tab might not have content script
          });
        }
      });
    } catch (error) {
      console.error('Error saving settings to API:', error);
      // Show error feedback
      saveBtnEl.textContent = '✗ Error!';
      saveBtnEl.classList.add('saved');
      
      setTimeout(() => {
        saveBtnEl.textContent = 'Save Settings';
        saveBtnEl.classList.remove('saved');
      }, 2000);
    }
  }

  // Update UI visibility based on auto mode
  function updateUIVisibility() {
    const isAutoMode = autoModeEl.checked;
    const isBreakMode = randomBreakModeEl.checked;
    
    autoSendRowEl.style.display = isAutoMode ? 'flex' : 'none';
    delayRowEl.style.display = isAutoMode ? 'block' : 'none';
    autoWarningEl.style.display = isAutoMode ? 'block' : 'none';
    breakSectionEl.style.display = isAutoMode ? 'block' : 'none';
    breakSettingsRowEl.style.display = isBreakMode ? 'block' : 'none';
  }

  // Simple tab switching between Chat / Swipe
  function activateTab(tabName) {
    tabs.forEach((btn) => {
      const name = btn.getAttribute('data-tab');
      const isActive = name === tabName;
      if (isActive) {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
    });
    Object.entries(tabContents).forEach(([name, el]) => {
      if (!el) return;
      if (name === tabName) {
        el.classList.add('active');
      } else {
        el.classList.remove('active');
      }
    });
    // Persist last-selected tab for convenience
    try {
      chrome.storage.local.set({ popupActiveTab: tabName });
    } catch (_) {}
  }

  // Update break status display
  function updateBreakStatus(breakState) {
    if (breakState?.isOnBreak) {
      const remainingMs = breakState.breakEndTime - Date.now();
      if (remainingMs > 0) {
        const remainingMin = Math.ceil(remainingMs / 60000);
        breakStatusTextEl.textContent = `☕ On break for ${remainingMin} more minute(s)...`;
        breakStatusEl.style.display = 'block';
      } else {
        breakStatusEl.style.display = 'none';
      }
    } else {
      breakStatusEl.style.display = 'none';
    }
  }

  // Check if we're on Match.com
  function checkStatus() {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const currentTab = tabs[0];
      if (currentTab?.url?.includes('match.com')) {
        const isAutoMode = autoModeEl.checked;
        const isBreakMode = randomBreakModeEl.checked;
        
        if (isAutoMode && isBreakMode) {
          statusEl.textContent = '🤖 Auto + Break Mode';
        } else if (isAutoMode) {
          statusEl.textContent = '🤖 Auto Mode Active';
        } else {
          statusEl.textContent = '✅ Active on Match.com';
        }
        statusEl.classList.remove('inactive');
      } else {
        statusEl.textContent = '⚪ Navigate to Match.com';
        statusEl.classList.add('inactive');
      }
    });
    
    // Also check break state
    chrome.storage.local.get('breakState', (result) => {
      updateBreakStatus(result.breakState);
    });
  }

  // Event listeners
  autoModeEl.addEventListener('change', () => {
    // Auto-enable autoSend when auto mode is turned on
    if (autoModeEl.checked && !autoSendEl.checked) {
      autoSendEl.checked = true;
    }
    updateUIVisibility();
    checkStatus();
  });
  
  randomBreakModeEl.addEventListener('change', () => {
    updateUIVisibility();
    checkStatus();
  });

  // All other controls only change UI until user clicks "Save Settings"
  autoSendEl.addEventListener('change', updateUIVisibility);
  replyDelayEl.addEventListener('change', () => {});
  replyDelayMaxEl.addEventListener('change', () => {});
  chatSwitchDelayEl.addEventListener('change', () => {});
  breakDurationMinEl.addEventListener('change', () => {});
  breakDurationMaxEl.addEventListener('change', () => {});
  breakIntervalMinEl.addEventListener('change', () => {});
  breakIntervalMaxEl.addEventListener('change', () => {});
  instagramHandleEl.addEventListener('change', () => {});
  snapchatHandleEl.addEventListener('change', () => {});
  ctaTypeEl.addEventListener('change', () => {});

  tabs.forEach((btn) => {
    btn.addEventListener('click', () => {
      const name = btn.getAttribute('data-tab') || 'chat';
      activateTab(name);
    });
  });

  saveBtnEl.addEventListener('click', saveSettings);

  // Format Instagram handle
  instagramHandleEl.addEventListener('blur', () => {
    let value = instagramHandleEl.value.trim();
    if (value && !value.startsWith('@')) {
      instagramHandleEl.value = '@' + value;
    }
  });

  // Initialize
  // Restore last active tab (defaults to "chat")
  chrome.storage.local.get('popupActiveTab', (result) => {
    const tabName = result.popupActiveTab === 'swipe' ? 'swipe' : 'chat';
    activateTab(tabName);
  });
  loadSettings();
  checkStatus();
  
  // Update break status every 30 seconds
  setInterval(() => {
    chrome.storage.local.get('breakState', (result) => {
      updateBreakStatus(result.breakState);
    });
  }, 30000);
});
