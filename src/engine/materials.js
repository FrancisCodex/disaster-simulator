// Custom materials: procedural building facades (with flexural sway),
// animated water, and a sky environment map for reflections.
import * as THREE from 'three'

const HASH = /* glsl */ `
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}`

// First-mode bending: the base is fixed, the top moves the most.
const SWAY_PROJECT = /* glsl */ `
vec4 mvPosition = vec4( transformed, 1.0 );
#ifdef USE_INSTANCING
  mvPosition = instanceMatrix * mvPosition;
#endif
float swayY = clamp(position.y, 0.0, 1.0);
mvPosition.xz += aSway.xy * swayY * swayY * (3.0 - 2.0 * swayY);
mvPosition = modelViewMatrix * mvPosition;
gl_Position = projectionMatrix * mvPosition;`

function injectSway(shader) {
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nattribute vec3 aSway;')
    .replace('#include <project_vertex>', SWAY_PROJECT)
}

/** Shadow-casting depth material that bends with the building. */
export function makeSwayDepthMaterial() {
  const m = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking })
  m.onBeforeCompile = injectSway
  return m
}

/**
 * Facade styles (aInfo.y): 0 industrial cladding, 1 punched windows,
 * 2 ribbon windows (offices), 3 glass curtain wall (towers).
 * aInfo = (floor height, style, seed, lights allowed)
 */
export function makeBuildingMaterial({ uNight, envMap }) {
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.86, metalness: 0.0, envMap, envMapIntensity: 0.4 })
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uNight = uNight
    injectSway(shader)
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 aInfo;\nflat varying vec4 vInfo;\nvarying vec3 vLocal;\nvarying vec3 vONormal;\nvarying vec3 vScale;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vInfo = aInfo;
        vScale = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
        vLocal = position * vScale;
        vLocal.y += aSway.z; // collapsing storeys disappear at the base, the top keeps its floors
        vONormal = normal;`,
      )
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform float uNight;
        flat varying vec4 vInfo;
        varying vec3 vLocal;
        varying vec3 vONormal;
        varying vec3 vScale;
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
          vec3 N = vec3(sign(vONormal.x) * step(0.5, abs(vONormal.x)), sign(vONormal.y) * step(0.5, abs(vONormal.y)), sign(vONormal.z) * step(0.5, abs(vONormal.z)));
          float style = floor(vInfo.y + 0.5);
          vec3 wallC = diffuseColor.rgb;
          if (abs(N.y) < 0.5) {
            bool xFace = abs(N.x) > 0.5;
            float faceW = xFace ? vScale.z : vScale.x;
            float u = (xFace ? vLocal.z * N.x : -vLocal.x * N.z) + faceW * 0.5;
            float y = vLocal.y;
            float fh = vInfo.x;
            float faceId = xFace ? (N.x > 0.0 ? 1.0 : 2.0) : (N.z > 0.0 ? 3.0 : 4.0);
            float bayW = style > 2.5 ? 1.5 : (style > 1.5 ? 3.0 : 3.2);
            float nb = max(1.0, floor(faceW / bayW + 0.5));
            float cu = u / faceW * nb;
            float cy = y / fh;
            float bayI = floor(cu);
            float floorI = floor(cy);
            float fx = fract(cu);
            float fy = fract(cy);
            float dx = max(fwidth(cu), 1e-4);
            float dy = max(fwidth(cy), 1e-4);
            // window rectangle per style (x0, x1, y0, y1 within a bay / storey)
            vec4 r = style > 2.5 ? vec4(0.03, 0.97, 0.1, 0.96) : (style > 1.5 ? vec4(0.02, 0.98, 0.3, 0.86) : vec4(0.24, 0.76, 0.3, 0.84));
            if (style < 0.5) r = vec4(0.1, 0.9, 0.0, 0.0);
            float win = box(fx, r.x, r.y, dx) * box(fy, r.z, r.w, dy);
            float frame = box(fx, r.x - 0.05, r.y + 0.05, dx) * box(fy, r.z - 0.05, r.w + 0.04, dy) - win;
            // ground floor: shopfronts on everything but houses & sheds
            if (floorI < 0.5 && style > 0.5) {
              float shop = style > 1.5 || vInfo.x > 3.3 ? 1.0 : 0.0;
              win = mix(win, box(fx, 0.06, 0.94, dx) * box(fy, 0.12, 0.8, dy), shop);
              frame = mix(frame, box(fy, 0.8, 0.9, dy), shop);
            }
            if (y < 0.4 || y > vScale.y - 0.6) { win = 0.0; frame = 0.0; }
            // industrial: corrugated cladding + a clerestory strip
            if (style < 0.5) {
              wallC *= 0.9 + 0.1 * smoothstep(-1.0, 1.0, sin(u * 10.5) / max(fwidth(u * 10.5), 1.0));
              win = box(y, vScale.y - 2.4, vScale.y - 1.3, fwidth(y)) * box(fract(u / 4.0), 0.1, 0.9, fwidth(u / 4.0));
              frame = 0.0;
            }
            // floor slabs & spandrels read as horizontal bands
            float slab = 1.0 - smoothstep(0.0, 0.07 + dy, fy);
            wallC *= 1.0 - 0.1 * slab * step(0.5, style);
            // integer inputs only, so every pixel of a window gets exactly the same value
            float sd = floor(vInfo.z + 0.5);
            float rnd = hash12(vec2(bayI + faceId * 97.0 + sd * 13.0, floorI + sd * 7.0));
            float rnd2 = hash12(vec2(floorI * 3.0 + faceId + sd * 5.0, bayI * 2.0 + 11.0));
            vec3 glass = style > 2.5
              ? mix(vec3(0.16, 0.24, 0.31), vec3(0.28, 0.37, 0.44), rnd * 0.6 + 0.2)
              : mix(vec3(0.09, 0.11, 0.13), vec3(0.2, 0.22, 0.25), rnd);
            if (style > 0.5 && style < 2.5 && rnd > 0.78) glass = mix(glass, vec3(0.72, 0.68, 0.6), 0.55); // blinds / curtains
            vec3 frameC = style > 2.5 ? vec3(0.62, 0.65, 0.68) : wallC * 0.62;
            vec3 facade = mix(wallC, frameC, clamp(frame, 0.0, 1.0));
            facade = mix(facade, glass, win);
            // distant facades: blend to the average instead of shimmering
            float far = smoothstep(0.35, 0.9, max(dx, dy));
            float cover = (r.y - r.x) * (r.w - r.z);
            vec3 avg = mix(wallC, glass, cover * 0.9);
            diffuseColor.rgb = mix(facade, avg, far);
            gWin = win * (1.0 - far * 0.6);
            float litChance = floorI < 0.5 && style > 0.5 ? 0.85 : 0.5;
            gLit = (win * (1.0 - far) + cover * far) * step(1.0 - litChance, rnd2);
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
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += gLit * uNight * vInfo.w * gLitCol * 1.6;')
  }
  return mat
}

/**
 * Water surface. Per-vertex aWater = (depth, flood share, flow x, flow z).
 * Animated normals advected with the flow, depth-based colour and
 * transparency, foam on shallow edges and fast water, rain ripples.
 */
export function makeWaterMaterial({ envMap, uTime, uRain }) {
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.04, metalness: 0.0, transparent: true, envMap, envMapIntensity: 1.1, side: THREE.DoubleSide })
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uTime
    shader.uniforms.uRain = uRain
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 aWater;\nvarying vec4 vWater;\nvarying vec3 vWorldP;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWater = aWater;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvWorldP = (modelMatrix * vec4(transformed, 1.0)).xyz;')
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform float uTime;
        uniform float uRain;
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
        float fm = max(edgeFoam, rapid);
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
