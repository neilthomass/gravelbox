"use strict";

const DB_NAME = "gravelbox-recordings";
const DB_VERSION = 1;
const CHUNK_SIZE = 1024 * 1024;
const FAST_RECORDING_ID = "ab328293-858c-4c69-b561-81ac6f8c9028";
const recordingCache = new Map();
let databasePromise;
let fastRecordingBlobPromise;

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
