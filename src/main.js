import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { HoloPortal } from './holoPortal.js';
import { DropInViewer } from '@mkkellogg/gaussian-splats-3d';

// =========================================================================
// 3D 볼류메트릭 케이지 ARAP 솔버 (축소/붕괴 현상 완벽 해결)
// =========================================================================
class VolumetricARAP {
    constructor() {
        this.restPositions = [];
        this.currentPositions = [];
        this.rotations = [];
        this.edges = [];
        this.handles = new Map();
        this.numBones = 24;  // 6 높이 × 4 코너 = 24개 본

        this.initCage();
    }

    initCage() {
        const radius = 15; 
        const dy = 40 / 5;
        const heights = [20, 20 + dy, 20 + 2 * dy, 20 + 3 * dy, 20 + 4 * dy, 20 + 5 * dy]; // Y축으로 6층 구성 (20~70)
        const corners = [
            [-radius, -radius], [radius, -radius],
            [radius, radius], [-radius, radius]
        ];

        for (let h of heights) {
            for (let c of corners) {
                const pos = new THREE.Vector3(c[0], h, c[1]);
                this.restPositions.push(pos.clone());
                this.currentPositions.push(pos.clone());
                this.rotations.push(new THREE.Matrix3());
                this.edges.push([]);
            }
        }

        // 💡 [수정된 부분] 가로 대각선은 묶어주되, Y축으로는 건너뛰어 묶이지 않도록 차단
        for (let i = 0; i < this.numBones; i++) {
            for (let j = i + 1; j < this.numBones; j++) {
                const dist = this.restPositions[i].distanceTo(this.restPositions[j]);
                const yDist = Math.abs(this.restPositions[i].y - this.restPositions[j].y);
                
                // 거리가 가깝더라도, Y축 높이 차이가 15.0 이하(같은 층 or 1계단 차이)일 때만 연결!
                if (dist < 55.0 && yDist <= 15.0) {
                    this.edges[i].push(j);
                    this.edges[j].push(i);
                }
            }
        }
    }

    setHandle(index, targetPosition) {
        this.handles.set(index, targetPosition.clone());
    }

    // 💡 [핵심 수정] 행렬이 쪼그라들지 않도록 완벽한 3D 회전 행렬만 추출합니다.
    extractRotation3D(S) {
        let R = S.clone();
        let det = R.determinant();

        // 노드들이 평면이 되어버리는 등 행렬이 무너지면 항등행렬로 초기화
        if (Math.abs(det) < 1e-9) {
            return new THREE.Matrix3().identity();
        }

        // 스케일을 1.0으로 강제 압축. 이 한 줄이 없어서 가운데로 뭉치는 참사가 났습니다.
        let scale = Math.pow(Math.abs(det), 1.0 / 3.0);
        for (let k = 0; k < 9; k++) {
            R.elements[k] /= scale;
        }

        // Higham's Iteration (순수 회전각 도출)
        const R_invT = new THREE.Matrix3();
        for (let iter = 0; iter < 5; iter++) {
            R_invT.copy(R).invert().transpose();
            for (let k = 0; k < 9; k++) {
                R.elements[k] = 0.5 * (R.elements[k] + R_invT.elements[k]);
            }
        }
        return R;
    }

    solve(iterations = 4) {
        for (let iter = 0; iter < iterations; iter++) {
            // [Local Step]
            for (let i = 0; i < this.numBones; i++) {
                const p_i = this.currentPositions[i];
                const r_i = this.restPositions[i];
                let S = new THREE.Matrix3().set(0,0,0, 0,0,0, 0,0,0);

                for (let j of this.edges[i]) {
                    const dp = this.currentPositions[j].clone().sub(p_i);
                    const dr = this.restPositions[j].clone().sub(r_i);
                    const outer = new THREE.Matrix3().set(
                        dp.x*dr.x, dp.x*dr.y, dp.x*dr.z,
                        dp.y*dr.x, dp.y*dr.y, dp.y*dr.z,
                        dp.z*dr.x, dp.z*dr.y, dp.z*dr.z
                    );
                    for (let k = 0; k < 9; k++) S.elements[k] += outer.elements[k];
                }
                this.rotations[i] = this.extractRotation3D(S);
            }

            // [Global Step]
            for (let i = 0; i < this.numBones; i++) {
                if (this.handles.has(i)) {
                    this.currentPositions[i].copy(this.handles.get(i));
                    continue;
                }

                let posSum = new THREE.Vector3();
                const r_i = this.restPositions[i];
                const R_i = this.rotations[i];

                for (let j of this.edges[i]) {
                    const p_j = this.currentPositions[j];
                    const r_j = this.restPositions[j];
                    const R_j = this.rotations[j];

                    const dr = r_i.clone().sub(r_j);
                    const rotated_dr = dr.clone().applyMatrix3(R_i).add(dr.clone().applyMatrix3(R_j)).multiplyScalar(0.5);
                    posSum.add(p_j.clone().add(rotated_dr));
                }

                if (this.edges[i].length > 0) {
                    const targetPos = posSum.divideScalar(this.edges[i].length);
                    // 💡 부드러운 damping (0.4 = 60% 기존 위치 유지, 40% 새 위치로 이동)
                    // → 중간층이 rigid하지 않고 유연하게 흔들림
                    this.currentPositions[i].lerp(targetPos, 0.75);
                }
            }
        }
    }
}

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

    const mainCamera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 1000);
    mainCamera.position.set(0, 150, 150);
    mainCamera.lookAt(0, 50, 0);

    const controls = new OrbitControls(mainCamera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;

    // 원본 수조 포탈 생성 (Stashed 원본 코드 유지)
    const holoPortal = new HoloPortal(mainScene, mainCamera, renderer, '/darkrai.ply', {
        cylinderRadius: 50,
        cylinderHeight: 100,
    });

    // 💡 새롭게 정의한 무적의 3D ARAP 시스템 가동
    const arapGrid = new VolumetricARAP();

    // 1. 16개의 모든 케이지 노드를 시각화할 작은 디버그 공 생성
    const debugBones = [];
    const sphereGeo = new THREE.SphereGeometry(1.0, 8, 8);
    const sphereMat = new THREE.MeshBasicMaterial({ color: 0xff3333, depthTest: false });
    for (let i = 0; i < arapGrid.numBones; i++) {
        const mesh = new THREE.Mesh(sphereGeo, sphereMat);
        mainScene.add(mesh);
        debugBones.push(mesh);
    }

    // 2. GPU 데이터 전송용 뼈대 텍스처 (12×8 = 96 픽셀 = 20 행렬 × 16/4 floats)
    // 각 행렬 i → 픽셀 i*4 부터 4개 vec4 저장 (column-major)
    const boneTextureSize = 8;
    const boneTextureWidth = 12;  // 20개 행렬을 위한 가로 확장
    const boneData = new Float32Array(boneTextureWidth * boneTextureSize * 4);
    
    // 항등 행렬로 초기화 (column-major: [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1])
    for (let i = 0; i < 20; i++) {
        const offset = i * 16;
        for (let k = 0; k < 16; k++) {
            boneData[offset + k] = (k === 0 || k === 5 || k === 10 || k === 15) ? 1 : 0;
        }
    }
    const boneTexture = new THREE.DataTexture(boneData, boneTextureWidth, boneTextureSize, THREE.RGBAFormat, THREE.FloatType);
    boneTexture.minFilter = THREE.NearestFilter;
    boneTexture.magFilter = THREE.NearestFilter;
    boneTexture.needsUpdate = true;

    // 3. 테스트용 실린더 메쉬 생성 (세분화 단계 적용)
    const testGeo = new THREE.CylinderGeometry(12, 12, 40, 16, 20);
    testGeo.translate(0, 40, 0); // Y축 20 ~ 60 범위에 배치

    const posAttr = testGeo.attributes.position;
    const vertexCount = posAttr.count;
    // ✅ 모든 bone의 RBF weight를 저장하기 위해 큰 배열 사용 (vertex × 20개 bone)
    const skinIndices = new Float32Array(vertexCount * 4);
    const skinWeights = new Float32Array(vertexCount * 4);
    const rbfWeights = new Float32Array(vertexCount * arapGrid.numBones);  // RBF texture용

    // 💡 핵심: 지수 형태(Exponential RBF) 스키닝 가중치 계산
    const sigma = 5.0; // 영향력 도달 반경
    for (let i = 0; i < vertexCount; i++) {
        const vPos = new THREE.Vector3(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i));
        
        let typedWeights = [];
        for (let b = 0; b < arapGrid.numBones; b++) {
            const dist = vPos.distanceTo(arapGrid.restPositions[b]);
            const w = Math.exp(-(dist * dist) / (2 * sigma * sigma));
            typedWeights.push({ index: b, weight: w });
        }

        // 가중치가 가장 높은 상위 '4개'의 뼈대 선별
        typedWeights.sort((a, b) => b.weight - a.weight);
        
        // 💡 4개의 가중치를 모두 합산하여 정규화(Normalize)
        const sum = typedWeights[0].weight + typedWeights[1].weight + 
                    typedWeights[2].weight + typedWeights[3].weight + 1e-5;

        // 4개의 슬롯(x, y, z, w)에 모두 데이터 할당
        skinIndices[i * 4 + 0] = typedWeights[0].index;
        skinIndices[i * 4 + 1] = typedWeights[1].index;
        skinIndices[i * 4 + 2] = typedWeights[2].index;
        skinIndices[i * 4 + 3] = typedWeights[3].index;

        skinWeights[i * 4 + 0] = typedWeights[0].weight / sum;
        skinWeights[i * 4 + 1] = typedWeights[1].weight / sum;
        skinWeights[i * 4 + 2] = typedWeights[2].weight / sum;
        skinWeights[i * 4 + 3] = typedWeights[3].weight / sum;
    }

    testGeo.setAttribute('skinIndex', new THREE.BufferAttribute(skinIndices, 4));
    testGeo.setAttribute('skinWeight', new THREE.BufferAttribute(skinWeights, 4));

    // 4. 텍스처 샘플링 기반 LBS 쉐이더
    const testMat = new THREE.ShaderMaterial({
        uniforms: {
            boneTexture: { value: boneTexture },
            boneTextureWidth: { value: boneTextureWidth },
            boneTextureHeight: { value: boneTextureSize }
        },
        vertexShader: `
            uniform sampler2D boneTexture;
            uniform float boneTextureWidth;
            uniform float boneTextureHeight;
            attribute vec4 skinIndex;
            attribute vec4 skinWeight;

            mat4 getBoneMatrix(float boneIdx) {
                // 각 행렬은 16개 float = 4개 vec4 (column-major)
                float texWidth = boneTextureWidth;
                float texHeight = boneTextureHeight;
                
                // 행렬 i의 시작 픽셀 위치
                float pixelStart = boneIdx * 4.0;
                float x = mod(pixelStart, texWidth);
                float y = floor(pixelStart / texWidth);
                
                float dx = 1.0 / texWidth;
                float dy = 1.0 / texHeight;
                
                // 4개 vec4 (4개 열) 읽기
                vec4 col0 = texture2D(boneTexture, vec2((x + 0.5) * dx, (y + 0.5) * dy));
                vec4 col1 = texture2D(boneTexture, vec2((x + 1.5) * dx, (y + 0.5) * dy));
                vec4 col2 = texture2D(boneTexture, vec2((x + 2.5) * dx, (y + 0.5) * dy));
                vec4 col3 = texture2D(boneTexture, vec2((x + 3.5) * dx, (y + 0.5) * dy));
                
                // GLSL mat4는 column-major
                return mat4(col0, col1, col2, col3);
            }

            void main() {
                // 💡 4개의 뼈대 행렬(x, y, z, w)을 모두 부드럽게 섞음 (4-Bone LBS)
                mat4 skinMat = getBoneMatrix(skinIndex.x) * skinWeight.x +
                               getBoneMatrix(skinIndex.y) * skinWeight.y +
                               getBoneMatrix(skinIndex.z) * skinWeight.z +
                               getBoneMatrix(skinIndex.w) * skinWeight.w;
                               
                vec4 skinnedPos = skinMat * vec4(position, 1.0);
                gl_Position = projectionMatrix * viewMatrix * skinnedPos;
            }
        `,
        fragmentShader: `void main() { gl_FragColor = vec4(0.0, 0.8, 1.0, 0.4); }`,
        wireframe: true, transparent: true, depthTest: false, side: THREE.DoubleSide
    });

    const testMesh = new THREE.Mesh(testGeo, testMat);
    testMesh.frustumCulled = false;
    mainScene.add(testMesh);


    // 기존 UI 및 포탈 렌더링 세팅
    const ui = document.createElement('div');
    ui.style.cssText = 'position:fixed;right:16px;top:16px;z-index:9999;width:220px;padding:12px;border-radius:12px;background:rgba(0,0,0,0.65);color:#fff;font:13px/1.4 system-ui,sans-serif;';
    const ampLabel = document.createElement('div'); ampLabel.textContent = '물방울 Z 진폭';
    const ampValue = document.createElement('div'); ampValue.textContent = '2.0';
    const ampSlider = document.createElement('input');
    ampSlider.type = 'range'; ampSlider.min = '0'; ampSlider.max = '20'; ampSlider.step = '0.1'; ampSlider.value = '2.0';
    ampSlider.style.width = '100%';
    ampSlider.addEventListener('input', () => {
        const v = parseFloat(ampSlider.value);
        holoPortal.setBendAmount(v);
        ampValue.textContent = v.toFixed(1);
    });
    ui.append(ampLabel, ampSlider, ampValue);
    document.body.appendChild(ui);
    holoPortal.setBendAmount(2.0);

    // 💡 [수정됨] safeBoneTexture -> boneTexture 로 변경하고 Width와 Height 모두 전달
    holoPortal.setARAPData(arapGrid.restPositions, boneTexture, boneTextureWidth, boneTextureSize);

    const viewer = new DropInViewer();
    try {
        await holoPortal.loadSplat(viewer);
    } catch (e) { console.error(e); }

    // ✅ Console 디버깅용
    window.holoPortal = holoPortal;
    window.arapGrid = arapGrid;

    const light1 = new THREE.DirectionalLight(0xffffff, 3.0); light1.position.set(50, 100, 50);
    const light2 = new THREE.DirectionalLight(0xffffff, 4.0); light2.position.set(-50, 100, -50);
    mainScene.add(light1, light2, new THREE.AmbientLight(0xffffff, 0.5));

    window.addEventListener('resize', () => {
        mainCamera.aspect = window.innerWidth / window.innerHeight;
        mainCamera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
        holoPortal.handleResize();
    });

    const clock = new THREE.Clock();

    function animate() {
        requestAnimationFrame(animate);
        const delta = clock.getDelta();
        const elapsed = clock.getElapsedTime();
        controls.update();

        // 💡 실시간 상단 핸들 노드 제어 (최상위 4개 노드를 부드럽게 원형으로 회전 제어)
        const waveX = Math.sin(elapsed * 2.5) * 12.0;
        const waveZ = Math.cos(elapsed * 2.0) * 8.0;
        const sizeY = Math.cos(elapsed * 1.5) * 0.5 + 1.0; // Y축으로도 약간 펄스

        // 최하단 층(0~3번 노드)은 Anchor 고정
        for (let i = 0; i < 4; i++) {
            arapGrid.setHandle(i, arapGrid.restPositions[i]);
        }
        // 최상단 층(16~19번 노드)은 실시간 애니메이션 핸들링
        for (let i = 16; i < 20; i++) {
            const target = arapGrid.restPositions[i].clone();
            target.x += waveX;
            target.z += waveZ;
            // Y축 변형 제거 (rigidity 유지)
            arapGrid.setHandle(i, target);
        }

        // ARAP 솔버 연산 가동 (5회 → 너무 많은 iteration은 rigid 강화)
        arapGrid.solve(5);

        // 연산 결과 행렬 추출 및 텍스처 업데이트
        for (let i = 0; i < arapGrid.numBones; i++) {
            const p = arapGrid.currentPositions[i];
            const R = arapGrid.rotations[i];
            const rest = arapGrid.restPositions[i];
            
            // Rest 위치 오프셋 포함한 변환 행렬 구성
            const mCurrent = new THREE.Matrix4().makeTranslation(p.x, p.y, p.z);
            const mRot = new THREE.Matrix4().setFromMatrix3(R);
            const mRestInv = new THREE.Matrix4().makeTranslation(-rest.x, -rest.y, -rest.z);
            
            mCurrent.multiply(mRot);
            mCurrent.multiply(mRestInv);
            
            // Column-major로 직접 저장 (Three.js 기본 포맷)
            const arr = mCurrent.toArray();  // 이미 column-major
            const offset = i * 16;
            for (let k = 0; k < 16; k++) {
                boneData[offset + k] = arr[k];
            }

            if (debugBones[i]) debugBones[i].position.copy(p);
        }
        boneTexture.needsUpdate = true;

        holoPortal.update(delta);
        holoPortal.render();
    }

    animate();
}

initHoloPortal();