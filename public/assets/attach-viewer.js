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
 *   AttachUI.open(files, index)  — open the viewer directly.
 *   AttachUI.release(file)       — free a file's preview URL (on remove).
 *
 * Idempotent: safe to load more than once (SPA navigation re-runs page
 * scripts) — the second load is a no-op.
 */
(function () {
  if (window.AttachUI) return;

  const urlCache = new WeakMap(); // File -> object URL
  function urlFor(file) {
    let u = urlCache.get(file);
    if (!u) { u = URL.createObjectURL(file); urlCache.set(file, u); }
    return u;
  }
  function release(file) {
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
  const mb = (b) => (b / 1048576).toFixed(1) + "MB";

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
  function applyZoom() {
    const img = lb.querySelector(".att-lb-stage img");
    if (!img) return;
    img.style.transform = `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`;
    img.classList.toggle("zoomed", zoom > 1);
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
    const stage = lb.querySelector(".att-lb-stage");
    stage.querySelectorAll("img, video, iframe, .att-lb-file").forEach((n) => n.remove());
    const k = kindOf(f);
    let el;
    if (k === "image") {
      el = document.createElement("img");
      el.src = urlFor(f); el.alt = f.name;
      el.addEventListener("click", () => setZoom(zoom > 1 ? 1 : 2));
    } else if (k === "video") {
      el = document.createElement("video");
      el.src = urlFor(f); el.controls = true; el.autoplay = true; el.playsInline = true;
    } else if (k === "pdf") {
      el = document.createElement("iframe");
      el.src = urlFor(f); el.title = f.name;
    } else {
      el = document.createElement("div");
      el.className = "att-lb-file";
      el.innerHTML = `<i>📎</i><b>${esc(f.name)}</b><span>No preview for this file type</span>`;
    }
    stage.insertBefore(el, stage.firstChild);
    lb.querySelector(".att-lb-name").innerHTML = `${esc(f.name)}<small>${cur + 1} / ${items.length} · ${mb(f.size)}</small>`;
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

  window.AttachUI = { renderInto, open, close, release, kindOf };
})();
