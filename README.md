# AETHERIUM: SHARDLANDS

**[▶ Play in your browser](https://avielbaum.github.io/shardlands/)** — desktop (keyboard + mouse) or mobile (touch). No install; everything is generated in the page.

A first-person open-world immersive-sim RPG set in a clockwork-alchemical world. It's written in plain HTML5, ES modules and raw WebGL 2.0. There are no engines, libraries or asset files: every texture, sprite, sound and place is generated in code, and progress saves to `localStorage`.

It takes after the hands-on dungeons and living towns of the classic *Ultima* games, and the learn-by-doing progression, guild work and open roaming of *The Elder Scrolls*.

## The story

You wake in the **Sunken Observatory**. Find the Brass Lantern and the Resonance Tuning Fork, and work out the three levers that relight the anchors, so the **Great Astrolabe Gate** opens onto the Shardlands. Up there the ley-lines are drifting. Master Vance of the Artificers' Guild in **Cinderwick** knows why: the Astrolabe's **Resonant Core** lies in the Drowned Shrine, out in the fen.

## The world

- **Overworld:** a 256×256 seeded map, streamed in 16×16 chunks. It has three blended biomes (the **Whispering Brass Fen**, the **Basalt Badlands** and the **Ley-Wood**), graded cobbled roads, roadside campfires, ley pylons and standing stones to discover, and herbs and salvage to gather.
- **Towns:** **Cinderwick** and **Oakhaven** each have a market plaza, tavern, guildhall, two shops and four houses. Around 10 townsfolk live in each, working stalls by day and gathering at the tavern by night. Doors open for them as they pass.
- **Dungeons:** four delvable shrines. Each has six rooms with locked and rune-sealed doors, deep pools or scalding vents, a guardian, a prize and a lore tablet. The **Hollow Spire** sits inside a chasm ring that only *Feather Step* crosses.
- **Interactable world:** doors (open, key-locked, lockpickable or rune-sealed), chests, readable tablets and books, beds, campfires, levers, and an automap with fog of war that takes your own markers.

## Systems

| System | How it works |
|---|---|
| Combat | The **Tuning Fork** sweeps when you strafe, thrusts when you advance and chops when you stand still. Tap **parry** to deflect orbs and stagger attackers, or hold it to block. The **Prism Scattergun** and **Alchemical Crossbow** fire Prism Shards, Ignis Flares (burning) or Frost Bolts (slowing), and shots ricochet off walls. **Phase Dash** gives invulnerability frames. |
| Runecasting | Collect Runestones and inscribe them in combinations: *Lumina* (Lux), *Mending* (Vita + Lux), *Kinetic Push* (Vis, which shoves constructs into water, vents or chasms), *Unlock* (Aperio + Vis) and *Feather Step* (Levis + Vis). |
| Progression | **Blade & Parry**, **Artificing**, **Aether Lore** and **Wayfaring** rise as you use them. Every 10 skill increases gives a character level, with an attribute point (Might, Finesse, Intellect, Presence) and a perk point. |
| Inventory | A weight-limited pack with Main Hand, Off-Hand/Lantern, Armor and Relic slots, plus an **Alchemy & Tinkering** tab for draughts, tonics, lockpicks, ammunition and weapon oils. |
| Trade | Six merchants with daily restocks. Prices depend on Wayfaring, Presence and town reputation. |
| Dialogue | Morrowind-style topics (*Rumours*, *The Observatory*, *Local Trade*, *Nearby Ruins*) plus branching choices with skill checks, e.g. `[Artificing 2] Offer to repair their broken water-pump`. |
| Quests & factions | A journal for the main storyline, town requests, and procedural contracts from **The Artificers' Guild** and **The Wayfarer's Wardens** (relics, bounties, surveys, deliveries, supplies). |
| Time | Day and night: one real second is one game minute. Fog and light change with biome and hour. Rest at beds and campfires to pass the time. |

## Controls

| | Desktop | Touch |
|-|---------|-------|
| Move / look | WASD + mouse (Pointer Lock) | Left / right thumb sticks |
| Attack or cast | Left click | ATTACK |
| Parry / block | Right click (tap / hold) | PARRY |
| Interact | E | USE |
| Dash / jump | Shift (or double-tap WASD) / Space | DASH / JUMP |
| Hotbar | 1-6, wheel, Q; R switches ammo | Tap a hotbar slot |
| Panels | Tab or I, K, J, M | PACK, SKILLS, LOG, MAP |
| Save / load | F5 / F9, or Menu | Menu |

Panels release the mouse so you can click; closing a panel locks it again. Some embedded browsers refuse pointer lock. The game then switches to free mouse look, and resting the cursor near a screen edge keeps turning. Touch controls switch on automatically on touch devices, and the **Touch HUD** button toggles them by hand.

## Running locally

ES modules don't load from `file://`, so serve the folder over HTTP:

```bash
python -m http.server 8000
```

Then open <http://localhost:8000>. Add `?seed=1234` to the URL to play a specific world. Add `?debug` to expose the running app as `window.__app`, for console inspection and scripted playtests.

## Hosting on GitHub Pages

Push the folder with `index.html` at the root. Then go to **Settings → Pages → Deploy from a branch** and choose your branch and `/ (root)`. Nothing loads from outside the repo, so CORS never applies.

## Code map

| File | Role |
|------|------|
| `index.html` | Canvas, HUD layer, hotbar, modal host, touch controls |
| `src/main.js` | `Game` (rules, time, levels and streaming, interaction, combat resolution, contracts, quests, save/load), `Input`, HUD, the `App` state machine and every modal |
| `src/renderer.js` | WebGL 2 renderer. World tiles are 256px texture-array layers (albedo, normal, roughness/specular/cavity/metal) with mipmaps and anisotropic filtering. Pixel edges stay crisp up close. Shading: normal mapping, Blinn-Phong sun plus 16 point lights, a world-space detail texture against visible tiling, and corner ambient occlusion. Sprites get soft blended edges and contact shadows. Outdoors there's a sky with sun glow, and `exp2` height-and-distance fog everywhere. The scene renders to an HDR buffer and is finished with bloom, FXAA, ACES tone mapping and warm/cool grading. Internal resolution adapts to hold 60 FPS. |
| `src/textures.js` | Tileable Perlin, Worley and fBm noise. Painted tiles are grown into 256px albedo, normal and material maps, with stone grain and pits, brass micro-scratches and verdigris patina, mortar crevices, moss creeping from floor seams, wood fibres, wet mud and pebbles. A z-buffered "pixel sculptor" makes the constructs, townsfolk, flora, props, item icons and hand viewmodels, with occlusion, warm and cool rim light, fabric folds and feathered silhouettes. |
| `src/audio.js` | Web Audio synth: combat, locks, brewing, footsteps by surface, NPC voices, biome ambiences, adaptive music |
| `src/world.js` | Seeded generators (observatory, overworld, towns, dungeons), the `Level` grid with collision and line of sight, the `ChunkStreamer` |
| `src/rpg.js` | Items, recipes, runes and spells, character, inventory, quests, contracts, pricing, books, dialogue engine |
| `src/entities.js` | Player controller, constructs and their AI, orbs, projectiles, scheduled NPCs, particles |

## License

MIT. See [LICENSE](LICENSE).
