# Architecture

Reader TTS is a Firefox Manifest V3 WebExtension that synthesizes speech directly with Microsoft Edge TTS.

```text
user toolbar action
  -> extension reader tab
  -> background `scripting.executeScript` on the active source tab
  -> vendored Mozilla Readability on a cloned document
  -> ordered text/image/figure blocks returned atomically
  -> semantic local DOM rendering with preserved text, image and caption boundaries
  -> first semantic chunk (maximum 320 Unicode characters)
  -> continuation chunks (maximum 1,800 characters)
  -> cancellable, one-chunk-ahead background WebSocket synthesis with `speech.platform.bing.com`
  -> valid MP3 Blob URLs -> continuous Firefox `<audio>` queue
  -> elapsed chunk time -> weighted word marker across article and caption text
```

The toolbar and `Ctrl+Alt+R` open Reader TTS without autoplay. The `Ctrl+Shift+U` command and page context-menu command use the same extraction boundary with autoplay enabled. When invoked from Firefox's native Reader View, the command follows the existing least-privilege original-URL handoff.

The explicit Archive.ph reader button requests only `https://archive.ph/*`, builds `/newest/{encoded original URL}`, and follows the redirect in an inactive tab. A specific missing-snapshot result triggers `/submit/?url={encoded original URL}`. `/wip/` pages remain hidden capture progress; a completed non-snapshot control page is treated as an interactive challenge, foregrounded, and monitored for up to five minutes. A validated final snapshot resumes extraction and restores focus to Reader TTS. Tabs close through `finally` boundaries except an interactive timeout, which deliberately remains open so user progress is preserved.

## Boundaries

- `activeTab` grants extraction only after a toolbar click; the add-on has no permanent all-sites permission.
- The injected extractor sees the source document but never sees the TTS token or performs network requests.
- The reader receives only title, author/site, source URL, language, excerpt, normalized text blocks, and allow-listed image metadata. Article HTML never crosses the boundary.
- The extractor parses Readability's cleaned content into a strict block-type allowlist. The reader recreates local semantic containers, token spans, figures, captions and images; original elements, arbitrary attributes, scripts, styles, and links never cross the boundary. Image URLs are revalidated as HTTP(S), dimensions are bounded, and every image request requires an explicit hostname-labelled click that discloses redirect behavior. Legacy sessions without block metadata fall back to blank-line/newline paragraph splitting.
- The background validates chunk length, voice, and speed, escapes text for SSML, and collects Edge WebSocket audio frames into a non-empty MP3 buffer. A `webRequest` listener rewrites only the fixed Edge synthesis WebSocket handshake with the headers Edge requires; it cannot observe or modify requests to other hosts. Every request has a 30-second timeout and a request ID used by Stop/replacement/unload cancellation.
- The short first chunk minimizes time to first speech. As soon as it arrives, playback begins and the next semantic chunk is synthesized concurrently. MP3 byte streams are not naively concatenated; complete blobs are queued at audio boundaries.
- The reader renders each non-whitespace token as a safe text span. During playback, elapsed audio time is mapped to weighted tokens in the active chunk; punctuation contributes a small pause weight. This is an estimate because the OpenAI-compatible MP3 response does not include word timestamps. The active marker is accessible, follows the viewport, honors reduced-motion preferences, persists on pause, and clears on Stop/completion.
- Reader-scoped Magic Trackpad input uses Firefox `wheel` events: dominant horizontal deltas accumulate to one ±10-second seek per gesture; `Ctrl`-modified vertical deltas from pinch gestures adjust the reader font scale. Ordinary vertical scrolling is never cancelled. Gesture state resets after 180 ms of inactivity, and seeking is disabled unless an audio chunk is active.
- Settings live in unencrypted Firefox extension storage. The clear control deletes them. No endpoint or API key is stored.
- Firefox host permissions cover only `speech.platform.bing.com` for speech. Arbitrary remote TTS services are intentionally outside this build's trust boundary.
- Archive.ph access is an optional permission requested only by its reader button. The article URL leaves the browser only after that explicit action; archive snapshot content never bypasses the structured rendering boundary.

## API contract

The background opens the Edge Read Aloud WebSocket, sends `speech.config` for 24 kHz mono MP3 and an escaped SSML request for one text chunk, and concatenates received `Path:audio` frames. A completed request must produce a non-empty MP3 buffer.

## Failure model

Special pages or non-articles display an extraction error without altering the source tab. Invalid settings block playback. Server status/detail is reported without rendering HTML. Stop and replacement invalidate the playback generation, abort current synthesis, pause audio, resolve queue waits, and revoke object URLs. Audio decode errors terminate only playback while leaving the article visible.
