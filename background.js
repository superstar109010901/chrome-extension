/**
 * Match.com AI Reply Assistant - Background Service Worker
 * 
 * Handles:
 * - Storage management (if needed)
 * - API communication (optional, can be done from content script)
 * - Extension lifecycle events
 */

// Listen for extension installation
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    console.log('Match.com AI Reply Assistant installed');
  } else if (details.reason === 'update') {
    console.log('Match.com AI Reply Assistant updated');
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

// Optional: Clean up old storage data periodically
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
  }
});

// Set up periodic cleanup (runs once per day)
chrome.alarms.create('cleanupStorage', { periodInMinutes: 24 * 60 });
