# Gravelbox

A Chrome extension that returns the selected private-library recording on a
continuous loop when a website requests camera access. It also prevents
websites from receiving `F1` through `F24` key events while leaving Chrome's
own function-key behavior available.

## Install

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Choose **Load unpacked** and select this folder.
3. Reload tabs that were already open, then request the site's camera again.

The toolbar popup controls the camera, virtual microphone, and function-key
blocking. Select the library clip to loop in its **Loop video** menu. Open
**Record and manage videos** to record, preview, save, select, download, or
delete clips. **Save and use recording** writes directly to the extension's
private browser storage; it does not ask you to open a file.

The virtual devices report `MacBook Air Camera` at 1920×1080 and 30 FPS, and
`MacBook Air Microphone (Built-in)` at mono 48 kHz. The microphone uses the
selected clip's audio when available. Clip titles and IDs stay within the
extension and are not placed in MediaStream metadata or the page-facing URL.

## Recorder and library

The recorder captures at 1920×1080 and 30 FPS, with mono 48 kHz microphone
audio. It saves the actual format produced by Chrome: MP4 when supported, or
WebM otherwise. A clip must be saved and selected before the loop camera can
be enabled. The existing Chrome-profile library is preserved when the
extension is reloaded; `silent.mp4` is not used as a default.

Websites with an already-open camera stream must request a new stream after
selecting a different clip. Protected Chrome pages cannot run extensions.
If a selected recording cannot be loaded or decoded, the camera request
returns an error.

To test locally, serve this folder with `python3 -m http.server 8000`, then
open `http://localhost:8000/test.html` and click **Start camera**.

Only use prerecorded video where doing so is lawful and permitted by the site.

## Gradescope calendar sync

Gradescope scraping is always enabled. Visiting a Gradescope dashboard or
course page extracts assignments with due dates and adds them to the primary
calendar as all-day events after Google Calendar has been authorized. Use the
popup's **Sync** button to authorize Calendar and manually re-scrape the active
Gradescope page. Existing events are deduplicated, and a daily background alarm
retries the most recently extracted assignments.

The registered Gradescope OAuth identity uses a separate Chrome storage
namespace from older keyless Gravelbox builds. On first run, the bundled
Gravelbox clip is restored into that namespace and selected automatically.
If this folder was already loaded before the OAuth key was added, remove that
installed copy from `chrome://extensions` and use **Load unpacked** again once;
the Reload button does not change an existing installation's extension ID.
