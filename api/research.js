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

async function fetchRelatedKeywords(hint) {
    const timestamp = Date.now().toString();
    const method = 'GET';
    const path = '/keywordstool';
    const signature = sign(timestamp, method, path, process.env.NAVER_AD_SECRET_KEY);
    const url = `https://api.naver.com${path}?hintKeywords=${encodeURIComponent(hint)}&showDetail=1`;

  const res = await fetch(url, {
        headers: {
                'X-Timestamp': timestamp,
                'X-API-KEY': process.env.NAVER_AD_API_KEY,
                'X-Customer': process.env.NAVER_AD_CUSTOMER_ID,
                'X-Signature': signature
        }
  });

  if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`검색광고 API 오류 (${res.status}) — 키 값을 다시 확인해보세요. ${text.slice(0, 200)}`);
  }
    const data = await res.json();
    return data.keywordList || [];
}

// 네이버 자동완성 — 실제 사람들이 검색창에 치는 조합(브랜드/지역명 등)을 가져온다
async function fetchAutocomplete(keyword) {
    try {
          const url = `https://ac.search.naver.com/nx/ac?q=${encodeURIComponent(keyword)}&con=1&frm=nv&ans=2&r_format=json&r_enc=UTF-8&r_unicode=0&t_koreng=1&run=2&rev=4&q_enc=UTF-8&st=100`;
          const res = await fetch(url);
          if (!res.ok) return [];
          const data = await res.json();
          const raw = (data.items && data.items[0]) ? data.items[0] : [];
          return raw
            .map(item => Array.isArray(item) ? item[0] : item)
            .filter(s => typeof s === 'string' && s.trim());
    } catch (e) {
          return [];
    }
}

// 문서수 API (NAVER API HUB 블로그 검색)
async function fetchDocCount(keyword) {
    const url = `https://naverapihub.apigw.ntruss.com/search/v1/blog?query=${encodeURIComponent(keyword)}&display=1`;
    const res = await fetch(url, {
          headers: {
                  'X-NCP-APIGW-API-KEY-ID': process.env.NAVER_CLIENT_ID,
                  'X-NCP-APIGW-API-KEY': process.env.NAVER_CLIENT_SECRET
          }
    });
    if (!res.ok) return null;
    const data = await res.json();
    return typeof data.total === 'number' ? data.total : null;
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
          const cleanKeyword = keyword.replace(/\s+/g, '');
          let rel = await fetchRelatedKeywords(cleanKeyword);
          const seen = new Set(rel.map(r => r.relKeyword));

      // 1) 입력이 이미 구체적이라 결과가 적으면, 첫 단어(뿌리 키워드)로도 찾아 합친다
      const rootWord = keyword.trim().split(/\s+/)[0];
          if (rel.length < 8 && rootWord && rootWord !== cleanKeyword) {
                  try {
                            const broader = await fetchRelatedKeywords(rootWord);
                            for (const r of broader) {
                                        if (!seen.has(r.relKeyword)) { rel.push(r); seen.add(r.relKeyword); }
                            }
                  } catch (e) { /* 무시하고 진행 */ }
          }

      // 2) 자동완성으로 실제 검색 조합(브랜드/지역명 등)을 찾아, 그 실제 수치를 배치 조회해 합친다
      try {
              const suggestions = await fetchAutocomplete(keyword);
              const candidates = suggestions
                .map(s => s.replace(/\s+/g, ''))
                .filter(s => s && s !== cleanKeyword)
                .slice(0, 5);
              if (candidates.length) {
                        const extra = await fetchRelatedKeywords(candidates.join(','));
                        for (const r of extra) {
                                    if (!seen.has(r.relKeyword)) { rel.push(r); seen.add(r.relKeyword); }
                        }
              }
      } catch (e) { /* 자동완성 실패해도 기존 결과 유지 */ }

      if (!rel.length) {
              res.status(200).json({ keyword, recommended: null, byNiche: [], byVolume: [], docApiEnabled: hasDocApi, note: '연관 키워드를 찾지 못했어요. 다른 표현으로 시도해보세요.' });
              return;
      }

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
                        const docs = hasDocApi ? await fetchDocCount(k.keyword) : null;
                        const ratio = (docs !== null && k.volume > 0) ? docs / k.volume : null;
                        return { ...k, docs, ratio, status: statusOf(ratio) };
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
