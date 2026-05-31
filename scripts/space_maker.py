import argparse
import struct
import os
import numpy as np
from tqdm import tqdm


SH_C0 = 0.28209479177387814

# 명령어 모음

# python space_maker.py                  \ 
#   --output stars_with_cosmic_dust.ply  \ output 이름
#   --radius 8.0                         \ 우주 공간 반지름
#   --seed 7                             \ 

#   --stars 2200                         \ 천구에 붙어있는 별 개수 (이하 천구별)
#   --star-density-bias uniform          \ 천구별의 분포 (uniform/milky)
#   --star-min-scale 0.002               \ 천구별의 최소 크기
#   --star-max-scale 0.008               \ 천구별의 최대 크기
#   --star-opacity-min 0.86              \ 천구별의 min opacity
#   --star-opacity-max 0.99              \ 천구별의 max opacity

#   --dust-candidates 25000              \ 우주면지의 후보 개수 (실제 개수는 threshold에 의해 결정)
#   --dust-threshold 0.62                \ threshold가 높을수록 듬성듬성해짐
#   --dust-density-power 1.8             \ 높을수록 강한 noise 영역만 선택적으로 남음
#   --dust-opacity-min 0.012             \ 우주먼지 min opacity
#   --dust-opacity-max 0.045             \ 우주먼지 max opacity
#   --dust-min-scale 0.020               \ 우주먼지 최소 크기
#   --dust-max-scale 0.120               \ 우주먼지 최대 크기
#   --dust-brightness-min 0.18           \ 우주먼지 최소 밝기
#   --dust-brightness-max 0.55           \ 우주먼지 최대 밝기

#   --inner-stars 50                     \ 우주 공간 내부에 존재하는 별의 개수 (이하 내부별)
#   --inner-star-radius-min-factor 0.18  \ 내부별이 배치될 최소 거리 비율
#   --inner-star-radius-max-factor 0.82  \ 내부별이 배치될 최대 거리 비율 (즉, 우주 공간 반지름의 0.18~0.82 구간에서만 생성됨)
#   --inner-star-scale-multiplier 2.0    \ 천구별 대비 내부별 크기 배율
#   --inner-star-opacity-min 0.70        \ 내부별 min opacity
#   --inner-star-opacity-max 0.96        \ 내부별 max opacity

#   --planets 10                         \ 행성 개수
#   --planet-radius-min 0.12             \ 행성 최소 반지름
#   --planet-radius-max 0.34             \ 행성 최대 반지름
#   --planet-distance-min-factor 0.52    \ 행성이 배치될 최소 거리 비율
#   --planet-distance-max-factor 0.82    \ 행성이 배치될 최대 거리 비율
#   --planet-splats-min 1800             \ 행성 하나당 표면 splat 최소 개수
#   --planet-splats-max 3200             \ 행성 하나당 표면 splat 최대 개수
#   --ringed-planet-ratio 0.45             고리형 행성 비율


def rgb_to_sh_dc(rgb: np.ndarray) -> np.ndarray:
    """
    RGB 0~1 값을 3DGS f_dc_* 값으로 변환.
    """
    return (rgb - 0.5) / SH_C0


def inverse_sigmoid(x: np.ndarray) -> np.ndarray:
    """
    3DGS opacity raw value.
    """
    x = np.clip(x, 1e-6, 1.0 - 1e-6)
    return np.log(x / (1.0 - x))


def make_random_star_splats(
    n_stars: int,
    radius: float,
    seed: int,
    star_radius_factor: float,
    star_min_scale: float,
    star_max_scale: float,
    star_opacity_min: float,
    star_opacity_max: float,
    star_density_bias: str = "uniform",
):
    """
    구 내부 표면 근처에 작고 선명한 별 splat 생성.

    star_density_bias:
        uniform: 전천구 균일 분포
        milky: 일부 별을 은하수 띠처럼 특정 band 근처에 더 많이 배치
    """
    rng = np.random.default_rng(seed)

    if star_density_bias == "uniform":
        y_rand = rng.uniform(-1.0, 1.0, size=n_stars).astype(np.float32)

    elif star_density_bias == "milky":
        mix = rng.random(n_stars)

        y_uniform = rng.uniform(-1.0, 1.0, size=n_stars)
        y_band = rng.normal(0.0, 0.20, size=n_stars)
        y_band = np.clip(y_band, -1.0, 1.0)

        y_rand = np.where(mix < 0.65, y_uniform, y_band).astype(np.float32)

    else:
        raise ValueError("star_density_bias must be 'uniform' or 'milky'")

    theta = rng.uniform(0.0, 2.0 * np.pi, size=n_stars).astype(np.float32)

    r = np.sqrt(np.maximum(0.0, 1.0 - y_rand * y_rand))
    x = r * np.cos(theta)
    y = y_rand
    z = r * np.sin(theta)

    dirs = np.stack([x, y, z], axis=1).astype(np.float32)
    dirs = dirs / (np.linalg.norm(dirs, axis=1, keepdims=True) + 1e-8)

    points = dirs * (radius * star_radius_factor)

    palette = np.array(
        [
            [1.00, 1.00, 1.00],  # white
            [0.92, 0.96, 1.00],  # cool white
            [1.00, 0.90, 0.60],  # pale yellow
            [1.00, 0.76, 0.35],  # warm yellow
            [0.70, 0.82, 1.00],  # pale blue
            [0.45, 0.62, 1.00],  # blue
        ],
        dtype=np.float32,
    )

    probs = np.array([0.50, 0.18, 0.12, 0.06, 0.10, 0.04], dtype=np.float64)
    probs = probs / probs.sum()

    color_idx = rng.choice(len(palette), size=n_stars, p=probs)
    colors = palette[color_idx].copy()

    intensity = rng.lognormal(
        mean=np.log(0.85),
        sigma=0.32,
        size=n_stars,
    ).astype(np.float32)

    intensity = np.clip(intensity, 0.35, 1.35)
    colors = np.clip(colors * intensity[:, None], 0.0, 1.0).astype(np.float32)

    size = rng.lognormal(
        mean=np.log((star_min_scale + star_max_scale) * 0.5),
        sigma=0.35,
        size=n_stars,
    ).astype(np.float32)

    size = np.clip(size, star_min_scale, star_max_scale)

    # 극소수의 별만 살짝 크게
    rare = rng.random(n_stars) < 0.02
    size[rare] *= rng.uniform(1.3, 2.0, size=rare.sum()).astype(np.float32)
    size = np.clip(size, star_min_scale, star_max_scale * 2.0)

    scales = np.stack([size, size, size], axis=1).astype(np.float32)

    opacities = rng.uniform(
        star_opacity_min,
        star_opacity_max,
        size=n_stars,
    ).astype(np.float32)

    rotations = np.zeros((n_stars, 4), dtype=np.float32)
    rotations[:, 0] = 1.0

    return (
        points.astype(np.float32),
        colors.astype(np.float32),
        opacities.astype(np.float32),
        scales.astype(np.float32),
        rotations.astype(np.float32),
    )


def make_sparse_cosmic_dust_splats(
    n_candidates: int,
    radius: float,
    seed: int,
    dust_radius_factor: float = 0.986,
    threshold: float = 0.62,
    density_power: float = 1.8,
    dust_opacity_min: float = 0.012,
    dust_opacity_max: float = 0.045,
    dust_min_scale: float = 0.020,
    dust_max_scale: float = 0.120,
    dust_brightness_min: float = 0.18,
    dust_brightness_max: float = 0.55,
):
    """
    구 전체에 넓고 듬성듬성 퍼진 알록달록한 우주 가스/먼지 layer.

    n_candidates:
        후보 splat 수.
        noise mask로 일부만 남기므로 실제 dust splat 수는 이보다 적음.

    threshold:
        높을수록 더 듬성듬성해짐.
        추천: 0.58 ~ 0.72

    density_power:
        높을수록 밝은 noise 영역만 더 강하게 남음.
    """
    rng = np.random.default_rng(seed + 3000)

    # 전천구 균일 방향 후보
    y = rng.uniform(-1.0, 1.0, size=n_candidates).astype(np.float32)
    theta = rng.uniform(0.0, 2.0 * np.pi, size=n_candidates).astype(np.float32)

    r = np.sqrt(np.maximum(0.0, 1.0 - y * y))
    x = r * np.cos(theta)
    z = r * np.sin(theta)

    dirs = np.stack([x, y, z], axis=1).astype(np.float32)
    dirs = dirs / (np.linalg.norm(dirs, axis=1, keepdims=True) + 1e-8)

    # 저주파 noise-like mask.
    # 완전 랜덤이 아니라 넓은 영역에 듬성듬성 먼지가 분포하는 느낌.
    noise = (
        0.45 * np.sin(3.0 * dirs[:, 0] + 1.7)
        + 0.35 * np.sin(4.0 * dirs[:, 1] - 0.9)
        + 0.30 * np.sin(5.0 * dirs[:, 2] + 2.4)
        + 0.20 * np.sin(7.0 * (dirs[:, 0] + dirs[:, 2]))
        + 0.18 * np.sin(9.0 * (dirs[:, 0] - 0.5 * dirs[:, 1]))
    )

    noise = (noise - noise.min()) / (noise.max() - noise.min() + 1e-8)

    keep_prob = np.clip((noise - threshold) / (1.0 - threshold), 0.0, 1.0)
    keep_prob = keep_prob ** density_power

    keep = rng.random(n_candidates) < keep_prob

    dirs = dirs[keep]
    noise = noise[keep]

    n = dirs.shape[0]

    points = dirs * (radius * dust_radius_factor)

    palette = np.array(
        [
            [0.45, 0.18, 0.90],  # deep purple
            [0.20, 0.38, 1.00],  # blue
            [0.10, 0.75, 0.70],  # cyan green
            [0.95, 0.25, 0.70],  # pink magenta
            [0.35, 0.95, 0.45],  # soft green
            [0.70, 0.35, 1.00],  # violet
            [0.25, 0.80, 1.00],  # cyan blue
        ],
        dtype=np.float32,
    )

    color_idx = rng.integers(0, len(palette), size=n)
    colors = palette[color_idx].copy()

    brightness = rng.uniform(
        dust_brightness_min,
        dust_brightness_max,
        size=(n, 1),
    ).astype(np.float32)

    colors = colors * brightness

    # noise가 강한 영역은 조금 더 색이 살아나게 함
    colors *= (0.65 + 0.55 * noise[:, None]).astype(np.float32)
    colors = np.clip(colors, 0.0, 1.0).astype(np.float32)

    opacities = rng.uniform(
        dust_opacity_min,
        dust_opacity_max,
        size=n,
    ).astype(np.float32)

    size = rng.lognormal(
        mean=np.log((dust_min_scale + dust_max_scale) * 0.5),
        sigma=0.45,
        size=n,
    ).astype(np.float32)

    size = np.clip(size, dust_min_scale, dust_max_scale)

    # 너무 균일하지 않도록 일부는 살짝 작게/크게
    small = rng.random(n) < 0.25
    size[small] *= rng.uniform(0.45, 0.80, size=small.sum()).astype(np.float32)

    large = rng.random(n) < 0.08
    size[large] *= rng.uniform(1.2, 1.8, size=large.sum()).astype(np.float32)

    size = np.clip(size, dust_min_scale * 0.5, dust_max_scale * 1.8)

    scales = np.stack([size, size, size], axis=1).astype(np.float32)

    rotations = np.zeros((n, 4), dtype=np.float32)
    rotations[:, 0] = 1.0

    return (
        points.astype(np.float32),
        colors.astype(np.float32),
        opacities.astype(np.float32),
        scales.astype(np.float32),
        rotations.astype(np.float32),
    )


def _normalize(v: np.ndarray) -> np.ndarray:
    return v / (np.linalg.norm(v) + 1e-8)


def _random_unit_vector(rng: np.random.Generator) -> np.ndarray:
    v = rng.normal(0.0, 1.0, size=3).astype(np.float32)
    return _normalize(v).astype(np.float32)


def _orthonormal_basis_from_normal(normal: np.ndarray):
    """
    normal 방향을 기준으로 서로 직교하는 tangent basis 2개 생성.
    ring plane이나 planet local coordinate에 사용.
    """
    n = _normalize(normal.astype(np.float32))
    helper = np.array([0.0, 1.0, 0.0], dtype=np.float32)
    if abs(float(np.dot(n, helper))) > 0.90:
        helper = np.array([1.0, 0.0, 0.0], dtype=np.float32)

    u = np.cross(n, helper)
    u = _normalize(u).astype(np.float32)
    v = np.cross(n, u)
    v = _normalize(v).astype(np.float32)
    return u, v, n


def make_inner_star_splats(
    n_stars: int,
    radius: float,
    seed: int,
    inner_radius_min_factor: float,
    inner_radius_max_factor: float,
    star_min_scale: float,
    star_max_scale: float,
    scale_multiplier: float = 2.0,
    opacity_min: float = 0.70,
    opacity_max: float = 0.96,
):
    """
    우주 구 표면이 아니라 내부 공간에 떠 있는 작은 별 splat 생성.
    기존 표면 별보다 scale_multiplier 배 크게 만든다.
    """
    rng = np.random.default_rng(seed + 9000)

    dirs = rng.normal(0.0, 1.0, size=(n_stars, 3)).astype(np.float32)
    dirs = dirs / (np.linalg.norm(dirs, axis=1, keepdims=True) + 1e-8)

    # 너무 중심에 몰리지 않도록 r^3 uniform 대신 살짝 균일한 shell 분포를 사용
    r = rng.uniform(
        radius * inner_radius_min_factor,
        radius * inner_radius_max_factor,
        size=(n_stars, 1),
    ).astype(np.float32)
    points = dirs * r

    palette = np.array(
        [
            [1.00, 0.98, 0.88],
            [0.88, 0.94, 1.00],
            [1.00, 0.82, 0.45],
            [0.62, 0.74, 1.00],
            [0.95, 0.95, 1.00],
        ],
        dtype=np.float32,
    )
    probs = np.array([0.42, 0.22, 0.14, 0.10, 0.12], dtype=np.float64)
    probs = probs / probs.sum()

    color_idx = rng.choice(len(palette), size=n_stars, p=probs)
    colors = palette[color_idx].copy()
    intensity = rng.uniform(0.55, 1.00, size=(n_stars, 1)).astype(np.float32)
    colors = np.clip(colors * intensity, 0.0, 1.0).astype(np.float32)

    base_mean = (star_min_scale + star_max_scale) * 0.5 * scale_multiplier
    size = rng.lognormal(mean=np.log(base_mean), sigma=0.28, size=n_stars).astype(np.float32)
    size = np.clip(
        size,
        star_min_scale * scale_multiplier,
        star_max_scale * scale_multiplier,
    )
    scales = np.stack([size, size, size], axis=1).astype(np.float32)

    opacities = rng.uniform(opacity_min, opacity_max, size=n_stars).astype(np.float32)

    rotations = np.zeros((n_stars, 4), dtype=np.float32)
    rotations[:, 0] = 1.0

    return points, colors, opacities, scales, rotations


def _planet_surface_colors(
    local_dirs: np.ndarray,
    rng: np.random.Generator,
    base_color: np.ndarray,
    pattern: str,
    brightness: float,
) -> np.ndarray:
    """
    단색 / 줄무늬 / 비정형 무늬 행성 색 생성.
    local_dirs[:, 1]을 위도 방향으로 간주한다.
    """
    n = local_dirs.shape[0]
    colors = np.tile(base_color[None, :], (n, 1)).astype(np.float32)

    if pattern == "solid":
        noise = rng.normal(0.0, 0.018, size=(n, 1)).astype(np.float32)
        colors *= 1.0 + noise

    elif pattern == "striped":
        lat = local_dirs[:, 1]
        bands = (
            0.16 * np.sin(lat * 18.0 + rng.uniform(0.0, 2.0 * np.pi))
            + 0.08 * np.sin(lat * 41.0 + rng.uniform(0.0, 2.0 * np.pi))
        ).astype(np.float32)
        band_tint = np.array([1.05, 0.96, 0.82], dtype=np.float32)
        colors = colors * (1.0 + bands[:, None])
        colors = colors * (0.88 + 0.22 * band_tint[None, :])
        colors += rng.normal(0.0, 0.014, size=colors.shape).astype(np.float32)

    elif pattern == "irregular":
        x, y, z = local_dirs[:, 0], local_dirs[:, 1], local_dirs[:, 2]
        noise = (
            0.35 * np.sin(4.0 * x + 1.3)
            + 0.30 * np.sin(5.5 * y - 0.7)
            + 0.28 * np.sin(6.5 * z + 2.1)
            + 0.20 * np.sin(9.0 * (x + 0.7 * z))
        )
        noise = (noise - noise.min()) / (noise.max() - noise.min() + 1e-8)
        tint = rng.uniform(0.88, 1.18, size=(1, 3)).astype(np.float32)
        colors = colors * (0.82 + 0.34 * noise[:, None]) * tint
        colors += rng.normal(0.0, 0.016, size=colors.shape).astype(np.float32)

    else:
        raise ValueError("pattern must be 'solid', 'striped', or 'irregular'")

    colors = np.clip(colors * brightness, 0.0, 0.88).astype(np.float32)
    return colors


def make_planet_splats(
    n_planets: int,
    radius: float,
    seed: int,
    planet_radius_min: float,
    planet_radius_max: float,
    planet_distance_min_factor: float,
    planet_distance_max_factor: float,
    planet_splats_min: int,
    planet_splats_max: int,
    ringed_ratio: float,
):
    """
    우주 공간 내부에 원형 행성/고리형 행성을 procedural 3DGS splat으로 생성.

    - 너무 밝지 않게 전체 brightness를 낮게 제한
    - solid / striped / irregular 패턴을 섞음
    - ringed_ratio 비율만큼 고리형 행성 생성
    """
    rng = np.random.default_rng(seed + 12000)

    # 행성은 우주 공간 반지름의 1/2 안쪽에 배치하지 않는다.
    # 사용자가 더 낮은 값을 넣어도 내부 중심부에는 생기지 않도록 강제로 보정한다.
    planet_distance_min_factor = max(float(planet_distance_min_factor), 0.50)
    planet_distance_max_factor = max(float(planet_distance_max_factor), planet_distance_min_factor + 0.02)

    # 너무 회색빛으로 죽지 않도록 기존보다 채도가 높은 팔레트.
    # 다만 전체 brightness/fake lighting으로 과하게 밝아지지는 않게 제한한다.
    planet_palettes = np.array(
        [
            [0.90, 0.56, 0.28],  # warm amber
            [0.32, 0.62, 0.92],  # clean blue
            [0.72, 0.38, 0.88],  # violet
            [0.34, 0.78, 0.52],  # emerald green
            [0.86, 0.36, 0.25],  # terracotta red
            [0.78, 0.70, 0.38],  # golden olive
            [0.30, 0.78, 0.82],  # cyan teal
            [0.82, 0.45, 0.66],  # rose
        ],
        dtype=np.float32,
    )
    patterns = ["solid", "striped", "irregular"]

    centers = []
    planet_radii = []

    # 간단한 rejection sampling으로 행성끼리 너무 겹치지 않게 배치
    for i in range(n_planets):
        pr = float(rng.uniform(planet_radius_min, planet_radius_max))
        for _ in range(200):
            direction = _random_unit_vector(rng)
            dist = float(rng.uniform(radius * planet_distance_min_factor, radius * planet_distance_max_factor))
            c = direction * dist
            ok = True
            for old_c, old_r in zip(centers, planet_radii):
                if np.linalg.norm(c - old_c) < (pr + old_r) * 3.2:
                    ok = False
                    break
            if ok:
                break
        centers.append(c.astype(np.float32))
        planet_radii.append(pr)

    all_points = []
    all_colors = []
    all_opacities = []
    all_scales = []
    all_rotations = []

    for i, (center, pr) in enumerate(zip(centers, planet_radii)):
        n_surface = int(rng.integers(planet_splats_min, planet_splats_max + 1))
        axis = _random_unit_vector(rng)
        u, v, n_axis = _orthonormal_basis_from_normal(axis)

        # 구 표면 균일 샘플링
        y = rng.uniform(-1.0, 1.0, size=n_surface).astype(np.float32)
        theta = rng.uniform(0.0, 2.0 * np.pi, size=n_surface).astype(np.float32)
        rr = np.sqrt(np.maximum(0.0, 1.0 - y * y))
        lx = rr * np.cos(theta)
        ly = y
        lz = rr * np.sin(theta)
        local_dirs = np.stack([lx, ly, lz], axis=1).astype(np.float32)

        # local x/y/z를 임의 basis에 매핑
        world_dirs = (
            local_dirs[:, 0:1] * u[None, :]
            + local_dirs[:, 1:2] * n_axis[None, :]
            + local_dirs[:, 2:3] * v[None, :]
        ).astype(np.float32)

        # 표면을 약간 두껍게 해서 얇은 껍데기 느낌 완화
        shell_jitter = rng.normal(0.0, pr * 0.010, size=(n_surface, 1)).astype(np.float32)
        points = center[None, :] + world_dirs * (pr + shell_jitter)

        base_color = planet_palettes[i % len(planet_palettes)].copy()
        pattern = patterns[i % len(patterns)]
        brightness = float(rng.uniform(0.62, 0.86))
        colors = _planet_surface_colors(local_dirs, rng, base_color, pattern, brightness)

        # 한쪽에 아주 약한 fake lighting. 너무 밝아지지 않게 낮게 유지.
        light_dir = _normalize(np.array([-0.35, 0.55, 0.75], dtype=np.float32))
        shade = np.clip(world_dirs @ light_dir, -1.0, 1.0)
        shade = (0.58 + 0.28 * np.maximum(shade, 0.0) - 0.10 * np.maximum(-shade, 0.0)).astype(np.float32)
        colors = np.clip(colors * shade[:, None], 0.0, 0.82).astype(np.float32)

        surf_scale = rng.uniform(pr * 0.055, pr * 0.095, size=n_surface).astype(np.float32)
        surf_scales = np.stack([surf_scale, surf_scale, surf_scale], axis=1).astype(np.float32)
        surf_opacities = rng.uniform(0.62, 0.90, size=n_surface).astype(np.float32)
        surf_rotations = np.zeros((n_surface, 4), dtype=np.float32)
        surf_rotations[:, 0] = 1.0

        all_points.append(points.astype(np.float32))
        all_colors.append(colors.astype(np.float32))
        all_opacities.append(surf_opacities)
        all_scales.append(surf_scales)
        all_rotations.append(surf_rotations)

        make_ring = rng.random() < ringed_ratio
        # n_planets가 작아도 최소 몇 개는 ringed가 나오도록 앞쪽 일부 강제
        if i < max(1, int(round(n_planets * ringed_ratio))):
            make_ring = True

        if make_ring:
            n_ring = max(420, int(n_surface * rng.uniform(0.50, 0.85)))
            inner = pr * rng.uniform(1.45, 1.75)
            outer = pr * rng.uniform(2.15, 2.90)
            ring_r = np.sqrt(rng.uniform(inner * inner, outer * outer, size=n_ring)).astype(np.float32)
            ring_theta = rng.uniform(0.0, 2.0 * np.pi, size=n_ring).astype(np.float32)
            thickness = rng.normal(0.0, pr * 0.025, size=n_ring).astype(np.float32)

            ring_dirs = (
                np.cos(ring_theta)[:, None] * u[None, :]
                + np.sin(ring_theta)[:, None] * v[None, :]
            ).astype(np.float32)
            ring_points = center[None, :] + ring_dirs * ring_r[:, None] + n_axis[None, :] * thickness[:, None]

            # ring banding: 반지름에 따라 밝고 어두운 띠
            t = (ring_r - inner) / (outer - inner + 1e-8)
            band = 0.5 + 0.5 * np.sin(t * 42.0 + rng.uniform(0.0, 2.0 * np.pi))
            ring_base = np.array([0.72, 0.62, 0.42], dtype=np.float32)
            ring_colors = ring_base[None, :] * (0.46 + 0.28 * band[:, None])
            ring_colors += rng.normal(0.0, 0.018, size=ring_colors.shape).astype(np.float32)
            ring_colors = np.clip(ring_colors, 0.0, 0.68).astype(np.float32)

            ring_scale = rng.uniform(pr * 0.032, pr * 0.070, size=n_ring).astype(np.float32)
            ring_scales = np.stack([ring_scale, ring_scale, ring_scale], axis=1).astype(np.float32)
            ring_opacities = rng.uniform(0.34, 0.62, size=n_ring).astype(np.float32)
            ring_rotations = np.zeros((n_ring, 4), dtype=np.float32)
            ring_rotations[:, 0] = 1.0

            all_points.append(ring_points.astype(np.float32))
            all_colors.append(ring_colors.astype(np.float32))
            all_opacities.append(ring_opacities)
            all_scales.append(ring_scales)
            all_rotations.append(ring_rotations)

    return (
        np.concatenate(all_points, axis=0).astype(np.float32),
        np.concatenate(all_colors, axis=0).astype(np.float32),
        np.concatenate(all_opacities, axis=0).astype(np.float32),
        np.concatenate(all_scales, axis=0).astype(np.float32),
        np.concatenate(all_rotations, axis=0).astype(np.float32),
    )


def write_3dgs_ply_binary_full(
    path: str,
    points: np.ndarray,
    colors: np.ndarray,
    opacities: np.ndarray,
    scales: np.ndarray,
    rotations: np.ndarray,
):
    """
    Full 3DGS-style binary_little_endian PLY 저장.

    포함 property:
        x y z
        nx ny nz
        f_dc_0 f_dc_1 f_dc_2
        f_rest_0 ~ f_rest_44
        opacity
        scale_0 scale_1 scale_2
        rot_0 rot_1 rot_2 rot_3
    """
    out_dir = os.path.dirname(path)
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)

    points = points.astype(np.float32)
    colors = np.clip(colors, 0.0, 1.0).astype(np.float32)
    opacities = np.clip(opacities, 1e-6, 1.0 - 1e-6).astype(np.float32)
    scales = np.clip(scales, 1e-6, None).astype(np.float32)
    rotations = rotations.astype(np.float32)
    rotations = rotations / (np.linalg.norm(rotations, axis=1, keepdims=True) + 1e-8)

    n = points.shape[0]

    f_dc = rgb_to_sh_dc(colors).astype(np.float32)
    opacity_raw = inverse_sigmoid(opacities).astype(np.float32)
    scale_raw = np.log(scales).astype(np.float32)

    normals = np.zeros_like(points, dtype=np.float32)

    # view-dependent color는 사용하지 않음
    f_rest = np.zeros((n, 45), dtype=np.float32)

    with open(path, "wb") as f:
        header = ""
        header += "ply\n"
        header += "format binary_little_endian 1.0\n"
        header += f"element vertex {n}\n"

        props = [
            "x", "y", "z",
            "nx", "ny", "nz",
            "f_dc_0", "f_dc_1", "f_dc_2",
        ]

        for i in range(45):
            props.append(f"f_rest_{i}")

        props += [
            "opacity",
            "scale_0", "scale_1", "scale_2",
            "rot_0", "rot_1", "rot_2", "rot_3",
        ]

        for p in props:
            header += f"property float {p}\n"

        header += "end_header\n"
        f.write(header.encode("ascii"))

        for i in tqdm(range(n), desc="Writing PLY"):
            row = (
                list(points[i])
                + list(normals[i])
                + list(f_dc[i])
                + list(f_rest[i])
                + [opacity_raw[i]]
                + list(scale_raw[i])
                + list(rotations[i])
            )

            f.write(struct.pack("<62f", *row))


def main():
    parser = argparse.ArgumentParser()

    parser.add_argument(
        "--output",
        "-o",
        default="stars_with_cosmic_dust.ply",
        help="Output 3DGS PLY",
    )

    parser.add_argument("--radius", type=float, default=8.0)
    parser.add_argument("--seed", type=int, default=7)

    # Stars
    parser.add_argument("--stars", type=int, default=2200)
    parser.add_argument(
        "--star-density-bias",
        type=str,
        default="uniform",
        choices=["uniform", "milky"],
    )
    parser.add_argument("--star-min-scale", type=float, default=0.002)
    parser.add_argument("--star-max-scale", type=float, default=0.008)
    parser.add_argument("--star-opacity-min", type=float, default=0.86)
    parser.add_argument("--star-opacity-max", type=float, default=0.99)

    # Cosmic dust
    parser.add_argument(
        "--dust-candidates",
        type=int,
        default=25000,
        help="후보 dust splat 수. 실제 남는 수는 threshold에 따라 줄어듦.",
    )
    parser.add_argument(
        "--dust-threshold",
        type=float,
        default=0.62,
        help="높을수록 dust가 더 듬성듬성함. 추천 0.58~0.72.",
    )
    parser.add_argument(
        "--dust-density-power",
        type=float,
        default=1.8,
        help="높을수록 dust가 더 선택적으로 남음.",
    )
    parser.add_argument("--dust-opacity-min", type=float, default=0.012)
    parser.add_argument("--dust-opacity-max", type=float, default=0.045)
    parser.add_argument("--dust-min-scale", type=float, default=0.020)
    parser.add_argument("--dust-max-scale", type=float, default=0.120)
    parser.add_argument("--dust-brightness-min", type=float, default=0.18)
    parser.add_argument("--dust-brightness-max", type=float, default=0.55)


    # Inner stars floating inside the space volume
    parser.add_argument("--inner-stars", type=int, default=50)
    parser.add_argument("--inner-star-radius-min-factor", type=float, default=0.18)
    parser.add_argument("--inner-star-radius-max-factor", type=float, default=0.82)
    parser.add_argument(
        "--inner-star-scale-multiplier",
        type=float,
        default=2.0,
        help="내부 별 scale 배율. 기본값 2.0은 표면 별보다 반지름이 약 2배 큰 별을 의미.",
    )
    parser.add_argument("--inner-star-opacity-min", type=float, default=0.70)
    parser.add_argument("--inner-star-opacity-max", type=float, default=0.96)

    # Procedural planets inside the space volume
    parser.add_argument("--planets", type=int, default=10)
    parser.add_argument("--planet-radius-min", type=float, default=0.12)
    parser.add_argument("--planet-radius-max", type=float, default=0.34)
    parser.add_argument("--planet-distance-min-factor", type=float, default=0.52)
    parser.add_argument("--planet-distance-max-factor", type=float, default=0.82)
    parser.add_argument("--planet-splats-min", type=int, default=1800)
    parser.add_argument("--planet-splats-max", type=int, default=3200)
    parser.add_argument(
        "--ringed-planet-ratio",
        type=float,
        default=0.45,
        help="고리형 행성 비율. 기본 0.45면 10개 중 대략 4~5개.",
    )

    args = parser.parse_args()

    print("Making stars")
    star_points, star_colors, star_opacities, star_scales, star_rotations = make_random_star_splats(
        n_stars=args.stars,
        radius=args.radius,
        seed=args.seed,
        star_radius_factor=0.992,
        star_min_scale=args.star_min_scale,
        star_max_scale=args.star_max_scale,
        star_opacity_min=args.star_opacity_min,
        star_opacity_max=args.star_opacity_max,
        star_density_bias=args.star_density_bias,
    )

    print("Making sparse cosmic dust")
    dust_points, dust_colors, dust_opacities, dust_scales, dust_rotations = make_sparse_cosmic_dust_splats(
        n_candidates=args.dust_candidates,
        radius=args.radius,
        seed=args.seed,
        dust_radius_factor=0.986,
        threshold=args.dust_threshold,
        density_power=args.dust_density_power,
        dust_opacity_min=args.dust_opacity_min,
        dust_opacity_max=args.dust_opacity_max,
        dust_min_scale=args.dust_min_scale,
        dust_max_scale=args.dust_max_scale,
        dust_brightness_min=args.dust_brightness_min,
        dust_brightness_max=args.dust_brightness_max,
    )


    print("Making inner floating stars")
    inner_star_points, inner_star_colors, inner_star_opacities, inner_star_scales, inner_star_rotations = make_inner_star_splats(
        n_stars=args.inner_stars,
        radius=args.radius,
        seed=args.seed,
        inner_radius_min_factor=args.inner_star_radius_min_factor,
        inner_radius_max_factor=args.inner_star_radius_max_factor,
        star_min_scale=args.star_min_scale,
        star_max_scale=args.star_max_scale,
        scale_multiplier=args.inner_star_scale_multiplier,
        opacity_min=args.inner_star_opacity_min,
        opacity_max=args.inner_star_opacity_max,
    )

    print("Making procedural planets")
    planet_points, planet_colors, planet_opacities, planet_scales, planet_rotations = make_planet_splats(
        n_planets=args.planets,
        radius=args.radius,
        seed=args.seed,
        planet_radius_min=args.planet_radius_min,
        planet_radius_max=args.planet_radius_max,
        planet_distance_min_factor=args.planet_distance_min_factor,
        planet_distance_max_factor=args.planet_distance_max_factor,
        planet_splats_min=args.planet_splats_min,
        planet_splats_max=args.planet_splats_max,
        ringed_ratio=args.ringed_planet_ratio,
    )

    points = np.concatenate([dust_points, star_points, inner_star_points, planet_points], axis=0)
    colors = np.concatenate([dust_colors, star_colors, inner_star_colors, planet_colors], axis=0)
    opacities = np.concatenate([dust_opacities, star_opacities, inner_star_opacities, planet_opacities], axis=0)
    scales = np.concatenate([dust_scales, star_scales, inner_star_scales, planet_scales], axis=0)
    rotations = np.concatenate([dust_rotations, star_rotations, inner_star_rotations, planet_rotations], axis=0)

    print(f"Surface stars: {star_points.shape[0]}")
    print(f"Inner stars: {inner_star_points.shape[0]}")
    print(f"Dust splats: {dust_points.shape[0]}")
    print(f"Planet/ring splats: {planet_points.shape[0]}")
    print(f"Total splats: {points.shape[0]}")
    print(f"Color min/max/mean: {colors.min():.6f} / {colors.max():.6f} / {colors.mean():.6f}")
    print(f"Scale min/max/mean: {scales.min():.6f} / {scales.max():.6f} / {scales.mean():.6f}")
    print(f"Opacity min/max/mean: {opacities.min():.6f} / {opacities.max():.6f} / {opacities.mean():.6f}")

    print(f"Writing output: {args.output}")
    write_3dgs_ply_binary_full(
        path=args.output,
        points=points,
        colors=colors,
        opacities=opacities,
        scales=scales,
        rotations=rotations,
    )

    print("Done.")


if __name__ == "__main__":
    main()