# Roadster: the ramp stunt, in 3D

A scroll-driven 3D website that recreates the ramp stunt from Tesla's Roadster event. As you scroll, the car drives up the wall, leaves the ramp upside down, rolls upright on thrusters and lands on cold-gas jets. After that comes a walk round the design, the body lifting off the chassis, the wheels and the cockpit.

**Live:** [roadster-v2.vercel.app](https://roadster-v2.vercel.app)

Built with [Three.js](https://threejs.org) and plain JavaScript, with no framework or build step.

- **A scroll-driven story:** the page's scroll position drives everything. A hand-tuned camera path runs through each scene, and the car's motion, thrusters, smoke and lighting are all functions of how far you've scrolled.
- **A rigged car:** the downloaded model is re-rigged in code. Its wheels are cut out and re-hung on new axles, the hood is separated from the bodywork, and the body is split into layers that lift off a rolling chassis.
- **A 3D viewer:** orbit the car, change the paint, fire the thrusters and take it apart.
- **A video renderer:** `render.html` records the site frame by frame into an MP4 in the browser, so nothing stutters however heavy the scene is.

## Run it locally

```bash
npm start
```

Then open http://localhost:5174. Useful options:

- `?debug&u=4.5` jumps to a point in the story.
- `?demo` plays the story by itself.
- `/render.html` renders the whole thing to a video.

## Credits

3D models, both CC BY 4.0, with materials modified:

- ["teala roadster 2027"](https://sketchfab.com/3d-models/teala-roadster-2027-22a1e0d904644f00849a253bc904cf01) by yarifmx
- ["Tesla Roadster fly wheels"](https://sketchfab.com/3d-models/tesla-roadster-fly-wheels-31a0476f5fd14fc282e799b8ae4ae4f3) by minchou19

**Unofficial fan project.** Not affiliated with, endorsed by, or sponsored by Tesla, Inc. "Tesla" and "Roadster" are trademarks of Tesla, Inc. The stunt is a 3D recreation, and the chassis hardware shown is illustrative.
