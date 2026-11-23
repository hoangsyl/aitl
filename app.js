/**
 * AIvolution Team - High Concurrency, Auto-Verify & Explore Hub Client
 * Bản quyền thuộc về AIvolution Team
 */

const HISTORY_KEY = "aivolution_scan_history_v1";
const TOTAL_SCANS_KEY = "aivolution_total_scans_v1";
const THEME_KEY = "aivolution_theme_v1";
const MAX_HISTORY = 10000;
const FRIENDLY_ERROR_MSG =
  "Opps! Mình không thể nhận diện được, có lẽ do bạn chụp không rõ hoặc mờ hoặc tối quá, bạn hãy giữ nguyên và để rõ giúp mình nhé.";

// Views & Elements
const views = {
  home: document.getElementById("viewHome"),
  weather: document.getElementById("viewWeather"),
  chat: document.getElementById("viewChat"),
  history: document.getElementById("viewHistory"),
  scanner: document.getElementById("viewScanner"),
  detail: document.getElementById("viewDetail")
};

const bottomNav = document.getElementById("bottomNav");
let video = document.getElementById("camera");
const canvas = document.getElementById("canvas");
const fileInput = document.getElementById("fileInput");
const statusPill = document.getElementById("statusPill");
const cameraErrorBanner = document.getElementById("cameraErrorBanner");
const gpsDot = document.getElementById("gpsDot");
const gpsText = document.getElementById("gpsText");
const historyBadge = document.getElementById("historyBadge");
const confirmDialog = document.getElementById("confirmDialog");
const btnToggleTheme = document.getElementById("btnToggleTheme");
const iconMoon = document.getElementById("iconMoon");
const iconSun = document.getElementById("iconSun");
const themeColorMeta = document.getElementById("themeColorMeta");

// State
let activeView = "home";
let previousView = "home";
let scanMode = "auto";
let facingMode = "environment";
let currentStream = null;
let cameraSessionId = 0;
let currentCoords = { lat: null, lng: null };
let currentSpeechText = "";
let isSpeaking = false;
let speechSessionId = 0;
let syncNavGlassFn = null;
let isScanning = false;
let isChatSending = false;
let lastScanData = null;

// Web Audio API + Fallback Audio + Bộ đệm giọng Hoài My
let audioCtx = null;
let activeSource = null;
let activeHtmlAudio = null;
let activeAudioUrl = null;
let audioNeedsReset = false;
const ttsBufferCache = new Map();

let chatHistory = [
  {
    role: "assistant",
    content:
      "Chào bạn! Mình là trợ lý AIvolution. Bạn cần hỏi đường, quán ngon Đà Nẵng – Hội An hay thông tin dinh dưỡng món vừa quét cứ nhắn mình nhé!"
  }
];

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Fetch có timeout + tự thử lại kèm độ trễ ngẫu nhiên (jitter) khi nhiều người quét cùng lúc
async function fetchApiWithRetry(payload, { timeoutMs = 13500, maxRetries = 1 } = {}) {
  let lastRes = null;
  let lastData = null;
  let lastErr = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch("/api/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      clearTimeout(timer);

      let data = {};
      try {
        data = await res.json();
      } catch (_) {
        data = { error: FRIENDLY_ERROR_MSG, debug: `HTTP ${res.status}` };
      }

      lastRes = res;
      lastData = data;

      if ([429, 502, 503, 504].includes(res.status) && attempt < maxRetries) {
        const jitter = 600 + Math.floor(Math.random() * 700);
        await sleep(jitter);
        continue;
      }
      return { res, data };
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      if (attempt < maxRetries) {
        const jitter = 500 + Math.floor(Math.random() * 600);
        await sleep(jitter);
        continue;
      }
    }
  }

  if (lastRes) return { res: lastRes, data: lastData };
  throw lastErr || new Error("Kết nối máy chủ bị gián đoạn");
}

// ==========================================
// 0. CHẾ ĐỘ SÁNG / TỐI (LIGHT / DARK MODE)
// ==========================================
function applyTheme(theme) {
  const isDark = theme === "dark";
  document.documentElement.setAttribute("data-theme", isDark ? "dark" : "light");
  if (themeColorMeta) {
    themeColorMeta.setAttribute("content", isDark ? "#0B0B0D" : "#F3F3F5");
  }
  if (iconMoon && iconSun) {
    iconMoon.hidden = isDark;
    iconSun.hidden = !isDark;
  }
  if (btnToggleTheme) {
    btnToggleTheme.setAttribute("aria-pressed", String(isDark));
    btnToggleTheme.setAttribute(
      "aria-label",
      isDark ? "Chuyển sang chế độ sáng" : "Chuyển sang chế độ tối"
    );
  }
  try {
    localStorage.setItem(THEME_KEY, isDark ? "dark" : "light");
  } catch (_) {}
}

function initTheme() {
  const current = document.documentElement.getAttribute("data-theme") || "light";
  applyTheme(current);
}

if (btnToggleTheme) {
  btnToggleTheme.addEventListener("click", () => {
    const current = document.documentElement.getAttribute("data-theme") || "light";
    applyTheme(current === "dark" ? "light" : "dark");
  });
}

// ==========================================
// 1. ĐIỀU HƯỚNG GIỮA CÁC MÀN HÌNH
// ==========================================
function navigateTo(viewName) {
  if (!views[viewName]) return;

  if (activeView === "detail" && viewName !== "detail") {
    stopSpeaking();
  }
  if (viewName !== activeView && activeView !== "detail") {
    previousView = activeView;
  }

  activeView = viewName;

  Object.entries(views).forEach(([key, el]) => {
    el.hidden = key !== viewName;
  });

  bottomNav.hidden = viewName === "scanner" || viewName === "detail";

  document.querySelectorAll(".bottom-nav .nav-btn").forEach((btn) => {
    const isMatch = btn.dataset.nav === viewName;
    btn.classList.toggle("active", isMatch);
    if (isMatch) btn.setAttribute("aria-current", "page");
    else btn.removeAttribute("aria-current");
  });

  if (viewName === "home") {
    stopCamera();
    renderHomeDashboard();
  } else if (viewName === "scanner") {
    startCamera();
    updateLastThumbPreview();
  } else if (viewName === "weather") {
    stopCamera();
    renderWeatherView();
  } else if (viewName === "chat") {
    stopCamera();
    renderChatView();
  } else if (viewName === "history") {
    stopCamera();
    renderHomeDashboard();
  }

  if (typeof syncNavGlassFn === "function" && !bottomNav.hidden) {
    requestAnimationFrame(() => syncNavGlassFn());
  }
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    const expModal = document.getElementById("exploreHubModal");
    if (expModal && !expModal.hidden) return;

    if (confirmDialog && confirmDialog.open) {
      confirmDialog.close();
    } else if (activeView === "detail") {
      navigateTo(previousView || "home");
    } else if (activeView === "scanner") {
      navigateTo("home");
    }
  }
});

// ==========================================
// 2. LỊCH SỬ KHÔNG GIỚI HẠN (> 9.999 LƯỢT) & THỐNG KÊ
// ==========================================
function loadHistory() {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (_) {
    return [];
  }
}

function getTotalScans() {
  const historyLen = loadHistory().length;
  try {
    const saved = Number(localStorage.getItem(TOTAL_SCANS_KEY) || "0");
    return Math.max(Number.isFinite(saved) ? saved : 0, historyLen);
  } catch (_) {
    return historyLen;
  }
}

function setTotalScans(count) {
  try {
    localStorage.setItem(TOTAL_SCANS_KEY, String(Math.max(0, Math.floor(count))));
  } catch (_) {}
}

function saveHistoryList(list) {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(list));
  } catch (_) {
    const slim = list.map((item, idx) => (idx >= 20 ? { ...item, thumb: "" } : item));
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(slim));
    } catch (_) {
      const ultraSlim = list.slice(0, 500).map((item, idx) => (idx >= 5 ? { ...item, thumb: "" } : item));
      try {
        localStorage.setItem(HISTORY_KEY, JSON.stringify(ultraSlim));
      } catch (_) {}
    }
  }
  updateHistoryBadge();
}

function addToHistory(data, thumbDataUrl) {
  const nextTotal = getTotalScans() + 1;
  setTotalScans(nextTotal);

  const list = loadHistory();
  list.unshift({
    id: Date.now(),
    time: new Date().toLocaleString("vi-VN", {
      hour: "2-digit",
      minute: "2-digit",
      day: "2-digit",
      month: "2-digit"
    }),
    thumb: thumbDataUrl || "",
    data
  });
  if (list.length > MAX_HISTORY) list.length = MAX_HISTORY;
  saveHistoryList(list);
}

function updateHistoryBadge() {
  const count = getTotalScans();
  if (count > 0) {
    historyBadge.textContent = count > 9999 ? "9999+" : String(count);
    historyBadge.hidden = false;
  } else {
    historyBadge.hidden = true;
  }
}

function parseCalories(str) {
  if (!str) return 0;
  const text = String(str).toLowerCase();
  if (/không áp dụng|chưa xác định|chưa đủ dữ liệu|n\/a/.test(text)) return 0;
  const nums = text.match(/\d+/g);
  if (!nums) return 0;
  if (nums.length >= 2) {
    return Math.round((Number(nums[0]) + Number(nums[1])) / 2);
  }
  return Number(nums[0]) || 0;
}

function renderHomeDashboard() {
  const list = loadHistory();
  const totalScans = getTotalScans();
  let totalCalories = 0;
  let placesCount = 0;
  let foodCount = 0;
  let productCount = 0;

  list.forEach((item) => {
    const d = item.data || {};
    const type = String(d.loai_doi_tuong || "").toLowerCase();
    const kcal = parseCalories(d.thong_tin_san_pham?.calo_uoc_tinh);
    totalCalories += kcal;

    if (d.la_dia_diem || /di tích|nhà hàng|quán ăn|workshop|shop|hán nôm|trường học|tổ chức|thương hiệu/.test(type)) {
      placesCount++;
    } else if (/thức ăn|đồ uống|món ăn|nước uống|thực phẩm|bánh|trái cây/.test(type) || kcal > 0) {
      foodCount++;
    } else {
      productCount++;
    }
  });

  document.getElementById("totalScansVal").textContent = totalScans.toLocaleString("vi-VN");
  document.getElementById("totalScansSub").textContent =
    totalCalories > 0
      ? `Không giới hạn • ${totalCalories.toLocaleString("vi-VN")} kcal`
      : `Không giới hạn • Đã lưu ${list.length.toLocaleString("vi-VN")} mục`;

  const circumference = 226.2;
  const milestone = totalScans <= 10 ? 10 : totalScans <= 100 ? 100 : totalScans <= 1000 ? 1000 : 10000;
  const ratio = totalScans === 0 ? 0.08 : Math.min(1, Math.max(0.12, (totalScans % milestone || milestone) / milestone));
  const offset = circumference * (1 - ratio);
  document.getElementById("heroRingProgress").setAttribute("stroke-dashoffset", offset.toFixed(1));

  const maxCat = Math.max(1, placesCount, foodCount, productCount);
  document.getElementById("statPlaces").textContent = `${placesCount} mục`;
  document.getElementById("statFood").textContent = `${foodCount} mục`;
  document.getElementById("statProducts").textContent = `${productCount} mục`;

  document.getElementById("barPlaces").style.transform = `scaleX(${Math.max(0.12, placesCount / maxCat)})`;
  document.getElementById("barFood").style.transform = `scaleX(${Math.max(0.12, foodCount / maxCat)})`;
  document.getElementById("barProducts").style.transform = `scaleX(${Math.max(0.12, productCount / maxCat)})`;

  const clearBtn = document.getElementById("btnClearHistory");
  if (clearBtn) clearBtn.hidden = list.length === 0 && totalScans === 0;

  const container = document.getElementById("homeHistoryContainer");
  if (!container) return;

  if (!list.length) {
    container.innerHTML = `
      <div class="empty-card">
        <p>Chưa có mục nào được quét. Hãy mở máy quét để nhận diện món ăn, logo trường học, địa điểm hoặc sản phẩm quanh bạn.</p>
        <button type="button" class="btn-pill btn-primary" id="emptyScanBtn">Mở AI Scanner</button>
      </div>
    `;
    document.getElementById("emptyScanBtn").addEventListener("click", () => navigateTo("scanner"));
    return;
  }

  const visibleList = list.slice(0, 100);

  container.innerHTML = `
    <ul class="history-list">
      ${visibleList
        .map((item) => {
          const kcal = parseCalories(item.data?.thong_tin_san_pham?.calo_uoc_tinh);
          const subText = kcal > 0
            ? `${kcal} kcal • ${item.time}`
            : `${escapeHtml(item.data?.loai_doi_tuong || "Nhận diện")} • ${item.time}`;

          return `
            <li class="history-card">
              <button type="button" class="history-open-btn" data-open-id="${item.id}">
                ${
                  item.thumb
                    ? `<img class="history-thumb" src="${item.thumb}" alt="" />`
                    : `<span class="history-thumb" aria-hidden="true">AI</span>`
                }
                <span class="history-meta">
                  <span class="history-name">${escapeHtml(item.data?.ten_dia_diem || "Kết quả nhận diện")}</span>
                  <span class="history-sub tabular-nums">${subText}</span>
                </span>
              </button>
              <button type="button" class="history-del-btn" data-del-id="${item.id}" aria-label="Xóa ${escapeHtml(item.data?.ten_dia_diem || "mục này")}">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
              </button>
            </li>
          `;
        })
        .join("")}
    </ul>
  `;

  container.querySelectorAll("[data-open-id]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = Number(btn.dataset.openId);
      const item = loadHistory().find((x) => x.id === id);
      if (item) renderDetailView(item.data, item.time, item.thumb, true);
    });
  });

  container.querySelectorAll("[data-del-id]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = Number(btn.dataset.delId);
      const next = loadHistory().filter((x) => x.id !== id);
      saveHistoryList(next);
      renderHomeDashboard();
    });
  });
}

function updateLastThumbPreview() {
  const list = loadHistory();
  const img = document.getElementById("lastThumbImg");
  const icon = document.getElementById("lastThumbIcon");
  if (list.length && list[0].thumb) {
    img.src = list[0].thumb;
    img.hidden = false;
    icon.hidden = true;
  } else {
    img.hidden = true;
    icon.hidden = false;
  }
}

// ==========================================
// 3. CAMERA (LUÔN FULL MÀN HÌNH TRÊN IOS) & GPS
// ==========================================
function recreateVideoElement() {
  if (!video || !video.parentNode) return;
  const fresh = document.createElement("video");
  fresh.id = "camera";
  fresh.autoplay = true;
  fresh.playsInline = true;
  fresh.muted = true;
  fresh.setAttribute("autoplay", "");
  fresh.setAttribute("playsinline", "");
  fresh.setAttribute("muted", "");
  video.parentNode.replaceChild(fresh, video);
  video = fresh;
}

async function startCamera() {
  cameraErrorBanner.hidden = true;
  stopCamera();
  recreateVideoElement();

  const session = ++cameraSessionId;

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false
    });

    if (session !== cameraSessionId || activeView !== "scanner") {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }

    currentStream = stream;
    video.srcObject = currentStream;
    video.onloadedmetadata = () => {
      video.play().catch(() => {});
    };
    video.play().catch(() => {});
  } catch (_) {
    if (session === cameraSessionId) {
      cameraErrorBanner.textContent = "Không mở được camera. Bạn có thể bấm nút Thư viện bên dưới để chọn ảnh có sẵn.";
      cameraErrorBanner.hidden = false;
    }
  }
}

function stopCamera() {
  cameraSessionId++;
  if (currentStream) {
    currentStream.getTracks().forEach((t) => t.stop());
    currentStream = null;
  }
  if (video) {
    video.pause();
    video.srcObject = null;
  }
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    stopSpeaking();
    resetAudioContext();
  } else {
    if (activeView === "scanner") {
      const track = currentStream?.getVideoTracks?.()[0];
      if (!track || track.readyState === "ended") startCamera();
      else if (video && video.paused) video.play().catch(() => {});
    }
  }
});

window.addEventListener("pagehide", () => {
  stopSpeaking();
  resetAudioContext();
});

function initGPS() {
  if (!navigator.geolocation) {
    gpsText.textContent = "Đà Nẵng – Hội An";
    return;
  }
  navigator.geolocation.watchPosition(
    (pos) => {
      currentCoords.lat = pos.coords.latitude;
      currentCoords.lng = pos.coords.longitude;
      gpsDot.classList.add("ready");
      gpsText.textContent = `${currentCoords.lat.toFixed(4)}, ${currentCoords.lng.toFixed(4)}`;
    },
    () => {
      gpsText.textContent = "Đà Nẵng – Hội An";
    },
    { enableHighAccuracy: true, maximumAge: 15000, timeout: 10000 }
  );
}

// ==========================================
// 4. THỜI TIẾT ĐÀ NẴNG – HỘI AN (7 NGÀY + BIỂU ĐỒ MƯA) & CHATBOT
// ==========================================
const WEATHER_CITIES = {
  danang: { id: "danang", name: "Đà Nẵng", lat: 16.0544, lng: 108.2022 },
  hoian: { id: "hoian", name: "Hội An", lat: 15.8801, lng: 108.338 }
};

let weatherState = {
  cityId: "hoian",
  selectedDayIdx: 0,
  cache: {}
};

function interpretWeatherCode(code) {
  if (code === 0) return "Trời quang đãng";
  if ([1, 2].includes(code)) return "Ít mây, khô ráo";
  if (code === 3) return "Nhiều mây";
  if ([45, 48].includes(code)) return "Có sương mù";
  if ([51, 53, 55].includes(code)) return "Mưa phùn nhẹ";
  if ([61, 63, 80, 81].includes(code)) return "Có mưa rào";
  if ([65, 82].includes(code)) return "Mưa to";
  if ([95, 96, 99].includes(code)) return "Mưa dông";
  return "Thời tiết ổn định";
}

function isRainWeatherCode(code) {
  return [51, 53, 55, 61, 63, 65, 80, 81, 82, 95, 96, 99].includes(code);
}

function getWindDirectionLabel(deg) {
  const dirs = ["B", "ĐB", "Đ", "ĐN", "N", "TN", "T", "TB"];
  const n = Number(deg);
  if (!Number.isFinite(n)) return "ĐB";
  return dirs[Math.round((n % 360) / 45) % 8];
}

function formatIsoTimeHHMM(isoStr) {
  if (!isoStr || !String(isoStr).includes("T")) return "--:--";
  return String(isoStr).split("T")[1].slice(0, 5);
}

function getVnWeekdayShort(dateStr, idx) {
  if (idx === 0) return "H.nay";
  const d = new Date(`${dateStr}T12:00:00`);
  const labels = ["CN", "T2", "T3", "T4", "T5", "T6", "T7"];
  return labels[d.getDay()] || dateStr.slice(5);
}

function getVnWeekdayLong(dateStr, idx) {
  if (idx === 0) return "Hôm nay";
  const d = new Date(`${dateStr}T12:00:00`);
  const labels = ["Chủ nhật", "Thứ 2", "Thứ 3", "Thứ 4", "Thứ 5", "Thứ 6", "Thứ 7"];
  return labels[d.getDay()] || dateStr;
}

function getWeatherIconSvg(code, size = 28, isDay = 1) {
  const storm = [95, 96, 99].includes(code);
  const rain = [51, 53, 55, 61, 63, 65, 80, 81, 82].includes(code);
  const cloudy = [3, 45, 48].includes(code);
  const partly = [1, 2].includes(code);

  if (storm) {
    return `<svg class="wx-anim-icon wx-is-storm" width="${size}" height="${size}" viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <path class="wx-cloud" d="M9 21h14a5 5 0 0 0 .8-9.94A7 7 0 0 0 10.2 9.4 4.5 4.5 0 0 0 9 21Z" fill="#CBD5E1"/>
      <path class="wx-bolt" d="M16 19l-2.5 5h2.4l-1.1 4.5L20 22h-2.5L19 19h-3Z" fill="#FACC15"/>
      <path class="wx-drop wx-drop-1" d="M10.5 23l-1 3.5" stroke="#38BDF8" stroke-width="2" stroke-linecap="round"/>
      <path class="wx-drop wx-drop-2" d="M22 23l-1 3.5" stroke="#38BDF8" stroke-width="2" stroke-linecap="round"/>
    </svg>`;
  }
  if (rain) {
    return `<svg class="wx-anim-icon wx-is-rain" width="${size}" height="${size}" viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <path class="wx-cloud" d="M9 20h14a5 5 0 0 0 .8-9.94A7 7 0 0 0 10.2 8.4 4.5 4.5 0 0 0 9 20Z" fill="#E2E8F0"/>
      <path class="wx-drop wx-drop-1" d="M11 22.5l-1.2 4" stroke="#38BDF8" stroke-width="2.2" stroke-linecap="round"/>
      <path class="wx-drop wx-drop-2" d="M16 22.5l-1.2 4" stroke="#38BDF8" stroke-width="2.2" stroke-linecap="round"/>
      <path class="wx-drop wx-drop-3" d="M21 22.5l-1.2 4" stroke="#38BDF8" stroke-width="2.2" stroke-linecap="round"/>
    </svg>`;
  }
  if (cloudy) {
    return `<svg class="wx-anim-icon wx-is-cloudy" width="${size}" height="${size}" viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <path class="wx-cloud" d="M8.5 23h15a5 5 0 0 0 .7-9.95A7.2 7.2 0 0 0 10 11.4 4.8 4.8 0 0 0 8.5 23Z" fill="#CBD5E1"/>
    </svg>`;
  }
  if (partly) {
    return `<svg class="wx-anim-icon wx-is-partly" width="${size}" height="${size}" viewBox="0 0 32 32" fill="none" aria-hidden="true">
      ${
        isDay
          ? `<circle class="wx-sun-orb" cx="20.5" cy="11.5" r="5" fill="#FBBF24"/>`
          : `<path class="wx-moon-orb" d="M22.5 7.5a5.2 5.2 0 1 0 3.2 9.3A5.8 5.8 0 0 1 22.5 7.5Z" fill="#E2E8F0"/>`
      }
      <path class="wx-cloud" d="M8 24h14a4.5 4.5 0 0 0 .6-8.96A6.2 6.2 0 0 0 10.4 13.8 4.2 4.2 0 0 0 8 24Z" fill="#F8FAFC"/>
    </svg>`;
  }
  return `<svg class="wx-anim-icon wx-is-clear" width="${size}" height="${size}" viewBox="0 0 32 32" fill="none" aria-hidden="true">
    ${
      isDay
        ? `<g class="wx-sun-spin">
             <circle cx="16" cy="16" r="6.5" fill="#FBBF24"/>
             <path d="M16 4v3M16 25v3M4 16h3M25 16h3M7.5 7.5l2.2 2.2M22.3 22.3l2.2 2.2M24.5 7.5l-2.2 2.2M9.7 22.3l-2.2 2.2" stroke="#FBBF24" stroke-width="2" stroke-linecap="round"/>
           </g>`
        : `<path class="wx-moon-orb" d="M19.5 7.2a8.5 8.5 0 1 0 5.3 15.1A9.2 9.2 0 0 1 19.5 7.2Z" fill="#E2E8F0"/>`
    }
  </svg>`;
}

function buildSmoothWavePaths(points, baseY) {
  if (!points.length) return { line: "", area: "" };
  let line = `M ${points[0].x.toFixed(1)} ${points[0].y.toFixed(1)}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] || points[i];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2] || p2;

    const cp1x = p1.x + (p2.x - p0.x) / 6;
    const cp1y = Math.min(baseY, Math.max(24, p1.y + (p2.y - p0.y) / 6));
    const cp2x = p2.x - (p3.x - p1.x) / 6;
    const cp2y = Math.min(baseY, Math.max(24, p2.y - (p3.y - p1.y) / 6));

    line += ` C ${cp1x.toFixed(1)} ${cp1y.toFixed(1)}, ${cp2x.toFixed(1)} ${cp2y.toFixed(1)}, ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`;
  }
  const last = points[points.length - 1];
  const area = `${line} L ${last.x.toFixed(1)} ${baseY} L ${points[0].x.toFixed(1)} ${baseY} Z`;
  return { line, area };
}

function pickHourlyRainSlots(hourly, dateStr, isToday) {
  const times = hourly?.time || [];
  const precips = hourly?.precipitation || [];
  const probs = hourly?.precipitation_probability || [];
  const winds = hourly?.wind_speed_10m || [];
  const windDirs = hourly?.wind_direction_10m || [];

  const dayIndices = [];
  for (let i = 0; i < times.length; i++) {
    if (String(times[i]).startsWith(dateStr)) dayIndices.push(i);
  }
  if (!dayIndices.length) return [];

  let chosen = [];
  if (isToday) {
    const curHour = new Date().getHours();
    const startPos = Math.max(0, Math.min(dayIndices.length - 6, curHour));
    chosen = dayIndices.slice(startPos, startPos + 6);
  } else {
    const baseHours = [6, 9, 12, 15, 18, 21];
    let peakIdx = dayIndices[0];
    let peakScore = -1;
    dayIndices.forEach((idx) => {
      const score = (precips[idx] || 0) * 100 + (probs[idx] || 0);
      if (score > peakScore) {
        peakScore = score;
        peakIdx = idx;
      }
    });

    chosen = baseHours.map((h) => dayIndices[Math.min(dayIndices.length - 1, h)]);
    if (!chosen.includes(peakIdx)) {
      const peakHour = Number(String(times[peakIdx]).slice(11, 13)) || 12;
      let nearestSlot = 0;
      let minDiff = 99;
      baseHours.forEach((h, slotIdx) => {
        if (Math.abs(h - peakHour) < minDiff) {
          minDiff = Math.abs(h - peakHour);
          nearestSlot = slotIdx;
        }
      });
      chosen[nearestSlot] = peakIdx;
    }
  }

  return chosen.map((idx, pos) => {
    const hhmm = formatIsoTimeHHMM(times[idx]);
    return {
      label: isToday && pos === 0 ? "Bây giờ" : hhmm,
      time: hhmm,
      mm: Number((precips[idx] ?? 0).toFixed(1)),
      prob: Math.round(probs[idx] ?? 0),
      wind: Math.round(winds[idx] ?? 0),
      windDir: windDirs[idx] ?? 45
    };
  });
}

function renderWeatherContent(data, city) {
  const body = document.getElementById("weatherBody");
  const cur = data.current || {};
  const daily = data.daily || {};
  const hourly = data.hourly || {};

  const dayTimes = daily.time || [];
  const selIdx = Math.min(Math.max(0, weatherState.selectedDayIdx), Math.max(0, dayTimes.length - 1));
  const isToday = selIdx === 0;
  const selDate = dayTimes[selIdx] || "";

  const selCode = isToday ? (cur.weather_code ?? daily.weather_code?.[0] ?? 0) : (daily.weather_code?.[selIdx] ?? 0);
  const selTemp = isToday
    ? Math.round(cur.temperature_2m ?? daily.temperature_2m_max?.[0] ?? 26)
    : Math.round(((daily.temperature_2m_max?.[selIdx] ?? 28) + (daily.temperature_2m_min?.[selIdx] ?? 22)) / 2);
  const selHi = Math.round(daily.temperature_2m_max?.[selIdx] ?? selTemp);
  const selLo = Math.round(daily.temperature_2m_min?.[selIdx] ?? selTemp - 4);
  const selWind = Math.round(isToday ? (cur.wind_speed_10m ?? 10) : (daily.wind_speed_10m_max?.[selIdx] ?? 12));
  const selWindDeg = cur.wind_direction_10m ?? 45;
  const selHumidity = Math.round(cur.relative_humidity_2m ?? 78);
  const selSunrise = formatIsoTimeHHMM(daily.sunrise?.[selIdx]);
  const selSunset = formatIsoTimeHHMM(daily.sunset?.[selIdx]);
  const selRainProb = Math.round(daily.precipitation_probability_max?.[selIdx] ?? 0);
  const selRainSum = Number((daily.precipitation_sum?.[selIdx] ?? 0).toFixed(1));
  const isDayFlag = isToday ? (cur.is_day ?? 1) : 1;

  const rainDays = [];
  const dryDays = [];
  dayTimes.forEach((dt, i) => {
    const prob = Math.round(daily.precipitation_probability_max?.[i] ?? 0);
    const sum = Number(daily.precipitation_sum?.[i] ?? 0);
    const rainy = prob >= 45 || sum >= 1 || isRainWeatherCode(daily.weather_code?.[i]);
    const lbl = getVnWeekdayShort(dt, i);
    if (rainy) rainDays.push(lbl);
    else dryDays.push(lbl);
  });

  const summaryLine =
    `7 ngày tới tại ${city.name}: ` +
    (rainDays.length ? `Mưa ${rainDays.length} ngày (${rainDays.join(", ")})` : "Không có ngày mưa lớn") +
    ` • ` +
    (dryDays.length ? `Khô ráo ${dryDays.length} ngày (${dryDays.join(", ")})` : "Mưa rải rác cả tuần");

  const nowStr = new Date().toLocaleString("vi-VN", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });

  const daysHtml = dayTimes
    .slice(0, 7)
    .map((dt, i) => {
      const code = daily.weather_code?.[i] ?? 0;
      const hi = Math.round(daily.temperature_2m_max?.[i] ?? 28);
      const lo = Math.round(daily.temperature_2m_min?.[i] ?? 22);
      const prob = Math.round(daily.precipitation_probability_max?.[i] ?? 0);
      const sum = Number(daily.precipitation_sum?.[i] ?? 0);
      const rainy = prob >= 45 || sum >= 1 || isRainWeatherCode(code);
      const dayShort = getVnWeekdayShort(dt, i);
      const dayLong = getVnWeekdayLong(dt, i);
      const active = i === selIdx;

      return `
        <button
          type="button"
          class="wx-day-btn"
          data-wx-day="${i}"
          aria-pressed="${active ? "true" : "false"}"
          aria-label="${dayLong}, cao ${hi} độ, thấp ${lo} độ, ${rainy ? `có mưa ${prob}%` : "không mưa"}"
        >
          <span class="wx-day-name">${dayShort}</span>
          <span class="wx-day-icon">${getWeatherIconSvg(code, 26, 1)}</span>
          <span class="wx-day-temps tabular-nums">
            <span class="wx-day-hi">${hi}°</span>
            <span class="wx-day-lo">${lo}°</span>
          </span>
          <span class="wx-day-rain-tag tabular-nums ${rainy ? "is-rain" : "is-dry"}">
            ${rainy ? `${prob}%` : "Khô"}
          </span>
        </button>
      `;
    })
    .join("");

  const slots = pickHourlyRainSlots(hourly, selDate, isToday);
  const svgW = 360;
  const svgH = 112;
  const baseY = 104;
  const topY = 34;

  const maxMm = slots.length ? Math.max(0, ...slots.map((s) => s.mm)) : 0;
  const useMmScale = maxMm >= 0.2;
  const scaleMax = useMmScale
    ? Math.max(maxMm, 1.5)
    : Math.max(100, ...(slots.length ? slots.map((s) => s.prob) : [100]));

  let peakSlotIdx = 0;
  let secondSlotIdx = -1;
  slots.forEach((s, i) => {
    const val = useMmScale ? s.mm : s.prob;
    const peakVal = useMmScale ? slots[peakSlotIdx].mm : slots[peakSlotIdx].prob;
    if (val > peakVal) peakSlotIdx = i;
  });

  if (slots.length >= 4) {
    let bestAltVal = 0;
    slots.forEach((s, i) => {
      if (Math.abs(i - peakSlotIdx) < 2) return;
      const val = useMmScale ? s.mm : s.prob;
      if (val > bestAltVal && (useMmScale ? s.mm >= 0.2 : s.prob >= 25)) {
        bestAltVal = val;
        secondSlotIdx = i;
      }
    });
  }

  const chartPoints = slots.map((s, i) => {
    const x = slots.length > 1 ? 14 + (i * (svgW - 28)) / (slots.length - 1) : svgW / 2;
    const rawVal = useMmScale ? s.mm : s.prob;
    const ratio = scaleMax > 0 ? Math.min(1, rawVal / scaleMax) : 0;
    const y = baseY - 12 - ratio * (baseY - 12 - topY);
    return { x, y, slot: s };
  });

  const { line: waveLine, area: waveArea } = buildSmoothWavePaths(chartPoints, baseY);

  const highlightIndices = slots.length ? [peakSlotIdx] : [];
  if (secondSlotIdx !== -1) highlightIndices.push(secondSlotIdx);

  const markersSvg = highlightIndices
    .map((idx) => {
      const pt = chartPoints[idx];
      if (!pt) return "";
      const isPeak = idx === peakSlotIdx;
      const labelText = useMmScale
        ? `${pt.slot.mm.toFixed(1).replace(".", ",")} mm`
        : `${pt.slot.prob}%`;
      const pillW = Math.max(48, labelText.length * 7.2 + 14);
      const pillX = Math.min(svgW - pillW - 4, Math.max(4, pt.x - pillW / 2));
      const pillY = Math.max(4, pt.y - 29);

      return `
        <g>
          <rect x="${pillX.toFixed(1)}" y="${pillY.toFixed(1)}" width="${pillW.toFixed(1)}" height="20" rx="6"
            fill="${isPeak ? "rgba(255,255,255,0.22)" : "rgba(255,255,255,0.14)"}" />
          <text x="${(pillX + pillW / 2).toFixed(1)}" y="${(pillY + 13.5).toFixed(1)}"
            text-anchor="middle" fill="#FFFFFF" font-size="11" font-weight="${isPeak ? "700" : "500"}">
            ${labelText}
          </text>
          <circle cx="${pt.x.toFixed(1)}" cy="${pt.y.toFixed(1)}" r="4.5" fill="#141926" stroke="#7DD3FC" stroke-width="2.5"/>
        </g>
      `;
    })
    .join("");

  const peakSlot = slots[peakSlotIdx] || { time: "--:--", mm: 0, prob: selRainProb };
  const peakBannerText =
    peakSlot.mm > 0
      ? `Mưa cao nhất lúc ${peakSlot.time}: ${peakSlot.mm.toFixed(1).replace(".", ",")} mm (${peakSlot.prob}%)`
      : peakSlot.prob >= 35
      ? `Khả năng mưa cao nhất lúc ${peakSlot.time} (${peakSlot.prob}%)`
      : `Không có mưa đáng kể trong khung giờ này (${getVnWeekdayLong(selDate, selIdx)})`;

  const windDirText = getWindDirectionLabel(selWindDeg);

  let advice = `${getVnWeekdayLong(selDate, selIdx)} tại ${city.name} tỷ lệ mưa thấp (${selRainProb}%), rất thích hợp dạo phố cổ, đi biển và chụp ảnh ngoài trời.`;
  if (selRainProb >= 65 || selRainSum >= 8) {
    advice = `${getVnWeekdayLong(selDate, selIdx)} tại ${city.name} khả năng mưa cao (${selRainProb}%, tổng ~${selRainSum.toFixed(1).replace(".", ",")} mm). Nên ưu tiên quán cà phê, bảo tàng hoặc workshop trong nhà.`;
  } else if (selRainProb >= 35 || selRainSum >= 1) {
    advice = `${getVnWeekdayLong(selDate, selIdx)} tại ${city.name} có khả năng mưa rải rác (${selRainProb}%). Bạn nên mang theo dù hoặc áo mưa mỏng khi di chuyển.`;
  }

  body.innerHTML = `
    <div class="wx-stack">
      <section class="wx-hero-card" aria-label="Tổng quan và dự báo 7 ngày tại ${escapeHtml(city.name)}">
        <div class="wx-current-panel">
          <div class="wx-current-top">
            <div class="wx-main-icon">${getWeatherIconSvg(selCode, 60, isDayFlag)}</div>
            <div class="wx-temp-wrap">
              <div class="wx-temp-main tabular-nums">${selTemp}°C</div>
              <div class="wx-temp-hl tabular-nums">
                <span>C ${selHi}°</span>
                <span>•</span>
                <span>T ${selLo}°</span>
              </div>
            </div>
          </div>

          <div class="wx-current-mid">
            <div>
              <h3 class="wx-cond-title">${escapeHtml(interpretWeatherCode(selCode))}</h3>
              <p class="wx-cond-sub tabular-nums">${escapeHtml(getVnWeekdayLong(selDate, selIdx))} • Mưa ${selRainProb}%</p>
            </div>
            <div class="wx-sun-times tabular-nums">
              <div class="wx-sun-row">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#FBBF24" stroke-width="2" aria-hidden="true"><path d="M12 2v4M4.93 10.93l1.41 1.41M2 18h20M19.07 10.93l-1.41 1.41M16 18a4 4 0 0 0-8 0"/></svg>
                <span>${selSunrise}</span>
              </div>
              <div class="wx-sun-row">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#FB923C" stroke-width="2" aria-hidden="true"><path d="M12 10V2M4.93 10.93l1.41 1.41M2 18h20M19.07 10.93l-1.41 1.41M16 18a4 4 0 0 0-8 0"/></svg>
                <span>${selSunset}</span>
              </div>
            </div>
          </div>

          <div class="wx-current-metrics">
            <div class="wx-metric-item">
              <svg class="wx-metric-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M9.59 4.59A2 2 0 1 1 11 8H2m10.59 11.41A2 2 0 1 0 14 16H2m15.73-8.27A2.5 2.5 0 1 1 19.5 12H2"/></svg>
              <div>
                <span class="wx-metric-label">Gió</span>
                <span class="wx-metric-val tabular-nums">${selWind} km/h</span>
              </div>
            </div>
            <div class="wx-metric-item">
              <svg class="wx-metric-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z"/></svg>
              <div>
                <span class="wx-metric-label">Độ ẩm</span>
                <span class="wx-metric-val tabular-nums">${selHumidity}%</span>
              </div>
            </div>
          </div>
        </div>

        <div class="wx-forecast-panel">
          <div class="wx-forecast-head">
            <div class="wx-city-switch" role="group" aria-label="Chọn khu vực Đà Nẵng hoặc Hội An">
              <button type="button" class="wx-city-btn" data-wx-city="hoian" aria-pressed="${city.id === "hoian" ? "true" : "false"}">Hội An</button>
              <button type="button" class="wx-city-btn" data-wx-city="danang" aria-pressed="${city.id === "danang" ? "true" : "false"}">Đà Nẵng</button>
            </div>
            <span class="wx-updated-time tabular-nums">${nowStr}</span>
          </div>

          <p class="wx-rain-summary">${escapeHtml(summaryLine)}</p>

          <div class="wx-days-grid">
            ${daysHtml}
          </div>
        </div>
      </section>

      <section class="wx-rain-card" aria-label="Biểu đồ lượng mưa theo giờ tại ${escapeHtml(city.name)}">
        <div class="wx-rain-top">
          <div>
            <div class="wx-rain-loc">${escapeHtml(city.name)}</div>
            <div class="wx-rain-temp-row tabular-nums">
              <span class="wx-rain-temp">${selTemp}°</span>
              <span class="wx-rain-hl">
                <span>${selHi}°</span>
                <span>${selLo}°</span>
              </span>
            </div>
          </div>

          <div class="wx-rain-wind">
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#4ADE80" stroke-width="2" stroke-linecap="round" aria-hidden="true">
              <path d="M9.59 4.59A2 2 0 1 1 11 8H2m10.59 11.41A2 2 0 1 0 14 16H2m15.73-8.27A2.5 2.5 0 1 1 19.5 12H2"/>
            </svg>
            <div class="wx-wind-meta tabular-nums">
              <span class="wx-wind-dir">
                ${windDirText}
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" style="transform:rotate(${Math.round(selWindDeg)}deg)" aria-hidden="true">
                  <circle cx="12" cy="12" r="10"/><path d="M12 8v8m0 0-3-3m3 3 3-3"/>
                </svg>
              </span>
              <span class="wx-wind-spd">${selWind} km/h</span>
            </div>
          </div>

          <div class="wx-rain-status-icon">${getWeatherIconSvg(selCode, 40, isDayFlag)}</div>
        </div>

        <div class="wx-peak-banner tabular-nums">
          <span>${escapeHtml(peakBannerText)}</span>
        </div>

        <div class="wx-chart-wrap">
          <svg class="wx-chart-svg" viewBox="0 0 ${svgW} ${svgH}" role="img" aria-label="${escapeHtml(peakBannerText)}">
            <defs>
              <linearGradient id="wxWaveFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stop-color="#38BDF8" stop-opacity="0.45"/>
                <stop offset="100%" stop-color="#38BDF8" stop-opacity="0.02"/>
              </linearGradient>
            </defs>
            <path d="${waveArea}" fill="url(#wxWaveFill)" />
            <path d="${waveLine}" fill="none" stroke="#60A5FA" stroke-width="2.5" stroke-linecap="round" />
            ${markersSvg}
          </svg>
          <div class="wx-chart-times tabular-nums">
            ${slots.map((s) => `<span>${escapeHtml(s.label)}</span>`).join("")}
          </div>
        </div>
      </section>

      <div class="wx-advice-card">
        <strong>Gợi ý di chuyển:</strong> ${escapeHtml(advice)}
      </div>
    </div>
  `;

  body.querySelectorAll("[data-wx-city]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const nextCity = btn.dataset.wxCity;
      if (nextCity && WEATHER_CITIES[nextCity] && nextCity !== weatherState.cityId) {
        weatherState.cityId = nextCity;
        renderWeatherView(false);
      }
    });
  });

  body.querySelectorAll("[data-wx-day]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const idx = Number(btn.dataset.wxDay);
      if (Number.isFinite(idx) && idx !== weatherState.selectedDayIdx) {
        weatherState.selectedDayIdx = idx;
        renderWeatherContent(data, city);
      }
    });
  });
}

async function renderWeatherView(forceRefresh = false) {
  const body = document.getElementById("weatherBody");
  const city = WEATHER_CITIES[weatherState.cityId] || WEATHER_CITIES.hoian;
  const cached = weatherState.cache[city.id];

  if (!forceRefresh && cached && Date.now() - cached.fetchedAt < 5 * 60 * 1000) {
    renderWeatherContent(cached.data, city);
    return;
  }

  body.setAttribute("aria-busy", "true");
  body.innerHTML = `<div class="wx-stack"><div class="wx-skeleton"></div><div class="wx-skeleton" style="height:160px"></div></div>`;

  try {
    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${city.lat}&longitude=${city.lng}` +
      `&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m,wind_direction_10m,is_day` +
      `&hourly=temperature_2m,precipitation,precipitation_probability,weather_code,wind_speed_10m,wind_direction_10m` +
      `&daily=weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset,precipitation_probability_max,precipitation_sum,wind_speed_10m_max` +
      `&timezone=Asia%2FBangkok&forecast_days=7`;

    const res = await fetch(url);
    if (!res.ok) throw new Error("Không tải được dữ liệu thời tiết.");
    const data = await res.json();

    weatherState.cache[city.id] = { data, fetchedAt: Date.now() };
    renderWeatherContent(data, city);
  } catch (err) {
    body.innerHTML = `
      <div class="error-panel">
        Không lấy được thời tiết ${escapeHtml(city.name)}: ${escapeHtml(err.message)}
        <div style="margin-top:10px">
          <button type="button" class="btn-pill btn-primary" id="wxRetryBtn">Thử tải lại</button>
        </div>
      </div>
    `;
    const retryBtn = document.getElementById("wxRetryBtn");
    if (retryBtn) retryBtn.addEventListener("click", () => renderWeatherView(true));
  } finally {
    body.setAttribute("aria-busy", "false");
  }
}

function renderChatView() {
  const box = document.getElementById("chatBox");
  box.innerHTML = chatHistory
    .map(
      (m) =>
        `<div class="chat-msg ${m.role === "user" ? "user" : "bot"}">${escapeHtml(m.content).replace(/\n/g, "<br>")}</div>`
    )
    .join("");
  box.scrollTop = box.scrollHeight;
}

document.getElementById("chatForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (isChatSending) return;

  const input = document.getElementById("chatInput");
  const text = input.value.trim();
  if (!text) return;

  isChatSending = true;
  chatHistory.push({ role: "user", content: text });
  input.value = "";
  renderChatView();

  const box = document.getElementById("chatBox");
  const typing = document.createElement("div");
  typing.className = "chat-msg bot";
  typing.textContent = "Đang trả lời...";
  box.appendChild(typing);
  box.scrollTop = box.scrollHeight;

  try {
    const locationContext = currentCoords.lat
      ? `GPS(${currentCoords.lat.toFixed(4)}, ${currentCoords.lng.toFixed(4)}) - Hội An & Đà Nẵng`
      : "Hội An – Đà Nẵng";

    const latestScan = lastScanData || loadHistory()[0]?.data || null;

    const { data } = await fetchApiWithRetry(
      {
        mode: "chat",
        messages: chatHistory.slice(-10),
        locationContext,
        lastScan: latestScan
      },
      { timeoutMs: 11000, maxRetries: 1 }
    );

    chatHistory.push({
      role: "assistant",
      content: data.reply || data.error || "Mình chưa nhận được phản hồi, bạn thử lại nhé."
    });
  } catch (err) {
    chatHistory.push({
      role: "assistant",
      content: "Lỗi kết nối: " + (err?.message || "Mạng không ổn định")
    });
  } finally {
    isChatSending = false;
    renderChatView();
  }
});

// ==========================================
// 5. GIỌNG ĐỌC HOÀI MY NEURAL (CHỈ TẢI KHI BẤM – GIẢM 50% TẢI SERVER)
// ==========================================
function normalizeTtsText(text) {
  return String(text || "").replace(/[*#_•]/g, " ").replace(/\s+/g, " ").trim();
}

function base64ToArrayBuffer(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function getOrFetchTtsBuffer(cleanText) {
  if (ttsBufferCache.has(cleanText)) return ttsBufferCache.get(cleanText);

  const promise = fetch("/api/scan", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "tts", text: cleanText })
  })
    .then(async (res) => {
      const data = await res.json();
      if (res.ok && data.audioBase64) return base64ToArrayBuffer(data.audioBase64);
      throw new Error(data.ttsError || "Không tải được âm thanh");
    })
    .catch((err) => {
      ttsBufferCache.delete(cleanText);
      throw err;
    });

  if (ttsBufferCache.size >= 10) {
    const firstKey = ttsBufferCache.keys().next().value;
    ttsBufferCache.delete(firstKey);
  }
  ttsBufferCache.set(cleanText, promise);
  return promise;
}

function resetAudioContext() {
  audioNeedsReset = true;
  if (audioCtx) {
    const oldCtx = audioCtx;
    audioCtx = null;
    try {
      if (oldCtx.state !== "closed") oldCtx.close().catch(() => {});
    } catch (_) {}
  }
}

function unlockAudioContext() {
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) return null;

  if (
    !audioCtx ||
    audioNeedsReset ||
    audioCtx.state === "closed" ||
    audioCtx.state === "interrupted"
  ) {
    if (audioCtx && audioCtx.state !== "closed") {
      try { audioCtx.close().catch(() => {}); } catch (_) {}
    }
    audioCtx = new AudioCtx();
    audioNeedsReset = false;
  }

  if (audioCtx.state !== "running") {
    audioCtx.resume().catch(() => {});
  }

  try {
    const silent = audioCtx.createBuffer(1, 1, 22050);
    const src = audioCtx.createBufferSource();
    src.buffer = silent;
    src.connect(audioCtx.destination);
    src.start(0);
  } catch (_) {}

  return audioCtx;
}

function decodeAudio(ctx, arrayBuffer) {
  return new Promise((resolve, reject) => {
    ctx.decodeAudioData(arrayBuffer.slice(0), resolve, reject);
  });
}

function playViaHtmlAudio(buffer, session) {
  return new Promise((resolve, reject) => {
    try {
      const blob = new Blob([buffer], { type: "audio/mpeg" });
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audio.playsInline = true;
      activeHtmlAudio = audio;
      activeAudioUrl = url;

      audio.onended = () => {
        if (session === speechSessionId) {
          stopSpeaking();
        }
      };
      audio.onerror = () => {
        if (session === speechSessionId) stopSpeaking();
        reject(new Error("Audio playback failed"));
      };

      updateSpeakButton(true);
      audio.play().then(resolve).catch(reject);
    } catch (err) {
      reject(err);
    }
  });
}

function updateSpeakButton(playing) {
  const btn = document.getElementById("speakBtn");
  if (!btn) return;
  btn.textContent = playing ? "Dừng thuyết minh" : "Nghe thuyết minh";
}

function stopSpeaking() {
  speechSessionId++;
  isSpeaking = false;
  if (activeSource) {
    try {
      activeSource.onended = null;
      activeSource.stop();
    } catch (_) {}
    activeSource = null;
  }
  if (activeHtmlAudio) {
    try {
      activeHtmlAudio.onended = null;
      activeHtmlAudio.onerror = null;
      activeHtmlAudio.pause();
      activeHtmlAudio.src = "";
    } catch (_) {}
    activeHtmlAudio = null;
  }
  if (activeAudioUrl) {
    try { URL.revokeObjectURL(activeAudioUrl); } catch (_) {}
    activeAudioUrl = null;
  }
  updateSpeakButton(false);
}

async function speakText(text) {
  if (isSpeaking) {
    stopSpeaking();
    return;
  }
  const cleanText = normalizeTtsText(text);
  if (!cleanText) return;

  const ctx = unlockAudioContext();
  const session = ++speechSessionId;
  isSpeaking = true;
  const btn = document.getElementById("speakBtn");
  if (btn) btn.textContent = "Đang tải giọng...";

  try {
    const buffer = await getOrFetchTtsBuffer(cleanText);
    if (session !== speechSessionId) return;

    if (ctx) {
      if (ctx.state !== "running") {
        await ctx.resume().catch(() => {});
      }
      if (ctx.state === "running") {
        const decoded = await decodeAudio(ctx, buffer);
        if (session !== speechSessionId) return;

        const source = ctx.createBufferSource();
        source.buffer = decoded;
        source.connect(ctx.destination);
        activeSource = source;

        updateSpeakButton(true);
        source.onended = () => {
          if (session === speechSessionId) {
            activeSource = null;
            isSpeaking = false;
            updateSpeakButton(false);
          }
        };
        source.start(0);
        return;
      }
    }

    await playViaHtmlAudio(buffer, session);
  } catch (_) {
    if (session === speechSessionId) {
      stopSpeaking();
      resetAudioContext();
      if (btn) {
        btn.textContent = "Thử nghe lại";
        setTimeout(() => {
          if (!isSpeaking) updateSpeakButton(false);
        }, 2200);
      }
    }
  }
}

// ==========================================
// 6. QUÉT ẢNH TỐC ĐỘ CAO & HIỂN THỊ MÀN HÌNH CHI TIẾT
// ==========================================
function makeThumbnail(sourceCanvas) {
  try {
    const thumbCanvas = document.createElement("canvas");
    const maxW = 360;
    const scale = Math.min(1, maxW / sourceCanvas.width);
    thumbCanvas.width = Math.round(sourceCanvas.width * scale);
    thumbCanvas.height = Math.round(sourceCanvas.height * scale);
    thumbCanvas.getContext("2d").drawImage(sourceCanvas, 0, 0, thumbCanvas.width, thumbCanvas.height);
    return thumbCanvas.toDataURL("image/jpeg", 0.65);
  } catch (_) {
    return "";
  }
}

function setScanningLock(locked) {
  isScanning = locked;
  statusPill.classList.toggle("show", locked);
  const captureBtn = document.getElementById("captureBtn");
  const uploadBtn = document.getElementById("uploadBtn");
  if (captureBtn) captureBtn.disabled = locked;
  if (uploadBtn) uploadBtn.disabled = locked;
}

async function scanBase64(imageBase64, thumbDataUrl) {
  if (isScanning) return;
  const startTime = performance.now();
  setScanningLock(true);

  try {
    const modeHint = scanMode === "food"
      ? "Ưu tiên đong đếm calo từ nhãn hoặc nguyên liệu nhìn thấy rõ, tuyệt đối không bịa số. "
      : scanMode === "place"
      ? "Ưu tiên nhận diện chính xác địa điểm, logo trường học, thương hiệu, di tích. "
      : "";

    const locationContext = currentCoords.lat
      ? `${modeHint}GPS(${currentCoords.lat.toFixed(4)}, ${currentCoords.lng.toFixed(4)}) - Hội An & Đà Nẵng`
      : `${modeHint}Hội An – Đà Nẵng`;

    const { res, data } = await fetchApiWithRetry(
      {
        imageBase64,
        scanMode,
        lat: currentCoords.lat,
        lng: currentCoords.lng,
        locationContext
      },
      { timeoutMs: 14000, maxRetries: 1 }
    );

    const elapsed = ((performance.now() - startTime) / 1000).toFixed(1);

    if (!res.ok || data.error) {
      renderErrorDetail(data.debug || "", thumbDataUrl);
    } else {
      lastScanData = data;
      addToHistory(data, thumbDataUrl);
      renderDetailView(data, `${elapsed}s`, thumbDataUrl, false);
    }
  } catch (err) {
    renderErrorDetail(
      err?.name === "AbortError"
        ? "Quá thời gian phản hồi, bạn thử bấm Quét lại nhé"
        : (err?.message || "Lỗi kết nối mạng"),
      thumbDataUrl
    );
  } finally {
    setScanningLock(false);
  }
}

function setDetailHero(thumbDataUrl) {
  const img = document.getElementById("detailHeroImg");
  const placeholder = document.getElementById("detailHeroPlaceholder");
  if (thumbDataUrl) {
    img.src = thumbDataUrl;
    img.hidden = false;
    placeholder.hidden = true;
  } else {
    img.hidden = true;
    placeholder.hidden = false;
  }
}

function renderErrorDetail(debugMsg, thumbDataUrl) {
  stopCamera();
  setDetailHero(thumbDataUrl);
  const sheet = document.getElementById("detailSheet");
  sheet.innerHTML = `
    <div class="detail-pills"><span class="pill-tag">THỬ LẠI</span></div>
    <h2 class="detail-title">Chưa nhận diện được</h2>
    <div class="error-panel">
      ${FRIENDLY_ERROR_MSG}
      ${debugMsg ? `<div class="error-debug">Chi tiết: ${escapeHtml(debugMsg)}</div>` : ""}
    </div>
    <div class="detail-actions">
      <button type="button" class="btn-pill btn-secondary" id="errHomeBtn">Trang chủ</button>
      <button type="button" class="btn-pill btn-primary" id="errRetryBtn">Quét lại</button>
    </div>
  `;
  navigateTo("detail");
  document.getElementById("errHomeBtn").addEventListener("click", () => navigateTo("home"));
  document.getElementById("errRetryBtn").addEventListener("click", () => navigateTo("scanner"));
}

function getShortHealthStatus(healthText, isFood) {
  if (!isFood) return "N/A";
  const t = String(healthText || "").toLowerCase();
  if (/hạn chế|nhiều đường|nhiều dầu|calo cao|không tốt|cân nhắc/.test(t)) return "Vừa phải";
  if (/không áp dụng|chưa rõ|chưa đủ dữ liệu/.test(t)) return "N/A";
  return "Tốt";
}

function renderDetailView(data, timeOrElapsed, thumbDataUrl, fromHistory) {
  stopCamera();
  setDetailHero(thumbDataUrl);
  lastScanData = data;

  currentSpeechText = `${data.ten_dia_diem || ""}. ${data.cau_chuyen_lich_su || ""} ${data.giai_thoai_dac_biet || ""}`;

  const sp = data.thong_tin_san_pham;
  const loaiLower = String(data.loai_doi_tuong || "").toLowerCase();
  const isFoodOrDrink = /thức ăn|đồ uống|món ăn|nước uống|thực phẩm|bánh|trái cây/.test(loaiLower);
  const kcalNum = parseCalories(sp?.calo_uoc_tinh);

  const hasValidAddress = data.dia_chi && !/không áp dụng|chưa xác định/i.test(data.dia_chi);
  const highlightText = isFoodOrDrink && sp?.calo_uoc_tinh
    ? `🔥 Calo: ${sp.calo_uoc_tinh}`
    : (hasValidAddress ? `📍 ${data.dia_chi}` : "Đà Nẵng – Hội An");

  const providerBadge = data._cached
    ? " • FAST CACHE"
    : data._provider
    ? ` • ${escapeHtml(String(data._provider).split(":")[0].toUpperCase())}`
    : "";

  const verifiedPill = data._verified
    ? `<span class="pill-tag accent">✓ Đã xác thực</span>`
    : "";

  const healthLabel = getShortHealthStatus(sp?.tot_cho_suc_khoe, isFoodOrDrink);

  const ringBlock = sp && sp.hien_thi ? `
    <div class="ring-grid">
      <div class="ring-tile">
        <span class="ring-tile-label">Calo</span>
        <div class="ring-mini-wrap">
          <svg class="ring-mini-svg" viewBox="0 0 60 60" aria-hidden="true">
            <circle class="ring-mini-bg" cx="30" cy="30" r="24" />
            <circle cx="30" cy="30" r="24" fill="none" stroke="#94D82D" stroke-width="6" stroke-linecap="round" stroke-dasharray="150.8" stroke-dashoffset="${kcalNum > 0 ? 42 : 135}" />
          </svg>
          <span class="ring-mini-val tabular-nums">${kcalNum > 0 ? kcalNum : "N/A"}</span>
        </div>
      </div>
      <div class="ring-tile">
        <span class="ring-tile-label">${isFoodOrDrink ? "Dinh dưỡng" : "Xác thực"}</span>
        <div class="ring-mini-wrap">
          <svg class="ring-mini-svg" viewBox="0 0 60 60" aria-hidden="true">
            <circle class="ring-mini-bg" cx="30" cy="30" r="24" />
            <circle cx="30" cy="30" r="24" fill="none" stroke="#38BDF8" stroke-width="6" stroke-linecap="round" stroke-dasharray="150.8" stroke-dashoffset="${isFoodOrDrink ? 50 : (data._verified ? 18 : 48)}" />
          </svg>
          <span class="ring-mini-val">${isFoodOrDrink ? healthLabel : (data._verified ? "100%" : "AI")}</span>
        </div>
      </div>
      <div class="ring-tile">
        <span class="ring-tile-label">Tốc độ</span>
        <div class="ring-mini-wrap">
          <svg class="ring-mini-svg" viewBox="0 0 60 60" aria-hidden="true">
            <circle class="ring-mini-bg" cx="30" cy="30" r="24" />
            <circle cx="30" cy="30" r="24" fill="none" stroke="#FB923C" stroke-width="6" stroke-linecap="round" stroke-dasharray="150.8" stroke-dashoffset="35" />
          </svg>
          <span class="ring-mini-val tabular-nums">${escapeHtml(timeOrElapsed)}</span>
        </div>
      </div>
    </div>
  ` : "";

  const productBlock = sp && sp.hien_thi ? `
    <div class="info-block">
      <h3>${isFoodOrDrink ? "🍽️ Dinh dưỡng & Định lượng" : "📌 Thông số & Khu vực"}</h3>
      ${sp.tot_cho_suc_khoe && sp.tot_cho_suc_khoe !== "Không áp dụng" ? `<p><strong>Sức khỏe / Lưu ý:</strong> ${escapeHtml(sp.tot_cho_suc_khoe)}</p>` : ""}
      <p><strong>Chi tiết:</strong> ${escapeHtml(sp.chi_tiet_san_pham || "Đang cập nhật")}</p>
      <p><strong>${data.la_dia_diem ? "Địa điểm / Giờ mở cửa" : "Nơi mua gợi ý"}:</strong> ${escapeHtml(sp.noi_mua_goi_y || "Đà Nẵng – Hội An")}</p>
    </div>
  ` : "";

  const hv = data.han_viet;
  const hanVietBlock = hv && hv.co_han_viet ? `
    <div class="info-block">
      <h3>Giải nghĩa Hán – Nôm</h3>
      <p><strong>${escapeHtml(hv.chu_goc || "")}</strong> (${escapeHtml(hv.phien_am || "")})</p>
      <p>${escapeHtml(hv.y_nghia_tong_the || "")}</p>
    </div>
  ` : "";

  const reviewsHtml = (data.danh_gia_ban_dia?.review_mau || [])
    .map((r) => `<div class="review-chip">${escapeHtml(r)}</div>`)
    .join("");

  const mapUrl = data.hien_chi_duong ? data.chi_duong_url : data.google_maps_url;
  const mapLabel = data.hien_chi_duong ? "Chỉ đường" : "Tìm nơi mua";

  const sheet = document.getElementById("detailSheet");
  sheet.innerHTML = `
    <div class="detail-pills">
      <span class="pill-tag accent">${escapeHtml(data.loai_doi_tuong || "NHẬN DIỆN")}</span>
      ${verifiedPill}
      <span class="pill-tag tabular-nums">${escapeHtml(data.nien_dai_hoac_gia || (fromHistory ? timeOrElapsed : "Đà Nẵng – Hội An"))}</span>
    </div>

    <h2 class="detail-title">${escapeHtml(data.ten_dia_diem || "Kết quả nhận diện")}</h2>

    <div class="highlight-bar">
      <span>${escapeHtml(highlightText)}</span>
      <span class="highlight-meta tabular-nums">${escapeHtml(timeOrElapsed)}${providerBadge}</span>
    </div>

    ${ringBlock}

    <div class="info-block">
      <h3>📊 Thông tin chi tiết</h3>
      <p>${escapeHtml(data.cau_chuyen_lich_su || "")}</p>
    </div>

    <div class="info-block">
      <h3>✨ Điểm độc đáo</h3>
      <p>${escapeHtml(data.giai_thoai_dac_biet || "")}</p>
    </div>

    ${productBlock}
    ${hanVietBlock}

    <div class="info-block">
      <h3>💬 Đánh giá từ người địa phương</h3>
      <p>${escapeHtml(data.danh_gia_ban_dia?.tom_tat || "")}</p>
      ${reviewsHtml}
    </div>

    <div class="detail-actions">
      <button type="button" id="speakBtn" class="btn-pill btn-secondary">Nghe thuyết minh</button>
      <a class="btn-pill btn-primary" href="${mapUrl || "#"}" target="_blank" rel="noopener">${mapLabel}</a>
    </div>
  `;

  navigateTo("detail");
  sheet.scrollTop = 0;
  document.getElementById("speakBtn").addEventListener("click", () => speakText(currentSpeechText));
}

// ==========================================
// SỰ KIỆN GIAO DIỆN
// ==========================================
document.querySelectorAll("[data-nav]").forEach((btn) => {
  btn.addEventListener("click", () => navigateTo(btn.dataset.nav));
});

document.getElementById("btnQuickWeather").addEventListener("click", () => navigateTo("weather"));
document.getElementById("btnQuickChat").addEventListener("click", () => navigateTo("chat"));
document.getElementById("btnRefreshWeather").addEventListener("click", () => renderWeatherView(true));

document.getElementById("detailBackBtn").addEventListener("click", () => navigateTo(previousView || "home"));
document.getElementById("detailCloseBtn").addEventListener("click", () => navigateTo("home"));

document.getElementById("btnClearHistory").addEventListener("click", () => {
  if (confirmDialog && typeof confirmDialog.showModal === "function") {
    confirmDialog.showModal();
  } else {
    setTotalScans(0);
    saveHistoryList([]);
    renderHomeDashboard();
  }
});

document.getElementById("dialogCancelBtn").addEventListener("click", () => confirmDialog.close());
document.getElementById("dialogConfirmBtn").addEventListener("click", () => {
  confirmDialog.close();
  setTotalScans(0);
  saveHistoryList([]);
  renderHomeDashboard();
});

document.querySelectorAll(".mode-pill[data-mode]").forEach((btn) => {
  btn.addEventListener("click", () => {
    scanMode = btn.dataset.mode;
    document.querySelectorAll(".mode-pill[data-mode]").forEach((b) => {
      const active = b === btn;
      b.classList.toggle("active", active);
      b.setAttribute("aria-pressed", String(active));
    });
  });
});

document.getElementById("uploadBtn").addEventListener("click", () => {
  if (!isScanning) fileInput.click();
});

document.getElementById("lastThumbBtn").addEventListener("click", () => {
  const list = loadHistory();
  if (list.length) {
    renderDetailView(list[0].data, list[0].time, list[0].thumb, true);
  } else {
    navigateTo("home");
  }
});

document.getElementById("switchBtn").addEventListener("click", () => {
  facingMode = facingMode === "environment" ? "user" : "environment";
  startCamera();
});

function prepareScanImage(source, srcW, srcH) {
  const maxSide = 720;
  const scale = Math.min(1, maxSide / Math.max(srcW, srcH));
  canvas.width = Math.round(srcW * scale);
  canvas.height = Math.round(srcH * scale);

  const ctx2d = canvas.getContext("2d");
  ctx2d.imageSmoothingEnabled = true;
  ctx2d.imageSmoothingQuality = "high";
  ctx2d.drawImage(source, 0, 0, canvas.width, canvas.height);

  return {
    base64: canvas.toDataURL("image/jpeg", 0.70).split(",")[1],
    thumb: makeThumbnail(canvas)
  };
}

document.getElementById("captureBtn").addEventListener("click", () => {
  if (isScanning || !video || !video.videoWidth) return;
  const { base64, thumb } = prepareScanImage(video, video.videoWidth, video.videoHeight);
  scanBase64(base64, thumb);
});

fileInput.addEventListener("change", (e) => {
  const file = e.target.files?.[0];
  if (!file || isScanning) return;
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      const { base64, thumb } = prepareScanImage(img, img.width, img.height);
      scanBase64(base64, thumb);
    };
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
  e.target.value = "";
});

// Khởi chạy ban đầu
initTheme();
updateHistoryBadge();
renderHomeDashboard();
initGPS();

// ==========================================
// AIvolution Team - Liquid Glass Bottom Nav
// ==========================================
(function initBottomNavLiquidGlass() {
  if (!bottomNav) return;

  const glassPill = document.createElement("span");
  glassPill.className = "nav-liquid-glass is-visible";
  glassPill.setAttribute("aria-hidden", "true");
  bottomNav.appendChild(glassPill);

  const buttons = Array.from(bottomNav.querySelectorAll(".nav-btn, .nav-scan-btn"));
  let isHolding = false;
  let hoveredBtn = null;

  function setHoveredButton(btn) {
    if (hoveredBtn === btn) return;
    if (hoveredBtn) hoveredBtn.classList.remove("is-glass-hover");
    hoveredBtn = btn;
    if (hoveredBtn) hoveredBtn.classList.add("is-glass-hover");
  }

  function getActiveTabButton() {
    if (activeView === "weather") {
      return bottomNav.querySelector('.nav-btn[data-nav="weather"]');
    }
    if (activeView === "chat") {
      return bottomNav.querySelector('.nav-btn[data-nav="chat"]');
    }
    if (activeView === "history") {
      return bottomNav.querySelector("#navHistoryBtn");
    }
    return bottomNav.querySelector('.nav-btn[data-nav="home"]');
  }

  function snapGlassToButton(btn, scale = 1) {
    if (!btn || bottomNav.hidden) return;
    const navRect = bottomNav.getBoundingClientRect();
    const btnRect = btn.getBoundingClientRect();
    if (!navRect.width || !btnRect.width) return;

    const isScan = btn.classList.contains("nav-scan-btn");
    const pillW = isScan ? 68 : 60;
    const pillH = isScan ? 64 : 46;
    const centerInNav = btnRect.left - navRect.left + btnRect.width / 2;
    const leftX = centerInNav - pillW / 2;

    glassPill.style.width = `${pillW}px`;
    glassPill.style.height = `${pillH}px`;
    glassPill.classList.remove("is-dragging");
    glassPill.classList.add("is-visible");
    glassPill.style.transform = `translate3d(${leftX.toFixed(1)}px, -50%, 0) scale(${scale})`;
  }

  syncNavGlassFn = () => {
    if (!isHolding) snapGlassToButton(getActiveTabButton(), 1);
  };

  function moveGlassTo(clientX, dragging) {
    const navRect = bottomNav.getBoundingClientRect();
    let nearest = null;
    let minDist = Infinity;

    buttons.forEach((btn) => {
      const r = btn.getBoundingClientRect();
      const center = r.left + r.width / 2;
      const dist = Math.abs(clientX - center);
      if (dist < minDist) {
        minDist = dist;
        nearest = btn;
      }
    });

    if (!nearest) return;
    setHoveredButton(nearest);

    const btnRect = nearest.getBoundingClientRect();
    const isScan = nearest.classList.contains("nav-scan-btn");
    const pillW = isScan ? 68 : 60;
    const pillH = isScan ? 64 : 46;

    const btnCenterInNav = btnRect.left - navRect.left + btnRect.width / 2;
    const fingerInNav = Math.min(navRect.width - pillW / 2, Math.max(pillW / 2, clientX - navRect.left));
    const targetCenter = btnCenterInNav * 0.72 + fingerInNav * 0.28;
    const leftX = targetCenter - pillW / 2;

    glassPill.style.width = `${pillW}px`;
    glassPill.style.height = `${pillH}px`;
    glassPill.classList.toggle("is-dragging", Boolean(dragging));
    glassPill.classList.add("is-visible");
    glassPill.style.transform = `translate3d(${leftX.toFixed(1)}px, -50%, 0) scale(1.06)`;
  }

  function releaseGlass() {
    if (!isHolding) return;
    isHolding = false;
    const target = hoveredBtn;
    setHoveredButton(null);
    if (target) {
      snapGlassToButton(target, 1);
      target.click();
    } else {
      snapGlassToButton(getActiveTabButton(), 1);
    }
  }

  bottomNav.addEventListener("pointerdown", (e) => {
    isHolding = true;
    if (bottomNav.setPointerCapture) {
      try { bottomNav.setPointerCapture(e.pointerId); } catch (_) {}
    }
    moveGlassTo(e.clientX, false);
  });

  bottomNav.addEventListener("pointermove", (e) => {
    if (!isHolding) return;
    moveGlassTo(e.clientX, true);
  });

  bottomNav.addEventListener("pointerup", releaseGlass);
  bottomNav.addEventListener("pointercancel", () => {
    isHolding = false;
    setHoveredButton(null);
    snapGlassToButton(getActiveTabButton(), 1);
  });

  const observer = new MutationObserver(() => {
    if (!isHolding && !bottomNav.hidden) {
      requestAnimationFrame(() => snapGlassToButton(getActiveTabButton(), 1));
    }
  });
  observer.observe(bottomNav, { attributes: true, attributeFilter: ["hidden"] });
  window.addEventListener("resize", () => {
    if (!isHolding) snapGlassToButton(getActiveTabButton(), 1);
  });

  requestAnimationFrame(() => snapGlassToButton(getActiveTabButton(), 1));
})();

// ==========================================
// AIvolution - EXPLORE NEWS / FOOD / CHECK-IN MINI-TAB HUB
// ==========================================
(function initExploreNewsHub() {
  const triggerBtn = document.getElementById("btnOpenNewsHub");
  const modal = document.getElementById("exploreHubModal");
  const win = document.getElementById("exploreWindow");
  const track = document.getElementById("exploreTrack");
  const updatedEl = document.getElementById("exploreUpdatedAt");
  const refreshBtn = document.getElementById("btnRefreshExplore");

  if (!triggerBtn || !modal || !win || !track) return;

  const TABS = ["news", "food", "checkin"];
  const tabCache = Object.create(null);
  const inFlight = Object.create(null);
  let activeTab = "news";
  let lastFocusedEl = null;

  const prefersReducedMotion = () =>
    window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function setTabIndicators(tab) {
    activeTab = tab;
    modal.querySelectorAll("[data-explore-tab]").forEach((btn) => {
      const isMatch = btn.dataset.exploreTab === tab;
      btn.classList.toggle("active", isMatch);
      btn.setAttribute("aria-selected", String(isMatch));
    });
    const cached = tabCache[tab];
    if (updatedEl) {
      updatedEl.textContent = cached?.updatedAt
        ? `Cập nhật ${cached.updatedAt}`
        : "Đang đồng bộ...";
    }
  }

  function renderSkeleton(paneEl) {
    paneEl.innerHTML = `
      <div class="explore-grid">
        <div class="explore-featured-col">
          <div class="explore-skel-card"></div>
          <div class="explore-skel-card"></div>
        </div>
        <div class="explore-list-box">
          <div class="explore-skel-row"></div>
          <div class="explore-skel-row"></div>
          <div class="explore-skel-row"></div>
          <div class="explore-skel-row"></div>
        </div>
      </div>
    `;
  }

  function renderError(paneEl, tab, msg) {
    paneEl.innerHTML = `
      <div class="explore-empty">
        <p>${escapeHtml(msg || "Chưa tải được dữ liệu xu hướng lúc này.")}</p>
        <button type="button" class="explore-card-action primary" data-retry-tab="${tab}" style="flex:0 0 auto;padding:9px 18px">
          Tải lại ngay
        </button>
      </div>
    `;
    const retryBtn = paneEl.querySelector("[data-retry-tab]");
    if (retryBtn) {
      retryBtn.addEventListener("click", () => loadTabData(tab, true));
    }
  }

  function askAssistantFromExplore(item, tab) {
    closeModal();
    if (typeof navigateTo === "function") navigateTo("chat");

    const promptText =
      tab === "news" || item.type === "news"
        ? `Tóm tắt nhanh thông tin chính và gợi ý trải nghiệm liên quan đến tin này tại Đà Nẵng – Hội An: "${item.title}"`
        : `Review ngắn gọn địa điểm "${item.title}" (${item.subtitle}): món ngon/góc chụp ảnh nổi bật, giá tham khảo và khung giờ đi đỡ đông?`;

    const input = document.getElementById("chatInput");
    const form = document.getElementById("chatForm");
    if (input && form) {
      input.value = promptText;
      if (typeof form.requestSubmit === "function") {
        form.requestSubmit();
      } else {
        form.dispatchEvent(new Event("submit", { cancelable: true }));
      }
    }
  }

  function renderTabItems(paneEl, tab, items) {
    if (!Array.isArray(items) || !items.length) {
      renderError(paneEl, tab, "Chưa có mục nổi bật nào mới. Bạn thử làm mới lại nhé!");
      return;
    }

    const featured = items.slice(0, 2);
    const rest = items.slice(2, 12);
    const shortTag = tab === "news" ? "NEWS" : tab === "food" ? "FOOD" : "CHECK-IN";

    const featuredHtml = featured
      .map((item, idx) => {
        const isPlace = item.type === "place";
        const actionLabel = isPlace ? "Chỉ đường" : "Đọc bài";
        const coverHtml = item.image
          ? `<img class="explore-cover-img" src="${escapeHtml(item.image)}" alt="${escapeHtml(item.title)}" loading="lazy" decoding="async" referrerpolicy="no-referrer" />`
          : `<span class="explore-cover-fallback" aria-hidden="true">${shortTag}</span>`;

        return `
          <article class="explore-featured-card">
            <a class="explore-cover-link" href="${escapeHtml(item.url || "#")}" target="_blank" rel="noopener noreferrer">
              ${coverHtml}
              <span class="explore-cover-badge tabular-nums">${escapeHtml(item.badge || shortTag)}</span>
            </a>
            <div class="explore-featured-content">
              <div class="explore-meta-row">
                <span class="explore-badge">${shortTag}</span>
                <span class="explore-meta-text tabular-nums">${escapeHtml(item.meta || "")}</span>
              </div>
              <a class="explore-card-title-link" href="${escapeHtml(item.url || "#")}" target="_blank" rel="noopener noreferrer">
                <h3 class="explore-card-title">${escapeHtml(item.title)}</h3>
              </a>
              <p class="explore-card-desc">${escapeHtml(item.subtitle || "")}</p>
              <div class="explore-card-actions">
                <a class="explore-card-action primary" href="${escapeHtml(item.url || "#")}" target="_blank" rel="noopener noreferrer">${actionLabel}</a>
                <button type="button" class="explore-card-action" data-ask-idx="${idx}">Hỏi AI</button>
              </div>
            </div>
          </article>
        `;
      })
      .join("");

    const listHtml = (rest.length ? rest : featured)
      .map((item, idx) => {
        const realIdx = rest.length ? idx + 2 : idx;
        const isPlace = item.type === "place";
        const thumbHtml = item.image
          ? `<img class="explore-list-thumb" src="${escapeHtml(item.image)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" />`
          : `<span class="explore-list-fallback" aria-hidden="true">${shortTag}</span>`;

        return `
          <article class="explore-list-item">
            <a class="explore-list-media" href="${escapeHtml(item.url || "#")}" target="_blank" rel="noopener noreferrer">
              ${thumbHtml}
            </a>
            <div class="explore-list-info">
              <a class="explore-list-title" href="${escapeHtml(item.url || "#")}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.title)}</a>
              <div class="explore-list-bottom">
                <span class="explore-list-sub tabular-nums">${escapeHtml(item.badge || "")}${item.meta ? ` • ${escapeHtml(item.meta)}` : ""}</span>
                <div class="explore-list-btns">
                  <button type="button" class="explore-mini-btn" data-ask-idx="${realIdx}" aria-label="Hỏi AI về ${escapeHtml(item.title)}">AI</button>
                  <a class="explore-mini-btn accent" href="${escapeHtml(item.url || "#")}" target="_blank" rel="noopener noreferrer">${isPlace ? "Maps" : "Đọc"}</a>
                </div>
              </div>
            </div>
          </article>
        `;
      })
      .join("");

    paneEl.innerHTML = `
      <div class="explore-grid">
        <div class="explore-featured-col">${featuredHtml}</div>
        <div class="explore-list-box">${listHtml}</div>
      </div>
    `;

    // Tự động chuyển sang khung dự phòng nếu ảnh từ báo gốc bị lỗi tải
    paneEl.querySelectorAll("img.explore-cover-img, img.explore-list-thumb").forEach((img) => {
      img.addEventListener("error", () => {
        const fb = document.createElement("span");
        fb.className = img.classList.contains("explore-cover-img")
          ? "explore-cover-fallback"
          : "explore-list-fallback";
        fb.setAttribute("aria-hidden", "true");
        fb.textContent = shortTag;
        img.replaceWith(fb);
      }, { once: true });
    });

    paneEl.querySelectorAll("[data-ask-idx]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const item = items[Number(btn.dataset.askIdx)];
        if (item) askAssistantFromExplore(item, tab);
      });
    });
  }

  async function loadTabData(tab, force = false) {
    const paneEl = document.getElementById(`pane-${tab}`);
    if (!paneEl) return;

    const cached = tabCache[tab];
    if (!force && cached && Date.now() - cached.fetchedAt < 10 * 60 * 1000) {
      if (!paneEl.dataset.rendered) {
        renderTabItems(paneEl, tab, cached.items);
        paneEl.dataset.rendered = "1";
      }
      if (tab === activeTab && updatedEl) {
        updatedEl.textContent = `Cập nhật ${cached.updatedAt}`;
      }
      return;
    }

    if (inFlight[tab] && !force) return;
    inFlight[tab] = true;
    renderSkeleton(paneEl);
    if (tab === activeTab && updatedEl) updatedEl.textContent = "Đang tải...";

    try {
      const res = await fetch(`/api/explore?tab=${encodeURIComponent(tab)}${force ? `&_t=${Date.now()}` : ""}`);
      const data = await res.json();
      if (!res.ok || !Array.isArray(data.items)) {
        throw new Error(data.error || "Không tải được dữ liệu.");
      }
      tabCache[tab] = {
        items: data.items,
        updatedAt: data.updatedAt || "Vừa xong",
        fetchedAt: Date.now()
      };
      renderTabItems(paneEl, tab, data.items);
      paneEl.dataset.rendered = "1";
      if (tab === activeTab && updatedEl) {
        updatedEl.textContent = `Cập nhật ${tabCache[tab].updatedAt}`;
      }
    } catch (err) {
      renderError(paneEl, tab, err?.message || "Mạng không ổn định, bạn thử tải lại nhé.");
    } finally {
      inFlight[tab] = false;
    }
  }

  function scrollToTab(tab) {
    const paneEl = document.getElementById(`pane-${tab}`);
    if (!paneEl) return;
    setTabIndicators(tab);
    paneEl.scrollIntoView({
      behavior: prefersReducedMotion() ? "auto" : "smooth",
      inline: "start",
      block: "nearest"
    });
    loadTabData(tab, false);
  }

  // Dùng IntersectionObserver đồng bộ khi vuốt ngang Mini-Tab (không poll scroll)
  const paneObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting && entry.intersectionRatio >= 0.55) {
          const tab = entry.target.dataset.paneTab;
          if (tab && TABS.includes(tab)) {
            if (tab !== activeTab) setTabIndicators(tab);
            loadTabData(tab, false);
          }
        }
      }
    },
    { root: track, threshold: 0.55 }
  );

  track.querySelectorAll(".explore-pane").forEach((pane) => paneObserver.observe(pane));

  function openModal() {
    lastFocusedEl = document.activeElement;
    modal.hidden = false;
    win.classList.add("is-animating");
    document.body.style.overflow = "hidden";

    requestAnimationFrame(() => {
      modal.classList.add("is-open");
    });

    loadTabData(activeTab, false);
    setTimeout(() => {
      if (modal.classList.contains("is-open")) {
        TABS.forEach((t) => {
          if (t !== activeTab && !tabCache[t]) loadTabData(t, false);
        });
      }
    }, 450);

    const closeBtn = document.getElementById("btnCloseExplore");
    if (closeBtn) closeBtn.focus();
  }

  function closeModal() {
    if (modal.hidden) return;
    win.classList.add("is-animating");
    modal.classList.remove("is-open");
    document.body.style.overflow = "";

    const finishClose = () => {
      win.classList.remove("is-animating");
      if (!modal.classList.contains("is-open")) {
        modal.hidden = true;
      }
    };

    if (prefersReducedMotion()) {
      finishClose();
    } else {
      setTimeout(finishClose, 240);
    }

    if (lastFocusedEl && typeof lastFocusedEl.focus === "function") {
      lastFocusedEl.focus();
    }
  }

  win.addEventListener("transitionend", () => {
    win.classList.remove("is-animating");
  });

  triggerBtn.addEventListener("click", openModal);

  modal.querySelectorAll("[data-explore-close]").forEach((el) => {
    el.addEventListener("click", closeModal);
  });

  modal.querySelectorAll("[data-explore-tab]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const tab = btn.dataset.exploreTab;
      if (tab && TABS.includes(tab)) scrollToTab(tab);
    });
  });

  if (refreshBtn) {
    refreshBtn.addEventListener("click", () => loadTabData(activeTab, true));
  }

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !modal.hidden) {
      e.stopPropagation();
      closeModal();
    }
  });
})();
