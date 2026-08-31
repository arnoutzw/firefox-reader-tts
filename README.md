# Reader TTS for Firefox

Reader TTS is a Firefox Manifest V3 extension that extracts the main article with Mozilla Readability, displays a quiet reader view with paragraphs and inline figures, and reads it aloud directly through Microsoft Edge TTS. The exact default voice is **Ava Multilingual** (`en-US-AvaMultilingualNeural`). No local server, Docker container, API key, or separate TTS installation is required.

## Architecture

```text
toolbar click -> reader extension tab -> background extraction
  -> Mozilla Readability in the source tab -> structured reader
  -> short first chunk (≤320 chars) + continuation chunks (≤1800 chars)
  -> one-chunk-ahead background TTS queue -> continuous MP3 playback
  -> chunk-aware word marker follows the current playback position
  -> Edge TTS WebSocket -> queued MP3 playback
```

Only a user-triggered active tab is inspected. Article text stays out of the page/content-script context. Readability's cleaned content is converted into ordered, sanitized blocks so paragraphs, headings, quotations, list items, preformatted sections, images, galleries, and captions retain their position without inserting article HTML. Captions participate in speech and playback highlighting. TTS requests run in the extension background, connect only to `speech.platform.bing.com`, time out after 30 seconds, and can be cancelled by Stop, replacement playback, or closing the reader.

Article figures appear inline with validated dimensions, alt text, and captions. Images whose URL has the article's exact origin load automatically and eagerly. Third-party images remain deferred behind a hostname-labelled button that discloses redirects may contact another host. Failed automatic or manual loads expose Retry without losing keyboard focus. Requests use asynchronous decoding and no referrer; responsive candidates are selected near the 720px reader width, while obvious hidden/tiny beacons and non-HTTP(S) URLs are discarded.

When Readability omits a lead figure that sits outside its cleaned article body, Reader TTS can recover the image from matching Open Graph metadata and the original article figure. Cloudflare image-transform URLs are matched to their underlying asset, including `srcset` URLs whose transformation options contain commas. Recovery is deduplicated against figures already retained by Readability.

## Install and run

1. For normal Firefox Release or Beta, download and open a Mozilla-signed Reader TTS XPI, then choose **Add** and approve the requested permissions. For development, open `about:debugging`, choose **This Firefox**, click **Load Temporary Add-on**, and select `manifest.json` from this directory.
2. Open an article and click the **Article View** button in Firefox's navigation toolbar (or press **Ctrl+Alt+R**). Choose **Read aloud**. Press **Ctrl+Shift+U** to open Reader TTS for the current article and begin speaking immediately. You can also right-click a page or selected text and choose **Read aloud with Reader TTS**; the reader opens and starts automatically.

When Firefox's built-in **Reader View / Lezerweergave** is open, Reader TTS also shows a page-specific button in the address bar. Firefox blocks extensions from injecting controls into the privileged Reader View document, so this button securely reopens the original article in a hidden tab, extracts it, closes that tab, and opens Reader TTS. The first use on a new site asks for that site's host permission.

The Reader TTS toolbar includes an explicit **Archive.ph** button. It sends the current article URL to archive.ph's `newest` redirect and extracts the resulting snapshot in an inactive tab. If no snapshot exists, it submits the URL to `/submit/?url=…` and monitors archive.ph's work-in-progress redirect. Normal captures remain hidden. If archive.ph stops on a challenge or rate-limit page, that tab is brought forward so the user can respond; Reader TTS waits up to five minutes and resumes extraction automatically after the final snapshot appears. Completed and failed tabs close automatically, while a timed-out interactive tab stays open for manual continuation. The first use asks for permission to access `https://archive.ph/*`; Reader TTS never contacts it automatically.

During playback, the current word is highlighted and the reader gently follows it when it moves outside the visible area. Because the speech endpoint returns MP3 audio without word timestamps, the word position is estimated from elapsed time and the relative spoken length of each token inside the active chunk. Pause keeps the marker in place; Stop and completion clear it.

Magic Trackpad 2 gestures are supported inside Reader TTS: a two-finger horizontal swipe skips backward or forward by 10 seconds in the active audio chunk, pinch resizes the article text from 80% to 160%, and two-finger vertical scrolling remains normal page scrolling. Text size is saved for future reader tabs. Firefox exposes trackpad swipes and pinches as wheel events rather than touch points, so the gesture controller is intentionally scoped to the extension reader document.

Reader appearance follows the same model as Safari Reader: the floating side panel combines White, Sepia, Gray, and Black backgrounds; Serif, Sans, Georgia, and Palatino fonts; text-size controls; and the complete Read aloud, Pause/Resume, Stop, and playback-status controls. There is no separate bottom playback toolbar. Appearance changes apply immediately and are restored in future reader tabs. The panel fades after a few seconds of inactivity and returns on pointer movement, hover, or keyboard focus.

Settings are stored in Firefox extension storage, which is not encrypted. **Clear settings** removes the saved voice, speed, and reader appearance. Speech always uses the fixed Microsoft Edge TTS WebSocket endpoint; it cannot be redirected to an arbitrary host.

## Development and verification

Run `npm test` (or `node --test`) for unit tests. The minimum supported Firefox version is 140, matching Firefox support for the current AMO data-collection manifest declaration. Browser-internal pages, built-in Reader View, `view-source:`, and PDF viewer pages do not allow extension injection and will show an extraction error.

Mozilla Readability is vendored under Apache-2.0; see `vendor/readability.LICENSE`.

See `SIGNING.md` for permanent-installation and Mozilla signing guidance.

## Privacy declaration

The add-on processes website content because that is the article being read, and sends the selected article text to Microsoft Edge TTS at `speech.platform.bing.com` when the user chooses Read aloud. Exact-origin article images load automatically; third-party image hosts are contacted only after the user presses their load button. Either request may follow an HTTP redirect to another host. Image requests use `no-referrer`, though each destination still receives the user's network request. Only when the user presses **Archive.ph**, the source article URL is disclosed to archive.ph and the returned snapshot is processed. It has no analytics or developer-operated backend.
