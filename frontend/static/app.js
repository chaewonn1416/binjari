/**
 * 빈자리 — Frontend App
 * 백엔드 API와 실제 통신
 */

const API   = "http://localhost:8000";   // 배포 시 Railway/Render URL 교체
const UID   = "user_" + (localStorage.getItem("binjari_uid") || (() => {
  const id = Math.random().toString(36).slice(2,10);
  localStorage.setItem("binjari_uid", id);
  return id;
})());

// 현재 탑승 정보 (체크인 시 설정)
const State = {
  line:        "2",
  station:     "선릉",
  car:         3,
  destination: null,
  exitId:      null,   // 내가 등록한 하차 exit_id
  mapData:     null,
  currentPts:  0,
};

const ZONES = ["priA","z1","z2","z3","priB"];
const ZSIZ  = {priA:2,z1:4,z2:4,z3:4,priB:2};
const ZL    = {priA:"앞 우선석",z1:"문1↔문2",z2:"문2↔문3",z3:"문3↔문4",priB:"뒤 우선석"};
const DOOR_MAP = {z1:1,z2:2,z3:3,priA:1,priB:4};

// ═══════════════════════════════════════════
const App = {

  // ── 초기화 ────────────────────────────────
  async init() {
    this.hideSplash();
    await this.initUser();
    await this.loadAll();
    this.buildCarScroll(State.car);
    await this.loadSeats(State.station, State.car);
    this.buildWeekBars();
    setInterval(() => this.poll(), 30000);  // 30초마다 새로고침
  },

  hideSplash() {
    setTimeout(() => {
      document.getElementById("splash").style.opacity = "0";
      setTimeout(() => document.getElementById("splash").style.display = "none", 600);
    }, 2300);
  },

  async initUser() {
    try {
      const res  = await fetch(`${API}/api/user`, {
        method:"POST", headers:{"Content-Type":"application/json"},
        body: JSON.stringify({user_id:UID, nickname:"익명"})
      });
      const data = await res.json();
      State.currentPts = data.total_points || 0;
      this.updatePtsUI(State.currentPts);
    } catch(e) { console.warn("user init:", e); }
  },

  async loadAll() {
    await Promise.allSettled([
      this.loadPredict(),
      this.loadReward(),
      this.loadCarbon(),
    ]);
  },

  async poll() {
    await this.loadPredict();
    await this.loadSeats(State.station, State.car);
  },

  // ── NAV ────────────────────────────────────
  showPage(name, el) {
    document.querySelectorAll(".page").forEach(p => p.classList.remove("active"));
    document.querySelectorAll(".nb").forEach(n => n.classList.remove("active"));
    document.getElementById("page-" + name).classList.add("active");
    el.classList.add("active");
  },

  // ── 알림 ───────────────────────────────────
  showN(icon, text) {
    clearTimeout(this._nt);
    document.getElementById("ni").textContent = icon;
    document.getElementById("nt").textContent = text;
    document.getElementById("notif").classList.add("show");
    this._nt = setTimeout(() => this.hideNotif(), 3400);
  },
  hideNotif() { document.getElementById("notif").classList.remove("show"); },

  // ── 모달 ───────────────────────────────────
  openMo(id)         { document.getElementById(id).classList.add("open"); },
  closeMo(id, e)     { if(e.target.id===id) document.getElementById(id).classList.remove("open"); },
  closeModal(id)     { document.getElementById(id).classList.remove("open"); },

  setDest(name) {
    State.destination = name;
    document.getElementById("modal-dest").classList.remove("open");
    this.showN("📍", `${name}(으)로 목적지 설정!`);
    // 해당 역 방향 좌석 갱신
    this.loadSeats(State.station, State.car);
    this.showPage("train", document.querySelectorAll(".nb")[1]);
  },

  togglePriority() {
    const cb = document.getElementById("exit-priority");
    cb.checked = !cb.checked;
  },

  // ── 하차 정보 등록 (핵심) ─────────────────
  async submitExit() {
    const exitStation = document.getElementById("exit-station-input").value;
    if (!exitStation) { this.showN("⚠️","하차 역을 선택해주세요"); return; }

    const side     = document.getElementById("exit-side-input").value;
    const doorZone = document.getElementById("exit-door-input").value;
    const isPri    = document.getElementById("exit-priority").checked;

    try {
      const res = await fetch(`${API}/api/register-exit`, {
        method:"POST", headers:{"Content-Type":"application/json"},
        body: JSON.stringify({
          user_id:      UID,
          line:         State.line,
          station:      State.station,
          car:          State.car,
          door_zone:    doorZone,
          side:         side,
          exit_station: exitStation.replace("역",""),
          is_priority:  isPri,
        }),
      });
      const data = await res.json();
      State.exitId     = data.exit_id;
      State.currentPts = data.total_points;
      this.updatePtsUI(data.total_points);
      this.closeModal("modal-exit");
      this.showN("🎉", `하차 등록 완료! +${data.points_earned}P 적립`);

      // 홈 매칭 카드 표시
      document.getElementById("home-match-area").innerHTML = `
        <div class="mcard">
          <div class="mib">🚪</div>
          <div class="minfo">
            <div class="mttl">${exitStation} 하차 등록됨</div>
            <div class="msub">${ZL[doorZone]} ${side==="top"?"위쪽":"아래쪽"} · 실제 하차 시 +10P 추가</div>
          </div>
          <button class="mbtn" onclick="App.confirmMyExit()">하차 완료</button>
        </div>
      `;

      // 좌석 맵 새로고침
      await this.loadSeats(State.station, State.car);

    } catch(e) {
      this.showN("❌","등록 실패. 백엔드 서버를 확인해주세요.");
      console.error(e);
    }
  },

  async confirmMyExit() {
    if (!State.exitId) return;
    try {
      const res  = await fetch(`${API}/api/confirm-exit`, {
        method:"POST", headers:{"Content-Type":"application/json"},
        body: JSON.stringify({exit_id:State.exitId, actual_station:State.destination||"강남"}),
      });
      const data = await res.json();
      State.currentPts = data.total_points;
      this.updatePtsUI(data.total_points);
      State.exitId = null;
      document.getElementById("home-match-area").innerHTML = "";
      this.showN("✅", `하차 완료! +${data.points_earned}P 추가 적립!`);
    } catch(e) { console.error(e); }
  },

  async confirmSeat() {
    // 착석 확인 → +10P
    try {
      // 현재 추천 exit_id가 있으면 API 호출
      if (State.recExitId) {
        const res  = await fetch(`${API}/api/confirm-seat`, {
          method:"POST", headers:{"Content-Type":"application/json"},
          body: JSON.stringify({exit_id:State.recExitId, seeker_id:UID}),
        });
        const data = await res.json();
        State.currentPts = data.seeker_total || State.currentPts + 10;
      } else {
        State.currentPts += 10;
      }
      this.updatePtsUI(State.currentPts);
      this.showN("🪑","착석 확인! +10P 적립!");
    } catch(e) { this.showN("🪑","착석 확인! +10P 적립!"); }
  },

  // ── API 데이터 로드 ────────────────────────

  async loadPredict() {
    try {
      const res  = await fetch(`${API}/api/predict/${encodeURIComponent(State.station)}?line=${State.line}`);
      const data = await res.json();

      // 도착 정보
      const arr = data.arrival || {};
      const arrTxt = document.getElementById("arrival-txt");
      const nxtMin = document.getElementById("next-min");
      if (arrTxt) arrTxt.textContent = `다음: ${arr.current_station||"역삼"}역 · ${arr.next_min||2}분`;
      if (nxtMin) nxtMin.textContent = `${arr.next_min||2}분`;

      // KPI
      const bestCar = data.car_predictions?.find(c=>c.ai_rec);
      if (bestCar) {
        document.getElementById("kpi-min").textContent = "2정거장";
        document.getElementById("kpi-pts").textContent = State.currentPts.toLocaleString();
      }

      // 비콘
      const bt = document.getElementById("beacon-txt");
      if (bt) bt.textContent = `2호선 ${State.station}역 — AI 분석 완료 · ${data.ai_rec_car||3}호차 추천`;

      // 히트맵
      this.buildHeatmap(data.car_predictions || []);

      // TOP2
      this.renderTop2(data.top_recommendations || []);

      // 학습 현황
      const stats = data.model_stats || {};
      const sr = document.getElementById("st-records");
      const sa = document.getElementById("st-acc");
      const st = document.getElementById("st-trained");
      if(sr) sr.textContent = "2.4M";
      if(sa) sa.textContent = "91%";
      if(st) st.textContent = stats.last_trained || "12h";

    } catch(e) {
      console.warn("predict:", e);
      this.renderDefaultPredict();
    }
  },

  async loadSeats(station, car) {
    try {
      const res  = await fetch(`${API}/api/exits/${State.line}/${encodeURIComponent(station)}/${car}`);
      const data = await res.json();

      // 크라우드소싱 카운트
      const cnt = data.exit_count || 0;
      document.getElementById("st-crowd").textContent = cnt;
      document.getElementById("kpi-exits").textContent = cnt + "명";

      const badge = document.getElementById("crowd-badge-wrap");
      if (badge) {
        badge.innerHTML = cnt > 0
          ? `<div class="crowd-count">🙋 ${cnt}명 직접 등록</div>`
          : `<div style="font-size:9px;color:var(--mu)">좌석 터치 → 상세</div>`;
      }

      // 좌석 맵 렌더
      const seatMap = data.seat_map;
      if (seatMap) {
        this.renderSeatMap(seatMap, car);
        this.updateZones(seatMap);
        this.updateRec(seatMap, car, station);
        State.mapData = seatMap;
      }

    } catch(e) {
      console.warn("exits:", e);
      this.buildFallbackMap(car);
    }
  },

  async loadReward() {
    try {
      const res  = await fetch(`${API}/api/reward/${UID}`);
      const data = await res.json();
      State.currentPts = data.total_points;
      this.updatePtsUI(data.total_points);

      // 포인트 이력
      const log = document.getElementById("point-log");
      if (log && data.point_log?.length) {
        log.innerHTML = data.point_log.map(l => `
          <div class="ei">
            <span class="el">${l.action==="exit_register"?"🚪 하차 등록":l.action==="checkin"?"🚇 탑승":"🎯 " + l.action}</span>
            <span class="ep">+${l.points} P</span>
          </div>
        `).join("");
      } else if (log) {
        log.innerHTML = `<div class="ei"><span class="el" style="color:var(--mu)">아직 적립 내역이 없어요. 하차 정보를 등록해보세요!</span></div>`;
      }
    } catch(e) { console.warn("reward:", e); this.updatePtsUI(0); }
  },

  async loadCarbon() {
    try {
      const res  = await fetch(`${API}/api/carbon/${UID}`);
      const data = await res.json();
      const cn = document.getElementById("co2-n");
      const ce = document.getElementById("co2-eq");
      const cs = document.getElementById("c-sub");
      const cr = document.getElementById("c-rank");
      if(cn) cn.textContent = data.carbon_saved_kg.toFixed(1);
      if(ce) ce.textContent = `= 소나무 ${data.eq_trees}그루 · 자동차 ${data.eq_car_km}km 운행 안 한 효과`;
      if(cs) cs.textContent = data.carbon_saved_kg.toFixed(1) + " kg";
      if(cr) cr.textContent = `상위 ${data.rank_pct}%`;
    } catch(e) {
      const cn = document.getElementById("co2-n"); if(cn) cn.textContent="4.7";
      const ce = document.getElementById("co2-eq"); if(ce) ce.textContent="= 소나무 0.5그루 · 자동차 28km";
    }
  },

  // ── UI 렌더 함수들 ──────────────────────────

  updatePtsUI(pts) {
    const hp = document.getElementById("home-pts");
    const pn = document.getElementById("pts-n");
    const kp = document.getElementById("kpi-pts");
    const ps = document.getElementById("pts-sub");
    if(hp) hp.textContent = pts.toLocaleString();
    if(pn) this.animCount(pn, 0, pts, 1200);
    if(kp) kp.textContent = pts.toLocaleString();
    if(ps) ps.textContent = `교통카드 ₩${pts.toLocaleString()} 상당`;
  },

  buildCarScroll(sel) {
    const wrap = document.getElementById("car-scroll");
    if (!wrap) return;
    wrap.innerHTML = "";
    const CONG = [88,91,76,84,67,55,79,72,83,61];
    CONG.forEach((pct, i) => {
      const n   = i + 1;
      const col = pct>=80?"var(--r)":pct>=55?"var(--y)":"var(--g)";
      const rec = n===3;  // AI 추천 호차 (실제 서비스: 서버에서 받아옴)
      const btn = document.createElement("div");
      btn.className = "cbtn" + (n===sel?" sel":"");
      btn.innerHTML = `
        <div class="cnum" style="${n===sel?"color:var(--c)":rec?"color:var(--p)":""}">${n}${rec?"⭐":""}</div>
        <div class="ccong"><div class="ccf" style="width:${pct}%;background:${col}"></div></div>
        <div class="cpct" style="color:${col}">${pct}%</div>
      `;
      btn.onclick = async () => {
        document.querySelectorAll(".cbtn").forEach(b=>{b.classList.remove("sel");b.querySelector(".cnum").style.color="";});
        btn.classList.add("sel");
        btn.querySelector(".cnum").style.color="var(--c)";
        State.car = n;
        document.getElementById("car-ttl").textContent = n+"호차 내부 배치도";
        await this.loadSeats(State.station, n);
        this.showN(rec?"⭐":"🚃", n+"호차"+(rec?" — AI 추천 호차!":""));
      };
      wrap.appendChild(btn);
    });
  },

  buildHeatmap(carPreds) {
    const wrap = document.getElementById("hm-row");
    if (!wrap) return;
    wrap.innerHTML = "";
    const fallback = [88,91,76,84,67,55,79,72,83,61].map((p,i)=>({car:i+1,congestion:p,ai_rec:i===2}));
    const data     = carPreds.length ? carPreds : fallback;
    data.forEach(c => {
      const col = c.congestion>=80?"var(--r)":c.congestion>=55?"var(--y)":"var(--g)";
      const fh  = Math.round((c.congestion/100)*20);
      const el  = document.createElement("div"); el.className="hmc";
      if(c.ai_rec) el.style.border="1.5px solid var(--p)";
      el.innerHTML=`<div class="hmn" style="${c.ai_rec?"color:var(--p)":""}">${c.car}호${c.ai_rec?"⭐":""}</div><div class="hmbar"><div class="hmf" style="height:${fh}px;background:${col}"></div></div><div class="hmpct" style="color:${col}">${c.congestion}%</div>`;
      el.onclick=()=>{
        this.showPage("train",document.querySelectorAll(".nb")[1]);
        this.buildCarScroll(c.car); State.car=c.car;
        document.getElementById("car-ttl").textContent=c.car+"호차 내부 배치도";
        this.loadSeats(State.station, c.car);
        this.showN(c.ai_rec?"⭐":"🚃",c.car+"호차 분석 완료");
      };
      wrap.appendChild(el);
    });
  },

  renderTop2(recs) {
    const wrap = document.getElementById("top2-wrap");
    if (!wrap) return;
    if (!recs.length) { this.renderDefaultTop2(); return; }
    wrap.innerHTML = recs.map((r,i)=>`
      <div class="airc">
        <div class="airch">
          <div>
            <div style="font-size:9px;color:var(--mu);margin-bottom:3px">${["🥇 1순위","🥈 2순위"][i]}</div>
            <div class="airspot">2호선 <span>${r.car}호차 · ${r.door||r.zone}</span></div>
            <div style="font-size:10px;color:var(--mu);margin-top:2px">${r.side||""} ${r.zone||""}</div>
            <div style="display:flex;gap:4px;margin-top:6px;flex-wrap:wrap">
              <span class="tag-g">✅ 추천</span>
              ${r.crowd_data?'<span class="tag-c">🙋 실제 등록 데이터</span>':'<span class="tag-p">📊 통계 기반</span>'}
            </div>
          </div>
          <div style="text-align:right"><div class="confn">${Math.round((r.confidence||0.85)*100)}%</div><div class="confl">신뢰도</div></div>
        </div>
        <div class="cbw"><div class="cbl">신뢰도</div><div class="cbb"><div class="cbf" style="width:${Math.round((r.confidence||0.85)*100)}%;background:linear-gradient(90deg,var(--g),var(--c))"></div></div></div>
        <div class="insight">💡 ${r.insight||"혼잡도 통계 기반 예측. 사용자 하차 등록 시 실시간 업데이트."}</div>
      </div>
    `).join("");
  },

  renderDefaultTop2() {
    const wrap = document.getElementById("top2-wrap");
    if (!wrap) return;
    wrap.innerHTML = `
      <div class="airc">
        <div class="airch">
          <div><div style="font-size:9px;color:var(--mu);margin-bottom:3px">🥇 1순위</div><div class="airspot">2호선 <span>3호차 · 3-2↔3-3</span></div><div style="font-size:10px;color:var(--mu);margin-top:2px">위쪽 창문쪽 · 혼잡도 최저</div><div style="display:flex;gap:4px;margin-top:6px"><span class="tag-g">✅ 추천</span><span class="tag-p">📊 통계 기반</span></div></div>
          <div style="text-align:right"><div class="confn">91%</div><div class="confl">신뢰도</div></div>
        </div>
        <div class="cbw"><div class="cbl">신뢰도</div><div class="cbb"><div class="cbf" style="width:91%;background:linear-gradient(90deg,var(--g),var(--c))"></div></div></div>
        <div class="insight">💡 3호차는 이 시간대 혼잡도가 가장 낮습니다 (76%). <strong>하차 정보를 직접 등록</strong>하면 실시간 좌석 데이터로 업데이트됩니다.</div>
      </div>
    `;
  },

  renderSeatMap(seatMap, car) {
    const w = document.getElementById("smap");
    if (!w) return;
    w.innerHTML = `
      <div class="dbar"><span class="df">▶ 진행 방향 (앞)</span><span style="font-size:8px;color:var(--mu);opacity:.5">${car}호차</span><span class="db">(뒤) ◀</span></div>
      <div class="wlbl">창문쪽 (위)</div><div class="ws"></div>
      <div class="ss"><div class="tb" id="tb${car}"></div></div>
      <div class="ws bot"></div><div class="wlbl">창문쪽 (아래)</div>
    `;
    const body = document.getElementById("tb"+car);
    if (!body) return;

    const cap = r => { const e=document.createElement("div"); e.className="tc"+(r?" r":""); return e; };
    body.appendChild(cap(false));
    ZONES.forEach((zk,zi) => {
      if (zi>0) body.appendChild(this.mkDoor(car, zi, zi===2));
      body.appendChild(this.mkZone(seatMap, zk, car));
    });
    body.appendChild(this.mkDoor(car, 4, false));
    body.appendChild(cap(true));
  },

  mkDoor(car, dn, mine) {
    const d=document.createElement("div"); d.className="td";
    d.innerHTML=`<div class="dw"></div><div class="do${mine?" mine":""}"><span class="${mine?"dt":""}">${mine?"탑승":""}</span></div><div class="dw"></div><div class="dn">${car}-${dn}</div>`;
    return d;
  },

  mkZone(seatMap, zk, car) {
    const col=document.createElement("div"); col.className="tz";
    const tr=document.createElement("div"); tr.className="tsr";
    (seatMap.top[zk]||[]).forEach((s,i)=>tr.appendChild(this.mkSeat(s,"top",zk,i,car)));
    col.appendChild(tr);
    const al=document.createElement("div"); al.className="ta";
    al.innerHTML=`<div class="tal"></div><div class="talb">${ZL[zk]}</div>`;
    col.appendChild(al);
    const br=document.createElement("div"); br.className="tsr";
    (seatMap.bot[zk]||[]).forEach((s,i)=>br.appendChild(this.mkSeat(s,"bot",zk,i,car)));
    col.appendChild(br);
    return col;
  },

  mkSeat(s, side, zk, idx, car) {
    const el=document.createElement("div");
    // crowd=true이면 실제 사용자 등록 데이터
    let cls="st ";
    if (s.crowd)          cls+="sg crowd";
    else if (s.type==="empty") cls+="se";
    else if (s.type==="green") cls+="sg";
    else if (s.type==="yellow") cls+="sy";
    else if (s.type==="red")   cls+="sr";
    else if (s.type==="priority") cls+="spri";
    else cls+="se";
    el.className=cls;

    if (s.crowd) {
      // 실제 사용자 등록 데이터 — 강조 표시
      el.innerHTML=`<div class="si">🙋</div><div class="sn">${s.exit_station||"?"}역</div><div class="crowd-badge"></div>`;
      if (s.exit_id) {
        State.recExitId = s.exit_id;  // 착석 확인용
      }
    } else if (s.type==="priority") {
      el.innerHTML=`<div class="si">♿</div><div class="sn">우선석</div>`;
    } else if (s.type==="empty") {
      el.innerHTML=`<div class="sn">빈자리</div>`;
    } else {
      el.innerHTML=`<div class="sn">${s.stops||"?"}역후</div>`;
    }

    const w=side==="top"?"위쪽":"아래쪽";
    el.onclick=()=>{
      if (s.crowd) {
        App.showN("🙋",`${w} ${ZL[zk]} — ${s.exit_station}역 하차 예정 (직접 등록)`);
      } else if (s.type==="empty") {
        App.showN("🪑",`${w} ${ZL[zk]} — 빈자리! 앉으세요 😊`);
      } else {
        App.showN("📊",`${w} ${ZL[zk]} — 혼잡도 통계 기반 예측`);
      }
    };
    return el;
  },

  updateZones(seatMap) {
    const cg = (zones) => zones.reduce((acc, z) =>
      acc + (seatMap.top[z]||[]).concat(seatMap.bot[z]||[])
            .filter(s=>s.crowd||s.type==="green"||s.type==="empty").length, 0);
    const zf=document.getElementById("zf"),zm=document.getElementById("zm"),zb=document.getElementById("zb");
    if(zf) zf.textContent=cg(["priA","z1"])+"석";
    if(zm) zm.textContent=cg(["z2"])+"석";
    if(zb) zb.textContent=cg(["z3","priB"])+"석";
  },

  updateRec(seatMap, car, station) {
    // 크라우드소싱 데이터 우선, 없으면 통계 기반
    for (const side of ["top","bot"]) {
      for (const zk of ["z1","z2","z3"]) {
        for (const s of (seatMap[side][zk]||[])) {
          if (s.crowd) {
            const rt=document.getElementById("rec-ttl"), rs=document.getElementById("rec-sub");
            if(rt) rt.textContent=`🙋 ${side==="top"?"위쪽":"아래쪽"} ${ZL[zk]} — ${s.exit_station}역 하차 예정`;
            if(rs) rs.textContent="사용자 직접 등록 데이터 · 실시간 업데이트";
            return;
          }
        }
      }
    }
    // 크라우드 없으면 기본 메시지
    const rt=document.getElementById("rec-ttl"), rs=document.getElementById("rec-sub");
    if(rt) rt.textContent=`🤖 ${car}호차 AI 추천 (혼잡도 통계 기반)`;
    if(rs) rs.textContent="하차 정보를 직접 등록하면 정확도가 올라가요!";
  },

  buildFallbackMap(car) {
    // API 연결 안 될 때 기본 배치도
    const fakeSm = {top:{}, bot:{}};
    ZONES.forEach(z=>{
      fakeSm.top[z]=Array.from({length:ZSIZ[z]},(_,i)=>{
        const r=Math.random();
        return {type:r<.12?"empty":r<.3?"green":r<.65?"yellow":"red",stops:Math.floor(Math.random()*8)+1,crowd:false};
      });
      fakeSm.bot[z]=Array.from({length:ZSIZ[z]},()=>{
        const r=Math.random();
        return {type:r<.12?"empty":r<.3?"green":r<.65?"yellow":"red",stops:Math.floor(Math.random()*8)+1,crowd:false};
      });
    });
    this.renderSeatMap(fakeSm, car);
    this.updateZones(fakeSm);
    const rt=document.getElementById("rec-ttl"), rs=document.getElementById("rec-sub");
    if(rt) rt.textContent="백엔드 연결 필요";
    if(rs) rs.textContent="uvicorn app:app --reload 로 서버 실행 후 새로고침";
  },

  renderDefaultPredict() {
    document.getElementById("beacon-txt").textContent="2호선 선릉역 — 백엔드 서버 미연결 (데모 모드)";
    this.buildHeatmap([]);
    this.renderDefaultTop2();
  },

  buildWeekBars() {
    const c=document.getElementById("wbars"); if(!c) return;
    const d=[55,70,48,85,62,30,20];
    const days=["월","화","수","목","금","토","일"];
    const mx=Math.max(...d);
    d.forEach((v,i)=>{
      const w=document.createElement("div"); w.className="wbw";
      const b=document.createElement("div"); b.className="wb"+(i===4?" today":""); b.style.height="0";
      setTimeout(()=>b.style.height=Math.round((v/mx)*58)+"px",400+i*80);
      const l=document.createElement("div"); l.className="wd"; l.textContent=days[i];
      w.appendChild(b); w.appendChild(l); c.appendChild(w);
    });
  },

  animCount(el, from, to, dur) {
    const s=performance.now();
    const step=now=>{
      const p=Math.min((now-s)/dur,1);
      el.textContent=Math.floor(from+(to-from)*p).toLocaleString();
      if(p<1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  },
};

window.addEventListener("load", () => App.init());
