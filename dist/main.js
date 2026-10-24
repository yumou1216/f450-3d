/* ============================================================
   F450 四旋翼 · 交互式 3D 拆解可视化
   纯代码建模（无外部模型） · Three.js r128
   部件数据来自真实组装记录（Pixhawk 6C mini / PM06 / 好盈30A /
   X2216 KV950 / R8EF / M8N / 3S 5200mAh）
   ============================================================ */
(function () {
'use strict';

var $ = function (id) { return document.getElementById(id); };
var loadingEl = $('loading');

if (!window.THREE) {
  loadingEl.querySelector('.txt').textContent = 'Three.js 加载失败，请检查 lib/three.min.js';
  return;
}

/* ---------------- 基础场景 ---------------- */
var canvas = $('scene');
var renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, alpha: true });
} catch (e) {
  loadingEl.querySelector('.txt').textContent = '当前浏览器不支持 WebGL';
  return;
}
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputEncoding = THREE.sRGBEncoding;

var scene = new THREE.Scene();
scene.fog = new THREE.Fog(0x070b16, 70, 165);

var camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 500);

/* 灯光 */
scene.add(new THREE.HemisphereLight(0x9db8dd, 0x10141f, 0.8));
var keyLight = new THREE.DirectionalLight(0xffffff, 0.95);
keyLight.position.set(26, 46, 20);
keyLight.castShadow = true;
keyLight.shadow.mapSize.set(2048, 2048);
keyLight.shadow.camera.left = -34; keyLight.shadow.camera.right = 34;
keyLight.shadow.camera.top = 34; keyLight.shadow.camera.bottom = -34;
keyLight.shadow.camera.near = 5; keyLight.shadow.camera.far = 130;
keyLight.shadow.bias = -0.0004;
keyLight.target.position.set(0, 9, 0);
scene.add(keyLight); scene.add(keyLight.target);
var rimLight = new THREE.PointLight(0x4dd8ff, 0.55, 130);
rimLight.position.set(-34, 16, -30);
scene.add(rimLight);
var warmLight = new THREE.PointLight(0xff9a50, 0.28, 110);
warmLight.position.set(26, 8, -34);
scene.add(warmLight);

/* 地面环境 */
var grid = new THREE.GridHelper(150, 50, 0x2c5f8a, 0x13223a);
grid.material.transparent = true;
grid.material.opacity = 0.42;
scene.add(grid);

(function glowDisc() {
  var c = document.createElement('canvas'); c.width = c.height = 256;
  var ctx = c.getContext('2d');
  var g = ctx.createRadialGradient(128, 128, 8, 128, 128, 126);
  g.addColorStop(0, 'rgba(77,216,255,0.36)');
  g.addColorStop(0.45, 'rgba(50,150,220,0.10)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, 256, 256);
  var tex = new THREE.CanvasTexture(c);
  var m = new THREE.Mesh(
    new THREE.PlaneGeometry(56, 56),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false })
  );
  m.rotation.x = -Math.PI / 2; m.position.y = 0.05;
  scene.add(m);
})();

var shadowPlane = new THREE.Mesh(
  new THREE.PlaneGeometry(240, 240),
  new THREE.ShadowMaterial({ opacity: 0.34 })
);
shadowPlane.rotation.x = -Math.PI / 2;
shadowPlane.position.y = 0.02;
shadowPlane.receiveShadow = true;
scene.add(shadowPlane);

/* 背景星点 */
(function stars() {
  var N = 240, pos = new Float32Array(N * 3);
  for (var i = 0; i < N; i++) {
    var r = 70 + Math.random() * 55;
    var th = Math.random() * Math.PI * 2;
    var ph = Math.acos(Math.random() * 0.85); // 偏上半球
    pos[i * 3] = r * Math.sin(ph) * Math.cos(th);
    pos[i * 3 + 1] = r * Math.cos(ph) + 4;
    pos[i * 3 + 2] = r * Math.sin(ph) * Math.sin(th);
  }
  var g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  var pts = new THREE.Points(g, new THREE.PointsMaterial({
    color: 0x7fc4e8, size: 0.55, transparent: true, opacity: 0.55, sizeAttenuation: true
  }));
  pts.name = 'stars';
  scene.add(pts);
})();

/* ---------------- 轨道控制器（自实现，含惯性阻尼/触控） ---------------- */
function OrbitRig(cam, dom) {
  var self = this;
  this.cam = cam;
  this.target = new THREE.Vector3(0, 8.5, 0);
  this.goalTarget = new THREE.Vector3(0, 8.5, 0);
  this.cur = { theta: 0.72, phi: 1.06, radius: 60 };
  this.goal = { theta: 0.72, phi: 1.06, radius: 38 };
  this.radiusMax = 96;

  var pointers = new Map();
  var lastPinch = 0, lastMid = null;
  var downPos = null, downTime = 0, moved = false;
  this.autoFrame = true; // 自动取景：爆炸程度越大，相机越远

  function clampGoal() {
    self.goal.phi = Math.max(0.14, Math.min(1.52, self.goal.phi));
    self.goal.radius = Math.max(13, Math.min(self.radiusMax || 96, self.goal.radius));
    self.goalTarget.y = Math.max(-2, Math.min(20, self.goalTarget.y));
    self.goalTarget.x = Math.max(-24, Math.min(24, self.goalTarget.x));
    self.goalTarget.z = Math.max(-24, Math.min(24, self.goalTarget.z));
  }

  dom.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  dom.addEventListener('pointerdown', function (e) {
    dom.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, button: e.button });
    downPos = { x: e.clientX, y: e.clientY };
    downTime = performance.now();
    moved = false;
    if (pointers.size === 2) {
      var ps = Array.from(pointers.values());
      lastPinch = Math.hypot(ps[0].x - ps[1].x, ps[0].y - ps[1].y);
      lastMid = { x: (ps[0].x + ps[1].x) / 2, y: (ps[0].y + ps[1].y) / 2 };
    }
    dom.classList.add('dragging');
    hideHints();
  });
  dom.addEventListener('pointermove', function (e) {
    if (!pointers.has(e.pointerId)) return;
    var prev = pointers.get(e.pointerId);
    var dx = e.clientX - prev.x, dy = e.clientY - prev.y;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, button: prev.button });

    if (downPos && Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y) > 6) moved = true;

    if (pointers.size === 1) {
      if (prev.button === 2 || e.shiftKey) pan(dx, dy);
      else {
        self.goal.theta -= dx * 0.0052;
        self.goal.phi -= dy * 0.0046;
        if (demo) exitDemo();
      }
    } else if (pointers.size === 2) {
      var ps = Array.from(pointers.values());
      var d = Math.hypot(ps[0].x - ps[1].x, ps[0].y - ps[1].y);
      var mid = { x: (ps[0].x + ps[1].x) / 2, y: (ps[0].y + ps[1].y) / 2 };
      if (lastPinch > 0) { self.goal.radius *= lastPinch / Math.max(20, d); self.autoFrame = false; }
      if (lastMid) pan(mid.x - lastMid.x, mid.y - lastMid.y);
      lastPinch = d; lastMid = mid;
    }
    clampGoal();
  });
  function endPointer(e) {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) { lastPinch = 0; lastMid = null; }
    if (pointers.size === 0) {
      dom.classList.remove('dragging');
      if (downPos && !moved && performance.now() - downTime < 450) {
        handleClick(e.clientX, e.clientY);
      }
      downPos = null;
    }
  }
  dom.addEventListener('pointerup', endPointer);
  dom.addEventListener('pointercancel', endPointer);
  dom.addEventListener('wheel', function (e) {
    e.preventDefault();
    self.goal.radius *= 1 + e.deltaY * 0.0011;
    self.autoFrame = false;
    clampGoal();
  }, { passive: false });

  function pan(dx, dy) {
    var s = self.cur.radius * 0.0011;
    var right = new THREE.Vector3().setFromMatrixColumn(self.cam.matrix, 0);
    var up = new THREE.Vector3().setFromMatrixColumn(self.cam.matrix, 1);
    self.goalTarget.addScaledVector(right, -dx * s);
    self.goalTarget.addScaledVector(up, dy * s);
    self.autoFrame = false;
    clampGoal();
  }

  this.update = function (dt) {
    var k = 1 - Math.exp(-dt * 6.5);
    this.cur.theta += (this.goal.theta - this.cur.theta) * k;
    this.cur.phi += (this.goal.phi - this.cur.phi) * k;
    this.cur.radius += (this.goal.radius - this.cur.radius) * k;
    this.target.lerp(this.goalTarget, k);
    this.cam.position.set(
      this.target.x + this.cur.radius * Math.sin(this.cur.phi) * Math.sin(this.cur.theta),
      this.target.y + this.cur.radius * Math.cos(this.cur.phi),
      this.target.z + this.cur.radius * Math.sin(this.cur.phi) * Math.cos(this.cur.theta)
    );
    this.cam.lookAt(this.target);
  };
  this.reset = function () {
    this.goal.theta = 0.72; this.goal.phi = 1.06; this.goal.radius = vp.base;
    this.goalTarget.set(0, 8.5, 0);
    this.autoFrame = true;
  };
}
var rig = new OrbitRig(camera, canvas);

/* ---------------- 材质 / 几何工具 ---------------- */
function std(c, rough, metal, extra) {
  var p = { color: c, roughness: rough, metalness: metal || 0 };
  if (extra) for (var k in extra) p[k] = extra[k];
  return new THREE.MeshStandardMaterial(p);
}
function roundRectShape(w, d, r) {
  var s = new THREE.Shape(), x = -w / 2, y = -d / 2;
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y); s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + d - r); s.quadraticCurveTo(x + w, y + d, x + w - r, y + d);
  s.lineTo(x + r, y + d); s.quadraticCurveTo(x, y + d, x, y + d - r);
  s.lineTo(x, y + r); s.quadraticCurveTo(x, y, x + r, y);
  return s;
}
/* 挤出平板（XZ 平面放置，厚度沿 Y 居中） */
function flatPlate(w, d, th, r, mat) {
  var g = new THREE.ExtrudeGeometry(roundRectShape(w, d, r), { depth: th, bevelEnabled: false, curveSegments: 10 });
  g.rotateX(-Math.PI / 2);
  g.translate(0, -th / 2, 0);
  var m = new THREE.Mesh(g, mat);
  m.castShadow = true;
  return m;
}
/* 线缆 */
var wireMeshes = [];
function tube(pts, r, mat) {
  var v = pts.map(function (p) { return new THREE.Vector3(p[0], p[1], p[2]); });
  var g = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(v), 30, r, 7, false);
  var m = new THREE.Mesh(g, mat);
  m.castShadow = true;
  wireMeshes.push(m);
  return m;
}
/* 画布贴图与贴片 */
function decalTexture(w, h, draw) {
  var c = document.createElement('canvas'); c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  var t = new THREE.CanvasTexture(c);
  t.anisotropy = 4;
  return t;
}
function decalPlane(w, h, tex) {
  return new THREE.Mesh(
    new THREE.PlaneGeometry(w, h),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false })
  );
}
function box(w, h, d, mat) {
  var m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.castShadow = true;
  return m;
}
function cyl(rt, rb, h, mat, seg) {
  var m = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg || 24), mat);
  m.castShadow = true;
  return m;
}

/* ---------------- 爆炸系统 ---------------- */
var root = new THREE.Group();
root.position.y = 11.5; // 起落架落地：机身抬高，脚垫贴地
scene.add(root);

/* ---------------- 响应式取景（手机竖屏单独一套参数） ---------------- */
var vp = { fov: 45, base: 38, grow: 30, max: 96, explodeScale: 1 };        // 桌面
var vpMobile = { fov: 65, base: 112, grow: 26, max: 175, explodeScale: 0.52 }; // 手机竖屏
var explodeScale = 1, explodeScaleTarget = 1, labelSpread = 1;
function layoutViewport() {
  var aspect = window.innerWidth / Math.max(1, window.innerHeight);
  vp = aspect < 0.95 ? vpMobile : { fov: 45, base: 38, grow: 30, max: 96, explodeScale: 1 };
  camera.fov = vp.fov;
  camera.updateProjectionMatrix();
  explodeScaleTarget = vp.explodeScale;
  rig.radiusMax = vp.max;
  labelSpread = vp.explodeScale < 1 ? 2.1 : 1; // 手机上标签抬升间距放大，防重叠
  if (rig.autoFrame) rig.goal.radius = vp.base + explodeGoal * vp.grow;
}

var explodables = []; // {obj, base, off}
function reg(obj, off) {
  obj.userData.basePos = obj.position.clone();
  obj.userData.off = off;
  explodables.push(obj);
}
var explodeCur = 1, explodeGoal = 0; // 开场：从拆解态组装
function applyExplode(t) {
  var e = t * t * (3 - 2 * t);
  for (var i = 0; i < explodables.length; i++) {
    var o = explodables[i];
    o.position.copy(o.userData.basePos).addScaledVector(o.userData.off, e * explodeScale);
  }
}

/* X 光外壳记录 */
var shellEntries = []; // {mesh, solid, ghost}
function markShell(mesh) {
  var ghost = mesh.material.clone();
  ghost.transparent = true; ghost.opacity = 0.13;
  ghost.depthWrite = false;
  ghost.emissive = new THREE.Color(0x0e3745);
  ghost.emissiveIntensity = 0.7;
  shellEntries.push({ mesh: mesh, solid: mesh.material, ghost: ghost });
}

/* ---------------- 部件数据 ---------------- */
var CATS = ['机架结构', '核心电子设备', '动力与能源'];
var PARTS = [
  { id: 'frame',   cat: '机架结构',   name: 'F450 机架',    short: '机架',   model: 'DJI FlameWheel F450', qty: '1 套' },
  { id: 'legs',    cat: '机架结构',   name: '起落架',      short: '起落架', model: 'F450 加高 U 形脚架', qty: '×2' },
  { id: 'pixhawk', cat: '核心电子设备', name: '飞控',       short: '飞控',   model: 'Pixhawk 6C mini', qty: '1' },
  { id: 'pdb',     cat: '核心电子设备', name: '分电板 PDB', short: '分电板', model: 'Holybro PM06-14S-V2.0', qty: '1' },
  { id: 'esc',     cat: '核心电子设备', name: '电调 ESC',   short: '电调',   model: '好盈天行者 30A V2', qty: '×4' },
  { id: 'rx',      cat: '核心电子设备', name: '接收机',     short: '接收机', model: '乐迪 R8EF', qty: '1' },
  { id: 'gps',     cat: '核心电子设备', name: 'GPS / 罗盘', short: 'GPS',    model: 'M8N / M9N 集成罗盘', qty: '1' },
  { id: 'motor',   cat: '动力与能源', name: '电机',        short: '电机',   model: 'YUAN H X2216 KV950', qty: '×4' },
  { id: 'prop',    cat: '动力与能源', name: '螺旋桨',      short: '螺旋桨', model: '1045 正反桨', qty: '2正2反' },
  { id: 'battery', cat: '动力与能源', name: '动力电池',    short: '电池',   model: '权盛 5200mAh 3S 35C', qty: '1' }
];
PARTS.forEach(function (p) { p.group = new THREE.Group(); root.add(p.group); p.mats = []; });
function byId(id) { for (var i = 0; i < PARTS.length; i++) if (PARTS[i].id === id) return PARTS[i]; return null; }

var interactive = [];

function finishPart(part) {
  part.group.traverse(function (o) {
    if (o.isMesh) {
      o.userData.partId = part.id;
      interactive.push(o);
      if (o.material && part.mats.indexOf(o.material) === -1) part.mats.push(o.material);
    }
  });
  // 记录每个材质的基础自发光，高亮结束后恢复
  part.mats.forEach(function (m) {
    if (m.emissive) {
      m.userData.ebHex = m.emissive.getHex();
      m.userData.ebInt = m.emissiveIntensity || 0;
    }
  });
}

/* 机臂方向：FR / FL 白臂（前），BR / BL 红臂（后） */
var MOTOR_D = 20.7;
var ARMS = [
  { id: 'FR', dir: new THREE.Vector3(1, 0, -1).normalize(), white: true,  cw: true  },
  { id: 'FL', dir: new THREE.Vector3(-1, 0, -1).normalize(), white: true,  cw: false },
  { id: 'BR', dir: new THREE.Vector3(1, 0, 1).normalize(),  white: false, cw: false },
  { id: 'BL', dir: new THREE.Vector3(-1, 0, 1).normalize(), white: false, cw: true  }
];
ARMS.forEach(function (a) { a.angle = Math.atan2(-a.dir.z, a.dir.x); });

/* ---------------- 1. 机架 ---------------- */
(function buildFrame() {
  var part = byId('frame');
  var whiteMat = std(0xe6e9ee, 0.5, 0.05);

  var topPlate = new THREE.Group();
  var tp = flatPlate(14, 17, 0.8, 2.8, whiteMat);
  topPlate.add(tp);
  // 绑带槽细节
  var slotMat = std(0x2a3240, 0.7, 0.1);
  [-5.6, 5.6].forEach(function (z) {
    [-6.2, 6.2].forEach(function (x) {
      var s = box(0.9, 0.85, 2.2, slotMat); s.position.set(x, 0, z); topPlate.add(s);
    });
  });
  // 机头方向箭头
  var arrowShape = new THREE.Shape();
  arrowShape.moveTo(0, 1.15); arrowShape.lineTo(-0.75, -0.5); arrowShape.lineTo(0, -0.15); arrowShape.lineTo(0.75, -0.5); arrowShape.lineTo(0, 1.15);
  var ag = new THREE.ExtrudeGeometry(arrowShape, { depth: 0.06, bevelEnabled: false });
  ag.rotateX(-Math.PI / 2);
  var arrow = new THREE.Mesh(ag, std(0xff7a1a, 0.5, 0.1, { emissive: 0x903c00, emissiveIntensity: 0.5 }));
  arrow.position.set(0, 0.43, -5.2);
  topPlate.add(arrow);
  topPlate.position.y = 1.9;
  markShell(tp);
  part.group.add(topPlate);
  reg(topPlate, new THREE.Vector3(0, 9, 0));

  var bottomPlate = flatPlate(13, 16, 0.8, 2.6, whiteMat.clone());
  bottomPlate.position.y = -1.9;
  markShell(bottomPlate);
  part.group.add(bottomPlate);
  reg(bottomPlate, new THREE.Vector3(0, -5.5, 0));

  // 四条机臂（含电机安装座）
  ARMS.forEach(function (a) {
    var armMat = a.white ? std(0xe8ebee, 0.5, 0.05) : std(0xd23c2c, 0.5, 0.05);
    var g = new THREE.Group();
    g.rotation.y = a.angle;

    var s = new THREE.Shape();
    s.moveTo(5, -1.85); s.lineTo(19.5, -1.55); s.lineTo(19.5, 1.55); s.lineTo(5, 1.85); s.lineTo(5, -1.85);
    var armGeo = new THREE.ExtrudeGeometry(s, { depth: 0.9, bevelEnabled: false });
    armGeo.rotateX(-Math.PI / 2); armGeo.translate(0, -0.45, 0);
    var armMesh = new THREE.Mesh(armGeo, armMat);
    armMesh.castShadow = true;
    g.add(armMesh);
    markShell(armMesh);

    var mount = cyl(2.05, 2.05, 0.5, std(0x333a44, 0.55, 0.25), 26);
    mount.position.set(20.7, 0.2, 0);
    g.add(mount);

    // 电机→电调 三相线（示意）
    var wMatA = std(0xb9c2cc, 0.35, 0.85), wMatB = std(0x22262c, 0.6, 0.3),
        wMatC = std(0xc2875a, 0.45, 0.6);
    [[15.9, 0.4], [15.9, 0], [15.9, -0.4]].forEach(function (st, i) {
      var mats = [wMatA, wMatB, wMatC][i];
      g.add(tube([
        [st[0], 1.05, st[1]],
        [17.6, 1.2, st[1] * 1.25],
        [19.3, 1.25, st[1] * 0.6]
      ], 0.09, mats));
    });
    // （电调电源线改为焊在分电板四边焊盘上，见 buildPDB）

    part.group.add(g);
    reg(g, a.dir.clone().multiplyScalar(7));
  });

  finishPart(part);
})();

/* ---------------- 1b. 起落架（F450 加高 U 形弯管脚架 ×2，前后各一条） ---------------- */
(function buildLegs() {
  var part = byId('legs');
  var tubeMat = std(0x22262c, 0.45, 0.25);
  var sleeveMat = std(0x2f3640, 0.85, 0.05);
  var clampMat = std(0x39404b, 0.55, 0.3);
  [-1, 1].forEach(function (side, idx) { // -1 前 / +1 后
    var g = new THREE.Group();
    // U 形弯管：一端脚 → 弧顶（卡在中心板角下方）→ 另一端脚
    g.add(tube([
      [-8.3, -10.85, side * 9.2],
      [-9.3, -8.3, side * 8.6],
      [-8.4, -4.4, side * 8.35],
      [0, -2.7, side * 8.15],
      [8.4, -4.4, side * 8.35],
      [9.3, -8.3, side * 8.6],
      [8.3, -10.85, side * 9.2]
    ], 0.32, tubeMat));
    // 三节海绵避震套（管端 ×2）
    [[-8.3, -10.75, side * 9.2], [8.3, -10.75, side * 9.2]].forEach(function (ft) {
      var sleeve = cyl(0.55, 0.55, 1.5, sleeveMat, 14);
      sleeve.position.set(ft[0], ft[1], ft[2]);
      g.add(sleeve);
    });
    // 中心板角下方固定座
    var mount = box(2.2, 0.55, 1.5, clampMat);
    mount.position.set(0, -2.62, side * 8.15);
    g.add(mount);
    part.group.add(g);
    reg(g, new THREE.Vector3(0, 0, side * 7));
    if (idx === 0) part.anchor = g;
  });
  finishPart(part);
})();

/* ---------------- 2. 飞控 Pixhawk 6C mini ---------------- */
(function buildFC() {
  var part = byId('pixhawk');
  var g = new THREE.Group();

  var foam = box(4.4, 0.26, 4.4, std(0x70767f, 0.92, 0));
  foam.position.y = 2.43;
  g.add(foam);

  var lower = box(4.4, 0.6, 4.4, std(0x22262d, 0.55, 0.25));
  lower.position.y = 2.86;
  g.add(lower);

  var upper = box(4.42, 0.52, 4.42, std(0xf07f22, 0.5, 0.15));
  upper.position.y = 3.42;
  g.add(upper);

  // 顶部箭头（指向机头）
  var arrowShape = new THREE.Shape();
  arrowShape.moveTo(0, 0.95); arrowShape.lineTo(-0.62, -0.42); arrowShape.lineTo(0, -0.12); arrowShape.lineTo(0.62, -0.42); arrowShape.lineTo(0, 0.95);
  var ag = new THREE.ExtrudeGeometry(arrowShape, { depth: 0.05, bevelEnabled: false });
  ag.rotateX(-Math.PI / 2);
  var arrow = new THREE.Mesh(ag, std(0x2a2d33, 0.5, 0.2));
  arrow.position.set(0, 3.71, -0.7);
  g.add(arrow);

  // 侧面接口
  var portMat = std(0xdfe3e8, 0.4, 0.1);
  [[1.7, 0, 0.9, 0], [1.7, 0, -0.9, 0], [-1.7, 0, 0.9, 0]].forEach(function (pt, i) {
    var p = box(0.35, 0.3, 1.5, portMat);
    p.position.set(pt[0], 2.86, pt[2]);
    g.add(p);
  });
  var portBack = box(1.8, 0.3, 0.35, portMat);
  portBack.position.set(0, 2.86, 2.2);
  g.add(portBack);

  // 状态 LED
  var led = box(0.55, 0.22, 0.35, std(0x2aff9d, 0.3, 0, { emissive: 0x2aff9d, emissiveIntensity: 1.2 }));
  led.userData.noGlow = true;
  led.position.set(0, 3.05, -2.25);
  g.add(led);

  g.position.set(0, 0, 0);
  part.group.add(g);
  reg(g, new THREE.Vector3(0, 13.5, 0));
  finishPart(part);
})();

/* ---------------- 3. 分电板 PM06（下层板上方，45° 放置，四边各一对焊盘朝向四臂） ---------------- */
(function buildPDB() {
  var part = byId('pdb');
  var g = new THREE.Group();
  g.position.set(0, -1.41, 0.3);
  g.rotation.y = Math.PI / 4; // 板边正对四条机臂
  part.group.add(g);

  var pcb = box(5.6, 0.18, 5.6, std(0x10141c, 0.45, 0.35));
  g.add(pcb);

  // 四边各一对焊盘（+ / −），分别对应四条机臂的电调
  var padMat = std(0xd9a441, 0.35, 0.9);
  var C = Math.SQRT1_2;
  var escEdges = [
    { axis: 'x', sign: 1 },   // FR → +x 边
    { axis: 'z', sign: -1 },  // FL → -z 边
    { axis: 'z', sign: 1 },   // BR → +z 边
    { axis: 'x', sign: -1 }   // BL → -x 边
  ];
  escEdges.forEach(function (e) {
    [1, -1].forEach(function (lat) {
      var pad = box(e.axis === 'x' ? 0.55 : 0.42, 0.08, e.axis === 'x' ? 0.42 : 0.55, padMat);
      pad.position.set(
        e.axis === 'x' ? e.sign * 2.45 : lat * 0.55,
        0.13,
        e.axis === 'x' ? lat * 0.55 : e.sign * 2.45
      );
      g.add(pad);
    });
  });

  // 电容 ×2（板面中央区）
  [[-1.4, 1.1], [1.4, -1.1]].forEach(function (pt) {
    var cap = cyl(0.5, 0.5, 0.95, std(0x1a1e26, 0.35, 0.4), 18);
    cap.position.set(pt[0], 0.56, pt[1]);
    g.add(cap);
    var stripe = cyl(0.51, 0.51, 0.18, std(0xc8ccd4, 0.3, 0.85), 18);
    stripe.position.set(pt[0], 0.98, pt[1]);
    g.add(stripe);
  });

  // XT60 输入（板后角，朝机尾）
  var xt = box(1.05, 0.7, 0.8, std(0xffb428, 0.45, 0.1, { emissive: 0x663c00, emissiveIntensity: 0.25 }));
  xt.position.set(-1.8, 0.28, 1.8);
  xt.rotation.y = -3 * Math.PI / 4;
  g.add(xt);
  var xtPins = box(0.5, 0.2, 0.28, std(0xd9a441, 0.3, 0.9));
  xtPins.position.set(-2.15, 0.33, 2.15);
  xtPins.rotation.y = -3 * Math.PI / 4;
  g.add(xtPins);

  // 6 芯输出口（板前角 → 飞控 POWER）
  var p6 = box(1.5, 0.3, 0.5, std(0xdfe3e8, 0.4, 0.1));
  p6.position.set(1.7, 0.24, -1.7);
  g.add(p6);

  // 根部坐标 → 分电板局部坐标（含 45° 旋转）
  function toLocal(x, y, z) {
    return [C * (x - z + 0.3), y + 1.41, C * (x + z - 0.3)];
  }
  // 四个电调的电源线：贴机臂上表面走线 → 机臂外侧下潜 → 板间空隙 → 焊到对应边焊盘
  var wireR = std(0xc0392b, 0.55, 0.1), wireB = std(0x1a1d22, 0.55, 0.1);
  ARMS.forEach(function (a, i) {
    var edge = escEdges[i];
    var tail = toLocal(a.dir.x * 11.2, 0.85, a.dir.z * 11.2); // 电调尾端（根坐标）
    function pt(along, y, lat) {
      return edge.axis === 'x' ? [edge.sign * along, y, lat] : [lat, y, edge.sign * along];
    }
    [1, -1].forEach(function (s, k) {
      g.add(tube([
        tail,
        pt(10.3, 2.0, s * 1.9),
        pt(9.8, 0.6, s * 2.1),
        pt(7.5, 0.35, s * 1.6),
        pt(4.5, 0.2, s * 1.2),
        pt(2.45, 0.13, s * 0.55)
      ], 0.11, k === 0 ? wireR : wireB));
    });
  });

  // 6 芯线 → 飞控 POWER（沿板前角穿板间空隙上行）
  g.add(tube([[1.7, 0.2, -1.7], [0.9, 2.2, -0.7], [-0.5, 3.9, 0.6], [-1.3, 4.25, 1.3]], 0.08, std(0x1a1d22, 0.55, 0.1)));

  reg(g, new THREE.Vector3(0, -3, 0.2));
  finishPart(part);
})();

/* ---------------- 4. 电调 ×4（好盈天行者 30A） ---------------- */
(function buildESC() {
  var part = byId('esc');
  ARMS.forEach(function (a, idx) {
    var g = new THREE.Group();
    var body = box(4.6, 1.05, 2.3, std(0x3b5bdb, 0.35, 0.2, { emissive: 0x101f4d, emissiveIntensity: 0.35 }));
    g.add(body);
    var label = box(3.4, 0.06, 1.1, std(0xdfe6f2, 0.4, 0.1));
    label.position.y = 0.56;
    g.add(label);
    // 信号线 ×3（白信号 / 黑地 / 红+5V）：沿机臂 → 板角外翻上顶板 → 贴板面 → 飞控 MAIN OUT
    var PORTS = { FR: [1.7, 2.88, -0.9], FL: [-1.7, 2.88, -0.9], BR: [1.7, 2.88, 0.9], BL: [-1.7, 2.88, 0.9] };
    var cA = Math.cos(a.angle), sA = Math.sin(a.angle);
    function toL(p) {
      var dx = p[0] - a.dir.x * 13.5, dz = p[2] - a.dir.z * 13.5;
      return [dx * cA - dz * sA, p[1], dx * sA + dz * cA];
    }
    var worldPath = [
      [a.dir.x * 10.3, 0.55, a.dir.z * 10.3],  // 机臂上走线（板外）
      [a.dir.x * 10.1, 2.4, a.dir.z * 10.1],   // 板角外翻上顶板
      [a.dir.x * 9.0, 2.48, a.dir.z * 9.0]     // 上板面
    ];
    if (a.id === 'BL') worldPath.push([-5.9, 2.5, 4.8]); // 左后绕开接收机
    worldPath.push(PORTS[a.id]);
    var lp = worldPath.map(toL);
    [-0.28, 0, 0.28].forEach(function (zo, i) {
      var wm = [std(0xe8e8e8, 0.5, 0.2), std(0xc0392b, 0.5, 0.1), std(0x1a1d22, 0.5, 0.1)][i];
      var path = [[-2.3, 0.62, zo]];
      lp.forEach(function (p, j) {
        var off = j === lp.length - 1 ? zo * 0.55 : zo * Math.max(0, 1 - j * 0.45);
        path.push([p[0], p[1], p[2] + off]);
      });
      g.add(tube(path, 0.06, wm));
    });
    g.position.set(a.dir.x * 13.5, 0, a.dir.z * 13.5);
    g.rotation.y = a.angle;
    part.group.add(g);
    var off = a.dir.clone().multiplyScalar(9); off.y = 3.4;
    reg(g, off);
    if (idx === 0) part.anchor = g;
  });
  finishPart(part);
})();

/* ---------------- 5. 接收机 R8EF（细长条 PCB · 双短鞭天线笔直引出） ---------------- */
(function buildRX() {
  var part = byId('rx');
  var g = new THREE.Group();

  // 机身：48.5 × 21 × 11 mm 细长条 PCB
  var body = box(4.85, 1.1, 2.1, std(0x11151d, 0.5, 0.25));
  body.position.y = 2.85;
  g.add(body);

  var tex = decalTexture(512, 224, function (ctx) {
    ctx.fillStyle = '#141c2e'; ctx.fillRect(0, 0, 512, 224);
    ctx.strokeStyle = '#31435f'; ctx.lineWidth = 6; ctx.strokeRect(8, 8, 496, 208);
    ctx.fillStyle = '#dfe8f5'; ctx.textAlign = 'center';
    ctx.font = 'bold 92px Arial'; ctx.fillText('R8EF', 256, 112);
    ctx.fillStyle = '#7fa7d9'; ctx.font = 'bold 38px Arial';
    ctx.fillText('2.4G 8CH · S.BUS', 256, 176);
  });
  var face = decalPlane(4.5, 1.9, tex);
  face.rotation.x = -Math.PI / 2;
  face.position.y = 3.42;
  g.add(face);

  // PWM 针脚排（顶面两侧）+ 晶振 + 状态 LED（S.BUS 模式亮蓝紫灯）
  var pinMat = std(0xd9dee6, 0.35, 0.5);
  [-0.72, 0.72].forEach(function (zOff) {
    var pins = box(3.6, 0.2, 0.28, pinMat);
    pins.position.set(-0.2, 3.47, zOff);
    g.add(pins);
  });
  var xtal = box(0.5, 0.24, 0.34, std(0xb9c2cc, 0.3, 0.85));
  xtal.position.set(1.3, 3.44, -0.4);
  g.add(xtal);
  var led = box(0.3, 0.16, 0.3, std(0x4d7dff, 0.3, 0, { emissive: 0x4d7dff, emissiveIntensity: 1.4 }));
  led.userData.noGlow = true;
  led.position.set(1.95, 3.45, 0.5);
  g.add(led);
  // ID SET 按键（内侧端面）
  var btn = box(0.16, 0.34, 0.5, std(0x2a3140, 0.5, 0.2));
  btn.position.set(2.48, 2.85, 0);
  g.add(btn);

  // 接飞控的三芯线（红 / 黄 / 蓝 一组并排，末端插头插飞控 RC IN）
  var wR = std(0xd23c2c, 0.55, 0.1), wY = std(0xf2c14e, 0.55, 0.1), wB = std(0x3b7bd6, 0.55, 0.1);
  function trio(dy, dz, mat) {
    g.add(tube([
      [2.45, 2.8 + dy, 0.25 + dz],
      [3.4, 2.88 + dy, -0.8 + dz],
      [4.35, 2.94 + dy, -2.4 + dz],
      [3.75, 2.99 + dy, -4.1 + dz]
    ], 0.05, mat));
  }
  trio(0.07, 0.09, wR);
  trio(-0.02, -0.1, wY);
  trio(-0.11, 0.01, wB);
  var plug = box(0.45, 0.4, 1.0, std(0xe8ecf2, 0.4, 0.1));
  plug.position.set(3.8, 2.94, -4.3);
  g.add(plug);

  g.position.set(-3.2, 0, 6.4);
  part.group.add(g);
  reg(g, new THREE.Vector3(0, 6, 9.5));
  finishPart(part);
})();

/* ---------------- 6. GPS / 罗盘（M8N + 支架） ---------------- */
(function buildGPS() {
  var part = byId('gps');
  var mast = new THREE.Group();

  var base = box(1.6, 0.4, 1.6, std(0x22262c, 0.55, 0.25));
  base.position.y = 2.5;
  mast.add(base);
  var seg1 = cyl(0.2, 0.24, 4.4, std(0x1c2026, 0.5, 0.35), 12);
  seg1.position.y = 4.9;
  mast.add(seg1);
  var joint = new THREE.Mesh(new THREE.SphereGeometry(0.3, 14, 12), std(0x2b3138, 0.45, 0.4));
  joint.castShadow = true; joint.position.y = 7.1;
  mast.add(joint);
  var seg2 = cyl(0.17, 0.2, 3.6, std(0x1c2026, 0.5, 0.35), 12);
  seg2.position.y = 10.9 - 7.1 + 7.1 - 1.8 + 1.8; // = 顶部对齐
  seg2.position.y = 9.0;
  mast.add(seg2);

  // GPS 连接线（沿支架下行 → 飞控，朝机头方向收拢）
  mast.add(tube([[0.4, 12.2, 0.4], [1.2, 9.6, -0.6], [0.9, 6.5, -2.0], [0.2, 3.0, -4.8]], 0.07, std(0x1a1d22, 0.55, 0.1)));

  mast.position.set(0, 0, 7.6);
  part.group.add(mast);
  reg(mast, new THREE.Vector3(0, 8, 1.4));

  var puck = new THREE.Group();
  var shell = cyl(2.2, 2.3, 0.78, std(0x14171c, 0.5, 0.2), 30);
  puck.add(shell);
  var cap = cyl(2.21, 2.21, 0.14, std(0x3a4149, 0.4, 0.35), 30);
  cap.position.y = 0.45;
  puck.add(cap);
  var tex = decalTexture(200, 200, function (ctx) {
    ctx.clearRect(0, 0, 200, 200);
    ctx.fillStyle = '#cfd8e6';
    ctx.beginPath();
    ctx.moveTo(100, 52); ctx.lineTo(64, 138); ctx.lineTo(100, 116); ctx.lineTo(136, 138);
    ctx.closePath(); ctx.fill();
  });
  var face = decalPlane(3.6, 3.6, tex);
  face.rotation.x = -Math.PI / 2;
  face.position.y = 0.53;
  puck.add(face);
  puck.position.set(0, 11.6, 7.6);
  part.group.add(puck);
  reg(puck, new THREE.Vector3(0, 14, 2.4));
  finishPart(part);
})();

/* ---------------- 7. 电机 ×4（X2216 KV950） ---------------- */
(function buildMotors() {
  var part = byId('motor');
  ARMS.forEach(function (a, idx) {
    var g = new THREE.Group();
    var base = cyl(1.5, 1.55, 1.1, std(0x171a1f, 0.45, 0.5), 24);
    base.position.y = 1.0;
    g.add(base);
    var bell = cyl(1.58, 1.58, 0.95, std(0x272c33, 0.35, 0.65), 24);
    bell.position.y = 2.0;
    g.add(bell);
    var ring = cyl(1.6, 1.6, 0.16, std(0xb9c2cc, 0.28, 0.9), 24);
    ring.position.y = 2.5;
    g.add(ring);
    var shaft = cyl(0.13, 0.13, 0.55, std(0xb9c2cc, 0.2, 0.95), 10);
    shaft.position.y = 2.85;
    g.add(shaft);

    g.position.set(a.dir.x * MOTOR_D, 0, a.dir.z * MOTOR_D);
    g.rotation.y = a.angle;
    part.group.add(g);
    var off = a.dir.clone().multiplyScalar(15); off.y = 1.4;
    reg(g, off);
    if (idx === 0) part.anchor = g;
  });
  finishPart(part);
})();

/* ---------------- 8. 螺旋桨 1045（2 正 2 反） ---------------- */
var propSpinners = [];
/* 桨叶沿展向渐变扭转：桨根攻角大、桨尖平（真实桨形） */
function twistBladeGeo(geo, len, rootAng, tipAng) {
  var pos = geo.attributes.position;
  for (var i = 0; i < pos.count; i++) {
    var x = pos.getX(i);
    var t = Math.max(0, Math.min(1, (x - 0.7) / (len - 0.7)));
    var ang = rootAng + (tipAng - rootAng) * t;
    var y = pos.getY(i), z = pos.getZ(i);
    var c = Math.cos(ang), s = Math.sin(ang);
    pos.setY(i, y * c - z * s);
    pos.setZ(i, y * s + z * c);
  }
  geo.computeVertexNormals();
}
(function buildProps() {
  var part = byId('prop');
  ARMS.forEach(function (a, idx) {
    var g = new THREE.Group();       // 定位组（跟爆炸）
    var spin = new THREE.Group();    // 旋转组
    var pitch = a.cw ? 0.16 : -0.16;

    var hub = cyl(0.72, 0.78, 0.5, std(0x1d2127, 0.45, 0.3), 18);
    spin.add(hub);
    var nut = cyl(0.34, 0.34, 0.22, std(0xb9c2cc, 0.25, 0.9), 12);
    nut.position.y = 0.34;
    spin.add(nut);

    for (var b = 0; b < 2; b++) {
      var bladeGrp = new THREE.Group();
      var s = new THREE.Shape();
      s.moveTo(0.7, 0);
      s.quadraticCurveTo(3, 1.2, 8, 0.8);
      s.quadraticCurveTo(10.6, 0.55, 11.6, 0.08);
      s.quadraticCurveTo(10.6, -0.32, 8, -0.62);
      s.quadraticCurveTo(3, -1.05, 0.7, 0);
      var bg = new THREE.ExtrudeGeometry(s, { depth: 0.13, bevelEnabled: false, curveSegments: 14 });
      bg.rotateX(-Math.PI / 2); bg.translate(0, 0.065, 0);
      twistBladeGeo(bg, 11.6, pitch * 2.4, pitch * 0.7);
      var blade = new THREE.Mesh(bg, std(0x23262c, 0.5, 0.15));
      blade.castShadow = true;
      markShell(blade);
      bladeGrp.add(blade);
      var tip = box(1.15, 0.16, 0.72, std(0xff8c2e, 0.45, 0.1, { emissive: 0x7a3a00, emissiveIntensity: 0.55 }));
      tip.position.set(11.1, 0.1, 0);
      bladeGrp.add(tip);
      if (b === 1) bladeGrp.rotation.y = Math.PI;
      spin.add(bladeGrp);
    }

    g.add(spin);
    g.position.set(a.dir.x * MOTOR_D, 3.0, a.dir.z * MOTOR_D);
    g.rotation.y = a.angle;
    part.group.add(g);
    var off = a.dir.clone().multiplyScalar(19); off.y = 7.4;
    reg(g, off);
    propSpinners.push({ obj: spin, dir: a.cw ? 1 : -1 });
    if (idx === 0) part.anchor = g;
  });
  finishPart(part);
})();

/* ---------------- 9. 动力电池 3S 5200mAh ---------------- */
(function buildBattery() {
  var part = byId('battery');
  var g = new THREE.Group();

  var body = flatPlate(4.8, 15.4, 2.9, 1.1, std(0x1d2737, 0.5, 0.15));
  markShell(body);
  g.add(body);

  var tex = decalTexture(256, 512, function (ctx) {
    ctx.fillStyle = '#141c2c'; ctx.fillRect(0, 0, 256, 512);
    ctx.strokeStyle = '#3a4a66'; ctx.lineWidth = 6;
    ctx.strokeRect(10, 10, 236, 492);
    ctx.fillStyle = '#4dd8ff'; ctx.textAlign = 'center';
    ctx.font = 'bold 58px Arial'; ctx.fillText('5200', 128, 120);
    ctx.font = 'bold 40px Arial'; ctx.fillText('mAh', 128, 170);
    ctx.fillStyle = '#e8eef8'; ctx.font = 'bold 46px Arial';
    ctx.fillText('11.1V', 128, 260);
    ctx.fillText('3S', 128, 320);
    ctx.fillStyle = '#ff9440'; ctx.font = 'bold 44px Arial';
    ctx.fillText('35C', 128, 400);
    ctx.fillStyle = '#8fa3bd'; ctx.font = '26px Arial';
    ctx.fillText('XT60', 128, 465);
  });
  var face = decalPlane(4.1, 13.6, tex);
  face.rotation.x = -Math.PI / 2;
  face.rotation.z = Math.PI; // 文字朝机尾方向阅读
  face.position.y = 1.47;
  g.add(face);
  var bandMat = std(0xffd23f, 0.65, 0.05);
  [-4.6, 4.6].forEach(function (z) {
    var bot = box(5.0, 0.14, 0.95, bandMat); bot.position.set(0, -1.52, z); g.add(bot);
    var top = box(5.0, 0.14, 0.95, bandMat.clone()); top.position.set(0, 1.36, z); g.add(top);
    [-2.46, 2.46].forEach(function (x) {
      var side = box(0.14, 2.9, 0.95, bandMat.clone());
      side.position.set(x, -0.1, z);
      g.add(side);
    });
  });

  // 电源引出线（绕过下层板后缘上行 → 板间夹层 → 分电板 XT60）
  var redW = std(0xc0392b, 0.55, 0.1), blkW = std(0x14161a, 0.55, 0.1);
  g.add(tube([[0.5, 0.3, 7.75], [0.55, 0.75, 8.75], [0.4, 1.95, 8.6], [0.3, 2.6, 8.4], [0.32, 2.5, 5.5], [0.35, 2.46, 3.05]], 0.16, redW));
  g.add(tube([[-0.5, 0.3, 7.75], [-0.55, 0.85, 8.8], [-0.4, 2.0, 8.65], [-0.3, 2.62, 8.42], [-0.32, 2.52, 5.5], [-0.35, 2.48, 3.05]], 0.16, blkW));

  g.position.set(0, -3.75, 0); // 下挂：顶面贴住下层板底面
  part.group.add(g);
  reg(g, new THREE.Vector3(0, -6, 0));
  finishPart(part);
})();

/* 标注锚点（跟随爆炸移动的不可见对象），标签分层错开防重叠 */
var LABEL_LIFT = { frame: 1.0, legs: -4.0, pixhawk: 2.2, pdb: 1.6, esc: 1.6, rx: 1.4, gps: 1.8, motor: 0.8, prop: 3.2, battery: 2.0 };
PARTS.forEach(function (p) {
  var host = p.anchor || p.group.children[0];
  if (!host) return;
  var anchorObj = new THREE.Object3D();
  var base = host.userData.basePos;
  var off = host.userData.off || new THREE.Vector3();
  anchorObj.position.copy(base);
  if (p.id === 'battery' || p.id === 'pixhawk') anchorObj.position.y += 1.6;
  root.add(anchorObj);
  reg(anchorObj, off);
  p.labelAnchor = anchorObj;
  p.labelLift = LABEL_LIFT[p.id] || 1.2;
});

/* ---------------- 部件详情文案（来自真实组装记录） ---------------- */
var DETAIL = {
  frame: {
    pos: '上下两块中心板夹持四条机臂，M3 螺丝固定；前臂白色、后臂红色，机臂末端为电机安装座',
    specs: [['轴距', '450 mm'], ['中心板', '上下双层 · 玻纤增强'], ['机臂', '前白后红 × 4'], ['空机重量', '约 280 g']],
    note: '电池采用下挂式：绑带穿过下层板槽，悬挂在四条起落架中间，重心贴板。'
  },
  pixhawk: {
    pos: '机架中心板上方，3M 减震胶 / 减震垫固定，箭头指向机头',
    specs: [['处理器', 'STM32H743'], ['IMU', '双 BMI055 + RM3100 罗盘'], ['固件', 'PX4 / ArduPilot'], ['输出', 'MAIN OUT 1-4 → 电调'], ['固定', '减震垫 · 箭头朝机头']],
    wires: [
      'MAIN OUT 1-4 → 4 个电调信号线（白 = 信号，黑 = 地）',
      'POWER 端口 ← PM06 6 芯线（5V 供电 + 电压电流检测）',
      'RC IN ← 乐迪 R8EF S.BUS 三芯线',
      'GPS1 ← GPS 模块 10 针线（箭头朝机头）'
    ],
    note: '电调红色 +5V 线绝缘不接，仅白（信号）黑（地）入排针。'
  },
  pdb: {
    pos: '下层中心板上方（板间夹层），XT60 朝机尾；板身 45° 放置，四边各一对焊盘正对四条机臂',
    specs: [['输入', 'XT60'], ['输出焊盘', '4 边 × 2（正 / 负）'], ['BEC 输出', '5V · 最大 3A'], ['内置', '电压 / 电流检测']],
    wires: [
      '电池 XT60 → PM06 输入口（主电源）',
      '4 个电调正负极 → 四边焊盘，每边一对（已焊接）',
      'PM06 6 芯线 → 飞控 POWER 端口（5V + 电压电流检测）'
    ],
    note: '焊接完成后已做绝缘与防短路处理。'
  },
  esc: {
    pos: '分别固定在四条机臂上（扎带绑于机臂内侧），靠近电机端',
    specs: [['持续电流', '30 A'], ['适配电机', '2216 级（KV950）'], ['固定方式', '扎带 · 机臂内侧'], ['信号', 'PWM / DShot']],
    wires: [
      '电源线正负极 → PM06 C1-C4 / G1-G4 焊盘',
      '信号线 → 飞控 MAIN OUT 1-4（红 5V 绝缘不接）',
      '三相线 → 对应电机（已按转向校正）'
    ],
    note: '电机转向已在飞控中校正完成。'
  },
  rx: {
    pos: '中心板尾部侧方（避开 GPS 支架），双面胶 / 扎带固定；双天线越过后缘自然下垂，远离电池与电源线',
    specs: [['通道', '8 CH'], ['频段', '2.4 GHz'], ['输出', 'S.BUS / PPM / PWM'], ['对频', 'ID SET 按键一键对频'], ['尺寸', '48.5 × 21 × 11 mm · 7 g']],
    wires: ['三芯线（红 / 黄 / 蓝）并排一组 → 飞控 RC IN 端口（信号 / +5V / GND）'],
    note: '已完成对频与通道校准。提示：绑在机臂上会贴近电调与大电流线，易受电磁干扰，建议移到中心板尾部侧方。'
  },
  gps: {
    pos: 'GPS 支架安装于机架尾部，模块箭头指向机头正前方，远离电源线和电调',
    specs: [['卫星系统', 'GPS + 北斗 + GLONASS'], ['集成', '三轴电子罗盘'], ['接口', '10 针 · 带定向箭头'], ['支架', '尾部抬升 · 避磁干扰']],
    wires: ['10 针线 → 飞控 GPS1 端口（插头箭头朝机头）'],
    note: '正在排查 GPS 位置偏移问题——罗盘已远离主电源线安装。'
  },
  motor: {
    pos: '四条机臂末端电机座，M3 螺丝固定，电机线朝机架中心走线',
    specs: [['KV 值', '950 KV'], ['定子', '22 × 16 mm'], ['适配桨', '1045（10 英寸）'], ['供电', '3S · 单电机拉力约 800 g'], ['固定', 'M3 螺丝 × 4']],
    wires: ['三相线 → 机臂内侧电调（按转向校正焊接）'],
    note: '对角同向：FR / BL 顺时针，FL / BR 逆时针。'
  },
  prop: {
    pos: '对应电机安装，有字面朝上：CW 电机装正桨，CCW 电机装反桨',
    specs: [['规格', '10 × 4.5 英寸'], ['桨型', '正桨 ×2 / 反桨 ×2'], ['安装', '有字面朝上 · 案帽锁紧']],
    wires: [],
    note: '安全守则：所有地面测试均已卸桨进行！'
  },
  battery: {
    pos: '下层中心板底面下挂，魔术贴绑带穿过板槽固定，悬挂在四条起落架中间，居中压重心',
    specs: [['容量', '5200 mAh'], ['电压', '3S · 11.1 V'], ['放电倍率', '35 C'], ['接口', 'XT60'], ['固定', '绑带下挂 · 起落架中间']],
    wires: ['XT60 → PM06 分电板输入口（主电源输入）'],
    note: '电池已做绝缘处理；起飞前确认绑带拉紧，防止位移改变重心。'
  },
  legs: {
    pos: '两条 U 形弯管脚架前后各一条，弧顶卡在中心板前后角下方，四端撑地、兜住下挂电池',
    specs: [['类型', '加高 U 形弯管脚架'], ['数量', '2 条 · 4 脚'], ['附件', '三节海绵避震套 ×4'], ['材质', '尼龙 + 玻纤'], ['作用', '起降缓冲 · 保护下挂电池']],
    wires: [],
    note: '电池悬挂在前后脚架之间，起降 / 跌落时海绵套先着地缓冲，保护电池与电调。'
  }
};

/* ---------------- UI：概览 + 部件清单 ---------------- */
$('overview-card').innerHTML =
  [['机架', 'F450 · 450mm'], ['飞控', 'Pixhawk 6C mini'], ['动力', 'X2216 KV950 ×4'],
   ['螺旋桨', '1045 正反桨'], ['电源', '3S 5200mAh 下挂'], ['脚架', 'U 形加高 ×2'], ['状态', '已首飞 · 调参中']]
  .map(function (r) { return '<div class="row"><span>' + r[0] + '</span><span>' + r[1] + '</span></div>'; }).join('');

var listEl = $('parts-list');
CATS.forEach(function (cat) {
  var h = document.createElement('div');
  h.className = 'cat-title';
  h.textContent = cat;
  listEl.appendChild(h);
  PARTS.filter(function (p) { return p.cat === cat; }).forEach(function (p) {
    var it = document.createElement('div');
    it.className = 'part-item';
    it.setAttribute('data-part', p.id);
    it.innerHTML =
      '<span class="dot"></span><span><div class="nm">' + p.name + '</div>' +
      '<div class="md">' + p.model + '</div></span>' +
      '<span class="qty">' + p.qty + '</span>';
    it.addEventListener('click', function () { selectPart(p.id, true); });
    listEl.appendChild(it);
  });
});

/* ---------------- UI：详情面板 ---------------- */
var detailPanel = $('detail-panel');
function renderDetail(p) {
  var d = DETAIL[p.id];
  $('d-cat').textContent = p.cat;
  $('d-name').textContent = p.name;
  $('d-model').textContent = p.model + ' · 数量 ' + p.qty;
  var html = '';
  html += '<div class="sec-title">安装位置</div><div class="pos-box">' + d.pos + '</div>';
  html += '<div class="sec-title">参数规格</div><table class="spec-table"><tbody>' +
    d.specs.map(function (s) { return '<tr><td>' + s[0] + '</td><td>' + s[1] + '</td></tr>'; }).join('') +
    '</tbody></table>';
  if (d.wires && d.wires.length) {
    html += '<div class="sec-title">线缆连接</div><ul class="wire-list">' +
      d.wires.map(function (w) { return '<li>' + w + '</li>'; }).join('') + '</ul>';
  }
  if (d.note) html += '<div class="sec-title">备注</div><div class="note-box">' + d.note + '</div>';
  $('detail-body').innerHTML = html;
  detailPanel.classList.add('show');
}
$('detail-close').addEventListener('click', function () { deselect(); });

/* ---------------- 选中 / 高亮 ---------------- */
var selected = null, hovered = null;
function setGlow(part, intensity) {
  if (!part) return;
  part.mats.forEach(function (m) {
    if (!m.emissive) return;
    m.emissive.setHex(0x36c9ff);
    m.emissiveIntensity = intensity;
  });
}
function clearGlow(part) {
  if (!part) return;
  part.mats.forEach(function (m) {
    if (!m.emissive) return;
    if (m.userData && m.userData.noGlow) return;
    m.emissive.setHex(m.userData.ebHex !== undefined ? m.userData.ebHex : 0);
    m.emissiveIntensity = m.userData.ebInt || 0;
  });
}
function selectPart(id, fromList) {
  var p = byId(id);
  if (!p) return;
  if (selected && selected !== p) clearGlow(selected);
  selected = p;
  setGlow(p, 0.3);
  renderDetail(p);
  document.querySelectorAll('.part-item').forEach(function (el) {
    el.classList.toggle('active', el.getAttribute('data-part') === id);
  });
  document.querySelectorAll('.lab').forEach(function (el) {
    el.classList.toggle('sel', el.getAttribute('data-part') === id);
  });
  if (p.labelAnchor && !fromList) {
    var v = new THREE.Vector3();
    p.labelAnchor.getWorldPosition(v);
    rig.goalTarget.copy(v);
    rig.autoFrame = false;
  } else if (p.labelAnchor && fromList) {
    var w = new THREE.Vector3();
    p.labelAnchor.getWorldPosition(w);
    rig.goalTarget.copy(w);
    rig.autoFrame = false;
    if (explodeGoal < 0.55) setExplodeGoal(1);
  }
}
function deselect() {
  if (selected) clearGlow(selected);
  selected = null;
  detailPanel.classList.remove('show');
  document.querySelectorAll('.part-item').forEach(function (el) { el.classList.remove('active'); });
  document.querySelectorAll('.lab').forEach(function (el) { el.classList.remove('sel'); });
  rig.goalTarget.set(0, 8.5, 0);
}

/* ---------------- 拾取交互 ---------------- */
var raycaster = new THREE.Raycaster();
var pointerNDC = new THREE.Vector2();
function pick(x, y) {
  pointerNDC.x = (x / window.innerWidth) * 2 - 1;
  pointerNDC.y = -(y / window.innerHeight) * 2 + 1;
  raycaster.setFromCamera(pointerNDC, camera);
  var hits = raycaster.intersectObjects(interactive, false);
  return hits.length ? hits[0].object.userData.partId : null;
}
function handleClick(x, y) {
  var id = pick(x, y);
  if (id) selectPart(id, false);
  else if (selected) deselect();
}
canvas.addEventListener('pointermove', function (e) {
  if (e.pointerType === 'mouse' && !canvas.classList.contains('dragging')) {
    var id = pick(e.clientX, e.clientY);
    if (id !== (hovered && hovered.id)) {
      if (hovered && hovered !== selected) clearGlow(hovered);
      hovered = id ? byId(id) : null;
      if (hovered && hovered !== selected) setGlow(hovered, 0.22);
      canvas.classList.toggle('pointing', !!hovered);
    }
  }
});

/* ---------------- 3D 标注 ---------------- */
var labelsOn = true;
var labelsEl = $('labels');
PARTS.forEach(function (p) {
  var el = document.createElement('div');
  el.className = 'lab';
  el.setAttribute('data-part', p.id);
  el.innerHTML = '<div class="tag">' + p.name + '</div><div class="stem"></div>';
  el.addEventListener('click', function (ev) { ev.stopPropagation(); selectPart(p.id, false); });
  labelsEl.appendChild(el);
  p.labelEl = el;
});
var tmpV = new THREE.Vector3();
function updateLabels() {
  var show = labelsOn && explodeCur > 0.2;
  PARTS.forEach(function (p) {
    var el = p.labelEl;
    if (!p.labelAnchor) { el.style.opacity = 0; return; }
    var isSel = selected === p;
    if (!show && !isSel) { el.style.opacity = 0; el.style.pointerEvents = 'none'; return; }
    p.labelAnchor.getWorldPosition(tmpV);
    tmpV.y += (p.labelLift || 1.2) * labelSpread;
    tmpV.project(camera);
    if (tmpV.z > 1 || tmpV.z < -1) { el.style.opacity = 0; el.style.pointerEvents = 'none'; return; }
    el.style.left = ((tmpV.x * 0.5 + 0.5) * window.innerWidth) + 'px';
    el.style.top = ((-tmpV.y * 0.5 + 0.5) * window.innerHeight) + 'px';
    el.style.opacity = 1;
    el.style.pointerEvents = 'auto';
  });
}

/* ---------------- 控制条 ---------------- */
var slider = $('explode-slider'), pctEl = $('explode-pct'), btnExplode = $('btn-explode');
function setExplodeGoal(v) {
  explodeGoal = Math.max(0, Math.min(1, v));
  slider.value = Math.round(explodeGoal * 100);
  slider.style.setProperty('--fill', (explodeGoal * 100) + '%');
  pctEl.textContent = Math.round(explodeGoal * 100) + '%';
  btnExplode.textContent = explodeGoal > 0.5 ? '一键装配' : '一键拆解';
}
slider.addEventListener('input', function () {
  exitDemo();
  setExplodeGoal(slider.value / 100);
});
btnExplode.addEventListener('click', function () {
  exitDemo();
  setExplodeGoal(explodeGoal > 0.5 ? 0 : 1);
});

var xrayOn = false;
var ELEC_IDS = { pixhawk: 1, pdb: 1, esc: 1, rx: 1, gps: 1, motor: 1 };
$('btn-xray').addEventListener('click', function () {
  xrayOn = !xrayOn;
  this.classList.toggle('on', xrayOn);
  shellEntries.forEach(function (s) { s.mesh.material = xrayOn ? s.ghost : s.solid; });
});

var wiresOn = true;
$('btn-wires').addEventListener('click', function () {
  wiresOn = !wiresOn;
  this.classList.toggle('on', wiresOn);
  wireMeshes.forEach(function (m) { m.visible = wiresOn; });
});

$('btn-labels').addEventListener('click', function () {
  labelsOn = !labelsOn;
  this.classList.toggle('on', labelsOn);
});
$('btn-labels').classList.add('on');

$('btn-reset').addEventListener('click', function () { rig.reset(); });

/* 自动演示 */
var demo = false, demoT = 0;
var btnDemo = $('btn-demo');
function exitDemo() {
  if (!demo) return;
  demo = false;
  btnDemo.classList.remove('on');
  setExplodeGoal(explodeGoal > 0.5 ? 1 : 0);
}
btnDemo.addEventListener('click', function () {
  demo = !demo;
  this.classList.toggle('on', demo);
  if (demo) { demoT = Math.acos(Math.max(-1, Math.min(1, 1 - 2 * explodeCur))) / 0.5; }
  else setExplodeGoal(explodeGoal > 0.5 ? 1 : 0);
});

/* 面板开关（移动端） */
$('panel-toggle').addEventListener('click', function () {
  $('parts-panel').classList.toggle('hidden-mobile');
});

/* 键盘 */
window.addEventListener('keydown', function (e) {
  if (e.code === 'Space') { e.preventDefault(); exitDemo(); setExplodeGoal(explodeGoal > 0.5 ? 0 : 1); }
  else if (e.key === 'x' || e.key === 'X') $('btn-xray').click();
  else if (e.key === 'l' || e.key === 'L') $('btn-labels').click();
  else if (e.key === 'd' || e.key === 'D') btnDemo.click();
  else if (e.key === 'r' || e.key === 'R') rig.reset();
  else if (e.key === 'Escape') deselect();
});

/* 提示淡出 */
var hintsHidden = false;
function hideHints() {
  if (hintsHidden) return;
  hintsHidden = true;
  $('hint-layer').classList.add('fade');
  $('help-btn').classList.add('show');
}
$('help-btn').addEventListener('click', function () {
  hintsHidden = false;
  $('hint-layer').classList.remove('fade');
  $('help-btn').classList.remove('show');
});
setTimeout(hideHints, 12000);

/* ---------------- 主循环 ---------------- */
setExplodeGoal(0);
applyExplode(explodeCur);

function animate() {
  requestAnimationFrame(animate);
  var dt = Math.min(clock.getDelta(), 0.05);
  elapsed += dt;

  if (demo) {
    demoT += dt;
    rig.goal.theta += dt * 0.22;
    setExplodeGoal((1 - Math.cos(demoT * 0.5)) / 2);
  }

  var ke = 1 - Math.exp(-dt * 3.2);
  explodeCur += (explodeGoal - explodeCur) * ke;
  if (Math.abs(explodeGoal - explodeCur) < 0.001) explodeCur = explodeGoal;
  explodeScale += (explodeScaleTarget - explodeScale) * (1 - Math.exp(-dt * 2.5));
  applyExplode(explodeCur);

  // 自动取景：爆炸铺开越大，相机拉得越远、视心略上移（手机/桌面各自一套距离）
  if (rig.autoFrame) {
    rig.goal.radius = vp.base + explodeCur * vp.grow;
    rig.goalTarget.y = 8.5 + explodeCur * 5;
  }

  // 螺旋桨慢转
  for (var i = 0; i < propSpinners.length; i++) {
    propSpinners[i].obj.rotation.y += dt * 1.5 * propSpinners[i].dir;
  }
  // 选中部件呼吸高亮；X 光时电子件保持透视加亮
  if (selected) setGlow(selected, 0.24 + 0.14 * Math.sin(elapsed * 3.6));
  if (hovered && hovered !== selected) setGlow(hovered, 0.22);
  PARTS.forEach(function (p) {
    if (p === selected || p === hovered) return;
    if (xrayOn && ELEC_IDS[p.id]) setGlow(p, 0.3);
    else clearGlow(p);
  });

  var stars = scene.getObjectByName('stars');
  if (stars) stars.rotation.y += dt * 0.008;

  rig.update(dt);
  updateLabels();
  renderer.render(scene, camera);
}

var clock = new THREE.Clock();
var elapsed = 0;
layoutViewport();
rig.cur.radius = vp.base + 24; // 开场从稍远处推进
animate();

window.addEventListener('resize', function () {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  layoutViewport();
});

setTimeout(function () { loadingEl.classList.add('done'); }, 600);
})();
