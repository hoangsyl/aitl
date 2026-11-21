const video = document.getElementById("camera");
const canvas = document.getElementById("canvas");
const statusPill = document.getElementById("statusPill");
const sheet = document.getElementById("sheet");
const sheetContent = document.getElementById("sheetContent");
const gpsDot = document.getElementById("gpsDot");
const gpsText = document.getElementById("gpsText");
const historyBadge = document.getElementById("historyBadge");

const HISTORY_KEY = "aivolution_scan_history_v1";
const MAX_HISTORY = 30;
const FRIENDLY_ERROR_MSG =
  "Opps! Mình không thể nhận diện được, có lẽ do bạn chụp không rõ hoặc mờ hoặc tối quá, bạn hãy giữ nguyên và để rõ giúp mình nhé😍";

let facingMode = "environment";
let currentStream = null;
let currentCoords = { lat: null, lng: null };
let currentSpeechText = "";
let isSpeaking = false;
let lockedVoice = null;
let speechSessionId = 0;

let chatHistory = [
  {
    role: "assistant",
    content: "Chào bạn! Mình là trợ lý AIvolution. Bạn cần hỏi đường, quán ngon Đà Nẵng – Hội An, hay thắc mắc về sản phẩm vừa quét cứ nhắn mình nhé!"
  }
];

// ==========================================
// 1. QUẢN LÝ LỊCH SỬ (localStorage)
// ==========================================
function loadHistory() {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    return [];
  }
}

function saveHistoryList(list) {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(list));
  } catch (e) {
    const slim = list.map((item, idx) => (idx > 5 ? { ...item, thumb: "" } : item));
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(slim)); } catch (_) {}
  }
  updateHistoryBadge();
}

function addToHistory(data, thumbDataUrl) {
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
  const count = loadHistory().length;
  if (count > 0) {
    historyBadge.textContent = count > 99 ? "99+" : count;
    historyBadge.style.display = "flex";
  } else {
    historyBadge.style.display = "none";
  }
}

function makeThumbnail(sourceCanvas) {
  try {
    const thumbCanvas = document.createElement("canvas");
    const maxW = 140;
    const scale = Math.min(1, maxW / sourceCanvas.width);
    thumbCanvas.width = Math.round(sourceCanvas.width * scale);
    thumbCanvas.height = Math.round(sourceCanvas.height * scale);
    thumbCanvas.getContext("2d").drawImage(sourceCanvas, 0, 0, thumbCanvas.width, thumbCanvas.height);
    return thumbCanvas.toDataURL("image/jpeg", 0.55);
  } catch (e) {
    return "";
  }
}

// ==========================================
// 2. MENU CHÍNH (LỊCH SỬ | THỜI TIẾT | CHATBOT)
// ==========================================
function openMenuSheet(activeTab = "history") {
  stopSpeaking();

  sheetContent.innerHTML = `
    <div class="sheet-header">
      <h2 class="title" style="font-size:20px;">☰ Menu AIvolution</h2>
      <button class="btn-close" onclick="closeSheet()">✕</button>
    </div>

    <div class="menu-tabs">
      <button class="menu-tab ${activeTab === "history" ? "active" : ""}" onclick="openMenuSheet('history')">🕒 Lịch sử</button>
      <button class="menu-tab ${activeTab === "weather" ? "active" : ""}" onclick="openMenuSheet('weather')">🌦️ Thời tiết</button>
      <button class="menu-tab ${activeTab === "chat" ? "active" : ""}" onclick="openMenuSheet('chat')">💬 Chatbot</button>
    </div>

    <div id="menuBody"></div>
  `;

  sheet.classList.add("open");

  if (activeTab === "history") renderHistoryTab();
  else if (activeTab === "weather") renderWeatherTab();
  else if (activeTab === "chat") renderChatTab();
}

function renderHistoryTab() {
  const body = document.getElementById("menuBody");
  const list = loadHistory();

  if (!list.length) {
    body.innerHTML = `<div class="history-empty">Chưa có lịch sử quét nào.<br/>Hãy chụp hoặc chọn ảnh để bắt đầu khám phá!</div>`;
    return;
  }

  body.innerHTML = `
    <div class="history-top">
      <span style="font-size:12px;color:#6b5b52;">Đã lưu ${list.length} mục • Bấm để xem lại</span>
      <button class="btn-clear-all" onclick="clearAllHistory()">Xóa tất cả</button>
    </div>
    <div class="history-list">
      ${list
        .map(
          (item) => `
        <div class="history-item" onclick="openHistoryItem(${item.id})">
          ${
            item.thumb
              ? `<img class="history-thumb" src="${item.thumb}" alt="thumb" />`
              : `<div class="history-thumb" style="display:flex;align-items:center;justify-content:center;font-size:22px;">📷</div>`
          }
          <div class="history-info">
            <div class="history-name">${item.data.ten_dia_diem || "Kết quả nhận diện"}</div>
            <div class="history-sub">${item.data.loai_doi_tuong || ""} • ${item.time}</div>
          </div>
          <button class="btn-del-item" title="Xóa" onclick="deleteHistoryItem(event, ${item.id})">🗑️</button>
        </div>
      `
        )
        .join("")}
    </div>
  `;
}

// ==========================================
// 3. THỜI TIẾT THEO GPS + TỶ LỆ MƯA + GỢI Ý ĐI CHƠI
// ==========================================
function interpretWeatherCode(code) {
  if (code === 0) return { text: "Trời quang đãng", icon: "☀️" };
  if ([1, 2, 3].includes(code)) return { text: "Có mây nhẹ", icon: "⛅" };
  if ([45, 48].includes(code)) return { text: "Có sương mù", icon: "🌫️" };
  if ([51, 53, 55, 61, 63, 65, 80, 81, 82].includes(code)) return { text: "Có mưa", icon: "🌧️" };
  if ([95, 96, 99].includes(code)) return { text: "Có dông bão", icon: "⛈️" };
  return { text: "Thời tiết ổn định", icon: "🌤️" };
}

async function renderWeatherTab() {
  const body = document.getElementById("menuBody");
  const lat = currentCoords.lat || 15.98;
  const lng = currentCoords.lng || 108.25;
  const locLabel = currentCoords.lat
    ? `GPS hiện tại (${lat.toFixed(4)}, ${lng.toFixed(4)})`
    : "Khu vực Đà Nẵng – Hội An (Mặc định)";

  body.innerHTML = `<div class="history-empty">⏳ Đang tải dự báo thời tiết tại vị trí của bạn...</div>`;

  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m&hourly=precipitation_probability&timezone=auto&forecast_days=1`;
    const res = await fetch(url);
    if (!res.ok) throw new Error("Không tải được dữ liệu thời tiết.");
    const data = await res.json();

    const cur = data.current || {};
    const temp = Math.round(cur.temperature_2m ?? 26);
    const humidity = Math.round(cur.relative_humidity_2m ?? 75);
    const wind = Math.round(cur.wind_speed_10m ?? 10);
    const wInfo = interpretWeatherCode(cur.weather_code);

    const currentHour = new Date().getHours();
    const probs = data.hourly?.precipitation_probability || [];
    const nextHoursProbs = probs.slice(currentHour, currentHour + 4).filter((v) => Number.isFinite(v));
    const rainProb = nextHoursProbs.length ? Math.max(...nextHoursProbs) : 0;

    let verdictClass = "verdict-good";
    let verdictTitle = "✅ Rất phù hợp để đi chơi!";
    let verdictDesc = `Tỷ lệ mưa chỉ khoảng ${rainProb}%, trời ${wInfo.text.toLowerCase()} và mát mẻ (${temp}°C). Bạn có thể thoải mái đi dạo phố, chụp ảnh hoặc khám phá quán ngon.`;

    if (rainProb >= 65 || [63, 65, 81, 82, 95, 96, 99].includes(cur.weather_code)) {
      verdictClass = "verdict-bad";
      verdictTitle = "⛔ Không nên đi chơi ngoài trời lúc này";
      verdictDesc = `Tỷ lệ mưa cao (${rainProb}%) kèm ${wInfo.text.toLowerCase()}. Bạn nên ưu tiên quán cà phê, trung tâm thương mại hoặc workshop trong nhà nhé.`;
    } else if (rainProb >= 35 || [51, 53, 61, 80].includes(cur.weather_code)) {
      verdictClass = "verdict-warn";
      verdictTitle = "⚠️ Có thể đi chơi nhưng nhớ mang áo mưa/dù";
      verdictDesc = `Khả năng có mưa rào khoảng ${rainProb}%. Nên chuẩn bị sẵn áo mưa mỏng và ưu tiên các điểm gần nhau để dễ trú mưa.`;
    }

    body.innerHTML = `
      <div style="font-size:12px;color:#6b5b52;margin-bottom:10px;">📍 ${locLabel}</div>
      <div class="weather-hero">
        <div>
          <div class="weather-temp">${temp}°C</div>
          <div class="weather-desc">${wInfo.text}</div>
        </div>
        <div class="weather-icon">${wInfo.icon}</div>
      </div>

      <div class="weather-grid">
        <div class="weather-stat">
          <div class="val">🌧️ ${rainProb}%</div>
          <div class="lbl">Tỷ lệ mưa</div>
        </div>
        <div class="weather-stat">
          <div class="val">💧 ${humidity}%</div>
          <div class="lbl">Độ ẩm</div>
        </div>
        <div class="weather-stat">
          <div class="val">💨 ${wind} km/h</div>
          <div class="lbl">Tốc độ gió</div>
        </div>
      </div>

      <div class="verdict-box ${verdictClass}">
        <div style="font-weight:800;margin-bottom:4px;">${verdictTitle}</div>
        <div>${verdictDesc}</div>
      </div>
    `;
  } catch (err) {
    body.innerHTML = `<div class="error-box">Không lấy được dữ liệu thời tiết: ${err.message}</div>`;
  }
}

// ==========================================
// 4. CHATBOT HỖ TRỢ GIẢI ĐÁP NGAY LẬP TỨC
// ==========================================
function renderChatTab() {
  const body = document.getElementById("menuBody");
  body.innerHTML = `
    <div id="chatBox" class="chat-box">
      ${chatHistory
        .map((m) => `<div class="chat-msg ${m.role === "user" ? "user" : "bot"}">${m.content}</div>`)
        .join("")}
    </div>
    <form id="chatForm" class="chat-form">
      <input id="chatInput" class="chat-input" type="text" placeholder="Hỏi bất cứ điều gì..." autocomplete="off" />
      <button type="submit" class="chat-send">Gửi</button>
    </form>
  `;

  const chatBox = document.getElementById("chatBox");
  chatBox.scrollTop = chatBox.scrollHeight;

  document.getElementById("chatForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = document.getElementById("chatInput");
    const text = input.value.trim();
    if (!text) return;

    chatHistory.push({ role: "user", content: text });
    input.value = "";
    renderChatTab();

    const box = document.getElementById("chatBox");
    const typing = document.createElement("div");
    typing.className = "chat-msg bot";
    typing.textContent = "⏳ Đang trả lời...";
    box.appendChild(typing);
    box.scrollTop = box.scrollHeight;

    try {
      const locationContext = currentCoords.lat
        ? `GPS(${currentCoords.lat.toFixed(4)}, ${currentCoords.lng.toFixed(4)}) - Đà Nẵng & Hội An`
        : "Đà Nẵng – Hội An";

      const res = await fetch("/api/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "chat",
          messages: chatHistory,
          locationContext
        })
      });
      const data = await res.json();
      chatHistory.push({
        role: "assistant",
        content: data.reply || data.error || "Mình chưa nhận được phản hồi, bạn thử lại nhé."
      });
    } catch (err) {
      chatHistory.push({ role: "assistant", content: "Lỗi kết nối: " + err.message });
    }
    renderChatTab();
  });
}

function openHistoryItem(id) {
  const item = loadHistory().find((x) => x.id === id);
  if (!item) return;
  renderResult(item.data, item.time, true);
}

function deleteHistoryItem(event, id) {
  event.stopPropagation();
  const list = loadHistory().filter((x) => x.id !== id);
  saveHistoryList(list);
  renderHistoryTab();
}

function clearAllHistory() {
  if (!confirm("Xóa toàn bộ lịch sử quét?")) return;
  saveHistoryList([]);
  renderHistoryTab();
}

window.openMenuSheet = openMenuSheet;
window.openHistoryItem = openHistoryItem;
window.deleteHistoryItem = deleteHistoryItem;
window.clearAllHistory = clearAllHistory;

// ==========================================
// 5. CAMERA, GPS & GIỌNG ĐỌC MƯỢT MÀ (KHÔNG CỨNG, KHÔNG GOOGLE)
// ==========================================
async function startCamera() {
  if (currentStream) currentStream.getTracks().forEach((t) => t.stop());
  try {
    currentStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false
    });
    video.srcObject = currentStream;
  } catch (err) {
    alert("Không mở được camera. Bạn có thể bấm nút 🖼️ để chọn ảnh từ máy.");
  }
}

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

// Khóa 1 giọng tiếng Việt tự nhiên nhất trên thiết bị
function getNaturalVietnameseVoice() {
  if (lockedVoice) return lockedVoice;
  if (!("speechSynthesis" in window)) return null;
  const voices = window.speechSynthesis.getVoices();
  if (!voices || voices.length === 0) return null;

  const viVoices = voices.filter((v) => (v.lang || "").toLowerCase().includes("vi"));
  if (!viVoices.length) return null;

  lockedVoice =
    viVoices.find((v) => /enhanced|premium|natural|hoaimy/i.test(v.name)) ||
    viVoices.find((v) => /linh|namminh/i.test(v.name)) ||
    viVoices[0];

  return lockedVoice;
}

if ("speechSynthesis" in window) {
  getNaturalVietnameseVoice();
  window.speechSynthesis.onvoiceschanged = () => {
    if (!lockedVoice) getNaturalVietnameseVoice();
  };
}

function updateSpeakButton(playing) {
  const btn = document.getElementById("speakBtn");
  if (!btn) return;
  btn.textContent = playing ? "⏹️ Dừng thuyết minh" : "🔊 Nghe thuyết minh";
}

function stopSpeaking() {
  speechSessionId++;
  isSpeaking = false;
  if ("speechSynthesis" in window) window.speechSynthesis.cancel();
  updateSpeakButton(false);
}

// Chỉ tách theo câu trọn vẹn (. ! ?) để giữ nguyên dấu phẩy bên trong -> giọng lên xuống mềm mại, không bị giật cục
function splitIntoNaturalSentences(text) {
  const clean = String(text || "")
    .replace(/[*#_•]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean) return [];
  const matches = clean.match(/[^.!?]+[.!?]*/g) || [clean];
  return matches.map((s) => s.trim()).filter(Boolean);
}

function speakText(text) {
  if (!("speechSynthesis" in window)) {
    alert("Trình duyệt này chưa hỗ trợ đọc giọng nói.");
    return;
  }

  if (isSpeaking) {
    stopSpeaking();
    return;
  }

  const sentences = splitIntoNaturalSentences(text);
  if (!sentences.length) return;

  window.speechSynthesis.cancel();
  const session = ++speechSessionId;
  const voice = getNaturalVietnameseVoice();

  isSpeaking = true;
  updateSpeakButton(true);

  let idx = 0;
  function speakNext() {
    if (session !== speechSessionId || !isSpeaking || idx >= sentences.length) {
      if (session === speechSessionId) {
        isSpeaking = false;
        updateSpeakButton(false);
      }
      return;
    }

    const utter = new SpeechSynthesisUtterance(sentences[idx]);
    utter.lang = "vi-VN";
    if (voice) utter.voice = voice;
    utter.rate = 0.95; // Tốc độ kể chuyện tự nhiên
    utter.pitch = 1.0; // Giữ cao độ gốc để giọng không bị méo/kim loại

    utter.onend = () => {
      idx++;
      setTimeout(speakNext, 260); // Nghỉ nhịp nhẹ giữa các câu
    };
    utter.onerror = () => {
      if (session === speechSessionId) {
        isSpeaking = false;
        updateSpeakButton(false);
      }
    };

    window.speechSynthesis.speak(utter);
  }

  speakNext();
}

function closeSheet() {
  stopSpeaking();
  sheet.classList.remove("open");
}

window.speakText = speakText;
window.closeSheet = closeSheet;

// ==========================================
// 6. QUÉT ẢNH & HIỂN THỊ KẾT QUẢ
// ==========================================
async function scanBase64(imageBase64, thumbDataUrl) {
  const startTime = performance.now();
  statusPill.classList.add("show");
  closeSheet();

  try {
    const locationContext = currentCoords.lat
      ? `GPS(${currentCoords.lat.toFixed(4)}, ${currentCoords.lng.toFixed(4)}) - Đà Nẵng & Hội An`
      : "Đà Nẵng – Hội An";

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
      renderError();
    } else {
      addToHistory(data, thumbDataUrl);
      renderResult(data, `${elapsed}s`, false);
    }
  } catch (_) {
    renderError();
  } finally {
    statusPill.classList.remove("show");
  }
}

function renderError() {
  sheetContent.innerHTML = `
    <div class="sheet-header">
      <div class="badges"><span class="badge-type">THỬ LẠI</span></div>
      <button class="btn-close" onclick="closeSheet()">✕</button>
    </div>
    <h2 class="title">Chưa nhận diện được</h2>
    <div class="error-box">${FRIENDLY_ERROR_MSG}</div>
    <div class="action-row" style="margin-top: 14px;">
      <button class="btn-primary" onclick="closeSheet()">🔄 Quét lại ngay</button>
    </div>
  `;
  sheet.classList.add("open");
}

function renderResult(data, timeOrElapsed, fromHistory = false) {
  currentSpeechText = `${data.ten_dia_diem || ""}. ${data.cau_chuyen_lich_su || ""} ${data.giai_thoai_dac_biet || ""}`;

  const sp = data.thong_tin_san_pham;
  const productBlock = sp && sp.hien_thi ? `
    <div class="ai-product-card">
      <h4>🥗 Dinh dưỡng & Thông tin mua hàng</h4>
      <p><strong>🔥 Chỉ số Calo:</strong> ${sp.calo_uoc_tinh || "Đang cập nhật"}</p>
      <p><strong>💚 Sức khỏe:</strong> ${sp.tot_cho_suc_khoe || "Đang cập nhật"}</p>
      <p><strong>📦 Chi tiết:</strong> ${sp.chi_tiet_san_pham || "Đang cập nhật"}</p>
      <p><strong>🛒 Nơi mua gợi ý:</strong> ${sp.noi_mua_goi_y || "Các cửa hàng uy tín tại Đà Nẵng – Hội An"}</p>
    </div>
  ` : "";

  const hv = data.han_viet;
  const hanVietBlock = hv && hv.co_han_viet ? `
    <div class="card">
      <h3>🏮 Giải nghĩa Hán – Nôm</h3>
      <p><strong>Chữ gốc:</strong> ${hv.chu_goc || ""} (${hv.phien_am || ""})</p>
      <p>${hv.y_nghia_tong_the || ""}</p>
    </div>
  ` : "";

  const mapButtonBlock = data.hien_chi_duong
    ? `<a class="ai-map-btn" href="${data.chi_duong_url}" target="_blank" rel="noopener">📍 Chỉ đường qua Google Maps</a>`
    : `<a class="ai-map-btn" href="${data.google_maps_url}" target="_blank" rel="noopener">🛒 Tìm địa chỉ mua vật phẩm này</a>`;

  const reviewsHtml = (data.danh_gia_ban_dia?.review_mau || [])
    .map((r) => `<div class="review-item"><span class="tag-local">THỔ ĐỊA</span>${r}</div>`)
    .join("");

  const badgeRight = fromHistory
    ? `<span class="badge-live" style="background:#fef3c7;color:#92400e;">🕒 Đã lưu</span>`
    : `<span class="badge-live">✓ Live AI</span>`;

  sheetContent.innerHTML = `
    <div class="sheet-header">
      <div class="badges">
        <span class="badge-type">${data.loai_doi_tuong || "NHẬN DIỆN"}</span>
        ${badgeRight}
      </div>
      <button class="btn-close" onclick="closeSheet()">✕</button>
    </div>

    <h2 class="title">${data.ten_dia_diem || "Kết quả nhận diện"}</h2>
    <div class="meta">📍 ${data.dia_chi || "Đà Nẵng – Hội An"} • ${data.nien_dai_hoac_gia || ""} • ${fromHistory ? "🕒 " : "⚡ "}${timeOrElapsed}</div>

    <div class="action-row">
      <button id="speakBtn" class="btn-primary" onclick="speakText(currentSpeechText)">🔊 Nghe thuyết minh</button>
      ${mapButtonBlock}
    </div>

    <div class="card">
      <h3>📜 Thông tin & Câu chuyện</h3>
      <p>${data.cau_chuyen_lich_su || ""}</p>
    </div>

    <div class="card">
      <h3>✨ Điểm độc đáo</h3>
      <p>${data.giai_thoai_dac_biet || ""}</p>
    </div>

    ${productBlock}
    ${hanVietBlock}

    <div class="card">
      <h3>💬 Đánh giá từ người địa phương</h3>
      <p>${data.danh_gia_ban_dia?.tom_tat || ""}</p>
      ${reviewsHtml}
    </div>
  `;
  sheet.classList.add("open");
}

// ==========================================
// 7. SỰ KIỆN NÚT BẤM
// ==========================================
document.getElementById("captureBtn").addEventListener("click", () => {
  if (!video.videoWidth) return;
  const maxW = 900;
  const scale = Math.min(1, maxW / video.videoWidth);
  canvas.width = video.videoWidth * scale;
  canvas.height = video.videoHeight * scale;
  canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
  const base64 = canvas.toDataURL("image/jpeg", 0.78).split(",")[1];
  const thumb = makeThumbnail(canvas);
  scanBase64(base64, thumb);
});

document.getElementById("switchBtn").addEventListener("click", () => {
  facingMode = facingMode === "environment" ? "user" : "environment";
  startCamera();
});

document.getElementById("uploadBtn").addEventListener("click", () => {
  document.getElementById("fileInput").click();
});

document.getElementById("menuBtn").addEventListener("click", () => openMenuSheet("history"));

document.getElementById("fileInput").addEventListener("change", (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      const maxW = 900;
      const scale = Math.min(1, maxW / img.width);
      canvas.width = img.width * scale;
      canvas.height = img.height * scale;
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      const base64 = canvas.toDataURL("image/jpeg", 0.8).split(",")[1];
      const thumb = makeThumbnail(canvas);
      scanBase64(base64, thumb);
    };
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
});

updateHistoryBadge();
startCamera();
initGPS();
