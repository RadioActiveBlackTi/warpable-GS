import * as THREE from 'three';

export class HoloCard {
    /**
     * @param {THREE.Scene} scene
     * @param {THREE.BufferGeometry} geometry
     * @param {THREE.Texture} rttTexture
     * @param {THREE.Texture} depthTexture
     * @param {THREE.Texture} backTexture
     * @param {string} deformFunctionGLSL
     */
    constructor(scene, geometry, rttTexture, depthTexture, backTexture, deformFunctionGLSL) {
        this.group = new THREE.Group();
        this.depthTexture = depthTexture;

        this.uniforms = {
            uTime: { value: 0.0 },
            uBendAmount: { value: 0.0 },
        };

        this.frontMat = new THREE.MeshStandardMaterial({
            map: rttTexture,
            transparent: false,
            toneMapped: false,
            roughness: 0.2,
            metalness: 0.01,
            side: THREE.FrontSide,
        });

        this.frontMat.onBeforeCompile = (shader) => {
            shader.uniforms.uTime = this.uniforms.uTime;
            shader.uniforms.uBendAmount = this.uniforms.uBendAmount;
            if (this.depthTexture) {
                shader.uniforms.uDepthMap = { value: this.depthTexture };
            }

            shader.vertexShader = `
                uniform float uTime;
                uniform float uBendAmount;
                varying vec3 vCurvedTangent;
                varying vec3 vCurvedBitangent;
                varying vec3 vCurvedNormal;
                varying vec3 vCurvedWorldViewDir;
                varying vec2 vArcLengthUv;

                vec3 applyDeformation(vec3 p, float t, float b) {
                    ${deformFunctionGLSL}
                }

                float getNumericU(float targetX, float y, float z, float t, float b) {
                    int steps = 15;
                    float startX = -31.5;
                    float endX = 31.5;

                    float totalLen = 0.0;
                    float stepTotal = (endX - startX) / float(steps);
                    vec3 prevP = applyDeformation(vec3(startX, y, z), t, b);
                    for (int i = 1; i <= 15; i++) {
                        vec3 currP = applyDeformation(vec3(startX + float(i) * stepTotal, y, z), t, b);
                        totalLen += distance(currP, prevP);
                        prevP = currP;
                    }

                    float currentLen = 0.0;
                    float stepCurr = (targetX - startX) / float(steps);
                    prevP = applyDeformation(vec3(startX, y, z), t, b);
                    for (int i = 1; i <= 15; i++) {
                        vec3 currP = applyDeformation(vec3(startX + float(i) * stepCurr, y, z), t, b);
                        currentLen += distance(currP, prevP);
                        prevP = currP;
                    }

                    return currentLen / (totalLen + 1e-7);
                }
            ` + shader.vertexShader;

            shader.vertexShader = shader.vertexShader.replace(
                '#include <begin_vertex>',
                `
                #include <begin_vertex>
                transformed = applyDeformation(position, uTime, uBendAmount);
                vArcLengthUv = vec2(getNumericU(position.x, position.y, position.z, uTime, uBendAmount), vMapUv.y);
                `
            );

            shader.vertexShader = shader.vertexShader.replace(
                '#include <project_vertex>',
                `
                #include <project_vertex>

                float eps = 0.1;
                vec3 px1 = applyDeformation(position + vec3(eps, 0.0, 0.0), uTime, uBendAmount);
                vec3 px2 = applyDeformation(position - vec3(eps, 0.0, 0.0), uTime, uBendAmount);
                vec3 localTangent = normalize(px1 - px2);

                vec3 py1 = applyDeformation(position + vec3(0.0, eps, 0.0), uTime, uBendAmount);
                vec3 py2 = applyDeformation(position - vec3(0.0, eps, 0.0), uTime, uBendAmount);
                vec3 localBitangent = normalize(py1 - py2);

                vec3 localNormal = normalize(cross(localTangent, localBitangent));

                vCurvedNormal = normalize(normalMatrix * localNormal);
                vCurvedTangent = normalize(normalMatrix * localTangent);
                vCurvedBitangent = normalize(normalMatrix * localBitangent);
                vCurvedWorldViewDir = (modelMatrix * vec4(transformed, 1.0)).xyz - cameraPosition;
                `
            );

            shader.fragmentShader = `
                varying vec3 vCurvedTangent;
                varying vec3 vCurvedBitangent;
                varying vec3 vCurvedNormal;
                varying vec3 vCurvedWorldViewDir;
                varying vec2 vArcLengthUv;
                ${this.depthTexture ? 'uniform sampler2D uDepthMap;' : ''}
            ` + shader.fragmentShader;

            shader.fragmentShader = shader.fragmentShader.replace(
                '#include <map_fragment>',
                `
                vec3 T = normalize(vCurvedTangent);
                vec3 B = normalize(vCurvedBitangent);
                vec3 N = normalize(vCurvedNormal);
                vec3 V = normalize(vCurvedWorldViewDir);

                vec3 localViewDir = vec3(dot(V, T), dot(V, B), dot(V, N));
                float hologramVirtualDepth = 0.06;
                float volumetricDepth = 1.0;
                ${this.depthTexture ? 'volumetricDepth = texture2D(uDepthMap, vArcLengthUv).r;' : ''}
                vec2 uvOffset = localViewDir.xy * (volumetricDepth * hologramVirtualDepth);

                vec2 warpedUv = clamp(vArcLengthUv + uvOffset, 0.0, 1.0);

                vec4 sampledDiffuseColor = texture2D(map, warpedUv);
                diffuseColor *= sampledDiffuseColor;
                `
            );
        };

        this.backMat = new THREE.MeshStandardMaterial({
            map: backTexture,
            roughness: 0.5,
            metalness: 0.2,
            side: THREE.BackSide,
        });

        this.backMat.onBeforeCompile = (shader) => {
            shader.uniforms.uTime = this.uniforms.uTime;
            shader.uniforms.uBendAmount = this.uniforms.uBendAmount;

            shader.vertexShader = `
                uniform float uTime;
                uniform float uBendAmount;

                vec3 applyDeformation(vec3 p, float t, float b) {
                    ${deformFunctionGLSL}
                }
            ` + shader.vertexShader;

            shader.vertexShader = shader.vertexShader.replace(
                '#include <begin_vertex>',
                `
                #include <begin_vertex>
                transformed = applyDeformation(position, uTime, uBendAmount);
                `
            );
        };

        this.meshFront = new THREE.Mesh(geometry, this.frontMat);
        this.meshBack = new THREE.Mesh(geometry, this.backMat);
        this.meshBack.position.z = -0.05;

        this.group.add(this.meshFront);
        this.group.add(this.meshBack);
        scene.add(this.group);
    }

    update(deltaTime) {
        this.uniforms.uTime.value += deltaTime;
    }
}
