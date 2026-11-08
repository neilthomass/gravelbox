(() => {
  "use strict";
  const config = GravelboxBlocklist;
  const list = document.querySelector("#blockedSitesList");
  const status = document.querySelector("#blockedSitesStatus");
  const input = document.querySelector("#blockedSiteInput");
  let entries = [];
  let busy = false;

  function render() {
    list.replaceChildren();
    const active = config.active(entries);
    document.querySelector("#blockedSitesCount").textContent = active.length;
    if (!active.length) {
      const empty = document.createElement("li");
      empty.textContent = "No sites blocked.";
      list.append(empty);
    }
    for (const entry of active) {
      const row = document.createElement("li");
      const label = document.createElement("span");
      label.textContent = entry.domain;
      label.title = entry.domain;
      if (entry.removeAt) {
        const countdown = document.createElement("small");
        countdown.dataset.deadline = entry.removeAt;
        row.append(countdown);
      }
      const button = document.createElement("button");
      button.type = "button";
      button.className = "remove-site";
      button.textContent = entry.removeAt ? "Cancel" : "Remove";
      button.setAttribute("aria-label", `${entry.removeAt ? "Cancel removal of" : "Remove"} ${entry.domain}`);
      button.addEventListener("click", () => update(items => {
        const item = items.find(item => item.domain === entry.domain);
        if (item) {
          if (item.removeAt) delete item.removeAt;
          else item.removeAt = Date.now() + config.delay;
        }
        return items;
      }));
      row.prepend(label);
      row.append(button);
      list.append(row);
    }
    tick();
  }

  function tick() {
    if (entries.some(entry => entry.removeAt && entry.removeAt <= Date.now())) {
      entries = config.active(entries);
      render();
      return;
    }
    for (const label of list.querySelectorAll("[data-deadline]")) {
      const seconds = Math.max(0, Math.ceil((Number(label.dataset.deadline) - Date.now()) / 1000));
      label.textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
    }
  }

  async function update(transform) {
    if (busy) return;
    busy = true;
    try {
      const settings = await chrome.storage.local.get({ blockedSites: config.defaults });
      const next = transform(config.active(settings.blockedSites));
      await chrome.storage.local.set({ blockedSites: next });
      entries = next;
      status.textContent = "";
      render();
    } catch (error) {
      status.textContent = error.message;
    } finally { busy = false; }
  }

  function add(value) {
    let domain;
    try { domain = config.normalize(value); }
    catch (error) { status.textContent = error.message; return; }
    return update(items => {
      const existing = items.find(item => item.domain === domain);
      if (existing) delete existing.removeAt;
      else items.push({ domain });
      input.value = "";
      return items;
    });
  }

  document.querySelector("#blockedSiteForm").addEventListener("submit", event => {
    event.preventDefault();
    add(input.value);
  });
  // Suggest the active website without overwriting anything the user has typed.
  chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
    if (!input.value && tab?.url && /^https?:\/\//i.test(tab.url)) {
      input.value = config.normalize(tab.url);
    }
  }).catch(() => {});
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.blockedSites) {
      entries = changes.blockedSites.newValue ?? config.defaults;
      render();
    }
  });
  chrome.storage.local.get({ blockedSites: config.defaults }).then(settings => {
    entries = settings.blockedSites;
    render();
  }).catch(error => { status.textContent = error.message; });
  setInterval(tick, 1000);
})();
