const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.join(__dirname, "..");

test("location bridge replies with native fallback when extension storage is unavailable", () => {
  for (const failure of ["invalidated", "callback-error", "missing-settings"]) {
    let request;
    const responses = [];
    const chrome = {
      runtime: {},
      storage: { local: {
        get(_defaults, callback) {
          if (failure === "invalidated") throw new Error("Extension context invalidated.");
          if (failure === "callback-error") chrome.runtime.lastError = { message: "Storage unavailable" };
          callback(undefined);
        }
      } }
    };
    vm.runInNewContext(
      fs.readFileSync(path.join(root, "location-content.js"), "utf8"),
      {
        chrome,
        window: {
          addEventListener(_type, listener) { request = listener; },
          dispatchEvent(event) { responses.push(event); }
        },
        CustomEvent: class {
          constructor(type, options) { this.type = type; this.detail = options.detail; }
        }
      }
    );
    assert.doesNotThrow(() => request({ detail: { requestId: failure } }));
    assert.equal(responses.length, 1);
    assert.equal(responses[0].type, "__gravelbox_location_response__");
    assert.equal(responses[0].detail.requestId, failure);
    assert.equal(responses[0].detail.location, null);
  }
});

test("loads the location bridge in both page and isolated worlds", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json")));
  const page = manifest.content_scripts.find((entry) =>
    entry.js.includes("location-page.js")
  );
  const content = manifest.content_scripts.find((entry) =>
    entry.js.includes("location-content.js")
  );

  assert.equal(page.world, "MAIN");
  assert.equal(content.world, "ISOLATED");
  assert.equal(page.run_at, "document_start");
  assert.equal(content.run_at, "document_start");
  assert.equal(page.all_frames, true);
  assert.equal(content.all_frames, true);
});

test("spoofs geolocation and falls back to the native location", async () => {
  const listeners = new Map();
  const addEventListener = (type, listener) => {
    const values = listeners.get(type) || [];
    values.push(listener);
    listeners.set(type, values);
  };
  const dispatchEvent = (event) => {
    for (const listener of listeners.get(event.type) || []) listener(event);
  };
  const window = { addEventListener, dispatchEvent };
  class CustomEvent {
    constructor(type, options = {}) {
      this.type = type;
      this.detail = options.detail;
    }
  }
  let nativeCalls = 0;
  const geolocation = {
    getCurrentPosition(success) {
      nativeCalls += 1;
      success({ coords: { latitude: 1, longitude: 2 } });
    },
    watchPosition() { return 7; },
    clearWatch() {}
  };
  const navigator = {
    geolocation,
    permissions: { query: async () => ({ state: "prompt" }) }
  };

  vm.runInNewContext(
    fs.readFileSync(path.join(root, "location-page.js"), "utf8"),
    { window, navigator, CustomEvent, Map, Date, NaN, Promise, Object }
  );

  let spoof = { latitude: 37.8715, longitude: -122.273 };
  addEventListener("__gravelbox_location_request__", (event) => {
    dispatchEvent(new CustomEvent("__gravelbox_location_response__", {
      detail: { requestId: event.detail.requestId, location: spoof }
    }));
  });

  const fake = await new Promise((resolve, reject) =>
    geolocation.getCurrentPosition(resolve, reject)
  );
  assert.equal(fake.coords.latitude, 37.8715);
  assert.equal(fake.coords.longitude, -122.273);
  assert.equal(nativeCalls, 0);
  assert.equal((await navigator.permissions.query({ name: "geolocation" })).state, "granted");

  spoof = null;
  const native = await new Promise((resolve, reject) =>
    geolocation.getCurrentPosition(resolve, reject)
  );
  assert.equal(native.coords.latitude, 1);
  assert.equal(nativeCalls, 1);
});

test("location storage bridge returns the selected saved coordinates", () => {
  const listeners = new Map();
  const window = {
    addEventListener(type, listener) { listeners.set(type, listener); },
    dispatchEvent(event) { listeners.get(event.type)?.(event); }
  };
  class CustomEvent {
    constructor(type, options = {}) {
      this.type = type;
      this.detail = options.detail;
    }
  }
  const chrome = {
    storage: {
      local: {
        get(_defaults, callback) {
          callback({
            activeLocationId: "berkeley",
            savedLocations: [
              { id: "berkeley", latitude: 37.8715, longitude: -122.273 }
            ]
          });
        }
      }
    }
  };
  let response;
  window.addEventListener("__gravelbox_location_response__", (event) => {
    response = event.detail;
  });

  vm.runInNewContext(
    fs.readFileSync(path.join(root, "location-content.js"), "utf8"),
    { window, chrome, CustomEvent }
  );
  window.dispatchEvent(new CustomEvent("__gravelbox_location_request__", {
    detail: { requestId: "request-1" }
  }));

  assert.equal(response.requestId, "request-1");
  assert.equal(response.location.latitude, 37.8715);
  assert.equal(response.location.longitude, -122.273);
});
