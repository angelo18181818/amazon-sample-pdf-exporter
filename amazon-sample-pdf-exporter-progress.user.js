// ==UserScript==
// @name         Amazon Sample PDF Exporter
// @namespace    https://local.userscripts.amazon-sample-pdf-exporter
// @version      2.10.7
// @description  Adds a luxury PDF export button with inline progress to Amazon sample pages and exports the loaded sample images as a single PDF.
// @author       Local User
// @license      MIT
// @include      /^https?:\/\/([^/]+\.)?amazon\.[^/]+\/.*$/
// @run-at       document-start
// @require      https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js
// @grant        GM_xmlhttpRequest
// @grant        GM_download
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        unsafeWindow
// @connect      *.cloudfront.net
// @connect      cloudfront.net
// ==/UserScript==

(() => {
  "use strict";

  const IDLE_MS = 3000;
  const SCROLL_READY_WAIT_TICKS = 90;
  const ARM_TTL_MS = 5 * 60 * 1000;
  const MAX_WAIT_WITH_ZERO_LINKS_MS = 50000;
  const LOG_PREFIX = "[Amazon Sample PDF]";
  const EXPORT_BUTTON_ID = "amazon-sample-pdf-export-button";
  const EXPORT_STYLE_ID = "amazon-sample-pdf-export-style";
  const HIDDEN_READER_STYLE_ID = "amazon-sample-pdf-hidden-reader-style";
  const ARM_STORAGE_KEY = "amazonSamplePdfExporterArmedUntil";
  const PROGRESS_MESSAGE_TYPE = "amazonSamplePdfProgress";
  const CLOSE_READER_MESSAGE_TYPE = "amazonSamplePdfCloseReaderBeforeReveal";
  const REVEAL_READER_CLOSE_MESSAGE_TYPE = "amazonSamplePdfRevealReaderCloseOnly";
  const ARM_READER_MESSAGE_TYPE = "amazonSamplePdfArmReaderFromButton";
  const DOWNLOAD_SETTLE_MS = 1500;
  const PAGE_COMPLETE_SETTLE_MS = 250;
  const AUTO_ADVANCE_INTERVAL_MS = 700;
  const VERTICAL_SCROLL_STEP_RATIO = 0.35;
  const PAGINATED_PAGE_TIMEOUT_MS = 15000;
  const PAGINATED_CAPTURE_RETRIES = 3;
  const SHOW_READER_DURING_EXPORT = false;
  const SHOW_READER_STATUS = false;
  const KEEP_READER_OPEN_ON_FAILURE = false;
  const READER_STATUS_ID = "amazon-sample-pdf-reader-status";

  const VIEWER_SELECTORS = [
    ".litb-content-background",
    "#litb-render-main",
    ".litb-render-main",
    "#litb-renderer",
    "#kr-renderer",
    "#renderer-container",
    ".litb-reading-area",
    ".sample-page-disclaimer",
    '[aria-label="Book Content"]',
    'img[alt^="Page "][src*="cloudfront.net"]',
    'img[src*=".cloudfront.net/"][src*=".jpg"]'
  ].join(",");

  const found = new Map();

  let collecting = false;
  let stopped = false;
  let buildingPdf = false;
  let detectorObserver = null;
  let buttonObserver = null;
  let collectorObserver = null;
  let performanceObserver = null;
  let idleTimer = null;
  let pageReadyTimer = null;
  let pageLoadGateStarted = false;
  let readerArmBroadcastTimer = null;
  let readerArmBroadcastTicks = 0;
  let zeroLinksTimer = null;
  let scrollTimer = null;
  let autoScrolling = false;
  let autoScrollDone = false;
  let lastScrollTop = -1;
  let stableScrollTicks = 0;
  let readerAdvanceMode = "unknown";
  let progressPercent = 0;
  let exportStartedByButton = false;

  function gmGet(key, fallback) {
    try {
      return typeof GM_getValue === "function" ? GM_getValue(key, fallback) : fallback;
    } catch {
      return fallback;
    }
  }

  function gmSet(key, value) {
    try {
      if (typeof GM_setValue === "function") {
        GM_setValue(key, value);
      }
    } catch (error) {
      console.warn(`${LOG_PREFIX} Unable to write userscript storage.`, error);
    }
  }

  function gmDelete(key) {
    try {
      if (typeof GM_deleteValue === "function") {
        GM_deleteValue(key);
      }
    } catch {
      gmSet(key, 0);
    }
  }

  function isArmed() {
    return Number(gmGet(ARM_STORAGE_KEY, 0)) > Date.now();
  }

  function isReaderContext() {
    return /(^|\.)read\.amazon\./i.test(location.hostname) || /^\/sample\//i.test(location.pathname);
  }

  function isExportArmed() {
    return isArmed() && (exportStartedByButton || isReaderContext());
  }

  function clearOldResourcePerformanceEntries() {
    try {
      performance.clearResourceTimings?.();
    } catch (error) {
      console.debug(`${LOG_PREFIX} Unable to clear old resource timings.`, error);
    }
  }

  function armExport() {
    exportStartedByButton = true;
    clearOldResourcePerformanceEntries();
    gmSet(ARM_STORAGE_KEY, Date.now() + ARM_TTL_MS);
    applyHiddenReaderStyle();
  }

  function extendArm() {
    if (isArmed()) {
      gmSet(ARM_STORAGE_KEY, Date.now() + ARM_TTL_MS);
    }
  }

  function clearArm() {
    exportStartedByButton = false;
    stopReaderArmBroadcast();
    gmDelete(ARM_STORAGE_KEY);
    removeHiddenReaderStyle();
  }

  function clearStaleArmOutsideReader() {
    if (isReaderContext()) return;
    gmDelete(ARM_STORAGE_KEY);
    removeHiddenReaderStyle();
  }

  function injectExportButtonStyle() {
    if (document.getElementById(EXPORT_STYLE_ID)) return;

    const style = document.createElement("style");
    style.id = EXPORT_STYLE_ID;
    style.textContent = `
      #${EXPORT_BUTTON_ID} {
        --aspdf-progress-angle: 0deg;
        position: absolute;
        top: 50%;
        right: 10px;
        width: 50px;
        height: 50px;
        transform: translateY(-50%);
        z-index: 20;
        display: grid;
        place-items: center;
        border: 1px solid rgba(255, 234, 164, 0.92);
        border-radius: 999px;
        padding: 0;
        color: #fff1b8;
        background:
          radial-gradient(circle at 30% 22%, rgba(255,255,255,0.28), rgba(255,255,255,0) 28%),
          linear-gradient(145deg, #030303 0%, #151007 54%, #2c1c05 100%);
        box-shadow:
          0 9px 24px rgba(0, 0, 0, 0.42),
          0 0 0 1px rgba(255, 250, 220, 0.14) inset,
          0 0 22px rgba(244, 201, 91, 0.4);
        cursor: pointer;
        user-select: none;
        isolation: isolate;
        transition: transform 140ms ease, filter 140ms ease, box-shadow 140ms ease, opacity 140ms ease;
      }

      #${EXPORT_BUTTON_ID}::before {
        content: "";
        position: absolute;
        inset: -4px;
        z-index: -1;
        border-radius: inherit;
        opacity: 0;
        background:
          conic-gradient(from -90deg, #fff2b0 var(--aspdf-progress-angle), rgba(255, 230, 150, 0.18) 0),
          linear-gradient(145deg, rgba(255,255,255,0.18), rgba(0,0,0,0.14));
        box-shadow:
          0 0 20px rgba(255, 218, 112, 0.58),
          0 0 36px rgba(16, 185, 129, 0.18);
        transition: opacity 140ms ease, background 160ms linear;
      }

      #${EXPORT_BUTTON_ID}::after {
        content: "";
        position: absolute;
        inset: 5px;
        border-radius: inherit;
        border: 1px solid rgba(255, 246, 199, 0.22);
        pointer-events: none;
      }

      #${EXPORT_BUTTON_ID}:hover {
        transform: translateY(-50%) scale(1.08);
        filter: saturate(1.18) brightness(1.08);
        box-shadow:
          0 12px 30px rgba(0, 0, 0, 0.52),
          0 0 0 1px rgba(255, 255, 255, 0.18) inset,
          0 0 32px rgba(255, 226, 138, 0.62);
      }

      #${EXPORT_BUTTON_ID}:active {
        transform: translateY(-50%) scale(0.98);
      }

      #${EXPORT_BUTTON_ID}[data-page-ready="false"] {
        opacity: 0.42;
        cursor: not-allowed;
        filter: grayscale(0.32) saturate(0.68);
        box-shadow:
          0 6px 18px rgba(0, 0, 0, 0.34),
          0 0 0 1px rgba(255, 250, 220, 0.1) inset;
      }

      #${EXPORT_BUTTON_ID}[data-busy="true"] {
        opacity: 1;
        cursor: wait;
        filter: saturate(1.18) contrast(1.05);
        transform: translateY(-50%) scale(1.08);
      }

      #${EXPORT_BUTTON_ID}[data-busy="true"]::before {
        opacity: 1;
      }

      #${EXPORT_BUTTON_ID} .aspdf-icon-wrap {
        display: grid;
        place-items: center;
        transition: opacity 140ms ease, transform 140ms ease;
      }

      #${EXPORT_BUTTON_ID} svg {
        display: block;
        width: 32px;
        height: 32px;
        pointer-events: none;
      }

      #${EXPORT_BUTTON_ID}[data-busy="true"] .aspdf-icon-wrap {
        opacity: 0.24;
        transform: scale(0.92);
      }

      #${EXPORT_BUTTON_ID} .aspdf-progress {
        position: absolute;
        inset: 0;
        z-index: 2;
        display: grid;
        place-items: center;
        opacity: 0;
        color: #fff4c7;
        font: 900 12px/1 Arial, Helvetica, sans-serif;
        letter-spacing: 0;
        text-shadow:
          0 1px 2px rgba(0, 0, 0, 0.78),
          0 0 10px rgba(255, 224, 128, 0.8);
        pointer-events: none;
        transition: opacity 140ms ease;
      }

      #${EXPORT_BUTTON_ID}[data-busy="true"] .aspdf-progress {
        opacity: 1;
      }
    `;

    document.documentElement.appendChild(style);
  }

  function applyHiddenReaderStyle() {
    if (SHOW_READER_DURING_EXPORT) {
      removeHiddenReaderStyle();
      return;
    }

    if (document.getElementById(HIDDEN_READER_STYLE_ID)) return;

    const style = document.createElement("style");
    style.id = HIDDEN_READER_STYLE_ID;
    style.textContent = `
      #litb-read-frame,
      #litb-render-main,
      .litb-render-main,
      .litb-content-background,
      main#litb-renderer {
        opacity: 0 !important;
        pointer-events: none !important;
        visibility: visible !important;
      }

      html[data-aspdf-closing-reader="true"] #litb-read-frame,
      html[data-aspdf-closing-reader="true"] #litb-render-main,
      html[data-aspdf-closing-reader="true"] .litb-render-main,
      html[data-aspdf-closing-reader="true"] .litb-content-background,
      html[data-aspdf-closing-reader="true"] main#litb-renderer {
        opacity: 1 !important;
        pointer-events: auto !important;
        visibility: visible !important;
      }

      html[data-aspdf-closing-reader="true"] #litb-render-main *,
      html[data-aspdf-closing-reader="true"] .litb-render-main *,
      html[data-aspdf-closing-reader="true"] .litb-content-background *,
      html[data-aspdf-closing-reader="true"] main#litb-renderer * {
        visibility: hidden !important;
        pointer-events: none !important;
      }

      html[data-aspdf-closing-reader="true"] .aspdf-reader-close-reveal,
      html[data-aspdf-closing-reader="true"] .aspdf-reader-close-target,
      html[data-aspdf-closing-reader="true"] .aspdf-reader-close-target * {
        opacity: 1 !important;
        pointer-events: auto !important;
        visibility: visible !important;
      }
    `;

    document.documentElement.appendChild(style);
  }

  function removeHiddenReaderStyle() {
    document.getElementById(HIDDEN_READER_STYLE_ID)?.remove();
  }

  function setReaderStatus(message, tone = "working") {
    if (!SHOW_READER_STATUS) {
      document.getElementById(READER_STATUS_ID)?.remove();
      return;
    }

    if (!isReaderContext() || !document.documentElement) return;

    let status = document.getElementById(READER_STATUS_ID);

    if (!status) {
      status = document.createElement("div");
      status.id = READER_STATUS_ID;
      status.setAttribute("role", "status");
      status.style.cssText = [
        "position:fixed",
        "top:12px",
        "left:50%",
        "transform:translateX(-50%)",
        "z-index:2147483647",
        "max-width:min(720px,calc(100vw - 32px))",
        "padding:9px 14px",
        "border:1px solid rgba(255,255,255,.42)",
        "border-radius:999px",
        "box-shadow:0 8px 24px rgba(0,0,0,.32)",
        "color:#fff",
        "font:700 13px/1.35 Arial,sans-serif",
        "text-align:center",
        "pointer-events:none"
      ].join(";");
      document.documentElement.appendChild(status);
    }

    const backgrounds = {
      error: "rgba(153,27,27,.94)",
      success: "rgba(6,95,70,.94)",
      working: "rgba(17,24,39,.94)"
    };

    status.style.background = backgrounds[tone] || backgrounds.working;
    status.textContent = `Amazon PDF: ${message}`;
  }

  function createExportIcon() {
    return `
      <span class="aspdf-icon-wrap" aria-hidden="true">
        <svg viewBox="0 0 48 48" focusable="false">
          <defs>
            <linearGradient id="aspdf-gold" x1="8" y1="4" x2="40" y2="44" gradientUnits="userSpaceOnUse">
              <stop offset="0" stop-color="#fff8c7"/>
              <stop offset="0.42" stop-color="#f4c95b"/>
              <stop offset="1" stop-color="#9f6b16"/>
            </linearGradient>
            <radialGradient id="aspdf-emerald" cx="50%" cy="45%" r="58%">
              <stop offset="0" stop-color="#34d399"/>
              <stop offset="1" stop-color="#064e3b"/>
            </radialGradient>
          </defs>
          <path d="M24 4.2 29.2 10 24 15.8 18.8 10 24 4.2Z" fill="url(#aspdf-gold)" opacity="0.96"/>
          <path d="M14.5 11.5h13.2l6.8 6.8v18.2a3 3 0 0 1-3 3h-17a3 3 0 0 1-3-3v-22a3 3 0 0 1 3-3Z" fill="rgba(255,255,255,0.055)" stroke="url(#aspdf-gold)" stroke-width="2.4" stroke-linejoin="round"/>
          <path d="M27.7 11.7v6.7h6.6" fill="none" stroke="url(#aspdf-gold)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
          <circle cx="24" cy="27.2" r="7.1" fill="url(#aspdf-emerald)" stroke="url(#aspdf-gold)" stroke-width="2.1"/>
          <path d="M24 20.8v11.4M18.9 27.3 24 32.5l5.1-5.2" fill="none" stroke="#fff7c2" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </span>
      <span class="aspdf-progress" aria-live="polite">0%</span>
    `;
  }

  function findReadSampleButton() {
    return (
      document.querySelector("#pbooksReadSampleButton") ||
      document.querySelector("#pbooksReadSampleButton-announce")?.closest(".a-button") ||
      [...document.querySelectorAll("button, [role='button'], .a-button")].find(element =>
        /read sample|look inside|leggi anteprima|leggi estratto/i.test(element.textContent || "")
      )
    );
  }

  function clickReadSampleButton() {
    const wrapper = document.querySelector("#pbooksReadSampleButton");
    const innerButton = document.querySelector("#pbooksReadSampleButton-announce");
    const target = innerButton || wrapper || findReadSampleButton();

    if (!target) {
      console.warn(`${LOG_PREFIX} Read Sample button was not found.`);
      return false;
    }

    if (typeof target.click === "function") {
      target.click();
    } else {
      target.dispatchEvent(new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        view: window
      }));
    }

    return true;
  }

  function clampPercent(value) {
    return Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
  }

  function postMessageToTop(message) {
    if (!window.top || window.top === window) return;

    try {
      window.top.postMessage(message, "*");
    } catch (error) {
      console.debug(`${LOG_PREFIX} Unable to post message to top frame.`, error);
    }
  }

  function postProgressToTop(percent) {
    postMessageToTop({
      percent,
      type: PROGRESS_MESSAGE_TYPE
    });
  }

  function broadcastArmToReaderFrames() {
    const message = {
      armedUntil: gmGet(ARM_STORAGE_KEY, 0),
      type: ARM_READER_MESSAGE_TYPE
    };

    document.querySelectorAll("iframe").forEach(frame => {
      try {
        frame.contentWindow?.postMessage(message, "*");
      } catch (error) {
        console.debug(`${LOG_PREFIX} Unable to arm reader frame.`, error);
      }
    });
  }

  function startReaderArmBroadcast() {
    if (window.top !== window) return;

    stopReaderArmBroadcast();
    readerArmBroadcastTicks = 0;
    broadcastArmToReaderFrames();

    readerArmBroadcastTimer = setInterval(() => {
      readerArmBroadcastTicks += 1;

      if (!isArmed() || readerArmBroadcastTicks > 120) {
        stopReaderArmBroadcast();
        return;
      }

      broadcastArmToReaderFrames();
    }, 500);
  }

  function stopReaderArmBroadcast() {
    clearInterval(readerArmBroadcastTimer);
    readerArmBroadcastTimer = null;
    readerArmBroadcastTicks = 0;
  }

  function setExportProgress(value, broadcast = true) {
    progressPercent = clampPercent(value);

    if (broadcast) {
      postProgressToTop(progressPercent);
    }

    const button = document.getElementById(EXPORT_BUTTON_ID);
    if (!button) return;

    const label = `${progressPercent}%`;
    button.dataset.progress = label;
    button.style.setProperty("--aspdf-progress-angle", `${progressPercent * 3.6}deg`);

    const progress = button.querySelector(".aspdf-progress");
    if (progress) {
      progress.textContent = label;
    }
  }

  function setExportProgressAtLeast(value) {
    setExportProgress(Math.max(progressPercent, value));
  }

  function setExportButtonBusy(isBusy) {
    const button = document.getElementById(EXPORT_BUTTON_ID);
    if (!button) {
      if (!isBusy) setExportProgress(0);
      return;
    }

    button.dataset.busy = String(isBusy);
    button.setAttribute("aria-busy", String(isBusy));

    if (isBusy) {
      setExportProgressAtLeast(1);
    } else {
      setExportProgress(0);
    }
  }

  function isPageFullyLoaded() {
    return document.readyState === "complete";
  }

  function updateExportButtonPageGate() {
    const button = document.getElementById(EXPORT_BUTTON_ID);
    if (!button) return false;

    const isReady = isPageFullyLoaded();
    button.dataset.pageReady = String(isReady);
    button.disabled = !isReady;
    button.setAttribute("aria-disabled", String(!isReady));
    button.title = isReady
      ? "Export sample as PDF"
      : "Waiting for the page to finish loading";

    return isReady;
  }

  function schedulePageGateUpdate() {
    clearTimeout(pageReadyTimer);
    pageReadyTimer = setTimeout(updateExportButtonPageGate, PAGE_COMPLETE_SETTLE_MS);
  }

  function startPageLoadGate() {
    updateExportButtonPageGate();

    if (pageLoadGateStarted) return;
    pageLoadGateStarted = true;

    document.addEventListener("readystatechange", () => {
      if (isPageFullyLoaded()) {
        schedulePageGateUpdate();
      }
    });

    window.addEventListener("load", schedulePageGateUpdate, { once: true });

    if (isPageFullyLoaded()) {
      schedulePageGateUpdate();
    }
  }

  function installExportButton() {
    if (document.getElementById(EXPORT_BUTTON_ID)) return true;

    const readSampleButton = findReadSampleButton();
    if (!readSampleButton) return false;

    const host =
      readSampleButton.closest("#pbooksReadSample") ||
      readSampleButton.closest(".sample-button") ||
      readSampleButton.parentElement;

    if (!host) return false;

    injectExportButtonStyle();

    if (getComputedStyle(host).position === "static") {
      host.style.position = "relative";
    }

    host.style.overflow = "visible";

    const button = document.createElement("button");
    button.id = EXPORT_BUTTON_ID;
    button.type = "button";
    button.title = "Export sample as PDF";
    button.setAttribute("aria-label", "Export sample as PDF");
    button.innerHTML = createExportIcon();
    button.dataset.pageReady = "false";
    button.disabled = true;

    button.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();

      if (!updateExportButtonPageGate()) return;
      if (button.dataset.busy === "true") return;

      found.clear();
      stopped = false;
      collecting = false;
      buildingPdf = false;
      autoScrolling = false;
      autoScrollDone = false;
      lastScrollTop = -1;
      stableScrollTicks = 0;
      readerAdvanceMode = "unknown";
      progressPercent = 0;
      clearInterval(scrollTimer);
      scrollTimer = null;

      armExport();
      setExportButtonBusy(true);
      setExportProgress(2);
      startReaderArmBroadcast();
      startDetector();

      setTimeout(() => {
        if (!clickReadSampleButton()) {
          setExportButtonBusy(false);
          clearArm();
        }
      }, 0);
    }, true);

    host.appendChild(button);
    startPageLoadGate();

    console.log(`${LOG_PREFIX} Export button installed.`);
    return true;
  }

  function startButtonInstaller() {
    if (!document.documentElement) {
      setTimeout(startButtonInstaller, 50);
      return;
    }

    if (installExportButton()) return;

    buttonObserver = new MutationObserver(() => {
      if (!installExportButton()) return;
      buttonObserver?.disconnect();
      buttonObserver = null;
    });

    buttonObserver.observe(document.documentElement, {
      subtree: true,
      childList: true
    });
  }

  function cleanUrl(value) {
    if (!value || typeof value !== "string") return "";

    return value
      .trim()
      .replaceAll("&amp;", "&")
      .replaceAll("\\u0026", "&")
      .replace(/^["']|["']$/g, "");
  }

  function normalizeTargetUrl(value) {
    const raw = cleanUrl(value);
    if (!raw) return null;

    let url;

    try {
      url = new URL(raw, location.href);
    } catch {
      return null;
    }

    if (!/\.cloudfront\.net$/i.test(url.hostname)) return null;
    if (!/\.jpe?g$/i.test(url.pathname)) return null;

    const keys = [...url.searchParams.keys()].map(key => key.toLowerCase());

    if (!keys.includes("expires")) return null;
    if (!keys.includes("signature") && !keys.includes("policy")) return null;
    if (!keys.includes("key-pair-id")) return null;

    return url.href;
  }

  function pageFromUrl(url) {
    const match = url.match(/\.S([0-9A-Z]+)\./i);
    return match ? parseInt(match[1], 36) : Number.MAX_SAFE_INTEGER;
  }

  function targetImageKey(url) {
    try {
      const parsed = new URL(url);
      return `${parsed.hostname.toLowerCase()}${parsed.pathname.toLowerCase()}`;
    } catch {
      return url;
    }
  }

  function signedUrlExpiry(url) {
    try {
      return Number(new URL(url).searchParams.get("Expires")) || 0;
    } catch {
      return 0;
    }
  }

  function imageElementToDataUrl(img) {
    return new Promise((resolve, reject) => {
      const capture = () => {
        try {
          if (!img?.isConnected || !img.complete) {
            reject(new Error("The blob image is no longer connected or loaded."));
            return;
          }

          const width = img.naturalWidth;
          const height = img.naturalHeight;

          if (!width || !height) {
            reject(new Error("The blob image has no rendered dimensions."));
            return;
          }

          const canvas = document.createElement("canvas");
          canvas.width = width;
          canvas.height = height;

          const context = canvas.getContext("2d");
          if (!context) {
            reject(new Error("Canvas 2D is not available."));
            return;
          }

          context.drawImage(img, 0, 0, width, height);
          resolve(canvas.toDataURL("image/png"));
        } catch (error) {
          reject(error);
        }
      };

      if (img.isConnected && img.complete && img.naturalWidth > 0 && img.naturalHeight > 0) {
        capture();
        return;
      }

      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error("Timed out waiting for the blob image to load."));
      }, 5000);

      const cleanup = () => {
        clearTimeout(timeout);
        img.removeEventListener("load", onLoad);
        img.removeEventListener("error", onError);
      };
      const onLoad = () => {
        cleanup();
        capture();
      };
      const onError = () => {
        cleanup();
        reject(new Error("The blob image failed to load."));
      };

      img.addEventListener("load", onLoad, { once: true });
      img.addEventListener("error", onError, { once: true });
    });
  }

  function addUrl(value, source) {
    if (!isExportArmed()) return;

    const raw = cleanUrl(value);

    if (/^blob:https?:\/\//i.test(raw)) {
      return;
    }

    const url = normalizeTargetUrl(raw);
    if (!url) return;

    const key = targetImageKey(url);
    const existing = found.get(key);

    if (existing) {
      if (signedUrlExpiry(url) > signedUrlExpiry(existing.url)) {
        existing.source = source;
        existing.url = url;
      }
      return;
    }

    found.set(key, {
      page: pageFromUrl(url),
      source,
      url
    });

    setExportProgressAtLeast(Math.min(45, 16 + found.size * 3));
    extendArm();
    resetIdleTimer();
  }

  function scanImage(img) {
    addUrl(img.currentSrc, "img.currentSrc");
    addUrl(img.src, "img.src");
    addUrl(img.getAttribute("src"), "img.src.attribute");

    const srcset = img.getAttribute("srcset");
    if (!srcset) return;

    srcset.split(",").forEach(part => {
      addUrl(part.trim().split(/\s+/)[0], "img.srcset");
    });
  }

  function scanDom(root = document) {
    if (stopped || !isExportArmed()) return;

    const base = root.nodeType === Node.ELEMENT_NODE ? root : document;

    if (base.matches?.("img")) {
      scanImage(base);
    }

    base.querySelectorAll?.("img").forEach(scanImage);
  }

  function scanPerformance() {
    if (stopped || !isExportArmed()) return;

    performance.getEntriesByType("resource").forEach(entry => {
      addUrl(entry.name, "performance");
    });
  }

  function getScrollTarget() {
    const candidates = [
      document.querySelector(".litb-reading-area.scroll"),
      document.querySelector(".litb-reading-area"),
      document.querySelector("#renderer-container"),
      document.querySelector("#kr-renderer"),
      document.scrollingElement,
      document.documentElement,
      document.body
    ].filter(Boolean);

    return candidates
      .map(element => ({
        element,
        distance: Math.max(0, element.scrollHeight - element.clientHeight)
      }))
      .sort((a, b) => b.distance - a.distance)[0]?.element || document.scrollingElement;
  }

  function getScrollTop(element) {
    return element === document.body || element === document.documentElement
      ? window.scrollY || document.documentElement.scrollTop || document.body.scrollTop || 0
      : element.scrollTop;
  }

  function setScrollTop(element, value) {
    if (element === document.body || element === document.documentElement) {
      window.scrollTo(0, value);
      return;
    }

    element.scrollTop = value;
  }

  function detectReaderAdvanceMode() {
    const readingArea = document.querySelector(".litb-reading-area");

    if (
      readingArea?.classList.contains("paginated") ||
      document.querySelector("#kr-chevron-right, button[aria-label='Next page'], button[title='Next page']")
    ) {
      return "paginated";
    }

    if (readingArea?.classList.contains("scroll")) {
      return "vertical";
    }

    return "waiting";
  }

  function findNextPageButton(root = document) {
    return (
      root.querySelector("#kr-chevron-right") ||
      root.querySelector(".kr-chevron-container-right button") ||
      root.querySelector("button.chevron.round.right") ||
      root.querySelector("button[aria-label='Next page']") ||
      root.querySelector("button[title='Next page']") ||
      [...root.querySelectorAll("button, [role='button']")].find(button =>
        /next page|pagina successiva|pagina seguente|pagina dopo|avanti/i.test(
          `${button.getAttribute("aria-label") || ""} ${button.getAttribute("title") || ""} ${button.textContent || ""}`
        )
      )
    );
  }

  function findNextPageContainer(root = document, button = null) {
    return (
      button?.closest?.(".kr-chevron-container-right, .chevron-container.right") ||
      root.querySelector(".kr-chevron-container-right") ||
      root.querySelector(".chevron-container.right") ||
      root.querySelector("[class*='chevron-container-right']")
    );
  }

  function controlIsDisabled(control) {
    return Boolean(
      control && (
        control.disabled ||
        control.getAttribute("aria-disabled") === "true" ||
        control.hidden
      )
    );
  }

  function sampleProgressPercent() {
    const scrubber = document.querySelector("#kr-scrubber-bar, ion-range[aria-label*='sample']");
    const candidates = [
      scrubber?.getAttribute("aria-label"),
      document.querySelector(".reading-loc-percent")?.textContent,
      document.querySelector(".range-pin")?.textContent
    ].filter(Boolean);

    for (const candidate of candidates) {
      const match = String(candidate).match(/(\d+(?:[.,]\d+)?)\s*%/);
      if (!match) continue;

      const value = Number(match[1].replace(",", "."));
      if (Number.isFinite(value)) {
        return Math.max(0, Math.min(100, value));
      }
    }

    const rawValue = Number(scrubber?.value ?? scrubber?.getAttribute("value"));
    const rawMax = Number(scrubber?.max ?? scrubber?.getAttribute("max"));

    if (Number.isFinite(rawValue) && Number.isFinite(rawMax) && rawMax > 0) {
      return Math.max(0, Math.min(100, (rawValue / rawMax) * 100));
    }

    return null;
  }

  function sampleProgressIsComplete() {
    const percent = sampleProgressPercent();
    return percent !== null && percent >= 100;
  }

  function paginatedEndIsVisible() {
    return [...document.querySelectorAll(".paginated-end-actions")].some(element => {
      if (element.classList.contains("paginated-end-actions-hide")) return false;

      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    });
  }

  function paginatedPageSignature() {
    const renderer = document.querySelector("#kr-renderer");
    if (!renderer) return "";

    const imageSources = [...renderer.querySelectorAll("img")]
      .map(image => image.currentSrc || image.src || image.getAttribute("src") || "")
      .join("|");
    const pageNumbers = [...renderer.querySelectorAll("[data-page]")]
      .map(element => element.getAttribute("data-page") || "")
      .join("|");
    const locationText = document.querySelector(".range-pin, .reading-loc-percent")
      ?.textContent?.replace(/\s+/g, " ").trim() || "";
    const accessiblePageText = renderer.querySelector('[role="region"][aria-label="page"]')
      ?.textContent?.replace(/\s+/g, " ").trim().slice(0, 320) || "";

    return [imageSources, pageNumbers, locationText, accessiblePageText].join("::");
  }

  function readerPageWindow() {
    try {
      if (typeof unsafeWindow !== "undefined" && unsafeWindow) {
        return unsafeWindow;
      }

      if (window.wrappedJSObject) {
        return window.wrappedJSObject;
      }
    } catch (error) {
      console.debug(`${LOG_PREFIX} Unable to access the raw reader window.`, error);
    }

    return window;
  }

  function clickNextPage() {
    const pageWindow = readerPageWindow();
    const pageDocument = pageWindow.document || document;
    const pageButton = findNextPageButton(pageDocument);
    const pageContainer = findNextPageContainer(pageDocument, pageButton);
    const pageControl = pageContainer || pageButton;

    if (!pageControl) {
      const keyboardTarget =
        pageDocument.activeElement ||
        pageDocument.querySelector("#kr-renderer, .litb-reading-area, main") ||
        pageDocument.body;
      const KeyboardEventCtor = pageWindow.KeyboardEvent || KeyboardEvent;

      for (const type of ["keydown", "keyup"]) {
        keyboardTarget?.dispatchEvent(new KeyboardEventCtor(type, {
          key: "ArrowRight",
          code: "ArrowRight",
          keyCode: 39,
          which: 39,
          bubbles: true,
          cancelable: true,
          view: pageWindow
        }));
      }

      return "iframe ArrowRight fallback";
    }

    const rect = pageControl.getBoundingClientRect();
    const clientX = rect.left + rect.width / 2;
    const clientY = rect.top + rect.height / 2;
    const MouseEventCtor = pageWindow.MouseEvent || MouseEvent;
    const dispatchEvent = pageWindow.EventTarget?.prototype?.dispatchEvent;

    const mouseDown = new MouseEventCtor("mousedown", {
      bubbles: true,
      button: 0,
      buttons: 1,
      cancelable: true,
      clientX,
      clientY,
      view: pageWindow
    });
    const mouseUp = new MouseEventCtor("mouseup", {
      bubbles: true,
      button: 0,
      buttons: 0,
      cancelable: true,
      clientX,
      clientY,
      view: pageWindow
    });

    if (typeof dispatchEvent === "function") {
      dispatchEvent.call(pageControl, mouseDown);
      dispatchEvent.call(pageControl, mouseUp);
    } else {
      pageControl.dispatchEvent(mouseDown);
      pageControl.dispatchEvent(mouseUp);
    }

    if (!pageContainer && pageButton && typeof pageButton.click === "function") {
      pageButton.click();
    }

    return pageContainer
      ? "iframe right-container mousedown+mouseup"
      : "iframe next-button mousedown+mouseup+click";
  }

  function wait(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
  }

  function paginatedImageSource(image) {
    return image?.currentSrc || image?.src || image?.getAttribute?.("src") || "";
  }

  function paginatedImageIsReady(image) {
    return Boolean(
      image?.isConnected &&
      image.complete &&
      image.naturalWidth > 0 &&
      image.naturalHeight > 0
    );
  }

  function currentPaginatedImage() {
    const renderer = document.querySelector("#kr-renderer");
    if (!renderer) return null;

    const candidates = [
      ...renderer.querySelectorAll(".kg-full-page-img img, img[src^='blob:'], img")
    ];

    return candidates.find(paginatedImageIsReady) || null;
  }

  async function waitForPaginatedPage(previousSignature = "", previousImageSource = "") {
    const deadline = Date.now() + PAGINATED_PAGE_TIMEOUT_MS;

    while (!stopped && isExportArmed() && Date.now() < deadline) {
      if (paginatedEndIsVisible()) {
        return { end: true };
      }

      const image = currentPaginatedImage();
      const signature = paginatedPageSignature();
      const imageSource = paginatedImageSource(image);

      if (
        paginatedImageIsReady(image) &&
        imageSource &&
        (!previousImageSource || imageSource !== previousImageSource) &&
        signature &&
        signature !== previousSignature
      ) {
        try {
          if (typeof image.decode === "function") {
            await image.decode();
          }
        } catch {
          await wait(160);
          continue;
        }

        await wait(160);

        const stableImage = currentPaginatedImage();
        const stableSource = paginatedImageSource(stableImage);
        const stableSignature = paginatedPageSignature();

        if (
          paginatedImageIsReady(stableImage) &&
          stableSource === imageSource &&
          (!previousImageSource || stableSource !== previousImageSource) &&
          stableSignature &&
          stableSignature !== previousSignature
        ) {
          return {
            end: false,
            image: stableImage,
            imageSource: stableSource,
            signature: stableSignature
          };
        }
      }

      await wait(120);
    }

    return null;
  }

  async function saveCurrentPaginatedPage(pageState, pageNumber) {
    let lastError = null;

    for (let attempt = 1; attempt <= PAGINATED_CAPTURE_RETRIES; attempt += 1) {
      try {
        const image = currentPaginatedImage();
        if (!paginatedImageIsReady(image)) {
          throw new Error("The current Kindle page image is not ready.");
        }

        const sourceUrl = paginatedImageSource(image);
        if (!sourceUrl || (pageState.imageSource && sourceUrl !== pageState.imageSource)) {
          throw new Error("The Kindle page image changed before capture.");
        }

        if (typeof image.decode === "function") {
          await image.decode();
        }

        await wait(100);

        if (
          !paginatedImageIsReady(image) ||
          currentPaginatedImage() !== image ||
          paginatedImageSource(image) !== sourceUrl
        ) {
          throw new Error("The Kindle page image was replaced before capture.");
        }

        const dataUrl = await imageElementToDataUrl(image);

        if (!/^data:image\//i.test(dataUrl) || dataUrl.length < 512) {
          throw new Error("The captured page image is empty.");
        }

        const key = `kindle-page-${pageNumber}-${pageState.signature}`;

        found.set(key, {
          dataUrl,
          page: pageNumber,
          source: "kindle.visible-page",
          url: sourceUrl
        });

        setReaderStatus(`Kindle: pagina ${pageNumber} salvata`);
        setExportProgressAtLeast(Math.min(45, 16 + pageNumber * 1.5));
        extendArm();
        return { imageSource: sourceUrl };
      } catch (error) {
        lastError = error;
        console.warn(
          `${LOG_PREFIX} Kindle page ${pageNumber} capture attempt ${attempt} failed.`,
          error
        );

        if (attempt < PAGINATED_CAPTURE_RETRIES) {
          await wait(500);
        }
      }
    }

    throw lastError || new Error(`Unable to capture Kindle page ${pageNumber}.`);
  }

  async function runPaginatedReader() {
    let previousSignature = "";
    let previousImageSource = "";
    let savedPages = 0;
    let completed = false;

    while (!stopped && isExportArmed()) {
      setReaderStatus(
        savedPages === 0
          ? "Kindle: attendo la prima pagina..."
          : `Kindle: attendo la pagina ${savedPages + 1}...`
      );

      const pageState = await waitForPaginatedPage(previousSignature, previousImageSource);

      if (!pageState) {
        throw new Error("La pagina Kindle successiva non è comparsa entro il tempo previsto.");
      }

      if (pageState.end) {
        completed = true;
        break;
      }

      const pageNumber = savedPages + 1;
      setReaderStatus(`Kindle: salvataggio della pagina ${pageNumber}...`);
      const savedPage = await saveCurrentPaginatedPage(pageState, pageNumber);

      savedPages = pageNumber;
      previousSignature = pageState.signature;
      previousImageSource = savedPage.imageSource;
      scanPerformance();

      const progressPercent = sampleProgressPercent();
      if (progressPercent !== null) {
        setReaderStatus(
          `Kindle: pagina ${pageNumber} salvata; sample ${Math.round(progressPercent)}%`
        );
      }

      if (sampleProgressIsComplete()) {
        completed = true;
        break;
      }

      const nextButton = findNextPageButton();
      const nextContainer = findNextPageContainer(document, nextButton);

      if (paginatedEndIsVisible()) {
        completed = true;
        break;
      }

      if (controlIsDisabled(nextButton) || controlIsDisabled(nextContainer)) {
        completed = true;
        break;
      }

      await wait(250);
      setReaderStatus(`Kindle: attivazione di Next page dopo la pagina ${pageNumber}`);
      const clickMethod = clickNextPage();
      console.log(
        `${LOG_PREFIX} Next page activated after saved page ${pageNumber}. Method: ${clickMethod}.`
      );
    }

    if (!completed) {
      throw new Error("Il ciclo Kindle si è interrotto prima del 100% del sample.");
    }

    finishAutoAdvance();
  }

  function advanceVerticalReader(state, ticks) {
    const target = getScrollTarget();

    if (target !== state.lastElement) {
      state.lastElement = target;
      lastScrollTop = -1;
      stableScrollTicks = 0;
    }

    const currentTop = getScrollTop(target);
    const maxTop = Math.max(0, target.scrollHeight - target.clientHeight);
    const viewportHeight = target.clientHeight || window.innerHeight || 800;
    const step = Math.max(180, Math.floor(viewportHeight * VERTICAL_SCROLL_STEP_RATIO));
    const nextTop = Math.min(maxTop, currentTop + step);

    setScrollTop(target, nextTop);
    target.dispatchEvent(new Event("scroll", { bubbles: true }));
    window.dispatchEvent(new Event("scroll"));

    const afterTop = getScrollTop(target);
    const atBottom = maxTop > 0 && afterTop >= maxTop - 8;
    const didNotMove = Math.abs(afterTop - lastScrollTop) < 4;

    if (maxTop <= 8 && found.size === 0 && ticks < SCROLL_READY_WAIT_TICKS) {
      setExportProgressAtLeast(Math.min(20, 8 + (ticks / SCROLL_READY_WAIT_TICKS) * 12));
      stableScrollTicks = 0;
      lastScrollTop = afterTop;
      return false;
    }

    if (maxTop > 8) {
      const scrollRatio = Math.max(0, Math.min(1, afterTop / maxTop));
      const foundBonus = Math.min(8, found.size * 1.5);
      setReaderStatus(`Paperback: scorrimento verticale ${Math.round(scrollRatio * 100)}%`);
      setExportProgressAtLeast(Math.min(45, 20 + scrollRatio * 17 + foundBonus));
    }

    stableScrollTicks = didNotMove || atBottom ? stableScrollTicks + 1 : 0;
    lastScrollTop = afterTop;

    return stableScrollTicks >= 5 || ticks >= 240;
  }

  function finishAutoAdvance() {
    clearInterval(scrollTimer);
    scrollTimer = null;
    autoScrolling = false;
    autoScrollDone = true;

    scanDom();
    scanPerformance();
    setExportProgressAtLeast(46);
    resetIdleTimer();
    setReaderStatus(`avanzamento terminato; immagini rilevate: ${found.size}`);

    console.log(
      `${LOG_PREFIX} Automatic ${readerAdvanceMode} advance completed. Images seen so far:`,
      found.size
    );
  }

  function startAutoScroll() {
    if (autoScrolling || autoScrollDone) return;

    autoScrolling = true;
    autoScrollDone = false;
    lastScrollTop = -1;
    stableScrollTicks = 0;
    readerAdvanceMode = "unknown";

    let ticks = 0;
    const verticalState = {
      lastElement: null
    };

    clearTimeout(idleTimer);
    clearInterval(scrollTimer);

    scrollTimer = setInterval(() => {
      if (stopped || !isExportArmed()) {
        clearInterval(scrollTimer);
        scrollTimer = null;
        autoScrolling = false;
        return;
      }

      scanDom();
      scanPerformance();
      ticks += 1;

      if (readerAdvanceMode === "unknown") {
        const detectedMode = detectReaderAdvanceMode();

        if (detectedMode === "waiting") {
          setExportProgressAtLeast(Math.min(16, 8 + (ticks / SCROLL_READY_WAIT_TICKS) * 8));
          if (ticks < SCROLL_READY_WAIT_TICKS) return;
          readerAdvanceMode = "vertical";
        } else {
          readerAdvanceMode = detectedMode;
          setReaderStatus(
            readerAdvanceMode === "paginated"
              ? "Kindle rilevato; avanzamento pagina per pagina"
              : "Paperback rilevato; scorrimento verticale"
          );
          console.log(`${LOG_PREFIX} Reader navigation detected: ${readerAdvanceMode}.`);

          if (readerAdvanceMode === "paginated") {
            clearInterval(scrollTimer);
            scrollTimer = null;

            runPaginatedReader().catch(async error => {
              console.error(`${LOG_PREFIX} Sequential Kindle export failed.`, error);
              stopCollectors();

              if (KEEP_READER_OPEN_ON_FAILURE) {
                clearArm();
              } else {
                await closeLitbReaderAndClearArm("sequential Kindle export failed");
              }

              setExportButtonBusy(false);
              setReaderStatus(
                `Kindle interrotto: ${error.message || error}`,
                "error"
              );
            });
            return;
          }
        }
      }

      const finished = advanceVerticalReader(verticalState, ticks);

      if (finished) {
        finishAutoAdvance();
      }
    }, AUTO_ADVANCE_INTERVAL_MS);
  }

  function viewerIsOpen() {
    return Boolean(document.querySelector?.(VIEWER_SELECTORS));
  }

  function resetIdleTimer() {
    clearTimeout(idleTimer);

    if (autoScrolling) return;

    idleTimer = setTimeout(() => {
      scanDom();
      scanPerformance();
      setExportProgressAtLeast(48);
      stopAndBuildPdf("No new image URLs for 3 seconds").catch(async error => {
        console.error(`${LOG_PREFIX} Export failed.`, error);
        setReaderStatus("errore durante l’esportazione; lettore lasciato aperto", "error");

        if (KEEP_READER_OPEN_ON_FAILURE) {
          stopCollectors();
          clearArm();
          setExportButtonBusy(false);
        } else {
          await closeLitbReaderAndClearArm("export failed");
        }
      });
    }, IDLE_MS);
  }

  function stopCollectors() {
    stopped = true;
    collecting = false;

    clearTimeout(idleTimer);
    clearTimeout(zeroLinksTimer);
    clearInterval(scrollTimer);

    detectorObserver?.disconnect();
    collectorObserver?.disconnect();
    performanceObserver?.disconnect();

    detectorObserver = null;
    collectorObserver = null;
    performanceObserver = null;
    scrollTimer = null;
    autoScrolling = false;
    readerAdvanceMode = "unknown";
  }

  function sortedRows() {
    return [...found.values()]
      .sort((a, b) => a.page - b.page)
      .map((item, index) => ({
        dataUrl: item.dataUrl || "",
        index: index + 1,
        page: item.page === Number.MAX_SAFE_INTEGER ? "" : item.page,
        source: item.source,
        url: item.url
      }));
  }

  function gmRequestBlob(url) {
    const request =
      typeof GM_xmlhttpRequest === "function"
        ? GM_xmlhttpRequest
        : typeof GM !== "undefined" && typeof GM.xmlHttpRequest === "function"
          ? GM.xmlHttpRequest
          : null;

    if (!request) {
      return Promise.reject(new Error("GM_xmlhttpRequest is not available. Check the userscript grants."));
    }

    return new Promise((resolve, reject) => {
      request({
        method: "GET",
        url,
        responseType: "blob",
        timeout: 30000,
        onload(response) {
          if (response.status < 200 || response.status >= 300) {
            reject(new Error(`HTTP ${response.status}`));
            return;
          }

          resolve(response.response);
        },
        onerror(error) {
          reject(error);
        },
        ontimeout() {
          reject(new Error("Request timed out"));
        }
      });
    });
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  function loadImage(dataUrl) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = dataUrl;
    });
  }

  function imageSourceForPdf(dataUrl, img) {
    if (/^data:image\/png[;,]/i.test(dataUrl)) {
      return { dataUrl, format: "PNG" };
    }

    if (/^data:image\/jpe?g[;,]/i.test(dataUrl)) {
      return { dataUrl, format: "JPEG" };
    }

    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth || img.width;
    canvas.height = img.naturalHeight || img.height;
    canvas.getContext("2d").drawImage(img, 0, 0);

    return {
      dataUrl: canvas.toDataURL("image/jpeg", 0.94),
      format: "JPEG"
    };
  }

  function pageSizeForImage(img) {
    const pixelWidth = img.naturalWidth || img.width;
    const pixelHeight = img.naturalHeight || img.height;
    const landscape = pixelWidth > pixelHeight;
    const maxWidth = landscape ? 841.89 : 595.28;
    const maxHeight = landscape ? 595.28 : 841.89;
    const scale = Math.min(maxWidth / pixelWidth, maxHeight / pixelHeight);

    return {
      width: pixelWidth * scale,
      height: pixelHeight * scale,
      orientation: landscape ? "landscape" : "portrait"
    };
  }

  function triggerBrowserDownload(blobUrl, filename) {
    const link = document.createElement("a");
    link.href = blobUrl;
    link.download = filename;
    link.style.display = "none";
    document.documentElement.appendChild(link);
    link.click();
    link.remove();
  }

  function saveBlob(blob, filename) {
    const blobUrl = URL.createObjectURL(blob);
    const revokeLater = () => setTimeout(() => URL.revokeObjectURL(blobUrl), 10000);

    return new Promise(resolve => {
      let finished = false;

      const finish = () => {
        if (finished) return;
        finished = true;
        revokeLater();
        resolve();
      };

      const finishEventually = () => setTimeout(finish, DOWNLOAD_SETTLE_MS);

      if (typeof GM_download === "function") {
        try {
          GM_download({
            url: blobUrl,
            name: filename,
            saveAs: true,
            onload() {
              console.log(`${LOG_PREFIX} PDF download completed:`, filename);
              finish();
            },
            onerror(error) {
              console.warn(`${LOG_PREFIX} GM_download failed. Falling back to browser download.`, error);
              triggerBrowserDownload(blobUrl, filename);
              finishEventually();
            }
          });
          finishEventually();
          return;
        } catch (error) {
          console.warn(`${LOG_PREFIX} GM_download threw an error. Falling back to browser download.`, error);
        }
      }

      triggerBrowserDownload(blobUrl, filename);
      console.log(`${LOG_PREFIX} PDF download triggered:`, filename);
      finishEventually();
    });
  }

  function elementClassText(element) {
    const className = element.className;
    if (typeof className === "string") return className;
    return className?.baseVal || "";
  }

  function isVisibleElement(element) {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
  }

  function looksLikeReaderClose(element) {
    const identity = `${element.id || ""} ${elementClassText(element)}`;
    const label = [
      element.getAttribute("aria-label"),
      element.getAttribute("title"),
      element.getAttribute("data-action"),
      element.textContent
    ].filter(Boolean).join(" ");

    if (/(litb|kcr|kindle|reader|popover|modal|dialog).*close|close.*(litb|kcr|kindle|reader|popover|modal|dialog)/i.test(identity)) {
      return true;
    }

    return /(close|chiudi|cerrar|fermer|schliessen|fechar|sluiten)/i.test(label) || /^x$/i.test(label.trim());
  }

  function findLitbCloseControls() {
    const selectors = [
      ".close-reader-text",
      "#close-x",
      "#litb-close",
      "#litb-reader-close",
      "#litbReaderClose",
      "#litb-lightbox-close",
      ".litb-close",
      ".litb-close-button",
      ".litb-reader-close",
      "#kr-close-button",
      ".kr-close-button",
      ".a-button-close",
      "[id*='Close']",
      "[class*='close-reader']",
      "[data-action='a-popover-close']",
      "button[aria-label]",
      "a[aria-label]",
      "[role='button'][aria-label]"
    ].join(",");

    const seen = new Set();
    return [...document.querySelectorAll(selectors)].filter(element => {
      if (seen.has(element)) return false;
      seen.add(element);
      return isVisibleElement(element) && looksLikeReaderClose(element);
    });
  }

  function readerCloseClickTarget(element) {
    return (
      element.closest?.("button, a, [role='button'], [onclick], [data-action], [tabindex], [aria-label]") ||
      element.closest?.("[id*='Close'], [id*='close'], [class*='close-reader'], [class*='litb-close'], [class*='reader-close']") ||
      element
    );
  }

  function clearReaderCloseRevealMode() {
    document.documentElement?.removeAttribute("data-aspdf-closing-reader");
    document.querySelectorAll(".aspdf-reader-close-reveal, .aspdf-reader-close-target").forEach(element => {
      element.classList.remove("aspdf-reader-close-reveal", "aspdf-reader-close-target");
    });
  }

  function revealOnlyReaderClose(element) {
    const target = readerCloseClickTarget(element);
    const shell =
      target.closest?.("#litb-read-frame, #litb-render-main, .litb-render-main, .litb-content-background, [role='dialog'], .a-popover") ||
      document.documentElement;

    document.documentElement?.setAttribute("data-aspdf-closing-reader", "true");
    element.classList?.add("aspdf-reader-close-target");
    target.classList?.add("aspdf-reader-close-target");

    let current = target;
    while (current && current.nodeType === Node.ELEMENT_NODE) {
      current.classList?.add("aspdf-reader-close-reveal");
      if (current === shell || current === document.documentElement) break;
      current = current.parentElement;
    }

    return target;
  }

  function clickReaderCloseControl(element) {
    const target = revealOnlyReaderClose(element);

    setTimeout(() => {
      target.dispatchEvent(new MouseEvent("mousedown", {
        bubbles: true,
        cancelable: true
      }));
      target.dispatchEvent(new MouseEvent("mouseup", {
        bubbles: true,
        cancelable: true
      }));

      if (typeof target.click === "function") {
        target.click();
        return;
      }

      target.dispatchEvent(new MouseEvent("click", {
        bubbles: true,
        cancelable: true
      }));
    }, 80);
  }

  function removeLitbReaderShells() {
    const readerSelectors = [
      "#litb-read-frame",
      "#litb-render-main",
      ".litb-render-main",
      ".litb-content-background",
      "#litb-renderer",
      "#kr-renderer",
      "[aria-label='Book Content']"
    ].join(",");

    [...document.querySelectorAll(readerSelectors)].forEach(element => {
      const shell =
        element.closest("#litb-read-frame, #litb-render-main, .litb-render-main, .litb-content-background, [role='dialog'], .a-popover") ||
        element;

      shell.remove?.();
    });

    document.documentElement?.style.removeProperty("overflow");
    document.body?.style.removeProperty("overflow");
  }

  function closeLitbReaderBeforeReveal(reason = "export finished", notifyTop = true) {
    applyHiddenReaderStyle();

    let clickedCloseControl = false;

    if (notifyTop) {
      postMessageToTop({
        type: REVEAL_READER_CLOSE_MESSAGE_TYPE
      });
    }

    for (const control of findLitbCloseControls()) {
      try {
        clickReaderCloseControl(control);
        clickedCloseControl = true;
        break;
      } catch (error) {
        console.warn(`${LOG_PREFIX} Unable to click reader close control.`, error);
      }
    }

    if (clickedCloseControl) {
      setTimeout(clearReaderCloseRevealMode, 900);
      setTimeout(removeLitbReaderShells, 1200);
      setTimeout(removeLitbReaderShells, 2500);
    } else {
      clearReaderCloseRevealMode();
      removeLitbReaderShells();
      setTimeout(removeLitbReaderShells, 250);
    }

    if (notifyTop) {
      setTimeout(() => {
        postMessageToTop({
          reason,
          type: CLOSE_READER_MESSAGE_TYPE
        });
      }, clickedCloseControl ? 900 : 0);
    }

    console.log(`${LOG_PREFIX} Closing litb reader before reveal: ${reason}`);
    return clickedCloseControl;
  }

  async function closeLitbReaderAndClearArm(reason) {
    const clickedCloseControl = closeLitbReaderBeforeReveal(reason);
    await new Promise(resolve => setTimeout(resolve, clickedCloseControl ? 1400 : 300));
    clearArm();
  }

  async function buildPdf(rows) {
    const JsPdf =
      typeof jspdf !== "undefined" && jspdf.jsPDF
        ? jspdf.jsPDF
        : globalThis.jspdf?.jsPDF || window.jspdf?.jsPDF;

    if (!JsPdf) {
      console.error(`${LOG_PREFIX} jsPDF is not available. Check the @require URL.`);
      return false;
    }

    let pdf = null;
    let added = 0;
    let failed = 0;
    let processed = 0;

    console.log(`${LOG_PREFIX} Building PDF from ${rows.length} images...`);
    console.table(rows);
    setReaderStatus(`creazione del PDF da ${rows.length} immagini...`);
    setExportProgressAtLeast(50);

    for (const row of rows) {
      try {
        const dataUrl = row.dataUrl || await blobToDataUrl(await gmRequestBlob(row.url));
        setExportProgressAtLeast(50 + (processed / rows.length) * 45 + 4);
        const img = await loadImage(dataUrl);
        const page = pageSizeForImage(img);
        const imageSource = imageSourceForPdf(dataUrl, img);

        if (!pdf) {
          pdf = new JsPdf({
            orientation: page.orientation,
            unit: "pt",
            format: [page.width, page.height],
            compress: true
          });
        } else {
          pdf.addPage([page.width, page.height], page.orientation);
        }

        pdf.addImage(imageSource.dataUrl, imageSource.format, 0, 0, page.width, page.height);
        added += 1;
        console.log(`${LOG_PREFIX} Added image ${added}/${rows.length}`);
      } catch (error) {
        failed += 1;
        console.warn(`${LOG_PREFIX} Skipped image:`, row.url, error);
      } finally {
        processed += 1;
        setExportProgressAtLeast(50 + (processed / rows.length) * 45);
      }
    }

    if (!pdf || added === 0) {
      console.error(`${LOG_PREFIX} PDF was not created because no valid images were added.`);
      return false;
    }

    const pdfBlob = pdf.output("blob");
    const filename = `amazon-sample-${Date.now()}.pdf`;

    console.log("======================================");
    console.log(`${LOG_PREFIX} PDF created.`);
    console.log(`${LOG_PREFIX} Pages added:`, added);
    console.log(`${LOG_PREFIX} Failed images:`, failed);
    console.log(`${LOG_PREFIX} PDF size:`, `${(pdfBlob.size / 1024 / 1024).toFixed(2)} MB`);
    console.log(`${LOG_PREFIX} Saving PDF:`, filename);
    console.log("======================================");

    setExportProgress(100);
    await saveBlob(pdfBlob, filename);
    setReaderStatus(`PDF salvato: ${added} pagine`, "success");
    return true;
  }

  async function stopAndBuildPdf(reason) {
    if (buildingPdf) return;

    buildingPdf = true;
    stopCollectors();

    const rows = sortedRows();

    console.log(`${LOG_PREFIX} Collection finished: ${reason}`);
    console.log(`${LOG_PREFIX} Image URLs found: ${rows.length}`);
    console.log(`${LOG_PREFIX} Frame:`, location.href);

    if (rows.length === 0) {
      console.warn(`${LOG_PREFIX} No valid image URLs found.`);
      setReaderStatus("nessuna immagine valida rilevata; lettore lasciato aperto", "error");

      if (KEEP_READER_OPEN_ON_FAILURE) {
        clearArm();
      } else {
        await closeLitbReaderAndClearArm("no valid image URLs");
      }

      setExportButtonBusy(false);
      return;
    }

    const created = await buildPdf(rows);
    if (created) {
      await new Promise(resolve => setTimeout(resolve, 800));
    }

    if (!created && KEEP_READER_OPEN_ON_FAILURE) {
      setReaderStatus("il PDF non è stato creato; lettore lasciato aperto", "error");
      clearArm();
      setExportButtonBusy(false);
      return;
    }

    await closeLitbReaderAndClearArm(created ? "PDF export finished" : "PDF was not created");
    setExportButtonBusy(false);
  }

  function startCollector(reason) {
    if (collecting || stopped || buildingPdf || !isExportArmed()) return;

    collecting = true;
    applyHiddenReaderStyle();
    setExportProgressAtLeast(12);
    extendArm();

    console.log(`${LOG_PREFIX} Reader detected:`, reason);
    console.log(`${LOG_PREFIX} Frame:`, location.href);
    setReaderStatus("lettore rilevato; attendo la modalità di navigazione...");

    scanDom();
    scanPerformance();

    collectorObserver = new MutationObserver(mutations => {
      if (stopped || !isExportArmed()) return;

      for (const mutation of mutations) {
        if (mutation.type === "attributes") {
          scanDom(mutation.target);
        }

        for (const node of mutation.addedNodes) {
          scanDom(node);
        }
      }

      scanPerformance();
    });

    collectorObserver.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["src", "srcset"]
    });

    if ("PerformanceObserver" in window) {
      performanceObserver = new PerformanceObserver(list => {
        if (stopped || !isExportArmed()) return;

        for (const entry of list.getEntries()) {
          addUrl(entry.name, "performance.observer");
        }
      });

      performanceObserver.observe({
        type: "resource",
        buffered: true
      });
    }

    startAutoScroll();

    zeroLinksTimer = setTimeout(async () => {
      if (found.size === 0) {
        console.warn(`${LOG_PREFIX} Reader was detected, but no valid CloudFront images were found.`);
        setReaderStatus("nessuna immagine CloudFront rilevata; lettore lasciato aperto", "error");

        if (KEEP_READER_OPEN_ON_FAILURE) {
          stopCollectors();
          clearArm();
        } else {
          await closeLitbReaderAndClearArm("no valid CloudFront images");
        }

        setExportButtonBusy(false);
      }
    }, MAX_WAIT_WITH_ZERO_LINKS_MS);
  }

  function startDetector() {
    if (!document.documentElement) {
      setTimeout(startDetector, 50);
      return;
    }

    if (!isExportArmed()) return;

    if (viewerIsOpen()) {
      setExportProgressAtLeast(8);
      startCollector("viewer already present");
      return;
    }

    if (detectorObserver) return;

    detectorObserver = new MutationObserver(() => {
      if (!viewerIsOpen()) return;

      if (!isExportArmed()) return;

      detectorObserver?.disconnect();
      detectorObserver = null;

      startCollector("viewer appeared in the DOM");
    });

    detectorObserver.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true
    });

    if (isExportArmed()) {
      applyHiddenReaderStyle();
      setExportProgressAtLeast(5);
      console.log(`${LOG_PREFIX} Waiting for the hidden Amazon reader...`, location.href);
    }
  }

  function startHiddenReaderWatch() {
    if (isExportArmed()) {
      applyHiddenReaderStyle();
    } else {
      removeHiddenReaderStyle();
    }

    setInterval(() => {
      if (isExportArmed()) {
        applyHiddenReaderStyle();
      } else {
        removeHiddenReaderStyle();
        setExportButtonBusy(false);
      }
    }, 1000);
  }

  function startProgressBridge() {
    window.addEventListener("message", event => {
      if (event.data?.type !== PROGRESS_MESSAGE_TYPE) return;
      setExportProgress(event.data.percent, false);
    });
  }

  function startReaderCloseBridge() {
    window.addEventListener("message", event => {
      if (event.data?.type === REVEAL_READER_CLOSE_MESSAGE_TYPE) {
        applyHiddenReaderStyle();
        document.documentElement?.setAttribute("data-aspdf-closing-reader", "true");
        return;
      }

      if (event.data?.type !== CLOSE_READER_MESSAGE_TYPE) return;
      closeLitbReaderBeforeReveal(event.data.reason || "message", false);
      setExportButtonBusy(false);
    });
  }

  function startReaderArmBridge() {
    window.addEventListener("message", event => {
      if (event.data?.type !== ARM_READER_MESSAGE_TYPE) return;
      if (!isReaderContext()) return;

      exportStartedByButton = true;
      clearOldResourcePerformanceEntries();
      gmSet(ARM_STORAGE_KEY, Number(event.data.armedUntil) || Date.now() + ARM_TTL_MS);
      applyHiddenReaderStyle();
      setExportProgressAtLeast(6);
      startDetector();
    });
  }

  window.amazonSamplePdfStart = () => {
    armExport();
    setExportButtonBusy(true);
    setExportProgress(2);
    startDetector();
    if (viewerIsOpen()) {
      startCollector("manual start");
    }
  };

  startProgressBridge();
  startReaderCloseBridge();
  startReaderArmBridge();
  startPageLoadGate();
  clearStaleArmOutsideReader();
  startHiddenReaderWatch();
  startButtonInstaller();
  if (isExportArmed()) {
    startDetector();
  }
})();
