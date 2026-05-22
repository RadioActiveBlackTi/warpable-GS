import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { HoloPortal } from './holoPortal.js';
import { VolumetricARAP } from './arap.js';
import { DropInViewer } from '@mkkellogg/gaussian-splats-3d';

// 모듈 임포트
import { computeSkinningAttributes } from './mathUtils.js';
import { createTestMeshLBSShader } from './shaders.js';
import {
    ARAP, BONE_TEXTURE, CAMERA, LIGHTS, TEST_MESH,
    DEBUG_BONES_MESH, PORTAL, RBF_WEIGHTS
} from './constants.js';

// =========================================================================
// 메인 어플리케이션 초기화
// =========================================================================
async function initHoloPortal() {
    const app = document.getElementById('app');

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(window.devicePixelRatio || 1);
    renderer.setSize(window.innerWidth, window.innerHeight);
    app.appendChild(renderer.domElement);

    const mainScene = new THREE.Scene();
    mainScene.background = new THREE.Color(0x333344);

    const mainCamera = new THREE.PerspectiveCamera(
        CAMERA.MAIN_FOV,
        window.innerWidth / window.innerHeight,
        CAMERA.MAIN_NEAR,
        CAMERA.MAIN_FAR
    );
    mainCamera.position.set(...CAMERA.MAIN_POS);
    mainCamera.lookAt(...CAMERA.MAIN_LOOK_AT);

    const controls = new OrbitControls(mainCamera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;

    // 호로포탈 생성
    const holoPortal = new HoloPortal(mainScene, mainCamera, renderer, 'nubjuk_face_rg.ply', {
        cylinderRadius: PORTAL.CYLINDER_RADIUS,
        cylinderHeight: PORTAL.CYLINDER_HEIGHT,
    });

    // ARAP 솔버 초기화
    const arapGrid = new VolumetricARAP();

    // ====== 디버그 뼈 메쉬 시각화 ======
    const debugBones = [];
    const sphereGeo = new THREE.SphereGeometry(
        DEBUG_BONES_MESH.RADIUS,
        DEBUG_BONES_MESH.WIDTH_SEGMENTS,
        DEBUG_BONES_MESH.HEIGHT_SEGMENTS
    );
    const sphereMat = new THREE.MeshBasicMaterial({
        color: DEBUG_BONES_MESH.COLOR,
        depthTest: DEBUG_BONES_MESH.DEPTH_TEST
    });
    for (let i = 0; i < arapGrid.numBones; i++) {
        const mesh = new THREE.Mesh(sphereGeo, sphereMat);
        mainScene.add(mesh);
        debugBones.push(mesh);
    }

    // ====== 뼈 텍스처 생성 ======
    const boneData = new Float32Array(BONE_TEXTURE.WIDTH * BONE_TEXTURE.HEIGHT * 4);
    // 항등 행렬로 초기화 (column-major)
    for (let i = 0; i < arapGrid.numBones; i++) {
        const offset = i * 16;
        for (let k = 0; k < 16; k++) {
            boneData[offset + k] = (k === 0 || k === 5 || k === 10 || k === 15) ? 1 : 0;
        }
    }
    const boneTexture = new THREE.DataTexture(
        boneData,
        BONE_TEXTURE.WIDTH,
        BONE_TEXTURE.HEIGHT,
        THREE.RGBAFormat,
        THREE.FloatType
    );
    boneTexture.minFilter = THREE.NearestFilter;
    boneTexture.magFilter = THREE.NearestFilter;
    boneTexture.needsUpdate = true;

    // ====== 테스트 메쉬(실린더) 생성 ======
    const testGeo = new THREE.CylinderGeometry(
        TEST_MESH.RADIUS_TOP,
        TEST_MESH.RADIUS_BOTTOM,
        TEST_MESH.HEIGHT,
        TEST_MESH.RADIAL_SEGMENTS,
        TEST_MESH.HEIGHT_SEGMENTS
    );
    testGeo.translate(0, TEST_MESH.INITIAL_Y, 0);

    // RBF 기반 스킨 가중치 계산
    const { skinIndices, skinWeights } = computeSkinningAttributes(
        testGeo,
        arapGrid.restPositions,
        RBF_WEIGHTS.TEST_MESH_SIGMA,
        RBF_WEIGHTS.TOP_K_BONES
    );
    testGeo.setAttribute('skinIndex', skinIndices);
    testGeo.setAttribute('skinWeight', skinWeights);

    // LBS 쉐이더 설정
    const testShaderConfig = createTestMeshLBSShader(BONE_TEXTURE.WIDTH, BONE_TEXTURE.HEIGHT);
    const testMat = new THREE.ShaderMaterial({
        uniforms: {
            ...testShaderConfig.uniforms,
            boneTexture: { value: boneTexture }
        },
        vertexShader: testShaderConfig.vertexShader,
        fragmentShader: testShaderConfig.fragmentShader,
        wireframe: true,
        transparent: true,
        depthTest: false,
        side: THREE.DoubleSide
    });

    const testMesh = new THREE.Mesh(testGeo, testMat);
    testMesh.frustumCulled = false;
    mainScene.add(testMesh);

    // ====== UI 세팅 ======
    const ui = document.createElement('div');
    ui.style.cssText = 'position:fixed;right:16px;top:16px;z-index:9999;width:220px;padding:12px;border-radius:12px;background:rgba(0,0,0,0.65);color:#fff;font:13px/1.4 system-ui,sans-serif;';
    
    const ampLabel = document.createElement('div');
    ampLabel.textContent = '물방울 Z 진폭';
    const ampValue = document.createElement('div');
    ampValue.textContent = '2.0';
    const ampSlider = document.createElement('input');
    ampSlider.type = 'range';
    ampSlider.min = '0';
    ampSlider.max = '20';
    ampSlider.step = '0.1';
    ampSlider.value = '2.0';
    ampSlider.style.width = '100%';
    ampSlider.addEventListener('input', () => {
        const v = parseFloat(ampSlider.value);
        holoPortal.setBendAmount(v);
        ampValue.textContent = v.toFixed(1);
    });
    ui.append(ampLabel, ampSlider, ampValue);
    document.body.appendChild(ui);
    holoPortal.setBendAmount(2.0);

    // ARAP 데이터 호로포탈에 전달
    holoPortal.setARAPData(arapGrid.restPositions, boneTexture, BONE_TEXTURE.WIDTH, BONE_TEXTURE.HEIGHT);

    // 가우시안 스플랫 로더 생성 및 로드
    const viewer = new DropInViewer({
        sphericalHarmonicsDegree: 2
    });
    try {
        await holoPortal.loadSplat(viewer);
    } catch (e) {
        console.error('Failed to load splat:', e);
    }

    // 디버깅용 전역 접근
    window.holoPortal = holoPortal;
    window.arapGrid = arapGrid;

    // ====== 조명 설정 ======
    const light1 = new THREE.DirectionalLight(LIGHTS.LIGHT1_COLOR, LIGHTS.LIGHT1_INTENSITY);
    light1.position.set(...LIGHTS.LIGHT1_POS);
    const light2 = new THREE.DirectionalLight(LIGHTS.LIGHT2_COLOR, LIGHTS.LIGHT2_INTENSITY);
    light2.position.set(...LIGHTS.LIGHT2_POS);
    const ambientLight = new THREE.AmbientLight(LIGHTS.AMBIENT_COLOR, LIGHTS.AMBIENT_INTENSITY);
    mainScene.add(light1, light2, ambientLight);

    // ====== 윈도우 리사이징 ======
    window.addEventListener('resize', () => {
        mainCamera.aspect = window.innerWidth / window.innerHeight;
        mainCamera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
        holoPortal.handleResize();
    });

    // ====== 애니메이션 루프 ======
    const clock = new THREE.Clock();

    function animate() {
        requestAnimationFrame(animate);
        const delta = clock.getDelta();
        const elapsed = clock.getElapsedTime();
        controls.update();

        // 실시간 상단 핸들 제어 (애니메이션)
        const waveX = Math.sin(elapsed * 2.5) * 12.0;
        const waveZ = Math.cos(elapsed * 2.0) * 8.0;

        // 최하단 층: 고정
        for (let i = 0; i < 4; i++) {
            arapGrid.setHandle(i, arapGrid.restPositions[i]);
        }
        // 최상단 층: 애니메이션
        for (let i = 16; i < 20; i++) {
            const target = arapGrid.restPositions[i].clone();
            target.x += waveX;
            target.z += waveZ;
            arapGrid.setHandle(i, target);
        }

        // ARAP 솔버 실행
        arapGrid.solve(ARAP.ITERATIONS);

        // 뼈 텍스처 업데이트
        arapGrid.updateBoneTextureData(boneData);
        boneTexture.needsUpdate = true;

        // 디버그 뼈 메쉬 위치 업데이트
        for (let i = 0; i < debugBones.length; i++) {
            debugBones[i].position.copy(arapGrid.currentPositions[i]);
        }

        // 호로포탈 업데이트 및 렌더
        holoPortal.update(delta);
        holoPortal.render();
    }

    animate();
}

// 시작
window.addEventListener('DOMContentLoaded', initHoloPortal);
