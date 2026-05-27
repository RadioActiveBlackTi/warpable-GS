/**
 * ARAP 케이지 설정
 */
export const ARAP = {
    NUM_BONES: 24,           // 6 높이 × 4 코너
    RADIUS: 15,              // XZ 평면 반경
    NUM_HEIGHTS: 6,          // Y축 레이어 수
    MIN_Y: 20,               // 최소 높이
    MAX_Y: 70,               // 최대 높이
    EDGE_DIST_THRESHOLD: 55.0,  // 정점 간 거리 한계
    EDGE_Y_THRESHOLD: 15.0,     // Y축 높이 차이 한계
    ITERATIONS: 5,           // 매 프레임 ARAP 반복
    LERP_DAMPING: 0.75,      // 글로벌 스텝 스무딩 (0.0=완전 이전, 1.0=새 위치로)
};

/**
 * 리플 파라미터 (호로포탈 물 표면)
 */
export const RIPPLE = {
    SPEED: 4.0,              // 진동 속도
    FREQUENCY: 22.0,         // 공간 주파수
    MAX_AMPLITUDE: 20.0,     // 최대 진폭
    ENVELOPE_DECAY: 2.0,     // exp(-r * ENVELOPE_DECAY)
};

/**
 * RBF 가중치 (근방 기저 함수)
 */
export const RBF_WEIGHTS = {
    TEST_MESH_SIGMA: 5.0,    // 테스트 메쉬 영향 반경
    SPLAT_SIGMA: 5.0,        // 가우시안 스플랫 영향 반경
    TOP_K_BONES: 4,          // 상위 K개 뼈만 사용
};

/**
 * 본 텍스처 설정
 */
export const BONE_TEXTURE = {
    WIDTH: 12,               // 12 픽셀 너비
    HEIGHT: 8,               // 8 픽셀 높이
    // 각 본당 4×4=16개 float (column-major 4×4 행렬)
    // 20개 본 = 80 pixels. 총 12×8=96 pixels (안전 마진)
};

/**
 * 호로포탈 기하학 설정
 */
export const PORTAL = {
    CYLINDER_RADIUS: 50.0,
    CYLINDER_HEIGHT: 100.0,
    SPLAT_SCALE: 15.0,
    RING_SEGMENTS: 128,
    RING_RADIAL_SEGMENTS: 64,
    CYLINDER_HEIGHT_SEGMENTS: 1,
};

/**
 * 렌더 타겟 설정
 */
export const RENDER_TARGET = {
    FORMAT: 'RGBAFormat',     // THREE.RGBAFormat
    TYPE: 'HalfFloatType',    // THREE.HalfFloatType
    MIN_FILTER: 'LinearFilter',
    MAG_FILTER: 'LinearFilter',
};

/**
 * 디버그 & 카메라 설정
 */
export const CAMERA = {
    MAIN_FOV: 50,
    MAIN_NEAR: 0.1,
    MAIN_FAR: 3000,
    MAIN_POS: [0, 150, 150],
    MAIN_LOOK_AT: [0, 50, 0],
    SPLAT_FOV: 45,
    SPLAT_NEAR: 0.1,
    SPLAT_FAR: 3000,
};

/**
 * 조명 설정
 */
export const LIGHTS = {
    LIGHT1_COLOR: 0xffffff,
    LIGHT1_INTENSITY: 3.0,
    LIGHT1_POS: [50, 100, 50],
    LIGHT2_COLOR: 0xffffff,
    LIGHT2_INTENSITY: 4.0,
    LIGHT2_POS: [-50, 100, -50],
    AMBIENT_COLOR: 0xffffff,
    AMBIENT_INTENSITY: 0.5,
    RTT_AMBIENT_INTENSITY: 1.2,
    RTT_DIRECTIONAL_INTENSITY: 2.5,
};

/**
 * 디버그 공 설정
 */
export const DEBUG_BONES_MESH = {
    RADIUS: 1.0,
    WIDTH_SEGMENTS: 8,
    HEIGHT_SEGMENTS: 8,
    COLOR: 0xff3333,
    DEPTH_TEST: false,
};

/**
 * 테스트 메쉬(실린더) 설정
 */
export const TEST_MESH = {
    RADIUS_TOP: 12,
    RADIUS_BOTTOM: 12,
    HEIGHT: 40,
    RADIAL_SEGMENTS: 16,
    HEIGHT_SEGMENTS: 20,
    INITIAL_Y: 40,  // 앞서 translate(0, 40, 0) 적용
};
