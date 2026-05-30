import * as THREE from 'three';
import { setupLidShaderInjection, getGaussianSplatLBSInjection } from './shaders.js';
import { RBF_WEIGHTS, PORTAL, LIGHTS, ARAP } from './constants.js';
import { normalizeKeyframePayload, LoopingKeyframeAnimator } from './rigging/index.js';
import { DropInViewer } from '@mkkellogg/gaussian-splats-3d';

// [핵심 해결] 엉뚱한 VolumetricARAP 대신 mathUtils에서 함수를 바로 가져옵니다.
import { extractRotation3D, outerProduct3 } from './mathUtils.js';

export class HoloPortal {
    constructor(mainScene, mainCamera, renderer, plyPath, options = {}) {
        this.mainScene = mainScene;
        this.mainCamera = mainCamera;
        this.renderer = renderer;
        // 외부에서 전달된 transform animator 팩토리 맵 (키: 식별자 문자열, 값: factory(viewer, content, contentData))
        this.transformFactoryMap = options.transformFactoryMap || {};
        this.objectSceneMap = new WeakMap();

        this.cylinderRadius = options.cylinderRadius ?? PORTAL.CYLINDER_RADIUS;
        this.cylinderHeight = options.cylinderHeight ?? PORTAL.CYLINDER_HEIGHT;
        this.splatScale = options.splatScale ?? PORTAL.SPLAT_SCALE;
        this.color = options.color ?? 0x444455;
        this.portalPassMargin = options.portalPassMargin ?? 2.0;
        
        if (typeof plyPath === 'string') {
            this.contents = [{
                plyPath: plyPath,
                riggingDataPath: options.riggingDataPath || null,
                animationDataPath: options.animationDataPath || null,
                scene: options.scene || 'underwater',
                position: options.position || { x: 0, y: this.cylinderHeight / 2, z: 0 },
                rotation: options.rotation || { x: 0, y: 0, z: 0 },
                scale: options.scale || 1.0,
            }];
        } else if (Array.isArray(plyPath)) {
            this.contents = plyPath;
        } else {
            this.contents = [];
        }

        this.contentData = new Map();

        // RTT 세팅
        this.splatScene = new THREE.Scene();
        this.renderTarget = new THREE.WebGLRenderTarget(window.innerWidth, window.innerHeight, {
            format: THREE.RGBAFormat,
            type: THREE.HalfFloatType,
            minFilter: THREE.LinearFilter,
            magFilter: THREE.LinearFilter,
        });
        this.splatCamera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 1000);

        // 포탈 쉐이더 및 컵 메쉬 생성
        const lidGeometry = new THREE.RingGeometry(0, this.cylinderRadius, PORTAL.RING_SEGMENTS, PORTAL.RING_RADIAL_SEGMENTS);
        const lidShaderConfig = setupLidShaderInjection();

        this.lidUniforms = {
            map: { value: this.renderTarget.texture },
            uTime: { value: 0 },
            uBendAmount: { value: 0 },
            uRadius: { value: this.cylinderRadius },
            uDistanceFade: { value: 1.0 },
            uResolution: { value: new THREE.Vector2(window.innerWidth, window.innerHeight) }
        };

        const lidMaterial = new THREE.MeshStandardMaterial({
            color: 0xffffff, roughness: 0.1, metalness: 0.1,
            side: THREE.FrontSide, transparent: true, depthWrite: false,
        });

        lidMaterial.onBeforeCompile = (shader) => {
            Object.assign(shader.uniforms, this.lidUniforms);
            shader.vertexShader = lidShaderConfig.injectVertex + shader.vertexShader;
            shader.vertexShader = shader.vertexShader.replace('#include <beginnormal_vertex>', lidShaderConfig.replaceNormalVertex);
            shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', lidShaderConfig.replaceBeginVertex);
            shader.fragmentShader = lidShaderConfig.injectFragment + shader.fragmentShader;
            shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', lidShaderConfig.replaceMapFragment);
            shader.fragmentShader = shader.fragmentShader.replace('#include <output_fragment>', lidShaderConfig.replaceOutputFragment);
        };

        this.cupGroup = new THREE.Group();
        this.cupGroup.scale.setScalar(1.5);
        this.mainScene.add(this.cupGroup);

        this.lidMesh = new THREE.Mesh(lidGeometry, lidMaterial);
        this.lidMesh.position.y = this.cylinderHeight / 2 + 18;
        this.lidMesh.position.x = -3;
        this.lidMesh.position.z = -3;
        this.lidMesh.rotation.x = -Math.PI / 2;
        this.cupGroup.add(this.lidMesh);

        // this.surfaceMesh = new THREE.Mesh(
        //     new THREE.CylinderGeometry(this.cylinderRadius, this.cylinderRadius, this.cylinderHeight, 64, PORTAL.CYLINDER_HEIGHT_SEGMENTS, true),
        //     new THREE.MeshStandardMaterial({ color: this.color, roughness: 0.8, side: THREE.DoubleSide })
        // );
        // this.cupGroup.add(this.surfaceMesh);

        // const outerRatio = 1.1;
        // const outerCylinderMesh = new THREE.Mesh(
        //     new THREE.CylinderGeometry(this.cylinderRadius * outerRatio, this.cylinderRadius * outerRatio, this.cylinderHeight, 64, PORTAL.CYLINDER_HEIGHT_SEGMENTS, true),
        //     new THREE.MeshStandardMaterial({ color: this.color, roughness: 0.9, side: THREE.FrontSide })
        // );
        // this.cupGroup.add(outerCylinderMesh);

        // const rimMesh = new THREE.Mesh(
        //     new THREE.RingGeometry(this.cylinderRadius, this.cylinderRadius * outerRatio, 64),
        //     new THREE.MeshStandardMaterial({ color: this.color, roughness: 0.9, side: THREE.FrontSide })
        // );
        // rimMesh.rotation.x = -Math.PI / 2;
        // rimMesh.position.y = this.cylinderHeight / 2;
        // this.cupGroup.add(rimMesh);
        
        // const floorGeometry = new THREE.RingGeometry(0, this.cylinderRadius * outerRatio, 64);
        // const floorMesh = new THREE.Mesh(floorGeometry, new THREE.MeshStandardMaterial({ color: this.color, roughness: 0.9, side: THREE.FrontSide }));
        // floorMesh.rotation.x = -Math.PI / 2;
        // floorMesh.position.y = -this.cylinderHeight / 2 + 0.1;
        // this.cupGroup.add(floorMesh);

        // const floorMesh2 = new THREE.Mesh(floorGeometry, new THREE.MeshStandardMaterial({ color: this.color, roughness: 0.9, side: THREE.BackSide }));
        // floorMesh2.rotation.x = -Math.PI / 2;
        // floorMesh2.position.y = -this.cylinderHeight / 2;
        // this.cupGroup.add(floorMesh2);

        // const handleMesh = new THREE.Mesh(
        //     new THREE.TorusGeometry(27, 7, 16, 100, Math.PI),
        //     new THREE.MeshStandardMaterial({ color: this.color, roughness: 0.9, side: THREE.FrontSide })
        // );
        // handleMesh.rotation.z = -Math.PI / 2;
        // handleMesh.position.y = 5;
        // handleMesh.position.x = this.cylinderRadius;
        // this.cupGroup.add(handleMesh);
        // this.tagObjectScene(this.cupGroup, 'main');

        // 수중 환경
        this.underwaterLidMesh = this.lidMesh.clone();
        this.underwaterLidMesh.material = this.underwaterLidMesh.material.clone();
        this.underwaterLidMesh.material.color.set(0xe8fbff);
        this.underwaterLidMesh.material.emissive.set(0x7feaff);
        this.underwaterLidMesh.material.emissiveIntensity = 2.5;
        this.underwaterLidMesh.material.roughness = 0.02;
        this.underwaterLidMesh.material.metalness = 0.0;
        this.underwaterLidMesh.material.side = THREE.DoubleSide;
        this.underwaterLidMesh.material.transparent = true;
        this.underwaterLidMesh.material.opacity = 0.98;
        this.underwaterLidMesh.material.blending = THREE.AdditiveBlending;
        this.underwaterLidMesh.material.depthTest = false;
        this.underwaterLidMesh.material.depthWrite = false;
        this.underwaterLidMesh.material.toneMapped = false;
        this.underwaterLidMesh.visible = false;
        this.underwaterLidMesh.renderOrder = 999;
        this.tagObjectScene(this.underwaterLidMesh, 'underwater');
        this.splatScene.add(this.underwaterLidMesh);

        this.underwaterPortalLight = new THREE.PointLight(0x9fefff, 6.0, 500, 1.5);
        this.underwaterPortalUpLight = new THREE.PointLight(0xe8ffff, 8.0, 650, 2.0);
        this.underwaterPortalLight.visible = false;
        this.underwaterPortalUpLight.visible = false;
        this.tagObjectScene(this.underwaterPortalLight, 'underwater');
        this.tagObjectScene(this.underwaterPortalUpLight, 'underwater');
        this.splatScene.add(this.underwaterPortalLight, this.underwaterPortalUpLight);

        this._tmpPortalPos = new THREE.Vector3();
        this._tmpPortalQuat = new THREE.Quaternion();
        this._tmpPortalScale = new THREE.Vector3();

        // 조명 및 배경
        this.splatScene.add(new THREE.AmbientLight(LIGHTS.RTT_AMBIENT_INTENSITY));
        const dirLight = new THREE.DirectionalLight(0xffffff, LIGHTS.RTT_DIRECTIONAL_INTENSITY);
        dirLight.position.set(...LIGHTS.LIGHT1_POS);
        this.splatScene.add(dirLight);

        const upperLight = new THREE.DirectionalLight(0xffffff, LIGHTS.RTT_DIRECTIONAL_INTENSITY * 0.8);
        upperLight.position.set(0, 100, 0);
        this.splatScene.add(upperLight);

        const starGeometry = new THREE.BufferGeometry();
        const starCount = 150;
        const starPositions = new Float32Array(starCount * 3);
        for (let i = 0; i < starCount * 3; i += 3) {
            starPositions[i] = (Math.random() - 0.5) * 600;
            starPositions[i + 1] = (Math.random() - 0.5) * 600;
            starPositions[i + 2] = (Math.random() - 0.5) * 600;
        }
        starGeometry.setAttribute('position', new THREE.BufferAttribute(starPositions, 3));
        this.splatScene.add(new THREE.Points(starGeometry, new THREE.PointsMaterial({ size: 1.5, color: 0xffffff, sizeAttenuation: true })));

        this.isUnderwater = false;
        this.wasUnderwater = false;
        this.sceneChangeCallback = null;

        this.viewer = null;
        this.arap = null;
        this.restPositions = null;
        this.boneTexture = null;
    }

    tagObjectScene(object, sceneType) {
        if (!object) return object;
        object.traverse?.((child) => {
            child.userData = child.userData || {};
            child.userData.portalScene = sceneType;
            this.objectSceneMap.set(child, sceneType);
        });
        return object;
    }

    getObjectSceneType(object) {
        if (!object) return null;
        return object.userData?.portalScene || this.objectSceneMap.get(object) || null;
    }

    getContentSceneType(content) {
        return content?.scene || content?.sceneType || 'underwater';
    }

    // ==========================================================
    // ⭐ [핵심 복구] skinning_demo.js의 "진짜" ARAP 솔버
    // ==========================================================
    buildArapSystem(restPositions, neighborCount = 6) {
        const n = restPositions.length;
        const rest = restPositions.map((p) => p.clone());
        const current = restPositions.map((p) => p.clone());
        const rotations = Array.from({ length: n }, () => new THREE.Matrix3().identity());
        const edges = Array.from({ length: n }, () => []);

        for (let i = 0; i < n; i++) {
            const distances = [];
            for (let j = 0; j < n; j++) {
                if (i === j) continue;
                distances.push({ j, d: rest[i].distanceTo(rest[j]) });
            }
            distances.sort((a, b) => a.d - b.d);
            for (let k = 0; k < Math.min(neighborCount, distances.length); k++) {
                const j = distances[k].j;
                if (!edges[i].includes(j)) edges[i].push(j);
                if (!edges[j].includes(i)) edges[j].push(i);
            }
        }
        return { restPositions: rest, currentPositions: current, rotations, edges };
    }

    solveArap(arap, handles, iterations = 4) {
        if (!arap) return;
        const { restPositions, currentPositions, rotations, edges } = arap;

        for (let iter = 0; iter < iterations; iter++) {
            for (let i = 0; i < currentPositions.length; i++) {
                const p_i = currentPositions[i];
                const r_i = restPositions[i];
                let S = new THREE.Matrix3().set(0, 0, 0, 0, 0, 0, 0, 0, 0);

                for (const j of edges[i]) {
                    const dp = currentPositions[j].clone().sub(p_i);
                    const dr = restPositions[j].clone().sub(r_i);
                    const outer = outerProduct3(dp, dr);
                    for (let k = 0; k < 9; k++) S.elements[k] += outer.elements[k];
                }
                rotations[i] = extractRotation3D(S);
            }

            for (let i = 0; i < currentPositions.length; i++) {
                if (handles.has(i)) {
                    currentPositions[i].copy(handles.get(i));
                    continue;
                }
                const neighbors = edges[i];
                if (!neighbors.length) continue;

                const r_i = restPositions[i];
                const R_i = rotations[i];
                const posSum = new THREE.Vector3();

                for (const j of neighbors) {
                    const p_j = currentPositions[j];
                    const r_j = restPositions[j];
                    const R_j = rotations[j];
                    const dr = r_i.clone().sub(r_j);
                    const rotated_dr = dr.clone()
                        .applyMatrix3(R_i)
                        .add(dr.clone().applyMatrix3(R_j))
                        .multiplyScalar(0.5);
                    posSum.add(p_j.clone().add(rotated_dr));
                }
                const targetPos = posSum.divideScalar(neighbors.length);
                currentPositions[i].lerp(targetPos, 0.75);
            }
        }
    }

    onSceneChange(callback) { this.sceneChangeCallback = callback; }

    async waitForSplatMeshReady(viewer, maxWaitTime = 30000) {
        const startTime = Date.now();
        let lastSplatCount = 0;
        let stableSplatCount = 0;
        
        while (Date.now() - startTime < maxWaitTime) {
            const splatMesh = viewer?.splatMesh;
            if (splatMesh) {
                const splatCount = splatMesh.getSplatCount?.() ?? 0;
                const hasBuffer = !!splatMesh.scenes?.[0]?.splatBuffer || !!splatMesh.splatBuffers?.[0];
                const hasGeometry = !!splatMesh.geometry;
                const hasMat = !!splatMesh.material && !!splatMesh.material.uniforms;
                
                if (splatCount > 0 && hasBuffer && hasGeometry && hasMat) {
                    if (splatCount === lastSplatCount) {
                        stableSplatCount++;
                        if (stableSplatCount >= 10) return true;
                    } else {
                        stableSplatCount = 0;
                        lastSplatCount = splatCount;
                    }
                }
            }
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        return false;
    }

    getSplatCountAndCenters(splatMesh) {
        const splatCount = splatMesh?.getSplatCount?.() ?? 0;
        const centers = [];
        if (!splatMesh || splatCount <= 0) return { splatCount: 0, centers };

        if (typeof splatMesh.getSplatCenter === 'function') {
            const tmp = new THREE.Vector3();
            for (let i = 0; i < splatCount; i++) {
                splatMesh.getSplatCenter(i, tmp);
                centers.push(tmp.clone());
            }
            return { splatCount, centers };
        }

        const buffer = splatMesh.scenes?.[0]?.splatBuffer ?? splatMesh.splatBuffers?.[0];
        const rawCenters = buffer?.centers || buffer?.getCenters?.();
        if (rawCenters) {
            for (let i = 0; i < splatCount; i++) {
                centers.push(new THREE.Vector3(rawCenters[i * 3], rawCenters[i * 3 + 1], rawCenters[i * 3 + 2]));
            }
        }
        return { splatCount, centers };
    }

    async loadSplat() {
        console.log(`🚀 가우시안 스플랫 로드 시작...`);
        for (let i = 0; i < this.contents.length; i++) {
            const content = this.contents[i];
            const sceneType = this.getContentSceneType(content);
            try {
                const viewer = new DropInViewer({
                    gpuAcceleratedSort: false,
                    sharedMemoryForWorkers: false,
                    sphericalHarmonicsDegree: 2,
                });
                this.tagObjectScene(viewer, sceneType);
                const targetScene = sceneType === 'main' ? this.mainScene : this.splatScene;
                targetScene.add(viewer);

                if (!this.contentData.has(i)) this.contentData.set(i, {});
                const contentData = this.contentData.get(i);
                contentData.viewer = viewer;
                contentData.sceneType = sceneType;

                await viewer.addSplatScene(content.plyPath, {
                    progressiveLoad: false,
                    position: [0, 0, 0],
                    scale: [1, 1, 1],
                });
                await this.waitForSplatMeshReady(viewer, 30000);

                if (content.riggingDataPath) {
                    const success = await this.injectSkinningForContent(i, content.riggingDataPath);
                    if (success && content.animationDataPath) {
                        await this.loadAnimationForContent(i, content.animationDataPath);
                    }
                }

                viewer.position.set(0, this.cylinderHeight / 2, 0);
                viewer.scale.setScalar(this.splatScale);

                // ✨ [새로운] content별 position, rotation, scale 적용
                if (content.position) {
                    viewer.position.set(
                        content.position.x ?? 0,
                        content.position.y ?? this.cylinderHeight / 2,
                        content.position.z ?? 0
                    );
                }
                if (content.rotation) {
                    viewer.rotation.set(
                        content.rotation.x || 0,
                        content.rotation.y || 0,
                        content.rotation.z || 0
                    );
                }
                if (content.scale !== undefined && content.scale !== null) {
                    viewer.scale.setScalar(content.scale * PORTAL.SPLAT_SCALE);
                }

                // === content-specific transform animator 생성 ===
                // 우선 콘텐츠 객체에 `transformFactory` 함수가 있으면 사용합니다.
                // 없으면 생성자 옵션 `transformFactoryMap`의 키와 매칭되는 factory를 사용합니다.
                let animator = null;
                if (typeof content.transformFactory === 'function') {
                    try { animator = content.transformFactory(viewer, content, contentData); } catch (e) { console.error('transformFactory error:', e); }
                } else if (typeof content.plyPath === 'string') {
                    const path = content.plyPath;
                    for (const key of Object.keys(this.transformFactoryMap)) {
                        if (path.includes(key) && typeof this.transformFactoryMap[key] === 'function') {
                            try { animator = this.transformFactoryMap[key](viewer, content, contentData); } catch (e) { console.error('transformFactoryMap error:', e); }
                            if (animator) break;
                        }
                    }
                }
                if (animator) contentData.transformAnimator = animator;

                console.log(`✅ 레이어 [${i}] 로드 및 스킨닝 완료`);
            } catch (error) {
                console.error(`❌ 레이어 [${i}] 로드 실패:`, error);
            }
        }

        if (this.contentData.has(0)) {
            const first = this.contentData.get(0);
            this.viewer = first.viewer;
            this.restPositions = first.restPositions;
            this.boneTexture = first.boneTexture;
            this.boneTextureWidth = first.boneTextureWidth;
            this.boneTextureHeight = first.boneTextureHeight;
            this.arap = first.arap;
        }

        this.autoAdjustSplatCameraView();
    }

    async injectSkinningForContent(contentIndex, riggingDataPath) {
        const contentData = this.contentData.get(contentIndex);
        if (!contentData) return false;

        const response = await fetch(riggingDataPath);
        const riggingData = await response.json();
        
        let skinningPoints = [];
        if (Array.isArray(riggingData)) {
            skinningPoints = riggingData.map(p => new THREE.Vector3(p.x, p.y, p.z));
        } else if (riggingData.points) {
            skinningPoints = riggingData.points.map(p => Array.isArray(p) ? new THREE.Vector3(p[0], p[1], p[2]) : new THREE.Vector3(p.x, p.y, p.z));
        }

        // 🚨 드디어 문제를 일으키던 VolumetricARAP을 제거하고 네이티브 솔버를 가동합니다.
        const arap = this.buildArapSystem(skinningPoints, 6);

        contentData.arap = arap;
        contentData.restPositions = skinningPoints;
        this.updateBoneTextureForContent(contentIndex, arap);

        const viewer = contentData.viewer;
        const splatMesh = viewer.splatMesh;
        const mat = splatMesh.material;
        const texSize = mat.uniforms.centersColorsTextureSize.value;

        const texW = Math.max(1, texSize.x | 0);
        const texH = Math.max(1, texSize.y | 0);
        
        const { splatCount, centers } = this.getSplatCountAndCenters(splatMesh);
        if (centers.length === 0) return false;

        const skinIndices = new Float32Array(texW * texH * 4);
        const skinWeights = new Float32Array(texW * texH * 4);
        const sigma = 5.0;

        for (let i = 0; i < Math.min(centers.length, splatCount); i++) {
            const center = centers[i];
            const allWeights = skinningPoints.map((bonePos, idx) => {
                const dist = center.distanceTo(bonePos);
                const w = Math.exp(-(dist * dist) / (2 * sigma * sigma));
                return { index: idx, weight: w };
            }).sort((a, b) => b.weight - a.weight).slice(0, 4);

            const sum = Math.max(allWeights.reduce((acc, item) => acc + item.weight, 0), 1e-5);
            for (let j = 0; j < 4; j++) {
                const item = allWeights[j] || { index: 0, weight: 0 };
                skinIndices[i * 4 + j] = item.index;
                skinWeights[i * 4 + j] = item.weight / sum;
            }
        }

        contentData.skinIndicesTexture = new THREE.DataTexture(skinIndices, texW, texH, THREE.RGBAFormat, THREE.FloatType);
        contentData.skinIndicesTexture.internalFormat = 'RGBA32F';
        contentData.skinIndicesTexture.minFilter = THREE.NearestFilter;
        contentData.skinIndicesTexture.magFilter = THREE.NearestFilter;
        contentData.skinIndicesTexture.needsUpdate = true;

        contentData.skinWeightsTexture = new THREE.DataTexture(skinWeights, texW, texH, THREE.RGBAFormat, THREE.FloatType);
        contentData.skinWeightsTexture.internalFormat = 'RGBA32F';
        contentData.skinWeightsTexture.minFilter = THREE.NearestFilter;
        contentData.skinWeightsTexture.magFilter = THREE.NearestFilter;
        contentData.skinWeightsTexture.needsUpdate = true;

        mat.uniforms.boneTexture = { value: contentData.boneTexture };
        mat.uniforms.boneTextureWidth = { value: contentData.boneTextureWidth };
        mat.uniforms.boneTextureHeight = { value: contentData.boneTextureHeight };
        mat.uniforms.skinIndicesTexture = { value: contentData.skinIndicesTexture };
        mat.uniforms.skinWeightsTexture = { value: contentData.skinWeightsTexture };

        const injection = getGaussianSplatLBSInjection();
        if (!mat.vertexShader?.includes('skinIndicesTexture') && mat.vertexShader) {
            let vs = mat.vertexShader;
            vs = vs.replace(/void\s+main\s*\(\s*\)\s*\{/, injection.mainFunctionPrefix);
            vs = vs.replace(
                /vec3\s+splatCenter\s*=\s*uintBitsToFloat\s*\(\s*uvec3\s*\(\s*sampledCenterColor\s*\.\s*gba\s*\)\s*\)\s*;/,
                `vec3 splatCenter = uintBitsToFloat(uvec3(sampledCenterColor.gba));\n            ${injection.splatCenterModification}`
            );
            mat.vertexShader = vs;
            mat.needsUpdate = true;
        }

        return true;
    }

    async loadAnimationForContent(contentIndex, animationDataPath) {
        const contentData = this.contentData.get(contentIndex);
        if (!contentData || !contentData.arap) return false;

        const response = await fetch(animationDataPath);
        const payload = await response.json();
        const keyframes = normalizeKeyframePayload(payload);

        if (!Array.isArray(keyframes) || keyframes.length < 2) return false;

        const animator = new LoopingKeyframeAnimator({
            keyframes,
            restPositions: contentData.arap.restPositions,
            speed: contentData.animationSpeed ?? 1.0,
            iterations: contentData.keyframeArapIterations ?? 10,
        });

        animator.rebuild();
        animator.play(0);

        contentData.animator = animator;
        contentData.animationPlaying = true;
        return true;
    }

    updateBoneTextureForContent(contentIndex, arap) {
        const contentData = this.contentData.get(contentIndex);
        if (!contentData) return;

        const { currentPositions, restPositions, rotations } = arap;
        const count = Math.min(currentPositions.length, restPositions.length, rotations.length);
        const width = count * 4;

        if (!contentData.boneTexture || contentData.boneTextureWidth !== width) {
            contentData.boneTextureWidth = width;
            contentData.boneTextureHeight = 1;
            contentData.boneData = new Float32Array(width * 4);

            contentData.boneTexture = new THREE.DataTexture(contentData.boneData, width, 1, THREE.RGBAFormat, THREE.FloatType);
            contentData.boneTexture.internalFormat = 'RGBA32F';
            contentData.boneTexture.minFilter = THREE.NearestFilter;
            contentData.boneTexture.magFilter = THREE.NearestFilter;

            const viewer = contentData.viewer;
            if (viewer?.splatMesh?.material) {
                viewer.splatMesh.material.uniforms.boneTexture = { value: contentData.boneTexture };
                viewer.splatMesh.material.uniforms.boneTextureWidth = { value: width };
                viewer.splatMesh.material.uniforms.boneTextureHeight = { value: 1 };
            }
        }

        const boneData = contentData.boneData;
        const mCurrent = new THREE.Matrix4();
        const mRot = new THREE.Matrix4();
        const mRestInv = new THREE.Matrix4();

        for (let i = 0; i < count; i++) {
            const p = currentPositions[i];
            const rest = restPositions[i];
            const R = rotations[i];

            mCurrent.makeTranslation(p.x, p.y, p.z);
            mRot.setFromMatrix3(R);
            mRestInv.makeTranslation(-rest.x, -rest.y, -rest.z);
            mCurrent.multiply(mRot).multiply(mRestInv);

            const e = mCurrent.elements;
            const offset = i * 16;
            for (let j = 0; j < 16; j++) {
                boneData[offset + j] = e[j];
            }
        }

        contentData.boneTexture.needsUpdate = true;
    }

    update(deltaTime) {
        this.lidUniforms.uTime.value += deltaTime;

        this.contentData.forEach((contentData, contentIndex) => {
            // transform animator (per-content RBT-like motion) - run for all contents
            if (contentData.transformAnimator && contentData.viewer) {
                try {
                    contentData.transformAnimator.update(deltaTime, contentData.viewer);
                } catch (e) {
                    // ignore
                }
            }
            if (contentData.arap) {
                const arap = contentData.arap;

                if (contentData.animator && contentData.animationPlaying !== false) {
                    const handleMap = contentData.animator.update(deltaTime);
                    if (handleMap && handleMap.size > 0) {
                        this.solveArap(arap, handleMap, contentData.animator.iterations ?? ARAP.ITERATIONS ?? 4);
                        this.updateBoneTextureForContent(contentIndex, arap);
                    }
                } else {
                    // 모델이 터지는 것을 막기 위해 진폭을 1.5로 대폭 축소 (기존 12.0은 우주 파괴급)
                    contentData.animationTime = (contentData.animationTime || 0) + deltaTime;
                    const t = contentData.animationTime;
                    const handles = new Map();
                    const n = arap.restPositions.length;
                    
                    for (let i = 0; i < Math.min(4, n); i++) {
                        handles.set(i, arap.restPositions[i].clone());
                    }
                    const topLayerStart = Math.max(4, n - 4);
                    for (let i = topLayerStart; i < n; i++) {
                        const rest = arap.restPositions[i];
                        const phase = (i - topLayerStart) * Math.PI * 0.5;
                        handles.set(i, new THREE.Vector3(
                            rest.x + Math.sin(t * 2.5 + phase) * 1.5,
                            rest.y,
                            rest.z + Math.cos(t * 2.0 + phase) * 1.0
                        ));
                    }
                    this.solveArap(arap, handles, ARAP.ITERATIONS ?? 4);
                    this.updateBoneTextureForContent(contentIndex, arap);
                }
                    // update last dt used by transform animator
                    if (contentData.transformAnimator) contentData._animLastDt = deltaTime;
            }
        });

        const localCamPos = this.lidMesh.worldToLocal(this.mainCamera.position.clone());
        const horizontalDist = Math.sqrt(localCamPos.x * localCamPos.x + localCamPos.y * localCamPos.y);
        const isWithinPortalOpening = horizontalDist <= this.cylinderRadius;
        const isAbovePortalPlane = localCamPos.z > this.portalPassMargin;
        const isBelowPortalPlane = localCamPos.z < -this.portalPassMargin;

        if (isWithinPortalOpening) {
            if (isBelowPortalPlane) this.isUnderwater = true;
            else if (isAbovePortalPlane) this.isUnderwater = false;
        }

        let fadeRatio = 1.0;
        if (isWithinPortalOpening && isAbovePortalPlane) {
            fadeRatio = Math.min(1.0, localCamPos.z / (this.cylinderRadius * 0.4));
        }
        this.lidUniforms.uDistanceFade.value = fadeRatio;

        this.lidMesh.visible = !this.isUnderwater;
        this.underwaterLidMesh.visible = this.isUnderwater;
        this.underwaterPortalLight.visible = this.isUnderwater;
        this.underwaterPortalUpLight.visible = this.isUnderwater;

        this.cupGroup.updateMatrixWorld(true);
        this.lidMesh.getWorldPosition(this._tmpPortalPos);
        this.lidMesh.getWorldQuaternion(this._tmpPortalQuat);
        
        this.underwaterLidMesh.position.copy(this._tmpPortalPos);
        this.underwaterLidMesh.quaternion.copy(this._tmpPortalQuat);
        this.underwaterPortalLight.position.copy(this._tmpPortalPos).y += this.cylinderHeight * 0.45;
        this.underwaterPortalUpLight.position.copy(this._tmpPortalPos).y -= this.cylinderHeight * 0.28;

        if (this.isUnderwater !== this.wasUnderwater) {
            this.wasUnderwater = this.isUnderwater;
            if (this.sceneChangeCallback) this.sceneChangeCallback(this.isUnderwater ? 'enter' : 'exit');
        }
    }

    render() {
        this.splatCamera.copy(this.mainCamera);

        this.contentData.forEach((contentData) => {
            if (contentData.viewer) {
                if (contentData.viewer.camera) contentData.viewer.camera.copy(this.splatCamera);
                if (typeof contentData.viewer.update === 'function') {
                    try { contentData.viewer.update(); } catch (e) {}
                }
            }
        });

        if (!this.isUnderwater) {
            const prevRT = this.renderer.getRenderTarget();
            this.renderer.setRenderTarget(this.renderTarget);
            this.renderer.setClearColor(0x000000, 0.0);
            this.renderer.clear(true, true, true);

            this.renderer.render(this.splatScene, this.splatCamera);

            this.renderer.setRenderTarget(prevRT);
            this.renderer.render(this.mainScene, this.mainCamera);
        } else {
            this.renderer.render(this.splatScene, this.splatCamera);
        }
    }

    autoAdjustSplatCameraView() {
        return;
        // const bbox = new THREE.Box3();
        // this.splatScene.traverse(obj => {
        //     if (obj.geometry && obj.isMesh) bbox.union(new THREE.Box3().setFromObject(obj));
        // });

        // if (!bbox.isEmpty()) {
        //     const center = bbox.getCenter(new THREE.Vector3());
        //     const distance = Math.max(bbox.getSize(new THREE.Vector3()).x, 15) * 2.5;
        //     this.splatCamera.position.copy(center).addScaledVector(new THREE.Vector3(1, 0.5, 1).normalize(), distance);
        //     this.splatCamera.lookAt(center);
        //     this.splatCamera.updateProjectionMatrix();
        // }
    }

    setPosition(x, y, z) { this.cupGroup.position.set(x, y, z); }
    setRotation(x, y, z) { this.cupGroup.rotation.set(x, y, z); }
    setScale(s) { this.cupGroup.scale.setScalar(s); }
    setBendAmount(val) { this.lidUniforms.uBendAmount.value = THREE.MathUtils.clamp(val, 0.0, 20.0); }
    setSplatScale(val) {
        this.splatScale = val * PORTAL.SPLAT_SCALE;
        this.contentData.forEach(d => d.viewer?.scale.setScalar(this.splatScale));
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