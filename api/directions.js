// Vercel 서버리스 함수: 네이버 Directions 5 API를 대신 호출해주는 프록시입니다.
//
// 왜 필요한가?
// 네이버 Directions 5 API는 브라우저에서 직접 fetch/XHR로 호출하면 CORS 정책 때문에
// 무조건 막힙니다(네이버도 공식적으로 확인한 이슈). 그래서 프론트엔드(app.js)가 우리
// 서버(이 파일)에 요청을 보내면, 이 서버가 대신 네이버에 요청하고 결과만 돌려줍니다.
//
// 필요한 환경변수 (Vercel 프로젝트 설정 > Environment Variables 에서 등록):
//   NAVER_MAPS_CLIENT_ID     = 네이버 클라우드 플랫폼에서 발급받은 Client ID
//   NAVER_MAPS_CLIENT_SECRET = 네이버 클라우드 플랫폼에서 발급받은 Client Secret
// (콘솔 경로: Services > Application Services > Maps > Directions 5 Application)
//
// 로컬에서 테스트하려면 Vercel CLI가 필요합니다.
//   npm install -g vercel
//   프로젝트 폴더에 .env.local 파일을 만들고 위 두 값을 적어둔 뒤
//   vercel dev 로 실행하면 index.html이 http://localhost:3000 에서 뜨고
//   이 API도 같이 동작합니다. (그냥 index.html을 더블클릭해서 열면 이 함수는
//   실행되지 않고, app.js가 자동으로 다음 우선순위(OSRM → 추정치)로 넘어갑니다.)
//
// 요청 형식: GET /api/directions?points=lng,lat|lng,lat|lng,lat...
//   (points 순서: [출발지, 선택한 장소들...] 형태를 그대로 넘기면 됩니다.)
// 응답 형식: { durations: number[][](초), distances: number[][](미터) }
//   -> app.js의 estimateTravelMatrix / OSRM 응답과 동일한 모양이라 프론트 코드
//      수정 없이 그대로 꽂아 쓸 수 있습니다.

const NAVER_DIRECTIONS_URL = "https://maps.apigw.ntruss.com/map-direction/v1/driving";
const MAX_POINTS = 8; // 출발지 1 + 관광지 최대 6 + 여유 1
const CONCURRENCY = 4; // 네이버 쪽에 한 번에 너무 많이 쏘지 않도록 나눠서 호출

function parsePoints(raw) {
  return raw.split("|").map((pair) => {
    const [lng, lat] = pair.split(",").map(Number);
    return { lng, lat };
  });
}

async function fetchPair(clientId, clientSecret, from, to) {
  const url = `${NAVER_DIRECTIONS_URL}?start=${from.lng},${from.lat}&goal=${to.lng},${to.lat}&option=trafast`;
  const response = await fetch(url, {
    headers: {
      "x-ncp-apigw-api-key-id": clientId,
      "x-ncp-apigw-api-key": clientSecret,
    },
  });
  const payload = await response.json();
  const summary = payload && payload.route && payload.route.trafast && payload.route.trafast[0] && payload.route.trafast[0].summary;
  if (!summary) {
    const message = (payload && payload.message) || `네이버 응답에 경로 정보가 없어요 (status ${response.status})`;
    throw new Error(message);
  }
  return { durationSec: summary.duration / 1000, distanceM: summary.distance };
}

export default async function handler(req, res) {
  const clientId = process.env.NAVER_MAPS_CLIENT_ID;
  const clientSecret = process.env.NAVER_MAPS_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    res.status(500).json({ error: "NAVER_MAPS_CLIENT_ID / NAVER_MAPS_CLIENT_SECRET 환경변수가 설정되지 않았어요." });
    return;
  }

  const raw = typeof req.query.points === "string" ? req.query.points : "";
  if (!raw) {
    res.status(400).json({ error: "points 쿼리 파라미터가 필요해요. 예: ?points=126.49,33.51|126.66,33.54" });
    return;
  }

  const points = parsePoints(raw);
  const n = points.length;
  if (n < 2 || n > MAX_POINTS || points.some((p) => Number.isNaN(p.lat) || Number.isNaN(p.lng))) {
    res.status(400).json({ error: `지점은 2~${MAX_POINTS}개의 유효한 좌표여야 해요.` });
    return;
  }

  const durations = Array.from({ length: n }, () => new Array(n).fill(0));
  const distances = Array.from({ length: n }, () => new Array(n).fill(0));

  const pairs = [];
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j < n; j += 1) {
      if (i !== j) pairs.push([i, j]);
    }
  }

  try {
    for (let i = 0; i < pairs.length; i += CONCURRENCY) {
      const chunk = pairs.slice(i, i + CONCURRENCY);
      // eslint-disable-next-line no-await-in-loop
      const results = await Promise.all(chunk.map(([a, b]) => fetchPair(clientId, clientSecret, points[a], points[b])));
      chunk.forEach(([a, b], idx) => {
        durations[a][b] = results[idx].durationSec;
        distances[a][b] = results[idx].distanceM;
      });
    }
  } catch (error) {
    res.status(502).json({ error: `네이버 경로 조회 실패: ${error.message}` });
    return;
  }

  res.status(200).json({ durations, distances });
}
