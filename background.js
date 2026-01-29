/**
 * Match.com AI Reply Assistant - Background Service Worker
 * 
 * Handles:
 * - Storage management (if needed)
 * - API communication (optional, can be done from content script)
 * - Extension lifecycle events
 * - Chrome Debugger API for GraphQL interception
 */

// Track attached tabs for debugger
const attachedTabs = new Set();

// Listen for extension installation
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    console.log('Match.com AI Reply Assistant installed');
  } else if (details.reason === 'update') {
    console.log('Match.com AI Reply Assistant updated');
  }
  
  // Attach debugger to any existing Match.com tabs
  chrome.tabs.query({ url: '*://*.match.com/*' }, (tabs) => {
    tabs.forEach(tab => {
      if (tab.id) {
        attachDebuggerToTab(tab.id);
      }
    });
  });
});

// Attach debugger to existing Match.com tabs on startup
chrome.tabs.query({ url: '*://*.match.com/*' }, (tabs) => {
  tabs.forEach(tab => {
    if (tab.id) {
      attachDebuggerToTab(tab.id);
    }
  });
});

// Attach debugger to Match.com tabs
async function attachDebuggerToTab(tabId) {
  if (attachedTabs.has(tabId)) {
    return; // Already attached
  }

  try {
    await chrome.debugger.attach({ tabId }, '1.0');
    await chrome.debugger.sendCommand({ tabId }, 'Network.enable');
    attachedTabs.add(tabId);
    console.log(`[Background] 🔍 Debugger attached to tab ${tabId}`);
  } catch (err) {
    // Tab might already have debugger attached or be invalid
    if (err.message && !err.message.includes('Another debugger')) {
      console.warn(`[Background] Failed to attach debugger to tab ${tabId}:`, err);
    }
  }
}

// Detach debugger from tab
async function detachDebuggerFromTab(tabId) {
  if (!attachedTabs.has(tabId)) {
    return;
  }

  try {
    await chrome.debugger.detach({ tabId });
    attachedTabs.delete(tabId);
    console.log(`[Background] 🔍 Debugger detached from tab ${tabId}`);
  } catch (err) {
    console.warn(`[Background] Failed to detach debugger from tab ${tabId}:`, err);
    attachedTabs.delete(tabId);
  }
}

// Listen for tab updates to attach debugger to Match.com tabs
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'loading' && tab.url && tab.url.includes('match.com')) {
    attachDebuggerToTab(tabId);
  }
});

// Listen for tab removal to detach debugger
chrome.tabs.onRemoved.addListener((tabId) => {
  detachDebuggerFromTab(tabId);
});

// Store request bodies by requestId to match with responses
const requestBodies = new Map();

// Handle debugger events (GraphQL responses)
chrome.debugger.onEvent.addListener((source, method, params) => {
  // Capture request body to get operationName and variables (userId)
  if (method === 'Network.requestWillBeSent') {
    const request = params.request;
    const requestId = params.requestId;
    
    if (request.url && request.url.includes('/graphql') && request.postData) {
      try {
        const requestJson = JSON.parse(request.postData);
        // Store request body by requestId for later matching
        requestBodies.set(requestId, requestJson);
      } catch (_) {
        // Not JSON - ignore
      }
    }
  }
  
  // Capture response body
  if (method === 'Network.responseReceived') {
    const response = params.response;
    const requestId = params.requestId;
    
    // Check if it's a GraphQL request
    if (response.url && response.url.includes('/graphql')) {
      // Get the stored request body (if available)
      const requestJson = requestBodies.get(requestId);
      
      // Small delay to ensure response body is available
      setTimeout(() => {
        // Get response body
        chrome.debugger.sendCommand(
          { tabId: source.tabId },
          'Network.getResponseBody',
          { requestId },
          (responseBody) => {
            // Clean up stored request
            requestBodies.delete(requestId);
            
            if (chrome.runtime.lastError) {
              // Response might not be available yet or already consumed
              return;
            }

            try {
              // Handle base64 encoded responses (shouldn't happen for JSON, but just in case)
              let bodyText = responseBody.body;
              if (responseBody.base64Encoded) {
                // Decode base64 (for binary responses, but GraphQL should be text)
                bodyText = atob(bodyText);
              }
              
              const json = JSON.parse(bodyText);
              
              // Check if this is MutualInboxConversationHistory
              // Check both request operationName and response structure
              const isMutualInbox = requestJson?.operationName === 'MutualInboxConversationHistory' ||
                                   bodyText.toLowerCase().includes('mutualinboxconversationhistory');
              
              if (isMutualInbox) {
                const historyPayload = json?.data?.mutualInboxConversationHistory ?? json?.data?.MutualInboxConversationHistory;
                if (historyPayload?.matchesHistory) {
                  console.log(`[Background] 📥 Intercepted MutualInboxConversationHistory GraphQL response for tab ${source.tabId}`);
                  // Send to content script with both request and response data
                  chrome.tabs.sendMessage(source.tabId, {
                    action: 'graphqlResponse',
                    operation: 'MutualInboxConversationHistory',
                    data: json,
                    requestJson: requestJson,
                    url: response.url
                  }).catch((err) => {
                    // Content script might not be ready
                    console.warn(`[Background] Failed to send GraphQL response to content script:`, err);
                  });
                }
              }
            } catch (err) {
              // Not JSON or invalid - ignore
            }
          }
        );
      }, 100); // Small delay to ensure response body is ready
    } else {
      // Not GraphQL - clean up stored request
      requestBodies.delete(requestId);
    }
  }
});

// Handle debugger detach (user might have detached manually)
chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId) {
    attachedTabs.delete(source.tabId);
  }
});

// Handle messages from content script & popup (proxy to backend where needed)
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'getStorage') {
    chrome.storage.local.get(request.keys, (result) => {
      sendResponse(result);
    });
    return true; // Keep channel open for async response
  }
  
  if (request.action === 'setStorage') {
    chrome.storage.local.set(request.data, () => {
      sendResponse({ success: true });
    });
    return true;
  }

  // Proxy AI reply generation to avoid page CORS restrictions
  if (request.action === 'generateReply') {
    (async () => {
      try {
        const backendUrl = request.backendUrl;
        const payload = request.payload;

        if (!backendUrl || typeof backendUrl !== 'string') {
          throw new Error('Missing backendUrl');
        }
        if (!payload || typeof payload !== 'object') {
          throw new Error('Missing payload');
        }

        const res = await fetch(`${backendUrl.replace(/\/$/, '')}/generate-reply`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });

        if (!res.ok) {
          const text = await res.text().catch(() => '');
          throw new Error(`API error: ${res.status} ${text}`.trim());
        }

        const data = await res.json();
        sendResponse({ ok: true, data });
      } catch (err) {
        sendResponse({ ok: false, error: String(err && err.message ? err.message : err) });
      }
    })();

    return true; // async response
  }

  // Proxy: get settings from backend (MongoDB)
  if (request.action === 'getSettings') {
    (async () => {
      try {
        const backendUrl = request.backendUrl;
        if (!backendUrl || typeof backendUrl !== 'string') {
          throw new Error('Missing backendUrl for getSettings');
        }

        const res = await fetch(`${backendUrl.replace(/\/$/, '')}/settings`, {
          method: 'GET',
          headers: { 'Content-Type': 'application/json' }
        });

        if (!res.ok) {
          const text = await res.text().catch(() => '');
          throw new Error(`Settings API error: ${res.status} ${text}`.trim());
        }

        const data = await res.json();
        sendResponse({ ok: true, data });
      } catch (err) {
        sendResponse({ ok: false, error: String(err && err.message ? err.message : err) });
      }
    })();

    return true; // async response
  }

  // Start a break that closes the current Match tab and reopens it after the break
  if (request.action === 'startBreakAndCloseTab') {
    (async () => {
      try {
        const tabId = sender.tab && sender.tab.id;
        const resumeUrl = request.resumeUrl;
        const breakEndTime = request.breakEndTime;
        const startedAt = request.startedAt || Date.now();

        if (!tabId || !resumeUrl || !breakEndTime) {
          throw new Error('Missing tabId, resumeUrl, or breakEndTime for startBreakAndCloseTab');
        }

        // Persist resume info so we can reopen later
        await chrome.storage.local.set({
          breakResume: {
            resumeUrl,
            breakEndTime,
            startedAt
          }
        });

        // Clear any previous resume alarm, then schedule a new one
        await chrome.alarms.clear('matchAiResumeAfterBreak');
        chrome.alarms.create('matchAiResumeAfterBreak', {
          when: breakEndTime
        });

        // Close the current Match tab
        try {
          await chrome.tabs.remove(tabId);
          console.log(`[Background] ☕ Closed Match tab ${tabId} for break; will reopen around ${new Date(breakEndTime).toLocaleTimeString()}`);
        } catch (e) {
          console.warn('[Background] Failed to close tab for break:', e);
        }

        sendResponse({ ok: true });
      } catch (err) {
        console.error('[Background] Error in startBreakAndCloseTab:', err);
        sendResponse({ ok: false, error: String(err && err.message ? err.message : err) });
      }
    })();

    return true; // async response
  }

  // Proxy: save settings to backend (MongoDB)
  if (request.action === 'saveSettings') {
    (async () => {
      try {
        const backendUrl = request.backendUrl;
        const settings = request.settings;
        if (!backendUrl || typeof backendUrl !== 'string') {
          throw new Error('Missing backendUrl for saveSettings');
        }
        if (!settings || typeof settings !== 'object') {
          throw new Error('Missing settings payload');
        }

        const res = await fetch(`${backendUrl.replace(/\/$/, '')}/settings`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(settings)
        });

        if (!res.ok) {
          const text = await res.text().catch(() => '');
          throw new Error(`Save settings API error: ${res.status} ${text}`.trim());
        }

        const data = await res.json();
        sendResponse({ ok: true, data });
      } catch (err) {
        sendResponse({ ok: false, error: String(err && err.message ? err.message : err) });
      }
    })();

    return true; // async response
  }
});

// Handle alarms:
// - cleanupStorage: periodic cleanup of old data
// - matchAiResumeAfterBreak: reopen Match tab after break
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'cleanupStorage') {
    // Clean up conversation data older than 30 days
    chrome.storage.local.get(null, (items) => {
      const now = Date.now();
      const thirtyDaysAgo = now - (30 * 24 * 60 * 60 * 1000);
      
      const keysToDelete = [];
      for (const key in items) {
        if (key.startsWith('turnCount_') || key.startsWith('ctaSent_')) {
          // In a real implementation, you'd store timestamps
          // For now, we'll keep all data
        }
      }
      
      if (keysToDelete.length > 0) {
        chrome.storage.local.remove(keysToDelete);
      }
    });
    return;
  }

  if (alarm.name === 'matchAiResumeAfterBreak') {
    chrome.storage.local.get('breakResume', (items) => {
      const info = items.breakResume;
      if (!info || !info.resumeUrl) {
        chrome.alarms.clear('matchAiResumeAfterBreak');
        return;
      }
      const { resumeUrl } = info;
      chrome.tabs.create({ url: resumeUrl, active: true }, () => {
        console.log('[Background] ☕ Break finished – reopened Match tab to resume auto mode.');
      });
      chrome.storage.local.remove('breakResume');
      chrome.alarms.clear('matchAiResumeAfterBreak');
    });
  }
});

// Set up periodic cleanup (runs once per day)
chrome.alarms.create('cleanupStorage', { periodInMinutes: 24 * 60 });
