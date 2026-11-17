// js/render-stage.js — render.html: runs the site in a frame of a fixed size and saves the video it renders.
// The frame is laid out at exactly the video size (1920×1080 unless &size= says otherwise) and only shown
// scaled down, so the video is full-frame whatever the shape of this window.
// The page inside is laid out at this screen's own width, so it looks exactly as it does in a browser here
// (with Windows display scaling at 125%, a 1920-pixel screen lays pages out 1536 wide), then drawn up to the video size.
//   render.html                    the whole page, then the 3D viewer, 1920×1080 at 30 fps
//   render.html?layout=1920        lay the page out at another width
//   render.html?size=1080x1350     another size (here 4:5, which the site lays out like a phone)
//   render.html?fps=60             any of the options in js/render.js and the demo's in js/main.js
const params = new URLSearchParams(location.search);
const autoSave = !params.has('nosave');            // &nosave: keep the file here instead of downloading it
params.delete('nosave');
const [W, H] = (params.get('size') || '1920x1080').split('x').map((n) => Math.max(2, Math.round(+n / 2) * 2));
params.delete('size');
const layoutW = Math.round(Math.min(W, +params.get('layout') || window.screen.width || W));
const layoutH = Math.round((layoutW * H) / W);
params.delete('layout');
params.set('render', '');
params.set('scale', String(W / layoutW));

const box = document.getElementById('box'), status = document.getElementById('status');
const meter = document.getElementById('meter'), link = document.getElementById('link');
const frame = document.createElement('iframe');
frame.width = layoutW; frame.height = layoutH;
frame.title = 'Site being rendered';
frame.src = `index.html?${params.toString()}`;
box.appendChild(frame);

function fit() {
  const stage = box.parentElement.getBoundingClientRect();
  const s = Math.min(stage.width / layoutW, stage.height / layoutH, 1);
  frame.style.transform = `scale(${s})`;
  box.style.width = `${layoutW * s}px`;
  box.style.height = `${layoutH * s}px`;
}
window.addEventListener('resize', fit);
fit();

window.addEventListener('message', (e) => {
  if (e.origin !== location.origin || e.source !== frame.contentWindow) return;
  const m = e.data || {};
  if (m.type === 'progress') {
    status.textContent = `Rendering ${W}×${H}: ${m.text}`;
    meter.style.width = `${(m.fraction * 100).toFixed(1)}%`;
    document.title = `${Math.round(m.fraction * 100)}% · Roadster render`;
  } else if (m.type === 'done') {
    const url = URL.createObjectURL(m.blob);
    status.textContent = `Done: ${m.seconds.toFixed(1)} s of video, ${(m.blob.size / 1e6).toFixed(1)} MB.`;
    meter.style.width = '100%';
    document.title = 'Done · Roadster render';
    link.innerHTML = '';
    const a = document.createElement('a');
    a.className = 'save'; a.href = url; a.download = m.name; a.textContent = `Download ${m.name}`;
    link.appendChild(a);
    if (autoSave) a.click();
    window.__renderedVideo = { url, size: m.blob.size, seconds: m.seconds, width: W, height: H };
  } else if (m.type === 'error') {
    status.textContent = `Render failed: ${m.message}`;
    document.title = 'Failed · Roadster render';
  }
});
