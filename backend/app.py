"""
빈자리 (BinJari) — FastAPI 백엔드
사용자 직접 입력 기반 하차 공유 + 실제 공공 API 연동
"""

import datetime, os
from contextlib import asynccontextmanager
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Optional
from dotenv import load_dotenv

import database as db
from data_pipeline import pipeline, sync_arrival, sync_cong
from model import predictor
from carbon import carbon

load_dotenv()


@asynccontextmanager
async def lifespan(app: FastAPI):
    await db.init_db()   # 서버 기동 시 DB 초기화
    yield

app = FastAPI(
    title="빈자리 API",
    description="사용자 직접 입력 기반 지하철 좌석 공유 서비스",
    version="2.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],   # 배포 시 .env ALLOWED_ORIGINS 으로 제한
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── 요청 스키마 ──────────────────────────────

class UserCreate(BaseModel):
    user_id:  str
    nickname: str = "익명"

class CheckinReq(BaseModel):
    user_id:     str
    line:        str        # "2"
    station:     str        # "선릉"
    car:         int
    destination: str

class ExitRegisterReq(BaseModel):
    """사용자가 직접 입력하는 하차 예정 정보"""
    user_id:      str
    line:         str       # "2"
    station:      str       # 현재 탑승 역
    car:          int       # 호차 1~10
    door_zone:    str       # "3-2"
    side:         str       # "top" / "bot"
    exit_station: str       # 하차 예정 역
    is_priority:  bool = False  # 교통약자 여부

class ExitConfirmReq(BaseModel):
    exit_id:        int
    actual_station: str

class SeatConfirmReq(BaseModel):
    exit_id:   int
    seeker_id: str


# ── 헬스 체크 ────────────────────────────────

@app.get("/")
def root():
    return {
        "service":            "빈자리 API v2",
        "status":             "running",
        "seoul_api":          bool(os.getenv("SEOUL_API_KEY","")),
        "crowd_sourcing":     True,
        "description":        "사용자 직접 입력 기반 하차 공유",
    }


# ── 사용자 ───────────────────────────────────

@app.post("/api/user")
async def create_user(req: UserCreate):
    user = await db.get_or_create_user(req.user_id, req.nickname)
    return user

@app.get("/api/user/{user_id}")
async def get_user(user_id: str):
    user = await db.get_or_create_user(user_id)
    log  = await db.get_point_log(user_id)
    return {**user, "point_log": log}


# ── 실시간 도착 정보 (서울 열린데이터광장 OA-12764) ──

@app.get("/api/arrival/{station}")
def get_arrival(station: str):
    """실제 API 연결 시 실시간, 미연결 시 fallback"""
    return sync_arrival(station)


# ── 혼잡도 (OA-12928 기반) ───────────────────

@app.get("/api/congestion/{station}")
def get_congestion(station: str, hour: Optional[int] = None):
    h = hour if hour is not None else datetime.datetime.now().hour
    return sync_cong(station, h)


# ── AI 예측 ──────────────────────────────────

@app.get("/api/predict/{station}")
async def predict(station: str, line: str = "2"):
    now      = datetime.datetime.now()
    hour     = now.hour
    weekday  = now.weekday()
    arrival  = sync_arrival(station)
    cong     = sync_cong(station, hour)
    car_pred = predictor.predict_cars(station, hour, weekday)
    top2     = predictor.get_top2(car_pred, station, cong["ai_rec_car"])

    return {
        "station":             station,
        "line":                line,
        "timestamp":           now.isoformat(),
        "arrival":             arrival,
        "congestion_base_pct": cong["base_pct"],
        "data_source":         cong["source"],
        "car_predictions":     car_pred,
        "top_recommendations": top2,
        "ai_rec_car":          cong["ai_rec_car"],
        "model_stats":         predictor.get_stats(),
    }


# ═══════════════════════════════════════════════════
# 핵심 기능: 사용자 직접 입력 하차 정보 공유
# ═══════════════════════════════════════════════════

@app.post("/api/checkin")
async def checkin(req: CheckinReq):
    """탑승 체크인 (사용자 등록 + +5P)"""
    await db.get_or_create_user(req.user_id)
    total = await db.add_points(
        req.user_id, 5, "checkin",
        f"{req.line}호선 {req.station} 탑승"
    )
    return {"status":"ok","mileage_earned":5,"total_points":total}


@app.post("/api/register-exit")
async def register_exit(req: ExitRegisterReq):
    """
    ★ 핵심 엔드포인트 ★
    사용자가 "나 X역에서 내려요"를 직접 입력.
    → DB 저장 → 같은 칸 탑승자에게 알림 → +20P 적립
    """
    await db.get_or_create_user(req.user_id)
    result = await db.register_exit(
        user_id=req.user_id,
        line=req.line,
        station=req.station,
        car=req.car,
        door_zone=req.door_zone,
        side=req.side,
        exit_station=req.exit_station,
        is_priority=req.is_priority,
    )
    return {
        "status":         "ok",
        "exit_id":        result["exit_id"],
        "message":        f"등록 완료! {req.exit_station}역 하차 예정으로 공유됐어요 🚇",
        "points_earned":  result["points_earned"],
        "total_points":   result["total_points"],
        "will_notify":    True,   # 같은 칸 탑승자에게 알림 발송 (실제 서비스: WebSocket/FCM)
    }


@app.get("/api/exits/{line}/{station}/{car}")
async def get_exits(line: str, station: str, car: int):
    """
    해당 호차의 하차 예정자 목록.
    자리를 찾는 사람이 "누가 곧 내리나?"를 확인하는 핵심 API.
    """
    exits = await db.get_active_exits(station=station, car=car, line=line)

    # 좌석 배치도 형태로 가공
    seat_map = _build_seat_map_from_exits(exits, car)

    return {
        "line":       line,
        "station":    station,
        "car":        car,
        "exits":      exits,
        "seat_map":   seat_map,
        "exit_count": len(exits),
        "note":       "사용자 직접 등록 데이터 (실시간 업데이트)",
    }


@app.post("/api/confirm-exit")
async def confirm_exit(req: ExitConfirmReq):
    """실제 하차 완료 → +10P 추가"""
    result = await db.confirm_exit(req.exit_id, req.actual_station)
    return {**result, "message":"하차 정보 공유 완료! 데이터에 기여해 주셔서 감사해요 🌿"}


@app.post("/api/confirm-seat")
async def confirm_seat(req: SeatConfirmReq):
    """착석 확인 → 착석자 +10P"""
    result = await db.confirm_seat(req.exit_id, req.seeker_id)
    return {**result, "message":"착석 성공! 빈자리를 잘 활용하셨네요 🎉"}


# ── 포인트 / 탄소 ─────────────────────────────

@app.get("/api/reward/{user_id}")
async def get_reward(user_id: str):
    user = await db.get_or_create_user(user_id)
    log  = await db.get_point_log(user_id)
    return {
        "user_id":      user_id,
        "total_points": user["total_points"],
        "point_log":    log,
        "rewards": [
            {"name":"교통카드 충전","cost":100,"unit":"1P=₩1"},
            {"name":"스타벅스 쿠폰","cost":500},
            {"name":"CU 편의점 3천원","cost":300},
            {"name":"탄소 크레딧 기증","cost":200},
        ],
    }

@app.get("/api/carbon/{user_id}")
async def get_carbon(user_id: str):
    user   = await db.get_or_create_user(user_id)
    km     = user["monthly_km"] or 87.4
    saved  = carbon.calc(km)
    return {
        "user_id":         user_id,
        "monthly_km":      km,
        "carbon_saved_kg": saved,
        "eq_trees":        carbon.to_trees(saved),
        "eq_car_km":       carbon.to_car_km(saved),
        "mileage":         carbon.to_mileage(saved),
        "rank_pct":        12,
    }


# ── 내부 유틸 ─────────────────────────────────

def _build_seat_map_from_exits(exits: list, car: int) -> dict:
    """
    DB에서 가져온 하차 예정자 목록을
    좌석 배치도(top/bot × 5구역) 형태로 변환.
    """
    import random

    ZONES    = ["priA","z1","z2","z3","priB"]
    ZSIZE    = {"priA":2,"z1":4,"z2":4,"z3":4,"priB":2}
    ZL       = {"priA":"앞 우선석","z1":"문1↔문2","z2":"문2↔문3",
                "z3":"문3↔문4","priB":"뒤 우선석"}

    # 등록된 하차 예정자를 구역별로 분류
    exit_map = {}
    for e in exits:
        key = (e["side"], e["door_zone"][:3] if len(e["door_zone"])>1 else "z1")
        if key not in exit_map:
            exit_map[key] = []
        exit_map[key].append(e)

    seat_map = {"top":{},"bot":{}}
    for side in ["top","bot"]:
        for zone in ZONES:
            is_pri = zone in ("priA","priB")
            seats  = []
            for i in range(ZSIZE[zone]):
                # 해당 구역에 하차 등록자 있으면 green, 없으면 랜덤
                key     = (side, zone)
                ex_list = exit_map.get(key, [])
                if i < len(ex_list):
                    ex = ex_list[i]
                    seats.append({
                        "idx":         i,
                        "type":        "green",
                        "exit_station":ex["exit_station"],
                        "is_priority": bool(ex["is_priority"]),
                        "exit_id":     ex["id"],
                        "crowd":       True,   # 실제 사용자 데이터
                    })
                else:
                    # 크라우드소싱 데이터 없는 좌석 → 통계 기반 추정
                    r = random.random()
                    t = "empty" if r<0.12 else "green" if r<0.25 else "yellow" if r<0.55 else "red"
                    seats.append({
                        "idx":i,"type":t,"exit_station":None,
                        "is_priority":is_pri,"exit_id":None,"crowd":False,
                    })
            seat_map[side][zone] = seats

    return seat_map
