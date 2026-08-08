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

async function fetchRelatedKeywords(keyword) {
          const timestamp = Date.now().toString();
          const method = 'GET';
          const path = '/keywordstool';
          const signature = sign(timestamp, method, path, process.env.NAVER_AD_SECRET_KEY);
          const cleanKeyword = keyword.replace(/\s+/g, '');
          const url = `https://api.naver.com${path}?hintKeywords=${encodeURIComponent(cleanKeyword)}&showDetail=1`;

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

// 문서수 API — 정확한 신규 엔드포인트가 불확실해서, 가능성 있는 후보를 순서대로 시도한다.
const DOC_API_CANDIDATES = [
        { base: 'https://naveropenapi.apigw.ntruss.com/search/v1/blog', style: 'ncp' },
        { base: 'https://naveropenapi.apigw.ntruss.com/v1/search/blog', style: 'ncp' },
        { base: 'https://naveropenapi.apigw.ntruss.com/blog/v1/search', style: 'ncp' },
        { base: 'https://naveropenapi.apigw.ntruss.com/search-blog/v1/blog', style: 'ncp' },
        { base: 'https://naveropenapi.apigw.ntruss.com/v1/search-blog/blog', style: 'ncp' },
        { base: 'https://naveropenapi.apigw.ntruss.com/naversearch/v1/search/blog', style: 'ncp' },
        { base: 'https://openapi.naver.com/v1/search/blog.json', style: 'classic' },
        ];

let cachedDocApi = null; // { base, style } — 워밍 인스턴스 동안 캐시
let probeLog = [];

function docApiHeaders(style) {
          if (style === 'classic') {
                      return {
                                    'X-Naver-Client-Id': process.env.NAVER_CLIENT_ID,
                                    'X-Naver-Client-Secret': process.env.NAVER_CLIENT_SECRET
                      };
          }
          return {
                      'X-NCP-APIGW-API-KEY-ID': process.env.NAVER_CLIENT_ID,
                      'X-NCP-APIGW-API-KEY': process.env.NAVER_CLIENT_SECRET
          };
}

async function tryDocApi(candidate, keyword) {
          const url = `${candidate.base}?query=${encodeURIComponent(keyword)}&display=1`;
          const res = await fetch(url, { headers: docApiHeaders(candidate.style) });
          const text = await res.text();
          if (!res.ok) {
                      return { ok: false, status: res.status, text };
          }
          try {
                      const data = JSON.parse(text);
                      if (typeof data.total === 'number') {
                                    return { ok: true, total: data.total };
                      }
                      return { ok: false, status: res.status, text: 'total 필드 없음: ' + text.slice(0, 150) };
          } catch (e) {
                      return { ok: false, status: res.status, text: 'JSON 파싱 실패: ' + text.slice(0, 150) };
          }
}

async function discoverDocApi(keyword) {
          probeLog = [];
          for (const candidate of DOC_API_CANDIDATES) {
                      const result = await tryDocApi(candidate, keyword);
                      probeLog.push({ base: candidate.base, ok: result.ok, status: result.status, detail: result.ok ? null : result.text });
                      if (result.ok) {
                                    cachedDocApi = candidate;
                                    return result.total;
                      }
          }
          return null;
}

async function fetchDocCount(keyword) {
          if (cachedDocApi) {
                      const result = await tryDocApi(cachedDocApi, keyword);
                      if (result.ok) return result.total;
                      cachedDocApi = null; // 캐시가 더 이상 안 맞으면 초기화
          }
          return discoverDocApi(keyword);
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
                      const rel = await fetchRelatedKeywords(keyword);
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
                        .slice(0, 20);

            // 문서수 API 엔드포인트를 첫 키워드로 먼저 확정한 뒤, 나머지는 확정된 것만 사용 (중복 탐색 방지)
            if (hasDocApi && !cachedDocApi && withVolume.length) {
                          await discoverDocApi(withVolume[0].keyword);
            }

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
                          docApiEnabled: hasDocApi,
                          docApiWorking: cachedDocApi ? cachedDocApi.base : null,
                          docApiProbeLog: hasDocApi && !cachedDocApi ? probeLog : undefined
            });
          } catch (err) {
                      res.status(500).json({ error: err.message || '알 수 없는 오류가 발생했어요.' });
          }
};
