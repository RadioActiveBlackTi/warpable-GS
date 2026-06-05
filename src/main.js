import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { HoloPortal } from "./holoPortal.js";
import { CAMERA, PORTAL } from "./constants.js";

async function initHoloPortal() {
  const app = document.getElementById("app");

  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: false,
  });

  renderer.setPixelRatio(window.devicePixelRatio || 1);
  renderer.setSize(window.innerWidth, window.innerHeight);
  app.appendChild(renderer.domElement);

  const mainScene = new THREE.Scene();

  const asset = (path) =>
    new URL(import.meta.env.BASE_URL + path, window.location.origin).href;

  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 512;

  const ctx = canvas.getContext("2d");

  const gradient = ctx.createLinearGradient(0, 0, 0, canvas.height);

  gradient.addColorStop(0, "#e8d5c4");
  gradient.addColorStop(0.5, "#c9b8a8");
  gradient.addColorStop(1, "#8b7d72");

  ctx.fillStyle = gradient;

  ctx.fillRect(0, 0, canvas.width, canvas.height);

  mainScene.background = new THREE.CanvasTexture(canvas);

  const tagSceneObject = (object, sceneType) => {
    if (!object) {
      return object;
    }

    object.traverse?.((child) => {
      child.userData = child.userData || {};
      child.userData.portalScene = sceneType;
    });

    return object;
  };

  const mainCamera = new THREE.PerspectiveCamera(
    CAMERA.MAIN_FOV,
    window.innerWidth / window.innerHeight,
    CAMERA.MAIN_NEAR,
    CAMERA.MAIN_FAR,
  );

  mainCamera.position.set(...CAMERA.MAIN_POS);

  mainCamera.lookAt(...CAMERA.MAIN_LOOK_AT);

  mainCamera.rotation.order = "YXZ";

  const controls = new OrbitControls(mainCamera, renderer.domElement);

  controls.enableDamping = true;
  controls.dampingFactor = 0.05;

  controls.zoomToCursor = true;
  controls.minDistance = 0.1;
  controls.maxDistance = 5000;
  controls.zoomSpeed = 1.2;

  const cameraModeToggle = document.getElementById("camera-mode-toggle");

  let cameraMode = cameraModeToggle?.checked ? "ego" : "orbit";

  const savedOrbitTarget = controls.target.clone();

  const egoState = {
    yaw: 0,
    pitch: 0,
  };

  const egoForward = new THREE.Vector3();

  const egoRight = new THREE.Vector3();

  const egoMove = new THREE.Vector3();

  const egoLookDir = new THREE.Vector3();

  const egoDrag = {
    active: false,
    lastX: 0,
    lastY: 0,
  };

  const syncEgoAnglesFromOrbit = () => {
    const direction = new THREE.Vector3()
      .subVectors(controls.target, mainCamera.position)
      .normalize();

    egoState.yaw = Math.atan2(direction.x, direction.z);

    egoState.pitch = Math.asin(THREE.MathUtils.clamp(direction.y, -1, 1));
  };

  const updateEgoCameraRotation = () => {
    mainCamera.rotation.set(egoState.pitch, egoState.yaw, 0, "YXZ");

    egoLookDir.set(0, 0, -1).applyQuaternion(mainCamera.quaternion).normalize();

    controls.target.copy(mainCamera.position).add(egoLookDir);
  };

  const setCameraMode = (mode) => {
    const previousMode = cameraMode;

    if (previousMode === "orbit" && mode === "ego") {
      savedOrbitTarget.copy(controls.target);
    }

    cameraMode = mode;

    const orbitMode = mode === "orbit";

    controls.enabled = orbitMode;

    controls.enableZoom = orbitMode;

    controls.enableRotate = orbitMode;

    controls.enablePan = orbitMode;

    if (mode === "ego") {
      syncEgoAnglesFromOrbit();
      updateEgoCameraRotation();

      renderer.domElement.style.cursor = "grab";
    } else {
      egoDrag.active = false;

      renderer.domElement.style.cursor = "";

      if (previousMode === "ego") {
        controls.target.copy(savedOrbitTarget);
      }

      controls.update();
    }
  };

  syncEgoAnglesFromOrbit();

  cameraModeToggle?.addEventListener("change", () => {
    setCameraMode(cameraModeToggle.checked ? "ego" : "orbit");
  });

  window.addEventListener("mousedown", (event) => {
    if (cameraMode !== "ego" || event.button !== 0) {
      return;
    }

    egoDrag.active = true;
    egoDrag.lastX = event.clientX;
    egoDrag.lastY = event.clientY;

    renderer.domElement.style.cursor = "grabbing";
  });

  window.addEventListener("mouseup", () => {
    egoDrag.active = false;

    if (cameraMode === "ego") {
      renderer.domElement.style.cursor = "grab";
    }
  });

  window.addEventListener("mousemove", (event) => {
    if (cameraMode !== "ego" || !egoDrag.active) {
      return;
    }

    const dx = event.clientX - egoDrag.lastX;

    const dy = event.clientY - egoDrag.lastY;

    egoDrag.lastX = event.clientX;

    egoDrag.lastY = event.clientY;

    egoState.yaw -= dx * 0.005;

    egoState.pitch -= dy * 0.005;

    egoState.pitch = THREE.MathUtils.clamp(
      egoState.pitch,
      -Math.PI / 2 + 0.05,
      Math.PI / 2 - 0.05,
    );

    updateEgoCameraRotation();
  });

  const keyState = {
    w: false,
    a: false,
    s: false,
    d: false,
    shift: false,
  };

  window.addEventListener("keydown", (event) => {
    const key = event.key.toLowerCase();

    if (key in keyState) {
      keyState[key] = true;
    }
  });

  window.addEventListener("keyup", (event) => {
    const key = event.key.toLowerCase();

    if (key in keyState) {
      keyState[key] = false;
    }
  });

  const moveEgoCamera = (deltaTime) => {
    if (cameraMode !== "ego") {
      return;
    }

    const moveSpeed = keyState.shift ? 220 : 120;

    const step = moveSpeed * deltaTime;

    mainCamera.getWorldDirection(egoForward).normalize();

    egoRight.crossVectors(egoForward, mainCamera.up).normalize();

    egoMove.set(0, 0, 0);

    if (keyState.w) {
      egoMove.add(egoForward);
    }

    if (keyState.s) {
      egoMove.sub(egoForward);
    }

    if (keyState.d) {
      egoMove.add(egoRight);
    }

    if (keyState.a) {
      egoMove.sub(egoRight);
    }

    if (egoMove.lengthSq() > 0) {
      egoMove.normalize().multiplyScalar(step);

      mainCamera.position.add(egoMove);

      updateEgoCameraRotation();
    }
  };

  const holoPortal = new HoloPortal(
    mainScene,
    mainCamera,
    renderer,
    [
      {
        plyPath: asset("mug.ply"),

        scene: "main",

        rotation: {
          x: 0,

          y: THREE.MathUtils.degToRad(5),

          z: Math.PI,
        },

        position: {
          x: 0,
          y: -90,
          z: 0,
        },

        scale: 35.0,
      },

      {
        plyPath: asset("space_background.ply"),

        scene: "underwater",

        rotation: {
          x: 0,
          y: 0,
          z: 0,
        },

        position: {
          x: 0,
          y: 0,
          z: 0,
        },

        scale: 3.0,
      },

      {
        plyPath: asset("arona/canonical.ply"),

        native4dgsManifest: asset("arona/native4dgs_manifest_lowrank.json"),

        native4dgsRuntimeOptions: {
          loop: true,

          playing: true,

          speed: 1.0,

          displacementScale: 1.0,
        },

        sphericalHarmonicsDegree: 0,

        splatAlphaRemovalThreshold: 0,

        optimizeSplatData: false,

        progressiveLoad: false,

        scene: "underwater",

        rotation: {
          x: 0,
          y: 0,
          z: 0,
        },

        position: {
          x: 100,
          y: -25,
          z: 0,
        },

        scale: 2.0,
      },

      {
        plyPath: asset("nubjuk_face_rg.ply"),

        riggingDataPath: asset(
          "nubjuk_face_rg_nodes300_sigma5.0/proxy_nodes.json",
        ),

        animationDataPath: asset("nubjuk_anim_1.json"),

        scene: "underwater",

        rotation: {
          x: 0,
          y: Math.PI,
          z: Math.PI,
        },

        position: {
          x: 0,
          y: -25,
          z: 0,
        },

        scale: 2.0,
      },

      {
        plyPath: asset("nubjuk_yg.ply"),

        riggingDataPath: asset(
          "nubjuk_face_rg_nodes300_sigma5.0/proxy_nodes.json",
        ),

        animationDataPath: asset("nubjuk_anim_swing.json"),

        scene: "underwater",

        rotation: {
          x: Math.PI / 2,

          y: 0,

          z: THREE.MathUtils.degToRad(160),
        },

        position: {
          x: 0,

          y: PORTAL.CYLINDER_HEIGHT + 18,

          z: 0,
        },

        scale: 1.5,

        transformFactory: (viewer) => {
          const basePosition = viewer.position.clone();

          return {
            time: Math.random() * Math.PI * 2,

            speed: 0.9,

            amplitude: 10,

            sway: 0.4,

            update(deltaTime, targetViewer) {
              this.time += deltaTime * this.speed;

              targetViewer.position.y =
                basePosition.y + Math.sin(this.time) * this.amplitude;

              targetViewer.rotation.z = Math.sin(this.time * 0.6) * this.sway;

              targetViewer.rotation.y += 0.01 * deltaTime;
            },
          };
        },
      },

      {
        plyPath: asset("nubjuk_red.ply"),

        riggingDataPath: asset(
          "nubjuk_face_rg_nodes300_sigma5.0/proxy_nodes.json",
        ),

        animationDataPath: asset("nubjuk_anim_swim.json"),

        scene: "underwater",

        rotation: {
          x: 0,
          y: 0,
          z: Math.PI,
        },

        position: {
          x: 0,
          y: -25,
          z: 0,
        },

        scale: 2.0,

        transformFactory: (viewer) => {
          const basePosition = viewer.position.clone();

          return {
            angle: 0,

            spin: 1.8,

            orbitSpeed: 0.6,

            radius: 200,

            update(deltaTime, targetViewer) {
              this.angle += this.orbitSpeed * deltaTime;

              targetViewer.position.x =
                basePosition.x + Math.cos(this.angle) * this.radius;

              targetViewer.position.z =
                basePosition.z + Math.sin(this.angle) * this.radius;

              targetViewer.rotation.x += this.spin * deltaTime;

              targetViewer.rotation.y += this.spin * 0.5 * deltaTime;
            },
          };
        },
      },

      {
        plyPath: asset("moon.ply"),

        scene: "underwater",

        rotation: {
          x: -Math.PI / 2,

          y: 0,

          z: 0,
        },

        position: {
          x: 0,
          y: -60,
          z: 0,
        },

        scale: 6.7,
      },
    ],
    {
      cylinderRadius: PORTAL.CYLINDER_RADIUS,

      cylinderHeight: PORTAL.CYLINDER_HEIGHT,
    },
  );

  holoPortal.setPosition(0, 60, 0);

  try {
    await holoPortal.loadSplat();
  } catch (error) {
    console.error("스플랫 로드 실패:", error);
  }

  window.holoPortal = holoPortal;

  const portalUI = document.createElement("div");

  portalUI.style.cssText = [
    "position:fixed",
    "right:16px",
    "top:16px",
    "z-index:9999",
    "width:220px",
    "padding:12px",
    "border-radius:12px",
    "background:rgba(0,0,0,0.65)",
    "color:#fff",
    "font:13px/1.4 system-ui,sans-serif",
  ].join(";");

  const amplitudeLabel = document.createElement("div");

  amplitudeLabel.textContent = "포탈 표면 물결 진폭";

  const amplitudeValue = document.createElement("div");

  amplitudeValue.textContent = "2.0";

  const amplitudeSlider = document.createElement("input");

  amplitudeSlider.type = "range";

  amplitudeSlider.min = "0";

  amplitudeSlider.max = "20";

  amplitudeSlider.step = "0.1";

  amplitudeSlider.value = "2.0";

  amplitudeSlider.style.width = "100%";

  amplitudeSlider.addEventListener("input", () => {
    const value = Number.parseFloat(amplitudeSlider.value);

    holoPortal.setBendAmount(value);

    amplitudeValue.textContent = value.toFixed(1);
  });

  portalUI.append(amplitudeLabel, amplitudeSlider, amplitudeValue);

  document.body.appendChild(portalUI);

  holoPortal.setBendAmount(2.0);

  const aronaContentIndex = holoPortal.contents.findIndex(
    (content) =>
      typeof content.plyPath === "string" &&
      content.plyPath.includes("arona/canonical.ply"),
  );

  const moonContentIndex = holoPortal.contents.findIndex(
    (content) =>
      typeof content.plyPath === "string" &&
      content.plyPath.includes("moon.ply"),
  );

  const aronaContentData = holoPortal.contentData.get(aronaContentIndex);

  const moonContentData = holoPortal.contentData.get(moonContentIndex);

  const aronaViewer = aronaContentData?.viewer ?? null;

  const aronaRuntime = aronaContentData?.native4dgsRuntime ?? null;

  const moonViewer = moonContentData?.viewer ?? null;

  window.aronaViewer = aronaViewer;

  window.aronaRuntime = aronaRuntime;

  window.moonViewer = moonViewer;

  const defaultSplatFootprint = 1.8;

  if (aronaViewer?.splatMesh?.setSplatScale) {
    aronaViewer.splatMesh.setSplatScale(defaultSplatFootprint);
  }

  const moonWorldPosition = new THREE.Vector3();

  const moonPositionInAronaParent = new THREE.Vector3();

  const getMoonCenterInAronaParent = () => {
    if (!moonViewer || !aronaViewer) {
      return moonPositionInAronaParent.set(0, 0, 0);
    }

    moonViewer.updateWorldMatrix(true, false);

    aronaViewer.parent?.updateWorldMatrix(true, false);

    moonViewer.getWorldPosition(moonWorldPosition);

    moonPositionInAronaParent.copy(moonWorldPosition);

    if (aronaViewer.parent) {
      aronaViewer.parent.worldToLocal(moonPositionInAronaParent);
    }

    return moonPositionInAronaParent;
  };

  const initialMoonCenter = getMoonCenterInAronaParent().clone();

  const initialOffsetX = aronaViewer
    ? aronaViewer.position.x - initialMoonCenter.x
    : 100;

  const initialOffsetZ = aronaViewer
    ? aronaViewer.position.z - initialMoonCenter.z
    : 0;

  const initialOrbitRadius = Math.max(
    1,
    Math.hypot(initialOffsetX, initialOffsetZ),
  );

  const aronaInitialState = aronaViewer
    ? {
        position: aronaViewer.position.clone(),

        rotation: aronaViewer.rotation.clone(),

        modelScale: aronaViewer.scale.x / PORTAL.SPLAT_SCALE,

        splatFootprint:
          aronaViewer.splatMesh?.getSplatScale?.() ?? defaultSplatFootprint,

        motionSpeed: aronaRuntime?.speed ?? 1.0,

        motionPlaying: aronaRuntime?.playing ?? true,
      }
    : null;

  const aronaPathState = {
    enabled: false,

    phase: Math.atan2(initialOffsetZ, initialOffsetX),

    radius: initialOrbitRadius,

    heightOffset: aronaViewer
      ? aronaViewer.position.y - initialMoonCenter.y
      : 35,

    angularSpeed: 0.35,

    followPathDirection: false,

    pitch: aronaViewer?.rotation.x ?? 0,

    yawOffset: aronaViewer?.rotation.y ?? 0,

    roll: aronaViewer?.rotation.z ?? 0,
  };

  const aronaPathForward = new THREE.Vector3();

  const aronaPathRight = new THREE.Vector3();

  const aronaPathWorldUp = new THREE.Vector3(0, 1, 0);

  const aronaPathCorrectedUp = new THREE.Vector3();

  const aronaPathRotationMatrix = new THREE.Matrix4();

  const aronaPathQuaternion = new THREE.Quaternion();

  const aronaPathOffsetQuaternion = new THREE.Quaternion();

  const aronaPathOffsetEuler = new THREE.Euler(0, 0, 0, "YXZ");

  const updateAronaTrajectory = (deltaTime) => {
    if (!aronaViewer || !moonViewer || !aronaPathState.enabled) {
      return;
    }

    aronaPathState.phase += deltaTime * aronaPathState.angularSpeed;

    const center = getMoonCenterInAronaParent();

    const cosPhase = Math.cos(aronaPathState.phase);

    const sinPhase = Math.sin(aronaPathState.phase);

    aronaViewer.position.set(
      center.x + cosPhase * aronaPathState.radius,

      center.y + aronaPathState.heightOffset,

      center.z + sinPhase * aronaPathState.radius,
    );

    if (aronaPathState.followPathDirection) {
      aronaPathForward
        .set(
          -sinPhase * aronaPathState.radius,
          0,
          cosPhase * aronaPathState.radius,
        )
        .normalize();

      aronaPathRight
        .crossVectors(aronaPathWorldUp, aronaPathForward)
        .normalize();

      aronaPathCorrectedUp
        .crossVectors(aronaPathForward, aronaPathRight)
        .normalize();

      aronaPathRotationMatrix.makeBasis(
        aronaPathRight,
        aronaPathCorrectedUp,
        aronaPathForward,
      );

      aronaPathQuaternion.setFromRotationMatrix(aronaPathRotationMatrix);

      aronaPathOffsetEuler.set(
        aronaPathState.pitch,
        aronaPathState.yawOffset,
        aronaPathState.roll,
        "YXZ",
      );

      aronaPathOffsetQuaternion.setFromEuler(aronaPathOffsetEuler);

      aronaViewer.quaternion
        .copy(aronaPathQuaternion)
        .multiply(aronaPathOffsetQuaternion);
    } else {
      aronaViewer.rotation.set(
        aronaPathState.pitch,
        aronaPathState.yawOffset,
        aronaPathState.roll,
      );
    }
  };

  const setAronaMotionPlaying = (playing) => {
    if (!aronaRuntime) {
      return;
    }

    if (typeof aronaRuntime.setPlaying === "function") {
      aronaRuntime.setPlaying(playing);
    } else {
      aronaRuntime.playing = Boolean(playing);
    }
  };

  const controlReferences = new Map();

  const aronaToggleButton = document.createElement("button");

  aronaToggleButton.type = "button";

  aronaToggleButton.textContent = "Arona controls";

  aronaToggleButton.style.cssText = [
    "position:fixed",
    "right:16px",
    "top:112px",
    "z-index:10000",
    "width:244px",
    "padding:9px 12px",
    "border:1px solid rgba(255,255,255,0.25)",
    "border-radius:10px",
    "background:rgba(0,0,0,0.78)",
    "color:#fff",
    "font:600 13px system-ui,sans-serif",
    "cursor:pointer",
  ].join(";");

  const aronaPanel = document.createElement("div");

  aronaPanel.style.cssText = [
    "display:none",
    "position:fixed",
    "right:16px",
    "top:154px",
    "z-index:9999",
    "width:300px",
    "max-height:calc(100vh - 170px)",
    "overflow:auto",
    "padding:12px",
    "border-radius:12px",
    "background:rgba(0,0,0,0.78)",
    "color:#fff",
    "font:13px/1.4 system-ui,sans-serif",
    "box-sizing:border-box",
  ].join(";");

  aronaToggleButton.addEventListener("click", () => {
    const opening = aronaPanel.style.display === "none";

    aronaPanel.style.display = opening ? "block" : "none";

    aronaToggleButton.textContent = opening
      ? "Close Arona controls"
      : "Arona controls";
  });

  const createSection = (title, open = false) => {
    const section = document.createElement("details");

    section.open = open;

    section.style.cssText = [
      "margin:0 0 10px",
      "border:1px solid rgba(255,255,255,0.16)",
      "border-radius:8px",
      "padding:8px",
    ].join(";");

    const summary = document.createElement("summary");

    summary.textContent = title;

    summary.style.cssText = [
      "cursor:pointer",
      "font-weight:700",
      "user-select:none",
    ].join(";");

    section.appendChild(summary);

    aronaPanel.appendChild(section);

    return section;
  };

  const createRange = ({
    parent,
    key,
    label,
    min,
    max,
    step,
    value,
    disabled = false,
    onInput,
  }) => {
    const row = document.createElement("div");

    row.style.marginTop = "9px";

    const header = document.createElement("div");

    header.style.cssText = [
      "display:flex",
      "justify-content:space-between",
      "gap:10px",
    ].join(";");

    const name = document.createElement("span");

    name.textContent = label;

    const decimals = step < 0.1 ? 2 : 1;

    const valueLabel = document.createElement("span");

    valueLabel.textContent = Number(value).toFixed(decimals);

    const input = document.createElement("input");

    input.type = "range";

    input.min = String(min);

    input.max = String(max);

    input.step = String(step);

    input.value = String(value);

    input.style.width = "100%";

    input.disabled = disabled;

    input.addEventListener("input", () => {
      const nextValue = Number.parseFloat(input.value);

      valueLabel.textContent = nextValue.toFixed(decimals);

      onInput(nextValue);
    });

    header.append(name, valueLabel);

    row.append(header, input);

    parent.appendChild(row);

    controlReferences.set(key, {
      input,
      valueLabel,
      decimals,
    });
  };

  const createCheckbox = ({
    parent,
    key,
    label,
    checked,
    disabled = false,
    onChange,
  }) => {
    const row = document.createElement("label");

    row.style.cssText = [
      "display:flex",
      "align-items:center",
      "gap:8px",
      "margin-top:9px",
      "cursor:pointer",
    ].join(";");

    const input = document.createElement("input");

    input.type = "checkbox";

    input.checked = checked;

    input.disabled = disabled;

    input.addEventListener("change", () => {
      onChange(input.checked);
    });

    const text = document.createElement("span");

    text.textContent = label;

    row.append(input, text);

    parent.appendChild(row);

    if (key) {
      controlReferences.set(key, {
        input,
      });
    }

    return input;
  };

  const setRangeValue = (key, value) => {
    const reference = controlReferences.get(key);

    if (!reference?.input || !reference.valueLabel) {
      return;
    }

    reference.input.value = String(value);

    reference.valueLabel.textContent = Number(value).toFixed(
      reference.decimals,
    );
  };

  const setControlDisabled = (key, disabled) => {
    const reference = controlReferences.get(key);

    if (reference?.input) {
      reference.input.disabled = disabled;
    }
  };

  const trajectorySection = createSection(
    "Circular trajectory around planet",
    true,
  );

  const trajectoryToggle = createCheckbox({
    parent: trajectorySection,

    key: "trajectoryEnabled",

    label: "Move Arona around planet",

    checked: false,

    disabled: !aronaViewer || !moonViewer,

    onChange: (enabled) => {
      if (!aronaViewer || !moonViewer) {
        return;
      }

      if (enabled) {
        const center = getMoonCenterInAronaParent();

        const offsetX = aronaViewer.position.x - center.x;

        const offsetZ = aronaViewer.position.z - center.z;

        aronaPathState.radius = Math.max(1, Math.hypot(offsetX, offsetZ));

        aronaPathState.phase = Math.atan2(offsetZ, offsetX);

        aronaPathState.heightOffset = aronaViewer.position.y - center.y;

        setRangeValue("orbitRadius", aronaPathState.radius);

        setRangeValue("orbitHeight", aronaPathState.heightOffset);
      }

      aronaPathState.enabled = enabled;

      setControlDisabled("positionX", enabled);

      setControlDisabled("positionY", enabled);

      setControlDisabled("positionZ", enabled);

      if (!enabled) {
        setRangeValue("positionX", aronaViewer.position.x);

        setRangeValue("positionY", aronaViewer.position.y);

        setRangeValue("positionZ", aronaViewer.position.z);
      }
    },
  });

  createRange({
    parent: trajectorySection,

    key: "orbitRadius",

    label: "Orbit radius",

    min: 1,

    max: 600,

    step: 1,

    value: aronaPathState.radius,

    disabled: !aronaViewer || !moonViewer,

    onInput: (value) => {
      aronaPathState.radius = value;
    },
  });

  createRange({
    parent: trajectorySection,

    key: "orbitHeight",

    label: "Height from planet center",

    min: -400,

    max: 400,

    step: 1,

    value: aronaPathState.heightOffset,

    disabled: !aronaViewer || !moonViewer,

    onInput: (value) => {
      aronaPathState.heightOffset = value;
    },
  });

  createRange({
    parent: trajectorySection,

    key: "orbitSpeed",

    label: "Orbit speed",

    min: -2,

    max: 2,

    step: 0.01,

    value: aronaPathState.angularSpeed,

    disabled: !aronaViewer || !moonViewer,

    onInput: (value) => {
      aronaPathState.angularSpeed = value;
    },
  });

  const followPathDirectionToggle = createCheckbox({
    parent: trajectorySection,

    key: "followPathDirection",

    label: "Walk facing path direction",

    checked: aronaPathState.followPathDirection,

    disabled: !aronaViewer || !moonViewer,

    onChange: (enabled) => {
      aronaPathState.followPathDirection = enabled;

      if (!enabled && aronaViewer) {
        aronaViewer.rotation.set(
          aronaPathState.pitch,
          aronaPathState.yawOffset,
          aronaPathState.roll,
        );
      }
    },
  });

  const scaleSection = createSection("Scale and density", true);

  createRange({
    parent: scaleSection,

    key: "modelScale",

    label: "Model scale",

    min: 0.1,

    max: 10,

    step: 0.05,

    value: aronaInitialState?.modelScale ?? 1,

    disabled: !aronaViewer,

    onInput: (value) => {
      aronaViewer?.scale.setScalar(value * PORTAL.SPLAT_SCALE);
    },
  });

  createRange({
    parent: scaleSection,

    key: "splatFootprint",

    label: "Splat footprint",

    min: 0.1,

    max: 4,

    step: 0.05,

    value: aronaInitialState?.splatFootprint ?? defaultSplatFootprint,

    disabled: !aronaViewer?.splatMesh?.setSplatScale,

    onInput: (value) => {
      aronaViewer?.splatMesh?.setSplatScale?.(value);
    },
  });

  const motionSection = createSection("Motion", true);

  createRange({
    parent: motionSection,

    key: "motionSpeed",

    label: "Walking motion speed",

    min: 0,

    max: 4,

    step: 0.05,

    value: aronaInitialState?.motionSpeed ?? 1,

    disabled: !aronaRuntime,

    onInput: (value) => {
      if (aronaRuntime) {
        aronaRuntime.speed = value;
      }
    },
  });

  const motionPlayingToggle = createCheckbox({
    parent: motionSection,

    key: "motionPlaying",

    label: "Play walking deformation",

    checked: aronaInitialState?.motionPlaying ?? true,

    disabled: !aronaRuntime,

    onChange: setAronaMotionPlaying,
  });

  const placeSection = createSection("Static place", false);

  createRange({
    parent: placeSection,

    key: "positionX",

    label: "Position X",

    min: -600,

    max: 600,

    step: 1,

    value: aronaViewer?.position.x ?? 0,

    disabled: !aronaViewer,

    onInput: (value) => {
      if (aronaViewer && !aronaPathState.enabled) {
        aronaViewer.position.x = value;
      }
    },
  });

  createRange({
    parent: placeSection,

    key: "positionY",

    label: "Position Y",

    min: -400,

    max: 400,

    step: 1,

    value: aronaViewer?.position.y ?? 0,

    disabled: !aronaViewer,

    onInput: (value) => {
      if (aronaViewer && !aronaPathState.enabled) {
        aronaViewer.position.y = value;
      }
    },
  });

  createRange({
    parent: placeSection,

    key: "positionZ",

    label: "Position Z",

    min: -600,

    max: 600,

    step: 1,

    value: aronaViewer?.position.z ?? 0,

    disabled: !aronaViewer,

    onInput: (value) => {
      if (aronaViewer && !aronaPathState.enabled) {
        aronaViewer.position.z = value;
      }
    },
  });

  const normalSection = createSection("Normal / facing direction", false);

  createRange({
    parent: normalSection,

    key: "pitch",

    label: "Pitch X",

    min: -180,

    max: 180,

    step: 1,

    value: THREE.MathUtils.radToDeg(aronaPathState.pitch),

    disabled: !aronaViewer,

    onInput: (value) => {
      aronaPathState.pitch = THREE.MathUtils.degToRad(value);

      if (aronaViewer && !aronaPathState.enabled) {
        aronaViewer.rotation.x = aronaPathState.pitch;
      }
    },
  });

  createRange({
    parent: normalSection,

    key: "yaw",

    label: "Yaw offset Y",

    min: -180,

    max: 180,

    step: 1,

    value: THREE.MathUtils.radToDeg(aronaPathState.yawOffset),

    disabled: !aronaViewer,

    onInput: (value) => {
      aronaPathState.yawOffset = THREE.MathUtils.degToRad(value);

      if (aronaViewer && !aronaPathState.enabled) {
        aronaViewer.rotation.y = aronaPathState.yawOffset;
      }
    },
  });

  createRange({
    parent: normalSection,

    key: "roll",

    label: "Roll Z",

    min: -180,

    max: 180,

    step: 1,

    value: THREE.MathUtils.radToDeg(aronaPathState.roll),

    disabled: !aronaViewer,

    onInput: (value) => {
      aronaPathState.roll = THREE.MathUtils.degToRad(value);

      if (aronaViewer && !aronaPathState.enabled) {
        aronaViewer.rotation.z = aronaPathState.roll;
      }
    },
  });

  const actionRow = document.createElement("div");

  actionRow.style.cssText = [
    "display:grid",
    "grid-template-columns:1fr 1fr",
    "gap:8px",
    "margin-top:10px",
  ].join(";");

  const focusButton = document.createElement("button");

  focusButton.type = "button";

  focusButton.textContent = "Focus Arona";

  focusButton.disabled = !aronaViewer;

  focusButton.style.cssText = [
    "padding:8px",
    "border:0",
    "border-radius:7px",
    "cursor:pointer",
  ].join(";");

  focusButton.addEventListener("click", () => {
    if (!aronaViewer) {
      return;
    }

    const target = new THREE.Vector3();

    aronaViewer.updateMatrixWorld(true);

    aronaViewer.getWorldPosition(target);

    controls.target.copy(target);

    mainCamera.position.set(target.x + 220, target.y + 70, target.z + 220);

    mainCamera.lookAt(target);

    if (cameraMode === "ego") {
      syncEgoAnglesFromOrbit();
      updateEgoCameraRotation();
    } else {
      controls.update();
    }
  });

  const resetButton = document.createElement("button");

  resetButton.type = "button";

  resetButton.textContent = "Reset Arona";

  resetButton.disabled = !aronaViewer;

  resetButton.style.cssText = [
    "padding:8px",
    "border:0",
    "border-radius:7px",
    "cursor:pointer",
  ].join(";");

  resetButton.addEventListener("click", () => {
    if (!aronaViewer || !aronaInitialState) {
      return;
    }

    aronaPathState.enabled = false;

    trajectoryToggle.checked = false;

    aronaViewer.position.copy(aronaInitialState.position);

    aronaViewer.rotation.copy(aronaInitialState.rotation);

    aronaViewer.scale.setScalar(
      aronaInitialState.modelScale * PORTAL.SPLAT_SCALE,
    );

    aronaViewer.splatMesh?.setSplatScale?.(aronaInitialState.splatFootprint);

    if (aronaRuntime) {
      aronaRuntime.speed = aronaInitialState.motionSpeed;
    }

    setAronaMotionPlaying(aronaInitialState.motionPlaying);

    motionPlayingToggle.checked = aronaInitialState.motionPlaying;

    const center = getMoonCenterInAronaParent();

    const offsetX = aronaViewer.position.x - center.x;

    const offsetZ = aronaViewer.position.z - center.z;

    aronaPathState.radius = Math.max(1, Math.hypot(offsetX, offsetZ));

    aronaPathState.phase = Math.atan2(offsetZ, offsetX);

    aronaPathState.heightOffset = aronaViewer.position.y - center.y;

    aronaPathState.angularSpeed = 0.35;

    aronaPathState.followPathDirection = false;

    aronaPathState.pitch = aronaInitialState.rotation.x;

    aronaPathState.yawOffset = aronaInitialState.rotation.y;

    aronaPathState.roll = aronaInitialState.rotation.z;

    followPathDirectionToggle.checked = false;

    setControlDisabled("positionX", false);

    setControlDisabled("positionY", false);

    setControlDisabled("positionZ", false);

    setRangeValue("orbitRadius", aronaPathState.radius);

    setRangeValue("orbitHeight", aronaPathState.heightOffset);

    setRangeValue("orbitSpeed", aronaPathState.angularSpeed);

    setRangeValue("modelScale", aronaInitialState.modelScale);

    setRangeValue("splatFootprint", aronaInitialState.splatFootprint);

    setRangeValue("motionSpeed", aronaInitialState.motionSpeed);

    setRangeValue("positionX", aronaInitialState.position.x);

    setRangeValue("positionY", aronaInitialState.position.y);

    setRangeValue("positionZ", aronaInitialState.position.z);

    setRangeValue("pitch", THREE.MathUtils.radToDeg(aronaPathState.pitch));

    setRangeValue("yaw", THREE.MathUtils.radToDeg(aronaPathState.yawOffset));

    setRangeValue("roll", THREE.MathUtils.radToDeg(aronaPathState.roll));
  });

  actionRow.append(focusButton, resetButton);

  aronaPanel.appendChild(actionRow);

  if (!aronaViewer || !moonViewer) {
    const warning = document.createElement("div");

    warning.textContent = !aronaViewer
      ? "Arona viewer was not found."
      : "Moon viewer was not found.";

    warning.style.cssText = ["margin-top:10px", "color:#ff9d9d"].join(";");

    aronaPanel.appendChild(warning);
  }

  document.body.append(aronaToggleButton, aronaPanel);

  const light1 = new THREE.DirectionalLight(0xffd9a8, 2.5);

  light1.position.set(150, 200, 100);

  light1.castShadow = true;

  tagSceneObject(light1, "main");

  const light2 = new THREE.DirectionalLight(0xb8d4ff, 1.5);

  light2.position.set(-150, 180, -150);

  tagSceneObject(light2, "main");

  const ambientLight = new THREE.AmbientLight(0xf5e6d3, 0.9);

  tagSceneObject(ambientLight, "main");

  mainScene.add(light1, light2, ambientLight);

  const floorGeometry = new THREE.PlaneGeometry(1200, 1200);

  const floorMaterial = new THREE.MeshStandardMaterial({
    color: 0xa89080,

    roughness: 0.7,
  });

  const floorMesh = new THREE.Mesh(floorGeometry, floorMaterial);

  floorMesh.rotation.x = -Math.PI / 2;

  floorMesh.position.y = -150;

  floorMesh.receiveShadow = true;

  tagSceneObject(floorMesh, "main");

  mainScene.add(floorMesh);

  const tableTopMesh = new THREE.Mesh(
    new THREE.BoxGeometry(800, 30, 600),

    new THREE.MeshStandardMaterial({
      color: 0x8b6f47,

      roughness: 0.6,
    }),
  );

  tableTopMesh.position.y = -40;

  tableTopMesh.castShadow = true;

  tableTopMesh.receiveShadow = true;

  tagSceneObject(tableTopMesh, "main");

  mainScene.add(tableTopMesh);

  const tableLegGeometry = new THREE.BoxGeometry(18, 130, 18);

  const tableLegMaterial = new THREE.MeshStandardMaterial({
    color: 0x6b5436,

    roughness: 0.7,
  });

  [
    [-360, -85, -260],
    [360, -85, -260],
    [-360, -85, 260],
    [360, -85, 260],
  ].forEach((position) => {
    const leg = new THREE.Mesh(tableLegGeometry, tableLegMaterial);

    leg.position.set(...position);

    leg.castShadow = true;

    leg.receiveShadow = true;

    tagSceneObject(leg, "main");

    mainScene.add(leg);
  });

  const addProp = (geometry, material, position, rotationZ = 0) => {
    const mesh = new THREE.Mesh(geometry, material);

    mesh.position.set(...position);

    mesh.rotation.z = rotationZ;

    mesh.castShadow = true;

    mesh.receiveShadow = true;

    tagSceneObject(mesh, "main");

    mainScene.add(mesh);
  };

  const bookGeometry = new THREE.BoxGeometry(45, 12, 30);

  addProp(
    bookGeometry,

    new THREE.MeshStandardMaterial({
      color: 0xc1402d,

      roughness: 0.7,
    }),

    [-250, 0, -120],

    0.15,
  );

  addProp(
    bookGeometry,

    new THREE.MeshStandardMaterial({
      color: 0x4a5f8f,

      roughness: 0.7,
    }),

    [-250, 12, -80],

    -0.1,
  );

  addProp(
    new THREE.BoxGeometry(50, 10, 40),

    new THREE.MeshStandardMaterial({
      color: 0x8b7d6b,

      roughness: 0.8,
    }),

    [-120, 0, 180],

    0.2,
  );

  addProp(
    new THREE.CylinderGeometry(2.5, 2.5, 25, 8),

    new THREE.MeshStandardMaterial({
      color: 0x3d3d3d,

      roughness: 0.4,
    }),

    [-70, 12, 190],

    0.3,
  );

  addProp(
    new THREE.CylinderGeometry(20, 20, 30, 32),

    new THREE.MeshStandardMaterial({
      color: 0xffffff,

      roughness: 0.3,
    }),

    [280, 8, 160],
  );

  addProp(
    new THREE.CylinderGeometry(35, 35, 2, 32),

    new THREE.MeshStandardMaterial({
      color: 0xf5f5dc,

      roughness: 0.5,
    }),

    [300, 0, -130],
  );

  addProp(
    new THREE.BoxGeometry(4, 4, 20),

    new THREE.MeshStandardMaterial({
      color: 0xc0a080,

      roughness: 0.4,

      metalness: 0.6,
    }),

    [200, 5, -180],

    0.4,
  );

  const cupPad = new THREE.Mesh(
    new THREE.CylinderGeometry(90, 90, 3, 32),

    new THREE.MeshStandardMaterial({
      color: 0xb8a89a,

      roughness: 0.8,
    }),
  );

  cupPad.position.y = -17;

  cupPad.receiveShadow = true;

  tagSceneObject(cupPad, "main");

  mainScene.add(cupPad);

  window.addEventListener("resize", () => {
    mainCamera.aspect = window.innerWidth / window.innerHeight;

    mainCamera.updateProjectionMatrix();

    renderer.setSize(window.innerWidth, window.innerHeight);

    holoPortal.handleResize();
  });

  const timer = new THREE.Timer();

  const animate = (timestamp) => {
    requestAnimationFrame(animate);

    timer.update(timestamp);

    const deltaTime = timer.getDelta();

    if (cameraMode === "ego") {
      moveEgoCamera(deltaTime);
    } else {
      controls.update();
    }

    updateAronaTrajectory(deltaTime);

    holoPortal.update(deltaTime);

    holoPortal.render();
  };

  setCameraMode(cameraMode);

  requestAnimationFrame(animate);
}

window.addEventListener("DOMContentLoaded", initHoloPortal);
