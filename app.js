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

// Web Audio API + Bộ đệm tải sẵn giọng Hoài My
let audioCtx = null;
let activeSource = null;
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
    const isMatch = btn.dataset.nav === viewName && btn.id !== "navHistoryBtn";
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
  }
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (confirmDialog.open) {
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
    // Nếu bộ nhớ trình duyệt gần đầy, giữ ảnh thumbnail cho 20 mục gần nhất để vẫn lưu được hàng nghìn lượt quét
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
  if (text.includes("không áp dụng")) return 0;
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

    if (d.la_dia_diem || /di tích|nhà hàng|quán ăn|workshop|shop|hán nôm/.test(type)) {
      placesCount++;
    } else if (/thức ăn|đồ uống/.test(type) || kcal > 0) {
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

  // Vòng tiến độ mượt theo mốc 10 / 100 / 1000 / 10000 lượt
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
  clearBtn.hidden = list.length === 0 && totalScans === 0;

  const container = document.getElementById("homeHistoryContainer");
  if (!list.length) {
    container.innerHTML = `
      <div class="empty-card">
        <p>Chưa có mục nào được quét. Hãy mở máy quét để nhận diện món ăn, địa điểm hoặc sản phẩm quanh bạn.</p>
        <button type="button" class="btn-pill btn-primary" id="emptyScanBtn">Mở AI Scanner</button>
      </div>
    `;
    document.getElementById("emptyScanBtn").addEventListener("click", () => navigateTo("scanner"));
    return;
  }

  // Hiển thị 100 mục gần nhất trên danh sách để cuộn mượt (vẫn lưu đầy đủ trong bộ nhớ)
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
  if (!document.hidden && activeView === "scanner") {
    const track = currentStream?.getVideoTracks?.()[0];
    if (!track || track.readyState === "ended") startCamera();
    else if (video && video.paused) video.play().catch(() => {});
  }
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
// 4. THỜI TIẾT & CHATBOT
// ==========================================
function interpretWeatherCode(code) {
  if (code === 0) return "Trời quang đãng";
  if ([1, 2, 3].includes(code)) return "Có mây nhẹ";
  if ([45, 48].includes(code)) return "Có sương mù";
  if ([51, 53, 55, 61, 63, 65, 80, 81, 82].includes(code)) return "Có mưa";
  if ([95, 96, 99].includes(code)) return "Có dông bão";
  return "Thời tiết ổn định";
}

async function renderWeatherView() {
  const body = document.getElementById("weatherBody");
  const lat = currentCoords.lat || 15.98;
  const lng = currentCoords.lng || 108.25;

  body.setAttribute("aria-busy", "true");
  body.innerHTML = `<div class="skeleton-box"></div><div class="skeleton-box"></div>`;

  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m&hourly=precipitation_probability&timezone=auto&forecast_days=1`;
    const res = await fetch(url);
    if (!res.ok) throw new Error("Không tải được dữ liệu thời tiết.");
    const data = await res.json();

    const cur = data.current || {};
    const temp = Math.round(cur.temperature_2m ?? 26);
    const humidity = Math.round(cur.relative_humidity_2m ?? 75);
    const wind = Math.round(cur.wind_speed_10m ?? 10);
    const desc = interpretWeatherCode(cur.weather_code);

    const currentHour = new Date().getHours();
    const probs = data.hourly?.precipitation_probability || [];
    const nextProbs = probs.slice(currentHour, currentHour + 4).filter((v) => Number.isFinite(v));
    const rainProb = nextProbs.length ? Math.max(...nextProbs) : 0;

    let advice = `Tỷ lệ mưa thấp (${rainProb}%), trời ${desc.toLowerCase()}. Rất phù hợp để dạo phố và chụp ảnh ngoài trời.`;
    if (rainProb >= 65) {
      advice = `Tỷ lệ mưa cao (${rainProb}%). Nên ưu tiên quán cà phê, bảo tàng hoặc workshop trong nhà.`;
    } else if (rainProb >= 35) {
      advice = `Khả năng mưa khoảng ${rainProb}%. Nên mang theo áo mưa mỏng hoặc dù khi di chuyển.`;
    }

    body.innerHTML = `
      <div class="weather-card">
        <div>
          <div class="weather-temp tabular-nums">${temp}°C</div>
          <div class="weather-desc">${desc}</div>
        </div>
        <div class="tabular-nums" style="font-size:13px;font-weight:700;">Mưa ${rainProb}%</div>
      </div>

      <div class="mini-grid">
        <div class="mini-card">
          <span class="mini-label">Tỷ lệ mưa</span>
          <span class="mini-val tabular-nums">${rainProb}%</span>
        </div>
        <div class="mini-card">
          <span class="mini-label">Độ ẩm</span>
          <span class="mini-val tabular-nums">${humidity}%</span>
        </div>
        <div class="mini-card">
          <span class="mini-label">Gió</span>
          <span class="mini-val tabular-nums">${wind} km/h</span>
        </div>
      </div>

      <div class="weather-verdict">
        <strong>Gợi ý di chuyển:</strong> ${advice}
      </div>
    `;
  } catch (err) {
    body.innerHTML = `<div class="error-panel">Không lấy được thời tiết: ${escapeHtml(err.message)}</div>`;
  } finally {
    body.setAttribute("aria-busy", "false");
  }
}

function renderChatView() {
  const box = document.getElementById("chatBox");
  box.innerHTML = chatHistory
    .map((m) => `<div class="chat-msg ${m.role === "user" ? "user" : "bot"}">${escapeHtml(m.content)}</div>`)
    .join("");
  box.scrollTop = box.scrollHeight;
}

document.getElementById("chatForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = document.getElementById("chatInput");
  const text = input.value.trim();
  if (!text) return;

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
      ? `GPS(${currentCoords.lat.toFixed(4)}, ${currentCoords.lng.toFixed(4)}) - Đà Nẵng & Hội An`
      : "Đà Nẵng – Hội An";

    const res = await fetch("/api/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "chat", messages: chatHistory, locationContext })
    });
    const data = await res.json();
    chatHistory.push({
      role: "assistant",
      content: data.reply || data.error || "Mình chưa nhận được phản hồi, bạn thử lại nhé."
    });
  } catch (err) {
    chatHistory.push({ role: "assistant", content: "Lỗi kết nối: " + err.message });
  }
  renderChatView();
});

// ==========================================
// 5. GIỌNG ĐỌC HOÀI MY NEURAL (1 CHẠM NGHE NGAY)
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

function prefetchTts(text) {
  const cleanText = normalizeTtsText(text);
  if (cleanText) getOrFetchTtsBuffer(cleanText).catch(() => {});
}

function unlockAudioContext() {
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) return null;
  if (!audioCtx) audioCtx = new AudioCtx();
  if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
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
  if (!ctx) return;

  const session = ++speechSessionId;
  isSpeaking = true;
  const btn = document.getElementById("speakBtn");
  if (btn) btn.textContent = "Đang tải giọng...";

  try {
    const buffer = await getOrFetchTtsBuffer(cleanText);
    if (session !== speechSessionId) return;
    const decoded = await decodeAudio(ctx, buffer);
    if (session !== speechSessionId) return;
    if (ctx.state === "suspended") await ctx.resume();

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
  } catch (_) {
    if (session === speechSessionId) {
      stopSpeaking();
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
// 6. QUÉT ẢNH & HIỂN THỊ MÀN HÌNH CHI TIẾT
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

async function scanBase64(imageBase64, thumbDataUrl) {
  const startTime = performance.now();
  statusPill.classList.add("show");

  try {
    const modeHint = scanMode === "food"
      ? "Ưu tiên phân tích món ăn & calo. "
      : scanMode === "place"
      ? "Ưu tiên nhận diện địa điểm / di tích. "
      : "";

    const locationContext = currentCoords.lat
      ? `${modeHint}GPS(${currentCoords.lat.toFixed(4)}, ${currentCoords.lng.toFixed(4)}) - Đà Nẵng & Hội An`
      : `${modeHint}Đà Nẵng – Hội An`;

    const res = await fetch("/api/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        imageBase64,
        lat: currentCoords.lat,
        lng: currentCoords.lng,
        locationContext
      })
    });

    const data = await res.json();
    const elapsed = ((performance.now() - startTime) / 1000).toFixed(1);

    if (!res.ok || data.error) {
      renderErrorDetail(data.debug || "", thumbDataUrl);
    } else {
      addToHistory(data, thumbDataUrl);
      renderDetailView(data, `${elapsed}s`, thumbDataUrl, false);
    }
  } catch (err) {
    renderErrorDetail(err?.message || "Lỗi kết nối mạng", thumbDataUrl);
  } finally {
    statusPill.classList.remove("show");
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

function renderDetailView(data, timeOrElapsed, thumbDataUrl, fromHistory) {
  stopCamera();
  setDetailHero(thumbDataUrl);

  currentSpeechText = `${data.ten_dia_diem || ""}. ${data.cau_chuyen_lich_su || ""} ${data.giai_thoai_dac_biet || ""}`;
  prefetchTts(currentSpeechText);

  const sp = data.thong_tin_san_pham;
  const kcalNum = parseCalories(sp?.calo_uoc_tinh);
  const highlightText = sp?.hien_thi && sp.calo_uoc_tinh
    ? `Ước tính: ${sp.calo_uoc_tinh}`
    : (data.dia_chi || "Đà Nẵng – Hội An");

  const ringBlock = sp && sp.hien_thi ? `
    <div class="ring-grid">
      <div class="ring-tile">
        <span class="ring-tile-label">Calo</span>
        <div class="ring-mini-wrap">
          <svg class="ring-mini-svg" viewBox="0 0 60 60" aria-hidden="true">
            <circle class="ring-mini-bg" cx="30" cy="30" r="24" />
            <circle cx="30" cy="30" r="24" fill="none" stroke="#94D82D" stroke-width="6" stroke-linecap="round" stroke-dasharray="150.8" stroke-dashoffset="42" />
          </svg>
          <span class="ring-mini-val tabular-nums">${kcalNum > 0 ? kcalNum : "N/A"}</span>
        </div>
      </div>
      <div class="ring-tile">
        <span class="ring-tile-label">Sức khỏe</span>
        <div class="ring-mini-wrap">
          <svg class="ring-mini-svg" viewBox="0 0 60 60" aria-hidden="true">
            <circle class="ring-mini-bg" cx="30" cy="30" r="24" />
            <circle cx="30" cy="30" r="24" fill="none" stroke="#38BDF8" stroke-width="6" stroke-linecap="round" stroke-dasharray="150.8" stroke-dashoffset="50" />
          </svg>
          <span class="ring-mini-val">Tốt</span>
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
      <h3>Dinh dưỡng & Nơi mua</h3>
      <p><strong>Sức khỏe:</strong> ${escapeHtml(sp.tot_cho_suc_khoe || "Đang cập nhật")}</p>
      <p><strong>Chi tiết:</strong> ${escapeHtml(sp.chi_tiet_san_pham || "Đang cập nhật")}</p>
      <p><strong>Nơi mua gợi ý:</strong> ${escapeHtml(sp.noi_mua_goi_y || "Đà Nẵng – Hội An")}</p>
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
      <span class="pill-tag tabular-nums">${escapeHtml(data.nien_dai_hoac_gia || (fromHistory ? timeOrElapsed : "Đà Nẵng – Hội An"))}</span>
    </div>

    <h2 class="detail-title">${escapeHtml(data.ten_dia_diem || "Kết quả nhận diện")}</h2>

    <div class="highlight-bar">
      <span>${escapeHtml(highlightText)}</span>
      <span class="highlight-meta tabular-nums">${escapeHtml(timeOrElapsed)}</span>
    </div>

    ${ringBlock}

    <div class="info-block">
      <h3>Thông tin & Câu chuyện</h3>
      <p>${escapeHtml(data.cau_chuyen_lich_su || "")}</p>
    </div>

    <div class="info-block">
      <h3>Điểm độc đáo</h3>
      <p>${escapeHtml(data.giai_thoai_dac_biet || "")}</p>
    </div>

    ${productBlock}
    ${hanVietBlock}

    <div class="info-block">
      <h3>Đánh giá từ người địa phương</h3>
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
// 7. GẮN SỰ KIỆN TƯƠNG TÁC
// ==========================================
document.querySelectorAll("[data-nav]").forEach((btn) => {
  btn.addEventListener("click", () => navigateTo(btn.dataset.nav));
});

document.getElementById("btnQuickWeather").addEventListener("click", () => navigateTo("weather"));
document.getElementById("btnQuickChat").addEventListener("click", () => navigateTo("chat"));
document.getElementById("btnRefreshWeather").addEventListener("click", () => renderWeatherView());

document.getElementById("detailBackBtn").addEventListener("click", () => navigateTo(previousView || "home"));
document.getElementById("detailCloseBtn").addEventListener("click", () => navigateTo("home"));

// Xóa lịch sử bằng AlertDialog chuẩn
document.getElementById("btnClearHistory").addEventListener("click", () => {
  if (typeof confirmDialog.showModal === "function") {
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

// Chọn chế độ trên Scanner
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

document.getElementById("uploadBtn").addEventListener("click", () => fileInput.click());

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

document.getElementById("captureBtn").addEventListener("click", () => {
  if (!video || !video.videoWidth) return;
  const maxW = 800;
  const scale = Math.min(1, maxW / video.videoWidth);
  canvas.width = video.videoWidth * scale;
  canvas.height = video.videoHeight * scale;
  canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
  const base64 = canvas.toDataURL("image/jpeg", 0.72).split(",")[1];
  const thumb = makeThumbnail(canvas);
  scanBase64(base64, thumb);
});

fileInput.addEventListener("change", (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      const maxW = 800;
      const scale = Math.min(1, maxW / img.width);
      canvas.width = img.width * scale;
      canvas.height = img.height * scale;
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      const base64 = canvas.toDataURL("image/jpeg", 0.75).split(",")[1];
      const thumb = makeThumbnail(canvas);
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
