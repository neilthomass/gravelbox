"use strict";

if (typeof importScripts === "function") {
  importScripts(chrome.runtime.getURL("src/gradescope/background.js"));
  importScripts(chrome.runtime.getURL("src/blocking/blocklist.js"));
}

const DB_NAME = "gravelbox-recordings";
const DB_VERSION = 1;
const CHUNK_SIZE = 1024 * 1024;
const recordingCache = new Map();
let databasePromise;
let tabCreationQueue = Promise.resolve();

function isExtensionPage(tab) {
  const root = chrome.runtime.getURL("");
  return [tab.pendingUrl, tab.url].some(url => typeof url === "string" && url.startsWith(root));
}

function closeBlockedTab(tab, settings) {
  if (!GravelboxBlocklist.matches(tab.pendingUrl, settings.blockedSites)
      && !GravelboxBlocklist.matches(tab.url, settings.blockedSites)) return;
  chrome.tabs.remove(tab.id, () => { void chrome.runtime.lastError; });
}

function checkBlockedTab(tab) {
  chrome.storage.local.get({ blockedSites: GravelboxBlocklist.defaults }, (settings) => {
    if (chrome.runtime.lastError) return;
    closeBlockedTab(tab, settings);
  });
}

if (chrome.tabs?.onUpdated) {
  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (!changeInfo.url && !changeInfo.status) return;
    checkBlockedTab({ ...tab, id: tabId, url: changeInfo.url || tab?.url });
  });
}

if (chrome.tabs?.onCreated) {
  chrome.tabs.onCreated.addListener((tab) => {
    // Serialize queries and removals so simultaneous tabs cannot each close
    // the last remaining tab during startup or restoration.
    tabCreationQueue = tabCreationQueue.then(() => new Promise((resolve) => {
      if (isExtensionPage(tab)) return resolve();
      chrome.storage.local.get({ newTabsBlocked: false, blockedSites: GravelboxBlocklist.defaults }, (settings) => {
        if (chrome.runtime.lastError) return resolve();
        if (settings.newTabsBlocked !== true) {
          closeBlockedTab(tab, settings);
          return resolve();
        }
        chrome.tabs.query({ windowId: tab.windowId }, (tabs) => {
          if (chrome.runtime.lastError) return resolve();
          const current = tabs.find(item => item.id === tab.id);
          if (!current || isExtensionPage(current)) return resolve();
          if (tabs.length <= 1) {
            closeBlockedTab(current, settings);
            return resolve();
          }
          chrome.tabs.remove(tab.id, () => {
            void chrome.runtime.lastError;
            resolve();
          });
        });
      });
    })).catch(error => console.error("Could not check new tab:", error));
  });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.blockedSites || !chrome.tabs?.query) return;
  chrome.tabs.query({}, (tabs) => {
    if (chrome.runtime.lastError) return;
    // Read the latest saved list, including removal deadlines, for each tab.
    for (const tab of tabs) checkBlockedTab(tab);
  });
});

function openDatabase() {
  if (!databasePromise) {
    databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains("recordings")) {
          const store = database.createObjectStore("recordings", { keyPath: "id" });
          store.createIndex("createdAt", "createdAt");
        }
        if (!database.objectStoreNames.contains("settings")) {
          database.createObjectStore("settings", { keyPath: "key" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  return databasePromise;
}

async function getRecording(id) {
  if (recordingCache.has(id)) {
    return recordingCache.get(id);
  }
  const database = await openDatabase();
  const recording = await new Promise((resolve, reject) => {
    const request = database
      .transaction("recordings", "readonly")
      .objectStore("recordings")
      .get(id);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
  if (recording) {
    recordingCache.set(id, recording);
  }
  return recording;
}

function encodeBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]);
  }
  return btoa(binary);
}

async function handleMessage(message) {
  if (!message || !message.recordingId) {
    throw new Error("Missing recording identifier.");
  }
  const recording = await getRecording(message.recordingId);
  if (!recording) {
    throw new Error("The active recording is no longer in the library.");
  }
  if (message.type === "recording-info") {
    return {
      ok: true,
      size: recording.blob.size,
      mimeType: recording.blob.type || recording.mimeType || "video/mp4",
      chunkSize: CHUNK_SIZE
    };
  }
  if (message.type === "recording-chunk") {
    const start = Math.max(0, Number(message.offset) || 0);
    const end = Math.min(recording.blob.size, start + CHUNK_SIZE);
    const buffer = await recording.blob.slice(start, end).arrayBuffer();
    return { ok: true, offset: start, end, data: encodeBase64(buffer) };
  }
  throw new Error("Unknown recording request.");
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || !["recording-info", "recording-chunk"].includes(message.type)) {
    return false;
  }
  handleMessage(message)
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && changes.recordingRevision) {
    recordingCache.clear();
  }
});
