/* =========================================================================
   STAR WING — a Star Fox–style on-rails shooter
   Built with Three.js (r128). Forward is -Z. The world rushes toward +Z.
   ========================================================================= */

(() => {
  'use strict';

  // ---------------------------------------------------------------------
  // Constants & tunables
  // ---------------------------------------------------------------------
  const PLAY = { x: 11, yMin: -5.5, yMax: 7.5 }; // steering bounds
  const SHIP_Z = 6;            // ship sits a bit in front of camera origin
  const CAM_Z = 20;            // camera pulled back so the ship reads small on screen
  const SPAWN_Z = -240;        // where things appear far ahead
  const DESPAWN_Z = 14;        // behind the camera
  const BASE_SPEED = 60;       // world scroll units / sec
  const LASER_SPEED = 320;
  const FIRE_COOLDOWN = 0.14;

  // ---------------------------------------------------------------------
  // DOM
  // ---------------------------------------------------------------------
  const $ = (id) => document.getElementById(id);
  const ui = {
    hud: $('hud'), title: $('title'), gameover: $('gameover'),
    score: $('score'), hiscore: $('hiscore'), wave: $('wave'),
    shield: $('shield-fill'), boost: $('boost-fill'),
    combo: $('combo'), rollFlash: $('roll-flash'), nearMiss: $('near-miss'),
    comms: $('comms'), commsMsg: $('comms-msg'),
    villain: $('villain'), villainMsg: $('villain-msg'), villainWeapon: $('villain-weapon'),
    bossWrap: $('boss-wrap'), bossFill: $('boss-fill'), bossStage: $('boss-stage'), reticle: $('reticle'),
    warnArrows: $('warn-arrows'), sectorClear: $('sector-clear'),
    weaponIcon: $('weapon-icon'), weaponName: $('weapon-name'),
    finalScore: $('final-score'), finalHi: $('final-hi'),
    startBtn: $('start-btn'), restartBtn: $('restart-btn'),
  };

  // ---------------------------------------------------------------------
  // Renderer / scene / camera
  // ---------------------------------------------------------------------
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  // sRGB output so PBR hull/lighting reads with proper punch. Every colour
  // texture below is tagged sRGB so it round-trips correctly (untagged maps
  // would wash out under sRGB output).
  renderer.outputEncoding = THREE.sRGBEncoding;
  $('game').appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x05060f);
  scene.fog = new THREE.FogExp2(0x05060f, 0.0065);

  const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 600);
  camera.position.set(0, 4.6, CAM_Z);
  camera.lookAt(0, 3.4, -30);

  // lights
  scene.add(new THREE.AmbientLight(0x4466aa, 0.9));
  const key = new THREE.DirectionalLight(0xbfefff, 1.1);
  key.position.set(-6, 12, 8);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0xff7bd5, 0.45);
  rim.position.set(8, -4, -10);
  scene.add(rim);

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  // ---------------------------------------------------------------------
  // Audio (tiny WebAudio synth — no asset files needed)
  // ---------------------------------------------------------------------
  const Sound = (() => {
    let ctx = null, noiseBuf = null;
    const ensure = () => { if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)(); return ctx; };
    function blip(freq, dur, type = 'square', gain = 0.06, slideTo = null) {
      try {
        const c = ensure();
        const o = c.createOscillator(), g = c.createGain();
        o.type = type; o.frequency.value = freq;
        if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, c.currentTime + dur);
        g.gain.setValueAtTime(gain, c.currentTime);
        g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + dur);
        o.connect(g); g.connect(c.destination);
        o.start(); o.stop(c.currentTime + dur);
      } catch (e) { /* audio not ready */ }
    }
    // filtered white-noise burst for explosions / impacts
    function noiseBurst(dur, startFreq, gain) {
      try {
        const c = ensure();
        if (!noiseBuf) {
          noiseBuf = c.createBuffer(1, c.sampleRate, c.sampleRate);
          const d = noiseBuf.getChannelData(0);
          for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
        }
        const s = c.createBufferSource(); s.buffer = noiseBuf;
        const f = c.createBiquadFilter(); f.type = 'lowpass';
        f.frequency.setValueAtTime(startFreq, c.currentTime);
        f.frequency.exponentialRampToValueAtTime(80, c.currentTime + dur);
        const g = c.createGain();
        g.gain.setValueAtTime(gain, c.currentTime);
        g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + dur);
        s.connect(f); f.connect(g); g.connect(c.destination);
        s.start(); s.stop(c.currentTime + dur);
      } catch (e) {}
    }
    // ---- sampled sound pack (assets/sfx) ----------------------------------
    // Decoded once into buffers; each play() spawns a cheap BufferSource.
    // Any clip that hasn't loaded yet just no-ops, so audio never blocks play.
    const SFX = {
      laser: 'player_laser', laserUp: 'player_laser_upgraded', plasma: 'enemy_plasma',
      missile: 'missile_launch', small: 'explosion_small', large: 'explosion_large',
      shieldHit: 'shield_hit', puShield: 'pickup_shield', puLaser: 'pickup_laser',
      puBomb: 'pickup_bomb', roll: 'barrel_roll', lockOn: 'lock_on_warning',
      menu: 'menu_select', victory: 'victory_stinger', gameOver: 'game_over_stinger',
      engine: 'engine_loop',
    };
    const buffers = {};
    let loaded = false;
    function loadPack() {
      if (loaded) return; loaded = true;
      const c = ensure();
      Object.entries(SFX).forEach(([key, file]) => {
        fetch(`assets/sfx/${file}.wav`)
          .then((r) => r.arrayBuffer())
          .then((ab) => new Promise((res, rej) => c.decodeAudioData(ab, res, rej)))
          .then((buf) => { buffers[key] = buf; })
          .catch(() => {});   // missing clip = silent, never fatal
      });
    }
    function play(key, gain = 0.7, rate = 1) {
      try {
        const c = ensure(); const buf = buffers[key];
        if (!buf) return;
        const s = c.createBufferSource(); s.buffer = buf;
        s.playbackRate.value = rate;
        const g = c.createGain(); g.gain.value = gain;
        s.connect(g); g.connect(c.destination);
        s.start();
      } catch (e) {}
    }

    // continuous engine hum, pitched/loudened by throttle
    let engineSrc = null, engineGain = null;
    function engineStart() {
      try {
        const c = ensure(); const buf = buffers.engine;
        if (!buf || engineSrc) return;
        engineSrc = c.createBufferSource(); engineSrc.buffer = buf; engineSrc.loop = true;
        engineGain = c.createGain(); engineGain.gain.value = 0.14;
        engineSrc.connect(engineGain); engineGain.connect(c.destination);
        engineSrc.start();
      } catch (e) {}
    }
    function engineStop() {
      try { if (engineSrc) { engineSrc.stop(); engineSrc.disconnect(); } } catch (e) {}
      engineSrc = null; engineGain = null;
    }
    function engineThrottle(t) {          // t: 0 cruise .. 1 full boost
      try {
        if (!engineSrc) return;
        engineSrc.playbackRate.value = 0.9 + t * 0.5;
        engineGain.gain.value = 0.12 + t * 0.12;
      } catch (e) {}
    }

    return {
      context: ensure,
      resume: () => { try { ensure().resume(); loadPack(); } catch (e) {} },
      load: loadPack,
      engineStart, engineStop, engineThrottle,
      // event API kept identical to the old synth so every call site upgrades
      laser:  () => play('laser', 0.5, 0.98 + Math.random() * 0.06),
      laserUp:() => play('laserUp', 0.5, 0.98 + Math.random() * 0.06),
      plasma: () => play('plasma', 0.45),
      missile:() => play('missile', 0.6),
      hit:    () => play('small', 0.35, 1.25 + Math.random() * 0.15),
      boom:   () => play('small', 0.75, 0.95 + Math.random() * 0.1),
      bigBoom:() => play('large', 0.9),
      ring:   () => play('puShield', 0.6),
      roll:   () => play('roll', 0.6),
      hurt:   () => play('shieldHit', 0.7),
      comms:  () => play('menu', 0.3, 1.6),
      chime:  () => play('puLaser', 0.6),
      alarm:  () => play('lockOn', 0.7),
      menu:   () => play('menu', 0.5),
      puShield:() => play('puShield', 0.7),
      puLaser: () => play('puLaser', 0.7),
      puBomb:  () => play('puBomb', 0.7),
      victory: () => play('victory', 0.8),
      gameOver:() => play('gameOver', 0.85),
    };
  })();

  // procedural soundtrack: kick / hats / bass / arp on a 25ms-lookahead sequencer
  const Music = (() => {
    let ctx = null, master = null, noiseBuf = null, timer = null, step = 0, nextTime = 0, bossMode = false;
    const SPB = 60 / 132 / 2;  // one 8th note at 132 BPM
    const bassNormal = [55, 55, 65.41, 55, 49, 49, 82.41, 49];      // A A C A G G E G
    const bassBoss   = [55, 55, 58.27, 55, 55, 58.27, 51.91, 49];   // chromatic menace
    const arpNotes   = [220, 261.63, 329.63, 392];
    function kick(t) {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.setValueAtTime(150, t);
      o.frequency.exponentialRampToValueAtTime(40, t + 0.1);
      g.gain.setValueAtTime(0.8, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
      o.connect(g); g.connect(master); o.start(t); o.stop(t + 0.13);
    }
    function hat(t) {
      const s = ctx.createBufferSource(); s.buffer = noiseBuf;
      const f = ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 7000;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.12, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.04);
      s.connect(f); f.connect(g); g.connect(master); s.start(t); s.stop(t + 0.05);
    }
    function bass(t, freq) {
      const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = freq;
      const f = ctx.createBiquadFilter(); f.type = 'lowpass';
      f.frequency.setValueAtTime(620, t);
      f.frequency.exponentialRampToValueAtTime(200, t + SPB * 0.9);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.22, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + SPB * 0.95);
      o.connect(f); f.connect(g); g.connect(master); o.start(t); o.stop(t + SPB);
    }
    function arp(t, freq) {
      const o = ctx.createOscillator(); o.type = 'square'; o.frequency.value = freq;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.045, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.15);
      o.connect(g); g.connect(master); o.start(t); o.stop(t + 0.16);
    }
    function schedule() {
      try {
        while (nextTime < ctx.currentTime + 0.12) {
          const s = step % 8;
          if (s === 0 || s === 4) kick(nextTime);
          hat(nextTime + SPB / 2);
          bass(nextTime, (bossMode ? bassBoss : bassNormal)[s]);
          if (s === 2 || s === 6) arp(nextTime, arpNotes[(step >> 1) % 4] * (bossMode ? 0.5 : 1));
          step++; nextTime += SPB;
        }
      } catch (e) {}
    }
    return {
      start(sharedCtx) {
        this.stop();
        ctx = sharedCtx;
        if (!master) {
          master = ctx.createGain(); master.gain.value = 0.2; master.connect(ctx.destination);
          noiseBuf = ctx.createBuffer(1, ctx.sampleRate / 2, ctx.sampleRate);
          const d = noiseBuf.getChannelData(0);
          for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
        }
        step = 0; nextTime = ctx.currentTime + 0.05; bossMode = false;
        timer = setInterval(schedule, 25);
      },
      stop() { if (timer) { clearInterval(timer); timer = null; } },
      setBoss(b) { bossMode = b; },
    };
  })();

  // ---------------------------------------------------------------------
  // Starfield + speed streaks
  // ---------------------------------------------------------------------
  function makeStarfield(count, spread) {
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(count * 3);
    // ring-shaped placement: stars stay clear of the flight corridor, otherwise
    // ones that drift past the camera balloon into big white squares
    const inner = 34, outer = spread * 0.5;
    for (let i = 0; i < count; i++) {
      const ang = Math.random() * Math.PI * 2;
      const rad = inner + Math.random() * (outer - inner);
      pos[i*3]   = Math.cos(ang) * rad;
      pos[i*3+1] = Math.sin(ang) * rad * 0.6 + 2;
      pos[i*3+2] = -Math.random() * 500;
    }
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({ color: 0x9fd8ff, size: 0.5, transparent: true, opacity: 0.9, sizeAttenuation: true });
    return new THREE.Points(geo, mat);
  }
  const stars = makeStarfield(900, 280);
  scene.add(stars);

  // ---------------------------------------------------------------------
  // Environments — a far-plane backdrop so each stretch of the run reads as a
  // place instead of an empty void. Cycles as the waves climb.
  // ---------------------------------------------------------------------
  const ENVIRONMENTS = {
    nebula:   { img: 'assets/bg_nebula.jpg',   name: 'VEIL NEBULA',        fog: 0x120a2a, grid: 0x2a2350 },
    planet:   { img: 'assets/bg_planet.jpg',   name: 'ORBITAL APPROACH',   fog: 0x0b1430, grid: 0x14525e },
    asteroid: { img: 'assets/bg_asteroid.jpg', name: 'ASTEROID BELT',      fog: 0x0a1020, grid: 0x1d3a4a },
    fleet:    { img: 'assets/bg_fleet.jpg',    name: 'FLEET GRAVEYARD',    fog: 0x180b18, grid: 0x3a2030 },
  };
  const ENV_ORDER = ['planet', 'asteroid', 'nebula', 'fleet'];

  // big curved plane far down the corridor; parallaxes slightly with the ship
  // Decode every backdrop up front. Lazily creating the texture on first use
  // meant a new environment showed an empty void for its first seconds.
  const bgTexCache = {};
  {
    const tl = new THREE.TextureLoader();
    for (const [key, env] of Object.entries(ENVIRONMENTS)) {
      const t = tl.load(env.img);
      t.encoding = THREE.sRGBEncoding;
      bgTexCache[key] = t;
    }
  }
  // Sized to over-fill the frustum at its depth: at 440 units from the camera
  // with a 70° FOV the visible height is ~616, so 1500x844 (16:9) covers the
  // view plus room for parallax drift. Undersized, it reads as a floating
  // picture hanging in space rather than the sky behind everything.
  const BACKDROP_Z = -420;
  const backdrop = new THREE.Mesh(
    new THREE.PlaneGeometry(1500, 844),
    new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, fog: false })
  );
  backdrop.position.set(0, 24, BACKDROP_Z);
  backdrop.renderOrder = -10;
  scene.add(backdrop);
  let currentEnv = null;

  function setEnvironment(key, instant) {
    const env = ENVIRONMENTS[key];
    if (!env || currentEnv === key) return;
    currentEnv = key;
    backdrop.material.map = bgTexCache[key];
    backdrop.material.needsUpdate = true;
    backdrop._fadeTo = 1;
    if (instant) backdrop.material.opacity = 1;
    scene.fog.color.setHex(env.fog);
    scene.background = new THREE.Color(env.fog);
    grid.material.color.setHex(env.grid);
  }

  // Faint moving ground grid for speed/depth. Kept dim and fog-faded so it
  // reads as a horizon rather than a test-arena floor.
  const grid = new THREE.GridHelper(800, 60, 0x14525e, 0x0d2b33);
  grid.position.set(0, PLAY.yMin - 5.5, -100);
  grid.material.transparent = true;
  grid.material.opacity = 0.34;
  grid.material.depthWrite = false;
  grid.material.fog = true;          // let scene fog swallow it toward the horizon
  scene.add(grid);

  // ---------------------------------------------------------------------
  // Player ship — mid-poly model lives in ship.js (shared with the viewer page)
  // ---------------------------------------------------------------------
  let shipScheme = localStorage.getItem('nebulawing_ship') || 'blue';
  if (!window.SHIP_SCHEMES[shipScheme]) shipScheme = 'blue';   // drop stale/removed schemes (e.g. cosmic)
  localStorage.setItem('nebulawing_ship', shipScheme);
  let ship = window.buildNebulaShip(THREE, shipScheme);
  ship.position.set(0, 1.5, SHIP_Z);
  scene.add(ship);

  // free a ship's GPU resources — the mid-poly model builds its own textures,
  // materials and geometries per instance, so releasing them avoids a leak
  // each time the player switches fighter colour.
  function disposeShip(obj) {
    obj.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      const mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
      for (const m of mats) { if (m.map) m.map.dispose(); m.dispose(); }
    });
  }

  // active hull's handling/durability/firepower profile
  const DEFAULT_STATS = { agility: 1, armour: 1, boost: 1, power: 1 };
  let shipStats = (window.SHIP_SCHEMES[shipScheme] || {}).stats || DEFAULT_STATS;

  function applyShipScheme(name) {
    shipStats = (window.SHIP_SCHEMES[name] || {}).stats || DEFAULT_STATS;
    shipScheme = name;
    localStorage.setItem('nebulawing_ship', name);
    const px = ship.position.x, py = ship.position.y;
    scene.remove(ship);
    if (ship.userData.disposable !== false) disposeShip(ship);  // GLB shares cached resources
    ship = window.buildNebulaShip(THREE, name);
    ship.position.set(px, py, SHIP_Z);
    scene.add(ship);
  }

  // engine point light following ship
  const engineLight = new THREE.PointLight(0x38e8ff, 1.2, 16);
  scene.add(engineLight);

  // rim light that trails the ship so its silhouette separates from the grid
  const shipRim = new THREE.PointLight(0x8fd8ff, 1.5, 22);
  scene.add(shipRim);

  // ---------------------------------------------------------------------
  // Object pools
  // ---------------------------------------------------------------------
  // player weapon tiers (Set 1 art) — the power-up ladder swaps between these
  const WEAPONS = [
    null,
    { name: 'PULSE PISTOL', icon: 'assets/wpn_pistol.png' },
    { name: 'STORM RIFLE',  icon: 'assets/wpn_rifle.png' },
    { name: 'RAIL CANNON',  icon: 'assets/wpn_cannon.png' },
  ];
  const VILLAIN_WEAPONS = ['assets/wpn_smg.png', 'assets/wpn_launcher.png', 'assets/wpn_sword.png'];

  const lasers = [];      // player projectiles
  const enemies = [];     // enemy ships
  const enemyShots = [];  // enemy projectiles
  const asteroids = [];
  const rings = [];
  const particles = [];   // explosion bits
  const powerups = [];
  const wingmen = [];     // temporary allied fighters called in by a pickup
  let boss = null;

  // only explosion debris still uses a primitive; every ship, shot and pickup
  // is a 3D GLB model (see GLBKit)
  const sharedGeo = {
    bit: new THREE.BoxGeometry(0.3, 0.3, 0.3),
  };

  // Enemy roster — the Crimson Eclipse is the common fighter, the Dreadstar a
  // tougher elite that appears once the waves ramp up. (Meshy hulls differ in
  // native facing, hence a per-type rotY so each one flies nose-first at you.)
  // Each role has its own silhouette + flight pattern so you can read intent
  // at a glance: small dark fighter = weaves, spiky star = elite that circles,
  // fast lean hull = scout that zigzags, glowing red = kamikaze charger.
  const ENEMY_TYPES = {
    scout:     { glb: 'assets/enemy.glb',           rotY: Math.PI/2, len: 3.0, hp: 1, score: 80,  hit: 1.5,
                 behavior: 'zigzag',   speed: 1.9, shoots: false },
    fighter:   { glb: 'assets/enemy.glb',           rotY: Math.PI/2, len: 3.8, hp: 2, score: 100, hit: 1.7,
                 behavior: 'weave',    speed: 1.0, shoots: true },
    intercept: { glb: 'assets/enemy_dreadstar.glb', rotY: 0,         len: 4.2, hp: 4, score: 220, hit: 2.2,
                 behavior: 'circle',   speed: 0.85, shoots: true },
    kamikaze:  { glb: 'assets/enemy.glb',           rotY: Math.PI/2, len: 3.4, hp: 2, score: 250, hit: 1.8,
                 behavior: 'kamikaze', speed: 1.5, shoots: false, tint: 0xff2a2a },
    elite:     { glb: 'assets/enemy_dreadstar.glb', rotY: 0,         len: 5.4, hp: 7, score: 350, hit: 2.6,
                 behavior: 'bomber',   speed: 0.7, shoots: true, volley: 3 },
  };

  // preload gameplay GLBs so the first spawn/shot already has a mesh
  ['assets/enemy.glb', 'assets/enemy_dreadstar.glb', 'assets/enemy_dreadnought.glb',
   'assets/proj_cannon.glb', 'assets/proj_boss_orb.glb', 'assets/proj_spear.glb',
   'assets/proj_blue2.glb', 'assets/proj_spear2.glb', 'assets/ship_cosmic.glb',
   'assets/meteor_cube.glb', 'assets/meteor_infernal.glb',
   'assets/pu_ember.glb', 'assets/pu_shield_aegis.glb', 'assets/pu_omega.glb',
   'assets/wing_azure.glb', 'assets/wing_blaze.glb']
    .forEach((u) => GLBKit.load(u));

  // one shared material for every kamikaze warning glow (never disposed)
  let kamikazeWarnMat = null;
  function buildEnemy(typeName) {
    const t = ENEMY_TYPES[typeName] || ENEMY_TYPES.fighter;
    const e = GLBKit.instance(t.glb, { rotY: t.rotY, targetLen: t.len });
    e._type = t;
    if (t.behavior === 'kamikaze') {
      if (!kamikazeWarnMat) {
        kamikazeWarnMat = new THREE.SpriteMaterial({
          map: glowTex, color: 0xff2020, transparent: true, opacity: 0.85,
          depthWrite: false, blending: THREE.AdditiveBlending,
        });
      }
      const warn = new THREE.Sprite(kamikazeWarnMat);   // shared: safe to drop
      warn.scale.setScalar(3.2);
      warn.visible = false;
      e.add(warn);
      e._warn = warn;
    }
    return e;
  }

  // molten meteors — shoot them apart or dodge them
  const METEORS = ['assets/meteor_cube.glb', 'assets/meteor_infernal.glb'];
  function buildAsteroid() {
    const r = 1.4 + Math.random() * 2.4;
    const m = GLBKit.instance(METEORS[(Math.random() * METEORS.length) | 0], {
      rotY: Math.random() * Math.PI * 2,
      targetLen: r * 2.1,
    });
    m._radius = r;
    m._hp = Math.max(2, Math.round(r * 1.6));   // bigger rocks take more hits
    return m;
  }

  // power-up pickups: distinct shape + color per type
  // pickups: 3D models in a coloured glow cage so each type stays readable
  const PU_TYPES = {
    laser:   { glb: 'assets/pu_ember.glb', rotY: 0, len: 2.3, color: 0xff8c1a },  // Emberforge Crest
    shield:  { glb: 'assets/pu_shield_aegis.glb', rotY: 0, len: 2.1, color: 0x38e8ff },  // Aegis Cube
    bomb:    { glb: 'assets/pu_omega.glb', rotY: 0, len: 2.3, color: 0xffd23f },  // Omega Core
    wingman: { glb: 'assets/wing_azure.glb', rotY: -Math.PI/2, len: 2.6, color: 0x7cff8a },  // call in the squadron
  };
  const puCageGeo = new THREE.TorusGeometry(1.15, 0.07, 8, 20);

  // the boss is a colossal 3D dreadnought (same crimson hull, massive scale)
  const BOSS_LEN = 26;

  function buildRing() {
    const g = new THREE.Mesh(
      new THREE.TorusGeometry(3.2, 0.28, 10, 28),
      new THREE.MeshStandardMaterial({ color: 0xffd23f, emissive: 0x6b5500, emissiveIntensity: 0.7, metalness: 0.4, roughness: 0.3 })
    );
    return g;
  }

  // ---------------------------------------------------------------------
  // Game state
  // ---------------------------------------------------------------------
  const state = {
    running: false,
    score: 0,
    hi: Number(localStorage.getItem('nebulawing_hi') || 0),
    shield: 100,
    boost: 100,
    wave: 1,
    speed: BASE_SPEED,
    time: 0,
    fireTimer: 0,
    spawnTimer: 0,
    ringTimer: 2,
    combo: 0,
    comboTimer: 0,
    rolling: 0,        // >0 means invincible/deflecting
    rollDir: 1,
    rollCooldown: 0,
    invuln: 0,         // brief i-frames after taking a hit
    shake: 0,
    kills: 0,
    slowmo: 0,         // seconds of remaining time-dilation
    tally: { fired: 0, weak: 0, armour: 0, expired: 0 },   // balance instrumentation
    kick: 0,           // camera recoil from firing
    weapon: 1,         // laser level 1-3
    puTimer: 8,
    lastBossWave: 0,
    bossCooldown: 0,   // minimum breathing room between dreadnoughts
  };

  // control input
  const keys = Object.create(null);
  const KEYMAP = {
    ArrowUp:'up', KeyW:'up', ArrowDown:'down', KeyS:'down',
    ArrowLeft:'left', KeyA:'left', ArrowRight:'right', KeyD:'right',
    Space:'fire', KeyJ:'fire',
    ShiftLeft:'boost', ShiftRight:'boost',
    ControlLeft:'brake', ControlRight:'brake',
    KeyQ:'rollL', KeyE:'rollR',
  };
  window.addEventListener('keydown', (e) => {
    const a = KEYMAP[e.code];
    if (a) { e.preventDefault(); keys[a] = true; if (a === 'rollL') startRoll(-1); if (a === 'rollR') startRoll(1); }
  });
  window.addEventListener('keyup', (e) => { const a = KEYMAP[e.code]; if (a) keys[a] = false; });

  // ---- mouse flight controls ----------------------------------------
  // Moving the mouse flies the ship (its screen position maps straight onto
  // the play area). Hold left to fire, right-click to barrel roll, wheel to
  // boost/brake. Touching a key hands control straight back to the keyboard.
  const mouse = { active: false, tx: 0, ty: 1.5, wheel: 0 };

  function pointerToPlay(clientX, clientY) {
    const nx = (clientX / window.innerWidth) * 2 - 1;       // -1 .. 1
    const ny = 1 - (clientY / window.innerHeight) * 2;      // -1 .. 1 (up +)
    mouse.tx = THREE.MathUtils.clamp(nx * PLAY.x, -PLAY.x, PLAY.x);
    // map the vertical range onto the play box, biased to its middle
    const mid = (PLAY.yMax + PLAY.yMin) / 2, half = (PLAY.yMax - PLAY.yMin) / 2;
    mouse.ty = THREE.MathUtils.clamp(mid + ny * half, PLAY.yMin, PLAY.yMax);
  }

  window.addEventListener('mousemove', (e) => {
    pointerToPlay(e.clientX, e.clientY);
    if (state.running) {
      mouse.active = true;
      document.body.classList.add('mouse-flying');   // hide the OS cursor
      // park the reticle on the pointer so it reads as the aim point
      ui.reticle.style.left = e.clientX + 'px';
      ui.reticle.style.top = e.clientY + 'px';
    }
  });
  window.addEventListener('mousedown', (e) => {
    if (!state.running) return;              // let menu buttons work normally
    if (e.button === 0) { mouse.active = true; keys.fire = true; }
    else if (e.button === 2) { e.preventDefault(); startRoll(vel.x >= 0 ? 1 : -1); }
  });
  window.addEventListener('mouseup', (e) => { if (e.button === 0) keys.fire = false; });
  window.addEventListener('contextmenu', (e) => { if (state.running) e.preventDefault(); });
  window.addEventListener('wheel', (e) => {
    if (!state.running) return;
    mouse.wheel = e.deltaY < 0 ? 1 : -1;     // scroll up = boost, down = brake
    clearTimeout(mouse._wt);
    mouse._wt = setTimeout(() => { mouse.wheel = 0; }, 260);
  }, { passive: true });
  // any steering key returns control to the keyboard
  window.addEventListener('keydown', (e) => {
    const a = KEYMAP[e.code];
    if (a === 'left' || a === 'right' || a === 'up' || a === 'down') {
      mouse.active = false;
      document.body.classList.remove('mouse-flying');
      ui.reticle.style.left = ''; ui.reticle.style.top = '';   // back to centre
    }
  });

  // ---- touch controls ---------------------------------------------------
  // Phones never fire mousemove during a drag, so the mouse path can't serve
  // them. Dragging anywhere flies the ship (same mapping as the pointer),
  // guns are automatic, and roll/boost get thumb buttons.
  // Listeners are always registered (they simply never fire on a mouse-only
  // machine) and touch mode latches on the first real touch. Sniffing
  // capability at load misreports hybrid laptops and can't be tested.
  let touchMode = ('ontouchstart' in window) || navigator.maxTouchPoints > 0;
  if (touchMode) document.body.classList.add('touch');

  function enterTouchMode() {
    if (touchMode) return;
    touchMode = true;
    document.body.classList.add('touch');
  }

  function touchSteer(e) {
    const t = e.touches && e.touches[0];
    if (!t) return;
    enterTouchMode();
    if (!state.running) return;
    pointerToPlay(t.clientX, t.clientY);
    mouse.active = true;
  }
  // passive:false so we can stop the page scrolling/pull-to-refresh under us
  window.addEventListener('touchstart', touchSteer, { passive: false });
  window.addEventListener('touchmove', (e) => {
    touchSteer(e);
    if (state.running) e.preventDefault();
  }, { passive: false });

  // thumb buttons (only rendered on touch devices)
  function bindHoldButton(el, onDown, onUp) {
    if (!el) return;
    const down = (e) => { e.preventDefault(); e.stopPropagation(); enterTouchMode(); onDown(); };
    const up = (e) => { e.preventDefault(); e.stopPropagation(); if (onUp) onUp(); };
    // pointer events cover touch, pen and mouse in one path
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('pointerleave', up);
    el.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
  }

  // ship velocity for smooth steering & banking
  const vel = { x: 0, y: 0 };

  // ---------------------------------------------------------------------
  // Spawning
  // ---------------------------------------------------------------------
  // roles unlock as the waves climb so the player meets them one at a time
  function pickEnemyRole() {
    const w = state.wave;
    const pool = ['fighter', 'fighter', 'scout'];
    if (w >= 2) pool.push('scout', 'kamikaze');
    if (w >= 3) pool.push('intercept');
    if (w >= 4) pool.push('intercept', 'elite');
    if (w >= 6) pool.push('elite', 'kamikaze');
    return pool[(Math.random() * pool.length) | 0];
  }

  function spawnEnemy(forceType, at) {
    if (enemies.length >= 24) return;
    const typeName = forceType || pickEnemyRole();
    const e = buildEnemy(typeName);
    if (at) e.position.set(at.x, at.y, at.z);
    else e.position.set((Math.random()-0.5)*PLAY.x*1.6, 1 + (Math.random()-0.5)*8, SPAWN_Z);
    e._hp = e._type.hp;
    e._shootTimer = 1 + Math.random()*2;
    e._sway = Math.random() * Math.PI * 2;
    e._swaySpeed = 0.6 + Math.random()*0.8;
    e._anchorX = e.position.x;      // orbit centre for interceptors
    e._anchorY = e.position.y;
    scene.add(e);
    enemies.push(e);
    return e;
  }

  // recognisable attack sequences instead of pure random trickle
  function spawnFormation() {
    const kind = Math.random();
    const baseX = (Math.random() - 0.5) * PLAY.x;
    const baseY = 1 + (Math.random() - 0.5) * 5;
    if (kind < 0.45) {
      // V-wing: five craft in an arrowhead
      const role = state.wave >= 3 && Math.random() < 0.4 ? 'scout' : 'fighter';
      for (let i = -2; i <= 2; i++) {
        spawnEnemy(role, { x: baseX + i * 2.6, y: baseY + Math.abs(i) * 1.1, z: SPAWN_Z - Math.abs(i) * 7 });
      }
    } else if (kind < 0.75) {
      // line abreast sweep
      for (let i = 0; i < 4; i++) {
        spawnEnemy('fighter', { x: -PLAY.x * 0.7 + i * (PLAY.x * 0.45), y: baseY, z: SPAWN_Z - i * 3 });
      }
    } else {
      // bomber with scout escort
      spawnEnemy('elite', { x: baseX, y: baseY, z: SPAWN_Z });
      spawnEnemy('scout', { x: baseX - 4, y: baseY + 1.5, z: SPAWN_Z - 6 });
      spawnEnemy('scout', { x: baseX + 4, y: baseY + 1.5, z: SPAWN_Z - 6 });
    }
    radio('formation');
  }

  function spawnAsteroid() {
    const a = buildAsteroid();
    a.position.set((Math.random()-0.5)*PLAY.x*1.8, (Math.random()-0.5)*12 + 1, SPAWN_Z);
    a._spin = new THREE.Vector3((Math.random()-0.5)*2, (Math.random()-0.5)*2, (Math.random()-0.5)*2);
    scene.add(a);
    asteroids.push(a);
  }

  function spawnRing() {
    const r = buildRing();
    r.position.set((Math.random()-0.5)*PLAY.x, 1 + (Math.random()-0.5)*7, SPAWN_Z);
    r._passed = false;
    scene.add(r);
    rings.push(r);
  }

  function makePickup(type) {
    const t = PU_TYPES[type];
    const g = new THREE.Group();
    g.add(GLBKit.instance(t.glb, { rotY: t.rotY, targetLen: t.len }));
    // two glowing rings so pickups pop against the starfield
    const ringMat = new THREE.MeshBasicMaterial({ color: t.color, transparent: true, opacity: 0.85 });
    const r1 = new THREE.Mesh(puCageGeo, ringMat);
    const r2 = new THREE.Mesh(puCageGeo, ringMat);
    r2.rotation.y = Math.PI / 2;
    g.add(r1, r2);
    g._type = type;
    return g;
  }

  function spawnPowerup() {
    const r = Math.random();
    const type = r < 0.32 ? 'laser' : r < 0.60 ? 'shield' : r < 0.80 ? 'bomb' : 'wingman';
    const m = makePickup(type);
    m.position.set((Math.random()-0.5)*PLAY.x*1.4, 1 + (Math.random()-0.5)*7, SPAWN_Z);
    scene.add(m);
    powerups.push(m);
  }

  // ---------------------------------------------------------------------
  // Wingmen — a pickup calls in two allied fighters that fly formation,
  // auto-engage the nearest target for a while, then peel off and warp out.
  // ---------------------------------------------------------------------
  const WINGMAN_TIME = 22;                       // seconds on station
  const WINGMEN_SPEC = [
    { glb: 'assets/wing_azure.glb', slot: -5.2, name: 'DASH' },
    { glb: 'assets/wing_blaze.glb', slot:  5.2, name: 'SKYE' },
  ];

  function callWingmen() {
    // refresh the clock if they're already flying with you
    if (wingmen.length) { wingmen.forEach((w) => { w._life = WINGMAN_TIME; w._guard = 1; }); return; }
    WINGMEN_SPEC.forEach((spec, i) => {
      const w = GLBKit.instance(spec.glb, { rotY: -Math.PI / 2, targetLen: 3.6 });
      // start behind the camera so they scream past the player on arrival
      w.position.set(ship.position.x + spec.slot * 1.6, ship.position.y - 1.5, CAM_Z + 12);
      w._slotX = spec.slot;
      w._slotY = 0.6 + i * 0.5;
      w._life = WINGMAN_TIME;
      w._fireTimer = 0.4 + i * 0.2;
      w._guard = 1;                    // each soaks one incoming shot for you
      w._phase = 'flyby';
      scene.add(w);
      wingmen.push(w);
    });
    radio('wingman', true);
    Sound.puLaser();
    Sound.missile();
  }

  // wingmen mirror the player's current weapon tier
  function wingmanFire(w) {
    const lvl = state.weapon;
    const offs = lvl >= 3 ? [-0.7, 0.7] : lvl === 2 ? [-0.5, 0.5] : [0];
    for (const dx of offs) {
      const l = GLBKit.acquire('assets/proj_blue2.glb', { targetLen: 1.7 });
      l.position.copy(w.position);
      l.position.x += dx; l.position.z -= 1.2;
      l._vx = 0; l._dmg = lvl >= 3 ? 2 : 1; l._pierce = false; l._spin = false;
      scene.add(l); lasers.push(l);
    }
    Sound.laser();
  }

  // parting shot: a homing-ish missile salvo before they bug out
  function wingmanFarewell(w) {
    for (const dx of [-1.2, 0, 1.2]) {
      const mstl = GLBKit.acquire('assets/proj_cannon.glb', { rotY: -Math.PI / 2, targetLen: 2.2 });
      mstl.position.copy(w.position);
      mstl.position.x += dx;
      mstl._vx = dx * 6; mstl._dmg = 3; mstl._pierce = true; mstl._spin = true;
      scene.add(mstl); lasers.push(mstl);
    }
    Sound.missile();
  }

  function updateWingmen(dt) {
    for (let i = wingmen.length - 1; i >= 0; i--) {
      const w = wingmen[i];
      w._life -= dt;

      if (w._phase === 'flyby') {
        // scream forward past the camera, then wheel back into formation
        w.position.z -= 95 * dt;
        w.position.y += (ship.position.y - w.position.y) * Math.min(1, dt * 2);
        if (w.position.z < ship.position.z - 10) w._phase = 'join';
      } else if (w._phase === 'join') {
        // ease into the formation slot beside the player
        const tx = ship.position.x + w._slotX, ty = ship.position.y + w._slotY, tz = ship.position.z - 1;
        w.position.x += (tx - w.position.x) * Math.min(1, dt * 3);
        w.position.y += (ty - w.position.y) * Math.min(1, dt * 3);
        w.position.z += (tz - w.position.z) * Math.min(1, dt * 3);
        if (Math.abs(w.position.z - tz) < 1.5) w._phase = 'fight';
      } else if (w._phase === 'fight') {
        // hold station with a little drift so they feel alive
        const bob = Math.sin(state.time * 1.6 + w._slotX) * 0.5;
        const tx = ship.position.x + w._slotX, ty = ship.position.y + w._slotY + bob;
        w.position.x += (tx - w.position.x) * Math.min(1, dt * 4);
        w.position.y += (ty - w.position.y) * Math.min(1, dt * 4);
        w.position.z += ((ship.position.z - 1) - w.position.z) * Math.min(1, dt * 4);
        w.rotation.z = (tx - w.position.x) * 0.10;      // bank into the correction

        // engage: prefer the boss, else the nearest enemy ahead
        w._fireTimer -= dt;
        if (w._fireTimer <= 0) {
          let target = boss;
          if (!target) {
            let best = Infinity;
            for (const e of enemies) {
              const d = Math.abs(e.position.z - w.position.z);
              if (e.position.z < w.position.z && d < best) { best = d; target = e; }
            }
          }
          if (target) {
            // lead the shot toward the target's lane before firing
            w.position.x += THREE.MathUtils.clamp(target.position.x - w.position.x, -2.5, 2.5) * dt * 2;
            wingmanFire(w);
            w._fireTimer = 0.42 + Math.random() * 0.18;
          } else {
            w._fireTimer = 0.25;
          }
        }
        if (w._life <= 0) { w._phase = 'leave'; wingmanFarewell(w); radio('wingmanOut'); }
      } else {                                   // 'leave' — burn out ahead
        w.position.z -= 70 * dt;
        w.position.y += 8 * dt;
        if (w.position.z < SPAWN_Z) { scene.remove(w); wingmen.splice(i, 1); continue; }
      }
    }
  }

  function clearWingmen() {
    while (wingmen.length) scene.remove(wingmen.pop());
  }

  // ---------------------------------------------------------------------
  // Multi-stage dreadnought. The hull itself is armoured — only the weak
  // points exposed in the current stage can be hurt:
  //   1 CANNONS  destroy both flank turrets
  //   2 VENTS    engine vents open; it answers with barrages + a sweeping beam
  //   3 CORE     shield breaks, the core is exposed and it fights enraged
  // ---------------------------------------------------------------------
  const BOSS_STAGES = [
    { key: 'cannons', label: 'TARGET: FLANK CANNONS', count: 2, hp: 46 },
    { key: 'vents',   label: 'TARGET: ENGINE VENTS',  count: 3, hp: 34 },
    { key: 'core',    label: 'TARGET: EXPOSED CORE',  count: 1, hp: 130 },
  ];
  // one continuous health pool across the whole encounter, so the bar only
  // ever falls — a per-stage bar refilling to full reads as "a new boss"
  const ARMOUR_CHIP = 0.25;    // fraction of damage a hull hit still delivers
  const BOSS_TOTAL_HP = BOSS_STAGES.reduce((s, st) => s + st.count * st.hp, 0);
  const bossHpBelowStage = (stage) =>
    BOSS_STAGES.slice(stage + 1).reduce((s, st) => s + st.count * st.hp, 0);

  function makeWeakPoint(color, radius, pos, hp) {
    const m = new THREE.Mesh(
      new THREE.SphereGeometry(radius, 14, 12),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.92 })
    );
    m.position.set(pos[0], pos[1], pos[2]);
    m._hp = hp; m._maxHp = hp;
    // halo + target ring so it reads unmistakably as "shoot here"
    const halo = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowTex, color, transparent: true, opacity: 0.8,
      depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    halo.scale.setScalar(radius * 4.2);
    m.add(halo);
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(radius * 1.9, radius * 0.13, 8, 22),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.75 })
    );
    m.add(ring);
    m._ring = ring;
    return m;
  }

  function buildStageParts(stage) {
    // clear anything left from the previous stage
    (boss._parts || []).forEach((p) => { if (p.parent) p.parent.remove(p); });
    boss._parts = [];
    const scale = BOSS_LEN / 2;   // weak points positioned in boss-local units
    // NB: the dreadnought hull is already covered in red glow, so red weak
    // points vanished into it — these use contrasting cyan/white and sit
    // proud of the hull (+z, toward the player) so nothing occludes them.
    const spec = BOSS_STAGES[stage];
    const PROUD = scale * 0.42;
    if (stage === 0) {
      for (const sx of [-1, 1]) {
        const p = makeWeakPoint(0x50e8ff, 2.0, [sx * scale * 0.62, 0, PROUD], spec.hp);
        boss.add(p); boss._parts.push(p);
      }
    } else if (stage === 1) {
      for (const dx of [-1, 0, 1]) {
        const p = makeWeakPoint(0xffd83a, 1.7, [dx * scale * 0.30, -scale * 0.10, PROUD], spec.hp);
        boss.add(p); boss._parts.push(p);
      }
    } else {
      const p = makeWeakPoint(0xffffff, 2.6, [0, 0, PROUD], spec.hp);
      boss.add(p); boss._parts.push(p);
      boss._core = p;
    }
    boss._stageHpMax = boss._parts.reduce((s, p) => s + p._maxHp, 0);
  }

  // Nudge the player toward the weak points the first few times they plink
  // off the hull in a given phase — nothing else in the game teaches this.
  function hintWeakPoints() {
    if (!boss || boss._hinted === boss._stage) return;
    boss._armourPings = (boss._armourPings || 0) + 1;
    if (boss._armourPings < 12) return;
    boss._hinted = boss._stage;
    boss._armourPings = 0;
    ui.nearMiss.textContent = 'ARMOURED — HIT THE GLOWING WEAK POINTS';
    flash(ui.nearMiss);
  }

  function bossStageHp() {
    return (boss._parts || []).reduce((s, p) => s + Math.max(0, p._hp), 0);
  }

  function advanceBossStage() {
    boss._stage++;
    if (boss._stage >= BOSS_STAGES.length) { killBoss(); return; }
    buildStageParts(boss._stage);
    boss._beamTimer = 3.5;
    // Deliberately NOT a death: no bigBoom, smaller burst. A kill-sized
    // explosion here made every stage feel like the boss had been destroyed.
    state.shake = 0.35;
    state.slowmo = 0.18;
    explode(boss.position, 0xffd23f, 10, 24);
    Sound.alarm();
    villainTaunt(boss._stage === 1 ? 'stage2' : 'stage3');
    ui.bossStage.textContent = `PHASE ${boss._stage + 1}/${BOSS_STAGES.length} · ${BOSS_STAGES[boss._stage].label}`;
    ui.nearMiss.textContent = `ARMOUR BREACHED — PHASE ${boss._stage + 1} / ${BOSS_STAGES.length}`;
    flash(ui.nearMiss);
  }

  function spawnBoss() {
    boss = GLBKit.instance('assets/enemy_dreadnought.glb', { rotY: 0, targetLen: BOSS_LEN });
    boss.position.set(0, 2, SPAWN_Z);
    boss._t = 0;
    boss._fireTimer = 2.5;
    boss._volley = 0;
    boss._stage = 0;
    boss._parts = [];
    boss._beamTimer = 6;
    scene.add(boss);
    buildStageParts(0);
    ui.bossWrap.classList.remove('hidden');
    ui.bossStage.textContent = `PHASE 1/${BOSS_STAGES.length} · ${BOSS_STAGES[0].label}`;
    ui.bossFill.style.width = '100%';
    radio('boss', true);
    villainTaunt('arrive');
    Sound.alarm();
    Music.setBoss(true);
  }

  function fire() {
    if (state.fireTimer > 0) return;
    const w = state.weapon;
    if (w === 3) {
      // RAIL CANNON — heavy piercing lightning-sphere, slow cadence, high damage
      state.fireTimer = 0.30;
      const l = GLBKit.instance('assets/proj_cannon.glb', { rotY: -Math.PI / 2, targetLen: 2.6 });
      l.position.set(ship.position.x, ship.position.y, ship.position.z - 1.9);
      // slow cadence, so each slug has to hit hard to be worth the tier
      l._vx = 0; l._dmg = Math.round(7 * shipStats.power); l._pierce = true; l._spin = true; l._hitParts = null;
      scene.add(l); lasers.push(l); state.tally.fired++;
      muzzleFlash(ship.position.x, ship.position.y, ship.position.z - 1.8, 0xfff0b0);
      Sound.laserUp();
      state.kick = 0.5;                       // heavy recoil on the rail cannon
      return;
    }
    // PULSE PISTOL (twin) · STORM RIFLE (twin + center, faster)
    state.fireTimer = (w === 2) ? 0.09 : FIRE_COOLDOWN;
    const offs = (w === 2) ? [-0.9, 0.9, 0] : [-0.9, 0.9];
    for (const dx of offs) {
      // plasma-bolt GLB; its tip already points -Z so no yaw needed
      const l = GLBKit.acquire('assets/proj_blue2.glb', { targetLen: 1.9 });
      l.position.set(ship.position.x + dx, ship.position.y, ship.position.z - 1.5);
      l._vx = 0; l._dmg = Math.max(1, Math.round(1 * shipStats.power)); l._pierce = false; l._spin = false; l._hitParts = null;
      scene.add(l); lasers.push(l); state.tally.fired++;
      muzzleFlash(ship.position.x + dx, ship.position.y, ship.position.z - 1.4);
    }
    if (w === 2) { Sound.laserUp(); state.kick = 0.16; } else Sound.laser();
  }

  function enemyFire(e) {
    // crimson spear GLB, nose -X -> rotate to fly +Z at the player
    const s = GLBKit.acquire('assets/proj_spear2.glb', { rotY: Math.PI / 2, targetLen: 2.2 });
    s._spin = false;
    s.position.copy(e.position);
    // aim roughly at the ship
    const dir = new THREE.Vector3().subVectors(ship.position, e.position).normalize();
    s._vel = dir.multiplyScalar(70);
    scene.add(s);
    enemyShots.push(s);
    Sound.plasma();
  }

  // ---------------------------------------------------------------------
  // Effects
  // ---------------------------------------------------------------------
  // soft radial glow used for explosion flashes and sparks
  const glowTex = (() => {
    const c = document.createElement('canvas'); c.width = c.height = 128;
    const g = c.getContext('2d').createRadialGradient(64, 64, 1, 64, 64, 62);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.25, 'rgba(255,255,255,0.75)');
    g.addColorStop(0.55, 'rgba(255,255,255,0.22)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    const ctx = c.getContext('2d'); ctx.fillStyle = g; ctx.fillRect(0, 0, 128, 128);
    const t = new THREE.CanvasTexture(c); t.encoding = THREE.sRGBEncoding; return t;
  })();

  // Momentary white-hot flash on a struck target. Materials are shared between
  // GLB clones, so we swap in a private copy for the duration of the flash.
  function hitFlash(obj) {
    if (obj._flashing) return;
    obj._flashing = true;
    const touched = [];
    obj.traverse((o) => {
      if (o.isMesh && o.material && o.material.emissive) {
        const solo = o.material.clone();
        solo.emissive = new THREE.Color(0xffffff);
        solo.emissiveIntensity = 1.4;
        touched.push({ mesh: o, original: o.material });
        o.material = solo;
      }
    });
    setTimeout(() => {
      touched.forEach(({ mesh, original }) => {
        if (mesh.material !== original) { mesh.material.dispose(); mesh.material = original; }
      });
      obj._flashing = false;
    }, 70);
  }

  // muzzle flash at the gun ports when you fire
  function muzzleFlash(x, y, z, color = 0x9fe6ff) {
    const f = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowTex, color, transparent: true, opacity: 0.95,
      depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    f.position.set(x, y, z);
    f.scale.setScalar(1.5);
    f._vel = new THREE.Vector3();
    f._life = 0.09;
    f._flash = true;
    scene.add(f); particles.push(f);
  }

  function explode(pos, color, n = 14, power = 26) {
    // bright core flash that punches out and fades fast
    const flash = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowTex, color, transparent: true, opacity: 1,
      depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    flash.position.copy(pos);
    flash.scale.setScalar(power * 0.16);
    flash._vel = new THREE.Vector3();
    flash._life = 0.34;
    flash._flash = true;
    scene.add(flash); particles.push(flash);

    // glowing sparks thrown outward
    for (let i = 0; i < n; i++) {
      const spark = new THREE.Sprite(new THREE.SpriteMaterial({
        map: glowTex, color, transparent: true, opacity: 1,
        depthWrite: false, blending: THREE.AdditiveBlending,
      }));
      spark.position.copy(pos);
      spark.scale.setScalar(0.6 + Math.random() * 0.9);
      spark._vel = new THREE.Vector3((Math.random()-0.5), (Math.random()-0.5), (Math.random()-0.5))
        .normalize().multiplyScalar(power * (0.4 + Math.random()));
      spark._life = 0.5 + Math.random() * 0.45;
      scene.add(spark); particles.push(spark);
    }
  }

  function startRoll(dir) {
    if (!state.running || state.rolling > 0 || state.rollCooldown > 0) return;
    state.rolling = 0.55;
    state.rollDir = dir;
    state.rollCooldown = 0.9;
    Sound.roll();
    flash(ui.rollFlash);
  }

  // ---- pilot comms (Cmdr. Lynx radios in on events) ----
  const COMMS = {
    start:    ['All wings, report in. Let\'s fly!', 'Nebulawing Squadron, engage!'],
    wave:     ['Enemy reinforcements inbound!', 'They\'re stepping it up. Stay sharp.', 'New wave on scope — watch your six!'],
    lowHp:    ['Shields critical! Grab a ring!', 'You\'re venting plasma — evade, evade!'],
    ring:     ['Nice flying. Shields recharging.', 'Ring bonus — keep it up!'],
    deflect:  ['Ha! Right back at \'em!', 'Textbook barrel roll!'],
    kill5:    ['They\'re falling like flies!', 'Impressive shooting, pilot!'],
    boss:     ['Dreadnought on scope — take it down!', 'That\'s a big one. Aim for the core!'],
    bossDown: ['Dreadnought destroyed! Outstanding flying!', 'Scratch one dreadnought! The squadron owes you one.'],
    puLaser:  ['Lasers upgraded — light \'em up!'],
    puShield: ['Shield cell acquired!'],
    puBomb:   ['Bomb away! Clear the skies!'],
    wingman:  ['Dash and Skye on your wing — go get \'em!', 'Squadron assist inbound! Form up!'],
    wingmanBlock: ['I got that one for you!', 'Covered your six!'],
    wingmanOut:   ['Wingmates bingo fuel — peeling off!', 'That\'s our cue. Good hunting, pilot!'],
    formation:    ['Formation on scope — break them up!', 'Squadron inbound, tight formation!'],
  };
  let commsCooldown = 0;
  let lowHpWarned = false;
  function radio(kind, force = false) {
    if (!force && commsCooldown > 0) return;
    const lines = COMMS[kind];
    ui.commsMsg.textContent = lines[Math.floor(Math.random() * lines.length)];
    ui.comms.classList.remove('hidden');
    Sound.comms();
    commsCooldown = 5;
    clearTimeout(ui.comms._t);
    ui.comms._t = setTimeout(() => ui.comms.classList.add('hidden'), 3800);
  }

  // ---- villain comms (Warlord Fenrir taunts during boss fights) ----
  const TAUNTS = {
    arrive:   ['So the Nebulawing pups have teeth. Let me pull them.',
               'You dare face my dreadnought? Foolish.',
               'This is where your flight ends, pilot.'],
    hurt:     ['Impossible! My hull is legend!',
               'You only make me angrier, whelp.',
               'A lucky shot. It will be your last.'],
    enrage:   ['ENOUGH! I will grind you to stardust!',
               'You have awoken the wolf. Now you die!'],
    stage2:   ['My cannons! You will pay for that, whelp.',
               'Gunnery decks lost — reroute to the vents. Burn them!'],
    stage3:   ['The core?! No — the shield holds! IT MUST HOLD!',
               'You have torn my ship open. I will tear you apart!'],
    beam:     ['Burn in my lance!', 'Sweep the sky — leave nothing!'],
  };
  function villainTaunt(kind, force = true) {
    if (!force && commsCooldown > 0) return;
    const lines = TAUNTS[kind];
    ui.villainMsg.textContent = lines[Math.floor(Math.random() * lines.length)];
    ui.villainWeapon.src = VILLAIN_WEAPONS[Math.floor(Math.random() * VILLAIN_WEAPONS.length)];
    ui.villain.classList.remove('hidden');
    Sound.comms();
    commsCooldown = 5;
    clearTimeout(ui.villain._t);
    ui.villain._t = setTimeout(() => ui.villain.classList.add('hidden'), 4200);
  }

  function flash(el) {
    el.classList.remove('hidden');
    // restart CSS animation
    el.style.animation = 'none'; void el.offsetWidth; el.style.animation = '';
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.add('hidden'), 600);
  }

  function addScore(n) {
    state.combo++;
    state.comboTimer = 1.6;
    const mult = 1 + Math.floor(state.combo / 5) * 0.5;
    state.score += Math.round(n * mult);
    if (state.combo >= 3) {
      ui.combo.textContent = `COMBO ×${state.combo}` + (mult > 1 ? `  (${mult.toFixed(1)}×)` : '');
      ui.combo.classList.remove('hidden');
    }
  }

  // NEAR MISS: reward flying dangerously — points, combo, a boost sip and a
  // brief slow-mo so the dodge reads.
  function nearMiss() {
    addScore(100);
    state.boost = Math.min(100, state.boost + 6);
    state.slowmo = 0.18;                 // short time dilation
    ui.nearMiss.textContent = 'NEAR MISS +100';
    flash(ui.nearMiss);
    Sound.comms();
  }

  function damage(amount) {
    if (state.invuln > 0 || state.rolling > 0) return;
    state.shield -= amount / shipStats.armour;   // heavier hulls soak more
    state.invuln = 0.8;
    state.shake = 0.5;
    state.combo = 0;
    ui.combo.classList.add('hidden');
    Sound.hurt();
    if (state.shield <= 0) { state.shield = 0; gameOver(); }
  }

  function killBoss() {
    if (!boss) return;
    const pos = boss.position.clone();
    if (boss._beam) { scene.remove(boss._beam); boss._beam = null; }

    // staggered detonation chain, then the big one — in slow motion
    state.slowmo = 1.1;
    state.shake = 1.2;
    const chain = [[-6, 1], [5, -2], [0, 3], [-3, -3], [7, 2], [-8, 0]];
    chain.forEach((off, i) => setTimeout(() => {
      explode(new THREE.Vector3(pos.x + off[0], pos.y + off[1], pos.z), 0xff8a5a, 14, 34);
      Sound.boom();
    }, i * 130));
    setTimeout(() => {
      explode(pos, 0xffd23f, 34, 52);
      explode(pos, 0xffffff, 18, 30);
      Sound.bigBoom();
      state.shake = 1.4;
    }, chain.length * 130);

    Sound.victory();
    addScore(3000);
    scene.remove(boss);
    boss = null;
    // The bounty itself vaults you several waves. Absorb that jump and hold a
    // cooldown, otherwise killing a boss immediately summons the next one.
    state.wave = 1 + Math.floor(Math.sqrt(state.score / 700));
    state.lastBossWave = state.wave;
    state.bossCooldown = 45;
    ui.bossWrap.classList.add('hidden');
    ui.villain.classList.add('hidden');
    radio('bossDown', true);
    Music.setBoss(false);
    showSectorClear();
  }

  // celebratory banner after a dreadnought goes down
  function showSectorClear() {
    const el = ui.sectorClear;
    if (!el) return;
    $('sc-wave').textContent = state.wave;
    $('sc-score').textContent = state.score.toLocaleString();
    $('sc-kills').textContent = state.kills;
    el.classList.remove('hidden', 'out');
    void el.offsetWidth;                       // restart the entry animation
    clearTimeout(el._t);
    el._t = setTimeout(() => {
      el.classList.add('out');
      setTimeout(() => el.classList.add('hidden'), 700);
    }, 2600);
  }

  // ---------------------------------------------------------------------
  // Collision helper (cheap sphere check)
  // ---------------------------------------------------------------------
  const tmpVec = new THREE.Vector3();   // scratch for world-space lookups

  function near(a, b, dist) {
    const dx = a.position.x - b.position.x;
    const dy = a.position.y - b.position.y;
    const dz = a.position.z - b.position.z;
    return dx*dx + dy*dy + dz*dz < dist*dist;
  }

  const sharedGeoSet = new Set([sharedGeo.bit, puCageGeo]);
  function dispose(obj, arr, i) {
    // pooled GLB instances go back to the pool instead of being destroyed
    if (!GLBKit.release(obj)) {
      scene.remove(obj);
      if (obj.geometry && !sharedGeoSet.has(obj.geometry)) {
        obj.geometry.dispose();
      }
    }
    arr.splice(i, 1);
  }

  // ---------------------------------------------------------------------
  // Main loop
  // ---------------------------------------------------------------------
  const clock = new THREE.Clock();

  function loop() {
    requestAnimationFrame(loop);
    let dt = Math.min(clock.getDelta(), 0.05);
    // near-miss / elite-kill time dilation
    if (state.slowmo > 0) { state.slowmo -= dt; dt *= 0.35; }
    if (state.running) update(dt);
    animateIdle(dt);
    renderer.render(scene, camera);
  }

  function animateIdle(dt) {
    // always-on cosmetic motion
    stars.material.opacity = 0.6 + Math.sin(performance.now()*0.002)*0.2;
    for (const t of ship._thrusters) {
      t.scale.y = 0.8 + Math.random()*0.6;   // flame length (cone axis)
    }
  }

  function update(dt) {
    state.time += dt;

    // ---- speed (boost / brake; wheel-up boosts, wheel-down brakes) ----
    let target = BASE_SPEED + state.wave * 4;
    const boosting = keys.boost || mouse.wheel > 0;
    const braking  = keys.brake || mouse.wheel < 0;
    if (boosting && state.boost > 0) { target *= 1.8 * shipStats.boost; state.boost -= 28*dt / shipStats.boost; }
    else if (braking) { target *= 0.55; state.boost = Math.min(100, state.boost + 10*dt*shipStats.boost); }
    else { state.boost = Math.min(100, state.boost + 14*dt*shipStats.boost); }
    state.speed += (target - state.speed) * Math.min(1, dt*4);
    Sound.engineThrottle(boosting ? 1 : braking ? 0 : 0.4);

    // ---- timers ----
    state.fireTimer -= dt;
    state.rollCooldown -= dt;
    if (state.rolling > 0) state.rolling -= dt;
    if (state.invuln > 0) state.invuln -= dt;
    if (state.comboTimer > 0) { state.comboTimer -= dt; if (state.comboTimer <= 0) { state.combo = 0; ui.combo.classList.add('hidden'); } }
    if (state.shake > 0) state.shake -= dt;
    if (commsCooldown > 0) commsCooldown -= dt;

    // shield warnings
    if (state.shield <= 30 && !lowHpWarned) { lowHpWarned = true; radio('lowHp', true); }
    if (state.shield > 45) lowHpWarned = false;

    // ---- steering ----
    const accel = 60 * shipStats.agility, damp = 8, maxV = 26 * shipStats.agility;
    if (mouse.active) {
      // chase the pointer; the resulting velocity still drives bank/pitch
      const follow = 7 * shipStats.agility;
      vel.x = THREE.MathUtils.clamp((mouse.tx - ship.position.x) * follow, -maxV, maxV);
      vel.y = THREE.MathUtils.clamp((mouse.ty - ship.position.y) * follow, -maxV, maxV);
    } else {
      if (keys.left)  vel.x -= accel*dt;
      if (keys.right) vel.x += accel*dt;
      if (keys.up)    vel.y += accel*dt;
      if (keys.down)  vel.y -= accel*dt;
      vel.x -= vel.x * Math.min(1, damp*dt);
      vel.y -= vel.y * Math.min(1, damp*dt);
      vel.x = THREE.MathUtils.clamp(vel.x, -maxV, maxV);
      vel.y = THREE.MathUtils.clamp(vel.y, -maxV, maxV);
    }

    ship.position.x = THREE.MathUtils.clamp(ship.position.x + vel.x*dt, -PLAY.x, PLAY.x);
    ship.position.y = THREE.MathUtils.clamp(ship.position.y + vel.y*dt, PLAY.yMin, PLAY.yMax);

    // ---- ship orientation (bank/pitch + barrel roll) ----
    let rollZ = -vel.x * 0.06;
    if (state.rolling > 0) {
      // full 360 spin over the roll duration
      rollZ += state.rollDir * (1 - state.rolling/0.55) * Math.PI * 2;
    }
    ship.rotation.z = rollZ;
    ship.rotation.x = -vel.y * 0.03 - 0.02;
    ship.rotation.y = vel.x * 0.02;
    ship.position.z = SHIP_Z + Math.sin(state.time*2)*0.15; // gentle bob

    engineLight.position.set(ship.position.x, ship.position.y, ship.position.z + 1.5);
    // rim light sits above/behind, picking out the hull edges against the grid
    shipRim.position.set(ship.position.x, ship.position.y + 3.2, ship.position.z + 4);

    // ---- firing (automatic on touch: the thumb is busy flying) ----
    if (keys.fire || touchMode) fire();

    // ---- world scroll factor ----
    const scroll = state.speed * dt;

    // starfield + grid recycle
    const sp = stars.geometry.attributes.position;
    for (let i = 0; i < sp.count; i++) {
      let z = sp.getZ(i) + scroll;
      if (z > 20) z = -500 + (z - 20);
      sp.setZ(i, z);
    }
    sp.needsUpdate = true;
    grid.position.z += scroll;
    if (grid.position.z > 0) grid.position.z -= 100;

    // backdrop: ease in, and drift opposite the ship for a parallax sense of scale
    if (backdrop._fadeTo !== undefined && backdrop.material.opacity < backdrop._fadeTo) {
      backdrop.material.opacity = Math.min(backdrop._fadeTo, backdrop.material.opacity + dt * 0.6);
    }
    backdrop.position.x = -ship.position.x * 1.4;
    backdrop.position.y = 24 - ship.position.y * 0.6;

    // ---- lasers ----
    for (let i = lasers.length-1; i >= 0; i--) {
      const l = lasers[i];
      l.position.z -= LASER_SPEED * dt;
      l.position.x += (l._vx || 0) * dt;
      if (l.position.z < SPAWN_Z) { state.tally.expired++; dispose(l, lasers, i); continue; }
      const dmg = l._dmg || 1;
      if (l._spin) l.rotation.z += dt * 4;  // slow spin on the cannon orb only
      // hit the boss — only the weak points exposed this stage take damage
      if (boss && near(l, boss, 13)) {
        let struck = false;
        for (const p of boss._parts) {
          if (p._hp <= 0) continue;
          // a piercing shot may only damage each weak point once
          if (l._hitParts && l._hitParts.has(p)) continue;
          p.getWorldPosition(tmpVec);
          const dx = l.position.x - tmpVec.x, dy = l.position.y - tmpVec.y, dz = l.position.z - tmpVec.z;
          const rr = p.geometry.parameters.radius * 2.7;   // generous: they're small, fast-moving targets
          if (dx*dx + dy*dy + dz*dz < rr*rr) {
            if (l._pierce) { (l._hitParts = l._hitParts || new Set()).add(p); }
            state.tally.weak++;
            p._hp -= dmg;
            explode(l.position, 0xffd0a0, 4, 14);
            Sound.hit();
            if (Math.random() < 0.02) villainTaunt('hurt', false);
            if (p._hp <= 0) {                       // weak point blown open
              explode(tmpVec, 0xff8a5a, 18, 32);
              Sound.bigBoom();
              addScore(300);
              state.shake = 0.5;
              p.visible = false;
              if (bossStageHp() <= 0) advanceBossStage();
            }
            struck = true;
            break;
          }
        }
        if (struck && !l._pierce) { dispose(l, lasers, i); continue; }
        if (!struck) {
          // Armour plating: only stops shots that actually reach the hull
          // plane. Without the depth gate this ate bolts ~10 units short of
          // the flank turrets, making them unkillable with basic lasers.
          const dzHull = Math.abs(l.position.z - boss.position.z);
          const dxHull = Math.abs(l.position.x - boss.position.x);
          const dyHull = Math.abs(l.position.y - boss.position.y);
          if (dzHull < 4 && dxHull < BOSS_LEN * 0.42 && dyHull < BOSS_LEN * 0.16) {
            state.tally.armour++;
            // Hull hits CHIP rather than doing nothing. Shooting the obvious
            // target used to deal exactly zero damage forever, which reads as
            // a broken boss. Weak points are still ~4x faster.
            const live = boss._parts.find((p) => p._hp > 0);
            if (live) {
              live._hp -= dmg * ARMOUR_CHIP;
              if (live._hp <= 0) {
                live.getWorldPosition(tmpVec);
                explode(tmpVec, 0xff8a5a, 18, 32);
                Sound.bigBoom(); addScore(300); state.shake = 0.5;
                live.visible = false;
                if (bossStageHp() <= 0) advanceBossStage();
              }
            }
            explode(l.position, 0x8899aa, 3, 10);
            Sound.hit();
            hintWeakPoints();
            if (!l._pierce) { dispose(l, lasers, i); continue; }
          }
        }
      }
      // hit enemies
      let hit = false;
      for (let j = enemies.length-1; j >= 0; j--) {
        const et = enemies[j]._type || ENEMY_TYPES.fighter;
        if (near(l, enemies[j], et.hit)) {
          enemies[j]._hp -= dmg;
          explode(l.position, 0x4dc9ff, 4, 14);
          if (enemies[j]._hp <= 0) {
            const heavy = et.hp >= 4;
            explode(enemies[j].position, 0xff8a5a, heavy ? 24 : 16, heavy ? 38 : 30);
            if (heavy) {
              Sound.bigBoom();
              state.slowmo = 0.14;              // freeze-frame on an elite kill
              state.shake = Math.max(state.shake, 0.4);
            } else Sound.boom();
            addScore(et.score);
            state.kills++;
            if (state.kills % 5 === 0) radio('kill5');
            dispose(enemies[j], enemies, j);
          } else {
            Sound.hit();
            hitFlash(enemies[j]);          // brief white pop so hits register
          }
          if (!l._pierce) { hit = true; break; }
        }
      }
      if (hit) { dispose(l, lasers, i); continue; }
      // hit meteors — chip them down, then blow them apart
      for (let j = asteroids.length-1; j >= 0; j--) {
        const a = asteroids[j];
        if (near(l, a, a._radius + 0.3)) {
          a._hp -= dmg;
          if (a._hp <= 0) {
            explode(a.position, 0xff7a2a, 18, 30);      // molten burst
            explode(a.position, 0xb0b4c0, 8, 22);       // rock shrapnel
            Sound.boom();
            addScore(75);
            dispose(a, asteroids, j);
          } else {
            explode(l.position, 0xff9a3c, 5, 16);
            Sound.hit();
            addScore(15);
          }
          if (!l._pierce) { dispose(l, lasers, i); break; }
        }
      }
    }

    // ---- enemies ----
    for (let i = enemies.length-1; i >= 0; i--) {
      const e = enemies[i];
      const et = e._type || ENEMY_TYPES.fighter;
      e._sway += dt * e._swaySpeed;
      e.position.z += scroll * (et.speed || 1);

      // ---- per-role flight behaviour ----
      switch (et.behavior) {
        case 'zigzag':      // scouts snap side to side in hard steps
          e.position.x += Math.sign(Math.sin(e._sway * 2.2)) * dt * 16;
          e.rotation.z = Math.sign(Math.sin(e._sway * 2.2)) * -0.5;
          break;
        case 'circle':      // interceptors corkscrew toward the player's lane
          // NB: this used to hard-set position from ship.position every frame,
          // which welded the enemy to the player — it tracked you sideways
          // forever and could never be shot (it sat at your own depth).
          e._orbit = (e._orbit || 0) + dt * 1.5;
          e._anchorX += (ship.position.x - e._anchorX) * Math.min(1, dt * 0.5);
          e._anchorY += (ship.position.y - e._anchorY) * Math.min(1, dt * 0.5);
          e.position.x = e._anchorX + Math.cos(e._orbit) * 5;
          e.position.y = e._anchorY + Math.sin(e._orbit) * 2.6;
          e.rotation.z = Math.cos(e._orbit) * 0.5;
          break;
        case 'kamikaze':    // locks on, strobes a warning, then charges
          if (e.position.z > -70) {
            e.position.x += (ship.position.x - e.position.x) * Math.min(1, dt * 1.4);
            e.position.y += (ship.position.y - e.position.y) * Math.min(1, dt * 1.4);
            e._flash = (e._flash || 0) + dt;
            // toggle an attached glow sprite rather than writing to the hull
            // material — GLB clones share materials, so tinting in place
            // strobed every other enemy of the same type too.
            if (e._warn) {
              e._warn.visible = Math.sin(e._flash * 22) > 0;
              e._warn.scale.setScalar(3.2 + Math.sin(e._flash * 22) * 0.5);
            }
          }
          e.rotation.z += dt * 3;
          break;
        case 'bomber':      // heavy: slow, steady, fires clusters
          e.position.x += Math.sin(e._sway * 0.5) * dt * 2;
          e.rotation.z = Math.sin(e._sway * 0.5) * 0.18;
          break;
        default:            // 'weave' — the classic sine drift
          e.position.x += Math.sin(e._sway) * dt * 4;
          e.rotation.z = Math.sin(e._sway) * 0.35;
      }

      e._shootTimer -= dt;
      if (et.shoots && e._shootTimer <= 0 && e.position.z < -20) {
        const shots = et.volley || 1;             // bombers launch clusters
        for (let v = 0; v < shots; v++) setTimeout(() => { if (e.parent) enemyFire(e); }, v * 110);
        e._shootTimer = (et.behavior === 'bomber' ? 2.4 : 1.6) + Math.random()*2;
      }
      if (e.position.z > DESPAWN_Z) { dispose(e, enemies, i); continue; }
      // ram damage — heavier craft hit harder
      if (near(e, ship, et.hit + 0.5)) {
        damage(et.behavior === 'kamikaze' ? 42 : et.hp >= 4 ? 40 : 28);
        explode(e.position, 0xff8a5a, 14, 28);
        Sound.boom();
        dispose(e, enemies, i);
      }
    }

    // ---- enemy shots ----
    for (let i = enemyShots.length-1; i >= 0; i--) {
      const s = enemyShots[i];
      s.position.addScaledVector(s._vel, dt);
      s.position.z += scroll * 0.3;
      if (s._spin) s.rotation.z += dt * 3;
      if (s.position.z > DESPAWN_Z || s.position.z < SPAWN_Z) { dispose(s, enemyShots, i); continue; }
      // a wingman with its guard up intercepts the shot for you
      let blocked = false;
      for (const w of wingmen) {
        if (w._guard > 0 && w._phase === 'fight' && near(s, w, 2.6)) {
          w._guard--;
          explode(s.position, 0x7cff8a, 10, 22);
          Sound.hurt();
          radio('wingmanBlock');
          dispose(s, enemyShots, i);
          blocked = true;
          break;
        }
      }
      if (blocked) continue;
      // NEAR MISS — shot slipped past inside the graze band without touching you
      if (!s._grazed && s.position.z > ship.position.z - 1 && near(s, ship, 4.2) && !near(s, ship, 1.7)) {
        s._grazed = true;
        nearMiss();
      }
      if (near(s, ship, 1.6)) {
        if (state.rolling > 0) {
          // deflect!
          explode(s.position, 0xffd23f, 8, 22);
          addScore(20);
          radio('deflect');
          Sound.ring();
        } else {
          damage(16);
          explode(s.position, 0xff5a5a, 8, 18);
        }
        dispose(s, enemyShots, i);
      }
    }

    // ---- asteroids ----
    for (let i = asteroids.length-1; i >= 0; i--) {
      const a = asteroids[i];
      a.position.z += scroll;
      a.rotation.x += a._spin.x * dt;
      a.rotation.y += a._spin.y * dt;
      if (a.position.z > DESPAWN_Z) { dispose(a, asteroids, i); continue; }
      // grazing a meteor counts too — rewards threading the rocks
      if (!a._grazed && a.position.z > ship.position.z - 2 && near(a, ship, a._radius + 4)
          && !near(a, ship, a._radius + 1.5)) {
        a._grazed = true;
        nearMiss();
      }
      if (near(a, ship, a._radius + 1.4)) {
        damage(34);
        explode(ship.position, 0xb0b4c0, 18, 30);
        Sound.boom();
        dispose(a, asteroids, i);
      }
    }

    // ---- rings ----
    for (let i = rings.length-1; i >= 0; i--) {
      const r = rings[i];
      r.position.z += scroll;
      r.rotation.z += dt * 0.8;
      if (r.position.z > DESPAWN_Z) { dispose(r, rings, i); continue; }
      if (!r._passed && Math.abs(r.position.z - ship.position.z) < 2) {
        r._passed = true;
        const dx = r.position.x - ship.position.x, dy = r.position.y - ship.position.y;
        if (dx*dx + dy*dy < 3.0*3.0) {
          state.shield = Math.min(100, state.shield + 12);
          state.boost = Math.min(100, state.boost + 25);
          addScore(50);
          radio('ring');
          Sound.ring();
          explode(r.position, 0xffd23f, 10, 18);
          dispose(r, rings, i);
        }
      }
    }

    // ---- boss ----
    if (boss) {
      boss._t += dt;
      // glide in from spawn depth, then hold formation ahead of the player
      boss.position.z += (-46 - boss.position.z) * Math.min(1, dt * 1.1);
      // drifts slowly enough that its weak points are trackable
      boss.position.x = Math.sin(boss._t * 0.34) * 5;
      boss.position.y = 2 + Math.sin(boss._t * 0.5) * 2;
      // barely any roll: rolling swings the weak points out of the firing line
      boss.rotation.z = Math.cos(boss._t * 0.34) * 0.05;

      // pulse the exposed weak points so they read as targets
      for (const p of boss._parts) {
        if (!p.visible) continue;
        const pulse = 0.85 + Math.sin(boss._t * 6) * 0.2;
        p.scale.setScalar(pulse);
        p.material.opacity = 0.7 + Math.sin(boss._t * 6) * 0.28;
        if (p._ring) { p._ring.rotation.z += dt * 1.6; p._ring.rotation.x = boss._t * 0.7; }
      }

      // stage 3 = enraged: it closes in and fires much faster
      const enraged = boss._stage >= 2;
      if (enraged && !boss._enrageAnnounced) { boss._enrageAnnounced = true; villainTaunt('enrage'); Sound.alarm(); }

      // ---- sweeping laser beam (stages 2 & 3) ----
      if (boss._stage >= 1) {
        boss._beamTimer -= dt;
        if (boss._beamTimer <= 0 && !boss._beam) {
          const g = new THREE.Mesh(
            new THREE.BoxGeometry(1.6, 60, 1.6),
            new THREE.MeshBasicMaterial({ color: 0xff3b3b, transparent: true, opacity: 0.75,
              blending: THREE.AdditiveBlending, depthWrite: false })
          );
          g.rotation.x = Math.PI / 2;         // lance it down the corridor
          g.position.copy(boss.position);
          g.position.z += 22;
          boss._beam = g; boss._beamT = 0;
          scene.add(g);
          Sound.alarm();
          villainTaunt('beam', false);
        }
        if (boss._beam) {
          boss._beamT += dt;
          const b = boss._beam;
          // sweep across the play area, then wink out
          b.position.x = Math.sin(boss._beamT * 1.1) * PLAY.x * 1.05;
          b.position.y = boss.position.y;
          b.material.opacity = 0.55 + Math.sin(boss._beamT * 24) * 0.25;
          if (Math.abs(b.position.x - ship.position.x) < 2.2 &&
              Math.abs(b.position.y - ship.position.y) < 12) {
            damage(18);
          }
          if (boss._beamT > 5.2) {
            scene.remove(b); b.geometry.dispose(); b.material.dispose();
            boss._beam = null;
            boss._beamTimer = enraged ? 6 : 9;
          }
        }
      }

      boss._fireTimer -= dt;
      if (boss._fireTimer <= 0 && boss.position.z > -80) {
        boss._volley++;
        if (boss._volley % 3 === 0) {
          // radial burst of crimson plasma orbs
          for (let a = 0; a < 10; a++) {
            const ang = (a / 10) * Math.PI * 2;
            const s = GLBKit.instance('assets/proj_boss_orb.glb', { rotY: -Math.PI / 2, targetLen: 3 });
            s.position.copy(boss.position);
            s._spin = true;
            s._vel = new THREE.Vector3(Math.cos(ang) * 16, Math.sin(ang) * 16, 52);
            scene.add(s); enemyShots.push(s);
          }
        } else {
          // aimed crimson laser-spear spread at the player
          for (const off of [-3, 0, 3]) {
            const s = GLBKit.instance('assets/proj_spear.glb', { rotY: Math.PI / 2, targetLen: 3.4 });
            s.position.copy(boss.position);
            const dir = new THREE.Vector3(
              ship.position.x + off - boss.position.x,
              ship.position.y - boss.position.y,
              ship.position.z - boss.position.z).normalize();
            s._vel = dir.multiplyScalar(78);
            scene.add(s); enemyShots.push(s);
          }
          Sound.missile();
        }
        boss._fireTimer = (enraged ? 0.75 : 1.3) + Math.random() * 0.4;
      }
    }

    // ---- power-ups ----
    for (let i = powerups.length-1; i >= 0; i--) {
      const p = powerups[i];
      p.position.z += scroll;
      p.rotation.x += dt * 1.6;
      p.rotation.y += dt * 2.3;
      const pulse = 1 + Math.sin(state.time * 6) * 0.12;
      p.scale.setScalar(pulse);
      if (p.position.z > DESPAWN_Z) { dispose(p, powerups, i); continue; }
      if (near(p, ship, 2.3)) {
        if (p._type === 'laser') {
          state.weapon = Math.min(3, state.weapon + 1);
          radio('puLaser', true);
          Sound.puLaser();
        } else if (p._type === 'wingman') {
          callWingmen();
        } else if (p._type === 'shield') {
          state.shield = Math.min(100, state.shield + 35);
          radio('puShield', true);
          Sound.puShield();
        } else { // bomb: launch a rocket, wipe everything on screen (except the boss)
          radio('puBomb', true);
          Sound.puBomb(); Sound.missile();
          state.shake = 0.6;
          Sound.bigBoom();
          const rk = GLBKit.instance('assets/ship_cosmic.glb', { rotY: -Math.PI / 2, targetLen: 4.5 });
          rk.position.set(ship.position.x, ship.position.y, ship.position.z - 2.5);
          rk._dmg = 0; rk._pierce = true;   // cosmetic rocket streak; the AOE below does the damage
          scene.add(rk); lasers.push(rk);
          for (let j = enemies.length-1; j >= 0; j--) {
            explode(enemies[j].position, 0xff8a5a, 12, 26);
            addScore(50); state.kills++;
            dispose(enemies[j], enemies, j);
          }
          for (let j = asteroids.length-1; j >= 0; j--) {
            explode(asteroids[j].position, 0xb0b4c0, 10, 22);
            addScore(15);
            dispose(asteroids[j], asteroids, j);
          }
          for (let j = enemyShots.length-1; j >= 0; j--) dispose(enemyShots[j], enemyShots, j);
        }
        explode(p.position, 0xffd23f, 8, 16);
        dispose(p, powerups, i);
      }
    }

    updateWingmen(dt);

    // ---- particles ----
    for (let i = particles.length-1; i >= 0; i--) {
      const p = particles[i];
      p._life -= dt;
      p.position.addScaledVector(p._vel, dt);
      p.position.z += scroll;
      p._vel.multiplyScalar(0.94);
      if (p._flash) {
        // core flash: balloons outward while fading out
        p.scale.multiplyScalar(1 + dt * 6);
        p.material.opacity = Math.max(0, p._life / 0.34);
      } else {
        p.material.opacity = Math.max(0, p._life);
        p.scale.setScalar(Math.max(0.08, p._life * 1.2));
      }
      if (p._life <= 0) { scene.remove(p); p.material.dispose(); particles.splice(i,1); }
    }

    // ---- spawning / difficulty (regular spawns pause during a boss fight) ----
    state.spawnTimer -= dt;
    if (state.spawnTimer <= 0 && !boss) {
      const r = Math.random();
      if (r < 0.18 && state.wave >= 2) {
        spawnFormation();                     // recognisable attack sequence
        state.spawnTimer = 3.2;               // breathing room after a squadron
      } else {
        if (r < 0.62) spawnEnemy(); else spawnAsteroid();
        if (Math.random() < 0.25) spawnEnemy();
        state.spawnTimer = Math.max(0.35, 1.4 - state.wave*0.06);
      }
    }
    state.ringTimer -= dt;
    if (state.ringTimer <= 0) { spawnRing(); state.ringTimer = 6 + Math.random()*4; }
    state.puTimer -= dt;
    if (state.puTimer <= 0) { spawnPowerup(); state.puTimer = 9 + Math.random()*6; }

    // Wave progression. The curve is deliberately sub-linear: score income
    // accelerates hard (combos, upgrades, 3000-point boss bounties), so a flat
    // points-per-wave rule made late waves tick by in seconds.
    if (state.bossCooldown > 0) state.bossCooldown -= dt;
    const newWave = 1 + Math.floor(Math.sqrt(state.score / 700));
    if (newWave !== state.wave) {
      state.wave = newWave;
      radio('wave');   // not forced: never stomps a fresh boss/victory line
      // shift scenery every couple of waves so the run feels like a journey
      const envKey = ENV_ORDER[Math.floor((newWave - 1) / 2) % ENV_ORDER.length];
      if (envKey !== currentEnv) {
        setEnvironment(envKey);
        ui.nearMiss.textContent = 'ENTERING ' + ENVIRONMENTS[envKey].name;
        flash(ui.nearMiss);
      }
      if (newWave % 3 === 0 && newWave > state.lastBossWave && !boss && state.bossCooldown <= 0) {
        state.lastBossWave = newWave;
        spawnBoss();
      }
    }

    // ---- camera shake & follow ----
    // sits further back and higher than the ship, aiming down the corridor so
    // the fighter rides the lower third of frame and never blocks the action
    const shakeAmt = state.shake > 0 ? state.shake * 0.6 : 0;
    camera.position.x = ship.position.x * 0.35 + (Math.random()-0.5)*shakeAmt;
    camera.position.y = 4.6 + ship.position.y * 0.18 + (Math.random()-0.5)*shakeAmt;
    if (state.kick > 0) state.kick -= dt * 3;
    camera.position.z = CAM_Z + Math.max(0, state.kick) * 1.6;   // recoil push-back
    camera.lookAt(ship.position.x * 0.5, ship.position.y * 0.35 + 3.4, -30);

    // engine light flicker tied to boost
    engineLight.intensity = (keys.boost && state.boost > 0) ? 2.4 : 1.2;

    updateHUD();
    updateWarnArrows();
  }

  // ---- off-screen threat arrows -----------------------------------------
  // Projects each nearby enemy to screen space; anything off the edges gets a
  // pulsing chevron so the periphery stays alive and threats are readable.
  const arrowPool = [];
  const projVec = new THREE.Vector3();
  function updateWarnArrows() {
    const W = window.innerWidth, H = window.innerHeight;
    const margin = 34;
    let used = 0;
    for (const e of enemies) {
      if (e.position.z < -170 || e.position.z > DESPAWN_Z) continue;   // too far / already past
      projVec.copy(e.position).project(camera);
      const behind = projVec.z > 1;
      const sx = (projVec.x * 0.5 + 0.5) * W;
      const sy = (-projVec.y * 0.5 + 0.5) * H;
      const off = behind || sx < 0 || sx > W || sy < 0 || sy > H;
      if (!off) continue;
      if (used >= 6) break;
      let a = arrowPool[used];
      if (!a) {
        a = document.createElement('div');
        a.className = 'warn-arrow';
        ui.warnArrows.appendChild(a);
        arrowPool[used] = a;
      }
      // clamp to the screen edge and point outward toward the threat
      const cx = W / 2, cy = H / 2;
      let dx = (behind ? -sx : sx) - cx, dy = (behind ? -sy : sy) - cy;
      const len = Math.hypot(dx, dy) || 1;
      dx /= len; dy /= len;
      const halfW = cx - margin, halfH = cy - margin;
      const scale = Math.min(halfW / Math.abs(dx || 1e-6), halfH / Math.abs(dy || 1e-6));
      const px = cx + dx * scale, py = cy + dy * scale;
      a.style.display = 'block';
      a.style.left = (px - 11) + 'px';
      a.style.top = (py - 10) + 'px';
      a.style.transform = `rotate(${Math.atan2(dy, dx) * 180 / Math.PI - 90}deg)`;
      used++;
    }
    for (let i = used; i < arrowPool.length; i++) arrowPool[i].style.display = 'none';
  }

  // ---------------------------------------------------------------------
  // HUD
  // ---------------------------------------------------------------------
  function updateHUD() {
    ui.score.textContent = state.score.toLocaleString();
    ui.hiscore.textContent = Math.max(state.hi, state.score).toLocaleString();
    ui.wave.textContent = state.wave;
    ui.shield.style.width = state.shield + '%';
    ui.shield.classList.toggle('low', state.shield <= 30);
    ui.boost.style.width = state.boost + '%';
    const wpn = WEAPONS[state.weapon] || WEAPONS[1];
    if (ui.weaponName.textContent !== wpn.name) {  // only touch the DOM on change
      ui.weaponName.textContent = wpn.name;
      ui.weaponIcon.src = wpn.icon;
    }
    if (boss) {
      // remaining health across ALL phases, so the bar never refills
      const left = bossStageHp() + bossHpBelowStage(boss._stage);
      ui.bossFill.style.width = Math.max(0, 100 * left / BOSS_TOTAL_HP) + '%';
    }
  }

  // ---------------------------------------------------------------------
  // Flow control
  // ---------------------------------------------------------------------
  function clearWorld() {
    [lasers, enemies, enemyShots, asteroids, rings, particles, powerups].forEach(arr => {
      while (arr.length) scene.remove(arr.pop());
    });
    if (boss) { if (boss._beam) scene.remove(boss._beam); scene.remove(boss); boss = null; }
    clearWingmen();
    arrowPool.forEach((a) => { a.style.display = 'none'; });
    if (ui.sectorClear) ui.sectorClear.classList.add('hidden');
    ui.bossWrap.classList.add('hidden');
    ui.villain.classList.add('hidden');
  }

  function startGame() {
    Sound.resume();
    clearWorld();
    Object.assign(state, {
      running: true, score: 0, shield: 100, boost: 100, wave: 1,
      speed: BASE_SPEED, time: 0, fireTimer: 0, spawnTimer: 0.5,
      ringTimer: 3, combo: 0, comboTimer: 0, rolling: 0, rollCooldown: 0,
      invuln: 0, shake: 0, kills: 0, weapon: 1, puTimer: 8, lastBossWave: 0,
      slowmo: 0, kick: 0, bossCooldown: 0,
    });
    vel.x = vel.y = 0;
    mouse.active = false; mouse.wheel = 0; keys.fire = false;
    document.body.classList.remove('mouse-flying');
    ui.reticle.style.left = ''; ui.reticle.style.top = '';
    commsCooldown = 0;
    lowHpWarned = false;
    setEnvironment(ENV_ORDER[0], true);   // every run opens on the orbital approach
    Music.start(Sound.context());
    Sound.engineStart();
    radio('start', true);
    ship.position.set(0, 1.5, SHIP_Z);
    ui.title.classList.add('hidden');
    ui.gameover.classList.add('hidden');
    ui.hud.classList.remove('hidden');
    ui.combo.classList.add('hidden');
    updateHUD();
  }

  function gameOver() {
    state.running = false;
    mouse.active = false; keys.fire = false;
    document.body.classList.remove('mouse-flying');   // restore the cursor for menus
    explode(ship.position, 0x38e8ff, 30, 40);
    Music.stop();
    Sound.engineStop();
    Sound.bigBoom();
    Sound.gameOver();
    if (state.score > state.hi) { state.hi = state.score; localStorage.setItem('nebulawing_hi', state.hi); }
    ui.finalScore.textContent = state.score.toLocaleString();
    ui.finalHi.textContent = state.hi.toLocaleString();
    ui.hud.classList.add('hidden');
    setTimeout(() => ui.gameover.classList.remove('hidden'), 700);
  }

  // ---- preloader ----------------------------------------------------------
  // Everything is preloaded up front (models + backdrops), and LAUNCH stays
  // disabled until it's in, so the fighter never pops in mid-flight.
  (() => {
    const el = document.getElementById('preload');
    const bar = document.getElementById('preload-bar');
    const sub = document.getElementById('preload-sub');
    if (!el) return;
    ui.startBtn.disabled = true;
    ui.startBtn.textContent = 'LOADING…';

    // count the backdrop images alongside the models
    const bgFiles = Object.values(ENVIRONMENTS).map((e) => e.img);
    let imgDone = 0;
    bgFiles.forEach((src) => {
      const im = new Image();
      im.onload = im.onerror = () => { imgDone++; refresh(); };
      im.src = src;
    });

    let settled = false;
    function refresh() {
      const g = GLBKit.stats();
      const total = g.requested + bgFiles.length;
      const done = g.finished + imgDone;
      const pct = total ? Math.round(100 * done / total) : 0;
      bar.style.width = pct + '%';
      sub.textContent = pct < 100 ? `INITIALIZING SQUADRON SYSTEMS · ${pct}%` : 'ALL SYSTEMS NOMINAL';
      if (!settled && g.done && imgDone >= bgFiles.length) {
        settled = true;
        ui.startBtn.disabled = false;
        ui.startBtn.textContent = 'LAUNCH';
        setTimeout(() => {
          el.classList.add('done');
          setTimeout(() => { el.style.display = 'none'; }, 600);
        }, 350);
      }
    }
    GLBKit.setProgress(refresh);
    // models are requested a tick later; keep polling briefly so we never
    // latch "done" before the queue has actually been filled
    const poll = setInterval(() => { refresh(); if (settled) clearInterval(poll); }, 250);
    setTimeout(() => { if (!settled) { settled = true; ui.startBtn.disabled = false;
      ui.startBtn.textContent = 'LAUNCH'; el.classList.add('done');
      setTimeout(() => { el.style.display = 'none'; }, 600); } }, 45000);  // failsafe
  })();

  // thumb pads
  bindHoldButton($('pad-boost'), () => { keys.boost = true; }, () => { keys.boost = false; });
  bindHoldButton($('pad-roll'), () => { startRoll(vel.x >= 0 ? 1 : -1); });

  // decode the sound pack as soon as the user interacts (autoplay policy)
  ['pointerdown', 'keydown'].forEach((ev) =>
    window.addEventListener(ev, () => Sound.resume(), { once: true }));

  ui.startBtn.addEventListener('click', () => { Sound.menu(); startGame(); });
  ui.restartBtn.addEventListener('click', () => { Sound.menu(); startGame(); });

  // ship selection cards
  const shipCards = Array.from(document.querySelectorAll('.ship-card'));
  // label each card with its role so the choice reads at a glance
  shipCards.forEach((card) => {
    const s = window.SHIP_SCHEMES[card.dataset.scheme];
    if (!s || !s.blurb) return;
    const tag = document.createElement('em');
    tag.className = 'ship-blurb';
    tag.textContent = s.blurb;
    card.appendChild(tag);
  });
  function highlightCard() {
    shipCards.forEach(c => c.classList.toggle('selected', c.dataset.scheme === shipScheme));
  }
  shipCards.forEach(card => card.addEventListener('click', () => {
    applyShipScheme(card.dataset.scheme);
    highlightCard();
    Sound.resume(); Sound.menu();
  }));
  highlightCard();  // reflect stored/default choice

  // show stored hi-score on title
  ui.hiscore.textContent = state.hi.toLocaleString();

  // kick off render loop (idle until started)
  loop();

  // Debug hook — lets a headless harness (where requestAnimationFrame is
  // paused) pump the simulation manually and inspect world state. Harmless
  // in normal play; ignore it.
  window.__sw = {
    state,
    keys,
    start: startGame,
    step: (dt = 1 / 60) => { if (state.running) update(dt); },
    counts: () => ({
      enemies: enemies.length, asteroids: asteroids.length,
      lasers: lasers.length, enemyShots: enemyShots.length,
      rings: rings.length, particles: particles.length,
      powerups: powerups.length,
    }),
    boss: () => boss ? { stage: boss._stage, label: BOSS_STAGES[boss._stage] && BOSS_STAGES[boss._stage].key,
      stageHp: bossStageHp(), stageMax: boss._stageHpMax,
      parts: boss._parts.map(p => p._hp), beam: !!boss._beam,
      x: +boss.position.x.toFixed(1), z: +boss.position.z.toFixed(1) } : null,
    wingmen: () => wingmen.map(w => ({ phase: w._phase, life: +w._life.toFixed(1), guard: w._guard,
      x: +w.position.x.toFixed(1), z: +w.position.z.toFixed(1) })),
    enemyRoles: () => {
      const c = {};
      for (const e of enemies) {
        const name = Object.keys(ENEMY_TYPES).find(k => ENEMY_TYPES[k] === e._type) || '?';
        c[name] = (c[name] || 0) + 1;
      }
      return c;
    },
    callWingmen,
    damage,
    stats: () => ({ scheme: shipScheme, ...shipStats }),
    env: () => ({ key: currentEnv, opacity: +backdrop.material.opacity.toFixed(2),
                  hasMap: !!backdrop.material.map }),
    tally: () => ({ ...state.tally }),
    resetTally: () => { state.tally = { fired: 0, weak: 0, armour: 0, expired: 0 }; },
    forceBoss: spawnBoss,
    forcePU: (type) => {
      const m = makePickup(type || 'laser');
      m.position.set(ship.position.x, ship.position.y, SPAWN_Z);
      scene.add(m); powerups.push(m);
    },
    ship: () => ({ x: +ship.position.x.toFixed(2), y: +ship.position.y.toFixed(2) }),
    shipInfo: () => {
      let meshes = 0;
      ship.traverse((o) => { if (o.isMesh) meshes++; });
      return { children: ship.children.length, meshes, thrusters: ship._thrusters.length, disposable: ship.userData.disposable };
    },
    renderShot: () => { renderer.render(scene, camera); },
    // offscreen capture of the live scene (main canvas has no preserved buffer)
    capture: (w = 1100, h = 620) => {
      const r2 = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
      r2.setSize(w, h); r2.outputEncoding = THREE.sRGBEncoding;
      const cam2 = camera.clone(); cam2.aspect = w / h; cam2.updateProjectionMatrix();
      r2.render(scene, cam2);
      const b64 = r2.domElement.toDataURL('image/jpeg', 0.78).split(',')[1];
      r2.dispose();
      return b64;
    },
    setShip: (x, y) => { ship.position.x = x; ship.position.y = y; vel.x = vel.y = 0; },
    enemies: () => enemies.map(e => ({ x: +e.position.x.toFixed(1), y: +e.position.y.toFixed(1), z: +e.position.z.toFixed(1), hp: e._hp })),
  };
})();
