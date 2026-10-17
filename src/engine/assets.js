// Procedural low-poly models: several vehicle types with shaped bodies,
// glazing, wheels and lights; and articulated pedestrians that walk.
import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'

function paint(g, rgb, part = 0) {
  g = g.index ? g.toNonIndexed() : g
  const n = g.attributes.position.count
  const c = new Float32Array(n * 3)
  const p = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    c.set(rgb, i * 3)
    p[i] = part
  }
  g.setAttribute('color', new THREE.BufferAttribute(c, 3))
  g.setAttribute('aPart', new THREE.BufferAttribute(p, 1))
  for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'color', 'aPart'].includes(k)) g.deleteAttribute(k)
  return g
}

/** Side-profile extrusion (x forward, y up), centred across its width. */
function profile(points, width, bevel = 0.05) {
  const s = new THREE.Shape(points.map(([x, y]) => new THREE.Vector2(x, y)))
  const g = new THREE.ExtrudeGeometry(s, { depth: width - bevel * 2, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 2, curveSegments: 4 })
  g.translate(0, 0, -(width - bevel * 2) / 2)
  return g
}

const BODY = [1, 1, 1] // tinted by the instance colour
const GLASS = [0.07, 0.09, 0.11]
const TYRE = [0.05, 0.05, 0.055]
const RIM = [0.55, 0.56, 0.58]
const TRIM = [0.12, 0.12, 0.13]
const HEAD = [1.6, 1.55, 1.35]
const TAIL = [1.3, 0.12, 0.08]

function wheels(xs, r, w, track) {
  const parts = []
  for (const x of xs)
    for (const side of [-1, 1]) {
      const tyre = new THREE.CylinderGeometry(r, r, w, 14).rotateX(Math.PI / 2).translate(x, r, (side * track) / 2)
      const rim = new THREE.CylinderGeometry(r * 0.55, r * 0.55, w + 0.02, 10).rotateX(Math.PI / 2).translate(x, r, (side * track) / 2)
      parts.push(paint(tyre, TYRE), paint(rim, RIM))
    }
  return parts
}

function lights(front, rear, y, half, h = 0.16) {
  return [
    paint(new THREE.BoxGeometry(0.06, h, 0.32).translate(front, y, half - 0.25), HEAD),
    paint(new THREE.BoxGeometry(0.06, h, 0.32).translate(front, y, -half + 0.25), HEAD),
    paint(new THREE.BoxGeometry(0.06, h, 0.36).translate(rear, y + 0.05, half - 0.22), TAIL),
    paint(new THREE.BoxGeometry(0.06, h, 0.36).translate(rear, y + 0.05, -half + 0.22), TAIL),
  ]
}

export const VEHICLE_TYPES = ['sedan', 'hatch', 'suv', 'van', 'bus', 'truck']

export function vehicleGeometry(type) {
  const parts = []
  if (type === 'sedan') {
    parts.push(paint(profile([[-2.3, 0.32], [2.3, 0.32], [2.32, 0.7], [2.15, 0.88], [1.25, 0.98], [0.6, 1.42], [-0.75, 1.44], [-1.35, 1.02], [-2.25, 0.96], [-2.33, 0.7]], 1.8), BODY))
    parts.push(paint(profile([[1.18, 0.98], [0.6, 1.38], [-0.72, 1.4], [-1.28, 1.0]], 1.84, 0.02), GLASS))
    parts.push(...wheels([1.4, -1.4], 0.33, 0.24, 1.6), ...lights(2.3, -2.32, 0.72, 0.9))
  } else if (type === 'hatch') {
    parts.push(paint(profile([[-1.95, 0.32], [1.95, 0.32], [1.97, 0.72], [1.75, 0.9], [0.95, 1.0], [0.35, 1.45], [-1.7, 1.47], [-1.95, 1.1]], 1.72), BODY))
    parts.push(paint(profile([[0.9, 1.0], [0.35, 1.41], [-1.62, 1.43], [-1.86, 1.08]], 1.76, 0.02), GLASS))
    parts.push(...wheels([1.25, -1.25], 0.31, 0.22, 1.52), ...lights(1.95, -1.95, 0.76, 0.86))
  } else if (type === 'suv') {
    parts.push(paint(profile([[-2.35, 0.42], [2.35, 0.42], [2.37, 0.95], [2.15, 1.1], [1.3, 1.18], [0.85, 1.78], [-2.2, 1.8], [-2.37, 1.3]], 1.92), BODY))
    parts.push(paint(profile([[1.25, 1.18], [0.85, 1.72], [-2.1, 1.74], [-2.28, 1.3]], 1.96, 0.02), GLASS))
    parts.push(paint(new THREE.BoxGeometry(4.6, 0.12, 1.4).translate(-0.4, 1.84, 0), TRIM)) // roof rails
    parts.push(...wheels([1.45, -1.45], 0.4, 0.28, 1.68), ...lights(2.35, -2.37, 0.95, 0.96))
  } else if (type === 'van') {
    parts.push(paint(profile([[-2.5, 0.38], [2.5, 0.38], [2.52, 1.0], [2.2, 1.25], [1.7, 2.05], [-2.48, 2.1], [-2.52, 1.0]], 1.95), BODY))
    parts.push(paint(profile([[2.15, 1.27], [1.7, 1.98], [1.1, 1.98], [1.1, 1.27]], 1.99, 0.02), GLASS))
    parts.push(paint(new THREE.BoxGeometry(2.4, 0.5, 2.0).translate(-0.3, 1.6, 0), GLASS))
    parts.push(...wheels([1.7, -1.7], 0.38, 0.26, 1.72), ...lights(2.5, -2.52, 1.0, 0.97))
  } else if (type === 'bus') {
    parts.push(paint(new THREE.BoxGeometry(11.5, 2.6, 2.5).translate(0, 1.75, 0), BODY))
    parts.push(paint(new THREE.BoxGeometry(10.6, 0.95, 2.54).translate(-0.2, 2.25, 0), GLASS))
    parts.push(paint(new THREE.BoxGeometry(0.06, 1.3, 2.3).translate(5.76, 2.0, 0), GLASS))
    parts.push(paint(new THREE.BoxGeometry(11.5, 0.12, 2.4).translate(0, 3.1, 0), TRIM))
    parts.push(...wheels([3.8, -3.6], 0.5, 0.32, 2.2), ...lights(5.76, -5.76, 0.85, 1.25))
  } else {
    // box truck: cab + cargo box
    parts.push(paint(profile([[1.6, 0.5], [3.4, 0.5], [3.42, 1.4], [3.2, 2.5], [1.6, 2.6]], 2.3), BODY))
    parts.push(paint(profile([[3.22, 1.6], [3.05, 2.4], [2.3, 2.45], [2.3, 1.6]], 2.34, 0.02), GLASS))
    parts.push(paint(new THREE.BoxGeometry(5.0, 2.9, 2.4).translate(-1.0, 2.05, 0), [0.92, 0.92, 0.9]))
    parts.push(paint(new THREE.BoxGeometry(6.8, 0.25, 1.0).translate(0, 0.55, 0), TRIM))
    parts.push(...wheels([2.6, -1.8, -2.9], 0.48, 0.32, 2.0), ...lights(3.42, -3.52, 0.9, 1.15))
  }
  const g = mergeGeometries(parts)
  g.computeVertexNormals()
  return g
}

export const VEHICLE_LENGTH = { sedan: 4.6, hatch: 3.9, suv: 4.7, van: 5.0, bus: 11.5, truck: 7.0 }

/** Vehicle material: glass/tyre colours stay dark, the body takes the instance colour. */
export function vehicleMaterial(envMap) {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.32, metalness: 0.5, envMap, envMapIntensity: 0.9 })
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aPart;')
      .replace('#include <color_vertex>', '#include <color_vertex>\n#ifdef USE_INSTANCING_COLOR\nif (abs(color.r - 1.0) > 0.01 || abs(color.g - 1.0) > 0.01 || abs(color.b - 1.0) > 0.01) vColor.rgb = color.rgb;\n#endif')
  }
  return m
}

// ----------------------------------------------------------------- people
// parts: 0 torso, 1 skin, 2 hair, 3 left leg, 4 right leg, 5 left arm, 6 right arm, 7 shoes
export function personGeometry() {
  const parts = []
  const leg = (side, part) => {
    const x = side * 0.1
    parts.push(paint(new THREE.CylinderGeometry(0.075, 0.065, 0.84, 6).translate(x, 0.5, 0), [1, 1, 1], part))
    parts.push(paint(new THREE.BoxGeometry(0.12, 0.08, 0.26).translate(x, 0.04, 0.04), [0.1, 0.09, 0.08], part))
  }
  leg(-1, 3)
  leg(1, 4)
  parts.push(paint(new THREE.CylinderGeometry(0.15, 0.13, 0.15, 8).translate(0, 0.95, 0), [1, 1, 1], 8)) // hips (pants)
  parts.push(paint(new THREE.CylinderGeometry(0.19, 0.15, 0.58, 8).translate(0, 1.29, 0), [1, 1, 1], 0))
  parts.push(paint(new THREE.CylinderGeometry(0.06, 0.07, 0.08, 6).translate(0, 1.61, 0), [1, 1, 1], 1)) // neck
  parts.push(paint(new THREE.SphereGeometry(0.115, 10, 8).scale(1, 1.15, 1.05).translate(0, 1.74, 0.01), [1, 1, 1], 1))
  parts.push(paint(new THREE.SphereGeometry(0.12, 10, 6, 0, Math.PI * 2, 0, Math.PI * 0.55).translate(0, 1.77, -0.01), [1, 1, 1], 2))
  for (const side of [-1, 1]) {
    const part = side < 0 ? 5 : 6
    parts.push(paint(new THREE.CylinderGeometry(0.055, 0.045, 0.58, 6).translate(side * 0.24, 1.25, 0), [1, 1, 1], part))
    parts.push(paint(new THREE.SphereGeometry(0.05, 6, 4).translate(side * 0.24, 0.94, 0), [1, 1, 1], part + 10)) // hands (skin)
  }
  const g = mergeGeometries(parts)
  g.computeVertexNormals()
  return g
}

/**
 * Instanced people: aLook = (shirt rgb) via instanceColor, aPants (rgb),
 * aSkin (rgb), aHair (rgb); aWalk = (phase, stride) animates the limbs.
 */
export function personMaterial() {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85 })
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aPart;\nattribute vec3 aPants;\nattribute vec3 aSkin;\nattribute vec3 aHair;\nattribute vec2 aWalk;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        {
          float sw = sin(aWalk.x) * aWalk.y;
          float ang = 0.0; float py = 0.0;
          if (aPart == 3.0) { ang = sw; py = 0.92; }
          else if (aPart == 4.0) { ang = -sw; py = 0.92; }
          else if (aPart == 5.0 || aPart == 15.0) { ang = -sw * 0.8; py = 1.52; }
          else if (aPart == 6.0 || aPart == 16.0) { ang = sw * 0.8; py = 1.52; }
          if (ang != 0.0) {
            float c = cos(ang); float s = sin(ang);
            vec3 p = transformed - vec3(0.0, py, 0.0);
            transformed = vec3(p.x, p.y * c - p.z * s, p.y * s + p.z * c) + vec3(0.0, py, 0.0);
          }
        }`,
      )
      .replace(
        '#include <color_vertex>',
        `#include <color_vertex>
        {
          vec3 shirt = vec3(1.0);
          #ifdef USE_INSTANCING_COLOR
            shirt = instanceColor.rgb;
          #endif
          if (aPart == 0.0 || aPart == 5.0 || aPart == 6.0) vColor.rgb = shirt;
          else if (aPart == 3.0 || aPart == 4.0 || aPart == 8.0) vColor.rgb = color.r < 0.5 ? color.rgb : aPants;
          else if (aPart == 1.0 || aPart == 15.0 || aPart == 16.0) vColor.rgb = aSkin;
          else if (aPart == 2.0) vColor.rgb = aHair;
          else vColor.rgb = color.rgb;
        }`,
      )
  }
  return m
}
