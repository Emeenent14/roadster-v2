// js/render.js — ?render: the demo rendered frame by frame straight into an MP4, in the browser.
//
// Every frame is drawn at a fixed time step and handed to the browser's video encoder (WebCodecs),
// so the result is perfectly smooth however long each frame takes to draw. The page's own text is
// painted into the frames from the live layout, and the run can end in the 3D viewer, turning slowly
// through the paint colours.
//
// Options, on top of the demo's from / to / speed:
//   &width=1920   video width in pixels; the height follows the window's shape, so size the window to frame it
//   &fps=60
//   &viewer=0     leave out the 3D viewer segment (it is on by default)
//   &story=0      the 3D viewer segment only
import { viewerApi } from './viewer.js';

const MUXER_URL = 'https://cdn.jsdelivr.net/npm/mp4-muxer@5.1.3/build/mp4-muxer.mjs';
const GOLD = '#c9a46a';

// The viewer segment: [seconds, what happens]. Swatch order matches index.html: Ano White, Stealth Grey, Ultra Red, Deep Blue.
const VIEWER_SECONDS = 12;
const VIEWER_SCRIPT = [
  [0.0, (v) => v.spin(true, 1.5)],
  [1.6, (v) => v.paint(1)],
  [3.7, (v) => v.paint(2)],
  [5.8, (v) => v.paint(3)],
  [7.9, (v) => v.paint(0)],
  [9.4, (v) => v.toggle('thrust', true)],
];
const FADE = 0.5;   // seconds of fade to and from black between the story and the viewer

const clamp01 = (x) => Math.min(1, Math.max(0, x));
const easeOut = (x) => 1 - Math.pow(1 - clamp01(x), 3);
const even = (x) => Math.max(2, Math.round(x / 2) * 2);
const tick = () => new Promise((r) => setTimeout(r, 0));

/* ============ Text: painted word by word where the browser laid it out ============ */
// The page's text fades up as it scrolls in. Here that follows the video's clock rather than the wall clock.
const revealed = new Map();
function revealOf(el, now) {
  const box = el.closest('.reveal');
  if (!box) return { a: 1, dy: 0 };
  if (!revealed.has(box)) {
    const r = box.getBoundingClientRect();
    if (r.top < window.innerHeight * 0.85 && r.bottom > 0) revealed.set(box, now);
    else return { a: 0, dy: 34 };
  }
  const p = easeOut((now - revealed.get(box)) / 1.1);
  return { a: p, dy: 34 * (1 - p) };
}

const range = document.createRange();
function paintText(ctx, root, k, now, skip) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.85)';
  ctx.shadowBlur = 26 * k;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const el = node.parentElement;
    if (!node.data.trim() || (skip && el.closest(skip))) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || !el.getClientRects().length) continue;
    const { a, dy } = revealOf(el, now);
    if (a <= 0.003) continue;
    ctx.font = `${cs.fontWeight} ${parseFloat(cs.fontSize) * k}px ${cs.fontFamily}`;
    ctx.letterSpacing = `${(parseFloat(cs.letterSpacing) || 0) * k}px`;
    ctx.fillStyle = cs.color;
    ctx.globalAlpha = a;
    const ascent = ctx.measureText('Hg').fontBoundingBoxAscent;
    const upper = cs.textTransform === 'uppercase';
    for (const m of node.data.matchAll(/\S+/g)) {
      range.setStart(node, m.index);
      range.setEnd(node, m.index + m[0].length);
      const r = range.getClientRects()[0];
      if (!r || r.bottom < 0 || r.top > window.innerHeight) continue;
      ctx.fillText(upper ? m[0].toUpperCase() : m[0], r.left * k, (r.top + dy) * k + ascent);
    }
  }
  ctx.restore();
}

/** The story's text, the gold rules under its headings, the version cards and the white flash. */
function paintStory(ctx, k, now, flash) {
  const main = document.getElementById('main');
  for (const card of main.querySelectorAll('.trim')) {
    const { a, dy } = revealOf(card, now), r = card.getBoundingClientRect();
    if (a <= 0.003 || r.bottom < 0 || r.top > window.innerHeight) continue;
    ctx.save();
    ctx.globalAlpha = a;
    ctx.fillStyle = 'rgba(10,10,10,0.72)'; ctx.strokeStyle = '#222'; ctx.lineWidth = k;
    ctx.fillRect(r.left * k, (r.top + dy) * k, r.width * k, r.height * k);
    ctx.strokeRect(r.left * k, (r.top + dy) * k, r.width * k, r.height * k);
    ctx.restore();
  }
  for (const h of main.querySelectorAll('h2')) {
    const { a, dy } = revealOf(h, now), r = h.getBoundingClientRect();
    if (a <= 0.003 || r.bottom < 0 || r.top > window.innerHeight) continue;
    const g = ctx.createLinearGradient(r.left * k, 0, r.right * k, 0);
    g.addColorStop(0, GOLD); g.addColorStop(1, 'rgba(201,164,106,0)');
    ctx.save(); ctx.globalAlpha = a; ctx.fillStyle = g;
    ctx.fillRect(r.left * k, (r.bottom - 1 + dy) * k, r.width * k, Math.max(1, k));
    ctx.restore();
  }
  paintText(ctx, main, k, now, '.btn-row, .cue, button');
  if (flash > 0) { ctx.save(); ctx.globalAlpha = flash; ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height); ctx.restore(); }
}

/** The viewer's title and its paint panel: name of the paint and the row of swatches. */
function paintViewer(ctx, k, now) {
  paintText(ctx, document.querySelector('.viewer__topbar'), k, now, 'button');
  const panel = document.querySelector('.viewer__controls'), p = panel.getBoundingClientRect();
  ctx.save();
  ctx.fillStyle = 'rgba(10,10,14,0.8)'; ctx.strokeStyle = 'rgba(255,255,255,0.08)'; ctx.lineWidth = k;
  ctx.beginPath(); ctx.roundRect(p.left * k, p.top * k, p.width * k, p.height * k, 16 * k); ctx.fill(); ctx.stroke();
  ctx.restore();
  paintText(ctx, panel, k, now, 'button');
  for (const s of panel.querySelectorAll('.viewer__swatch')) {
    const r = s.getBoundingClientRect();
    if (!r.width) continue;
    const cx = (r.left + r.width / 2) * k, cy = (r.top + r.height / 2) * k, rad = (r.width / 2) * k;
    ctx.save();
    ctx.fillStyle = getComputedStyle(s).backgroundColor;
    ctx.beginPath(); ctx.arc(cx, cy, rad - 2 * k, 0, Math.PI * 2); ctx.fill();
    if (s.classList.contains('is-active')) {
      ctx.shadowColor = 'rgba(201,164,106,0.45)'; ctx.shadowBlur = 12 * k;
      ctx.strokeStyle = GOLD; ctx.lineWidth = 2 * k;
      ctx.beginPath(); ctx.arc(cx, cy, rad - k, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.restore();
  }
}

const black = (ctx, a) => { if (a > 0) { ctx.save(); ctx.globalAlpha = clamp01(a); ctx.fillStyle = '#000'; ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height); ctx.restore(); } };

/* ============ Encoding: H.264 in an MP4 ============ */
async function makeEncoder(width, height, fps) {
  if (!('VideoEncoder' in window)) throw new Error('This browser cannot encode video. Use Chrome or Edge.');
  const { Muxer, ArrayBufferTarget } = await import(MUXER_URL);
  const bitrate = Math.round(width * height * fps * 0.14);
  let config = null;
  for (const codec of ['avc1.640034', 'avc1.4d0034', 'avc1.42e034']) {     // High, Main, then Baseline profile
    const c = { codec, width, height, bitrate, framerate: fps, avc: { format: 'avc' } };
    if ((await VideoEncoder.isConfigSupported(c)).supported) { config = c; break; }
  }
  if (!config) throw new Error(`This browser cannot encode H.264 at ${width}x${height}. Try a smaller &width.`);
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
      while (encoder.encodeQueueSize > 4) await new Promise((r) => setTimeout(r, 2));
    },
    async finish() {
      await encoder.flush();
      if (failure) throw failure;
      muxer.finalize();
      return new Blob([target.buffer], { type: 'video/mp4' });
    },
  };
}

/* ============ Progress panel (on the page only; it is not part of the video) ============ */
function makePanel() {
  const el = document.createElement('div');
  el.style.cssText = 'position:fixed;left:16px;bottom:16px;z-index:300;padding:14px 18px;background:rgba(10,10,14,0.92);border:1px solid #333;border-radius:12px;color:#ddd;font:13px/1.5 "Exo 2",system-ui,sans-serif;max-width:min(420px,calc(100vw - 32px));cursor:auto';
  document.body.appendChild(el);
  return (html) => { el.innerHTML = html; };
}

/* ============ The render ============ */
export async function renderVideo(story, params) {
  const show = makePanel();
  try {
    const fps = Math.max(1, +(params.get('fps') || 60)), dt = 1 / fps;
    const withStory = params.get('story') !== '0', withViewer = params.get('viewer') !== '0';
    const W = even(+(params.get('width') || 1920)), k = W / window.innerWidth, H = even(window.innerHeight * k);
    show('Rendering video: loading…');
    await story.whenReady();
    await document.fonts.ready;
    const out = document.createElement('canvas');
    out.width = W; out.height = H;
    const ctx = out.getContext('2d');
    const enc = await makeEncoder(W, H, fps);
    let frames = 0, now = 0;
    const t0 = performance.now();
    const progress = (what) => {
      if (frames % 15) return;
      const rate = frames / ((performance.now() - t0) / 1000);
      show(`Rendering video: ${what}<br>${(frames / fps).toFixed(1)} s of video · ${W}×${H} at ${fps} fps · ${rate.toFixed(1)} frames/s<br><span style="color:#888">Keep this tab in front until it finishes.</span>`);
    };

    if (withStory) {
      story.setPixelRatio(k);
      story.start();
      let fade = -1;
      for (;;) {
        story.step(dt);
        now += dt;
        ctx.drawImage(story.canvas, 0, 0, W, H);
        paintStory(ctx, k, now, story.flash());
        if (story.finished) fade = fade < 0 ? 0 : fade + dt;
        if (withViewer && fade >= 0) black(ctx, fade / FADE);
        await enc.add(out);
        frames++; progress('the story');
        await tick();
        if (fade >= (withViewer ? FADE : 0)) break;
      }
    }

    if (withViewer) {
      show('Rendering video: opening the 3D viewer…');
      await viewerApi.openManual(k);
      viewerApi.step(dt);
      let next = 0;
      for (let t = 0; t < VIEWER_SECONDS; t += dt) {
        while (next < VIEWER_SCRIPT.length && VIEWER_SCRIPT[next][0] <= t) VIEWER_SCRIPT[next++][1](viewerApi);
        viewerApi.step(dt);
        now += dt;
        ctx.drawImage(viewerApi.canvas, 0, 0, W, H);
        paintViewer(ctx, k, now);
        black(ctx, Math.max(withStory ? 1 - t / FADE : 0, (t - (VIEWER_SECONDS - FADE)) / FADE));
        await enc.add(out);
        frames++; progress('the 3D viewer');
        await tick();
      }
    }

    show('Rendering video: finishing the file…');
    const blob = await enc.finish();
    const url = URL.createObjectURL(blob);
    window.__renderedVideo = { url, size: blob.size, frames, fps, width: W, height: H };
    const name = `roadster-demo-${W}x${H}.mp4`;
    const a = document.createElement('a');
    a.href = url; a.download = name; a.click();
    show(`Done: ${(frames / fps).toFixed(1)} s, ${(blob.size / 1e6).toFixed(1)} MB.<br><a href="${url}" download="${name}" style="color:${GOLD}">Download ${name}</a> (if it did not save already)`);
  } catch (err) {
    console.error(err);
    show(`Render failed: ${err.message}`);
  }
}
