/**
 * softbench_renderer — Blockbench plugin
 *
 * PS1-style software rasterizer that replaces the WebGL viewport.
 * Single-file IIFE (Blockbench wraps plugin files).
 *
 * Features:
 *   - 640×400 default resolution, pixel-perfect CSS upscale
 *   - Fixed-point half-space triangle rasterization
 *   - Per-pixel distance fog with Bayer 4×4 dithering
 *   - 15-bit color quantization (5/5/5)
 *   - Flat shading with directional face light
 *   - Full hierarchical group transforms via Three.js matrixWorld
 *   - Near-plane clipping (Sutherland-Hodgman)
 *   - Ctrl+Shift+P toggle
 */

// ═══════════════════════════════════════════════════════════════════════════════
// § ps1fx — PS1-authentic color utilities (all integer arithmetic)
// ═══════════════════════════════════════════════════════════════════════════════

const _BAYER_4X4 = new Int32Array([
   0,  8,  2, 10,
  12,  4, 14,  6,
   3, 11,  1,  9,
  15,  7, 13,  5,
]);

function _rgba(r, g, b, a = 255) {
  return ((a & 0xff) << 24) | ((b & 0xff) << 16) | ((g & 0xff) << 8) | (r & 0xff);
}

function _unpack(c) {
  return {
    r: c & 0xff,
    g: (c >>> 8) & 0xff,
    b: (c >>> 16) & 0xff,
    a: (c >>> 24) & 0xff,
  };
}

function _quantize15(c, x, y) {
  const r = c & 0xff;
  const g = (c >>> 8) & 0xff;
  const b = (c >>> 16) & 0xff;
  const a = c >>> 24;
  const t = _BAYER_4X4[(y & 3) * 4 + (x & 3)] - 7;
  let rv = r + t; if (rv < 0) rv = 0; else if (rv > 255) rv = 255; rv &= 0xf8;
  let gv = g + t; if (gv < 0) gv = 0; else if (gv > 255) gv = 255; gv &= 0xf8;
  let bv = b + t; if (bv < 0) bv = 0; else if (bv > 255) bv = 255; bv &= 0xf8;
  return (a << 24) | (bv << 16) | (gv << 8) | rv;
}

function _shade(c, t) {
  if (t <= 0) return c;
  if (t >= 1) return c & 0xff000000;
  const inv = (256 - (t * 256 + 0.5) | 0);
  const r = ((c & 0xff) * inv) >> 8;
  const g = (((c >>> 8) & 0xff) * inv) >> 8;
  const b = (((c >>> 16) & 0xff) * inv) >> 8;
  const a = c >>> 24;
  return (a << 24) | (b << 16) | (g << 8) | r;
}

function _tint(c, target, t) {
  if (t <= 0) return c;
  if (t >= 1) return (c & 0xff000000) | (target & 0x00ffffff);
  const f = (t * 256 + 0.5) | 0;
  const cr = c & 0xff,      tr = target & 0xff;
  const cg = (c >>> 8) & 0xff,  tg = (target >>> 8) & 0xff;
  const cb = (c >>> 16) & 0xff, tb = (target >>> 16) & 0xff;
  const r = cr + (((tr - cr) * f) >> 8);
  const g = cg + (((tg - cg) * f) >> 8);
  const b = cb + (((tb - cb) * f) >> 8);
  const a = c >>> 24;
  return (a << 24) | (b << 16) | (g << 8) | r;
}

// ═══════════════════════════════════════════════════════════════════════════════
// § textureloader — CPU texture sampler
// ═══════════════════════════════════════════════════════════════════════════════

function _sampleTextureNearest(tex, u, v) {
  if (!tex || !tex.data || tex.width <= 0 || tex.height <= 0) return 0xffffffff;
  let x = Math.floor(u * tex.width);
  let y = Math.floor(v * tex.height);
  if (tex.wrap) {
    x = ((x % tex.width) + tex.width) % tex.width;
    y = ((y % tex.height) + tex.height) % tex.height;
  } else {
    x = x < 0 ? 0 : x >= tex.width ? tex.width - 1 : x;
    y = y < 0 ? 0 : y >= tex.height ? tex.height - 1 : y;
  }
  const i = (((tex.oy || 0) + y) * (tex.stride || tex.width) + (tex.ox || 0) + x) * 4;
  const r = tex.data[i];
  const g = tex.data[i + 1];
  const b = tex.data[i + 2];
  const a = tex.data[i + 3];
  return (a << 24) | (b << 16) | (g << 8) | r;
}

function _tintTexelRGBA(texel, tint) {
  const tr = tint & 255;
  const tg = (tint >>> 8) & 255;
  const tb = (tint >>> 16) & 255;
  const r = texel & 255;
  const g = (texel >>> 8) & 255;
  const b = (texel >>> 16) & 255;
  const a = (texel >>> 24) & 255;
  return (
    (a << 24) |
    ((((b * tb) / 255) | 0) << 16) |
    ((((g * tg) / 255) | 0) << 8) |
    (((r * tr) / 255) | 0)
  ) >>> 0;
}

// ─── Blockbench texture → CPU texture cache ──────────────────────────────────
const _texCache = new Map();

function _serializeBBTexture(bbTexture) {
  if (!bbTexture) return null;
  const id = bbTexture.uuid || bbTexture.id;
  if (id && _texCache.has(id)) return _texCache.get(id);
  let img = bbTexture.img || bbTexture._img;
  if (!img && bbTexture.source) {
    img = document.querySelector('img[src="' + bbTexture.source + '"]');
  }
  if (!img || !img.complete || !img.naturalWidth) return null;
  const c = document.createElement("canvas");
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const imageData = ctx.getImageData(0, 0, c.width, c.height);
  const tex = {
    width: c.width,
    height: c.height,
    data: imageData.data,
    wrap: true,
    nearest: true,
  };
  if (id) _texCache.set(id, tex);
  return tex;
}

function _serializeThreeTexture(threeTex) {
  if (!threeTex || !threeTex.image) return null;
  const img = threeTex.image;
  const key = "three_" + (threeTex.uuid || threeTex.id || "");
  if (key && _texCache.has(key)) return _texCache.get(key);
  let w, h;
  if (img.width && img.height) { w = img.width; h = img.height; }
  else if (img.naturalWidth) { w = img.naturalWidth; h = img.naturalHeight; }
  else return null;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, w, h);
  const imageData = ctx.getImageData(0, 0, w, h);
  const tex = {
    width: w,
    height: h,
    data: imageData.data,
    wrap: true,
    nearest: true,
  };
  if (key) _texCache.set(key, tex);
  return tex;
}

function _getFaceTexture(cube, faceName) {
  if (!cube.faces || !cube.faces[faceName]) return null;
  const face = cube.faces[faceName];
  if (face.texture === undefined || face.texture === null || face.texture === -1) return null;
  if (typeof Texture === "undefined" || !Texture.all) return null;
  const tex = Texture.all[face.texture];
  return _serializeBBTexture(tex);
}

function _getMeshTexture(cube) {
  if (!cube.mesh) return null;
  const mat = cube.mesh.material;
  if (mat) {
    const mats = mat.length ? mat : [mat];
    for (const m of mats) {
      if (m.map) return _serializeThreeTexture(m.map);
      if (m.color && !m.map) return null;
    }
  }
  if (typeof Texture !== "undefined" && Texture.all && Texture.all.length > 0) {
    return _serializeBBTexture(Texture.all[0]);
  }
  return null;
}

function _invalidateTextureCache() {
  _texCache.clear();
}

// ═══════════════════════════════════════════════════════════════════════════════
// § rasterizer — Fixed-point software rasterizer
// ═══════════════════════════════════════════════════════════════════════════════

let _SCREEN_W = 640;
let _SCREEN_H = 400;
let _HALF_W   = 320;
let _HALF_H   = 200;
let _FOCAL_Y  = (_HALF_H / Math.tan((50 * Math.PI / 180) / 2)) | 0;
let _FOCAL_X  = _FOCAL_Y;

function _setResolution(w, h, fovDeg = 50) {
  _SCREEN_W = w;
  _SCREEN_H = h;
  _HALF_W = (w / 2) | 0;
  _HALF_H = (h / 2) | 0;
  _FOCAL_Y = (_HALF_H / Math.tan((fovDeg * Math.PI / 180) / 2)) | 0;
  _FOCAL_X = _FOCAL_Y;
}

function _getResolution() {
  return { w: _SCREEN_W, h: _SCREEN_H };
}

// ─── Trig LUT ───────────────────────────────────────────────────────────────
const _SIN = new Float32Array(360);
const _COS = new Float32Array(360);
for (let i = 0; i < 360; i++) {
  const rad = (i * Math.PI) / 180;
  _SIN[i] = Math.sin(rad);
  _COS[i] = Math.cos(rad);
}
function _sinDeg(deg) { return _SIN[(((deg % 360) + 360) % 360) | 0]; }
function _cosDeg(deg) { return _COS[(((deg % 360) + 360) % 360) | 0]; }

function _scaleAtX(camZ) { return camZ > 0.001 ? _FOCAL_X / camZ : 0; }
function _scaleAtY(camZ) { return camZ > 0.001 ? _FOCAL_Y / camZ : 0; }

// ─── Near-plane / fog constants ─────────────────────────────────────────────
const _NEAR_Z = 0.1;
const _FOG_NEAR = 200.0;
const _FOG_FAR  = 1600.0;
const _FOG_LUT_LEN = 4096;
const _fogLut = new Uint8Array(_FOG_LUT_LEN);
{
  const range = _FOG_FAR - _FOG_NEAR;
  for (let i = 0; i < _FOG_LUT_LEN; i++) {
    const z = i * 0.1;
    if (z <= _FOG_NEAR)      _fogLut[i] = 0;
    else if (z >= _FOG_FAR)  _fogLut[i] = 255;
    else                      _fogLut[i] = ((z - _FOG_NEAR) / range * 255) | 0;
  }
}
function _fogByte(camZ) {
  const i = (camZ * 10) | 0;
  if (i <= 0)            return 0;
  if (i >= _FOG_LUT_LEN) return 255;
  return _fogLut[i];
}

let _FOG_COLOR = _rgba(50, 50, 50);
const _FC_R = () => _FOG_COLOR & 0xff;
const _FC_G = () => (_FOG_COLOR >>> 8) & 0xff;
const _FC_B = () => (_FOG_COLOR >>> 16) & 0xff;

const _BAYER = new Int32Array(16);
for (let i = 0; i < 16; i++) _BAYER[i] = _BAYER_4X4[i] - 7;

const _FOG_RANGE_INV = 1.0 / (_FOG_FAR - _FOG_NEAR);

// ─── Renderer state ─────────────────────────────────────────────────────────
function _createRenderer(canvas) {
  const ctx = canvas.getContext("2d", { alpha: false, willReadFrequently: true });
  ctx.imageSmoothingEnabled = false;
  const w = canvas.width || _SCREEN_W;
  const h = canvas.height || _SCREEN_H;
  const image = ctx.createImageData(w, h);
  const buf32 = new Uint32Array(image.data.buffer);
  const depth = new Float32Array(w * h);
  return { ctx, image, buf32, depth, canvas, w, h };
}

function _resizeRenderer(rd, w, h) {
  if (rd.w === w && rd.h === h) return;
  const ctx = rd.canvas.getContext("2d", { alpha: false, willReadFrequently: true });
  ctx.imageSmoothingEnabled = false;
  const image = ctx.createImageData(w, h);
  const buf32 = new Uint32Array(image.data.buffer);
  const depth = new Float32Array(w * h);
  rd.ctx = ctx;
  rd.image = image;
  rd.buf32 = buf32;
  rd.depth = depth;
  rd.w = w;
  rd.h = h;
}

// ─── Camera-space transform ────────────────────────────────────────────────
function _toCameraSpace(world, camera) {
  const dx = world.x - camera.x;
  const dy = world.y - camera.y;
  const dz = world.z - camera.z;
  const cy = _cosDeg(-camera.yaw);
  const sy = _sinDeg(-camera.yaw);
  let cx  =  dx * cy + dz * sy;
  let cz  = -dx * sy + dz * cy;
  let cyy = dy;
  const pitch = camera.pitch || 0;
  if (pitch !== 0) {
    const cp = _cosDeg(pitch);
    const sp = _sinDeg(pitch);
    const cyy2 = cyy * cp + cz * sp;
    const cz2  = -cyy * sp + cz * cp;
    cyy = cyy2;
    cz  = cz2;
  }
  return { cx, cy: cyy, cz: -cz, u: world.u ?? 0, v: world.v ?? 0 };
}

function _projectCS(cs, camera) {
  if (cs.cz < _NEAR_Z) return { sx: 0, sy: 0, cz: cs.cz, u: cs.u ?? 0, v: cs.v ?? 0, visible: false };
  const fovMul = camera.fovMul || 1.0;
  const sx = (_HALF_W + cs.cx * _scaleAtX(cs.cz) * fovMul) | 0;
  const sy = (_HALF_H - cs.cy * _scaleAtY(cs.cz) * fovMul) | 0;
  return { sx, sy, cz: cs.cz, u: cs.u ?? 0, v: cs.v ?? 0, visible: true };
}

function _project(world, camera) {
  return _projectCS(_toCameraSpace(world, camera), camera);
}

// ─── Near-plane clip (Sutherland-Hodgman) ──────────────────────────────────
function _clipNear(pts) {
  const out = [];
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    const aIn = a.cz >= _NEAR_Z;
    const bIn = b.cz >= _NEAR_Z;
    if (aIn) out.push(a);
    if (aIn !== bIn) {
      const t = (_NEAR_Z - a.cz) / (b.cz - a.cz);
      out.push({
        cx: a.cx + t * (b.cx - a.cx),
        cy: a.cy + t * (b.cy - a.cy),
        cz: _NEAR_Z,
        u: (a.u ?? 0) + t * ((b.u ?? 0) - (a.u ?? 0)),
        v: (a.v ?? 0) + t * ((b.v ?? 0) - (a.v ?? 0)),
      });
    }
  }
  return out;
}

function _emitClipped(csPts, color, camera, texture) {
  if (csPts.length < 3) return [];
  const tris = [];
  const v0 = _projectCS(csPts[0], camera);
  for (let i = 1; i + 1 < csPts.length; i++) {
    const va = _projectCS(csPts[i], camera);
    const vb = _projectCS(csPts[i + 1], camera);
    if (!v0.visible || !va.visible || !vb.visible) continue;
    const avgZ = (v0.cz + va.cz + vb.cz) * 0.3333333;
    tris.push({ verts: [v0, va, vb], color, avgZ, texture: texture || null });
  }
  return tris;
}

function _buildFace(worldPts, color, camera, texture) {
  const csPts = worldPts.map(p => _toCameraSpace(p, camera));
  const clipped = _clipNear(csPts);
  return _emitClipped(clipped, color, camera, texture);
}

function _shadeFace(c, brightness) {
  const r = Math.min(255, ((c & 0xff) * brightness)) | 0;
  const g = Math.min(255, (((c >>> 8) & 0xff) * brightness)) | 0;
  const b = Math.min(255, (((c >>> 16) & 0xff) * brightness)) | 0;
  return (255 << 24) | (b << 16) | (g << 8) | r;
}

// ─── Flat-shaded triangle rasterization ────────────────────────────────────
function _drawTriangle(rd, v0, v1, v2, color) {
  if (!v0.visible || !v1.visible || !v2.visible) return;
  const x1 = v0.sx | 0, y1 = v0.sy | 0;
  const x2 = v1.sx | 0, y2 = v1.sy | 0;
  const x3 = v2.sx | 0, y3 = v2.sy | 0;
  const minX = x1 < x2 ? (x1 < x3 ? x1 : x3) : (x2 < x3 ? x2 : x3);
  const maxX = x1 > x2 ? (x1 > x3 ? x1 : x3) : (x2 > x3 ? x2 : x3);
  const minY = y1 < y2 ? (y1 < y3 ? y1 : y3) : (y2 < y3 ? y2 : y3);
  const maxY = y1 > y2 ? (y1 > y3 ? y1 : y3) : (y2 > y3 ? y2 : y3);
  if (maxX < 0 || minX >= rd.w || maxY < 0 || minY >= rd.h) return;
  const area = (x1 - x3) * (y2 - y1) - (x1 - x2) * (y3 - y1);
  if (area === 0) return;
  const cR = color & 0xff;
  const cG = (color >>> 8) & 0xff;
  const cB = (color >>> 16) & 0xff;
  const cA = color >>> 24;
  const dx12 = x1 - x2, dy12 = y1 - y2;
  const dx23 = x2 - x3, dy23 = y2 - y3;
  const dx31 = x3 - x1, dy31 = y3 - y1;
  const invArea = 1 / area;
  const zF0 = v0.cz * invArea;
  const zF1 = v1.cz * invArea;
  const zF2 = v2.cz * invArea;
  const dzdx = dy23 * zF0 + dy31 * zF1 + dy12 * zF2;
  const dzdy = -dx23 * zF0 - dx31 * zF1 - dx12 * zF2;
  const x0c = minX < 0 ? 0 : minX;
  const xec = maxX >= rd.w ? rd.w - 1 : maxX;
  const y0c = minY < 0 ? 0 : minY;
  const yec = maxY >= rd.h ? rd.h - 1 : maxY;
  const { buf32, depth } = rd;
  const sw = rd.w;
  let w1_row = (x0c - x2) * dy23 - (y0c - y2) * dx23;
  let w2_row = (x0c - x3) * dy31 - (y0c - y3) * dx31;
  let w3_row = (x0c - x1) * dy12 - (y0c - y1) * dx12;
  const fcr = _FC_R(), fcg = _FC_G(), fcb = _FC_B();
  for (let y = y0c; y <= yec; y++) {
    const row = y * sw;
    const by = y & 3;
    let w1 = w1_row;
    let w2 = w2_row;
    let w3 = w3_row;
    let zRow = w1_row * zF0 + w2_row * zF1 + w3_row * zF2;
    for (let x = x0c; x <= xec; x++) {
      const allPos = (w1 >= 0) & (w2 >= 0) & (w3 >= 0);
      const allNeg = (w1 <= 0) & (w2 <= 0) & (w3 <= 0);
      if (allPos | allNeg) {
        const z = zRow;
        const idx = row + x;
        if (z < depth[idx]) {
          depth[idx] = z;
          let t256;
          if (z <= _FOG_NEAR) {
            t256 = 0;
          } else if (z >= _FOG_FAR) {
            t256 = 256;
          } else {
            t256 = ((z - _FOG_NEAR) * _FOG_RANGE_INV * 256) | 0;
          }
          const t = _BAYER[(by << 2) | (x & 3)];
          const invT = 256 - t256;
          const r0 = ((fcr * t256 + cR * invT) >> 8);
          const g0 = ((fcg * t256 + cG * invT) >> 8);
          const b0 = ((fcb * t256 + cB * invT) >> 8);
          const r2 = (r0 + t) < 0 ? 0 : (r0 + t) > 255 ? 0xf8 : ((r0 + t) & 0xf8);
          const g2 = (g0 + t) < 0 ? 0 : (g0 + t) > 255 ? 0xf8 : ((g0 + t) & 0xf8);
          const b2 = (b0 + t) < 0 ? 0 : (b0 + t) > 255 ? 0xf8 : ((b0 + t) & 0xf8);
          buf32[idx] = (cA << 24) | (b2 << 16) | (g2 << 8) | r2;
        }
      }
      w1 += dy23;
      w2 += dy31;
      w3 += dy12;
      zRow += dzdx;
    }
    w1_row -= dx23;
    w2_row -= dx31;
    w3_row -= dx12;
  }
}

// ─── Textured triangle ─────────────────────────────────────────────────────
function _drawTexturedTriangle(rd, v0, v1, v2, color, texture) {
  if (!texture) return _drawTriangle(rd, v0, v1, v2, color);
  if (!v0.visible || !v1.visible || !v2.visible) return;
  const x1 = v0.sx | 0, y1 = v0.sy | 0;
  const x2 = v1.sx | 0, y2 = v1.sy | 0;
  const x3 = v2.sx | 0, y3 = v2.sy | 0;
  const minX = x1 < x2 ? (x1 < x3 ? x1 : x3) : (x2 < x3 ? x2 : x3);
  const maxX = x1 > x2 ? (x1 > x3 ? x1 : x3) : (x2 > x3 ? x2 : x3);
  const minY = y1 < y2 ? (y1 < y3 ? y1 : y3) : (y2 < y3 ? y2 : y3);
  const maxY = y1 > y2 ? (y1 > y3 ? y1 : y3) : (y2 > y3 ? y2 : y3);
  if (maxX < 0 || minX >= rd.w || maxY < 0 || minY >= rd.h) return;
  const area = (x1 - x3) * (y2 - y1) - (x1 - x2) * (y3 - y1);
  if (area === 0) return;
  const dx12 = x1 - x2, dy12 = y1 - y2;
  const dx23 = x2 - x3, dy23 = y2 - y3;
  const dx31 = x3 - x1, dy31 = y3 - y1;
  const invArea = 1 / area;
  const zF0 = v0.cz * invArea;
  const zF1 = v1.cz * invArea;
  const zF2 = v2.cz * invArea;
  const u0 = (v0.u ?? 0) * invArea;
  const u1 = (v1.u ?? 0) * invArea;
  const u2 = (v2.u ?? 0) * invArea;
  const vv0 = (v0.v ?? 0) * invArea;
  const vv1 = (v1.v ?? 0) * invArea;
  const vv2 = (v2.v ?? 0) * invArea;
  const x0c = minX < 0 ? 0 : minX;
  const xec = maxX >= rd.w ? rd.w - 1 : maxX;
  const y0c = minY < 0 ? 0 : minY;
  const yec = maxY >= rd.h ? rd.h - 1 : maxY;
  const { buf32, depth } = rd;
  const sw = rd.w;
  let w1_row = (x0c - x2) * dy23 - (y0c - y2) * dx23;
  let w2_row = (x0c - x3) * dy31 - (y0c - y3) * dx31;
  let w3_row = (x0c - x1) * dy12 - (y0c - y1) * dx12;
  const fcr = _FC_R(), fcg = _FC_G(), fcb = _FC_B();
  for (let y = y0c; y <= yec; y++) {
    const row = y * sw;
    const by = y & 3;
    let w1 = w1_row, w2 = w2_row, w3 = w3_row;
    let zRow = w1_row * zF0 + w2_row * zF1 + w3_row * zF2;
    let uRow = w1_row * u0 + w2_row * u1 + w3_row * u2;
    let vRow = w1_row * vv0 + w2_row * vv1 + w3_row * vv2;
    for (let x = x0c; x <= xec; x++) {
      const allPos = (w1 >= 0) & (w2 >= 0) & (w3 >= 0);
      const allNeg = (w1 <= 0) & (w2 <= 0) & (w3 <= 0);
      if (allPos | allNeg) {
        const z = zRow;
        const idx = row + x;
        if (z < depth[idx]) {
          const texel = _sampleTextureNearest(texture, uRow, vRow);
          if ((texel >>> 24) >= 128) {
            depth[idx] = z;
            const tinted = _tintTexelRGBA(texel, color);
            const cR2 = tinted & 0xff;
            const cG2 = (tinted >>> 8) & 0xff;
            const cB2 = (tinted >>> 16) & 0xff;
            const cA2 = tinted >>> 24;
            let t256;
            if (z <= _FOG_NEAR) t256 = 0;
            else if (z >= _FOG_FAR) t256 = 256;
            else t256 = ((z - _FOG_NEAR) * _FOG_RANGE_INV * 256) | 0;
            const t = _BAYER[(by << 2) | (x & 3)];
            const invT = 256 - t256;
            const r0 = ((fcr * t256 + cR2 * invT) >> 8);
            const g0 = ((fcg * t256 + cG2 * invT) >> 8);
            const b0 = ((fcb * t256 + cB2 * invT) >> 8);
            const r2 = (r0 + t) < 0 ? 0 : (r0 + t) > 255 ? 0xf8 : ((r0 + t) & 0xf8);
            const g2 = (g0 + t) < 0 ? 0 : (g0 + t) > 255 ? 0xf8 : ((g0 + t) & 0xf8);
            const b2 = (b0 + t) < 0 ? 0 : (b0 + t) > 255 ? 0xf8 : ((b0 + t) & 0xf8);
            buf32[idx] = (cA2 << 24) | (b2 << 16) | (g2 << 8) | r2;
          }
        }
      }
      w1 += dy23; w2 += dy31; w3 += dy12;
      zRow += dy23 * zF0 + dy31 * zF1 + dy12 * zF2;
      uRow += dy23 * u0 + dy31 * u1 + dy12 * u2;
      vRow += dy23 * vv0 + dy31 * vv1 + dy12 * vv2;
    }
    w1_row -= dx23; w2_row -= dx31; w3_row -= dx12;
  }
}

// ─── Pixel point ────────────────────────────────────────────────────────────
function _drawPixelW(rd, world, camera, color, size = 1) {
  const p = _project(world, camera);
  if (!p.visible) return;
  const fogB = _fogByte(p.cz);
  const fogT256 = fogB;
  const fr = color & 0xff, fg = (color >>> 8) & 0xff, fb = (color >>> 16) & 0xff;
  const rr = fr + (((_FC_R() - fr) * fogT256) >> 8);
  const rg = fg + (((_FC_G() - fg) * fogT256) >> 8);
  const rb = fb + (((_FC_B() - fb) * fogT256) >> 8);
  const ra = color >>> 24;
  const tinted = (ra << 24) | (rb << 16) | (rg << 8) | rr;
  const c = _quantize15(tinted, p.sx, p.sy);
  const { buf32, depth } = rd;
  const sw = rd.w, sh = rd.h;
  for (let dy = -size; dy <= size; dy++) {
    const y = (p.sy + dy) | 0;
    if (y < 0 || y >= sh) continue;
    const row = y * sw;
    for (let dx = -size; dx <= size; dx++) {
      const x = (p.sx + dx) | 0;
      if (x < 0 || x >= sw) continue;
      const idx = row + x;
      if (p.cz < depth[idx]) {
        depth[idx] = p.cz;
        buf32[idx] = c;
      }
    }
  }
}

// ─── Clear / present ────────────────────────────────────────────────────────
function _clearSolid(rd, color) {
  rd.buf32.fill(color);
  rd.depth.fill(Infinity);
}

function _present(rd) {
  rd.ctx.putImageData(rd.image, 0, 0);
}

// ─── Bitmap font (4×5 monospace) ───────────────────────────────────────────
const _FONT = {
  "0": 0x69996, "1": 0x4c44e, "2": 0xe168f, "3": 0xe161e, "4": 0x99f11,
  "5": 0xf8e1e, "6": 0x68e96, "7": 0xf1244, "8": 0x69696, "9": 0x69716,
  "A": 0x69f99, "B": 0xe9e9e, "C": 0x78887, "D": 0xe999e, "E": 0xf8e8f,
  "F": 0xf8e88, "G": 0x78b97, "H": 0x99f99, "I": 0xe444e, "J": 0x722a4,
  "K": 0x9aca9, "L": 0x8888f, "M": 0x9ff99, "N": 0x9dfb9, "O": 0x69996,
  "P": 0xe9e88, "Q": 0x699b7, "R": 0xe9ea9, "S": 0x7861e, "T": 0xf4444,
  "U": 0x99996, "V": 0x99966, "W": 0x99ff9, "X": 0x96669, "Y": 0x99644,
  "Z": 0xf168f,
  " ": 0,
  ".": 0x00004, ",": 0x00048, "-": 0x00e00, ":": 0x04040,
  "+": 0x04e40, "/": 0x12480, "!": 0x44404, "?": 0xe1604,
};

function _drawText(rd, text, x, y, color = 0xffffffff, scale = 1) {
  text = String(text).toUpperCase();
  const { buf32 } = rd;
  const sw = rd.w, sh = rd.h;
  let cx = x | 0;
  for (let i = 0; i < text.length; i++) {
    const glyph = _FONT[text[i]] ?? 0;
    for (let gy = 0; gy < 5; gy++) {
      const row = (glyph >>> ((4 - gy) * 4)) & 0xf;
      for (let gx = 0; gx < 4; gx++) {
        const bit = (row >>> (3 - gx)) & 1;
        if (!bit) continue;
        for (let py = 0; py < scale; py++) {
          for (let px = 0; px < scale; px++) {
            const xx = cx + gx * scale + px;
            const yy = y + gy * scale + py;
            if (xx < 0 || xx >= sw || yy < 0 || yy >= sh) continue;
            buf32[yy * sw + xx] = color;
          }
        }
      }
    }
    cx += 5 * scale;
  }
}

function _drawRect(rd, x, y, w, h, color, fill = true) {
  const { buf32 } = rd;
  const sw = rd.w, sh = rd.h;
  const x0 = Math.max(0, x | 0);
  const y0 = Math.max(0, y | 0);
  const x1 = Math.min(sw, (x + w) | 0);
  const y1 = Math.min(sh, (y + h) | 0);
  if (fill) {
    for (let yy = y0; yy < y1; yy++) {
      const row = yy * sw;
      for (let xx = x0; xx < x1; xx++) buf32[row + xx] = color;
    }
  } else {
    for (let xx = x0; xx < x1; xx++) {
      buf32[y0 * sw + xx] = color;
      buf32[(y1 - 1) * sw + xx] = color;
    }
    for (let yy = y0; yy < y1; yy++) {
      buf32[yy * sw + x0] = color;
      buf32[yy * sw + x1 - 1] = color;
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// § bbmesh — Blockbench scene → triangle records
// ═══════════════════════════════════════════════════════════════════════════════

const _FACE_DEFS = {
  north: { verts: [0, 3, 5, 6], nx:  0, ny:  0, nz: -1 },
  south: { verts: [2, 1, 7, 4], nx:  0, ny:  0, nz:  1 },
  east:  { verts: [1, 2, 4, 7], nx:  1, ny:  0, nz:  0 },
  west:  { verts: [3, 0, 6, 5], nx: -1, ny:  0, nz:  0 },
  up:    { verts: [5, 6, 4, 7], nx:  0, ny:  1, nz:  0 },
  down:  { verts: [0, 1, 3, 2], nx:  0, ny: -1, nz:  0 },
};

const _FACE_SHADE = {
  up:    1.0,
  down:  0.50,
  north: 0.80,
  south: 0.60,
  east:  0.70,
  west:  0.85,
};

function _getPaletteColor(index) {
  try {
    if (typeof Blockbench !== "undefined" && Blockbench.ColorPalette) {
      const palette = Blockbench.ColorPalette;
      const color = palette[index] || palette[0];
      if (color && color.hex) {
        const hex = parseInt(color.hex.replace(/^#/, ""), 16);
        if (Number.isFinite(hex)) {
          const r = (hex >> 16) & 0xff;
          const g = (hex >> 8) & 0xff;
          const b = hex & 0xff;
          return _rgba(r, g, b);
        }
      }
    }
  } catch (_) {}
  const hue = (index * 137.508) % 360;
  return _hslToPacked(hue, 0.6, 0.55);
}

function _hslToPacked(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r, g, b;
  if (h < 60)       { r = c; g = x; b = 0; }
  else if (h < 120) { r = x; g = c; b = 0; }
  else if (h < 180) { r = 0; g = c; b = x; }
  else if (h < 240) { r = 0; g = x; b = c; }
  else if (h < 300) { r = x; g = 0; b = c; }
  else              { r = c; g = 0; b = x; }
  return _rgba(
    Math.round((r + m) * 255),
    Math.round((g + m) * 255),
    Math.round((b + m) * 255),
  );
}

function _getCubeWorldCorners(cube) {
  if (!cube.mesh || !cube.mesh.matrixWorld) return null;
  const m = cube.mesh.matrixWorld.elements;

  // Handle mesh type (e.g. from Doom importer) — extract from BufferGeometry
  if (cube.type === "mesh" && cube.mesh.geometry) {
    const geo = cube.mesh.geometry;
    const pos = geo.attributes.position;
    if (!pos) return null;
    const verts = [];
    for (let i = 0; i < pos.count; i++) {
      const lx = pos.getX(i), ly = pos.getY(i), lz = pos.getZ(i);
      const w = m[3]*lx + m[7]*ly + m[11]*lz + m[15];
      const invW = 1 / w;
      verts.push({
        x: (m[0]*lx + m[4]*ly + m[8]*lz + m[12]) * invW,
        y: (m[1]*lx + m[5]*ly + m[9]*lz + m[13]) * invW,
        z: (m[2]*lx + m[6]*ly + m[10]*lz + m[14]) * invW,
      });
    }
    cube._swVertBuf = verts;
    return verts.length > 0 ? verts : null;
  }

  // Standard cube — from/to bounding box
  const inf = cube.inflate || 0;
  const f = cube.from;
  const t = cube.to;
  const minX = Math.min(f[0], t[0]) - inf;
  const maxX = Math.max(f[0], t[0]) + inf;
  const minY = Math.min(f[1], t[1]) - inf;
  const maxY = Math.max(f[1], t[1]) + inf;
  const minZ = Math.min(f[2], t[2]) - inf;
  const maxZ = Math.max(f[2], t[2]) + inf;
  const localVerts = [
    [minX, minY, minZ], [maxX, minY, minZ], [maxX, minY, maxZ], [minX, minY, maxZ],
    [maxX, maxY, minZ], [minX, maxY, minZ], [minX, maxY, maxZ], [maxX, maxY, maxZ],
  ];
  const worldVerts = new Array(8);
  for (let i = 0; i < 8; i++) {
    const [lx, ly, lz] = localVerts[i];
    const w = m[3] * lx + m[7] * ly + m[11] * lz + m[15];
    const invW = 1 / w;
    worldVerts[i] = {
      x: (m[0] * lx + m[4] * ly + m[8]  * lz + m[12]) * invW,
      y: (m[1] * lx + m[5] * ly + m[9]  * lz + m[13]) * invW,
      z: (m[2] * lx + m[6] * ly + m[10] * lz + m[14]) * invW,
    };
  }
  return worldVerts;
}

function _getWorldFaceNormal(cube, faceDef) {
  if (!cube.mesh || !cube.mesh.matrixWorld) return { nx: faceDef.nx, ny: faceDef.ny, nz: faceDef.nz };
  const m = cube.mesh.matrixWorld.elements;
  let nx = m[0] * faceDef.nx + m[4] * faceDef.ny + m[8]  * faceDef.nz;
  let ny = m[1] * faceDef.nx + m[5] * faceDef.ny + m[9]  * faceDef.nz;
  let nz = m[2] * faceDef.nx + m[6] * faceDef.ny + m[10] * faceDef.nz;
  const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (len > 1e-8) { nx /= len; ny /= len; nz /= len; }
  return { nx, ny, nz };
}

function _getFaceCenter(corners, vertIndices) {
  let cx = 0, cy = 0, cz = 0;
  for (const vi of vertIndices) {
    cx += corners[vi].x;
    cy += corners[vi].y;
    cz += corners[vi].z;
  }
  const n = vertIndices.length;
  return { x: cx / n, y: cy / n, z: cz / n };
}

function _extractCamera(previewCamera) {
  const pos = previewCamera.position;
  const fwd = new THREE.Vector3(0, 0, -1);
  fwd.applyQuaternion(previewCamera.quaternion);
  const yaw = Math.atan2(-fwd.x, -fwd.z) * (180 / Math.PI);
  const pitch = Math.asin(Math.max(-1, Math.min(1, fwd.y))) * (180 / Math.PI);
  const bbFov = previewCamera.fov || 50;
  const fovMul = bbFov / 50;
  return { x: pos.x, y: pos.y, z: pos.z, yaw, pitch, fovMul };
}

function _buildSceneTris(camera) {
  const tris = [];
  const cubes = [];
  if (typeof Outliner === "undefined" || !Outliner.elements) {
    return tris;
  }
  _walkOutliner(Outliner.elements, cubes);
  let skippedNoMesh = 0, skippedNoMW = 0, cubeCount = 0, meshCount = 0;
  for (const cube of cubes) {
    if (!cube.mesh) { skippedNoMesh++; continue; }
    if (!cube.mesh.matrixWorld) { skippedNoMW++; continue; }
    // Billboards handle their own geometry extraction — skip corners for them
    let corners = null;
    if (cube.type !== "billboard") {
      corners = _getCubeWorldCorners(cube);
      if (!corners) continue;
    }

    // Mesh type — extract triangles from geometry
    if (cube.type === "mesh" && cube.mesh && cube.mesh.geometry) {
      meshCount++;
      const geo = cube.mesh.geometry;
      const meshColor = _getPaletteColor(cube.color || 0x808080);
      const verts = cube._swVertBuf || corners;
      const idx = geo.index;
      const triColor = (0xff << 24) | (meshColor & 0x00ffffff);
      const uvAttr = geo.attributes.uv;
      const meshTex = _getMeshTexture(cube);
      if (idx) {
        for (let i = 0; i < idx.count; i += 3) {
          const a = idx.getX(i), b = idx.getX(i+1), c = idx.getX(i+2);
          if (!verts[a] || !verts[b] || !verts[c]) continue;
          const pa = { ...verts[a] }, pb = { ...verts[b] }, pc = { ...verts[c] };
          if (uvAttr) {
            pa.u = uvAttr.getX(a); pa.v = 1.0 - uvAttr.getY(a);
            pb.u = uvAttr.getX(b); pb.v = 1.0 - uvAttr.getY(b);
            pc.u = uvAttr.getX(c); pc.v = 1.0 - uvAttr.getY(c);
          }
          for (const tri of _buildFace([pa, pb, pc], triColor, camera, meshTex)) {
            tris.push(tri);
          }
        }
      } else {
        for (let i = 0; i + 2 < verts.length; i += 3) {
          const vi = i, vj = i + 1, vk = i + 2;
          const pa = { ...verts[vi] }, pb = { ...verts[vj] }, pc = { ...verts[vk] };
          if (uvAttr) {
            pa.u = uvAttr.getX(vi); pa.v = 1.0 - uvAttr.getY(vi);
            pb.u = uvAttr.getX(vj); pb.v = 1.0 - uvAttr.getY(vj);
            pc.u = uvAttr.getX(vk); pc.v = 1.0 - uvAttr.getY(vk);
          }
          for (const tri of _buildFace([pa, pb, pc], triColor, camera, meshTex)) {
            tris.push(tri);
          }
        }
      }
      continue;
    }

    // Billboard type — single camera-facing quad
    if (cube.type === "billboard") {
      const bbMesh = cube.mesh;
      if (!bbMesh || !bbMesh.geometry) continue;
      const bbM = (bbMesh.matrixWorld || bbMesh.matrix).elements;
      const posAttr = bbMesh.geometry.attributes.position;
      const uvAttr = bbMesh.geometry.attributes.uv;
      if (!posAttr) continue;
      const bbColor = (0xff << 24) | (_getPaletteColor(cube.color || 0) & 0x00ffffff);
      const bbTex = _getMeshTexture(cube);
      const bbPts = [];
      for (let i = 0; i < posAttr.count; i++) {
        const lx = posAttr.getX(i), ly = posAttr.getY(i), lz = posAttr.getZ(i);
        const w = bbM[3]*lx + bbM[7]*ly + bbM[11]*lz + bbM[15];
        const invW = 1 / w;
        const pt = {
          x: (bbM[0]*lx + bbM[4]*ly + bbM[8]*lz + bbM[12]) * invW,
          y: (bbM[1]*lx + bbM[5]*ly + bbM[9]*lz + bbM[13]) * invW,
          z: (bbM[2]*lx + bbM[6]*ly + bbM[10]*lz + bbM[14]) * invW,
        };
        if (uvAttr && i < uvAttr.count) {
          pt.u = uvAttr.getX(i);
          pt.v = 1.0 - uvAttr.getY(i);
        }
        bbPts.push(pt);
      }
      if (bbPts.length >= 3) {
        for (const tri of _buildFace([bbPts[0], bbPts[1], bbPts[2]], bbColor, camera, bbTex)) tris.push(tri);
      }
      if (bbPts.length >= 4) {
        for (const tri of _buildFace([bbPts[2], bbPts[1], bbPts[3]], bbColor, camera, bbTex)) tris.push(tri);
      }
      continue;
    }

    // Cube type — face-based rendering
    cubeCount++;
    const cubeColor = _getPaletteColor(cube.color || 0);
    for (const [faceName, faceDef] of Object.entries(_FACE_DEFS)) {
      const face = cube.faces ? cube.faces[faceName] : null;
      if (face && face.visible === false) continue;
      let faceColor = cubeColor;
      if (face && Number.isFinite(face.color)) {
        faceColor = _getPaletteColor(face.color);
      }
      if (face && Number.isFinite(face.tint)) {
        faceColor = _getPaletteColor(face.tint);
      }
      const center = _getFaceCenter(corners, faceDef.verts);
      const worldNormal = _getWorldFaceNormal(cube, faceDef);
      const toCamX = camera.x - center.x;
      const toCamY = camera.y - center.y;
      const toCamZ = camera.z - center.z;
      const dot = toCamX * worldNormal.nx + toCamY * worldNormal.ny + toCamZ * worldNormal.nz;
      if (dot <= 0) continue;
      let shadedColor;
      if (cube.shade !== false) {
        shadedColor = _shadeFace(faceColor, _FACE_SHADE[faceName]);
      } else {
        shadedColor = (0xff << 24) | (faceColor & 0x00ffffff);
      }
      const faceTex = _getFaceTexture(cube, faceName);
      const pts = faceDef.verts.map(i => corners[i]);
      if (face && face.uv && faceTex) {
        const uv = face.uv;
        const tw = faceTex.width || 16;
        const th = faceTex.height || 16;
        const u1 = uv[0] / tw, v1 = uv[1] / th;
        const u2 = uv[2] / tw, v2 = uv[3] / th;
        pts[0].u = u1; pts[0].v = v1;
        pts[1].u = u2; pts[1].v = v1;
        pts[2].u = u2; pts[2].v = v2;
        pts[3].u = u1; pts[3].v = v2;
      }
      for (const tri of _buildFace(pts, shadedColor, camera, faceTex)) {
        tris.push(tri);
      }
    }
  }
  return tris;
}

function _walkOutliner(elements, out) {
  if (!elements) return;
  for (const el of elements) {
    if (el.type === "cube") {
      if (el.visibility !== false) out.push(el);
    } else if (el.type === "mesh") {
      if (el.visibility !== false) out.push(el);
    } else if (el.type === "billboard") {
      if (el.visibility !== false) out.push(el);
    } else if (el.children) {
      _walkOutliner(el.children, out);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// § Plugin entry — Blockbench registration
// ═══════════════════════════════════════════════════════════════════════════════

let swEnabled = false;
let swRenderer = null;
let swCanvas = null;
let renderWidth = 640;
let renderHeight = 400;
let frame = 0;
let _patched = false;
let _origRender = null;
let toggleAction = null;
let eventHandlers = [];
let _recRenderCanvas = null;
let _recRenderRd = null;

// ─── Custom camera controls ──────────────────────────────────────────────
const _cam = {
  target: { x: 0, y: 16, z: 0 },
  distance: 80,
  yaw: 0,
  pitch: -30,
  fov: 50,
  moveSpeed: 40,
  rotSpeed: 0.3,
  panSpeed: 0.5,
  zoomSpeed: 0.1,
  _keys: {},
  _dragging: false,
  _button: -1,
  _mx: 0,
  _my: 0,
};

function _camInitFromPreview(preview) {
  if (!preview || !preview.camera) return;
  const cam = preview.camera;
  const pos = cam.position;
  const fwd = new THREE.Vector3(0, 0, -1);
  fwd.applyQuaternion(cam.quaternion);
  _cam.yaw = Math.atan2(-fwd.x, -fwd.z) * (180 / Math.PI);
  _cam.pitch = Math.asin(Math.max(-1, Math.min(1, fwd.y))) * (180 / Math.PI);
  _cam.fov = cam.fov || 50;
  _cam.distance = 80;
  _cam.target.x = pos.x + fwd.x * _cam.distance;
  _cam.target.y = pos.y + fwd.y * _cam.distance;
  _cam.target.z = pos.z + fwd.z * _cam.distance;
}

function _camApplyToPreview(preview) {
  if (!preview || !preview.camera) return;
  const cam = preview.camera;
  const yr = _cam.yaw * Math.PI / 180;
  const pr = _cam.pitch * Math.PI / 180;
  const cp = Math.cos(pr);
  cam.position.set(
    _cam.target.x + _cam.distance * Math.sin(yr) * cp,
    _cam.target.y - _cam.distance * Math.sin(pr),
    _cam.target.z + _cam.distance * Math.cos(yr) * cp,
  );
  const dx = _cam.target.x - cam.position.x;
  const dy = _cam.target.y - cam.position.y;
  const dz = _cam.target.z - cam.position.z;
  if (dx * dx + dy * dy + dz * dz > 0.001) {
    cam.lookAt(_cam.target.x, _cam.target.y, _cam.target.z);
  }
  cam.fov = _cam.fov;
  cam.updateProjectionMatrix();
}

function _camTick(dt) {
  const k = _cam._keys;
  const yr = _cam.yaw * Math.PI / 180;
  const speed = _cam.moveSpeed * dt * (_cam.distance / 80);
  const fwdX = -Math.sin(yr);
  const fwdZ = -Math.cos(yr);
  const rightX = Math.cos(yr);
  const rightZ = -Math.sin(yr);
  if (k["w"] || k["arrowup"])    { _cam.target.x += fwdX * speed; _cam.target.z += fwdZ * speed; }
  if (k["s"] || k["arrowdown"])  { _cam.target.x -= fwdX * speed; _cam.target.z -= fwdZ * speed; }
  if (k["a"] || k["arrowleft"])  { _cam.target.x -= rightX * speed; _cam.target.z -= rightZ * speed; }
  if (k["d"] || k["arrowright"]) { _cam.target.x += rightX * speed; _cam.target.z += rightZ * speed; }
  if (k["r"]) { _cam.target.y += speed; }
  if (k["f"]) { _cam.target.y -= speed; }
}

function _onMouseDown(e) {
  if (!swEnabled) return;
  if (e.target !== swCanvas) return;
  if (e.button === 0 || e.button === 2) {
    _cam._dragging = true;
    _cam._button = e.button;
    _cam._mx = e.clientX;
    _cam._my = e.clientY;
    e.preventDefault();
  }
}

function _onMouseMove(e) {
  if (!swEnabled || !_cam._dragging) return;
  const dx = e.clientX - _cam._mx;
  const dy = e.clientY - _cam._my;
  _cam._mx = e.clientX;
  _cam._my = e.clientY;
  // Skip orbit when in a transform mode (move/rotate/scale) with selection
  if (_cam._button === 0 && _edit.mode !== "orbit" && _edit.selected) return;
  if (_cam._button === 0) {
    _cam.yaw -= dx * _cam.rotSpeed;
    _cam.pitch += dy * _cam.rotSpeed;
    _cam.pitch = Math.max(-89, Math.min(89, _cam.pitch));
    e.preventDefault();
  } else if (_cam._button === 2) {
    const yr = _cam.yaw * Math.PI / 180;
    const pr = _cam.pitch * Math.PI / 180;
    const rightX = Math.cos(yr);
    const rightZ = -Math.sin(yr);
    const upY = 1;
    const panFactor = _cam.distance * _cam.panSpeed * 0.002;
    _cam.target.x -= (rightX * dx) * panFactor;
    _cam.target.z -= (rightZ * dx) * panFactor;
    _cam.target.y += dy * panFactor;
    e.preventDefault();
  }
}

function _onMouseUp(e) {
  if (e.button === _cam._button) {
    _cam._dragging = false;
    _cam._button = -1;
    _edit._dragStart = null;
  }
}

function _onWheel(e) {
  if (!swEnabled) return;
  if (e.target !== swCanvas) return;
  const delta = e.deltaY > 0 ? 1.1 : 0.9;
  _cam.distance *= delta;
  _cam.distance = Math.max(1, Math.min(2000, _cam.distance));
  e.preventDefault();
}

function _onKeyDown(e) {
  if (!swEnabled) return;
  const key = e.key.toLowerCase();
  if (["w","a","s","d","r","f","arrowup","arrowdown","arrowleft","arrowright"].includes(key)) {
    _cam._keys[key] = true;
    e.preventDefault();
  }
}

function _onKeyUp(e) {
  const key = e.key.toLowerCase();
  _cam._keys[key] = false;
}

function _onContextMenu(e) {
  if (swEnabled && e.target === swCanvas) e.preventDefault();
}

let _camListenersAttached = false;
let _lastCamTick = 0;

function _attachCamListeners() {
  if (_camListenersAttached) return;
  _camListenersAttached = true;
  document.addEventListener("mousedown", _onMouseDown, true);
  document.addEventListener("mousemove", _onMouseMove, true);
  document.addEventListener("mouseup", _onMouseUp, true);
  document.addEventListener("wheel", _onWheel, { passive: false, capture: true });
  document.addEventListener("keydown", _onKeyDown, true);
  document.addEventListener("keydown", _onKeyDownEdit, true);
  document.addEventListener("keyup", _onKeyUp, true);
  document.addEventListener("contextmenu", _onContextMenu, true);
  _attachEditListeners();
}

function _detachCamListeners() {
  if (!_camListenersAttached) return;
  _camListenersAttached = false;
  document.removeEventListener("mousedown", _onMouseDown, true);
  document.removeEventListener("mousemove", _onMouseMove, true);
  document.removeEventListener("mouseup", _onMouseUp, true);
  document.removeEventListener("wheel", _onWheel, true);
  document.removeEventListener("keydown", _onKeyDown, true);
  document.removeEventListener("keydown", _onKeyDownEdit, true);
  document.removeEventListener("keyup", _onKeyUp, true);
  document.removeEventListener("contextmenu", _onContextMenu, true);
  _cam._keys = {};
  _detachEditListeners();
}

// ═══════════════════════════════════════════════════════════════════════════════
// § editing — Software raycasting, selection, transforms, keyboard shortcuts
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Transform state ────────────────────────────────────────────────────────
const _edit = {
  mode: "orbit",       // "orbit" | "move" | "rotate" | "scale"
  selected: null,      // Blockbench element (cube/group from Outliner)
  _mouseDownPos: null, // {x,y} at mousedown for click-vs-drag detection
  _dragStart: null,    // {x,y} at drag start
  _undoSnapshot: null, // snapshot before current transform drag
  _dragged: false,     // true once a transform drag actually moved
};

const _undoStack = [];
const _redoStack = [];
const _HISTORY_MAX = 50;

// ─── Software raycasting ────────────────────────────────────────────────────
function _swUnproject(sx, sy, camera) {
  // Screen pixel → world-space ray origin + direction
  const ndcX = (sx - _HALF_W) / _HALF_W;
  const ndcY = (_HALF_H - sy) / _HALF_H;
  const fovMul = camera.fovMul || 1.0;
  // Camera-space ray direction at unit depth
  let dx = ndcX / (_FOCAL_X * fovMul);
  let dy = ndcY / (_FOCAL_Y * fovMul);
  let dz = -1;
  // Inverse pitch rotation (rotate by -pitch around X)
  const pr = camera.pitch * Math.PI / 180;
  const cp = Math.cos(pr), sp = Math.sin(pr);
  const dy2 = cp * dy - sp * dz;
  const dz2 = sp * dy + cp * dz;
  dy = dy2; dz = dz2;
  // Inverse yaw rotation (rotate by +yaw around Y)
  const yr = camera.yaw * Math.PI / 180;
  const cy = Math.cos(yr), sy2 = Math.sin(yr);
  const dx2 = cy * dx + sy2 * dz;
  const dz3 = -sy2 * dx + cy * dz;
  dx = dx2; dz = dz3;
  // Normalize
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (len > 1e-10) { dx /= len; dy /= len; dz /= len; }
  return { ox: camera.x, oy: camera.y, oz: camera.z, dx, dy, dz };
}

function _swRayAABB(ox, oy, oz, dx, dy, dz, minX, minY, minZ, maxX, maxY, maxZ) {
  // Slab method — returns distance t or Infinity
  let tmin = -Infinity, tmax = Infinity;
  if (Math.abs(dx) > 1e-12) {
    let t1 = (minX - ox) / dx, t2 = (maxX - ox) / dx;
    if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
    tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2);
  } else if (ox < minX || ox > maxX) return Infinity;
  if (Math.abs(dy) > 1e-12) {
    let t1 = (minY - oy) / dy, t2 = (maxY - oy) / dy;
    if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
    tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2);
  } else if (oy < minY || oy > maxY) return Infinity;
  if (Math.abs(dz) > 1e-12) {
    let t1 = (minZ - oz) / dz, t2 = (maxZ - oz) / dz;
    if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
    tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2);
  } else if (oz < minZ || oz > maxZ) return Infinity;
  if (tmin > tmax || tmax < 0) return Infinity;
  return tmin >= 0 ? tmin : tmax;
}

function _swGetWorldAABB(elem) {
  if (!elem || !elem.mesh || !elem.mesh.matrixWorld) return null;
  const m = elem.mesh.matrixWorld.elements;
  // Standard cube: from/to
  if (elem.type !== "mesh" && elem.type !== "billboard" && elem.from && elem.to) {
    const inf = elem.inflate || 0;
    const f = elem.from, t = elem.to;
    const lx = [Math.min(f[0], t[0]) - inf, Math.max(f[0], t[0]) + inf];
    const ly = [Math.min(f[1], t[1]) - inf, Math.max(f[1], t[1]) + inf];
    const lz = [Math.min(f[2], t[2]) - inf, Math.max(f[2], t[2]) + inf];
    let wminX = Infinity, wminY = Infinity, wminZ = Infinity;
    let wmaxX = -Infinity, wmaxY = -Infinity, wmaxZ = -Infinity;
    for (let xi = 0; xi < 2; xi++) {
      for (let yi = 0; yi < 2; yi++) {
        for (let zi = 0; zi < 2; zi++) {
          const lxv = lx[xi], lyv = ly[yi], lzv = lz[zi];
          const w = m[3]*lxv + m[7]*lyv + m[11]*lzv + m[15];
          const invW = 1 / w;
          const wx = (m[0]*lxv + m[4]*lyv + m[8]*lzv + m[12]) * invW;
          const wy = (m[1]*lxv + m[5]*lyv + m[9]*lzv + m[13]) * invW;
          const wz = (m[2]*lxv + m[6]*lyv + m[10]*lzv + m[14]) * invW;
          if (wx < wminX) wminX = wx; if (wx > wmaxX) wmaxX = wx;
          if (wy < wminY) wminY = wy; if (wy > wmaxY) wmaxY = wy;
          if (wz < wminZ) wminZ = wz; if (wz > wmaxZ) wmaxZ = wz;
        }
      }
    }
    return { minX: wminX, minY: wminY, minZ: wminZ, maxX: wmaxX, maxY: wmaxY, maxZ: wmaxZ };
  }
  // Mesh type or fallback: use geometry.boundingBox
  if (elem.mesh.geometry) {
    const geo = elem.mesh.geometry;
    if (!geo.boundingBox) geo.computeBoundingBox();
    const bb = geo.boundingBox;
    if (!bb) return null;
    const corners = [
      [bb.min.x, bb.min.y, bb.min.z], [bb.max.x, bb.min.y, bb.min.z],
      [bb.max.x, bb.max.y, bb.min.z], [bb.min.x, bb.max.y, bb.min.z],
      [bb.min.x, bb.min.y, bb.max.z], [bb.max.x, bb.min.y, bb.max.z],
      [bb.max.x, bb.max.y, bb.max.z], [bb.min.x, bb.max.y, bb.max.z],
    ];
    let wminX = Infinity, wminY = Infinity, wminZ = Infinity;
    let wmaxX = -Infinity, wmaxY = -Infinity, wmaxZ = -Infinity;
    for (const c of corners) {
      const w = m[3]*c[0] + m[7]*c[1] + m[11]*c[2] + m[15];
      const invW = 1 / w;
      const wx = (m[0]*c[0] + m[4]*c[1] + m[8]*c[2] + m[12]) * invW;
      const wy = (m[1]*c[0] + m[5]*c[1] + m[9]*c[2] + m[13]) * invW;
      const wz = (m[2]*c[0] + m[6]*c[1] + m[10]*c[2] + m[14]) * invW;
      if (wx < wminX) wminX = wx; if (wx > wmaxX) wmaxX = wx;
      if (wy < wminY) wminY = wy; if (wy > wmaxY) wmaxY = wy;
      if (wz < wminZ) wminZ = wz; if (wz > wmaxZ) wmaxZ = wz;
    }
    return { minX: wminX, minY: wminY, minZ: wminZ, maxX: wmaxX, maxY: wmaxY, maxZ: wmaxZ };
  }
  return null;
}

function _swRaycast(screenX, screenY) {
  if (typeof Outliner === "undefined" || !Outliner.elements) return null;
  const preview = Preview.selected;
  if (!preview || !preview.camera) return null;
  const camera = _extractCamera(preview.camera);
  const ray = _swUnproject(screenX, screenY, camera);
  let bestDist = Infinity, bestElem = null;
  const elems = Outliner.elements;
  for (let i = 0; i < elems.length; i++) {
    const elem = elems[i];
    if (!elem.mesh || !elem.mesh.visible) continue;
    const bb = _swGetWorldAABB(elem);
    if (!bb) continue;
    const t = _swRayAABB(ray.ox, ray.oy, ray.oz, ray.dx, ray.dy, ray.dz,
                          bb.minX, bb.minY, bb.minZ, bb.maxX, bb.maxY, bb.maxZ);
    if (t < bestDist) { bestDist = t; bestElem = elem; }
  }
  return bestElem;
}

// ─── Selection ──────────────────────────────────────────────────────────────
function _swSelect(elem) {
  _edit.selected = elem;
  // Sync with Blockbench selection
  if (elem && typeof Selected !== "undefined") {
    Selected.length = 0;
    Selected.push(elem);
    if (typeof Canvas !== "undefined") Canvas.updateView({ selection: true });
    if (typeof Outliner !== "undefined") Outliner.updateSelection();
  }
  _safeUpdateView();
}

function _swDeselect() {
  _edit.selected = null;
  if (typeof Selected !== "undefined") {
    Selected.length = 0;
    if (typeof Canvas !== "undefined") Canvas.updateView({ selection: true });
    if (typeof Outliner !== "undefined") Outliner.updateSelection();
  }
  _safeUpdateView();
}

function _swGetElemCenter(elem) {
  if (!elem) return null;
  // Standard cube: center of from/to
  if (elem.from && elem.to) {
    return {
      x: (elem.from[0] + elem.to[0]) / 2,
      y: (elem.from[1] + elem.to[1]) / 2,
      z: (elem.from[2] + elem.to[2]) / 2,
    };
  }
  // Mesh/billboard: center of geometry bounding box
  if (elem.mesh && elem.mesh.geometry) {
    const geo = elem.mesh.geometry;
    if (!geo.boundingBox) geo.computeBoundingBox();
    const bb = geo.boundingBox;
    if (bb) {
      const m = elem.mesh.matrixWorld.elements;
      const lx = (bb.min.x + bb.max.x) / 2;
      const ly = (bb.min.y + bb.max.y) / 2;
      const lz = (bb.min.z + bb.max.z) / 2;
      const w = m[3]*lx + m[7]*ly + m[11]*lz + m[15];
      const invW = 1 / w;
      return {
        x: (m[0]*lx + m[4]*ly + m[8]*lz + m[12]) * invW,
        y: (m[1]*lx + m[5]*ly + m[9]*lz + m[13]) * invW,
        z: (m[2]*lx + m[6]*ly + m[10]*lz + m[14]) * invW,
      };
    }
  }
  // Fallback: origin
  return { x: 0, y: 0, z: 0 };
}

function _swSnapshotTransform(elem) {
  if (!elem) return null;
  return {
    uuid: elem.uuid,
    from: elem.from ? elem.from.slice() : null,
    to: elem.to ? elem.to.slice() : null,
    origin: elem.origin ? elem.origin.slice() : null,
    rotation: elem.rotation ? elem.rotation.slice() : null,
    position: elem.position ? elem.position.slice() : null,
    scale: elem.scale ? elem.scale.slice() : null,
  };
}

function _swRestoreTransform(elem, snap) {
  if (!elem || !snap) return;
  if (snap.from && elem.from) { elem.from[0] = snap.from[0]; elem.from[1] = snap.from[1]; elem.from[2] = snap.from[2]; }
  if (snap.to && elem.to) { elem.to[0] = snap.to[0]; elem.to[1] = snap.to[1]; elem.to[2] = snap.to[2]; }
  if (snap.origin && elem.origin) { elem.origin[0] = snap.origin[0]; elem.origin[1] = snap.origin[1]; elem.origin[2] = snap.origin[2]; }
  if (snap.rotation && elem.rotation) { elem.rotation[0] = snap.rotation[0]; elem.rotation[1] = snap.rotation[1]; elem.rotation[2] = snap.rotation[2]; }
  if (snap.position && elem.position) { elem.position[0] = snap.position[0]; elem.position[1] = snap.position[1]; elem.position[2] = snap.position[2]; }
  if (snap.scale && elem.scale) { elem.scale[0] = snap.scale[0]; elem.scale[1] = snap.scale[1]; elem.scale[2] = snap.scale[2]; }
  if (elem.mesh) elem.mesh.updateMatrixWorld(true);
  _safeUpdateView();
}

function _swPushBBUndo() {
  if (typeof Undo === "undefined") return;
  try {
    if (typeof Undo.save === "function") Undo.save("edit");
    else if (typeof Undo.push === "function") Undo.push("edit");
  } catch (_) {}
}

function _swFindElemByUuid(uuid) {
  if (typeof Outliner !== "undefined" && Outliner.elements) {
    for (let i = 0; i < Outliner.elements.length; i++) {
      if (Outliner.elements[i].uuid === uuid) return Outliner.elements[i];
    }
  }
  return null;
}

function _swUndo() {
  if (_undoStack.length === 0) return;
  const snap = _undoStack.pop();
  const elem = _swFindElemByUuid(snap.uuid);
  if (!elem) return;
  _redoStack.push(_swSnapshotTransform(elem));
  if (_redoStack.length > _HISTORY_MAX) _redoStack.shift();
  _swRestoreTransform(elem, snap);
  console.log("[bbsw] UNDO uuid=" + snap.uuid);
}

function _swRedo() {
  if (_redoStack.length === 0) return;
  const snap = _redoStack.pop();
  const elem = _swFindElemByUuid(snap.uuid);
  if (!elem) return;
  _undoStack.push(_swSnapshotTransform(elem));
  if (_undoStack.length > _HISTORY_MAX) _undoStack.shift();
  _swRestoreTransform(elem, snap);
  console.log("[bbsw] REDO uuid=" + snap.uuid);
}

// ─── Transform drag logic ───────────────────────────────────────────────────
function _swProjectWorldToScreen(wx, wy, wz, camera) {
  const cs = _toCameraSpace({ x: wx, y: wy, z: wz }, camera);
  const fovMul = camera.fovMul || 1.0;
  if (cs.cz < _NEAR_Z) return null;
  const sx = _HALF_W + cs.cx * _scaleAtX(cs.cz) * fovMul;
  const sy = _HALF_H - cs.cy * _scaleAtY(cs.cz) * fovMul;
  return { sx, sy, depth: cs.cz };
}

function _swScreenToWorldScale(camera, depth) {
  const fovMul = camera.fovMul || 1.0;
  return depth / (_FOCAL_Y * fovMul) * 2;
}

function _swTransformDrag(screenDX, screenDY) {
  const elem = _edit.selected;
  if (!elem) return;
  const yr = _cam.yaw * Math.PI / 180;
  const pr = _cam.pitch * Math.PI / 180;
  const cp0 = Math.cos(pr);
  const camPos = {
    x: _cam.target.x + _cam.distance * Math.sin(yr) * cp0,
    y: _cam.target.y - _cam.distance * Math.sin(pr),
    z: _cam.target.z + _cam.distance * Math.cos(yr) * cp0,
  };

  if (_edit.mode === "move") {
    const cp = Math.cos(pr), sp = Math.sin(pr);
    const cy = Math.cos(yr), sy = Math.sin(yr);
    const rightX = cy, rightZ = -sy;
    const upX = sy * sp, upY = cp, upZ = cy * sp;
    const center = _swGetElemCenter(elem);
    const dist = center ? Math.sqrt(
      (center.x - camPos.x) ** 2 + (center.y - camPos.y) ** 2 + (center.z - camPos.z) ** 2
    ) : 50;
    const fovMul = (_cam.fov || 50) / 50;
    const scale = dist / (_FOCAL_Y * fovMul) * 2;
    const worldDX = (rightX * screenDX - upX * screenDY) * scale;
    const worldDY = -(upY * screenDY) * scale;
    const worldDZ = (rightZ * screenDX - upZ * screenDY) * scale;
    if (elem.from && elem.to) {
      elem.from[0] += worldDX; elem.from[1] += worldDY; elem.from[2] += worldDZ;
      elem.to[0] += worldDX; elem.to[1] += worldDY; elem.to[2] += worldDZ;
      if (elem.origin) { elem.origin[0] += worldDX; elem.origin[1] += worldDY; elem.origin[2] += worldDZ; }
    }
    if (elem.position) {
      elem.position[0] += worldDX; elem.position[1] += worldDY; elem.position[2] += worldDZ;
    }
    if (elem.mesh) elem.mesh.updateMatrixWorld(true);
    if (typeof Canvas !== "undefined" && Canvas.updateView) {
      try { Canvas.updateView({ elements: [elem] }); } catch (_) {}
    }
  } else if (_edit.mode === "rotate") {
    if (elem.rotation) {
      elem.rotation[1] += screenDX * 0.5;
      elem.rotation[0] += screenDY * 0.3;
    }
    if (elem.mesh) elem.mesh.updateMatrixWorld(true);
    if (typeof Canvas !== "undefined" && Canvas.updateView) {
      try { Canvas.updateView({ elements: [elem] }); } catch (_) {}
    }
  } else if (_edit.mode === "scale") {
    const factor = 1.0 + screenDY * -0.005;
    if (elem.from && elem.to) {
      const cx = (elem.from[0] + elem.to[0]) / 2;
      const cy = (elem.from[1] + elem.to[1]) / 2;
      const cz = (elem.from[2] + elem.to[2]) / 2;
      const hw = (elem.to[0] - elem.from[0]) / 2 * factor;
      const hh = (elem.to[1] - elem.from[1]) / 2 * factor;
      const hd = (elem.to[2] - elem.from[2]) / 2 * factor;
      elem.from[0] = cx - hw; elem.from[1] = cy - hh; elem.from[2] = cz - hd;
      elem.to[0] = cx + hw; elem.to[1] = cy + hh; elem.to[2] = cz + hd;
    }
    if (elem.scale) {
      elem.scale[0] *= factor; elem.scale[1] *= factor; elem.scale[2] *= factor;
    }
    if (elem.mesh) elem.mesh.updateMatrixWorld(true);
    if (typeof Canvas !== "undefined" && Canvas.updateView) {
      try { Canvas.updateView({ elements: [elem] }); } catch (_) {}
    }
  }
}

// ─── Selection outline drawing ──────────────────────────────────────────────
function _swDrawLine(rd, x0, y0, x1, y1, color) {
  const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;
  const { buf32, w: rw, h: rh } = rd;
  for (let i = 0; i < 2000; i++) {
    if (x0 >= 0 && x0 < rw && y0 >= 0 && y0 < rh) buf32[y0 * rw + x0] = color;
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x0 += sx; }
    if (e2 < dx) { err += dx; y0 += sy; }
  }
}

function _swDrawSelectionOutline(rd, camera) {
  const elem = _edit.selected;
  if (!elem) return;
  const bb = _swGetWorldAABB(elem);
  if (!bb) return;
  const corners = [
    [bb.minX, bb.minY, bb.minZ], [bb.maxX, bb.minY, bb.minZ],
    [bb.maxX, bb.maxY, bb.minZ], [bb.minX, bb.maxY, bb.minZ],
    [bb.minX, bb.minY, bb.maxZ], [bb.maxX, bb.minY, bb.maxZ],
    [bb.maxX, bb.maxY, bb.maxZ], [bb.minX, bb.maxY, bb.maxZ],
  ];
  const edges = [
    [0,1],[1,2],[2,3],[3,0],
    [4,5],[5,6],[6,7],[7,4],
    [0,4],[1,5],[2,6],[3,7],
  ];
  const selColor = _rgba(80, 255, 80);
  for (const [a, b] of edges) {
    const pa = _swProjectWorldToScreen(corners[a][0], corners[a][1], corners[a][2], camera);
    const pb = _swProjectWorldToScreen(corners[b][0], corners[b][1], corners[b][2], camera);
    if (pa && pb && pa.depth > _NEAR_Z && pb.depth > _NEAR_Z) {
      _swDrawLine(rd, pa.sx | 0, pa.sy | 0, pb.sx | 0, pb.sy | 0, selColor);
    }
  }
}

// ─── Transform gizmo drawing ────────────────────────────────────────────────
function _swDrawGizmo(rd, camera) {
  if (!_edit.selected || _edit.mode === "orbit") return;
  const center = _swGetElemCenter(_edit.selected);
  if (!center) return;
  const cp = _swProjectWorldToScreen(center.x, center.y, center.z, camera);
  if (!cp || cp.depth < _NEAR_Z) return;
  const scale = _swScreenToWorldScale(camera, cp.depth);
  const gizmoLen = 3.0;
  const gizmoLenW = gizmoLen * scale;
  const yr = camera.yaw * Math.PI / 180;
  const pitchR = camera.pitch * Math.PI / 180;
  const cyaw = Math.cos(yr), syaw = Math.sin(yr);
  const cpitch = Math.cos(pitchR), spitch = Math.sin(pitchR);
  const rightX = cyaw, rightZ = -syaw;
  const upX = syaw * spitch, upY = cpitch, upZ = cyaw * spitch;
  const fwdX = -syaw * cpitch, fwdY = spitch, fwdZ = -cyaw * cpitch;

  if (_edit.mode === "move") {
    const redX = _rgba(255, 60, 60), greenY = _rgba(60, 255, 60), blueZ = _rgba(60, 120, 255);
    const axes = [
      { dx: gizmoLen, dy: 0, dz: 0, color: redX, label: "X" },
      { dx: 0, dy: gizmoLen, dz: 0, color: greenY, label: "Y" },
      { dx: 0, dy: 0, dz: gizmoLen, color: blueZ, label: "Z" },
    ];
    for (const ax of axes) {
      const end = _swProjectWorldToScreen(center.x + ax.dx, center.y + ax.dy, center.z + ax.dz, camera);
      if (!end || end.depth < _NEAR_Z) continue;
      _swDrawLine(rd, cp.sx | 0, cp.sy | 0, end.sx | 0, end.sy | 0, ax.color);
      _swDrawLine(rd, (end.sx - 2) | 0, (end.sy - 2) | 0, (end.sx + 2) | 0, (end.sy + 2) | 0, ax.color);
      _swDrawLine(rd, (end.sx - 2) | 0, (end.sy + 2) | 0, (end.sx + 2) | 0, (end.sy - 2) | 0, ax.color);
    }
  } else if (_edit.mode === "rotate") {
    const redX = _rgba(255, 80, 80), greenY = _rgba(80, 255, 80), blueZ = _rgba(80, 140, 255);
    const rings = [
      { color: redX, axis: "x" },
      { color: greenY, axis: "y" },
      { color: blueZ, axis: "z" },
    ];
    const segments = 24;
    const ringRadius = gizmoLen;
    for (const ring of rings) {
      let prevPt = null;
      for (let i = 0; i <= segments; i++) {
        const angle = (i / segments) * Math.PI * 2;
        const cosA = Math.cos(angle) * ringRadius;
        const sinA = Math.sin(angle) * ringRadius;
        let wx, wy, wz;
        if (ring.axis === "x") {
          wx = center.x;
          wy = center.y + cosA;
          wz = center.z + sinA;
        } else if (ring.axis === "y") {
          wx = center.x + cosA;
          wy = center.y;
          wz = center.z + sinA;
        } else {
          wx = center.x + cosA;
          wy = center.y + sinA;
          wz = center.z;
        }
        const pt = _swProjectWorldToScreen(wx, wy, wz, camera);
        if (pt && pt.depth > _NEAR_Z && prevPt && prevPt.depth > _NEAR_Z) {
          _swDrawLine(rd, prevPt.sx | 0, prevPt.sy | 0, pt.sx | 0, pt.sy | 0, ring.color);
        }
        prevPt = pt;
      }
    }
  } else if (_edit.mode === "scale") {
    const redX = _rgba(255, 100, 100), greenY = _rgba(100, 255, 100), blueZ = _rgba(100, 150, 255);
    const axes = [
      { dx: gizmoLen, dy: 0, dz: 0, color: redX },
      { dx: 0, dy: gizmoLen, dz: 0, color: greenY },
      { dx: 0, dy: 0, dz: gizmoLen, color: blueZ },
    ];
    for (const ax of axes) {
      const end = _swProjectWorldToScreen(center.x + ax.dx, center.y + ax.dy, center.z + ax.dz, camera);
      if (!end || end.depth < _NEAR_Z) continue;
      _swDrawLine(rd, cp.sx | 0, cp.sy | 0, end.sx | 0, end.sy | 0, ax.color);
      const bs = 3;
      _swDrawRect(rd, (end.sx - bs) | 0, (end.sy - bs) | 0, bs * 2, bs * 2, ax.color);
    }
  }
}

// ─── HUD improvements ───────────────────────────────────────────────────────
function _swDrawHUD(rd) {
  const sel = _edit.selected;
  const modeLabels = { orbit: "ORBIT", move: "MOVE [G]", rotate: "ROTATE [E]", scale: "SCALE [T]" };
  const label = modeLabels[_edit.mode] || "ORBIT";
  const modeColor = _edit.mode === "orbit" ? _rgba(180, 180, 200) :
                    _edit.mode === "move" ? _rgba(80, 200, 255) :
                    _edit.mode === "rotate" ? _rgba(255, 200, 80) :
                    _rgba(255, 100, 100);
  _drawRect(rd, 2, rd.h - 16, 92, 12, _rgba(0, 0, 0, 180));
  _drawText(rd, label, 4, rd.h - 14, modeColor);
  if (sel) {
    const name = sel.name || sel.uuid || "?";
    _drawRect(rd, 2, rd.h - 30, Math.min(name.length * 5 + 8, 200), 12, _rgba(0, 0, 0, 180));
    _drawText(rd, name, 4, rd.h - 28, _rgba(200, 255, 200));
  }
}

// ─── Modified mouse handlers (click-to-select + transform drag) ────────────
const _CLICK_THRESHOLD = 4; // pixels — below this is a click, not a drag

function _onMouseDownEdit(e) {
  if (!swEnabled) return;
  if (e.target !== swCanvas) return;
  if (e.button === 0) {
    _edit._mouseDownPos = { x: e.clientX, y: e.clientY };
    _edit._dragged = false;
    if (_edit.mode !== "orbit" && _edit.selected) {
      _edit._undoSnapshot = _swSnapshotTransform(_edit.selected);
    }
    console.log("[bbsw] mousedown mode=" + _edit.mode + " sel=" + (_edit.selected ? (_edit.selected.name || _edit.selected.uuid) : "none"));
  }
}

function _onMouseUpEdit(e) {
  if (!swEnabled) return;
  if (e.button !== 0 || !_edit._mouseDownPos) return;
  const dx = e.clientX - _edit._mouseDownPos.x;
  const dy = e.clientY - _edit._mouseDownPos.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  _edit._mouseDownPos = null;
  if (_edit._dragged && _edit._undoSnapshot) {
    _undoStack.push(_edit._undoSnapshot);
    if (_undoStack.length > _HISTORY_MAX) _undoStack.shift();
    _redoStack.length = 0;
    _edit._undoSnapshot = null;
    _edit._dragged = false;
  }
  if (dist < _CLICK_THRESHOLD && _edit.mode === "orbit") {
    const rect = swCanvas.getBoundingClientRect();
    const sx = ((e.clientX - rect.left) / rect.width) * _SCREEN_W;
    const sy = ((e.clientY - rect.top) / rect.height) * _SCREEN_H;
    const hit = _swRaycast(sx, sy);
    if (hit) {
      _swSelect(hit);
    } else {
      _swDeselect();
    }
  }
}

function _onMouseMoveEdit(e) {
  if (!swEnabled || !_cam._dragging || _cam._button !== 0) return;
  if (_edit.mode !== "orbit" && _edit.selected) {
    if (_edit._dragStart === null) {
      _edit._dragStart = { x: e.clientX, y: e.clientY };
      _edit._lastMoveX = e.clientX;
      _edit._lastMoveY = e.clientY;
      _edit._dragged = true;
      _swPushBBUndo();
      console.log("[bbsw] transform drag START mode=" + _edit.mode);
    }
    const dx = e.clientX - _edit._lastMoveX;
    const dy = e.clientY - _edit._lastMoveY;
    _edit._lastMoveX = e.clientX;
    _edit._lastMoveY = e.clientY;
    _swTransformDrag(dx, dy);
  }
}

// ─── Keyboard handler additions ─────────────────────────────────────────────
function _onKeyDownEdit(e) {
  if (!swEnabled) return;
  if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT" || e.target.tagName === "TEXTAREA") return;
  if (e.ctrlKey || e.metaKey) {
    if (e.key.toLowerCase() === "z" && !e.shiftKey) { _swUndo(); e.preventDefault(); return; }
    if (e.key.toLowerCase() === "z" && e.shiftKey) { _swRedo(); e.preventDefault(); return; }
    if (e.key.toLowerCase() === "y") { _swRedo(); e.preventDefault(); return; }
    return;
  }
  const key = e.key.toLowerCase();
  // G=move, E=rotate, T=scale (avoid W/R/F which conflict with camera WASD+RF)
  if (key === "g") { _edit.mode = "move"; console.log("[bbsw] mode -> MOVE"); e.preventDefault(); return; }
  if (key === "e") { _edit.mode = "rotate"; console.log("[bbsw] mode -> ROTATE"); e.preventDefault(); return; }
  if (key === "t") { _edit.mode = "scale"; console.log("[bbsw] mode -> SCALE"); e.preventDefault(); return; }
  if (key === "escape") { _swDeselect(); _edit.mode = "orbit"; console.log("[bbsw] mode -> ORBIT (deselect)"); e.preventDefault(); return; }
  if (key === "delete" || key === "backspace") {
    if (_edit.selected) {
      _swPushBBUndo();
      const elem = _edit.selected;
      _swDeselect();
      if (typeof elem.remove === "function") elem.remove();
      _safeUpdateView();
      e.preventDefault();
    }
    return;
  }
  if (key === "h" && _edit.selected) {
    const elem = _edit.selected;
    if (elem.mesh) {
      elem.mesh.visible = !elem.mesh.visible;
      _safeUpdateView();
    }
    e.preventDefault();
  }
}

// ─── Wire editing events alongside camera events ────────────────────────────
function _attachEditListeners() {
  document.addEventListener("mousedown", _onMouseDownEdit, true);
  document.addEventListener("mouseup", _onMouseUpEdit, true);
  document.addEventListener("mousemove", _onMouseMoveEdit, true);
}

function _detachEditListeners() {
  document.removeEventListener("mousedown", _onMouseDownEdit, true);
  document.removeEventListener("mouseup", _onMouseUpEdit, true);
  document.removeEventListener("mousemove", _onMouseMoveEdit, true);
}

let cssElement = null;
const CSS_ID = "bb-software-renderer-css";

function injectCSS() {
  if (document.getElementById(CSS_ID)) return;
  cssElement = document.createElement("style");
  cssElement.id = CSS_ID;
  cssElement.textContent = `
    .bb-sw-overlay {
      image-rendering: pixelated;
      image-rendering: crisp-edges;
    }
  `;
  document.head.appendChild(cssElement);
}

function removeCSS() {
  if (cssElement) { cssElement.remove(); cssElement = null; }
}

function _getPreviewContainer() {
  return (typeof document !== "undefined" && document.getElementById("preview")) || document.body;
}

function ensureOverlay(preview) {
  if (!swCanvas) {
    swCanvas = document.createElement("canvas");
    swCanvas.className = "bb-sw-overlay";
  }
  swCanvas.style.position = "absolute";
  swCanvas.style.zIndex = "15";
  swCanvas.style.imageRendering = "pixelated";
  swCanvas.style.pointerEvents = "auto";
  const container = _getPreviewContainer();
  if (swCanvas.parentElement !== container) {
    if (swCanvas.parentElement) swCanvas.remove();
    container.appendChild(swCanvas);
  }
  _positionOverlay(preview);
}

function _positionOverlay(preview) {
  if (!swCanvas || !preview || !preview.canvas) return;
  const container = _getPreviewContainer();
  const containerRect = container.getBoundingClientRect();
  const rect = preview.canvas.getBoundingClientRect();
  if (rect.width > 0 && rect.height > 0) {
    swCanvas.style.left = (rect.left - containerRect.left) + "px";
    swCanvas.style.top = (rect.top - containerRect.top) + "px";
    swCanvas.style.width = rect.width + "px";
    swCanvas.style.height = rect.height + "px";
  }
}

function showOverlay() {
  if (swCanvas) {
    swCanvas.style.display = "";
    swCanvas.style.position = "absolute";
    swCanvas.style.zIndex = "15";
    const previews = typeof Preview !== "undefined" ? Preview.all : [];
    if (previews.length > 0) {
      _positionOverlay(previews[0]);
    }
  }
}

function hideOverlay() {
  if (swCanvas) {
    swCanvas.style.display = "none";
  }
}

function initRenderer() {
  if (!swCanvas) {
    swCanvas = document.createElement("canvas");
    swCanvas.className = "bb-sw-overlay";
  }
  swCanvas.width = renderWidth;
  swCanvas.height = renderHeight;
  swRenderer = _createRenderer(swCanvas);
}

function syncResolution() {
  renderWidth = 640;
  renderHeight = 400;
  _setResolution(renderWidth, renderHeight, 50);
  if (swCanvas) {
    swCanvas.width = renderWidth;
    swCanvas.height = renderHeight;
  }
  if (swRenderer) {
    _resizeRenderer(swRenderer, renderWidth, renderHeight);
  } else {
    initRenderer();
  }
}

function renderSwFrame() {
  if (!swRenderer || !swEnabled) return;
  const preview = Preview.selected;
  if (!preview) return;
  frame++;
  const now = performance.now();
  const dt = _lastCamTick ? Math.min((now - _lastCamTick) / 1000, 0.1) : 0.016;
  _lastCamTick = now;
  _camTick(dt);
  _camApplyToPreview(preview);
  const camera = _extractCamera(preview.camera);
  const tris = _buildSceneTris(camera);
  _clearSolid(swRenderer, _rgba(40, 40, 50));
  for (const tri of tris) {
    const [v0, v1, v2] = tri.verts;
    if (tri.texture) {
      _drawTexturedTriangle(swRenderer, v0, v1, v2, 0xffffffff, tri.texture);
    } else {
      _drawTriangle(swRenderer, v0, v1, v2, tri.color);
    }
  }
  _drawRect(swRenderer, 2, 2, 200, 12, _rgba(0, 0, 0, 180));
  _drawText(swRenderer, `TRIS: ${tris.length} F:${frame}`, 4, 4, _rgba(0, 255, 120));
  _drawRect(swRenderer, swRenderer.w - 16, 2, 8, 8, _rgba(255, 0, 0));
  _swDrawSelectionOutline(swRenderer, camera);
  _swDrawGizmo(swRenderer, camera);
  _swDrawHUD(swRenderer);
  _present(swRenderer);
}

function _swRenderForRecording(preview) {
  if (!swEnabled || !preview || !preview.canvas) return;
  const src = preview.camera;
  if (!src) return;
  _camInitFromPreview(preview);
  const w = preview.width || renderWidth;
  const h = preview.height || renderHeight;
  if (!_recRenderCanvas || _recRenderCanvas.width !== w || _recRenderCanvas.height !== h) {
    _recRenderCanvas = document.createElement("canvas");
    _recRenderCanvas.width = w;
    _recRenderCanvas.height = h;
    _recRenderRd = _createRenderer(_recRenderCanvas);
  }
  const savedRd = swRenderer;
  const savedCv = swCanvas;
  swRenderer = _recRenderRd;
  swCanvas = _recRenderCanvas;
  const savedFrame = frame;
  _lastCamTick = 0;
  frame = 0;
  const savedPreview = (typeof Preview !== "undefined") ? Preview.selected : null;
  try {
    if (typeof Preview !== "undefined") Preview.selected = preview;
    _camApplyToPreview(preview);
    const camera = _extractCamera(preview.camera);
    const tris = _buildSceneTris(camera);
    _clearSolid(swRenderer, _rgba(0, 0, 0));
    for (const tri of tris) {
      const [v0, v1, v2] = tri.verts;
      if (tri.texture) {
        _drawTexturedTriangle(swRenderer, v0, v1, v2, 0xffffffff, tri.texture);
      } else {
        _drawTriangle(swRenderer, v0, v1, v2, tri.color);
      }
    }
    _present(swRenderer);
  } finally {
    swRenderer = savedRd;
    swCanvas = savedCv;
    frame = savedFrame;
    if (typeof Preview !== "undefined") Preview.selected = savedPreview;
  }
  const destCtx = preview.canvas.getContext("2d");
  if (destCtx) {
    destCtx.drawImage(_recRenderCanvas, 0, 0, preview.canvas.width, preview.canvas.height);
  }
}

function patchRender() {
  if (_patched) return;
  _origRender = Preview.prototype.render;
  Preview.prototype.render = function () {
    if (this.controls) this.controls.update();
    if (swEnabled && typeof Screencam !== "undefined" && this === Screencam.NoAAPreview) {
      _swRenderForRecording(this);
    }
  };
  _patched = true;
}

function unpatchRender() {
  if (!_patched || !_origRender) return;
  Preview.prototype.render = _origRender;
  _origRender = null;
  _patched = false;
}

let _swRAF = 0;
let _lastOverlayRect = "";
function _swLoop() {
  if (!swEnabled) return;
  try {
    if (Preview.selected && Preview.selected.canvas) {
      const rect = Preview.selected.canvas.getBoundingClientRect();
      const key = rect.left + "," + rect.top + "," + rect.width + "," + rect.height;
      if (key !== _lastOverlayRect) {
        _positionOverlay(Preview.selected);
        _lastOverlayRect = key;
      }
    }
    if (swCanvas && swCanvas.style.display === "none") {
      swCanvas.style.display = "";
    }
    renderSwFrame();
  } catch (e) {
    console.error("[bbsw] renderSwFrame error:", e);
  }
  _swRAF = requestAnimationFrame(_swLoop);
}

function _safeUpdateView() {
  try {
    if (typeof Canvas !== "undefined" && Canvas.updateView &&
        typeof Outliner !== "undefined" && Outliner.elements) {
      Canvas.updateView();
    }
  } catch (_) {}
}

function _safeRenderPreview() {
  try {
    if (typeof Preview !== "undefined" && Preview.selected) Preview.selected.render();
  } catch (_) {}
}

function enableSw() {
  swEnabled = true;
  injectCSS();
  initRenderer();
  syncResolution();
  patchRender();
  for (const preview of Preview.all) {
    ensureOverlay(preview);
  }
  _safeUpdateView();
  showOverlay();
  _camInitFromPreview(Preview.selected);
  _lastCamTick = 0;
  _attachCamListeners();
  if (_swRAF) cancelAnimationFrame(_swRAF);
  _swLoop();
}

function disableSw() {
  swEnabled = false;
  if (_swRAF) { cancelAnimationFrame(_swRAF); _swRAF = 0; }
  _recRenderCanvas = null;
  _recRenderRd = null;
  _detachCamListeners();
  hideOverlay();
  unpatchRender();
  _safeUpdateView();
  _safeRenderPreview();
}

function _initPlugin() {
  Plugin.register("softbench_renderer", {
    title: "Softbench Renderer",
    author: "crawlspaceinteractive",
    description: "Replaces the viewport with a PS1-style fixed-point software rasterizer. Bayer dithering, distance fog, 15-bit color quantization.",
    icon: "texture",
    version: "1.0.0",
    variant: "desktop",
    min_version: "4.8.0",

  onload() {
    setTimeout(function () {
      try {
        if (!toggleAction) {
          toggleAction = new Action("bb_sw_toggle", {
            name: "Software Renderer",
            description: "Toggle PS1-style software renderer viewport",
            icon: "texture",
            category: "view",
            keybind: new Keybind({ key: "P", ctrl: true, shift: true }),
            click() {
              if (swEnabled) {
                disableSw();
                toggleAction.setIcon("texture");
                Blockbench.showQuickMessage("Software renderer: OFF");
              } else {
                enableSw();
                toggleAction.setIcon("block");
                Blockbench.showQuickMessage("Software renderer: ON");
              }
            },
          });
          MenuBar.addAction(toggleAction, "view");
        }
      } catch (e) {
        console.warn("[softbench_renderer] Failed to register action:", e);
      }
    }, 0);

    eventHandlers.push(
      Blockbench.on("preview_created", (preview) => {
        if (swEnabled) { ensureOverlay(preview); showOverlay(); }
      }),
    );
    eventHandlers.push(
      Blockbench.on("load_project", () => {
        _invalidateTextureCache();
        if (swEnabled) { syncResolution(); _safeUpdateView(); }
      }),
    );
    eventHandlers.push(
      Blockbench.on("texture_update", () => {
        _invalidateTextureCache();
      }),
    );
    eventHandlers.push(
      Blockbench.on("change_texture", () => {
        _invalidateTextureCache();
      }),
    );
    },

    onunload() {
      disableSw();
      if (toggleAction) { toggleAction.delete(); toggleAction = null; }
      for (const handler of eventHandlers) {
        if (handler && typeof handler.cancel === "function") handler.cancel();
      }
      eventHandlers = [];
      if (swCanvas && swCanvas.parentElement) {
        swCanvas.remove();
      }
      swCanvas = null;
      swRenderer = null;
      removeCSS();
    },

    oninstall() {
      Blockbench.showQuickMessage("Software Renderer installed — use Ctrl+Shift+P or View menu to toggle");
    },
  });
}

if (typeof Plugin !== "undefined") {
  _initPlugin();
} else if (typeof document !== "undefined") {
  document.addEventListener("DOMContentLoaded", () => {
    setTimeout(_initPlugin, 500);
  });
} else {
  _initPlugin();
}
