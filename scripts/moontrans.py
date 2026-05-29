import json
import math
import numpy as np
import os

# 8개의 달 위상 파일명 (순서 중요)
datapath = "./dataset/moon/images"
datapath = os.path.abspath(datapath)
phases = [
    "moon_0.png", "moon_1.png", "moon_2.png", "moon_3.png",
    "moon_4.png", "moon_5.png", "moon_6.png", "moon_7.png"
]

NUM_CAMERAS_PER_RING = 60
RADIUS = 4.0
elevations_deg = [-85, -60, -30, -15, 0, 15, 30, 60, 85]

def get_lookat_matrix(eye, target=np.array([0, 0, 0]), up=np.array([0, 1, 0])):
    """카메라가 중심을 바라보도록 하는 회전/이동 행렬"""
    fwd = target - eye
    fwd = fwd / np.linalg.norm(fwd)
    right = np.cross(fwd, up)
    right = right / np.linalg.norm(right)
    new_up = np.cross(right, fwd)
    
    R = np.column_stack((right, new_up, -fwd))
    T = np.eye(4)
    T[:3, :3] = R
    T[:3, 3] = eye
    return T.tolist()

frames = []

for el_deg in elevations_deg:
    el_rad = math.radians(el_deg)
    for i in range(NUM_CAMERAS_PER_RING):
        az_rad = (i / NUM_CAMERAS_PER_RING) * (2 * math.pi)
        
        phase_idx = int(round((az_rad / (2 * math.pi)) * 8)) % 8
        image_name = phases[phase_idx]
        
        y = RADIUS * math.sin(el_rad)
        r_xz = RADIUS * math.cos(el_rad)
        x = r_xz * math.sin(az_rad)
        z = r_xz * math.cos(az_rad)
        
        eye_pos = np.array([x, y, z])
        transform_matrix = get_lookat_matrix(eye_pos)
        
        frames.append({
            "file_path": f"{datapath}/{image_name}",
            "transform_matrix": transform_matrix
        })

# ==========================================
# 🚨 [수정된 부분] 깐깐한 nerfstudio를 위한 카메라 파라미터 주입
# ==========================================
W, H = 800, 800             # 생성한 이모지 이미지 해상도
FOV = 0.85                  # 시야각 (카메라 화각)
FL = (W / 2) / math.tan(FOV / 2)  # 초점 거리(Focal Length) 자동 계산

transforms = {
    "w": W,
    "h": H,
    "fl_x": FL,
    "fl_y": FL,
    "cx": W / 2.0,
    "cy": H / 2.0,
    "camera_angle_x": FOV,
    "ply_file_path": "init_moon.ply",
    "frames": frames
}

with open("transforms.json", "w") as f:
    json.dump(transforms, f, indent=4)
    
print("✅ nerfstudio 맞춤형 transforms.json 생성 완료! 이제 에러 없이 돌아갑니다.")