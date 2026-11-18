/**
 * @file Actors: the player (circle-vs-world sliding, jumping, elevation stepping, levitation,
 * Phase Dash, directional melee, parry/block, ranged ammo, rune casting), constructs with
 * telegraphed AI and hazard-aware knockback, homing orbs, ricocheting projectiles,
 * schedule-driven townsfolk and particles.
 */
import { SPR } from './textures.js';
import { HAZARD } from './world.js';
import { ITEMS, SPELLS } from './rpg.js';

/** @typedef {import('./main.js').Game} Game */
/** @typedef {import('./world.js').Level} Level */
/** @typedef {import('./world.js').NpcDef} NpcDef */
/** @typedef {import('./renderer.js').SpriteDesc} SpriteDesc */
/**
 * @typedef {Object} FrameInput
 * @property {number} moveX strafe, -1..1 (right positive)
 * @property {number} moveY forward, -1..1
 * @property {number} lookX yaw delta (radians)
 * @property {number} lookY pitch delta (radians, positive looks down)
 * @property {boolean} attack held
 * @property {boolean} attackPressed edge
 * @property {boolean} parry edge
 * @property {boolean} parryHeld
 * @property {boolean} dash edge
 * @property {boolean} jump edge
 * @property {number} slot direct hotbar select or -1
 * @property {number} cycle -1, 0, 1
 */

/** @param {number} a @param {number} b smallest signed difference a - b */
export function angleDiff(a, b) {
  let d = (a - b) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/** @param {number} v @param {number} lo @param {number} hi */
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** Melee swing shapes, picked by movement direction at the moment of the strike. */
const SWINGS = {
  sweep: { cos: 0.34, reach: 2.1, mult: 1.0, cd: 0.45, stam: 10 },
  thrust: { cos: 0.86, reach: 2.8, mult: 1.1, cd: 0.5, stam: 9 },
  chop: { cos: 0.6, reach: 2.0, mult: 1.4, cd: 0.65, stam: 14 },
};

export class Player {
  /** @param {number} x @param {number} y @param {number} z @param {number} yaw */
  constructor(x, y, z, yaw) {
    this.x = x;
    this.y = y;
    this.z = z;
    this.yaw = yaw;
    this.pitch = 0;
    this.vx = 0;
    this.vz = 0;
    this.vy = 0;
    this.radius = 0.3;
    this.eye = 1.6;
    this.onGround = true;
    this.fallFrom = y;
    this.dashT = 0;
    this.dashX = 0;
    this.dashZ = 0;
    this.iframes = 0;
    this.attackCd = 0;
    this.swingT = 0;
    /** @type {'sweep'|'thrust'|'chop'} */
    this.swingKind = 'sweep';
    this.parryT = 0;
    this.parryCd = 0;
    this.blocking = false;
    this.riposte = false;
    this.flash = 0;
    this.recoil = 0;
    this.castT = 0;
    this.bob = 0;
    this.stepDist = 0;
    this.hazardCd = 0;
    this.lastSafe = { x, z, y };
  }

  /** @param {number} dt @param {FrameInput} input @param {Game} game */
  update(dt, input, game) {
    const c = game.char;
    const L = game.level;
    this.yaw += input.lookX;
    this.pitch = clamp(this.pitch - input.lookY, -1.3, 1.3);
    if (input.slot >= 0) game.selectSlot(input.slot);
    if (input.cycle) game.cycleSlot(input.cycle);

    // Vitals.
    if (!this.blocking) c.stamina = Math.min(c.maxStamina, c.stamina + 22 * dt);
    c.mana = Math.min(c.maxMana, c.mana + (0.8 + c.attrs.intellect * 0.08) * dt);
    for (const k of Object.keys(c.effects)) {
      c.effects[k] -= dt;
      if (c.effects[k] <= 0) {
        delete c.effects[k];
        game.notify(`${k === 'feather' ? 'Feather Step' : k === 'lumina' ? 'Lumina' : k === 'oil_ember' ? 'Ember oil' : 'Frost oil'} has faded.`);
      }
    }

    // Movement.
    const flying = (c.effects.feather ?? 0) > 0;
    const fx = Math.cos(this.yaw);
    const fz = Math.sin(this.yaw);
    let mx = input.moveX;
    let my = input.moveY;
    const ml = Math.hypot(mx, my);
    if (ml > 1) { mx /= ml; my /= ml; }
    const hz = L.hazardAt(this.x, this.z);
    const deep = hz === HAZARD.DEEP && !flying;
    if (input.dash && this.dashT <= 0 && c.stamina >= 20 && !c.encumbered) {
      let dx = fx * my - fz * mx;
      let dz = fz * my + fx * mx;
      const l = Math.hypot(dx, dz);
      if (l < 0.01) { dx = fx; dz = fz; } else { dx /= l; dz /= l; }
      this.dashX = dx;
      this.dashZ = dz;
      this.dashT = 0.17;
      this.iframes = Math.max(this.iframes, 0.32);
      c.stamina -= 20;
      game.audio.dash();
      game.fx.dash = 1;
    }
    if (this.dashT > 0) {
      this.dashT -= dt;
      this.vx = this.dashX * 15;
      this.vz = this.dashZ * 15;
    } else {
      const sp = 4.6 * (c.encumbered ? 0.5 : 1) * (deep ? 0.55 : 1) * (this.blocking ? 0.55 : 1);
      const k = 1 - Math.exp(-dt * 12);
      this.vx += ((fx * my - fz * mx) * sp - this.vx) * k;
      this.vz += ((fz * my + fx * mx) * sp - this.vz) * k;
    }
    const ox = this.x;
    const oz = this.z;
    L.move(this, this.vx * dt, this.vz * dt, this.radius, this.y, flying, false);
    const moved = Math.hypot(this.x - ox, this.z - oz);
    this.bob += moved * 2.2;

    // Vertical: gravity, stepping, levitation, falls.
    const ground = L.heightAt(this.x, this.z);
    if (flying) {
      this.y = Math.max(this.y, ground);
      this.vy = 0;
      this.onGround = true;
      this.fallFrom = this.y;
    } else {
      if (input.jump && this.onGround && !deep) {
        this.vy = 5.4;
        this.onGround = false;
        this.fallFrom = this.y;
      }
      this.vy -= 16 * dt;
      this.y += this.vy * dt;
      if (this.y <= ground || (this.onGround && this.vy <= 0 && this.y - ground < 0.3)) {
        const fall = this.fallFrom - ground;
        if (!this.onGround && fall > 4.5) game.hurtPlayer(Math.round((fall - 4.5) * 9), null);
        if (!this.onGround && fall > 1) game.audio.thud();
        this.y = ground;
        this.vy = 0;
        this.onGround = true;
        this.fallFrom = ground;
      } else if (this.onGround && this.y - ground >= 0.3) {
        this.onGround = false;
        this.fallFrom = this.y;
      }
    }
    // Feather Step ran out over the chasm: fall and climb back out.
    if (!flying && L.hazardAt(this.x, this.z) === HAZARD.CHASM) {
      this.x = this.lastSafe.x;
      this.z = this.lastSafe.z;
      this.y = this.lastSafe.y;
      game.hurtPlayer(25, null);
      game.notify('You fell into the chasm and clawed your way back up.');
    } else if (this.onGround && !flying && hz === HAZARD.NONE) {
      this.lastSafe = { x: this.x, z: this.z, y: this.y };
    }
    this.hazardCd -= dt;
    if (hz === HAZARD.VENT && this.onGround && !flying && this.hazardCd <= 0) {
      this.hazardCd = 0.5;
      game.hurtPlayer(8, null);
    }
    this.stepDist += moved;
    if (this.stepDist > 1.7 && this.onGround) {
      this.stepDist = 0;
      game.footstep(this.x, this.z, deep);
    }
    this.iframes = Math.max(0, this.iframes - dt);

    // Defence: timed parry, then block while held.
    this.parryCd -= dt;
    if (input.parry && this.parryCd <= 0 && c.stamina >= 8) {
      const off = c.equip.off ? ITEMS[c.equip.off].parry ?? 0 : 0;
      this.parryT = 0.25 + off;
      this.parryCd = 0.45;
      c.stamina -= 8;
      game.audio.parrySwing();
      game.fx.parry = Math.max(game.fx.parry, 0.3);
    }
    this.blocking = input.parryHeld && this.parryT <= 0 && c.stamina > 1;
    if (this.parryT > 0) {
      this.parryT -= dt;
      game.tryDeflect(2.4);
    }

    // Offence.
    this.attackCd -= dt;
    this.swingT = Math.max(0, this.swingT - dt);
    this.recoil = Math.max(0, this.recoil - dt * 4);
    this.flash = Math.max(0, this.flash - dt * 6);
    this.castT = Math.max(0, this.castT - dt);
    const slot = game.selectedSlot();
    if (!slot || this.attackCd > 0 || this.blocking) return;
    if (slot.kind === 'spell') {
      if (input.attackPressed) this._cast(slot.id, game);
      return;
    }
    const w = ITEMS[slot.id];
    if (!w || !input.attack) return;
    if (w.weapon === 'melee') this._melee(slot.id, input, game);
    else this._fire(slot.id, game);
  }

  /** Directional slash: strafing sweeps, advancing thrusts, standing chops. @param {string} id @param {FrameInput} input @param {Game} game */
  _melee(id, input, game) {
    const c = game.char;
    const kind = input.moveX !== 0 ? 'sweep' : input.moveY > 0 ? 'thrust' : 'chop';
    const s = SWINGS[kind];
    let mult = s.mult * (c.stamina >= s.stam ? 1 : 0.5) * (c.has('heavy') ? 1.25 : 1) * (this.riposte ? 2 : 1);
    c.stamina = Math.max(0, c.stamina - s.stam);
    this.riposte = false;
    this.attackCd = s.cd;
    this.swingT = 0.28;
    this.swingKind = kind;
    this.parryT = Math.max(this.parryT, 0.12);
    game.audio.forkBlast();
    const dmg = ((ITEMS[id].damage ?? 10) + c.attrs.might * 1.5 + c.skill('blade') * 1.2) * mult;
    const fx = Math.cos(this.yaw);
    const fz = Math.sin(this.yaw);
    let hit = false;
    for (const e of game.enemies) {
      if (!e.alive) continue;
      const dx = e.x - this.x;
      const dz = e.z - this.z;
      const d = Math.hypot(dx, dz);
      if (d > s.reach + e.radius || Math.abs(e.y - this.y) > 2.5) continue;
      if (d > 0.01 && (dx * fx + dz * fz) / d < s.cos) continue;
      game.damageEnemy(e, dmg, this.x, this.z, kind === 'chop' ? 2.5 : 4, { burn: !!c.effects.oil_ember, slow: !!c.effects.oil_frost });
      hit = true;
    }
    if (hit) {
      game.audio.meleeHit();
      game.exercise('blade', 0.5);
    }
  }

  /** Fire the equipped ranged weapon with the loaded ammunition. @param {string} id @param {Game} game */
  _fire(id, game) {
    const c = game.char;
    const w = ITEMS[id];
    let ammo = c.ammo;
    if (!c.inventory.count(ammo)) {
      ammo = ['ammo_shard', 'ammo_flare', 'ammo_frost'].find((a) => c.inventory.count(a) > 0) ?? '';
      if (!ammo) {
        this.attackCd = 0.4;
        game.notify('Out of ammunition. Craft Prism Shards from Aether Crystals.');
        return;
      }
      c.ammo = ammo;
    }
    c.inventory.remove(ammo, 1);
    const kind = ITEMS[ammo].ammo ?? 'shard';
    const pellets = w.pellets ?? 1;
    const base = (w.damage ?? 10) * (1 + c.attrs.finesse * 0.03) * (kind === 'shard' ? 1 : 0.9);
    for (let k = 0; k < pellets; k++) {
      const a = this.yaw + (pellets > 1 ? (k - (pellets - 1) / 2) * (w.spread ?? 0.1) : 0);
      const sp = w.speed ?? 24;
      const cp = Math.cos(this.pitch);
      game.projectiles.push(new Projectile(this.x + Math.cos(a) * 0.4, this.y + 1.35, this.z + Math.sin(a) * 0.4,
        Math.cos(a) * cp * sp, Math.sin(this.pitch) * sp, Math.sin(a) * cp * sp, base, kind, c.has('ricochet') ? 2 : 1, id === 'crossbow'));
    }
    this.attackCd = id === 'crossbow' ? 0.9 : 0.75;
    this.recoil = 1;
    this.flash = 1;
    if (kind === 'flare') game.audio.flare();
    else if (kind === 'frost') game.audio.frostShot();
    else if (id === 'crossbow') game.audio.bow();
    else game.audio.shard();
  }

  /** Cast an inscribed rune spell. @param {string} id @param {Game} game */
  _cast(id, game) {
    const c = game.char;
    const s = SPELLS[id];
    const cost = Math.round(s.cost * (c.has('efficient') ? 0.75 : 1));
    if (c.mana < cost) {
      game.notify('Not enough Aether.');
      this.attackCd = 0.3;
      return;
    }
    const lore = c.skill('aether');
    const power = 1 + lore * 0.12 + c.attrs.intellect * 0.03;
    let ok = true;
    if (id === 'lumina') c.effects.lumina = 120 + lore * 10;
    else if (id === 'mending') c.hp = Math.min(c.maxHp, c.hp + 22 * power);
    else if (id === 'feather') c.effects.feather = 6 + lore * 1.2;
    else if (id === 'push') game.kineticPush(power);
    else if (id === 'unlock') ok = game.castUnlock(lore);
    if (!ok) {
      this.attackCd = 0.3;
      return;
    }
    c.mana -= cost;
    this.castT = 0.4;
    this.attackCd = 0.6;
    game.audio.cast(id);
    game.fx.parry = Math.max(game.fx.parry, 0.4);
    game.exercise('aether', 1);
    game.burst(this.x + Math.cos(this.yaw) * 0.8, this.y + 1.3, this.z + Math.sin(this.yaw) * 0.8, 10, [0.4, 1.2, 1.6], 2);
  }
}

/** Base stats per construct kind before tier scaling. */
export const ENEMY_STATS = Object.freeze({
  mite: { name: 'Brass Mite', hp: 22, dmg: 5, speed: 3, radius: 0.28, size: 1.3, sprite: 'sentinel' },
  sentinel: { name: 'Clockwork Sentinel', hp: 50, dmg: 12, speed: 2.8, radius: 0.35, size: 2.2, sprite: 'sentinel' },
  wisp: { name: 'Censer Wisp', hp: 34, dmg: 10, speed: 2.3, radius: 0.36, size: 1.4, sprite: 'wisp' },
  golem: { name: 'Basalt Warden', hp: 120, dmg: 16, speed: 1.3, radius: 0.45, size: 2.7, sprite: 'golem' },
});

export class Enemy {
  /**
   * @param {import('./world.js').Spawn} sp @param {number} y
   */
  constructor(sp, y) {
    const st = ENEMY_STATS[/** @type {keyof typeof ENEMY_STATS} */ (sp.kind)];
    const scale = 1 + 0.45 * Math.max(0, sp.tier - 1);
    this.key = sp.key;
    this.kind = sp.kind;
    this.name = (sp.boss ? 'Elder ' : '') + st.name;
    this.x = sp.x;
    this.z = sp.z;
    this.y = y;
    this.homeX = sp.x;
    this.homeZ = sp.z;
    this.maxHp = Math.round(st.hp * scale * (sp.boss ? 1.8 : 1));
    this.hp = this.maxHp;
    this.dmg = st.dmg * (1 + 0.3 * Math.max(0, sp.tier - 1));
    this.speed = st.speed;
    this.radius = st.radius;
    this.size = st.size * (sp.boss ? 1.2 : 1);
    this.sprite = st.sprite;
    this.alive = true;
    /** @type {string} dormant | chase | windup | lunge | recover | hover | charge | advance | home | stagger | fall */
    this.state = 'dormant';
    this.t = 0;
    this.flash = 0;
    this.stagger = 0;
    this.burn = 0;
    this.slow = 0;
    this.shielded = false;
    this.kx = 0;
    this.kz = 0;
    this.pushed = 0;
    this.anim = Math.random() * 10;
    this.losT = 0;
    this.los = false;
    this.fireT = 1 + Math.random();
    this.strafe = Math.random() < 0.5 ? 1 : -1;
    this.hitDone = false;
    this.lx = 0;
    this.lz = 0;
    this.boss = !!sp.boss;
  }

  get awake() {
    return this.state !== 'dormant';
  }

  wake() {
    if (this.state === 'dormant' || this.state === 'home') this.state = this.kind === 'wisp' ? 'hover' : this.kind === 'golem' ? 'advance' : 'chase';
  }

  /** @param {number} dt @param {Game} game */
  update(dt, game) {
    const L = game.level;
    const p = game.player;
    this.anim += dt;
    this.flash = Math.max(0, this.flash - dt);
    if (this.state === 'fall') {
      this.y -= 7 * dt;
      this.t -= dt;
      if (this.t <= 0) game.killEnemy(this, 'fell into the chasm');
      return;
    }
    if (this.burn > 0) {
      this.burn -= dt;
      if (Math.floor(this.burn * 4) !== Math.floor((this.burn + dt) * 4)) game.damageEnemy(this, 2, this.x, this.z, 0, { quiet: true });
    }
    this.slow = Math.max(0, this.slow - dt);
    const dx = p.x - this.x;
    const dz = p.z - this.z;
    const dist = Math.hypot(dx, dz) || 1e-3;
    this.losT -= dt;
    if (this.losT <= 0) {
      this.losT = 0.25;
      this.los = dist < 18 && L.los(this.x, this.z, p.x, p.z);
    }
    if (this.state === 'dormant') {
      if (this.los && dist < 12) this.wake();
      this.y = L.heightAt(this.x, this.z);
      return;
    }
    if (this.kx || this.kz) {
      L.move(this, this.kx * dt, this.kz * dt, this.radius, this.y, false, this.pushed <= 0);
      const k = Math.exp(-dt * 6);
      this.kx *= k;
      this.kz *= k;
      if (Math.abs(this.kx) + Math.abs(this.kz) < 0.1) { this.kx = 0; this.kz = 0; }
    }
    if (this.pushed > 0) {
      this.pushed -= dt;
      game.hazardCheck(this);
      if (!this.alive || this.state === 'fall') return;
    }
    this.y = L.heightAt(this.x, this.z);
    if (this.stagger > 0) {
      this.stagger -= dt;
      return;
    }
    if (this.state !== 'home' && dist > 26) this.state = 'home';
    const spd = this.speed * (this.slow > 0 ? 0.5 : 1);
    if (this.state === 'home') {
      const hx = this.homeX - this.x;
      const hz = this.homeZ - this.z;
      const hd = Math.hypot(hx, hz);
      if (hd < 0.5) {
        this.state = 'dormant';
        this.hp = this.maxHp;
      } else L.move(this, (hx / hd) * spd * dt, (hz / hd) * spd * dt, this.radius, this.y, false, true);
      if (this.los && dist < 10) this.wake();
      return;
    }
    if (this.kind === 'wisp') this._wisp(dt, game, dx, dz, dist, spd);
    else if (this.kind === 'golem') this._golem(dt, game, dx, dz, dist, spd);
    else this._sentinel(dt, game, dx, dz, dist, spd);
  }

  /** Step toward the player directly when visible, else follow the flow field. @param {number} dt @param {Game} game @param {number} spd @param {number} dx @param {number} dz @param {number} dist */
  pursue(dt, game, spd, dx, dz, dist) {
    let tx = dx / dist;
    let tz = dz / dist;
    if (!this.los) {
      const dir = game.flowDir(this.x, this.z);
      if (!dir) return;
      tx = dir.x;
      tz = dir.z;
    }
    game.level.move(this, tx * spd * dt, tz * spd * dt, this.radius, this.y, false, true);
  }

  /** @param {number} dt @param {Game} game @param {number} dx @param {number} dz @param {number} dist @param {number} spd */
  _sentinel(dt, game, dx, dz, dist, spd) {
    switch (this.state) {
      case 'windup':
        this.t -= dt;
        if (this.t <= 0) {
          this.lx = dx / dist;
          this.lz = dz / dist;
          this.state = 'lunge';
          this.t = 0.3;
          this.hitDone = false;
        }
        break;
      case 'lunge': {
        this.t -= dt;
        game.level.move(this, this.lx * 9 * dt, this.lz * 9 * dt, this.radius, this.y, false, true);
        const p = game.player;
        if (!this.hitDone && Math.hypot(p.x - this.x, p.z - this.z) < this.radius + p.radius + 0.35) {
          this.hitDone = true;
          game.hurtPlayer(this.dmg, this);
        }
        if (this.t <= 0) { this.state = 'recover'; this.t = 0.6; }
        break;
      }
      case 'recover':
        this.t -= dt;
        if (this.t <= 0) this.state = 'chase';
        break;
      default:
        this.state = 'chase';
        this.pursue(dt, game, spd, dx, dz, dist);
        if (this.los && dist < 3.6) {
          this.state = 'windup';
          this.t = this.kind === 'mite' ? 0.45 : 0.55;
          game.audio.telegraph('stalker');
        }
    }
  }

  /** @param {number} dt @param {Game} game @param {number} dx @param {number} dz @param {number} dist @param {number} spd */
  _wisp(dt, game, dx, dz, dist, spd) {
    if (this.state === 'charge') {
      this.t -= dt;
      if (this.t <= 0) {
        game.spawnOrb(this, Math.atan2(dz, dx));
        this.fireT = 1.6 + Math.random() * 1.2;
        this.state = 'hover';
      }
      return;
    }
    this.state = 'hover';
    if (!this.los && dist > 4) this.pursue(dt, game, spd, dx, dz, dist);
    else {
      const mv = dist > 8 ? 1 : dist < 4.5 ? -1 : 0;
      const sx = (-dz / dist) * this.strafe;
      const sz = (dx / dist) * this.strafe;
      game.level.move(this, ((dx / dist) * mv + sx * 0.7) * spd * dt, ((dz / dist) * mv + sz * 0.7) * spd * dt, this.radius, this.y, false, true);
    }
    if (Math.random() < dt * 0.4) this.strafe *= -1;
    this.fireT -= dt;
    if (this.fireT <= 0 && this.los && dist < 14) {
      this.state = 'charge';
      this.t = 0.55;
      game.audio.telegraph('weaver');
    }
  }

  /** @param {number} dt @param {Game} game @param {number} dx @param {number} dz @param {number} dist @param {number} spd */
  _golem(dt, game, dx, dz, dist, spd) {
    switch (this.state) {
      case 'windup':
        this.t -= dt;
        if (this.t <= 0) {
          this.state = 'recover';
          this.t = 1.1;
          game.audio.slam();
          game.burst(this.x, this.y + 0.2, this.z, 16, [0.4, 0.9, 1.3], 4);
          if (dist < 3) game.hurtPlayer(this.dmg, this);
        }
        break;
      case 'recover':
        this.t -= dt;
        if (this.t <= 0) this.state = 'advance';
        break;
      default:
        this.state = 'advance';
        if (dist > 2) this.pursue(dt, game, spd, dx, dz, dist);
        if (this.los && dist < 2.5) {
          this.state = 'windup';
          this.t = 0.85;
          game.audio.telegraph('warden');
        }
    }
  }

  /** @returns {SpriteDesc} */
  getSprite() {
    let name = `${this.sprite}_idle`;
    if (this.sprite === 'sentinel') {
      name = this.state === 'windup' ? 'sentinel_windup' : this.state === 'lunge' ? 'sentinel_lunge' : Math.floor(this.anim * 6) % 2 && this.awake ? 'sentinel_walk' : 'sentinel_idle';
    } else if (this.sprite === 'wisp') name = this.state === 'charge' ? 'wisp_charge' : Math.floor(this.anim * 3) % 2 ? 'wisp_b' : 'wisp_a';
    else name = this.state === 'windup' ? 'golem_slam' : 'golem_idle';
    let tint = [1, 1, 1];
    if (this.flash > 0) tint = [3, 3, 3];
    else if (this.state === 'windup' && Math.sin(this.anim * 40) > 0) tint = [1.7, 1.7, 2];
    else if (this.shielded) tint = [0.7, 1.1, 1.9];
    else if (this.burn > 0) tint = [1.6, 0.9, 0.6];
    else if (this.slow > 0) tint = [0.7, 1.0, 1.5];
    else if (this.stagger > 0) tint = [1.3, 1.3, 0.8];
    const lift = this.sprite === 'wisp' ? 0.7 + Math.sin(this.anim * 2) * 0.1 : 0;
    return { x: this.x, y: this.y + lift, z: this.z, w: this.size, h: this.size, frame: SPR[name], emit: 1, tint, sky: 1 };
  }
}

/** Homing spirit orb fired by Censer Wisps; parried orbs become the player's and seek constructs. */
export class Orb {
  /** @param {number} x @param {number} y @param {number} z @param {number} angle @param {number} dmg */
  constructor(x, y, z, angle, dmg) {
    this.x = x;
    this.y = y;
    this.z = z;
    this.angle = angle;
    this.speed = 4.4;
    this.dmg = dmg;
    /** @type {'enemy'|'player'} */
    this.owner = 'enemy';
    this.life = 6;
    this.alive = true;
  }

  /** @param {number} dt @param {Game} game */
  update(dt, game) {
    this.life -= dt;
    if (this.life <= 0) { this.alive = false; return; }
    const target = this.owner === 'enemy' ? game.player : game.nearestEnemy(this.x, this.z, 12);
    if (target) {
      const want = Math.atan2(target.z - this.z, target.x - this.x);
      const turn = (this.owner === 'enemy' ? 1.5 : 3.2) * dt;
      this.angle += clamp(angleDiff(want, this.angle), -turn, turn);
      const ty = target.y + 1.1;
      this.y += clamp(ty - this.y, -2 * dt, 2 * dt);
    }
    this.x += Math.cos(this.angle) * this.speed * dt;
    this.z += Math.sin(this.angle) * this.speed * dt;
    const col = this.owner === 'enemy' ? [1.2, 0.5, 1.6] : [0.5, 1.4, 1.6];
    if (game.level.solidAt(this.x, this.z, this.y)) {
      this.alive = false;
      game.burst(this.x, this.y, this.z, 5, col, 1.5);
      return;
    }
    if (this.owner === 'enemy') {
      const p = game.player;
      if (Math.hypot(p.x - this.x, p.z - this.z) < p.radius + 0.25 && Math.abs(p.y + 1 - this.y) < 1.2 && game.hurtPlayer(this.dmg, null)) {
        this.alive = false;
        game.burst(this.x, this.y, this.z, 6, col, 1.5);
      }
      return;
    }
    for (const e of game.enemies) {
      if (e.alive && Math.hypot(e.x - this.x, e.z - this.z) < e.radius + 0.25) {
        game.damageEnemy(e, this.dmg * 3.5, this.x, this.z, 4, {});
        this.alive = false;
        game.burst(this.x, this.y, this.z, 10, col, 2.5);
        return;
      }
    }
  }

  /** @returns {SpriteDesc} */
  getSprite() {
    return { x: this.x, y: this.y - 0.4, z: this.z, w: 0.8, h: 0.8, frame: SPR[this.owner === 'enemy' ? 'orb_enemy' : 'orb_player'], emit: 2, tint: [1, 1, 1], sky: 1 };
  }
}

/** Player shot: ricochets off walls and terrain; flares burn, frost slows. */
export class Projectile {
  /**
   * @param {number} x @param {number} y @param {number} z @param {number} vx @param {number} vy @param {number} vz
   * @param {number} dmg @param {string} ammo shard|flare|frost @param {number} bounces allowed ricochets @param {boolean} bolt
   */
  constructor(x, y, z, vx, vy, vz, dmg, ammo, bounces, bolt) {
    this.x = x;
    this.y = y;
    this.z = z;
    this.vx = vx;
    this.vy = vy;
    this.vz = vz;
    this.dmg = dmg;
    this.ammo = ammo;
    this.maxBounce = bounces;
    this.bounced = 0;
    this.bolt = bolt;
    this.life = 1.6;
    this.alive = true;
  }

  /** @param {Game} game @returns {boolean} false if the projectile shattered */
  _bounce(game) {
    if (this.bounced >= this.maxBounce) {
      this.alive = false;
      game.burst(this.x, this.y, this.z, 3, [0.8, 1.0, 1.2], 1.2);
      return false;
    }
    this.bounced++;
    game.audio.ricochet();
    return true;
  }

  /** @param {number} dt @param {Game} game */
  update(dt, game) {
    this.life -= dt;
    if (this.life <= 0) { this.alive = false; return; }
    const L = game.level;
    if (this.bolt) this.vy -= 3 * dt;
    const n = 4;
    for (let s = 0; s < n && this.alive; s++) {
      const nx = this.x + (this.vx * dt) / n;
      if (L.solidAt(nx, this.z, this.y)) {
        if (!this._bounce(game)) return;
        this.vx = -this.vx;
      } else this.x = nx;
      const nz = this.z + (this.vz * dt) / n;
      if (L.solidAt(this.x, nz, this.y)) {
        if (!this._bounce(game)) return;
        this.vz = -this.vz;
      } else this.z = nz;
      this.y += (this.vy * dt) / n;
      const floor = L.heightAt(this.x, this.z);
      const ceil = L.outdoor ? (L.covered(this.x, this.z) ? L.ceil[L.idx(Math.floor(this.x), Math.floor(this.z))] : 1e9) : L.ceil[L.idx(Math.floor(this.x), Math.floor(this.z))] || 1e9;
      if (this.y < floor + 0.05 || this.y > ceil - 0.05) {
        if (!this._bounce(game)) return;
        this.vy = -this.vy * 0.7;
        this.y = clamp(this.y, floor + 0.06, ceil - 0.06);
      }
      for (const e of game.enemies) {
        if (!e.alive || Math.hypot(e.x - this.x, e.z - this.z) > e.radius + 0.18) continue;
        if (this.y < e.y - 0.2 || this.y > e.y + e.size) continue;
        const bonus = this.bounced && game.char.has('ricochet') ? 1.2 : 1;
        game.damageEnemy(e, this.dmg * bonus, this.x - this.vx * 0.02, this.z - this.vz * 0.02, this.bolt ? 2 : 0.8, { burn: this.ammo === 'flare', slow: this.ammo === 'frost' });
        if (this.bounced) {
          game.exercise('artificing', 1);
          game.notify('Bank shot!');
        }
        this.alive = false;
        game.burst(this.x, this.y, this.z, 4, this.ammo === 'flare' ? [1.6, 0.7, 0.3] : this.ammo === 'frost' ? [0.6, 1.0, 1.6] : [0.7, 1.1, 1.3], 1.6);
        return;
      }
    }
  }

  /** @returns {SpriteDesc} */
  getSprite() {
    const frame = SPR[this.ammo === 'flare' ? 'flare' : this.ammo === 'frost' ? 'frost' : this.bolt ? 'bolt' : 'shard'];
    return { x: this.x, y: this.y - 0.22, z: this.z, w: 0.45, h: 0.45, frame, emit: 2, tint: this.bounced ? [1.4, 1.1, 0.6] : [1, 1, 1], sky: 1 };
  }
}

/** A townsperson following a daily schedule between home, work and the tavern. */
export class NPC {
  /** @param {NpcDef} def @param {Level} level */
  constructor(def, level) {
    this.def = def;
    this.x = def.spots.home.x;
    this.z = def.spots.home.z;
    this.y = level.heightAt(this.x, this.z);
    this.radius = 0.3;
    /** @type {{x:number, z:number}[]} */
    this.path = [];
    /** @type {{x:number, z:number}|null} */
    this.goal = null;
    this.phase = '';
    this.working = false;
    this.talking = false;
    this.anim = Math.random() * 10;
    this.moving = false;
    this.patrolI = 0;
    this.thinkT = 0;
  }

  /** Where this NPC wants to be at a given hour. @param {number} hour 0..24 @returns {{spot:{x:number, z:number}, phase:string}} */
  scheduleAt(hour) {
    const [ws, we, bed] = this.def.hours;
    /** @param {number} a @param {number} b */
    const within = (a, b) => (hour >= a && hour < b) || (hour + 24 >= a && hour + 24 < b);
    const s = this.def.spots;
    if (within(ws, we)) {
      if (s.patrol) return { spot: s.patrol[this.patrolI % s.patrol.length], phase: 'work' };
      return { spot: s.work, phase: 'work' };
    }
    if (within(we, bed)) return { spot: s.tavern, phase: 'tavern' };
    return { spot: s.home, phase: 'home' };
  }

  /** @param {number} dt @param {Game} game @param {boolean} near player close enough to simulate walking */
  update(dt, game, near) {
    this.anim += dt;
    this.thinkT -= dt;
    const L = game.level;
    if (this.thinkT <= 0) {
      this.thinkT = 1.5;
      const { spot, phase } = this.scheduleAt(game.hour);
      this.working = phase === 'work';
      if (!this.goal || spot.x !== this.goal.x || spot.z !== this.goal.z) {
        this.goal = spot;
        this.phase = phase;
        this.path = near ? game.findPath(this.x, this.z, spot.x, spot.z) : [];
        if (!near || !this.path.length) {
          if (!near) { this.x = spot.x; this.z = spot.z; }
        }
      }
    }
    if (this.talking) {
      this.moving = false;
      return;
    }
    if (!this.path.length) {
      this.moving = false;
      if (this.def.spots.patrol && this.working && this.goal && Math.hypot(this.goal.x - this.x, this.goal.z - this.z) < 0.6) {
        this.patrolI++;
        this.thinkT = 0;
      }
      return;
    }
    const next = this.path[0];
    const dx = next.x - this.x;
    const dz = next.z - this.z;
    const d = Math.hypot(dx, dz);
    const step = 1.6 * dt;
    game.holdDoorAt(next.x, next.z);
    if (d <= step) {
      this.x = next.x;
      this.z = next.z;
      this.path.shift();
    } else {
      this.x += (dx / d) * step;
      this.z += (dz / d) * step;
    }
    this.y = L.heightAt(this.x, this.z);
    this.moving = true;
  }

  /** @param {Level} level @returns {SpriteDesc} */
  getSprite(level) {
    const walk = this.moving && Math.floor(this.anim * 4) % 2 === 1;
    const name = walk ? `${this.def.sprite}_walk` : this.def.sprite;
    return { x: this.x, y: this.y, z: this.z, w: 1.9, h: 1.9, frame: SPR[name], emit: this.def.sprite === 'master' ? 1 : 0, tint: [1, 1, 1], sky: level.covered(this.x, this.z) ? 0 : 1 };
  }
}

/** Short-lived emissive spark. */
export class Particle {
  /** @param {number} x @param {number} y @param {number} z @param {number} vx @param {number} vy @param {number} vz @param {number} life @param {number} size @param {number[]} tint */
  constructor(x, y, z, vx, vy, vz, life, size, tint) {
    this.x = x;
    this.y = y;
    this.z = z;
    this.vx = vx;
    this.vy = vy;
    this.vz = vz;
    this.life = life;
    this.maxLife = life;
    this.size = size;
    this.tint = tint;
    this.alive = true;
  }

  /** @param {number} dt @param {number} floor */
  update(dt, floor) {
    this.life -= dt;
    if (this.life <= 0) { this.alive = false; return; }
    this.vy -= 6 * dt;
    this.x += this.vx * dt;
    this.y += this.vy * dt;
    this.z += this.vz * dt;
    if (this.y < floor) { this.y = floor; this.vy *= -0.4; }
  }

  /** @returns {SpriteDesc} */
  getSprite() {
    const s = this.size * (0.4 + 0.6 * (this.life / this.maxLife));
    return { x: this.x, y: this.y - s / 2, z: this.z, w: s, h: s, frame: SPR.spark, emit: 2, tint: this.tint, sky: 1 };
  }
}
