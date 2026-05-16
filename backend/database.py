"""
SQLite 데이터베이스
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

테이블:
  users       사용자 (id, nickname, total_points, monthly_km)
  exits       하차 예정 등록 (핵심 데이터)
  seat_matches 착석 매칭 로그
  point_log   포인트 적립 이력
"""

import aiosqlite
import datetime
import os

DB_PATH = os.path.join(os.path.dirname(__file__), "binjari.db")


async def init_db():
    """앱 기동 시 테이블 생성"""
    async with aiosqlite.connect(DB_PATH) as db:
        await db.executescript("""
        CREATE TABLE IF NOT EXISTS users (
            user_id      TEXT PRIMARY KEY,
            nickname     TEXT NOT NULL DEFAULT '익명',
            total_points INTEGER NOT NULL DEFAULT 0,
            monthly_km   REAL    NOT NULL DEFAULT 0.0,
            created_at   TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
        );

        -- 핵심 테이블: 사용자가 직접 등록한 하차 예정 정보
        CREATE TABLE IF NOT EXISTS exits (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id     TEXT    NOT NULL,
            line        TEXT    NOT NULL,   -- "2" (2호선)
            station     TEXT    NOT NULL,   -- 현재 탑승 역
            car         INTEGER NOT NULL,   -- 호차 (1~10)
            door_zone   TEXT    NOT NULL,   -- "3-2" 도어 구역
            side        TEXT    NOT NULL,   -- "top" / "bot"
            exit_station TEXT   NOT NULL,   -- 하차 예정 역
            is_priority  INTEGER NOT NULL DEFAULT 0,  -- 교통약자 여부
            status      TEXT    NOT NULL DEFAULT 'active',
                                            -- active / exited / matched
            registered_at TEXT  NOT NULL DEFAULT (datetime('now','localtime')),
            exited_at     TEXT
        );

        -- 착석 매칭 로그
        CREATE TABLE IF NOT EXISTS seat_matches (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            exit_id      INTEGER NOT NULL REFERENCES exits(id),
            seeker_id    TEXT    NOT NULL,   -- 자리 찾는 사람
            matched_at   TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
            confirmed    INTEGER NOT NULL DEFAULT 0
        );

        -- 포인트 이력
        CREATE TABLE IF NOT EXISTS point_log (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id    TEXT    NOT NULL,
            action     TEXT    NOT NULL,   -- "exit_register" / "seat_match" / ...
            points     INTEGER NOT NULL,
            detail     TEXT,
            created_at TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
        );
        """)
        await db.commit()


# ── Users ──────────────────────────────────────

async def get_or_create_user(user_id: str, nickname: str = "익명") -> dict:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        await db.execute(
            "INSERT OR IGNORE INTO users (user_id, nickname) VALUES (?, ?)",
            (user_id, nickname)
        )
        await db.commit()
        async with db.execute(
            "SELECT * FROM users WHERE user_id = ?", (user_id,)
        ) as cur:
            row = await cur.fetchone()
            return dict(row)


async def add_points(user_id: str, points: int, action: str, detail: str = "") -> int:
    """포인트 적립 → 총합 반환"""
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "UPDATE users SET total_points = total_points + ? WHERE user_id = ?",
            (points, user_id)
        )
        await db.execute(
            "INSERT INTO point_log (user_id, action, points, detail) VALUES (?, ?, ?, ?)",
            (user_id, action, points, detail)
        )
        await db.commit()
        async with db.execute(
            "SELECT total_points FROM users WHERE user_id = ?", (user_id,)
        ) as cur:
            row = await cur.fetchone()
            return row[0] if row else 0


# ── Exits (하차 예정 등록) ─────────────────────

async def register_exit(
    user_id: str, line: str, station: str,
    car: int, door_zone: str, side: str,
    exit_station: str, is_priority: bool = False
) -> dict:
    """
    사용자가 하차 예정 정보를 직접 입력.
    이 데이터가 앱의 핵심 — 비콘 없이 크라우드소싱으로 수집.
    """
    async with aiosqlite.connect(DB_PATH) as db:
        cur = await db.execute(
            """INSERT INTO exits
               (user_id, line, station, car, door_zone, side, exit_station, is_priority)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (user_id, line, station, car, door_zone, side, exit_station, int(is_priority))
        )
        exit_id = cur.lastrowid
        await db.commit()

    # 하차 등록 포인트 +20
    total = await add_points(user_id, 20, "exit_register",
                             f"{line}호선 {car}호차 → {exit_station} 하차 등록")
    return {"exit_id": exit_id, "points_earned": 20, "total_points": total}


async def get_active_exits(station: str, car: int, line: str) -> list:
    """
    해당 역·호차에 탑승 중인 하차 예정자 목록.
    자리를 찾는 사람에게 보여주는 핵심 데이터.
    """
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            """SELECT e.*, u.nickname
               FROM exits e JOIN users u ON e.user_id = u.user_id
               WHERE e.line = ? AND e.station = ? AND e.car = ?
                 AND e.status = 'active'
               ORDER BY e.registered_at DESC""",
            (line, station, car)
        ) as cur:
            rows = await cur.fetchall()
            return [dict(r) for r in rows]


async def confirm_exit(exit_id: int, actual_station: str) -> dict:
    """실제 하차 완료 확인 → 추가 포인트"""
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM exits WHERE id = ?", (exit_id,)
        ) as cur:
            row = await cur.fetchone()
        if not row:
            return {"error": "등록 정보 없음"}

        await db.execute(
            "UPDATE exits SET status='exited', exited_at=datetime('now','localtime') WHERE id=?",
            (exit_id,)
        )
        await db.commit()

    bonus = 10  # 예고 하차 완료 보너스
    total = await add_points(row["user_id"], bonus, "exit_confirmed",
                             f"{actual_station} 실제 하차 완료")
    return {"points_earned": bonus, "total_points": total}


async def confirm_seat(exit_id: int, seeker_id: str) -> dict:
    """착석 확인 → 양측 포인트"""
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute("SELECT * FROM exits WHERE id=?", (exit_id,)) as cur:
            row = await cur.fetchone()
        if not row:
            return {"error": "없음"}

        await db.execute(
            "INSERT INTO seat_matches (exit_id, seeker_id, confirmed) VALUES (?,?,1)",
            (exit_id, seeker_id)
        )
        await db.execute("UPDATE exits SET status='matched' WHERE id=?", (exit_id,))
        await db.commit()

    # 착석 성공 포인트
    seeker_total = await add_points(seeker_id, 10, "seat_confirmed", "착석 성공")
    return {"seeker_points": 10, "seeker_total": seeker_total}


# ── Point log ──────────────────────────────────

async def get_point_log(user_id: str, limit: int = 10) -> list:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            """SELECT action, points, detail, created_at
               FROM point_log WHERE user_id=?
               ORDER BY created_at DESC LIMIT ?""",
            (user_id, limit)
        ) as cur:
            rows = await cur.fetchall()
            return [dict(r) for r in rows]
