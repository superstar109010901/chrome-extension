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
  const saveBtnEl = document.getElementById('saveBtn');

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
    ctaType: 'instagram'
  };

  // Load settings from storage
  function loadSettings() {
    chrome.storage.local.get(['settings', 'breakState'], (result) => {
      const settings = { ...DEFAULT_SETTINGS, ...result.settings };
      
      autoModeEl.checked = settings.autoMode;
      autoSendEl.checked = settings.autoSend;
      replyDelayEl.value = settings.replyDelayMin;
      replyDelayMaxEl.value = settings.replyDelayMax;
      chatSwitchDelayEl.value = settings.chatSwitchDelay || 30;
      
      // Break mode
      randomBreakModeEl.checked = settings.randomBreakMode;
      breakDurationMinEl.value = settings.breakDurationMin;
      breakDurationMaxEl.value = settings.breakDurationMax;
      breakIntervalMinEl.value = settings.breakIntervalMin;
      breakIntervalMaxEl.value = settings.breakIntervalMax;
      
      // Social handles
      instagramHandleEl.value = settings.instagramHandle;
      snapchatHandleEl.value = settings.snapchatHandle;
      ctaTypeEl.value = settings.ctaType;
      
      updateUIVisibility();
      
      // Show break status if on break
      if (result.breakState?.isOnBreak) {
        updateBreakStatus(result.breakState);
      }
    });
  }

  // Save settings to storage
  function saveSettings() {
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
      ctaType: ctaTypeEl.value
    };

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

    chrome.storage.local.set({ settings }, () => {
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
    });
  }

  // Auto-save (debounced) so toggles take effect immediately
  let autoSaveTimer = null;
  function scheduleAutoSave() {
    if (autoSaveTimer) clearTimeout(autoSaveTimer);
    autoSaveTimer = setTimeout(() => {
      saveSettings();
    }, 250);
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
    scheduleAutoSave();
  });
  
  randomBreakModeEl.addEventListener('change', () => {
    updateUIVisibility();
    checkStatus();
    scheduleAutoSave();
  });

  autoSendEl.addEventListener('change', scheduleAutoSave);
  replyDelayEl.addEventListener('change', scheduleAutoSave);
  replyDelayMaxEl.addEventListener('change', scheduleAutoSave);
  chatSwitchDelayEl.addEventListener('change', scheduleAutoSave);
  breakDurationMinEl.addEventListener('change', scheduleAutoSave);
  breakDurationMaxEl.addEventListener('change', scheduleAutoSave);
  breakIntervalMinEl.addEventListener('change', scheduleAutoSave);
  breakIntervalMaxEl.addEventListener('change', scheduleAutoSave);
  instagramHandleEl.addEventListener('change', scheduleAutoSave);
  snapchatHandleEl.addEventListener('change', scheduleAutoSave);
  ctaTypeEl.addEventListener('change', scheduleAutoSave);

  saveBtnEl.addEventListener('click', saveSettings);

  // Format Instagram handle
  instagramHandleEl.addEventListener('blur', () => {
    let value = instagramHandleEl.value.trim();
    if (value && !value.startsWith('@')) {
      instagramHandleEl.value = '@' + value;
    }
  });

  // Initialize
  loadSettings();
  checkStatus();
  
  // Update break status every 30 seconds
  setInterval(() => {
    chrome.storage.local.get('breakState', (result) => {
      updateBreakStatus(result.breakState);
    });
  }, 30000);
});
