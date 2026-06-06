import bpy
import numpy as np
import os

MESH_NAME = "arona"
ARMATURE_NAME = "Armature"
ACTION_NAME = ""
EXCLUDE_ACTIONS = {"07_03"}
START_FRAME = 1
END_FRAME = None
STEP = 1
OUTPUT_PATH = "//renderseq_v5_with_parts.npz"
MAX_INFLUENCES = 8


def get_obj(name, typ):
    obj = bpy.data.objects.get(name)
    if obj is None:
        raise RuntimeError(f"Object '{name}' not found")
    if obj.type != typ:
        raise RuntimeError(f"Object '{name}' is not type {typ}")
    return obj


def pick_action(arm_obj):
    if ACTION_NAME:
        act = bpy.data.actions.get(ACTION_NAME)
        if act is None:
            raise RuntimeError(f"Action '{ACTION_NAME}' not found")
        if act.name in EXCLUDE_ACTIONS:
            raise RuntimeError(f"Action '{ACTION_NAME}' is excluded")
        return act

    if arm_obj.animation_data is not None and arm_obj.animation_data.action is not None:
        cur = arm_obj.animation_data.action
        if cur.name not in EXCLUDE_ACTIONS:
            return cur

    usable = [a for a in bpy.data.actions if a.name not in EXCLUDE_ACTIONS]
    if not usable:
        raise RuntimeError(f"No usable action found. Existing actions: {[a.name for a in bpy.data.actions]}")
    return sorted(usable, key=lambda a: a.name)[0]


def rest_vertices_world(mesh_obj):
    mw = mesh_obj.matrix_world
    out = np.empty((len(mesh_obj.data.vertices), 3), dtype=np.float32)
    for i, v in enumerate(mesh_obj.data.vertices):
        p = mw @ v.co
        out[i] = (p.x, p.y, p.z)
    return out


def evaluated_vertices_world(mesh_obj, depsgraph):
    eo = mesh_obj.evaluated_get(depsgraph)
    em = eo.to_mesh()
    mw = eo.matrix_world
    out = np.empty((len(em.vertices), 3), dtype=np.float32)
    for i, v in enumerate(em.vertices):
        p = mw @ v.co
        out[i] = (p.x, p.y, p.z)
    eo.to_mesh_clear()
    return out


def rest_faces_tri(mesh_obj):
    mesh = mesh_obj.data
    mesh.calc_loop_triangles()
    return np.asarray([[t.vertices[0], t.vertices[1], t.vertices[2]] for t in mesh.loop_triangles], dtype=np.int32)


def vertex_weights(mesh_obj, bone_names, max_infl):
    name_to_bone = {n: i for i, n in enumerate(bone_names)}
    group_to_bone = {}
    for vg in mesh_obj.vertex_groups:
        if vg.name in name_to_bone:
            group_to_bone[vg.index] = name_to_bone[vg.name]

    V = len(mesh_obj.data.vertices)
    idx = np.zeros((V, max_infl), dtype=np.int32)
    wgt = np.zeros((V, max_infl), dtype=np.float32)

    for v in mesh_obj.data.vertices:
        pairs = []
        for g in v.groups:
            if g.group in group_to_bone and g.weight > 0:
                pairs.append((group_to_bone[g.group], float(g.weight)))
        pairs.sort(key=lambda x: -x[1])
        pairs = pairs[:max_infl]
        s = sum(w for _, w in pairs)
        if s <= 1e-8:
            pairs = [(0, 1.0)]
            s = 1.0
        for k, (bi, bw) in enumerate(pairs):
            idx[v.index, k] = int(bi)
            wgt[v.index, k] = float(bw / s)
    return idx, wgt


def main():
    mesh = get_obj(MESH_NAME, "MESH")
    arm = get_obj(ARMATURE_NAME, "ARMATURE")

    if arm.animation_data is None:
        arm.animation_data_create()

    act = pick_action(arm)
    arm.animation_data.action = act

    start = int(START_FRAME)
    end = int(END_FRAME) if END_FRAME is not None else int(act.frame_range[1])
    frames = list(range(start, end + 1, int(STEP)))
    if not frames:
        raise RuntimeError("No frames selected")

    bone_names = [b.name for b in arm.data.bones]
    v_bone_idx, v_bone_w = vertex_weights(mesh, bone_names, int(MAX_INFLUENCES))

    depsgraph = bpy.context.evaluated_depsgraph_get()
    scene = bpy.context.scene

    vertices_rest = rest_vertices_world(mesh)
    faces = rest_faces_tri(mesh)
    vertices_frames = []

    for f in frames:
        scene.frame_set(f)
        bpy.context.view_layer.update()
        vf = evaluated_vertices_world(mesh, depsgraph)
        if vf.shape != vertices_rest.shape:
            raise RuntimeError(f"Vertex count changed at frame {f}: {vf.shape} vs {vertices_rest.shape}")
        vertices_frames.append(vf)

    out = bpy.path.abspath(OUTPUT_PATH)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    np.savez_compressed(
        out,
        action_name=np.asarray([act.name]),
        mesh_name=np.asarray([mesh.name]),
        armature_name=np.asarray([arm.name]),
        frames=np.asarray(frames, dtype=np.int32),
        vertices_rest=vertices_rest.astype(np.float32),
        vertices_frames=np.stack(vertices_frames, axis=0).astype(np.float32),
        faces=faces.astype(np.int32),
        bone_names=np.asarray(bone_names),
        vertex_bone_indices=v_bone_idx.astype(np.int32),
        vertex_bone_weights=v_bone_w.astype(np.float32),
    )

    print("saved:", out)
    print("action:", act.name)
    print("mesh:", mesh.name)
    print("armature:", arm.name)
    print("frames:", frames[0], "to", frames[-1], "count", len(frames))
    print("vertices:", vertices_rest.shape[0])
    print("tri faces:", faces.shape[0])
    print("bones:", len(bone_names))
    print("max influences:", MAX_INFLUENCES)


if __name__ == "__main__":
    main()
