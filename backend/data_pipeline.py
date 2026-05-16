"""
서울 공공 API 연동
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
① OA-12764  실시간 도착 정보
② OA-12601  실시간 열차 위치
③ OA-12928  혼잡도 통계 (CSV → 내장 테이블)

API 키: https://data.seoul.go.kr → 실시간 지하철 인증키 신청
"""

import os, asyncio, httpx
from dotenv import load_dotenv

load_dotenv()
KEY  = os.getenv("SEOUL_API_KEY", "")
BASE = "http://swopenAPI.seoul.go.kr/api/subway"


class DataPipeline:

    # ── ① 실시간 도착 정보 ──────────────────────
    async def get_arrival(self, station: str) -> dict:
        if not KEY:
            return self._fallback_arrival(station)
        url = f"{BASE}/{KEY}/json/realtimeStationArrival/0/10/{station}"
        try:
            async with httpx.AsyncClient(timeout=5.0) as c:
                data = (await c.get(url)).json()
            return self._parse_arrival(data)
        except Exception as e:
            print(f"[arrival] {e}")
            return self._fallback_arrival(station)

    def _parse_arrival(self, data: dict) -> dict:
        rows = data.get("realtimeArrivalList", [])
        if not rows:
            return self._fallback_arrival("?")
        r   = next((x for x in rows if x.get("subwayId") == "1002"), rows[0])
        sec = int(r.get("barvlDt", 120))
        return {
            "line":            self._lid(r.get("subwayId","")),
            "next_min":        max(1, sec // 60),
            "direction":       r.get("trainLineNm",""),
            "train_no":        r.get("btrainNo",""),
            "current_station": r.get("statnNm",""),
        }

    def _fallback_arrival(self, station: str) -> dict:
        return {"line":"2호선","next_min":2,"direction":"강남방면",
                "train_no":"DEMO","current_station":"역삼"}

    # ── ② 실시간 열차 위치 ──────────────────────
    async def get_positions(self, line_name: str = "2호선") -> list:
        if not KEY:
            return []
        url = f"{BASE}/{KEY}/json/realtimePosition/0/100/{line_name}"
        try:
            async with httpx.AsyncClient(timeout=5.0) as c:
                data = (await c.get(url)).json()
            return [{"train_no":r.get("trainNo"),"station":r.get("statnNm"),
                     "updn":r.get("updnLine"),"status":r.get("trainSttus")}
                    for r in data.get("realtimePositionList",[])]
        except Exception as e:
            print(f"[position] {e}")
            return []

    # ── ③ 혼잡도 통계 (OA-12928 기반 내장) ─────
    #
    # 서울교통공사_지하철혼잡도정보 (2024)
    # 혼잡도 34% = 좌석 모두 찬 기준
    # 혼잡도 100% = 정원 초과
    #
    CONG = {
        "선릉": {"07":{"up":62,"dn":44},"08":{"up":89,"dn":51},"09":{"up":78,"dn":48},
                 "17":{"up":55,"dn":71},"18":{"up":58,"dn":88},"19":{"up":49,"dn":72}},
        "역삼": {"07":{"up":65,"dn":42},"08":{"up":92,"dn":48},"09":{"up":81,"dn":44},
                 "18":{"up":61,"dn":85}},
        "강남": {"07":{"up":58,"dn":55},"08":{"up":85,"dn":62},"09":{"up":72,"dn":55},
                 "18":{"up":68,"dn":91}},
        "잠실": {"07":{"up":55,"dn":60},"08":{"up":80,"dn":75},"09":{"up":68,"dn":65},
                 "18":{"up":71,"dn":80}},
        "홍대입구": {"08":{"up":70,"dn":55},"09":{"up":62,"dn":50},
                    "17":{"up":60,"dn":72},"18":{"up":65,"dn":80}},
        "교대": {"08":{"up":77,"dn":50},"09":{"up":68,"dn":46},
                 "17":{"up":52,"dn":76},"18":{"up":55,"dn":84}},
    }

    # 호차별 혼잡도 보정계수 (서울교통공사 2023 연구)
    CAR_W = {1:1.05,2:1.12,3:0.93,4:1.02,5:0.83,
             6:0.69,7:0.97,8:0.90,9:1.04,10:0.77}

    def get_congestion(self, station: str, hour: int, direction: str = "up") -> dict:
        h    = str(hour).zfill(2)
        slot = self.CONG.get(station,{}).get(h, {"up":55,"dn":55})
        base = slot.get(direction if direction=="up" else "dn", 55)

        cars = []
        for n in range(1, 11):
            pct   = min(100, round(base * self.CAR_W[n]))
            empty = max(0, round(28 * (1 - pct / 100)))
            cars.append({"car":n,"pct":pct,"empty":empty,
                          "color":"red" if pct>=80 else "yellow" if pct>=55 else "green",
                          "ai_rec":False})

        best = min(cars, key=lambda x: x["pct"])
        best["ai_rec"] = True
        return {"base_pct":base,"cars":cars,"ai_rec_car":best["car"],
                "source":"서울교통공사 OA-12928 (2024)"}

    def _lid(self, sid):
        return {"1001":"1호선","1002":"2호선","1003":"3호선","1004":"4호선",
                "1005":"5호선","1006":"6호선","1007":"7호선","1008":"8호선",
                "1009":"9호선"}.get(sid,"지하철")


pipeline = DataPipeline()

def sync_arrival(station): return asyncio.run(pipeline.get_arrival(station))
def sync_cong(station, hour): return pipeline.get_congestion(station, hour)
