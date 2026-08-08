# 황금키워드 자동 채굴기

키워드를 넣으면 네이버 검색광고 API(검색량)와 네이버 오픈API(블로그 문서수)를 실제로 호출해서
틈새 지수를 자동으로 계산해주는 사이트입니다. 숫자는 전부 실시간 조회 결과이며, 지어내지 않습니다.

## 배포 방법 (Vercel, 5분)

1. https://vercel.com 접속 → 회원가입(깃허브 계정으로 가능) → 로그인
2. "Add New" → "Project" → 이 폴더(golden-keyword-site)를 통째로 드래그 앤 드롭
3. 배포되기 전에 **Environment Variables**(환경 변수) 항목에 아래 값을 입력하세요:

**필수 (검색량 자동화)**

| 이름 | 값 |
|---|---|
| `NAVER_AD_API_KEY` | 검색광고 액세스라이선스 |
| `NAVER_AD_SECRET_KEY` | 검색광고 비밀키 |
| `NAVER_AD_CUSTOMER_ID` | 검색광고 CUSTOMER_ID |

**선택 (문서수·틈새비율까지 자동화하고 싶을 때만)**

| 이름 | 값 |
|---|---|
| `NAVER_CLIENT_ID` | 개발자센터/NCP 오픈API Client ID |
| `NAVER_CLIENT_SECRET` | 개발자센터/NCP 오픈API Client Secret |

선택 항목 2개는 안 넣어도 사이트가 정상 작동해요 — 검색량·연관키워드는 100% 자동, 문서수만 나중에 원할 때 추가하면 자동으로 틈새 비율까지 켜져요.

4. "Deploy" 클릭 → 1분 안에 `https://내프로젝트이름.vercel.app` 같은 진짜 주소가 생겨요.
5. 그 주소를 북마크해두면 언제든 폰·PC에서 바로 키워드 조회가 가능해요.

## 나중에 키를 바꾸거나 잘못 입력했다면

Vercel 프로젝트 → Settings → Environment Variables 에서 언제든 수정할 수 있어요.
수정 후에는 Deployments 탭에서 "Redeploy"를 한 번 눌러줘야 반영돼요.

## 구조

- `index.html` — 검색창 + 결과 화면 (프론트엔드)
- `api/research.js` — 실제 API 호출 + 틈새 지수 계산 (서버리스 함수, 키는 여기서만 사용되고 브라우저에는 노출되지 않아요)

