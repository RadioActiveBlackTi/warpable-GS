import math
import random

NUM_POINTS = 100000  # 🚨 10만 개로 10배 증가! (Splatfacto 권장 수준)
SPHERE_RADIUS = 1.5

with open("init_moon.ply", "w") as f:
    f.write("ply\n")
    f.write("format ascii 1.0\n")
    f.write(f"element vertex {NUM_POINTS}\n")
    f.write("property float x\n")
    f.write("property float y\n")
    f.write("property float z\n")
    f.write("property uchar red\n")
    f.write("property uchar green\n")
    f.write("property uchar blue\n")
    f.write("end_header\n")
    
    for _ in range(NUM_POINTS):
        # 🚨 [핵심 수정] 속 빈 껍질이 아니라 '속이 꽉 찬(Solid)' 구를 만듦
        # 구의 부피 전체에 균일하게 퍼지도록 세제곱근(1/3) 사용
        u = random.random()
        r = SPHERE_RADIUS * (u ** (1.0 / 3.0))
        
        phi = random.uniform(0, math.pi * 2)
        costheta = random.uniform(-1.0, 1.0)
        theta = math.acos(costheta)
        
        x = r * math.sin(theta) * math.cos(phi)
        y = r * math.sin(theta) * math.sin(phi)
        z = r * math.cos(theta)
        
        # 모델이 유연하게 깎아낼 수 있도록 완전한 단색보다는
        # 노이즈가 살짝 낀 중간 회색(Gray) 톤으로 초기화
        color = random.randint(100, 150)
        
        f.write(f"{x:.6f} {y:.6f} {z:.6f} {color} {color} {color}\n")

print("✅ 속이 꽉 찬(Solid Volume) 10만 개의 포인트 클라우드 생성 완료!")