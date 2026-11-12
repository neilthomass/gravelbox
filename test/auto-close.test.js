const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.join(__dirname, "..");

function loadWorker(settings = {}, tabs = []) {
  tabs = tabs.map((tab) => ({ windowId: 1, ...tab }));
  const storageListeners = [];
  let onUpdated;
  let onCreated;
  const removed = [];
  const chrome = {
    runtime: {
      getURL: (file) => `chrome-extension://gravelbox/${file}`,
      lastError: undefined,
      onMessage: { addListener() {} }
    },
    storage: {
      local: {
        get(defaults, callback) {
          if ("newTabsBlocked" in defaults || "blockedSites" in defaults) callback({ ...defaults, ...settings });
        }
      },
      onChanged: { addListener(listener) { storageListeners.push(listener); } }
    },
    tabs: {
      query(query, callback) {
        callback(tabs.filter((tab) => query.windowId === undefined || tab.windowId === query.windowId));
      },
      onCreated: {
        addListener(listener) { onCreated = listener; }
      },
      onUpdated: {
        addListener(listener) { onUpdated = listener; }
      },
      remove(tabId, callback) {
        removed.push(tabId);
        tabs = tabs.filter((tab) => tab.id !== tabId);
        callback();
      }
    }
  };
  const source = fs.readFileSync(path.join(root, "src/blocking/blocklist.js"), "utf8") + "\n" + fs.readFileSync(path.join(root, "src/background/service-worker.js"), "utf8");
  const context = vm.createContext({
    chrome,
    URL,
    Map,
    Promise,
    console,
    fetch: async () => { throw new Error("not used"); },
    indexedDB: {}
  });
  vm.runInContext(source, context);
  return { onUpdated, idle: () => vm.runInContext("tabCreationQueue", context),
    tabs: () => tabs, onCreated(tab) {
    tab = { windowId: 1, ...tab };
    tabs.push(tab);
    onCreated(tab);
    return vm.runInContext("tabCreationQueue", context);
  }, removed, storageChanged(changes, area = "local") {
    for (const listener of storageListeners) listener(changes, area);
  } };
}

test("new tabs are allowed by default", async () => {
  const { onCreated, removed } = loadWorker();
  await onCreated({ id: 10 });
  assert.deepEqual(removed, []);
});

test("adding a site closes matching existing tabs immediately", async () => {
  const settings = { blockedSites: [] };
  const worker = loadWorker(settings, [
    { id: 1, url: "https://example.com/page" },
    { id: 2, url: "https://sub.example.com/" },
    { id: 3, url: "https://example.com.other.test/" }
  ]);
  settings.blockedSites = [{ domain: "example.com" }];
  worker.storageChanged({ blockedSites: { newValue: settings.blockedSites } });
  assert.deepEqual(worker.removed, [1, 2]);
});

test("dynamic sites are blocked on creation, pending navigation, and reload", async () => {
  const worker = loadWorker({ blockedSites: [{ domain: "example.com" }] });
  await worker.onCreated({ id: 1, url: "https://example.com/" });
  await worker.onCreated({ id: 2, pendingUrl: "https://example.com/" });
  worker.onUpdated(3, { status: "loading" }, { url: "https://example.com/" });
  worker.onUpdated(4, { status: "complete" }, { url: "https://other.test/" });
  assert.deepEqual(worker.removed, [1, 2, 3]);
});

test("dynamic blocklist honors edits, an empty list, and background removal deadlines", async () => {
  const settings = { blockedSites: [{ domain: "example.com", removeAt: Date.now() + 300000 }] };
  const { onUpdated, removed } = loadWorker(settings);
  onUpdated(1, { url: "https://sub.example.com/" });
  onUpdated(2, { url: "https://github.com/" });
  settings.blockedSites[0].removeAt = Date.now() - 1;
  onUpdated(3, { url: "https://example.com/" });
  const restarted = loadWorker(settings);
  restarted.onUpdated(4, { url: "https://example.com/" });
  assert.deepEqual(restarted.removed, []);
  settings.blockedSites = [];
  onUpdated(5, { url: "https://x.com/" });
  settings.blockedSites = [{ domain: "github.com" }];
  onUpdated(6, { url: "https://github.com/" });
  assert.deepEqual(removed, [1, 6]);
});

test("blocklist normalizes website inputs and enforces the exact removal deadline", async () => {
  const context = { URL };
  vm.runInNewContext(fs.readFileSync(path.join(root, "src/blocking/blocklist.js"), "utf8"), context);
  const config = context.GravelboxBlocklist;
  assert.equal(config.normalize(" HTTPS://WWW.Example.com/path?q=1 "), "example.com");
  assert.equal(config.normalize("mail.google.com"), "mail.google.com");
  for (const input of ["chrome://extensions/", "not a site", "https://user:pass@example.com/"]) {
    assert.throws(() => config.normalize(input));
  }
  const entries = [{ domain: "example.com", removeAt: 300000 }];
  assert.equal(config.matches("https://example.com/", entries, 299999), true);
  assert.equal(config.matches("https://example.com/", entries, 300000), false);
  assert.equal(config.matches("https://example.com.evil.test/", entries, 0), false);
});

test("blocks new tabs with persisted setting and allows them after disabling", async () => {
  const settings = { newTabsBlocked: true };
  const { onCreated, onUpdated, removed } = loadWorker(settings, [{ id: 1 }]);
  await onCreated({ id: 10 });
  await onCreated({ id: 11, url: "https://example.com/" });
  onUpdated(12, { url: "https://example.com/" });
  assert.deepEqual(removed, [10, 11]);
  settings.newTabsBlocked = false;
  await onCreated({ id: 13 });
  assert.deepEqual(removed, [10, 11]);
});

test("allows the first tab in each window while blocking additional tabs", async () => {
  const { onCreated, removed } = loadWorker({ newTabsBlocked: true });
  await onCreated({ id: 1, windowId: 1 });
  assert.deepEqual(removed, []);
  await onCreated({ id: 2, windowId: 1 });
  assert.deepEqual(removed, [2]);
  await onCreated({ id: 3, windowId: 2 });
  assert.deepEqual(removed, [2]);
  await onCreated({ id: 4, windowId: 2 });
  assert.deepEqual(removed, [2, 4]);
});

test("blocked sites remain blocked in the first tab of a window", async () => {
  const { onCreated, removed } = loadWorker({
    newTabsBlocked: true,
    blockedSites: [{ domain: "example.com" }]
  });
  await onCreated({ id: 1, url: "https://example.com/" });
  await onCreated({ id: 2, pendingUrl: "https://example.com/" });
  assert.deepEqual(removed, [1, 2]);
});

test("auto-closes configured domains, including subdomains", async () => {
  const { onUpdated, removed } = loadWorker({ blockedSites: ["x.com", "linkedin.com", "youtube.com"].map(domain => ({ domain })) });

  onUpdated(1, { url: "https://x.com/home" });
  onUpdated(2, { url: "https://www.linkedin.com/feed/" });
  onUpdated(3, { url: "https://jobs.linkedin.com/" });
  onUpdated(4, { url: "https://youtube.com/watch?v=example" });
  onUpdated(5, { url: "https://music.youtube.com/" });

  assert.deepEqual(removed, [1, 2, 3, 4, 5]);
});

test("does not close lookalike, non-web, or unrelated URLs", async () => {
  const { onUpdated, removed } = loadWorker();

  onUpdated(1, { url: "https://notx.com/" });
  onUpdated(2, { url: "https://linkedin.com.example.test/" });
  onUpdated(3, { url: "chrome://extensions/" });
  onUpdated(4, { status: "loading" });
  onUpdated(5, { url: "https://example.com/?next=https://x.com" });
  onUpdated(6, { url: "https://youtube.com.example.test/" });

  assert.deepEqual(removed, []);
});

test("fresh installs allow formerly default-blocked sites", async () => {
  const worker = loadWorker();
  for (const [index, domain] of ["gmail.com", "github.com", "youtube.com", "x.com"].entries()) {
    await worker.onCreated({ id: index + 1, url: `https://${domain}/` });
    worker.onUpdated(index + 1, { status: "loading" }, { url: `https://${domain}/` });
  }
  assert.deepEqual(worker.removed, []);
});

test("recording manager remains accessible when new tabs are blocked", async () => {
  const worker = loadWorker({ newTabsBlocked: true }, [{ id: 1 }]);
  await worker.onCreated({ id: 2, pendingUrl: "chrome-extension://gravelbox/src/recorder/recorder.html#library" });
  await worker.onCreated({ id: 3, url: "chrome-extension://gravelbox/src/popup/popup.html" });
  await worker.onCreated({ id: 4, url: "https://example.com/?next=chrome-extension://gravelbox/src/recorder/recorder.html" });
  assert.deepEqual(worker.removed, [4]);
});

test("simultaneous tab creation keeps a tab in every window", async () => {
  const worker = loadWorker({ newTabsBlocked: true });
  worker.onCreated({ id: 1, windowId: 1 });
  worker.onCreated({ id: 2, windowId: 1 });
  worker.onCreated({ id: 3, windowId: 2 });
  worker.onCreated({ id: 4, windowId: 2 });
  await worker.idle();
  assert.equal(worker.tabs().filter(tab => tab.windowId === 1).length, 1);
  assert.equal(worker.tabs().filter(tab => tab.windowId === 2).length, 1);
});

test("worker restart and extension reload preserve saved blocking choices", async () => {
  const settings = { newTabsBlocked: true, blockedSites: [{ domain: "example.com" }] };
  for (let restart = 0; restart < 3; restart++) {
    const worker = loadWorker(settings);
    await worker.onCreated({ id: 1 });
    await worker.onCreated({ id: 2 });
    assert.deepEqual(worker.removed, [2]);
    worker.onUpdated(1, { url: "https://example.com/" });
    assert.deepEqual(worker.removed, [2, 1]);
  }
});
