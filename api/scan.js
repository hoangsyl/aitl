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
  "Opps! Mình không thể nhận diện được, có lẽ do bạn chụp không rõ hoặc mờ hoặc tối quá, bạn hãy giữ nguyên và để rõ giúp mình nhé.";

// Bộ nhớ đệm trên Serverless
let cachedAllModels = null;
let cachedModelsAt = 0;
let lastWorkingVisionModel = null;
let keyCursor = 0;
const badVisionModels = new Set();
const MODELS_CACHE_TTL = 10 * 60 * 1000; // 10 phút

// Gom tất cả API Key từ GROQ_API_KEY (cách nhau dấu phẩy/xuống dòng) và GROQ_API_KEY_1..10
function getGroqApiKeys() {
  const rawList = [];

  if (process.env.GROQ_API_KEY) {
    rawList.push(...String(process.env.GROQ_API_KEY).split(/[\s,;]+/));
  }

  for (let i = 1; i <= 10; i++) {
    const val = process.env[`GROQ_API_KEY_${i}`];
    if (val) rawList.push(...String(val).split(/[\s,;]+/));
  }

  const uniqueKeys = [...new Set(rawList.map((k) => k.trim()).filter(Boolean))];
  if (uniqueKeys.length <= 1) return uniqueKeys;

  // Xoay vòng vị trí bắt đầu để chia đều lượt gọi cho các key
  const start = keyCursor % uniqueKeys.length;
  keyCursor = (keyCursor + 1) % uniqueKeys.length;
  return [...uniqueKeys.slice(start), ...uniqueKeys.slice(0, start)];
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

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
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("Phản hồi AI không phải JSON");
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

async function fetchWorkingGroqModels(apiKey) {
  const now = Date.now();
  if (cachedAllModels && now - cachedModelsAt < MODELS_CACHE_TTL) {
    return cachedAllModels;
  }

  const res = await fetch("https://api.groq.com/openai/v1/models", {
    headers: { Authorization: `Bearer ${apiKey}` }
  });
  if (!res.ok) throw new Error(`Groq models HTTP ${res.status}`);

  const data = await res.json();
  const allIds = (data.data || []).map((m) => m.id).filter(Boolean);
  const activeModels = allIds.filter(
    (id) => !/whisper|tts|guard|safeguard|embed|prompt-guard|playai|orpheus|compound/i.test(id)
  );
  if (!activeModels.length) throw new Error("Không tìm thấy model khả dụng trên Groq");

  cachedAllModels = activeModels;
  cachedModelsAt = now;
  return activeModels;
}

function getOrderedVisionModels(liveModels) {
  const textOnlyPattern = /gpt-oss|deepseek|mixtral|llama-3\.1|llama-3\.3|llama3-|allam|gemma2/i;
  const visionPattern = /vision|vl|scout|maverick|llama-4|llama-5|omni|multimodal|pixtral|kimi|qwen/i;

  const filtered = liveModels.filter(
    (m) => !textOnlyPattern.test(m) && !badVisionModels.has(m)
  );

  const primary = filtered.filter((m) => visionPattern.test(m));
  const secondary = filtered.filter((m) => !visionPattern.test(m));
  const list = [...primary, ...secondary];

  if (lastWorkingVisionModel && list.includes(lastWorkingVisionModel)) {
    return [lastWorkingVisionModel, ...list.filter((m) => m !== lastWorkingVisionModel)];
  }
  return list;
}

async function callGroqVision({ apiKey, model, prompt, imageBase64, timeoutMs = 6500 }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

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
        max_tokens: 750,
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
      const err = new Error(`${model}: HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }

    const parsed = JSON.parse(rawText.trim());
    const content = parsed.choices?.[0]?.message?.content;
    if (!content) throw new Error(`${model}: Empty content`);
    return extractJson(content);
  } finally {
    clearTimeout(timer);
  }
}

async function runVisionSmart({ apiKeys, prompt, imageBase64 }) {
  const errors = [];

  for (let k = 0; k < apiKeys.length; k++) {
    const apiKey = apiKeys[k];
    let liveModels;
    try {
      liveModels = await fetchWorkingGroqModels(apiKey);
    } catch (err) {
      errors.push(`Key#${k + 1}: ${err.message}`);
      continue;
    }

    const candidates = getOrderedVisionModels(liveModels);

    for (const model of candidates.slice(0, 4)) {
      try {
        const result = await callGroqVision({
          apiKey,
          model,
          prompt,
          imageBase64,
          timeoutMs: 6500
        });
        if (result && typeof result === "object") {
          lastWorkingVisionModel = model;
          return result;
        }
      } catch (err) {
        errors.push(err.message || `${model}: Failed`);
        if (err.status === 400 || err.status === 404) {
          badVisionModels.add(model);
          if (lastWorkingVisionModel === model) lastWorkingVisionModel = null;
          continue;
        }
        // Nếu dính 429 hoặc 401 trên key này -> chuyển ngay sang key tiếp theo
        if (err.status === 429 || err.status === 401) {
          if (apiKeys.length === 1 && err.status === 429) {
            await sleep(1500);
          }
          break;
        }
      }
    }
  }

  const isRateLimit = errors.some((e) => e.includes("429"));
  const finalErr = new Error(errors.slice(0, 2).join(" | ") || "Không có model đọc ảnh nào phản hồi");
  finalErr.isRateLimit = isRateLimit;
  throw finalErr;
}

async function handleChatMode({ apiKeys, messages, locationContext }) {
  const systemPrompt = `Bạn là trợ lý AIvolution thông minh, thân thiện và am hiểu sâu sắc khu vực Đà Nẵng – Hội An.
Vị trí hiện tại của người dùng: ${locationContext || "Đà Nẵng – Hội An"}.
Hãy trả lời ngắn gọn, chính xác, thực tế bằng tiếng Việt.`;

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
            max_tokens: 500,
            messages: chatMessages
          })
        });
        if (res.status === 429 || res.status === 401) break;
        if (!res.ok) continue;
        const data = await res.json();
        const reply = data.choices?.[0]?.message?.content?.trim();
        if (reply) return reply.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
      } catch (_) {}
    }
  }
  throw new Error("Chatbot tạm thời bận, bạn thử gửi lại nhé.");
}

// ==========================================
// GIỌNG ĐỌC MP3 TÍCH HỢP SẴN (HOÀI MY NEURAL + DỰ PHÒNG MP3)
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

    const timer = setTimeout(() => {
      finish(new Error("HoaiMy timeout"));
    }, 4500);

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
        if (!headerText.includes("101")) {
          return finish(new Error("Edge TTS blocked"));
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
          const textData = payload.toString("utf8");
          if (textData.includes("Path:turn.end")) {
            if (audioChunks.length > 0) {
              return finish(null, Buffer.concat(audioChunks).toString("base64"));
            }
            return finish(new Error("Empty audio"));
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
          if (audioChunks.length > 0) {
            return finish(null, Buffer.concat(audioChunks).toString("base64"));
          }
          return finish(new Error("Closed"));
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

module.exports = async (req, res) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }
  if (req.method !== "POST") {
    return res.status(405).json({ error: FRIENDLY_ERROR });
  }

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};

    // --- CHẾ ĐỘ ĐỌC GIỌNG THUYẾT MINH ---
    if (body.mode === "tts") {
      try {
        const audioBase64 = await generateVoiceBase64(body.text);
        if (audioBase64) {
          return res.status(200).json({ audioBase64 });
        }
        return res.status(502).json({ ttsError: "Không có dữ liệu âm thanh" });
      } catch (err) {
        return res.status(502).json({ ttsError: err.message || "Lỗi tạo giọng" });
      }
    }

    const groqKeys = getGroqApiKeys();
    if (!groqKeys.length) {
      return res.status(400).json({
        error: FRIENDLY_ERROR,
        debug: "Thiếu biến GROQ_API_KEY trên Vercel"
      });
    }

    // --- CHẾ ĐỘ CHATBOT ---
    if (body.mode === "chat") {
      const reply = await handleChatMode({
        apiKeys: groqKeys,
        messages: body.messages,
        locationContext: body.locationContext
      });
      return res.status(200).json({ reply });
    }

    // --- CHẾ ĐỘ QUÉT ẢNH ---
    const { imageBase64, locationContext, lat, lng } = body;
    if (!imageBase64) {
      return res.status(400).json({ error: FRIENDLY_ERROR, debug: "Thiếu dữ liệu ảnh" });
    }

    const areaPoint = clampToDaNangHoiAn(lat, lng, locationContext);

    const prompt = `Bạn là chuyên gia nhận diện hình ảnh, văn hóa Đà Nẵng – Hội An và phân tích sản phẩm.
Ngữ cảnh vị trí: ${locationContext || "Đà Nẵng – Hội An"}.

QUY TẮC CHÍNH XÁC:
- Đọc kỹ mọi chữ trên bảng hiệu, logo, nhãn mác trong ảnh để xác định ĐÚNG tên cửa hàng, di tích, món ăn hoặc sản phẩm.
- Không bịa đặt địa chỉ cụ thể nếu ảnh không thể hiện rõ; chỉ ghi khu vực thực tế (ví dụ: "Phố cổ Hội An" hoặc "Đà Nẵng – Hội An").
- Phân loại đúng 1 trong 2 nhóm:
  + NHÓM ĐỊA ĐIỂM: "Di tích" | "Nhà hàng & Quán ăn" | "Shop & Workshop" | "Hán Nôm"
  + NHÓM VẬT PHẨM / THỨC ĂN: "Thức ăn & Đồ uống" | "Sản phẩm" | "Vật thể"

CHỈ TRẢ VỀ DUY NHẤT JSON THUẦN (không kèm chữ bên ngoài):
{
  "loai_doi_tuong": "Di tích | Nhà hàng & Quán ăn | Shop & Workshop | Hán Nôm | Thức ăn & Đồ uống | Sản phẩm | Vật thể",
  "la_dia_diem": true,
  "ten_dia_diem": "Tên chính xác đọc được từ ảnh",
  "dia_chi": "Địa chỉ tại Đà Nẵng / Hội An hoặc thương hiệu/xuất xứ",
  "nien_dai_hoac_gia": "Chỉ ghi gọn niên đại hoặc khoảng giá VNĐ (ví dụ: 250.000 - 450.000đ)",
  "cau_chuyen_lich_su": "2-3 câu ngắn gọn, chuẩn xác về đối tượng trong ảnh.",
  "giai_thoai_dac_biet": "3-4 câu miêu tả chi tiết điểm nổi bật nhìn thấy trực tiếp trong ảnh, chấm phẩy rõ ràng để đọc thuyết minh.",
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
    "tom_tat": "Tóm tắt thực tế theo góc nhìn người địa phương (1-2 câu).",
    "review_mau": ["Nhận xét thực tế 1", "Nhận xét thực tế 2"]
  }
}
Lưu ý: Nếu là NHÓM VẬT PHẨM / THỨC ĂN thì đặt "la_dia_diem": false và "thong_tin_san_pham.hien_thi": true rồi điền đầy đủ các mục bên trong.`;

    const result = await runVisionSmart({
      apiKeys: groqKeys,
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
  } catch (err) {
    return res.status(err?.isRateLimit ? 429 : 502).json({
      error: err?.isRateLimit
        ? "AI đang chạm giới hạn lượt quét miễn phí (HTTP 429). Bạn đợi 15–30 giây rồi bấm Quét lại nhé!"
        : FRIENDLY_ERROR,
      debug: err?.message || "Lỗi xử lý máy chủ"
    });
  }
};
