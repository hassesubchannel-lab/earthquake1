// 地震シミュレーター
// 震源・断層・M から P/S 波の広がり、地域ごとの震度、緊急地震速報の流れを計算して表示する。
// 震度は簡易式による推定であり、実際の地震とは一致しない。
'use strict';

// ---------- 定数 ----------
const CLASS_KEYS = ['0', '1', '2', '3', '4', '5m', '5p', '6m', '6p', '7'];
const CLASS_LABELS = ['0', '1', '2', '3', '4', '5弱', '5強', '6弱', '6強', '7'];
const CLASS_COLORS = ['#ffffff', '#55b2ff', '#7bd35a', '#ffd04f', '#ff7a2e', '#b5122c', '#b5122c', '#ffa9b8', '#ffa9b8', '#8a0a1e'];
const RUPTURE_SPEED = 2.8;   // 断層の破壊が進む速さ km/s
const SOURCE_STEP = 5;       // 断層をこの間隔(km)の点に分けて計算する
const EEW_DELAY = 2;         // 最初の観測点で P 波を検知してから第1報までの秒数
const PLUM_RADIUS = 30;      // PLUM 法で予想に使う観測点からの距離 km

// 海底観測網の仮想観測点（おおよその位置）
const SEAFLOOR = {
  donet: [[33.95, 136.95], [33.75, 136.65], [33.55, 136.35], [33.30, 136.00], [33.10, 135.60], [33.00, 135.15], [32.90, 134.70], [32.85, 134.30]],
  snet: [[41.20, 142.60], [40.40, 143.10], [39.60, 143.20], [38.80, 142.90], [38.00, 142.50], [37.20, 141.80], [36.40, 141.30], [35.60, 140.90]],
};

const PRESETS = [
  { name: '南海トラフ巨大地震（想定）', lat: 33.30, lon: 135.90, depth: 20, mag: 9.1, type: '-0.02',
    faultA: [[33.80, 136.90], [34.20, 137.70], [34.70, 138.50]],
    faultB: [[33.00, 135.00], [32.70, 134.00], [32.40, 133.00], [31.90, 132.20], [31.50, 131.80]] },
  { name: '東北地方太平洋沖地震（2011）', lat: 38.10, lon: 142.86, depth: 24, mag: 9.0, type: '-0.02',
    faultA: [[38.90, 143.00], [39.70, 142.90]], faultB: [[37.20, 141.90], [36.30, 141.30]] },
  { name: '兵庫県南部地震（1995）', lat: 34.60, lon: 135.04, depth: 16, mag: 7.3, type: '0',
    faultA: [[34.75, 135.30]], faultB: [[34.48, 134.88]] },
  { name: '熊本地震 本震（2016）', lat: 32.75, lon: 130.76, depth: 12, mag: 7.3, type: '0',
    faultA: [[32.92, 131.08]], faultB: [[32.68, 130.68]] },
  { name: '北海道胆振東部地震（2018）', lat: 42.69, lon: 142.01, depth: 37, mag: 6.7, type: '0.12',
    faultA: [], faultB: [] },
  { name: '能登半島地震（2024）', lat: 37.50, lon: 137.27, depth: 16, mag: 7.6, type: '0',
    faultA: [[37.58, 137.55]], faultB: [[37.30, 136.95], [37.15, 136.70]] },
  { name: '首都直下地震（想定）', lat: 35.65, lon: 139.75, depth: 45, mag: 7.3, type: '0.12',
    faultA: [], faultB: [] },
];

const CITIES = [
  ['大阪', 34.69, 135.50], ['東京', 35.68, 139.76], ['名古屋', 35.17, 136.91], ['仙台', 38.27, 140.87],
  ['福岡', 33.59, 130.40], ['札幌', 43.06, 141.35], ['高知', 33.56, 133.53], ['静岡', 34.98, 138.38],
  ['金沢', 36.56, 136.66], ['震源付近', null, null],
];

// ---------- 状態 ----------
const state = {
  hypo: null,           // {lat, lon}
  faultA: [], faultB: [],
  mode: null,           // 'hypo' | 'faultA' | 'faultB' | null
  t: 0, playing: false, speed: 1,
  model: null,          // prepare() の結果
  originDate: null,
  shownClass: [],       // 地域ごとに表示中の震度階級
  shownMax: -1,
  shownReport: -1,
};

const $ = (id) => document.getElementById(id);

// ---------- 計算 ----------
function makeProj(lat0, lon0) {
  const kx = 111.32 * Math.cos(lat0 * Math.PI / 180), ky = 110.57;
  return {
    xy: (lat, lon) => [(lon - lon0) * kx, (lat - lat0) * ky],
    ll: (x, y) => [lat0 + y / ky, lon0 + x / kx],
  };
}

// 断層の長さの目安 (宇津 1977)
const faultLength = (m) => Math.pow(10, 0.5 * m - 1.85);

// 司・翠川(1999)の最大速度の距離減衰式 + 藤本・翠川(2005)の震度換算
function intensity(X, mag, depth, typeD, amp) {
  const mw = Math.min(mag, 8.3);
  const D = Math.min(Math.max(depth, 0), 200);
  const logV = 0.58 * mw + 0.0038 * D + typeD - 1.29
    - Math.log10(X + 0.0028 * Math.pow(10, 0.5 * mw)) - 0.002 * X;
  const lv = Math.log10(Math.pow(10, logV) * amp);
  return 2.002 + 2.603 * lv - 0.213 * lv * lv;
}

function toClass(I) {
  if (I < 0.5) return 0;
  if (I < 1.5) return 1;
  if (I < 2.5) return 2;
  if (I < 3.5) return 3;
  if (I < 4.5) return 4;
  if (I < 5.0) return 5;
  if (I < 5.5) return 6;
  if (I < 6.0) return 7;
  if (I < 6.5) return 8;
  return 9;
}

// 地域ごとの地盤の揺れやすさ（区域コードから決まる疑似的な値 1.2〜1.9）
function siteAmp(code) {
  let h = 2166136261;
  for (const c of String(code)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
  return 1.2 + 0.7 * ((h >>> 0) % 1000) / 1000;
}

// 震源から断層の端へ向かって、破壊が届く時刻つきの点列を作る
function buildSources(proj, hypo, sides) {
  const out = [{ x: 0, y: 0, t: 0 }];
  for (const side of sides) {
    let prev = [0, 0], tAcc = 0;
    for (const p of side) {
      const cur = proj.xy(p[0], p[1]);
      const len = Math.hypot(cur[0] - prev[0], cur[1] - prev[1]);
      const n = Math.max(1, Math.round(len / SOURCE_STEP));
      for (let i = 1; i <= n; i++) {
        const f = i / n;
        out.push({ x: prev[0] + (cur[0] - prev[0]) * f, y: prev[1] + (cur[1] - prev[1]) * f, t: tAcc + len * f / RUPTURE_SPEED });
      }
      tAcc += len / RUPTURE_SPEED;
      prev = cur;
    }
  }
  return out;
}

function arrival(sources, x, y, h, v) {
  let best = Infinity;
  for (const s of sources) {
    const d = Math.sqrt((x - s.x) ** 2 + (y - s.y) ** 2 + h * h);
    const tt = s.t + d / v;
    if (tt < best) best = tt;
  }
  return best;
}

// 断層からの距離。断層の幅を考えて、震源域の広がりの分だけ近く扱う。
function faultDistance(sources, x, y, h, halfWidth) {
  let dmin = Infinity;
  for (const s of sources) {
    const d = Math.hypot(x - s.x, y - s.y);
    if (d < dmin) dmin = d;
  }
  const dd = Math.max(dmin - halfWidth, 0);
  return Math.sqrt(dd * dd + h * h);
}

// ---------- 地域データの前処理 ----------
const AREAS = (window.JMA_AREAS ? window.JMA_AREAS.features : []).map((f) => {
  const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
  let best = null, bestA = -1;
  for (const poly of polys) {
    const ring = poly[0];
    let a = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += (ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1]);
    if (Math.abs(a) > bestA) { bestA = Math.abs(a); best = ring; }
  }
  // 重心
  let cx = 0, cy = 0, A = 0;
  for (let i = 0, j = best.length - 1; i < best.length; j = i++) {
    const cr = best[j][0] * best[i][1] - best[i][0] * best[j][1];
    A += cr; cx += (best[j][0] + best[i][0]) * cr; cy += (best[j][1] + best[i][1]) * cr;
  }
  let center = A !== 0 ? [cy / (3 * A), cx / (3 * A)] : [best[0][1], best[0][0]];
  if (!pointInRing(center, best)) center = [best[Math.floor(best.length / 2)][1], best[Math.floor(best.length / 2)][0]];
  // 揺れを計算する代表点：重心と、外周から内側へ寄せた8点
  const pts = [center];
  const step = Math.max(1, Math.floor(best.length / 8));
  for (let i = 0; i < best.length && pts.length < 9; i += step) {
    pts.push([best[i][1] * 0.6 + center[0] * 0.4, best[i][0] * 0.6 + center[1] * 0.4]);
  }
  return { name: f.properties.name, code: f.properties.code, feature: f, center, pts, amp: siteAmp(f.properties.code) };
});

function pointInRing(latlon, ring) {
  const x = latlon[1], y = latlon[0];
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// ---------- モデルの準備（再生前にすべて計算しておく） ----------
function readInputs() {
  return {
    lat: parseFloat($('lat').value), lon: parseFloat($('lon').value),
    depth: Math.max(0, parseFloat($('depth').value) || 0),
    mag: parseFloat($('mag').value) || 5,
    typeD: parseFloat($('qtype').value) || 0,
    vp: parseFloat($('vp').value) || 7.1, vs: parseFloat($('vs').value) || 4.0,
    donet: $('useDonet').checked, snet: $('useSnet').checked, plum: $('usePlum').checked,
  };
}

function prepare() {
  const p = readInputs();
  state.hypo = { lat: p.lat, lon: p.lon };
  const proj = makeProj(p.lat, p.lon);
  const sources = buildSources(proj, state.hypo, [state.faultA, state.faultB]);
  const hasFault = sources.length > 1;
  const L = faultLength(p.mag);
  const halfWidth = hasFault ? Math.min(L / 4, 60) : Math.min(L / 2, 150);
  const h = Math.max(p.depth, 3);

  const areas = AREAS.map((a) => {
    const pts = a.pts.map(([lat, lon]) => {
      const [x, y] = proj.xy(lat, lon);
      const X = faultDistance(sources, x, y, h, halfWidth);
      return {
        x, y,
        tP: arrival(sources, x, y, h, p.vp),
        tS: arrival(sources, x, y, h, p.vs),
        cls: toClass(intensity(X, p.mag, p.depth, p.typeD, a.amp)),
      };
    });
    pts.sort((u, v) => u.tS - v.tS);
    return { pts, cx: pts.length ? proj.xy(a.center[0], a.center[1]) : [0, 0] };
  });
  // 地域の代表点（重心）の P 波到達
  areas.forEach((m, i) => {
    const [x, y] = m.cx;
    m.tPc = arrival(sources, x, y, h, p.vp);
  });

  const model = { p, proj, sources, h, halfWidth, areas, maxRupture: Math.max(...sources.map((s) => s.t)) };
  model.eew = buildEEW(model);
  model.tEnd = Math.max(...areas.map((m) => m.pts.length ? m.pts[m.pts.length - 1].tS : 0).filter(isFinite), model.maxRupture) + 15;
  state.model = model;
  return model;
}

function classAt(m, t) {
  let c = 0;
  for (const pt of m.pts) { if (pt.tS > t) break; if (pt.cls > c) c = pt.cls; }
  return c;
}

// 緊急地震速報の各報を時刻順に作る
function buildEEW(model) {
  const { p, proj, areas, h } = model;
  const stations = areas.map((m, i) => ({ kind: 'land', area: i, x: m.cx[0], y: m.cx[1], tP: m.tPc }));
  const sea = [].concat(p.donet ? SEAFLOOR.donet : [], p.snet ? SEAFLOOR.snet : []);
  for (const [lat, lon] of sea) {
    const [x, y] = proj.xy(lat, lon);
    const X = faultDistance(model.sources, x, y, h, model.halfWidth);
    stations.push({
      kind: 'sea', x, y,
      tP: arrival(model.sources, x, y, h, p.vp),
      tS: arrival(model.sources, x, y, h, p.vs),
      cls: toClass(intensity(X, p.mag, p.depth, p.typeD, 1.5)),
    });
  }
  // 各地域から PLUM_RADIUS 以内の観測点
  const near = areas.map((m) => stations.map((s, si) => {
    const d = Math.min(...m.pts.map((pt) => Math.hypot(pt.x - s.x, pt.y - s.y)));
    return d <= PLUM_RADIUS ? si : -1;
  }).filter((si) => si >= 0));

  const tFirst = Math.min(...stations.map((s) => s.tP)) + EEW_DELAY;
  const Mcap = Math.min(p.mag, 8.1);
  const reports = [];
  let warned = false, warnSet = new Set(), lastKey = '', lastChange = tFirst;
  const tStop = tFirst + Math.max(90, model.maxRupture + 30);

  for (let tau = tFirst; tau <= tStop; tau += 1) {
    const mest = Math.round(Math.min(Mcap, 4.5 + 0.4 * (tau - tFirst + 1)) * 10) / 10;
    const Lest = faultLength(mest);
    const pred = areas.map((m, i) => {
      // 震源とMの推定だけから出す予想（断層の広がりは分からないので点震源）
      const [x, y] = m.cx;
      const d = Math.hypot(x, y);
      const dd = Math.max(d - Math.min(Lest / 2, 150), 0);
      let c = toClass(intensity(Math.sqrt(dd * dd + h * h), mest, p.depth, p.typeD, AREAS[i].amp));
      if (p.plum) {
        for (const si of near[i]) {
          const s = stations[si];
          const obs = s.kind === 'land' ? classAt(areas[s.area], tau) : (s.tS <= tau ? s.cls : 0);
          if (obs > c) c = obs;
        }
      }
      return c;
    });
    const maxPred = Math.max(...pred);
    if (!reports.length && maxPred < 3 && mest < 3.5 && mest >= Mcap) break;
    if (maxPred >= 5) warned = true;
    if (warned) pred.forEach((c, i) => { if (c >= 4) warnSet.add(i); });
    const key = [mest, maxPred, warned, warnSet.size].join('/');
    if (key !== lastKey) {
      reports.push({ t: tau, no: reports.length + 1, mest, maxPred, warned, warnAreas: [...warnSet], pred, final: false });
      lastKey = key; lastChange = tau;
    } else if (tau - lastChange >= 10 && mest >= Mcap && tau > model.maxRupture + 5) {
      break;
    }
  }
  if (reports.length) {
    const last = reports[reports.length - 1];
    reports.push({ ...last, t: last.t + 5, no: last.no + 1, final: true });
  }
  return reports;
}

// ---------- 地図 ----------
const GSI_STD = 'https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png';
const GSI_ATTR = '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank">国土地理院</a>';

const mainMap = L.map('mainMap', { preferCanvas: true, zoomSnap: 0.25, zoomControl: false }).setView([35.3, 136.5], 6);
L.tileLayer(GSI_STD, { attribution: GSI_ATTR, maxZoom: 18, minZoom: 4 }).addTo(mainMap);
L.control.zoom({ position: 'topright' }).addTo(mainMap);
const zoomMap = L.map('zoomMap', { preferCanvas: true, zoomControl: false, attributionControl: false }).setView([34.69, 135.5], 9);
L.tileLayer(GSI_STD, { maxZoom: 18 }).addTo(zoomMap);
const eewMap = L.map('eewMap', {
  zoomControl: false, attributionControl: false, dragging: false, scrollWheelZoom: false,
  doubleClickZoom: false, boxZoom: false, keyboard: false, touchZoom: false, zoomSnap: 0.1,
}).setView([36, 137], 4.6);

const baseStyle = { color: '#555', weight: 0.5, opacity: 0.5, fillOpacity: 0, fillColor: '#fff' };
function areaLayer(map, style) {
  const layers = [];
  L.geoJSON(window.JMA_AREAS, {
    style: () => ({ ...style }),
    onEachFeature: (f, layer) => layers.push(layer),
  }).addTo(map);
  return layers;
}
const mainAreas = areaLayer(mainMap, baseStyle);
const zoomAreas = areaLayer(zoomMap, baseStyle);
const eewAreas = areaLayer(eewMap, { color: '#fff', weight: 0.6, opacity: 0.8, fillOpacity: 1, fillColor: '#d0d0d0' });

const mainIcons = L.layerGroup().addTo(mainMap);
const zoomIcons = L.layerGroup().addTo(zoomMap);
const markerCache = { main: [], zoom: [] };

function intIcon(cls, size) {
  return L.divIcon({ className: 'int-icon', html: `<img src="img/s-${CLASS_KEYS[cls]}.png" alt="${CLASS_LABELS[cls]}">`, iconSize: [size, size], iconAnchor: [size / 2, size / 2] });
}
const epiIcon = (size) => L.divIcon({ className: 'epi-icon', html: '<img src="img/epicenter.png" alt="震央">', iconSize: [size, size], iconAnchor: [size / 2, size / 2] });

const fronts = {};
for (const [key, map] of [['main', mainMap], ['zoom', zoomMap]]) {
  fronts[key] = {
    p: L.polygon([], { color: '#2a55ff', weight: 2, fill: false, interactive: false }).addTo(map),
    s: L.polygon([], { color: '#e0103a', weight: 2, fillColor: '#ff6f8f', fillOpacity: 0.18, interactive: false }).addTo(map),
    fault: L.polyline([], { color: '#888', weight: 4, opacity: 0.6, dashArray: '6 6', interactive: false }).addTo(map),
    rupture: L.polyline([], { color: '#d00', weight: 6, opacity: 0.85, interactive: false }).addTo(map),
    epi: L.marker([0, 0], { icon: epiIcon(key === 'main' ? 30 : 26), interactive: false, zIndexOffset: 1000 }),
  };
}
const eewEpi = L.marker([0, 0], { icon: epiIcon(30), interactive: false });
const faultPins = L.layerGroup().addTo(mainMap);

// 震源から見た各方位で、最も遠い波面までの距離を求めて多角形にする
function frontPolygon(model, t, v) {
  const radii = model.sources.map((s) => {
    const r = v * (t - s.t);
    return r > model.h ? Math.sqrt(r * r - model.h * model.h) : -1;
  });
  if (radii.every((r) => r < 0)) return [];
  const pts = [];
  for (let k = 0; k < 120; k++) {
    const th = (k / 120) * Math.PI * 2;
    const ux = Math.cos(th), uy = Math.sin(th);
    let best = -1;
    model.sources.forEach((s, i) => {
      const r = radii[i];
      if (r < 0) return;
      const uc = ux * s.x + uy * s.y;
      const disc = r * r - (s.x * s.x + s.y * s.y - uc * uc);
      if (disc < 0) return;
      const d = uc + Math.sqrt(disc);
      if (d > best) best = d;
    });
    if (best > 0) pts.push(model.proj.ll(best * ux, best * uy));
  }
  return pts;
}

// ---------- 描画 ----------
function fmtTime(t) {
  const cs = Math.floor(Math.max(t, 0) * 100);
  const h = Math.floor(cs / 360000), m = Math.floor(cs / 6000) % 60, s = Math.floor(cs / 100) % 60, c = cs % 100;
  return [h, m, s].map((n) => String(n).padStart(2, '0')).join(':') + '.' + String(c).padStart(2, '0');
}

function drawSetup() {
  // 入力から震源・断層の表示だけを更新する（再生していない時）
  const p = readInputs();
  const ll = [p.lat, p.lon];
  for (const key of ['main', 'zoom']) {
    const f = fronts[key];
    f.epi.setLatLng(ll);
    if (!(key === 'main' ? mainMap : zoomMap).hasLayer(f.epi)) f.epi.addTo(key === 'main' ? mainMap : zoomMap);
    const line = [...[...state.faultA].reverse(), ll, ...state.faultB];
    f.fault.setLatLngs(state.faultA.length || state.faultB.length ? line : []);
  }
  faultPins.clearLayers();
  for (const [arr, label] of [[state.faultA, 'A'], [state.faultB, 'B']]) {
    arr.forEach((q, i) => L.circleMarker(q, { radius: 5, color: '#333', weight: 1, fillColor: label === 'A' ? '#ffd84a' : '#7fd3ff', fillOpacity: 1 })
      .bindTooltip(`${label}${i + 1}`).addTo(faultPins));
  }
}

function resetView() {
  state.t = 0;
  state.shownClass = AREAS.map(() => 0);
  state.shownMax = -1;
  state.shownReport = -1;
  for (const layers of [mainAreas, zoomAreas]) layers.forEach((l) => l.setStyle({ fillOpacity: 0 }));
  eewAreas.forEach((l) => l.setStyle({ fillColor: '#d0d0d0' }));
  mainIcons.clearLayers(); zoomIcons.clearLayers();
  markerCache.main = []; markerCache.zoom = [];
  for (const key of ['main', 'zoom']) { fronts[key].p.setLatLngs([]); fronts[key].s.setLatLngs([]); fronts[key].rupture.setLatLngs([]); }
  $('maxPanel').classList.add('hidden');
  $('infoBar').classList.add('hidden');
  $('eewLabel').textContent = ''; $('eewLabel').className = '';
  $('tab-eew').innerHTML = '<div class="muted">再生すると、ここに緊急地震速報が出ます。</div>';
  $('tab-info').innerHTML = '<div class="muted">揺れが観測されると、ここに震度の一覧が出ます。</div>';
  $('timer').textContent = fmtTime(0);
  if (eewMap.hasLayer(eewEpi)) eewMap.removeLayer(eewEpi);
  eewMap.setView([36, 137], 4.6);
}

function render() {
  const model = state.model;
  if (!model) return;
  const t = state.t;
  $('timer').textContent = fmtTime(t);
  const { p } = model;

  // 波面
  const pPoly = frontPolygon(model, t, p.vp), sPoly = frontPolygon(model, t, p.vs);
  // 破壊が進んだ部分
  const rup = ruptureLine(model, t);
  for (const key of ['main', 'zoom']) {
    fronts[key].p.setLatLngs(pPoly);
    fronts[key].s.setLatLngs(sPoly);
    fronts[key].rupture.setLatLngs(rup);
  }

  // 地域の震度
  let maxCls = 0, changed = false;
  model.areas.forEach((m, i) => {
    const c = classAt(m, t);
    if (c > maxCls) maxCls = c;
    if (c !== state.shownClass[i]) {
      state.shownClass[i] = c;
      changed = true;
      const style = c > 0 ? { fillColor: CLASS_COLORS[c], fillOpacity: 0.7 } : { fillOpacity: 0 };
      mainAreas[i].setStyle(style);
      zoomAreas[i].setStyle(style);
      setAreaIcon('main', mainIcons, i, c >= 3 ? c : 0, 22);
      setAreaIcon('zoom', zoomIcons, i, c, 22);
    }
  });
  if (maxCls !== state.shownMax) {
    state.shownMax = maxCls;
    if (maxCls >= 1) {
      $('maxPanel').src = `img/max-${CLASS_KEYS[maxCls]}.png`;
      $('maxPanel').alt = `最大震度${CLASS_LABELS[maxCls]}`;
      $('maxPanel').classList.remove('hidden');
      showInfoBar();
    } else {
      $('maxPanel').classList.add('hidden');
      $('infoBar').classList.add('hidden');
    }
  }
  if (changed) renderInfoTab(t);

  // 緊急地震速報
  let idx = -1;
  for (let i = 0; i < model.eew.length; i++) if (model.eew[i].t <= t) idx = i;
  if (idx !== state.shownReport) {
    const prev = state.shownReport >= 0 ? model.eew[state.shownReport] : null;
    state.shownReport = idx;
    renderEEW(idx >= 0 ? model.eew[idx] : null);
    if (idx >= 0 && state.playing) {
      const r = model.eew[idx];
      if (r.warned && !(prev && prev.warned)) chime(true);
      else if (!prev) chime(false);
    }
  }
}

function ruptureLine(model, t) {
  // 震源から両側へ、t までに割れた区間の線
  const A = [], B = [];
  let side = A;
  const srcs = model.sources;
  // buildSources は 震源, A側..., B側... の順。A側の終わりは t が一度減るところで判定する。
  for (let i = 1; i < srcs.length; i++) {
    if (i > 1 && srcs[i].t < srcs[i - 1].t) side = B;
    if (srcs[i].t <= t) side.push(model.proj.ll(srcs[i].x, srcs[i].y));
  }
  if (!A.length && !B.length) return [];
  return [...A.reverse(), model.proj.ll(0, 0), ...B];
}

function setAreaIcon(key, group, i, cls, size) {
  const old = markerCache[key][i];
  if (old) { group.removeLayer(old); markerCache[key][i] = null; }
  if (cls <= 0) return;
  const mk = L.marker(AREAS[i].center, { icon: intIcon(cls, size), interactive: false, zIndexOffset: cls * 10 });
  mk.addTo(group);
  markerCache[key][i] = mk;
}

function showInfoBar() {
  const d = state.originDate || new Date();
  $('ibDay').textContent = d.getDate();
  $('ibHour').textContent = d.getHours();
  $('ibMin').textContent = d.getMinutes();
  $('ibMag').textContent = state.model.p.mag.toFixed(1);
  $('infoBar').classList.remove('hidden');
}

function epicenterName(model) {
  let best = null, bd = Infinity;
  AREAS.forEach((a, i) => {
    const [x, y] = model.areas[i].cx;
    const d = Math.hypot(x, y);
    if (d < bd) { bd = d; best = a; }
  });
  if (!best) return '不明';
  return bd < 25 ? best.name : `${best.name}の沖`;
}

function renderEEW(r) {
  const label = $('eewLabel');
  const body = $('tab-eew');
  const model = state.model;
  if (!r) {
    label.textContent = ''; label.className = '';
    body.innerHTML = '<div class="muted">まだ緊急地震速報は出ていません。</div>';
    eewAreas.forEach((l) => l.setStyle({ fillColor: '#d0d0d0' }));
    if (eewMap.hasLayer(eewEpi)) eewMap.removeLayer(eewEpi);
    return;
  }
  const kind = r.warned ? '警報' : '予報';
  label.textContent = `緊急地震速報（${kind}）`;
  label.className = r.warned ? 'warn' : 'fc';
  eewEpi.setLatLng([model.p.lat, model.p.lon]);
  if (!eewMap.hasLayer(eewEpi)) eewEpi.addTo(eewMap);
  const warn = new Set(r.warnAreas);
  eewAreas.forEach((l, i) => l.setStyle({ fillColor: warn.has(i) ? '#ffff00' : '#d0d0d0' }));
  if (warn.size) {
    const b = L.latLngBounds([[model.p.lat, model.p.lon]]);
    warn.forEach((i) => b.extend(mainAreas[i].getBounds()));
    eewMap.fitBounds(b.pad(0.35), { maxZoom: 7 });
  }
  const names = [...warn].map((i) => AREAS[i].name);
  body.innerHTML = `
    <div class="head ${r.warned ? 'warn' : 'fc'}">緊急地震速報（${kind}）${r.final ? '最終報' : `第${r.no}報`}</div>
    <div class="row">震源：${epicenterName(model)}（北緯${model.p.lat.toFixed(1)}度 東経${model.p.lon.toFixed(1)}度）</div>
    <div class="row">深さ：約${Math.round(model.p.depth)}km　推定M：${r.mest.toFixed(1)}</div>
    <div class="row">予想最大震度：${r.maxPred >= 1 ? CLASS_LABELS[r.maxPred] : '1未満'}</div>
    ${r.warned ? `<div class="row"><b>強い揺れに警戒する地域：</b></div><div class="areas">${names.join('　') || '—'}</div>` : ''}`;
}

function renderInfoTab(t) {
  const groups = {};
  state.shownClass.forEach((c, i) => { if (c > 0) (groups[c] = groups[c] || []).push(AREAS[i].name); });
  const levels = Object.keys(groups).map(Number).sort((a, b) => b - a);
  const body = $('tab-info');
  if (!levels.length) { body.innerHTML = '<div class="muted">揺れが観測されると、ここに震度の一覧が出ます。</div>'; return; }
  const d = state.originDate || new Date();
  const head = levels[0] >= 3 ? '震度速報' : '各地の震度';
  body.innerHTML = `<div class="head info">${head}（${d.getDate()}日${d.getHours()}時${d.getMinutes()}分ごろ発生）</div>
    <div class="row">震源：${epicenterName(state.model)}　深さ：約${Math.round(state.model.p.depth)}km　M${state.model.p.mag.toFixed(1)}</div>` +
    levels.map((c) => `<div class="lvl"><img src="img/s-${CLASS_KEYS[c]}.png" alt="震度${CLASS_LABELS[c]}"><div class="areas">${groups[c].join('　')}</div></div>`).join('');
}

// ---------- 音（オリジナルの警報音） ----------
let audioCtx = null;
function chime(isWarning) {
  if (!$('sound').checked) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const now = audioCtx.currentTime;
    const notes = isWarning ? [660, 990, 660, 990, 660, 990] : [880, 880];
    notes.forEach((f, i) => {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.type = 'triangle'; o.frequency.value = f;
      const st = now + i * 0.28;
      g.gain.setValueAtTime(0, st);
      g.gain.linearRampToValueAtTime(0.25, st + 0.02);
      g.gain.exponentialRampToValueAtTime(0.001, st + 0.26);
      o.connect(g).connect(audioCtx.destination);
      o.start(st); o.stop(st + 0.27);
    });
  } catch (e) { /* 音が出せない環境では無視 */ }
}

// ---------- 再生 ----------
let lastFrame = 0;
function loop(ts) {
  if (!state.playing) return;
  const dt = lastFrame ? (ts - lastFrame) / 1000 : 0;
  lastFrame = ts;
  state.t += dt * state.speed;
  if (state.model && state.t > state.model.tEnd) { state.t = state.model.tEnd; pause(); }
  render();
  if (state.playing) requestAnimationFrame(loop);
}

function play() {
  if (!state.model) {
    prepare();
    resetView();
    state.originDate = new Date();
  }
  if (state.model && state.t >= state.model.tEnd) restart(false);
  state.playing = true;
  lastFrame = 0;
  $('play').textContent = '一時停止';
  requestAnimationFrame(loop);
}
function pause() {
  state.playing = false;
  $('play').textContent = '再生';
}
function restart(autoplay = true) {
  pause();
  prepare();
  resetView();
  state.originDate = new Date();
  drawSetup();
  if (autoplay) play();
}
function invalidate() {
  // 入力が変わったら計算をやり直す
  pause();
  state.model = null;
  resetView();
  drawSetup();
}
function seek(dt) {
  if (!state.model) { prepare(); resetView(); state.originDate = new Date(); }
  const target = Math.max(0, Math.min(state.t + dt, state.model.tEnd));
  // 震度などは時刻だけで決まるので、表示を消して描き直す
  const playing = state.playing;
  resetView();
  state.t = target;
  render();
  if (playing) { state.playing = true; $('play').textContent = '一時停止'; }
}

// ---------- 入力 ----------
function setMode(mode) {
  state.mode = state.mode === mode ? null : mode;
  $('modeHypo').classList.toggle('on', state.mode === 'hypo');
  $('modeFaultA').classList.toggle('on', state.mode === 'faultA');
  $('modeFaultB').classList.toggle('on', state.mode === 'faultB');
  $('hint').textContent = {
    hypo: '地図をクリックして震源の位置を決めてください',
    faultA: '地図をクリックすると、断層の端A側に点を足します（震源から順につながります）',
    faultB: '地図をクリックすると、断層の端B側に点を足します（震源から順につながります）',
  }[state.mode] || '';
}

mainMap.on('click', (e) => {
  const ll = [Math.round(e.latlng.lat * 100) / 100, Math.round(e.latlng.lng * 100) / 100];
  if (state.mode === 'hypo') {
    $('lat').value = ll[0].toFixed(2); $('lon').value = ll[1].toFixed(2);
    setMode(null);
  } else if (state.mode === 'faultA') {
    state.faultA.push(ll);
  } else if (state.mode === 'faultB') {
    state.faultB.push(ll);
  } else return;
  invalidate();
});

function applyPreset(i) {
  const pr = PRESETS[i];
  if (!pr) return;
  $('lat').value = pr.lat.toFixed(2); $('lon').value = pr.lon.toFixed(2);
  $('depth').value = pr.depth; $('mag').value = pr.mag; $('qtype').value = pr.type;
  state.faultA = pr.faultA.map((q) => [...q]);
  state.faultB = pr.faultB.map((q) => [...q]);
  invalidate();
  const b = L.latLngBounds([[pr.lat, pr.lon], ...pr.faultA, ...pr.faultB]);
  mainMap.fitBounds(b.pad(pr.mag >= 8.5 ? 1.2 : 3), { maxZoom: 8 });
}

PRESETS.forEach((pr, i) => $('preset').add(new Option(pr.name, i)));
$('preset').add(new Option('（自分で設定）', -1));
$('preset').addEventListener('change', (e) => applyPreset(+e.target.value));

CITIES.forEach(([n], i) => $('zoomCity').add(new Option(`拡大：${n}`, i)));
$('zoomCity').addEventListener('change', (e) => {
  const c = CITIES[+e.target.value];
  if (c[1] == null) zoomMap.setView([parseFloat($('lat').value), parseFloat($('lon').value)], 8);
  else zoomMap.setView([c[1], c[2]], 9);
});

for (const id of ['lat', 'lon', 'depth', 'mag', 'qtype', 'vp', 'vs', 'useDonet', 'useSnet', 'usePlum']) {
  $(id).addEventListener('change', () => { if (id !== 'preset') $('preset').value = '-1'; invalidate(); });
}
$('modeHypo').addEventListener('click', () => setMode('hypo'));
$('modeFaultA').addEventListener('click', () => setMode('faultA'));
$('modeFaultB').addEventListener('click', () => setMode('faultB'));
$('clearFault').addEventListener('click', () => { state.faultA = []; state.faultB = []; $('preset').value = '-1'; invalidate(); });
$('play').addEventListener('click', () => (state.playing ? pause() : play()));
$('back').addEventListener('click', () => seek(-10));
$('fwd').addEventListener('click', () => seek(10));
$('speed').addEventListener('change', (e) => { state.speed = +e.target.value; });

document.querySelectorAll('#infoPanel .tabs button').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('#infoPanel .tabs button').forEach((x) => x.classList.toggle('active', x === b));
  $('tab-eew').classList.toggle('hidden', b.dataset.tab !== 'eew');
  $('tab-info').classList.toggle('hidden', b.dataset.tab !== 'info');
}));

document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, select, textarea')) return;
  if (e.key === 'Enter') { e.preventDefault(); restart(true); }
  else if (e.key === ' ') { e.preventDefault(); state.playing ? pause() : play(); }
  else if (e.key === 'ArrowLeft') seek(-10);
  else if (e.key === 'ArrowRight') seek(10);
});

// 初期表示：南海トラフのプリセット
applyPreset(0);

// テスト用に外から触れるようにしておく
window.QuakeSim = { state, prepare, render, seek, restart, intensity, toClass };
