/**
 * AIvolution Team - 100% Free Real-time News, Food & Check-in with Real Cover Photos
 * 0 Token • 0 API Key • CDN Cache 30 phút
 * Nguồn ảnh thật: VnExpress, Tuổi Trẻ, Thanh Niên, Dân Trí, VietNamNet, Wikimedia Geosearch
 */

const CACHE_TTL_MS = 30 * 60 * 1000;
const ramCache = new Map();
const inFlight = new Map();
const UA = "Mozilla/5.0 (compatible; AIvolutionBot/1.0; +https://aitl-teal.vercel.app)";

function fetchWithTimeout(url, options = {}, timeoutMs = 3600) {
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

async function fetchRssFeed(url, { defaultSource = "Tin tức", filterRegex = null, limit = 8 } = {}) {
  const res = await fetchWithTimeout(url, {}, 3500);
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
      badge: source,
      meta: formatRelativeVnDate(stripTags(rawDate)),
      image,
      url: link
    });
  }

  return items;
}

// Tự lấy ảnh og:image từ trang báo gốc cho bài chưa có ảnh (chạy song song tối đa 1.4s)
async function enrichMissingOgImages(items, maxFetch = 4) {
  const targets = items
    .filter((i) => !i.image && i.url && !/news\.google\.com|google\.com\/maps/i.test(i.url))
    .slice(0, maxFetch);

  if (!targets.length) return items;

  await Promise.allSettled(
    targets.map(async (item) => {
      try {
        const res = await fetchWithTimeout(item.url, {}, 1400);
        if (!res.ok) return;
        const html = (await res.text()).slice(0, 28000);
        const ogMatch =
          html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) ||
          html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i) ||
          html.match(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i);
        if (ogMatch) {
          const clean = sanitizeImgUrl(ogMatch[1]);
          if (clean) item.image = clean;
        }
      } catch (_) {}
    })
  );
  return items;
}

function dedupeAndSortWithImages(list, maxItems = 12) {
  const seen = new Set();
  const unique = list.filter((item) => {
    const k = String(item.title || "").toLowerCase().replace(/[^a-z0-9à-ỹ]/gi, "").slice(0, 36);
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  // Luôn đưa bài có ảnh thật lên đầu để giao diện báo chí nổi bật nhất
  const withImg = unique.filter((x) => Boolean(x.image));
  const noImg = unique.filter((x) => !x.image);
  return [...withImg, ...noImg].slice(0, maxItems);
}

// Lấy ảnh thật độ phân giải 640px từ Wikipedia Tiếng Việt theo tọa độ hoặc danh sách chủ đề
async function fetchWikiGeosearch(lat, lng, cityName) {
  const url =
    `https://vi.wikipedia.org/w/api.php?action=query&generator=geosearch` +
    `&ggscoord=${lat}|${lng}&ggsradius=10000&ggslimit=14` +
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
      subtitle: p.extract ? p.extract.slice(0, 125) : `Điểm check-in nổi tiếng tại ${cityName}.`,
      badge: `Check-in ${cityName}`,
      meta: "Tọa độ hot",
      image: sanitizeImgUrl(p.thumbnail.source),
      url: buildMapsPlaceUrl(p.title, cityName)
    }))
    .filter((x) => x.image)
    .slice(0, 6);
}

async function fetchWikiFoodGallery() {
  const titles = [
    "Cao lầu",
    "Mì Quảng",
    "Bánh mì Việt Nam",
    "Bánh xèo",
    "Bún chả cá",
    "Bánh tráng cuốn thịt heo"
  ].join("|");

  const url =
    `https://vi.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(titles)}` +
    `&prop=pageimages|extracts&piprop=thumbnail&pithumbsize=640` +
    `&exintro=1&explaintext=1&exsentences=1&format=json`;

  const res = await fetchWithTimeout(url, {}, 2800);
  if (!res.ok) throw new Error(`WikiFood HTTP ${res.status}`);
  const data = await res.json();
  const pages = Object.values(data.query?.pages || {});

  return pages
    .filter((p) => p.title && p.thumbnail?.source)
    .map((p) => ({
      type: "place",
      title: `${p.title} — Đà Nẵng & Hội An`,
      subtitle: p.extract ? p.extract.slice(0, 125) : "Món đặc sản đường phố nổi tiếng tại Đà Nẵng – Hội An.",
      badge: "Ẩm thực bản địa",
      meta: "Tìm quán ngon gần đây",
      image: sanitizeImgUrl(p.thumbnail.source),
      url: buildMapsPlaceUrl(`${p.title} ngon`, "Đà Nẵng - Hội An")
    }))
    .filter((x) => x.image);
}

// ==========================================
// TAB 1: NEWS THỜI GIAN THỰC ĐÀ NẴNG – HỘI AN (NHIỀU BÁO LỚN CÓ ẢNH)
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
    fetchRssFeed("https://vietnamnet.vn/rss/du-lich.rss", { defaultSource: "VietNamNet", filterRegex: dnHaFilter, limit: 5 }),
    fetchRssFeed(gNewsUrl, { defaultSource: "Google News", limit: 8 })
  ]);

  let items = settled
    .filter((r) => r.status === "fulfilled")
    .flatMap((r) => r.value);

  // Nếu ít hơn 6 tin lọc hẹp theo khu vực, bổ sung thêm tin Du lịch nổi bật Việt Nam có ảnh đẹp
  if (items.filter((x) => x.image).length < 4) {
    const extra = await Promise.allSettled([
      fetchRssFeed("https://vnexpress.net/rss/du-lich.rss", { defaultSource: "VnExpress", limit: 6 }),
      fetchRssFeed("https://tuoitre.vn/rss/du-lich.rss", { defaultSource: "Tuổi Trẻ", limit: 6 })
    ]);
    items.push(...extra.filter((r) => r.status === "fulfilled").flatMap((r) => r.value));
  }

  items = await enrichMissingOgImages(items, 4);
  return dedupeAndSortWithImages(items, 12);
}

// ==========================================
// TAB 2: FOOD & DRINKS ĐƯỜNG PHỐ HOT (BÁO ẨM THỰC CÓ ẢNH + ĐẶC SẢN)
// ==========================================
async function getFreeTrendingFood() {
  const dnFoodFilter = /đà nẵng|hội an|quảng nam|miền trung|mì quảng|cao lầu|bánh mì|bánh xèo|ốc|chè|cà phê|ăn vặt|ẩm thực|quán ngon|đường phố|trà sữa/i;
  const gFoodUrl = `https://news.google.com/rss/search?q=${encodeURIComponent('("Đà Nẵng" OR "Hội An") ("ăn vặt" OR "ẩm thực đường phố" OR "quán ngon" OR "cà phê") when:30d')}&hl=vi&gl=VN&ceid=VN:vi`;

  const settled = await Promise.allSettled([
    fetchRssFeed("https://thanhnien.vn/rss/am-thuc.rss", { defaultSource: "Thanh Niên Ẩm thực", filterRegex: dnFoodFilter, limit: 6 }),
    fetchRssFeed("https://vnexpress.net/rss/du-lich.rss", { defaultSource: "VnExpress Ẩm thực", filterRegex: dnFoodFilter, limit: 6 }),
    fetchRssFeed("https://tuoitre.vn/rss/du-lich.rss", { defaultSource: "Tuổi Trẻ Ẩm thực", filterRegex: dnFoodFilter, limit: 6 }),
    fetchRssFeed("https://dantri.com.vn/rss/du-lich.rss", { defaultSource: "Dân Trí", filterRegex: dnFoodFilter, limit: 5 }),
    fetchWikiFoodGallery(),
    fetchRssFeed(gFoodUrl, { defaultSource: "Ẩm thực Hot", limit: 6 })
  ]);

  let items = settled
    .filter((r) => r.status === "fulfilled")
    .flatMap((r) => r.value);

  items = await enrichMissingOgImages(items, 4);
  return dedupeAndSortWithImages(items, 12);
}

// ==========================================
// TAB 3: LOCATION CHECK-IN SỐNG ẢO (ẢNH THẬT HỘI AN – ĐÀ NẴNG + BÁO TREND)
// ==========================================
async function getFreeTrendingCheckin() {
  const checkinFilter = /đà nẵng|hội an|quảng nam|check-in|cà phê|hoàng hôn|phố cổ|biển|cầu|sơn trà|bà nà/i;
  const gCheckinUrl = `https://news.google.com/rss/search?q=${encodeURIComponent('("Đà Nẵng" OR "Hội An") ("check-in" OR "sống ảo" OR "quán cà phê đẹp" OR "phố đi bộ") when:30d')}&hl=vi&gl=VN&ceid=VN:vi`;

  const settled = await Promise.allSettled([
    fetchWikiGeosearch(15.8801, 108.3380, "Hội An"),
    fetchWikiGeosearch(16.0544, 108.2208, "Đà Nẵng"),
    fetchRssFeed("https://vnexpress.net/rss/du-lich.rss", { defaultSource: "VnExpress", filterRegex: checkinFilter, limit: 5 }),
    fetchRssFeed("https://thanhnien.vn/rss/du-lich.rss", { defaultSource: "Thanh Niên", filterRegex: checkinFilter, limit: 5 }),
    fetchRssFeed(gCheckinUrl, { defaultSource: "Trend Check-in", limit: 6 })
  ]);

  const wikiHA = settled[0].status === "fulfilled" ? settled[0].value : [];
  const wikiDN = settled[1].status === "fulfilled" ? settled[1].value : [];
  const rssItems = [
    ...(settled[2].status === "fulfilled" ? settled[2].value : []),
    ...(settled[3].status === "fulfilled" ? settled[3].value : []),
    ...(settled[4].status === "fulfilled" ? settled[4].value : [])
  ];

  // Xen kẽ tọa độ ảnh đẹp Hội An & Đà Nẵng cùng các bài báo check-in mới
  const interleaved = [];
  const maxLen = Math.max(wikiHA.length, wikiDN.length);
  for (let i = 0; i < maxLen; i++) {
    if (wikiHA[i]) interleaved.push(wikiHA[i]);
    if (wikiDN[i]) interleaved.push(wikiDN[i]);
  }

  return dedupeAndSortWithImages([...interleaved, ...rssItems], 12);
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
      error: "Chưa tải được tin tức lúc này, bạn thử bấm làm mới nhé!",
      debug: err.message
    });
  }
};
