/* ===================================================================
   /explore/lib/ship.js : first-person ship for the system view

   The ship is a point with a position in doubles (plain {x, y, z}
   object, scene units, 1 unit = 1,000 km), a velocity in units per
   second and an orientation quaternion. The page keeps the camera at
   the scene origin and places every body at (body - ship), so the
   ship's numbers never pass through a Float32 until they are turned
   into a small relative offset.

   Controls (pointer lock)
     mouse             look (yaw and pitch, no world-up constraint)
     Q / E             roll
     W / S, wheel      throttle up / down in THROTTLE_STEPS exponential
                       steps from 1 km/s to 3e7 km/s (about 100 c)
     A / D             yaw with the keyboard
     shift             boost, 4x the throttle speed
     space             brake to zero (also zeroes the throttle)
   Inertial: the velocity approaches the throttle target exponentially,
   so releasing a key glides. Nothing here is a model of a real drive;
   the readouts are honest about the speed, that is all.

   Frames: vel is the ship's own velocity relative to the body it is
   following (the star when flying freely; the target during an
   autopilot run and after arrival, when the ship keeps station and
   drifts along with the planet). The followed body's motion is added
   to the position only, so a parked ship reads 0 km/s whatever the
   simulation's time rate.

   This module does NOT import three; the page passes THREE in.
   =================================================================== */

import { KM_PER_UNIT } from './catalog.js';

export const C_KMS = 299792.458;
export const THROTTLE_STEPS = 14;
const MIN_KMS = 1;
const MAX_KMS = 3e7;
const STEP_RATIO = Math.pow(MAX_KMS / MIN_KMS, 1 / (THROTTLE_STEPS - 1));
const BOOST = 4;

const ACCEL_RATE = 2.2;          // 1/s, exponential approach to the throttle speed
const BRAKE_RATE = 7.0;          // 1/s, while space is held
const LOOK_SENS = 0.0021;        // rad per pixel of mouse motion
const TOUCH_SENS = 0.0048;       // rad per css pixel of touch drag
const LOOK_SMOOTH = 24;          // 1/s, how quickly pending look input is applied
const SOFT_DEADZONE_PX = 2;      // motions smaller than this are damped, not dropped
const ROLL_RATE = 1.35;          // rad/s at full roll input
const ROLL_SMOOTH = 8;           // 1/s
const KEY_YAW_RATE = 1.1;        // rad/s for A / D
const HULL = 1.02;               // the ship cannot get closer than this many radii to a body's centre
const REPEAT_DELAY = 0.38;       // s before a held W / S starts repeating
const REPEAT_EVERY = 0.12;       // s between repeated throttle steps
const WHEEL_STEP = 48;           // accumulated deltaY per throttle step
const AP_MAX = (MAX_KMS * BOOST) / KM_PER_UNIT;   // autopilot speed cap, units/s (about 400 c)
const AP_T = 1.1;                // s: autopilot speed = remaining distance / AP_T (ease-out)
const AP_APPROACH = 4.0;         // 1/s, velocity approach rate under autopilot
const AP_TURN = 2.6;             // 1/s, orientation slerp rate under autopilot
const AP_CANCEL_PX = 2.5;        // a mouse motion larger than this cancels the autopilot

const THROTTLE_UNITS = new Float64Array(THROTTLE_STEPS + 1);
for (let k = 1; k <= THROTTLE_STEPS; k++) THROTTLE_UNITS[k] = (MIN_KMS * Math.pow(STEP_RATIO, k - 1)) / KM_PER_UNIT;

/** Speed in scene units per second for a throttle level 0..THROTTLE_STEPS. */
export function throttleSpeedUnits(level) {
  const k = Math.max(0, Math.min(THROTTLE_STEPS, Math.round(level)));
  return THROTTLE_UNITS[k];
}

/** The throttle level whose speed is nearest to a speed in units per second. */
export function nearestThrottleLevel(unitsPerSecond) {
  if (!(unitsPerSecond > THROTTLE_UNITS[1] * 0.5)) return 0;
  const kms = unitsPerSecond * KM_PER_UNIT;
  const k = 1 + Math.log(kms / MIN_KMS) / Math.log(STEP_RATIO);
  return Math.max(0, Math.min(THROTTLE_STEPS, Math.round(k)));
}

function isTextTarget(t) {
  if (!t || !t.tagName) return false;
  const tag = t.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable === true;
}

/**
 * @param THREE the three.js namespace
 * @param opts { camera, element } the camera whose quaternion follows the ship, and the
 *   canvas used for pointer lock, mouse and touch events
 */
export function createShip(THREE, opts) {
  const camera = opts.camera;
  const element = opts.element;
  const doc = element && element.ownerDocument ? element.ownerDocument : document;

  /* ---- public state ---- */
  const pos = { x: 0, y: 0, z: 0 };
  const vel = { x: 0, y: 0, z: 0 };
  const quat = new THREE.Quaternion();

  /* ---- private state ---- */
  let level = 0;                  // throttle level 0..THROTTLE_STEPS
  let boost = false;
  let braking = false;
  let pendYaw = 0, pendPitch = 0; // look input not yet applied (radians)
  let rollVel = 0;
  let holdT = 0, repeatT = 0;
  let wheelAcc = 0;
  let locked = false;             // pointer lock currently held
  let lockRequested = false;
  let dragMode = false;           // pointer lock unavailable: mouse drag looks instead
  let freeLook = false;           // attach({ lock: false }): any mouse motion over the element looks
  let dragging = false;
  let lastX = NaN, lastY = NaN;   // last pointer position seen in free-look mode
  let dragX = 0, dragY = 0;
  let touchActive = false;
  let touchX = 0, touchY = 0;
  let silentDetach = false;
  let anchor = null;              // body the ship drifts with after an autopilot arrival
  const keys = { w: false, s: false, q: false, e: false, a: false, d: false };
  const ap = { active: false, body: null, stopRadii: 4 };

  /* ---- temporaries (no per-frame allocation) ---- */
  const AX_X = new THREE.Vector3(1, 0, 0);
  const AX_Y = new THREE.Vector3(0, 1, 0);
  const AX_Z = new THREE.Vector3(0, 0, 1);
  const ZERO = new THREE.Vector3(0, 0, 0);
  const qTmp = new THREE.Quaternion();
  const qTarget = new THREE.Quaternion();
  const mTmp = new THREE.Matrix4();
  const fwd = new THREE.Vector3();
  const up = new THREE.Vector3();
  const dir = new THREE.Vector3();
  const vTmp = new THREE.Vector3();

  const ship = {
    pos, vel, quat,
    enabled: false,
    onArrive: null,
    onRelease: null,
    onInput: null,          // fires once per manual input that cancels an autopilot (page use)
    attach, detach, update, autopilotTo, cancelAutopilot,
    speedKms, speedC, speedUnits, throttleLevel, throttleIndex, setThrottleIndex, throttleStep, brake,
    setPosition, lookAt, setVelocity, unanchor,
    touchLook: { start: touchStart, move: touchMove, end: touchEnd },
    get autopilot() { return ap.active; },
    get autopilotBody() { return ap.active ? ap.body : null; },
    get anchored() { return anchor; },
    get frameBody() { return ap.active ? ap.body : anchor; },
    get pointerLocked() { return locked; },
    get freeLook() { return freeLook; },
    get boosting() { return boost; },
    get braking() { return braking; },
    dispose,
  };

  /* ---------------- helpers ---------------- */

  function speedUnits() { return Math.sqrt(vel.x * vel.x + vel.y * vel.y + vel.z * vel.z); }
  function speedKms() { return speedUnits() * KM_PER_UNIT; }
  function speedC() { return speedKms() / C_KMS; }
  function throttleIndex() { return ap.active ? nearestThrottleLevel(speedUnits()) : level; }
  function throttleLevel() { return throttleIndex() / THROTTLE_STEPS; }

  function setThrottleIndex(k) {
    level = Math.max(0, Math.min(THROTTLE_STEPS, Math.round(Number(k) || 0)));
    if (level > 0) anchor = null;
  }
  function throttleStep(delta) {
    if (ap.active) manualInput();
    setThrottleIndex(level + (delta > 0 ? 1 : -1));
  }
  function brake() {
    if (ap.active) manualInput();
    level = 0;
    anchor = null;
    braking = true;
  }

  function setPosition(p) {
    pos.x = Number(p.x) || 0; pos.y = Number(p.y) || 0; pos.z = Number(p.z) || 0;
    anchor = null;                // a teleport ends station keeping
  }
  function unanchor() { anchor = null; }
  function setVelocity(v) {
    if (!v) { vel.x = 0; vel.y = 0; vel.z = 0; return; }
    vel.x = Number(v.x) || 0; vel.y = Number(v.y) || 0; vel.z = Number(v.z) || 0;
  }
  /** Face a world point; scene +z (the orbital plane's normal) is up. */
  function lookAt(p) {
    dir.set(p.x - pos.x, p.y - pos.y, p.z - pos.z);
    if (dir.lengthSq() < 1e-18) return;
    dir.normalize();
    up.set(0, 0, 1);
    if (Math.abs(dir.dot(up)) > 0.999) up.set(0, 1, 0);
    mTmp.lookAt(ZERO, dir, up);
    quat.setFromRotationMatrix(mTmp);
    if (camera) camera.quaternion.copy(quat);
  }

  /** Any manual input while the autopilot flies cancels it and hands the throttle back at the current speed. */
  function manualInput() {
    if (!ap.active) return;
    ap.active = false;
    ap.body = null;
    level = nearestThrottleLevel(speedUnits());
    if (typeof ship.onInput === 'function') ship.onInput();
  }

  /* ---------------- pointer lock ---------------- */

  /**
   * Take the controls. opts.lock === false skips pointer lock and looks with plain
   * mouse motion over the element (the ?flight=1 test path; also usable where
   * pointer lock is refused).
   */
  function attach(o) {
    ship.enabled = true;
    if (o && o.lock === false) {
      freeLook = true;
      dragMode = true;
      if (locked && doc.pointerLockElement === element && typeof doc.exitPointerLock === 'function') {
        silentDetach = true;
        try { doc.exitPointerLock(); } catch (err) { silentDetach = false; }
      }
      return;
    }
    if (locked) return;
    // try for the lock every time; when it is refused (no user gesture, an iframe policy,
    // a phone) the ship falls back to drag-to-look on the same element
    if (element && typeof element.requestPointerLock === 'function') {
      lockRequested = true;
      try {
        const r = element.requestPointerLock();
        if (r && typeof r.catch === 'function') r.catch(() => { lockRequested = false; dragMode = true; });
      } catch (err) {
        lockRequested = false;
        dragMode = true;
      }
    } else {
      dragMode = true;
    }
  }

  function detach() {
    ship.enabled = false;
    touchActive = false;
    dragging = false;
    freeLook = false;
    lastX = NaN; lastY = NaN;
    resetInputs();
    if (locked && doc.pointerLockElement === element && typeof doc.exitPointerLock === 'function') {
      silentDetach = true;
      try { doc.exitPointerLock(); } catch (err) { silentDetach = false; }
    }
  }

  function resetInputs() {
    keys.w = keys.s = keys.q = keys.e = keys.a = keys.d = false;
    boost = false; braking = false;
    pendYaw = 0; pendPitch = 0; rollVel = 0;
    holdT = 0; repeatT = 0; wheelAcc = 0;
  }

  function onLockChange() {
    const nowLocked = doc.pointerLockElement === element;
    if (nowLocked) {
      locked = true;
      lockRequested = false;
      ship.enabled = true;
      return;
    }
    if (!locked) return;
    locked = false;
    const silent = silentDetach;
    silentDetach = false;
    if (touchActive) return;               // a phone with a stray lock: keep the touch controls
    ship.enabled = false;
    resetInputs();
    if (!silent && typeof ship.onRelease === 'function') ship.onRelease();
  }

  function onLockError() {
    lockRequested = false;
    // pointer lock refused (no user gesture, an iframe policy): fall back to drag-to-look
    dragMode = true;
    ship.enabled = true;
  }

  /* ---------------- mouse ---------------- */

  function lookDelta(dx, dy, sens) {
    const mag = Math.sqrt(dx * dx + dy * dy);
    if (mag === 0) return;
    // soft deadzone: tiny motions count for less, larger ones pass through untouched
    const scale = mag < SOFT_DEADZONE_PX ? (mag / SOFT_DEADZONE_PX) : 1;
    pendYaw -= dx * sens * scale;
    pendPitch -= dy * sens * scale;
    if (ap.active && mag > AP_CANCEL_PX) manualInput();
  }

  function onMouseMove(e) {
    if (!ship.enabled) return;
    if (locked) {
      lookDelta(e.movementX || 0, e.movementY || 0, LOOK_SENS);
    } else if (freeLook) {
      // no lock: pointer deltas over the canvas drive the look (client deltas, so synthetic
      // events without movementX work too)
      const mx = Number.isFinite(lastX) ? e.clientX - lastX : 0;
      const my = Number.isFinite(lastY) ? e.clientY - lastY : 0;
      lastX = e.clientX; lastY = e.clientY;
      if (e.target === element || dragging) lookDelta(mx, my, LOOK_SENS * 1.6);
    } else if (dragMode && dragging) {
      lookDelta(e.clientX - dragX, e.clientY - dragY, LOOK_SENS * 1.6);
      dragX = e.clientX; dragY = e.clientY;
    }
  }
  function onMouseDown(e) {
    if (!ship.enabled || locked || !dragMode || e.button !== 0) return;
    dragging = true; dragX = e.clientX; dragY = e.clientY;
  }
  function onMouseUp() { dragging = false; }

  function onWheel(e) {
    if (!ship.enabled) return;
    e.preventDefault();
    const unit = e.deltaMode === 1 ? 16 : (e.deltaMode === 2 ? 120 : 1);
    wheelAcc += e.deltaY * unit;
    while (wheelAcc <= -WHEEL_STEP) { wheelAcc += WHEEL_STEP; throttleStep(+1); }
    while (wheelAcc >= WHEEL_STEP) { wheelAcc -= WHEEL_STEP; throttleStep(-1); }
  }

  /* ---------------- keyboard ---------------- */

  function onKeyDown(e) {
    if (!ship.enabled || isTextTarget(e.target)) return;
    const c = e.code || (e.key === 'Escape' ? 'Escape' : (e.key === ' ' ? 'Space' : ''));
    switch (c) {
      case 'KeyW': case 'ArrowUp':
        if (!keys.w) { keys.w = true; holdT = 0; repeatT = 0; throttleStep(+1); }
        break;
      case 'KeyS': case 'ArrowDown':
        if (!keys.s) { keys.s = true; holdT = 0; repeatT = 0; throttleStep(-1); }
        break;
      case 'KeyQ': keys.q = true; manualInput(); break;
      case 'KeyE': keys.e = true; manualInput(); break;
      case 'KeyA': case 'ArrowLeft': keys.a = true; manualInput(); break;
      case 'KeyD': case 'ArrowRight': keys.d = true; manualInput(); break;
      case 'ShiftLeft': case 'ShiftRight': boost = true; manualInput(); break;
      case 'Space': brake(); break;
      case 'Escape':
        // without pointer lock the browser cannot release the controls for us
        if (locked) return;
        ship.enabled = false;
        dragging = false; touchActive = false; freeLook = false;
        resetInputs();
        if (typeof ship.onRelease === 'function') ship.onRelease();
        return;
      default: return;
    }
    e.preventDefault();
  }
  function onKeyUp(e) {
    switch (e.code) {
      case 'KeyW': case 'ArrowUp': keys.w = false; break;
      case 'KeyS': case 'ArrowDown': keys.s = false; break;
      case 'KeyQ': keys.q = false; break;
      case 'KeyE': keys.e = false; break;
      case 'KeyA': case 'ArrowLeft': keys.a = false; break;
      case 'KeyD': case 'ArrowRight': keys.d = false; break;
      case 'ShiftLeft': case 'ShiftRight': boost = false; break;
      case 'Space': braking = false; break;
      default: break;
    }
  }
  function onBlur() { resetInputs(); }

  /* ---------------- touch look ---------------- */

  function touchStart(x, y) {
    touchActive = true;
    ship.enabled = true;
    touchX = x; touchY = y;
  }
  function touchMove(x, y) {
    if (!touchActive) return;
    lookDelta(x - touchX, y - touchY, TOUCH_SENS);
    touchX = x; touchY = y;
  }
  function touchEnd() {
    // the controls stay with the player between drags; detach() gives them up
    touchActive = false;
  }

  /* ---------------- autopilot ---------------- */

  function autopilotTo(body, o) {
    if (!body || !body.pos) return;
    ap.body = body;
    ap.stopRadii = o && Number.isFinite(o.stopRadii) ? Math.max(0.5, o.stopRadii) : 4;
    ap.active = true;
    anchor = null;
    braking = false;
  }
  function cancelAutopilot() {
    if (!ap.active) return;
    ap.active = false;
    ap.body = null;
    level = nearestThrottleLevel(speedUnits());
  }

  function autopilotStep(dt) {
    const b = ap.body;
    const r = Math.max(1e-6, Number(b.radius_units) || 1e-6);
    dir.set(b.pos.x - pos.x, b.pos.y - pos.y, b.pos.z - pos.z);
    const dist = dir.length();
    if (dist < 1e-9) { arrive(b); return; }
    dir.multiplyScalar(1 / dist);
    const stopDist = r * (1 + ap.stopRadii);
    const remaining = dist - stopDist;

    // orientation: turn to face the body, keeping the current up vector
    up.set(0, 1, 0).applyQuaternion(quat);
    if (Math.abs(dir.dot(up)) > 0.995) up.set(0, 0, 1);
    mTmp.lookAt(ZERO, dir, up);
    qTarget.setFromRotationMatrix(mTmp);
    quat.slerp(qTarget, 1 - Math.exp(-dt * AP_TURN));

    // speed: proportional to the remaining distance (ease-out), capped, and reduced
    // while the nose is still turning toward the target so the ship turns first
    let v;
    if (remaining > 0) {
      v = Math.min(AP_MAX, remaining / AP_T + r * 0.05);
      if (remaining > r * 10) {
        const align = Math.max(0, fwd.dot(dir));
        v *= 0.08 + 0.92 * align * align;
      }
      if (dt > 0) v = Math.min(v, remaining / dt);
    } else {
      v = -Math.min(AP_MAX, -remaining / AP_T + r * 0.05);   // too close: back off gently
      if (dt > 0) v = Math.max(v, remaining / dt);
    }
    // vel is relative to the target body: its own motion is added to the position in update()
    const k = 1 - Math.exp(-dt * AP_APPROACH);
    vel.x += (dir.x * v - vel.x) * k;
    vel.y += (dir.y * v - vel.y) * k;
    vel.z += (dir.z * v - vel.z) * k;

    // arrival: parked at the stop distance, at rest relative to the body
    if (Math.abs(remaining) < r * 0.03 && speedUnits() < r * 0.06) arrive(b);
  }

  function arrive(b) {
    ap.active = false;
    ap.body = null;
    level = 0;
    anchor = b;
    vel.x = 0; vel.y = 0; vel.z = 0;
    if (typeof ship.onArrive === 'function') ship.onArrive(b);
  }

  /* ---------------- per-frame integration ---------------- */

  /**
   * @param dt      real seconds since the last call
   * @param bodies  [{ pos:{x,y,z}, radius_units, name, vel?:{x,y,z} }] for hull stops and arrival
   */
  function update(dt, bodies) {
    if (!(dt > 0)) dt = 0;
    if (dt > 0.1) dt = 0.1;

    // held W / S repeat after a short delay
    if (dt > 0 && (keys.w !== keys.s)) {
      holdT += dt;
      if (holdT > REPEAT_DELAY) {
        repeatT += dt;
        while (repeatT >= REPEAT_EVERY) { repeatT -= REPEAT_EVERY; throttleStep(keys.w ? +1 : -1); }
      }
    }

    // look: apply a fraction of the pending input each frame (smooth, slight lag)
    const kl = 1 - Math.exp(-dt * LOOK_SMOOTH);
    let yaw = pendYaw * kl, pitch = pendPitch * kl;
    pendYaw -= yaw; pendPitch -= pitch;
    yaw += ((keys.a ? 1 : 0) - (keys.d ? 1 : 0)) * KEY_YAW_RATE * dt;
    const rollTarget = ((keys.q ? 1 : 0) - (keys.e ? 1 : 0)) * ROLL_RATE;
    rollVel += (rollTarget - rollVel) * (1 - Math.exp(-dt * ROLL_SMOOTH));
    const roll = rollVel * dt;
    if (yaw !== 0) { qTmp.setFromAxisAngle(AX_Y, yaw); quat.multiply(qTmp); }
    if (pitch !== 0) { qTmp.setFromAxisAngle(AX_X, pitch); quat.multiply(qTmp); }
    if (roll !== 0) { qTmp.setFromAxisAngle(AX_Z, roll); quat.multiply(qTmp); }
    quat.normalize();
    fwd.set(0, 0, -1).applyQuaternion(quat);

    // the local frame: the autopilot target, or the body the ship keeps station with.
    // Its motion is applied first so the autopilot measures the current geometry
    // (at fast time rates a planet moves a good fraction of a radius per frame; measuring
    // before this step made the autopilot stop short by that lag).
    const frame = ap.active ? ap.body : anchor;
    if (frame && frame.vel) {
      pos.x += frame.vel.x * dt; pos.y += frame.vel.y * dt; pos.z += frame.vel.z * dt;
    }

    if (ap.active) {
      autopilotStep(dt);
    } else {
      const target = braking ? 0 : THROTTLE_UNITS[level] * (boost ? BOOST : 1);
      const k = 1 - Math.exp(-dt * (braking ? BRAKE_RATE : ACCEL_RATE));
      vel.x += (fwd.x * target - vel.x) * k;
      vel.y += (fwd.y * target - vel.y) * k;
      vel.z += (fwd.z * target - vel.z) * k;
      if (target === 0 && speedUnits() < 1e-6) { vel.x = 0; vel.y = 0; vel.z = 0; }
    }

    pos.x += vel.x * dt; pos.y += vel.y * dt; pos.z += vel.z * dt;

    // hull stop: never inside a body
    if (bodies) {
      for (let i = 0; i < bodies.length; i++) {
        const b = bodies[i];
        const minR = (Number(b.radius_units) || 0) * HULL;
        if (!(minR > 0)) continue;
        const dx = pos.x - b.pos.x, dy = pos.y - b.pos.y, dz = pos.z - b.pos.z;
        const r2 = dx * dx + dy * dy + dz * dz;
        if (r2 >= minR * minR) continue;
        const rr = Math.sqrt(r2);
        let nx, ny, nz;
        if (rr < 1e-9) { nx = fwd.x; ny = fwd.y; nz = fwd.z; } else { nx = dx / rr; ny = dy / rr; nz = dz / rr; }
        pos.x = b.pos.x + nx * minR; pos.y = b.pos.y + ny * minR; pos.z = b.pos.z + nz * minR;
        const vn = vel.x * nx + vel.y * ny + vel.z * nz;
        if (vn < 0) { vel.x -= nx * vn; vel.y -= ny * vn; vel.z -= nz * vn; }
        if (level > 0) level = 0;    // the throttle is cut on contact
      }
    }

    if (camera) camera.quaternion.copy(quat);
  }

  /* ---------------- events ---------------- */

  const onTouchStartDom = (e) => {
    if (!e.touches || e.touches.length !== 1) return;
    if (!ship.enabled && !touchActive) return;   // the page decides when touch flight begins
    const t = e.touches[0];
    touchStart(t.clientX, t.clientY);
    e.preventDefault();
  };
  const onTouchMoveDom = (e) => {
    if (!touchActive || !e.touches || e.touches.length !== 1) return;
    const t = e.touches[0];
    touchMove(t.clientX, t.clientY);
    e.preventDefault();
  };
  const onTouchEndDom = () => { if (touchActive) touchEnd(); };

  doc.addEventListener('pointerlockchange', onLockChange);
  doc.addEventListener('pointerlockerror', onLockError);
  doc.addEventListener('mousemove', onMouseMove);
  doc.addEventListener('mouseup', onMouseUp);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);
  if (element) {
    element.addEventListener('mousedown', onMouseDown);
    element.addEventListener('wheel', onWheel, { passive: false });
    element.addEventListener('touchstart', onTouchStartDom, { passive: false });
    element.addEventListener('touchmove', onTouchMoveDom, { passive: false });
    element.addEventListener('touchend', onTouchEndDom);
    element.addEventListener('touchcancel', onTouchEndDom);
  }

  function dispose() {
    detach();
    doc.removeEventListener('pointerlockchange', onLockChange);
    doc.removeEventListener('pointerlockerror', onLockError);
    doc.removeEventListener('mousemove', onMouseMove);
    doc.removeEventListener('mouseup', onMouseUp);
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    window.removeEventListener('blur', onBlur);
    if (element) {
      element.removeEventListener('mousedown', onMouseDown);
      element.removeEventListener('wheel', onWheel);
      element.removeEventListener('touchstart', onTouchStartDom);
      element.removeEventListener('touchmove', onTouchMoveDom);
      element.removeEventListener('touchend', onTouchEndDom);
      element.removeEventListener('touchcancel', onTouchEndDom);
    }
  }

  return ship;
}
