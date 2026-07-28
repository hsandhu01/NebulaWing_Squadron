/* ==========================================================================
   GLBKit — shared GLTF loader/instancer for the whole game.
   Loads each .glb once (cached), then hands out cheap clones that share
   geometry + textures. Instances are THREE.Group wrappers that fill in
   asynchronously and are normalized (centered, scaled, oriented).

   Because clones share cached geometry/materials, callers must NOT dispose
   them — game.js's dispose() skips Groups (no .geometry) so this is automatic.
   ========================================================================== */
window.GLBKit = (() => {
  'use strict';
  const cache = {};     // url -> gltf.scene
  const waiters = {};   // url -> [cb]
  let requested = 0, finished = 0, onProgress = null;

  const tick = () => { if (onProgress) onProgress(finished, requested); };

  function load(url, cb) {
    if (cache[url]) { if (cb) cb(cache[url]); return; }
    (waiters[url] = waiters[url] || []).push(cb);
    if (waiters[url].length > 1) return;          // load already in flight
    if (!THREE.GLTFLoader) { console.error('[GLBKit] GLTFLoader missing'); return; }
    requested++; tick();
    const settle = () => { finished++; tick(); };
    new THREE.GLTFLoader().load(url, (gltf) => {
      cache[url] = gltf.scene;
      const cbs = waiters[url] || []; waiters[url] = [];
      cbs.forEach((f) => f && f(gltf.scene));
      settle();
    }, undefined, (e) => { console.error('[GLBKit] load failed', url, e); settle(); });
  }

  // progress reporting for the preloader
  function setProgress(fn) { onProgress = fn; tick(); }
  function stats() { return { finished, requested, done: requested > 0 && finished >= requested }; }

  // Returns a Group that fills with a centered, scaled, oriented clone once
  // the model is available. opts: { rotY, rotX, targetLen, scale, onReady }
  function instance(url, opts) {
    opts = opts || {};
    const group = new THREE.Group();
    group.userData.ready = false;
    load(url, (scene) => {
      const inst = scene.clone(true);
      const box = new THREE.Box3().setFromObject(inst);
      const size = new THREE.Vector3(); box.getSize(size);
      const center = new THREE.Vector3(); box.getCenter(center);
      inst.position.set(-center.x, -center.y, -center.z);   // recenter on origin

      const holder = new THREE.Group();
      holder.add(inst);
      if (opts.rotY) holder.rotation.y = opts.rotY;
      if (opts.rotX) holder.rotation.x = opts.rotX;
      const maxDim = Math.max(size.x, size.y, size.z) || 1;
      const scale = opts.targetLen ? (opts.targetLen / maxDim) : (opts.scale || 1);
      holder.scale.setScalar(scale);

      group.add(holder);
      group.userData.ready = true;
      if (opts.onReady) opts.onReady(group);
    });
    return group;
  }

  // Pooled variant for high-churn objects (bullets). Reuses retired Groups
  // instead of cloning a fresh model for every shot.
  const pools = {};   // key -> [Group]
  function acquire(url, opts) {
    opts = opts || {};
    const key = url + '|' + (opts.rotY || 0) + '|' + (opts.targetLen || opts.scale || 1);
    const pool = pools[key] || (pools[key] = []);
    const g = pool.pop();
    if (g) {
      g.visible = true;
      g.position.set(0, 0, 0);
      g.rotation.set(0, 0, 0);
      g.userData.poolKey = key;
      return g;
    }
    const fresh = instance(url, opts);
    fresh.userData.poolKey = key;
    return fresh;
  }
  function release(g) {
    const key = g.userData && g.userData.poolKey;
    if (!key) return false;
    if (g.parent) g.parent.remove(g);
    const pool = pools[key] || (pools[key] = []);
    if (pool.length < 40) { pool.push(g); return true; }
    return false;   // pool full: let it be garbage collected
  }

  return { load, instance, acquire, release, setProgress, stats };
})();
