/**
 * AIvolution Team
 * Bản quyền thuộc về AIvolution Team
 */

const tls = require("tls");
const crypto = require("crypto");

// ==========================================
// 1. CẤU HÌNH HỆ THỐNG (NHANH 4–10s & CHÍNH XÁC)
// ==========================================
const CONFIG = {
  DN_HA_BOUNDS: { minLat: 15.70, maxLat: 16.20, minLng: 107.90, maxLng: 108.45 },
  GEMINI_MODELS: ["gemini-3.5-flash-lite", "gemini-3.8-flash"],
  TOTAL_VISION_BUDGET_MS: 9500,
  GEMINI_BUDGET_MS: 6500,
  GEMINI_ATTEMPT_TIMEOUT_MS: 6200,
  GROQ_ATTEMPT_TIMEOUT_MS: 3200,
  GROQ_MODELS_TIMEOUT_MS: 1600,
  CHAT_TIMEOUT_MS: 6500,
  TTS_TIMEOUT_MS: 4500,
  MODELS_CACHE_TTL_MS: 10 * 60 * 1000,
  KEY_COOLDOWN_429_MS: 60 * 1000,
  KEY_COOLDOWN_5XX_MS: 20 * 1000,
  KEY_COOLDOWN_AUTH_MS: 10 * 60 * 1000,
  FRIENDLY_ERROR:
    "Opps! Mình không thể nhận diện được, có lẽ do bạn chụp không rõ, bị mờ hoặc thiếu sáng. Bạn giữ chắc tay và chụp rõ hơn giúp mình nhé!"
};

// Bộ nhớ đệm giữ trạng thái key/model khỏe trên Serverless instance
const runtimeState = {
  cachedGroqModels: null,
  cachedGroqModelsAt: 0,
  lastWorkingGeminiModel: null,
  lastWorkingGeminiKey: null,
  lastWorkingGroqVision: null,
  lastWorkingGroqKey: null,
  badGeminiModels: new Set(),
  badGroqVisionModels: new Set(),
  keyCooldownUntil: new Map()
};

// ==========================================
// 2. QUẢN LÝ KEY & MODEL ƯU TIÊN NGUỒN KHỎE
// ==========================================
function collectApiKeys(prefix) {
  const raw = [];
  if (process.env[prefix]) {
    raw.push(...String(process.env[prefix]).split(/[\s,;]+/));
  }
  for (let i = 1; i <= 10; i++) {
    const val = process.env[`${prefix}_${i}`];
    if (val) raw.push(...String(val).split(/[\s,;]+/));
  }

  const unique = [...new Set(raw.map((k) => k.trim()).filter(Boolean))];
  if (unique.length <= 1) return unique;

  const now = Date.now();
  const isGemini = prefix.includes("GEMINI");
  const preferredKey = isGemini
    ? runtimeState.lastWorkingGeminiKey
    : runtimeState.lastWorkingGroqKey;

  const ready = unique.filter((k) => (runtimeState.keyCooldownUntil.get(k) || 0) <= now);
  const cooling = unique.filter((k) => (runtimeState.keyCooldownUntil.get(k) || 0) > now);

  if (preferredKey && ready.includes(preferredKey)) {
    return [preferredKey, ...ready.filter((k) => k !== preferredKey), ...cooling];
  }
  return [...ready, ...cooling];
}

function getOrderedGeminiModels() {
  const active = CONFIG.GEMINI_MODELS.filter((m) => !runtimeState.badGeminiModels.has(m));
  const list = active.length ? active : [...CONFIG.GEMINI_MODELS];
  if (runtimeState.lastWorkingGeminiModel && list.includes(runtimeState.lastWorkingGeminiModel)) {
    return [
      runtimeState.lastWorkingGeminiModel,
      ...list.filter((m) => m !== runtimeState.lastWorkingGeminiModel)
    ];
  }
  return list;
}

function markKeyCooldown(apiKey, ms = CONFIG.KEY_COOLDOWN_429_MS) {
  runtimeState.keyCooldownUntil.set(apiKey, Date.now() + ms);
  if (runtimeState.lastWorkingGeminiKey === apiKey) runtimeState.lastWorkingGeminiKey = null;
  if (runtimeState.lastWorkingGroqKey === apiKey) runtimeState.lastWorkingGroqKey = null;
}

function fetchWithTimeout(url, options = {}, timeoutMs = 4500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(800, timeoutMs));
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
}

// ==========================================
// 3. TIỆN ÍCH ĐỊA LÝ & CHUẨN HÓA DỮ LIỆU
// ==========================================
function clampToDaNangHoiAn(lat, lng, locationContext = "") {
  const numLat = Number(lat);
  const numLng = Number(lng);
  const ctx = String(locationContext || "").toLowerCase();
  const { minLat, maxLat, minLng, maxLng } = CONFIG.DN_HA_BOUNDS;

  if (
    Number.isFinite(numLat) &&
    Number.isFinite(numLng) &&
    numLat >= minLat &&
    numLat <= maxLat &&
    numLng >= minLng &&
    numLng <= maxLng
  ) {
    return { lat: Number(numLat.toFixed(6)), lng: Number(numLng.toFixed(6)) };
  }
  if (ctx.includes("hội an") || ctx.includes("hoi an")) {
    return { lat: 15.8801, lng: 108.3380 };
  }
  return { lat: 16.0544, lng: 108.2022 };
}

function buildDnHaMapsUrl({ query = "", lat, lng, locationContext = "" } = {}) {
  const point = clampToDaNangHoiAn(lat, lng, locationContext);
  const cleanQuery = String(query || "").trim();
  const scopedQuery = cleanQuery
    ? (/đà nẵng|hội an/i.test(cleanQuery) ? cleanQuery : `${cleanQuery}, Đà Nẵng - Hội An`)
    : "Đà Nẵng - Hội An";

  const params = new URLSearchParams({
    api: "1",
    query: scopedQuery,
    center: `${point.lat},${point.lng}`,
    zoom: "15"
  });
  return `https://www.google.com/maps/search/?${params.toString()}`;
}

function buildDnHaDirectionsUrl({ destName = "", lat, lng, locationContext = "" } = {}) {
  const origin = clampToDaNangHoiAn(lat, lng, locationContext);
  const cleanDest = String(destName || "").trim();
  const scopedDest = cleanDest
    ? (/đà nẵng|hội an/i.test(cleanDest) ? cleanDest : `${cleanDest}, Đà Nẵng - Hội An`)
    : "Hội An, Đà Nẵng";

  const params = new URLSearchParams({
    api: "1",
    origin: `${origin.lat},${origin.lng}`,
    destination: scopedDest,
    travelmode: "driving"
  });
  return `https://www.google.com/maps/dir/?${params.toString()}`;
}

function extractJson(rawText) {
  const cleaned = String(rawText || "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/```json|```/gi, "")
    .trim();

  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("Phản hồi AI không phải JSON hợp lệ");
  }

  let jsonStr = cleaned.slice(start, end + 1);
  try {
    return JSON.parse(jsonStr);
  } catch (_) {
    jsonStr = jsonStr
      .replace(/,\s*([}\]])/g, "$1")
      .replace(/[\u0000-\u0019]+/g, " ");
    return JSON.parse(jsonStr);
  }
}

function normalizeScanResult(raw, { areaPoint, locationContext, provider }) {
  const data = raw && typeof raw === "object" ? raw : {};

  if (data.khong_nhan_dien_duoc === true || data.error) {
    return {
      error: CONFIG.FRIENDLY_ERROR,
      debug: String(data.ly_do || data.debug || "Ảnh không đủ rõ nét")
    };
  }

  const loai = String(data.loai_doi_tuong || "Vật thể").trim();
  const isPlace =
    data.la_dia_diem === true ||
    /di tích|nhà hàng|quán ăn|workshop|shop|hán nôm|địa điểm/i.test(loai);

  const sp = data.thong_tin_san_pham && typeof data.thong_tin_san_pham === "object"
    ? data.thong_tin_san_pham
    : {};
  const hv = data.han_viet && typeof data.han_viet === "object"
    ? data.han_viet
    : {};
  const dg = data.danh_gia_ban_dia && typeof data.danh_gia_ban_dia === "object"
    ? data.danh_gia_ban_dia
    : {};

  const ten = String(data.ten_dia_diem || "Chưa xác định rõ").trim();
  const diaChi = String(data.dia_chi || (isPlace ? "Đà Nẵng – Hội An" : "Không xác định từ ảnh")).trim();
  const nienDaiGia = String(data.nien_dai_hoac_gia || "Chưa rõ").trim();

  const normalized = {
    loai_doi_tuong: loai,
    la_dia_diem: isPlace,
    ten_dia_diem: ten,
    dia_chi: diaChi,
    nien_dai_hoac_gia: nienDaiGia,
    cau_chuyen_lich_su: String(data.cau_chuyen_lich_su || "").trim(),
    giai_thoai_dac_biet: String(data.giai_thoai_dac_biet || "").trim(),
    thong_tin_san_pham: {
      hien_thi: typeof sp.hien_thi === "boolean" ? sp.hien_thi : !isPlace,
      calo_uoc_tinh: String(sp.calo_uoc_tinh || "Không áp dụng").trim(),
      tot_cho_suc_khoe: String(sp.tot_cho_suc_khoe || "Không áp dụng").trim(),
      chi_tiet_san_pham: String(sp.chi_tiet_san_pham || "Chưa xác định rõ từ ảnh").trim(),
      noi_mua_goi_y: String(sp.noi_mua_goi_y || "Các cửa hàng hoặc siêu thị liên quan").trim(),
      tu_khoa_mua_hang: String(sp.tu_khoa_mua_hang || "").trim()
    },
    han_viet: {
      co_han_viet: Boolean(hv.co_han_viet && String(hv.chu_goc || "").trim()),
      chu_goc: String(hv.chu_goc || "").trim(),
      phien_am: String(hv.phien_am || "").trim(),
      phan_tich_tung_tu: Array.isArray(hv.phan_tich_tung_tu) ? hv.phan_tich_tung_tu : [],
      y_nghia_tong_the: String(hv.y_nghia_tong_the || "").trim()
    },
    danh_gia_ban_dia: {
      tom_tat: String(dg.tom_tat || "Nhận xét thực tế dựa trên đặc điểm nhận diện trong ảnh.").trim(),
      review_mau: Array.isArray(dg.review_mau)
        ? dg.review_mau.map((r) => String(r || "").trim()).filter(Boolean).slice(0, 2)
        : []
    },
    toa_do_khu_vuc: {
      lat: areaPoint.lat,
      lng: areaPoint.lng,
      khu_vuc: "Đà Nẵng – Hội An"
    },
    _provider: provider
  };

  if (isPlace) {
    const placeQuery = ten || diaChi;
    normalized.hien_chi_duong = true;
    normalized.google_maps_url = buildDnHaMapsUrl({
      query: placeQuery,
      lat: areaPoint.lat,
      lng: areaPoint.lng,
      locationContext
    });
    normalized.chi_duong_url = buildDnHaDirectionsUrl({
      destName: placeQuery,
      lat: areaPoint.lat,
      lng: areaPoint.lng,
      locationContext
    });
  } else {
    const buyQuery = normalized.thong_tin_san_pham.tu_khoa_mua_hang || `mua ${ten}`;
    normalized.hien_chi_duong = false;
    normalized.google_maps_url = buildDnHaMapsUrl({
      query: buyQuery,
      lat: areaPoint.lat,
      lng: areaPoint.lng,
      locationContext
    });
    normalized.chi_duong_url = "";
  }

  return normalized;
}

// ==========================================
// 4. PROMPT CHUẨN XÁC TUYỆT ĐỐI – KHÔNG BỊA – SÚC TÍCH
// ==========================================
function buildVisionPrompt(locationContext) {
  return `Bạn là hệ thống nhận diện hình ảnh chính xác, trung thực tuyệt đối cho ứng dụng du lịch & đời sống AIvolution.
Ngữ cảnh người dùng: ${locationContext || "Đà Nẵng – Hội An"}.

NGUYÊN TẮC TRUNG THỰC TUYỆT ĐỐI (BẮT BUỘC):
1. CHỈ nhận diện và mô tả đúng những gì NHÌN THẤY RÕ trong ảnh kết hợp kiến thức xác thực.
2. KHÔNG BỊA ĐẶT:
   - Không bịa tên hãng/thương hiệu, mã sản phẩm nếu không đọc rõ chữ/logo trong ảnh.
   - Không bịa niên đại, số liệu, tên quán ăn cụ thể hay câu chuyện không có thật.
   - KHÔNG gượng ép gắn đồ vật thường ngày (chai nước, bàn phím, quạt, bình lắc...) vào văn hóa Đà Nẵng – Hội An. Chỉ liên hệ Đà Nẵng – Hội An khi đối tượng thực sự là địa danh, di tích, đặc sản hoặc địa điểm tại khu vực này.
   - Nếu thông tin nào không đủ căn cứ từ ảnh, ghi rõ "Chưa xác định rõ từ ảnh" hoặc "Không áp dụng".
3. PHÂN BIỆT ẨM THỰC MIỀN TRUNG CHUẨN XÁC:
   - Cao lầu: sợi mì dày vuông màu vàng/nâu, thịt xá xíu, ram giòn, ít nước xốt, KHÔNG đậu phộng.
   - Mì Quảng: sợi mì dẹt bản to, có đậu phộng rang, bánh tráng mè, nước dùng ít.
   - Bún bò: sợi tròn to, nước cam đỏ sả/dầu điều. Phở: sợi dẹt trắng mỏng, nước trong.
4. VỚI ĐỒ VẬT / SẢN PHẨM KHÔNG ĂN ĐƯỢC:
   - "calo_uoc_tinh" BẮT BUỘC ghi "Không áp dụng".
   - "tot_cho_suc_khoe" nêu công năng/lưu ý sử dụng an toàn thực tế (không bịa dinh dưỡng).
5. HÁN – NÔM: Chỉ bật "co_han_viet": true khi ảnh thực sự có chữ Hán/Nôm nhìn rõ nét; tuyệt đối không tự bịa chữ.
6. Chỉ trả "khong_nhan_dien_duoc": true khi ảnh tối đen, nhòe nặng hoặc không thấy chủ thể.
7. VIẾT SÚC TÍCH, MẠCH LẠC (2–3 câu mỗi mục) để tốc độ phản hồi nhanh dưới 5 giây.

CHỈ TRẢ VỀ JSON HỢP LỆ (không thêm chữ ngoài JSON):
{
  "khong_nhan_dien_duoc": false,
  "loai_doi_tuong": "Di tích | Nhà hàng & Quán ăn | Shop & Workshop | Hán Nôm | Thức ăn & Đồ uống | Sản phẩm | Vật thể",
  "la_dia_diem": false,
  "ten_dia_diem": "Tên chính xác, trung thực (không bịa hãng nếu không thấy chữ)",
  "dia_chi": "Địa chỉ thật nếu là địa điểm xác định được, ngược lại ghi 'Không áp dụng'",
  "nien_dai_hoac_gia": "Niên đại xác thực hoặc khoảng giá tham khảo VNĐ, không rõ ghi 'Chưa xác định'",
  "cau_chuyen_lich_su": "2-3 câu chính xác về bản chất, công dụng hoặc nguồn gốc đã xác thực của đối tượng.",
  "giai_thoai_dac_biet": "2-3 câu mô tả đúng các chi tiết thực tế quan sát được trong ảnh (màu sắc, hình dáng, chất liệu, đặc điểm nổi bật).",
  "thong_tin_san_pham": {
    "hien_thi": true,
    "calo_uoc_tinh": "Ước tính kcal nếu là món ăn/đồ uống, ngược lại ghi 'Không áp dụng'",
    "tot_cho_suc_khoe": "1-2 câu thực tế về dinh dưỡng (với món ăn) hoặc lưu ý sử dụng/vệ sinh an toàn (với đồ vật).",
    "chi_tiet_san_pham": "Chất liệu/thành phần thấy rõ hoặc đặc trưng phổ biến nhất.",
    "noi_mua_goi_y": "Loại cửa hàng phổ biến (VD: Siêu thị, cửa hàng thể thao, chợ truyền thống...; chỉ ghi tên quán cụ thể nếu chắc chắn).",
    "tu_khoa_mua_hang": "Từ khóa tìm kiếm ngắn gọn trên Google Maps"
  },
  "han_viet": {
    "co_han_viet": false,
    "chu_goc": "",
    "phien_am": "",
    "phan_tich_tung_tu": [],
    "y_nghia_tong_the": ""
  },
  "danh_gia_ban_dia": {
    "tom_tat": "1-2 câu đánh giá khách quan về ưu điểm thực tế, không bịa đặt.",
    "review_mau": ["Ưu điểm thực tế 1", "Lưu ý thực tế 2"]
  }
}
Lưu ý: Nếu là địa điểm/di tích/quán ăn thì đặt "la_dia_diem": true và "thong_tin_san_pham.hien_thi": false. Nếu là món ăn/đồ uống/sản phẩm/vật thể thì đặt "la_dia_diem": false và "thong_tin_san_pham.hien_thi": true.`;
}

// ==========================================
// 5. TẦNG 1: GEMINI FREE (GIỚI HẠN NGÂN SÁCH 6.2s)
// ==========================================
async function callGeminiVisionOnce({ apiKey, model, prompt, imageBase64, timeoutMs }) {
  const cleanBase64 = String(imageBase64).replace(/^data:image\/\w+;base64,/, "");
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const generationConfig = {
    temperature: 0.1,
    topP: 0.8,
    maxOutputTokens: 780,
    responseMimeType: "application/json"
  };
  if (model.includes("3.8-flash")) {
    generationConfig.thinkingConfig = { thinkingBudget: 0 };
  }

  try {
    const res = await fetchWithTimeout(
      endpoint,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [
                { text: prompt },
                { inlineData: { mimeType: "image/jpeg", data: cleanBase64 } }
              ]
            }
          ],
          generationConfig
        })
      },
      timeoutMs
    );

    const rawText = await res.text();
    if (!res.ok) {
      let msg = rawText.slice(0, 140);
      try {
        msg = JSON.parse(rawText)?.error?.message || msg;
      } catch (_) {}
      const err = new Error(`Gemini(${model}) HTTP ${res.status}: ${msg}`);
      err.status = res.status;
      throw err;
    }

    const parsed = JSON.parse(rawText.trim());
    const content = parsed.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!content) throw new Error(`Gemini(${model}): Empty content`);
    return extractJson(content);
  } catch (err) {
    if (err.name === "AbortError") {
      const timeoutErr = new Error(`Gemini(${model}) timeout (${timeoutMs}ms)`);
      timeoutErr.isTimeout = true;
      throw timeoutErr;
    }
    throw err;
  }
}

async function runGeminiVision({ apiKeys, prompt, imageBase64, deadlineMs }) {
  const errors = [];
  const models = getOrderedGeminiModels();
  const primaryModel = models[0];
  const raceKeys = apiKeys.slice(0, 2);

  // Chạy đua song song 2 key đầu tiên trên model ưu tiên để lấy phản hồi nhanh nhất
  const remaining = deadlineMs - Date.now();
  if (primaryModel && raceKeys.length && remaining >= 1500) {
    const attemptTimeout = Math.min(CONFIG.GEMINI_ATTEMPT_TIMEOUT_MS, remaining);
    try {
      const winner = await Promise.any(
        raceKeys.map(async (apiKey) => {
          try {
            const result = await callGeminiVisionOnce({
              apiKey,
              model: primaryModel,
              prompt,
              imageBase64,
              timeoutMs: attemptTimeout
            });
            if (result && typeof result === "object") {
              return { result, apiKey };
            }
            throw new Error("Empty result");
          } catch (err) {
            if (err.status === 404) runtimeState.badGeminiModels.add(primaryModel);
            else if (err.status === 401 || err.status === 403) markKeyCooldown(apiKey, CONFIG.KEY_COOLDOWN_AUTH_MS);
            else if (err.status === 429) markKeyCooldown(apiKey, CONFIG.KEY_COOLDOWN_429_MS);
            else if (err.status === 500 || err.status === 503 || err.isTimeout) markKeyCooldown(apiKey, CONFIG.KEY_COOLDOWN_5XX_MS);
            throw err;
          }
        })
      );

      runtimeState.lastWorkingGeminiModel = primaryModel;
      runtimeState.lastWorkingGeminiKey = winner.apiKey;
      return { result: winner.result, provider: `gemini:${primaryModel}` };
    } catch (aggErr) {
      const list = Array.isArray(aggErr?.errors) ? aggErr.errors : [aggErr];
      errors.push(...list.map((e) => e?.message || "Gemini race failed"));
    }
  }

  // Dự phòng: thử các key/model còn lại nếu còn đủ thời gian (>= 2.2s)
  for (const model of models) {
    if (runtimeState.badGeminiModels.has(model)) continue;
    for (const apiKey of apiKeys) {
      if (model === primaryModel && raceKeys.includes(apiKey)) continue;
      const left = deadlineMs - Date.now();
      if (left < 2200) break;

      try {
        const result = await callGeminiVisionOnce({
          apiKey,
          model,
          prompt,
          imageBase64,
          timeoutMs: Math.min(CONFIG.GEMINI_ATTEMPT_TIMEOUT_MS, left)
        });
        if (result && typeof result === "object") {
          runtimeState.lastWorkingGeminiModel = model;
          runtimeState.lastWorkingGeminiKey = apiKey;
          return { result, provider: `gemini:${model}` };
        }
      } catch (err) {
        errors.push(err.message || `Gemini(${model}): Failed`);
        if (err.status === 404) {
          runtimeState.badGeminiModels.add(model);
          break;
        }
        if (err.status === 401 || err.status === 403) markKeyCooldown(apiKey, CONFIG.KEY_COOLDOWN_AUTH_MS);
        else if (err.status === 429) markKeyCooldown(apiKey, CONFIG.KEY_COOLDOWN_429_MS);
        else if (err.status === 500 || err.status === 503 || err.isTimeout) markKeyCooldown(apiKey, CONFIG.KEY_COOLDOWN_5XX_MS);
      }
    }
    if (deadlineMs - Date.now() < 2200) break;
  }

  const finalErr = new Error(errors.slice(0, 2).join(" | ") || "Gemini không phản hồi kịp");
  finalErr.isRateLimit = errors.some((e) => e.includes("429"));
  throw finalErr;
}
async function handleGeminiChat({ apiKeys, messages, locationContext }) {
  const systemPrompt = `Bạn là trợ lý du lịch, ẩm thực và đời sống AIvolution am hiểu Đà Nẵng – Hội An.
Vị trí người dùng: ${locationContext || "Đà Nẵng – Hội An"}.
Nguyên tắc: Trả lời bằng tiếng Việt tự nhiên, ngắn gọn, chính xác; không bịa tên quán hay địa chỉ nếu không chắc chắn.`;

  const contents = (Array.isArray(messages) ? messages.slice(-10) : []).map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: String(m.content || "") }]
  }));

  for (const model of getOrderedGeminiModels()) {
    for (const apiKey of apiKeys) {
      try {
        const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
        const generationConfig = { temperature: 0.3, maxOutputTokens: 650 };
        if (model.includes("3.8-flash")) {
          generationConfig.thinkingConfig = { thinkingBudget: 0 };
        }

        const res = await fetchWithTimeout(
          endpoint,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              systemInstruction: { parts: [{ text: systemPrompt }] },
              contents,
              generationConfig
            })
          },
          CONFIG.CHAT_TIMEOUT_MS
        );

        if (res.status === 404) {
          runtimeState.badGeminiModels.add(model);
          break;
        }
        if (res.status === 429) {
          markKeyCooldown(apiKey, CONFIG.KEY_COOLDOWN_429_MS);
          continue;
        }
        if (res.status === 401 || res.status === 403) {
          markKeyCooldown(apiKey, CONFIG.KEY_COOLDOWN_AUTH_MS);
          continue;
        }
        if (!res.ok) continue;

        const data = await res.json();
        const reply = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
        if (reply) {
          runtimeState.lastWorkingGeminiModel = model;
          runtimeState.lastWorkingGeminiKey = apiKey;
          return reply;
        }
      } catch (_) {}
    }
  }
  throw new Error("Gemini chat unavailable");
}

// ==========================================
// 6. TẦNG 2: GROQ FALLBACK NHANH (TRẦN CÒN LẠI <= 3.2s)
// ==========================================
async function fetchWorkingGroqModels(apiKey, timeoutMs = CONFIG.GROQ_MODELS_TIMEOUT_MS) {
  const now = Date.now();
  if (
    runtimeState.cachedGroqModels &&
    now - runtimeState.cachedGroqModelsAt < CONFIG.MODELS_CACHE_TTL_MS
  ) {
    return runtimeState.cachedGroqModels;
  }

  const res = await fetchWithTimeout(
    "https://api.groq.com/openai/v1/models",
    { headers: { Authorization: `Bearer ${apiKey}` } },
    timeoutMs
  );
  if (!res.ok) throw new Error(`Groq models HTTP ${res.status}`);

  const data = await res.json();
  const activeModels = (data.data || [])
    .map((m) => m.id)
    .filter(
      (id) =>
        id &&
        !/whisper|tts|guard|safeguard|embed|prompt-guard|playai|orpheus|compound/i.test(id)
    );

  if (!activeModels.length) throw new Error("Không tìm thấy model khả dụng trên Groq");

  runtimeState.cachedGroqModels = activeModels;
  runtimeState.cachedGroqModelsAt = now;
  return activeModels;
}

function getOrderedGroqVisionModels(liveModels) {
  const textOnly = /gpt-oss|deepseek|mixtral|llama-3\.1|llama-3\.3|llama3-|allam|gemma2/i;
  const visionPriority = /vision|vl|maverick|scout|llama-4|llama-5|omni|multimodal|pixtral|kimi|qwen/i;

  const filtered = liveModels.filter(
    (m) => !textOnly.test(m) && !runtimeState.badGroqVisionModels.has(m)
  );
  const primary = filtered.filter((m) => visionPriority.test(m));
  const secondary = filtered.filter((m) => !visionPriority.test(m));
  const list = [...primary, ...secondary];

  if (runtimeState.lastWorkingGroqVision && list.includes(runtimeState.lastWorkingGroqVision)) {
    return [
      runtimeState.lastWorkingGroqVision,
      ...list.filter((m) => m !== runtimeState.lastWorkingGroqVision)
    ];
  }
  return list;
}

async function callGroqVision({ apiKey, model, prompt, imageBase64, timeoutMs }) {
  const imageUrl = String(imageBase64).startsWith("data:image")
    ? imageBase64
    : `data:image/jpeg;base64,${imageBase64}`;

  const res = await fetchWithTimeout(
    "https://api.groq.com/openai/v1/chat/completions",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        temperature: 0.1,
        max_tokens: 720,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              { type: "image_url", image_url: { url: imageUrl } }
            ]
          }
        ]
      })
    },
    timeoutMs
  );

  const rawText = await res.text();
  if (!res.ok) {
    const err = new Error(`Groq(${model}): HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }

  const parsed = JSON.parse(rawText.trim());
  const content = parsed.choices?.[0]?.message?.content;
  if (!content) throw new Error(`Groq(${model}): Empty content`);
  return extractJson(content);
}

async function runGroqVision({ apiKeys, prompt, imageBase64, deadlineMs }) {
  const errors = [];

  for (const apiKey of apiKeys) {
    const remainingForList = deadlineMs - Date.now();
    if (remainingForList < 1200) break;

    let candidates = [];
    if (runtimeState.lastWorkingGroqVision && !runtimeState.badGroqVisionModels.has(runtimeState.lastWorkingGroqVision)) {
      candidates = [runtimeState.lastWorkingGroqVision];
    } else {
      try {
        const liveModels = await fetchWorkingGroqModels(
          apiKey,
          Math.min(CONFIG.GROQ_MODELS_TIMEOUT_MS, remainingForList - 800)
        );
        candidates = getOrderedGroqVisionModels(liveModels).slice(0, 3);
      } catch (err) {
        errors.push(err.message);
        continue;
      }
    }

    for (const model of candidates) {
      const remaining = deadlineMs - Date.now();
      if (remaining < 1000) break;

      try {
        const result = await callGroqVision({
          apiKey,
          model,
          prompt,
          imageBase64,
          timeoutMs: Math.min(CONFIG.GROQ_ATTEMPT_TIMEOUT_MS, remaining)
        });
        if (result && typeof result === "object") {
          runtimeState.lastWorkingGroqVision = model;
          runtimeState.lastWorkingGroqKey = apiKey;
          return { result, provider: `groq:${model}` };
        }
      } catch (err) {
        errors.push(err.message || `Groq(${model}): Failed`);
        if (err.status === 400 || err.status === 404) {
          runtimeState.badGroqVisionModels.add(model);
          if (runtimeState.lastWorkingGroqVision === model) {
            runtimeState.lastWorkingGroqVision = null;
          }
          continue;
        }
        if (err.status === 429 || err.status === 401 || err.status === 403) {
          markKeyCooldown(
            apiKey,
            err.status === 429 ? CONFIG.KEY_COOLDOWN_429_MS : CONFIG.KEY_COOLDOWN_AUTH_MS
          );
          break;
        }
      }
    }
  }

  const finalErr = new Error(errors.slice(0, 2).join(" | ") || "Groq không phản hồi kịp");
  finalErr.isRateLimit = errors.some((e) => e.includes("429"));
  throw finalErr;
}

async function handleGroqChat({ apiKeys, messages, locationContext }) {
  const systemPrompt = `Bạn là trợ lý AIvolution thông minh, trung thực và am hiểu Đà Nẵng – Hội An.
Vị trí hiện tại của người dùng: ${locationContext || "Đà Nẵng – Hội An"}.
Trả lời bằng tiếng Việt ngắn gọn, chính xác; không bịa thông tin nếu không chắc chắn.`;

  const chatMessages = [
    { role: "system", content: systemPrompt },
    ...(Array.isArray(messages) ? messages.slice(-10) : [])
  ];

  for (const apiKey of apiKeys) {
    let models;
    try {
      models = await fetchWorkingGroqModels(apiKey);
    } catch (_) {
      continue;
    }

    const sortedModels = [
      ...models.filter((m) => /llama-3\.3|llama-3\.1|llama-4|qwen|gpt-oss/i.test(m)),
      ...models.filter((m) => !/llama-3\.3|llama-3\.1|llama-4|qwen|gpt-oss/i.test(m))
    ];

    for (const model of sortedModels.slice(0, 3)) {
      try {
        const res = await fetchWithTimeout(
          "https://api.groq.com/openai/v1/chat/completions",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${apiKey}`
            },
            body: JSON.stringify({
              model,
              temperature: 0.3,
              max_tokens: 600,
              messages: chatMessages
            })
          },
          CONFIG.CHAT_TIMEOUT_MS
        );
        if (res.status === 429) {
          markKeyCooldown(apiKey, CONFIG.KEY_COOLDOWN_429_MS);
          break;
        }
        if (res.status === 401 || res.status === 403) {
          markKeyCooldown(apiKey, CONFIG.KEY_COOLDOWN_AUTH_MS);
          break;
        }
        if (!res.ok) continue;
        const data = await res.json();
        const reply = data.choices?.[0]?.message?.content?.trim();
        if (reply) {
          runtimeState.lastWorkingGroqKey = apiKey;
          return reply.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
        }
      } catch (_) {}
    }
  }
  throw new Error("Trợ lý tạm thời bận, bạn thử gửi lại sau vài giây nhé.");
}

// ==========================================
// 7. GIỌNG ĐỌC MP3 (HOÀI MY NEURAL + DỰ PHÒNG)
// ==========================================
function cleanTtsText(rawText) {
  return String(rawText || "")
    .replace(/[*#_•~`]/g, " ")
    .replace(/[\u{1F300}-\u{1FAFF}]/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1200);
}

function escapeXml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function generateSecMsGec(trustedToken) {
  let ticks = BigInt(Math.floor(Date.now() / 1000)) + 11644473600n;
  ticks -= ticks % 300n;
  ticks *= 10000000n;
  return crypto
    .createHash("sha256")
    .update(`${ticks.toString()}${trustedToken}`, "ascii")
    .digest("hex")
    .toUpperCase();
}

function createWsFrame(payload, opcode = 0x1) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, "utf8");
  const len = data.length;
  let header;

  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }

  const mask = crypto.randomBytes(4);
  const masked = Buffer.alloc(len);
  for (let i = 0; i < len; i++) {
    masked[i] = data[i] ^ mask[i % 4];
  }
  return Buffer.concat([header, mask, masked]);
}

function generateHoaiMyBase64(cleanText) {
  return new Promise((resolve, reject) => {
    const trustedToken = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
    const connId = crypto.randomBytes(16).toString("hex");
    const reqId = crypto.randomBytes(16).toString("hex");
    const secMsGec = generateSecMsGec(trustedToken);
    const wsKey = crypto.randomBytes(16).toString("base64");

    const path =
      `/consumer/speech/synthesize/readaloud/edge/v1` +
      `?TrustedClientToken=${trustedToken}` +
      `&Sec-MS-GEC=${secMsGec}` +
      `&Sec-MS-GEC-Version=1-143.0.3650.66` +
      `&ConnectionId=${connId}`;

    const socket = tls.connect(443, "speech.platform.bing.com", {
      servername: "speech.platform.bing.com"
    });

    let done = false;
    let upgraded = false;
    let recvBuf = Buffer.alloc(0);
    let lastOpcode = 0x1;
    const audioChunks = [];

    const timer = setTimeout(() => finish(new Error("HoaiMy timeout")), CONFIG.TTS_TIMEOUT_MS);

    function finish(err, result) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      if (err) reject(err);
      else resolve(result);
    }

    socket.on("secureConnect", () => {
      const handshake = [
        `GET ${path} HTTP/1.1`,
        "Host: speech.platform.bing.com",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Key: ${wsKey}`,
        "Sec-WebSocket-Version: 13",
        "Origin: chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold",
        "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0",
        "Pragma: no-cache",
        "Cache-Control: no-cache",
        "\r\n"
      ].join("\r\n");
      socket.write(handshake);
    });

    socket.on("data", (chunk) => {
      recvBuf = Buffer.concat([recvBuf, chunk]);

      if (!upgraded) {
        const headerEnd = recvBuf.indexOf("\r\n\r\n");
        if (headerEnd === -1) return;
        const headerText = recvBuf.slice(0, headerEnd).toString("utf8");
        if (!headerText.includes("101")) return finish(new Error("Edge TTS blocked"));

        upgraded = true;
        recvBuf = recvBuf.slice(headerEnd + 4);

        const ts = new Date().toString();
        const configMsg =
          `X-Timestamp:${ts}\r\n` +
          `Content-Type:application/json; charset=utf-8\r\n` +
          `Path:speech.config\r\n\r\n` +
          `{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}`;

        const ssmlMsg =
          `X-RequestId:${reqId}\r\n` +
          `Content-Type:application/ssml+xml\r\n` +
          `X-Timestamp:${ts}\r\n` +
          `Path:ssml\r\n\r\n` +
          `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='vi-VN'>` +
          `<voice name='vi-VN-HoaiMyNeural'>` +
          `<prosody pitch='+0Hz' rate='+0%' volume='+0%'>${escapeXml(cleanText)}</prosody>` +
          `</voice></speak>`;

        socket.write(createWsFrame(configMsg, 0x1));
        socket.write(createWsFrame(ssmlMsg, 0x1));
      }

      while (recvBuf.length >= 2) {
        const rawOpcode = recvBuf[0] & 0x0f;
        const opcode = rawOpcode === 0x0 ? lastOpcode : rawOpcode;
        if (rawOpcode === 0x1 || rawOpcode === 0x2) lastOpcode = rawOpcode;

        const masked = (recvBuf[1] & 0x80) !== 0;
        let payloadLen = recvBuf[1] & 0x7f;
        let offset = 2;

        if (payloadLen === 126) {
          if (recvBuf.length < 4) return;
          payloadLen = recvBuf.readUInt16BE(2);
          offset = 4;
        } else if (payloadLen === 127) {
          if (recvBuf.length < 10) return;
          payloadLen = Number(recvBuf.readBigUInt64BE(2));
          offset = 10;
        }

        if (masked) offset += 4;
        if (recvBuf.length < offset + payloadLen) return;

        const payload = recvBuf.slice(offset, offset + payloadLen);
        recvBuf = recvBuf.slice(offset + payloadLen);

        if (opcode === 0x1) {
          if (payload.toString("utf8").includes("Path:turn.end")) {
            return audioChunks.length > 0
              ? finish(null, Buffer.concat(audioChunks).toString("base64"))
              : finish(new Error("Empty audio"));
          }
        } else if (opcode === 0x2 && payload.length > 2) {
          if (rawOpcode === 0x2) {
            const headerLen = payload.readUInt16BE(0);
            const headerStr = payload.slice(2, 2 + headerLen).toString("utf8");
            if (headerStr.includes("Path:audio")) {
              audioChunks.push(payload.slice(2 + headerLen));
            }
          } else {
            audioChunks.push(payload);
          }
        } else if (rawOpcode === 0x9) {
          socket.write(createWsFrame(payload, 0xa));
        } else if (rawOpcode === 0x8) {
          return audioChunks.length > 0
            ? finish(null, Buffer.concat(audioChunks).toString("base64"))
            : finish(new Error("Closed"));
        }
      }
    });

    socket.on("error", (err) => finish(err));
    socket.on("close", () => {
      if (!done) {
        if (audioChunks.length > 0) {
          finish(null, Buffer.concat(audioChunks).toString("base64"));
        } else {
          finish(new Error("Socket closed"));
        }
      }
    });
  });
}

function splitTextForMp3(text, maxLen = 175) {
  const sentences = text.match(/[^.!?]+[.!?]*/g) || [text];
  const chunks = [];
  let current = "";

  for (const s of sentences) {
    const part = s.trim();
    if (!part) continue;
    if ((current + " " + part).trim().length <= maxLen) {
      current = (current + " " + part).trim();
    } else {
      if (current) chunks.push(current);
      if (part.length <= maxLen) {
        current = part;
      } else {
        const words = part.split(/\s+/);
        let temp = "";
        for (const w of words) {
          if ((temp + " " + w).trim().length <= maxLen) {
            temp = (temp + " " + w).trim();
          } else {
            if (temp) chunks.push(temp);
            temp = w;
          }
        }
        current = temp;
      }
    }
  }
  if (current) chunks.push(current);
  return chunks.slice(0, 8);
}

async function generateBackupMp3Base64(cleanText) {
  const chunks = splitTextForMp3(cleanText, 175);
  const buffers = await Promise.all(
    chunks.map(async (chunk) => {
      const url = `https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=vi&q=${encodeURIComponent(chunk)}`;
      const res = await fetchWithTimeout(
        url,
        {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
          }
        },
        3000
      );
      if (!res.ok) throw new Error(`Backup TTS HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    })
  );
  return Buffer.concat(buffers).toString("base64");
}

async function generateVoiceBase64(rawText) {
  const cleanText = cleanTtsText(rawText);
  if (!cleanText) return null;

  try {
    const hoaiMy = await generateHoaiMyBase64(cleanText);
    if (hoaiMy) return hoaiMy;
  } catch (_) {}

  return await generateBackupMp3Base64(cleanText);
}

// ==========================================
// 8. ENTRY POINT SERVERLESS HANDLER
// ==========================================
module.exports = async (req, res) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    return res.status(405).json({ error: CONFIG.FRIENDLY_ERROR });
  }

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};

    // --- 1. CHẾ ĐỘ ĐỌC THUYẾT MINH ---
    if (body.mode === "tts") {
      try {
        const audioBase64 = await generateVoiceBase64(body.text);
        if (audioBase64) return res.status(200).json({ audioBase64 });
        return res.status(502).json({ ttsError: "Không có dữ liệu âm thanh" });
      } catch (err) {
        return res.status(502).json({ ttsError: err.message || "Lỗi tạo giọng đọc" });
      }
    }

    const geminiKeys = collectApiKeys("GEMINI_API_KEY");
    const groqKeys = collectApiKeys("GROQ_API_KEY");

    if (!geminiKeys.length && !groqKeys.length) {
      return res.status(500).json({
        error: CONFIG.FRIENDLY_ERROR,
        debug: "Thiếu biến môi trường GEMINI_API_KEY và GROQ_API_KEY trên Vercel"
      });
    }

    // --- 2. CHẾ ĐỘ CHATBOT (Gemini -> Groq) ---
    if (body.mode === "chat") {
      if (geminiKeys.length) {
        try {
          const reply = await handleGeminiChat({
            apiKeys: geminiKeys,
            messages: body.messages,
            locationContext: body.locationContext
          });
          return res.status(200).json({ reply, provider: "gemini" });
        } catch (err) {
          console.error("[Gemini Chat Fallback Reason]:", err.message);
        }
      }
      if (groqKeys.length) {
        const reply = await handleGroqChat({
          apiKeys: groqKeys,
          messages: body.messages,
          locationContext: body.locationContext
        });
        return res.status(200).json({ reply, provider: "groq" });
      }
      throw new Error("Không có API Key hoạt động cho Chatbot");
    }

    // --- 3. CHẾ ĐỘ QUÉT ẢNH (TRẦN 9.2s: Gemini <= 6.2s -> Groq <= 3s) ---
    const { imageBase64, locationContext, lat, lng } = body;
    if (!imageBase64) {
      return res.status(400).json({ error: CONFIG.FRIENDLY_ERROR, debug: "Thiếu dữ liệu ảnh" });
    }

    const requestStart = Date.now();
    const totalDeadline = requestStart + CONFIG.TOTAL_VISION_BUDGET_MS;
    const geminiDeadline = groqKeys.length
      ? requestStart + CONFIG.GEMINI_BUDGET_MS
      : totalDeadline;

    const areaPoint = clampToDaNangHoiAn(lat, lng, locationContext);
    const prompt = buildVisionPrompt(locationContext);

    let visionOutput = null;
    let geminiError = null;

    if (geminiKeys.length) {
      try {
        visionOutput = await runGeminiVision({
          apiKeys: geminiKeys,
          prompt,
          imageBase64,
          deadlineMs: geminiDeadline
        });
      } catch (err) {
        geminiError = err;
        console.error("[Gemini Fallback Reason]:", err.message);
      }
    }

    if (!visionOutput) {
      if (groqKeys.length && totalDeadline - Date.now() >= 1200) {
        visionOutput = await runGroqVision({
          apiKeys: groqKeys,
          prompt,
          imageBase64,
          deadlineMs: totalDeadline
        });
      } else if (geminiError) {
        throw geminiError;
      } else {
        throw new Error("Hết thời gian xử lý ảnh (timeout 10s)");
      }
    }

    const finalPayload = normalizeScanResult(visionOutput.result, {
      areaPoint,
      locationContext,
      provider: visionOutput.provider
    });

    if (finalPayload.error) {
      return res.status(422).json(finalPayload);
    }

    return res.status(200).json(finalPayload);
  } catch (err) {
    return res.status(err?.isRateLimit ? 429 : 502).json({
      error: err?.isRateLimit
        ? "Hệ thống AI đang chạm giới hạn lượt quét miễn phí (HTTP 429). Bạn đợi 15–30 giây rồi bấm Quét lại nhé!"
        : CONFIG.FRIENDLY_ERROR,
      debug: err?.message || "Lỗi xử lý máy chủ"
    });
  }
};
