// js/render.js — ?render: the site recorded frame by frame into an MP4, in the browser.
//
// Every frame is stepped at a fixed time step, so the video is perfectly smooth however long a frame
// takes to draw. Each frame is the page as a visitor sees it: the 3D scene plus the page itself (text,
// top bar, buttons, footer, the 3D viewer's controls) drawn from the live layout, with the page's own
// CSS fades run on the video's clock. The run scrolls the whole page, then a pointer clicks "View in 3D"
// and tries the viewer: spin, each paint colour, the thrusters and the chassis.
//
// Open it through render.html, which runs this page in a frame of a fixed size, so the video is full-frame
// whatever the shape of the browser window. The page is laid out at the screen's own width (as the visitor's
// browser lays it out, display scaling included) and drawn up to the video size (1920×1080 by default).
//   &scale=1.25    video pixels per page pixel (render.html sets this)
//   &fps=30        frames per second (60 is smoother and takes twice as long)
//   &outro=0       stop at the bottom of the page instead of going on into the 3D viewer
//                  (not "viewer": ?viewer is the site's own link that opens the viewer straight away)
//   plus the demo's from / to / speed / delay (see "Demo mode" in js/main.js)
import { viewerApi } from './viewer.js';

const MUXER_URL = 'https://cdn.jsdelivr.net/npm/mp4-muxer@5.1.3/build/mp4-muxer.mjs';
const GOLD = '#c9a46a';
const MOVE = 0.9;   // seconds the pointer takes to reach what it clicks next

// What the pointer does in the viewer, in seconds from when the car has loaded.
const VIEWER_SECONDS = 24;
const VIEWER_SCRIPT = [
  { at: 1.8, sel: '#autoRotate' },
  { at: 4.2, sel: '.viewer__swatch[title="Stealth Grey"]' },
  { at: 6.8, sel: '.viewer__swatch[title="Ultra Red"]' },
  { at: 9.4, sel: '.viewer__swatch[title="Deep Blue"]' },
  { at: 12.0, sel: '.viewer__swatch[title="Ano White"]' },
  { at: 14.4, sel: '#toggleThrust' },
  { at: 17.2, sel: '#toggleThrust' },
  { at: 18.6, sel: '#toggleTeardown' },
];

const clamp01 = (x) => Math.min(1, Math.max(0, x));
const easeInOut = (x) => { x = clamp01(x); return x * x * (3 - 2 * x); };
const even = (x) => Math.max(2, Math.round(x / 2) * 2);
// Yield to the browser between frames. A message, not a timer: timers in a background tab are slowed to
// once a second, so a render would crawl whenever its tab isn't the one in front.
const yieldPort = new MessageChannel(), yieldWaiters = [];
yieldPort.port1.onmessage = () => yieldWaiters.shift()?.();
const tick = () => new Promise((r) => { yieldWaiters.push(r); yieldPort.port2.postMessage(0); });

/* ============ The page's CSS fades and transitions, run on the video's clock ============ */
const animStart = new WeakMap();
function syncAnimations(ms) {
  for (const a of document.getAnimations()) {
    if (!animStart.has(a)) animStart.set(a, ms - (a.currentTime || 0));
    a.pause();
    a.currentTime = Math.max(0, ms - animStart.get(a));
  }
}
// Text fades up as it scrolls into view. The page does this with an IntersectionObserver, which only runs
// when the browser paints; check here as well so the timing follows the frames being rendered.
function revealInView() {
  for (const el of document.querySelectorAll('.reveal:not(.is-in)')) {
    const r = el.getBoundingClientRect();
    if (r.top < window.innerHeight - r.height * 0.2 && r.bottom > r.height * 0.2) el.classList.add('is-in');
  }
}

/* ============ Drawing the page ============ */
const isClear = (c) => !c || c === 'transparent' || /rgba\([^)]*,\s*0\)$/.test(c);
const range = document.createRange();
const svgPaths = new WeakMap();

function radiusOf(cs, r) {
  const v = cs.borderTopLeftRadius;
  return v.endsWith('%') ? (Math.min(r.width, r.height) * parseFloat(v)) / 100 : parseFloat(v) || 0;
}

function paintBox(ctx, el, cs, r) {
  const rad = Math.min(radiusOf(cs, r), r.width / 2, r.height / 2);
  const path = () => { ctx.beginPath(); ctx.roundRect(r.left, r.top, r.width, r.height, rad); };
  if (!isClear(cs.backgroundColor)) { ctx.fillStyle = cs.backgroundColor; path(); ctx.fill(); }
  if (cs.backgroundImage !== 'none') {
    if (el.tagName === 'H2') {                                       // the gold rule under each heading
      const g = ctx.createLinearGradient(r.left, 0, r.right, 0);
      g.addColorStop(0, GOLD); g.addColorStop(1, 'rgba(201,164,106,0)');
      ctx.fillStyle = g; ctx.fillRect(r.left, r.bottom - 1, r.width, 1);
    } else if (el.classList.contains('nav') || el.classList.contains('viewer__topbar')) {   // dark fade behind the top bar
      const g = ctx.createLinearGradient(0, r.top, 0, r.bottom);
      g.addColorStop(0, el.classList.contains('nav') ? 'rgba(0,0,0,0.6)' : 'rgba(0,0,0,0.7)'); g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g; ctx.fillRect(r.left, r.top, r.width, r.height);
    } else if (el.classList.contains('btn--viewer')) {
      ctx.fillStyle = 'rgba(201,164,106,0.1)'; path(); ctx.fill();
    }
  }
  const bw = parseFloat(cs.borderTopWidth) || 0;
  if (bw > 0 && !isClear(cs.borderTopColor)) {
    ctx.strokeStyle = cs.borderTopColor; ctx.lineWidth = bw;
    ctx.beginPath(); ctx.roundRect(r.left + bw / 2, r.top + bw / 2, r.width - bw, r.height - bw, Math.max(0, rad - bw / 2)); ctx.stroke();
  }
}

function paintSvg(ctx, svg, cs, r) {
  if (!svgPaths.has(svg)) svgPaths.set(svg, [...svg.querySelectorAll('path')].map((p) => new Path2D(p.getAttribute('d'))));
  const vb = svg.viewBox.baseVal, s = r.width / (vb && vb.width ? vb.width : 24);
  ctx.save();
  ctx.translate(r.left, r.top); ctx.scale(s, s);
  ctx.strokeStyle = cs.color;
  ctx.lineWidth = +(svg.getAttribute('stroke-width') || 1.5);
  ctx.lineCap = svg.getAttribute('stroke-linecap') || 'butt';
  ctx.lineJoin = svg.getAttribute('stroke-linejoin') || 'miter';
  for (const p of svgPaths.get(svg)) ctx.stroke(p);
  ctx.restore();
}

function paintTextNode(ctx, node, cs) {
  ctx.save();
  ctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
  ctx.letterSpacing = cs.letterSpacing === 'normal' ? '0px' : cs.letterSpacing;
  ctx.fillStyle = cs.color;
  if (cs.textShadow !== 'none') { ctx.shadowColor = 'rgba(0,0,0,0.85)'; ctx.shadowBlur = 24; }
  const ascent = ctx.measureText('Hg').fontBoundingBoxAscent;
  const upper = cs.textTransform === 'uppercase';
  for (const m of node.data.matchAll(/\S+/g)) {
    range.setStart(node, m.index);
    range.setEnd(node, m.index + m[0].length);
    const r = range.getClientRects()[0];
    if (!r || r.bottom < 0 || r.top > window.innerHeight) continue;
    ctx.fillText(upper ? m[0].toUpperCase() : m[0], r.left, r.top + ascent);
  }
  ctx.restore();
}

// Things drawn with CSS pseudo-elements, which the DOM doesn't expose as boxes
function paintExtras(ctx, el, r, now) {
  if (el.classList.contains('viewer__hotspot')) {                    // the pulsing dots on the car
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2, R = r.width / 2;
    const p = (now % 2.2) / 2.2, eo = 1 - Math.pow(1 - p, 2);
    ctx.save();
    ctx.globalAlpha *= 0.8 * (1 - eo); ctx.strokeStyle = 'rgba(255,255,255,0.6)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(cx, cy, R * (1 + 1.1 * eo), 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
    ctx.fillStyle = el.classList.contains('is-active') ? GOLD : '#fff';
    ctx.beginPath(); ctx.arc(cx, cy, R - 11, 0, Math.PI * 2); ctx.fill();
  } else if (el.parentElement && el.parentElement.classList.contains('cue') && el.tagName === 'SPAN') {   // "Scroll" hint
    const p = (now % 1.8) / 1.8, y = r.top + (-0.4 + 1.4 * easeInOut(p)) * r.height;
    ctx.save(); ctx.beginPath(); ctx.rect(r.left, r.top, r.width, r.height); ctx.clip();
    ctx.fillStyle = '#fff'; ctx.fillRect(r.left, y, 1, r.height * 0.4); ctx.restore();
  } else if (el.classList.contains('label')) {                         // teardown part labels: dot and gold tick
    const cy = r.top + r.height / 2;
    ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(r.left + 2.5, cy, 2.5, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = GOLD; ctx.fillRect(r.left + 7, cy, 14, 1);
  }
}

/** Draw `el` and everything in it, in document order, as the browser laid it out. */
function paintTree(ctx, el, now, canvases, parentAlpha = 1) {
  const cs = getComputedStyle(el);
  if (cs.display === 'none' || cs.visibility === 'hidden' || el.hidden) return;
  const alpha = parentAlpha * +cs.opacity;
  if (alpha < 0.004) return;
  const r = el.getBoundingClientRect();
  if (r.bottom < 0 || r.top > window.innerHeight || r.right < 0 || r.left > window.innerWidth) return;
  ctx.globalAlpha = alpha;
  if (el.tagName === 'CANVAS') { const src = canvases.get(el); if (src) ctx.drawImage(src, r.left, r.top, r.width, r.height); return; }
  paintBox(ctx, el, cs, r);
  if (el.tagName === 'svg') { paintSvg(ctx, el, cs, r); return; }
  paintExtras(ctx, el, r, now);
  for (const n of el.childNodes) {
    if (n.nodeType === 3) { if (n.data.trim()) { ctx.globalAlpha = alpha; paintTextNode(ctx, n, cs); } }
    else if (n.nodeType === 1 && n.tagName !== 'SCRIPT') paintTree(ctx, n, now, canvases, alpha);
  }
}

// Fixed layers, back to front (their z-index order in css/style.css)
const LAYERS = ['#scene', '#flash', '#main', '#labels', '.footer', '.nav', '.progress', '#viewer'];
function paintPage(ctx, now, canvases) {
  ctx.save();
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  for (const sel of LAYERS) { const el = document.querySelector(sel); if (el) paintTree(ctx, el, now, canvases); }
  ctx.restore();
}

/* ============ The pointer ============ */
const pointer = { x: 0, y: 0, alpha: 0, clickAt: -9 };
// While the page scrolls the pointer rests low in the middle, drifting a little the way a hand on a mouse does
function idlePointer(now) {
  pointer.x = window.innerWidth * 0.56 + 16 * Math.sin(now * 0.37) + 7 * Math.sin(now * 0.93 + 1.3);
  pointer.y = window.innerHeight * 0.74 + 10 * Math.sin(now * 0.29 + 0.6) + 5 * Math.sin(now * 1.07);
}
const ARROW = new Path2D('M0 0 L0 17 L4.6 13 L7.6 20 L10.2 18.9 L7.3 12.3 L13 12.3 Z');
function paintPointer(ctx, now) {
  if (pointer.alpha <= 0) return;
  ctx.save();
  ctx.globalAlpha = pointer.alpha;
  const c = now - pointer.clickAt;
  if (c >= 0 && c < 0.4) {                                             // a soft ring where it clicks
    ctx.strokeStyle = `rgba(255,255,255,${0.55 * (1 - c / 0.4)})`; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(pointer.x, pointer.y, 6 + 18 * (c / 0.4), 0, Math.PI * 2); ctx.stroke();
  }
  ctx.translate(pointer.x, pointer.y);
  const s = c >= 0 && c < 0.15 ? 0.9 : 1;                               // presses in a touch on the click
  ctx.scale(1.15 * s, 1.15 * s);
  ctx.shadowColor = 'rgba(0,0,0,0.45)'; ctx.shadowBlur = 4; ctx.shadowOffsetY = 1;
  ctx.fillStyle = '#fff'; ctx.fill(ARROW);
  ctx.shadowColor = 'transparent'; ctx.strokeStyle = '#000'; ctx.lineWidth = 1.1; ctx.lineJoin = 'round'; ctx.stroke(ARROW);
  ctx.restore();
}
/** Glide to each target in turn and click it at its time. `t` is seconds into the plan. */
function runPlan(plan, t, now) {
  for (const p of plan) {
    const t0 = p.at - MOVE;
    if (t < t0) break;
    if (!p.to) {
      const r = document.querySelector(p.sel).getBoundingClientRect();
      p.from = { x: pointer.x, y: pointer.y };
      p.to = { x: r.left + r.width / 2 + 2, y: r.top + r.height / 2 + 2 };
    }
    const e = easeInOut((t - t0) / MOVE);
    pointer.x = p.from.x + (p.to.x - p.from.x) * e;
    pointer.y = p.from.y + (p.to.y - p.from.y) * e;
    if (t >= p.at && !p.clicked) { p.clicked = true; pointer.clickAt = now; document.querySelector(p.sel).click(); }
  }
}

/* ============ Encoding: H.264 in an MP4 ============ */
async function makeEncoder(width, height, fps) {
  if (!('VideoEncoder' in window)) throw new Error('This browser cannot encode video. Use Chrome or Edge.');
  const { Muxer, ArrayBufferTarget } = await import(MUXER_URL);
  const bitrate = Math.round(width * height * fps * 0.2);
  let config = null;
  for (const codec of ['avc1.640034', 'avc1.4d0034', 'avc1.42e034']) {     // High, Main, then Baseline profile
    const c = { codec, width, height, bitrate, framerate: fps, avc: { format: 'avc' } };
    if ((await VideoEncoder.isConfigSupported(c)).supported) { config = c; break; }
  }
  if (!config) throw new Error(`This browser cannot encode H.264 at ${width}×${height}.`);
  const target = new ArrayBufferTarget();
  const muxer = new Muxer({ target, video: { codec: 'avc', width, height }, fastStart: 'in-memory' });
  let failure = null, n = 0;
  const encoder = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: (e) => { failure = e; } });
  encoder.configure(config);
  return {
    async add(source) {
      if (failure) throw failure;
      const frame = new VideoFrame(source, { timestamp: Math.round((n * 1e6) / fps), duration: Math.round(1e6 / fps) });
      encoder.encode(frame, { keyFrame: n % (fps * 2) === 0 });
      frame.close();
      n++;
      while (encoder.encodeQueueSize > 4) await tick();
    },
    async finish() {
      await encoder.flush();
      if (failure) throw failure;
      muxer.finalize();
      return new Blob([target.buffer], { type: 'video/mp4' });
    },
  };
}

/* ============ Progress: to render.html when it hosts this page, otherwise a small panel here ============ */
function reporter() {
  const stage = window.parent !== window ? window.parent : null;
  let el = null;
  const local = (html) => {
    if (!el) {
      el = document.createElement('div');
      el.style.cssText = 'position:fixed;left:16px;bottom:16px;z-index:300;padding:14px 18px;background:rgba(10,10,14,0.92);border:1px solid #333;border-radius:12px;color:#ddd;font:13px/1.5 system-ui,sans-serif';
      document.body.appendChild(el);
    }
    el.innerHTML = html;
  };
  return {
    progress(text, fraction) { if (stage) stage.postMessage({ type: 'progress', text, fraction }, location.origin); else document.title = text; },
    done(blob, name, seconds) {
      window.__renderedVideo = { url: URL.createObjectURL(blob), size: blob.size, seconds };
      if (stage) { stage.postMessage({ type: 'done', blob, name, seconds }, location.origin); return; }
      const url = window.__renderedVideo.url;
      local(`Done: ${seconds.toFixed(1)} s, ${(blob.size / 1e6).toFixed(1)} MB. <a href="${url}" download="${name}" style="color:${GOLD}">Download ${name}</a>`);
    },
    fail(message) { if (stage) stage.postMessage({ type: 'error', message }, location.origin); else local(`Render failed: ${message}`); },
  };
}

/* ============ The render ============ */
export async function renderVideo(story, params) {
  const report = reporter();
  try {
    const fps = Math.max(1, +(params.get('fps') || 30)), dt = 1 / fps;
    const withViewer = params.get('outro') !== '0';
    report.progress('Loading…', 0);
    await story.whenReady();
    await document.fonts.ready;
    const k = Math.max(0.25, +(params.get('scale') || 1));          // video pixels per page pixel
    story.setPixelRatio(k);                                           // the 3D scene renders at the video's resolution
    const W = even(window.innerWidth * k), H = even(window.innerHeight * k);
    const out = document.createElement('canvas');
    out.width = W; out.height = H;
    const ctx = out.getContext('2d');
    ctx.setTransform(k, 0, 0, k, 0, 0);                               // everything below is drawn in page pixels
    const enc = await makeEncoder(W, H, fps);

    // the WebGL canvases are copied right after each draw (later in the task they may already be cleared)
    const copies = new Map();
    const copyOf = (src) => {
      if (!copies.has(src)) copies.set(src, document.createElement('canvas'));
      const c = copies.get(src);
      if (c.width !== src.width || c.height !== src.height) { c.width = src.width; c.height = src.height; }
      c.getContext('2d').drawImage(src, 0, 0);
    };
    const sceneCanvas = story.canvas;

    let now = 0, frames = 0;
    const t0 = performance.now();
    const emit = async (phase) => {
      revealInView();
      syncAnimations(now * 1000);
      paintPage(ctx, now, copies);
      paintPointer(ctx, now);
      await enc.add(out);
      frames++;
      if (frames % 10 === 0) {
        const total = (story.seconds || 60) + (withViewer ? VIEWER_SECONDS + 3 : 0);
        const rate = frames / ((performance.now() - t0) / 1000);
        report.progress(`${phase} · ${(frames / fps).toFixed(0)} of about ${total.toFixed(0)} s · ${rate.toFixed(1)} frames/s`, Math.min(0.99, frames / fps / total));
      }
      await tick();
    };

    // 1. the story: the page scrolls from the top to the bottom
    story.start();
    pointer.alpha = 1;
    while (!story.finished) {
      story.step(dt); copyOf(sceneCanvas); now += dt;
      idlePointer(now);
      await emit('Scrolling the page');
    }

    if (withViewer) {
      // 2. the pointer moves to "View in 3D" in the footer and clicks it
      const intro = [{ at: 1.3, sel: '#view3d' }];
      for (let t = 0; !viewerApi.open; t += dt) {
        story.step(dt); copyOf(sceneCanvas); now += dt;
        runPlan(intro, t, now);
        await emit('Opening the 3D viewer');
      }
      viewerApi.takeOver(k);

      // 3. the viewer: it loads, then the pointer tries the controls
      const plan = VIEWER_SCRIPT.map((p) => ({ ...p }));
      let t = -Infinity;
      for (let n = 0; ; n++) {
        if (t === -Infinity && viewerApi.ready) t = 0;
        viewerApi.step(dt); copyOf(viewerApi.canvas); now += dt;
        if (t >= 0) { runPlan(plan, t, now); t += dt; }
        await emit('In the 3D viewer');
        if (t >= VIEWER_SECONDS) break;
        if (n > fps * 30 && t < 0) throw new Error('The 3D viewer did not finish loading.');
      }
    }

    report.progress('Finishing the file…', 0.995);
    const blob = await enc.finish();
    report.done(blob, `roadster-demo-${W}x${H}.mp4`, frames / fps);
  } catch (err) {
    console.error(err);
    report.fail(err.message);
  }
}
