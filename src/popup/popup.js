(() => {
  "use strict";

  const defaults = {
    cameraEnabled: false,
    audioMuted: false,
    functionKeysBlocked: false,
    newTabsBlocked: false
  };

  const recorderUrl = chrome.runtime.getURL("src/recorder/recorder.html#library");
  const selector = document.querySelector("#recordingSelector");
  const locationSelector = document.querySelector("#locationSelector");
  const locationForm = document.querySelector("#locationForm");
  const locationNameInput = document.querySelector("#locationName");
  const latitudeInput = document.querySelector("#latitude");
  const longitudeInput = document.querySelector("#longitude");
  const NEW_LOCATION_VALUE = "__new__";
  const MANAGE_RECORDINGS_VALUE = "__manage__";
  const status = document.querySelector("#popupStatus");
  let currentSettings = { ...defaults, activeRecordingId: "" };

  function openRecorder() {
    chrome.tabs.create({ url: recorderUrl }).then(() => window.close()).catch(error => {
      status.textContent = `Could not open recordings: ${error.message}`;
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
    onboardingComplete: false
  }, (settings) => {
    if (chrome.runtime.lastError) {
      status.textContent = "Could not load settings. Reopen the popup to try again.";
      return;
    }
    currentSettings = settings;
    document.querySelector("#onboarding").hidden = settings.onboardingComplete === true;
    for (const key of Object.keys(defaults)) {
      const toggle = document.querySelector(`#${key}`);
      toggle.checked = settings[key] === true;
      toggle.addEventListener("change", () => {
        if (["cameraEnabled", "audioMuted"].includes(key) && toggle.checked && !selector.value) {
          toggle.checked = false;
          currentSettings[key] = false;
          chrome.storage.local.set({ [key]: false });
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
    loadRecordingChoices(settings.activeRecordingId).catch(error => {
      status.textContent = `Could not load recordings: ${error.message}`;
    });
    loadLocationChoices(settings.savedLocations, settings.activeLocationId);
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
  document.querySelector("#dismissOnboarding").addEventListener("click", async () => {
    try {
      await chrome.storage.local.set({ onboardingComplete: true });
      document.querySelector("#onboarding").hidden = true;
    } catch (error) { status.textContent = error.message; }
  });
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
    if (changes.recordingRevision) {
      loadRecordingChoices(currentSettings.activeRecordingId).catch(error => {
        status.textContent = `Could not load recordings: ${error.message}`;
      });
    }
  });
})();
