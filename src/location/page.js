(() => {
  "use strict";

  const geolocation = navigator.geolocation;
  if (!geolocation) return;

  const REQUEST_EVENT = "__gravelbox_location_request__";
  const RESPONSE_EVENT = "__gravelbox_location_response__";
  const originalGetCurrentPosition = geolocation.getCurrentPosition.bind(geolocation);
  const originalWatchPosition = geolocation.watchPosition.bind(geolocation);
  const originalClearWatch = geolocation.clearWatch.bind(geolocation);
  const pending = new Map();
  const nativeWatches = new Map();
  let nextRequestId = 0;
  let nextWatchId = 1_000_000;

  function requestLocation(callback) {
    const requestId = `location-${++nextRequestId}`;
    pending.set(requestId, callback);
    window.dispatchEvent(new CustomEvent(REQUEST_EVENT, {
      detail: { requestId }
    }));
  }

  function position(location) {
    return {
      timestamp: Date.now(),
      coords: {
        latitude: location.latitude,
        longitude: location.longitude,
        altitude: null,
        accuracy: 64.0999,
        altitudeAccuracy: null,
        heading: NaN,
        speed: null
      }
    };
  }

  window.addEventListener(RESPONSE_EVENT, (event) => {
    const requestId = event.detail?.requestId;
    const callback = pending.get(requestId);
    if (!callback) return;
    pending.delete(requestId);
    callback(event.detail.location || null);
  });

  geolocation.getCurrentPosition = function(success, error, options) {
    requestLocation((location) => {
      if (location) success(position(location));
      else originalGetCurrentPosition(success, error, options);
    });
  };

  geolocation.watchPosition = function(success, error, options) {
    const watchId = nextWatchId++;
    requestLocation((location) => {
      if (location) {
        success(position(location));
      } else {
        nativeWatches.set(
          watchId,
          originalWatchPosition(success, error, options)
        );
      }
    });
    return watchId;
  };

  geolocation.clearWatch = function(watchId) {
    const nativeWatchId = nativeWatches.get(watchId);
    if (nativeWatchId !== undefined) {
      nativeWatches.delete(watchId);
      originalClearWatch(nativeWatchId);
    }
  };

  if (navigator.permissions?.query) {
    const originalPermissionsQuery = navigator.permissions.query.bind(
      navigator.permissions
    );
    navigator.permissions.query = function(descriptor) {
      if (descriptor?.name !== "geolocation") {
        return originalPermissionsQuery(descriptor);
      }
      return originalPermissionsQuery(descriptor).then((result) =>
        new Promise((resolve) => {
          requestLocation((location) => {
            if (location) {
              Object.defineProperty(result, "state", {
                configurable: true,
                enumerable: true,
                value: "granted"
              });
            }
            resolve(result);
          });
        })
      );
    };
  }
})();
