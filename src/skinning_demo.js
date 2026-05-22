/**
 * Skinning Data Visualizer
 * 
 * 기능:
 * - 스키닝 데이터 (proxy nodes + weights) 로드
 * - 프록시 노드를 구체로 시각화
 * - 본 선택 및 회전 제어
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { DropInViewer } from '@mkkellogg/gaussian-splats-3d';

// 전역 상태
const state = {
    scene: null,
    camera: null,
    renderer: null,
    controls: null,
    viewer: null,
    
    proxyNodes: [],
    skinIndices: null,
    skinWeights: null,
    
    nodeMeshes: [],
    edgeLines: null,
    
    selectedBoneIdx: 0,
    boneMatrices: [],
    boneTexture: null,
};

// ====== 초기화 ======
window.addEventListener('load', initScene);

async function initScene() {
    const canvas = document.getElementById('canvas');
    
    // Three.js 씬 설정
    state.scene = new THREE.Scene();
    state.scene.background = new THREE.Color(0x1a1a1a);
    
    state.camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 1000);
        // 더 가까이에서 관찰하기 위해 초기 위치를 기존(0,30,80)보다 가깝게 설정
        // 초기 카메라 위치를 가까이로 설정하여 노드가 더 크게 보이도록 함
        state.camera.position.set(0, 20, 40);
    state.camera.lookAt(0, 0, 0);
    
    state.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    state.renderer.setSize(window.innerWidth, window.innerHeight);
    state.renderer.setPixelRatio(window.devicePixelRatio);
    
    // OrbitControls - main.js와 동일한 방식
    state.controls = new OrbitControls(state.camera, state.renderer.domElement);
    state.controls.enableDamping = true;
    state.controls.dampingFactor = 0.05;
    state.controls.autoRotate = false;
        // 카메라 타겟을 카메라 Y 위치와 동일하게 맞춤
        state.controls.target.set(0, 20, 0);
    
    // 조명
    const light1 = new THREE.DirectionalLight(0xffffff, 3.0);
    light1.position.set(50, 100, 50);
    const light2 = new THREE.DirectionalLight(0xffffff, 2.0);
    light2.position.set(-50, 100, -50);
    const ambient = new THREE.AmbientLight(0xffffff, 0.8);
    state.scene.add(light1, light2, ambient);
    
    // 애니메이션 루프
    animate();
    
    // 윈도우 리사이즈
    window.addEventListener('resize', onWindowResize);
    
    updateStatus('✅ 준비 완료', 'ok');
}

// ====== 데이터 로드 ======
window.loadData = async function() {
    const dataPath = document.getElementById('dataPath').value;
    
    if (!dataPath) {
        updateStatus('❌ 데이터 경로를 입력하세요', 'error');
        return;
    }
    
    try {
        updateStatus('⏳ 데이터 로드 중...', 'loading');
        
        // proxy_nodes.json 로드
        console.log(`�� ${dataPath}/proxy_nodes.json 로드 중...`);
        const nodesResp = await fetch(`${dataPath}/proxy_nodes.json`);
        if (!nodesResp.ok) {
            throw new Error(`proxy_nodes.json 로드 실패: ${nodesResp.status}`);
        }
        const nodesData = await nodesResp.json();
        
        state.proxyNodes = nodesData.map(p => new THREE.Vector3(p.x, p.y, p.z));
        console.log(`✅ ${state.proxyNodes.length}개 프록시 노드 로드됨`);
        
        // skinning_data.bin 로드
        console.log(`📂 ${dataPath}/skinning_data.bin 로드 중...`);
        const binResp = await fetch(`${dataPath}/skinning_data.bin`);
        if (!binResp.ok) {
            throw new Error(`skinning_data.bin 로드 실패: ${binResp.status}`);
        }
        const binBuffer = await binResp.arrayBuffer();
        const skinDataFloat32 = new Float32Array(binBuffer);
        
        const K = 4;
        const numPoints = skinDataFloat32.length / (2 * K);
        state.skinIndices = new Uint32Array(numPoints * K);
        state.skinWeights = new Float32Array(numPoints * K);
        
        for (let i = 0; i < numPoints; i++) {
            for (let j = 0; j < K; j++) {
                state.skinIndices[i * K + j] = skinDataFloat32[i * (2 * K) + j];
                state.skinWeights[i * K + j] = skinDataFloat32[i * (2 * K) + K + j];
            }
        }
        console.log(`✅ ${numPoints}개 포인트 스킨 데이터 로드됨`);
        
        // 본 텍스처 생성
        createBoneTexture();
        
        // 프록시 노드 시각화
        visualizeProxyNodes();

        // 가우시안 스플랫 로드 (옵션)
        const showSplats = document.getElementById('showSplats')?.checked ?? true;
        if (showSplats) {
            await loadGaussianSplats(dataPath);
            // 적용된 alpha 값 반영
            setGSAlpha();
        }
        
        updateStatus(`✅ 로드 완료: ${state.proxyNodes.length} nodes, ${numPoints} points`, 'ok');
        
        // 본 범위 업데이트
        const maxBone = Math.max(0, state.proxyNodes.length - 1);
        document.getElementById('selectedBone').max = maxBone;
        
    } catch (error) {
        console.error('❌ 로드 실패:', error);
        updateStatus(`❌ 에러: ${error.message}`, 'error');
    }
};

function createBoneTexture() {
    const numBones = state.proxyNodes.length;
    const width = Math.ceil(Math.sqrt(numBones));
    const height = Math.ceil(numBones / width);
    
    const boneData = new Float32Array(width * height * 4);
    
    // 각 본의 4x4 행렬을 저장
    state.boneMatrices = [];
    
    for (let i = 0; i < numBones; i++) {
        const mat4 = new THREE.Matrix4(); // 항등 행렬
        state.boneMatrices.push(mat4);
        
        // 4x4 행렬을 float32 배열에 저장 (column-major)
        const arr = mat4.toArray();
        for (let k = 0; k < 16; k++) {
            boneData[i * 16 + k] = arr[k];
        }
    }
    
    state.boneTexture = new THREE.DataTexture(
        boneData,
        width,
        height,
        THREE.RGBAFormat,
        THREE.FloatType
    );
    state.boneTexture.minFilter = THREE.NearestFilter;
    state.boneTexture.magFilter = THREE.NearestFilter;
    state.boneTexture.needsUpdate = true;
    
    console.log(`📊 본 텍스처 생성: ${width}×${height} (${numBones} bones)`);
}

// Gaussian Splat 로드 및 제어
async function loadGaussianSplats(dataPath) {
    try {
        const gsPath = dataPath.replace(/_nodes\d+_sigma[\d.]+$/, '') + '.ply';
        console.log(`📂 GS 로드 시도: ${gsPath}`);

        if (!state.viewer) {
            state.viewer = new DropInViewer({ gpuAcceleratedSort: true });
            state.scene.add(state.viewer);
        }

        const scaleVal = parseFloat(document.getElementById('gsScale')?.value || 1.0);

        await state.viewer.addSplatScene(gsPath, {
            progressiveLoad: true,
            splatAlphaRemovalThreshold: 1,
            position: [0, 0, 0],
            rotation: [0, 0, 0, 1],
            scale: [scaleVal, scaleVal, scaleVal]
        });

        // 진단: viewer / splatMesh 출력 및 강제 가시화 시도
        console.log('🧭 DropInViewer after addSplatScene:', state.viewer);
        try {
            console.log('🧭 viewer.splatMesh:', state.viewer.splatMesh);
            console.log('🧭 viewer children:', state.viewer.children ? state.viewer.children.map(c => c.type + (c.name ? '/' + c.name : '')) : state.viewer.children);

            // 기존 처럼 traverse로 소재에 알파 적용
            state.viewer.traverse((child) => {
                if (child.isMesh && child.material) {
                    child.material.transparent = true;
                    const alpha = parseFloat(document.getElementById('gsAlpha')?.value || 0.8);
                    if ('opacity' in child.material) child.material.opacity = alpha;
                    if (child.material.uniforms && child.material.uniforms.u_alpha) child.material.uniforms.u_alpha.value = alpha;
                    child.material.needsUpdate = true;
                }
            });

            // splatMesh가 직접 노출되는 경우 추가로 강제 적용
            if (state.viewer.splatMesh) {
                const sm = state.viewer.splatMesh;
                sm.visible = true;
                if (sm.material) {
                    sm.material.transparent = true;
                    const alpha = parseFloat(document.getElementById('gsAlpha')?.value || 0.8);
                    if ('opacity' in sm.material) sm.material.opacity = alpha;
                    if (sm.material.uniforms && sm.material.uniforms.u_alpha) sm.material.uniforms.u_alpha.value = alpha;
                    sm.material.needsUpdate = true;
                }
                try {
                    console.log('🔢 splatCount:', typeof sm.getSplatCount === 'function' ? sm.getSplatCount() : 'n/a');
                } catch (e) {}
                // 프러스터럼 컬링으로 인해 사라질 수 있으므로 비활성화
                try { sm.frustumCulled = false; } catch (e) {}
                try { sm.renderOrder = 1000; } catch (e) {}
                try { if (sm.material) { sm.material.depthTest = false; sm.material.depthWrite = false; sm.material.side = THREE.DoubleSide; sm.material.needsUpdate = true; } } catch (e) {}
            }
            // 디버그 포인트 생성 (항상 시도)
            try { createSplatDebugPoints(state.viewer.splatMesh); } catch (e) { console.warn('createSplatDebugPoints error', e); }

            // viewer가 자체 업데이트 함수가 있으면 호출하고, 매트릭스 월드 갱신
            if (typeof state.viewer.update === 'function') {
                try { state.viewer.update(); } catch (e) { console.warn('viewer.update() threw', e); }
            }
            try { state.viewer.updateMatrixWorld(true); } catch (e) {}
        } catch (e) {
            console.warn('splat diagnostic failed', e);
        }

        console.log('✅ GS 로드 완료');
        // 카메라를 스플랫 중심/크기에 맞춰 자동 조정
        try {
            const bbox = new THREE.Box3().setFromObject(state.viewer);
            const center = bbox.getCenter(new THREE.Vector3());
            const size = bbox.getSize(new THREE.Vector3());
            const maxDim = Math.max(size.x, size.y, size.z, 1.0);
            const desiredDist = maxDim * 1.8 + 10; // 경험적 보정
            // 카메라 타겟과 컨트롤 업데이트
            state.controls.target.copy(center);
            state.controls.update();
            // 카메라 위치를 타겟에서 떨어뜨려 설정
            const dir = state.camera.position.clone().sub(state.controls.target).normalize();
            state.camera.position.copy(state.controls.target).addScaledVector(dir, desiredDist);
            state.camera.lookAt(center);
            document.getElementById('cameraDist').value = Math.round(desiredDist);
            document.getElementById('cameraDistValue').textContent = Math.round(desiredDist);
        } catch (e) {
            // bbox 계산 실패는 무시
            console.warn('카메라 자동조정 실패:', e.message || e);
        }
    } catch (err) {
        console.warn('⚠️ GS 로드 실패:', err.message || err);
    }
}

// 스플랫의 센터를 추출해 Points로 시각화 (디버그용)
function createSplatDebugPoints(splatMesh) {
    // 기존 디버그 포인트 제거
    if (state.splatDebugPoints) {
        state.scene.remove(state.splatDebugPoints);
        state.splatDebugPoints.geometry.dispose();
        state.splatDebugPoints.material.dispose();
        state.splatDebugPoints = null;
    }

    if (!splatMesh) return;

    let centersArray = null;
    try {
        // 우선 getSplatCenter 함수 사용
        if (typeof splatMesh.getSplatCenter === 'function') {
            const count = typeof splatMesh.getSplatCount === 'function' ? splatMesh.getSplatCount() : 0;
            const positions = new Float32Array(count * 3);
            const tmp = new THREE.Vector3();
            for (let i = 0; i < count; i++) {
                splatMesh.getSplatCenter(i, tmp);
                tmp.applyMatrix4(splatMesh.matrixWorld);
                positions[i * 3 + 0] = tmp.x;
                positions[i * 3 + 1] = tmp.y;
                positions[i * 3 + 2] = tmp.z;
            }
            centersArray = positions;
        } else {
            // 내부 버퍼에서 추출
            const buffer = splatMesh.scenes ? splatMesh.scenes[0].splatBuffer : (splatMesh.splatBuffers ? splatMesh.splatBuffers[0] : null);
            const raw = buffer && (buffer.centers || (buffer.getCenters ? buffer.getCenters() : null));
            if (raw) {
                // raw는 로컬 공간 좌표
                const count = raw.length / 3;
                const positions = new Float32Array(count * 3);
                const v = new THREE.Vector3();
                for (let i = 0; i < count; i++) {
                    v.set(raw[i * 3 + 0], raw[i * 3 + 1], raw[i * 3 + 2]);
                    v.applyMatrix4(splatMesh.matrixWorld);
                    positions[i * 3 + 0] = v.x;
                    positions[i * 3 + 1] = v.y;
                    positions[i * 3 + 2] = v.z;
                }
                centersArray = positions;
            }
        }
    } catch (e) {
        console.warn('createSplatDebugPoints: center extraction failed', e);
        centersArray = null;
    }

    if (!centersArray) {
        console.warn('createSplatDebugPoints: no centers available');
        return;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(centersArray, 3));

    const gsScale = parseFloat(document.getElementById('gsScale')?.value || 1.0);
    const size = Math.max(2.0, 3.0 * gsScale);

    const mat = new THREE.PointsMaterial({
        color: 0x88ccff,
        size: size,
        sizeAttenuation: true,
        depthTest: false,
        depthWrite: false
    });

    const points = new THREE.Points(geo, mat);
    points.renderOrder = 2000;
    state.splatDebugPoints = points;
    state.scene.add(points);
    console.log('🔍 Splat debug points added:', centersArray.length / 3);
}

window.setGSScale = function() {
    const v = parseFloat(document.getElementById('gsScale').value);
    document.getElementById('gsScaleValue').textContent = v.toFixed(1);
    if (!state.viewer) return;
    state.viewer.scale.set(v, v, v);
};

window.setGSAlpha = function() {
    const v = parseFloat(document.getElementById('gsAlpha').value);
    document.getElementById('gsAlphaValue').textContent = v.toFixed(2);
    if (!state.viewer) return;
    state.viewer.traverse((child) => {
        if (child.isMesh && child.material) {
            child.material.transparent = true;
            if ('opacity' in child.material) child.material.opacity = v;
            if (child.material.uniforms && child.material.uniforms.u_alpha) {
                child.material.uniforms.u_alpha.value = v;
            }
        }
    });
};

function visualizeProxyNodes() {
    // 기존 노드 메시 제거
    state.nodeMeshes.forEach(mesh => state.scene.remove(mesh));
    state.nodeMeshes = [];
    
    if (state.proxyNodes.length === 0) return;
    
    const sphereGeo = new THREE.SphereGeometry(0.01, 12, 12);
    
    state.proxyNodes.forEach((node, idx) => {
        const color = idx === state.selectedBoneIdx ? 0xff4444 : 0x4444ff;
        const mat = new THREE.MeshStandardMaterial({
            color,
            emissive: color,
            emissiveIntensity: 0.5,
            metalness: 0.3,
            roughness: 0.4,
        });
        const mesh = new THREE.Mesh(sphereGeo, mat);
        mesh.position.copy(node);
        mesh.userData.boneIdx = idx;
        state.scene.add(mesh);
        state.nodeMeshes.push(mesh);
    });
    
    console.log(`🎨 ${state.proxyNodes.length}개 본 노드 시각화됨`);
    
    // 본 연결선 (선택사항)
    updateBoneEdges();
}

function updateBoneEdges() {
    if (state.edgeLines) {
        state.scene.remove(state.edgeLines);
        state.edgeLines = null;
    }
    
    if (!document.getElementById('showEdges')?.checked || state.proxyNodes.length === 0) return;
    
    const edgeGeo = new THREE.BufferGeometry();
    const positions = [];
    
    // 간단한 연결: 인접한 본들끼리 연결
    for (let i = 0; i < state.proxyNodes.length - 1; i++) {
        positions.push(
            state.proxyNodes[i].x, state.proxyNodes[i].y, state.proxyNodes[i].z,
            state.proxyNodes[i + 1].x, state.proxyNodes[i + 1].y, state.proxyNodes[i + 1].z
        );
    }
    
    edgeGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
    const lineMat = new THREE.LineBasicMaterial({
        color: 0x888888,
        linewidth: 1,
        fog: false
    });
    state.edgeLines = new THREE.LineSegments(edgeGeo, lineMat);
    state.scene.add(state.edgeLines);
    
    console.log(`📍 ${state.proxyNodes.length - 1}개 본 연결선 표시됨`);
}

// ====== 제어 함수 ======
window.updateSelectedBone = function() {
    const idx = parseInt(document.getElementById('selectedBone').value);
    state.selectedBoneIdx = idx;
    document.getElementById('selectedBoneValue').textContent = idx;
    
    // 노드 색상 업데이트
    visualizeProxyNodes();
    
    // 초기화: 회전값 0으로 리셋
    document.getElementById('rotX').value = 0;
    document.getElementById('rotY').value = 0;
    document.getElementById('rotZ').value = 0;
    updateBoneRotation();
};

window.updateBoneRotation = function() {
    const rotX = parseFloat(document.getElementById('rotX').value);
    const rotY = parseFloat(document.getElementById('rotY').value);
    const rotZ = parseFloat(document.getElementById('rotZ').value);
    
    document.getElementById('rotXValue').textContent = `${rotX}°`;
    document.getElementById('rotYValue').textContent = `${rotY}°`;
    document.getElementById('rotZValue').textContent = `${rotZ}°`;
    
    // 회전 행렬 생성 및 본 텍스처 업데이트
    updateBoneTexture();
};

function updateBoneTexture() {
    if (!state.boneTexture || state.boneMatrices.length === 0) return;
    
    const rotX = THREE.MathUtils.degToRad(parseFloat(document.getElementById('rotX').value));
    const rotY = THREE.MathUtils.degToRad(parseFloat(document.getElementById('rotY').value));
    const rotZ = THREE.MathUtils.degToRad(parseFloat(document.getElementById('rotZ').value));
    
    // 선택된 본의 행렬 업데이트
    const mat = new THREE.Matrix4();
    mat.makeRotationFromEuler(new THREE.Euler(rotX, rotY, rotZ, 'XYZ'));
    state.boneMatrices[state.selectedBoneIdx] = mat;
    
    // 텍스처 데이터 업데이트
    const data = state.boneTexture.image.data;
    const arr = mat.toArray();
    const offset = state.selectedBoneIdx * 16;
    for (let k = 0; k < 16; k++) {
        data[offset + k] = arr[k];
    }
    
    state.boneTexture.needsUpdate = true;
    
    console.log(`🔄 본 ${state.selectedBoneIdx} 회전 업데이트`);
}

window.updateCameraDistance = function() {
    const dist = parseFloat(document.getElementById('cameraDist').value);
    document.getElementById('cameraDistValue').textContent = dist;
    
    if (state.controls) {
        const direction = state.camera.position.clone().sub(state.controls.target).normalize();
        state.camera.position.copy(state.controls.target).addScaledVector(direction, dist);
    }
};

window.onWindowResize = function() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    state.camera.aspect = w / h;
    state.camera.updateProjectionMatrix();
    state.renderer.setSize(w, h);
};

// ====== UI 업데이트 ======
function updateStatus(msg, type = 'info') {
    const el = document.getElementById('loadStatus');
    if (!el) return;
    
    el.textContent = msg;
    el.className = `status-${type}`;
}

// ====== 애니메이션 루프 ======
let frameCount = 0;
let lastTime = Date.now();

function animate() {
    requestAnimationFrame(animate);
    
    // OrbitControls 업데이트
    if (state.controls) {
        state.controls.update();
    }
    // DropInViewer 업데이트(있는 경우)
    if (state.viewer && typeof state.viewer.update === 'function') {
        try { state.viewer.update(); } catch (e) { console.warn('viewer.update() error', e); }
    }
    
    // UI 업데이트
    state.nodeMeshes.forEach((mesh, idx) => {
        const color = idx === state.selectedBoneIdx ? 0xff4444 : 0x4444ff;
        mesh.material.color.setHex(color);
        mesh.material.emissive.setHex(color);
    });
    
    // 체크박스 상태 반영
    const showNodes = document.getElementById('showNodes');
    if (showNodes) {
        state.nodeMeshes.forEach(mesh => {
            mesh.visible = showNodes.checked;
        });
    }
    
    if (state.edgeLines) {
        const showEdges = document.getElementById('showEdges');
        if (showEdges) {
            state.edgeLines.visible = showEdges.checked;
        }
    }
    
    state.renderer.render(state.scene, state.camera);
    
    // FPS 표시
    frameCount++;
    const now = Date.now();
    if (now - lastTime > 1000) {
        const frameInfo = document.getElementById('frameInfo');
        if (frameInfo) {
            frameInfo.textContent = `FPS: ${frameCount}`;
        }
        frameCount = 0;
        lastTime = now;
    }
}
