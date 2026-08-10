// sw-download.js
//
// This Service Worker has exactly one job: make the browser's native
// download machinery (downloads bar/shelf, progress, no save dialog on
// most platforms) available for files arriving over WebRTC, in browsers
// that don't support the File System Access API (Firefox, Safari).
//
// How it works (classic "StreamSaver.js" technique, no library needed):
//   1. The page opens a MessageChannel and sends this worker one end of
//      it, tagged with a random token, along with the filename/size.
//   2. This worker creates a ReadableStream for that token and stashes
//      its controller, keyed by the token.
//   3. The page "clicks" a same-origin link to /sw-download/<token>.
//      That triggers a normal navigation fetch, which this worker's
//      "fetch" handler intercepts and answers with a Response wrapping
//      that ReadableStream, plus a Content-Disposition: attachment
//      header -- so the browser treats it exactly like downloading a
//      real file from a server, streaming straight to disk.
//   4. As WebRTC data-channel chunks arrive, the page posts them over
//      the MessagePort; this worker enqueues them into the stream.
//      When the transfer finishes (or is cancelled), the page tells
//      this worker to close (or error) the stream.
//
// Nothing here ever sees the network -- it's a purely local bridge
// between two same-page APIs (WebRTC + fetch) that otherwise can't talk
// to each other. No data leaves the device.

const pending = new Map(); // token -> { controller, filename, size, mimeType }

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || data.type !== "register-download") return;

  const { token, filename, size, mimeType } = data;
  const port = event.ports[0];
  if (!port || !token) return;

  let controller = null;
  const stream = new ReadableStream({
    start(c) { controller = c; },
    cancel() {
      // The browser's download UI was cancelled on its end -- let the
      // page know so it can stop feeding chunks and clean up.
      try { port.postMessage({ type: "cancelled" }); } catch (e) {}
      pending.delete(token);
    }
  });

  pending.set(token, {
    stream,
    filename: filename || "download",
    size: typeof size === "number" ? size : null,
    mimeType: mimeType || "application/octet-stream"
  });

  port.onmessage = (e) => {
    const msg = e.data;
    if (!msg) return;
    if (msg.type === "chunk") {
      try {
        controller.enqueue(new Uint8Array(msg.data));
      } catch (err) {
        // Controller already closed/errored (e.g. the fetch was never
        // claimed, or was already finished) -- nothing more to do.
      }
    } else if (msg.type === "close") {
      try { controller.close(); } catch (e) {}
    } else if (msg.type === "abort") {
      try { controller.error(new Error("Transfer aborted")); } catch (e) {}
      pending.delete(token);
    }
  };

  // Let the page know we're set up and it's safe to trigger the
  // download navigation now.
  port.postMessage({ type: "ready" });
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  const match = url.pathname.match(/\/sw-download\/([^/]+)\/?$/);
  if (!match) return; // not one of ours -- let the browser handle it normally

  const token = match[1];
  const entry = pending.get(token);
  if (!entry) return; // unknown/expired token -- fall through to a normal 404

  pending.delete(token); // one-shot: each token is good for exactly one fetch

  const headers = {
    "Content-Type": entry.mimeType,
    "Content-Disposition": `attachment; filename="${encodeURIComponent(entry.filename)}"`,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  };
  if (entry.size) headers["Content-Length"] = String(entry.size);

  event.respondWith(new Response(entry.stream, { headers }));
});
