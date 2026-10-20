(() => {
  "use strict";

  const REQUEST_EVENT = "__gravelbox_location_request__";
  const RESPONSE_EVENT = "__gravelbox_location_response__";

  window.addEventListener(REQUEST_EVENT, (event) => {
    const requestId = event.detail?.requestId;
    if (!requestId) return;

    chrome.storage.local.get({
      savedLocations: [],
      activeLocationId: ""
    }, (settings) => {
      const location = settings.savedLocations.find(
        (item) => item.id === settings.activeLocationId
      );
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
    });
  });
})();
