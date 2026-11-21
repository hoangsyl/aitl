// Khung giới hạn địa lý cứng cho khu vực Đà Nẵng – Hội An
const DN_HA_BOUNDS = {
  minLat: 15.70,
  maxLat: 16.20,
  minLng: 107.90,
  maxLng: 108.45
};

const FRIENDLY_ERROR =
  "Opps! Mình không thể nhận diện được, có lẽ do bạn chụp không rõ hoặc mờ hoặc tối quá, bạn hãy giữ nguyên và để rõ giúp mình nhé😍";

function clampToDaNangHoiAn(lat, lng, locationContext = "") {
  const numLat = Number(lat);
  const numLng = Number(lng);
  const ctx = String(locationContext || "").toLowerCase();

  const isInside =
    Number.isFinite(numLat) &&
    Number.isFinite(numLng) &&
    numLat >= DN_HA_BOUNDS.minLat &&
    numLat <= DN_HA_BOUNDS.maxLat &&
    numLng >= DN_HA_BOUNDS.minLng &&
    numLng <= DN_HA_BOUNDS.maxLng;

  if (isInside) {
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
  if (start === -1 || end === -1) {
    throw new Error("Invalid JSON");
  }
  return JSON.parse(cleaned.slice(start, end + 1));
}

async function fetchWorkingGroqModels(apiKey) {
  const res = await fetch("https://api.groq.com/openai/v1/models", {
    headers: { Authorization: `Bearer ${apiKey}` }
  });
  if (!res.ok) throw new Error("Groq models error");
  const data = await res.json();
  const allIds = (data.data || []).map((m) => m.id).filter(Boolean);
  const activeModels = allIds.filter(
    (id) => !/whisper|tts|guard|safeguard|embed|prompt-guard/i.test(id)
  );
  if (!activeModels.length) throw new Error("No Groq models");
  return activeModels;
}

async function callGroqVision({ apiKey, model, prompt, imageBase64, timeoutMs = 12000 }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

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
        max_tokens: 950,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              {
                type: "image_url",
                image_url: { url: `data:image/jpeg;base64,${imageBase64}` }
              }
            ]
          }
        ]
      }),
      signal: controller.signal
    });

    const rawText = await res.text();
    if (!res.ok) throw new Error(`${model}: HTTP ${res.status}`);

    const parsed = JSON.parse(rawText.trim());
    const content = parsed.choices?.[0]?.message?.content;
    if (!content) throw new Error("Empty content");
    return extractJson(content);
  } finally {
    clearTimeout(timer);
  }
}

async function handleChatMode({ apiKey, messages, locationContext }) {
  const models = await fetchWorkingGroqModels(apiKey);
  const sortedModels = [
    ...models.filter((m) => /llama-3\.3|llama-3\.1|gpt-oss|qwen/i.test(m)),
    ...models.filter((m) => !/llama-3\.3|llama-3\.1|gpt-oss|qwen/i.test(m))
  ];

  const systemPrompt = `Bạn là trợ lý AIvolution thông minh, thân thiện và am hiểu sâu sắc khu vực Đà Nẵng – Hội An.
Vị trí hiện tại của người dùng: ${locationContext || "Đà Nẵng – Hội An"}.
Hãy trả lời ngắn gọn, rõ ràng, thực tế bằng tiếng Việt.`;

  const chatMessages = [
    { role: "system", content: systemPrompt },
    ...(Array.isArray(messages) ? messages.slice(-10) : [])
  ];

  for (const model of sortedModels.slice(0, 5)) {
    try {
      const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model,
          temperature: 0.5,
          max_tokens: 550,
          messages: chatMessages
        })
      });
      if (!res.ok) continue;
      const data = await res.json();
      const reply = data.choices?.[0]?.message?.content?.trim();
      if (reply) return reply.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
    } catch (_) {}
  }
  throw new Error("Chatbot tạm thời bận, bạn thử gửi lại nhé.");
}

module.exports = async (req, res) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  if (req.method !== "POST") {
    return res.status(405).json({ error: FRIENDLY_ERROR });
  }

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const groqKey = String(process.env.GROQ_API_KEY || "").trim();

    if (!groqKey) {
      return res.status(400).json({ error: FRIENDLY_ERROR });
    }

    // --- CHẾ ĐỘ CHATBOT ---
    if (body && body.mode === "chat") {
      const reply = await handleChatMode({
        apiKey: groqKey,
        messages: body.messages,
        locationContext: body.locationContext
      });
      return res.status(200).json({ reply });
    }

    // --- CHẾ ĐỘ QUÉT ẢNH ---
    const { imageBase64, locationContext, lat, lng } = body || {};
    if (!imageBase64) {
      return res.status(400).json({ error: FRIENDLY_ERROR });
    }

    const areaPoint = clampToDaNangHoiAn(lat, lng, locationContext);

    const prompt = `Bạn là chuyên gia văn hóa Đà Nẵng – Hội An, đồng thời là chuyên gia dinh dưỡng & phân tích sản phẩm.
Ngữ cảnh vị trí (chỉ trong Đà Nẵng – Hội An): ${locationContext || "Đà Nẵng – Hội An"}.

Nhiệm vụ: Nhận diện chính xác đối tượng trong ảnh và phân loại đúng 1 trong 2 nhóm:
- NHÓM ĐỊA ĐIỂM: "Di tích" | "Nhà hàng & Quán ăn" | "Shop & Workshop" | "Hán Nôm"
- NHÓM VẬT PHẨM / THỨC ĂN: "Thức ăn & Đồ uống" | "Sản phẩm" | "Vật thể"

Yêu cầu nội dung (viết văn phong kể chuyện truyền cảm, chấm phẩy rõ ràng để đọc thuyết minh thật hay):
1. "cau_chuyen_lich_su": 2–3 câu giới thiệu rõ nguồn gốc, bối cảnh hoặc công dụng.
2. "giai_thoai_dac_biet" (Điểm độc đáo): Viết thật hay, cuốn hút, giàu cảm xúc (4–5 câu, khoảng 80–110 từ), chấm phẩy đầy đủ, phân tích kỹ chi tiết nhìn thấy trên ảnh và giá trị đặc trưng.
3. "thong_tin_san_pham":
   - Nếu là NHÓM VẬT PHẨM / THỨC ĂN: đặt "hien_thi": true.
     + "calo_uoc_tinh": Ước tính cụ thể lượng calo (hoặc ghi "Không áp dụng (vật dụng không ăn được)").
     + "tot_cho_suc_khoe": Đánh giá rõ có tốt cho sức khỏe không (hoặc độ an toàn khi dùng).
     + "chi_tiet_san_pham": Mô tả chi tiết thành phần, thương hiệu/xuất xứ, công dụng.
     + "noi_mua_goi_y": Gợi ý cụ thể địa chỉ hoặc hệ thống cửa hàng uy tín tại Đà Nẵng – Hội An bán đúng vật phẩm này.
     + "tu_khoa_mua_hang": Từ khóa ngắn gọn để tìm đúng nơi bán vật phẩm này trên Google Maps tại Đà Nẵng – Hội An.
   - Nếu là NHÓM ĐỊA ĐIỂM: đặt "hien_thi": false và để trống các chuỗi bên trong.
4. "danh_gia_ban_dia": Tổng hợp nhận xét chân thực theo phong cách Local Guide Đà Nẵng – Hội An.
5. "han_viet": CHỈ đặt "co_han_viet": true nếu ảnh THẬT SỰ CÓ CHỮ HÁN/NÔM.

Trả về DUY NHẤT JSON thuần theo mẫu:
{
  "loai_doi_tuong": "Di tích | Nhà hàng & Quán ăn | Shop & Workshop | Hán Nôm | Thức ăn & Đồ uống | Sản phẩm | Vật thể",
  "la_dia_diem": true,
  "ten_dia_diem": "Tên chính xác đối tượng",
  "dia_chi": "Địa chỉ tại Đà Nẵng / Hội An (hoặc thương hiệu/xuất xứ nếu là sản phẩm)",
  "nien_dai_hoac_gia": "Niên đại hoặc mức giá tham khảo",
  "cau_chuyen_lich_su": "2–3 câu giới thiệu.",
  "giai_thoai_dac_biet": "4–5 câu miêu tả thật hay và chi tiết về điểm độc đáo.",
  "thong_tin_san_pham": {
    "hien_thi": false,
    "calo_uoc_tinh": "",
    "tot_cho_suc_khoe": "",
    "chi_tiet_san_pham": "",
    "noi_mua_goi_y": "",
    "tu_khoa_mua_hang": ""
  },
  "han_viet": {
    "co_han_viet": false,
    "chu_goc": "",
    "phien_am": "",
    "phan_tich_tung_tu": [],
    "y_nghia_tong_the": ""
  },
  "danh_gia_ban_dia": {
    "tom_tat": "Tóm tắt góc nhìn của người địa phương (2 câu).",
    "review_mau": ["Nhận xét thực tế 1", "Nhận xét thực tế 2"]
  }
}`;

    const models = await fetchWorkingGroqModels(groqKey);

    for (const model of models) {
      try {
        const result = await callGroqVision({
          apiKey: groqKey,
          model,
          prompt,
          imageBase64
        });

        const isPlace =
          result.la_dia_diem === true ||
          /di tích|nhà hàng|quán ăn|workshop|shop|hán nôm/i.test(result.loai_doi_tuong || "");

        result.toa_do_khu_vuc = {
          lat: areaPoint.lat,
          lng: areaPoint.lng,
          khu_vuc: "Đà Nẵng – Hội An"
        };

        if (isPlace) {
          const placeQuery = result.ten_dia_diem || result.dia_chi || "Đà Nẵng - Hội An";
          result.hien_chi_duong = true;
          result.google_maps_url = buildDnHaMapsUrl({
            query: placeQuery,
            lat: areaPoint.lat,
            lng: areaPoint.lng,
            locationContext
          });
          result.chi_duong_url = buildDnHaDirectionsUrl({
            destName: placeQuery,
            lat: areaPoint.lat,
            lng: areaPoint.lng,
            locationContext
          });
        } else {
          const buyQuery =
            result.thong_tin_san_pham?.tu_khoa_mua_hang ||
            `mua ${result.ten_dia_diem || "sản phẩm"}`;
          result.hien_chi_duong = false;
          result.google_maps_url = buildDnHaMapsUrl({
            query: buyQuery,
            lat: areaPoint.lat,
            lng: areaPoint.lng,
            locationContext
          });
          result.chi_duong_url = "";
        }

        return res.status(200).json(result);
      } catch (_) {}
    }

    return res.status(502).json({ error: FRIENDLY_ERROR });
  } catch (_) {
    return res.status(500).json({ error: FRIENDLY_ERROR });
  }
};
