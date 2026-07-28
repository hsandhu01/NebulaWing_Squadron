/* ==========================================================================
   NEBULAWING SQUADRON — PLAYER FIGHTERS (textured GLB models)

   Four selectable Meshy hulls, each loaded via GLBKit (shared cache). All
   share the Meshy orientation convention (nose -X) so they rotate -90° about
   Y to fly forward (-Z). Procedural exhaust flames are added so the game's
   existing thruster flicker animates them.

   Public API preserved:  window.SHIP_SCHEMES, window.buildNebulaShip()
   ========================================================================== */
(() => {
  'use strict';

  // Three flat-winged fighters. (The "Cosmic" GLB is a rocket/shuttle shape,
  // not a fighter, so it's used as the smart-bomb projectile instead.)
  // Each hull flies differently. `stats` are read by game.js:
  //   agility  steering responsiveness      armour  shield pool multiplier
  //   boost    boost strength / regen       power   weapon damage multiplier
  window.SHIP_SCHEMES = {
    orange: { name: 'Vanguard', glb: 'assets/ship_orange.glb',  flame: 0xff9a3c,
              blurb: 'BALANCED', stats: { agility: 1.0,  armour: 1.0,  boost: 1.0,  power: 1.0 } },
    blue:   { name: 'Talon',    glb: 'assets/player_ship.glb',  flame: 0x74c0ff,
              blurb: 'FAST · FRAGILE', stats: { agility: 1.35, armour: 0.78, boost: 1.35, power: 0.9 } },
    green:  { name: 'Viper',    glb: 'assets/ship_green.glb',   flame: 0x7affe0,
              blurb: 'HEAVY · HARD-HITTING', stats: { agility: 0.82, armour: 1.28, boost: 0.85, power: 1.35 } },
  };

  const NOSE_FIX_Y = -Math.PI / 2;  // model nose is -X -> faces -Z (forward)
  const TARGET_LEN = 5.1;           // normalize every hull to the same footprint

  function addExhaust(ship, THREE, scheme) {
    const flameMat = new THREE.MeshBasicMaterial({
      color: scheme.flame, transparent: true, opacity: 0.5,
      depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    });
    const coreMat = new THREE.MeshBasicMaterial({
      color: 0xeafcff, transparent: true, opacity: 0.85,
      depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    });
    for (const sx of [-1, 1]) {
      const outer = new THREE.Mesh(new THREE.ConeGeometry(0.24, 1.4, 14, 1, true), flameMat);
      outer.rotation.x = Math.PI / 2;          // apex points +Z (rearward)
      outer.position.set(sx * 0.55, -0.03, 2.35);
      ship.add(outer); ship._thrusters.push(outer);

      const inner = new THREE.Mesh(new THREE.ConeGeometry(0.12, 1.0, 12, 1, true), coreMat);
      inner.rotation.x = Math.PI / 2;
      inner.position.set(sx * 0.55, -0.03, 2.2);
      ship.add(inner); ship._thrusters.push(inner);
    }
  }

  window.buildNebulaShip = function buildNebulaShip(THREE, schemeName = 'blue') {
    const scheme = window.SHIP_SCHEMES[schemeName] || window.SHIP_SCHEMES.blue;
    const ship = new THREE.Group();
    ship.name = `Nebulawing ${scheme.name}`;
    ship._thrusters = [];
    ship.userData.scheme = schemeName;
    ship.userData.disposable = false;          // GLB resources are shared+cached

    addExhaust(ship, THREE, scheme);
    ship.add(window.GLBKit.instance(scheme.glb, { rotY: NOSE_FIX_Y, targetLen: TARGET_LEN }));
    return ship;
  };
})();
