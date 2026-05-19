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

    async loadSplat(dropInViewer) {
        this.viewer = dropInViewer;
        this.splatScene.add(this.viewer);

        await this.viewer.addSplatScene(this.plyPath, {
            progressiveLoad: true,
            position: [0, this.cylinderHeight / 2 - 15, 0],
            scale: [this.splatScale, this.splatScale, this.splatScale],
        });
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
