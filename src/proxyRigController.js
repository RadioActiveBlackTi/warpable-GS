import * as THREE from 'three';

// --- ARAP Math Helpers ---
function addMatrix3(A, B) { for (let i = 0; i < 9; i++) A.elements[i] += B.elements[i]; }
function scaleMatrix3(A, scalar) { for (let i = 0; i < 9; i++) A.elements[i] *= scalar; }
function extractRotation(M, maxIters = 5) {
    let R = M.clone(); const R_invT = new THREE.Matrix3();
    for (let iter = 0; iter < maxIters; iter++) {
        R_invT.copy(R).invert().transpose(); addMatrix3(R, R_invT); scaleMatrix3(R, 0.5);
    }
    return R;
}

export class ProxyRigController {
    constructor(numBones = 4) {
        this.numBones = numBones;
        this.boneTextureSize = 4;
        this.boneData = new Float32Array(this.boneTextureSize * this.boneTextureSize * 4);
        this.boneTexture = new THREE.DataTexture(this.boneData, this.boneTextureSize, this.boneTextureSize, THREE.RGBAFormat, THREE.FloatType);
        this.boneTexture.needsUpdate = true;

        this.restPositions = [];
        this.currentPositions = [];
        this.edges = [];
        this.rotations = [];
        this.handles = new Map();

        // 스플랫의 World Position(Y=35 주변)을 감싸도록 뼈대 생성: 20, 30, 40, 50
        const startY = 20;
        const spacing = 10; 

        for (let i = 0; i < numBones; i++) {
            const pos = new THREE.Vector3(0, startY + (i * spacing), 0);
            this.restPositions.push(pos.clone());
            this.currentPositions.push(pos.clone());
            this.rotations.push(new THREE.Matrix3());

            const neighbors = [];
            if (i > 0) neighbors.push(i - 1);
            if (i < numBones - 1) neighbors.push(i + 1);
            this.edges.push(neighbors);
        }
    }

    setHandle(index, targetPosition) { this.handles.set(index, targetPosition.clone()); }

    solve(iterations = 3) {
        for (let iter = 0; iter < iterations; iter++) {
            // Local Step
            for (let i = 0; i < this.numBones; i++) {
                const p_i = this.currentPositions[i]; const r_i = this.restPositions[i];
                let S = new THREE.Matrix3().set(0,0,0, 0,0,0, 0,0,0);
                for (let j of this.edges[i]) {
                    const p_j = this.currentPositions[j]; const r_j = this.restPositions[j];
                    const dp = p_j.clone().sub(p_i); const dr = r_j.clone().sub(r_i);
                    const outer = new THREE.Matrix3().set(
                        dp.x*dr.x, dp.x*dr.y, dp.x*dr.z, dp.y*dr.x, dp.y*dr.y, dp.y*dr.z, dp.z*dr.x, dp.z*dr.y, dp.z*dr.z
                    );
                    addMatrix3(S, outer);
                }
                this.rotations[i] = extractRotation(S);
            }
            // Global Step
            const nextPositions = this.currentPositions.map(p => p.clone());
            for (let i = 0; i < this.numBones; i++) {
                if (this.handles.has(i)) { nextPositions[i].copy(this.handles.get(i)); continue; }
                const r_i = this.restPositions[i]; const R_i = this.rotations[i];
                let posSum = new THREE.Vector3();
                for (let j of this.edges[i]) {
                    const p_j = this.currentPositions[j]; const r_j = this.restPositions[j]; const R_j = this.rotations[j];
                    const dr = r_i.clone().sub(r_j);
                    const combined_dr = dr.clone().applyMatrix3(R_i).add(dr.clone().applyMatrix3(R_j)).multiplyScalar(0.5);
                    posSum.add(p_j.clone().add(combined_dr));
                }
                if (this.edges[i].length > 0) nextPositions[i].copy(posSum.divideScalar(this.edges[i].length));
            }
            this.currentPositions = nextPositions;
        }
    }

    update(time) {
        this.setHandle(0, this.restPositions[0]); // 바닥(Y=20) 고정
        
        const tipIndex = this.numBones - 1;
        const tipTarget = this.restPositions[tipIndex].clone();
        // 최상단 뼈대(Y=50)를 좌우로 크게 흔들기
        tipTarget.x += Math.sin(time * 3.0) * 15.0; 
        tipTarget.z += Math.cos(time * 2.0) * 8.0; 
        this.setHandle(tipIndex, tipTarget);

        this.solve(4);

        for (let i = 0; i < this.numBones; i++) {
            const p = this.currentPositions[i];
            const R = this.rotations[i];
            const r_rest = this.restPositions[i];

            // 가장 중요한 행렬 수학: [현재 회전/이동] * [초기 위치 역행렬]
            const mCurrent = new THREE.Matrix4().set(
                R.elements[0], R.elements[3], R.elements[6], p.x,
                R.elements[1], R.elements[4], R.elements[7], p.y,
                R.elements[2], R.elements[5], R.elements[8], p.z,
                0, 0, 0, 1
            );
            const mRestInv = new THREE.Matrix4().makeTranslation(-r_rest.x, -r_rest.y, -r_rest.z);
            
            const finalBoneMat = mCurrent.multiply(mRestInv);
            finalBoneMat.toArray(this.boneData, i * 16);
        }
        this.boneTexture.needsUpdate = true;
    }
}