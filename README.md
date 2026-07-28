# NEBULAWING SQUADRON

A Star Fox–style on-rails 3D space shooter that runs in the browser. Built with
Three.js — no build step, no framework, no dependencies to install.

**▶ Play: https://hsandhu01.github.io/NebulaWing_Squadron/**

---

## Controls

| Mouse | Keyboard | Touch |
| --- | --- | --- |
| **Move** — fly | **W A S D** / **Arrows** — steer | **Drag** anywhere — fly |
| **Left click** — fire | **Space** / **J** — fire | *guns are automatic* |
| **Right click** — barrel roll | **Q** / **E** — barrel roll | **ROLL** pad |
| **Wheel** — boost / brake | **Shift** — boost · **Ctrl** — brake | **BOOST** pad |

All three schemes are live at once — move the mouse to fly with it, touch a
steering key to hand control back to the keyboard, or drag on a touchscreen.
A barrel roll deflects incoming fire.

Phones and tablets are supported: drag to fly, guns fire themselves so your
thumb stays on the stick, and roll/boost sit in the bottom corners. The menus
reflow for small screens in either orientation.

## Features

- **Three fighters** with real handling identities — Vanguard (balanced),
  Talon (fast, fragile), Viper (heavy, hard-hitting). Ship choice changes
  steering response, damage taken, boost, and firepower.
- **Five enemy roles** you can read by silhouette — scouts zigzag, interceptors
  corkscrew in, kamikazes lock on and strobe before charging, heavies fire
  clusters — plus V-wing, line-abreast and bomber-escort formations.
- **Three-phase dreadnought boss.** Break the flank cannons, then the engine
  vents, then the exposed core, while dodging a sweeping laser lance.
- **Squadron assist** — a pickup calls in Dash and Skye, who fly past the
  camera, hold formation, mirror your weapon tier, block a shot each, and fire
  a parting missile salvo before peeling off.
- **Weapon tiers** — Pulse Pistol → Storm Rifle → Rail Cannon (piercing).
- **Near-miss system** — graze a shot or a meteor for points, combo, boost and
  a beat of slow motion.
- **Four environments** that cycle as you progress: orbital approach, asteroid
  belt, veil nebula, fleet graveyard.
- Destructible molten meteors, procedural soundtrack, sampled SFX pack.

## Running locally

Any static file server works — the game needs `http://` rather than `file://`
so the browser will load the GLB models.

```bash
python -m http.server 5180
```

Then open <http://localhost:5180>.

## Project layout

```
index.html      markup + HUD
style.css       HUD, menus, preloader
game.js         engine: loop, spawning, combat, boss, audio, environments
ship.js         player fighter definitions (models + stat profiles)
glbkit.js       shared GLTF loader — caches each model once, pools instances
assets/         models, backdrops, UI art, sfx
```

Source material (raw pre-decimation exports, retired art) is kept out of the
repo — see `.gitignore`. Shipped models are decimated with
[gltf-transform](https://gltf-transform.dev/); the raw generator exports run to
roughly 1.5 GB, versus ~76 MB here.

## Credits

Art and audio generated for this project. Engine code written with
[Claude Code](https://claude.com/claude-code).
