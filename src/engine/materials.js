// Custom materials: procedural building facades and parts (with flexural sway),
// animated water, and a sky environment map for reflections.
import * as THREE from 'three'

const HASH = /* glsl */ `
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}`

// Building parts are instanced boxes (and roofs, columns, domes...) placed in
// their building's own frame. Each building's live state is one row of a data
// texture, so moving, tilting, swaying or crushing a building is a single row
// write instead of re-composing the matrix of every part on the CPU:
//   texel 0–2  rows of the frame matrix (building metres → world)
//   texel 3    (sway x, sway z at the top, rest height H, cut: top clip in rest metres)
//   texel 4    (sink: storeys crushed at the base, flags: 1 lights allowed | 2 rubble |
//              4 rough: broken-concrete facades but details kept, sway x, z at mid-height)
//   texel 5    facade tint (rgb, amount)
//   texel 6    detail tint (rgb, amount)
export const BLD_TEXELS = 7

const PART_VERTEX_COMMON = /* glsl */ `
uniform highp sampler2D uBld;
attribute vec4 iPos;   // part centre x, bottom y, centre z (building frame), rotation about y
attribute vec4 iSize;  // part size w, h, d; building row
attribute vec4 iColor; // part colour; flags (1: grounded)
vec4 bldTexel(int k) { return texelFetch(uBld, ivec2(k, int(iSize.w + 0.5)), 0); }
vec3 partRotY(vec3 p) {
  float c = cos(iPos.w);
  float s = sin(iPos.w);
  return vec3(c * p.x + s * p.z, p.y, -s * p.x + c * p.z);
}`

// Place the part in the world (shared by the facade, detail and shadow materials).
const PART_BEGIN = /* glsl */ `
vec4 bR0 = bldTexel(0);
vec4 bR1 = bldTexel(1);
vec4 bR2 = bldTexel(2);
vec4 bS = bldTexel(3);
vec4 bF = bldTexel(4);
bool grounded = mod(iColor.a, 2.0) > 0.5;
vec3 lp = partRotY(position * iSize.xyz) + iPos.xyz;
float yRest = lp.y;
vec2 swayD = vec2(0.0);
if (!grounded) {
  // storeys crushed at the base drop everything above them; a sheared-off top is cut away
  lp.y = max(min(lp.y, bS.w) - bF.x, 0.0);
  // the frame's deflected shape, through its displacement at mid-height (bF.zw) and at the top
  // (bS.xy): a bowed first mode, or an S-shape when the second mode is ringing
  float sy = clamp(yRest / max(bS.z, 1.0), 0.0, 1.0);
  float lo = clamp(sy * 2.0, 0.0, 1.0);
  float hi = clamp(sy * 2.0 - 1.0, 0.0, 1.0);
  swayD = bF.zw * (lo * lo * (3.0 - 2.0 * lo)) + (bS.xy - bF.zw) * hi;
  #ifdef PART_DETAIL
    if (mod(floor(bF.y / 2.0 + 0.01), 2.0) > 0.5) lp *= 0.0; // reduced to rubble: details are gone
  #endif
}
vec3 transformed = vec3(dot(bR0, vec4(lp, 1.0)), dot(bR1, vec4(lp, 1.0)), dot(bR2, vec4(lp, 1.0)));
// the base is fixed to the ground; the storeys above sway
transformed.xz += swayD;`

const PART_NORMAL = /* glsl */ `
vec3 objectNormal;
{
  vec3 n = partRotY(normal);
  objectNormal = normalize(vec3(dot(bldTexel(0).xyz, n), dot(bldTexel(1).xyz, n), dot(bldTexel(2).xyz, n)));
}
#ifdef USE_TANGENT
  vec3 objectTangent = vec3( tangent.xyz );
#endif`

function injectParts(shader, uBld, detail) {
  shader.uniforms.uBld = uBld
  shader.vertexShader = (detail ? '#define PART_DETAIL\n' : '') + shader.vertexShader
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>\n${PART_VERTEX_COMMON}`)
    .replace('#include <beginnormal_vertex>', PART_NORMAL)
    .replace('#include <begin_vertex>', `${PART_BEGIN}\n${PARTS_PLACED}`)
}
// materials add their own vertex code after the part has been placed
const PARTS_PLACED = '// <parts placed>'

/** Shadow-casting depth material for building parts (bends, tilts and collapses with them). */
export function makePartsDepthMaterial(uBld, detail) {
  const m = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking })
  m.onBeforeCompile = (shader) => injectParts(shader, uBld, detail)
  m.customProgramCacheKey = () => (detail ? 'parts-depth-detail' : 'parts-depth-body')
  return m
}

/** Roofs, balconies, columns, spires...: flat colours per part, tinted with their building. */
export function makeDetailMaterial({ uBld, envMap }) {
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.8, metalness: 0.0, envMap, envMapIntensity: 0.35 })
  mat.onBeforeCompile = (shader) => {
    injectParts(shader, uBld, true)
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vTint;')
      .replace(PARTS_PLACED, 'vec4 dT = bldTexel(6);\nvTint = mix(iColor.rgb, dT.rgb, dT.a);')
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vTint;')
      .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb *= vTint;')
  }
  mat.customProgramCacheKey = () => 'parts-detail'
  return mat
}

/**
 * Facades. iInfo = (floor height, style, seed, flags: 1 shopfronts).
 * Styles: 0 industrial cladding, 1 punched windows, 2 ribbon windows,
 * 3 glass curtain wall, 4 classical (arched windows, pilasters, rusticated
 * base), 5 blank panels, 6 house (siding, a front door), 7 brick (sills,
 * coursing).
 */
export function makeBodyMaterial({ uNight, uBld, envMap }) {
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.86, metalness: 0.0, envMap, envMapIntensity: 0.4 })
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uNight = uNight
    injectParts(shader, uBld, false)
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 iInfo;\nflat varying vec4 vInfo;\nvarying vec3 vLocal;\nvarying vec3 vONormal;\nflat varying vec3 vScale;\nflat varying float vPartY;\nflat varying float vBFlags;\nvarying vec3 vTint;')
      .replace(
        PARTS_PLACED,
        `vInfo = iInfo;
        vScale = iSize.xyz;
        vLocal = position * iSize.xyz;
        vPartY = iPos.y;
        vONormal = normal;
        vBFlags = bF.y;
        vec4 fT = bldTexel(5);
        vTint = mix(iColor.rgb, fT.rgb, fT.a);`,
      )
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform float uNight;
        flat varying vec4 vInfo;
        varying vec3 vLocal;
        varying vec3 vONormal;
        flat varying vec3 vScale;
        flat varying float vPartY;
        flat varying float vBFlags;
        varying vec3 vTint;
        float gWin = 0.0;
        float gLit = 0.0;
        vec3 gLitCol = vec3(1.0);
        ${HASH}
        float box(float x, float a, float b, float w) { return smoothstep(a - w, a + w, x) * (1.0 - smoothstep(b - w, b + w, x)); }`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        {
          diffuseColor.rgb *= vTint;
          vec3 N = vec3(sign(vONormal.x) * step(0.5, abs(vONormal.x)), sign(vONormal.y) * step(0.5, abs(vONormal.y)), sign(vONormal.z) * step(0.5, abs(vONormal.z)));
          float style = floor(vInfo.y + 0.5);
          bool shop = mod(vInfo.w, 2.0) > 0.5;
          bool rubble = mod(floor(vBFlags / 2.0 + 0.01), 4.0) > 0.5;
          vec3 wallC = diffuseColor.rgb;
          if (rubble) {
            // broken slabs and masonry: blotchy, no windows left
            float n1 = hash12(floor(vLocal.xz * 0.9 + vLocal.y * 1.7));
            float n2 = hash12(floor(vLocal.zx * 2.3 - vLocal.y * 3.1) + 7.0);
            diffuseColor.rgb = wallC * (0.5 + 0.3 * n1 + 0.15 * n2);
          } else if (abs(N.y) < 0.5) {
            bool xFace = abs(N.x) > 0.5;
            float faceW = xFace ? vScale.z : vScale.x;
            float u = (xFace ? vLocal.z * N.x : -vLocal.x * N.z) + faceW * 0.5;
            float yb = vPartY + vLocal.y; // height above the building's base
            float fh = vInfo.x;
            float faceId = xFace ? (N.x > 0.0 ? 1.0 : 2.0) : (N.z > 0.0 ? 3.0 : 4.0);
            float bayW = style > 6.5 ? 3.0 : style > 5.5 ? 4.2 : style > 3.5 ? 3.6 : style > 2.5 ? 1.5 : style > 1.5 ? 3.0 : 3.2;
            float nb = max(1.0, floor(faceW / bayW + 0.5));
            float cu = u / faceW * nb;
            float cy = yb / fh;
            float bayI = floor(cu);
            float floorI = floor(cy);
            float fx = fract(cu);
            float fy = fract(cy);
            float dx = max(fwidth(cu), 1e-4);
            float dy = max(fwidth(cy), 1e-4);
            // window rectangle per style (x0, x1, y0, y1 within a bay / storey)
            vec4 r = vec4(0.24, 0.76, 0.3, 0.84);
            if (style > 6.5) r = vec4(0.26, 0.74, 0.26, 0.8);
            else if (style > 5.5) r = vec4(0.3, 0.7, 0.3, 0.78);
            else if (style > 3.5) r = vec4(0.3, 0.7, 0.18, 0.8);
            else if (style > 2.5) r = vec4(0.03, 0.97, 0.1, 0.96);
            else if (style > 1.5) r = vec4(0.02, 0.98, 0.3, 0.86);
            if (style < 0.5 || (style > 4.5 && style < 5.5)) r = vec4(0.1, 0.9, 0.0, 0.0);
            float win = box(fx, r.x, r.y, dx) * box(fy, r.z, r.w, dy);
            float frame = box(fx, r.x - 0.05, r.y + 0.05, dx) * box(fy, r.z - 0.05, r.w + 0.04, dy) - win;
            float door = 0.0;
            if (style > 3.5 && style < 4.5) {
              // round-headed windows between pilasters, rusticated ground floor
              float bw = faceW / nb;
              float hw = (r.y - r.x) * 0.5 * bw;
              float ac = r.w * fh - hw;
              float wy = fy * fh;
              float arch = 1.0 - smoothstep(hw - 0.06, hw + 0.06, length(vec2((fx - 0.5) * bw, wy - ac)));
              win *= wy < ac ? 1.0 : arch;
              frame = box(fx, r.x - 0.06, r.y + 0.06, dx) * box(fy, r.z - 0.06, r.w + 0.05, dy) * (wy < ac + 0.15 ? 1.0 : 1.0 - smoothstep(hw + 0.1, hw + 0.25, length(vec2((fx - 0.5) * bw, wy - ac)))) - win;
              float pil = 1.0 - box(fx, 0.1, 0.9, dx);
              wallC = mix(wallC, wallC * 1.12, pil * 0.7);
              if (floorI < 0.5) wallC *= 0.9 + 0.1 * smoothstep(0.0, 0.08 + fwidth(yb / 0.55), fract(yb / 0.55));
            }
            if (style > 6.5) {
              // brick coursing and stone sills
              float by = yb / 0.3;
              float bx = u / 0.9 + 0.5 * mod(floor(by), 2.0);
              float fade = 1.0 - smoothstep(0.12, 0.35, fwidth(by));
              float mortar = max(1.0 - smoothstep(0.0, 0.12, fract(by)), 1.0 - smoothstep(0.0, 0.06, fract(bx)));
              wallC *= 1.0 - 0.13 * mortar * fade;
              float sill = box(fx, r.x - 0.05, r.y + 0.05, dx) * box(fy, r.z - 0.07, r.z - 0.01, dy);
              wallC = mix(wallC, vec3(0.75, 0.72, 0.66), sill);
            }
            if (style > 5.5 && style < 6.5) {
              // lap siding; a front door in the middle bay
              float sy = yb / 0.3;
              wallC *= 1.0 - 0.07 * (1.0 - smoothstep(0.0, 0.2, fract(sy))) * (1.0 - smoothstep(0.15, 0.4, fwidth(sy)));
              if (floorI < 0.5 && faceId > 2.5 && faceId < 3.5 && abs(bayI - floor(nb * 0.5)) < 0.5) {
                door = box(fx, 0.34, 0.66, dx) * box(fy, 0.0, 0.76, dy);
                win = 0.0;
                frame = box(fx, 0.31, 0.69, dx) * box(fy, 0.0, 0.79, dy) - door;
              }
            }
            if (style > 4.5 && style < 5.5) {
              // blank precast panels
              float px = u / 3.0;
              float py = yb / 1.5;
              float j = max(1.0 - smoothstep(0.0, 0.04 + fwidth(px), fract(px)), 1.0 - smoothstep(0.0, 0.05 + fwidth(py), fract(py)));
              wallC *= 1.0 - 0.1 * j * (1.0 - smoothstep(0.2, 0.5, fwidth(px)));
            }
            // shopfronts along the street
            if (shop && floorI < 0.5) {
              win = box(fx, 0.06, 0.94, dx) * box(fy, 0.12, 0.8, dy);
              frame = box(fy, 0.8, 0.9, dy);
            }
            if (yb < 0.4 || vLocal.y > vScale.y - 0.6) { win = 0.0; frame = 0.0; door = 0.0; }
            // industrial: corrugated cladding + a clerestory strip
            if (style < 0.5) {
              wallC *= 0.9 + 0.1 * smoothstep(-1.0, 1.0, sin(u * 10.5) / max(fwidth(u * 10.5), 1.0));
              win = box(vLocal.y, vScale.y - 2.4, vScale.y - 1.3, fwidth(vLocal.y)) * box(fract(u / 4.0), 0.1, 0.9, fwidth(u / 4.0));
              frame = 0.0;
            }
            // floor slabs & spandrels read as horizontal bands
            float slab = 1.0 - smoothstep(0.0, 0.07 + dy, fy);
            if (style > 0.5 && style < 4.5) wallC *= 1.0 - 0.1 * slab;
            // integer inputs only, so every pixel of a window gets exactly the same value
            float sd = floor(vInfo.z + 0.5);
            float rnd = hash12(vec2(bayI + faceId * 97.0 + sd * 13.0, floorI + sd * 7.0));
            float rnd2 = hash12(vec2(floorI * 3.0 + faceId + sd * 5.0, bayI * 2.0 + 11.0));
            vec3 glass = style > 2.5 && style < 3.5
              ? mix(vec3(0.16, 0.24, 0.31), vec3(0.28, 0.37, 0.44), rnd * 0.6 + 0.2)
              : mix(vec3(0.09, 0.11, 0.13), vec3(0.2, 0.22, 0.25), rnd);
            if ((style < 2.5 || style > 3.5) && style > 0.5 && rnd > 0.78) glass = mix(glass, vec3(0.72, 0.68, 0.6), 0.55); // blinds / curtains
            vec3 frameC = style > 2.5 && style < 3.5 ? vec3(0.62, 0.65, 0.68) : style > 5.5 ? vec3(0.85, 0.84, 0.8) : wallC * 0.62;
            vec3 facade = mix(wallC, frameC, clamp(frame, 0.0, 1.0));
            facade = mix(facade, glass, win);
            facade = mix(facade, vec3(0.3, 0.2, 0.13), door);
            // distant facades: blend to the average instead of shimmering
            float far = smoothstep(0.35, 0.9, max(dx, dy));
            float cover = (r.y - r.x) * (r.w - r.z);
            vec3 avg = mix(wallC, glass, cover * 0.9);
            diffuseColor.rgb = mix(facade, avg, far);
            gWin = win * (1.0 - far * 0.6);
            // about a third of rooms lit at night; distant facades glow far less
            float litChance = shop && floorI < 0.5 ? 0.6 : 0.3;
            gLit = (win * (1.0 - far) + cover * far * 0.35) * step(1.0 - litChance, rnd2) * mod(vBFlags, 2.0);
            gLitCol = mix(vec3(1.0, 0.74, 0.42), vec3(0.85, 0.9, 1.0), step(0.7, hash12(vec2(rnd2 * 91.0, rnd * 37.0))));
          } else if (N.y > 0.5) {
            // flat roof: gravel membrane with a lighter parapet edge
            vec2 e = min(vLocal.xz + vScale.xz * 0.5, vScale.xz * 0.5 - vLocal.xz);
            float edge = 1.0 - smoothstep(0.5, 0.9, min(e.x, e.y));
            float grit = hash12(floor(vLocal.xz * 2.0)) * 0.06;
            diffuseColor.rgb = mix(mix(wallC, vec3(0.44, 0.44, 0.43), 0.7) + grit, wallC * 1.05, edge);
          }
        }`,
      )
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.06, gWin);')
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor = mix(metalnessFactor, 0.35, gWin);')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += gLit * uNight * gLitCol * 0.8;')
  }
  mat.customProgramCacheKey = () => 'parts-body'
  return mat
}

/**
 * Water surface. Per-vertex aWater = (depth, flood share, flow x, flow z).
 * Animated normals advected with the flow, depth-based colour and
 * transparency, foam on shallow edges and fast water, rain ripples.
 */
export function makeWaterMaterial({ envMap, uTime, uRain, uQuake }) {
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.04, metalness: 0.0, transparent: true, envMap, envMapIntensity: 1.1, side: THREE.DoubleSide })
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uTime
    shader.uniforms.uRain = uRain
    shader.uniforms.uQuake = uQuake ?? { value: new THREE.Vector3(0, 1, 0) }
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 aWater;\nvarying vec4 vWater;\nvarying vec3 vWorldP;\nuniform float uTime;\nuniform vec3 uQuake;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vWater = aWater;
        // ground shaking sets the water sloshing: waves along the shaking direction plus a cross-swell,
        // biggest where the water is deep enough to move freely
        if (aWater.x > 0.015 && uQuake.x > 0.001) {
          vec2 d = uQuake.yz;
          float ph = dot(position.xz, d) * 0.22 - uTime * 3.4;
          float ph2 = dot(position.xz, vec2(-d.y, d.x)) * 0.15 - uTime * 2.6;
          transformed.y += uQuake.x * (0.7 * sin(ph) + 0.3 * sin(ph2)) * clamp(aWater.x / 1.5, 0.2, 1.0);
        }`,
      )
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvWorldP = (modelMatrix * vec4(transformed, 1.0)).xyz;')
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform float uTime;
        uniform float uRain;
        uniform vec3 uQuake;
        varying vec4 vWater;
        varying vec3 vWorldP;
        float gFoam = 0.0;
        ${HASH}
        float vnoise(vec2 p) {
          vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
          return mix(mix(hash12(i), hash12(i + vec2(1, 0)), f.x), mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), f.x), f.y);
        }
        vec2 waveGrad(vec2 p, vec2 flow) {
          vec2 g = vec2(0.0);
          vec2 q = p - flow * uTime * 0.9;
          const int K = 5;
          for (int i = 0; i < K; i++) {
            float fi = float(i);
            float a = fi * 2.399 + 0.7;
            vec2 d = vec2(cos(a), sin(a));
            float f = 0.35 * pow(1.55, fi);
            float ph = dot(d, q) * f + uTime * (0.9 + fi * 0.37);
            g += d * f * cos(ph) * (0.16 / pow(1.6, fi));
          }
          return g;
        }`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        float depth = vWater.x;
        if (depth < 0.015) discard;
        float flood = vWater.y;
        vec2 flow = vWater.zw;
        float speed = length(flow);
        vec3 shallowRiver = vec3(0.30, 0.38, 0.30);
        vec3 deepRiver = vec3(0.05, 0.13, 0.14);
        vec3 shallowFlood = vec3(0.50, 0.42, 0.29);
        vec3 deepFlood = vec3(0.24, 0.19, 0.12);
        float absorb = 1.0 - exp(-depth * 0.45);
        vec3 body = mix(mix(shallowRiver, deepRiver, absorb), mix(shallowFlood, deepFlood, absorb), flood);
        // foam: lapping edges, white water where it runs fast
        float n = vnoise(vWorldP.xz * 0.35 - flow * uTime * 0.6) * 0.6 + vnoise(vWorldP.xz * 1.3 - flow * uTime) * 0.4;
        float edgeFoam = (1.0 - smoothstep(0.03, 0.2, depth)) * 0.55;
        float rapid = smoothstep(2.4, 5.0, speed) * 0.6;
        // churned up by the shaking
        float slosh = clamp(uQuake.x * 0.9, 0.0, 0.6);
        float fm = max(max(edgeFoam, rapid), slosh);
        gFoam = clamp(smoothstep(0.58, 0.92, n + fm * 0.3) * fm, 0.0, 0.7);
        // fast water still shows streaks of turbulence without turning white
        body *= 1.0 + smoothstep(0.8, 3.0, speed) * (n - 0.5) * 0.35;
        diffuseColor.rgb = mix(body, vec3(0.86, 0.84, 0.78), gFoam);
        diffuseColor.a = clamp(smoothstep(0.0, 0.7, depth) * 0.82 + 0.1 + flood * 0.08, 0.0, 0.97);`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
        {
          vec2 g = waveGrad(vWorldP.xz, flow);
          if (uQuake.x > 0.001) {
            // slopes of the sloshing waves (matching the vertex displacement) plus choppy short waves
            vec2 d = uQuake.yz;
            vec2 e = vec2(-d.y, d.x);
            g += d * cos(dot(vWorldP.xz, d) * 0.22 - uTime * 3.4) * 0.22 * 0.7 * uQuake.x;
            g += e * cos(dot(vWorldP.xz, e) * 0.15 - uTime * 2.6) * 0.15 * 0.3 * uQuake.x;
            g += vec2(cos(vWorldP.x * 1.7 + uTime * 9.0), sin(vWorldP.z * 1.9 - uTime * 8.0)) * 0.25 * uQuake.x;
          }
          // raindrop ripples
          if (uRain > 0.01) {
            vec2 c = floor(vWorldP.xz * 0.5);
            vec2 f = fract(vWorldP.xz * 0.5) - 0.5;
            float t0 = hash12(c);
            float ph = fract(uTime * 0.8 + t0);
            float r = length(f - (vec2(hash12(c + 3.1), hash12(c + 7.7)) - 0.5) * 0.4);
            float ring = sin((r - ph * 0.5) * 40.0) * (1.0 - ph) * smoothstep(0.5 * ph + 0.05, 0.5 * ph, r);
            g += (f / max(r, 0.01)) * ring * 0.5 * clamp(uRain / 40.0, 0.0, 1.0);
          }
          float rough = 1.0 + speed * 0.6 + flood * 0.4;
          vec3 nW = normalize(vec3(-g.x * rough, 1.0, -g.y * rough));
          normal = normalize((viewMatrix * vec4(nW, 0.0)).xyz);
          float fres = pow(1.0 - clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0), 4.0);
          diffuseColor.a = mix(diffuseColor.a, 1.0, fres * 0.7 + gFoam * 0.5);
        }`,
      )
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(0.035 + vWater.y * 0.08, 0.7, gFoam);')
  }
  return mat
}

/** Gradient sky + sun as a PMREM environment, regenerated as the sky changes. */
export class SkyEnvironment {
  constructor(renderer) {
    this.renderer = renderer
    this.pmrem = new THREE.PMREMGenerator(renderer)
    this.scene = new THREE.Scene()
    this.uniforms = {
      top: { value: new THREE.Color(0x4f7fbf) },
      horizon: { value: new THREE.Color(0xbcd4ea) },
      ground: { value: new THREE.Color(0x3b4535) },
      sunDir: { value: new THREE.Vector3(0.3, 0.8, 0.2) },
      sunCol: { value: new THREE.Color(1, 0.95, 0.85) },
    }
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      uniforms: this.uniforms,
      vertexShader: 'varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: `uniform vec3 top; uniform vec3 horizon; uniform vec3 ground; uniform vec3 sunDir; uniform vec3 sunCol; varying vec3 vDir;
        void main(){ float y = vDir.y; vec3 c = y > 0.0 ? mix(horizon, top, pow(y, 0.6)) : mix(horizon, ground, pow(-y, 0.4));
          float s = max(dot(normalize(vDir), normalize(sunDir)), 0.0); c += sunCol * (pow(s, 600.0) * 30.0 + pow(s, 12.0) * 0.4);
          gl_FragColor = vec4(c, 1.0); }`,
    })
    this.scene.add(new THREE.Mesh(new THREE.SphereGeometry(100, 32, 16), mat))
    this.texture = null
    this.key = ''
  }

  update({ top, horizon, ground, sunDir, sunCol }) {
    const key = [top, horizon, sunCol].map((c) => c.getHexString()).join() + sunDir.toArray().map((v) => v.toFixed(1)).join()
    if (key === this.key) return false
    this.key = key
    this.uniforms.top.value.copy(top)
    this.uniforms.horizon.value.copy(horizon)
    this.uniforms.ground.value.copy(ground)
    this.uniforms.sunDir.value.copy(sunDir)
    this.uniforms.sunCol.value.copy(sunCol)
    const old = this.texture
    this.texture = this.pmrem.fromScene(this.scene, 0).texture
    old?.dispose()
    return true
  }
}
