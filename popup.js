(() => {
  "use strict";

  const defaults = {
    cameraEnabled: false,
    audioMuted: true,
    functionKeysBlocked: true
  };

  const recorderUrl = chrome.runtime.getURL("recorder.html#library");
  const selector = document.querySelector("#recordingSelector");
  const locationSelector = document.querySelector("#locationSelector");
  const locationForm = document.querySelector("#locationForm");
  const locationNameInput = document.querySelector("#locationName");
  const latitudeInput = document.querySelector("#latitude");
  const longitudeInput = document.querySelector("#longitude");
  const NEW_LOCATION_VALUE = "__new__";
  const MANAGE_RECORDINGS_VALUE = "__manage__";
  let currentSettings = { ...defaults, activeRecordingId: "" };

  function openRecorder() {
    chrome.tabs.create({ url: recorderUrl });
    window.close();
  }

  function showGradescopeStatus(status) {
    const element = document.querySelector("#gradescopeSyncStatus");
    if (!status) {
      element.textContent = "";
      delete element.dataset.state;
      return;
    }
    element.dataset.state = status.state || "error";
    element.textContent = status.message || "Gradescope sync failed.";
  }

  function saveGradescopeStatus(state, message) {
    const status = { state, message, timestamp: new Date().toISOString() };
    showGradescopeStatus(status);
    chrome.storage.local.set({ gradescope_last_status: status });
  }

  function sendRuntimeMessage(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (response) => {
        const error = chrome.runtime.lastError;
        if (error) reject(new Error(error.message));
        else resolve(response);
      });
    });
  }

  function sendTabMessage(tabId, message) {
    return new Promise((resolve, reject) => {
      chrome.tabs.sendMessage(tabId, message, (response) => {
        const error = chrome.runtime.lastError;
        if (error) reject(new Error(error.message));
        else resolve(response);
      });
    });
  }

  function injectGradescopeScripts(tabId) {
    const files = [
      "gradescope/lib/browser-polyfill.js",
      "gradescope/utils/browserDetector.js",
      "gradescope/utils/dateParser.js",
      "gradescope/utils/assignmentParser.js",
      "gradescope/utils/pageDetector.js",
      "gradescope/contentScript.js"
    ];
    return new Promise((resolve, reject) => {
      chrome.scripting.executeScript({ target: { tabId }, files }, () => {
        const error = chrome.runtime.lastError;
        if (error) reject(new Error(error.message));
        else resolve();
      });
    });
  }

  async function requestGradescopeSync(tabId) {
    try {
      const response = await sendTabMessage(tabId, {
        action: "gradescopeManualSync"
      });
      if (response) return response;
    } catch (error) {
      if (!/Receiving end does not exist|Could not establish connection|message port closed/i.test(error.message)) {
        throw error;
      }
    }

    await injectGradescopeScripts(tabId);
    return sendTabMessage(tabId, { action: "gradescopeManualSync" });
  }

  function manuallySyncGradescope() {
    const button = document.querySelector("#gradescopeSync");
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      const tab = tabs?.[0];
      if (!tab?.id || !tab.url?.includes("gradescope.com")) {
        saveGradescopeStatus(
          "error",
          "Open a Gradescope dashboard or course page first."
        );
        return;
      }

      button.disabled = true;
      button.textContent = "Syncing…";
      showGradescopeStatus({ state: "loading", message: "Syncing…" });
      try {
        const auth = await sendRuntimeMessage({ action: "gradescopeGetAuthStatus" });
        if (!auth?.success || !auth.authenticated || !auth.tokenValid) {
          const connected = await sendRuntimeMessage({
            action: "gradescopeAuthenticate"
          });
          if (!connected?.success) {
            throw new Error(connected?.error || "Google Calendar authorization failed.");
          }
        }

        const response = await requestGradescopeSync(tab.id);
        if (!response?.success) {
          throw new Error(response?.error || "Gradescope sync failed.");
        }
        const results = response.results || { created: 0, skipped: 0, errors: 0 };
        const state = results.errors ? "error" : "success";
        saveGradescopeStatus(
          state,
          `${results.created} added · ${results.skipped} already synced · ${results.errors} failed`
        );
      } catch (error) {
        saveGradescopeStatus("error", error.message);
      } finally {
        button.disabled = false;
        button.textContent = "Sync";
      }
    });
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
    while (selector.options.length > 2) selector.remove(2);
    selector.options[0].textContent = "Choose a recording…";
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

  function loadLocationChoices(locations, activeLocationId) {
    while (locationSelector.options.length > 2) locationSelector.remove(2);
    for (const location of locations) {
      const option = document.createElement("option");
      option.value = location.id;
      option.textContent = location.name
        || `${location.latitude}, ${location.longitude}`;
      locationSelector.append(option);
    }
    locationSelector.value = activeLocationId || "";
  }

  function saveLocation(event) {
    event.preventDefault();
    const name = locationNameInput.value.trim();
    locationNameInput.setCustomValidity(name ? "" : "Enter a location name.");
    if (!event.currentTarget.reportValidity()) return;

    const latitude = Number(latitudeInput.value);
    const longitude = Number(longitudeInput.value);
    const locations = currentSettings.savedLocations || [];
    let location = locations.find((item) =>
      item.latitude === latitude && item.longitude === longitude
    );
    if (!location) {
      location = {
        id: crypto.randomUUID(),
        name,
        latitude,
        longitude
      };
      locations.push(location);
    } else {
      location.name = name;
    }

    currentSettings.savedLocations = locations;
    currentSettings.activeLocationId = location.id;
    chrome.storage.local.set({
      savedLocations: locations,
      activeLocationId: location.id
    });
    loadLocationChoices(locations, location.id);
    event.currentTarget.reset();
    event.currentTarget.hidden = true;
  }

  chrome.storage.local.get({
    ...defaults,
    activeRecordingId: "",
    savedLocations: [],
    activeLocationId: "",
    gradescope_last_status: null
  }, (settings) => {
    currentSettings = settings;
    for (const key of Object.keys(defaults)) {
      const toggle = document.querySelector(`#${key}`);
      toggle.checked = settings[key] !== false;
      toggle.addEventListener("change", () => {
        if (key === "cameraEnabled" && toggle.checked && !selector.value) {
          toggle.checked = false;
          currentSettings.cameraEnabled = false;
          chrome.storage.local.set({ cameraEnabled: false });
          openRecorder();
          return;
        }
        currentSettings[key] = toggle.checked;
        chrome.storage.local.set({ [key]: toggle.checked });
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
    loadLocationChoices(settings.savedLocations, settings.activeLocationId);
    showGradescopeStatus(settings.gradescope_last_status);
  });

  selector.addEventListener("change", () => {
    if (selector.value === MANAGE_RECORDINGS_VALUE) {
      selector.value = currentSettings.activeRecordingId || "";
      openRecorder();
      return;
    }
    if (!selector.value) {
      currentSettings.activeRecordingId = "";
      currentSettings.cameraEnabled = false;
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
    chrome.storage.local.set({
      activeRecordingId: selector.value,
      cameraEnabled: true,
      useVideoAudio: true,
      recordingRevision: Date.now()
    });
    document.querySelector("#cameraEnabled").checked = true;
  });

  locationSelector.addEventListener("change", () => {
    if (locationSelector.value === NEW_LOCATION_VALUE) {
      locationForm.hidden = false;
      locationNameInput.focus();
      return;
    }
    locationForm.hidden = true;
    locationForm.reset();
    currentSettings.activeLocationId = locationSelector.value;
    chrome.storage.local.set({ activeLocationId: locationSelector.value });
  });

  locationForm.addEventListener("submit", saveLocation);
  document.querySelector("#gradescopeSync").addEventListener("click", manuallySyncGradescope);
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
    if (changes.savedLocations) {
      currentSettings.savedLocations = changes.savedLocations.newValue || [];
    }
    if (changes.activeLocationId) {
      currentSettings.activeLocationId = changes.activeLocationId.newValue || "";
    }
    if (changes.savedLocations || changes.activeLocationId) {
      loadLocationChoices(
        currentSettings.savedLocations || [],
        currentSettings.activeLocationId
      );
    }
    if (changes.gradescope_last_status) {
      showGradescopeStatus(changes.gradescope_last_status.newValue);
    }
    if (changes.recordingRevision) {
      loadRecordingChoices(currentSettings.activeRecordingId).catch(() => {});
    }
  });
})();
