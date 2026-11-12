const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const root = path.join(__dirname, '..');

function storageMock(initial = {}) {
  const data = { ...initial };
  return { data, local: {
    async get(keys) {
      if (keys === null) return { ...data };
      if (typeof keys === 'string') return { [keys]: data[keys] };
      if (Array.isArray(keys)) return Object.fromEntries(keys.map(key => [key, data[key]]));
      return { ...keys, ...data };
    },
    async set(values) { Object.assign(data, values); },
    async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key]; }
  } };
}

function loadAuth(initial = {}) {
  const storage = storageMock(initial);
  const requested = [];
  const removed = [];
  const chrome = {
    runtime: { id: 'extension-id', lastError: undefined },
    identity: {
      getAuthToken(options, callback) { requested.push(options.interactive); callback('native-token'); },
      removeCachedAuthToken({ token }, callback) { removed.push(token); callback(); }
    }
  };
  const context = { self: {}, browser: { storage }, chrome };
  vm.createContext(context);
  for (const file of ['tokenManager', 'authenticationManager']) {
    vm.runInContext(fs.readFileSync(path.join(root, `gradescope/auth/${file}.js`), 'utf8'), context);
  }
  const tokens = new context.self.TokenManager();
  const auth = new context.self.AuthenticationManager({ CHROME_EXTENSION_CLIENTS: { 'extension-id': 'public-client-id' } }, tokens);
  return { storage, requested, removed, tokens, auth };
}

test('new installations never prompt for Calendar access until explicitly connected', async () => {
  const { tokens, auth, requested, storage } = loadAuth();
  await tokens.initializeFromStorage();
  assert.equal((await auth.getAuthStatus()).authenticated, false);
  assert.deepEqual(requested, []);
  await auth.authenticate();
  assert.deepEqual(requested, [true]);
  assert.deepEqual(storage.data, { google_auth_method: 'chrome_native' });
  assert.equal(await tokens.getValidToken(() => auth.getChromeToken()), 'native-token');
});

test('upgrades discard legacy secret-based tokens and require native reconnection', async () => {
  const { tokens, auth, requested, storage } = loadAuth({
    google_auth_method: 'pkce', google_refresh_token: 'legacy-refresh',
    google_access_token: 'legacy-access', google_token_expiry: Date.now() + 3600000
  });
  await tokens.initializeFromStorage();
  assert.deepEqual(storage.data, {});
  assert.equal((await auth.getAuthStatus()).authenticated, false);
  assert.deepEqual(requested, []);
  await assert.rejects(tokens.getValidToken(() => auth.getChromeToken()), /Connect Google Calendar/);
});

test('native Calendar connection survives worker restarts without persisting tokens', async () => {
  const { tokens, auth, requested, storage } = loadAuth({
    google_auth_method: 'chrome_native', google_access_token: 'old-token',
    google_token_expiry: Date.now() + 3600000
  });
  await tokens.initializeFromStorage();
  assert.equal((await auth.getAuthStatus()).tokenValid, true);
  assert.deepEqual(requested, [false]);
  assert.deepEqual(storage.data, { google_auth_method: 'chrome_native' });
});

test('disconnect clears the native token cache and stored connection', async () => {
  const { tokens, auth, removed, storage } = loadAuth();
  await auth.authenticate();
  await auth.clearAuth();
  assert.deepEqual(removed, ['native-token']);
  assert.deepEqual(storage.data, {});
  assert.equal(tokens.isAuthenticated(), false);
});

test('fresh content defaults leave function keys, camera, and microphone alone', async () => {
  const listeners = new Map();
  const published = [];
  const nativeStream = { native: true };
  const nativeDevices = [{ kind: 'audioinput', deviceId: 'real-mic' }];
  let nativeCalls = 0;
  const window = {
    addEventListener(name, listener) {
      const items = listeners.get(name) || [];
      items.push(listener); listeners.set(name, items);
    },
    dispatchEvent(event) {
      published.push(event);
      for (const fn of listeners.get(event.type) || []) fn(event);
    }
  };
  class CustomEvent { constructor(type, { detail }) { this.type = type; this.detail = detail; } }
  const mediaDevices = {
    async getUserMedia() { nativeCalls++; return nativeStream; },
    async enumerateDevices() { return nativeDevices; }
  };
  const context = vm.createContext({
    window, navigator: { mediaDevices }, CustomEvent, setTimeout, clearTimeout,
    chrome: {
      runtime: { onMessage: { addListener() {} }, sendMessage() { assert.fail('No clip should load'); } },
      storage: {
        local: { get(defaults, callback) { callback(defaults); } },
        onChanged: { addListener() {} }
      }
    }
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'page-camera.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(root, 'content.js'), 'utf8'), context);
  for (const fn of listeners.get('keydown')) fn({ key: 'F1', stopImmediatePropagation() { assert.fail('F1 should pass through'); } });
  const settings = published.find(e => e.type === '__gravelbox_settings__').detail;
  assert.equal(settings.cameraEnabled, false);
  assert.equal(settings.audioMuted, false);
  assert.equal(await mediaDevices.getUserMedia({ audio: true, video: true }), nativeStream);
  assert.equal(nativeCalls, 1);
  assert.deepEqual(await mediaDevices.enumerateDevices(), nativeDevices);
});

test('a saved clip is not sent to a webpage when both media overrides are off', () => {
  let settingsChanged;
  const events = [];
  let requests = 0;
  class CustomEvent { constructor(type, { detail }) { this.type = type; this.detail = detail; } }
  const context = {
    window: { addEventListener() {}, dispatchEvent(event) { events.push(event); } }, CustomEvent,
    chrome: {
      runtime: { onMessage: { addListener() {} }, sendMessage() { requests++; } },
      storage: {
        local: { get(defaults, callback) { callback({ ...defaults, activeRecordingId: 'saved-clip' }); } },
        onChanged: { addListener(fn) { settingsChanged = fn; } }
      }
    }
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'content.js'), 'utf8'), context);
  assert.equal(requests, 0);
  assert.equal(events.at(-1).detail.type, 'clear');
  settingsChanged({ audioMuted: { newValue: true } }, 'local');
  assert.equal(requests, 1);
  settingsChanged({ audioMuted: { newValue: false } }, 'local');
  assert.equal(events.at(-1).detail.type, 'clear');
});

test('Gradescope does not parse or store assignments without opt-in', async () => {
  const storage = storageMock();
  const context = {
    browser: { storage: { ...storage, onChanged: { addListener() {} } }, runtime: { onMessage: { addListener() {} } } },
    window: { gradescopeCalendarSyncLoaded: true },
    PageDetector: { detectPageType() { assert.fail('Must not inspect assignments before opt-in'); } }
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(root, 'gradescope/contentScript.js'), 'utf8'), context);
  const result = await vm.runInContext('extractAndSync()', context);
  assert.equal(result.skipped, true);
  assert.deepEqual(storage.data, {});
});

test('worker startup neither seeds recordings nor opens a recording database', () => {
  const chrome = {
    runtime: { onMessage: { addListener() {} } },
    storage: { onChanged: { addListener() {} } }
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'service-worker.js'), 'utf8'), {
    chrome, indexedDB: { open() { assert.fail('Fresh install must not seed recordings'); } },
    fetch() { assert.fail('No recording should be fetched'); }
  });
});
