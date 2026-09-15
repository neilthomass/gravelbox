(() => {
  "use strict";

  const DB_NAME = "gravelbox-recordings";
  const DB_VERSION = 1;
  const WIDTH = 1920;
  const HEIGHT = 1080;
  const FRAME_RATE = 30;
  const cameraPreview = document.querySelector("#cameraPreview");
  const recordingPreview = document.querySelector("#recordingPreview");
  const startButton = document.querySelector("#startRecording");
  const stopButton = document.querySelector("#stopRecording");
  const saveButton = document.querySelector("#saveRecording");
  const status = document.querySelector("#status");
  const libraryGrid = document.querySelector("#libraryGrid");
  let mediaRecorder = null;
  let sourceStream = null;
  let audioContext = null;
  let drawFrame = 0;
  let pendingBlob = null;
  let pendingMimeType = "";
  let pendingHasAudio = false;
  let previewUrl = "";
  let libraryUrls = [];

  function setStatus(message, error = false) {
    status.textContent = message;
    status.classList.toggle("error", error);
  }

  function openDatabase() {
    return new Promise((resolve, reject) => {
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

  async function getAllRecordings() {
    const database = await openDatabase();
    return new Promise((resolve, reject) => {
      const request = database
        .transaction("recordings", "readonly")
        .objectStore("recordings")
        .getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function storeRecording(recording) {
    const database = await openDatabase();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction("recordings", "readwrite");
      transaction.objectStore("recordings").put(recording);
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  }

  async function deleteRecording(id) {
    const database = await openDatabase();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction("recordings", "readwrite");
      transaction.objectStore("recordings").delete(id);
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  }

  function getSettings() {
    return new Promise((resolve) => {
      chrome.storage.local.get({ activeRecordingId: "" }, resolve);
    });
  }

  function useRecording(id) {
    return new Promise((resolve, reject) => {
      chrome.storage.local.set({
        activeRecordingId: id,
        cameraEnabled: true,
        useVideoAudio: true,
        recordingRevision: Date.now()
      }, () => {
        if (chrome.runtime.lastError) {
          reject(chrome.runtime.lastError);
        } else {
          resolve();
        }
      });
    });
  }

  function clearPreviews() {
    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
      previewUrl = "";
    }
    recordingPreview.removeAttribute("src");
    recordingPreview.load();
    recordingPreview.hidden = true;
    cameraPreview.hidden = false;
  }

  function releaseCapture() {
    cancelAnimationFrame(drawFrame);
    drawFrame = 0;
    if (sourceStream) {
      sourceStream.getTracks().forEach((track) => track.stop());
      sourceStream = null;
    }
    cameraPreview.pause();
    cameraPreview.srcObject = null;
    if (audioContext) {
      audioContext.close().catch(() => {});
      audioContext = null;
    }
  }

  function recordingMimeType(hasAudio) {
    const candidates = hasAudio
      ? [
          "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
          "video/mp4",
          "video/webm;codecs=vp9,opus",
          "video/webm"
        ]
      : [
          "video/mp4;codecs=avc1.42E01E",
          "video/mp4",
          "video/webm;codecs=vp9",
          "video/webm"
        ];
    return candidates.find((type) => MediaRecorder.isTypeSupported(type)) || "";
  }

  async function startRecording() {
    startButton.disabled = true;
    saveButton.disabled = true;
    pendingBlob = null;
    clearPreviews();
    setStatus("Opening camera and microphone…");
    try {
      sourceStream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: WIDTH },
          height: { ideal: HEIGHT },
          frameRate: { ideal: FRAME_RATE }
        },
        audio: {
          channelCount: { ideal: 1 },
          sampleRate: { ideal: 48000 },
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });
      cameraPreview.srcObject = sourceStream;
      await cameraPreview.play();

      const canvas = document.createElement("canvas");
      canvas.width = WIDTH;
      canvas.height = HEIGHT;
      const context = canvas.getContext("2d", { alpha: false });
      function draw() {
        if (sourceStream && cameraPreview.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
          context.drawImage(cameraPreview, 0, 0, WIDTH, HEIGHT);
        }
        drawFrame = requestAnimationFrame(draw);
      }
      draw();
      const output = canvas.captureStream(FRAME_RATE);
      pendingHasAudio = sourceStream.getAudioTracks().length > 0;
      if (pendingHasAudio) {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        audioContext = new AudioContextClass({ sampleRate: 48000 });
        await audioContext.resume();
        const source = audioContext.createMediaStreamSource(sourceStream);
        const destination = audioContext.createMediaStreamDestination();
        destination.channelCount = 1;
        destination.channelCountMode = "explicit";
        source.connect(destination);
        output.addTrack(destination.stream.getAudioTracks()[0]);
      }
      pendingMimeType = recordingMimeType(pendingHasAudio);
      mediaRecorder = new MediaRecorder(output, pendingMimeType
        ? { mimeType: pendingMimeType, videoBitsPerSecond: 8_000_000 }
        : { videoBitsPerSecond: 8_000_000 });
      const chunks = [];
      mediaRecorder.addEventListener("dataavailable", (event) => {
        if (event.data && event.data.size) {
          chunks.push(event.data);
        }
      });
      mediaRecorder.addEventListener("error", (event) => {
        setStatus(event.error?.message || "Recording failed.", true);
        releaseCapture();
        stopButton.disabled = true;
        startButton.disabled = false;
      });
      mediaRecorder.addEventListener("stop", () => {
        releaseCapture();
        pendingMimeType = mediaRecorder.mimeType || pendingMimeType || "video/webm";
        pendingBlob = new Blob(chunks, { type: pendingMimeType });
        mediaRecorder = null;
        stopButton.disabled = true;
        startButton.disabled = false;
        if (!pendingBlob.size) {
          setStatus("No video data was recorded. Please try again.", true);
          return;
        }
        previewUrl = URL.createObjectURL(pendingBlob);
        recordingPreview.src = previewUrl;
        recordingPreview.hidden = false;
        cameraPreview.hidden = true;
        saveButton.disabled = false;
        setStatus("Recording ready. Save it directly to the library and use it.");
      }, { once: true });
      mediaRecorder.start(1000);
      stopButton.disabled = false;
      setStatus("Recording at 1920×1080 and 30 FPS…");
    } catch (error) {
      releaseCapture();
      startButton.disabled = false;
      stopButton.disabled = true;
      setStatus(`${error.name || "Error"}: ${error.message}`, true);
    }
  }

  function stopRecording() {
    if (mediaRecorder && mediaRecorder.state === "recording") {
      stopButton.disabled = true;
      setStatus("Finishing recording…");
      mediaRecorder.stop();
    }
  }

  async function saveRecording() {
    if (!pendingBlob || !pendingBlob.size) {
      return;
    }
    saveButton.disabled = true;
    setStatus("Saving recording to the local library…");
    try {
      const recording = {
        id: crypto.randomUUID(),
        name: `Recording ${new Date().toLocaleString()}`,
        createdAt: Date.now(),
        width: WIDTH,
        height: HEIGHT,
        frameRate: FRAME_RATE,
        hasAudio: pendingHasAudio,
        mimeType: pendingMimeType,
        blob: pendingBlob
      };
      await storeRecording(recording);
      await useRecording(recording.id);
      pendingBlob = null;
      setStatus("Saved and selected. Sites must request a new camera stream to see it.");
      await renderLibrary();
    } catch (error) {
      saveButton.disabled = false;
      setStatus(`Could not save recording: ${error.message}`, true);
    }
  }

  async function renderLibrary() {
    const [recordings, settings] = await Promise.all([
      getAllRecordings(),
      getSettings()
    ]);
    libraryUrls.forEach((url) => URL.revokeObjectURL(url));
    libraryUrls = [];
    libraryGrid.replaceChildren();
    recordings.sort((a, b) => b.createdAt - a.createdAt);
    if (!recordings.length) {
      const empty = document.createElement("p");
      empty.className = "empty";
      empty.textContent = "No recordings yet. Record one above to start looping it.";
      libraryGrid.append(empty);
      return;
    }
    for (const recording of recordings) {
      const card = document.createElement("article");
      card.className = "recording-card";
      if (recording.id === settings.activeRecordingId) {
        card.classList.add("active");
      }
      const video = document.createElement("video");
      video.controls = true;
      video.preload = "metadata";
      video.playsInline = true;
      const url = URL.createObjectURL(recording.blob);
      libraryUrls.push(url);
      video.src = url;
      const title = document.createElement("h3");
      title.textContent = recording.name || "Recording";
      const detail = document.createElement("p");
      const resolution = `${recording.width || WIDTH}×${recording.height || HEIGHT}`;
      detail.textContent = `${resolution} · ${recording.frameRate || FRAME_RATE} FPS · ${recording.hasAudio ? "audio" : "silent"}`;
      const actions = document.createElement("div");
      actions.className = "card-actions";
      const use = document.createElement("button");
      use.className = "use-button";
      use.type = "button";
      use.textContent = recording.id === settings.activeRecordingId ? "In use" : "Use";
      use.disabled = recording.id === settings.activeRecordingId;
      use.addEventListener("click", async () => {
        try {
          await useRecording(recording.id);
          await renderLibrary();
          setStatus("Recording selected for the loop.");
        } catch (error) {
          setStatus(error.message, true);
        }
      });
      const download = document.createElement("a");
      download.className = "download-link";
      download.href = url;
      download.download = `${recording.name || "Recording"}.${recording.mimeType?.includes("mp4") ? "mp4" : "webm"}`;
      download.textContent = "Download";
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "Delete";
      remove.addEventListener("click", async () => {
        if (!confirm(`Delete "${recording.name || "Recording"}" from the local library?`)) {
          return;
        }
        try {
          await deleteRecording(recording.id);
          if (recording.id === settings.activeRecordingId) {
            await new Promise((resolve) => chrome.storage.local.set({
              activeRecordingId: "",
              cameraEnabled: false,
              recordingRevision: Date.now()
            }, resolve));
          } else {
            await new Promise((resolve) => chrome.storage.local.set({
              recordingRevision: Date.now()
            }, resolve));
          }
          await renderLibrary();
          setStatus("Recording deleted from the local library.");
        } catch (error) {
          setStatus(error.message, true);
        }
      });
      actions.append(use, download, remove);
      card.append(video, title, detail, actions);
      libraryGrid.append(card);
    }
  }

  startButton.addEventListener("click", startRecording);
  stopButton.addEventListener("click", stopRecording);
  saveButton.addEventListener("click", saveRecording);
  window.addEventListener("pagehide", () => {
    if (mediaRecorder && mediaRecorder.state === "recording") {
      mediaRecorder.stop();
    }
    releaseCapture();
    libraryUrls.forEach((url) => URL.revokeObjectURL(url));
    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
    }
  });
  renderLibrary().catch((error) => setStatus(`Could not open library: ${error.message}`, true));
})();
