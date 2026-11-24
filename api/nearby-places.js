// api/nearby-places.js
const QUERY_MAP = {
  all: 'nhà hàng quán ăn cafe minimart siêu thị tiện lợi',
  food: 'nhà hàng quán ăn ngon đặc sản',
  minimart: 'minimart siêu thị tiện lợi bách hóa xanh winmart',
  cafe: 'quán cà phê trà sữa',
};

function calcDistanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.SERPER_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'Chưa cấu hình SERPER_API_KEY trên Vercel.' });
  }

  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);
  const radius = Math.min(Math.max(Number(req.query.radius) || 1000, 500), 3000);
  const category = QUERY_MAP[req.query.category] ? req.query.category : 'all';

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return res.status(400).json({ error: 'Tọa độ GPS không hợp lệ.' });
  }

  try {
    const zoom = radius <= 1000 ? '15z' : '14z';
    const response = await fetch('https://google.serper.dev/maps', {
      method: 'POST',
      headers: {
        'X-API-KEY': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        q: QUERY_MAP[category],
        ll: `@${lat},${lng},${zoom}`,
        gl: 'vn',
        hl: 'vi',
      }),
    });

    if (!response.ok) {
      return res.status(502).json({ error: 'Không thể kết nối dữ liệu Google Maps.' });
    }

    const data = await response.json();
    const seen = new Set();

    const places = (data.places || [])
      .filter((p) => Number.isFinite(p.latitude) && Number.isFinite(p.longitude))
      .map((p) => {
        const id = p.cid || `${p.latitude}_${p.longitude}`;
        const distance = calcDistanceMeters(lat, lng, p.latitude, p.longitude);
        return {
          id,
          name: p.title || 'Địa điểm chưa rõ tên',
          type: p.type || 'Cửa hàng',
          address: p.address || '',
          rating: Number(p.rating) || 0,
          reviews: Number(p.ratingCount) || 0,
          distance,
          mapsUrl: p.cid
            ? `https://www.google.com/maps?cid=${p.cid}`
            : `https://www.google.com/maps/dir/?api=1&destination=${p.latitude},${p.longitude}`,
        };
      })
      .filter((p) => {
        if (seen.has(p.id)) return false;
        seen.add(p.id);
        return p.distance <= radius && p.rating >= 4.0 && p.reviews >= 5;
      })
      // Ưu tiên: Sao cao nhất -> Nhiều lượt đánh giá nhất -> Gần nhất
      .sort((a, b) => {
        if (b.rating !== a.rating) return b.rating - a.rating;
        if (b.reviews !== a.reviews) return b.reviews - a.reviews;
        return a.distance - b.distance;
      });

    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    return res.status(200).json({ places, radius, updatedAt: Date.now() });
  } catch (error) {
    return res.status(500).json({ error: 'Lỗi máy chủ khi quét địa điểm quanh bạn.' });
  }
}
