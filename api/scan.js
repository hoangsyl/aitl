const tls = require("tls");
const crypto = require("crypto");

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

async function callGroqVision({ apiKey, model, prompt, imageBase64, timeoutMs = 8500 }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const imageUrl = imageBase64.startsWith("data:image")
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
        temperature: 0.3,
        max_tokens: 900,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              {
                type: "image_url",
                image_url: { url: imageUrl }
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

async function runVisionWithFallback({ apiKey, prompt, imageBase64 }) {
  const fallbackList = [
    "meta-llama/llama-4-scout-17b-16e-instruct",
    "meta-llama/llama-4-maverick-17b-128e-instruct",
    "llama-3.2-90b-vision-preview",
    "llama-3.2-11b-vision-preview"
  ];

  let candidates = [...fallbackList];
  try {
    const allModels = await fetchWorkingGroqModels(apiKey);
    const visionFromApi = allModels.filter((m) =>
      /vision|scout|maverick|llama-4|vl|omni/i.test(m)
    );
    if (visionFromApi.length > 0) {
      candidates = [...new Set([...visionFromApi, ...fallbackList])];
    }
  } catch (_) {}

  // Chạy song song 2 model đầu tiên để phản hồi nhanh nhất
  const firstBatch = candidates.slice(0, 2);
  const firstResults = await Promise.allSettled(
    firstBatch.map((model) =>
      callGroqVision({ apiKey, model, prompt, imageBase64, timeoutMs: 8500 })
    )
  );
  for (const r of firstResults) {
    if (r.status === "fulfilled" && r.value && typeof r.value === "object") {
      return r.value;
    }
  }

  // Nếu batch đầu chưa được, thử lần lượt các model còn lại
  for (const model of candidates.slice(2)) {
    try {
      const res = await callGroqVision({
        apiKey,
        model,
        prompt,
        imageBase64,
        timeoutMs: 8500
      });
      if (res && typeof res === "object") return res;
    } catch (_) {}
  }

  throw new Error("All vision models failed");
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

// ==========================================
// GIỌNG HOÀI MY NEURAL TÍCH HỢP SẴN (KHÔNG CẦN PACKAGE.JSON)
// ==========================================
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

function generateHoaiMyBase64(rawText) {
  const cleanText = String(rawText || "")
    .replace(/[*#_•~`]/g, " ")
    .replace(/[\u{1F300}-\u{1FAFF}]/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1200);

  if (!cleanText) return Promise.resolve(null);

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
      `&Sec-MS-GEC-Version=1-130.0.2849.68` +
      `&ConnectionId=${connId}`;

    const socket = tls.connect(443, "speech.platform.bing.com", {
      servername: "speech.platform.bing.com"
    });

    let done = false;
    let upgraded = false;
    let recvBuf = Buffer.alloc(0);
    const audioChunks = [];

    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        socket.destroy();
        reject(new Error("TTS timeout"));
      }
    }, 9500);

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
        "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0",
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
        if (!headerText.includes("101")) {
          return finish(new Error("Handshake failed"));
        }

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
        const opcode = recvBuf[0] & 0x0f;
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
          const textData = payload.toString("utf8");
          if (textData.includes("Path:turn.end")) {
            if (audioChunks.length > 0) {
              return finish(null, Buffer.concat(audioChunks).toString("base64"));
            }
            return finish(new Error("Empty audio"));
          }
        } else if (opcode === 0x2 && payload.length > 2) {
          const headerLen = payload.readUInt16BE(0);
          const headerStr = payload.slice(2, 2 + headerLen).toString("utf8");
          if (headerStr.includes("Path:audio")) {
            audioChunks.push(payload.slice(2 + headerLen));
          }
        } else if (opcode === 0x9) {
          socket.write(createWsFrame(payload, 0xa));
        } else if (opcode === 0x8) {
          if (audioChunks.length > 0) {
            return finish(null, Buffer.concat(audioChunks).toString("base64"));
          }
          return finish(new Error("Connection closed"));
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

module.exports = async (req, res) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  if (req.method !== "POST") {
    return res.status(405).json({ error: FRIENDLY_ERROR });
  }

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;

    // --- CHẾ ĐỘ ĐỌC GIỌNG HOÀI MY NEURAL (TÍCH HỢP SẴN) ---
    if (body && body.mode === "tts") {
      try {
        const audioBase64 = await generateHoaiMyBase64(body.text);
        if (audioBase64) {
          return res.status(200).json({ audioBase64 });
        }
        return res.status(502).json({ ttsError: "Không tạo được âm thanh" });
      } catch (err) {
        return res.status(502).json({ ttsError: err.message || "Lỗi tạo giọng" });
      }
    }

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

Yêu cầu nội dung (viết văn phong hướng dẫn viên du lịch truyền cảm, chấm phẩy rõ ràng để đọc thuyết minh thật hay):
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

CHỈ TRẢ VỀ DUY NHẤT JSON THUẦN (không kèm chữ giải thích bên ngoài) theo mẫu:
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

    const result = await runVisionWithFallback({
      apiKey: groqKey,
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
  } catch (_) {
    return res.status(502).json({ error: FRIENDLY_ERROR });
  }
};
