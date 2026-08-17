// 네이버 API 연동만 딱 떼어서 확인하는 테스트 스크립트입니다.
// vercel dev 필요 없이 그냥 이 파일 하나로 확인할 수 있어요.
//
// 사용법 (터미널에서):
//   node test-naver.js
//
// .env.local 파일에서 NAVER_MAPS_CLIENT_ID / NAVER_MAPS_CLIENT_SECRET을 직접 읽어옵니다.

const fs = require("fs");
const path = require("path");

function loadEnvLocal() {
  const envPath = path.join(__dirname, ".env.local");
  if (!fs.existsSync(envPath)) {
    console.error("❌ .env.local 파일을 찾을 수 없어요. 이 스크립트와 같은 폴더에 있어야 해요.");
    process.exit(1);
  }
  const lines = fs.readFileSync(envPath, "utf8").split("\n");
  const env = {};
  lines.forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) return;
    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim();
    env[key] = value;
  });
  return env;
}

async function main() {
  const env = loadEnvLocal();
  const clientId = env.NAVER_MAPS_CLIENT_ID;
  const clientSecret = env.NAVER_MAPS_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    console.error("❌ .env.local 안에 NAVER_MAPS_CLIENT_ID / NAVER_MAPS_CLIENT_SECRET이 없어요.");
    process.exit(1);
  }

  console.log("🔑 Client ID:", clientId);
  console.log("🔎 네이버 Directions 5 API 호출 테스트 중...\n");

  // 제주국제공항 -> 성산일출봉 (임의의 두 지점, 실제 서비스에서 쓰는 좌표)
  const start = "126.4913534,33.5104135"; // 제주국제공항
  const goal = "126.9408178,33.4588891"; // 성산일출봉
  const url = `https://maps.apigw.ntruss.com/map-direction/v1/driving?start=${start}&goal=${goal}&option=trafast`;

  try {
    const response = await fetch(url, {
      headers: {
        "x-ncp-apigw-api-key-id": clientId,
        "x-ncp-apigw-api-key": clientSecret,
      },
    });
    const data = await response.json();

    if (data?.route?.trafast?.[0]?.summary) {
      const summary = data.route.trafast[0].summary;
      console.log("✅ 성공! 네이버 API가 정상 작동해요.\n");
      console.log(`   이동 거리: ${(summary.distance / 1000).toFixed(1)}km`);
      console.log(`   이동 시간: ${Math.round(summary.duration / 1000 / 60)}분`);
    } else {
      console.log("⚠️ 응답은 왔는데 예상한 형태가 아니에요. 전체 응답:");
      console.log(JSON.stringify(data, null, 2));
    }
  } catch (error) {
    console.error("❌ 요청 자체가 실패했어요:", error.message);
  }
}

main();
