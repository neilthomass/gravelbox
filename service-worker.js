"use strict";

if (typeof importScripts === "function") {
  importScripts("gradescope/background.js");
  importScripts("blocklist.js");
}

const DB_NAME = "gravelbox-recordings";
const DB_VERSION = 1;
const CHUNK_SIZE = 1024 * 1024;
const FAST_RECORDING_ID = "ab328293-858c-4c69-b561-81ac6f8c9028";
const recordingCache = new Map();
let databasePromise;
let fastRecordingBlobPromise;

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
    chrome.storage.local.get({ newTabsBlocked: false, blockedSites: GravelboxBlocklist.defaults }, (settings) => {
      if (chrome.runtime.lastError) return;
      if (settings.newTabsBlocked === true) {
        chrome.tabs.remove(tab.id, () => { void chrome.runtime.lastError; });
      } else {
        closeBlockedTab(tab, settings);
      }
    });
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

function getFastRecordingBlob() {
  if (!fastRecordingBlobPromise) {
    fastRecordingBlobPromise = fetch(chrome.runtime.getURL("media.mp4"))
      .then((response) => {
        if (!response.ok) {
          throw new Error("The optimized recording copy is unavailable.");
        }
        return response.blob();
      })
      .catch((error) => {
        fastRecordingBlobPromise = null;
        throw error;
      });
  }
  return fastRecordingBlobPromise;
}

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

function getLocalStorage(defaults) {
  return new Promise((resolve) => chrome.storage.local.get(defaults, resolve));
}

function setLocalStorage(values) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(values, () => {
      if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
      else resolve();
    });
  });
}

async function restoreBundledRecording() {
  const state = await getLocalStorage({
    bundledRecordingRestored: false,
    activeRecordingId: ""
  });
  if (state.bundledRecordingRestored) return;

  const [database, blob] = await Promise.all([
    openDatabase(),
    getFastRecordingBlob()
  ]);
  const existing = await new Promise((resolve, reject) => {
    const request = database
      .transaction("recordings", "readonly")
      .objectStore("recordings")
      .get(FAST_RECORDING_ID);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });

  if (!existing) {
    await new Promise((resolve, reject) => {
      const transaction = database.transaction("recordings", "readwrite");
      transaction.objectStore("recordings").put({
        id: FAST_RECORDING_ID,
        name: "Recovered Gravelbox recording",
        createdAt: Date.now(),
        width: 1920,
        height: 1080,
        frameRate: 30,
        hasAudio: true,
        mimeType: "video/mp4",
        blob
      });
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  }

  await setLocalStorage({
    bundledRecordingRestored: true,
    activeRecordingId: state.activeRecordingId || FAST_RECORDING_ID,
    recordingRevision: Date.now()
  });
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
    const playable = id === FAST_RECORDING_ID
      ? {
          ...recording,
          blob: await getFastRecordingBlob(),
          mimeType: "video/mp4"
        }
      : recording;
    recordingCache.set(id, playable);
    return playable;
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

if (chrome.storage?.local) {
  restoreBundledRecording().catch((error) => {
    console.error("Could not restore the bundled Gravelbox recording:", error);
  });
}
