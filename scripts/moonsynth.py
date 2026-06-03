import os
import json
import math
import random
import urllib.request
import ssl
import time
from PIL import Image
from io import BytesIO
import socket
import numpy as np

# ==========================================
# 1. Global Configurations
# ==========================================
ssl._create_default_https_context = ssl._create_unverified_context
socket.setdefaulttimeout(10)

DATASET_DIR = "dataset/moon" # May modify this path as needed
IMAGES_DIR = os.path.join(DATASET_DIR, "images")
PLY_FILENAME = os.path.join(DATASET_DIR, "init_moon.ply")
TRANSFORMS_FILENAME = os.path.join(DATASET_DIR, "transforms.json")

SQUARE_SIZE = 800
MAX_RETRIES = 3

CODE_FACE_FULL = "1f31d"  # 🌝 얼굴 (데칼용)
CODE_BASE_FULL = "1f315"  # 🌕 베이스 달 (크레이터 매핑용)

os.makedirs(IMAGES_DIR, exist_ok=True)

COLOR_BRIGHT = np.array([255, 230, 150], dtype=np.float32)
COLOR_DARK   = np.array([80, 85, 95], dtype=np.float32)

# ==========================================
# 2. Blending Texture
# ==========================================
def download_emoji(code):
    url = f"https://raw.githubusercontent.com/googlefonts/noto-emoji/main/png/512/emoji_u{code}.png"
    for attempt in range(MAX_RETRIES):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
            with urllib.request.urlopen(req) as response:
                img = Image.open(BytesIO(response.read())).convert("RGBA")
                img = img.resize((SQUARE_SIZE, SQUARE_SIZE), Image.Resampling.LANCZOS)
                canvas = Image.new("RGBA", (SQUARE_SIZE, SQUARE_SIZE), (0, 0, 0, 0))
                canvas.paste(img, (0, 0), img)
                return np.array(canvas)
        except Exception as e:
            time.sleep(2)
    raise Exception(f"Download Failed: {code}")

print("Step 1: Downloading and Processing Emoji Textures...")
arr_face = download_emoji(CODE_FACE_FULL)
arr_base = download_emoji(CODE_BASE_FULL)

face_rgb = arr_face[:, :, :3].astype(np.float32)
base_rgb = arr_base[:, :, :3].astype(np.float32)

luma_base = np.dot(base_rgb, [0.299, 0.587, 0.114]) / 255.0
luma_face = np.dot(face_rgb, [0.299, 0.587, 0.114]) / 255.0

valid_mask = arr_base[:, :, 3] > 10
avg_luma = np.mean(luma_base[valid_mask])
luma_base[~valid_mask] = avg_luma
crater_tex = np.stack([luma_base, luma_base, luma_base], axis=-1)

y_idx, x_idx = np.indices((SQUARE_SIZE, SQUARE_SIZE))
dist = np.sqrt((x_idx - SQUARE_SIZE/2)**2 + (y_idx - SQUARE_SIZE/2)**2)
max_dist = SQUARE_SIZE * 0.35

radial_mask = np.clip(1.0 - (dist / max_dist), 0.0, 1.0)
radial_mask = radial_mask * radial_mask * (3 - 2 * radial_mask) 

diff = np.linalg.norm(face_rgb - base_rgb, axis=-1)
face_alpha_raw = np.clip((diff - 5) / 25.0, 0.0, 1.0)

face_alpha = face_alpha_raw * radial_mask
face_shade_ratio = (luma_face + 1e-5) / (luma_base + 1e-5)

# ==========================================
# 3. 3D Ray Tracing + Rendering
# ==========================================
print("\nStep 2: Seamless Rendering...")

def get_lookat_matrix(eye, target=np.array([0, 0, 0]), up=np.array([0, 1, 0])):
    fwd = target - eye
    fwd = fwd / np.linalg.norm(fwd)
    right = np.cross(fwd, up)
    if np.linalg.norm(right) < 1e-6:
        right = np.array([1.0, 0.0, 0.0])
    right = right / np.linalg.norm(right)
    new_up = np.cross(right, fwd)
    T = np.eye(4)
    T[:3, :3] = np.column_stack((right, new_up, -fwd))
    T[:3, 3] = eye
    return T

NUM_CAMERAS_PER_RING = 60
RADIUS = 4.0
ELEVATIONS_DEG = [-85, -60, -30, -15, 0, 15, 30, 60, 85]
SPHERE_RADIUS = 1.5

W, H = SQUARE_SIZE, SQUARE_SIZE
FOV = 0.85
FL = (W / 2) / math.tan(FOV / 2)

u_grid, v_grid = np.meshgrid(np.arange(W), np.arange(H))
x_c = (u_grid - W / 2) / FL
y_c = -(v_grid - H / 2) / FL
z_c = -np.ones_like(x_c)
rays_c = np.stack([x_c, y_c, z_c], axis=-1)
rays_c = rays_c / np.linalg.norm(rays_c, axis=-1, keepdims=True)

frames = []
frame_idx = 0
total_frames = len(ELEVATIONS_DEG) * NUM_CAMERAS_PER_RING

for el_deg in ELEVATIONS_DEG:
    el_rad = math.radians(el_deg)
    for i in range(NUM_CAMERAS_PER_RING):
        az_rad = (i / NUM_CAMERAS_PER_RING) * (2 * math.pi)
        
        x = RADIUS * math.cos(el_rad) * math.sin(az_rad)
        y = RADIUS * math.sin(el_rad)
        z = RADIUS * math.cos(el_rad) * math.cos(az_rad)
        
        eye_pos = np.array([x, y, z])
        T_mat = get_lookat_matrix(eye_pos)
        R_mat = T_mat[:3, :3]
        
        rays_w = rays_c @ R_mat.T
        b = 2.0 * np.sum(eye_pos * rays_w, axis=-1)
        c = np.sum(eye_pos**2) - SPHERE_RADIUS**2
        delta = b**2 - 4 * c
        hit_mask = delta > 0
        
        out_img = np.zeros((H, W, 4), dtype=np.uint8)
        
        if np.any(hit_mask):
            t = (-b[hit_mask] - np.sqrt(delta[hit_mask])) / 2.0
            hit_points = eye_pos + t[:, None] * rays_w[hit_mask]
            
            nx = hit_points[:, 0] / SPHERE_RADIUS
            ny = hit_points[:, 1] / SPHERE_RADIUS
            nz = hit_points[:, 2] / SPHERE_RADIUS
            
            # Mirror-relfection Base Moon Texture
            scale_base = 0.90
            u_base = 0.5 + 0.5 * nx * scale_base
            v_base = 0.5 - 0.5 * ny * scale_base
            
            ix_b = np.clip(u_base * (W - 1), 0, W - 1).astype(np.int32)
            iy_b = np.clip(v_base * (H - 1), 0, H - 1).astype(np.int32)
            
            # --- 🌓 반달 명암 적용 ---
            blend_factor = np.clip((nx + 0.1) / 0.2, 0.0, 1.0)
            base_colors = COLOR_DARK * (1.0 - blend_factor[:, None]) + COLOR_BRIGHT * blend_factor[:, None]
            
            base_crater = crater_tex[iy_b, ix_b]
            final_rgb = base_colors * base_crater
            
            # --- 🌝 부드럽게 스며든 얼굴 데칼 ---
            FACE_SCALE = 1.35
            u_face = 0.5 + 0.5 * nx * FACE_SCALE
            v_face = 0.5 - 0.5 * ny * FACE_SCALE
            
            valid_face = (u_face >= 0.0) & (u_face <= 1.0) & (v_face >= 0.0) & (v_face <= 1.0) & (nz > 0.2)
            
            ix_f = np.clip(u_face * (W - 1), 0, W - 1).astype(np.int32)
            iy_f = np.clip(v_face * (H - 1), 0, H - 1).astype(np.int32)
            
            alpha = np.zeros(len(nx), dtype=np.float32)
            alpha[valid_face] = face_alpha[iy_f[valid_face], ix_f[valid_face]]
            
            shade = np.zeros(len(nx), dtype=np.float32)
            shade[valid_face] = face_shade_ratio[iy_f[valid_face], ix_f[valid_face]]
            shade_3c = np.stack([shade, shade, shade], axis=-1)
            
            face_applied_rgb = final_rgb * ((1.0 - alpha[:, None]) + shade_3c * alpha[:, None])
            
            colors_rgba = np.zeros((len(nx), 4), dtype=np.uint8)
            colors_rgba[:, :3] = np.clip(face_applied_rgb, 0, 255).astype(np.uint8)
            colors_rgba[:, 3] = 255
            
            out_img[hit_mask] = colors_rgba
            
        image_name = f"render_{frame_idx:04d}.png"
        Image.fromarray(out_img).save(os.path.join(IMAGES_DIR, image_name))
        
        frames.append({
            "file_path": f"images/{image_name}",
            "transform_matrix": T_mat.tolist()
        })
        frame_idx += 1
        print(f"\rProgress: {frame_idx} / {total_frames} frames completed", end="")

# ==========================================
# 4. JSON 및 PLY 볼륨 생성
# ==========================================
print("\n\nStep 3: Generating JSON and PLY Volume...")
transforms = {
    "w": W, "h": H, "fl_x": FL, "fl_y": FL,
    "cx": W / 2.0, "cy": H / 2.0,
    "camera_angle_x": FOV,
    "ply_file_path": "init_moon.ply",
    "frames": frames
}

with open(TRANSFORMS_FILENAME, "w") as f:
    json.dump(transforms, f, indent=4)

NUM_POINTS = 100000
with open(PLY_FILENAME, "w") as f:
    f.write(f"ply\nformat ascii 1.0\nelement vertex {NUM_POINTS}\n")
    f.write("property float x\nproperty float y\nproperty float z\n")
    f.write("property uchar red\nproperty uchar green\nproperty uchar blue\nend_header\n")
    for _ in range(NUM_POINTS):
        r = SPHERE_RADIUS * (random.random() ** (1.0 / 3.0))
        phi, theta = random.uniform(0, math.pi * 2), math.acos(random.uniform(-1.0, 1.0))
        x, y, z = r * math.sin(theta) * math.cos(phi), r * math.sin(theta) * math.sin(phi), r * math.cos(theta)
        c = random.randint(100, 150)
        f.write(f"{x:.6f} {y:.6f} {z:.6f} {c} {c} {c}\n")

print("Completed Generation.")