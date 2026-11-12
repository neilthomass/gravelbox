Remember, the browser is a sandbox. Please don't eat the tabs.

# Gravelbox

A Chrome extension for blocking distractions, looping recorded camera/audio,
overriding location, and syncing Gradescope assignments to Google Calendar.

## Install

1. Open `chrome://extensions` and enable **Developer mode**.
2. Click **Load unpacked** and select this folder.
3. Open the Gravelbox popup and choose what to enable.

New installs start with everything off, an empty blocklist, and no recordings.
Existing saved settings and recordings survive updates.

## Controls

- **Tab blocking:** Add sites to close matching tabs, including subdomains.
  Removing a site takes five minutes. **Block new tabs** allows one tab per
  window and keeps Gravelbox pages accessible.
- **Video:** Choose **Manage recordings…** to record a clip, then select it to
  loop. The virtual microphone uses its audio. Recordings stay in browser
  storage until you use them on a website or download them.
- **Location:** Save coordinates or select **Use real location**.
- **Function keys:** Stop websites receiving F1–F24. Chrome shortcuts still work.
- **Gradescope calendar:** Connect in the popup to sync due dates from pages you
  visit. Sync also runs daily. Disconnect stops collection and future syncs;
  events already added to Calendar stay there. Requires Google Chrome.

Reload existing webpages after updating the extension. Restart a site's camera
stream after changing clips.

## Development

Run `node --test test/*.test.js`.
For the camera demo, run `python3 -m http.server 8000` and open
`http://localhost:8000/test.html`.
