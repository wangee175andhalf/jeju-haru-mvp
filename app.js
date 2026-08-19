const AIRPORT = { name: "제주국제공항", lat: 33.5104135, lng: 126.4913534 };
const REGIONS = ["전체", "동부", "서부", "제주시내", "서귀포시내", "중문", "남부", "중산간"];
const WEEKDAY_NAMES = ["일", "월", "화", "수", "목", "금", "토"];

const state = {
  selectedIds: [],
  recommendedIds: [],
  scheduleResult: null,
  scheduleAlternatives: [],
  activeAlternativeIndex: 0,
  isBuilding: false,
  region: "전체",
  query: "",
  startPoint: { ...AIRPORT },
  flowStartedAt: null,
  isConfirmed: false,
  confirmedSchedule: null,
};

const elements = {
  date: document.querySelector("#travel-date"),
  time: document.querySelector("#start-time"),
  endTime: document.querySelector("#end-time"),
  weekday: document.querySelector("#weekday"),
  startName: document.querySelector("#start-name"),
  count: document.querySelector("#count"),
  search: document.querySelector("#search"),
  clearSearch: document.querySelector("#clear-search"),
  chips: document.querySelector("#region-chips"),
  spotList: document.querySelector("#spot-list"),
  routeBar: document.querySelector("#route-bar"),
  routeTitle: document.querySelector("#route-title"),
  routeSubtitle: document.querySelector("#route-subtitle"),
  stack: document.querySelector("#selection-stack"),
  previewButton: document.querySelector("#preview-button"),
  backdrop: document.querySelector("#schedule-backdrop"),
  scheduleTitle: document.querySelector("#schedule-title"),
  summaryCards: document.querySelector("#summary-cards"),
  timeline: document.querySelector("#timeline"),
  overtimeBanner: document.querySelector("#overtime-banner"),
  altSchedules: document.querySelector("#alt-schedules"),
  altList: document.querySelector("#alt-list"),
  confirmedPanel: document.querySelector("#confirmed-panel"),
  confirmedPanelTitle: document.querySelector("#confirmed-panel-title"),
  confirmedPanelBody: document.querySelector("#confirmed-panel-body"),
  toast: document.querySelector("#toast"),
  selectionStep: document.querySelector("#selection-step"),
  resultStep: document.querySelector("#result-step"),
};

// ---------------------------------------------------------------------------
// 입력값 로컬 저장 (localStorage)
// 계산된 일정 "결과"가 아니라, 사용자가 고른 "입력값"(장소, 출발지, 날짜/시간)만
// 저장합니다. 이동시간·운영시간·날씨는 시시각각 바뀔 수 있어서, 새로고침 후에는
// 이 입력값만 복원해두고 "추천 일정 만들기"를 다시 눌러야 그 시점의 최신 데이터로
// 재계산됩니다. (자동 재계산은 하지 않음 — 네이버 API 일일 호출 한도를 아끼기 위해
// 사용자가 명시적으로 버튼을 눌렀을 때만 호출되는 기존 방식을 그대로 유지)
// ---------------------------------------------------------------------------
const STORAGE_KEY = "jejuharu:inputs:v1";

function saveState() {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
      selectedIds: state.selectedIds,
      startPoint: state.startPoint,
      date: elements.date.value,
      time: elements.time.value,
      endTime: elements.endTime.value,
    }));
  } catch (error) {
    // localStorage를 못 쓰는 환경(시크릿 모드 등)이면 조용히 저장을 건너뜀
  }
}

function loadState() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    if (Array.isArray(saved.selectedIds)) {
      state.selectedIds = saved.selectedIds.filter((id) => SPOTS.some((spot) => spot.id === id));
      // toggleSpot()을 거치지 않고 바로 복원하면 flowStartedAt이 안 찍혀서, 이 상태로
      // 바로 확정/이탈해도 schedule_confirmed·schedule_dismissed KPI 이벤트가 안 잡히는
      // 문제가 있어 여기서도 동일하게 기록해줍니다.
      if (state.selectedIds.length) state.flowStartedAt = performance.now();
    }
    if (saved.startPoint && typeof saved.startPoint.lat === "number" && typeof saved.startPoint.lng === "number") {
      state.startPoint = saved.startPoint;
    }
    if (saved.date) elements.date.value = saved.date;
    if (saved.time) elements.time.value = saved.time;
    if (saved.endTime) elements.endTime.value = saved.endTime;
  } catch (error) {
    // 저장된 값이 손상됐거나 파싱에 실패해도 조용히 기본값으로 진행
  }
}

// ---------------------------------------------------------------------------
// 운영시간 파싱
// data.js의 hours 필드는 "09:00~18:00" 같은 형태부터 "점포별 상이", "상시 개방" 같은
// 자유 텍스트까지 섞여 있어요. 여기서는 HH:MM~HH:MM 패턴만 뽑아서 운영시간으로
// 쓰고, "상시"로 시작하거나 패턴을 못 찾으면 시간 제약이 없는 것으로 봅니다.
// (추후 관광지 데이터 담당자와 openTime/closeTime을 구조화된 필드로 분리하면
//  더 정확해질 수 있는 부분입니다.)
// ---------------------------------------------------------------------------
function parseHoursWindow(hoursText) {
  if (!hoursText || /^상시/.test(hoursText.trim())) return null;
  const match = hoursText.match(/(\d{1,2}):(\d{2})\s*[~\-]\s*(\d{1,2}):(\d{2})/);
  if (!match) return null;
  const open = Number(match[1]) * 60 + Number(match[2]);
  let close = Number(match[3]) * 60 + Number(match[4]);
  if (close <= open) close += 1440;
  return { open, close };
}
SPOTS.forEach((spot) => { spot.hoursWindow = parseHoursWindow(spot.hours); });

// ---------------------------------------------------------------------------
// 계절/기간제 운영 파싱
// "해수욕장 운영기간 6/24~9/6" 처럼 closure 필드에 M/D~M/D 형태로 적힌 운영기간을
// 뽑아냅니다. 이 기간 밖의 날짜에 방문하면(시설 이용은 어렵지만 장소 자체는
// 갈 수 있는 경우가 많아서) 선택을 막지는 않고, 일정표에서 "이용 기간 아님"
// 경고로 표시합니다.
// ---------------------------------------------------------------------------
function parseSeasonalWindow(closureText) {
  if (!closureText) return null;
  const match = closureText.match(/(\d{1,2})\/(\d{1,2})\s*~\s*(\d{1,2})\/(\d{1,2})/);
  if (!match) return null;
  return { startMonth: Number(match[1]), startDay: Number(match[2]), endMonth: Number(match[3]), endDay: Number(match[4]) };
}
SPOTS.forEach((spot) => { spot.seasonalWindow = parseSeasonalWindow(spot.closure); });

function isOutOfSeason(spot, date) {
  const window = spot.seasonalWindow;
  if (!window) return false;
  const value = (date.getMonth() + 1) * 100 + date.getDate();
  const start = window.startMonth * 100 + window.startDay;
  const end = window.endMonth * 100 + window.endDay;
  return start <= end ? value < start || value > end : value < start && value > end;
}

function isClosedOn(spot, date) {
  const weekday = WEEKDAY_NAMES[date.getDay()];
  return new RegExp(`매주\\s*${weekday}요일`).test(spot.closure || "");
}

// 모바일(좁은 화면)에서는 지도 세로 높이가 짧아져서 초기 확대 수준(10)을 그대로 쓰면
// 제주 섬 위아래가 잘려 보이는 문제가 있어, 화면 폭에 따라 초기 확대를 한 단계
// 낮춰(9) 섬 전체가 더 잘 들어오도록 조정합니다.
const INITIAL_MAP_ZOOM = window.innerWidth <= 900 ? 9 : 10;
const map = L.map("map", { zoomControl: false, minZoom: 8, maxZoom: 16 }).setView([33.382, 126.55], INITIAL_MAP_ZOOM);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "© OpenStreetMap contributors",
}).addTo(map);
L.control.zoom({ position: "bottomright" }).addTo(map);

const markerLayer = L.layerGroup().addTo(map);
let startMarker = null;
let routeLine = null;
let toastTimer = null;

function selectedSpots() {
  return state.selectedIds.map((id) => SPOTS.find((spot) => spot.id === id)).filter(Boolean);
}

function recommendedSpots() {
  return state.recommendedIds.map((id) => SPOTS.find((spot) => spot.id === id)).filter(Boolean);
}

function clearRecommendation() {
  state.recommendedIds = [];
  state.scheduleResult = null;
  state.scheduleAlternatives = [];
  state.activeAlternativeIndex = 0;
  state.isBuilding = false;
}

function selectedDate() {
  return new Date(`${elements.date.value}T12:00:00`);
}

function weekdayText() {
  return new Intl.DateTimeFormat("ko-KR", { weekday: "long" }).format(selectedDate());
}

function showToast(message) {
  window.clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.remove("hidden");
  toastTimer = window.setTimeout(() => elements.toast.classList.add("hidden"), 2600);
}

// ---------------------------------------------------------------------------
// KPI 이벤트 훅
// "일정 확정까지 걸린 시간 / 운영시간 충돌 건수 / 추천 원안 채택률 / 평균 수정 횟수"를
// 나중에 Google Analytics(김원 담당)만 연결하면 바로 집계할 수 있도록 dataLayer에
// 쌓아둡니다. GA가 아직 안 붙어 있어도 이 배열에 누적되기만 해서 안전합니다.
// ---------------------------------------------------------------------------
function trackEvent(name, params = {}) {
  window.dataLayer = window.dataLayer || [];
  window.dataLayer.push({ event: name, ...params });
  // index.html에 심어둔 gtag(GA4)로 실제 전송. GA 스크립트가 아직 없거나(로컬
  // index.html 더블클릭 등) 차단됐으면 gtag가 없어서 조용히 건너뜀 — 위 dataLayer
  // 누적은 그대로 유지되니 안전합니다.
  if (typeof gtag === "function") {
    gtag("event", name, params);
  }
}

function updateDate() {
  clearRecommendation();
  elements.weekday.textContent = weekdayText();
  renderAllSelections();
  saveState();
}

function renderChips() {
  elements.chips.innerHTML = REGIONS.map((region) => `<button type="button" class="${state.region === region ? "active" : ""}" data-region="${region}">${region}</button>`).join("");
  elements.chips.querySelectorAll("button").forEach((button) => {
    button.addEventListener("click", () => {
      state.region = button.dataset.region;
      renderChips();
      renderSpots();
    });
  });
}

function filteredSpots() {
  const query = state.query.trim().toLowerCase();
  return SPOTS.filter((spot) => {
    const regionMatch = state.region === "전체" || spot.region === state.region;
    const text = `${spot.name} ${spot.description} ${spot.category}`.toLowerCase();
    return regionMatch && (!query || text.includes(query));
  });
}

function toggleSpot(id) {
  const spot = SPOTS.find((item) => item.id === id);
  if (!spot) return;
  if (isClosedOn(spot, selectedDate())) {
    showToast(`${spot.name}은 선택한 날짜에 휴무예요.`);
    return;
  }
  if (state.selectedIds.includes(id)) {
    state.selectedIds = state.selectedIds.filter((item) => item !== id);
  } else if (state.selectedIds.length >= 6) {
    showToast("관광지는 최대 6곳까지 선택할 수 있어요.");
    return;
  } else {
    if (!state.selectedIds.length) {
      state.flowStartedAt = performance.now();
      state.isConfirmed = false;
    }
    state.selectedIds.push(id);
  }
  clearRecommendation();
  renderAllSelections();
  saveState();
}

function renderSpots() {
  const list = filteredSpots();
  if (!list.length) {
    elements.spotList.innerHTML = `<div class="empty-state">조건에 맞는 관광지를 찾지 못했어요.</div>`;
    return;
  }
  elements.spotList.innerHTML = list.map((spot) => {
    const selected = state.selectedIds.includes(spot.id);
    const closed = isClosedOn(spot, selectedDate());
    return `
      <article class="spot-card ${selected ? "selected" : ""} ${closed ? "closed" : ""}">
        <button type="button" class="spot-select" data-id="${spot.id}" aria-pressed="${selected}">
          <span class="spot-emoji">${CATEGORY_EMOJI[spot.category]}</span>
          <span class="spot-copy">
            <span class="spot-title-line"><strong>${spot.name}</strong>${closed ? "<em>오늘 휴무</em>" : ""}</span>
            <span>${spot.region} · 약 ${spot.duration}분</span>
            <small>${spot.hours}</small>
            <small class="spot-desc">${spot.description}</small>
          </span>
          <span class="checkmark">${selected ? "✓" : "+"}</span>
        </button>
        <a href="${spot.source}" target="_blank" rel="noreferrer" class="source-link">정보 ↗</a>
      </article>`;
  }).join("");
  elements.spotList.querySelectorAll(".spot-select").forEach((button) => button.addEventListener("click", () => toggleSpot(Number(button.dataset.id))));
}

function renderMarkers() {
  markerLayer.clearLayers();
  SPOTS.forEach((spot) => {
    const selected = state.selectedIds.includes(spot.id);
    const recommendedIndex = state.recommendedIds.indexOf(spot.id);
    const hasResult = recommendedIndex >= 0;
    const icon = L.divIcon({
      className: "map-marker-shell",
      html: `<div class="map-marker ${selected ? "selected" : ""} ${hasResult ? "recommended" : ""}"><span>${hasResult ? recommendedIndex + 1 : selected ? "✓" : CATEGORY_EMOJI[spot.category]}</span></div>`,
      iconSize: selected ? [42, 48] : [36, 42],
      iconAnchor: selected ? [21, 46] : [18, 40],
    });
    const marker = L.marker([spot.lat, spot.lng], { icon }).addTo(markerLayer);
    marker.bindTooltip(`
      <div class="spot-tooltip-card">
        <img src="${SPOT_PHOTOS[spot.id]}" alt="${spot.name}" />
        <div><strong>${spot.name}</strong><span>${spot.region} · 약 ${spot.duration}분</span><small>${spot.hours}</small></div>
      </div>`, { direction: "top", offset: [0, -32], className: "spot-tooltip" });
    marker.on("click", (event) => {
      L.DomEvent.stopPropagation(event);
      toggleSpot(spot.id);
    });
  });
}

function renderStart() {
  if (startMarker) startMarker.remove();
  const icon = L.divIcon({
    className: "map-marker-shell",
    html: `<div class="start-marker"><span>🚗</span><b>출발</b></div>`,
    iconSize: [66, 50],
    iconAnchor: [33, 46],
  });
  startMarker = L.marker([state.startPoint.lat, state.startPoint.lng], { icon, zIndexOffset: 1000 }).addTo(map).bindTooltip(state.startPoint.name, { direction: "top", offset: [0, -34] });
  elements.startName.textContent = state.startPoint.name;
}

// ---------------------------------------------------------------------------
// 지도 위 경로선을 실제 도로 모양으로 그리기
// 지금까지는 지점들을 직선으로만 이었는데, OSRM의 Route API(여러 지점을 한 번에
// 넣으면 실제 도로를 따라간 경로 좌표를 돌려줌)로 실제 도로 형태의 선을 그립니다.
// 요청이 실패하면(네트워크 문제 등) 직선으로 자연스럽게 유지되고, 이때는
// 안내문구(.route-disclaimer)를 계속 보여줘서 실제 도로와 다를 수 있음을 알립니다.
// ---------------------------------------------------------------------------
let routeRequestToken = 0;

async function fetchRouteGeometry(points) {
  if (points.length < 2) return null;
  const coords = points.map((point) => `${point.lng},${point.lat}`).join(";");
  const url = `https://router.project-osrm.org/route/v1/driving/${coords}?overview=full&geometries=geojson`;
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error("route-geometry-error");
    const payload = await response.json();
    const coordinates = payload?.routes?.[0]?.geometry?.coordinates;
    if (!Array.isArray(coordinates) || !coordinates.length) throw new Error("route-no-geometry");
    return coordinates.map(([lng, lat]) => [lat, lng]); // GeoJSON은 [lng,lat] 순서라 Leaflet용 [lat,lng]로 변환
  } catch (error) {
    return null;
  } finally {
    window.clearTimeout(timer);
  }
}

async function renderRoute() {
  if (routeLine) routeLine.remove();
  routeLine = null;
  const recommended = recommendedSpots();
  if (!recommended.length) return;
  const points = [state.startPoint, ...recommended];
  const straightLine = points.map((point) => [point.lat, point.lng]);
  // 실제 도로 데이터를 받아오기 전까지는 우선 직선으로 그려서 빈 화면이 안 보이게 함
  routeLine = L.polyline(straightLine, { color: "#ff6b5f", weight: 5, opacity: 0.9, dashArray: "2 10", lineCap: "round" }).addTo(map);

  const token = ++routeRequestToken;
  const geometry = await fetchRouteGeometry(points);
  if (token !== routeRequestToken || !routeLine) return; // 그 사이에 선택/경로가 바뀌었으면 무시
  if (geometry) {
    routeLine.setLatLngs(geometry);
  }
  // 실패 시: 직선 그대로 유지 (안내문구는 결과 화면 노란 박스에서 항상 안내함)
}

function renderRouteBar() {
  const selected = selectedSpots();
  elements.count.innerHTML = `${selected.length}<span>/6</span>`;
  elements.count.classList.toggle("ready", selected.length >= 2);
  elements.stack.innerHTML = selected.slice(0, 4).map((spot) => `<span>${CATEGORY_EMOJI[spot.category]}</span>`).join("");
  if (state.recommendedIds.length) {
    const routeNames = recommendedSpots().map((spot, index) => `${index + 1}. ${spot.name}`).join(" → ");
    elements.routeTitle.textContent = "추천 순서가 완성됐어요";
    elements.routeSubtitle.textContent = routeNames;
    elements.previewButton.innerHTML = `일정표 보기 <span>→</span>`;
  } else {
    elements.routeTitle.textContent = selected.length >= 2 ? `${selected.length}곳을 선택했어요` : "장소를 2곳 이상 선택해주세요";
    elements.routeSubtitle.textContent = selected.length >= 2 ? "선택 순서와 관계없이 이동하기 편한 순서를 만들어드려요" : "선택 중에는 방문 순서와 경로가 표시되지 않아요";
    elements.previewButton.innerHTML = state.isBuilding
      ? `<span class="btn-spinner" aria-hidden="true"></span>일정 만드는 중…`
      : `추천 일정 만들기 <span>→</span>`;
  }
  elements.previewButton.disabled = selected.length < 2 || state.isBuilding;
  elements.previewButton.setAttribute("aria-busy", String(state.isBuilding));
  elements.routeBar.classList.toggle("ready", selected.length >= 2);
  elements.routeBar.classList.toggle("has-result", Boolean(state.recommendedIds.length));
  elements.selectionStep.classList.toggle("active", !state.recommendedIds.length);
  elements.resultStep.classList.toggle("active", Boolean(state.recommendedIds.length));
}

function renderAllSelections() {
  renderSpots();
  renderMarkers();
  renderRoute();
  renderRouteBar();
}

function distanceKm(a, b) {
  const toRad = (value) => value * Math.PI / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function minutesToTime(total) {
  const normalized = ((total % 1440) + 1440) % 1440;
  return `${String(Math.floor(normalized / 60)).padStart(2, "0")}:${String(normalized % 60).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// 이동시간 행렬
// 1순위: OSRM 공개 데모 서버의 Table API로 실제 도로 기반 이동시간을 한 번에 조회.
//        (API 키 불필요, README의 "API 키 없이 작동" 원칙 유지)
// 2순위: 요청 실패/타임아웃/CORS 차단 시 직선거리 * 도로보정계수 기반 추정치로 대체.
// 추후 서버(프록시)를 둘 수 있게 되면 네이버 Directions API로 교체 가능하도록
// getTravelMatrix()의 반환 형태({durations, source})만 맞추면 됩니다.
// ---------------------------------------------------------------------------
const ROAD_FACTOR = 1.28;
const AVERAGE_SPEED_KMH = 42;
const ROUTING_TIMEOUT_MS = 6000;

function estimateTravelMatrix(points) {
  const n = points.length;
  const durations = Array.from({ length: n }, () => new Array(n).fill(0));
  const distances = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j < n; j += 1) {
      if (i === j) continue;
      const roadKm = distanceKm(points[i], points[j]) * ROAD_FACTOR;
      durations[i][j] = (roadKm / AVERAGE_SPEED_KMH) * 3600;
      distances[i][j] = roadKm * 1000;
    }
  }
  return { durations, distances, source: "estimate" };
}

async function fetchRoutedMatrix(points) {
  const coords = points.map((point) => `${point.lng},${point.lat}`).join(";");
  const url = `https://router.project-osrm.org/table/v1/driving/${coords}?annotations=duration,distance`;
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), ROUTING_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error("routing-http-error");
    const payload = await response.json();
    if (!Array.isArray(payload.durations)) throw new Error("routing-no-data");
    return { durations: payload.durations, distances: payload.distances || null, source: "osrm" };
  } catch (error) {
    return null;
  } finally {
    window.clearTimeout(timer);
  }
}

async function fetchNaverMatrix(points) {
  const query = points.map((point) => `${point.lng},${point.lat}`).join("|");
  const controller = new AbortController();
  // 지점 쌍마다 순차/청크 단위로 네이버를 호출하는 구조라 OSRM보다 시간이 걸려서 넉넉하게 잡음
  const timer = window.setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(`/api/directions?points=${encodeURIComponent(query)}`, { signal: controller.signal });
    if (!response.ok) throw new Error("naver-proxy-error");
    const payload = await response.json();
    if (!Array.isArray(payload.durations)) throw new Error("naver-no-data");
    return { durations: payload.durations, distances: payload.distances, source: "naver" };
  } catch (error) {
    // 서버리스 함수가 없는 환경(로컬 index.html 더블클릭, 프록시 미배포 등)이거나
    // 키 미설정, 네트워크 문제일 때 여기로 빠져서 다음 단계(OSRM)로 자연스럽게 넘어감
    return null;
  } finally {
    window.clearTimeout(timer);
  }
}

async function getTravelMatrix(points) {
  const naver = await fetchNaverMatrix(points);
  if (naver) return naver;
  const routed = await fetchRoutedMatrix(points);
  return routed || estimateTravelMatrix(points);
}

// ---------------------------------------------------------------------------
// 방문 순서 탐색
// 선택 장소가 최대 6곳이라 전체 순열(최대 720가지)을 모두 계산해도 가벼워서
// 별도의 휴리스틱 없이 완전탐색으로 최적해를 구합니다.
// 우선순위: ① 운영시간·기간·여행 종료시간 충돌이 없는 경로 ② 총 이동시간이 짧은 경로
// ---------------------------------------------------------------------------
function permutations(list) {
  if (list.length <= 1) return [list];
  const result = [];
  list.forEach((item, index) => {
    const rest = [...list.slice(0, index), ...list.slice(index + 1)];
    permutations(rest).forEach((rest2) => result.push([item, ...rest2]));
  });
  return result;
}

// ---------------------------------------------------------------------------
// 식사 시간 버퍼
// 구체적인 맛집 추천은 하지 않되(사용자가 직접 찾는 게 낫다는 판단), 점심/저녁
// 시간대를 그냥 관통해서 다음 관광지로 넘어가는 비현실적인 일정을 막기 위해
// 해당 시간대에 걸리면 자동으로 식사 버퍼를 한 번씩 끼워넣습니다. 최종 종료
// 시간(finish)과 "종료 희망 시간" 충돌 판정에도 자연스럽게 반영됩니다.
// ---------------------------------------------------------------------------
const LUNCH_WINDOW = { start: 11 * 60 + 30, end: 13 * 60 + 30 };
const DINNER_WINDOW = { start: 17 * 60 + 30, end: 19 * 60 + 30 };
const MEAL_BUFFER_MINUTES = 60;

function applyMealBuffer(cursor, mealsTaken) {
  if (!mealsTaken.lunch && cursor >= LUNCH_WINDOW.start && cursor < LUNCH_WINDOW.end) {
    mealsTaken.lunch = true;
    return { cursor: cursor + MEAL_BUFFER_MINUTES, meal: "lunch" };
  }
  if (!mealsTaken.dinner && cursor >= DINNER_WINDOW.start && cursor < DINNER_WINDOW.end) {
    mealsTaken.dinner = true;
    return { cursor: cursor + MEAL_BUFFER_MINUTES, meal: "dinner" };
  }
  return { cursor, meal: null };
}

function evaluateOrder(order, indexOf, matrix, startMinutes, date) {
  const mealsTaken = { lunch: false, dinner: false };
  let previousIndex = 0;
  let totalTravel = 0;
  let totalDistanceKm = 0;
  let conflicts = 0;

  const initialMeal = applyMealBuffer(startMinutes, mealsTaken);
  let cursor = initialMeal.cursor;
  let pendingMeal = initialMeal.meal;

  const steps = order.map((spot) => {
    const spotIndex = indexOf.get(spot.id);
    const travelSeconds = matrix.durations[previousIndex][spotIndex];
    const travel = Math.max(5, Math.round(travelSeconds / 60 / 5) * 5);
    const legDistanceKm = matrix.distances ? matrix.distances[previousIndex][spotIndex] / 1000 : null;
    if (legDistanceKm !== null) totalDistanceKm += legDistanceKm;
    cursor += travel;
    totalTravel += travel;
    const arrival = cursor;
    const hoursWindow = spot.hoursWindow;
    let visitStart = arrival;
    let wait = 0;
    let conflict = false;
    let conflictReason = null;
    if (hoursWindow) {
      if (arrival >= hoursWindow.close) {
        conflict = true; // 영업 종료 이후 도착
        conflictReason = "hours";
      } else if (arrival < hoursWindow.open) {
        wait = hoursWindow.open - arrival;
        visitStart = hoursWindow.open; // 영업 시작 전 도착 -> 대기
      }
    }
    const visitEnd = visitStart + spot.duration;
    if (hoursWindow && visitEnd > hoursWindow.close) {
      conflict = true; // 체류 중 영업 종료
      conflictReason = "hours";
    }
    if (isOutOfSeason(spot, date)) {
      conflict = true; // 계절제 운영 기간 아님
      conflictReason = conflictReason || "season";
    }
    if (conflict) conflicts += 1;
    const mealNote = pendingMeal;
    const nextMeal = applyMealBuffer(visitEnd, mealsTaken);
    cursor = nextMeal.cursor;
    pendingMeal = nextMeal.meal;
    previousIndex = spotIndex;
    return { spot, travel, legDistanceKm, wait, arrival, visitStart, visitEnd, conflict, conflictReason, mealNote };
  });
  return { steps, totalTravel, totalDistanceKm, finish: cursor, conflicts };
}

async function buildRecommendedSchedule() {
  const spots = selectedSpots();
  const [hour, minute] = elements.time.value.split(":").map(Number);
  const [endHour, endMinute] = elements.endTime.value.split(":").map(Number);
  const startMinutes = hour * 60 + minute;
  const endMinutes = endHour * 60 + endMinute;
  const date = selectedDate();
  const points = [state.startPoint, ...spots];
  const indexOf = new Map(spots.map((spot, i) => [spot.id, i + 1]));
  const matrix = await getTravelMatrix(points);

  const evaluated = permutations(spots).map((order) => {
    const result = evaluateOrder(order, indexOf, matrix, startMinutes, date);
    const overEnd = result.finish > endMinutes;
    const score = (result.conflicts + (overEnd ? 1 : 0)) * 100000 + result.totalTravel;
    return { order, ...result, overEnd, score, source: matrix.source };
  });
  evaluated.sort((a, b) => a.score - b.score);

  // 상위 3개(순열 자체가 서로 달라서 자동으로 중복 없음)를 대안으로 제공
  const alternatives = evaluated.slice(0, 3);
  const primary = alternatives[0];
  alternatives.forEach((alt) => { alt.reason = buildAlternativeReason(alt, primary, endMinutes); });
  return { primary, alternatives };
}

// ---------------------------------------------------------------------------
// 대안 추천 이유
// 단순히 "이동 몇 분"만 보여주면 사용자가 뭘 기준으로 골라야 할지 알기 어려워서,
// 1순위 경로와 비교했을 때 이 대안에서 어떤 장소를 더 여유롭게 즐길 수 있는지
// 찾아서 한 줄로 설명해줍니다. "여유 시간" = 그 장소의 영업 종료 시각(또는
// 영업시간 제약이 없으면 여행 종료 희망 시각)까지 얼마나 남았는지로 계산해요.
// ---------------------------------------------------------------------------
function computeSlackBySpot(result, endMinutes) {
  const slack = new Map();
  result.steps.forEach((step) => {
    const limit = step.spot.hoursWindow ? step.spot.hoursWindow.close : endMinutes;
    slack.set(step.spot.id, limit - step.visitEnd);
  });
  return slack;
}

function minutesToDurationText(minutes) {
  const rounded = Math.round(minutes);
  if (rounded < 60) return `${rounded}분`;
  const hours = Math.floor(rounded / 60);
  const mins = rounded % 60;
  return mins > 0 ? `${hours}시간 ${mins}분` : `${hours}시간`;
}

function buildAlternativeReason(alt, primary, endMinutes) {
  if (alt === primary) return null;
  const altSlack = computeSlackBySpot(alt, endMinutes);
  const baseSlack = computeSlackBySpot(primary, endMinutes);
  let bestSpot = null;
  let bestDelta = 0;
  altSlack.forEach((slack, spotId) => {
    const delta = slack - (baseSlack.get(spotId) ?? slack);
    if (delta > bestDelta) {
      bestDelta = delta;
      bestSpot = alt.steps.find((step) => step.spot.id === spotId).spot;
    }
  });
  if (bestSpot && bestDelta >= 10) {
    return `${bestSpot.name}에서 더 여유롭게 머물 수 있는 순서예요 (약 ${minutesToDurationText(bestDelta)} 더 여유)`;
  }
  if (alt.totalTravel < primary.totalTravel) {
    return "이동 시간이 조금 더 짧은 대신 방문 순서가 달라요";
  }
  return "다른 방문 순서로 둘러보는 경로예요";
}

function showSchedule() {
  const result = state.scheduleResult;
  if (!result) return;
  elements.scheduleTitle.textContent = `${weekdayText()}, 제주에서의 하루`;

  const distanceText = result.totalDistanceKm !== undefined && result.totalDistanceKm !== null
    ? `약 ${result.totalDistanceKm.toFixed(1)}km`
    : "-";
  elements.summaryCards.innerHTML = `
    <div><span>출발</span><strong>${elements.time.value}</strong></div>
    <div><span>도착 예상</span><strong>${minutesToTime(result.finish)}</strong></div>
    <div><span>이동 시간 · 거리</span><strong>약 ${result.totalTravel}분 · ${distanceText}</strong></div>`;

  const introEl = document.querySelector(".schedule-intro");
  if (introEl) {
    // 소스(네이버/OSRM)에 따라 이동시간·거리 문구가 계속 바뀌면 발표·시연 중에는
    // 오히려 "왜 문구가 다르지?"하고 오류처럼 보일 수 있어서, 실제 도로 데이터를
    // 쓴 두 경우는 같은 문구로 통일했습니다. 지도 위 경로선에 대한 안내도 여기에
    // 항상 같이 보여줘서(도로선 구현이 100% 정확하다고 보장은 못 하니) 따로 뜨고
    // 사라지는 배너보다 안정적으로 안내되게 했어요.
    const dataNote = result.source === "estimate"
      ? "길찾기 서버 응답이 없어 직선거리를 보정한 추정치로 계산했어요."
      : "실제 도로 경로를 기반으로 계산한 예상 이동시간·거리예요. 교통 상황에 따라 다소 차이가 있을 수 있어요.";
    const routeNote = " 지도 위 선은 도로 경로를 반영해 방문 순서를 나타내는 안내선이며, 실제 도로 모양과는 다소 차이가 있을 수 있어요.";
    const conflictNote = result.conflicts > 0
      ? " 일부 장소는 선택한 시간·기간과 겹쳐요. 아래에서 확인해주세요."
      : "";
    introEl.textContent = dataNote + routeNote + conflictNote;
  }

  if (elements.overtimeBanner) {
    if (result.overEnd) {
      elements.overtimeBanner.textContent = `앗, 예상 종료 시간(${minutesToTime(result.finish)})이 희망하신 종료 시간(${elements.endTime.value})을 넘어요. 장소를 줄이거나 출발을 당겨보세요.`;
      elements.overtimeBanner.classList.remove("hidden");
    } else {
      elements.overtimeBanner.classList.add("hidden");
    }
  }

  elements.timeline.innerHTML = `
    <div class="timeline-start"><span>🚗</span><div><strong>${elements.time.value}</strong><p>${state.startPoint.name}</p></div></div>
    ${result.steps.map((item, index) => {
      const waitNote = item.wait > 0 ? ` · 개장까지 ${item.wait}분 대기` : "";
      const distanceNote = item.legDistanceKm !== null && item.legDistanceKm !== undefined ? ` · ${item.legDistanceKm.toFixed(1)}km` : "";
      const mealNote = item.mealNote === "lunch" ? " · 점심 식사 60분 포함" : item.mealNote === "dinner" ? " · 저녁 식사 60분 포함" : "";
      const badgeText = item.conflictReason === "season" ? "이용 기간 확인 필요" : "운영시간 확인 필요";
      const conflictBadge = item.conflict
        ? `<span style="display:inline-block;margin-left:6px;background:#ffe1dd;color:#a34137;border-radius:6px;padding:2px 6px;font-size:9px;font-weight:900;">${badgeText}</span>`
        : "";
      return `
      <div class="timeline-item">
        <div class="travel-note">차량 이동 약 ${item.travel}분${distanceNote}${mealNote}</div>
        <span class="timeline-number">${index + 1}</span>
        <div class="timeline-card">
          <div><span class="schedule-emoji">${CATEGORY_EMOJI[item.spot.category]}</span><strong>${item.spot.name}</strong>${conflictBadge}</div>
          <p>${minutesToTime(item.visitStart)} 도착 · ${minutesToTime(item.visitEnd)} 출발${waitNote}</p>
          <small>머무는 시간 약 ${item.spot.duration}분 · ${item.spot.hours}</small>
        </div>
      </div>`;
    }).join("")}`;

  renderAlternatives();
  elements.backdrop.classList.remove("hidden");
}

function renderAlternatives() {
  if (!elements.altSchedules || !elements.altList) return;
  const alts = state.scheduleAlternatives || [];
  if (alts.length < 2) {
    elements.altSchedules.classList.add("hidden");
    elements.altList.innerHTML = "";
    return;
  }
  elements.altList.innerHTML = alts.map((alt, index) => {
    const isActive = index === state.activeAlternativeIndex;
    const routeNames = alt.order.map((spot) => spot.name).join(" → ");
    const warn = alt.conflicts > 0 || alt.overEnd ? `<em>충돌 ${alt.conflicts + (alt.overEnd ? 1 : 0)}건</em>` : "";
    const reasonLine = alt.reason ? `<span class="alt-reason">${alt.reason}</span>` : "";
    const distanceText = alt.totalDistanceKm !== undefined && alt.totalDistanceKm !== null
      ? `${alt.totalDistanceKm.toFixed(1)}km`
      : "-";
    return `
      <button type="button" class="alt-card ${isActive ? "active" : ""}" data-index="${index}">
        <div class="alt-card-top">
          <strong>${index === 0 ? "추천 1순위" : `대안 ${index}`} · ${routeNames}</strong>
          ${warn}
        </div>
        <div class="alt-card-stats">
          <div><span>이동시간</span><strong>${alt.totalTravel}분</strong></div>
          <div><span>이동거리</span><strong>${distanceText}</strong></div>
          <div><span>종료시간</span><strong>${minutesToTime(alt.finish)}</strong></div>
        </div>
        ${reasonLine}
      </button>`;
  }).join("");
  elements.altSchedules.classList.remove("hidden");
  elements.altList.querySelectorAll(".alt-card").forEach((button) => button.addEventListener("click", () => selectAlternative(Number(button.dataset.index))));
}

function selectAlternative(index) {
  const alt = (state.scheduleAlternatives || [])[index];
  if (!alt) return;
  state.scheduleResult = alt;
  state.activeAlternativeIndex = index;
  state.recommendedIds = alt.order.map((spot) => spot.id);
  trackEvent("schedule_alternative_selected", { alternativeIndex: index });
  renderMarkers();
  renderRoute();
  renderRouteBar();
  showSchedule();
}

async function createOrOpenSchedule() {
  if (state.selectedIds.length < 2 || state.isBuilding) return;
  if (state.recommendedIds.length) {
    showSchedule();
    return;
  }
  const closedSpot = selectedSpots().find((spot) => isClosedOn(spot, selectedDate()));
  if (closedSpot) {
    showToast(`${closedSpot.name}은 선택한 날짜에 휴무예요. 목록에서 제외해주세요.`);
    return;
  }
  const [startHour, startMinute] = elements.time.value.split(":").map(Number);
  const [endHour, endMinute] = elements.endTime.value.split(":").map(Number);
  if (endHour * 60 + endMinute <= startHour * 60 + startMinute) {
    showToast("종료 희망 시간은 출발 시간보다 늦어야 해요.");
    return;
  }
  state.isBuilding = true;
  renderRouteBar();
  const buildStartedAt = performance.now();
  trackEvent("schedule_build_start", { spotCount: state.selectedIds.length });
  try {
    const { primary, alternatives } = await buildRecommendedSchedule();
    state.recommendedIds = primary.order.map((spot) => spot.id);
    state.scheduleResult = primary;
    state.scheduleAlternatives = alternatives;
    state.activeAlternativeIndex = 0;
    state.isBuilding = false;
    trackEvent("schedule_build_complete", {
      durationMs: Math.round(performance.now() - buildStartedAt),
      conflicts: primary.conflicts,
      overEnd: primary.overEnd,
      routingSource: primary.source,
    });
    renderMarkers();
    renderRoute();
    renderRouteBar();
    showSchedule();
  } catch (error) {
    state.isBuilding = false;
    renderRouteBar();
    showToast("일정을 계산하는 중 문제가 생겼어요. 다시 시도해주세요.");
  }
}

function renderConfirmedPanel() {
  const result = state.confirmedSchedule;
  if (!elements.confirmedPanel) return;
  if (!result) {
    elements.confirmedPanel.classList.add("hidden");
    return;
  }
  elements.confirmedPanelTitle.textContent = `${weekdayText()}, 제주에서의 하루`;
  elements.confirmedPanelBody.innerHTML = `
    <div class="row"><span>출발 · 도착</span><span>${elements.time.value} → ${minutesToTime(result.finish)}</span></div>
    <div class="row"><span>이동</span><span>약 ${result.totalTravel}분</span></div>
    ${result.steps.map((item, index) => `
      <div class="stop">
        <b>${index + 1}.</b>
        <div><b>${item.spot.name}</b><br /><small>${minutesToTime(item.visitStart)} ~ ${minutesToTime(item.visitEnd)}</small></div>
      </div>`).join("")}`;
  elements.confirmedPanel.classList.remove("hidden");
}

function closeSchedule() {
  elements.backdrop.classList.add("hidden");
}

function confirmSchedule() {
  if (!state.scheduleResult) return;
  // 지금 확정하려는 일정이 "이미 확정해둔 바로 그 일정"과 같은 경우(빠른 연타,
  // 확정 후 재확인 화면에서 재클릭 등)에만 중복 방지로 조용히 무시합니다. 선택을
  // 바꿔서 다른 조합으로 새로 확정하려는 경우(scheduleResult가 새로 계산된 다른
  // 객체)는 정상적으로 진행되어야 하므로, 단순히 "확정한 적 있는지"가 아니라
  // "이번 결과가 이미 확정된 그 결과와 같은 객체인지"로 판단합니다.
  if (state.isConfirmed && state.confirmedSchedule === state.scheduleResult) {
    closeSchedule();
    return;
  }
  if (state.flowStartedAt) {
    trackEvent("schedule_confirmed", {
      totalTimeMs: Math.round(performance.now() - state.flowStartedAt),
      conflicts: state.scheduleResult.conflicts,
      overEnd: Boolean(state.scheduleResult.overEnd),
      usedPrimaryRecommendation: state.activeAlternativeIndex === 0,
    });
  }
  // 여행지별로 몇 번 담겼는지(인기 순위) KPI를 위해, 확정된 일정에 포함된 장소마다
  // 하나씩 별도 이벤트로 전송합니다. GA4는 하나의 이벤트 안에 배열 값을 담아
  // 집계하기 어려워서, 장소 수만큼 이벤트를 나눠 보내는 방식을 씁니다.
  state.scheduleResult.steps.forEach((step) => {
    trackEvent("spot_included", { spotName: step.spot.name, spotRegion: step.spot.region });
  });
  state.isConfirmed = true;
  state.confirmedSchedule = state.scheduleResult;
  showToast("이 일정으로 확정됐어요! 오른쪽 패널에서 언제든 다시 볼 수 있어요.");
  closeSchedule();
  renderConfirmedPanel();
}

function returnToSelection() {
  if (state.flowStartedAt && !state.isConfirmed) {
    trackEvent("schedule_dismissed", { conflicts: state.scheduleResult?.conflicts ?? null });
  }
  closeSchedule();
  clearRecommendation();
  renderMarkers();
  renderRoute();
  renderRouteBar();
}

function reopenConfirmedSchedule() {
  const result = state.confirmedSchedule;
  if (!result) return;
  state.scheduleResult = result;
  state.scheduleAlternatives = [result];
  state.activeAlternativeIndex = 0;
  state.recommendedIds = (result.order || result.steps.map((step) => step.spot)).map((spot) => spot.id);
  renderMarkers();
  renderRoute();
  renderRouteBar();
  showSchedule();
}

map.on("click", (event) => {
  state.startPoint = { name: "지도에서 선택한 출발지", lat: event.latlng.lat, lng: event.latlng.lng };
  clearRecommendation();
  renderStart();
  renderRoute();
  renderRouteBar();
  saveState();
});

elements.date.addEventListener("change", updateDate);
elements.time.addEventListener("change", () => { clearRecommendation(); renderAllSelections(); saveState(); });
elements.endTime.addEventListener("change", () => { clearRecommendation(); renderAllSelections(); saveState(); });
elements.search.addEventListener("input", () => {
  state.query = elements.search.value;
  elements.clearSearch.classList.toggle("visible", Boolean(state.query));
  renderSpots();
});
elements.clearSearch.addEventListener("click", () => {
  state.query = "";
  elements.search.value = "";
  elements.clearSearch.classList.remove("visible");
  renderSpots();
});
document.querySelector("#airport-button").addEventListener("click", () => {
  state.startPoint = { ...AIRPORT };
  clearRecommendation();
  renderStart();
  renderRoute();
  renderRouteBar();
  map.panTo([AIRPORT.lat, AIRPORT.lng]);
  saveState();
});
elements.previewButton.addEventListener("click", createOrOpenSchedule);
document.querySelector("#close-schedule").addEventListener("click", closeSchedule);
document.querySelector("#schedule-confirm").addEventListener("click", confirmSchedule);
document.querySelector("#schedule-done").addEventListener("click", returnToSelection);
document.querySelector("#confirmed-panel-close").addEventListener("click", () => {
  state.confirmedSchedule = null;
  renderConfirmedPanel();
});
document.querySelector("#confirmed-panel-detail").addEventListener("click", reopenConfirmedSchedule);
elements.backdrop.addEventListener("click", (event) => { if (event.target === elements.backdrop) closeSchedule(); });
document.addEventListener("keydown", (event) => { if (event.key === "Escape") closeSchedule(); });

loadState();
renderChips();
updateDate();
renderStart();
renderRoute();
renderRouteBar();
