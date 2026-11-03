// Shared page heartbeat for the stress fixtures. Every page reports its own
// rAF rate, visibility, video-playback quality and WebGL renderer to the
// loopback server every 2 s, so a background tab's work is still observable
// without switching to it (Marionette can only read the active tab).
(() => {
  const params = new URLSearchParams(location.search);
  const id = params.get("id") || "page";
  const kind = params.get("kind") || "generic";
  const state = {
    id,
    kind,
    frames: 0,
    fps: 0,
    last: performance.now(),
    maxFrameMs: 0,
    lastFrame: performance.now(),
  };

  // Only pages with real animation (or an explicit hb=1) run a rAF loop.
  // A static page must stay genuinely idle: an unconditional rAF loop made
  // the "idle" baseline redraw 60x/s and invented GPU/CPU load.
  const wantsFrames = params.get("hb") === "1" || ["video", "css", "3d", "js"].includes(kind);
  function raf() {
    const now = performance.now();
    const gap = now - state.lastFrame;
    state.lastFrame = now;
    if (gap > state.maxFrameMs) state.maxFrameMs = gap;
    state.frames += 1;
    requestAnimationFrame(raf);
  }
  if (wantsFrames) requestAnimationFrame(raf);

  function videoStats() {
    const videos = [...document.querySelectorAll("video")];
    return videos.map((v) => {
      let quality = null;
      try {
        quality = v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality() : null;
      } catch {}
      return {
        src: (v.currentSrc || "").split("/").pop(),
        paused: v.paused,
        t: Number.isFinite(v.currentTime) ? Math.round(v.currentTime * 100) / 100 : null,
        readyState: v.readyState,
        networkState: v.networkState,
        width: v.videoWidth,
        height: v.videoHeight,
        decoded: quality ? quality.totalVideoFrames : null,
        dropped: quality ? quality.droppedVideoFrames : null,
      };
    });
  }

  function glInfo() {
    const c = document.querySelector("canvas");
    if (!c) return null;
    try {
      const gl = c.getContext("webgl2") || c.getContext("webgl");
      if (!gl) return null;
      const ext = gl.getExtension("WEBGL_debug_renderer_info");
      return {
        w: c.width,
        h: c.height,
        renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
      };
    } catch (e) {
      return { error: String(e) };
    }
  }

  function report() {
    const now = performance.now();
    const window_s = Math.max(0.001, (now - state.last) / 1000);
    state.fps = Math.round((state.frames / window_s) * 10) / 10;
    state.frames = 0;
    state.last = now;
    const payload = {
      id: state.id,
      kind: state.kind,
      t: Math.round(performance.now()),
      href: location.href,
      visibility: document.visibilityState,
      hidden: document.hidden,
      fps: state.fps,
      maxFrameMs: Math.round(state.maxFrameMs * 10) / 10,
      video: videoStats(),
      gl: glInfo(),
    };
    state.maxFrameMs = 0;
    fetch("/report", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      keepalive: true,
    }).catch(() => {});
  }

  setInterval(report, 2000);
  window.addEventListener("load", report);
  setInterval(() => {
    for (const v of document.querySelectorAll("video")) {
      if (v.paused) v.play().catch(() => {});
    }
  }, 1500);
  window.__stress = state;
})();
