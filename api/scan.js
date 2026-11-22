/**
 * AIvolution Backend API (Vercel Serverless)
 * Architecture:
 *  - Tier 1: Google Gemini Free (gemini-2.5-flash -> gemini-2.5-flash-lite)
 *  - Tier 2: Groq Vision & Chat Fallback (Auto-discovery + Model Ranking)
 *  - Voice : Edge TTS (vi-VN-HoaiMyNeural) -> Google TTS MP3 Fallback
 */

const tls = require("tls");
const crypto = require("crypto");

// ==========================================
// 1. CẤU HÌNH HỆ THỐNG & HẰNG SỐ
// ==========================================
const CONFIG = {
  DN_HA_BOUNDS: { minLat: 15.70, maxLat: 16.20, minLng: 107.90, maxLng: 108.45 },
  GEMINI_MODELS: ["gemini-2.5-flash", "gemini-2.5-flash-lite"],
  GEMINI_TIMEOUT_MS: 12000,
  GROQ_TIMEOUT_MS: 7000,
  TTS_TIMEOUT_MS: 4500,
  MODELS_CACHE_TTL_MS: 10 * 60 * 1000,
  KEY_COOLDOWN_MS: 60 * 1000,
  FRIENDLY_ERROR:
    "Opps! Mình không thể nhận diện được, có lẽ do bạn chụp không rõ, bị mờ hoặc thiếu sáng. Bạn giữ chắc tay và chụp rõ hơn giúp mình nhé!"
};

// Bộ nhớ đệm trên Serverless instance
const runtimeState = {
  cachedGroqModels: null,
  cachedGroqModelsAt: 0,
  lastWorkingGroqVision: null,
  badGroqVisionModels: new Set(),
  keyCooldownUntil: new Map(),
  cursors: { gemini: 0, groq: 0 }
};

// ==========================================
// 2. QUẢN LÝ & XOAY VÒNG API KEY THÔNG MINH
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

  const cursorKey = prefix.includes("GEMINI") ? "gemini" : "groq";
  const start = runtimeState.cursors[cursorKey] % unique.length;
  runtimeState.cursors[cursorKey] = (start + 1) % unique.length;

  const rotated = [...unique.slice(start), ...unique.slice(0, start)];
  const now = Date.now();

  const ready = rotated.filter((k) => (runtimeState.keyCooldownUntil.get(k) || 0) <= now);
  const cooling = rotated.filter((k) => (runtimeState.keyCooldownUntil.get(k) || 0) > now);
  return [...ready, ...cooling];
}

function markKeyCooldown(apiKey, ms = CONFIG.KEY_COOLDOWN_MS) {
  runtimeState.keyCooldownUntil.set(apiKey, Date.now() + ms);
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

  const loai = String(data.loai_doi_tuong || "Nhận diện").trim();
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

  const ten = String(data.ten_dia_diem || "Kết quả nhận diện").trim();
  const diaChi = String(data.dia_chi || "Đà Nẵng – Hội An").trim();

  const normalized = {
    loai_doi_tuong: loai,
    la_dia_diem: isPlace,
    ten_dia_diem: ten,
    dia_chi: diaChi,
    nien_dai_hoac_gia: String(data.nien_dai_hoac_gia || "Đà Nẵng – Hội An").trim(),
    cau_chuyen_lich_su: String(data.cau_chuyen_lich_su || "").trim(),
    giai_thoai_dac_biet: String(data.giai_thoai_dac_biet || "").trim(),
    thong_tin_san_pham: {
      hien_thi: typeof sp.hien_thi === "boolean" ? sp.hien_thi : !isPlace,
      calo_uoc_tinh: String(sp.calo_uoc_tinh || "").trim(),
      tot_cho_suc_khoe: String(sp.tot_cho_suc_khoe || "").trim(),
      chi_tiet_san_pham: String(sp.chi_tiet_san_pham || "").trim(),
      noi_mua_goi_y: String(sp.noi_mua_goi_y || "").trim(),
      tu_khoa_mua_hang: String(sp.tu_khoa_mua_hang || "").trim()
    },
    han_viet: {
      co_han_viet: Boolean(hv.co_han_viet),
      chu_goc: String(hv.chu_goc || "").trim(),
      phien_am: String(hv.phien_am || "").trim(),
      phan_tich_tung_tu: Array.isArray(hv.phan_tich_tung_tu) ? hv.phan_tich_tung_tu : [],
      y_nghia_tong_the: String(hv.y_nghia_tong_the || "").trim()
    },
    danh_gia_ban_dia: {
      tom_tat: String(dg.tom_tat || "Được người dân địa phương và du khách đánh giá tích cực.").trim(),
      review_mau: Array.isArray(dg.review_mau)
        ? dg.review_mau.map((r) => String(r || "").trim()).filter(Boolean).slice(0, 3)
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
// 4. PROMPT CHUẨN CHUYÊN GIA VĂN HÓA & ẨM THỰC
// ==========================================
function buildVisionPrompt(locationContext) {
  return `Bạn là chuyên gia văn hóa, lịch sử, ẩm thực và du lịch bản địa tại Đà Nẵng – Hội An (Việt Nam).
Ngữ cảnh vị trí & chế độ quét: ${locationContext || "Đà Nẵng – Hội An"}.

I. QUY TẮC QUAN SÁT & PHÂN BIỆT CHÍNH XÁC (BẮT BUỘC KIỂM TRA CHI TIẾT THỰC TẾ TRONG ẢNH):
1. Cao lầu (Hội An) vs Mì Quảng:
   - Cao lầu: Sợi mì dày, tiết diện hơi vuông, màu vàng sậm hoặc nâu nhạt; ăn kèm thịt xá xíu thái lát mỏng viền đỏ/nâu, ram/da heo vuông chiên giòn, giá trụng và rất ít nước xốt đậm màu dưới đáy tô (KHÔNG rắc đậu phộng rang nguyên hạt).
   - Mì Quảng: Sợi mì dẹt bản to (trắng hoặc vàng nghệ); đặc trưng gần như luôn có đậu phộng rang nguyên hạt trên mặt, bánh tráng mè nướng bẻ miếng, tôm/thịt gà/thịt heo/trứng cút, rau sống và nước dùng sâm sấp.
2. Bún bò (Huế / Đà Nẵng) vs Phở:
   - Bún bò: Sợi bún tròn to; nước dùng màu cam đỏ có váng dầu điều/sả ớt; topping thường có bắp bò, chả cua/chả lụa, giò heo, huyết.
   - Phở: Sợi bánh phở dẹt trắng mỏng; nước dùng trong thanh; thịt bò tái/nạm thái mỏng, nhiều hành lá.
3. Đặc sản khác & Địa điểm:
   - Đọc chính xác chữ trên bảng hiệu, nhãn mác, bao bì, bia đá hoặc hoành phi Hán – Nôm.
   - Không bịa đặt địa chỉ số nhà cụ thể nếu ảnh không hiển thị; chỉ ghi khu vực chính xác (VD: "Phố cổ Hội An" hoặc "Đà Nẵng – Hội An").
   - Nếu ảnh quá mờ, tối đen, bị che khuất hoặc không thể xác định đối tượng: trả về duy nhất {"khong_nhan_dien_duoc": true, "ly_do": "Ảnh chưa đủ rõ nét"}.

II. YÊU CẦU VĂN PHONG THUYẾT MINH:
- Viết tiếng Việt chuẩn mực, tự nhiên, giàu chiều sâu văn hóa như hướng dẫn viên chuyên nghiệp; ngắt câu bằng dấu chấm, dấu phẩy rõ ràng để đọc thành giọng nói mượt mà.

III. ĐỊNH DẠNG JSON DUY NHẤT (KHÔNG KÈM CHỮ NGOÀI JSON):
{
  "khong_nhan_dien_duoc": false,
  "loai_doi_tuong": "Di tích | Nhà hàng & Quán ăn | Shop & Workshop | Hán Nôm | Thức ăn & Đồ uống | Sản phẩm | Vật thể",
  "la_dia_diem": true,
  "ten_dia_diem": "Tên chính xác nhất của món ăn, địa điểm hoặc sản phẩm",
  "dia_chi": "Địa chỉ thực tế tại Đà Nẵng / Hội An hoặc thương hiệu/xuất xứ",
  "nien_dai_hoac_gia": "Ghi ngắn gọn niên đại hoặc khoảng giá VNĐ (VD: 35.000 - 50.000đ)",
  "cau_chuyen_lich_su": "2-3 câu chuẩn xác về nguồn gốc, giá trị văn hóa hoặc bản sắc của đối tượng.",
  "giai_thoai_dac_biet": "3-4 câu miêu tả chi tiết hương vị, điểm nhấn kiến trúc hoặc trải nghiệm nổi bật nhìn thấy trong ảnh.",
  "thong_tin_san_pham": {
    "hien_thi": false,
    "calo_uoc_tinh": "VD: 450 - 550 kcal (hoặc Không áp dụng)",
    "tot_cho_suc_khoe": "Nhận xét khách quan về dinh dưỡng, thành phần hoặc lưu ý dị ứng",
    "chi_tiet_san_pham": "Nguyên liệu chính hoặc chất liệu tạo nên sản phẩm",
    "noi_mua_goi_y": "Gợi ý 2-3 địa điểm uy tín tại Đà Nẵng hoặc Hội An",
    "tu_khoa_mua_hang": "Từ khóa tìm kiếm trên Google Maps"
  },
  "han_viet": {
    "co_han_viet": false,
    "chu_goc": "",
    "phien_am": "",
    "phan_tich_tung_tu": [],
    "y_nghia_tong_the": ""
  },
  "danh_gia_ban_dia": {
    "tom_tat": "Tóm tắt góc nhìn thực tế của người bản địa và du khách (1-2 câu).",
    "review_mau": ["Nhận xét ngắn gọn thực tế 1", "Nhận xét ngắn gọn thực tế 2"]
  }
}
Lưu ý: Với món ăn, đồ uống hoặc sản phẩm, đặt "la_dia_diem": false và "thong_tin_san_pham.hien_thi": true rồi điền đầy đủ thông tin dinh dưỡng & nơi mua.`;
}

// ==========================================
// 5. TẦNG 1: GEMINI FREE (GOOGLE AI STUDIO)
// ==========================================
async function callGeminiVision({ apiKey, model, prompt, imageBase64 }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONFIG.GEMINI_TIMEOUT_MS);

  try {
    const cleanBase64 = String(imageBase64).replace(/^data:image\/\w+;base64,/, "");
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;

    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
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
        generationConfig: {
          temperature: 0.15,
          maxOutputTokens: 1000,
          responseMimeType: "application/json"
        }
      }),
      signal: controller.signal
    });

    const rawText = await res.text();
    if (!res.ok) {
      const err = new Error(`Gemini(${model}): HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }

    const parsed = JSON.parse(rawText.trim());
    const content = parsed.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!content) throw new Error(`Gemini(${model}): Empty content`);
    return extractJson(content);
  } finally {
    clearTimeout(timer);
  }
}

async function runGeminiVision({ apiKeys, prompt, imageBase64 }) {
  const errors = [];

  for (const model of CONFIG.GEMINI_MODELS) {
    for (const apiKey of apiKeys) {
      try {
        const result = await callGeminiVision({ apiKey, model, prompt, imageBase64 });
        if (result && typeof result === "object") {
          return { result, provider: `gemini:${model}` };
        }
      } catch (err) {
        errors.push(err.message || `Gemini(${model}): Failed`);
        if (err.status === 429) markKeyCooldown(apiKey);
        if ([400, 401, 403, 429].includes(err.status)) continue;
      }
    }
  }

  const finalErr = new Error(errors.slice(0, 2).join(" | ") || "Gemini không phản hồi");
  finalErr.isRateLimit = errors.some((e) => e.includes("429"));
  throw finalErr;
}

async function handleGeminiChat({ apiKeys, messages, locationContext }) {
  const systemPrompt = `Bạn là trợ lý du lịch, ẩm thực và dinh dưỡng AIvolution am hiểu sâu sắc Đà Nẵng – Hội An.
Vị trí hiện tại của người dùng: ${locationContext || "Đà Nẵng – Hội An"}.
Trả lời bằng tiếng Việt tự nhiên, chuyên nghiệp, chính xác, súc tích và dễ đọc trên điện thoại.`;

  const contents = (Array.isArray(messages) ? messages.slice(-10) : []).map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: String(m.content || "") }]
  }));

  for (const model of CONFIG.GEMINI_MODELS) {
    for (const apiKey of apiKeys) {
      try {
        const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
        const res = await fetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: systemPrompt }] },
            contents,
            generationConfig: { temperature: 0.4, maxOutputTokens: 650 }
          })
        });
        if (res.status === 429) {
          markKeyCooldown(apiKey);
          continue;
        }
        if (!res.ok) continue;
        const data = await res.json();
        const reply = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
        if (reply) return reply;
      } catch (_) {}
    }
  }
  throw new Error("Gemini chat unavailable");
}

// ==========================================
// 6. TẦNG 2: GROQ FALLBACK (DỰ PHÒNG TỰ ĐỘNG)
// ==========================================
async function fetchWorkingGroqModels(apiKey) {
  const now = Date.now();
  if (
    runtimeState.cachedGroqModels &&
    now - runtimeState.cachedGroqModelsAt < CONFIG.MODELS_CACHE_TTL_MS
  ) {
    return runtimeState.cachedGroqModels;
  }

  const res = await fetch("https://api.groq.com/openai/v1/models", {
    headers: { Authorization: `Bearer ${apiKey}` }
  });
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

async function callGroqVision({ apiKey, model, prompt, imageBase64 }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONFIG.GROQ_TIMEOUT_MS);

  try {
    const imageUrl = String(imageBase64).startsWith("data:image")
      ? imageBase64
      : `data:image/jpeg;base64,${imageBase64}`;

    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        temperature: 0.15,
        max_tokens: 850,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              { type: "image_url", image_url: { url: imageUrl } }
            ]
          }
        ]
      }),
      signal: controller.signal
    });

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
  } finally {
    clearTimeout(timer);
  }
}

async function runGroqVision({ apiKeys, prompt, imageBase64 }) {
  const errors = [];

  for (const apiKey of apiKeys) {
    let liveModels;
    try {
      liveModels = await fetchWorkingGroqModels(apiKey);
    } catch (err) {
      errors.push(err.message);
      continue;
    }

    const candidates = getOrderedGroqVisionModels(liveModels);
    for (const model of candidates.slice(0, 4)) {
      try {
        const result = await callGroqVision({ apiKey, model, prompt, imageBase64 });
        if (result && typeof result === "object") {
          runtimeState.lastWorkingGroqVision = model;
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
        if (err.status === 429 || err.status === 401) {
          if (err.status === 429) markKeyCooldown(apiKey);
          break;
        }
      }
    }
  }

  const finalErr = new Error(errors.slice(0, 2).join(" | ") || "Groq không phản hồi");
  finalErr.isRateLimit = errors.some((e) => e.includes("429"));
  throw finalErr;
}

async function handleGroqChat({ apiKeys, messages, locationContext }) {
  const systemPrompt = `Bạn là trợ lý AIvolution thông minh, chuyên nghiệp và am hiểu sâu sắc Đà Nẵng – Hội An.
Vị trí hiện tại của người dùng: ${locationContext || "Đà Nẵng – Hội An"}.
Trả lời bằng tiếng Việt ngắn gọn, chính xác và thực tế.`;

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
        const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`
          },
          body: JSON.stringify({
            model,
            temperature: 0.4,
            max_tokens: 550,
            messages: chatMessages
          })
        });
        if (res.status === 429) {
          markKeyCooldown(apiKey);
          break;
        }
        if (res.status === 401) break;
        if (!res.ok) continue;
        const data = await res.json();
        const reply = data.choices?.[0]?.message?.content?.trim();
        if (reply) return reply.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
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
      const res = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
        }
      });
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
        } catch (_) {}
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

    // --- 3. CHẾ ĐỘ QUÉT ẢNH (Gemini -> Groq) ---
    const { imageBase64, locationContext, lat, lng } = body;
    if (!imageBase64) {
      return res.status(400).json({ error: CONFIG.FRIENDLY_ERROR, debug: "Thiếu dữ liệu ảnh" });
    }

    const areaPoint = clampToDaNangHoiAn(lat, lng, locationContext);
    const prompt = buildVisionPrompt(locationContext);

    let visionOutput = null;
    let geminiError = null;

    if (geminiKeys.length) {
      try {
        visionOutput = await runGeminiVision({ apiKeys: geminiKeys, prompt, imageBase64 });
      } catch (err) {
        geminiError = err;
      }
    }

    if (!visionOutput) {
      if (groqKeys.length) {
        visionOutput = await runGroqVision({ apiKeys: groqKeys, prompt, imageBase64 });
      } else if (geminiError) {
        throw geminiError;
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
