(() => {
  "use strict";
  const connect = document.querySelector("#calendarConnect");
  const disconnect = document.querySelector("#calendarDisconnect");
  const status = document.querySelector("#calendarStatus");

  async function request(action) {
    const response = await chrome.runtime.sendMessage({ action });
    if (!response?.success) throw new Error(response?.error || "Could not reach Calendar sync. Try reopening the popup.");
    return response;
  }

  async function refresh() {
    const auth = await request("gradescopeGetAuthStatus");
    const enabled = auth.enabled && auth.tokenValid;
    connect.hidden = enabled;
    disconnect.hidden = !auth.enabled;
    connect.disabled = auth.supported === false;
    status.dataset.state = enabled ? "success" : "";
    status.textContent = enabled
      ? "Connected. Visit a Gradescope dashboard or course page to sync."
      : auth.supported === false
        ? "Calendar sync requires Google Chrome and a registered installation."
        : auth.enabled ? "Reconnect Google Calendar to resume syncing." : "Off. No assignments are collected until you connect.";
  }

  async function run(action) {
    connect.disabled = disconnect.disabled = true;
    status.dataset.state = "loading";
    status.textContent = action === "gradescopeAuthenticate" ? "Connecting…" : "Disconnecting…";
    try {
      await request(action);
      await refresh();
    } catch (error) {
      status.dataset.state = "error";
      status.textContent = error.message;
    } finally {
      connect.disabled = disconnect.disabled = false;
    }
  }

  connect.addEventListener("click", () => run("gradescopeAuthenticate"));
  disconnect.addEventListener("click", () => run("gradescopeDisconnect"));
  refresh().catch(error => {
    status.dataset.state = "error";
    status.textContent = error.message;
  });
})();
