// api/research.js
const crypto = require('crypto');

function sign(timestamp, method, path, secretKey) {
      const message = `${timestamp}.${method}.${path}`;
      return crypto.createHmac('sha256', secretKey).update(message).digest('base64');
}

function normalizeCnt(v) {
      if (v === '< 10') return 5;
      const n = Number(v);
      return Number.isFinite(n) ? n : 0;
}

function stripTags(s) {
      return (s || '')
      .replace(/<\/?b>/g, '')
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>');
}

// 네이버 자동완성 API로 실제 사람들이 이어서 검색하는 키워드를 가져온다.
async function fetchAutocomplete(keyword) {
      const url = `https://ac.search.naver.com/nx/ac?q=${encodeURIComponent(keyword)}&con=0&frm=nv&ans=2&r_format=json&r_enc=UTF-8&r_unicode=0&t_koreng=1&run=2&rev=4&q_enc=UTF-8&st=100`;
      const res = await fetch(url, {
            headers: {
                  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
                  'Referer': 'https://search.naver.com/'
            }
      });
      if (!res.ok) return [];
      const data = await res.json();
      const list = (data.items && data.items[0]) ? data.items[0] : [];
      return list
      .map(item => Array.isArray(item) ? item[0] : item)
      .filter(Boolean)
      .map(s => String(s).trim())
      .filter(s => s && s.toLowerCase() !== keyword.trim().toLowerCase());
}

// 검색광고 API로 특정 키워드들의 정확한 검색량을 가져온다 (최대 5개씩 묶어서 조회).
async function fetchVolumeForKeywords(keywords) {
      const results = [];
      for (let i = 0; i < keywords.length; i += 5) {
            const chunk = keywords.slice(i, i + 5);
            const timestamp = Date.now().toString();
            const method = 'GET';
            const path = '/keywordstool';
            const signature = sign(timestamp, method, path, process.env.NAVER_AD_SECRET_KEY);
            const url = `https://api.naver.com${path}?hintKeywords=${encodeURIComponent(chunk.join(','))}&showDetail=1`;

      const res = await fetch(url, {
            headers: {
                  'X-Timestamp': timestamp,
                  'X-API-KEY': process.env.NAVER_AD_API_KEY,
                  'X-Customer': process.env.NAVER_AD_CUSTOMER_ID,
                  'X-Signature': signature
            }
      });

      if (!res.ok) continue;
            const data = await res.json();
            results.push(...(data.keywordList || []));
      }
      return results;
}

// 문서수 + 1등 블로그 글 (NAVER API HUB 블로그 검색)
async function fetchBlogInfo(keyword) {
      const url = `https://naverapihub.apigw.ntruss.com/search/v1/blog?query=${encodeURIComponent(keyword)}&display=1`;
      const res = await fetch(url, {
            headers: {
                  'X-NCP-APIGW-API-KEY-ID': process.env.NAVER_CLIENT_ID,
                  'X-NCP-APIGW-API-KEY': process.env.NAVER_CLIENT_SECRET
            }
      });
      if (!res.ok) return { docs: null, topPost: null };
      const data = await res.json();
      const docs = typeof data.total === 'number' ? data.total : null;
      let topPost = null;
      if (Array.isArray(data.items) && data.items.length) {
            const item = data.items[0];
            topPost = {
                  title: stripTags(item.title),
                  link: item.link,
                  blogger: item.bloggername || null
            };
      }
      return { docs, topPost };
}

function statusOf(ratio) {
      if (ratio === null) return '데이터 없음';
      if (ratio < 1) return '매우 좋음';
      if (ratio < 5) return '좋음';
      if (ratio < 20) return '보통';
      return '경쟁 심함';
}

module.exports = async (req, res) => {
      const keyword = (req.query.keyword || '').toString().trim();
      if (!keyword) {
            res.status(400).json({ error: '키워드를 입력해주세요.' });
            return;
      }

      const requiredEnv = ['NAVER_AD_API_KEY', 'NAVER_AD_SECRET_KEY', 'NAVER_AD_CUSTOMER_ID'];
      const missing = requiredEnv.filter(k => !process.env[k]);
      if (missing.length) {
            res.status(500).json({ error: `환경변수가 설정되지 않았어요: ${missing.join(', ')}` });
            return;
      }
      const hasDocApi = Boolean(process.env.NAVER_CLIENT_ID && process.env.NAVER_CLIENT_SECRET);

      try {
            const suggestions = await fetchAutocomplete(keyword);

      if (!suggestions.length) {
            res.status(200).json({ keyword, recommended: null, byNiche: [], byVolume: [], docApiEnabled: hasDocApi, note: '연관검색어를 찾지 못했어요. 다른 표현으로 시도해보세요.' });
            return;
      }

      const volumeData = await fetchVolumeForKeywords(suggestions);
            const normalizeKey = s => String(s).replace(/\s+/g, '').toLowerCase();
            const rel = suggestions.map(sug => {
                  const match = volumeData.find(v => normalizeKey(v.relKeyword) === normalizeKey(sug));
                  return match || { relKeyword: sug, monthlyPcQcCnt: 0, monthlyMobileQcCnt: 0, compIdx: null };
            });

      const withVolume = rel
            .map(k => {
                  const pc = normalizeCnt(k.monthlyPcQcCnt);
                  const mobile = normalizeCnt(k.monthlyMobileQcCnt);
                  return { keyword: k.relKeyword, pc, mobile, volume: pc + mobile, compIdx: k.compIdx || null };
            })
            .sort((a, b) => b.volume - a.volume)
            .slice(0, 30);

      const withDocs = await Promise.all(
            withVolume.map(async k => {
                  if (!hasDocApi) return { ...k, docs: null, ratio: null, status: statusOf(null), topPost: null };
                  const { docs, topPost } = await fetchBlogInfo(k.keyword);
                  const ratio = (docs !== null && k.volume > 0) ? docs / k.volume : null;
                  return { ...k, docs, ratio, status: statusOf(ratio), topPost };
            })
            );

      const eligible = withDocs.filter(k => k.volume >= 50 && k.ratio !== null);
            let byNiche;
            if (eligible.length) {
                  byNiche = eligible.slice().sort((a, b) => a.ratio - b.ratio);
            } else {
                  byNiche = withDocs.slice().sort((a, b) => b.volume - a.volume);
            }

      const byVolume = withDocs.slice().sort((a, b) => b.volume - a.volume);

      res.status(200).json({
            keyword,
            recommended: byNiche[0] || null,
            byNiche,
            byVolume,
            docApiEnabled: hasDocApi
      });
      } catch (err) {
            res.status(500).json({ error: err.message || '알 수 없는 오류가 발생했어요.' });
      }
};
