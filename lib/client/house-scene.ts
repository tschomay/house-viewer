import * as THREE from "three";
import { DEFAULT_INTRINSICS } from "@/lib/geometry";
import { SIDES, WALL_H, type HouseModel, type HouseRoom } from "@/lib/house-model";
import type { ListingImage, WallArt } from "@/lib/types";

export interface RoomColors {
  wall: string;
  floor: string;
  ceiling: string;
}

export const SKY = "#b8cde0";
const MAX_PHOTOS = 6;

export interface HouseScene {
  scene: THREE.Scene;
  /** One group per storey (indexed like model.floors), so floors above the one you're on can be hidden. */
  floorGroups: THREE.Group[];
  /** The outside faces of exterior walls, one mesh per storey. */
  siding: THREE.Mesh[];
  /** Call each frame with the camera's world position: photos taken near it win the blend. */
  update: (camWorld: THREE.Vector3) => void;
  photoTexture: (id: string) => THREE.Texture;
  dispose: () => void;
}

/**
 * The whole house as a three.js scene, shared by the fly-through and the
 * dollhouse. Each room is a box with doorways cut in its walls. Its surfaces
 * are painted by projecting the room's listing photos back from where they
 * were taken (projective texturing), so from a photo's viewpoint the view *is*
 * the photo. Walls the photos never saw show AI wall art (or paint colours
 * sampled from the photos, without it). Walls face into their room, so from
 * outside the near walls are invisible (back faces), which is what makes the
 * dollhouse cutaway work; the siding covers them when the house should read
 * as a closed building.
 */
export function buildHouseScene(
  model: HouseModel,
  photos: Map<string, ListingImage>,
  wallArt: Record<string, WallArt>,
  palette: Record<string, RoomColors>,
  renderer: THREE.WebGLRenderer,
): HouseScene {
  const scene = new THREE.Scene();
  const sky = new THREE.Color(SKY);
  scene.background = sky;
  scene.fog = new THREE.Fog(sky, 40, 140);
  const disposables: { dispose(): void }[] = [];
  const loader = new THREE.TextureLoader();
  const aniso = renderer.capabilities.getMaxAnisotropy();
  const tex = (url: string) => {
    const t = loader.load(url);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = aniso;
    disposables.push(t);
    return t;
  };
  const photoTex = new Map<string, THREE.Texture>();
  const photoTexture = (id: string) => {
    if (!photoTex.has(id)) photoTex.set(id, tex(photos.get(id)!.dataUrl));
    return photoTex.get(id)!;
  };

  // Lights only matter for the outside of the house (the rooms are painted with photos).
  scene.add(new THREE.HemisphereLight("#eef4ff", "#6b6250", 1.6));
  const sun = new THREE.DirectionalLight("#fff6e8", 1.4);
  sun.position.set(-30, 50, 20);
  scene.add(sun);

  const b = model.bounds;
  const ground = new THREE.Mesh(new THREE.CircleGeometry(160, 48).rotateX(-Math.PI / 2), new THREE.MeshLambertMaterial({ color: "#7d8b63" }));
  ground.position.set((b.x0 + b.x1) / 2, -0.03, (b.z0 + b.z1) / 2);
  scene.add(ground);
  disposables.push(ground.geometry, ground.material as THREE.Material);

  const floorGroups = model.floors.map(() => {
    const g = new THREE.Group();
    scene.add(g);
    return g;
  });
  const upperStairs = new Set(model.stairs.map((s) => s.upperRoomId));
  const fallbackPalette: RoomColors = { wall: "#d9d3c7", floor: "#9c8468", ceiling: "#eeeeea" };
  const updaters: ((cam: THREE.Vector3) => void)[] = [];

  for (const room of model.rooms) {
    if (room.parent) continue;
    const colors = palette[room.id] ?? fallbackPalette;
    const art = wallArt[room.id];
    const quads = model.walls.filter((w) => w.roomId === room.id && !w.outside);
    // The top of a stairwell is open to the floor below.
    const withFloor = !upperStairs.has(room.id) || room.floor === 0;
    const { mesh, update } = roomMesh(room, quads, colors, art ? tex(art.dataUrl) : null, withFloor, photoTexture, photos, disposables);
    mesh.userData.roomId = room.id;
    floorGroups[room.floor].add(mesh);
    updaters.push(update);
  }

  // Outside faces of exterior walls: plain siding, so the house reads as a building from the air.
  const siding: THREE.Mesh[] = [];
  const outside = model.walls.filter((w) => w.outside);
  if (outside.length) {
    const mat = new THREE.MeshLambertMaterial({ color: "#d8cfbf" });
    const byFloor = new Map<number, typeof outside>();
    for (const w of outside) {
      const f = model.rooms.find((r) => r.id === w.roomId)!.floor;
      (byFloor.get(f) ?? byFloor.set(f, []).get(f)!).push(w);
    }
    for (const [f, ws] of byFloor) {
      const g = quadsGeometry(ws, true);
      const mesh = new THREE.Mesh(g, mat);
      floorGroups[f].add(mesh);
      siding.push(mesh);
      disposables.push(g);
    }
    disposables.push(mat);
  }

  return {
    scene,
    floorGroups,
    siding,
    update: (cam) => updaters.forEach((u) => u(cam)),
    photoTexture,
    dispose: () => disposables.forEach((d) => d.dispose()),
  };
}

type Quad = { ax: number; az: number; bx: number; bz: number; y0: number; y1: number; u0: number; u1: number; v0: number; v1: number; side: string };

/** Wall quads → triangles facing into the room (or out, for outside faces). */
function quadsGeometry(quads: Quad[], outside = false): THREE.BufferGeometry {
  const pos: number[] = [];
  for (const q of quads) {
    const A0 = [q.ax, q.y0, q.az], B0 = [q.bx, q.y0, q.bz], B1 = [q.bx, q.y1, q.bz], A1 = [q.ax, q.y1, q.az];
    // Seen from inside, A is on the left: A0 B0 B1 is counter-clockwise, i.e. front-facing.
    const tri = outside ? [A0, B1, B0, A0, A1, B1] : [A0, B0, B1, A0, B1, A1];
    for (const v of tri) pos.push(...v);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

const STRIP = Object.fromEntries(SIDES.map((s, i) => [s, i])) as Record<string, number>;

/**
 * One room: walls, floor and ceiling in one mesh, with a shader that projects
 * up to MAX_PHOTOS listing photos from their cameras and falls back to the
 * wall art / paint colours where no photo reaches.
 */
function roomMesh(
  room: HouseRoom,
  quads: Quad[],
  colors: RoomColors,
  art: THREE.Texture | null,
  withFloor: boolean,
  photoTexture: (id: string) => THREE.Texture,
  photos: Map<string, ListingImage>,
  disposables: { dispose(): void }[],
) {
  const pos: number[] = [], uv: number[] = [], kind: number[] = [];
  const push = (v: number[], u: [number, number], k: number) => {
    pos.push(...v);
    uv.push(...u);
    kind.push(k);
  };
  for (const q of quads) {
    const strip = STRIP[q.side] ?? 0;
    // Strip i fills rows i/4..(i+1)/4 from the top of the art; texture v runs bottom-up. Trim a sliver off every edge.
    const vLo = 1 - (strip + 1) / 4 + 0.012, vHi = 1 - strip / 4 - 0.012;
    const U = (u: number) => 0.01 + u * 0.98;
    const V = (v: number) => vLo + v * (vHi - vLo);
    const A0 = [q.ax, q.y0, q.az], B0 = [q.bx, q.y0, q.bz], B1 = [q.bx, q.y1, q.bz], A1 = [q.ax, q.y1, q.az];
    const a0: [number, number] = [U(q.u0), V(q.v0)], b0: [number, number] = [U(q.u1), V(q.v0)], b1: [number, number] = [U(q.u1), V(q.v1)], a1: [number, number] = [U(q.u0), V(q.v1)];
    push(A0, a0, 0); push(B0, b0, 0); push(B1, b1, 0);
    push(A0, a0, 0); push(B1, b1, 0); push(A1, a1, 0);
  }
  const { x0, x1, z0, z1 } = room.box;
  const fy = room.elevation + 0.002, cy = room.elevation + WALL_H;
  if (withFloor) {
    // Faces up: counter-clockwise seen from above.
    push([x0, fy, z0], [0, 0], 1); push([x0, fy, z1], [0, 0], 1); push([x1, fy, z1], [0, 0], 1);
    push([x0, fy, z0], [0, 0], 1); push([x1, fy, z1], [0, 0], 1); push([x1, fy, z0], [0, 0], 1);
  }
  // Ceiling faces down, so it vanishes when seen from above (the dollhouse view).
  push([x0, cy, z0], [0, 0], 2); push([x1, cy, z1], [0, 0], 2); push([x0, cy, z1], [0, 0], 2);
  push([x0, cy, z0], [0, 0], 2); push([x1, cy, z0], [0, 0], 2); push([x1, cy, z1], [0, 0], 2);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  geo.setAttribute("kind", new THREE.Float32BufferAttribute(kind, 1));

  // Projectors: the photos with the most different headings, if there are more than fit.
  const shots = room.photos.slice(0, MAX_PHOTOS).filter((p) => photos.has(p.photoId));
  const projMats: THREE.Matrix4[] = [], projPos: THREE.Vector3[] = [];
  const cam = new THREE.PerspectiveCamera();
  for (const s of shots) {
    const img = photos.get(s.photoId)!;
    const aspect = img.width / img.height;
    cam.fov = (2 * Math.atan(Math.tan((DEFAULT_INTRINSICS.hfovDeg * Math.PI) / 360) / aspect) * 180) / Math.PI;
    cam.aspect = aspect;
    cam.near = 0.05;
    cam.far = 100;
    cam.position.set(s.x, s.y, s.z);
    cam.rotation.set(0, s.yaw, 0, "YXZ");
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld(true);
    projMats.push(new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
    projPos.push(new THREE.Vector3(s.x, s.y, s.z));
  }
  while (projMats.length < MAX_PHOTOS) {
    projMats.push(new THREE.Matrix4());
    projPos.push(new THREE.Vector3());
  }
  const blank = new THREE.Texture();
  disposables.push(blank);
  const uniforms: Record<string, THREE.IUniform> = {
    art: { value: art ?? blank },
    hasArt: { value: art ? 1 : 0 },
    wallColor: { value: new THREE.Color(colors.wall) },
    floorColor: { value: new THREE.Color(colors.floor) },
    ceilColor: { value: new THREE.Color(colors.ceiling) },
    count: { value: shots.length },
    projM: { value: projMats },
    projP: { value: projPos },
    camPos: { value: new THREE.Vector3() },
    elev: { value: room.elevation },
  };
  for (let i = 0; i < MAX_PHOTOS; i++) uniforms[`ph${i}`] = { value: shots[i] ? photoTexture(shots[i].photoId) : blank };

  const mat = new THREE.ShaderMaterial({
    uniforms,
    // Honours renderer.clippingPlanes: the dollhouse cuts the walls down to see into rooms.
    clipping: true,
    vertexShader: /* glsl */ `
      #include <clipping_planes_pars_vertex>
      attribute float kind;
      varying vec3 vW;
      varying vec2 vUv;
      varying float vKind;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vW = w.xyz;
        vUv = uv;
        vKind = kind;
        vec4 mvPosition = viewMatrix * w;
        gl_Position = projectionMatrix * mvPosition;
        #include <clipping_planes_vertex>
      }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D art;
      uniform float hasArt;
      uniform vec3 wallColor, floorColor, ceilColor;
      uniform int count;
      uniform mat4 projM[${MAX_PHOTOS}];
      uniform vec3 projP[${MAX_PHOTOS}];
      uniform vec3 camPos;
      uniform float elev;
      ${Array.from({ length: MAX_PHOTOS }, (_, i) => `uniform sampler2D ph${i};`).join("\n")}
      #include <clipping_planes_pars_fragment>
      varying vec3 vW;
      varying vec2 vUv;
      varying float vKind;

      float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

      // One photo's contribution: its colour × weight (rgb) and the weight (a).
      vec4 project(sampler2D t, mat4 m, vec3 p, inout float maxW) {
        vec4 c = m * vec4(vW, 1.0);
        if (c.w <= 0.0) return vec4(0.0);
        vec2 n = c.xy / c.w;
        if (abs(n.x) > 1.0 || abs(n.y) > 1.0) return vec4(0.0);
        float edge = smoothstep(0.0, 0.1, 1.0 - abs(n.x)) * smoothstep(0.0, 0.1, 1.0 - abs(n.y));
        // Prefer photos taken near where you are, looking the way you look at this spot.
        float d = distance(camPos, p);
        float near = 0.25 + 0.75 * exp(-d * d / 2.5);
        float ang = max(0.0, dot(normalize(vW - p), normalize(vW - camPos)));
        float w = edge * near * (0.3 + 0.7 * ang * ang * ang);
        maxW = max(maxW, w);
        // Sharpened for the blend, so the best-placed photo wins instead of several ghosting together.
        float s = w * w * w * w + 1e-6;
        return vec4(texture2D(t, n * 0.5 + 0.5).rgb * s, s) * step(1e-4, w);
      }

      void main() {
        #include <clipping_planes_fragment>
        vec3 base;
        if (vKind < 0.5) {
          base = hasArt > 0.5 ? texture2D(art, vUv).rgb : wallColor;
          if (hasArt < 0.5) {
            // Plain paint: a soft darkening towards floor and ceiling, like bounce light.
            float h = clamp((vW.y - elev) / ${WALL_H.toFixed(2)}, 0.0, 1.0);
            base *= 0.86 + 0.14 * smoothstep(0.0, 0.25, h) * smoothstep(1.0, 0.8, h);
          }
        } else if (vKind < 1.5) {
          float n = hash(floor(vW.xz * 8.0)) * 0.06 - 0.03;
          base = floorColor * (1.0 + n);
        } else {
          base = ceilColor;
        }
        vec4 acc = vec4(0.0);
        float maxW = 0.0;
        ${Array.from({ length: MAX_PHOTOS }, (_, i) => `if (count > ${i}) acc += project(ph${i}, projM[${i}], projP[${i}], maxW);`).join("\n        ")}
        vec3 col = base;
        if (acc.a > 0.0) col = mix(base, acc.rgb / acc.a, clamp(maxW * 3.0, 0.0, 1.0));
        gl_FragColor = vec4(col, 1.0);
        #include <colorspace_fragment>
      }`,
  });
  disposables.push(geo, mat);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  return {
    mesh,
    update: (camWorld: THREE.Vector3) => (uniforms.camPos.value as THREE.Vector3).copy(camWorld),
  };
}
