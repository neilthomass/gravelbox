(() => {
  "use strict";

  const defaults = {
    cameraEnabled: false,
    audioMuted: true,
    functionKeysBlocked: true
  };

  const recorderUrl = chrome.runtime.getURL("recorder.html#library");
  const selector = document.querySelector("#recordingSelector");
  const status = document.querySelector("#cameraStatus");
  const statusLabel = document.querySelector("#cameraStatusLabel");
  let currentSettings = { ...defaults, activeRecordingId: "" };
  let statusCheckGeneration = 0;

  function setCameraStatus(state) {
    const safeState = ["active", "inactive", "loading"].includes(state)
      ? state
      : "inactive";
    status.dataset.state = safeState;
    statusLabel.textContent = safeState[0].toUpperCase() + safeState.slice(1);
    status.title = {
      active: "A virtual camera stream is running in this tab.",
      inactive: "No virtual camera stream is running in this tab.",
      loading: "The selected recording is transferring into this tab."
    }[safeState];
  }

  function updateCameraStatus() {
    const generation = ++statusCheckGeneration;
    if (!currentSettings.cameraEnabled || !currentSettings.activeRecordingId) {
      setCameraStatus("inactive");
      return;
    }
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (generation !== statusCheckGeneration) {
        return;
      }
      const tabId = tabs?.[0]?.id;
      if (typeof tabId !== "number") {
        setCameraStatus("inactive");
        return;
      }
      chrome.tabs.sendMessage(tabId, { type: "gravelbox-status" }, { frameId: 0 }, (response) => {
        if (generation !== statusCheckGeneration) {
          return;
        }
        if (chrome.runtime.lastError || !response) {
          setCameraStatus("inactive");
          return;
        }
        setCameraStatus(response.state);
      });
    });
  }

  function openRecorder() {
    chrome.tabs.create({ url: recorderUrl });
    window.close();
  }

  function openDatabase() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open("gravelbox-recordings", 1);
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

  async function loadRecordingChoices(activeRecordingId) {
    const database = await openDatabase();
    const recordings = await new Promise((resolve, reject) => {
      const request = database
        .transaction("recordings", "readonly")
        .objectStore("recordings")
        .getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    recordings.sort((a, b) => b.createdAt - a.createdAt);
    for (const recording of recordings) {
      const option = document.createElement("option");
      option.value = recording.id;
      option.textContent = recording.name;
      option.dataset.hasAudio = String(recording.hasAudio);
      selector.append(option);
    }
    selector.value = activeRecordingId || "";
    if (!recordings.length) {
      selector.options[0].textContent = "No recordings — create one";
    }
  }

  chrome.storage.local.get({ ...defaults, activeRecordingId: "" }, (settings) => {
    currentSettings = settings;
    for (const key of Object.keys(defaults)) {
      const toggle = document.querySelector(`#${key}`);
      toggle.checked = settings[key] !== false;
      toggle.addEventListener("change", () => {
        if (key === "cameraEnabled" && toggle.checked && !selector.value) {
          toggle.checked = false;
          currentSettings.cameraEnabled = false;
          setCameraStatus("inactive");
          chrome.storage.local.set({ cameraEnabled: false });
          openRecorder();
          return;
        }
        currentSettings[key] = toggle.checked;
        if (key === "cameraEnabled") {
          setCameraStatus("inactive");
        }
        chrome.storage.local.set({ [key]: toggle.checked }, updateCameraStatus);
      });
    }
    if (!settings.activeRecordingId) {
      currentSettings.cameraEnabled = false;
      document.querySelector("#cameraEnabled").checked = false;
      if (settings.cameraEnabled) {
        chrome.storage.local.set({ cameraEnabled: false });
      }
    }
    loadRecordingChoices(settings.activeRecordingId).catch(() => {});
    updateCameraStatus();
  });

  selector.addEventListener("change", () => {
    if (!selector.value) {
      currentSettings.activeRecordingId = "";
      currentSettings.cameraEnabled = false;
      setCameraStatus("inactive");
      chrome.storage.local.set({
        activeRecordingId: "",
        cameraEnabled: false,
        recordingRevision: Date.now()
      });
      document.querySelector("#cameraEnabled").checked = false;
      return;
    }
    currentSettings.activeRecordingId = selector.value;
    currentSettings.cameraEnabled = true;
    setCameraStatus("loading");
    chrome.storage.local.set({
      activeRecordingId: selector.value,
      cameraEnabled: true,
      useVideoAudio: true,
      recordingRevision: Date.now()
    }, updateCameraStatus);
    document.querySelector("#cameraEnabled").checked = true;
  });

  document.querySelector("#openRecorder").addEventListener("click", openRecorder);
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") {
      return;
    }
    if (changes.cameraEnabled) {
      currentSettings.cameraEnabled = changes.cameraEnabled.newValue === true;
    }
    if (changes.activeRecordingId) {
      currentSettings.activeRecordingId = changes.activeRecordingId.newValue || "";
    }
    if (changes.cameraEnabled || changes.activeRecordingId || changes.recordingRevision) {
      updateCameraStatus();
    }
  });
  setInterval(updateCameraStatus, 1500);
})();
