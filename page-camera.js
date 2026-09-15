(() => {
  "use strict";

  const mediaDevices = navigator.mediaDevices;
  if (!mediaDevices || typeof mediaDevices.getUserMedia !== "function") {
    return;
  }

  const originalGetUserMedia = mediaDevices.getUserMedia.bind(mediaDevices);
  const originalEnumerateDevices =
    typeof mediaDevices.enumerateDevices === "function"
      ? mediaDevices.enumerateDevices.bind(mediaDevices)
      : async () => [];
  const CAMERA = Object.freeze({
    label: "MacBook Air Camera",
    deviceId: "macbook-air-camera",
    groupId: "macbook-air-camera",
    width: 1920,
    height: 1080,
    frameRate: 30
  });
  const MICROPHONE = Object.freeze({
    label: "MacBook Air Microphone (Built-in)",
    deviceId: "gravelbox-microphone",
    groupId: "gravelbox-microphone",
    autoGainControl: true,
    channelCount: 1,
    echoCancellation: true,
    latency: 0.01,
    noiseSuppression: true,
    sampleRate: 48000,
    sampleSize: 16
  });
  let settings = {
    // Fail closed until the isolated settings bridge responds.
    cameraEnabled: true,
    audioMuted: true,
    useVideoAudio: true,
    videoUrl: "",
    videoLoading: false,
    mediaGeneration: 0
  };
  let mediaTransfer = null;
  let mediaReadyResolve;
  let mediaReady = new Promise((resolve) => {
    mediaReadyResolve = resolve;
  });
  let mediaError = "";
  let activeVideoTracks = 0;
  let settingsReceived = false;
  let resolveSettings;
  const settingsReady = new Promise((resolve) => {
    resolveSettings = resolve;
  });

  window.addEventListener("__gravelbox_settings__", (event) => {
      if (event.detail && typeof event.detail === "object") {
        const generation = Number(event.detail.mediaGeneration) || 0;
        if (generation !== settings.mediaGeneration) {
          settings.videoUrl = "";
          mediaError = "";
          activeVideoTracks = 0;
          mediaReady = new Promise((resolve) => {
            mediaReadyResolve = resolve;
          });
        }
        settings = {
          cameraEnabled: event.detail.cameraEnabled !== false,
          audioMuted: event.detail.audioMuted !== false,
          useVideoAudio: true,
          videoUrl: typeof event.detail.videoUrl === "string"
            ? event.detail.videoUrl
            : settings.videoUrl,
          videoLoading: event.detail.videoLoading === true,
          mediaGeneration: generation
        };
        if (!settingsReceived) {
          settingsReceived = true;
          resolveSettings();
        }
        if (settings.cameraEnabled && activeVideoTracks > 0) {
          publishStreamState(true);
        }
      }
    });

  function publishStreamState(active) {
    window.dispatchEvent(new CustomEvent("__gravelbox_stream_state__", {
      detail: {
        mediaGeneration: settings.mediaGeneration,
        active
      }
    }));
  }

  function monitorVideoTrack(track) {
    const generation = settings.mediaGeneration;
    let released = false;
    activeVideoTracks += 1;
    publishStreamState(true);
    function release() {
      if (released) {
        return;
      }
      released = true;
      if (generation === settings.mediaGeneration) {
        activeVideoTracks = Math.max(0, activeVideoTracks - 1);
        publishStreamState(activeVideoTracks > 0);
      }
    }
    const originalStop = track.stop.bind(track);
    track.stop = () => {
      release();
      originalStop();
    };
    track.addEventListener?.("ended", release, { once: true });
  }

  function failMediaTransfer(message) {
    mediaTransfer = null;
    mediaError = message;
    if (mediaReadyResolve) {
      mediaReadyResolve();
      mediaReadyResolve = null;
    }
  }

  function decodeBase64(value) {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  }

  window.addEventListener("__gravelbox_media__", (event) => {
    const detail = event.detail;
    if (!detail || detail.generation !== settings.mediaGeneration) {
      return;
    }
    try {
      if (detail.type === "start") {
        mediaTransfer = {
          size: detail.size,
          mimeType: detail.mimeType || "video/mp4",
          offset: 0,
          chunks: []
        };
      } else if (detail.type === "chunk") {
        if (!mediaTransfer || detail.offset !== mediaTransfer.offset) {
          throw new Error("Recording transfer was interrupted.");
        }
        const bytes = decodeBase64(detail.data);
        if (bytes.length !== detail.end - detail.offset) {
          throw new Error("Recording chunk was incomplete.");
        }
        mediaTransfer.chunks.push(bytes);
        mediaTransfer.offset = detail.end;
      } else if (detail.type === "complete") {
        if (!mediaTransfer || mediaTransfer.offset !== mediaTransfer.size) {
          throw new Error("Recording transfer ended early.");
        }
        settings.videoUrl = URL.createObjectURL(new Blob(
          mediaTransfer.chunks,
          { type: mediaTransfer.mimeType }
        ));
        mediaTransfer = null;
        mediaError = "";
        if (mediaReadyResolve) {
          mediaReadyResolve();
          mediaReadyResolve = null;
        }
      } else if (detail.type === "error") {
        failMediaTransfer(detail.message || "Recording unavailable.");
      } else if (detail.type === "clear") {
        failMediaTransfer("No recording selected.");
      }
    } catch (error) {
      failMediaTransfer(error.message);
    }
  });

  async function waitForSettings() {
    if (!settingsReceived) {
      let timeoutId;
      try {
        await Promise.race([
          settingsReady,
          new Promise((_resolve, reject) => {
            timeoutId = setTimeout(
              () => reject(new DOMException(
                "Camera settings unavailable",
                "NotReadableError"
              )),
              15000
            );
          })
        ]);
      } finally {
        clearTimeout(timeoutId);
      }
    }
  }

  async function waitForSelectedVideo() {
    if (settings.videoUrl) {
      return;
    }
    if (settings.videoLoading) {
      await mediaReady;
    }
    if (!settings.videoUrl) {
      throw new DOMException(
        mediaError || "The selected recording could not be loaded.",
        "NotReadableError"
      );
    }
  }

  function waitForVideo(video) {
    return new Promise((resolve, reject) => {
      video.addEventListener("loadeddata", resolve, { once: true });
      video.addEventListener(
        "error",
        () => reject(new Error("Selected recording unavailable")),
        { once: true }
      );
      video.load();
    });
  }

  function exactConstraint(constraints, name) {
    if (!constraints || typeof constraints !== "object") {
      return null;
    }
    const value = constraints[name];
    if (typeof value === "number") {
      return value;
    }
    if (value && typeof value === "object" && typeof value.exact === "number") {
      return value.exact;
    }
    return null;
  }

  function assertSupportedConstraints(constraints) {
    const limits = {
      width: CAMERA.width,
      height: CAMERA.height,
      frameRate: CAMERA.frameRate
    };
    for (const [name, maximum] of Object.entries(limits)) {
      const exact = exactConstraint(constraints, name);
      const minimum = constraints && typeof constraints === "object"
        && constraints[name] && typeof constraints[name] === "object"
        ? constraints[name].min
        : null;
      if ((exact !== null && (exact < 1 || exact > maximum))
          || (typeof minimum === "number" && minimum > maximum)) {
        throw new DOMException(
          `${name} is not supported by ${CAMERA.label}`,
          "OverconstrainedError"
        );
      }
    }
  }

  function setCameraTrackInfo(track, width, height, frameRate) {
    const settings = {
      deviceId: CAMERA.deviceId,
      groupId: CAMERA.groupId,
      width,
      height,
      aspectRatio: width / height,
      frameRate,
      resizeMode: "none"
    };
    const capabilities = {
      width: { min: CAMERA.width, max: CAMERA.width },
      height: { min: CAMERA.height, max: CAMERA.height },
      aspectRatio: {
        min: CAMERA.width / CAMERA.height,
        max: CAMERA.width / CAMERA.height
      },
      frameRate: { min: CAMERA.frameRate, max: CAMERA.frameRate },
      resizeMode: ["none"],
      deviceId: CAMERA.deviceId,
      groupId: CAMERA.groupId
    };

    Object.defineProperty(track, "label", {
      configurable: true,
      enumerable: true,
      value: CAMERA.label
    });
    Object.defineProperty(track, "getSettings", {
      configurable: true,
      value: () => ({ ...settings })
    });
    Object.defineProperty(track, "getCapabilities", {
      configurable: true,
      value: () => ({ ...capabilities })
    });
    Object.defineProperty(track, "getConstraints", {
      configurable: true,
      value: () => ({
        width: CAMERA.width,
        height: CAMERA.height,
        frameRate: CAMERA.frameRate,
        aspectRatio: CAMERA.width / CAMERA.height
      })
    });
    Object.defineProperty(track, "applyConstraints", {
      configurable: true,
      value: async (constraints = {}) => {
        assertSupportedConstraints(constraints);
      }
    });
    return track;
  }

  function makeCanvasTrack(videoConstraints, video = null) {
    assertSupportedConstraints(videoConstraints);
    const width = exactConstraint(videoConstraints, "width") || CAMERA.width;
    const height = exactConstraint(videoConstraints, "height") || CAMERA.height;
    const fps = exactConstraint(videoConstraints, "frameRate") || CAMERA.frameRate;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { alpha: false });
    let stopped = false;
    let animationId = 0;

    function draw() {
      if (stopped) {
        return;
      }
      if (video) {
        context.drawImage(video, 0, 0, width, height);
      } else {
        const pulse = (Math.sin(performance.now() / 700) + 1) / 2;
        context.fillStyle = `rgb(${Math.round(23 + pulse * 18)}, 24, ${Math.round(48 + pulse * 30)})`;
        context.fillRect(0, 0, width, height);
        context.fillStyle = "#f5f7ff";
        context.textAlign = "center";
        context.textBaseline = "middle";
        context.font = `700 ${Math.max(24, Math.round(width / 24))}px system-ui`;
        context.fillText("Camera unavailable", width / 2, height / 2 - 24);
        context.fillStyle = "#b9bfce";
        context.font = `400 ${Math.max(15, Math.round(width / 48))}px system-ui`;
        context.fillText("No recording selected", width / 2, height / 2 + 34);
      }
      animationId = requestAnimationFrame(draw);
    }
    draw();

    const track = canvas.captureStream(fps).getVideoTracks()[0];
    const stopTrack = track.stop.bind(track);
    track.stop = () => {
      if (stopped) {
        return;
      }
      stopped = true;
      cancelAnimationFrame(animationId);
      if (video) {
        video.pause();
        video.removeAttribute("src");
      }
      stopTrack();
    };
    return setCameraTrackInfo(track, width, height, fps);
  }

  async function loadLoopVideo() {
    await waitForSelectedVideo();
    const video = document.createElement("video");
    video.src = settings.videoUrl;
    video.muted = true;
    video.loop = true;
    video.autoplay = true;
    video.playsInline = true;
    try {
      await waitForVideo(video);
      await video.play();
      return video;
    } catch (_error) {
      throw new DOMException(
        "The selected recording could not be decoded.",
        "NotReadableError"
      );
    }
  }

  async function makeVideoTrack(videoConstraints) {
    const video = await loadLoopVideo();
    return { track: makeCanvasTrack(videoConstraints, video), video };
  }

  function setMicrophoneTrackInfo(track) {
    const microphoneSettings = {
      deviceId: MICROPHONE.deviceId,
      groupId: MICROPHONE.groupId,
      autoGainControl: MICROPHONE.autoGainControl,
      channelCount: MICROPHONE.channelCount,
      echoCancellation: MICROPHONE.echoCancellation,
      latency: MICROPHONE.latency,
      noiseSuppression: MICROPHONE.noiseSuppression,
      sampleRate: MICROPHONE.sampleRate,
      sampleSize: MICROPHONE.sampleSize
    };
    Object.defineProperty(track, "label", {
      configurable: true,
      enumerable: true,
      value: MICROPHONE.label
    });
    Object.defineProperty(track, "getSettings", {
      configurable: true,
      value: () => ({ ...microphoneSettings })
    });
    Object.defineProperty(track, "getCapabilities", {
      configurable: true,
      value: () => ({
        autoGainControl: [true],
        channelCount: { min: 1, max: 1 },
        echoCancellation: [true],
        latency: { min: MICROPHONE.latency, max: MICROPHONE.latency },
        noiseSuppression: [true],
        sampleRate: { min: MICROPHONE.sampleRate, max: MICROPHONE.sampleRate },
        sampleSize: { min: MICROPHONE.sampleSize, max: MICROPHONE.sampleSize },
        deviceId: MICROPHONE.deviceId,
        groupId: MICROPHONE.groupId
      })
    });
    Object.defineProperty(track, "getConstraints", {
      configurable: true,
      value: () => ({ ...microphoneSettings })
    });
    return track;
  }

  function makeSilentAudioTrack() {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    const audioContext = new AudioContextClass({
      sampleRate: MICROPHONE.sampleRate,
      latencyHint: MICROPHONE.latency
    });
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    const destination = audioContext.createMediaStreamDestination();
    destination.channelCount = MICROPHONE.channelCount;
    destination.channelCountMode = "explicit";
    gain.gain.value = 0;
    oscillator.connect(gain);
    gain.connect(destination);
    oscillator.start();

    const track = destination.stream.getAudioTracks()[0];
    const stopTrack = track.stop.bind(track);
    track.stop = () => {
      oscillator.stop();
      oscillator.disconnect();
      gain.disconnect();
      audioContext.close().catch(() => {});
      stopTrack();
    };
    return setMicrophoneTrackInfo(track);
  }

  function makeVideoAudioTrack(video) {
    if (video && typeof video.captureStream === "function") {
      const track = video.captureStream().getAudioTracks()[0];
      if (track) {
        return setMicrophoneTrackInfo(track);
      }
    }
    return makeSilentAudioTrack();
  }

  function fakeDevice(kind, deviceId, groupId, label) {
    return {
      deviceId,
      groupId,
      kind,
      label,
      toJSON() {
        return { deviceId, groupId: this.groupId, kind, label };
      }
    };
  }

  async function enumerateGravelboxDevices() {
    await waitForSettings();
    let devices = [];
    try {
      devices = await originalEnumerateDevices();
    } catch (_error) {
      // A hardware permission failure must not hide the virtual inputs.
    }
    if (settings.cameraEnabled) {
      devices = devices.filter((device) => device.kind !== "videoinput");
      devices.push(fakeDevice(
        "videoinput",
        CAMERA.deviceId,
        CAMERA.groupId,
        CAMERA.label
      ));
    }
    if (settings.audioMuted) {
      devices.push(fakeDevice(
        "audioinput",
        MICROPHONE.deviceId,
        MICROPHONE.groupId,
        MICROPHONE.label
      ));
    }
    return devices;
  }

  async function getLoopCamera(constraints = {}) {
    await waitForSettings();

    const replaceVideo = Boolean(constraints.video && settings.cameraEnabled);
    const replaceAudio = Boolean(constraints.audio && settings.audioMuted);
    if ((!replaceVideo && !replaceAudio) || (!constraints.video && !constraints.audio)) {
      return originalGetUserMedia(constraints);
    }

    const stream = new MediaStream();
    let loopVideo = null;
    if (constraints.video) {
      if (replaceVideo) {
        const loopCamera = await makeVideoTrack(constraints.video);
        loopVideo = loopCamera.video;
        stream.addTrack(loopCamera.track);
      } else {
        const camera = await originalGetUserMedia({
          video: constraints.video,
          audio: false
        });
        for (const track of camera.getVideoTracks()) {
          stream.addTrack(track);
        }
      }
    }

    if (constraints.audio) {
      if (replaceAudio) {
        if (settings.useVideoAudio && !loopVideo
            && (settings.videoLoading || settings.videoUrl)) {
          try {
            loopVideo = await loadLoopVideo();
          } catch (_error) {
            // A microphone-only request still works when its clip is absent.
          }
        }
        stream.addTrack(settings.useVideoAudio
          ? makeVideoAudioTrack(loopVideo)
          : makeSilentAudioTrack());
      } else {
        const microphone = await originalGetUserMedia({
          video: false,
          audio: constraints.audio
        });
        for (const track of microphone.getAudioTracks()) {
          stream.addTrack(track);
        }
      }
    }
    if (replaceVideo) {
      monitorVideoTrack(stream.getVideoTracks()[0]);
    }
    return stream;
  }

  Object.defineProperty(mediaDevices, "getUserMedia", {
    configurable: true,
    enumerable: true,
    writable: true,
    value: getLoopCamera
  });
  Object.defineProperty(mediaDevices, "enumerateDevices", {
    configurable: true,
    enumerable: true,
    writable: true,
    value: enumerateGravelboxDevices
  });
})();
