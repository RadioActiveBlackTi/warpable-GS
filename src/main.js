import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { HoloCard } from './holoCard.js';
import { SplatPass } from './splatPass.js';

async function initHoloCard() {
    const app = document.getElementById('app');
    if (!app) throw new Error('Missing #app element');

    const status = document.createElement('div');
    status.style.cssText = 'position:fixed;left:16px;top:16px;z-index:9999;padding:8px 12px;border-radius:8px;background:rgba(0,0,0,0.7);color:#fff;font:14px/1.4 system-ui,sans-serif;pointer-events:none;';
    status.textContent = '초기화 중...';
    document.body.appendChild(status);

    // ==========================================
    // 1. 공통 렌더러 설정 (Modern Pipeline)
    // ==========================================
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(window.devicePixelRatio || 1);
    renderer.setSize(window.innerWidth, window.innerHeight);
    app.appendChild(renderer.domElement);

    renderer.outputColorSpace = THREE.LinearSRGBColorSpace; // ⭕ 원복
    renderer.toneMapping = THREE.NoToneMapping;

    const textureLoaderImage = new THREE.TextureLoader();
    const backTexture = await textureLoaderImage.loadAsync('/back.png');

    // ==========================================
    // 2. RTT (프레임버퍼) 설정
    // ==========================================
    const ratio = 1.0;
    const renderTarget = new THREE.WebGLRenderTarget(1260 * ratio, 1760 * ratio, {
        minFilter: THREE.NearestFilter,
        magFilter: THREE.LinearFilter,
        format: THREE.RGBAFormat,
        type: THREE.HalfFloatType,
        // ✨ 지적 반영: RTT 내부는 가우시안 본연의 Linear SRGB 데이터를 완벽히 보존
        colorSpace: THREE.NoColorSpace,
    });
    renderTarget.texture.anisotropy = renderer.capabilities.getMaxAnisotropy();

    const depthRenderTarget = new THREE.WebGLRenderTarget(1260 * ratio, 1760 * ratio, {
        minFilter: THREE.NearestFilter,
        magFilter: THREE.LinearFilter,
        format: THREE.RGBAFormat,
        type: THREE.HalfFloatType,
        colorSpace: THREE.NoColorSpace,
    });
    depthRenderTarget.texture.anisotropy = renderer.capabilities.getMaxAnisotropy();

    // ==========================================
    // 성능 제어
    // ==========================================
    const targetFPS = 30;
    const minFrameIntervalSec = 1 / targetFPS;

    // ==========================================
    // 3. 메인 씬 (HoloCard 모듈 기반)
    // ==========================================
    const mainScene = new THREE.Scene();
    mainScene.background = new THREE.Color(0x22dddd);
    
    const mainCamera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 1000);
    mainCamera.position.set(0, 0, 150);
    const controls = new OrbitControls(mainCamera, renderer.domElement);
    controls.enableDamping = true;

    const cardGeometry = new THREE.PlaneGeometry(63, 88, 32, 32);
    const deformFunctionGLSL = `
        // b = ripple z-amplitude (slider), t = time
        float amplitude = clamp(abs(b), 0.0, 2.0);

        // 카드 중심 기준의 정규화 반경 (가로/세로 비율 보정)
        float rx = p.x / 31.5;
        float ry = p.y / 44.0;
        float r = length(vec2(rx, ry));

        // 물방울이 떨어진 뒤 퍼져나가는 동심원 파문
        float rippleSpeed = 4.0;
        float rippleFreq = 22.0;
        float envelope = exp(-r * 2.0);
        float ripple = sin(r * rippleFreq - t * rippleSpeed) * envelope;

        // 슬라이더 값 자체가 z 진폭이 되도록 직접 곱함
        p.z += ripple * amplitude;
        return p;
    `;
    const holoCard = new HoloCard(mainScene, cardGeometry, renderTarget.texture, depthRenderTarget.texture, backTexture, deformFunctionGLSL);
    const cardGroup = holoCard.group;

    // ==========================================
    // UI 슬라이더 설정
    // ==========================================
    const controlPanel = document.createElement('div');
    controlPanel.style.cssText = 'position:fixed;right:16px;top:16px;z-index:9998;background:rgba(0,0,0,0.7);padding:16px;border-radius:8px;color:#fff;font:12px system-ui,sans-serif;';
    
    const bendLabel = document.createElement('div');
    bendLabel.textContent = '물방울 Z 진폭';
    bendLabel.style.marginBottom = '8px';
    controlPanel.appendChild(bendLabel);
    
    const bendSlider = document.createElement('input');
    bendSlider.type = 'range';
    bendSlider.min = '0';
    bendSlider.max = '20.0'; 
    bendSlider.step = '0.01';
    bendSlider.value = '0.35';
    bendSlider.style.cssText = 'width:150px;cursor:pointer;';
    
    const bendValue = document.createElement('div');
    bendValue.style.marginTop = '6px';
    bendValue.textContent = 'Z Amp: 0.35';

    bendSlider.addEventListener('input', (e) => {
        const val = parseFloat(e.target.value);
        holoCard.uniforms.uBendAmount.value = val;
        bendValue.textContent = `Z Amp: ${val.toFixed(2)}`;
    });

    holoCard.uniforms.uBendAmount.value = parseFloat(bendSlider.value);

    controlPanel.appendChild(bendSlider);
    controlPanel.appendChild(bendValue);
    document.body.appendChild(controlPanel);

    // 스튜디오 라이팅 조명 활성화
    const keyLight1 = new THREE.DirectionalLight(0xffffff, 1.0);
    keyLight1.position.set(50, 100, 100);
    mainScene.add(keyLight1);

    const keyLight4 = new THREE.AmbientLight(0xeeeeee, 4.0);
    mainScene.add(keyLight4);

    // ==========================================
    // 4. 가우시안 RTT 패스 (캡슐화)
    // ==========================================
    const splatPass = new SplatPass({
        app,
        renderer,
        renderTarget,
        depthRenderTarget,
        plyPath: '/darkrai.ply',
        statusEl: status,
        cardObject: cardGroup,
        splatFov: 8.0,
        clearColor: 0xBCC8D6,
        clearAlpha: 1.0,
        parallaxStrength: 15.0,
        zOffset: -1.0,
        shAmplifyX: 3.5,
        shAmplifyY: 3.5,
    });

    try {
        await splatPass.load();
    } catch (error) {
        status.textContent = `로드 실패: ${error.message}`;
    }

    // ==========================================
    // 5. 렌더링 루프
    // ==========================================
    let prevTimeSec = performance.now() * 0.001;
    let lastRenderSec = prevTimeSec;

    function animate() {
        requestAnimationFrame(animate);
        const nowSec = performance.now() * 0.001;
        const deltaTime = nowSec - prevTimeSec;
        prevTimeSec = nowSec;
        holoCard.update(deltaTime);
        controls.update();

        // 카드 애니메이션: Y축 연속 회전 + 위아래 진동
        // rotation: 초당 약 0.6 라디안
        // cardGroup.rotation.y += 0.6 * deltaTime;
        // vertical bob: 주파수 1.4Hz, 진폭 ±2 units
        cardGroup.position.y = Math.sin(nowSec * 1.4) * 2.0;

        if (nowSec - lastRenderSec < minFrameIntervalSec) {
            return;
        }
        lastRenderSec = nowSec;

        splatPass.updateAndRenderToTarget(mainCamera);

        // 2단계: 메인 카드 렌더링
        renderer.render(mainScene, mainCamera);
    }

    window.addEventListener('resize', () => {
        mainCamera.aspect = window.innerWidth / window.innerHeight;
        mainCamera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
        splatPass.handleResize();
    });

    animate();
}

initHoloCard();