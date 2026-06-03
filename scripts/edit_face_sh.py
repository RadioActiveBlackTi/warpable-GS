import argparse
import numpy as np
from plyfile import PlyData, PlyElement


SH_C1 = 0.4886025119029199


def require_fields(vertex_data, fields):
    names = vertex_data.data.dtype.names
    missing = [f for f in fields if f not in names]
    if missing:
        raise ValueError(f"Missing fields in PLY: {missing}")


def edit_face_sh(
    input_ply,
    output_ply,
    x_range=None,
    y_range=None,
    z_range=None,
    x_tint=(0.25, -0.05, -0.25),
    z_tint=(0.0, 0.0, 0.0),
    mode="add",
):
    ply = PlyData.read(input_ply)
    vertex = ply["vertex"]
    data = vertex.data.copy()

    required = [
        "x", "y", "z",
        "f_rest_1", "f_rest_2",
        "f_rest_16", "f_rest_17",
        "f_rest_31", "f_rest_32",
    ]
    require_fields(vertex, required)

    mask = np.ones(len(data), dtype=bool)

    if x_range is not None:
        mask &= (data["x"] >= x_range[0]) & (data["x"] <= x_range[1])

    if y_range is not None:
        mask &= (data["y"] >= y_range[0]) & (data["y"] <= y_range[1])

    if z_range is not None:
        mask &= (data["z"] >= z_range[0]) & (data["z"] <= z_range[1])

    print(f"Selected Gaussians: {mask.sum()} / {len(data)}")

    if mask.sum() == 0:
        raise ValueError("No Gaussians selected. Check your x/y/z range.")

    z_fields = ["f_rest_1", "f_rest_16", "f_rest_31"]
    x_fields = ["f_rest_2", "f_rest_17", "f_rest_32"]

    x_tint = np.array(x_tint, dtype=np.float32)
    z_tint = np.array(z_tint, dtype=np.float32)

    x_coeff = -x_tint / SH_C1
    z_coeff = z_tint / SH_C1

    for i in range(3):
        if mode == "replace":
            data[x_fields[i]][mask] = x_coeff[i]
            data[z_fields[i]][mask] = z_coeff[i]
        elif mode == "add":
            data[x_fields[i]][mask] += x_coeff[i]
            data[z_fields[i]][mask] += z_coeff[i]
        else:
            raise ValueError("mode must be 'add' or 'replace'")

    new_vertex = PlyElement.describe(data, "vertex")

    new_elements = []
    for element in ply.elements:
        if element.name == "vertex":
            new_elements.append(new_vertex)
        else:
            new_elements.append(element)

    PlyData(
        new_elements,
        text=ply.text,
        byte_order=ply.byte_order,
    ).write(output_ply)

    print(f"Saved edited PLY to: {output_ply}")


def parse_range(values):
    if values is None:
        return None
    if len(values) != 2:
        raise ValueError("Range must have exactly two values.")
    return (min(values), max(values))


def main():
    parser = argparse.ArgumentParser()

    parser.add_argument("input_ply")
    parser.add_argument("output_ply")

    parser.add_argument("--mode", choices=["add", "replace"], default="add")

    parser.add_argument("--x_range", type=float, nargs=2, default=None)
    parser.add_argument("--y_range", type=float, nargs=2, default=None)
    parser.add_argument("--z_range", type=float, nargs=2, default=None)

    parser.add_argument("--x_r", type=float, default=0.25)
    parser.add_argument("--x_g", type=float, default=-0.05)
    parser.add_argument("--x_b", type=float, default=-0.25)

    parser.add_argument("--z_r", type=float, default=0.0)
    parser.add_argument("--z_g", type=float, default=0.0)
    parser.add_argument("--z_b", type=float, default=0.0)

    args = parser.parse_args()

    edit_face_sh(
        args.input_ply,
        args.output_ply,
        x_range=parse_range(args.x_range),
        y_range=parse_range(args.y_range),
        z_range=parse_range(args.z_range),
        x_tint=(args.x_r, args.x_g, args.x_b),
        z_tint=(args.z_r, args.z_g, args.z_b),
        mode=args.mode,
    )


if __name__ == "__main__":
    main()