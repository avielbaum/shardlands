# AETHERIUM: SHARDLANDS

**[▶ Play in your browser](https://avielbaum.github.io/shardlands/)** — desktop (keyboard + mouse) or mobile (touch). No install; everything is generated in the page.

A first-person open-world immersive-sim RPG set in a clockwork-alchemical world. It's written in plain HTML5, ES modules and raw WebGL 2.0. There are no engines, libraries or asset files: every texture, model, sound and place is generated in code, and progress saves to `localStorage`.

It takes after the hands-on dungeons and living towns of the classic *Ultima* games, and the learn-by-doing progression, guild work and open roaming of *The Elder Scrolls*.

## The story

You wake in the **Sunken Observatory**. Find the Aether Lantern and the Resonance Tuning Fork, and work out the three levers that relight the anchors (or speak a rune in the Gate Hall), so the **Great Astrolabe Gate** opens onto the Shardlands. Up there the ley-lines are drifting. Master Vance of the Artificers' Guild in **Cinderwick** knows why: the Astrolabe's **Resonant Core** lies in the Drowned Shrine, out in the fen.

## Character creation

**New Game** opens the Astrolabe character creation screen. Name your character (or roll a lore-friendly name), switch the Guided Tutorial on or off, then either:

- **Direct Selection:** pick any of six **Professions** and seven **Mythic Birthsigns** from cards. A live summary shows your attributes, skills, vitals, starting gear, boon and power.
- **Consult the Astrolabe:** answer the Astral Oracle's four moral dilemmas and one birth omen. The Oracle reads a profession and a sign from your answers; accept its reading unchanged for a **Fated Alignment** (+5% skill gain). You can still change either choice afterwards, but the alignment holds only while both match.

| Profession | Bonuses | Starting gear and perk |
|---|---|---|
| Ley-Wright | +2 Artificing, +1 Aether Lore | Brass Scrap, Lockpicks, Calibrated Prism Lens (ranged shots bank off one extra wall) |
| Shard-Warden | +2 Blade & Parry, +1 Wayfaring | Riveted Leather Brigandine, Whetstone Oil; +15 maximum Health |
| Aether-Seer | +2 Aether Lore, +1 Artificing | Vita Runestone (for Mending), Lore Compendium; +20 maximum Aether |
| Fen-Strider | +2 Wayfaring, +1 Blade & Parry | Herbal Poultices; Phase Dash costs 15% less, wider map charting |
| Guild Factor | +2 Wayfaring, +1 Artificing | 75 Aether Shards; 15% better prices, [Mercantile] persuasion with merchants |
| Cinder-Alchemist | +2 Aether Lore, +1 Wayfaring | Alchemical Mortar (each draught, tonic and oil brews one extra) and four reagents |

| Birthsign | Boon | Power (R / POWER) |
|---|---|---|
| The Pendulum | Timed parries restore stamina and stagger longer | Temporal Stasis: enemies and their orbs slow by 65% for 4 s |
| The Crucible | 25% less hazard and fall damage; potions 30% stronger | Alchemical Nova: a burning blast that hurls back nearby foes |
| The Astrolabe | Nearby unlooted chests and vents chime; +15% skill gain from discovery and lockpicking | Astral Sight: enemies, chests and your quest marker show through walls for 12 s |
| The Spire | +40 maximum Aether; faster Aether recovery while still | Ley-Surge: full Aether and free runes for 5 s |
| The Hound | +15% speed, +25 carry, longer Phase Dash | Phantom Stride: enemies lose you and you move 50% faster for 6 s |
| The Veiled Crown | +15 standing with every town and guild; extra lore | Command Resonance: the nearest construct (not a boss) stands down for 15 s |
| The Shattered Star | 25% critical hits, 30% more shards from chests, but 15% less Health | Supernova Strike: your next hit or rune within 6 s deals triple damage |

Powers recharge over time (75 to 150 seconds) or when you rest. Your profession's gear waits in the starter chest. Townsfolk, guild masters and the Archivist remark on your past, your sign and whether you accepted the Oracle's reading, and some conversations offer options only your profession can take. Your identity is saved with the game, and the creation screen remembers your last choices.

## Guided tutorial

The title screen has a **Guided Tutorial: ON / OFF** toggle, which is remembered. With it on, a small card at the top of the screen walks you through five steps and moves on by itself as you do each one:

1. **Look & Move** to the glowing Resonance Brazier.
2. **Interact & Loot** the starter chest: Tuning Fork, Aether Lantern, Lumina Runestone and two Healing Draughts.
3. **Equip** them from the Inventory, then close it.
4. **Combat**: attack, parry or dash against the training automaton in the Atrium.
5. **Open the Gate**: cast a rune in the Gate Hall or pull the Harmonic Levers, then step outside.

The card never blocks the game, and its wording follows your controls (desktop or touch). You can leave at any time with **End Tutorial [Esc / Tap]**, the pause menu, or by asking **The Archivist** beside your bed. Ending early puts any starter gear you haven't looted into your pack and opens the Gate.

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
| Weather | Clear, cloudy, rain and storm, rolled every few in-game hours with odds set by biome. Rain dims the sun and thickens the fog. Storms bring lightning flashes and thunder that rolls in late from far strikes. Rain and wind have their own sound, muffled under a roof. |

## Controls

| | Desktop | Touch |
|-|---------|-------|
| Move / look | WASD + mouse (Pointer Lock) | Left / right thumb sticks |
| Attack or cast | Left click | ATTACK |
| Parry / block | Right click (tap / hold) | PARRY |
| Interact | E | USE |
| Dash / jump | Shift (or double-tap WASD) / Space | DASH / JUMP |
| Hotbar | 1-6, wheel, Q; T switches ammo | Tap a hotbar slot |
| Birthsign Power | R | POWER |
| Panels | Tab or I, K, J, M | PACK, SKILLS, LOG, MAP |
| Save / load | F5 / F9, or Menu | Menu |

Panels release the mouse so you can click; closing a panel locks it again. Some embedded browsers refuse pointer lock. The game then switches to free mouse look, and resting the cursor near a screen edge keeps turning. Touch controls switch on automatically on touch devices, and the **Touch HUD** button toggles them by hand.

## Running locally

The character-origin rules have a self-check: `node tests/destiny.mjs`.

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
| `src/renderer.js` | WebGL 2 renderer, physically based and in linear light. World tiles sample 512px texture-array PBR layers (albedo, normal, roughness/specular/cavity/metal), trilinear with 16x anisotropy. Shading is Cook-Torrance (GGX, Smith, Schlick) for the sun or moon and 16 point lights, with hemisphere sky/ground ambient and an environment-reflection approximation; rain darkens and polishes open ground. Props, trees, grass and items are 3D meshes, welded into indexed buffers and hardware-instanced per model, with distance and facing culling and a low-poly far LOD. Characters are skinned to up to 16 bones per draw, and the weapon and lantern viewmodels are 3D too. A 2048px directional shadow map with PCF grounds everything outdoors, SSAO (half-res, depth-aware blur) darkens creases, and fog is exponential distance haze plus analytic height mist that drifts. Rain is a GPU particle system placed entirely in the vertex shader. The frame renders to an HDR buffer and is finished with bloom, FXAA, ACES tone mapping and grading. Internal resolution adapts to hold 60 FPS. |
| `src/textures.js` | Tileable Perlin, Worley and fBm noise. Painted tiles are softened, graded toward a muted, weathered palette, then grown into 512px albedo, normal and material maps with domain-warped grain, pores, Worley pits and fractures, brass scratches and verdigris patina, mortar crevices, moss creeping from floor seams, wood fibres, wet mud and pebbles. A small "sculptor" also paints the 2D sprite atlas the UI uses for item icons and dialogue portraits. |
| `src/models.js` | Procedural 3D sculpting. Surfaces are lofted through elliptical cross-sections or swept along Catmull-Rom splines (parallel-transport frames, 24-32 radial segments), Laplacian-smoothed, and roughened by fBm displacement along their normals (chipped stone, bark ridges, craggy basalt, dented plate). Every model is finished with area-weighted smooth normals (hard creases kept) and per-vertex ambient occlusion baked from a voxelized copy of the assembled body. Characters have realistic adult proportions and layered gear (skirted tunics, robes, aprons, belts and pouches, riveted pauldrons, hoods, cloaks with gravity folds, articulated hands gripping their weapons), with idle weight shifts, stride counter-rotation and cloak sway; distant characters and trees switch to lighter LODs. Also the props, items, roofs, door arches and first-person viewmodels. |
| `src/audio.js` | Web Audio engine, no samples. Music, SFX, Ambience and UI buses run into a warmth shelf, glue compressor and limiter, with two in-memory convolution reverbs (stone hall, open air) crossfaded by place. Enemy steps, attack tells, shots, impacts, fires and vents are placed in 3D (HRTF) with distance air absorption. Foley is layered and modal (surface-aware footsteps, the tuning fork's ring, latches, string snaps, tumblers, grinding stone, bubbling brews, parchment, formant voices). The generative score crossfades between observatory, dungeon, day, night and town stems (Karplus-Strong lute and harp, bowed strings, celesta and bells), with a combat layer of drums, clockwork ticks and a string ostinato. Master, Music and SFX volume sliders sit in the pause menu. |
| `src/world.js` | Seeded generators (observatory, overworld, towns, dungeons), the `Level` grid with collision and line of sight, the `ChunkStreamer` |
| `src/rpg.js` | Items, recipes, runes and spells, character, inventory, quests, contracts, pricing, books, dialogue engine |
| `src/entities.js` | Player controller, constructs and their AI, orbs, projectiles, scheduled NPCs, particles |

## License

MIT. See [LICENSE](LICENSE).
