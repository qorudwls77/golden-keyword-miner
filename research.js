// api/research.js
// Vercel 서버리스 함수. 프론트에서 /api/research?keyword=... 로 호출한다.
// 네이버 검색광고 API(검색량) + 네이버 오픈API 블로그검색(문서수)을 실제로 호출해
// 틈새 지수를 계산한다. 숫자를 절대 지어내지 않는다 — API가 실패하면 에러를 그대로 보여준다.

const crypto = require('crypto');

function sign(timestamp, method, path, secretKey) {
  const message = `${timestamp}.${method}.${path}`;
  return crypto.createHmac('sha256', secretKey).update(message).digest('base64');
}

function normalizeCnt(v) {
  if (v === '< 10') return 5; // 최소 표기 보정용
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

async function fetchRelatedKeywords(keyword) {
  const timestamp = Date.now().toString();
  const method = 'GET';
  const path = '/keywordstool';
  const signature = sign(timestamp, method, path, process.env.NAVER_AD_SECRET_KEY);
  const url = `https://api.naver.com${path}?hintKeywords=${encodeURIComponent(keyword)}&showDetail=1`;

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

async function fetchDocCount(keyword) {
  const url = `https://openapi.naver.com/v1/search/blog.json?query=${encodeURIComponent(keyword)}&display=1`;
  const res = await fetch(url, {
    headers: {
      'X-Naver-Client-Id': process.env.NAVER_CLIENT_ID,
      'X-Naver-Client-Secret': process.env.NAVER_CLIENT_SECRET
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

  // 검색량 조회(검색광고 API)는 필수. 문서수 조회(오픈API)는 선택 — 없으면
  // 검색량만으로 자동화를 제공하고, 나중에 키를 추가하면 자동으로 활성화된다.
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

    // 검색량 기준으로 상위 20개만 추려서 문서수 조회 (API 호출 절약 + 속도)
    const withVolume = rel
      .map(k => {
        const pc = normalizeCnt(k.monthlyPcQcCnt);
        const mobile = normalizeCnt(k.monthlyMobileQcCnt);
        return { keyword: k.relKeyword, pc, mobile, volume: pc + mobile, compIdx: k.compIdx || null };
      })
      .sort((a, b) => b.volume - a.volume)
      .slice(0, 20);

    const withDocs = await Promise.all(
      withVolume.map(async k => {
        const docs = hasDocApi ? await fetchDocCount(k.keyword) : null;
        const ratio = (docs !== null && k.volume > 0) ? docs / k.volume : null;
        return { ...k, docs, ratio, status: statusOf(ratio) };
      })
    );

    // 검색량 50 미만은 '노이즈'로 보고 틈새 추천에서 제외 (실제 조사에서 확인된 패턴)
    const eligible = withDocs.filter(k => k.volume >= 50 && k.ratio !== null);
    let byNiche;
    if (eligible.length) {
      byNiche = eligible.slice().sort((a, b) => a.ratio - b.ratio);
    } else {
      // 문서수 API 미설정(또는 결과 없음) — 검색량 순으로 대체
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
