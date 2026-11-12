const assert = require("node:assert/strict");
const vm = require("node:vm");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");

test("loads the override in the page's main world at document start", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json")));
  const pageScript = manifest.content_scripts[0];
  assert.equal(pageScript.world, "MAIN");
  assert.equal(pageScript.run_at, "document_start");
  assert.equal(pageScript.all_frames, true);
  assert.deepEqual(pageScript.js, ["page-camera.js"]);
});

test("manifest registers the recorder, Gradescope sync, and all scripts parse", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json")));
  assert.equal(manifest.web_accessible_resources, undefined);
  assert.equal(manifest.background.service_worker, "service-worker.js");
  assert.equal(manifest.action.default_popup, "popup.html");
  for (const file of [
    "content.js", "page-camera.js", "location-content.js", "location-page.js",
    "popup.js", "calendar-popup.js", "blocklist.js", "blocklist-popup.js", "recorder.js", "service-worker.js",
    "gradescope/background.js", "gradescope/contentScript.js",
    "gradescope/auth/eventCache.js",
    "gradescope/auth/tokenManager.js", "gradescope/auth/authenticationManager.js",
    "gradescope/auth/calendarAPIClient.js", "gradescope/auth/autoSyncManager.js",
    "gradescope/utils/browserDetector.js", "gradescope/utils/dateParser.js",
    "gradescope/utils/assignmentParser.js", "gradescope/utils/pageDetector.js"
  ]) {
    const source = fs.readFileSync(path.join(root, file), "utf8");
    assert.doesNotThrow(() => new Function(source), file);
  }
  const popup = fs.readFileSync(path.join(root, "popup.html"), "utf8");
  const recorder = fs.readFileSync(path.join(root, "recorder.html"), "utf8");
  assert.match(popup, /id="cameraEnabled"/);
  assert.match(popup, /id="locationSelector"/);
  assert.match(popup, /id="locationName"/);
  assert.match(popup, /id="latitude"/);
  assert.match(popup, /id="longitude"/);
  assert.doesNotMatch(popup, /id="gradescopeSync"/);
  assert.match(popup, /value="__manage__"/);
  assert.match(recorder, /id="libraryGrid"/);
  assert.match(recorder, /src="recorder\.js"/);
});

test("still blocks F1 through F24 without cancelling browser defaults", () => {
  const listeners = new Map();
  const window = {
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    dispatchEvent() {}
  };
  class CustomEvent {
    constructor(type, options) {
      this.type = type;
      this.detail = options.detail;
    }
  }
  const chrome = {
    runtime: {
      getURL: (file) => file,
      onMessage: { addListener() {} }
    },
    storage: {
      local: {
        get: (defaults, callback) => callback({ ...defaults, functionKeysBlocked: true })
      },
      onChanged: { addListener() {} }
    }
  };
  const source = fs.readFileSync(path.join(root, "content.js"), "utf8");
  vm.runInNewContext(source, { window, CustomEvent, chrome });

  for (let number = 1; number <= 24; number += 1) {
    const event = {
      key: `F${number}`,
      stopped: false,
      defaultPrevented: false,
      stopImmediatePropagation() { this.stopped = true; },
      preventDefault() { this.defaultPrevented = true; }
    };
    listeners.get("keydown")(event);
    assert.equal(event.stopped, true, event.key);
    assert.equal(event.defaultPrevented, false, event.key);
  }
});

test("exposes a 1080p MacBook Air camera without an associated audio device", async () => {
  const listeners = new Map();
  const nativeDevices = [
    { kind: "audioinput", deviceId: "native-mic", groupId: "native" },
    {
      kind: "videoinput",
      deviceId: "physical-camera",
      groupId: "physical-camera",
      label: "MacBook Air Camera"
    }
  ];
  const mediaDevices = {
    async getUserMedia() { throw new Error("native camera should not open"); },
    async enumerateDevices() { return nativeDevices; }
  };
  const window = {
    addEventListener(type, listener) { listeners.set(type, listener); },
    dispatchEvent() {}
  };
  class CustomEvent {
    constructor(type, options) {
      this.type = type;
      this.detail = options.detail;
    }
  }
  window.AudioContext = class {
    createOscillator() {
      return { connect() {}, disconnect() {}, start() {}, stop() {} };
    }
    createGain() {
      return { gain: { value: 1 }, connect() {}, disconnect() {} };
    }
    createMediaStreamDestination() {
      const track = { kind: "audio", stop() {} };
      return {
        channelCount: 2,
        channelCountMode: "max",
        stream: { getAudioTracks: () => [track] }
      };
    }
    close() { return Promise.resolve(); }
  };
  const document = {
    createElement(type) {
      if (type === "video") {
        const videoListeners = new Map();
        return {
          src: "",
          addEventListener(event, listener) { videoListeners.set(event, listener); },
          load() {
            const event = this.src === "with-audio.mp4" ? "loadeddata" : "error";
            queueMicrotask(() => videoListeners.get(event)());
          },
          play() { return Promise.resolve(); },
          captureStream() {
            const track = { kind: "audio", fromVideo: true, stop() {} };
            return { getAudioTracks: () => [track] };
          },
          pause() {},
          removeAttribute() {}
        };
      }
      const track = { stop() {} };
      return {
        getContext() {
          return { drawImage() {}, fillRect() {}, fillText() {} };
        },
        captureStream() {
          return { getVideoTracks: () => [track] };
        }
      };
    }
  };
  class MediaStream {
    constructor() { this.tracks = []; }
    addTrack(track) { this.tracks.push(track); }
    getVideoTracks() { return this.tracks.filter((track) => track.kind !== "audio"); }
    getAudioTracks() { return this.tracks.filter((track) => track.kind === "audio"); }
  }

  const source = fs.readFileSync(path.join(root, "page-camera.js"), "utf8");
  vm.runInNewContext(source, {
    window,
    document,
    navigator: { mediaDevices },
    MediaStream,
    DOMException,
    CustomEvent,
    performance: { now: () => 0 },
    requestAnimationFrame: () => 1,
    cancelAnimationFrame() {},
    queueMicrotask,
    setTimeout,
    clearTimeout
  });
  listeners.get("__gravelbox_settings__")({
    detail: { cameraEnabled: true, audioMuted: true, videoUrl: "with-audio.mp4" }
  });

  const devices = await mediaDevices.enumerateDevices();
  const camera = devices.find((device) => device.deviceId === "macbook-air-camera");
  assert.equal(camera.label, "MacBook Air Camera");
  assert.equal(camera.groupId, "macbook-air-camera");
  assert.equal(devices.filter((device) => device.kind === "videoinput").length, 1);
  assert.equal(
    devices.some((device) => device.deviceId === "physical-camera"),
    false
  );
  assert.equal(
    devices.some((device) => device.kind === "audioinput"
      && device.groupId === camera.groupId),
    false
  );

  const stream = await mediaDevices.getUserMedia({ video: true, audio: false });
  const track = stream.getVideoTracks()[0];
  assert.equal(track.label, "MacBook Air Camera");
  assert.deepEqual(
    { ...track.getSettings() },
    {
      deviceId: "macbook-air-camera",
      groupId: "macbook-air-camera",
      width: 1920,
      height: 1080,
      aspectRatio: 16 / 9,
      frameRate: 30,
      resizeMode: "none"
    }
  );
  await assert.rejects(
    track.applyConstraints({ width: { exact: 4096 } }),
    { name: "OverconstrainedError" }
  );

  const microphoneDevice = devices.find(
    (device) => device.deviceId === "gravelbox-microphone"
  );
  assert.equal(microphoneDevice.label, "MacBook Air Microphone (Built-in)");
  const audioStream = await mediaDevices.getUserMedia({ video: false, audio: true });
  const microphone = audioStream.getAudioTracks()[0];
  assert.equal(microphone.label, "MacBook Air Microphone (Built-in)");
  assert.deepEqual(
    { ...microphone.getSettings() },
    {
      deviceId: "gravelbox-microphone",
      groupId: "gravelbox-microphone",
      autoGainControl: true,
      channelCount: 1,
      echoCancellation: true,
      latency: 0.01,
      noiseSuppression: true,
      sampleRate: 48000,
      sampleSize: 16
    }
  );

  listeners.get("__gravelbox_settings__")({
    detail: {
      cameraEnabled: true,
      audioMuted: true,
      useVideoAudio: true,
      videoUrl: "with-audio.mp4"
    }
  });
  const videoAudioStream = await mediaDevices.getUserMedia({
    video: false,
    audio: true
  });
  assert.equal(videoAudioStream.getAudioTracks()[0].fromVideo, true);

  listeners.get("__gravelbox_settings__")({
    detail: { cameraEnabled: true, audioMuted: true, videoUrl: "missing.mp4" }
  });
  await assert.rejects(
    mediaDevices.getUserMedia({ video: true, audio: false }),
    { name: "NotReadableError" }
  );
});

test("transfers the selected recording into the page world without exposing its ID", async () => {
  const listeners = new Map();
  const seenSettings = [];
  const window = {
    addEventListener(type, listener) {
      const callbacks = listeners.get(type) || [];
      callbacks.push(listener);
      listeners.set(type, callbacks);
    },
    dispatchEvent(event) {
      if (event.type === "__gravelbox_settings__") {
        seenSettings.push(event.detail);
      }
      for (const listener of listeners.get(event.type) || []) {
        listener(event);
      }
    }
  };
  class CustomEvent {
    constructor(type, options) {
      this.type = type;
      this.detail = options.detail;
    }
  }
  const data = Buffer.alloc(1024 * 1024 + 17, 42);
  let createdBlob = null;
  const pageUrl = {
    createObjectURL(blob) {
      createdBlob = blob;
      return "blob:page-camera-video";
    }
  };
  const mediaDevices = {
    async getUserMedia() { throw new Error("native camera should not open"); },
    async enumerateDevices() { return []; }
  };
  const document = {
    createElement(type) {
      if (type === "video") {
        const videoListeners = new Map();
        return {
          src: "",
          addEventListener(event, listener) { videoListeners.set(event, listener); },
          load() {
            assert.equal(this.src, "blob:page-camera-video");
            queueMicrotask(() => videoListeners.get("loadeddata")());
          },
          play() { return Promise.resolve(); },
          pause() {},
          removeAttribute() {}
        };
      }
      const track = { stop() {} };
      return {
        getContext() { return { drawImage() {} }; },
        captureStream() { return { getVideoTracks: () => [track] }; }
      };
    }
  };
  class MediaStream {
    constructor() { this.tracks = []; }
    addTrack(track) { this.tracks.push(track); }
    getVideoTracks() { return this.tracks; }
  }
  const pageSource = fs.readFileSync(path.join(root, "page-camera.js"), "utf8");
  vm.runInNewContext(pageSource, {
    window,
    document,
    navigator: { mediaDevices },
    MediaStream,
    DOMException,
    CustomEvent,
    Blob,
    URL: pageUrl,
    atob,
    requestAnimationFrame: () => 1,
    cancelAnimationFrame() {},
    setTimeout,
    clearTimeout
  });

  const cameraRequest = mediaDevices.getUserMedia({ video: true, audio: false });
  let statusListener;
  const chrome = {
    runtime: {
      onMessage: { addListener(listener) { statusListener = listener; } },
      sendMessage(message, callback) {
        queueMicrotask(() => {
          if (message.type === "recording-info") {
            callback({
              ok: true,
              size: data.length,
              chunkSize: 1024 * 1024,
              mimeType: "video/mp4"
            });
          } else {
            const end = Math.min(data.length, message.offset + 1024 * 1024);
            callback({
              ok: true,
              end,
              data: data.subarray(message.offset, end).toString("base64")
            });
          }
        });
      }
    },
    storage: {
      local: {
        get(_defaults, callback) {
          callback({
            cameraEnabled: true,
            audioMuted: true,
            activeRecordingId: "internal-recording-id",
            recordingRevision: 1,
            functionKeysBlocked: true
          });
        }
      },
      onChanged: { addListener() {} }
    }
  };
  const contentSource = fs.readFileSync(path.join(root, "content.js"), "utf8");
  vm.runInNewContext(contentSource, { window, CustomEvent, chrome, queueMicrotask });

  let state;
  statusListener({ type: "gravelbox-status" }, {}, (response) => {
    state = response.state;
  });
  assert.equal(state, "loading");

  const stream = await cameraRequest;
  statusListener({ type: "gravelbox-status" }, {}, (response) => {
    state = response.state;
  });
  assert.equal(state, "active");
  assert.equal(stream.getVideoTracks()[0].label, "MacBook Air Camera");
  assert.equal(createdBlob.size, data.length);
  assert.equal(seenSettings[0].videoLoading, true);
  assert.equal(
    seenSettings.some((detail) => JSON.stringify(detail).includes("internal-recording-id")),
    false
  );
});

test("service worker reads existing library recordings without bundled replacements", async () => {
  const fastId = "ab328293-858c-4c69-b561-81ac6f8c9028";
  const originalBlob = new Blob(["much larger original recording"]);
  const recording = { id: fastId, blob: originalBlob, mimeType: "video/mp4" };
  let messageListener;
  let fetchCount = 0;
  const database = {
    objectStoreNames: { contains: () => true },
    transaction() {
      return {
        objectStore() {
          return {
            get(id) {
              const request = {};
              queueMicrotask(() => {
                request.result = id === fastId ? recording : null;
                request.onsuccess();
              });
              return request;
            }
          };
        }
      };
    }
  };
  const indexedDB = {
    open() {
      const request = {};
      queueMicrotask(() => {
        request.result = database;
        request.onsuccess();
      });
      return request;
    }
  };
  const chrome = {
    runtime: {
      getURL(file) { return `chrome-extension://private/${file}`; },
      onMessage: { addListener(listener) { messageListener = listener; } }
    },
    storage: { onChanged: { addListener() {} } }
  };
  const fetch = async () => {
    fetchCount += 1;
    throw new Error("Recordings must come from the user library");
  };
  const source = fs.readFileSync(path.join(root, "service-worker.js"), "utf8");
  vm.runInNewContext(source, { chrome, indexedDB, fetch, Blob, btoa, queueMicrotask });

  function ask(message) {
    return new Promise((resolve) => {
      assert.equal(messageListener(message, {}, resolve), true);
    });
  }
  const info = await ask({ type: "recording-info", recordingId: fastId });
  assert.equal(info.size, originalBlob.size);
  const chunk = await ask({ type: "recording-chunk", recordingId: fastId, offset: 0 });
  assert.equal(Buffer.from(chunk.data, "base64").toString(), "much larger original recording");
  assert.equal(fetchCount, 0);
  const missing = await ask({ type: "recording-info", recordingId: "missing" });
  assert.equal(missing.ok, false);
});
