// Drawing for the game worker: one WebGL2 program, one texture atlas, one batch of quads per
// frame. Nothing is allocated while drawing.
//
// The atlas is painted once with a 2D canvas: the built-in noteskin (an arrow, a receptor, a
// mine, all white so that vertices can tint them) and the words and digits of the display.
// Coordinates given to the batch are StepMania's logical pixels from the centre of the
// screen, y down, 480 high.

import { SCREEN_HEIGHT } from './field.ts';

const MAX_QUADS = 8192;
const FLOATS_PER_VERTEX = 8; // x, y, u, v, r, g, b, a
const ATLAS_W = 2048;
const ATLAS_H = 1024;
const CELL = 256;

export interface Sprite {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
  /** Width over height. */
  aspect: number;
}

export const WORDS = ['Flawless', 'Perfect', 'Great', 'Good', 'Boo', 'Miss', 'OK', 'NG', 'Early', 'Late', 'Combo', 'Misses', 'Autoplay', 'Failed', 'Ready', 'Full Combo'] as const;
export type Word = (typeof WORDS)[number];

/** Two colours (top, bottom) for the words that carry their own; the rest are white and tinted when drawn. */
const WORD_COLOURS: Partial<Record<Word, [string, string]>> = {
  Flawless: ['#ffffff', '#7fe9ff'],
  Perfect: ['#fff7c2', '#ffb800'],
  Great: ['#d8ffd0', '#22d04a'],
  Good: ['#d6e6ff', '#3d7bff'],
  Boo: ['#f0d6ff', '#a23df0'],
  Miss: ['#ffd0d0', '#ff2a2a'],
  Failed: ['#ffd0d0', '#ff2a2a'],
  'Full Combo': ['#ffffff', '#ffd75e'],
};

export interface Labels {
  title: string;
  artist: string;
  /** For example "Hard 9". */
  level: string;
}

export interface Atlas {
  /** The arrow's body, white with shading: tinted when drawn. */
  arrowFill: Sprite;
  /** Its outline and highlights: drawn over the body, untinted. */
  arrowOver: Sprite;
  /** A soft white arrow, for flashes. */
  arrowFlash: Sprite;
  receptor: Sprite;
  mine: Sprite;
  ring: Sprite;
  glow: Sprite;
  solid: Sprite;
  holdBody: Sprite;
  holdCap: Sprite;
  vignette: Sprite;
  digits: Sprite[];
  dot: Sprite;
  percent: Sprite;
  words: Record<Word, Sprite>;
  title: Sprite;
  artist: Sprite;
  level: Sprite;
}

const VERTEX = `#version 300 es
in vec2 aPos;
in vec2 aUv;
in vec4 aColor;
uniform vec2 uScale;
out vec2 vUv;
out vec4 vColor;
void main() {
  vUv = aUv;
  vColor = aColor;
  gl_Position = vec4(aPos.x * uScale.x, -aPos.y * uScale.y, 0.0, 1.0);
}`;

const FRAGMENT = `#version 300 es
precision mediump float;
in vec2 vUv;
in vec4 vColor;
uniform sampler2D uAtlas;
out vec4 color;
void main() {
  color = texture(uAtlas, vUv) * vColor;
}`;

function sprite(x: number, y: number, w: number, h: number): Sprite {
  // Half a texel in, so that neighbours do not bleed.
  return { u0: (x + 0.5) / ATLAS_W, v0: (y + 0.5) / ATLAS_H, u1: (x + w - 0.5) / ATLAS_W, v1: (y + h - 0.5) / ATLAS_H, aspect: w / h };
}

type Ctx = OffscreenCanvasRenderingContext2D;

/** The outline of an arrow pointing up in a 256 box at (x, y), scaled by `k` about the box's centre. */
function arrowPath(c: Ctx, x: number, y: number, k = 1): void {
  const p = (px: number, py: number): [number, number] => [x + 128 + (px - 128) * k, y + 128 + (py - 128) * k];
  const points: [number, number][] = [
    [128, 22],
    [230, 124],
    [196, 158],
    [152, 114],
    [152, 234],
    [104, 234],
    [104, 114],
    [60, 158],
    [26, 124],
  ];
  c.beginPath();
  points.forEach(([px, py], i) => {
    const [qx, qy] = p(px, py);
    if (i === 0) c.moveTo(qx, qy);
    else c.lineTo(qx, qy);
  });
  c.closePath();
}

function paintSprites(c: Ctx): void {
  c.lineJoin = 'round';
  c.lineCap = 'round';

  // --- Arrow body (cell 0): white, lighter at the tip, so that a tint keeps its shading.
  arrowPath(c, 0, 0);
  let g = c.createLinearGradient(0, 20, 0, 236);
  g.addColorStop(0, '#ffffff');
  g.addColorStop(0.55, '#d9d9d9');
  g.addColorStop(1, '#9c9c9c');
  c.fillStyle = g;
  c.fill();

  // --- Arrow outline and highlights (cell 1).
  const ox = CELL;
  c.save();
  arrowPath(c, ox, 0);
  c.clip();
  // A sheen across the upper left.
  g = c.createLinearGradient(ox + 30, 20, ox + 200, 200);
  g.addColorStop(0, 'rgba(255,255,255,0.55)');
  g.addColorStop(0.45, 'rgba(255,255,255,0.08)');
  g.addColorStop(1, 'rgba(0,0,0,0.25)');
  c.fillStyle = g;
  c.fillRect(ox, 0, CELL, CELL);
  c.restore();
  // A fine line inside, following the shape.
  arrowPath(c, ox, 0, 0.56);
  c.lineWidth = 5;
  c.strokeStyle = 'rgba(255,255,255,0.38)';
  c.stroke();
  arrowPath(c, ox, 0);
  c.lineWidth = 16;
  c.strokeStyle = '#0c0e14';
  c.stroke();
  arrowPath(c, ox, 0);
  c.lineWidth = 5;
  c.strokeStyle = 'rgba(255,255,255,0.9)';
  c.stroke();

  // --- Receptor (cell 2): a dark arrow with a metal rim.
  const rx = 2 * CELL;
  arrowPath(c, rx, 0);
  c.fillStyle = 'rgba(14,17,26,0.82)';
  c.fill();
  c.lineWidth = 16;
  g = c.createLinearGradient(rx, 20, rx, 236);
  g.addColorStop(0, '#f2f5fa');
  g.addColorStop(1, '#7c8698');
  c.strokeStyle = g;
  c.stroke();
  arrowPath(c, rx, 0);
  c.lineWidth = 4;
  c.strokeStyle = '#0c0e14';
  c.stroke();
  arrowPath(c, rx, 0, 0.6);
  c.lineWidth = 7;
  c.strokeStyle = 'rgba(200,210,228,0.55)';
  c.stroke();

  // --- Mine (cell 3).
  const mx = 3 * CELL + 128;
  c.fillStyle = '#aab2c0';
  c.strokeStyle = '#0c0e14';
  c.lineWidth = 6;
  for (let i = 0; i < 8; i++) {
    const a = (i * Math.PI) / 4;
    const tip = 118;
    const base = 84;
    c.beginPath();
    c.moveTo(mx + Math.cos(a) * tip, 128 + Math.sin(a) * tip);
    c.lineTo(mx + Math.cos(a + 0.2) * base, 128 + Math.sin(a + 0.2) * base);
    c.lineTo(mx + Math.cos(a - 0.2) * base, 128 + Math.sin(a - 0.2) * base);
    c.closePath();
    c.fill();
    c.stroke();
  }
  g = c.createRadialGradient(mx - 26, 100, 8, mx, 128, 92);
  g.addColorStop(0, '#5a6070');
  g.addColorStop(0.6, '#23262e');
  g.addColorStop(1, '#0b0c10');
  c.beginPath();
  c.arc(mx, 128, 90, 0, Math.PI * 2);
  c.fillStyle = g;
  c.fill();
  c.lineWidth = 8;
  c.strokeStyle = '#c9d0dc';
  c.stroke();
  g = c.createRadialGradient(mx, 128, 2, mx, 128, 40);
  g.addColorStop(0, '#ffffff');
  g.addColorStop(0.35, '#ff5a4d');
  g.addColorStop(1, '#6e0000');
  c.beginPath();
  c.arc(mx, 128, 38, 0, Math.PI * 2);
  c.fillStyle = g;
  c.fill();
  c.lineWidth = 5;
  c.strokeStyle = '#0c0e14';
  c.stroke();

  // --- Ring (cell 4) and glow (cell 5), for flashes.
  c.save();
  c.shadowColor = '#fff';
  c.shadowBlur = 18;
  c.beginPath();
  c.arc(4 * CELL + 128, 128, 96, 0, Math.PI * 2);
  c.lineWidth = 12;
  c.strokeStyle = '#fff';
  c.stroke();
  c.restore();
  // Ends well inside its cell: drawn small or stretched, it must not pick up its neighbours.
  g = c.createRadialGradient(5 * CELL + 128, 128, 0, 5 * CELL + 128, 128, 108);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.35, 'rgba(255,255,255,0.45)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  c.fillStyle = g;
  c.fillRect(5 * CELL, 0, CELL, CELL);

  // --- Soft arrow (cell 6).
  c.save();
  c.shadowColor = '#fff';
  c.shadowBlur = 22;
  arrowPath(c, 6 * CELL, 0, 0.86);
  c.fillStyle = '#fff';
  c.fill();
  c.restore();

  // --- Vignette (cell 7): clear in the middle, dark at the rim.
  g = c.createRadialGradient(7 * CELL + 128, 128, 40, 7 * CELL + 128, 128, 180);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(1, 'rgba(0,0,0,0.9)');
  c.fillStyle = g;
  c.fillRect(7 * CELL, 0, CELL, CELL);

  // --- Second row: hold body, hold cap, solid.
  const y = CELL;
  g = c.createLinearGradient(0, 0, 128, 0);
  g.addColorStop(0, '#6e6e6e');
  g.addColorStop(0.22, '#e6e6e6');
  g.addColorStop(0.5, '#ffffff');
  g.addColorStop(0.78, '#dcdcdc');
  g.addColorStop(1, '#5c5c5c');
  c.fillStyle = g;
  c.fillRect(0, y, 128, CELL);
  c.fillStyle = '#0c0e14';
  c.fillRect(0, y, 7, CELL);
  c.fillRect(121, y, 7, CELL);
  // Cap: the lower half of a disc with the same shading.
  c.save();
  c.beginPath();
  c.arc(128 + 64, y, 64, 0, Math.PI);
  c.closePath();
  c.clip();
  c.translate(128, 0);
  c.fillStyle = g;
  c.fillRect(0, y, 128, 64);
  c.restore();
  c.beginPath();
  c.arc(128 + 64, y, 60.5, 0, Math.PI);
  c.lineWidth = 7;
  c.strokeStyle = '#0c0e14';
  c.stroke();
  c.fillStyle = '#fff';
  c.fillRect(CELL + 8, y + 8, 48, 48);
}

const FONT = '"Avenir Next Condensed", "Helvetica Neue", "Arial Narrow", "Roboto Condensed", system-ui, sans-serif';

function paintAtlas(labels: Labels): { canvas: OffscreenCanvas; atlas: Atlas } {
  const canvas = new OffscreenCanvas(ATLAS_W, ATLAS_H);
  const c = canvas.getContext('2d');
  if (!c) throw new Error('No 2D canvas in this worker: cannot paint the noteskin');
  c.clearRect(0, 0, ATLAS_W, ATLAS_H);
  paintSprites(c);

  // Text, flowed into rows below the sprites.
  c.textBaseline = 'alphabetic';
  c.textAlign = 'left';
  c.lineJoin = 'round';
  let x = 4;
  let y = 2 * CELL + 4;
  const ROW = 124;
  const PAD = 14;
  const put = (text: string, font: string, colours: [string, string] | null, maxWidth = ATLAS_W - 8): Sprite => {
    c.font = font;
    let shown = text;
    while (shown.length > 1 && c.measureText(shown).width + 2 * PAD > maxWidth) shown = `${shown.slice(0, -2).trimEnd()}…`;
    const w = Math.ceil(c.measureText(shown).width) + 2 * PAD;
    if (x + w > ATLAS_W - 4) {
      x = 4;
      y += ROW;
    }
    if (y + ROW > ATLAS_H) throw new Error('The text atlas is full');
    const base = y + 92;
    c.lineWidth = 12;
    c.strokeStyle = '#090b10';
    c.strokeText(shown, x + PAD, base);
    if (colours) {
      const g = c.createLinearGradient(0, y + 20, 0, y + 100);
      g.addColorStop(0, colours[0]);
      g.addColorStop(1, colours[1]);
      c.fillStyle = g;
    } else {
      c.fillStyle = '#fff';
    }
    c.fillText(shown, x + PAD, base);
    const s = sprite(x, y, w, ROW);
    x += w + 4;
    return s;
  };
  const heavy = `italic 800 96px ${FONT}`;
  const digits: Sprite[] = [];
  for (let d = 0; d < 10; d++) digits.push(put(String(d), heavy, null));
  const dot = put('.', heavy, null);
  const percent = put('%', heavy, null);
  const words = {} as Record<Word, Sprite>;
  for (const word of WORDS) words[word] = put(word.toUpperCase(), heavy, WORD_COLOURS[word] ?? null);
  const title = put(labels.title || ' ', `700 84px ${FONT}`, null, 1100);
  const artist = put(labels.artist || ' ', `500 84px ${FONT}`, null, 900);
  const level = put(labels.level.toUpperCase() || ' ', `800 84px ${FONT}`, null, 600);

  return {
    canvas,
    atlas: {
      arrowFill: sprite(0, 0, CELL, CELL),
      arrowOver: sprite(CELL, 0, CELL, CELL),
      receptor: sprite(2 * CELL, 0, CELL, CELL),
      mine: sprite(3 * CELL, 0, CELL, CELL),
      ring: sprite(4 * CELL, 0, CELL, CELL),
      glow: sprite(5 * CELL + 16, 16, CELL - 32, CELL - 32),
      arrowFlash: sprite(6 * CELL, 0, CELL, CELL),
      vignette: sprite(7 * CELL, 0, CELL, CELL),
      holdBody: sprite(0, CELL + 8, 128, CELL - 16),
      holdCap: sprite(128, CELL, 128, 64),
      solid: sprite(CELL + 16, CELL + 16, 32, 32),
      digits,
      dot,
      percent,
      words,
      title,
      artist,
      level,
    },
  };
}

export class Renderer {
  readonly gl: WebGL2RenderingContext;
  readonly canvas: OffscreenCanvas;
  readonly atlas: Atlas;
  private readonly vertices = new Float32Array(MAX_QUADS * 4 * FLOATS_PER_VERTEX);
  private readonly buffer: WebGLBuffer;
  private readonly scale: WebGLUniformLocation;
  private quads = 0;
  private readonly atlasTexture: WebGLTexture;
  private background: WebGLTexture | null = null;
  private backgroundAspect = 1;
  private backgroundDim = 0.35;
  /** Quads left out because the batch was full. */
  dropped = 0;

  constructor(canvas: OffscreenCanvas, labels: Labels = { title: '', artist: '', level: '' }, desynchronized = false) {
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      desynchronized,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: false,
    });
    if (!gl) throw new Error('WebGL2 is not available on an OffscreenCanvas here');
    this.gl = gl;
    this.canvas = canvas;

    const compile = (type: number, source: string): WebGLShader => {
      const shader = gl.createShader(type)!;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(`Shader: ${gl.getShaderInfoLog(shader)}`);
      return shader;
    };
    const program = gl.createProgram()!;
    gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAGMENT));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`Program: ${gl.getProgramInfoLog(program)}`);
    gl.useProgram(program);
    this.scale = gl.getUniformLocation(program, 'uScale')!;

    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    this.buffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.vertices.byteLength, gl.DYNAMIC_DRAW);
    const stride = FLOATS_PER_VERTEX * 4;
    const attribute = (name: string, size: number, offset: number): void => {
      const location = gl.getAttribLocation(program, name);
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, size, gl.FLOAT, false, stride, offset * 4);
    };
    attribute('aPos', 2, 0);
    attribute('aUv', 2, 2);
    attribute('aColor', 4, 4);

    const indices = new Uint16Array(MAX_QUADS * 6);
    for (let q = 0; q < MAX_QUADS; q++) {
      const v = q * 4;
      indices.set([v, v + 1, v + 2, v, v + 2, v + 3], q * 6);
    }
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);

    const painted = paintAtlas(labels);
    this.atlas = painted.atlas;
    this.atlasTexture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.atlasTexture);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, painted.canvas);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    // Sprites share the texture: the smaller mip levels would mix neighbours together.
    gl.texParameterf(gl.TEXTURE_2D, gl.TEXTURE_MAX_LOD, 2);
    gl.generateMipmap(gl.TEXTURE_2D);

    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); // premultiplied alpha
  }

  get hasBackground(): boolean {
    return this.background !== null;
  }

  /** A picture drawn behind everything, scaled to cover the canvas. */
  setBackground(bitmap: ImageBitmap, dim: number): void {
    const gl = this.gl;
    if (this.background) gl.deleteTexture(this.background);
    this.background = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.background);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, this.atlasTexture);
    this.backgroundAspect = bitmap.width / Math.max(1, bitmap.height);
    this.backgroundDim = dim;
  }

  /** Starts a frame. The first quad of the batch is kept for the background. */
  begin(): void {
    this.quads = 1;
  }

  /**
   * A sprite centred on (cx, cy), `w` by `h`, turned clockwise by `angle` radians.
   * The colour is not premultiplied. With `additive`, it is added to what is there (light).
   */
  sprite(s: Sprite, cx: number, cy: number, w: number, h: number, angle: number, r: number, g: number, b: number, a: number, additive = false): void {
    if (this.quads >= MAX_QUADS) {
      this.dropped++;
      return;
    }
    const hw = w / 2;
    const hh = h / 2;
    let ax = -hw;
    let ay = -hh;
    let bx = hw;
    let by = -hh;
    if (angle !== 0) {
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      // Clockwise with y down.
      const tx = ax * cos - ay * sin;
      ay = ax * sin + ay * cos;
      ax = tx;
      const ux = bx * cos - by * sin;
      by = bx * sin + by * cos;
      bx = ux;
    }
    const v = this.vertices;
    let o = this.quads * 4 * FLOATS_PER_VERTEX;
    const pr = r * a;
    const pg = g * a;
    const pb = b * a;
    // Premultiplied alpha: an alpha of 0 with colour left in adds light.
    const pa = additive ? 0 : a;
    // top left, top right, bottom right, bottom left (of the unturned sprite)
    o = this.vertex(v, o, cx + ax, cy + ay, s.u0, s.v0, pr, pg, pb, pa);
    o = this.vertex(v, o, cx + bx, cy + by, s.u1, s.v0, pr, pg, pb, pa);
    o = this.vertex(v, o, cx - ax, cy - ay, s.u1, s.v1, pr, pg, pb, pa);
    this.vertex(v, o, cx - bx, cy - by, s.u0, s.v1, pr, pg, pb, pa);
    this.quads++;
  }

  private vertex(v: Float32Array, o: number, x: number, y: number, u: number, t: number, r: number, g: number, b: number, a: number): number {
    v[o] = x;
    v[o + 1] = y;
    v[o + 2] = u;
    v[o + 3] = t;
    v[o + 4] = r;
    v[o + 5] = g;
    v[o + 6] = b;
    v[o + 7] = a;
    return o + FLOATS_PER_VERTEX;
  }

  /** A filled rectangle from (x0, y0) to (x1, y1). */
  rect(x0: number, y0: number, x1: number, y1: number, r: number, g: number, b: number, a: number): void {
    this.sprite(this.atlas.solid, (x0 + x1) / 2, (y0 + y1) / 2, Math.abs(x1 - x0), Math.abs(y1 - y0), 0, r, g, b, a);
  }

  /** A word or glyph `height` high, centred on (cx, cy). Returns its width. */
  text(s: Sprite, cx: number, cy: number, height: number, r: number, g: number, b: number, a: number): number {
    const w = height * s.aspect;
    this.sprite(s, cx, cy, w, height, 0, r, g, b, a);
    return w;
  }

  /** A whole number in digits, centred on (cx, cy). */
  number(value: number, cx: number, cy: number, height: number, r: number, g: number, b: number, a: number): void {
    const digits = this.atlas.digits;
    let n = Math.max(0, Math.floor(value));
    let count = 1;
    for (let m = n; m >= 10; m = Math.floor(m / 10)) count++;
    const advance = height * digits[0]!.aspect * 0.66;
    let x = cx + ((count - 1) * advance) / 2;
    for (let i = 0; i < count; i++) {
      this.text(digits[n % 10]!, x, cy, height, r, g, b, a);
      n = Math.floor(n / 10);
      x -= advance;
    }
  }

  /** Width of the view in logical pixels (the height is 480). */
  get viewWidth(): number {
    return SCREEN_HEIGHT * (this.canvas.width / Math.max(1, this.canvas.height));
  }

  /** Clears the canvas and draws the batch. */
  end(): void {
    const gl = this.gl;
    const w = this.canvas.width;
    const h = this.canvas.height;
    gl.viewport(0, 0, w, h);
    gl.clearColor(0.02, 0.024, 0.036, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    // 480 logical pixels fill the height; x uses the same scale.
    gl.uniform2f(this.scale, (2 / SCREEN_HEIGHT) * (h / w), 2 / SCREEN_HEIGHT);

    if (this.background) {
      // Quad 0: the whole texture, covering the canvas, cropped where the shapes differ.
      const viewW = SCREEN_HEIGHT * (w / h);
      const cover = Math.max(viewW / this.backgroundAspect, SCREEN_HEIGHT);
      const hw = (cover * this.backgroundAspect) / 2;
      const hh = cover / 2;
      const d = this.backgroundDim;
      const v = this.vertices;
      let o = 0;
      o = this.vertex(v, o, -hw, -hh, 0, 0, d, d, d, 1);
      o = this.vertex(v, o, hw, -hh, 1, 0, d, d, d, 1);
      o = this.vertex(v, o, hw, hh, 1, 1, d, d, d, 1);
      this.vertex(v, o, -hw, hh, 0, 1, d, d, d, 1);
    }
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.vertices, 0, this.quads * 4 * FLOATS_PER_VERTEX);
    if (this.background) {
      gl.bindTexture(gl.TEXTURE_2D, this.background);
      gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
      gl.bindTexture(gl.TEXTURE_2D, this.atlasTexture);
    }
    if (this.quads > 1) gl.drawElements(gl.TRIANGLES, (this.quads - 1) * 6, gl.UNSIGNED_SHORT, 6 * 2);
  }
}
