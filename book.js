/* ==========================================================================
   Shikshit Mitra — Book Reader (iframe edition)
   Each row in Google Sheets = one "page" shown in a full-size iframe.
   Navigation: prev/next buttons, swipe, keyboard arrows.
   No PDF.js, no CORS issues — works with any Google Drive link.
   ========================================================================== */

(function () {
  "use strict";

  /* ── Google Sheets CSV source ── */
  var SHEET_URL =
    "https://docs.google.com/spreadsheets/d/e/" +
    "2PACX-1vS5svv38RZ1MJ54P73voMTXWZYuNZZeU6Hy4uWsXS95Z0BcydyeRsQINcY8gzVyKYNCeQoM8u3gs7E_" +
    "/pub?output=csv";

  var params      = new URLSearchParams(window.location.search);
  var BOOK_FILTER = (params.get("book") || "second").toLowerCase().trim();

  var state = {
    title:       params.get("title") || "खरिदार द्वितीय पत्र",
    pages:       [],   // [{title, url}]
    currentPage: 1
  };

  /* ── Element refs ── */
  var els = {
    bookTitle:    document.getElementById("bookTitle"),
    pageCurrent:  document.getElementById("pageCurrent"),
    pageTotal:    document.getElementById("pageTotal"),
    backBtn:      document.getElementById("backBtn"),
    prevBtn:      document.getElementById("prevBtn"),
    nextBtn:      document.getElementById("nextBtn"),
    pdfLoader:    document.getElementById("pdfLoader"),
    pdfError:     document.getElementById("pdfError"),
    pdfErrorText: document.getElementById("pdfErrorText"),
    pdfRetryBtn:  document.getElementById("pdfRetryBtn"),
    fullscreenBtn:document.getElementById("fullscreenBtn"),
    zoomOutBtn:   document.getElementById("zoomOutBtn"),
    zoomInBtn:    document.getElementById("zoomInBtn"),
    bookOuter:    document.getElementById("bookOuter"),
    flipBook:     document.getElementById("flipBook"),
    toast:        document.getElementById("toast")
  };

  /* ── Toast ── */
  var toastTimer = null;
  function showToast(msg) {
    if (!els.toast) return;
    els.toast.textContent = msg;
    els.toast.classList.add("is-visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      els.toast.classList.remove("is-visible");
    }, 1800);
  }

  /* ── Overlay helpers ── */
  function showOverlay(type, msg) {
    els.pdfLoader.classList.toggle("is-hidden", type !== "loader");
    els.pdfError.classList.toggle("is-hidden",  type !== "error");
    if (type === "error" && msg && els.pdfErrorText)
      els.pdfErrorText.textContent = msg;
  }
  function hideOverlay() {
    els.pdfLoader.classList.add("is-hidden");
    els.pdfError.classList.add("is-hidden");
  }

  /* ── Convert any Drive share URL to an embeddable preview URL ── */
  function toEmbedUrl(url) {
    var id = null, m;
    m = url.match(/\/file\/d\/([^\/\?&]+)/);
    if (m) id = m[1];
    if (!id) { m = url.match(/[?&]id=([^&]+)/); if (m) id = m[1]; }
    if (!id) { m = url.match(/\/d\/([^\/\?&]+)/);  if (m) id = m[1]; }
    if (id) return "https://drive.google.com/file/d/" + id + "/preview";
    // Already a preview or non-Drive URL — use as-is
    return url;
  }

  /* ── Minimal CSV parser ── */
  function parseCSV(text) {
    var rows = [];
    var lines = text.split(/\r?\n/);
    lines.forEach(function (line) {
      if (!line.trim()) return;
      var cols = [], cur = "", inQ = false;
      for (var i = 0; i < line.length; i++) {
        var ch = line[i];
        if (inQ) {
          if (ch === '"') { if (line[i+1] === '"') { cur += '"'; i++; } else inQ = false; }
          else cur += ch;
        } else {
          if (ch === '"') inQ = true;
          else if (ch === ',') { cols.push(cur.trim()); cur = ""; }
          else cur += ch;
        }
      }
      cols.push(cur.trim());
      rows.push(cols);
    });
    return rows;
  }

  /* ── Fetch + filter sheet ── */
  function fetchPages() {
    return fetch(SHEET_URL)
      .then(function (res) {
        if (!res.ok) throw new Error("Sheet fetch failed: " + res.status);
        return res.text();
      })
      .then(function (csv) {
        var rows = parseCSV(csv);
        if (rows.length < 2) throw new Error("Sheet is empty");

        var header  = rows[0].map(function (h) { return h.toLowerCase().trim(); });
        var colBook  = header.indexOf("book");
        var colTitle = header.indexOf("title");
        var colPdf   = header.indexOf("pdfurl");
        var colOrder = header.indexOf("order");

        if (colBook < 0 || colPdf < 0)
          throw new Error("Sheet missing required columns (book, pdfUrl)");

        var filtered = [];
        for (var r = 1; r < rows.length; r++) {
          var row = rows[r];
          if (!row || !row[colBook]) continue;
          if ((row[colBook] || "").toLowerCase().trim() !== BOOK_FILTER) continue;
          var url = (row[colPdf] || "").trim();
          if (!url) continue;
          var title = colTitle >= 0 ? (row[colTitle] || "").trim() : "";
          var order = colOrder >= 0 ? parseInt(row[colOrder], 10) || 9999 : 9999;
          filtered.push({ title: title, url: url, order: order });
        }

        filtered.sort(function (a, b) { return a.order - b.order; });
        return filtered;
      });
  }

  /* ── Render header + nav state ── */
  function renderHeader() {
    if (els.bookTitle)   els.bookTitle.textContent   = state.title;
    if (els.pageCurrent) els.pageCurrent.textContent = state.pages.length ? state.currentPage : "–";
    if (els.pageTotal)   els.pageTotal.textContent   = state.pages.length || "–";
    if (els.prevBtn) els.prevBtn.disabled = state.currentPage <= 1;
    if (els.nextBtn) els.nextBtn.disabled = state.currentPage >= state.pages.length;
  }

  /* ── Build the iframe viewer ── */
  function buildViewer() {
    var fb = els.flipBook;
    fb.innerHTML = "";
    fb.style.width  = "100%";
    fb.style.height = "100%";
    fb.style.position = "relative";
    fb.style.background = "#fff";
    fb.style.borderRadius = "4px";
    fb.style.overflow = "hidden";
    fb.style.boxShadow = "0 20px 48px rgba(15,16,24,0.30), 0 8px 18px rgba(15,16,24,0.16)";

    // Create one iframe per page, only show current
    state.pages.forEach(function (page, idx) {
      var frame = document.createElement("iframe");
      frame.src = toEmbedUrl(page.url);
      frame.setAttribute("allowfullscreen", "true");
      frame.setAttribute("frameborder", "0");
      frame.dataset.pageIndex = idx + 1;
      frame.style.cssText = [
        "position:absolute",
        "top:0", "left:0",
        "width:100%", "height:100%",
        "border:none",
        "display:" + (idx === 0 ? "block" : "none")
      ].join(";");
      fb.appendChild(frame);
    });

    // Size the outer container to fill the stage
    var stage = document.querySelector(".reader-stage");
    els.bookOuter.style.width  = (stage.clientWidth  - 128) + "px";
    els.bookOuter.style.height = (stage.clientHeight - 36)  + "px";
  }

  /* ── Show a specific page (1-based) ── */
  function showPage(n) {
    if (n < 1 || n > state.pages.length) return;
    state.currentPage = n;

    var frames = els.flipBook.querySelectorAll("iframe");
    frames.forEach(function (f) {
      f.style.display = (parseInt(f.dataset.pageIndex, 10) === n) ? "block" : "none";
    });

    renderHeader();
  }

  /* ── Nav ── */
  function goNext() {
    if (state.currentPage < state.pages.length) showPage(state.currentPage + 1);
  }
  function goPrev() {
    if (state.currentPage > 1) showPage(state.currentPage - 1);
  }

  /* ── Load ── */
  function load() {
    showOverlay("loader");
    state.pages = [];
    state.currentPage = 1;

    fetchPages().then(function (pages) {
      if (!pages || pages.length === 0) {
        showOverlay("error", "यस पुस्तकका लागि कुनै PDF फेला परेन");
        return;
      }
      state.pages = pages;
      hideOverlay();
      renderHeader();
      buildViewer();
      showPage(1);
      bindSwipe();
    }).catch(function (err) {
      console.error("load failed:", err);
      showOverlay("error", "Google Sheet बाट डाटा लोड गर्न सकिएन");
    });
  }

  /* ── Swipe gestures ── */
  function bindSwipe() {
    var fb = els.flipBook;
    var sx = 0, sy = 0, st = 0;

    fb.addEventListener("touchstart", function (e) {
      var t = e.touches[0];
      sx = t.clientX; sy = t.clientY; st = Date.now();
    }, { passive: true });

    fb.addEventListener("touchend", function (e) {
      var t   = e.changedTouches[0];
      var dx  = t.clientX - sx;
      var dy  = t.clientY - sy;
      var dt  = Date.now() - st;
      if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 40 && dt < 400) {
        if (dx < 0) goNext(); else goPrev();
      }
    }, { passive: true });
  }

  /* ── Back button ── */
  function handleBack() {
    if (window.parent && window.parent !== window) {
      try { window.parent.postMessage({ type: "shikshitmitra:closeReader" }, "*"); return; }
      catch (e) {}
    }
    if (window.history.length > 1) window.history.back();
    else window.location.href = "index.html";
  }

  /* ── Fullscreen ── */
  function toggleFullscreen() {
    var el = document.documentElement;
    var isFull = document.fullscreenElement || document.webkitFullscreenElement;
    if (!isFull) {
      var req = el.requestFullscreen || el.webkitRequestFullscreen;
      if (req) req.call(el).catch(function () { showToast("पूर्ण स्क्रिन उपलब्ध छैन"); });
    } else {
      var exit = document.exitFullscreen || document.webkitExitFullscreen;
      if (exit) exit.call(document);
    }
  }

  /* ── Keyboard ── */
  function handleKeydown(e) {
    if (e.key === "ArrowLeft"  || e.key === "ArrowUp")    goPrev();
    if (e.key === "ArrowRight" || e.key === "ArrowDown")   goNext();
    if (e.key === "Escape" && (document.fullscreenElement || document.webkitFullscreenElement))
      toggleFullscreen();
  }

  /* ── Resize ── */
  var resizeTimer = null;
  function handleResize() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      if (state.pages.length === 0) return;
      var stage = document.querySelector(".reader-stage");
      els.bookOuter.style.width  = (stage.clientWidth  - 128) + "px";
      els.bookOuter.style.height = (stage.clientHeight - 36)  + "px";
    }, 220);
  }

  /* ── Init ── */
  function init() {
    renderHeader();

    if (els.backBtn)       els.backBtn.addEventListener("click", handleBack);
    if (els.prevBtn)       els.prevBtn.addEventListener("click", goPrev);
    if (els.nextBtn)       els.nextBtn.addEventListener("click", goNext);
    if (els.fullscreenBtn) els.fullscreenBtn.addEventListener("click", toggleFullscreen);
    if (els.pdfRetryBtn)   els.pdfRetryBtn.addEventListener("click", load);
    if (els.zoomOutBtn)    els.zoomOutBtn.addEventListener("click", function () { showToast("जुम सुविधा छिट्टै आउनेछ"); });
    if (els.zoomInBtn)     els.zoomInBtn.addEventListener("click",  function () { showToast("जुम सुविधा छिट्टै आउनेछ"); });

    document.addEventListener("keydown", handleKeydown);
    window.addEventListener("resize",   handleResize);

    load();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
