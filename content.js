(() => {
  "use strict";

  const FUNCTION_KEY_PATTERN = /^F(?:[1-9]|1[0-9]|2[0-4])$/;
  const SETTINGS_EVENT = "__gravelbox_settings__";
  const MEDIA_EVENT = "__gravelbox_media__";
  let settings = {
    cameraEnabled: false,
    audioMuted: true,
    useVideoAudio: true,
    recordingRevision: 0,
    activeRecordingId: "",
    functionKeysBlocked: true
  };
  let videoLoadGeneration = 0;
  let mediaReady = false;
  let mediaError = false;
  let settingsLoaded = false;
  let streamActive = false;

  window.addEventListener("__gravelbox_stream_state__", (event) => {
    const detail = event.detail;
    if (detail?.mediaGeneration === videoLoadGeneration) {
      streamActive = detail.active === true;
    }
  });

  function cameraStatus() {
    if (!settingsLoaded) {
      return "loading";
    }
    if (!settings.cameraEnabled || !settings.activeRecordingId || mediaError) {
      return "inactive";
    }
    if (streamActive) {
      return "active";
    }
    return mediaReady ? "inactive" : "loading";
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "gravelbox-status") {
      return false;
    }
    sendResponse({ state: cameraStatus() });
    return false;
  });

  function blockFunctionKey(event) {
    if (settings.functionKeysBlocked && FUNCTION_KEY_PATTERN.test(event.key)) {
      event.stopImmediatePropagation();
    }
  }

  window.addEventListener("keydown", blockFunctionKey, { capture: true });
  window.addEventListener("keyup", blockFunctionKey, { capture: true });

  function publishSettings() {
    window.dispatchEvent(new CustomEvent(SETTINGS_EVENT, {
      detail: {
        cameraEnabled: settings.cameraEnabled,
        audioMuted: settings.audioMuted,
        useVideoAudio: true,
        mediaGeneration: videoLoadGeneration,
        videoLoading: Boolean(
          settings.cameraEnabled && settings.activeRecordingId && !mediaReady
        )
      }
    }));
  }

  function publishMedia(detail) {
    window.dispatchEvent(new CustomEvent(MEDIA_EVENT, { detail }));
  }

  function sendRuntimeMessage(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          reject(chrome.runtime.lastError);
        } else if (!response || response.ok === false) {
          reject(new Error(response?.error || "Could not load the recording."));
        } else {
          resolve(response);
        }
      });
    });
  }

  async function refreshActiveVideo() {
    const generation = ++videoLoadGeneration;
    mediaReady = false;
    mediaError = false;
    streamActive = false;
    publishSettings();
    if (!settings.activeRecordingId) {
      publishMedia({ type: "clear", generation });
      return;
    }
    try {
      const info = await sendRuntimeMessage({
        type: "recording-info",
        recordingId: settings.activeRecordingId
      });
      if (!Number.isSafeInteger(info.size) || info.size <= 0
          || !Number.isSafeInteger(info.chunkSize) || info.chunkSize <= 0) {
        throw new Error("The selected recording is empty or invalid.");
      }
      if (generation !== videoLoadGeneration) {
        return;
      }
      publishMedia({
        type: "start",
        generation,
        size: info.size,
        mimeType: info.mimeType
      });
      for (let offset = 0; offset < info.size; offset += info.chunkSize) {
        const chunk = await sendRuntimeMessage({
          type: "recording-chunk",
          recordingId: settings.activeRecordingId,
          offset
        });
        if (generation !== videoLoadGeneration) {
          return;
        }
        publishMedia({
          type: "chunk",
          generation,
          offset,
          end: chunk.end,
          data: chunk.data
        });
      }
      if (generation !== videoLoadGeneration) {
        return;
      }
      publishMedia({ type: "complete", generation });
      mediaReady = true;
    } catch (error) {
      if (generation === videoLoadGeneration) {
        mediaError = true;
        publishMedia({ type: "error", generation, message: error.message });
      }
    }
  }

  const defaults = {
    cameraEnabled: false,
    audioMuted: true,
    useVideoAudio: true,
    recordingRevision: 0,
    activeRecordingId: "",
    functionKeysBlocked: true
  };

  chrome.storage.local.get(defaults, (savedSettings) => {
    settings = savedSettings;
    settingsLoaded = true;
    settings.useVideoAudio = true;
    if (!settings.activeRecordingId && settings.cameraEnabled) {
      settings.cameraEnabled = false;
      chrome.storage.local.set({ cameraEnabled: false });
    }
    refreshActiveVideo();
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    const featureKeys = [
      "cameraEnabled",
      "audioMuted",
      "functionKeysBlocked"
    ];
    const featureChange = featureKeys.some((key) => changes[key]);
    const recordingChange = Boolean(
      changes.recordingRevision || changes.activeRecordingId
    );
    if (areaName === "local" && (featureChange || recordingChange)) {
      for (const key of featureKeys) {
        if (changes[key]) {
          settings[key] = changes[key].newValue !== false;
        }
      }
      if (changes.recordingRevision) {
        settings.recordingRevision = changes.recordingRevision.newValue || 0;
      }
      if (changes.activeRecordingId) {
        settings.activeRecordingId = changes.activeRecordingId.newValue || "";
      }
      if (recordingChange) {
        refreshActiveVideo();
      } else {
        publishSettings();
      }
    }
  });
})();
