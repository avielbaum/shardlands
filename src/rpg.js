/**
 * @file Core RPG systems and data: items, equipment and weight-limited inventory, alchemy &
 * tinkering recipes, runestones and spell combinations, learn-by-doing skills with levels,
 * attributes and perks, faction reputation, quest journal, guild contracts, merchant pricing,
 * lore books and the Morrowind-style topic / branching dialogue engine with skill checks.
 */
import { SITES, mulberry32 } from './world.js';

/** @typedef {import('./main.js').Game} Game */
/** @typedef {import('./world.js').NpcDef} NpcDef */

// ---------------------------------------------------------------------------
// Skills, attributes, perks
// ---------------------------------------------------------------------------

/** @type {Readonly<Record<string, {name:string, desc:string}>>} */
export const SKILLS = Object.freeze({
  blade: { name: 'Blade & Parry', desc: 'Raised by landing melee strikes and, above all, timed parries.' },
  artificing: { name: 'Artificing', desc: 'Raised by picking locks, banking ricochet shots, and tinkering or brewing.' },
  aether: { name: 'Aether Lore', desc: 'Raised by casting rune spells.' },
  wayfaring: { name: 'Wayfaring', desc: 'Raised by discovering landmarks, bartering and finishing contracts.' },
});

/** @type {Readonly<Record<string, {name:string, desc:string}>>} */
export const ATTRIBUTES = Object.freeze({
  might: { name: 'Might', desc: '+Health, +melee damage, +carry capacity.' },
  finesse: { name: 'Finesse', desc: '+Stamina, +ranged damage, better lockpicking.' },
  intellect: { name: 'Intellect', desc: '+Aether, +spell potency.' },
  presence: { name: 'Presence', desc: 'Better prices and more persuasive words.' },
});

/** @type {ReadonlyArray<{id:string, skill:string, need:number, name:string, desc:string}>} */
export const PERKS = Object.freeze([
  { id: 'riposte', skill: 'blade', need: 3, name: 'Riposte', desc: 'A landed parry staggers longer and your next strike deals double damage.' },
  { id: 'heavy', skill: 'blade', need: 5, name: 'Heavy Resonance', desc: 'Melee strikes deal +25% damage.' },
  { id: 'steady', skill: 'artificing', need: 3, name: 'Steady Hands', desc: '+15% lockpicking chance; picks break half as often.' },
  { id: 'ricochet', skill: 'artificing', need: 5, name: 'Ricochet Savant', desc: 'Projectiles bounce once more and hit 20% harder after a bounce.' },
  { id: 'deepwell', skill: 'aether', need: 3, name: 'Deep Well', desc: '+25 maximum Aether.' },
  { id: 'efficient', skill: 'aether', need: 5, name: 'Rune Economy', desc: 'Spells cost 25% less Aether.' },
  { id: 'packmule', skill: 'wayfaring', need: 3, name: 'Pack Mule', desc: '+25 carry capacity.' },
  { id: 'silver', skill: 'wayfaring', need: 5, name: 'Silver Tongue', desc: 'Better prices with every merchant.' },
]);

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} ItemDef
 * @property {string} name
 * @property {'weapon'|'offhand'|'armor'|'relic'|'consumable'|'ingredient'|'material'|'tool'|'key'|'book'|'rune'|'ammo'|'quest'} type
 * @property {string} sprite
 * @property {number} weight
 * @property {number} value
 * @property {string} desc
 * @property {'melee'|'ranged'} [weapon]
 * @property {number} [damage]
 * @property {number} [pellets]
 * @property {number} [spread]
 * @property {number} [speed]
 * @property {number} [armor]
 * @property {number} [parry] extra parry window seconds
 * @property {boolean} [light]
 * @property {number} [heal]
 * @property {number} [mana]
 * @property {string} [oil]
 * @property {string} [ammo]
 * @property {string} [book]
 * @property {Record<string, number>} [bonus]
 */

/** @type {Record<string, ItemDef>} */
export const ITEMS = {
  fork: { name: 'Resonance Tuning Fork', type: 'weapon', sprite: 'i_fork', weight: 3, value: 40, weapon: 'melee', damage: 14, desc: 'A singing brass fork. Sweep, thrust or chop with it; time a strike to turn orbs back on their makers.' },
  scatter: { name: 'Prism Scattergun', type: 'weapon', sprite: 'i_scatter', weight: 6, value: 220, weapon: 'ranged', damage: 9, pellets: 3, spread: 0.12, speed: 22, desc: 'Splits ammunition into a fan of three. Shots ricochet off walls.' },
  crossbow: { name: 'Alchemical Crossbow', type: 'weapon', sprite: 'i_crossbow', weight: 5, value: 180, weapon: 'ranged', damage: 26, pellets: 1, spread: 0, speed: 30, desc: 'A single heavy bolt that banks off stone.' },
  lantern: { name: 'Brass Lantern', type: 'offhand', sprite: 'i_lantern', weight: 2, value: 30, light: true, desc: 'A steady amber light, carried in the off hand.' },
  buckler: { name: 'Riveted Buckler', type: 'offhand', sprite: 'i_buckler', weight: 4, value: 90, armor: 3, parry: 0.1, desc: '+3 armour and a wider parry window.' },
  coat: { name: 'Padded Fen Coat', type: 'armor', sprite: 'i_coat', weight: 5, value: 60, armor: 4, desc: 'Quilted canvas; light and warm.' },
  cuirass: { name: 'Brass Cuirass', type: 'armor', sprite: 'i_cuirass', weight: 12, value: 260, armor: 10, desc: 'Heavy riveted brass. Turns blades.' },
  charm: { name: 'Ley Compass Charm', type: 'relic', sprite: 'i_charm', weight: 0.5, value: 150, bonus: { wayfaring: 1 }, desc: '+1 Wayfaring. Its needle trembles near ley disturbances.' },
  amulet: { name: 'Ember Amulet', type: 'relic', sprite: 'i_amulet', weight: 0.5, value: 180, bonus: { mana: 25 }, desc: '+25 maximum Aether.' },
  draught: { name: 'Healing Draught', type: 'consumable', sprite: 'i_draught', weight: 0.5, value: 25, heal: 40, desc: 'Restores 40 health.' },
  tonic: { name: 'Mana Tonic', type: 'consumable', sprite: 'i_tonic', weight: 0.5, value: 30, mana: 40, desc: 'Restores 40 Aether.' },
  oil_ember: { name: 'Ember Weapon Oil', type: 'consumable', sprite: 'i_oil_ember', weight: 0.3, value: 35, oil: 'ember', desc: 'Coat your melee weapon: strikes burn for 90 seconds.' },
  oil_frost: { name: 'Frost Weapon Oil', type: 'consumable', sprite: 'i_oil_frost', weight: 0.3, value: 35, oil: 'frost', desc: 'Coat your melee weapon: strikes slow for 90 seconds.' },
  bread: { name: 'Fen Rye Loaf', type: 'consumable', sprite: 'i_bread', weight: 0.5, value: 3, heal: 10, desc: 'Dense and filling. Restores 10 health.' },
  apple: { name: 'Cinderwick Apple', type: 'consumable', sprite: 'i_apple', weight: 0.3, value: 2, heal: 6, desc: 'Grown in ash-rich soil. Restores 6 health.' },
  fen_lotus: { name: 'Fen Lotus', type: 'ingredient', sprite: 'herb_lotus', weight: 0.2, value: 6, desc: 'A pale bloom from the Whispering Brass Fen.' },
  ember_moss: { name: 'Ember Moss', type: 'ingredient', sprite: 'herb_moss', weight: 0.2, value: 6, desc: 'Warm to the touch. Grows on Badlands basalt.' },
  ley_bloom: { name: 'Ley Bloom', type: 'ingredient', sprite: 'herb_bloom', weight: 0.2, value: 8, desc: 'Glows faintly. Found under Ley-Wood canopy.' },
  scrap: { name: 'Brass Scrap', type: 'material', sprite: 'i_scrap', weight: 1, value: 4, desc: 'Bent cogs and plate. Tinkers want it.' },
  crystal: { name: 'Aether Crystal', type: 'material', sprite: 'i_crystal', weight: 0.3, value: 12, desc: 'Condensed ley energy.' },
  salt: { name: 'Basalt Salt', type: 'material', sprite: 'i_salt', weight: 0.3, value: 5, desc: 'A binding agent for oils.' },
  lockpick: { name: 'Lockpick', type: 'tool', sprite: 'i_lockpick', weight: 0.1, value: 6, desc: 'Used automatically on locks you lack a key for.' },
  book_almanac: { name: "A Fen-Walker's Almanac", type: 'book', sprite: 'i_book', weight: 1, value: 20, book: 'book_almanac', desc: 'A field guide to the fen.' },
  book_ley: { name: 'Treatise on Ley Resonance', type: 'book', sprite: 'i_book', weight: 1, value: 30, book: 'book_ley', desc: 'Dry, but true.' },
  book_colossus: { name: 'The Fall of the Brass Colossus', type: 'book', sprite: 'i_book', weight: 1, value: 20, book: 'book_colossus', desc: 'A tavern ballad, written down.' },
  rune_lux: { name: 'Runestone: Lux', type: 'rune', sprite: 'rune_lux', weight: 0.5, value: 80, desc: 'The rune of light.' },
  rune_vita: { name: 'Runestone: Vita', type: 'rune', sprite: 'rune_vita', weight: 0.5, value: 120, desc: 'The rune of life.' },
  rune_vis: { name: 'Runestone: Vis', type: 'rune', sprite: 'rune_vis', weight: 0.5, value: 120, desc: 'The rune of force.' },
  rune_aperio: { name: 'Runestone: Aperio', type: 'rune', sprite: 'rune_aperio', weight: 0.5, value: 160, desc: 'The rune of opening.' },
  rune_levis: { name: 'Runestone: Levis', type: 'rune', sprite: 'rune_levis', weight: 0.5, value: 200, desc: 'The rune of air and lightness.' },
  ammo_shard: { name: 'Prism Shards', type: 'ammo', sprite: 'i_ammo_shard', weight: 0.02, value: 1, ammo: 'shard', desc: 'Standard ricocheting ammunition.' },
  ammo_flare: { name: 'Ignis Flares', type: 'ammo', sprite: 'i_ammo_flare', weight: 0.05, value: 3, ammo: 'flare', desc: 'Burns the target over time.' },
  ammo_frost: { name: 'Frost Bolts', type: 'ammo', sprite: 'i_ammo_frost', weight: 0.05, value: 3, ammo: 'frost', desc: 'Slows the target.' },
  core: { name: 'Resonant Core', type: 'quest', sprite: 'i_core', weight: 2, value: 0, desc: 'Hums against your palm. The Great Astrolabe was built around something like this.' },
  relic: { name: 'Lost Astrolabe Fragment', type: 'quest', sprite: 'i_relic', weight: 1, value: 0, desc: 'Recovered for the Artificers.' },
  parcel: { name: 'Sealed Parcel', type: 'quest', sprite: 'i_parcel', weight: 1, value: 0, desc: 'Wax-sealed. Not yours to open.' },
};
for (const id of ['drowned', 'ember', 'verdant', 'spire']) {
  ITEMS[`key_${id}`] = { name: `Key to ${SITES[/** @type {'drowned'} */ (id)].name}`, type: 'key', sprite: 'i_key', weight: 0.1, value: 0, desc: 'Opens the locked doors inside.' };
}

/** @type {ReadonlyArray<{id:string, makes:[string, number], needs:[string, number][], level:number}>} */
export const RECIPES = Object.freeze([
  { id: 'draught', makes: ['draught', 1], needs: [['fen_lotus', 1], ['ember_moss', 1]], level: 1 },
  { id: 'tonic', makes: ['tonic', 1], needs: [['ley_bloom', 1], ['crystal', 1]], level: 1 },
  { id: 'lockpick', makes: ['lockpick', 3], needs: [['scrap', 1]], level: 1 },
  { id: 'ammo_shard', makes: ['ammo_shard', 10], needs: [['crystal', 1]], level: 1 },
  { id: 'ammo_flare', makes: ['ammo_flare', 6], needs: [['ember_moss', 1], ['scrap', 1]], level: 2 },
  { id: 'ammo_frost', makes: ['ammo_frost', 6], needs: [['fen_lotus', 1], ['crystal', 1]], level: 2 },
  { id: 'oil_ember', makes: ['oil_ember', 1], needs: [['ember_moss', 2], ['salt', 1]], level: 2 },
  { id: 'oil_frost', makes: ['oil_frost', 1], needs: [['fen_lotus', 2], ['salt', 1]], level: 2 },
]);

/** Spells are inscribed from runestone combinations. */
/** @type {Readonly<Record<string, {name:string, runes:string[], cost:number, desc:string}>>} */
export const SPELLS = Object.freeze({
  lumina: { name: 'Lumina', runes: ['rune_lux'], cost: 8, desc: 'A personal light that follows you for two minutes.' },
  mending: { name: 'Mending', runes: ['rune_vita', 'rune_lux'], cost: 18, desc: 'Knit wounds: restore health.' },
  push: { name: 'Kinetic Push', runes: ['rune_vis'], cost: 14, desc: 'A cone of force. Knock foes into water, vents or chasms.' },
  unlock: { name: 'Unlock', runes: ['rune_aperio', 'rune_vis'], cost: 15, desc: 'Open locks and rune seals in front of you.' },
  feather: { name: 'Feather Step', runes: ['rune_levis', 'rune_vis'], cost: 20, desc: 'Levitate: walk on air across chasms for a few seconds.' },
});

/** @type {Readonly<Record<string, string>>} */
export const FACTIONS = Object.freeze({
  artificers: "The Artificers' Guild", wardens: "The Wayfarer's Wardens", cinderwick: 'Cinderwick', oakhaven: 'Oakhaven',
});

/** Merchant stock: item id and base quantity. */
/** @type {Readonly<Record<string, {name:string, town:string, items:[string, number][]}>>} */
export const SHOPS = Object.freeze({
  sundries: { name: "Gearwright's Sundries", town: 'cinderwick', items: [['lockpick', 10], ['scrap', 6], ['crystal', 4], ['ammo_shard', 40], ['lantern', 1], ['bread', 5], ['book_ley', 1]] },
  forge: { name: 'Flint Forge', town: 'cinderwick', items: [['scatter', 1], ['crossbow', 1], ['buckler', 1], ['cuirass', 1], ['coat', 2], ['ammo_shard', 30], ['ammo_flare', 12]] },
  tavern_c: { name: 'The Molten Mug', town: 'cinderwick', items: [['bread', 8], ['apple', 8], ['draught', 2]] },
  apothecary: { name: "Rowan's Apothecary", town: 'oakhaven', items: [['draught', 5], ['tonic', 5], ['oil_ember', 2], ['oil_frost', 2], ['fen_lotus', 4], ['ember_moss', 4], ['ley_bloom', 4], ['salt', 4], ['rune_levis', 1], ['book_almanac', 1]] },
  quiver: { name: 'Quill & Quiver', town: 'oakhaven', items: [['ammo_shard', 40], ['ammo_frost', 12], ['ammo_flare', 8], ['crossbow', 1], ['coat', 1], ['charm', 1]] },
  tavern_o: { name: 'The Rooted Lantern', town: 'oakhaven', items: [['bread', 8], ['apple', 6], ['tonic', 2], ['book_colossus', 1]] },
});

/** Readable lore: tablets in the world and books in the pack. */
/** @type {Readonly<Record<string, {title:string, text:string}>>} */
export const BOOKS = Object.freeze({
  keeper_log: { title: "The Keeper's Last Log", text: "Third night the anchors have drifted. The ley-lines under the Shardlands pull at the Great Astrolabe like tides at a moored hull.\n\nI have sealed the gate. If the instruments wake before I do, whoever stirs must first take up the Fork in the Hall of Instruments, then restore the three anchors from the levers in the Conduit Room.\n\nThe Core is gone. I sent it to the Drowned Shrine for safekeeping, and the fen took the shrine." },
  on_resonance: { title: 'On Resonance', text: 'A tuning fork struck at the right moment does not merely sound. It answers.\n\nThe constructs of this place fire spirit-orbs tuned to a single note. Meet the orb with your own note (raise your guard as it arrives, or strike through it) and it will fly home twice as fast.' },
  anchor_hint: { title: 'Gate Hall Inscription', text: 'THREE ANCHORS HOLD THE GATE.\nTHE LEFT LEVER MOVES THE LEFT AND THE HEART.\nTHE MIDDLE LEVER MOVES THE HEART ALONE.\nTHE RIGHT LEVER MOVES THE HEART AND THE RIGHT.\nWHEN ALL THREE SING, THE GATE WILL OPEN.' },
  artificer_charter: { title: "Charter of the Artificers' Guild", text: 'We mend what the old builders left: pumps, lamps, and the brass that still walks.\n\nMembers are paid in shards for relics recovered and supplies delivered. Master Vance keeps the contract ledger.' },
  warden_oath: { title: "The Wardens' Oath", text: 'I walk the roads so others need not fear them. I map what is lost, and I clear what has woken.\n\nCaptain Marr assigns bounties to Wardens in good standing.' },
  tablet_drowned: { title: 'Drowned Inscription', text: 'Here the Keeper hid the heart of the Astrolabe, beneath still water and the watch of a stone guardian.\n\nThe guardian will not yield it to any hand that cannot also lift a blade.' },
  tablet_ember: { title: 'Vault Inscription', text: 'VIS: the rune of force. Spoken alone it pushes. Spoken with APERIO it opens what is sealed. Spoken with LEVIS it lifts.\n\nMind the vents. They remember the forge.' },
  tablet_verdant: { title: 'Reliquary Inscription', text: 'VITA is the rune of life, but life alone is formless. Bind it to LUX and the light will knit the wound.' },
  tablet_spire: { title: 'Spire Inscription', text: 'The ley-lines do not break. They are pulled. Whoever seats a living Core in the Great Astrolabe draws every line back to true.\n\nWe built the chasm so that only the light-footed would find this room.' },
  book_almanac: { title: "A Fen-Walker's Almanac", text: 'Fen Lotus grows where the water is shallow and the reeds are thick. Pair it with Ember Moss from the Badlands for a healing draught, or with Basalt Salt for a frost oil.\n\nNever wade into the dark pools. Clockwork drowns there, but so do you.' },
  book_ley: { title: 'Treatise on Ley Resonance', text: 'Ley Bloom and Aether Crystal brew a tonic that restores the will to cast.\n\nPylons mark where the lines run close to the surface. A wise traveller visits each one, because the ley remembers those who listen.' },
  book_colossus: { title: 'The Fall of the Brass Colossus', text: 'It walked from the Spire to the sea, and every step rang.\nIt fell where the roads now cross, and it rings there still.\nGo east of the Gate, they say, and listen for the bell in the grass.' },
});

/** Rumours NPCs share; several point at progression. */
const RUMORS = [
  "They say the Hollow Spire sits behind a chasm no one can cross. You'd need to walk on air.",
  'Pell Rowan in Oakhaven keeps a Levis runestone under the counter. Expensive, mind.',
  "The Drowned Shrine's down in the fen, south-west of the old Gate. Something big guards it.",
  "Constructs don't swim. Knock one into a deep pool and it's scrap.",
  "Captain Marr pays Wardens well for clearing the old vaults.",
  "Strike an orb just as it arrives and it'll fly straight back at whatever spat it.",
  "The Ember Vault in the Badlands is full of steam vents. Folk say there's a runestone at the bottom.",
  "If you're tired, the inns rent beds. Campfires on the roads will do in a pinch.",
  "The ley-lines have been twitching since the Observatory went quiet. Lamps flicker in the night.",
  "Master Vance has been asking after anyone who comes up out of the Observatory.",
];

// ---------------------------------------------------------------------------
// Inventory & character
// ---------------------------------------------------------------------------

export class Inventory {
  constructor() {
    /** @type {{id:string, qty:number}[]} */
    this.items = [];
  }

  /** @param {string} id @param {number} [qty] */
  add(id, qty = 1) {
    const s = this.items.find((it) => it.id === id);
    if (s) s.qty += qty;
    else this.items.push({ id, qty });
  }

  /** @param {string} id @param {number} [qty] @returns {boolean} */
  remove(id, qty = 1) {
    const s = this.items.find((it) => it.id === id);
    if (!s || s.qty < qty) return false;
    s.qty -= qty;
    if (s.qty <= 0) this.items.splice(this.items.indexOf(s), 1);
    return true;
  }

  /** @param {string} id */
  count(id) {
    return this.items.find((it) => it.id === id)?.qty ?? 0;
  }

  weight() {
    return this.items.reduce((w, it) => w + (ITEMS[it.id]?.weight ?? 0) * it.qty, 0);
  }
}

/** @typedef {{kind:'item'|'spell', id:string}|null} HotbarSlot */

export class Character {
  constructor() {
    this.level = 1;
    this.skillUps = 0;
    this.attrPoints = 0;
    this.perkPoints = 0;
    this.attrs = { might: 5, finesse: 5, intellect: 5, presence: 5 };
    /** @type {Record<string, {level:number, xp:number}>} */
    this.skills = { blade: { level: 1, xp: 0 }, artificing: { level: 1, xp: 0 }, aether: { level: 1, xp: 0 }, wayfaring: { level: 1, xp: 0 } };
    /** @type {string[]} */
    this.perks = [];
    this.inventory = new Inventory();
    /** @type {{main:string|null, off:string|null, armor:string|null, relic:string|null}} */
    this.equip = { main: null, off: null, armor: null, relic: null };
    this.ammo = 'ammo_shard';
    this.shards = 0;
    /** @type {string[]} */
    this.spells = [];
    /** @type {HotbarSlot[]} */
    this.hotbar = [null, null, null, null, null, null];
    /** @type {Record<string, number>} timed effects, seconds remaining */
    this.effects = {};
    this.hp = this.maxHp;
    this.mana = this.maxMana;
    this.stamina = this.maxStamina;
  }

  /** @param {string} perk */
  has(perk) {
    return this.perks.includes(perk);
  }

  /** Relic-adjusted skill level. @param {string} id */
  skill(id) {
    const relic = this.equip.relic ? ITEMS[this.equip.relic]?.bonus : undefined;
    return this.skills[id].level + (relic?.[id] ?? 0);
  }

  get maxHp() {
    return 60 + this.attrs.might * 6 + (this.level - 1) * 8;
  }

  get maxMana() {
    const relic = this.equip.relic ? ITEMS[this.equip.relic]?.bonus : undefined;
    return 30 + this.attrs.intellect * 6 + (this.has('deepwell') ? 25 : 0) + (relic?.mana ?? 0);
  }

  get maxStamina() {
    return 60 + this.attrs.finesse * 6;
  }

  get carryCap() {
    return 30 + this.attrs.might * 5 + (this.has('packmule') ? 25 : 0);
  }

  get armor() {
    return [this.equip.armor, this.equip.off].reduce((a, id) => a + (id ? ITEMS[id].armor ?? 0 : 0), 0);
  }

  get encumbered() {
    return this.inventory.weight() > this.carryCap;
  }

  /**
   * Learn-by-doing progression. Every 10 skill increases grants a character level with
   * one attribute point and one perk point.
   * @param {string} id @param {number} amount
   * @returns {{skillUp:boolean, levelUp:boolean, text:string[]}}
   */
  exercise(id, amount) {
    const s = this.skills[id];
    const out = { skillUp: false, levelUp: false, text: /** @type {string[]} */ ([]) };
    s.xp += amount;
    for (let need = 3 + s.level * 2; s.xp >= need; need = 3 + s.level * 2) {
      s.xp -= need;
      s.level++;
      this.skillUps++;
      out.skillUp = true;
      out.text.push(`${SKILLS[id].name} increased to ${s.level}`);
      if (this.skillUps % 10 === 0) {
        this.level++;
        this.attrPoints++;
        this.perkPoints++;
        this.hp = this.maxHp;
        out.levelUp = true;
        out.text.push(`You reached level ${this.level}! (+1 attribute, +1 perk point)`);
      }
    }
    return out;
  }

  /** @returns {Object<string, any>} */
  toJSON() {
    return { ...this, inventory: this.inventory.items };
  }

  /** @param {Object<string, any>} o @returns {Character} */
  static fromJSON(o) {
    const c = new Character();
    Object.assign(c, o);
    c.inventory = new Inventory();
    c.inventory.items = o.inventory || [];
    return c;
  }
}

// ---------------------------------------------------------------------------
// Quests & contracts
// ---------------------------------------------------------------------------

/** @typedef {{level:string, x:number, z:number}} Marker */
/**
 * @typedef {Object} Quest
 * @property {string} id
 * @property {string} title
 * @property {'main'|'guild'|'town'} kind
 * @property {number} stage
 * @property {boolean} done
 * @property {{text:string, day:number}[]} entries
 * @property {Marker|null} marker
 */

export class QuestLog {
  constructor() {
    /** @type {Record<string, Quest>} */
    this.quests = {};
    /** @type {string|null} quest whose marker the compass shows */
    this.tracked = null;
  }

  /** @param {string} id @param {string} title @param {Quest['kind']} kind */
  start(id, title, kind) {
    if (!this.quests[id]) this.quests[id] = { id, title, kind, stage: 0, done: false, entries: [], marker: null };
    this.tracked = id;
    return this.quests[id];
  }

  /** @param {string} id */
  get(id) {
    return this.quests[id] || null;
  }

  /**
   * Advance a quest and write a journal entry.
   * @param {string} id @param {number} stage @param {string} text @param {number} day @param {Marker|null} marker
   */
  update(id, stage, text, day, marker) {
    const q = this.quests[id];
    if (!q) return;
    q.stage = stage;
    q.entries.push({ text, day });
    q.marker = marker;
    this.tracked = id;
  }

  /** @param {string} id @param {string} text @param {number} day */
  complete(id, text, day) {
    const q = this.quests[id];
    if (!q) return;
    q.done = true;
    q.marker = null;
    q.entries.push({ text, day });
    if (this.tracked === id) this.tracked = Object.values(this.quests).find((x) => !x.done)?.id ?? null;
  }

  active() {
    return Object.values(this.quests).filter((q) => !q.done);
  }

  /** @returns {Marker|null} */
  trackedMarker() {
    const q = this.tracked ? this.quests[this.tracked] : null;
    return q && !q.done ? q.marker : null;
  }
}

/**
 * @typedef {Object} Contract
 * @property {string} id quest id
 * @property {'artificers'|'wardens'} guild
 * @property {'relic'|'delivery'|'bounty'|'gather'|'scout'} kind
 * @property {string} title
 * @property {string} brief
 * @property {number} reward
 * @property {string} [dungeon]
 * @property {string} [npc]
 * @property {string} [landmark]
 * @property {string} [item]
 * @property {number} [count]
 * @property {boolean} [delivered]
 */

const DUNGEON_IDS = ['drowned', 'ember', 'verdant', 'spire'];
const LANDMARK_NAMES = { pylon_fen: 'Fen Ley Pylon', pylon_wood: 'Ley-Wood Pylon', pylon_bad: 'Badlands Ley Pylon', stones: 'The Listening Stones', colossus: 'Fallen Brass Colossus' };

/**
 * Procedural guild contract #n.
 * @param {'artificers'|'wardens'} guild @param {number} n @param {number} seed @returns {Contract}
 */
export function makeContract(guild, n, seed) {
  const rnd = mulberry32(seed ^ (n * 2654435761) ^ (guild === 'artificers' ? 17 : 91));
  const pick = (/** @type {string[]} */ a) => a[Math.floor(rnd() * a.length)];
  const id = `contract_${guild}_${n}`;
  const reward = 40 + n * 15 + Math.floor(rnd() * 20);
  const kinds = guild === 'artificers' ? ['relic', 'gather', 'delivery'] : ['bounty', 'scout', 'delivery'];
  const kind = /** @type {Contract['kind']} */ (kinds[n % 3 === 0 ? 0 : Math.floor(rnd() * 3)]);
  if (kind === 'relic') {
    const dungeon = pick(DUNGEON_IDS.filter((d) => d !== 'spire' || n > 1));
    const name = SITES[/** @type {'drowned'} */ (dungeon)].name;
    return { id, guild, kind, dungeon, reward, title: `Relic from ${name}`, brief: `Recover the Lost Astrolabe Fragment from ${name} and bring it to Master Vance.` };
  }
  if (kind === 'bounty') {
    const dungeon = pick(DUNGEON_IDS.filter((d) => d !== 'spire' || n > 1));
    const name = SITES[/** @type {'drowned'} */ (dungeon)].name;
    return { id, guild, kind, dungeon, reward: reward + 20, title: `Bounty: ${name}`, brief: `Destroy every construct in ${name}, then report to Captain Marr.` };
  }
  if (kind === 'gather') {
    const item = pick(['scrap', 'crystal', 'salt']);
    const count = item === 'scrap' ? 4 : 3;
    return { id, guild, kind, item, count, reward, title: `Supplies: ${ITEMS[item].name}`, brief: `Bring ${count} ${ITEMS[item].name} to Master Vance.` };
  }
  if (kind === 'scout') {
    const landmark = pick(Object.keys(LANDMARK_NAMES));
    const name = /** @type {Record<string, string>} */ (LANDMARK_NAMES)[landmark];
    return { id, guild, kind, landmark, reward, title: `Survey: ${name}`, brief: `Find ${name} and mark it for the Wardens.` };
  }
  const npc = guild === 'artificers' ? pick(['pell', 'dorrin', 'quill']) : pick(['tobin', 'mirela', 'brann']);
  const names = { pell: 'Pell Rowan (Oakhaven)', dorrin: 'Dorrin Vale (Oakhaven)', quill: 'Quill Ashby (Oakhaven)', tobin: 'Tobin Gearwright (Cinderwick)', mirela: 'Mirela Ash (Cinderwick)', brann: 'Brann Flint (Cinderwick)' };
  return { id, guild, kind: 'delivery', npc, reward: reward - 10, title: `Delivery to ${/** @type {Record<string, string>} */ (names)[npc]}`, brief: `Carry a sealed parcel to ${/** @type {Record<string, string>} */ (names)[npc]}, then return for payment.` };
}

// ---------------------------------------------------------------------------
// Trade & crafting
// ---------------------------------------------------------------------------

/** @param {Character} c @param {number} rep */
function haggle(c, rep) {
  return c.skill('wayfaring') * 0.03 + c.attrs.presence * 0.012 + rep / 250 + (c.has('silver') ? 0.1 : 0);
}

/** Price the merchant asks. @param {Character} c @param {string} id @param {number} rep town reputation */
export function buyPrice(c, id, rep) {
  return Math.max(1, Math.ceil(ITEMS[id].value * Math.max(0.85, 1.5 - haggle(c, rep))));
}

/** Price the merchant pays. @param {Character} c @param {string} id @param {number} rep */
export function sellPrice(c, id, rep) {
  return Math.floor(ITEMS[id].value * Math.min(0.8, 0.3 + haggle(c, rep) * 0.6));
}

/**
 * Combine ingredients. Returns an error message, or null on success.
 * @param {Character} c @param {typeof RECIPES[number]} r @returns {string|null}
 */
export function craft(c, r) {
  if (c.skill('artificing') < r.level) return `Requires Artificing ${r.level}.`;
  for (const [id, n] of r.needs) if (c.inventory.count(id) < n) return `Missing ${ITEMS[id].name}.`;
  for (const [id, n] of r.needs) c.inventory.remove(id, n);
  c.inventory.add(r.makes[0], r.makes[1]);
  return null;
}

/** Which spell (if any) a set of runestones spells out. @param {string[]} runes @returns {string|null} */
export function spellFor(runes) {
  const key = [...runes].sort().join('+');
  for (const [id, s] of Object.entries(SPELLS)) if ([...s.runes].sort().join('+') === key) return id;
  return null;
}

// ---------------------------------------------------------------------------
// Dialogue
// ---------------------------------------------------------------------------

/** @typedef {{id:string, label:string, enabled:boolean}} DialogueOption */
/** @typedef {{text:string, options:DialogueOption[], action?:'trade'|'rest'|'close'}} DialogueReply */

/** @param {number} dx @param {number} dz */
function bearing(dx, dz) {
  const dirs = ['east', 'south-east', 'south', 'south-west', 'west', 'north-west', 'north', 'north-east'];
  const a = Math.atan2(dz, dx);
  return dirs[(Math.round(a / (Math.PI / 4)) + 8) % 8];
}

/** Topic / branching dialogue with skill checks, bound to one NPC. */
export class Dialogue {
  /** @param {Game} game @param {{def:NpcDef, working:boolean}} npc */
  constructor(game, npc) {
    this.game = game;
    this.npc = npc;
    this.def = npc.def;
    /** @type {string} topic awaiting an option choice */
    this.topic = '';
  }

  /** @param {string} id @param {string} label @param {boolean} [enabled] @returns {DialogueOption} */
  opt(id, label, enabled = true) {
    return { id, label, enabled };
  }

  /** Option gated on a skill or attribute. @param {string} id @param {string} stat @param {number} need @param {string} label */
  check(id, stat, need, label) {
    const c = this.game.char;
    const have = stat in c.skills ? c.skill(stat) : /** @type {Record<string, number>} */ (c.attrs)[stat];
    const name = stat in c.skills ? SKILLS[stat].name : ATTRIBUTES[stat].name;
    return this.opt(id, `[${name} ${need}] ${label}`, have >= need);
  }

  greeting() {
    const g = this.game;
    const d = this.def;
    const hour = g.hour;
    const tod = hour < 12 ? 'Morning' : hour < 18 ? 'Afternoon' : 'Evening';
    if (d.id === 'vance' && g.mainStage === 20) return `${tod}. You have the look of someone who climbed out of the Observatory. I've been waiting for one of you. Ask me about the ley-lines.`;
    if (d.role === 'guard') return `${tod}, traveller. Keep your blade sheathed inside the walls.`;
    if (d.role === 'innkeeper') return `Welcome to ${d.town === 'cinderwick' ? 'the Molten Mug' : 'the Rooted Lantern'}! Food, drink, a bed: what'll it be?`;
    if (d.role === 'merchant' && !this.npc.working) return "I'm closed for the day. Come by the shop in the morning.";
    const rep = g.factions.rep[d.town] || 0;
    return rep >= 20 ? `${tod}, friend! Good to see you again.` : `${tod}. What do you need?`;
  }

  /** @returns {{id:string, label:string}[]} */
  topics() {
    const g = this.game;
    const d = this.def;
    const t = [
      { id: 'background', label: 'Who are you?' }, { id: 'rumors', label: 'Rumours' }, { id: 'observatory', label: 'The Observatory' },
      { id: 'trade', label: 'Local Trade' }, { id: 'ruins', label: 'Nearby Ruins' },
    ];
    if (d.shop && (this.npc.working || d.role === 'innkeeper')) t.push({ id: 'barter', label: 'Barter' });
    if (d.role === 'innkeeper') t.push({ id: 'room', label: 'Rent a bed' });
    if (d.role === 'guard') t.push({ id: 'directions', label: 'Directions' });
    if (d.role === 'guildmaster') {
      const guild = /** @type {'artificers'|'wardens'} */ (d.faction);
      t.push(g.factions.member[guild] ? { id: 'contracts', label: 'Contracts' } : { id: 'join', label: `Join ${FACTIONS[guild]}` });
    }
    if (d.id === 'vance' && g.mainStage >= 20 && g.mainStage < 100) t.unshift({ id: 'ley', label: 'The Ley-lines' });
    if (d.id === 'ilsa') t.push({ id: 'chasm', label: 'The Hollow Spire' });
    if (d.id === 'odda' && !g.flags.pumpFixed) t.unshift({ id: 'pump', label: 'Your water-pump' });
    if (d.id === 'fenna' && !g.quests.get('blooms')?.done) t.unshift({ id: 'blooms', label: 'Ley Blooms' });
    for (const guild of /** @type {const} */ (['artificers', 'wardens'])) {
      const c = g.contracts[guild];
      if (c && c.kind === 'delivery' && c.npc === d.id && !c.delivered && g.char.inventory.count('parcel')) t.unshift({ id: `parcel_${guild}`, label: 'A parcel for you' });
    }
    return t;
  }

  /** @param {string} topic @returns {DialogueReply} */
  ask(topic) {
    const g = this.game;
    const d = this.def;
    const c = g.char;
    this.topic = topic;
    g.audio.voice(d.voice, 3 + Math.floor(Math.random() * 4));
    switch (topic) {
      case 'background': {
        const lines = {
          guildmaster: d.faction === 'artificers' ? 'I keep the Artificers honest and the pumps running. Mostly the pumps.' : 'I captain the Wayfarer\'s Wardens. We keep the roads walkable.',
          merchant: `I run ${d.shop ? SHOPS[d.shop].name : 'a stall'}. Fair prices, mostly.`,
          innkeeper: "I pour, I cook, I listen. Mostly I listen.",
          guard: `I watch the ${d.town === 'cinderwick' ? 'Cinderwick' : 'Oakhaven'} roads, and you, now.`,
          folk: `${d.name}. Born here, likely die here, hopefully not today.`,
        };
        return { text: /** @type {Record<string, string>} */ (lines)[d.role] || lines.folk, options: [] };
      }
      case 'rumors': {
        const h = (d.id.length * 7 + d.name.charCodeAt(0) + g.day) % RUMORS.length;
        return { text: RUMORS[h], options: [] };
      }
      case 'observatory':
        return { text: g.mainStage >= 100 ? 'Since the Astrolabe turned true again, the lamps have stopped flickering. That was you, wasn\'t it?' : 'The Sunken Observatory? South of the crossroads, under the brass ring. It\'s been quiet for a generation. Now the lamps flicker every night.', options: [] };
      case 'trade':
        return { text: d.town === 'cinderwick' ? 'Cinderwick lives on brass and basalt. Tobin sells tools and ammunition, Brann forges arms. Bring scrap; everyone wants scrap.' : 'Oakhaven trades in herbs and timber. Pell brews draughts and tonics, Quill fletches bolts. Ley Blooms fetch a fair price.', options: [] };
      case 'ruins': {
        const town = SITES[/** @type {'oakhaven'} */ (d.town)];
        const near = ['drowned', 'ember', 'verdant', 'spire']
          .map((id) => ({ id, s: SITES[/** @type {'drowned'} */ (id)] }))
          .sort((a, b) => Math.hypot(a.s.x - town.x, a.s.z - town.z) - Math.hypot(b.s.x - town.x, b.s.z - town.z));
        const [a, b] = near;
        return { text: `${a.s.name} lies ${bearing(a.s.x - town.x, a.s.z - town.z)} of here, and ${b.s.name} further ${bearing(b.s.x - town.x, b.s.z - town.z)}. Take a light.`, options: [] };
      }
      case 'directions': {
        const town = SITES[/** @type {'oakhaven'} */ (d.town)];
        const lines = ['gate', 'oakhaven', 'cinderwick', 'drowned', 'ember', 'verdant', 'spire']
          .filter((id) => id !== d.town)
          .map((id) => {
            const s = SITES[/** @type {'gate'} */ (id)];
            return `${s.name}: ${bearing(s.x - town.x, s.z - town.z)}, about ${Math.round(Math.hypot(s.x - town.x, s.z - town.z))} paces.`;
          });
        return { text: lines.join('\n'), options: [] };
      }
      case 'barter':
        return { text: 'Have a look.', options: [], action: 'trade' };
      case 'room':
        if (g.flags.rent === d.town) return { text: 'Your bed is made. Any of the beds by the wall.', options: [] };
        return { text: 'Ten shards for a bed until morning.', options: [this.opt('rent', 'Rent a bed (10 shards)', c.shards >= 10), this.opt('no', 'Not tonight')] };
      case 'join': {
        if (d.faction === 'artificers') {
          return {
            text: 'The Guild takes those who can fix things, or those who can pay dues while they learn.',
            options: [this.check('join_skill', 'artificing', 2, 'Show him a lock you picked clean'), this.opt('join_pay', 'Pay the 40-shard dues', c.shards >= 40), this.opt('no', 'Not yet')],
          };
        }
        return {
          text: 'Wardens are walkers and fighters. Prove you are either.',
          options: [this.check('join_skill', 'wayfaring', 2, 'Name the landmarks you have charted'), this.check('join_blade', 'blade', 2, 'Spar with a Warden'), this.opt('no', 'Not yet')],
        };
      }
      case 'contracts':
        return this._contracts();
      case 'ley':
        return this._ley();
      case 'chasm':
        return { text: 'The Hollow Spire stands inside a ring of chasm in the eastern Badlands. Nobody crosses without Feather Step: Levis and Vis together. Pell sells a Levis stone, or finish your first contract with me and I\'ll give you mine.', options: [] };
      case 'pump':
        return {
          text: "My water-pump's seized again. The whole east side drinks from it, and I can't make head nor tail of the gears.",
          options: [this.check('pump_fix', 'artificing', 2, 'Offer to repair their broken water-pump'), this.opt('pump_scrap', 'Hand over 2 Brass Scrap for the smith to use', c.inventory.count('scrap') >= 2), this.opt('no', 'Maybe later')],
        };
      case 'blooms': {
        const q = g.quests.get('blooms');
        if (q && c.inventory.count('ley_bloom') >= 3) return { text: 'Are those Ley Blooms? Three of them?', options: [this.opt('blooms_give', 'Hand over 3 Ley Blooms'), this.opt('no', 'Not yet')] };
        if (q) return { text: 'Three Ley Blooms, from under the Ley-Wood canopy. They glow; you can\'t miss them.', options: [] };
        return {
          text: 'My salves need Ley Blooms and my knees can\'t manage the woods any more. Bring me three?',
          options: [this.opt('blooms_accept', 'I\'ll find them'), this.check('blooms_haggle', 'presence', 6, 'Ask for something up front'), this.opt('no', 'Not now')],
        };
      }
      default:
        if (topic.startsWith('parcel_')) return { text: 'For me? Ah, finally.', options: [this.opt(topic, 'Hand over the parcel')] };
        return { text: '…', options: [] };
    }
  }

  /** @returns {DialogueReply} */
  _contracts() {
    const g = this.game;
    const guild = /** @type {'artificers'|'wardens'} */ (this.def.faction);
    const c = g.contracts[guild];
    if (!c) return { text: 'There is work if you want it.', options: [this.opt('take', 'Show me a contract'), this.opt('no', 'Not now')] };
    if (g.contractReady(c)) return { text: `${c.title}: done? Let me see.`, options: [this.opt('turnin', 'Report the contract complete')] };
    return { text: `Your contract stands: ${c.brief}`, options: [this.opt('abandon', 'Abandon the contract'), this.opt('no', 'I\'m on it')] };
  }

  /** @returns {DialogueReply} */
  _ley() {
    const g = this.game;
    const st = g.mainStage;
    if (st === 20) {
      return {
        text: 'The ley-lines under the Shardlands are drifting. Lamps die, constructs wake. The Great Astrolabe below the Observatory used to hold the lines true, but its Resonant Core was hidden in the Drowned Shrine, out in the fen to the south-west.',
        options: [this.check('ley_lore', 'aether', 2, 'Describe the anchor resonance you felt below'), this.opt('ley_accept', 'I\'ll bring back the Core')],
      };
    }
    if (st === 30) return { text: 'The Drowned Shrine: south-west, in the Whispering Brass Fen. Mind the deep water.', options: [] };
    if (st === 40) return { text: 'You have it? Let me see the Core.', options: [this.opt('ley_core', 'Hand him the Resonant Core', g.char.inventory.count('core') > 0)] };
    if (st === 50) return { text: 'The Core is attuned. Take it down to the Great Astrolabe beneath the Observatory and seat it.', options: [] };
    return { text: 'The lines are quiet.', options: [] };
  }

  /** @param {string} id @returns {DialogueReply} */
  choose(id) {
    const g = this.game;
    const c = g.char;
    const d = this.def;
    if (id === 'no') return { text: 'As you like.', options: [] };
    if (id === 'rent') {
      g.addShards(-10);
      g.flags.rent = d.town;
      g.flags.rentUntil = g.minutes + (((34 - g.hour) % 24) || 24) * 60;
      g.audio.coins();
      return { text: 'Here\'s your key. Sleep well.', options: [] };
    }
    if (id === 'join_skill' || id === 'join_pay' || id === 'join_blade') {
      const guild = /** @type {'artificers'|'wardens'} */ (d.faction);
      if (id === 'join_pay') g.addShards(-40);
      g.factions.member[guild] = true;
      g.changeRep(guild, 10);
      g.notify(`You joined ${FACTIONS[guild]}.`);
      return { text: 'Welcome. Ask me about contracts when you want work.', options: [] };
    }
    if (id === 'take') {
      const guild = /** @type {'artificers'|'wardens'} */ (d.faction);
      const k = g.offerContract(guild);
      return { text: `${k.title}. ${k.brief} Pay is ${k.reward} shards.`, options: [] };
    }
    if (id === 'turnin') {
      const guild = /** @type {'artificers'|'wardens'} */ (d.faction);
      const text = g.completeContract(guild);
      return { text, options: [] };
    }
    if (id === 'abandon') {
      g.abandonContract(/** @type {'artificers'|'wardens'} */ (d.faction));
      return { text: 'Pity. The ledger remembers.', options: [] };
    }
    if (id.startsWith('parcel_')) {
      const guild = /** @type {'artificers'|'wardens'} */ (id.slice(7));
      const k = g.contracts[guild];
      if (k && c.inventory.remove('parcel', 1)) {
        k.delivered = true;
        g.notify('Parcel delivered. Return to the guild for payment.');
      }
      return { text: 'Tell them it arrived safely.', options: [] };
    }
    if (id === 'ley_lore' || id === 'ley_accept') {
      if (id === 'ley_lore') {
        g.give('tonic', 2);
        g.exercise('aether', 2);
      }
      g.setMain(30, 'Master Vance believes the Resonant Core lies in the Drowned Shrine, south-west in the Whispering Brass Fen. I must recover it.');
      return { text: id === 'ley_lore' ? 'Then you already hear it. Good. Take these tonics; the Shrine\'s guardian will test you.' : 'Go carefully. The fen keeps what it takes.', options: [] };
    }
    if (id === 'ley_core') {
      g.setMain(50, 'Master Vance attuned the Resonant Core. I must seat it in the Great Astrolabe beneath the Sunken Observatory.');
      g.addShards(100);
      g.changeRep('artificers', 15);
      return { text: 'There. Feel it hum? It\'s ready. Seat it in the Great Astrolabe, at the heart of the Gate Hall, and the lines will come home.', options: [] };
    }
    if (id === 'pump_fix' || id === 'pump_scrap') {
      if (id === 'pump_scrap') c.inventory.remove('scrap', 2);
      else g.exercise('artificing', 2);
      g.flags.pumpFixed = true;
      g.addShards(20);
      g.changeRep('cinderwick', 10);
      g.audio.lockOpen();
      return { text: id === 'pump_fix' ? 'You did it! Hear that? Water! Here, take this, and thank you.' : 'Brann can work with that. Thank you, friend. Take these shards.', options: [] };
    }
    if (id === 'blooms_accept' || id === 'blooms_haggle') {
      g.startQuest('blooms', 'Blooms for Fenna', 'Fenna Rook in Oakhaven needs 3 Ley Blooms from the Ley-Wood.');
      if (id === 'blooms_haggle') g.addShards(10);
      return { text: id === 'blooms_haggle' ? 'Fine, fine. Ten shards now, more when you\'re back.' : 'Bless you.', options: [] };
    }
    if (id === 'blooms_give') {
      c.inventory.remove('ley_bloom', 3);
      g.give('tonic', 2);
      g.addShards(25);
      g.changeRep('oakhaven', 10);
      g.finishQuest('blooms', 'I brought Fenna her Ley Blooms.');
      return { text: 'Perfect, still glowing. Take these tonics, and my thanks.', options: [] };
    }
    return { text: '…', options: [] };
  }
}
