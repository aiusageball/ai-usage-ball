/* ═══════════════════════════════════════════════════════════════════════
   彩蛋:水晶球弹射 × 同色消除

   进程(全程无任何文字引导,靠玩家自己发现):
   ─ 潜伏:按住主界面任意水晶球拖动(>6px 判定为拖拽;普通点击仍是弹出
     桌面小球)。可以拉很长,越拉越沉;无绳、无辅助线;松手反向弹射。
   ─ 竞技场:UI 保持可见,弹射出去的【真实水晶球】(液体/圆环/倒计时数字
     全在,数字随球滚动旋转)在窗口内反弹。撞到界面里【另外两个真实水晶
     球】→ 那颗球也被撞飞、变成物理球,+1 分(玻璃脆响)。
   ─ 折叠:两颗球都被撞飞后,UI 淡出,背景变暗。
   ─ 消除(match):全尺寸水晶球(与主界面同一视觉风格)不断出现在场景中。
     玩家用弹射/方向键把球撞过去,被撞中的球会弹飞并继续撞其他球,
     形成连锁反应。当两个【同色球】碰撞时,一起消除,+2 分。
     异色球则正常弹开。球会随时间逐渐变小增加难度。
     场上球过多(≥12 个)游戏结束;分数到 100 进第二关。
   ─ 球雨消除(rainmatch,第二关):球从上方掉落,按住玩家球直拖(像空气
     曲棍球球拍)去撞。同色消除 +2,漏到底边扣 1 分,分数≤0 结束。
     分数到 200 进第三关。
   ─ 极速车道(race,第三关,地狱难度):窗口自动拉高,3 条车道,水晶球
     迎面而来越来越大,3-2-1-GO 发车。左右方向键换道,接触那一刹那结算:
     接住同色 +分×combo(粒子爆裂),撞上异色 -15 清 combo 红屏震动,
     该接的同色溜走也 -3(不能光躲)。只加速不减速,20s HELL MODE
     (双发+中途变道的漂移球),40s MAX GEAR(双发成常态)。
     分数掉到 0 直接结束;到 300 直接"赢了"。
   ─ Esc 随时退出。状态用 registry 注册,未来玩法 register()+switchState 即挂。

   玩家球与被撞球都是【真实 DOM 节点】:游戏开始把 .orb-glass 摘到 body 下
   (React 靠节点引用继续每秒刷新倒计时,不受搬家影响),物理逐帧写
   transform(平移+旋转+缩放),退出原样放回。
   ═══════════════════════════════════════════════════════════════════ */

// ── 可调参数(手感全在这里) ─────────────────────────────────────────
export const PHYS = {
  DRAG_THRESHOLD: 6,     // px,超过才算拖拽(区分普通点击)
  DRAG_FEEL: 320,        // 沉重感衰减:越小越沉
  DRAG_MAX_OFFSET: 170,  // 拖拽最大视觉位移(可以拉很长)
  ROLL: 1.0,             // 滚动自旋系数(数字随球转)
  LAUNCH_K: 7.0,         // 弹射速度 = 拖拽距离 × K
  MAX_LAUNCH: 2600,
  AIR_DRAG: 0.4,         // 空气阻力/秒
  WALL_REST: 0.88,       // 撞墙恢复系数
  BALL_REST: 0.96,       // 球球恢复系数
  STOP_SPEED: 24,
  STEER: 1600,           // 方向键施力 px/s²
  IDLE_RETURN: 2.2,      // 竞技场:没撞到任何球且停下后,几秒静默归位
  GROW_DELAY: 0.9,       // 两球撞飞后到变大的停顿 s
  // ── 消除阶段参数 ──
  SPAWN_INTERVAL_0: 2.5, // 初始生成间隔 s
  SPAWN_MIN: 0.8,        // 最快生成间隔 s
  SPAWN_RAMP: 50,        // 生成间隔收紧时间常数 s
  ORB_SIZE_0: 120,       // 初始球直径 px
  ORB_SIZE_MIN: 50,      // 最小球直径 px
  SHRINK_TIME: 90,       // 缩小时间常数 s(越大越慢)
  MAX_ORBS: 12,          // 场上最大球数(超过则结束)
  ORB_DRIFT: 30,         // 生成球初始漂移速度 px/s
  ORB_DRAG: 1.2,         // 生成球空气阻力(比玩家球更大,会慢慢停)
  // ── 第二关:球雨消除 ──
  LEVEL2_SCORE: 100,     // 进入第二关的分数
  RAIN_V0: 130,          // 初始下落速度 px/s
  RAIN_ACCEL: 6,         // 每秒全局提速 px/s²
  RAIN_SPAWN0: 2.2,      // 初始生成间隔 s
  RAIN_SPAWN_MIN: 0.5,   // 最快生成间隔 s
  RAIN_RAMP: 45,         // 生成间隔收紧时间常数 s
  // ── 第三关:极速车道(地狱难度,分数掉到 0 直接结束) ──
  LEVEL3_SCORE: 200,     // 进入第三关的分数
  WIN_SCORE: 300,        // 第三关分数到这个数直接"赢了",搞笑收场
  RACE_LANES: 3,         // 车道数(左中右)
  RACE_WIN_H: 760,       // 进第三关时窗口拉高到这个高度(默认 470,见 DEFAULT_WIN_H)
  RACE_HIT_Y_FRAC: 0.86, // 玩家球所在行,相对场地高度的比例
  RACE_V0: 260,          // 初始接近速度 px/s
  RACE_ACCEL: 13,        // 每秒提速 px/s²(地狱难度的核心:越到后面越快)
  RACE_SPAWN0: 1.15,     // 初始生成间隔 s
  RACE_SPAWN_MIN: 0.24,  // 最快生成间隔 s
  RACE_RAMP: 24,         // 生成间隔收紧时间常数 s
  RACE_HELL_AT: 20,      // HELL MODE:双道齐发概率大增,开始出中途变道的漂移球
  RACE_MAX_AT: 40,       // MAX GEAR:双道齐发成为常态
  RACE_HIT_SCORE: 2,     // 接住同色的基础分(乘 combo 倍率)
  RACE_WRONG_PENALTY: 15,// 撞错颜色的代价(比加分重得多,一次失误抹掉好几次成果)
  RACE_PASS_PENALTY: 3,  // 该接的同色球溜过去没接到,也要罚(逼你主动追,不能光躲)
  RACE_COMBO_MAX: 5,     // 连续接对的 combo 倍率上限
  RACE_LANE_SLIDE: 16,   // 换道时的插值速度系数(越大切换越快)
};

// 三种颜色(与主界面的三颗水晶球对应)
const ORB_COLORS = [
  { id: 'claude',      hex: '#ff8c00', hue: '0deg',   sat: '1.0', bri: '1.0' },
  { id: 'codex',       hex: '#ef4444', hue: '320deg', sat: '2.0', bri: '1.2' },
  { id: 'antigravity', hex: '#06b6d4', hue: '185deg', sat: '1.8', bri: '1.2' },
];

// ── 上下文 ──────────────────────────────────────────────────────────
const G = {
  canvas: null, ctx: null, dpr: 1, W: 0, H: 0,
  running: false, raf: 0, last: 0,
  state: null, stateName: 'dormant',
  balls: [],            // 真实水晶球物理体 [{x,y,vx,vy,r,rot,orb:{el,parent,next,scale,halfW},isPlayer,detached}]
  statics: [],          // 竞技场里还没被撞飞的真实球(静态碰撞体) [{x,y,r,el}]
  orbs: [],             // 消除阶段的生成球 [{x,y,vx,vy,r,rot,el,color,dead}]
  score: 0,
  bgAlpha: 0, matchT: 0, spawnIn: 0,
  rainT: 0, fallV: 0,
  lifeLostUntil: 0,
  // 第三关(极速车道)专用状态
  raceLane: 1, raceHitY: 0, raceT: 0, raceV: 0, raceScrollY: 0,
  raceCombo: 0, racePhase: 0, raceIntroT: 0, raceCount: -1,
  raceBannerEl: null, laneEls: null, hitLineEl: null, hurtEl: null,
  keys: new Set(), drag: null,
  suppressClick: false,
  audio: null,
  scoreEl: null,
  exitBtn: null,
  dimEl: null,
  winMsgEl: null,
  resizeHandler: null,
  // 第二关(rainmatch)专用:按住直接拖着球走(像空气曲棍球球拍),不是
  // 拉弓蓄力松手弹射。holdActive 时每帧把球位置吸附到鼠标位置,速度由
  // 帧间位移算出 —— 拖得快、角度斜,撞到球时力度/方向就相应地大/偏。
  holdActive: false, holdTargetX: 0, holdTargetY: 0,
  chromeTop: 0, chromeBottom: 0,   // 顶栏底部/底栏顶部的真实屏幕 y 坐标
};

// Tauri 窗口 API(动态引入,纯浏览器 dev 下静默不可用)
let winApi = null;
try { import('@tauri-apps/api/window').then((m) => { winApi = m; }); } catch (e) {}
// 主窗口默认尺寸(须与 tauri.conf.json 里 windows[0].width/height 保持一致)。
// 玩家可能在游戏过程中手动把窗口拉大,退出游戏后把窗口尺寸复原成这个默认值。
const DEFAULT_WIN_W = 860, DEFAULT_WIN_H = 470;

// ── 状态机 ──────────────────────────────────────────────────────────
const States = {};
function register(name, impl) { States[name] = impl; }
function switchState(name) {
  if (G.state && G.state.exit) G.state.exit();
  G.stateName = name; G.state = States[name];
  if (G.state && G.state.enter) G.state.enter();
}

// ── WebAudio 合成音效 ───────────────────────────────────────────────
function audioCtx() {
  if (!G.audio) { try { G.audio = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) {} }
  return G.audio;
}
function tone(freq, dur, type = 'sine', gain = 0.18, when = 0) {
  const ac = audioCtx(); if (!ac) return;
  const o = ac.createOscillator(), g = ac.createGain();
  o.type = type; o.frequency.value = freq * (0.98 + Math.random() * 0.04);
  g.gain.setValueAtTime(gain, ac.currentTime + when);
  g.gain.exponentialRampToValueAtTime(0.0008, ac.currentTime + when + dur);
  o.connect(g); g.connect(ac.destination);
  o.start(ac.currentTime + when); o.stop(ac.currentTime + when + dur + 0.02);
}
const sfx = {
  clink(v = 1) { tone(2100, 0.11, 'sine', 0.14 * v); tone(3400, 0.07, 'sine', 0.07 * v); },
  big() { tone(1500, 0.2, 'sine', 0.16); tone(2400, 0.14, 'sine', 0.1, 0.02); },
  bounce(v = 1) { tone(320, 0.06, 'triangle', 0.09 * Math.min(1, v)); },
  miss() { tone(150, 0.25, 'triangle', 0.16); },
  grow() { tone(660, 0.5, 'sine', 0.07); tone(990, 0.6, 'sine', 0.05, 0.1); },
  over() { tone(520, 0.4, 'sine', 0.08); tone(390, 0.5, 'sine', 0.08, 0.15); tone(260, 0.7, 'sine', 0.08, 0.3); },
  match() {  // 同色消除:悦耳的双音和弦
    tone(880, 0.25, 'sine', 0.12); tone(1320, 0.2, 'sine', 0.08, 0.05);
    tone(1760, 0.15, 'sine', 0.05, 0.1);
  },
  win() {  // 赢了:上扬的四音琶音(C-E-G-高八度C)
    tone(523, 0.15, 'sine', 0.14); tone(659, 0.15, 'sine', 0.13, 0.1);
    tone(784, 0.15, 'sine', 0.12, 0.2); tone(1047, 0.4, 'sine', 0.15, 0.3);
  },
  level3() {  // 进第三关:比 grow 更急促的三连升调,预告"车道要来了"
    tone(523, 0.12, 'sine', 0.1); tone(659, 0.12, 'sine', 0.1, 0.1);
    tone(784, 0.35, 'sine', 0.12, 0.2);
  },
  hell() {  // 进入地狱模式:低音下沉 + 不和谐音,营造压迫感
    tone(196, 0.5, 'sawtooth', 0.05); tone(207, 0.5, 'sawtooth', 0.04, 0.05);
    tone(880, 0.15, 'square', 0.06, 0.3);
  },
  crash() {  // 撞错颜色:低沉的碎裂声,比 miss 更痛
    tone(110, 0.3, 'sawtooth', 0.14); tone(92, 0.35, 'square', 0.1, 0.02);
    tone(60, 0.4, 'triangle', 0.12, 0.05);
  },
  count() { tone(620, 0.09, 'square', 0.07); },                       // 倒计时滴答
  go() { tone(880, 0.18, 'square', 0.1); tone(1320, 0.3, 'sine', 0.1, 0.06); },  // 发车!
};

// ── canvas(只画暗背景) ──────────────────────────────────────────────
// 顶栏(标题/LIVE_SYNC/齿轮)和底栏(时间/品牌)在游戏里保持常驻可见(见
// App.css .spheres-grid 淡出规则),暗色遮罩因此也只画在两者之间的中段,
// 不能整窗铺满盖住它们。读真实 DOM 位置,不猜像素数字,窗口大小变化自适应。
function updateChromeBand() {
  const header = document.querySelector('.popover-header-section');
  const footer = document.querySelector('.popover-footer-accent');
  G.chromeTop = header ? header.getBoundingClientRect().bottom : 0;
  G.chromeBottom = footer ? footer.getBoundingClientRect().top : G.H;
}
function ensureCanvas() {
  if (G.canvas) return;
  const c = document.createElement('canvas');
  c.id = 'egg-canvas';
  document.body.appendChild(c);
  G.canvas = c; G.ctx = c.getContext('2d', { alpha: true });
  const resize = () => {
    if (!G.ctx) return; // Prevent crash if called after exit
    G.dpr = window.devicePixelRatio || 1;
    G.W = window.innerWidth; G.H = window.innerHeight;
    c.width = G.W * G.dpr; c.height = G.H * G.dpr;
    G.ctx.setTransform(G.dpr, 0, 0, G.dpr, 0, 0);
    updateChromeBand();
  };
  resize();
  G.resizeHandler = resize;
  window.addEventListener('resize', resize);
}
function startLoop() {
  if (G.running) return;
  G.running = true; G.last = performance.now();
  const step = (t) => {
    if (!G.running) return;
    const dt = Math.min(0.033, (t - G.last) / 1000); G.last = t;
    try {
      if (G.state && G.state.update) G.state.update(dt);
      if (G.running) render();
    } catch (err) {
      console.error('easterEgg crashed, bailing out:', err);
      exitGame();   // 任何异常都安全收场,绝不留下一个坏死的界面
      return;
    }
    G.raf = requestAnimationFrame(step);
  };
  G.raf = requestAnimationFrame(step);
}
function stopLoop() { G.running = false; cancelAnimationFrame(G.raf); if (G.ctx) G.ctx.clearRect(0, 0, G.W, G.H); }

// ── 物理 ────────────────────────────────────────────────────────────
function stepBall(b, dt, drag = PHYS.AIR_DRAG) {
  b.x += b.vx * dt; b.y += b.vy * dt;
  const f = Math.exp(-drag * dt);
  b.vx *= f; b.vy *= f;
  b.rot += ((b.vx * PHYS.ROLL + b.vy * PHYS.ROLL * 0.35) / b.r) * dt;
}
function bounceWalls(b) {
  let hit = false;
  if (b.x - b.r < 0) { b.x = b.r; b.vx = Math.abs(b.vx) * PHYS.WALL_REST; hit = true; }
  if (b.x + b.r > G.W) { b.x = G.W - b.r; b.vx = -Math.abs(b.vx) * PHYS.WALL_REST; hit = true; }
  if (b.y - b.r < 0) { b.y = b.r; b.vy = Math.abs(b.vy) * PHYS.WALL_REST; hit = true; }
  if (b.y + b.r > G.H) { b.y = G.H - b.r; b.vy = -Math.abs(b.vy) * PHYS.WALL_REST; hit = true; }
  return hit;
}
function collide(a, b) {  // 圆形刚体弹性碰撞,质量 ∝ r²
  const dx = b.x - a.x, dy = b.y - a.y;
  const dist = Math.hypot(dx, dy), minD = a.r + b.r;
  if (dist === 0 || dist >= minD) return false;
  const nx = dx / dist, ny = dy / dist;
  const ma = a.r * a.r, mb = b.r * b.r;
  const overlap = minD - dist;
  a.x -= nx * overlap * (mb / (ma + mb)); a.y -= ny * overlap * (mb / (ma + mb));
  b.x += nx * overlap * (ma / (ma + mb)); b.y += ny * overlap * (ma / (ma + mb));
  const dvx = a.vx - b.vx, dvy = a.vy - b.vy;
  const dvn = dvx * nx + dvy * ny;
  if (dvn <= 0) return false;
  const j = dvn * 2 * ma * mb / (ma + mb) * PHYS.BALL_REST;
  a.vx -= (j / ma) * nx; a.vy -= (j / ma) * ny;
  b.vx += (j / mb) * nx; b.vy += (j / mb) * ny;
  return true;
}
function steer(dt) {
  const p = player(); if (!p) return;
  const a = PHYS.STEER * dt, k = G.keys;
  if (k.has('ArrowLeft')) p.vx -= a;
  if (k.has('ArrowRight')) p.vx += a;
  if (k.has('ArrowUp')) p.vy -= a;
  if (k.has('ArrowDown')) p.vy += a;
}
const player = () => G.balls.find((b) => b.isPlayer);

// ── 无绳弹弓 ────────────────────────────────────────────────────────
function dragOffset(dx, dy) {
  const d = Math.hypot(dx, dy);
  if (d === 0) return { ox: 0, oy: 0 };
  const mag = Math.min(PHYS.DRAG_MAX_OFFSET, d * (PHYS.DRAG_FEEL / (PHYS.DRAG_FEEL + d)));
  return { ox: (dx / d) * mag, oy: (dy / d) * mag };
}
function launchVelocity(dx, dy) {
  let vx = -dx * PHYS.LAUNCH_K, vy = -dy * PHYS.LAUNCH_K;
  const sp = Math.hypot(vx, vy);
  if (sp > PHYS.MAX_LAUNCH) { vx *= PHYS.MAX_LAUNCH / sp; vy *= PHYS.MAX_LAUNCH / sp; }
  return { vx, vy };
}

// ── 真实水晶球的摘取/归还 ───────────────────────────────────────────
function detachOrb(el, isPlayer = false) {
  const rect = el.getBoundingClientRect();
  const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2, r = rect.width / 2;
  const orb = { el, parent: el.parentNode, next: el.nextSibling, scale: 1, halfW: 0 };
  document.body.appendChild(el);
  const naturalW = el.offsetWidth;
  orb.scale = rect.width / naturalW;
  orb.halfW = naturalW / 2;
  Object.assign(el.style, {
    position: 'fixed', left: '0', top: '0', margin: '0', zIndex: '9001',
    transformOrigin: `${orb.halfW}px ${orb.halfW}px`,
    willChange: 'transform', transition: 'none',
  });
  // data-provider(App.jsx 上写的,claude/codex/antigravity)记下玩家球自己的
  // 颜色——第三关(极速车道)要用它判断迎面而来的球是"同色"还是"撞错了"。
  const ball = { x: cx, y: cy, vx: 0, vy: 0, r, rot: 0, orb, isPlayer, color: el.dataset.provider || null };
  G.balls.push(ball);
  applyBall(ball);
  return ball;
}
function restoreOrb(ball) {
  const { el, parent, next } = ball.orb;
  ['position', 'left', 'top', 'margin', 'zIndex', 'transform',
   'transformOrigin', 'willChange', 'transition', 'opacity'].forEach((k) => { el.style[k] = ''; });
  if (parent) parent.insertBefore(el, next);
}
function applyBall(b, offX = 0, offY = 0) {
  const o = b.orb;
  o.el.style.transform =
    `translate(${b.x + offX - o.halfW}px, ${b.y + offY - o.halfW}px) rotate(${b.rot}rad) scale(${o.scale})`;
}

// ── 消除球:全尺寸水晶球(与主界面同视觉) ──────────────────────────
function orbSize() {
  // 随游戏时间从大变小
  const t = G.matchT || 0;
  return PHYS.ORB_SIZE_MIN +
    (PHYS.ORB_SIZE_0 - PHYS.ORB_SIZE_MIN) * Math.exp(-t / PHYS.SHRINK_TIME);
}
function spawnOrb() {
  const color = ORB_COLORS[(Math.random() * ORB_COLORS.length) | 0];
  const size = orbSize();
  const r = size / 2;

  // 创建 DOM 元素(仿 .orb-glass 视觉)
  const el = document.createElement('div');
  el.className = 'egg-orb';
  el.style.width = el.style.height = `${size}px`;
  // 颜色环(外圈光晕)
  el.style.boxShadow = `
    inset 0 0 ${size * 0.15}px rgba(0,0,0,0.9),
    inset 0 0 ${size * 0.04}px rgba(255,255,255,0.2),
    inset 0 -${size * 0.08}px ${size * 0.16}px rgba(255,255,255,0.12),
    0 ${size * 0.08}px ${size * 0.16}px rgba(0,0,0,0.6),
    0 0 ${size * 0.2}px ${color.hex}44`;
  // 液体海报图
  const img = document.createElement('img');
  img.src = '/liquid-poster.png';
  img.style.cssText = `
    position: absolute; left: 50%; top: 50%;
    width: 145%; height: 145%;
    transform: translate(-50%, -50%);
    object-fit: cover; mix-blend-mode: screen;
    filter: hue-rotate(${color.hue}) saturate(${color.sat}) brightness(${color.bri});
  `;
  el.appendChild(img);
  // 高光
  const spec = document.createElement('div');
  spec.className = 'egg-orb-specular';
  el.appendChild(spec);

  document.body.appendChild(el);

  // 随机位置(避免靠边)
  const margin = r + 20;
  let x, y, attempts = 0;
  do {
    x = margin + Math.random() * (G.W - 2 * margin);
    y = margin + Math.random() * (G.H - 2 * margin);
    attempts++;
  } while (attempts < 20 && isTooClose(x, y, r));

  // 轻微初始漂移
  const angle = Math.random() * Math.PI * 2;
  const orb = {
    el, r, x, y, color: color.id,
    vx: Math.cos(angle) * PHYS.ORB_DRIFT,
    vy: Math.sin(angle) * PHYS.ORB_DRIFT,
    rot: 0, dead: false,
  };
  el.style.transform = `translate(${x - r}px, ${y - r}px)`;
  G.orbs.push(orb);
}
function isTooClose(x, y, r) {
  // 检查是否与玩家球或已有消除球太近
  const p = player();
  if (p && Math.hypot(x - p.x, y - p.y) < p.r + r + 30) return true;
  for (const o of G.orbs) {
    if (!o.dead && Math.hypot(x - o.x, y - o.y) < o.r + r + 10) return true;
  }
  return false;
}
function applyOrb(o) {
  o.el.style.transform = `translate(${o.x - o.r}px, ${o.y - o.r}px) rotate(${o.rot}rad)`;
}
function removeOrb(o) {
  o.dead = true;
  o.el.remove();
}
// 漏球时在"逃出去的那个边"上打一个红色的圈,并让比分抖一下——不然球一旦
// 判定漏球时早就飞出屏幕外老远了(尤其第三关四面八方都能飞出去,不像第二关
// 永远从底边掉出去那么好盯),玩家完全看不到是哪颗球、从哪漏的,只听见一声
// 音效、看见命数少了一颗,搞不清发生了什么。把位置钳在场地边缘上,保证
// 这个提示总是画在看得见的地方。
function missFlash(x, y) {
  const fx = Math.max(0, Math.min(G.W, x));
  const fy = Math.max(0, Math.min(G.H, y));
  const el = document.createElement('div');
  el.className = 'egg-miss-ping';
  const size = 90;
  el.style.left = `${fx - size / 2}px`;
  el.style.top = `${fy - size / 2}px`;
  el.style.width = el.style.height = `${size}px`;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 550);
  // 不直接在这里 classList.add ——render() 每帧都会把 scoreEl.className 整个
  // 重写一遍(拼 baseClass+negativeClass),下一帧就把这个 class 冲掉了,
  // 动画播放不出来。改成记一个"到期时间戳",让 render() 自己判断要不要
  // 把这个 class 拼进当帧的 className 里。
  G.lifeLostUntil = performance.now() + 350;
}
// 接触即爆:一圈色环 + 一把同色粒子四散,给"碰到那一刹那"一个爽脆的反馈。
function burstFX(x, y, hex) {
  const ring = document.createElement('div');
  ring.className = 'egg-burst-ring';
  const rs = 70;
  ring.style.left = `${x - rs / 2}px`;
  ring.style.top = `${y - rs / 2}px`;
  ring.style.width = ring.style.height = `${rs}px`;
  ring.style.borderColor = hex;
  ring.style.boxShadow = `0 0 24px ${hex}`;
  document.body.appendChild(ring);
  setTimeout(() => ring.remove(), 480);
  for (let i = 0; i < 10; i++) {
    const d = document.createElement('div');
    d.className = 'egg-burst-dot';
    d.style.left = `${x - 4}px`;
    d.style.top = `${y - 4}px`;
    d.style.background = hex;
    const a = Math.random() * Math.PI * 2;
    const dist = 44 + Math.random() * 76;
    d.style.setProperty('--dx', `${Math.cos(a) * dist}px`);
    d.style.setProperty('--dy', `${Math.sin(a) * dist}px`);
    document.body.appendChild(d);
    setTimeout(() => d.remove(), 620);
  }
}
// 浮动得分数字:在结算点往上飘一小段然后淡掉("+4 ×2"/"-15")。
function scorePop(x, y, text, negative) {
  const el = document.createElement('div');
  el.className = 'egg-score-pop' + (negative ? ' negative' : '');
  el.textContent = text;
  el.style.left = `${Math.max(20, Math.min(G.W - 20, x))}px`;
  el.style.top = `${Math.max(20, y)}px`;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 750);
}
// 撞错颜色:整窗红色暗角闪一下 + 比分抖动(复用 lifeLostUntil 机制)。
function hurtFlash() {
  if (G.hurtEl) {
    G.hurtEl.classList.remove('show');
    void G.hurtEl.offsetWidth;
    G.hurtEl.classList.add('show');
    clearTimeout(G.hurtEl._hideTimer);
    G.hurtEl._hideTimer = setTimeout(() => { if (G.hurtEl) G.hurtEl.classList.remove('show'); }, 280);
  }
  G.lifeLostUntil = performance.now() + 350;
}
function matchOrbs(a, b) {
  // 同色消除:发光 → 缩小淡出
  a.dead = true; b.dead = true;
  sfx.match();
  const animateOut = (o) => {
    o.el.style.transition = 'transform 0.3s ease-in, opacity 0.3s ease-out';
    o.el.style.opacity = '0';
    o.el.style.transform = `translate(${o.x - o.r}px, ${o.y - o.r}px) scale(0.2)`;
    o.el.style.boxShadow = `0 0 ${o.r}px ${ORB_COLORS.find(c => c.id === o.color)?.hex || '#fff'}`;
    setTimeout(() => o.el.remove(), 320);
  };
  animateOut(a); animateOut(b);
  G.score += 2;
}
function clearOrbs() { for (const o of G.orbs) o.el.remove(); G.orbs = []; }

// ── 球雨消除(第二关):从顶部生成下落球 ──────────────────────────
function spawnRainOrb() {
  const color = ORB_COLORS[(Math.random() * ORB_COLORS.length) | 0];
  const size = orbSize();
  const r = size / 2;

  const el = document.createElement('div');
  el.className = 'egg-orb';
  el.style.width = el.style.height = `${size}px`;
  el.style.boxShadow = `
    inset 0 0 ${size * 0.15}px rgba(0,0,0,0.9),
    inset 0 0 ${size * 0.04}px rgba(255,255,255,0.2),
    inset 0 -${size * 0.08}px ${size * 0.16}px rgba(255,255,255,0.12),
    0 ${size * 0.08}px ${size * 0.16}px rgba(0,0,0,0.6),
    0 0 ${size * 0.2}px ${color.hex}44`;
  const img = document.createElement('img');
  img.src = '/liquid-poster.png';
  img.style.cssText = `
    position: absolute; left: 50%; top: 50%;
    width: 145%; height: 145%;
    transform: translate(-50%, -50%);
    object-fit: cover; mix-blend-mode: screen;
    filter: hue-rotate(${color.hue}) saturate(${color.sat}) brightness(${color.bri});
  `;
  el.appendChild(img);
  const spec = document.createElement('div');
  spec.className = 'egg-orb-specular';
  el.appendChild(spec);
  document.body.appendChild(el);

  const x = r + Math.random() * (G.W - 2 * r);
  const orb = {
    el, r, x, y: -r * 2, color: color.id,
    vx: (Math.random() - 0.5) * 40,
    vy: G.fallV * (0.85 + Math.random() * 0.3),
    rot: 0, dead: false,
    falling: true,   // 还在下落中,未被玩家击中
  };
  el.style.transform = `translate(${x - r}px, ${orb.y - r}px)`;
  G.orbs.push(orb);
}

// ── 极速车道(第三关):3 条车道,球从车道顶端飞近,越近越大 ─────────
function laneX(i) { return G.W * (i + 0.5) / PHYS.RACE_LANES; }

// avoidLane:双道齐发时避开第一颗的车道,保证两颗不叠在同一条道上。
function spawnRaceOrb(avoidLane = -1) {
  const color = ORB_COLORS[(Math.random() * ORB_COLORS.length) | 0];
  let lane = (Math.random() * PHYS.RACE_LANES) | 0;
  if (lane === avoidLane) lane = (lane + 1 + ((Math.random() * (PHYS.RACE_LANES - 1)) | 0)) % PHYS.RACE_LANES;

  const el = document.createElement('div');
  el.className = 'egg-orb egg-race-orb';
  const img = document.createElement('img');
  img.src = '/liquid-poster.png';
  img.style.cssText = `
    position: absolute; left: 50%; top: 50%;
    width: 145%; height: 145%;
    transform: translate(-50%, -50%);
    object-fit: cover; mix-blend-mode: screen;
    filter: hue-rotate(${color.hue}) saturate(${color.sat}) brightness(${color.bri});
  `;
  el.appendChild(img);
  const spec = document.createElement('div');
  spec.className = 'egg-orb-specular';
  el.appendChild(spec);
  document.body.appendChild(el);

  const orb = {
    el, lane, x: laneX(lane), y: -40, color: color.id,
    dead: false, driftTo: null, driftAtY: 0,
  };
  // 漂移球(HELL MODE 起):飞到半路突然滑向相邻车道——你以为躲开了/接到了,
  // 它变道了。这是后期不确定性的主要来源。
  if (G.racePhase >= 1 && Math.random() < 0.3) {
    const candidates = [lane - 1, lane + 1].filter(l => l >= 0 && l < PHYS.RACE_LANES);
    orb.driftTo = candidates[(Math.random() * candidates.length) | 0];
    orb.driftAtY = G.H * (0.25 + Math.random() * 0.35);
  }
  applyRaceOrb(orb);
  G.orbs.push(orb);
  return orb;
}
// 车道球按 y 到判定线的进度线性放大(远小近大,营造迎面而来的纵深感)。
function applyRaceOrb(o) {
  const t = Math.max(0, Math.min(1, o.y / G.raceHitY));
  const size = 34 + t * 96;   // 34px(刚出现,远)→ 130px(到判定线,近)
  o.r = size / 2;
  o.el.style.width = o.el.style.height = `${size}px`;
  o.el.style.opacity = String(0.35 + t * 0.65);
  const glowHex = (ORB_COLORS.find(c => c.id === o.color) || ORB_COLORS[0]).hex;
  o.el.style.boxShadow = `
    inset 0 0 ${size * 0.15}px rgba(0,0,0,0.9),
    inset 0 0 ${size * 0.04}px rgba(255,255,255,0.2),
    inset 0 -${size * 0.08}px ${size * 0.16}px rgba(255,255,255,0.12),
    0 ${size * 0.08}px ${size * 0.16}px rgba(0,0,0,0.6),
    0 0 ${size * 0.25}px ${glowHex}66`;
  o.el.style.transform = `translate(${o.x - o.r}px, ${o.y - o.r}px)`;
}
// 换道时车道分隔线/判定线元素(懒创建,exitGame 时清掉)
function ensureRaceUI() {
  if (!G.laneEls) {
    G.laneEls = [];
    for (let i = 1; i < PHYS.RACE_LANES; i++) {
      const el = document.createElement('div');
      el.className = 'egg-lane-line';
      document.body.appendChild(el);
      G.laneEls.push(el);
    }
  }
  if (!G.hitLineEl) {
    G.hitLineEl = document.createElement('div');
    G.hitLineEl.className = 'egg-hit-line';
    document.body.appendChild(G.hitLineEl);
  }
  if (!G.raceBannerEl) {
    G.raceBannerEl = document.createElement('div');
    G.raceBannerEl.id = 'egg-race-banner';
    document.body.appendChild(G.raceBannerEl);
  }
  if (!G.hurtEl) {
    G.hurtEl = document.createElement('div');
    G.hurtEl.id = 'egg-hurt';
    document.body.appendChild(G.hurtEl);
  }
}
function removeRaceUI() {
  if (G.laneEls) { G.laneEls.forEach(el => el.remove()); G.laneEls = null; }
  if (G.hitLineEl) { G.hitLineEl.remove(); G.hitLineEl = null; }
  if (G.raceBannerEl) { G.raceBannerEl.remove(); G.raceBannerEl = null; }
  if (G.hurtEl) { G.hurtEl.remove(); G.hurtEl = null; }
}
function showRaceBanner(text, ms = 1400) {
  if (!G.raceBannerEl) return;
  G.raceBannerEl.textContent = text;
  G.raceBannerEl.classList.remove('show');
  void G.raceBannerEl.offsetWidth;
  G.raceBannerEl.classList.add('show');
  clearTimeout(G.raceBannerEl._hideTimer);
  G.raceBannerEl._hideTimer = setTimeout(() => {
    if (G.raceBannerEl) G.raceBannerEl.classList.remove('show');
  }, ms);
}
// 车道线 + 判定线跟着顶/底栏边界走(和 #egg-dim 同一套逻辑),分隔线的
// background-position 按当前速度滚动,制造"向你冲来"的动感。
function renderRaceUI(dt) {
  if (!G.laneEls) return;
  const top = G.chromeTop || 0, bottom = G.chromeBottom || G.H;
  G.raceScrollY = (G.raceScrollY || 0) + G.raceV * dt;
  G.laneEls.forEach((el, i) => {
    // i 是数组下标(0、1…),第 i 条分隔线该在的位置是车道边界 (i+1)/N,
    // 不是某条车道的中心,所以不能用 laneX()。
    el.style.left = `${G.W * (i + 1) / PHYS.RACE_LANES}px`;
    el.style.top = `${top}px`;
    el.style.height = `${Math.max(0, bottom - top)}px`;
    el.style.backgroundPositionY = `${G.raceScrollY}px`;
  });
  if (G.hitLineEl) {
    G.hitLineEl.style.left = '0px';
    G.hitLineEl.style.width = `${G.W}px`;
    G.hitLineEl.style.top = `${G.raceHitY}px`;
  }
}

// ── 消除球之间以及与玩家球的碰撞 ─────────────────────────────────────
function collideOrbs(a, b) {
  // 同 collide() 但适用于 orb 对象(没有 orb.orb 属性)
  const dx = b.x - a.x, dy = b.y - a.y;
  const dist = Math.hypot(dx, dy), minD = a.r + b.r;
  if (dist === 0 || dist >= minD) return false;
  const nx = dx / dist, ny = dy / dist;
  const ma = a.r * a.r, mb = b.r * b.r;
  const overlap = minD - dist;
  a.x -= nx * overlap * (mb / (ma + mb)); a.y -= ny * overlap * (mb / (ma + mb));
  b.x += nx * overlap * (ma / (ma + mb)); b.y += ny * overlap * (ma / (ma + mb));
  const dvx = a.vx - b.vx, dvy = a.vy - b.vy;
  const dvn = dvx * nx + dvy * ny;
  if (dvn <= 0) return false;
  const j = dvn * 2 * ma * mb / (ma + mb) * PHYS.BALL_REST;
  a.vx -= (j / ma) * nx; a.vy -= (j / ma) * ny;
  b.vx += (j / mb) * nx; b.vy += (j / mb) * ny;
  return true;
}
function bounceWallsOrb(o) {
  if (o.x - o.r < 0) { o.x = o.r; o.vx = Math.abs(o.vx) * PHYS.WALL_REST; }
  if (o.x + o.r > G.W) { o.x = G.W - o.r; o.vx = -Math.abs(o.vx) * PHYS.WALL_REST; }
  if (o.y - o.r < 0) { o.y = o.r; o.vy = Math.abs(o.vy) * PHYS.WALL_REST; }
  if (o.y + o.r > G.H) { o.y = G.H - o.r; o.vy = -Math.abs(o.vy) * PHYS.WALL_REST; }
}

// ── 渲染(canvas 只负责得分;暗背景交给下面的毛玻璃 DOM 层) ─────────
function render() {
  const c = G.ctx; if (!c) return;
  c.clearRect(0, 0, G.W, G.H);
  // canvas 画的纯色矩形做不出 backdrop-filter 模糊效果(那只对 DOM 元素生效),
  // 之前渐变到 1 还是全不透明黑,和主界面的半透明毛玻璃观感不统一。改成驱动
  // 一个真实 DOM 层(#egg-dim,与 .pulse-desktop-environment 同款颜色/模糊参数)。
  if (G.dimEl) {
    const top = G.chromeTop || 0, bottom = G.chromeBottom || G.H;
    G.dimEl.style.top = `${top}px`;
    G.dimEl.style.height = `${Math.max(0, bottom - top)}px`;
    G.dimEl.style.opacity = String(G.bgAlpha);
  }

  // 得分: 写入 DOM，以获得更好的设计感和半透明背景下的可见度
  const inGamePhase = G.stateName === 'match' || G.stateName === 'rainmatch' || G.stateName === 'race' || G.stateName === 'over';
  if (G.score !== 0 || inGamePhase) {
    if (G.scoreEl) {
      // 第三关在分数旁边显示 combo 倍率(连续撞对颜色才会 >1x)
      G.scoreEl.textContent = G.stateName === 'race' && G.raceCombo > 1
        ? `${G.score} ${G.raceCombo}x`
        : String(G.score);
      G.scoreEl.style.display = 'flex';
      const baseClass = inGamePhase ? 'egg-score-center' : 'egg-score-corner';
      const negativeClass = G.score < 0 ? ' negative' : '';
      const lifeLostClass = performance.now() < G.lifeLostUntil ? ' egg-life-lost' : '';
      G.scoreEl.className = baseClass + negativeClass + lifeLostClass;
    }
  } else {
    if (G.scoreEl) G.scoreEl.style.display = 'none';
  }

  // 真实球体们:写 DOM transform(拖拽中的绷劲偏移只作用于玩家球)
  for (const b of G.balls) {
    let ox = 0, oy = 0;
    if (b.isPlayer && G.drag && G.drag.inGame) {
      const o = dragOffset(G.drag.cx - G.drag.sx, G.drag.cy - G.drag.sy);
      ox = o.ox; oy = o.oy;
    }
    applyBall(b, ox, oy);
  }
  // 消除球
  for (const o of G.orbs) {
    if (!o.dead) applyOrb(o);
  }
}

// ── 状态实现 ────────────────────────────────────────────────────────

// 竞技场:UI 可见,撞飞界面里另外两颗真实水晶球
register('arena', {
  enter() { this.idle = 0; this.grew = 0; },
  update(dt) {
    steer(dt);
    for (const b of G.balls) { stepBall(b, dt); if (bounceWalls(b)) sfx.bounce(Math.hypot(b.vx, b.vy) / 900); }
    // 撞静态球(界面里的)→ 撞飞它:变成物理球,+1
    const p = player();
    for (let i = G.statics.length - 1; i >= 0; i--) {
      const s = G.statics[i];
      for (const b of G.balls) {
        const d = Math.hypot(b.x - s.x, b.y - s.y);
        if (d < b.r + s.r) {
          const nb = detachOrb(s.el, false);
          // 继承撞击方向的动量
          const nx = (nb.x - b.x) / (d || 1), ny = (nb.y - b.y) / (d || 1);
          const sp = Math.hypot(b.vx, b.vy);
          nb.vx = nx * sp * 0.8; nb.vy = ny * sp * 0.8;
          b.vx *= 0.5; b.vy *= 0.5;
          G.statics.splice(i, 1);
          G.score += 1; sfx.big();
          break;
        }
      }
    }
    // 球球互撞
    for (let i = 0; i < G.balls.length; i++)
      for (let j = i + 1; j < G.balls.length; j++)
        if (collide(G.balls[i], G.balls[j])) {
          sfx.clink(0.5);
        }

    // 两颗都撞飞了 → 稍作停顿 → 窗口生长
    if (G.statics.length === 0) {
      this.grew += dt;
      if (this.grew > PHYS.GROW_DELAY) switchState('grow');
      return;
    }
    // 一颗都没撞到、球停了、也没在拖 → 静默归位(玩家只是好奇拽了一下)
    if (G.balls.length === 1 && !G.drag && Math.hypot(p.vx, p.vy) < PHYS.STOP_SPEED) {
      this.idle += dt;
      if (this.idle > PHYS.IDLE_RETURN) exitGame();
    } else this.idle = 0;
  },
});

// 折叠:UI 淡出
register('grow', {
  enter() {
    this.done = false;
    document.body.classList.add('egg-mode');
    sfx.grow();
    this.done = true;
  },
  update(dt) {
    G.bgAlpha = Math.min(1, G.bgAlpha + dt * 1.6);
    steer(dt);
    for (const b of G.balls) { stepBall(b, dt); bounceWalls(b); }
    for (let i = 0; i < G.balls.length; i++)
      for (let j = i + 1; j < G.balls.length; j++) collide(G.balls[i], G.balls[j]);
    if (this.done && G.bgAlpha >= 1) switchState('match');
  },
});

// 消除:全尺寸水晶球同色碰撞消除
register('match', {
  enter() {
    G.matchT = 0; G.spawnIn = 1.0;
    // 被撞飞的两颗真实球淡出、悄悄归位(只留玩家球)
    for (const b of [...G.balls]) {
      if (!b.isPlayer) {
        b.orb.el.style.transition = 'opacity .5s ease';
        b.orb.el.style.opacity = '0';
        setTimeout(() => restoreOrb(b), 550);
        G.balls.splice(G.balls.indexOf(b), 1);
      }
    }
  },
  update(dt) {
    G.matchT += dt;

    // 定时生成新球
    const spawnEvery = PHYS.SPAWN_MIN +
      (PHYS.SPAWN_INTERVAL_0 - PHYS.SPAWN_MIN) * Math.exp(-G.matchT / PHYS.SPAWN_RAMP);
    G.spawnIn -= dt;
    if (G.spawnIn <= 0) {
      const aliveOrbs = G.orbs.filter(o => !o.dead).length;
      if (aliveOrbs < PHYS.MAX_ORBS) {
        spawnOrb();
      }
      G.spawnIn = spawnEvery;
    }

    // 玩家球物理
    steer(dt);
    const p = player();
    stepBall(p, dt); bounceWalls(p);

    // 消除球物理
    for (const o of G.orbs) {
      if (o.dead) continue;
      // 运动 + 阻力
      o.x += o.vx * dt; o.y += o.vy * dt;
      const f = Math.exp(-PHYS.ORB_DRAG * dt);
      o.vx *= f; o.vy *= f;
      o.rot += ((o.vx * PHYS.ROLL + o.vy * PHYS.ROLL * 0.35) / o.r) * dt;
      bounceWallsOrb(o);
    }

    // 玩家球 vs 消除球碰撞(物理弹开)
    for (const o of G.orbs) {
      if (o.dead) continue;
      const dx = o.x - p.x, dy = o.y - p.y;
      const dist = Math.hypot(dx, dy), minD = p.r + o.r;
      if (dist > 0 && dist < minD) {
        // 手动碰撞(玩家球用 ball 数据结构,消除球用 orb 数据结构)
        const nx = dx / dist, ny = dy / dist;
        const ma = p.r * p.r, mb = o.r * o.r;
        const overlap = minD - dist;
        p.x -= nx * overlap * (mb / (ma + mb)); p.y -= ny * overlap * (mb / (ma + mb));
        o.x += nx * overlap * (ma / (ma + mb)); o.y += ny * overlap * (ma / (ma + mb));
        const dvx = p.vx - o.vx, dvy = p.vy - o.vy;
        const dvn = dvx * nx + dvy * ny;
        if (dvn > 0) {
          const j = dvn * 2 * ma * mb / (ma + mb) * PHYS.BALL_REST;
          p.vx -= (j / ma) * nx; p.vy -= (j / ma) * ny;
          o.vx += (j / mb) * nx; o.vy += (j / mb) * ny;
          sfx.clink(Math.min(1, Math.hypot(p.vx, p.vy) / 700 + 0.3));
        }
      }
    }

    // 消除球之间的碰撞:同色消除,异色弹开
    const alive = G.orbs.filter(o => !o.dead);
    for (let i = 0; i < alive.length; i++) {
      for (let j = i + 1; j < alive.length; j++) {
        const a = alive[i], b = alive[j];
        const dx = b.x - a.x, dy = b.y - a.y;
        const dist = Math.hypot(dx, dy), minD = a.r + b.r;
        if (dist > 0 && dist < minD) {
          if (a.color === b.color) {
            // 同色:消除!
            matchOrbs(a, b);
          } else {
            // 异色:物理弹开
            collideOrbs(a, b);
            sfx.bounce(Math.hypot(a.vx, a.vy) / 500);
          }
        }
      }
    }

    // 清理已消除的球
    G.orbs = G.orbs.filter(o => !o.dead);

    // 升级:分数达到阈值 → 进入第二关
    if (G.score >= PHYS.LEVEL2_SCORE) {
      switchState('rainmatch');
      return;
    }

    // 失败条件:场上球 ≥ MAX_ORBS
    if (G.orbs.length >= PHYS.MAX_ORBS) {
      switchState('over');
    }
  },
});

// 第二关:球雨消除 — 球从上方掉落,击中后在框内弹,同色碰撞消除,漏掉扣分
register('rainmatch', {
  enter() {
    G.rainT = 0; G.spawnIn = 0.8;
    G.fallV = PHYS.RAIN_V0;
    G.holdActive = false;
    // 清掉第一关残留的消除球
    clearOrbs();
    sfx.grow();   // 升级音效
  },
  update(dt) {
    G.rainT += dt;
    G.matchT += dt;  // 继续用于 orbSize 缩小
    G.fallV += PHYS.RAIN_ACCEL * dt;  // 越掉越快

    // 定时生成球雨
    const spawnEvery = PHYS.RAIN_SPAWN_MIN +
      (PHYS.RAIN_SPAWN0 - PHYS.RAIN_SPAWN_MIN) * Math.exp(-G.rainT / PHYS.RAIN_RAMP);
    G.spawnIn -= dt;
    if (G.spawnIn <= 0) { spawnRainOrb(); G.spawnIn = spawnEvery; }

    // 玩家球物理:按住时直接吸附到鼠标位置(像空气曲棍球球拍),速度由
    // 帧间位移实时算出,拖得越快/角度越斜,撞到球时飞出去的力度/方向就
    // 相应越大/越偏(下面撞击段用的是同一套弹性碰撞公式,天然物理正确)。
    // 松手后交还给普通自由物理(保留最后拖动速度,受空气阻力/撞墙影响)。
    const p = player();
    if (G.holdActive) {
      const safeDt = Math.max(dt, 1 / 240);   // 防止极小 dt 除出离谱速度
      // 把目标位置钳在球心的合法范围内 —— 否则鼠标拖出窗口外时,球每帧被
      // 设到界外、又被墙体逻辑弹回墙边,来回抽动算出离谱的瞬时速度,表现
      // 为球疯狂自旋、撞击球被弹飞得极快。钳住后,球贴着墙"顶住"鼠标,
      // 不会再有这种失控速度;此时位置已在界内,不需要额外调用 bounceWalls。
      const tx = Math.max(p.r, Math.min(G.W - p.r, G.holdTargetX));
      const ty = Math.max(p.r, Math.min(G.H - p.r, G.holdTargetY));
      let vx = (tx - p.x) / safeDt, vy = (ty - p.y) / safeDt;
      const sp = Math.hypot(vx, vy), cap = PHYS.MAX_LAUNCH * 1.2;
      if (sp > cap) { vx *= cap / sp; vy *= cap / sp; }
      p.vx = vx; p.vy = vy;
      p.x = tx; p.y = ty;
      p.rot += ((p.vx * PHYS.ROLL + p.vy * PHYS.ROLL * 0.35) / p.r) * dt;
    } else {
      steer(dt);
      stepBall(p, dt); bounceWalls(p);
    }

    // 消除球物理
    for (const o of G.orbs) {
      if (o.dead) continue;
      o.x += o.vx * dt; o.y += o.vy * dt;
      o.rot += ((o.vx * PHYS.ROLL + o.vy * PHYS.ROLL * 0.35) / o.r) * dt;
      // 左右顶墙反弹(不管 falling 还是 active)
      if (o.x - o.r < 0) { o.x = o.r; o.vx = Math.abs(o.vx) * PHYS.WALL_REST; }
      if (o.x + o.r > G.W) { o.x = G.W - o.r; o.vx = -Math.abs(o.vx) * PHYS.WALL_REST; }
      if (o.y - o.r < 0) { o.y = o.r; o.vy = Math.abs(o.vy) * PHYS.WALL_REST; }
      // 激活球额外加阻力
      if (!o.falling) {
        const f = Math.exp(-PHYS.ORB_DRAG * dt);
        o.vx *= f; o.vy *= f;
      }
      // 底边:任何球碰到就出去,扣 1 分
      if (o.y - o.r > G.H) {
        missFlash(o.x, G.H);
        removeOrb(o);
        G.score -= 1; sfx.miss();
        if (G.score <= 0) { switchState('over'); return; }
      }
    }

    // 玩家球 vs 消除球碰撞
    for (const o of G.orbs) {
      if (o.dead) continue;
      const dx = o.x - p.x, dy = o.y - p.y;
      const dist = Math.hypot(dx, dy), minD = p.r + o.r;
      if (dist > 0 && dist < minD) {
        const nx = dx / dist, ny = dy / dist;
        const ma = p.r * p.r, mb = o.r * o.r;
        const overlap = minD - dist;
        p.x -= nx * overlap * (mb / (ma + mb)); p.y -= ny * overlap * (mb / (ma + mb));
        o.x += nx * overlap * (ma / (ma + mb)); o.y += ny * overlap * (ma / (ma + mb));
        const dvx = p.vx - o.vx, dvy = p.vy - o.vy;
        const dvn = dvx * nx + dvy * ny;
        if (dvn > 0) {
          const j = dvn * 2 * ma * mb / (ma + mb) * PHYS.BALL_REST;
          p.vx -= (j / ma) * nx; p.vy -= (j / ma) * ny;
          o.vx += (j / mb) * nx; o.vy += (j / mb) * ny;
          sfx.clink(Math.min(1, Math.hypot(p.vx, p.vy) / 700 + 0.3));
        }
        // 被玩家击中 → 激活
        if (o.falling) o.falling = false;
      }
    }

    // 消除球之间的碰撞:同色消除,异色弹开
    const alive = G.orbs.filter(o => !o.dead);
    for (let i = 0; i < alive.length; i++) {
      for (let j = i + 1; j < alive.length; j++) {
        const a = alive[i], b = alive[j];
        const dx = b.x - a.x, dy = b.y - a.y;
        const dist = Math.hypot(dx, dy), minD = a.r + b.r;
        if (dist > 0 && dist < minD) {
          if (a.color === b.color) {
            matchOrbs(a, b);
          } else {
            collideOrbs(a, b);
            sfx.bounce(Math.hypot(a.vx, a.vy) / 500);
            // 碰撞后双方都变为激活态
            if (a.falling) a.falling = false;
            if (b.falling) b.falling = false;
          }
        }
      }
    }

    // 清理
    G.orbs = G.orbs.filter(o => !o.dead);

    // 分数到阈值 → 进第三关(极速车道)
    if (G.score >= PHYS.LEVEL3_SCORE) {
      switchState('race');
      return;
    }
  },
});

// 第三关:极速车道 — 3 条车道,水晶球迎面而来越来越大,左右换道。
// 规则(全部围绕"接触那一刹那"结算,圆碰圆立即爆裂,不等重合):
//  · 接住同色 → +基础分×combo(连续接对 combo 涨到 5x,爆彩色粒子)
//  · 撞上异色 → -15、清 combo、红屏震动(一次失误抹掉几次成果)
//  · 该接的同色溜过去没接到 → -3、清 combo(不能光躲,得追)
//  · 异色从别的车道溜走 → 无事,这才是成功的躲避
//  · 只加速不减速;20s HELL MODE(双发变多+漂移球),40s MAX GEAR(双发成常态)
//  · 分数掉到 0 结束;到 300 赢
register('race', {
  enter() {
    G.raceT = 0; G.spawnIn = 0;
    G.raceV = PHYS.RACE_V0;
    G.raceLane = 1;
    G.raceCombo = 0;
    G.racePhase = 0;
    G.raceIntroT = 0; G.raceCount = -1;
    G.raceScrollY = 0;
    G.holdActive = false;
    clearOrbs();
    ensureRaceUI();
    sfx.level3();
    // 拉高窗口给赛道留纵深——玩家可能之前手动拉过窗口,这里不管多大都
    // 统一定到赛道要的高度,退出游戏时 exitGame() 会照旧把窗口复位。
    if (winApi) {
      try { winApi.getCurrentWindow().setSize(new winApi.LogicalSize(DEFAULT_WIN_W, PHYS.RACE_WIN_H)); } catch (e) {}
    }
    const p = player();
    if (p) {
      p.x = laneX(1); p.y = G.H * PHYS.RACE_HIT_Y_FRAC; p.vx = 0; p.vy = 0;
    }
  },
  exit() {
    removeRaceUI();
  },
  update(dt) {
    // 每帧按当前 G.H 重算玩家行——进关瞬间窗口才刚开始拉高,resize 事件
    // 生效前 G.H 还是旧高度,不能只在 enter() 里算一次。
    G.raceHitY = G.H * PHYS.RACE_HIT_Y_FRAC;

    const p = player();
    if (p) {
      const targetX = laneX(G.raceLane);
      p.x += (targetX - p.x) * Math.min(1, dt * PHYS.RACE_LANE_SLIDE);
      p.y = G.raceHitY;
      p.rot += dt * (2.2 + G.raceV / 240);   // 越快滚得越快,车轮飞转的前冲感
      applyBall(p);
    }
    renderRaceUI(dt);

    // 开场 3-2-1-GO 倒计时(先给一屏操作提示),读秒期间可以先练换道
    G.raceIntroT += dt;
    if (G.raceIntroT < 3.1) {
      const stage = Math.min(4, Math.floor(G.raceIntroT / 0.62));
      if (stage !== G.raceCount) {
        G.raceCount = stage;
        const texts = ['← / → SWITCH LANES', '3', '2', '1', 'GO!'];
        showRaceBanner(texts[stage], 620);
        if (stage >= 1 && stage <= 3) sfx.count();
        if (stage === 4) sfx.go();
      }
      return;
    }

    G.raceT += dt;
    G.raceV += PHYS.RACE_ACCEL * dt;   // 只加速不减速,这就是"地狱"的核心
    if (G.racePhase === 0 && G.raceT > PHYS.RACE_HELL_AT) {
      G.racePhase = 1;
      showRaceBanner('HELL MODE');
      sfx.hell();
    }
    if (G.racePhase === 1 && G.raceT > PHYS.RACE_MAX_AT) {
      G.racePhase = 2;
      showRaceBanner('MAX GEAR');
      sfx.hell();
    }

    const spawnEvery = PHYS.RACE_SPAWN_MIN +
      (PHYS.RACE_SPAWN0 - PHYS.RACE_SPAWN_MIN) * Math.exp(-G.raceT / PHYS.RACE_RAMP);
    G.spawnIn -= dt;
    if (G.spawnIn <= 0) {
      const first = spawnRaceOrb();
      // 双道齐发:阶段越深概率越高,两颗永远不同车道,逼你瞬间二选一
      const doubleP = G.racePhase === 2 ? 0.7 : G.racePhase === 1 ? 0.5 : 0.15;
      if (Math.random() < doubleP) spawnRaceOrb(first.lane);
      G.spawnIn = spawnEvery;
    }

    for (const o of G.orbs) {
      if (o.dead) continue;
      o.y += G.raceV * dt;
      // 漂移球:飞到设定高度后平滑滑向相邻车道
      if (o.driftTo != null && o.y > o.driftAtY) {
        const tx = laneX(o.driftTo);
        o.x += (tx - o.x) * Math.min(1, dt * 6);
        if (Math.abs(tx - o.x) < 1) { o.x = tx; o.lane = o.driftTo; o.driftTo = null; }
      }
      applyRaceOrb(o);

      // 接触判定:圆碰圆的那一刹那立即爆裂结算,不等重合
      const dx = o.x - p.x, dy = o.y - p.y;
      if (Math.hypot(dx, dy) <= p.r + o.r) {
        o.dead = true;
        const hex = (ORB_COLORS.find(c => c.id === o.color) || ORB_COLORS[0]).hex;
        if (o.color === p.color) {
          G.raceCombo = Math.min(PHYS.RACE_COMBO_MAX, G.raceCombo + 1);
          const pts = PHYS.RACE_HIT_SCORE * G.raceCombo;
          G.score += pts;
          burstFX(o.x, o.y, hex);
          scorePop(o.x, o.y - o.r, G.raceCombo > 1 ? `+${pts} ×${G.raceCombo}` : `+${pts}`, false);
          sfx.match();
        } else {
          G.raceCombo = 0;
          G.score -= PHYS.RACE_WRONG_PENALTY;
          burstFX(o.x, o.y, '#ff5a5a');
          scorePop(o.x, o.y - o.r, `-${PHYS.RACE_WRONG_PENALTY}`, true);
          hurtFlash();
          sfx.crash();
          if (G.score <= 0) { o.el.remove(); switchState('over'); return; }
        }
        o.el.remove();
        continue;
      }

      // 溜出底边:同色是"该接没接到",要罚;异色安全溜走 = 成功躲避
      if (o.y - o.r > G.H + 10) {
        o.dead = true; o.el.remove();
        if (o.color === p.color) {
          G.raceCombo = 0;
          G.score -= PHYS.RACE_PASS_PENALTY;
          missFlash(o.x, G.H);
          scorePop(o.x, G.H - 46, `-${PHYS.RACE_PASS_PENALTY}`, true);
          sfx.miss();
          if (G.score <= 0) { switchState('over'); return; }
        }
      }
    }
    G.orbs = G.orbs.filter(o => !o.dead);

    // 赢了:分数到阈值,搞笑收场(不是失败,是"我服了你了")
    if (G.score >= PHYS.WIN_SCORE) {
      switchState('win');
      return;
    }
  },
});

// 赢了:分数到 WIN_SCORE,一句搞笑的话,短暂展示后收场。
const WIN_LINES = [
  "Alright, alright — you win. Go do something productive now.",
  "OK champion, put the mouse down and go touch grass.",
  "300 points. Impressive. Deeply unnecessary. Go be useful now.",
];
register('win', {
  enter() {
    this.t = 0;
    sfx.win();
    clearOrbs();
    let msg = document.getElementById('egg-win-msg');
    if (!msg) {
      msg = document.createElement('div');
      msg.id = 'egg-win-msg';
      document.body.appendChild(msg);
    }
    msg.textContent = WIN_LINES[(Math.random() * WIN_LINES.length) | 0];
    G.winMsgEl = msg;
    requestAnimationFrame(() => msg.classList.add('show'));
  },
  update(dt) {
    this.t += dt;
    const p = player();
    if (p) { stepBall(p, dt, 1.5); bounceWalls(p); }
    if (this.t > 2.6 && G.winMsgEl) G.winMsgEl.classList.remove('show');
    if (this.t > 3.2) exitGame();
  },
});

// 收场:一切安静下来,回到桌面
register('over', {
  enter() {
    this.t = 0;
    sfx.over();
    clearOrbs();
  },
  update(dt) {
    this.t += dt;
    G.bgAlpha = Math.max(0, G.bgAlpha - dt * 1.2);
    const p = player();
    if (p) { stepBall(p, dt, 1.5); bounceWalls(p); }
    if (this.t > 1.4) exitGame();
  },
});

// ── 进入/退出 ───────────────────────────────────────────────────────
function enterGame(el) {
  ensureCanvas();
  let dimEl = document.getElementById('egg-dim');
  if (!dimEl) {
    dimEl = document.createElement('div');
    dimEl.id = 'egg-dim';
    document.body.appendChild(dimEl);
  }
  G.dimEl = dimEl;
  dimEl.style.opacity = '0';

  let scoreEl = document.getElementById('egg-score');
  if (!scoreEl) {
    scoreEl = document.createElement('div');
    scoreEl.id = 'egg-score';
    document.body.appendChild(scoreEl);
  }
  G.scoreEl = scoreEl;
  G.scoreEl.style.display = 'none';

  let exitBtn = document.getElementById('egg-exit-btn');
  if (!exitBtn) {
    exitBtn = document.createElement('button');
    exitBtn.id = 'egg-exit-btn';
    exitBtn.innerHTML = `
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <line x1="19" y1="12" x2="5" y2="12"></line>
        <polyline points="12 19 5 12 12 5"></polyline>
      </svg>
      Back
    `;
    exitBtn.onclick = () => exitGame();
    document.body.appendChild(exitBtn);
  }
  G.exitBtn = exitBtn;

  document.body.classList.add('egg-playing');
  G.score = 0; G.bgAlpha = 0; G.balls = []; G.orbs = []; G.statics = [];
  detachOrb(el, true);
  // 收集界面里另外两颗真实球作为静态碰撞体
  document.querySelectorAll('.spheres-grid .orb-glass').forEach((other) => {
    if (other === el) return;
    const r = other.getBoundingClientRect();
    if (r.width === 0) return;
    G.statics.push({ el: other, x: r.left + r.width / 2, y: r.top + r.height / 2, r: r.width / 2 });
  });
  window.addEventListener('keydown', onKey);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('mousedown', onGameGrab);
  startLoop();
  switchState('arena');
}
function exitGame() {
  G.running = false;
  cancelAnimationFrame(G.raf);
  // 游戏过程中如果窗口被手动拉大过,退出时把窗口尺寸复原成默认值(只改
  // 尺寸,不改位置——用户可能特意把窗口挪到了别处)。
  if (winApi) {
    try {
      winApi.getCurrentWindow().setSize(new winApi.LogicalSize(DEFAULT_WIN_W, DEFAULT_WIN_H));
    } catch (e) {}
  }
  // 清掉 canvas 上的残留(bgAlpha 遮罩)
  if (G.ctx) G.ctx.clearRect(0, 0, G.W, G.H);
  // 彻底从 DOM 移除 canvas，防止 macOS 透明窗口合成异常
  if (G.canvas) { G.canvas.remove(); G.canvas = null; G.ctx = null; }
  // 移除毛玻璃暗层
  if (G.dimEl) { G.dimEl.remove(); G.dimEl = null; }
  // 移除"赢了"文案
  if (G.winMsgEl) { G.winMsgEl.remove(); G.winMsgEl = null; }
  // 移除比分 DOM
  if (G.scoreEl) { G.scoreEl.remove(); G.scoreEl = null; }
  // 移除退出按钮
  if (G.exitBtn) { G.exitBtn.remove(); G.exitBtn = null; }
  // 移除第三关的车道线/判定线/banner——exitGame 可能直接由 Esc 触发(比如
  // 正在 race 状态里按 Esc),不会经过 race 自己的 exit() 钩子,得在这里
  // 兜底清一次(removeRaceUI 本身是幂等的,重复调用无副作用)。
  removeRaceUI();
  // 注销 resize 监听
  if (G.resizeHandler) { window.removeEventListener('resize', G.resizeHandler); G.resizeHandler = null; }
  document.body.classList.remove('egg-mode', 'egg-playing');
  // 万一横扫拖拽期间还是残留了一段选区,退出时主动清空,绝不把
  // "文字全选中"的状态带回正常界面。
  try { window.getSelection().removeAllRanges(); } catch (e) {}
  G.bgAlpha = 0;
  for (const b of G.balls) restoreOrb(b);
  G.balls = [];
  clearOrbs();
  window.removeEventListener('keydown', onKey);
  window.removeEventListener('keyup', onKeyUp);
  window.removeEventListener('mousedown', onGameGrab);
  G.keys.clear(); G.drag = null; G.statics = []; G.holdActive = false;
  G.stateName = 'dormant'; G.state = null;
}
function onKey(e) {
  if (e.key === 'Escape') { exitGame(); return; }
  // 第三关:左右键离散换道(一按一格),不是连续按力——e.repeat 是系统按住
  // 自动重复触发的,直接忽略,不然按住不放会一路窜到底,失去"选道"的手感。
  if (G.stateName === 'race' && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
    e.preventDefault();
    if (e.repeat) return;
    const dir = e.key === 'ArrowLeft' ? -1 : 1;
    G.raceLane = Math.max(0, Math.min(PHYS.RACE_LANES - 1, G.raceLane + dir));
    return;
  }
  if (e.key.startsWith('Arrow')) { G.keys.add(e.key); e.preventDefault(); }
}
function onKeyUp(e) { G.keys.delete(e.key); }

// 游戏中再次抓球蓄力
function onGameGrab(e) {
  if (G.stateName === 'race') return;   // 第三关只用左右方向键换道,鼠标不管
  const p = player();
  if (!p || e.button !== 0) return;
  if (Math.hypot(e.clientX - p.x, e.clientY - p.y) > p.r + 24) return;
  e.preventDefault();   // 不阻止的话,横扫式拖拽会被浏览器当成"选中文字"

  // 第二关(球雨消除):按住直接拖着球走,不是拉弓蓄力松手弹射。
  // 拖动速度/角度由 update() 每帧从鼠标位移里算出来,
  // 天然决定撞到球时那颗球飞出去的力度和方向。
  if (G.stateName === 'rainmatch') {
    G.holdActive = true;
    G.holdTargetX = e.clientX; G.holdTargetY = e.clientY;
    const move = (ev) => {
      ev.preventDefault();
      G.holdTargetX = ev.clientX; G.holdTargetY = ev.clientY;
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      G.holdActive = false;   // 松手:球保留最后一帧的拖动速度,交还给自由物理
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return;
  }

  // 其他阶段(竞技场 / 第一关消除):拉弓蓄力,松手反向弹射。
  G.drag = { sx: e.clientX, sy: e.clientY, cx: e.clientX, cy: e.clientY, inGame: true };
  const move = (ev) => { ev.preventDefault(); G.drag.cx = ev.clientX; G.drag.cy = ev.clientY; };
  const up = (ev) => {
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', up);
    const dx = ev.clientX - G.drag.sx, dy = ev.clientY - G.drag.sy;
    G.drag = null;
    if (Math.hypot(dx, dy) > PHYS.DRAG_THRESHOLD) {
      const { vx, vy } = launchVelocity(dx, dy);
      p.vx = vx; p.vy = vy;
      sfx.bounce(0.5);
    }
  };
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
}

// ── 对外 API ────────────────────────────────────────────────────────
export function eggBeginDrag(e, el) {
  if (e.button !== 0 || !el || G.stateName !== 'dormant') return;
  e.preventDefault();   // 不阻止的话,横扫式拖拽会被浏览器当成"选中文字"
  audioCtx();
  const sx = e.clientX, sy = e.clientY;
  let dragging = false;
  const move = (ev) => {
    ev.preventDefault();
    const dx = ev.clientX - sx, dy = ev.clientY - sy;
    if (!dragging && Math.hypot(dx, dy) > PHYS.DRAG_THRESHOLD) dragging = true;
    if (dragging) {
      const { ox, oy } = dragOffset(dx, dy);
      el.style.transform = `translate(${ox}px, ${oy}px)`;
      el.style.transition = 'none';
    }
  };
  const up = (ev) => {
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', up);
    el.style.transform = ''; el.style.transition = '';
    if (!dragging) return;                    // 普通点击 → 弹出桌面小球
    G.suppressClick = true;
    enterGame(el);
    const { vx, vy } = launchVelocity(ev.clientX - sx, ev.clientY - sy);
    const p = player();
    p.vx = vx; p.vy = vy;
  };
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
}
export function eggConsumeClickSuppress() {
  const s = G.suppressClick; G.suppressClick = false; return s;
}
