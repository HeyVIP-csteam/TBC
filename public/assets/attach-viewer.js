/**
 * attach-viewer.js  (SHARED — form.html via app.js, threads.html forward modal)
 *
 * 2026-11-02 — attachment thumbnails + full-screen viewer for files the
 * agent is ABOUT to submit (local File objects, nothing uploaded yet), so
 * they can check a photo / video / PDF is the right one before sending.
 *
 *   AttachUI.renderInto(dropzoneEl, files, { max, subText, onRemove, onOpenPicker })
 *     Renders square thumbnails (photo, video with ▶, PDF icon) + an
 *     "Add more" box inside the dropzone. Clicking a thumbnail opens the
 *     viewer; × calls onRemove(index); the add box calls onOpenPicker().
 *   AttachUI.open(files, index)  — open the viewer directly. `files` may be
 *     File objects OR already-loaded items { url, name, type, size? }
 *     (TG Reply Threads attachments, fetched from Telegram — 2026-11-02).
 *   AttachUI.release(file)       — free a file's preview URL (on remove).
 *
 * Idempotent: safe to load more than once (SPA navigation re-runs page
 * scripts) — the second load is a no-op.
 */
(function () {
  if (window.AttachUI) return;

  const urlCache = new WeakMap(); // File -> object URL
  function urlFor(file) {
    if (file && typeof file.url === "string" && !(file instanceof Blob)) return file.url; // pre-loaded item
    let u = urlCache.get(file);
    if (!u) { u = URL.createObjectURL(file); urlCache.set(file, u); }
    return u;
  }
  function release(file) {
    if (!file || !(file instanceof Blob)) return;
    const u = urlCache.get(file);
    if (u) { URL.revokeObjectURL(u); urlCache.delete(file); }
  }
  function kindOf(f) {
    const t = (f && f.type) || "", n = (f && f.name) || "";
    if (/^image\//.test(t) || /\.(png|jpe?g|webp|gif|bmp)$/i.test(n)) return "image";
    if (/^video\//.test(t) || /\.(mp4|mov|m4v|webm)$/i.test(n)) return "video";
    if (t === "application/pdf" || /\.pdf$/i.test(n)) return "pdf";
    return "file";
  }
  const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const mb = (b) => (typeof b === "number" && b > 0 ? (b / 1048576).toFixed(1) + "MB" : "");

  function thumbInner(file) {
    const k = kindOf(file);
    if (k === "image") return `<img src="${urlFor(file)}" alt="" />`;
    if (k === "video") return `<video src="${urlFor(file)}#t=0.1" muted preload="metadata" playsinline></video><span class="att-play">▶</span><span class="att-kind">VIDEO</span>`;
    if (k === "pdf") return `<span class="att-doc"><i>📄</i>PDF</span>`;
    return `<span class="att-doc att-doc-file"><i>📎</i>FILE</span>`;
  }

  function renderInto(dz, files, opts) {
    opts = opts || {};
    const max = opts.max || 5;
    dz.classList.add("att-dz");
    dz.classList.toggle("att-has-files", files.length > 0);
    const tiles = files.map((f, i) => `
      <div class="att-tile">
        <button type="button" class="att-thumb" data-att-open="${i}" title="Click to view ${esc(f.name)}">${thumbInner(f)}</button>
        <button type="button" class="att-rm" data-att-rm="${i}" title="Remove" aria-label="Remove ${esc(f.name)}">×</button>
        <span class="att-name" title="${esc(f.name)} · ${mb(f.size)}">${esc(f.name)}</span>
      </div>`).join("");
    const add = files.length >= max ? "" : `
      <div class="att-add${files.length ? " compact" : ""}" data-att-add role="button" tabindex="0">
        <span class="dz-icon">${files.length ? "＋" : "📎"}</span>
        <p class="dz-main">${files.length ? "Add more" : "Click or drag files here"}</p>
        ${files.length ? "" : `<p class="dz-sub">${esc(opts.subText || "")}</p><p class="dz-paste">📋 Ctrl+V / ⌘V to paste screenshot</p>`}
      </div>`;
    dz.innerHTML = tiles + add;
    dz.__attFiles = files;
    dz.__attOpts = opts;
    if (!dz.__attWired) {
      dz.__attWired = true;
      dz.addEventListener("click", (e) => {
        const o = dz.__attOpts || {};
        const rm = e.target.closest("[data-att-rm]");
        if (rm) { e.stopPropagation(); if (o.onRemove) o.onRemove(Number(rm.dataset.attRm)); return; }
        const op = e.target.closest("[data-att-open]");
        if (op) { e.stopPropagation(); open(dz.__attFiles || [], Number(op.dataset.attOpen)); return; }
        if (e.target.closest("[data-att-add]") || e.target === dz) { if (o.onOpenPicker) o.onOpenPicker(); }
      });
      dz.addEventListener("keydown", (e) => {
        if ((e.key === "Enter" || e.key === " ") && (e.target === dz || e.target.closest("[data-att-add]"))) {
          e.preventDefault();
          const o = dz.__attOpts || {};
          if (o.onOpenPicker) o.onOpenPicker();
        }
      });
    }
  }

  // ---- viewer ----------------------------------------------------------
  let lb = null, items = [], cur = 0, zoom = 1, pan = { x: 0, y: 0 }, drag = null;
  function build() {
    lb = document.createElement("div");
    lb.className = "att-lb";
    lb.setAttribute("role", "dialog");
    lb.setAttribute("aria-modal", "true");
    lb.setAttribute("aria-label", "Attachment viewer");
    lb.innerHTML = `
      <div class="att-lb-top"><span class="att-lb-name"></span>
        <button type="button" class="att-lb-btn" data-lb="zoom" title="Zoom">🔍</button>
        <button type="button" class="att-lb-btn" data-lb="close" title="Close (Esc)">✕</button></div>
      <div class="att-lb-stage">
        <button type="button" class="att-lb-nav prev" data-lb="prev" aria-label="Previous">‹</button>
        <button type="button" class="att-lb-nav next" data-lb="next" aria-label="Next">›</button>
      </div>
      <div class="att-lb-hint"></div>
      <div class="att-lb-strip"></div>`;
    document.body.appendChild(lb);
    const stage = lb.querySelector(".att-lb-stage");
    lb.addEventListener("click", (e) => {
      const b = e.target.closest("[data-lb]");
      if (b) {
        const a = b.dataset.lb;
        if (a === "close") close();
        else if (a === "prev" && cur > 0) { cur--; show(); }
        else if (a === "next" && cur < items.length - 1) { cur++; show(); }
        else if (a === "zoom") setZoom(zoom > 1 ? 1 : 2);
        return;
      }
      const go = e.target.closest("[data-lb-go]");
      if (go) { cur = Number(go.dataset.lbGo); show(); return; }
      if (e.target === lb || e.target === stage) close();
    });
    stage.addEventListener("wheel", (e) => {
      if (!stage.querySelector("img")) return;
      e.preventDefault();
      setZoom(zoom * (e.deltaY < 0 ? 1.2 : 1 / 1.2));
    }, { passive: false });
    stage.addEventListener("mousedown", (e) => {
      if (!e.target.closest("img") || zoom <= 1) return;
      drag = { x: e.clientX - pan.x, y: e.clientY - pan.y, moved: false };
      e.preventDefault();
    });
    window.addEventListener("resize", fitMedia);
    window.addEventListener("mousemove", (e) => {
      if (!drag) return;
      pan = { x: e.clientX - drag.x, y: e.clientY - drag.y };
      drag.moved = true;
      applyZoom();
    });
    window.addEventListener("mouseup", () => {
      if (drag && drag.moved) {
        const img = stage.querySelector("img");
        if (img) img.addEventListener("click", (ev) => ev.stopImmediatePropagation(), { capture: true, once: true });
      }
      drag = null;
    });
    document.addEventListener("keydown", (e) => {
      if (!lb.classList.contains("open")) return;
      if (e.key === "Escape") { e.stopPropagation(); close(); }
      else if (e.key === "ArrowLeft" && cur > 0) { cur--; show(); }
      else if (e.key === "ArrowRight" && cur < items.length - 1) { cur++; show(); }
    }, true);
  }
  // 2026-11-02 v2 — size photo / video to its real aspect ratio inside the
  // stage so the (lightly dimmed) area around it stays see-through and a
  // click there closes the viewer.
  function fitMedia() {
    if (!lb) return;
    const stage = lb.querySelector(".att-lb-stage");
    const el = stage.querySelector("img, video");
    if (!el) return;
    // For a sharpened photo, size from the ORIGINAL dimensions so the
    // sharpened copy never changes how big the photo is shown.
    const nw = Number(el.dataset.ow) || el.naturalWidth || el.videoWidth;
    const nh = Number(el.dataset.oh) || el.naturalHeight || el.videoHeight;
    if (!nw || !nh) return;
    const cs = getComputedStyle(stage);
    const aw = stage.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const ah = stage.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    // Photo / video open as big as the window allows.
    const r = Math.min(aw / nw, ah / nh);
    el.dataset.bw = Math.floor(nw * r);
    el.dataset.bh = Math.floor(nh * r);
    el.style.width = el.dataset.bw + "px";
    el.style.height = el.dataset.bh + "px";
    if (el.tagName === "IMG") {
      applyZoom();
      if (!el.dataset.ow) { el.dataset.ow = nw; el.dataset.oh = nh; }
      maybeSharpen(el);
    }
  }

  // 2026-11-02 v4 — a small photo (e.g. a 400px receipt crop) stretched to
  // fill the window looks soft. Instead of letting the browser stretch it,
  // re-draw it once at the display size in high quality steps and apply a
  // light unsharp mask, so text / numbers on screenshots stay crisp. Large
  // photos are untouched. Runs once per opened photo, after it is shown.
  let enhancedUrl = null;
  function maybeSharpen(el) {
    if (el.__sharpTried) return;
    const ow = Number(el.dataset.ow), oh = Number(el.dataset.oh);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const maxZoomPx = Number(el.dataset.bw) * dpr * 2; // room for one 2x zoom
    if (!ow || maxZoomPx < ow * 1.25) return; // big enough already
    el.__sharpTried = true;
    const srcUrl = el.src;
    try {
      let tw = Math.min(Math.round(maxZoomPx), 3200);
      let th = Math.round(oh * tw / ow);
      // step up 2x at a time (smoother than one big jump)
      let c = document.createElement("canvas");
      c.width = ow; c.height = oh;
      c.getContext("2d").drawImage(el, 0, 0);
      while (c.width * 2 < tw) {
        const n = document.createElement("canvas");
        n.width = c.width * 2; n.height = c.height * 2;
        const g = n.getContext("2d");
        g.imageSmoothingEnabled = true; g.imageSmoothingQuality = "high";
        g.drawImage(c, 0, 0, n.width, n.height);
        unsharp(g, n.width, n.height, 0.6); // keep edges crisp at each step
        c = n;
      }
      const f = document.createElement("canvas");
      f.width = tw; f.height = th;
      const fg = f.getContext("2d");
      fg.imageSmoothingEnabled = true; fg.imageSmoothingQuality = "high";
      fg.drawImage(c, 0, 0, tw, th);
      unsharp(fg, tw, th, 1.2);
      f.toBlob((b) => {
        if (!b || !el.isConnected || el.src !== srcUrl) return;
        if (enhancedUrl) URL.revokeObjectURL(enhancedUrl);
        enhancedUrl = URL.createObjectURL(b);
        el.src = enhancedUrl;
      }, "image/png");
    } catch (e) { /* canvas blocked — keep the normal image */ }
  }
  // out = px + amount * (px - blur(px)),  blur = 3x3 [1 2 1; 2 4 2; 1 2 1] / 16
  function unsharp(g, w, h, amount) {
    const img = g.getImageData(0, 0, w, h), d = img.data, s = new Uint8ClampedArray(d);
    const row = w * 4;
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * row + x * 4;
        for (let ch = 0; ch < 3; ch++) {
          const p = i + ch;
          const blur = (s[p - row - 4] + 2 * s[p - row] + s[p - row + 4] +
            2 * s[p - 4] + 4 * s[p] + 2 * s[p + 4] +
            s[p + row - 4] + 2 * s[p + row] + s[p + row + 4]) / 16;
          d[p] = s[p] + amount * (s[p] - blur);
        }
      }
    }
    g.putImageData(img, 0, 0);
  }
  function applyZoom() {
    const img = lb.querySelector(".att-lb-stage img");
    if (!img) return;
    // Zoom by re-laying-out the image at the bigger size (the browser
    // re-samples the original file, so it stays sharp) instead of a CSS
    // scale() of the already-drawn picture, which looked blurry.
    const bw = Number(img.dataset.bw), bh = Number(img.dataset.bh);
    if (bw && bh) { img.style.width = Math.round(bw * zoom) + "px"; img.style.height = Math.round(bh * zoom) + "px"; }
    img.style.transform = `translate(${pan.x}px, ${pan.y}px)`;
    img.classList.toggle("zoomed", zoom > 1);
    lb.classList.toggle("att-lb-dark", zoom > 1);
    lb.querySelector('[data-lb="zoom"]').classList.toggle("on", zoom > 1);
  }
  function setZoom(z) {
    zoom = Math.min(5, Math.max(1, z));
    if (zoom === 1) pan = { x: 0, y: 0 };
    applyZoom();
  }
  function show() {
    const f = items[cur];
    if (!f) { close(); return; }
    zoom = 1; pan = { x: 0, y: 0 };
    lb.classList.remove("att-lb-dark");
    const stage = lb.querySelector(".att-lb-stage");
    stage.querySelectorAll("img, video, iframe, .att-lb-file").forEach((n) => n.remove());
    if (enhancedUrl) { URL.revokeObjectURL(enhancedUrl); enhancedUrl = null; }
    const k = kindOf(f);
    let el;
    if (k === "image") {
      el = document.createElement("img");
      el.src = urlFor(f); el.alt = f.name;
      el.addEventListener("click", () => setZoom(zoom > 1 ? 1 : 2));
      el.addEventListener("load", fitMedia);
    } else if (k === "video") {
      el = document.createElement("video");
      el.addEventListener("loadedmetadata", fitMedia); el.src = urlFor(f); el.controls = true; el.autoplay = true; el.playsInline = true;
    } else if (k === "pdf") {
      el = document.createElement("iframe");
      el.src = urlFor(f); el.title = f.name;
    } else {
      el = document.createElement("div");
      el.className = "att-lb-file";
      el.innerHTML = `<i>📎</i><b>${esc(f.name)}</b><span>No preview for this file type</span><a class="att-lb-dl" href="${urlFor(f)}" download="${esc(f.name)}">⬇ Download</a>`;
    }
    stage.insertBefore(el, stage.firstChild);
    fitMedia();
    lb.querySelector(".att-lb-name").innerHTML = `${esc(f.name)}<small>${cur + 1} / ${items.length}${mb(f.size) ? ` · ${mb(f.size)}` : ""}</small>`;
    lb.querySelector('[data-lb="zoom"]').style.display = k === "image" ? "" : "none";
    lb.querySelector('[data-lb="zoom"]').classList.remove("on");
    lb.querySelector(".att-lb-hint").textContent =
      k === "image" ? "Click or scroll to zoom · drag to move · ← → to switch · Esc to close"
        : k === "video" ? "← → to switch · Esc to close"
          : k === "pdf" ? "PDF preview · ← → to switch · Esc to close" : "← → to switch · Esc to close";
    lb.querySelector('[data-lb="prev"]').disabled = cur === 0;
    lb.querySelector('[data-lb="next"]').disabled = cur === items.length - 1;
    lb.querySelector(".att-lb-strip").innerHTML = items.length > 1 ? items.map((x, i) => {
      const kk = kindOf(x);
      const inner = kk === "image" ? `<img src="${urlFor(x)}" alt="" />` : kk === "video" ? `<video src="${urlFor(x)}#t=0.1" muted preload="metadata"></video>` : `<span>${kk === "pdf" ? "PDF" : "FILE"}</span>`;
      return `<button type="button" class="${i === cur ? "on" : ""}" data-lb-go="${i}" title="${esc(x.name)}">${inner}</button>`;
    }).join("") : "";
  }
  function open(files, index) {
    if (!files || !files.length) return;
    if (!lb) build();
    items = files.slice();
    cur = Math.min(Math.max(0, index || 0), items.length - 1);
    lb.classList.add("open");
    document.documentElement.classList.add("att-lb-lock");
    show();
    lb.querySelector('[data-lb="close"]').focus({ preventScroll: true });
  }
  function close() {
    if (!lb) return;
    const v = lb.querySelector(".att-lb-stage video");
    if (v) v.pause();
    lb.classList.remove("open");
    document.documentElement.classList.remove("att-lb-lock");
  }

  window.AttachUI = { renderInto, open, close, release, kindOf, urlFor };
})();
