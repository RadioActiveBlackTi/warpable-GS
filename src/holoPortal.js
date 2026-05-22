import * as THREE from 'three';
import { getRippleZ } from './mathUtils.js';
import { setupLidShaderInjection, getGaussianSplatLBSInjection } from './shaders.js';
import { RBF_WEIGHTS, RIPPLE, PORTAL, LIGHTS } from './constants.js';

export class HoloPortal {
    constructor(mainScene, mainCamera, renderer, plyPath, options = {}) {
        this.mainScene = mainScene;
        this.mainCamera = mainCamera;
        this.renderer = renderer;
        this.plyPath = plyPath;

        this.cylinderRadius = options.cylinderRadius ?? PORTAL.CYLINDER_RADIUS;
        this.cylinderHeight = options.cylinderHeight ?? PORTAL.CYLINDER_HEIGHT;
        this.splatScale = options.splatScale ?? PORTAL.SPLAT_SCALE;

        // ====== RTT(Render-To-Texture) 세팅 ======
        this.splatScene = new THREE.Scene();
        this.renderTarget = new THREE.WebGLRenderTarget(window.innerWidth, window.innerHeight, {
            format: THREE.RGBAFormat,
            type: THREE.HalfFloatType,
            minFilter: THREE.LinearFilter,
            magFilter: THREE.LinearFilter,
        });
        this.splatCamera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 1000);

        // ====== Lid 메쉬 쉐이더 세팅 ======
        const lidGeometry = new THREE.RingGeometry(0, this.cylinderRadius, PORTAL.RING_SEGMENTS, PORTAL.RING_RADIAL_SEGMENTS);
        const lidShaderConfig = setupLidShaderInjection();

        this.lidUniforms = {
            map: { value: this.renderTarget.texture },
            ...lidShaderConfig.uniforms,
            uRadius: { value: this.cylinderRadius },
        };

        const lidMaterial = new THREE.MeshStandardMaterial({
            color: 0xffffff,
            roughness: 0.1,
            metalness: 0.1,
            side: THREE.FrontSide,
            transparent: true,
            depthWrite: false,
        });

        lidMaterial.onBeforeCompile = (shader) => {
            // 유니폼 할당
            shader.uniforms.map = this.lidUniforms.map;
            shader.uniforms.uTime = this.lidUniforms.uTime;
            shader.uniforms.uBendAmount = this.lidUniforms.uBendAmount;
            shader.uniforms.uRadius = this.lidUniforms.uRadius;
            shader.uniforms.uDistanceFade = this.lidUniforms.uDistanceFade;
            shader.uniforms.uResolution = this.lidUniforms.uResolution;

            // 버텍스 쉐이더 주입
            shader.vertexShader = lidShaderConfig.injectVertex + shader.vertexShader;

            shader.vertexShader = shader.vertexShader.replace(
                '#include <beginnormal_vertex>',
                lidShaderConfig.replaceNormalVertex
            );

            shader.vertexShader = shader.vertexShader.replace(
                '#include <begin_vertex>',
                lidShaderConfig.replaceBeginVertex
            );

            // 프래그먼트 쉐이더 주입
            shader.fragmentShader = lidShaderConfig.injectFragment + shader.fragmentShader;

            shader.fragmentShader = shader.fragmentShader.replace(
                '#include <map_fragment>',
                lidShaderConfig.replaceMapFragment
            );

            shader.fragmentShader = shader.fragmentShader.replace(
                '#include <output_fragment>',
                lidShaderConfig.replaceOutputFragment
            );
        };

        this.lidMesh = new THREE.Mesh(lidGeometry, lidMaterial);
        this.lidMesh.position.y = this.cylinderHeight / 2;
        this.lidMesh.rotation.x = -Math.PI / 2;
        mainScene.add(this.lidMesh);

        // ====== 실린더 바디 ======
        const cylinderGeometry = new THREE.CylinderGeometry(
            this.cylinderRadius,
            this.cylinderRadius,
            this.cylinderHeight,
            64,
            PORTAL.CYLINDER_HEIGHT_SEGMENTS,
            true
        );
        this.surfaceMesh = new THREE.Mesh(
            cylinderGeometry,
            new THREE.MeshStandardMaterial({ color: 0x444455, roughness: 0.8, side: THREE.DoubleSide })
        );
        mainScene.add(this.surfaceMesh);

        // ====== 내부 테스트 객체 ======
        this.testCube = new THREE.Mesh(
            new THREE.BoxGeometry(15, 15, 15),
            new THREE.MeshStandardMaterial({ color: 0xff4444 })
        );
        this.testCube.position.set(0, this.cylinderHeight / 2 - 35, 0);
        this.splatScene.add(this.testCube);

        // ====== RTT 씬 조명 ======
        this.splatScene.add(new THREE.AmbientLight(LIGHTS.RTT_AMBIENT_INTENSITY));
        const dirLight = new THREE.DirectionalLight(0xffffff, LIGHTS.RTT_DIRECTIONAL_INTENSITY);
        dirLight.position.set(...LIGHTS.LIGHT1_POS);
        this.splatScene.add(dirLight);

        this.viewer = null;
        this.isUnderwater = false;
        this.wasUnderwater = false;

        // ARAP 데이터 저장소
        this.restPositions = null;
        this.boneTexture = null;
        this.boneTextureWidth = 0;
        this.boneTextureHeight = 0;
    }

    /**
     * main.js에서 ARAP 데이터 수신
     */
    setARAPData(restPositions, boneTexture, boneTextureWidth, boneTextureHeight) {
        this.restPositions = restPositions;
        this.boneTexture = boneTexture;
        this.boneTextureWidth = boneTextureWidth;
        this.boneTextureHeight = boneTextureHeight;
    }

    /**
     * 스플랫 로드 및 스킨닝 주입
     */
    async loadSplat(dropInViewer) {
        this.viewer = dropInViewer;
        this.splatScene.add(this.viewer);

        await this.viewer.addSplatScene(this.plyPath, {
            progressiveLoad: true,
            position: [0, this.cylinderHeight / 2, 0],
            scale: [this.splatScale, this.splatScale, this.splatScale],
        });

        // 스플랫 로드 후 스킨닝 주입
        this.injectSkinning();
    }

    /**
     * 가우시안 스플랫에 LBS(Linear Blend Skinning) 주입
     * 런타임에 스플랫 센터를 뼈 애니메이션에 따라 변형
     */
    injectSkinning() {
        const splatMesh = this.viewer.splatMesh;
        if (!splatMesh || !this.restPositions) {
            console.warn('Cannot inject skinning: missing splatMesh or restPositions');
            return;
        }

        console.log('💡 가우시안 스플랫 스킨닝 주입 시작...');

        const splatCount = splatMesh.getSplatCount();
        const mat = splatMesh.material;
        const texWidth = mat.uniforms.centersColorsTextureSize.value.x;
        const texHeight = mat.uniforms.centersColorsTextureSize.value.y;

        // ====== 스플랫별 스킨 인덱스/가중치 텍스처 생성 ======
        const skinIndices = new Float32Array(texWidth * texHeight * 4);
        const skinWeights = new Float32Array(texWidth * texHeight * 4);

        const sigma = RBF_WEIGHTS.SPLAT_SIGMA;
        const center = new THREE.Vector3();

        // 안전한 센터 추출 헬퍼
        let getSafeCenter;
        if (typeof splatMesh.getSplatCenter === 'function') {
            getSafeCenter = (i, out) => splatMesh.getSplatCenter(i, out);
        } else {
            const buffer = splatMesh.scenes ? splatMesh.scenes[0].splatBuffer : splatMesh.splatBuffers[0];
            const centers = buffer.centers || buffer.getCenters();
            getSafeCenter = (i, out) => out.set(centers[i * 3], centers[i * 3 + 1], centers[i * 3 + 2]);
        }

        splatMesh.updateMatrixWorld(true);

        // 각 스플랫에 대해 상위 4개 뼈의 가중치 계산
        for (let i = 0; i < splatCount; i++) {
            getSafeCenter(i, center);
            center.applyMatrix4(splatMesh.matrixWorld);

            let typedWeights = [];
            for (let b = 0; b < this.restPositions.length; b++) {
                const dist = center.distanceTo(this.restPositions[b]);
                const w = Math.exp(-(dist * dist) / (2 * sigma * sigma));
                typedWeights.push({ index: b, weight: w });
            }

            typedWeights.sort((a, b) => b.weight - a.weight);
            const sum = typedWeights[0].weight + typedWeights[1].weight +
                        typedWeights[2].weight + typedWeights[3].weight + 1e-5;

            skinIndices[i * 4 + 0] = typedWeights[0].index;
            skinIndices[i * 4 + 1] = typedWeights[1].index;
            skinIndices[i * 4 + 2] = typedWeights[2].index;
            skinIndices[i * 4 + 3] = typedWeights[3].index;

            skinWeights[i * 4 + 0] = typedWeights[0].weight / sum;
            skinWeights[i * 4 + 1] = typedWeights[1].weight / sum;
            skinWeights[i * 4 + 2] = typedWeights[2].weight / sum;
            skinWeights[i * 4 + 3] = typedWeights[3].weight / sum;
        }

        const skinIndicesTexture = new THREE.DataTexture(skinIndices, texWidth, texHeight, THREE.RGBAFormat, THREE.FloatType);
        skinIndicesTexture.needsUpdate = true;
        const skinWeightsTexture = new THREE.DataTexture(skinWeights, texWidth, texHeight, THREE.RGBAFormat, THREE.FloatType);
        skinWeightsTexture.needsUpdate = true;

        // ====== 쉐이더에 유니폼 추가 ======
        mat.uniforms.boneTexture = { value: this.boneTexture };
        mat.uniforms.boneTextureWidth = { value: this.boneTextureWidth };
        mat.uniforms.boneTextureHeight = { value: this.boneTextureHeight };
        mat.uniforms.skinIndicesTexture = { value: skinIndicesTexture };
        mat.uniforms.skinWeightsTexture = { value: skinWeightsTexture };

        // ====== 버텍스 쉐이더 수정 ======
        const lbsInjection = getGaussianSplatLBSInjection();
        let modifiedShader = mat.vertexShader;

        modifiedShader = modifiedShader.replace(
            /void\s+main\s*\([^)]*\)\s*\{/,
            lbsInjection.mainFunctionPrefix
        );

        modifiedShader = modifiedShader.replace(
            'vec3 splatCenter = uintBitsToFloat(uvec3(sampledCenterColor.gba));',
            `vec3 splatCenter = uintBitsToFloat(uvec3(sampledCenterColor.gba));
            ${lbsInjection.splatCenterModification}`
        );

        mat.vertexShader = modifiedShader;
        mat.needsUpdate = true;

        console.log('✅ 가우시안 스플랫 LBS 주입 완료!');
    }

    /**
     * 매 프레임 업데이트
     */
    update(deltaTime) {
        this.lidUniforms.uTime.value += deltaTime;

        // 카메라 위치 기반 수중/수상 판정
        const localCamPos = this.lidMesh.worldToLocal(this.mainCamera.position.clone());
        const horizontalDist = Math.sqrt(localCamPos.x * localCamPos.x + localCamPos.y * localCamPos.y);

        const exactZ = getRippleZ(
            localCamPos.x,
            localCamPos.y,
            this.lidUniforms.uTime.value,
            this.lidUniforms.uBendAmount.value,
            this.cylinderRadius
        );

        const distToSurface = localCamPos.z - exactZ;
        const isInCylinderRadius = horizontalDist <= this.cylinderRadius;

        this.isUnderwater = isInCylinderRadius && distToSurface < 0.0;

        // 굴절 효과 페이드
        let fadeRatio = 1.0;
        if (isInCylinderRadius && distToSurface > 0.0) {
            const fadeDist = this.cylinderRadius * 0.4;
            fadeRatio = Math.min(1.0, distToSurface / fadeDist);
        }
        this.lidUniforms.uDistanceFade.value = fadeRatio;

        this.lidMesh.visible = !this.isUnderwater;

        // 카메라가 표면을 넘나들 때 개체 씬 변경
        if (this.isUnderwater !== this.wasUnderwater) {
            this.wasUnderwater = this.isUnderwater;

            if (this.isUnderwater) {
                this.mainScene.add(this.testCube);
                if (this.viewer) this.mainScene.add(this.viewer);
            } else {
                this.splatScene.add(this.testCube);
                if (this.viewer) this.splatScene.add(this.viewer);
            }
        }
    }

    /**
     * 렌더링
     */
    render() {
        if (!this.isUnderwater) {
            // 수상: RTT 렌더 후 메인 씬 렌더
            this.splatCamera.copy(this.mainCamera);

            const prevRT = this.renderer.getRenderTarget();
            this.renderer.setRenderTarget(this.renderTarget);
            this.renderer.setClearColor(0x000000, 0.0);
            this.renderer.clear(true, true, true);

            this.renderer.render(this.splatScene, this.splatCamera);

            this.renderer.setRenderTarget(prevRT);
            this.renderer.render(this.mainScene, this.mainCamera);
        } else {
            // 수중: 메인 씬만 렌더
            this.renderer.render(this.mainScene, this.mainCamera);
        }
    }

    // ====== 제어 메서드 ======
    setBendAmount(val) {
        this.lidUniforms.uBendAmount.value = Math.min(Math.max(val, 0.0), 20.0);
    }

    setSplatScale(val) {
        this.splatScale = val * PORTAL.SPLAT_SCALE;
        if (this.viewer) {
            this.viewer.scale.setScalar(this.splatScale);
        }
    }

    setRadius(val) {
        this.cylinderRadius = val;
        this.lidUniforms.uRadius.value = val;
        this.lidMesh.geometry.dispose();
        this.lidMesh.geometry = new THREE.RingGeometry(0, val, PORTAL.RING_SEGMENTS, PORTAL.RING_RADIAL_SEGMENTS);
        this.surfaceMesh.geometry.dispose();
        this.surfaceMesh.geometry = new THREE.CylinderGeometry(val, val, this.cylinderHeight, 64, PORTAL.CYLINDER_HEIGHT_SEGMENTS, true);
    }

    handleResize() {
        this.splatCamera.aspect = window.innerWidth / window.innerHeight;
        this.splatCamera.updateProjectionMatrix();
        this.renderTarget.setSize(window.innerWidth, window.innerHeight);
        this.lidUniforms.uResolution.value.set(window.innerWidth, window.innerHeight);
    }
}
