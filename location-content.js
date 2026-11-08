(() => {
  "use strict";

  const REQUEST_EVENT = "__gravelbox_location_request__";
  const RESPONSE_EVENT = "__gravelbox_location_response__";

  window.addEventListener(REQUEST_EVENT, (event) => {
    const requestId = event.detail?.requestId;
    if (!requestId) return;

    function respond(location) {
      window.dispatchEvent(new CustomEvent(RESPONSE_EVENT, {
        detail: {
          requestId,
          location: location
            ? {
                latitude: location.latitude,
                longitude: location.longitude
              }
            : null
        }
      }));
    }

    try {
      chrome.storage.local.get({
        savedLocations: [],
        activeLocationId: ""
      }, (settings) => {
        if (chrome.runtime?.lastError || !settings) {
          respond(null);
          return;
        }
        const locations = Array.isArray(settings.savedLocations)
          ? settings.savedLocations : [];
        respond(locations.find((item) => item?.id === settings.activeLocationId));
      });
    } catch (_error) {
      // Reloading the extension invalidates content scripts in existing tabs.
      // Reply so the page bridge can fall back to native geolocation.
      respond(null);
    }
  });
})();
