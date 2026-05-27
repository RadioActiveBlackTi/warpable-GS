import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { HoloPortal } from './holoPortal.js';
import { CAMERA, PORTAL } from './constants.js';

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
    
    // ====== 배경 생성 (따뜻한 톤 그라데이션) ======
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 512;
    const ctx = canvas.getContext('2d');
    const gradient = ctx.createLinearGradient(0, 0, 0, canvas.height);
    gradient.addColorStop(0, '#e8d5c4');    // 위: 따뜻한 베이지
    gradient.addColorStop(0.5, '#c9b8a8');  // 중간: 따뜻한 회색
    gradient.addColorStop(1, '#8b7d72');    // 아래: 따뜻한 갈색
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    
    const gradientTexture = new THREE.CanvasTexture(canvas);
    mainScene.background = gradientTexture;

    const tagSceneObject = (object, sceneType) => {
        if (!object) return object;
        object.traverse?.((child) => {
            child.userData = child.userData || {};
            child.userData.portalScene = sceneType;
        });
        return object;
    };

    // ====== 카메라 세팅 ======
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

    // ====== Orbit / Ego 카메라 모드 로직 ======
    const cameraModeToggle = document.getElementById('camera-mode-toggle');
    let cameraMode = cameraModeToggle?.checked ? 'ego' : 'orbit';

    mainCamera.rotation.order = 'YXZ';

    const egoState = { yaw: 0, pitch: 0 };
    const egoForward = new THREE.Vector3();
    const egoRight = new THREE.Vector3();
    const egoMove = new THREE.Vector3();
    const egoLookDir = new THREE.Vector3();
    const egoDrag = { active: false, lastX: 0, lastY: 0 };

    const syncEgoAnglesFromOrbit = () => {
        const dir = new THREE.Vector3().subVectors(controls.target, mainCamera.position).normalize();
        egoState.yaw = Math.atan2(dir.x, dir.z);
        egoState.pitch = Math.asin(THREE.MathUtils.clamp(dir.y, -1, 1));
    };

    syncEgoAnglesFromOrbit();

    const updateEgoCameraRotation = () => {
        mainCamera.rotation.set(egoState.pitch, egoState.yaw, 0, 'YXZ');
        egoLookDir.set(0, 0, -1).applyQuaternion(mainCamera.quaternion).normalize();
        controls.target.copy(mainCamera.position).add(egoLookDir);
    };

    const setCameraMode = (mode) => {
        cameraMode = mode;
        controls.enabled = mode === 'orbit';
        controls.enableZoom = mode === 'orbit';
        controls.enableRotate = mode === 'orbit';
        controls.enablePan = mode === 'orbit';

        if (mode === 'ego') {
            syncEgoAnglesFromOrbit();
            updateEgoCameraRotation();
            renderer.domElement.style.cursor = 'grab';
        } else {
            egoDrag.active = false;
            renderer.domElement.style.cursor = '';
            mainCamera.getWorldDirection(egoLookDir);
            controls.target.copy(mainCamera.position).add(egoLookDir);
            controls.update();
        }
    };

    if (cameraModeToggle) {
        cameraModeToggle.addEventListener('change', () => {
            setCameraMode(cameraModeToggle.checked ? 'ego' : 'orbit');
        });
    }

    window.addEventListener('mousedown', (e) => {
        if (cameraMode !== 'ego') return;
        if (e.button !== 0) return;
        egoDrag.active = true;
        egoDrag.lastX = e.clientX;
        egoDrag.lastY = e.clientY;
        renderer.domElement.style.cursor = 'grabbing';
    });

    window.addEventListener('mouseup', () => {
        egoDrag.active = false;
        if (cameraMode === 'ego') renderer.domElement.style.cursor = 'grab';
    });

    window.addEventListener('mousemove', (e) => {
        if (cameraMode !== 'ego' || !egoDrag.active) return;
        const dx = e.clientX - egoDrag.lastX;
        const dy = e.clientY - egoDrag.lastY;
        egoDrag.lastX = e.clientX;
        egoDrag.lastY = e.clientY;

        const sensitivity = 0.005;
        egoState.yaw -= dx * sensitivity;
        egoState.pitch -= dy * sensitivity;
        egoState.pitch = THREE.MathUtils.clamp(egoState.pitch, -Math.PI / 2 + 0.05, Math.PI / 2 - 0.05);
        updateEgoCameraRotation();
    });

    // ====== WASD 이동 ======
    const keyState = { w: false, a: false, s: false, d: false, shift: false };
    window.addEventListener('keydown', (e) => { const key = e.key.toLowerCase(); if (key in keyState) keyState[key] = true; });
    window.addEventListener('keyup', (e) => { const key = e.key.toLowerCase(); if (key in keyState) keyState[key] = false; });

    const moveEgoCamera = (deltaTime) => {
        if (cameraMode !== 'ego') return;
        const moveSpeed = keyState.shift ? 220 : 120;
        const step = moveSpeed * deltaTime;

        mainCamera.getWorldDirection(egoForward).normalize();
        egoRight.crossVectors(egoForward, mainCamera.up).normalize();

        egoMove.set(0, 0, 0);
        if (keyState.w) egoMove.add(egoForward);
        if (keyState.s) egoMove.sub(egoForward);
        if (keyState.d) egoMove.add(egoRight);
        if (keyState.a) egoMove.sub(egoRight);

        if (egoMove.lengthSq() > 0) {
            egoMove.normalize().multiplyScalar(step);
            mainCamera.position.add(egoMove);
            updateEgoCameraRotation();
        }
    };

    // =========================================================================
    // ✨ 핵심: 스마트해진 HoloPortal 인스턴스화
    // =========================================================================
    const holoPortal = new HoloPortal(mainScene, mainCamera, renderer, [
        {
            plyPath: new URL('/warpable-GS/nubjuk_face_rg.ply', window.location.origin).href,
            riggingDataPath: new URL('/warpable-GS/nubjuk_face_rg_nodes300_sigma5.0/proxy_nodes.json', window.location.origin).href,
            animationDataPath: new URL('/warpable-GS/nubjuk_anim_1.json', window.location.origin).href,
            scene: 'underwater',
            rotation: {x: 0, y: Math.PI, z: Math.PI},
            position: {x: 0, y: -25, z: 0},
            scale: 2.0,
        }
    ], {
        cylinderRadius: PORTAL.CYLINDER_RADIUS,
        cylinderHeight: PORTAL.CYLINDER_HEIGHT,
    });

    holoPortal.setPosition(0, 60, 0);

    // 스플랫 및 내부 씬 파이프라인 전면 로드 실행 (await로 안전하게 대기)
    try {
        await holoPortal.loadSplat();
    } catch (e) {
        console.error('스플랫 로드 실패:', e);
    }

    // 전역 디버깅용 노출
    window.holoPortal = holoPortal;

    // ====== UI 세팅 (진폭 슬라이더) ======
    const ui = document.createElement('div');
    ui.style.cssText = 'position:fixed;right:16px;top:16px;z-index:9999;width:220px;padding:12px;border-radius:12px;background:rgba(0,0,0,0.65);color:#fff;font:13px/1.4 system-ui,sans-serif;';
    
    const ampLabel = document.createElement('div');
    ampLabel.textContent = '포탈 표면 물결 진폭';
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

    // =========================================================================
    // 환경, 조명, 인테리어 소품 세팅 (기존 코드 유지)
    // =========================================================================
    const light1 = new THREE.DirectionalLight(0xffd9a8, 2.5);
    light1.position.set(150, 200, 100);
    light1.castShadow = true;
    tagSceneObject(light1, 'main');
    
    const light2 = new THREE.DirectionalLight(0xb8d4ff, 1.5);
    light2.position.set(-150, 180, -150);
    tagSceneObject(light2, 'main');
    
    const ambientLight = new THREE.AmbientLight(0xf5e6d3, 0.9);
    tagSceneObject(ambientLight, 'main');
    mainScene.add(light1, light2, ambientLight);

    // 바닥
    const floorGeo = new THREE.PlaneGeometry(1200, 1200);
    const floorMat = new THREE.MeshStandardMaterial({ color: 0xa89080, roughness: 0.7 });
    const floorMesh = new THREE.Mesh(floorGeo, floorMat);
    floorMesh.rotation.x = -Math.PI / 2;
    floorMesh.position.y = -150;
    floorMesh.receiveShadow = true;
    tagSceneObject(floorMesh, 'main');
    mainScene.add(floorMesh);

    // 테이블 탑
    const tableTopMesh = new THREE.Mesh(
        new THREE.BoxGeometry(800, 8, 600),
        new THREE.MeshStandardMaterial({ color: 0x8b6f47, roughness: 0.6 })
    );
    tableTopMesh.position.y = -20;
    tableTopMesh.castShadow = true;
    tableTopMesh.receiveShadow = true;
    tagSceneObject(tableTopMesh, 'main');
    mainScene.add(tableTopMesh);

    // 테이블 다리
    const legGeo = new THREE.BoxGeometry(18, 130, 18);
    const legMat = new THREE.MeshStandardMaterial({ color: 0x6b5436, roughness: 0.7 });
    [[-360, -85, -260], [360, -85, -260], [-360, -85, 260], [360, -85, 260]].forEach(pos => {
        const legMesh = new THREE.Mesh(legGeo, legMat);
        legMesh.position.set(...pos);
        legMesh.castShadow = true;
        legMesh.receiveShadow = true;
        tagSceneObject(legMesh, 'main');
        mainScene.add(legMesh);
    });


    // 테이블 위 소품들
    const addProp = (geo, mat, pos, rotZ = 0) => {
        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.set(...pos);
        mesh.rotation.z = rotZ;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        tagSceneObject(mesh, 'main');
        mainScene.add(mesh);
    };

    const bookGeo = new THREE.BoxGeometry(45, 12, 30);
    addProp(bookGeo, new THREE.MeshStandardMaterial({ color: 0xc1402d, roughness: 0.7 }), [-250, 0, -120], 0.15);
    addProp(bookGeo, new THREE.MeshStandardMaterial({ color: 0x4a5f8f, roughness: 0.7 }), [-250, 12, -80], -0.1);
    addProp(new THREE.BoxGeometry(50, 10, 40), new THREE.MeshStandardMaterial({ color: 0x8b7d6b, roughness: 0.8 }), [-120, 0, 180], 0.2);
    addProp(new THREE.CylinderGeometry(2.5, 2.5, 25, 8), new THREE.MeshStandardMaterial({ color: 0x3d3d3d, roughness: 0.4 }), [-70, 12, 190], 0.3);
    addProp(new THREE.CylinderGeometry(20, 20, 30, 32), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.3 }), [280, 8, 160]);
    addProp(new THREE.CylinderGeometry(35, 35, 2, 32), new THREE.MeshStandardMaterial({ color: 0xf5f5dc, roughness: 0.5 }), [300, 0, -130]);
    addProp(new THREE.BoxGeometry(4, 4, 20), new THREE.MeshStandardMaterial({ color: 0xc0a080, roughness: 0.4, metalness: 0.6 }), [200, 5, -180], 0.4);

    // 포탈 받침대
    const cupPad = new THREE.Mesh(
        new THREE.CylinderGeometry(90, 90, 3, 32),
        new THREE.MeshStandardMaterial({ color: 0xb8a89a, roughness: 0.8 })
    );
    cupPad.position.y = -17;
    cupPad.receiveShadow = true;
    tagSceneObject(cupPad, 'main');
    mainScene.add(cupPad);

    // ====== 윈도우 리사이징 ======
    window.addEventListener('resize', () => {
        mainCamera.aspect = window.innerWidth / window.innerHeight;
        mainCamera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
        holoPortal.handleResize();
    });

    // =========================================================================
    // ✨ 핵심: 엄청나게 간결해진 애니메이션 루프
    // =========================================================================
    const clock = new THREE.Clock();

    function animate() {
        requestAnimationFrame(animate);
        const delta = clock.getDelta();
        
        if (cameraMode === 'ego') {
            moveEgoCamera(delta);
        } else {
            controls.update();
        }

        // 호로포탈이 자체적으로 ARAP, 스킨닝 업데이트, 키프레임 처리, 렌더링을 모두 수행합니다!
        holoPortal.update(delta);
        holoPortal.render();
    }

    animate();
}

window.addEventListener('DOMContentLoaded', initHoloPortal);