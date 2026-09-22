"use strict";

importScripts(
  "gradescope/lib/browser-polyfill.js",
  "gradescope/utils/browserDetector.js",
  "gradescope/auth/eventCache.js",
  "gradescope/auth/tokenManager.js",
  "gradescope/auth/authenticationManager.js",
  "gradescope/auth/calendarAPIClient.js",
  "gradescope/auth/autoSyncManager.js"
);

const GRADESCOPE_CONFIG = {
  CALENDAR_API_BASE: "https://www.googleapis.com/calendar/v3",
  CHROME_EXTENSION_CLIENTS: {
    bbepekfgnpdfclkpfoojmfclnbkkbbco:
      "589515007396-0frm2bh6mhobpqiuec8p2dlb2gs10gla.apps.googleusercontent.com"
  },
  WEB_CLIENT_ID:
    "589515007396-nofmk5v0dhegv5fmp1700v8ve94624ih.apps.googleusercontent.com",
  WEB_CLIENT_SECRET: "REDACTED",
  SCOPE: "https://www.googleapis.com/auth/calendar",
  AUTO_SYNC_INTERVAL: 1440,
  ALARM_NAME: "gradescope_auto_sync"
};

const gradescopeTokenManager = new TokenManager(GRADESCOPE_CONFIG);
const gradescopeAuthManager = new AuthenticationManager(
  GRADESCOPE_CONFIG,
  gradescopeTokenManager
);
const gradescopeCalendarClient = new CalendarAPIClient(
  GRADESCOPE_CONFIG,
  gradescopeTokenManager,
  gradescopeAuthManager
);
const gradescopeAutoSyncManager = new AutoSyncManager(GRADESCOPE_CONFIG);

function assertRegisteredOAuthIdentity() {
  const extensionId = chrome.runtime.id;
  if (!GRADESCOPE_CONFIG.CHROME_EXTENSION_CLIENTS[extensionId]) {
    throw new Error(
      `OAuth is not registered for extension ID ${extensionId}. Remove this unpacked extension from chrome://extensions, then load this folder again.`
    );
  }
}

const gradescopeInitialization = (async () => {
  await gradescopeTokenManager.initializeFromStorage();
  const auth = await gradescopeAuthManager.getAuthStatus();
  if (auth.authenticated) {
    await browser.storage.local.set({ settings_auto_sync: true });
    await gradescopeAutoSyncManager.restoreAutoSync();
  }
})().catch((error) => {
  console.error("Gradescope Calendar initialization failed:", error);
});

function gradescopeResultStatus(results) {
  return {
    state: results.errors ? "error" : "success",
    message: `${results.created} added · ${results.skipped} already synced · ${results.errors} failed`,
    timestamp: new Date().toISOString()
  };
}

async function storeGradescopeResponse(response) {
  const status = response?.success === false
    ? {
        state: "error",
        message: response.error || response.reason || "Gradescope sync failed.",
        timestamp: new Date().toISOString()
      }
    : response?.results
      ? gradescopeResultStatus(response.results)
      : {
          state: "success",
          message: "Sync completed.",
          timestamp: new Date().toISOString()
        };
  await browser.storage.local.set({ gradescope_last_status: status });
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== GRADESCOPE_CONFIG.ALARM_NAME) return;

  await gradescopeInitialization;
  const response = await gradescopeCalendarClient.performBackgroundSync();
  await storeGradescopeResponse(response);
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const actions = new Set([
    "gradescopeAuthenticate",
    "gradescopeGetAuthStatus",
    "gradescopeSyncToCalendar",
    "gradescopePerformBackgroundSync"
  ]);
  if (!actions.has(message?.action)) return false;

  (async () => {
    await gradescopeInitialization;

    switch (message.action) {
      case "gradescopeAuthenticate": {
        assertRegisteredOAuthIdentity();
        const auth = await gradescopeAuthManager.getAuthStatus();
        if (!auth.authenticated || !auth.tokenValid) {
          await gradescopeAuthManager.authenticate();
        }
        await gradescopeAutoSyncManager.setupAutoSync();
        return { success: true };
      }
      case "gradescopeGetAuthStatus": {
        const status = await gradescopeAuthManager.getAuthStatus();
        return { success: true, ...status };
      }
      case "gradescopeSyncToCalendar": {
        const results = await gradescopeCalendarClient.syncAssignments(
          message.assignments || []
        );
        await browser.storage.local.set({
          last_auto_sync: new Date().toISOString(),
          last_sync_results: results,
          gradescope_last_status: gradescopeResultStatus(results)
        });
        return { success: true, results };
      }
      case "gradescopePerformBackgroundSync":
        return gradescopeCalendarClient.performBackgroundSync();
      default:
        return { success: false, error: "Unknown Gradescope action." };
    }
  })()
    .then(sendResponse)
    .catch(async (error) => {
      console.error("Gradescope Calendar request failed:", error);
      await browser.storage.local.set({
        gradescope_last_status: {
          state: "error",
          message: error.message,
          timestamp: new Date().toISOString()
        }
      });
      sendResponse({ success: false, error: error.message });
    });
  return true;
});
