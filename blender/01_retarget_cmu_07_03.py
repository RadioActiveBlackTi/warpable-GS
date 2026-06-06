import bpy
from mathutils import Matrix

SRC_NAME = "07_03"
TGT_NAME = "Armature"

REF_FRAME = 1
BAKE_START = 1

src = bpy.data.objects.get(SRC_NAME)
tgt = bpy.data.objects.get(TGT_NAME)

if src is None:
    raise Exception("Source armature 07_03 not found. Outliner에서 BVH armature 이름 확인.")
if tgt is None:
    raise Exception("Target armature Armature not found.")

if src.type != "ARMATURE":
    raise Exception("07_03 is not an armature.")
if tgt.type != "ARMATURE":
    raise Exception("Armature is not an armature.")

if src.animation_data and src.animation_data.action:
    src_start, src_end = src.animation_data.action.frame_range
    src_start = int(src_start)
    src_end = int(src_end)
else:
    src_start = bpy.context.scene.frame_start
    src_end = bpy.context.scene.frame_end

BAKE_END = src_end

MAP = {
    "hip": "bone_0",
    "abdomen": "bone_1",
    "chest": "bone_3",
    "neck": "bone_4",
    "head": "bone_5",
    "lShldr": "bone_7",
    "lForeArm": "bone_8",
    "rShldr": "bone_23",
    "rForeArm": "bone_24",
    "lThigh": "bone_38",
    "lShin": "bone_39",
    "lFoot": "bone_40",
    "rThigh": "bone_42",
    "rShin": "bone_43",
    "rFoot": "bone_44",
}

for pb in tgt.pose.bones:
    for c in list(pb.constraints):
        if c.name.startswith("CMU_TEST_"):
            pb.constraints.remove(c)

tgt.animation_data_create()
tgt.animation_data.action = None
for track in tgt.animation_data.nla_tracks:
    track.mute = True

bpy.context.view_layer.objects.active = tgt
bpy.ops.object.mode_set(mode="POSE")

for pb in tgt.pose.bones:
    pb.rotation_mode = "QUATERNION"
    pb.location = (0, 0, 0)
    pb.rotation_quaternion = (1, 0, 0, 0)
    pb.scale = (1, 1, 1)

bpy.context.view_layer.update()

target_base = {}
target_base_loc = {}
target_base_scale = {}

for src_bone, tgt_bone in MAP.items():
    if tgt_bone not in tgt.pose.bones:
        continue

    pb = tgt.pose.bones[tgt_bone]
    target_base[tgt_bone] = pb.matrix.copy()
    target_base_loc[tgt_bone] = pb.location.copy()
    target_base_scale[tgt_bone] = pb.scale.copy()

bpy.context.scene.frame_set(REF_FRAME)
bpy.context.view_layer.update()

source_ref = {}
missing = []

for src_bone, tgt_bone in MAP.items():
    if src_bone not in src.pose.bones:
        missing.append(f"source missing: {src_bone}")
        continue
    if tgt_bone not in tgt.pose.bones:
        missing.append(f"target missing: {tgt_bone}")
        continue

    source_ref[src_bone] = src.pose.bones[src_bone].matrix.copy()

action = bpy.data.actions.new("CMU_07_03_retargeted")
tgt.animation_data.action = action

ORDER = [
    "hip", "abdomen", "chest", "neck", "head",
    "lShldr", "lForeArm",
    "rShldr", "rForeArm",
    "lThigh", "lShin", "lFoot",
    "rThigh", "rShin", "rFoot",
]

out_frame = 1

for frame in range(BAKE_START, BAKE_END + 1):
    bpy.context.scene.frame_set(frame)
    bpy.context.view_layer.update()

    for _, tgt_bone in MAP.items():
        if tgt_bone not in tgt.pose.bones:
            continue
        if tgt_bone not in target_base:
            continue

        pb = tgt.pose.bones[tgt_bone]
        pb.rotation_mode = "QUATERNION"
        pb.matrix = target_base[tgt_bone].copy()
        pb.location = target_base_loc[tgt_bone].copy()
        pb.scale = target_base_scale[tgt_bone].copy()

    bpy.context.view_layer.update()

    for src_bone in ORDER:
        if src_bone not in MAP:
            continue

        tgt_bone = MAP[src_bone]

        if src_bone not in source_ref:
            continue
        if tgt_bone not in tgt.pose.bones:
            continue
        if tgt_bone not in target_base:
            continue

        src_pb = src.pose.bones[src_bone]
        tgt_pb = tgt.pose.bones[tgt_bone]

        src_cur = src_pb.matrix.copy()
        src_base = source_ref[src_bone]
        delta = src_cur @ src_base.inverted()
        desired = delta @ target_base[tgt_bone]

        tgt_pb.rotation_mode = "QUATERNION"
        tgt_pb.matrix = desired
        tgt_pb.location = target_base_loc[tgt_bone].copy()
        tgt_pb.scale = target_base_scale[tgt_bone].copy()

        bpy.context.view_layer.update()

    for _, tgt_bone in MAP.items():
        if tgt_bone in tgt.pose.bones:
            pb = tgt.pose.bones[tgt_bone]
            pb.keyframe_insert(data_path="rotation_quaternion", frame=out_frame)

    out_frame += 1

bpy.context.scene.frame_start = 1
bpy.context.scene.frame_end = out_frame - 1
bpy.context.scene.frame_set(1)

result = []
result.append("DONE: 07_03 motion baked to Armature")
result.append(f"Source: {SRC_NAME}")
result.append(f"Target: {TGT_NAME}")
result.append(f"Reference frame: {REF_FRAME}")
result.append(f"Source frames: {BAKE_START} - {BAKE_END}")
result.append(f"Output frames: 1 - {out_frame - 1}")
result.append("")
result.append("Mapping:")
for k, v in MAP.items():
    result.append(f"{k} -> {v}")

if missing:
    result.append("")
    result.append("Missing:")
    result.extend(missing)

txt = bpy.data.texts.get("RETARGET_07_03_DONE")
if txt is None:
    txt = bpy.data.texts.new("RETARGET_07_03_DONE")
txt.clear()
txt.write("\n".join(result))

for area in bpy.context.screen.areas:
    if area.type == "TEXT_EDITOR":
        area.spaces.active.text = txt
