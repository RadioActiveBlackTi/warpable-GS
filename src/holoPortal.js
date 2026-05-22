import * as THREE from 'three';

// Ripple function shared by CPU and GPU.
function getRippleZ(x, y, time, bendAmount, radius) {
    const amplitude = Math.min(Math.max(Math.abs(bendAmount), 0.0), 20.0);
    const r = Math.sqrt(x * x + y * y) / radius;

    if (r > 1.0) return 0.0;

    const rippleSpeed = 4.0;
    const rippleFreq = 22.0;
    const envelope = Math.exp(-r * 2.0);
    return Math.sin(r * rippleFreq - time * rippleSpeed) * envelope * amplitude;
}

export class HoloPortal {
    constructor(mainScene, mainCamera, renderer, plyPath, options = {}) {
        this.mainScene = mainScene;
        this.mainCamera = mainCamera;
        this.renderer = renderer;
        this.plyPath = plyPath;

        this.cylinderRadius = options.cylinderRadius ?? 50.0;
        this.cylinderHeight = options.cylinderHeight ?? 100.0;
        this.splatScale = options.splatScale ?? 15.0;

        // RTT setup.
        this.splatScene = new THREE.Scene();
        this.renderTarget = new THREE.WebGLRenderTarget(window.innerWidth, window.innerHeight, {
            format: THREE.RGBAFormat,
            type: THREE.HalfFloatType,
            minFilter: THREE.LinearFilter,
            magFilter: THREE.LinearFilter,
        });
        this.splatCamera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 1000);

        // Lid shader setup.
        const lidGeometry = new THREE.RingGeometry(0, this.cylinderRadius, 128, 64);

        this.lidUniforms = {
            map: { value: this.renderTarget.texture },
            uTime: { value: 0.0 },
            uBendAmount: { value: 2.0 },
            uDistanceFade: { value: 1.0 },
            uRadius: { value: this.cylinderRadius },
            uResolution: { value: new THREE.Vector2(window.innerWidth, window.innerHeight) },
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
            shader.uniforms.map = this.lidUniforms.map;
            shader.uniforms.uTime = this.lidUniforms.uTime;
            shader.uniforms.uBendAmount = this.lidUniforms.uBendAmount;
            shader.uniforms.uRadius = this.lidUniforms.uRadius;
            shader.uniforms.uDistanceFade = this.lidUniforms.uDistanceFade;
            shader.uniforms.uResolution = this.lidUniforms.uResolution;

            shader.vertexShader = `
                uniform float uTime;
                uniform float uBendAmount;
                uniform float uRadius;

                // Local slope passed to the fragment shader.
                varying vec2 vLocalSlope;

                float rippleFunc(vec2 p, float t, float b, float radius) {
                    float amplitude = clamp(abs(b), 0.0, 20.0);
                    float r = length(p) / radius;
                    if (r > 1.0) return 0.0;
                    float rippleSpeed = 4.0;
                    float rippleFreq = 22.0;
                    float envelope = exp(-r * 2.0);
                    return sin(r * rippleFreq - t * rippleSpeed) * envelope * amplitude;
                }
            ` + shader.vertexShader;

            // Inject the ripple deformation into Three.js normal generation.
            shader.vertexShader = shader.vertexShader.replace(
                '#include <beginnormal_vertex>',
                `
                float eps = 0.01;
                vec3 p0 = position;
                p0.z += rippleFunc(p0.xy, uTime, uBendAmount, uRadius);

                vec3 px = position + vec3(eps, 0.0, 0.0);
                px.z += rippleFunc(px.xy, uTime, uBendAmount, uRadius);

                vec3 py = position + vec3(0.0, eps, 0.0);
                py.z += rippleFunc(py.xy, uTime, uBendAmount, uRadius);

                vec3 T = normalize(px - p0);
                vec3 B = normalize(py - p0);
                vec3 localN = normalize(cross(T, B));

                vec3 objectNormal = localN;
                vLocalSlope = localN.xy;
                `
            );

            // Apply the ripple displacement to the vertex position.
            shader.vertexShader = shader.vertexShader.replace(
                '#include <begin_vertex>',
                `
                vec3 transformed = vec3(position);
                transformed.z += rippleFunc(position.xy, uTime, uBendAmount, uRadius);
                `
            );

            // Fragment shader setup.
            shader.fragmentShader = `
                uniform sampler2D map;
                uniform float uDistanceFade;
                uniform vec2 uResolution;
                varying vec2 vLocalSlope;
            ` + shader.fragmentShader;

            // Use screen-space UVs with a simple warp.
            shader.fragmentShader = shader.fragmentShader.replace(
                '#include <map_fragment>',
                `
                vec2 screenUv = gl_FragCoord.xy / uResolution.xy;
                float warpStrength = 0.06;
                vec2 uvOffset = vLocalSlope * warpStrength * uDistanceFade;
                vec2 warpedUv = clamp(screenUv + uvOffset, 0.0, 1.0);
                vec4 sampledDiffuseColor = texture2D(map, warpedUv);

                // Keep empty areas translucent so the water layer still reads as a surface.
                diffuseColor *= sampledDiffuseColor;
                diffuseColor.a = mix(0.28, 0.78, sampledDiffuseColor.a);
                `
            );

            shader.fragmentShader = shader.fragmentShader.replace(
                '#include <output_fragment>',
                `
                gl_FragColor = vec4(outgoingLight, diffuseColor.a);
                `
            );
        };

        this.lidMesh = new THREE.Mesh(lidGeometry, lidMaterial);
        this.lidMesh.position.y = this.cylinderHeight / 2;
        this.lidMesh.rotation.x = -Math.PI / 2;
        mainScene.add(this.lidMesh);

        // Cylinder body.
        const cylinderGeometry = new THREE.CylinderGeometry(
            this.cylinderRadius,
            this.cylinderRadius,
            this.cylinderHeight,
            64,
            1,
            true
        );
        this.surfaceMesh = new THREE.Mesh(
            cylinderGeometry,
            new THREE.MeshStandardMaterial({ color: 0x444455, roughness: 0.8, side: THREE.DoubleSide })
        );
        mainScene.add(this.surfaceMesh);

        // Internal test object.
        this.testCube = new THREE.Mesh(
            new THREE.BoxGeometry(15, 15, 15),
            new THREE.MeshStandardMaterial({ color: 0xff4444 })
        );
        this.testCube.position.set(0, this.cylinderHeight / 2 - 35, 0);
        this.splatScene.add(this.testCube);

        // Lighting for the RTT scene.
        this.splatScene.add(new THREE.AmbientLight(0xffffff, 1.2));
        const dirLight = new THREE.DirectionalLight(0xffffff, 2.5);
        dirLight.position.set(50, 100, 50);
        this.splatScene.add(dirLight);

        this.viewer = null;
        this.isUnderwater = false;
        this.wasUnderwater = false;
    }

    // 💡 1. 데이터를 받아오는 세터(Setter) 추가
    // 💡 1. main.js에서 보낸 데이터를 받는 함수
    setARAPData(restPositions, boneTexture, boneTextureWidth, boneTextureHeight) {
        this.restPositions = restPositions;
        this.boneTexture = boneTexture;
        this.boneTextureWidth = boneTextureWidth;
        this.boneTextureHeight = boneTextureHeight;
    }

    // 💡 2. 기존 loadSplat 함수 마지막에 주입 함수 호출 추가
    async loadSplat(dropInViewer) {
        this.viewer = dropInViewer;
        this.splatScene.add(this.viewer);

        await this.viewer.addSplatScene(this.plyPath, {
            progressiveLoad: true,
            position: [0, this.cylinderHeight / 2 - 15, 0],
            scale: [this.splatScale, this.splatScale, this.splatScale],
        });

        // 스플랫 로드 직후 가중치 계산 및 쉐이더 해킹 실행
        this.injectSkinning();
    }

    // 💡 3. 가우시안 런타임 가중치 베이킹 및 쉐이더 몽키 패치
    injectSkinning() {
        const splatMesh = this.viewer.splatMesh;
        if (!splatMesh || !this.restPositions) return;

        console.log("⏳ 가우시안 런타임 가중치 베이킹 시작...");
        
        const splatCount = splatMesh.getSplatCount();
        const mat = splatMesh.material;
        
        const texWidth = mat.uniforms.centersColorsTextureSize.value.x;
        const texHeight = mat.uniforms.centersColorsTextureSize.value.y;

        const skinIndices = new Float32Array(texWidth * texHeight * 4);
        const skinWeights = new Float32Array(texWidth * texHeight * 4);

        const sigma = 5.0; // 유연함 파라미터
        const center = new THREE.Vector3();

        // 라이브러리 버전 파편화를 막기 위한 안전한 중심점 추출 헬퍼
        let getSafeCenter;
        if (typeof splatMesh.getSplatCenter === 'function') {
            getSafeCenter = (i, out) => splatMesh.getSplatCenter(i, out);
        } else {
            // 구버전/내부 구조 변경 대응 폴백
            const buffer = splatMesh.scenes ? splatMesh.scenes[0].splatBuffer : splatMesh.splatBuffers[0];
            const centers = buffer.centers || buffer.getCenters();
            getSafeCenter = (i, out) => out.set(centers[i*3], centers[i*3+1], centers[i*3+2]);
        }

        // 스플랫의 Scale과 Position이 적용된 월드 행렬을 미리 업데이트합니다.
        splatMesh.updateMatrixWorld(true);

        // 30만개의 스플랫에 대해 24-Bone 가중치 계산
        for (let i = 0; i < splatCount; i++) {
            // 1. 안전하게 원본 중심점을 가져옵니다.
            getSafeCenter(i, center);
            
            // 2. 💡 매우 중요: Scale 15배, Position 이동이 적용된 '진짜 화면상 위치(World)'로 변환
            center.applyMatrix4(splatMesh.matrixWorld);

            let typedWeights = [];
            for (let b = 0; b < 24; b++) { // 현재 뼈대 24개
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

        mat.uniforms.boneTexture = { value: this.boneTexture };
        mat.uniforms.boneTextureWidth = { value: this.boneTextureWidth };
        mat.uniforms.boneTextureHeight = { value: this.boneTextureHeight };
        mat.uniforms.skinIndicesTexture = { value: skinIndicesTexture };
        mat.uniforms.skinWeightsTexture = { value: skinWeightsTexture };

        // ... (앞부분 skinWeightsTexture.needsUpdate = true; 까지는 그대로 유지) ...

        let modifiedShader = mat.vertexShader;
        
        modifiedShader = modifiedShader.replace(
            /void\s+main\s*\([^)]*\)\s*\{/,
            `
            uniform sampler2D boneTexture;
            uniform float boneTextureWidth;
            uniform float boneTextureHeight;
            uniform sampler2D skinIndicesTexture;
            uniform sampler2D skinWeightsTexture;

            // 💡 UV 좌표 계산(getDataUV, texture)을 모두 버리고, 정수형 픽셀 인덱스(texelFetch)로 직행
            mat4 getBoneMatrix(float boneIdx) {
                int bIdx = int(boneIdx);
                int texW = int(boneTextureWidth);
                int pixelStart = bIdx * 4;
                
                vec4 col0 = texelFetch(boneTexture, ivec2((pixelStart + 0) % texW, (pixelStart + 0) / texW), 0);
                vec4 col1 = texelFetch(boneTexture, ivec2((pixelStart + 1) % texW, (pixelStart + 1) / texW), 0);
                vec4 col2 = texelFetch(boneTexture, ivec2((pixelStart + 2) % texW, (pixelStart + 2) / texW), 0);
                vec4 col3 = texelFetch(boneTexture, ivec2((pixelStart + 3) % texW, (pixelStart + 3) / texW), 0);
                
                return mat4(col0, col1, col2, col3);
            }
            
            void main() {
            `
        );

        modifiedShader = modifiedShader.replace(
            'vec3 splatCenter = uintBitsToFloat(uvec3(sampledCenterColor.gba));',
            `
            vec3 splatCenter = uintBitsToFloat(uvec3(sampledCenterColor.gba));
            
            // 💡 라이브러리 내장 함수(getDataUV) 완전 폐기!
            // 스플랫 인덱스를 정수로 변환하여 텍스처에서 직접 가중치/인덱스 픽셀을 뽑아옵니다.
            int texW = int(centersColorsTextureSize.x);
            int sIdx = int(splatIndex);
            ivec2 texelCoord = ivec2(sIdx % texW, sIdx / texW);
            
            vec4 skinIdx = texelFetch(skinIndicesTexture, texelCoord, 0);
            vec4 skinW = texelFetch(skinWeightsTexture, texelCoord, 0);
            
            // LBS 계산
            mat4 skinMat = getBoneMatrix(skinIdx.x) * skinW.x +
                           getBoneMatrix(skinIdx.y) * skinW.y +
                           getBoneMatrix(skinIdx.z) * skinW.z +
                           getBoneMatrix(skinIdx.w) * skinW.w;
                           
            splatCenter = (skinMat * vec4(splatCenter, 1.0)).xyz;
            `
        );

        mat.vertexShader = modifiedShader;
        mat.needsUpdate = true;
        console.log("✅ 가우시안 쉐이더 texelFetch 해킹 및 모핑 적용 완료!");
    }

    update(deltaTime) {
        this.lidUniforms.uTime.value += deltaTime;

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

        // Fade the refraction effect as the camera approaches the surface.
        let fadeRatio = 1.0;
        if (isInCylinderRadius && distToSurface > 0.0) {
            const fadeDist = this.cylinderRadius * 0.4;
            fadeRatio = Math.min(1.0, distToSurface / fadeDist);
        }
        this.lidUniforms.uDistanceFade.value = fadeRatio;

        this.lidMesh.visible = !this.isUnderwater;

        // Swap the test cube and the splat viewer between scenes when the camera crosses the surface.
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

    render() {
        if (!this.isUnderwater) {
            // Above water: bake the RTT and draw the main scene.
            this.splatCamera.copy(this.mainCamera);

            const prevRT = this.renderer.getRenderTarget();
            this.renderer.setRenderTarget(this.renderTarget);
            this.renderer.setClearColor(0x000000, 0.0);
            this.renderer.clear(true, true, true);

            this.renderer.render(this.splatScene, this.splatCamera);

            this.renderer.setRenderTarget(prevRT);
            this.renderer.render(this.mainScene, this.mainCamera);
        } else {
            // Underwater: draw the main scene directly.
            this.renderer.render(this.mainScene, this.mainCamera);
        }
    }

    setBendAmount(val) {
        this.lidUniforms.uBendAmount.value = Math.min(Math.max(val, 0.0), 20.0);
    }

    setSplatScale(val) {
        this.splatScale = val * 15.0;
        if (this.viewer) {
            this.viewer.scale.setScalar(this.splatScale);
        }
    }

    setRadius(val) {
        this.cylinderRadius = val;
        this.lidUniforms.uRadius.value = val;
        this.lidMesh.geometry.dispose();
        this.lidMesh.geometry = new THREE.RingGeometry(0, val, 128, 64);
        this.surfaceMesh.geometry.dispose();
        this.surfaceMesh.geometry = new THREE.CylinderGeometry(val, val, this.cylinderHeight, 64, 1, true);
    }

    handleResize() {
        this.splatCamera.aspect = window.innerWidth / window.innerHeight;
        this.splatCamera.updateProjectionMatrix();
        this.renderTarget.setSize(window.innerWidth, window.innerHeight);
        this.lidUniforms.uResolution.value.set(window.innerWidth, window.innerHeight);
    }
}
