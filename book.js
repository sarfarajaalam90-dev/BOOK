/* ==========================================================================
   Shikshit Mitra — Book Reader
   Multi-PDF virtual book + CSS 3-D page-flip engine

   Architecture
   ────────────
   Multiple PDFs are stitched into one continuous virtual book.
   A compact index maps every global page number to its source PDF and
   local page number within that PDF — the student sees only one seamless
   sequence and never knows multiple files are involved.

   Virtual page index (built at load time)
   ────────────────────────────────────────
     virtualIndex[globalPage] = { docIndex: N, localPage: M }

   PDFs are opened lazily: a PDF document is only opened (via PDF.js)
   when a page from it is actually needed, and a per-doc promise is cached
   so it is never opened twice.  Rendered canvases are kept in pageCache
   with LRU eviction to cap memory at ~CACHE_LIMIT pages.

   Page-flip engine (same as previous version, untouched)
   ────────────────────────────────────────────────────────
   CSS 3-D perspective + a folding half-page "leaf" with:
     • Tap / swipe / drag-corner gestures
     • Realistic fold shadow + spine highlight
     • A4 ratio, single-page on mobile

   Page numbering: 1-based global, displayed directly to the student.
   ========================================================================== */

(function () {
  "use strict";

  /* ─────────────────────────────────────────────
     ①  Google Sheets data source
        Sheet columns: book | title | pdfUrl | order
        Pass ?book=second (or third, etc.) in the URL.
        The CSV endpoint is derived from the published
        HTML URL by replacing /pubhtml with /pub?output=csv
     ───────────────────────────────────────────── */
  var SHEET_URL =
    "https://docs.google.com/spreadsheets/d/e/" +
    "2PACX-1vS5svv38RZ1MJ54P73voMTXWZYuNZZeU6Hy4uWsXS95Z0BcydyeRsQINcY8gzVyKYNCeQoM8u3gs7E_" +
    "/pub?output=csv";

  /* pdfUrls is populated dynamically from the sheet — do not edit manually */
  var pdfUrls = [];

  /* ─────────────────────────────────────────────
     Config
     ───────────────────────────────────────────── */
  var params = new URLSearchParams(window.location.search);

  var CACHE_LIMIT  = 40;   // max rendered canvases kept in memory
  var PREFETCH_WIN = 4;    // pages ahead/behind to pre-render

  /* Which book to load — matches the "book" column in the sheet */
  var BOOK_FILTER = (params.get("book") || "second").toLowerCase().trim();

  var state = {
    title:       params.get("title") || "खरिदार द्वितीय पत्र",
    currentPage: 1,
    totalPages:  0
  };

  /* ─────────────────────────────────────────────
     Element refs
     ───────────────────────────────────────────── */
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
    zoomOutBtn:   document.getElementById("zoomOutBtn"),
    zoomInBtn:    document.getElementById("zoomInBtn"),
    zoomLevel:    document.getElementById("zoomLevel"),
    fullscreenBtn:document.getElementById("fullscreenBtn"),
    bookOuter:    document.getElementById("bookOuter"),
    flipBook:     document.getElementById("flipBook"),
    toast:        document.getElementById("toast")
  };

  /* ─────────────────────────────────────────────
     Toast
     ───────────────────────────────────────────── */
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

  /* ═══════════════════════════════════════════════════════════════════════
     Multi-PDF virtual book layer
     ═══════════════════════════════════════════════════════════════════════

     virtualIndex  Array<{ docIndex, localPage }>   (globalPage - 1 = array idx)
     docCache      Array<Promise<PDFDocumentProxy>>  (one slot per URL)
     pageCache     Map<globalPage, HTMLCanvasElement>
     lruList       Array<globalPage>  — most-recently-used at end
  */

  var virtualIndex = [];   // built during loadAllPdfs()
  var docCache     = [];   // [docIndex] → Promise<pdfjsDoc>  (lazy)
  var pageCache    = {};   // [globalPage] → HTMLCanvasElement
  var lruList      = [];   // globalPage numbers, LRU eviction
  var renderQueue  = {};   // [globalPage] → Promise<canvas>   (in-flight)

  /* ── resolve: globalPage (1-based) → { doc, localPage } ── */
  function resolve(globalPage) {
    var entry = virtualIndex[globalPage - 1];
    if (!entry) return null;
    return entry;
  }

  /* ── getDoc: open (or reuse) a PDF document by index ── */
  function getDoc(docIndex) {
    if (docCache[docIndex]) return docCache[docIndex];
    docCache[docIndex] = pdfjsLib.getDocument(pdfUrls[docIndex]).promise;
    return docCache[docIndex];
  }

  /* ── lru helpers ── */
  function lruTouch(globalPage) {
    var idx = lruList.indexOf(globalPage);
    if (idx !== -1) lruList.splice(idx, 1);
    lruList.push(globalPage);
  }

  function lruEvict() {
    while (lruList.length > CACHE_LIMIT) {
      var victim = lruList.shift();
      delete pageCache[victim];
    }
  }

  /* ── getPageCanvas: render globalPage → HTMLCanvasElement ── */
  function getPageCanvas(globalPage) {
    if (pageCache[globalPage]) {
      lruTouch(globalPage);
      return Promise.resolve(pageCache[globalPage]);
    }
    if (renderQueue[globalPage]) return renderQueue[globalPage];

    var entry = resolve(globalPage);
    if (!entry) return Promise.reject(new Error("Page out of range: " + globalPage));

    renderQueue[globalPage] = getDoc(entry.docIndex).then(function (doc) {
      return doc.getPage(entry.localPage);
    }).then(function (page) {
      var slotW = book.pageW || 400;
      var slotH = book.bookH || 566;
      var base  = page.getViewport({ scale: 1 });
      var scale = Math.min(slotW / base.width, slotH / base.height);
      var dpr   = window.devicePixelRatio || 1;
      var vp    = page.getViewport({ scale: scale });

      var c   = document.createElement("canvas");
      c.width  = Math.floor(vp.width  * dpr);
      c.height = Math.floor(vp.height * dpr);
      c.style.width  = Math.floor(vp.width)  + "px";
      c.style.height = Math.floor(vp.height) + "px";

      var ctx = c.getContext("2d");
      var xf  = dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null;

      return page.render({ canvasContext: ctx, viewport: vp, transform: xf }).promise
        .then(function () {
          pageCache[globalPage] = c;
          lruTouch(globalPage);
          lruEvict();
          delete renderQueue[globalPage];
          return c;
        });
    });

    return renderQueue[globalPage];
  }

  /* ── prefetch: queue nearby pages without blocking ── */
  function prefetch(around) {
    for (var i = around - PREFETCH_WIN; i <= around + PREFETCH_WIN; i++) {
      if (i >= 1 && i <= state.totalPages && i !== around) {
        getPageCanvas(i).catch(function () { /* silent */ });
      }
    }
  }

  /* ── parseCSV: minimal RFC-4180 CSV parser ── */
  function parseCSV(text) {
    var rows = [];
    var lines = text.split(/\r?\n/);
    lines.forEach(function (line) {
      if (!line.trim()) return;
      var cols = [];
      var cur = "";
      var inQ = false;
      for (var i = 0; i < line.length; i++) {
        var ch = line[i];
        if (inQ) {
          if (ch === '"') {
            if (line[i + 1] === '"') { cur += '"'; i++; }
            else inQ = false;
          } else {
            cur += ch;
          }
        } else {
          if (ch === '"') { inQ = true; }
          else if (ch === ',') { cols.push(cur.trim()); cur = ""; }
          else { cur += ch; }
        }
      }
      cols.push(cur.trim());
      rows.push(cols);
    });
    return rows;
  }

  /* ── fetchSheetUrls: download CSV, filter + sort, return pdfUrl list ── */
  function fetchSheetUrls() {
    return fetch(SHEET_URL)
      .then(function (res) {
        if (!res.ok) throw new Error("Sheet fetch failed: " + res.status);
        return res.text();
      })
      .then(function (csv) {
        var rows = parseCSV(csv);
        if (rows.length < 2) throw new Error("Sheet is empty");

        // Row 0 is the header; normalise column names
        var header = rows[0].map(function (h) { return h.toLowerCase().trim(); });
        var colBook  = header.indexOf("book");
        var colTitle = header.indexOf("title");
        var colPdf   = header.indexOf("pdfurl");
        var colOrder = header.indexOf("order");

        if (colBook < 0 || colPdf < 0) {
          throw new Error("Sheet missing required columns (book, pdfUrl)");
        }

        var filtered = [];
        for (var r = 1; r < rows.length; r++) {
          var row = rows[r];
          if (!row || !row[colBook]) continue;
          var bookVal = (row[colBook] || "").toLowerCase().trim();
          if (bookVal !== BOOK_FILTER) continue;
          var url = (row[colPdf] || "").trim();
          if (!url) continue;
          var order = colOrder >= 0 ? parseInt(row[colOrder], 10) || 9999 : 9999;
          filtered.push({ url: url, order: order });
        }

        // Sort by order column
        filtered.sort(function (a, b) { return a.order - b.order; });

        return filtered.map(function (item) { return item.url; });
      });
  }

  /* ── loadAllPdfs: fetch sheet → then probe every PDF for its page count,
        build the virtual index, then start the reader ── */
  function loadAllPdfs() {
    showOverlay("loader");

    if (!window.pdfjsLib) {
      showOverlay("error", "PDF लोड गर्ने सुविधा उपलब्ध छैन");
      return;
    }

    pdfjsLib.GlobalWorkerOptions.workerSrc =
      "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

    // Reset state for retry
    virtualIndex = [];
    docCache     = [];
    pageCache    = {};
    lruList      = [];
    renderQueue  = {};
    pdfUrls      = [];

    // Step 1: fetch PDF URLs from Google Sheets, then probe each PDF.
    fetchSheetUrls().then(function (urls) {
      if (!urls || urls.length === 0) {
        showOverlay("error", "यस पुस्तकका लागि कुनै PDF फेला परेन");
        return;
      }

      // Populate the global pdfUrls array used by getDoc()
      pdfUrls = urls;

      // Load all PDFs sequentially so page order is preserved.
      var chain = Promise.resolve();
      var segments = [];   // [{ docIndex, numPages }]

      pdfUrls.forEach(function (url, idx) {
        chain = chain.then(function () {
          return pdfjsLib.getDocument(url).promise.then(function (doc) {
            // Cache the already-opened document so getDoc() reuses it
            docCache[idx] = Promise.resolve(doc);
            segments.push({ docIndex: idx, numPages: doc.numPages });
          }).catch(function (err) {
            console.error("Failed to probe PDF " + idx + " (" + url + "):", err);
            // Treat as 0-page — keeps the rest of the book intact
            segments.push({ docIndex: idx, numPages: 0 });
          });
        });
      });

      chain.then(function () {
        // Build the flat virtual index
        virtualIndex = [];
        segments.forEach(function (seg) {
          for (var lp = 1; lp <= seg.numPages; lp++) {
            virtualIndex.push({ docIndex: seg.docIndex, localPage: lp });
          }
        });

        state.totalPages  = virtualIndex.length;
        state.currentPage = 1;

        if (state.totalPages === 0) {
          showOverlay("error", "पाना फेला परेन");
          return;
        }

        hideOverlay();
        renderHeader();
        book.buildDOM();
        book.showSpread(state.currentPage, false);
        prefetch(state.currentPage);
      }).catch(function (err) {
        console.error("loadAllPdfs failed:", err);
        showOverlay("error", "पाना लोड गर्न सकिएन");
      });

    }).catch(function (err) {
      console.error("fetchSheetUrls failed:", err);
      showOverlay("error", "Google Sheet बाट डाटा लोड गर्न सकिएन");
    });
  }

  /* ─────────────────────────────────────────────
     Overlay helpers
     ───────────────────────────────────────────── */
  function showOverlay(type, msg) {
    els.pdfLoader.classList.toggle("is-hidden", type !== "loader");
    els.pdfError.classList.toggle("is-hidden",  type !== "error");
    if (type === "error" && msg && els.pdfErrorText) els.pdfErrorText.textContent = msg;
  }

  function hideOverlay() {
    els.pdfLoader.classList.add("is-hidden");
    els.pdfError.classList.add("is-hidden");
  }

  /* ─────────────────────────────────────────────
     Header / nav state
     ───────────────────────────────────────────── */
  function renderHeader() {
    if (els.bookTitle)   els.bookTitle.textContent   = state.title;
    if (els.pageCurrent) els.pageCurrent.textContent = state.totalPages ? state.currentPage : "–";
    if (els.pageTotal)   els.pageTotal.textContent   = state.totalPages || "–";
  }

  function renderNavState() {
    var noPages = state.totalPages === 0;
    if (els.prevBtn) els.prevBtn.disabled = noPages || state.currentPage <= 1;
    if (els.nextBtn) els.nextBtn.disabled = noPages || state.currentPage >= state.totalPages;
  }

  /* ═══════════════════════════════════════════════════════════════════════
     FlipBook  — core page-flip engine  (unchanged from previous version)
     ═══════════════════════════════════════════════════════════════════════ */

  var FLIP_DURATION  = 600;
  var SNAP_THRESHOLD = 0.35;

  var book = {
    bookW: 0, bookH: 0, pageW: 0,
    isSingle: false,
    isFlipping: false,

    spread: null, pageLeft: null, pageRight: null,
    scene: null, leaf: null, leafFront: null, leafBack: null,
    shadowLeft: null, shadowRight: null, foldLight: null,

    /* ── layout ── */
    layout: function () {
      var stage  = document.querySelector(".reader-stage");
      var stageW = stage.clientWidth  - 128;
      var stageH = stage.clientHeight - 36;
      var A4     = 210 / 297;
      var isSingle = stageW < 560;

      var bookH, bookW;
      if (isSingle) {
        bookH = Math.min(stageH, stageW / A4);
        bookW = Math.min(stageW, bookH * A4);
        bookH = bookW / A4;
      } else {
        bookH = Math.min(stageH, (stageW / 2) / A4);
        bookW = Math.min(stageW, bookH * A4 * 2);
        bookH = (bookW / 2) / A4;
      }

      this.bookW    = Math.floor(bookW);
      this.bookH    = Math.floor(bookH);
      this.pageW    = Math.floor(bookW / (isSingle ? 1 : 2));
      this.isSingle = isSingle;
    },

    /* ── buildDOM ── */
    buildDOM: function () {
      this.layout();

      var fb = els.flipBook;
      fb.innerHTML = "";
      fb.style.width  = this.bookW + "px";
      fb.style.height = this.bookH + "px";
      fb.classList.toggle("is-single", this.isSingle);
      fb.style.boxShadow = [
        "0 20px 48px rgba(15,16,24,0.30)",
        "0 8px 18px rgba(15,16,24,0.16)",
        "0 0 0 1px rgba(15,16,24,0.05)"
      ].join(",");
      fb.style.borderRadius = "3px";

      var spread = document.createElement("div");
      spread.className = "flip-spread";
      this.spread = spread;

      if (!this.isSingle) {
        var pl = document.createElement("div");
        pl.className = "flip-page flip-page--left";
        pl.innerHTML = '<div class="flip-page__inner"></div>';
        spread.appendChild(pl);
        this.pageLeft = pl;
      }

      var pr = document.createElement("div");
      pr.className = "flip-page flip-page--right";
      pr.innerHTML = '<span class="page-ribbon" aria-hidden="true"></span><div class="flip-page__inner"></div>';
      spread.appendChild(pr);
      this.pageRight = pr;
      fb.appendChild(spread);

      var scene = document.createElement("div");
      scene.className = "flip-scene";
      this.scene = scene;

      var leaf  = document.createElement("div");
      leaf.className = "flip-leaf is-right";
      var front = document.createElement("div");
      front.className = "flip-face flip-face--front";
      var back  = document.createElement("div");
      back.className  = "flip-face flip-face--back";
      leaf.appendChild(front);
      leaf.appendChild(back);
      this.leaf      = leaf;
      this.leafFront = front;
      this.leafBack  = back;
      scene.appendChild(leaf);
      fb.appendChild(scene);

      var sl = document.createElement("div");
      sl.className = "flip-shadow flip-shadow--left";
      var sr = document.createElement("div");
      sr.className = "flip-shadow flip-shadow--right";
      this.shadowLeft  = sl;
      this.shadowRight = sr;
      fb.appendChild(sl);
      fb.appendChild(sr);

      var fl = document.createElement("div");
      fl.className = "flip-fold-light";
      this.foldLight = fl;
      fb.appendChild(fl);

      if (!this.isSingle) {
        var br = document.createElement("div");
        br.className = "flip-corner-hint flip-corner-hint--br";
        br.innerHTML = '<svg viewBox="0 0 48 48" fill="none"><path d="M40 40 C40 40 28 38 10 40 L10 10" stroke="rgba(140,31,46,0.35)" stroke-width="2" stroke-linecap="round" fill="rgba(140,31,46,0.08)"/></svg>';
        fb.appendChild(br);
      }

      els.bookOuter.style.width  = this.bookW + "px";
      els.bookOuter.style.height = this.bookH + "px";

      this.bindGestures();
    },

    /* ── showSpread ── */
    showSpread: function (rightPage) {
      if (state.totalPages === 0) return;
      state.currentPage = rightPage;
      renderHeader();
      renderNavState();

      var self     = this;
      var leftPage = rightPage - 1;

      function placeCanvas(container, canvas) {
        var inner = container.querySelector(".flip-page__inner") || container;
        inner.innerHTML = "";
        if (canvas) {
          inner.appendChild(canvas.cloneNode(true));
          inner.style.cssText = "display:flex;align-items:center;justify-content:center;width:100%;height:100%;";
        }
      }

      var tasks = [getPageCanvas(rightPage)];
      if (!self.isSingle && leftPage >= 1) tasks.push(getPageCanvas(leftPage));

      Promise.all(tasks).then(function (canvases) {
        placeCanvas(self.pageRight, canvases[0]);
        if (!self.isSingle && self.pageLeft && canvases[1]) {
          placeCanvas(self.pageLeft, canvases[1]);
        }
        prefetch(rightPage);
      }).catch(function (err) {
        console.error("showSpread error:", err);
      });
    },

    /* ── flipTo ── */
    flipTo: function (direction) {
      if (this.isFlipping || state.totalPages === 0) return;

      var fromPage = state.currentPage;
      var toPage   = direction === "next" ? fromPage + 1 : fromPage - 1;
      if (toPage < 1 || toPage > state.totalPages) return;

      this.isFlipping = true;
      var self = this;
      var turningRight = direction === "next";

      var frontPage = turningRight ? fromPage     : fromPage - 1;
      var backPage  = turningRight ? fromPage + 1 : fromPage - 2;
      frontPage = Math.max(1, Math.min(frontPage, state.totalPages));
      backPage  = Math.max(1, Math.min(backPage,  state.totalPages));

      Promise.all([
        getPageCanvas(frontPage),
        getPageCanvas(backPage)
      ]).then(function (canvases) {
        self.animateFlip(turningRight, canvases[0], canvases[1], toPage);
      }).catch(function () {
        self.isFlipping = false;
      });
    },

    /* ── animateFlip ── */
    animateFlip: function (turningRight, frontCanvas, backCanvas, toPage) {
      var self  = this;
      var leaf  = this.leaf;
      var front = this.leafFront;
      var back  = this.leafBack;

      leaf.classList.toggle("is-right", turningRight);
      leaf.classList.toggle("is-left",  !turningRight);

      if (turningRight) {
        leaf.style.left  = this.isSingle ? "0" : "50%";
        leaf.style.right = "";
        leaf.style.transformOrigin = "left center";
      } else {
        leaf.style.left  = "";
        leaf.style.right = this.isSingle ? "0" : "50%";
        leaf.style.transformOrigin = "right center";
      }

      front.innerHTML = "";
      back.innerHTML  = "";
      if (frontCanvas) front.appendChild(frontCanvas.cloneNode(true));
      if (backCanvas)  back.appendChild(backCanvas.cloneNode(true));

      leaf.style.zIndex    = 11;
      leaf.style.transition = "none";
      leaf.style.transform  = "rotateY(0deg)";

      var fl = this.foldLight;
      fl.style.left    = turningRight ? (this.isSingle ? "0px" : this.pageW + "px") : "";
      fl.style.right   = turningRight ? "" : (this.isSingle ? "0px" : this.pageW + "px");
      fl.style.opacity = "0";

      var startTime = null;
      var duration  = FLIP_DURATION;

      function ease(t) {
        return t < 0.5 ? 4*t*t*t : 1 - Math.pow(-2*t+2, 3)/2;
      }

      function tick(ts) {
        if (!startTime) startTime = ts;
        var elapsed = ts - startTime;
        var t = Math.min(elapsed / duration, 1);
        var e = ease(t);
        var angle = turningRight ? -180 * e : 180 * e;
        leaf.style.transform = "rotateY(" + angle + "deg)";

        var shadowT = Math.sin(e * Math.PI);
        if (turningRight) {
          self.shadowLeft.style.opacity  = (shadowT * 0.7).toFixed(3);
          self.shadowRight.style.opacity = (shadowT * 0.4).toFixed(3);
        } else {
          self.shadowRight.style.opacity = (shadowT * 0.7).toFixed(3);
          self.shadowLeft.style.opacity  = (shadowT * 0.4).toFixed(3);
        }
        fl.style.opacity = (Math.sin(e * Math.PI) * 0.9).toFixed(3);

        if (t < 1) {
          requestAnimationFrame(tick);
        } else {
          self.finishFlip(toPage);
        }
      }

      leaf.getBoundingClientRect();
      requestAnimationFrame(tick);
    },

    /* ── finishFlip ── */
    finishFlip: function (toPage) {
      this.leaf.style.zIndex = "";
      this.shadowLeft.style.opacity  = "0";
      this.shadowRight.style.opacity = "0";
      this.foldLight.style.opacity   = "0";
      this.isFlipping = false;
      this.showSpread(toPage);
    },

    /* ── drag state ── */
    _drag: null,

    startDrag: function (evt, turningRight) {
      if (this.isFlipping || state.totalPages === 0) return;
      var touch = evt.touches ? evt.touches[0] : evt;
      var rect  = els.flipBook.getBoundingClientRect();

      var toPage = turningRight ? state.currentPage + 1 : state.currentPage - 1;
      if (toPage < 1 || toPage > state.totalPages) return;

      this._drag = {
        turningRight: turningRight,
        startX: touch.clientX,
        rect:   rect,
        toPage: toPage,
        progress: 0
      };

      var self      = this;
      var fromPage  = state.currentPage;
      var frontPage = turningRight ? fromPage     : fromPage - 1;
      var backPage  = turningRight ? fromPage + 1 : fromPage - 2;
      frontPage = Math.max(1, Math.min(frontPage, state.totalPages));
      backPage  = Math.max(1, Math.min(backPage,  state.totalPages));

      var leaf = this.leaf;
      leaf.classList.toggle("is-right", turningRight);
      leaf.classList.toggle("is-left",  !turningRight);
      if (turningRight) {
        leaf.style.left  = this.isSingle ? "0" : "50%";
        leaf.style.right = "";
        leaf.style.transformOrigin = "left center";
      } else {
        leaf.style.left  = "";
        leaf.style.right = this.isSingle ? "0" : "50%";
        leaf.style.transformOrigin = "right center";
      }
      leaf.style.zIndex    = 11;
      leaf.style.transition = "none";
      leaf.style.transform  = "rotateY(0deg)";

      Promise.all([
        getPageCanvas(frontPage),
        getPageCanvas(backPage)
      ]).then(function (canvases) {
        self.leafFront.innerHTML = "";
        self.leafBack.innerHTML  = "";
        if (canvases[0]) self.leafFront.appendChild(canvases[0].cloneNode(true));
        if (canvases[1]) self.leafBack.appendChild(canvases[1].cloneNode(true));
      }).catch(function () {});
    },

    moveDrag: function (evt) {
      if (!this._drag) return;
      evt.preventDefault();
      var touch = evt.touches ? evt.touches[0] : evt;
      var d     = this._drag;
      var dx    = touch.clientX - d.startX;
      var halfW = this.isSingle ? this.bookW : this.pageW;
      var progress = Math.max(0, Math.min(1, Math.abs(dx) / halfW));

      d.progress = progress;
      var angle = d.turningRight ? -180 * progress : 180 * progress;
      this.leaf.style.transform = "rotateY(" + angle + "deg)";

      var st = Math.sin(progress * Math.PI);
      if (d.turningRight) {
        this.shadowLeft.style.opacity  = (st * 0.7).toFixed(3);
        this.shadowRight.style.opacity = (st * 0.4).toFixed(3);
      } else {
        this.shadowRight.style.opacity = (st * 0.7).toFixed(3);
        this.shadowLeft.style.opacity  = (st * 0.4).toFixed(3);
      }
      this.foldLight.style.opacity = (st * 0.9).toFixed(3);
    },

    endDrag: function () {
      if (!this._drag) return;
      var d    = this._drag;
      var self = this;
      this._drag = null;

      if (d.progress >= SNAP_THRESHOLD) {
        // Snap to complete
        var startAngle = d.turningRight ? -180 * d.progress : 180 * d.progress;
        var endAngle   = d.turningRight ? -180 : 180;
        var snapDur    = Math.max(80, (1 - d.progress) * FLIP_DURATION);
        var startTime  = null;
        this.isFlipping = true;

        function snapTick(ts) {
          if (!startTime) startTime = ts;
          var t = Math.min((ts - startTime) / snapDur, 1);
          var e = t < 0.5 ? 4*t*t*t : 1 - Math.pow(-2*t+2, 3)/2;
          var angle = startAngle + (endAngle - startAngle) * e;
          self.leaf.style.transform = "rotateY(" + angle + "deg)";

          var progress = Math.abs(angle) / 180;
          var st = Math.sin(progress * Math.PI);
          if (d.turningRight) {
            self.shadowLeft.style.opacity  = (st * 0.7).toFixed(3);
            self.shadowRight.style.opacity = (st * 0.4).toFixed(3);
          } else {
            self.shadowRight.style.opacity = (st * 0.7).toFixed(3);
            self.shadowLeft.style.opacity  = (st * 0.4).toFixed(3);
          }
          self.foldLight.style.opacity = (st * 0.9).toFixed(3);

          if (t < 1) requestAnimationFrame(snapTick);
          else self.finishFlip(d.toPage);
        }
        requestAnimationFrame(snapTick);

      } else {
        // Cancel — spring back
        var startAngle = d.turningRight ? -180 * d.progress : 180 * d.progress;
        var snapDur    = Math.max(80, d.progress * FLIP_DURATION * 0.6);
        var startTime  = null;

        function cancelTick(ts) {
          if (!startTime) startTime = ts;
          var t = Math.min((ts - startTime) / snapDur, 1);
          var e = 1 - Math.pow(1 - t, 3);
          var angle = startAngle * (1 - e);
          self.leaf.style.transform = "rotateY(" + angle + "deg)";

          var progress = Math.abs(angle) / 180;
          var st = Math.sin(progress * Math.PI);
          self.shadowLeft.style.opacity  = (st * 0.5).toFixed(3);
          self.shadowRight.style.opacity = (st * 0.3).toFixed(3);
          self.foldLight.style.opacity   = (st * 0.7).toFixed(3);

          if (t < 1) {
            requestAnimationFrame(cancelTick);
          } else {
            self.leaf.style.transform = "rotateY(0deg)";
            self.leaf.style.zIndex = "";
            self.shadowLeft.style.opacity  = "0";
            self.shadowRight.style.opacity = "0";
            self.foldLight.style.opacity   = "0";
          }
        }
        requestAnimationFrame(cancelTick);
      }
    },

    /* ── bindGestures ── */
    bindGestures: function () {
      var self = this;
      var fb   = els.flipBook;
      var swipeStartX = 0, swipeStartY = 0, swipeStartTime = 0;
      var isDraggingCorner = false;

      fb.addEventListener("touchstart", function (e) {
        var t = e.touches[0];
        swipeStartX    = t.clientX;
        swipeStartY    = t.clientY;
        swipeStartTime = Date.now();
        isDraggingCorner = false;

        var rect  = fb.getBoundingClientRect();
        var xFrac = (t.clientX - rect.left) / rect.width;
        var yFrac = (t.clientY - rect.top)  / rect.height;

        if (yFrac > 0.78) {
          isDraggingCorner = true;
          self.startDrag(e, xFrac > 0.5);
        }
      }, { passive: true });

      fb.addEventListener("touchmove", function (e) {
        if (isDraggingCorner) self.moveDrag(e);
      }, { passive: false });

      fb.addEventListener("touchend", function (e) {
        if (isDraggingCorner) {
          isDraggingCorner = false;
          self.endDrag();
          return;
        }
        var t     = e.changedTouches[0];
        var dx    = t.clientX - swipeStartX;
        var dy    = t.clientY - swipeStartY;
        var dt    = Date.now() - swipeStartTime;
        var absDx = Math.abs(dx);
        var absDy = Math.abs(dy);

        if (absDx > absDy && absDx > 40 && dt < 400) {
          if (dx < 0) goNext(); else goPrev();
          return;
        }
        if (absDx < 12 && absDy < 12 && dt < 250) {
          var rect  = fb.getBoundingClientRect();
          var xFrac = (t.clientX - rect.left) / rect.width;
          if (xFrac < 0.35) goPrev();
          else if (xFrac > 0.65) goNext();
        }
      }, { passive: true });

      var mouseDown = false;
      fb.addEventListener("mousedown", function (e) {
        var rect  = fb.getBoundingClientRect();
        var xFrac = (e.clientX - rect.left) / rect.width;
        var yFrac = (e.clientY - rect.top)  / rect.height;
        if (yFrac > 0.78) {
          mouseDown = true;
          self.startDrag(e, xFrac > 0.5);
        }
      });

      window.addEventListener("mousemove", function (e) {
        if (mouseDown) self.moveDrag(e);
      });

      window.addEventListener("mouseup", function () {
        if (mouseDown) { mouseDown = false; self.endDrag(); }
      });
    },

    /* ── resize ── */
    onResize: function () {
      // Clear only the rendered canvases (they are sized to slot dimensions).
      // The virtual index and PDF doc cache are still valid.
      pageCache   = {};
      renderQueue = {};
      lruList     = [];
      if (state.totalPages === 0) return;
      this.buildDOM();
      this.showSpread(state.currentPage);
    }
  };

  /* ─────────────────────────────────────────────
     Nav actions
     ───────────────────────────────────────────── */
  function goNext() {
    if (state.totalPages === 0 || state.currentPage >= state.totalPages) return;
    book.flipTo("next");
  }

  function goPrev() {
    if (state.totalPages === 0 || state.currentPage <= 1) return;
    book.flipTo("prev");
  }

  /* ─────────────────────────────────────────────
     Back button
     ───────────────────────────────────────────── */
  function handleBack() {
    if (window.parent && window.parent !== window) {
      try {
        window.parent.postMessage({ type: "shikshitmitra:closeReader" }, "*");
        return;
      } catch (e) { /* fall through */ }
    }
    if (window.history.length > 1) window.history.back();
    else window.location.href = "index.html";
  }

  /* ─────────────────────────────────────────────
     Fullscreen
     ───────────────────────────────────────────── */
  function toggleFullscreen() {
    var el = document.documentElement;
    var isFull = document.fullscreenElement || document.webkitFullscreenElement;
    if (!isFull) {
      var req = el.requestFullscreen || el.webkitRequestFullscreen;
      if (req) req.call(el).catch(function () { showToast("पूर्ण स्क्रिन उपलब्ध छैन"); });
      else showToast("पूर्ण स्क्रिन उपलब्ध छैन");
    } else {
      var exit = document.exitFullscreen || document.webkitExitFullscreen;
      if (exit) exit.call(document);
    }
  }

  /* ─────────────────────────────────────────────
     Keyboard
     ───────────────────────────────────────────── */
  function handleKeydown(e) {
    if (e.key === "ArrowLeft"  || e.key === "ArrowUp")   goPrev();
    if (e.key === "ArrowRight" || e.key === "ArrowDown")  goNext();
    if (e.key === "Escape" && (document.fullscreenElement || document.webkitFullscreenElement))
      toggleFullscreen();
  }

  /* ─────────────────────────────────────────────
     Resize
     ───────────────────────────────────────────── */
  var resizeTimer = null;
  function handleResize() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () { book.onResize(); }, 220);
  }

  /* ─────────────────────────────────────────────
     Init
     ───────────────────────────────────────────── */
  function init() {
    renderHeader();
    renderNavState();

    if (els.backBtn)      els.backBtn.addEventListener("click", handleBack);
    if (els.prevBtn)      els.prevBtn.addEventListener("click", goPrev);
    if (els.nextBtn)      els.nextBtn.addEventListener("click", goNext);
    if (els.zoomOutBtn)   els.zoomOutBtn.addEventListener("click",  function () { showToast("जुम सुविधा छिट्टै आउनेछ"); });
    if (els.zoomInBtn)    els.zoomInBtn.addEventListener("click",   function () { showToast("जुम सुविधा छिट्टै आउनेछ"); });
    if (els.fullscreenBtn)els.fullscreenBtn.addEventListener("click", toggleFullscreen);
    if (els.pdfRetryBtn)  els.pdfRetryBtn.addEventListener("click",  loadAllPdfs);

    document.addEventListener("keydown", handleKeydown);
    window.addEventListener("resize",   handleResize);

    loadAllPdfs();
  }

  document.addEventListener("DOMContentLoaded", init);
})();