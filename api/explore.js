/**
 * AIvolution Team - 100% Free Real-time Explore Hub (0 Token • 0 API Key)
 * - News: Báo lớn Đà Nẵng – Hội An có ảnh bìa thật
 * - Food & Drinks: Voucher/Món mới (KFC, Dookki, Bách Hóa Xanh, Pikamart, Jollibee, Highlands, Mixue...) + Món độc đáo Hội An
 * - Check-in: Tọa độ sống ảo Đà Nẵng – Hội An có ảnh thật 640px + bài báo trend
 */

const CACHE_TTL_MS = 30 * 60 * 1000;
const ramCache = new Map();
const inFlight = new Map();
const UA = "Mozilla/5.0 (compatible; AIvolutionBot/1.0; +https://aitl-teal.vercel.app)";

// Danh sách món ăn độc đáo nổi tiếng tại Hội An (địa chỉ thật + gắn ảnh tự động từ Wikipedia)
const HOI_AN_UNIQUE_FOODS = [
  {
    title: "Nước Mót Hội An — Trà thảo mộc cánh sen",
    subtitle: "150 Trần Phú, Phố cổ Hội An • Thức uống thảo mộc sả chanh, gừng, cam thảo giải nhiệt đặc trưng.",
    badge: "Độc đáo Hội An",
    meta: "16.000 - 30.000đ",
    wikiKey: "Trà thảo mộc",
    address: "150 Trần Phú, Hội An"
  },
  {
    title: "Chè Xí Mà Phủ (Chè mè đen) Ông Thiều",
    subtitle: "130 Nguyễn Trường Tộ, Hội An • Món chè mè đen nấu cùng vị thuốc bắc gia truyền hơn 70 năm.",
    badge: "Độc đáo Hội An",
    meta: "10.000 - 15.000đ",
    wikiKey: "Chè",
    address: "130 Nguyễn Trường Tộ, Hội An"
  },
  {
    title: "Bánh Mì Phượng Hội An",
    subtitle: "2B Phan Chu Trinh, Hội An • Vỏ giòn rụm, xốt gia truyền với nhân xá xíu, pate, thịt nướng.",
    badge: "Nổi tiếng Hội An",
    meta: "25.000 - 45.000đ",
    wikiKey: "Bánh mì Việt Nam",
    address: "2B Phan Chu Trinh, Hội An"
  },
  {
    title: "Bánh Mì Madam Khánh (The Bánh Mì Queen)",
    subtitle: "115 Trần Cao Vân, Hội An • Nhân thập cẩm hài hòa, nộm đu đủ giòn và nước xốt béo thơm.",
    badge: "Nổi tiếng Hội An",
    meta: "25.000 - 40.000đ",
    wikiKey: "Bánh mì Việt Nam",
    address: "115 Trần Cao Vân, Hội An"
  },
  {
    title: "Cao Lầu Thanh — Chuẩn vị phố cổ",
    subtitle: "26 Thái Phiên, Hội An • Sợi mì vàng dai giòn, thịt xá xíu mềm, da heo chiên và rau Trà Quế.",
    badge: "Đặc sản Hội An",
    meta: "30.000 - 45.000đ",
    wikiKey: "Cao lầu",
    address: "26 Thái Phiên, Hội An"
  },
  {
    title: "Cơm Gà Bà Buội Hội An",
    subtitle: "22 Phan Chu Trinh, Hội An • Cơm nấu nước luộc gà vàng tơi, gà ta xé phay trộn hành tây rau răm.",
    badge: "Đặc sản Hội An",
    meta: "35.000 - 55.000đ",
    wikiKey: "Cơm gà",
    address: "22 Phan Chu Trinh, Hội An"
  },
  {
    title: "Bánh Đập – Hến Xào Cẩm Nam",
    subtitle: "Lương Như Bích, Cẩm Nam, Hội An • Bánh tráng nướng kẹp bánh ướt chấm mắm nêm ăn cùng hến xào.",
    badge: "Độc đáo Hội An",
    meta: "25.000 - 50.000đ",
    wikiKey: "Mì Quảng",
    address: "Cẩm Nam, Hội An"
  }
];

// Danh sách chuỗi F&B & Minimart phổ biến để người dùng tra nhanh ưu đãi / chi nhánh gần nhất
const CHAIN_QUICK_HUB = [
  {
    title: "KFC Việt Nam — Combo gà rán & Ưu đãi tuần này",
    subtitle: "Tìm chi nhánh KFC gần nhất Đà Nẵng – Hội An • Bấm AI để hỏi combo giảm giá & món mới.",
    badge: "Chuỗi KFC",
    meta: "Voucher & Combo",
    wikiKey: "Gà rán",
    mapsQuery: "KFC Đà Nẵng Hội An"
  },
  {
    title: "Dookki — Buffet Tokbokki & Phô mai kéo sợi",
    subtitle: "Tìm chi nhánh Dookki gần nhất tại Đà Nẵng • Bấm AI để hỏi giá vé, ưu đãi học sinh/sinh viên.",
    badge: "Chuỗi Dookki",
    meta: "Buffet Hot Trend",
    wikiKey: "Tteokbokki",
    mapsQuery: "Dookki Đà Nẵng"
  },
  {
    title: "Bách Hóa Xanh — Deal đồ ăn vặt, nước uống & khuyến mãi",
    subtitle: "Tìm cửa hàng Bách Hóa Xanh gần bạn tại Hội An – Đà Nẵng • Săn hàng giảm giá mỗi ngày.",
    badge: "Bách Hóa Xanh",
    meta: "Siêu thị Mini",
    wikiKey: "Siêu thị",
    mapsQuery: "Bách Hóa Xanh Hội An Đà Nẵng"
  },
  {
    title: "Pikamart & Minimart — Đồ ăn nhanh, snack & nước giải khát",
    subtitle: "Tìm Pikamart / cửa hàng tiện lợi gần nhất quanh khu vực Hội An – Đà Nẵng.",
    badge: "Minimart • Pikamart",
    meta: "Tiện lợi 24/7",
    wikiKey: "Cửa hàng tiện lợi",
    mapsQuery: "Pikamart minimart Hội An Đà Nẵng"
  }
];

function fetchWithTimeout(url, options = {}, timeoutMs = 3400) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, {
    ...options,
    headers: { "User-Agent": UA, ...(options.headers || {}) },
    signal: controller.signal
  }).finally(() => clearTimeout(timer));
}

function runSingleFlight(key, fn) {
  if (inFlight.has(key)) return inFlight.get(key);
  const p = Promise.resolve().then(fn).finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}

function buildMapsPlaceUrl(title, address = "") {
  const q = address && !address.toLowerCase().includes(title.toLowerCase())
    ? `${title}, ${address}`
    : `${title}, Đà Nẵng - Hội An`;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
}

function decodeHtml(str) {
  return String(str || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, " ")
    .trim();
}

function stripTags(str) {
  return decodeHtml(String(str || "").replace(/<[^>]+>/g, " "));
}

function sanitizeImgUrl(raw) {
  let u = decodeHtml(raw || "").trim();
  if (!u || /^data:/i.test(u)) return "";
  if (u.startsWith("//")) u = `https:${u}`;
  if (u.startsWith("http://")) u = u.replace(/^http:\/\//i, "https://");
  if (!/^https:\/\//i.test(u)) return "";
  if (/logo|icon|avatar|pixel|1x1|blank\./i.test(u)) return "";
  return u;
}

function formatRelativeVnDate(pubDateRaw) {
  if (!pubDateRaw) return "Mới đăng";
  const d = new Date(pubDateRaw);
  if (Number.isNaN(d.getTime())) return "Mới đăng";

  const diffMin = Math.floor((Date.now() - d.getTime()) / 60000);
  if (diffMin >= 0 && diffMin < 60) return `${Math.max(1, diffMin)} phút trước`;
  if (diffMin >= 60 && diffMin < 1440) return `${Math.floor(diffMin / 60)} giờ trước`;

  return d.toLocaleDateString("vi-VN", {
    day: "2-digit",
    month: "2-digit",
    timeZone: "Asia/Ho_Chi_Minh"
  });
}

function extractImageFromRssBlock(block, decodedDesc) {
  const candidates = [
    (block.match(/<media:content[^>]+url=["']([^"']+)["']/i) || [])[1],
    (block.match(/<media:thumbnail[^>]+url=["']([^"']+)["']/i) || [])[1],
    (block.match(/<enclosure[^>]+url=["']([^"']+)["']/i) || [])[1],
    (decodedDesc.match(/<img[^>]+data-src=["']([^"']+)["']/i) || [])[1],
    (decodedDesc.match(/<img[^>]+src=["']([^"']+)["']/i) || [])[1]
  ];
  for (const c of candidates) {
    const clean = sanitizeImgUrl(c);
    if (clean) return clean;
  }
  return "";
}

async function fetchRssFeed(url, { defaultSource = "Tin tức", filterRegex = null, limit = 8, badgePrefix = "" } = {}) {
  const res = await fetchWithTimeout(url, {}, 3400);
  if (!res.ok) throw new Error(`RSS HTTP ${res.status}`);
  const xml = await res.text();

  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
  let m;

  while ((m = itemRegex.exec(xml)) !== null && items.length < limit) {
    const block = m[1];
    const rawTitle = (block.match(/<title>([\s\S]*?)<\/title>/i) || [])[1] || "";
    const rawLink = (block.match(/<link>([\s\S]*?)<\/link>/i) || [])[1] || "";
    const rawDesc = (block.match(/<description>([\s\S]*?)<\/description>/i) || [])[1] || "";
    const rawSource = (block.match(/<source[^>]*>([\s\S]*?)<\/source>/i) || [])[1] || "";
    const rawDate = (block.match(/<pubDate>([\s\S]*?)<\/pubDate>/i) || [])[1] || "";

    const decodedDesc = decodeHtml(rawDesc);
    const image = extractImageFromRssBlock(block, decodedDesc);

    let title = stripTags(rawTitle);
    const source = stripTags(rawSource) || defaultSource;
    if (rawSource && title.endsWith(`- ${source}`)) {
      title = title.slice(0, -(source.length + 2)).trim();
    } else if (defaultSource === "Google News") {
      title = title.replace(/\s*-\s*[^-]{2,35}$/, "").trim() || title;
    }

    const link = stripTags(rawLink);
    const snippet = stripTags(rawDesc).slice(0, 150);

    if (!title || !link) continue;
    if (filterRegex && !filterRegex.test(`${title} ${snippet}`)) continue;

    items.push({
      type: "news",
      title,
      subtitle: snippet && snippet !== title ? snippet : `Cập nhật mới nhất từ ${source}.`,
      badge: badgePrefix ? `${badgePrefix} • ${source}` : source,
      meta: formatRelativeVnDate(stripTags(rawDate)),
      image,
      url: link
    });
  }

  return items;
}

// Lấy bản đồ ảnh thật 640px từ Wikipedia Tiếng Việt cho món ăn & chuỗi F&B (0 token)
async function fetchWikiPhotoMap(titles) {
  const map = Object.create(null);
  try {
    const url =
      `https://vi.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(titles.join("|"))}` +
      `&prop=pageimages&piprop=thumbnail&pithumbsize=640&redirects=1&format=json`;
    const res = await fetchWithTimeout(url, {}, 2600);
    if (!res.ok) return map;
    const data = await res.json();

    const normMap = Object.create(null);
    (data.query?.normalized || []).forEach((n) => { normMap[n.to] = n.from; });
    const redirMap = Object.create(null);
    (data.query?.redirects || []).forEach((r) => { redirMap[r.to] = r.from; });

    Object.values(data.query?.pages || {}).forEach((p) => {
      const img = sanitizeImgUrl(p.thumbnail?.source || "");
      if (!img) return;
      map[p.title] = img;
      if (redirMap[p.title]) map[redirMap[p.title]] = img;
      if (normMap[p.title]) map[normMap[p.title]] = img;
    });
  } catch (_) {}
  return map;
}

function pickTopicPhotoFromMap(text, photoMap) {
  const t = String(text || "").toLowerCase();
  if (/kfc|jollibee|lotteria|gà rán|burger|mcdonald|popeyes/.test(t)) return photoMap["Gà rán"] || "";
  if (/dookki|doki|tokbokki|lẩu|hàn quốc/.test(t)) return photoMap["Tteokbokki"] || "";
  if (/bách hóa xanh|winmart|pikamart|minimart|gs25|circle k|siêu thị/.test(t)) return photoMap["Siêu thị"] || photoMap["Cửa hàng tiện lợi"] || "";
  if (/highlands|phúc long|katinat|mixue|trà sữa|cà phê|coffee/.test(t)) return photoMap["Cà phê sữa đá"] || photoMap["Trà sữa trân châu"] || "";
  if (/bánh mì/.test(t)) return photoMap["Bánh mì Việt Nam"] || "";
  if (/cao lầu/.test(t)) return photoMap["Cao lầu"] || "";
  if (/mì quảng/.test(t)) return photoMap["Mì Quảng"] || "";
  if (/cơm gà/.test(t)) return photoMap["Cơm gà"] || "";
  if (/chè|mót|trà thảo mộc/.test(t)) return photoMap["Chè"] || photoMap["Trà thảo mộc"] || "";
  return photoMap["Bánh mì Việt Nam"] || photoMap["Cao lầu"] || "";
}

async function fetchWikiGeosearch(lat, lng, cityName) {
  const url =
    `https://vi.wikipedia.org/w/api.php?action=query&generator=geosearch` +
    `&ggscoord=${lat}|${lng}&ggsradius=10000&ggslimit=16` +
    `&prop=pageimages|extracts&piprop=thumbnail&pithumbsize=640` +
    `&exintro=1&explaintext=1&exsentences=1&format=json`;

  const res = await fetchWithTimeout(url, {}, 3000);
  if (!res.ok) throw new Error(`Wiki HTTP ${res.status}`);
  const data = await res.json();
  const pages = Object.values(data.query?.pages || {});

  const skipAdmin = /^(Phường|Xã|Quận|Huyện|Thành phố|Tỉnh|Danh sách|Bầu cử|Sân bay|Trận |Đại học|Trường )/i;

  return pages
    .filter((p) => p.title && !skipAdmin.test(p.title) && p.thumbnail?.source)
    .map((p) => ({
      type: "place",
      title: p.title,
      subtitle: p.extract ? p.extract.slice(0, 125) : `Tọa độ check-in nổi bật tại ${cityName}.`,
      badge: `Check-in ${cityName}`,
      meta: "Tọa độ hot",
      image: sanitizeImgUrl(p.thumbnail.source),
      url: buildMapsPlaceUrl(p.title, cityName)
    }))
    .filter((x) => x.image)
    .slice(0, 7);
}

function dedupeAndSortWithImages(list, maxItems = 12) {
  const seen = new Set();
  const unique = list.filter((item) => {
    const k = String(item.title || "").toLowerCase().replace(/[^a-z0-9à-ỹ]/gi, "").slice(0, 36);
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  const withImg = unique.filter((x) => Boolean(x.image));
  const noImg = unique.filter((x) => !x.image);
  return [...withImg, ...noImg].slice(0, maxItems);
}

// ==========================================
// TAB 1: NEWS THỜI GIAN THỰC ĐÀ NẴNG – HỘI AN (LUÔN ƯU TIÊN BÀI CÓ ẢNH)
// ==========================================
async function getFreeRealtimeNews() {
  const dnHaFilter = /đà nẵng|hội an|quảng nam|cầu rồng|sơn trà|bà nà|mỹ khê|cù lao chàm|miền trung/i;
  const gNewsUrl = `https://news.google.com/rss/search?q=${encodeURIComponent('("Đà Nẵng" OR "Hội An") (du lịch OR sự kiện OR lễ hội OR tin mới) when:7d')}&hl=vi&gl=VN&ceid=VN:vi`;

  const settled = await Promise.allSettled([
    fetchRssFeed("https://vnexpress.net/rss/du-lich.rss", { defaultSource: "VnExpress", filterRegex: dnHaFilter, limit: 6 }),
    fetchRssFeed("https://vnexpress.net/rss/thoi-su.rss", { defaultSource: "VnExpress", filterRegex: dnHaFilter, limit: 5 }),
    fetchRssFeed("https://tuoitre.vn/rss/du-lich.rss", { defaultSource: "Tuổi Trẻ", filterRegex: dnHaFilter, limit: 6 }),
    fetchRssFeed("https://tuoitre.vn/rss/thoi-su.rss", { defaultSource: "Tuổi Trẻ", filterRegex: dnHaFilter, limit: 5 }),
    fetchRssFeed("https://thanhnien.vn/rss/du-lich.rss", { defaultSource: "Thanh Niên", filterRegex: dnHaFilter, limit: 6 }),
    fetchRssFeed("https://dantri.com.vn/rss/du-lich.rss", { defaultSource: "Dân Trí", filterRegex: dnHaFilter, limit: 6 }),
    fetchRssFeed("https://kenh14.vn/doi-song.rss", { defaultSource: "Kenh14", filterRegex: dnHaFilter, limit: 5 }),
    fetchRssFeed(gNewsUrl, { defaultSource: "Google News", limit: 6 })
  ]);

  const items = settled
    .filter((r) => r.status === "fulfilled")
    .flatMap((r) => r.value);

  if (items.filter((x) => x.image).length < 4) {
    const extra = await Promise.allSettled([
      fetchRssFeed("https://vnexpress.net/rss/du-lich.rss", { defaultSource: "VnExpress", limit: 6 }),
      fetchRssFeed("https://tuoitre.vn/rss/du-lich.rss", { defaultSource: "Tuổi Trẻ", limit: 6 })
    ]);
    items.push(...extra.filter((r) => r.status === "fulfilled").flatMap((r) => r.value));
  }

  return dedupeAndSortWithImages(items, 12);
}

// ==========================================
// TAB 2: FOOD & DRINKS — VOUCHER/MÓN MỚI CHUỖI F&B & MINIMART + ĐỘC ĐÁO HỘI AN
// ==========================================
async function getFreeTrendingFood() {
  const chainNewsQuery =
    '("KFC" OR "Dookki" OR "Jollibee" OR "Lotteria" OR "Bách Hóa Xanh" OR "Pikamart" OR "WinMart" OR "Highlands Coffee" OR "Phúc Long" OR "Mixue") ' +
    '("khuyến mãi" OR "voucher" OR "giảm giá" OR "món mới" OR "combo" OR "ưu đãi") when:30d';

  const gChainUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(chainNewsQuery)}&hl=vi&gl=VN&ceid=VN:vi`;
  const chainOrFoodRegex = /kfc|dookki|jollibee|lotteria|bách hóa xanh|pikamart|winmart|highlands|phúc long|mixue|katinat|minimart|khuyến mãi|giảm giá|món mới|hội an|đà nẵng|ẩm thực|ăn vặt|trà sữa/i;

  const wikiKeys = [
    "Gà rán",
    "Tteokbokki",
    "Siêu thị",
    "Cửa hàng tiện lợi",
    "Cà phê sữa đá",
    "Trà sữa trân châu",
    "Trà thảo mộc",
    "Chè",
    "Bánh mì Việt Nam",
    "Cao lầu",
    "Cơm gà",
    "Mì Quảng"
  ];

  const [photoMap, ...rssSettled] = await Promise.all([
    fetchWikiPhotoMap(wikiKeys),
    ...([
      fetchRssFeed("https://kenh14.vn/an-quay-di.rss", { defaultSource: "Kenh14", filterRegex: chainOrFoodRegex, limit: 6 }),
      fetchRssFeed("https://thanhnien.vn/rss/am-thuc.rss", { defaultSource: "Thanh Niên", filterRegex: chainOrFoodRegex, limit: 6 }),
      fetchRssFeed("https://vnexpress.net/rss/kinh-doanh.rss", { defaultSource: "VnExpress", filterRegex: /kfc|jollibee|lotteria|dookki|bách hóa xanh|winmart|highlands|phúc long|mixue/i, limit: 4 }),
      fetchRssFeed(gChainUrl, { defaultSource: "Deal & Món mới", limit: 8, badgePrefix: "Ưu đãi" })
    ].map((p) => p.then((value) => ({ status: "fulfilled", value })).catch(() => ({ status: "rejected", value: [] }))))
  ]);

  // 1. Gắn ảnh thật cho tin voucher/món mới từ các chuỗi
  const liveChainNews = rssSettled
    .filter((r) => r.status === "fulfilled")
    .flatMap((r) => r.value)
    .map((item) => ({
      ...item,
      image: item.image || pickTopicPhotoFromMap(`${item.title} ${item.subtitle}`, photoMap)
    }));

  // 2. Tạo thẻ địa chỉ món ăn độc đáo Hội An (có ảnh thật + Chỉ đường Maps)
  const hoiAnCards = HOI_AN_UNIQUE_FOODS.map((spot) => ({
    type: "place",
    title: spot.title,
    subtitle: spot.subtitle,
    badge: spot.badge,
    meta: spot.meta,
    image: photoMap[spot.wikiKey] || pickTopicPhotoFromMap(spot.title, photoMap),
    url: buildMapsPlaceUrl(spot.title.split("—")[0].trim(), spot.address)
  }));

  // 3. Tạo thẻ tra nhanh chuỗi KFC, Dookki, Bách Hóa Xanh, Pikamart
  const chainCards = CHAIN_QUICK_HUB.map((c) => ({
    type: "place",
    title: c.title,
    subtitle: c.subtitle,
    badge: c.badge,
    meta: c.meta,
    image: photoMap[c.wikiKey] || pickTopicPhotoFromMap(c.title, photoMap),
    url: buildMapsPlaceUrl(c.mapsQuery)
  }));

  // Bố cục cân bằng:
  // - 2 thẻ Featured đầu: 1 tin Deal/Món mới từ chuỗi + 1 món độc đáo Hội An
  // - Danh sách bên dưới: Xen kẽ tin khuyến mãi chuỗi + địa chỉ KFC/Dookki/BHX/Pikamart + đặc sản Hội An
  const mixed = [];
  const topNews = liveChainNews.slice(0, 5);
  const maxLen = Math.max(topNews.length, hoiAnCards.length, chainCards.length);
  for (let i = 0; i < maxLen; i++) {
    if (topNews[i]) mixed.push(topNews[i]);
    if (hoiAnCards[i]) mixed.push(hoiAnCards[i]);
    if (chainCards[i]) mixed.push(chainCards[i]);
  }

  return dedupeAndSortWithImages(mixed, 14);
}

// ==========================================
// TAB 3: LOCATION CHECK-IN SỐNG ẢO (LUÔN CÓ ẢNH THẬT HỘI AN & ĐÀ NẴNG)
// ==========================================
async function getFreeTrendingCheckin() {
  const checkinFilter = /đà nẵng|hội an|quảng nam|check-in|cà phê|hoàng hôn|phố cổ|biển|cầu|sơn trà|bà nà/i;

  const settled = await Promise.allSettled([
    fetchWikiGeosearch(15.8801, 108.3380, "Hội An"),
    fetchWikiGeosearch(16.0544, 108.2208, "Đà Nẵng"),
    fetchRssFeed("https://kenh14.vn/an-quay-di.rss", { defaultSource: "Kenh14", filterRegex: checkinFilter, limit: 5 }),
    fetchRssFeed("https://vnexpress.net/rss/du-lich.rss", { defaultSource: "VnExpress", filterRegex: checkinFilter, limit: 5 }),
    fetchRssFeed("https://thanhnien.vn/rss/du-lich.rss", { defaultSource: "Thanh Niên", filterRegex: checkinFilter, limit: 5 }),
    fetchRssFeed("https://tuoitre.vn/rss/du-lich.rss", { defaultSource: "Tuổi Trẻ", filterRegex: checkinFilter, limit: 5 })
  ]);

  const wikiHA = settled[0].status === "fulfilled" ? settled[0].value : [];
  const wikiDN = settled[1].status === "fulfilled" ? settled[1].value : [];
  const rssWithImg = settled
    .slice(2)
    .filter((r) => r.status === "fulfilled")
    .flatMap((r) => r.value)
    .filter((x) => Boolean(x.image)); // Chỉ lấy bài báo có ảnh thật cho tab Check-in

  const interleaved = [];
  const maxLen = Math.max(wikiHA.length, wikiDN.length);
  for (let i = 0; i < maxLen; i++) {
    if (wikiHA[i]) interleaved.push(wikiHA[i]);
    if (wikiDN[i]) interleaved.push(wikiDN[i]);
  }

  return dedupeAndSortWithImages([...interleaved, ...rssWithImg], 12);
}

module.exports = async (req, res) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "public, s-maxage=1800, stale-while-revalidate=3600");

  if (req.method === "OPTIONS") return res.status(200).end();

  const tab = ["news", "food", "checkin"].includes(req.query?.tab) ? req.query.tab : "news";
  const force = Boolean(req.query?._t);

  const cached = ramCache.get(tab);
  if (!force && cached && Date.now() < cached.exp) {
    return res.status(200).json({ ...cached.data, cached: true });
  }

  try {
    const items = await runSingleFlight(`explore:${tab}`, async () => {
      if (tab === "news") return getFreeRealtimeNews();
      if (tab === "food") return getFreeTrendingFood();
      return getFreeTrendingCheckin();
    });

    const payload = {
      tab,
      updatedAt: new Date().toLocaleTimeString("vi-VN", {
        hour: "2-digit",
        minute: "2-digit",
        timeZone: "Asia/Ho_Chi_Minh"
      }),
      provider: "free-open-news",
      items
    };

    if (items.length) {
      ramCache.set(tab, { data: payload, exp: Date.now() + CACHE_TTL_MS });
    }
    return res.status(200).json(payload);
  } catch (err) {
    return res.status(502).json({
      error: "Chưa tải được dữ liệu lúc này, bạn thử bấm làm mới nhé!",
      debug: err.message
    });
  }
};
