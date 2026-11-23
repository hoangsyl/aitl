/**
 * AIvolution Team - 100 Concurrent Users & Zero-Hallucination Engine
 * Bản quyền thuộc về AIvolution Team
 */

const tls = require("tls");
const crypto = require("crypto");

// ==========================================
// 1. CẤU HÌNH HỆ THỐNG (CHỊU TẢI 100 USERS – KHÔNG TREO 504)
// ==========================================
const CONFIG = {
  DN_HA_BOUNDS: { minLat: 15.70, maxLat: 16.20, minLng: 107.90, maxLng: 108.45 },
  GROQ_VISION_PRIORITY: [],
  GEMINI_BACKUP_MODELS: ["gemini-3.8-flash", "gemini-3.5-flash-lite"],
  TOTAL_SCAN_BUDGET_MS: 8200,   // Khóa trần toàn bộ request < 8.2s để không bao giờ bị Vercel 504
  GROQ_ATTEMPT_TIMEOUT_MS: 4200,
  GROQ_MODELS_TIMEOUT_MS: 1800,
  SERPER_TIMEOUT_MS: 1000,
  GEMINI_BACKUP_TIMEOUT_MS: 4200,
  CHAT_TIMEOUT_MS: 4800,
  TTS_TIMEOUT_MS: 4200,
  MODELS_CACHE_TTL_MS: 20 * 60 * 1000,
  SCAN_CACHE_TTL_MS: 15 * 60 * 1000,
  SERPER_CACHE_TTL_MS: 60 * 60 * 1000,
  TTS_CACHE_TTL_MS: 30 * 60 * 1000,
  KEY_COOLDOWN_429_MS: 45 * 1000,
  KEY_COOLDOWN_AUTH_MS: 10 * 60 * 1000,
  FRIENDLY_ERROR:
    "Opps! Mình không thể nhận diện được, có lẽ do bạn chụp không rõ, bị mờ hoặc thiếu sáng. Bạn giữ chắc tay và chụp rõ hơn giúp mình nhé!"
};

const runtimeState = {
  cachedGroqModels: null,
  cachedGroqModelsAt: 0,
  badGroqVisionModels: new Set(),
  badGeminiModels: new Set(),
  keyCooldownUntil: new Map(),
  rrIndex: Object.create(null), // Round-robin chia tải đều cho 100 người
  inFlight: new Map(),          // Single-flight: gộp các request trùng đang chạy
  scanCache: new Map(),         // Cache kết quả quét (15 phút)
  serperCache: new Map(),       // Cache Google Search/Giá (60 phút)
  ttsCache: new Map()           // Cache giọng đọc MP3 (30 phút)
};

// ==========================================
// 2. KHO DỮ LIỆU XÁC THỰC 100% HỘI AN (TRƯỜNG HỌC, THƯƠNG HIỆU, DI TÍCH)
// ==========================================
const HOI_AN_VERIFIED_DB = [
  // --- TRƯỜNG HỌC TẠI HỘI AN ---
  {
    keywords: ["tran quy cap", "thpt tran quy cap", "tranquycaphoian"],
    data: {
      loai_doi_tuong: "Trường học & Tổ chức",
      la_dia_diem: true,
      ten_dia_diem: "Trường THPT Trần Quý Cáp (Hội An)",
      dia_chi: "07 Trần Hưng Đạo, Hội An",
      nien_dai_hoac_gia: "Thành lập 15/09/1952",
      cau_chuyen_lich_su:
        "Trường THPT Trần Quý Cáp là ngôi trường trung học lâu đời và giàu truyền thống hiếu học tại Hội An. Trường thành lập ngày 15/09/1952 và đặt tại cơ sở số 07 Trần Hưng Đạo từ năm 1955.",
      noi_mua_goi_y: "Trung tâm phố cổ Hội An",
      danh_gia_ban_dia: {
        tom_tat: "Ngôi trường có bề dày lịch sử hơn 70 năm với nhiều thế hệ học sinh tiêu biểu tại Hội An.",
        review_mau: ["Khuôn viên xanh mát ngay trục đường Trần Hưng Đạo", "Truyền thống học tập và hoạt động phong trào nổi bật"]
      }
    }
  },
  {
    keywords: ["chuyen le thanh tong", "thpt chuyen le thanh tong", "le thanh tong hoi an"],
    data: {
      loai_doi_tuong: "Trường học & Tổ chức",
      la_dia_diem: true,
      ten_dia_diem: "Trường THPT Chuyên Lê Thánh Tông (Hội An)",
      dia_chi: "236 Trường Chinh, Hội An",
      nien_dai_hoac_gia: "Thành lập năm 2012",
      cau_chuyen_lich_su:
        "Trường THPT Chuyên Lê Thánh Tông là trường trung học phổ thông chuyên trọng điểm tại Hội An, đào tạo học sinh năng khiếu các môn văn hóa với nhiều giải học sinh giỏi cấp quốc gia.",
      noi_mua_goi_y: "Khu vực đường Trường Chinh, Hội An",
      danh_gia_ban_dia: {
        tom_tat: "Cơ sở vật chất hiện đại, chất lượng đào tạo mũi nhọn hàng đầu khu vực.",
        review_mau: ["Thành tích học sinh giỏi cấp quốc gia nổi bật", "Nhiều CLB học thuật và ngoại khóa năng động"]
      }
    }
  },
  {
    keywords: ["nguyen trai hoi an", "thpt nguyen trai hoi an", "58 nguyen cong tru"],
    requireHoiAnOrExact: true,
    softKeywords: ["thpt nguyen trai"],
    data: {
      loai_doi_tuong: "Trường học & Tổ chức",
      la_dia_diem: true,
      ten_dia_diem: "Trường THPT Nguyễn Trãi – Hội An",
      dia_chi: "58 Nguyễn Công Trứ, Hội An",
      nien_dai_hoac_gia: "Thành lập 27/07/1999",
      cau_chuyen_lich_su:
        "Trường THPT Nguyễn Trãi (Hội An) thành lập ngày 27/07/1999, là trường công lập uy tín đào tạo nhiều thế hệ học sinh khu vực Tân An và lân cận.",
      noi_mua_goi_y: "Đường Nguyễn Công Trứ, Hội An",
      danh_gia_ban_dia: {
        tom_tat: "Môi trường học tập thân thiện, chất lượng giảng dạy ổn định.",
        review_mau: ["Khuôn viên khang trang, rộng rãi", "Phong trào Đoàn và hoạt động ngoại khóa sôi nổi"]
      }
    }
  },
  {
    keywords: ["thpt tran hung dao hoi an", "170 cua dai", "tran hung dao cua dai"],
    requireHoiAnOrExact: true,
    softKeywords: ["thpt tran hung dao"],
    data: {
      loai_doi_tuong: "Trường học & Tổ chức",
      la_dia_diem: true,
      ten_dia_diem: "Trường THPT Trần Hưng Đạo (Hội An)",
      dia_chi: "170 Cửa Đại, Hội An",
      nien_dai_hoac_gia: "Thành lập năm 2009",
      cau_chuyen_lich_su:
        "Trường THPT Trần Hưng Đạo (Hội An) thành lập năm 2009, tọa lạc trên trục đường Cửa Đại, phục vụ giáo dục bậc THPT cho khu vực phía Đông Hội An.",
      noi_mua_goi_y: "Đường Cửa Đại, Hội An",
      danh_gia_ban_dia: {
        tom_tat: "Ngôi trường trẻ năng động, vị trí thuận lợi trên tuyến đường ra biển Cửa Đại.",
        review_mau: ["Môi trường giáo dục gần gũi", "Nhiều hoạt động trải nghiệm gắn với địa phương"]
      }
    }
  },
  {
    keywords: ["ptdtnt thpt quang nam", "pho thong dan toc noi tru quang nam", "39 nguyen tat thanh"],
    data: {
      loai_doi_tuong: "Trường học & Tổ chức",
      la_dia_diem: true,
      ten_dia_diem: "Trường PTDTNT THPT Quảng Nam (Hội An)",
      dia_chi: "39 Nguyễn Tất Thành, Hội An",
      nien_dai_hoac_gia: "Thành lập năm 1985",
      cau_chuyen_lich_su:
        "Trường Phổ thông Dân tộc Nội trú THPT Quảng Nam đặt tại Hội An từ năm 1985, đào tạo nguồn nhân lực trẻ cho con em đồng bào các dân tộc thiểu số.",
      noi_mua_goi_y: "Đường Nguyễn Tất Thành, Hội An",
      danh_gia_ban_dia: {
        tom_tat: "Môi trường nội trú giàu bản sắc văn hóa và tinh thần đoàn kết.",
        review_mau: ["Không gian giao lưu văn hóa đặc sắc", "Chế độ chăm lo học sinh nội trú chu đáo"]
      }
    }
  },

  // --- THƯƠNG HIỆU & ẨM THỰC ĐẶC TRƯNG HỘI AN ---
  {
    keywords: ["mot hoi an", "nuoc mot", "tra thao moc mot", "150 tran phu"],
    data: {
      loai_doi_tuong: "Thức ăn & Đồ uống",
      la_dia_diem: true,
      ten_dia_diem: "Nước Mót Hội An (Trà thảo mộc sả chanh)",
      dia_chi: "150 Trần Phú, Phố cổ Hội An",
      nien_dai_hoac_gia: "16.000 - 30.000 VNĐ",
      calo_uoc_tinh: "60 - 95 kcal/ly",
      cau_chuyen_lich_su:
        "Mót Hội An là thương hiệu trà thảo mộc giải nhiệt nổi tiếng trên đường Trần Phú, pha từ sả, chanh, gừng, cam thảo, táo tàu, quế và trang trí cánh hoa sen.",
      noi_mua_goi_y: "150 Trần Phú, Phố cổ Hội An",
      danh_gia_ban_dia: {
        tom_tat: "Thức uống giải nhiệt đặc trưng của phố cổ Hội An, thơm mùi thảo mộc dịu nhẹ.",
        review_mau: ["Vị thanh mát, ít ngọt, hợp đi bộ phố cổ", "Cốc trang trí cánh sen rất đặc trưng"]
      }
    }
  },
  {
    keywords: ["banh mi phuong", "banh my phuong", "2b phan chu trinh", "2b phan chau trinh"],
    data: {
      loai_doi_tuong: "Nhà hàng & Quán ăn",
      la_dia_diem: true,
      ten_dia_diem: "Bánh Mì Phượng Hội An",
      dia_chi: "2B Phan Chu Trinh, Hội An",
      nien_dai_hoac_gia: "25.000 - 45.000 VNĐ",
      calo_uoc_tinh: "450 - 580 kcal/ổ",
      cau_chuyen_lich_su:
        "Bánh Mì Phượng là thương hiệu bánh mì nổi tiếng tại Hội An với lớp vỏ giòn, nước xốt gia truyền và nhiều loại nhân như xá xíu, pate, thịt nướng, rau thơm.",
      noi_mua_goi_y: "2B Phan Chu Trinh, Hội An",
      danh_gia_ban_dia: {
        tom_tat: "Hương vị đậm đà, vỏ bánh giòn và nước xốt đặc trưng.",
        review_mau: ["Nhiều lựa chọn nhân phong phú", "Giờ cao điểm thường phải xếp hàng"]
      }
    }
  },
  {
    keywords: ["madam khanh", "madame khanh", "banh mi queen", "banh mi ba khanh", "115 tran cao van"],
    data: {
      loai_doi_tuong: "Nhà hàng & Quán ăn",
      la_dia_diem: true,
      ten_dia_diem: "Bánh Mì Madam Khánh (The Bánh Mì Queen)",
      dia_chi: "115 Trần Cao Vân, Hội An",
      nien_dai_hoac_gia: "25.000 - 40.000 VNĐ",
      calo_uoc_tinh: "430 - 540 kcal/ổ",
      cau_chuyen_lich_su:
        "Bánh Mì Madam Khánh được du khách gọi là 'Nữ hoàng Bánh mì Hội An', nổi bật với phần nhân hài hòa gồm thịt xá xíu, pate, trứng, nộm đu đủ và xốt đặc trưng.",
      noi_mua_goi_y: "115 Trần Cao Vân, Hội An",
      danh_gia_ban_dia: {
        tom_tat: "Vị bánh cân bằng, bánh nướng nóng giòn, phục vụ thân thiện.",
        review_mau: ["Nhân đầy đặn nhưng không bị ngấy", "Có bàn ngồi lại sạch sẽ tại quán"]
      }
    }
  },
  {
    keywords: ["com ga ba buoi", "ba buoi", "22 phan chu trinh"],
    data: {
      loai_doi_tuong: "Nhà hàng & Quán ăn",
      la_dia_diem: true,
      ten_dia_diem: "Cơm Gà Bà Buội Hội An",
      dia_chi: "22 Phan Chu Trinh, Hội An",
      nien_dai_hoac_gia: "35.000 - 55.000 VNĐ",
      calo_uoc_tinh: "520 - 650 kcal/đĩa",
      cau_chuyen_lich_su:
        "Cơm Gà Bà Buội là thương hiệu ẩm thực gia truyền tại Hội An từ thập niên 1950, nổi tiếng với cơm nấu nước luộc gà vàng tơi, gà ta xé phay trộn hành tây và rau răm Trà Quế.",
      noi_mua_goi_y: "22 Phan Chu Trinh, Hội An",
      danh_gia_ban_dia: {
        tom_tat: "Hương vị cơm gà phố cổ truyền thống, hạt cơm tơi thơm và thịt gà dai ngọt.",
        review_mau: ["Tương ớt Hội An và đu đủ bào ăn kèm rất hợp", "Nên đi sớm vì buổi trưa rất đông"]
      }
    }
  },
  {
    keywords: ["cao lau thanh", "26 thai phien"],
    data: {
      loai_doi_tuong: "Nhà hàng & Quán ăn",
      la_dia_diem: true,
      ten_dia_diem: "Cao Lầu Thanh Hội An",
      dia_chi: "26 Thái Phiên, Hội An",
      nien_dai_hoac_gia: "30.000 - 45.000 VNĐ",
      calo_uoc_tinh: "460 - 560 kcal/tô",
      cau_chuyen_lich_su:
        "Cao Lầu Thanh là quán ăn bản địa nổi tiếng tại Hội An, phục vụ sợi mì cao lầu dai giòn ăn kèm thịt xá xíu mềm, ram chiên giòn và rau sống Trà Quế.",
      noi_mua_goi_y: "26 Thái Phiên, Hội An",
      danh_gia_ban_dia: {
        tom_tat: "Quán địa phương chuẩn vị, giá bình dân và phục vụ nhanh.",
        review_mau: ["Thịt xá xíu thấm vị, sợi mì đúng chuẩn", "Đông khách địa phương ăn sáng và trưa"]
      }
    }
  },
  {
    keywords: ["faifo coffee", "ca phe faifo", "130 tran phu"],
    data: {
      loai_doi_tuong: "Nhà hàng & Quán ăn",
      la_dia_diem: true,
      ten_dia_diem: "Faifo Coffee Hội An",
      dia_chi: "130 Trần Phú, Phố cổ Hội An",
      nien_dai_hoac_gia: "45.000 - 85.000 VNĐ",
      cau_chuyen_lich_su:
        "Faifo Coffee tọa lạc trong ngôi nhà cổ hai tầng trên đường Trần Phú, nổi tiếng với sân thượng nhìn trọn mái ngói âm dương phố cổ Hội An.",
      noi_mua_goi_y: "130 Trần Phú, Phố cổ Hội An",
      danh_gia_ban_dia: {
        tom_tat: "Điểm cà phê sân thượng nổi tiếng để ngắm toàn cảnh phố cổ từ trên cao.",
        review_mau: ["Góc chụp hoàng hôn trên sân thượng đẹp", "Cà phê rang xay đậm vị"]
      }
    }
  },
  {
    keywords: ["reaching out", "reaching out tea", "131 tran phu"],
    data: {
      loai_doi_tuong: "Nhà hàng & Quán ăn",
      la_dia_diem: true,
      ten_dia_diem: "Reaching Out Tea House Hội An",
      dia_chi: "131 Trần Phú, Phố cổ Hội An",
      nien_dai_hoac_gia: "60.000 - 150.000 VNĐ",
      cau_chuyen_lich_su:
        "Reaching Out Tea House thành lập năm 2000, là quán trà yên tĩnh do các nhân viên khiếm thính vận hành; khách gọi món bằng thẻ gỗ khắc chữ trong không gian nhà cổ.",
      noi_mua_goi_y: "131 Trần Phú, Phố cổ Hội An",
      danh_gia_ban_dia: {
        tom_tat: "Không gian thưởng trà tĩnh lặng và nhân văn giữa lòng phố cổ.",
        review_mau: ["Trà Việt và bánh mứt thủ công chất lượng", "Trải nghiệm giao tiếp bằng thẻ gỗ ý nghĩa"]
      }
    }
  },

  // --- DI TÍCH BIỂU TƯỢNG ---
  {
    keywords: ["chua cau", "lai vien kieu", "cau nhat ban"],
    data: {
      loai_doi_tuong: "Di tích",
      la_dia_diem: true,
      ten_dia_diem: "Chùa Cầu (Lai Viễn Kiều – Hội An)",
      dia_chi: "Giao điểm Trần Phú – Nguyễn Thị Minh Khai, Phố cổ Hội An",
      nien_dai_hoac_gia: "Đầu thế kỷ 17 (khoảng 1593)",
      cau_chuyen_lich_su:
        "Chùa Cầu là biểu tượng kiến trúc của Hội An, do thương nhân Nhật Bản dựng đầu thế kỷ 17 và được chúa Nguyễn Phúc Chu đặt tên 'Lai Viễn Kiều' năm 1719; hình ảnh công trình in trên tờ 20.000 VNĐ.",
      noi_mua_goi_y: "Trung tâm Phố cổ Hội An",
      danh_gia_ban_dia: {
        tom_tat: "Di tích kiến trúc biểu tượng giao thoa văn hóa Nhật – Việt – Hoa.",
        review_mau: ["Rực rỡ ánh đèn vào buổi tối", "Nên tham quan sáng sớm để tránh đông"]
      }
    }
  },
  {
    keywords: ["hoi quan phuc kien", "phuc kien hoi quan", "46 tran phu"],
    data: {
      loai_doi_tuong: "Di tích",
      la_dia_diem: true,
      ten_dia_diem: "Hội quán Phúc Kiến (Hội An)",
      dia_chi: "46 Trần Phú, Phố cổ Hội An",
      nien_dai_hoac_gia: "Cuối thế kỷ 17 (khoảng 1690)",
      cau_chuyen_lich_su:
        "Hội quán Phúc Kiến là hội quán lớn bậc nhất tại phố cổ Hội An, thờ Thiên Hậu Thánh Mẫu, nổi tiếng với cổng tam quan mái ngói lưu ly và nhiều hiện vật Hán – Nôm cổ.",
      noi_mua_goi_y: "46 Trần Phú, Phố cổ Hội An",
      danh_gia_ban_dia: {
        tom_tat: "Kiến trúc chạm khắc tinh xảo, điểm tham quan trọng yếu trên đường Trần Phú.",
        review_mau: ["Cổng tam quan và vòng nhang lớn rất ấn tượng", "Lưu giữ nhiều hoành phi cổ giá trị"]
      }
    }
  }
];

// ==========================================
// 3. CACHE 3 TẦNG, SINGLE-FLIGHT & ROUND-ROBIN 30 KEYS
// ==========================================
function getCache(map, key) {
  const entry = map.get(key);
  if (!entry) return null;
  if (Date.now() > entry.exp) {
    map.delete(key);
    return null;
  }
  return entry.val;
}

function setCache(map, key, val, ttlMs, maxEntries = 100) {
  if (map.size >= maxEntries) {
    const oldestKey = map.keys().next().value;
    if (oldestKey !== undefined) map.delete(oldestKey);
  }
  map.set(key, { val, exp: Date.now() + ttlMs });
}

// Gộp các request giống hệt nhau đang chạy cùng lúc thành 1 lần gọi API duy nhất
function runSingleFlight(key, fn) {
  if (runtimeState.inFlight.has(key)) {
    return runtimeState.inFlight.get(key);
  }
  const p = Promise.resolve()
    .then(fn)
    .finally(() => runtimeState.inFlight.delete(key));
  runtimeState.inFlight.set(key, p);
  return p;
}

function hashShort(str) {
  return crypto.createHash("sha256").update(String(str || "")).digest("hex").slice(0, 24);
}

function normalizeTextForMatch(str) {
  return String(str || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function collectApiKeys(prefix) {
  const raw = [];
  if (process.env[prefix]) {
    raw.push(...String(process.env[prefix]).split(/[\s,;]+/));
  }
  for (let i = 1; i <= 30; i++) {
    const val = process.env[`${prefix}_${i}`];
    if (val) raw.push(...String(val).split(/[\s,;]+/));
  }

  const unique = [...new Set(raw.map((k) => k.trim()).filter(Boolean))];
  if (unique.length <= 1) return unique;

  const now = Date.now();
  const ready = unique.filter((k) => (runtimeState.keyCooldownUntil.get(k) || 0) <= now);
  const cooling = unique.filter((k) => (runtimeState.keyCooldownUntil.get(k) || 0) > now);

  // Round-robin thực sự: mỗi người dùng lấy key kế tiếp -> không bao giờ dồn tải vào Key #1
  if (ready.length > 1) {
    const idx = (runtimeState.rrIndex[prefix] || 0) % ready.length;
    runtimeState.rrIndex[prefix] = idx + 1;
    return [...ready.slice(idx), ...ready.slice(0, idx), ...cooling];
  }
  return [...ready, ...cooling];
}

function markKeyCooldown(apiKey, ms = CONFIG.KEY_COOLDOWN_429_MS) {
  runtimeState.keyCooldownUntil.set(apiKey, Date.now() + ms);
}

function fetchWithTimeout(url, options = {}, timeoutMs = 4200) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(700, timeoutMs));
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
}

// ==========================================
// 4. ĐỊA LÝ, ĐỐI CHIẾU XÁC THỰC & CHUẨN HÓA (KHÔNG BỊA)
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
    ? (/đà nẵng|hội an/i.test(cleanQuery) ? cleanQuery : `${cleanQuery}, Hội An - Đà Nẵng`)
    : "Hội An - Đà Nẵng";

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
    ? (/đà nẵng|hội an/i.test(cleanDest) ? cleanDest : `${cleanDest}, Hội An - Đà Nẵng`)
    : "Hội An, Đà Nẵng";

  const params = new URLSearchParams({
    api: "1",
    origin: `${origin.lat},${origin.lng}`,
    destination: scopedDest,
    travelmode: "driving"
  });
  return `https://www.google.com/maps/dir/?${params.toString()}`;
}

function matchVerifiedHoiAnEntity(ten, ocrText, locationContext) {
  const combined = normalizeTextForMatch(`${ten || ""} ${ocrText || ""}`);
  if (!combined) return null;

  const isHoiAnContext = /hoi an|quang nam/i.test(normalizeTextForMatch(`${locationContext || ""} ${ocrText || ""}`));

  for (const item of HOI_AN_VERIFIED_DB) {
    if (item.keywords.some((kw) => combined.includes(kw))) {
      return item.data;
    }
    if (item.requireHoiAnOrExact && isHoiAnContext && Array.isArray(item.softKeywords)) {
      if (item.softKeywords.some((kw) => combined.includes(kw))) {
        return item.data;
      }
    }
  }
  return null;
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

  const ocrText = String(data.chu_doc_duoc_tren_anh || "").trim();
  const sp = data.thong_tin_san_pham && typeof data.thong_tin_san_pham === "object"
    ? data.thong_tin_san_pham
    : {};
  const hv = data.han_viet && typeof data.han_viet === "object"
    ? data.han_viet
    : {};
  const dg = data.danh_gia_ban_dia && typeof data.danh_gia_ban_dia === "object"
    ? data.danh_gia_ban_dia
    : {};

  let ten = String(data.ten_dia_diem || "").trim();
  if (!ten || /^(không áp dụng|chưa xác định|n\/a|none|null)$/i.test(ten)) {
    const chiTiet = String(sp.chi_tiet_san_pham || data.cau_chuyen_lich_su || "").trim();
    ten = ocrText && !/không có chữ/i.test(ocrText)
      ? ocrText.slice(0, 60)
      : (chiTiet ? chiTiet.split(/[.,(]/)[0].trim().slice(0, 60) : "Đối tượng nhận diện");
  }

  const verified = matchVerifiedHoiAnEntity(ten, ocrText, locationContext);

  const loai = verified?.loai_doi_tuong || String(data.loai_doi_tuong || "Vật thể").trim();
  const isPlace = verified
    ? Boolean(verified.la_dia_diem)
    : (data.la_dia_diem === true || /di tích|nhà hàng|quán ăn|workshop|shop|hán nôm|địa điểm|trường học|tổ chức/i.test(loai));

  const finalTen = verified?.ten_dia_diem || ten;
  const diaChi = verified?.dia_chi || String(data.dia_chi || (isPlace ? "Chưa xác định rõ địa chỉ từ ảnh" : "Không áp dụng")).trim();
  const nienDaiGia = verified?.nien_dai_hoac_gia || String(data.nien_dai_hoac_gia || "Chưa xác định rõ từ ảnh").trim();

  const isFoodOrDrink = /thức ăn|đồ uống|món ăn|nước uống|thực phẩm|bánh|trái cây/i.test(loai);
  const rawCalo = verified?.calo_uoc_tinh || String(sp.calo_uoc_tinh || "").trim();
  const safeCalo = !isFoodOrDrink
    ? "Không áp dụng"
    : (/chưa đủ dữ liệu|chưa xác định/i.test(rawCalo)
      ? "Chưa đủ dữ liệu trên ảnh"
      : (/\d+/.test(rawCalo) ? rawCalo : "Chưa đủ dữ liệu trên ảnh"));

  const normalized = {
    loai_doi_tuong: loai,
    la_dia_diem: isPlace,
    ten_dia_diem: finalTen,
    dia_chi: diaChi,
    nien_dai_hoac_gia: nienDaiGia,
    cau_chuyen_lich_su: verified?.cau_chuyen_lich_su || String(data.cau_chuyen_lich_su || "").trim(),
    giai_thoai_dac_biet: String(data.giai_thoai_dac_biet || "").trim(),
    thong_tin_san_pham: {
      hien_thi: typeof sp.hien_thi === "boolean" ? sp.hien_thi : !isPlace,
      calo_uoc_tinh: safeCalo,
      tot_cho_suc_khoe: isFoodOrDrink
        ? String(sp.tot_cho_suc_khoe || "Chưa đủ dữ liệu đánh giá từ ảnh").trim()
        : String(sp.tot_cho_suc_khoe || "Không áp dụng").trim(),
      chi_tiet_san_pham: String(sp.chi_tiet_san_pham || "Nhận diện từ đặc điểm nhìn thấy trong ảnh").trim(),
      noi_mua_goi_y: verified?.noi_mua_goi_y || String(sp.noi_mua_goi_y || "Các cửa hàng hoặc địa điểm liên quan").trim(),
      tu_khoa_mua_hang: String(sp.tu_khoa_mua_hang || "").trim()
    },
    han_viet: {
      co_han_viet: Boolean(hv.co_han_viet && String(hv.chu_goc || "").trim()),
      chu_goc: String(hv.chu_goc || "").trim(),
      phien_am: String(hv.phien_am || "").trim(),
      phan_tich_tung_tu: Array.isArray(hv.phan_tich_tung_tu) ? hv.phan_tich_tung_tu : [],
      y_nghia_tong_the: String(hv.y_nghia_tong_the || "").trim()
    },
    danh_gia_ban_dia: verified?.danh_gia_ban_dia || {
      tom_tat: String(dg.tom_tat || "Nhận xét thực tế dựa trên đặc điểm nhìn thấy trong ảnh.").trim(),
      review_mau: Array.isArray(dg.review_mau)
        ? dg.review_mau.map((r) => String(r || "").trim()).filter(Boolean).slice(0, 2)
        : []
    },
    toa_do_khu_vuc: {
      lat: areaPoint.lat,
      lng: areaPoint.lng,
      khu_vuc: "Đà Nẵng – Hội An"
    },
    _ocr: ocrText,
    _verified: Boolean(verified),
    _provider: provider
  };

  if (isPlace) {
    const hasExactAddr = diaChi && !/không áp dụng|chưa xác định/i.test(diaChi);
    const placeQuery = hasExactAddr ? `${finalTen}, ${diaChi}` : finalTen;
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
    const buyQuery = normalized.thong_tin_san_pham.tu_khoa_mua_hang || `mua ${finalTen}`;
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
// 5. PROMPT CHUẨN XÁC TUYỆT ĐỐI – KHÔNG BỊA THÔNG TIN / KHÔNG BỊA CALO
// ==========================================
function buildVisionPrompt(locationContext) {
  return `Hệ thống Computer Vision & OCR chuẩn xác tuyệt đối của AIvolution. Ngữ cảnh: ${locationContext || "Hội An – Đà Nẵng"}.

NGUYÊN TẮC BẮT BUỘC (TUYỆT ĐỐI KHÔNG BỊA ĐẶT):
1. ĐỌC CHỮ TRƯỚC (OCR): Chép nguyên văn mọi chữ, tên trường học, năm trên logo, tên thương hiệu, dung tích (ml/g), bảng dinh dưỡng hoặc chữ Hán – Nôm nhìn thấy rõ vào "chu_doc_duoc_tren_anh". Không thấy chữ ghi "Không có chữ".
2. KHÔNG ĐOÁN MÒ:
   - Nếu không đọc rõ chữ/logo thương hiệu -> KHÔNG tự bịa tên hãng, chỉ mô tả đúng vật thể thực tế.
   - Nếu không biết chắc 100% địa chỉ hoặc năm thành lập -> ghi "Chưa xác định rõ từ ảnh", TUYỆT ĐỐI không tự chế địa chỉ hay năm.
   - Logo trường học / phù hiệu / đồng phục -> đặt "loai_doi_tuong": "Trường học & Tổ chức", "la_dia_diem": true, ghi đúng tên trường đọc được.
   - KHÔNG gượng ép gắn vật dụng cá nhân (chai nước, tai nghe, bình lắc...) vào Hội An – Đà Nẵng.
3. LUẬT ĐONG ĐẾM CALO (KHÔNG BỊA SỐ):
   - Có nhãn dinh dưỡng hoặc sản phẩm đóng gói đọc rõ tên + dung tích (VD: lon nước, hộp sữa): ghi đúng kcal theo nhãn/nhà sản xuất (VD: "0 kcal/lon 355ml", "140 kcal/lon 330ml").
   - Món ăn tươi thấy rõ từng thành phần trên đĩa/tô: tính cộng dồn theo chuẩn Viện Dinh Dưỡng Việt Nam và ghi rõ cách tính vào "chi_tiet_san_pham" (VD: "150g cơm ~195 kcal + 100g gà ~165 kcal"), xuất tổng khoảng hẹp vào "calo_uoc_tinh".
   - Món đựng trong hộp kín/bị che khuất không thấy khẩu phần: BẮT BUỘC ghi "Chưa đủ dữ liệu trên ảnh".
   - Logo trường học, di tích, đồ vật không ăn được: BẮT BUỘC ghi "Không áp dụng".
4. ĐẶC SẢN MIỀN TRUNG: Cao lầu (sợi dày vuông vàng/nâu, xá xíu, ram giòn, KHÔNG đậu phộng); Mì Quảng (sợi dẹt bản to, CÓ đậu phộng, bánh tráng mè).
5. TỐC ĐỘ: Viết ngắn gọn, súc tích đúng 1–2 câu chuẩn xác cho mỗi mục để phản hồi cực nhanh. CHỈ TRẢ VỀ JSON HỢP LỆ:

{
  "khong_nhan_dien_duoc": false,
  "chu_doc_duoc_tren_anh": "Nguyên văn chữ/thương hiệu/tên trường/dung tích đọc được",
  "loai_doi_tuong": "Trường học & Tổ chức | Thương hiệu | Di tích | Nhà hàng & Quán ăn | Shop & Workshop | Hán Nôm | Thức ăn & Đồ uống | Sản phẩm | Vật thể",
  "la_dia_diem": false,
  "ten_dia_diem": "Tên chính xác nhất của trường học, thương hiệu, sản phẩm, món ăn hoặc địa điểm. KHÔNG ghi 'Không áp dụng'.",
  "dia_chi": "Địa chỉ thật nếu biết chắc 100%, ngược lại ghi 'Không áp dụng' hoặc 'Chưa xác định rõ từ ảnh'",
  "nien_dai_hoac_gia": "Năm thành lập thật (nếu là trường/di tích) hoặc khoảng giá bán lẻ VNĐ thực tế tại Việt Nam; không rõ ghi 'Chưa xác định rõ từ ảnh'",
  "cau_chuyen_lich_su": "1-2 câu chính xác, đã kiểm chứng về bản chất, công dụng hoặc lịch sử.",
  "giai_thoai_dac_biet": "1-2 câu mô tả chi tiết thực tế nhìn thấy trong ảnh (màu sắc, biểu tượng, chất liệu, bố cục).",
  "thong_tin_san_pham": {
    "hien_thi": true,
    "calo_uoc_tinh": "Số kcal chính xác theo nhãn/định lượng; đồ ăn bị che ghi 'Chưa đủ dữ liệu trên ảnh'; đồ vật/logo ghi 'Không áp dụng'",
    "tot_cho_suc_khoe": "1 câu đánh giá thực tế về dinh dưỡng hoặc lưu ý an toàn (đồ vật/logo ghi 'Không áp dụng').",
    "chi_tiet_san_pham": "Thành phần + định lượng calo (nếu là món ăn) hoặc chất liệu/dung tích nổi bật.",
    "noi_mua_goi_y": "Khu vực hoặc loại cửa hàng phổ biến.",
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
    "tom_tat": "1 câu nhận xét khách quan thực tế.",
    "review_mau": ["Ưu điểm thực tế", "Lưu ý thực tế"]
  }
}`;
}

// ==========================================
// 6. TẦNG 1: GROQ LPU (TỰ DÒ MODEL VISION SỐNG + SINGLE-FLIGHT)
// ==========================================
async function fetchWorkingGroqModels(apiKey, timeoutMs = CONFIG.GROQ_MODELS_TIMEOUT_MS) {
  const now = Date.now();
  if (
    runtimeState.cachedGroqModels &&
    now - runtimeState.cachedGroqModelsAt < CONFIG.MODELS_CACHE_TTL_MS
  ) {
    return runtimeState.cachedGroqModels;
  }

  return runSingleFlight("groq:models", async () => {
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
    runtimeState.cachedGroqModelsAt = Date.now();
    return activeModels;
  });
}

function getOrderedGroqVisionModels(liveModels = []) {
  const textOnly = /gpt-oss|deepseek|mixtral|llama-3\.1|llama-3\.3|llama3-|allam|gemma2|minimax/i;
  const highPriority = /qwen3\.8|vl|maverick|vision|pixtral|omni|multimodal|muse-spark/i;
  const secondary = /qwen|llama-4|llama-5|scout|kimi/i;

  const filtered = [...new Set(liveModels)].filter(
    (m) => !textOnly.test(m) && !runtimeState.badGroqVisionModels.has(m)
  );
  const tier1 = filtered.filter((m) => highPriority.test(m));
  const tier2 = filtered.filter((m) => !highPriority.test(m) && secondary.test(m));
  return [...tier1, ...tier2];
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
        temperature: 0.05,
        max_tokens: 1050,
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
    let msg = rawText.slice(0, 140);
    try {
      msg = JSON.parse(rawText)?.error?.message || msg;
    } catch (_) {}
    const err = new Error(`Groq(${model}) HTTP ${res.status}: ${msg}`);
    err.status = res.status;
    throw err;
  }

  const parsed = JSON.parse(rawText.trim());
  const content = parsed.choices?.[0]?.message?.content;
  if (!content) throw new Error(`Groq(${model}): Empty content`);
  return extractJson(content);
}

async function runGroqVision({ apiKeys, prompt, imageBase64, deadline }) {
  const errors = [];
  // Thử tối đa 3 key luân phiên (đủ chịu tải, không bao giờ kẹt lâu)
  for (const apiKey of apiKeys.slice(0, 3)) {
    const remaining = deadline - Date.now();
    if (remaining < 1400) break;

    let liveModels = [];
    try {
      liveModels = await fetchWorkingGroqModels(apiKey, Math.min(CONFIG.GROQ_MODELS_TIMEOUT_MS, remaining - 500));
    } catch (e) {
      errors.push(`GroqModels: ${e.message}`);
      continue;
    }

    const models = getOrderedGroqVisionModels(liveModels).slice(0, 2);
    if (!models.length) {
      errors.push("Groq không có model vision khả dụng");
      break;
    }

    for (const model of models) {
      const attemptLeft = deadline - Date.now();
      if (attemptLeft < 1200) break;

      try {
        const result = await callGroqVision({
          apiKey,
          model,
          prompt,
          imageBase64,
          timeoutMs: Math.min(CONFIG.GROQ_ATTEMPT_TIMEOUT_MS, attemptLeft)
        });
        if (result && typeof result === "object") {
          return { result, provider: `groq:${model}` };
        }
      } catch (err) {
        errors.push(err.message || `Groq(${model}): Failed`);
        if (err.status === 400 || err.status === 404) {
          runtimeState.badGroqVisionModels.add(model);
          continue;
        }
        if (err.status === 429 || err.status === 401 || err.status === 403) {
          markKeyCooldown(
            apiKey,
            err.status === 429 ? CONFIG.KEY_COOLDOWN_429_MS : CONFIG.KEY_COOLDOWN_AUTH_MS
          );
          break; // Nhảy ngay sang key khỏe tiếp theo
        }
      }
    }
  }

  const finalErr = new Error(errors.slice(0, 2).join(" | ") || "Groq không phản hồi");
  finalErr.isRateLimit = errors.some((e) => e.includes("429"));
  throw finalErr;
}

// ==========================================
// 7. TẦNG 2: GEMINI DỰ PHÒNG (CHUYỂN TỨC THÌ KHI GROQ BẬN)
// ==========================================
async function runGeminiBackupVision({ apiKeys, prompt, imageBase64, deadline }) {
  const cleanBase64 = String(imageBase64).replace(/^data:image\/\w+;base64,/, "");
  const errors = [];

  for (const model of CONFIG.GEMINI_BACKUP_MODELS) {
    if (runtimeState.badGeminiModels.has(model)) continue;

    for (const apiKey of apiKeys.slice(0, 3)) {
      const remaining = deadline - Date.now();
      if (remaining < 1200) break;

      try {
        const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
        const generationConfig = {
          temperature: 0.05,
          maxOutputTokens: 1050,
          responseMimeType: "application/json"
        };
        if (model.includes("3.8-flash")) {
          generationConfig.thinkingConfig = { thinkingBudget: 0 };
        }

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
          Math.min(CONFIG.GEMINI_BACKUP_TIMEOUT_MS, remaining)
        );

        const rawText = await res.text();
        if (!res.ok) {
          if (res.status === 404) runtimeState.badGeminiModels.add(model);
          else if (res.status === 429) markKeyCooldown(apiKey, CONFIG.KEY_COOLDOWN_429_MS);
          else if (res.status === 401 || res.status === 403) markKeyCooldown(apiKey, CONFIG.KEY_COOLDOWN_AUTH_MS);
          throw new Error(`Gemini(${model}) HTTP ${res.status}`);
        }

        const parsed = JSON.parse(rawText.trim());
        const content = parsed.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!content) throw new Error(`Gemini(${model}): Empty content`);
        return { result: extractJson(content), provider: `gemini:${model}` };
      } catch (err) {
        errors.push(err.message);
        if (err.message.includes("404")) break;
      }
    }
  }

  const finalErr = new Error(errors.slice(0, 2).join(" | ") || "Gemini backup unavailable");
  finalErr.isRateLimit = errors.some((e) => e.includes("429"));
  throw finalErr;
}

// ==========================================
// 8. SERPER CÓ CACHE 60 PHÚT + SINGLE-FLIGHT (TRA GIÁ & XÁC THỰC ĐỊA CHỈ THẬT)
// ==========================================
async function querySerperCached(query, num = 4, timeoutMs = CONFIG.SERPER_TIMEOUT_MS) {
  const normKey = `serper:${normalizeTextForMatch(query)}:${num}`;
  const cached = getCache(runtimeState.serperCache, normKey);
  if (cached !== null) return cached;

  const apiKeys = collectApiKeys("SERPER_API_KEY");
  if (!apiKeys.length || !query) return null;

  return runSingleFlight(normKey, async () => {
    for (const apiKey of apiKeys.slice(0, 2)) {
      try {
        const res = await fetchWithTimeout(
          "https://google.serper.dev/search",
          {
            method: "POST",
            headers: {
              "X-API-KEY": apiKey,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({ q: query, gl: "vn", hl: "vi", num })
          },
          timeoutMs
        );

        if (res.status === 400 || res.status === 401 || res.status === 403 || res.status === 429) {
          markKeyCooldown(apiKey, CONFIG.KEY_COOLDOWN_AUTH_MS);
          continue;
        }
        if (!res.ok) continue;

        const data = await res.json();
        setCache(runtimeState.serperCache, normKey, data, CONFIG.SERPER_CACHE_TTL_MS, 250);
        return data;
      } catch (_) {
        continue;
      }
    }
    return null;
  });
}

async function fetchRealPriceFromGoogle(productName, ocrHint = "", timeoutMs = CONFIG.SERPER_TIMEOUT_MS) {
  const unitMatch = String(ocrHint || "").match(/\b\d+\s*(?:ml|g|kg|lít|l|viên|gói)\b/i);
  const searchName = unitMatch && !productName.toLowerCase().includes(unitMatch[0].toLowerCase())
    ? `${productName} ${unitMatch[0]}`
    : productName;

  const data = await querySerperCached(`giá bán ${searchName} chính hãng`, 5, timeoutMs);
  if (!data) return null;

  const texts = [];
  if (data.answerBox?.snippet) texts.push(data.answerBox.snippet);
  (data.organic || []).forEach((item) => {
    if (item.price) texts.push(String(item.price));
    if (item.title) texts.push(item.title);
    if (item.snippet) texts.push(item.snippet);
  });

  const fullText = texts.join(" | ");
  const prices = [];

  const regexVnd = /(?:₫\s*)?(\d{1,3}(?:[.,]\d{3})+)\s*(?:đ|₫|vnđ|vnd)?/gi;
  let match;
  while ((match = regexVnd.exec(fullText)) !== null) {
    const val = Number(match[1].replace(/[.,]/g, ""));
    if (val >= 5000 && val <= 100000000) prices.push(val);
  }

  const regexK = /\b(\d{2,4})k\b/gi;
  while ((match = regexK.exec(fullText)) !== null) {
    const val = Number(match[1]) * 1000;
    if (val >= 5000 && val <= 50000000) prices.push(val);
  }

  if (!prices.length) return null;

  prices.sort((a, b) => a - b);
  const cut = prices.length >= 6 ? Math.floor(prices.length * 0.25) : (prices.length >= 4 ? 1 : 0);
  const trimmed = cut > 0 ? prices.slice(cut, prices.length - cut) : prices;
  const minP = trimmed[0];
  const maxP = trimmed[trimmed.length - 1];

  const fmt = (n) => n.toLocaleString("vi-VN");
  return minP === maxP ? `${fmt(minP)} VNĐ` : `${fmt(minP)} - ${fmt(maxP)} VNĐ`;
}

async function enrichLocalBrandOrSchool(payload, timeoutMs = CONFIG.SERPER_TIMEOUT_MS) {
  if (payload._verified) return payload;
  const isOrgOrBrand = /trường học|tổ chức|thương hiệu|nhà hàng|quán ăn|shop|di tích/i.test(payload.loai_doi_tuong);
  if (!isOrgOrBrand || !payload.ten_dia_diem) return payload;

  const data = await querySerperCached(`${payload.ten_dia_diem} Hội An Đà Nẵng địa chỉ`, 3, timeoutMs);
  if (!data) return payload;

  const kg = data.knowledgeGraph || {};
  const needsAddr = !payload.dia_chi || /không áp dụng|chưa xác định/i.test(payload.dia_chi);
  if (needsAddr && kg.address) {
    payload.dia_chi = kg.address;
  } else if (needsAddr) {
    const snippets = (data.organic || []).map((i) => `${i.title} ${i.snippet}`).join(" | ");
    const addrMatch = snippets.match(/Địa chỉ[:\s]+([^.|;\n]{10,80})/i);
    if (addrMatch) payload.dia_chi = addrMatch[1].trim();
  }
  return payload;
}

// ==========================================
// 9. TRỢ LÝ AI THÔNG MINH (HIỂU MÓN VỪA QUÉT + DỮ LIỆU GOOGLE THẬT)
// ==========================================
async function searchWebContextForChat(userText, lastScan) {
  if (!userText) return "";
  const needSearch = /quán|ăn gì|ở đâu|giá|mấy giờ|đường|thời tiết|review|ngon|mua|địa chỉ|sự kiện|vé|trường|chỗ nào/i.test(userText);
  if (!needSearch) return "";

  let query = userText.trim();
  if (/món này|cái này|sản phẩm này|vừa quét|trường này|quán này/i.test(query) && lastScan?.ten_dia_diem) {
    query = `${lastScan.ten_dia_diem} Hội An Đà Nẵng`;
  } else if (!/đà nẵng|hội an/i.test(query)) {
    query = `${query} Hội An Đà Nẵng`;
  }

  const data = await querySerperCached(query, 3, CONFIG.SERPER_TIMEOUT_MS);
  if (!data) return "";
  const snippets = (data.organic || [])
    .map((item) => `- ${item.title}: ${item.snippet}`)
    .join("\n");
  return snippets ? `\n[Dữ liệu Google thực tế vừa tra cứu]:\n${snippets}` : "";
}

function buildSmartChatSystemPrompt({ locationContext, lastScan, webContext }) {
  const vnTime = new Date().toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" });
  const scanContext = lastScan && lastScan.ten_dia_diem
    ? `\n[Đối tượng người dùng VỪA QUÉT bằng camera]:
- Tên: ${lastScan.ten_dia_diem} (${lastScan.loai_doi_tuong || ""})
- Địa chỉ: ${lastScan.dia_chi || "Không áp dụng"}
- Giá/Niên đại: ${lastScan.nien_dai_hoac_gia || "Chưa rõ"}
- Calo: ${lastScan.thong_tin_san_pham?.calo_uoc_tinh || "Không áp dụng"}
- Chi tiết: ${lastScan.cau_chuyen_lich_su || ""}`
    : "";

  return `Bạn là Trợ lý thông minh của ứng dụng AIvolution tại Hội An – Đà Nẵng.
Thời gian hiện tại: ${vnTime}. Vị trí người dùng: ${locationContext || "Hội An – Đà Nẵng"}.${scanContext}${webContext}

NGUYÊN TẮC TRẢ LỜI TRUNG THỰC & THÔNG MINH:
1. Trả lời đúng trọng tâm, tự nhiên, chính xác về Hội An – Đà Nẵng, dinh dưỡng và mua sắm.
2. Nếu người dùng hỏi về "món này / trường này / quán này / vừa quét", bám sát mục [Đối tượng người dùng VỪA QUÉT].
3. Chỉ dùng thông tin xác thực hoặc từ [Dữ liệu Google thực tế vừa tra cứu]; nếu không chắc địa chỉ/giờ mở cửa, nói thẳng để người dùng kiểm tra trên Google Maps, TUYỆT ĐỐI không bịa.
4. KHÔNG dùng ký tự Markdown như ** hoặc ## hoặc *; dùng gạch đầu dòng (-) hoặc số (1., 2.).
5. Viết súc tích 3–5 câu, rõ ràng.`;
}

async function handleGroqChat({ apiKeys, messages, locationContext, lastScan }) {
  const lastUserMsg = Array.isArray(messages)
    ? [...messages].reverse().find((m) => m.role === "user")?.content || ""
    : "";

  const webContext = await searchWebContextForChat(lastUserMsg, lastScan);
  const systemPrompt = buildSmartChatSystemPrompt({ locationContext, lastScan, webContext });

  const chatMessages = [
    { role: "system", content: systemPrompt },
    ...(Array.isArray(messages) ? messages.slice(-10) : [])
  ];

  for (const apiKey of apiKeys.slice(0, 3)) {
    let models;
    try {
      models = await fetchWorkingGroqModels(apiKey);
    } catch (_) {
      continue;
    }

    const sortedModels = [
      ...models.filter((m) => /llama-3\.3-70b|gpt-oss-120b|qwen3\.8|qwen-2\.5-32b/i.test(m)),
      ...models.filter((m) => /llama-3\.1|gpt-oss-20b|llama-4|qwen/i.test(m))
    ];

    for (const model of [...new Set(sortedModels)].slice(0, 2)) {
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
              max_tokens: 750,
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
          return reply
            .replace(/<think>[\s\S]*?<\/think>/gi, "")
            .replace(/\*\*/g, "")
            .replace(/^#+\s*/gm, "")
            .trim();
        }
      } catch (_) {}
    }
  }
  throw new Error("Groq chat unavailable");
}

async function handleGeminiBackupChat({ apiKeys, messages, locationContext, lastScan }) {
  const lastUserMsg = Array.isArray(messages)
    ? [...messages].reverse().find((m) => m.role === "user")?.content || ""
    : "";
  const webContext = await searchWebContextForChat(lastUserMsg, lastScan);
  const systemPrompt = buildSmartChatSystemPrompt({ locationContext, lastScan, webContext });

  const contents = (Array.isArray(messages) ? messages.slice(-10) : []).map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: String(m.content || "") }]
  }));

  for (const model of CONFIG.GEMINI_BACKUP_MODELS) {
    if (runtimeState.badGeminiModels.has(model)) continue;
    for (const apiKey of apiKeys.slice(0, 3)) {
      try {
        const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
        const generationConfig = { temperature: 0.3, maxOutputTokens: 750 };
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
        if (!res.ok) continue;
        const data = await res.json();
        const reply = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
        if (reply) {
          return reply.replace(/\*\*/g, "").replace(/^#+\s*/gm, "").trim();
        }
      } catch (_) {}
    }
  }
  throw new Error("Trợ lý tạm thời bận, bạn thử gửi lại sau vài giây nhé.");
}

// ==========================================
// 10. GIỌNG ĐỌC MP3 CÓ CACHE + SINGLE-FLIGHT (HOÀI MY NEURAL + DỰ PHÒNG)
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

  const cacheKey = `tts:${hashShort(cleanText)}`;
  const cached = getCache(runtimeState.ttsCache, cacheKey);
  if (cached) return cached;

  return runSingleFlight(cacheKey, async () => {
    let audio = null;
    try {
      audio = await generateHoaiMyBase64(cleanText);
    } catch (_) {}

    if (!audio) {
      audio = await generateBackupMp3Base64(cleanText);
    }
    if (audio) {
      setCache(runtimeState.ttsCache, cacheKey, audio, CONFIG.TTS_CACHE_TTL_MS, 60);
    }
    return audio;
  });
}

// ==========================================
// 11. ENTRY POINT SERVERLESS HANDLER (CHỊU TẢI 100 USERS)
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

    const groqKeys = collectApiKeys("GROQ_API_KEY");
    const geminiKeys = collectApiKeys("GEMINI_API_KEY");

    if (!groqKeys.length && !geminiKeys.length) {
      return res.status(500).json({
        error: CONFIG.FRIENDLY_ERROR,
        debug: "Thiếu biến môi trường GROQ_API_KEY và GEMINI_API_KEY trên Vercel"
      });
    }

    // --- 2. CHẾ ĐỘ CHATBOT THÔNG MINH (Groq chính -> Gemini dự phòng) ---
    if (body.mode === "chat") {
      if (groqKeys.length) {
        try {
          const reply = await handleGroqChat({
            apiKeys: groqKeys,
            messages: body.messages,
            locationContext: body.locationContext,
            lastScan: body.lastScan
          });
          return res.status(200).json({ reply, provider: "groq" });
        } catch (err) {
          console.error("[Groq Chat Fallback Reason]:", err.message);
        }
      }
      if (geminiKeys.length) {
        const reply = await handleGeminiBackupChat({
          apiKeys: geminiKeys,
          messages: body.messages,
          locationContext: body.locationContext,
          lastScan: body.lastScan
        });
        return res.status(200).json({ reply, provider: "gemini" });
      }
      throw new Error("Không có API Key hoạt động cho Chatbot");
    }

    // --- 3. CHẾ ĐỘ QUÉT ẢNH (SINGLE-FLIGHT + CACHE + DEADLINE 8.2s) ---
    const { imageBase64, locationContext, lat, lng } = body;
    if (!imageBase64) {
      return res.status(400).json({ error: CONFIG.FRIENDLY_ERROR, debug: "Thiếu dữ liệu ảnh" });
    }

    const imgKey = `scan:${hashShort(imageBase64)}`;
    const cachedScan = getCache(runtimeState.scanCache, imgKey);
    if (cachedScan) {
      return res.status(200).json({ ...cachedScan, _cached: true });
    }

    const finalPayload = await runSingleFlight(imgKey, async () => {
      const deadline = Date.now() + CONFIG.TOTAL_SCAN_BUDGET_MS;
      const areaPoint = clampToDaNangHoiAn(lat, lng, locationContext);
      const prompt = buildVisionPrompt(locationContext);

      let visionOutput = null;
      let groqError = null;

      if (groqKeys.length) {
        try {
          visionOutput = await runGroqVision({
            apiKeys: groqKeys,
            prompt,
            imageBase64,
            deadline: Math.min(deadline, Date.now() + 5000)
          });
        } catch (err) {
          groqError = err;
          console.error("[Groq Vision Fallback Reason]:", err.message);
        }
      }

      if (!visionOutput) {
        if (geminiKeys.length) {
          try {
            visionOutput = await runGeminiBackupVision({
              apiKeys: geminiKeys,
              prompt,
              imageBase64,
              deadline
            });
          } catch (gemErr) {
            const combinedErr = new Error(`Groq: ${groqError?.message || "N/A"} || Gemini: ${gemErr.message}`);
            combinedErr.isRateLimit = Boolean(groqError?.isRateLimit || gemErr?.isRateLimit);
            throw combinedErr;
          }
        } else if (groqError) {
          throw groqError;
        }
      }

      let payload = normalizeScanResult(visionOutput.result, {
        areaPoint,
        locationContext,
        provider: visionOutput.provider
      });

      if (payload.error) return payload;

      // Chỉ gọi Serper nếu vẫn còn đủ quỹ thời gian (>= 1.1s) để không bao giờ gây lag/504
      const timeLeftForSerper = deadline - Date.now();
      if (!payload._verified && timeLeftForSerper >= 1100) {
        const serperTimeout = Math.min(CONFIG.SERPER_TIMEOUT_MS, timeLeftForSerper - 150);
        if (payload.la_dia_diem) {
          payload = await enrichLocalBrandOrSchool(payload, serperTimeout);
        } else if (payload.ten_dia_diem) {
          const realPrice = await fetchRealPriceFromGoogle(
            payload.ten_dia_diem,
            payload._ocr,
            serperTimeout
          );
          if (realPrice) {
            payload.nien_dai_hoac_gia = realPrice;
          }
        }
      }

      setCache(runtimeState.scanCache, imgKey, payload, CONFIG.SCAN_CACHE_TTL_MS, 100);
      return payload;
    });

    if (finalPayload.error) {
      return res.status(422).json(finalPayload);
    }

    return res.status(200).json(finalPayload);
  } catch (err) {
    return res.status(err?.isRateLimit ? 429 : 502).json({
      error: err?.isRateLimit
        ? "Hệ thống đang có nhiều người quét cùng lúc (HTTP 429). Bạn đợi 5–10 giây rồi bấm Quét lại nhé!"
        : CONFIG.FRIENDLY_ERROR,
      debug: err?.message || "Lỗi xử lý máy chủ"
    });
  }
};
