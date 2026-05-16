"""탄소 절감량 계산 — 환경부 배출계수 기준"""

class CarbonCalculator:
    CAR    = 0.210   # 승용차 kg CO₂/km
    SUBWAY = 0.041   # 지하철 kg CO₂/km
    DIFF   = CAR - SUBWAY  # 0.169

    def calc(self, km: float) -> float:
        return round(km * self.DIFF, 3)

    def to_trees(self, kg: float) -> float:
        return round(kg / 10.8, 2)

    def to_car_km(self, kg: float) -> float:
        return round(kg / self.CAR, 1)

    def to_mileage(self, kg: float) -> int:
        return int(kg * 30)

carbon = CarbonCalculator()
