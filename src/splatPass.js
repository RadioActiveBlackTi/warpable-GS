import * as THREE from 'three';
import * as GaussianSplats3D from '@mkkellogg/gaussian-splats-3d';

export class SplatPass {
    /**
     * @param {{
     *  app: HTMLElement,
     *  renderer: THREE.WebGLRenderer,
     *  renderTarget: THREE.WebGLRenderTarget,
    *  depthRenderTarget: THREE.WebGLRenderTarget,
     *  plyPath: string,
     *  statusEl?: HTMLElement,
     *  cardObject: THREE.Object3D,
     *  splatFov?: number,
     *  clearColor?: number,
     *  clearAlpha?: number,
     *  parallaxStrength?: number,
     *  zOffset?: number,
     *  shAmplifyX?: number,
     *  shAmplifyY?: number,
     * }} options
     */
    constructor(options) {
        this.app = options.app;
        this.renderer = options.renderer;
        this.renderTarget = options.renderTarget;
        this.depthRenderTarget = options.depthRenderTarget;
        this.plyPath = options.plyPath;
        this.statusEl = options.statusEl;
        this.cardObject = options.cardObject;

        this.clearColor = options.clearColor ?? 0xBCC8D6;
        this.clearAlpha = options.clearAlpha ?? 1.0;
        this.parallaxStrength = options.parallaxStrength ?? 15.0;
        this.zOffset = options.zOffset ?? -1.0;
        this.shAmplifyX = options.shAmplifyX ?? 3.5;
        this.shAmplifyY = options.shAmplifyY ?? 3.5;

        this.scene = new THREE.Scene();
        const aspect = this.renderTarget.width / this.renderTarget.height;
        this.camera = new THREE.PerspectiveCamera(options.splatFov ?? 8.0, aspect, 0.1, 500);

        this.viewer = new GaussianSplats3D.Viewer({
            camera: this.camera,
            renderer: this.renderer,
            threeScene: this.scene,
            rootElement: this.app,
            selfDrivenMode: false,
            useBuiltInControls: false,
            sphericalHarmonicsDegree: 3,
        });

        this.inverseMatrix = new THREE.Matrix4();
        this.localCamPos = new THREE.Vector3();
        this.mainCamWorldPos = new THREE.Vector3();

        this.ready = false;
        this.splatMesh = null;
        this.splatMaterialShader = null;
    }

    async load() {
        if (this.statusEl) this.statusEl.textContent = 'PLY 로딩 중...';

        await this.viewer.addSplatScene(this.plyPath, {
            progressiveLoad: true,
            format: GaussianSplats3D.SceneFormat.Ply,
            splatAlphaRemovalThreshold: 5,
            position: [0, 0, 0],
            rotation: [0, 0, 0, 1],
            scale: [1, 1, 1],
        });

        this.ready = true;
        this.splatMesh = this.viewer.splatMesh;

        if (this.splatMesh) {
            this.splatMesh.visible = true;
            this.splatMesh.material.onBeforeCompile = (shader) => {
                shader.uniforms.fakeCamPos = { value: new THREE.Vector3() };
                shader.uniforms.u_renderDepthMode = { value: false };
                shader.uniforms.u_cameraNear = { value: this.camera.near };
                shader.uniforms.u_cameraFar = { value: this.camera.far };
                shader.vertexShader = `uniform vec3 fakeCamPos;\n` + shader.vertexShader;
                shader.vertexShader = shader.vertexShader.replace(/cameraPosition/g, 'fakeCamPos');

                shader.fragmentShader = `
                    uniform bool u_renderDepthMode;
                    uniform float u_cameraNear;
                    uniform float u_cameraFar;
                ` + shader.fragmentShader;

                shader.fragmentShader = shader.fragmentShader.replace(
                    /gl_FragColor\s*=\s*vec4\(color\.rgb, opacity\);/g,
                    `
                    if (u_renderDepthMode) {
                        float z = gl_FragCoord.z * 2.0 - 1.0;
                        float linearDepth = (2.0 * u_cameraNear * u_cameraFar) / (u_cameraFar + u_cameraNear - z * (u_cameraFar - u_cameraNear));
                        float normDepth = 1.0 - (linearDepth / u_cameraFar);
                        gl_FragColor = vec4(vec3(normDepth), opacity);
                    } else {
                        gl_FragColor = vec4(color.rgb, opacity);
                    }
                    `
                );

                this.splatMesh.material.userData.shader = shader;
                this.splatMaterialShader = shader;
            };
        }

        if (this.statusEl) this.statusEl.textContent = '지오메트리 일관성 파이프라인 정렬 완료.';
    }

    updateAndRenderToTarget(mainCamera) {
        if (!this.ready || !this.splatMesh) return;

        mainCamera.getWorldPosition(this.mainCamWorldPos);

        this.inverseMatrix.copy(this.cardObject.matrixWorld).invert();
        this.localCamPos.copy(this.mainCamWorldPos).applyMatrix4(this.inverseMatrix);

        if (this.splatMesh.material.userData.shader) {
            const shAmplify = new THREE.Vector3(
                this.localCamPos.x * this.shAmplifyX,
                this.localCamPos.y * this.shAmplifyY,
                this.localCamPos.z,
            );
            this.splatMesh.material.userData.shader.uniforms.fakeCamPos.value.copy(shAmplify);
        }

        const safeDir = this.localCamPos.clone().normalize();

        const fovRad = THREE.MathUtils.degToRad(this.camera.fov);
        const exactDistance = 1.0 / Math.tan(fovRad / 2);
        const camZ = exactDistance + this.zOffset;

        const shiftX = safeDir.x * this.parallaxStrength;
        const shiftY = safeDir.y * this.parallaxStrength;

        this.camera.position.set(shiftX, shiftY, camZ);
        this.camera.lookAt(shiftX, shiftY, 0);

        this.camera.updateMatrixWorld();
        this.camera.updateProjectionMatrix();

        const p0 = this.camera.projectionMatrix.elements[0];
        const p5 = this.camera.projectionMatrix.elements[5];
        this.camera.projectionMatrix.elements[8] = p0 * (-shiftX / camZ);
        this.camera.projectionMatrix.elements[9] = p5 * (-shiftY / camZ);

        const shader = this.splatMaterialShader || this.splatMesh.material.userData.shader;

        this.renderer.resetState();
        this.renderer.setRenderTarget(this.renderTarget);
        this.renderer.setClearColor(this.clearColor, this.clearAlpha);
        this.renderer.clear();

        if (shader) shader.uniforms.u_renderDepthMode.value = false;
        this.viewer.update();
        this.viewer.render();

        if (this.depthRenderTarget) {
            this.renderer.resetState();
            this.renderer.setRenderTarget(this.depthRenderTarget);
            this.renderer.setClearColor(0x000000, 1.0);
            this.renderer.clear();

            if (shader) shader.uniforms.u_renderDepthMode.value = true;
            this.viewer.update();
            this.viewer.render();
        }

        if (shader) shader.uniforms.u_renderDepthMode.value = false;

        this.renderer.resetState();
        this.renderer.setRenderTarget(null);
    }

    handleResize() {
        this.camera.aspect = this.renderTarget.width / this.renderTarget.height;
        this.camera.updateProjectionMatrix();
    }
}
