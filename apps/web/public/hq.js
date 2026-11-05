/* ═══ QG Tyno : l'étage de bureaux en 3D, vu du dessus ═══════════════════════
 * Chaque pièce est un service de Tyno (un « agent ») : son statut vient des
 * vraies données (ventes, achats Temu, messages, factures…). Clic sur une
 * étiquette = détail + bouton vers la bonne page. Barre « Écris au Boss ».
 * Utilise les globales de la page : state, go, esc, eur, eurShort, toast,
 * openTasks, invNumbers, PENDING, view, DEMO.
 */
(function () {
  const hq = { ok: false, failed: false, labels: [], rooms: [], walkers: [], monitors: [], seated: [], log: [], sel: null };

  // ── Plan de l'étage (x : gauche→droite, z : haut→bas) ──────────────────────
  const ROOMS = [
    // ── BUREAUX (moitié haute) ──
    { k: "boss", name: "BOSS", ic: "👑", x: -33, z: -24, w: 13, d: 10, kind: "boss", page: "overview" },
    { k: "controle", name: "CONTRÔLE", ic: "🛡️", x: -20, z: -24, w: 13, d: 10, kind: "control", page: "sales" },
    { k: "compta", name: "COMPTABILITÉ", ic: "📒", x: -7, z: -24, w: 10, d: 10, kind: "office", desks: 4, page: "compta" },
    { k: "tresorerie", name: "TRÉSORERIE", ic: "💶", x: 3, z: -24, w: 10, d: 10, kind: "office", desks: 4, page: "accounts" },
    { k: "urssaf", name: "URSSAF", ic: "🏛️", x: 13, z: -24, w: 10, d: 10, kind: "office", desks: 2, page: "facturation" },
    { k: "rapports", name: "RAPPORTS", ic: "📊", x: 23, z: -24, w: 10, d: 10, kind: "office", desks: 2, page: "reports" },
    { k: "achats", name: "ACHATS TEMU", ic: "🛒", x: -33, z: -11.4, w: 11, d: 9.4, kind: "pod", desks: 4, page: "temu" },
    { k: "ventes", name: "VENTES", ic: "🛍️", x: -22, z: -11.4, w: 11, d: 9.4, kind: "pod", desks: 4, page: "sales" },
    { k: "service", name: "SERVICE CLIENT", ic: "💬", x: -11, z: -11.4, w: 11, d: 9.4, kind: "pod", desks: 4, page: "messages" },
    { k: "annonces", name: "ANNONCES", ic: "📢", x: 0, z: -11.4, w: 11, d: 9.4, kind: "pod", desks: 4, page: "listings" },
    { k: "niches", name: "RECHERCHE NICHES", ic: "🔎", x: 11, z: -11.4, w: 11, d: 9.4, kind: "pod", desks: 4, page: "products" },
    { k: "facturation", name: "FACTURATION", ic: "🧾", x: 22, z: -11.4, w: 11, d: 9.4, kind: "pod", desks: 4, page: "facturation" },
    // ── ZONE EMBALLAGE (moitié basse) ──
    { k: "stock", name: "STOCK", ic: "📦", x: -34, z: 3, w: 16, d: 21, kind: "stock", page: "listings" },
    { k: "reception", name: "RÉCEPTION", ic: "📥", x: -16, z: 3, w: 11, d: 9, kind: "reception", page: "sales" },
    { k: "emballage", name: "EMBALLAGE", ic: "🎁", x: -3, z: 3, w: 14, d: 9, kind: "packing", page: "temu" },
    { k: "etiquetage", name: "ÉTIQUETAGE", ic: "🏷️", x: 13, z: 3, w: 9, d: 9, kind: "labels", page: "temu" },
    { k: "quai", name: "QUAI D'EXPÉDITION", ic: "🚚", x: 24, z: 3, w: 11, d: 21, kind: "dock", page: "sales" },
    { k: "livres", name: "LIVRÉS", ic: "✅", x: -16, z: 16, w: 38, d: 8, kind: "pallets", page: "sales" },
  ];
  const ROLE = {
    boss: "Toi. Tu décides, Tyno exécute.",
    controle: "Vérifie chaque vente avant la commande (stock, prix, rentabilité).",
    rapports: "Prépare tes rapports : chaque lundi et le 1er du mois.",
    securite: "Garde le site privé : mot de passe, accès Telegram limité.",
    achats: "Commande sur Temu les articles vendus.",
    stock: "Tes annonces en ligne : ce qui est en rayon, prêt à être vendu.",
    reception: "Les nouvelles commandes arrivent ici dès qu'un acheteur paie.",
    emballage: "Les colis commandés chez Temu, en préparation.",
    etiquetage: "Crée les étiquettes : il manque le numéro de suivi.",
    quai: "Les colis partis, en route vers tes acheteurs.",
    livres: "Les colis livrés : l'argent arrive sur tes comptes.",
    ventes: "Suit toutes les ventes jusqu'à la livraison.",
    service: "Répond aux acheteurs sur Leboncoin.",
    annonces: "Publie et programme tes annonces.",
    niches: "Repère ce qui se vend et ce qui bloque.",
    facturation: "Crée les factures et les avoirs automatiquement.",
    compta: "Tient le chiffre d'affaires, les achats et le bénéfice.",
    tresorerie: "Surveille l'argent de chaque compte et les retraits.",
    urssaf: "Calcule la déclaration et te la rappelle à temps.",
  };
  const ST = {
    mission: { t: "En mission", c: "#e8702a" },
    wait: { t: "À valider par toi", c: "#e6b04a" },
    ok: { t: "Disponible", c: "#4fbf8a" },
    meet: { t: "Libre", c: "#6aa5e8" },
  };

  // ── Données : ce que fait chaque agent en ce moment ─────────────────────────
  function agents() {
    const sales = (state.dash?.activeSales ?? []).filter((s) => s.status !== "cancelled");
    const confirmed = sales.filter((s) => s.status === "confirmed").length;
    const noTrack = sales.filter((s) => s.status === "order_placed" && !s.trackingNumber).length;
    const pend = sales.filter((s) => PENDING.includes(s.status));
    const placed = sales.filter((s) => s.status === "order_placed").length;
    const shipped = sales.filter((s) => s.status === "tracking_added").length;
    const delivered = sales.filter((s) => s.status === "delivered").length;
    const need = (state.convs ?? []).filter((c) => c.needsYou).length;
    const sched = (state.listings ?? []).filter((l) => l.status === "scheduled").length;
    const live = (state.listings ?? []).filter((l) => l.status === "published").length;
    let nums = {};
    try { nums = invNumbers(); } catch { /* */ }
    const toInv = sales.filter((s) => !nums[s.saleId]).length;
    const action = (state.dash?.salesNeedingAction ?? []).length;
    const dec = (state.decls ?? []).find((d) => !d.current && !d.declaredAt && d.caEur > 0);
    const avail = (state.wd?.accounts ?? []).reduce((a, x) => a + (x.availableEur ?? 0), 0);
    const today = sales.filter((s) => new Date(s.confirmedAt).toDateString() === new Date().toDateString());
    const ca = state.fin?.summary?.revenueEur ?? 0;
    const niches = new Set((state.listings ?? []).map((l) => l.product_niche).filter(Boolean)).size;
    const A = {
      boss: { s: "wait", line: action ? `${action} décision${action > 1 ? "s" : ""}` : "Tout roule", n: action },
      controle: { s: confirmed ? "wait" : "ok", line: confirmed ? `${confirmed} vente${confirmed > 1 ? "s" : ""} à valider` : "Rien à valider", n: confirmed },
      rapports: { s: "ok", line: "Prochain : lundi", n: 0 },
      securite: { s: "ok", line: "Site privé · protégé", n: 0 },
      achats: { s: confirmed ? "mission" : "ok", line: confirmed ? `${confirmed} à commander` : "Rien à commander", n: confirmed },
      expedition: { s: "ok", line: "", n: noTrack },
      ventes: { s: pend.length ? "mission" : "ok", line: `${pend.length} en cours · ${eurShort(pend.reduce((a, s) => a + s.salePriceEur, 0))}`, n: pend.length },
      service: { s: need ? "wait" : "ok", line: need ? `${need} acheteur${need > 1 ? "s" : ""} attend${need > 1 ? "ent" : ""}` : "Réponses auto actives", n: need },
      annonces: { s: sched ? "mission" : "ok", line: `${live} en ligne${sched ? ` · ${sched} programmée${sched > 1 ? "s" : ""}` : ""}`, n: sched },
      niches: { s: "ok", line: niches ? `${niches} niche${niches > 1 ? "s" : ""} suivie${niches > 1 ? "s" : ""}` : "En veille", n: 0 },
      facturation: { s: toInv ? "mission" : "ok", line: toInv ? `${toInv} facture${toInv > 1 ? "s" : ""} à émettre` : "Factures à jour", n: toInv },
      compta: { s: "ok", line: `CA ${eurShort(ca)}`, n: 0 },
      tresorerie: { s: avail > 0 ? "mission" : "ok", line: avail > 0 ? `${eurShort(avail)} à retirer` : "Comptes à jour", n: avail > 0 ? 1 : 0 },
      urssaf: { s: dec ? "wait" : "ok", line: dec ? `${dec.label} à déclarer` : "Déclarations à jour", n: dec ? 1 : 0 },
      stock: { s: live ? "ok" : "wait", line: `${live} article${live > 1 ? "s" : ""} en rayon`, n: Math.min(4, Math.ceil(live / 10)) },
      reception: { s: confirmed ? "mission" : "ok", line: confirmed ? `${confirmed} nouvelle${confirmed > 1 ? "s" : ""} commande${confirmed > 1 ? "s" : ""}` : "Quai vide", n: confirmed },
      emballage: { s: placed ? "mission" : "ok", line: placed ? `${placed} colis en préparation` : "Rien à emballer", n: placed },
      etiquetage: { s: noTrack ? "wait" : "ok", line: noTrack ? `${noTrack} étiquette${noTrack > 1 ? "s" : ""} à créer` : "Étiquettes à jour", n: noTrack },
      quai: { s: shipped ? "mission" : "ok", line: shipped ? `${shipped} colis en route` : "Aucun départ", n: shipped },
      livres: { s: "ok", line: `${delivered} livré${delivered > 1 ? "s" : ""}`, n: Math.min(4, delivered) },
    };
    delete A.expedition;
    if (!action) A.boss.s = "ok";
    return { A, today, ca, pend };
  }

  // ── Textures dessinées (pas d'image externe) ────────────────────────────────
  function glowTex(color) {
    const c = document.createElement("canvas"); c.width = c.height = 128;
    const g = c.getContext("2d"), r = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    r.addColorStop(0, color); r.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = r; g.fillRect(0, 0, 128, 128);
    return new THREE.CanvasTexture(c);
  }
  function signTex(text) {
    const c = document.createElement("canvas"); c.width = 512; c.height = 128;
    const g = c.getContext("2d");
    g.fillStyle = "#0b0a09"; g.fillRect(0, 0, 512, 128);
    g.strokeStyle = "#c9a45c"; g.lineWidth = 3; g.strokeRect(6, 6, 500, 116);
    g.fillStyle = "#e8b06a"; g.font = "600 64px Georgia, serif"; g.textAlign = "center"; g.textBaseline = "middle";
    g.fillText(text, 256, 70);
    return new THREE.CanvasTexture(c);
  }

  // ── Construction de la scène ────────────────────────────────────────────────
  function init() {
    if (hq.ok || hq.failed) return;
    const host = document.getElementById("hq-scene");
    if (!window.THREE) { hq.failed = true; host.innerHTML = '<div class="scene-fallback">Vue 3D indisponible</div>'; return; }
    let renderer;
    try { renderer = new THREE.WebGLRenderer({ antialias: true }); } catch { hq.failed = true; host.innerHTML = '<div class="scene-fallback">Ton navigateur ne supporte pas la 3D (WebGL)</div>'; return; }
    renderer.setPixelRatio(Math.min(1.75, devicePixelRatio));
    renderer.setClearColor(0x07080b);
    host.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0x07080b, 90, 160);
    const camera = new THREE.PerspectiveCamera(32, 1, 0.5, 400);
    Object.assign(hq, { renderer, scene, camera, host });

    scene.add(new THREE.AmbientLight(0x4a5468, 0.75));
    scene.add(new THREE.HemisphereLight(0xffe2c0, 0x0b0d12, 0.5));
    const key = new THREE.PointLight(0xffb070, 0.6, 90); key.position.set(0, 26, 0); scene.add(key);
    const moon = new THREE.DirectionalLight(0x9db4ff, 0.25); moon.position.set(-30, 60, 20); scene.add(moon);

    const M = (color, o = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.75, metalness: 0.08, ...o });
    const mat = {
      ground: M(0x0c0d10, { roughness: 0.95 }),
      corridor: M(0x1a1b1f, { roughness: 0.6 }),
      wood: M(0x2a1e15, { roughness: 0.55 }),
      carpet: M(0x17191e, { roughness: 1 }),
      wall: M(0x1d1e22, { roughness: 0.8 }),
      glass: new THREE.MeshStandardMaterial({ color: 0x9fc3e8, transparent: true, opacity: 0.16, roughness: 0.1, metalness: 0.3, depthWrite: false }),
      edge: new THREE.MeshBasicMaterial({ color: 0xffb066 }),
      desk: M(0x3a2b1f, { roughness: 0.5 }),
      deskTop: M(0xd9cbb4, { roughness: 0.45 }),
      chair: M(0x111216, { roughness: 0.7 }),
      screenOn: new THREE.MeshBasicMaterial({ color: 0x7fd0ff }),
      screenWarm: new THREE.MeshBasicMaterial({ color: 0xffb36b }),
      screenOff: M(0x0a0b0d, { roughness: 0.3 }),
      plant: M(0x2e6b3a, { roughness: 0.9 }),
      pot: M(0x2b2b30),
      sofa: M(0x3b2f28),
      rack: M(0x15161a, { metalness: 0.5, roughness: 0.4 }),
      led: new THREE.MeshBasicMaterial({ color: 0x3de08a }),
    };
    const box = (w, h, d, m, x, y, z, parent = scene) => { const o = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m); o.position.set(x, y, z); parent.add(o); return o; };
    const cyl = (rt, rb, h, m, x, y, z, seg = 14) => { const o = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg), m); o.position.set(x, y, z); scene.add(o); return o; };

    // Dalle du bâtiment : bureaux (haut) + entrepôt béton (bas)
    box(72, 0.4, 50, mat.ground, 0, -0.25, 0);
    box(70, 0.05, 2.4, mat.corridor, 0, 0.0, -13);    // couloir des bureaux
    box(70, 0.04, 23, M(0x2a2b2f, { roughness: 0.9 }), 0, -0.01, 13.5); // béton de l'entrepôt
    // séparation vitrée bureaux / entrepôt + bande lumineuse
    box(70, 1.6, 0.15, mat.glass, 0, 0.8, 0.9);
    box(70, 0.05, 0.08, new THREE.MeshBasicMaterial({ color: 0x9fd0ff, transparent: true, opacity: 0.5 }), 0, 1.62, 0.9);
    const yellow = new THREE.MeshBasicMaterial({ color: 0xd9a21b });
    box(70, 0.03, 0.18, yellow, 0, 0.03, 2.2); box(70, 0.03, 0.18, yellow, 0, 0.03, 13.9); box(70, 0.03, 0.18, yellow, 0, 0.03, 15.4);
    // Façade : bordure lumineuse du bâtiment
    [[0, -22.6, 70, 0.25], [0, 22.6, 70, 0.25]].forEach(([x, z, w, d]) => box(w, 0.12, d, mat.edge, x, 0.05, z));
    [[-35.6, 0], [35.6, 0]].forEach(([x, z]) => box(0.25, 0.12, 45, mat.edge, x, 0.05, z));

    const pool = { warm: glowTex("rgba(255,170,90,0.7)"), cool: glowTex("rgba(120,190,255,0.35)"), green: glowTex("rgba(80,220,140,0.35)") };
    const floorGlow = (x, z, s, tex = pool.warm) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(s, s), new THREE.MeshBasicMaterial({ map: tex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
      m.rotation.x = -Math.PI / 2; m.position.set(x, 0.06, z); scene.add(m); return m;
    };
    const plant = (x, z, s = 1) => { cyl(0.35 * s, 0.28 * s, 0.6 * s, mat.pot, x, 0.3 * s, z, 10); const p = new THREE.Mesh(new THREE.SphereGeometry(0.62 * s, 10, 8), mat.plant); p.position.set(x, 1.0 * s, z); p.scale.y = 1.25; scene.add(p); };
    const person = (x, z, color, seated = true) => {
      const g = new THREE.Group();
      const body = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.34, seated ? 0.8 : 1.15, 10), M(color, { roughness: 0.6 }));
      body.position.y = seated ? 0.85 : 0.75; g.add(body);
      const head = new THREE.Mesh(new THREE.SphereGeometry(0.24, 12, 10), M(0xe6c3a5, { roughness: 0.7 }));
      head.position.y = seated ? 1.45 : 1.55; g.add(head);
      g.position.set(x, 0, z); scene.add(g); g.userData.head = head; return g;
    };
    const HUE = [0xe8702a, 0x6aa5e8, 0x4fbf8a, 0xc9a45c, 0xb979e0, 0xe5675f, 0xdedede];

    const walls = (r, glassy) => {
      const h = glassy ? 1.4 : 2.2, t = 0.18, m = glassy ? mat.glass : mat.wall;
      const x0 = r.x, x1 = r.x + r.w, z0 = r.z, z1 = r.z + r.d, cx = r.x + r.w / 2, cz = r.z + r.d / 2;
      const door = 2.2; // ouverture côté couloir (bas de la pièce)
      box(r.w, h, t, m, cx, h / 2, z0);
      box((r.w - door) / 2, h, t, m, x0 + (r.w - door) / 4, h / 2, z1);
      box((r.w - door) / 2, h, t, m, x1 - (r.w - door) / 4, h / 2, z1);
      box(t, h, r.d, m, x0, h / 2, cz);
      box(t, h, r.d, m, x1, h / 2, cz);
      // liseré lumineux en haut des murs
      const e = glassy ? new THREE.MeshBasicMaterial({ color: 0x9fd0ff, transparent: true, opacity: 0.45 }) : mat.edge;
      box(r.w, 0.05, 0.06, e, cx, h + 0.02, z0); box(t, 0.05, r.d, e, x0, h + 0.02, cz); box(t, 0.05, r.d, e, x1, h + 0.02, cz);
    };
    const deskAt = (x, z, rot, room, i) => {
      const g = new THREE.Group(); g.position.set(x, 0, z); g.rotation.y = rot; scene.add(g);
      box(2.4, 0.08, 1.2, mat.deskTop, 0, 0.95, 0, g);
      box(0.08, 0.9, 1.1, mat.desk, -1.1, 0.47, 0, g); box(0.08, 0.9, 1.1, mat.desk, 1.1, 0.47, 0, g);
      const scr = box(1.1, 0.62, 0.06, mat.screenOff, 0, 1.38, -0.42, g);
      box(0.1, 0.3, 0.1, mat.rack, 0, 1.1, -0.42, g);
      const ch = box(0.8, 0.12, 0.8, mat.chair, 0, 0.6, 0.95, g); box(0.8, 0.8, 0.12, mat.chair, 0, 1.0, 1.32, g); void ch;
      const p = new THREE.Vector3(0, 0, 0.95).applyAxisAngle(new THREE.Vector3(0, 1, 0), rot).add(new THREE.Vector3(x, 0, z));
      const w = person(p.x, p.z, HUE[(room.hue + i) % HUE.length]);
      w.rotation.y = rot; w.visible = false;
      hq.monitors.push({ m: scr, room: room.k, i });
      hq.seated.push({ g: w, room: room.k, i, phase: Math.random() * 6 });
    };

    const cardboard = [M(0xb98a55), M(0xa8784a), M(0xc89a62)];
    const parcel = (x, y, z, s = 0.8, parent = scene) => box(s, s * 0.75, s, cardboard[Math.floor(Math.random() * 3)], x, y + s * 0.375, z, parent);
    const stand = (x, z, color, room, i, rot = 0) => {
      const w = person(x, z, color, false); w.rotation.y = rot; w.visible = false;
      hq.seated.push({ g: w, room, i, phase: Math.random() * 6, base: 1.55 });
      return w;
    };
    const steel = M(0x3a3d44, { metalness: 0.6, roughness: 0.4 });
    const orange = M(0xd9661f, { metalness: 0.3, roughness: 0.5 });
    function buildZone(r, cx, cz) {
      if (r.kind === "stock") {
        // rayonnages hauts remplis de cartons + chariot élévateur dans l'allée
        for (let row = 0; row < 3; row++) {
          const x = r.x + 2.2 + row * 5.6;
          for (let lv = 0; lv < 3; lv++) box(1.6, 0.08, r.d - 3, steel, x, 0.6 + lv * 1.3, cz);
          [-1, 1].forEach((sx) => [r.z + 1.5, cz, r.z + r.d - 1.5].forEach((z) => box(0.08, 3.6, 0.08, orange, x + sx * 0.78, 1.8, z)));
          for (let lv = 0; lv < 3; lv++) for (let k = 0; k < 7; k++) if (Math.random() < 0.85) parcel(x, 0.64 + lv * 1.3, r.z + 2 + k * ((r.d - 4) / 6.5), 0.9);
        }
        const fork = new THREE.Group();
        box(1.4, 0.8, 2.2, M(0xe6b04a, { roughness: 0.5 }), 0, 0.6, 0, fork); box(1.2, 1.6, 0.1, steel, 0, 1.1, -1.2, fork);
        box(0.12, 0.08, 1.2, steel, -0.4, 0.15, -1.8, fork); box(0.12, 0.08, 1.2, steel, 0.4, 0.15, -1.8, fork);
        parcel(0, 0.2, -1.8, 0.9, fork);
        const driver = person(0, 0.4, 0xe8702a); fork.add(driver); driver.position.set(0, 0.2, 0.4);
        fork.position.set(r.x + 5, 0, cz); scene.add(fork);
        hq.walkers.push({ g: fork, a: [r.x + 5, r.z + 3], b: [r.x + 5, r.z + r.d - 3], t: 0.3, speed: 0.012, vehicle: true });
        stand(r.x + 10.6, r.z + 5, 0x6aa5e8, r.k, 0, Math.PI / 2); stand(r.x + 10.6, r.z + 13, 0x4fbf8a, r.k, 1, -Math.PI / 2);
      } else if (r.kind === "reception") {
        for (let i = 0; i < 3; i++) { box(1.6, 0.18, 1.6, M(0x7a5a38), r.x + 2 + i * 3.4, 0.09, cz + 1.5); for (let k = 0; k < 4; k++) parcel(r.x + 1.7 + i * 3.4 + (k % 2) * 0.7, 0.18 + Math.floor(k / 2) * 0.62, cz + 1.2 + (k % 2) * 0.5, 0.65); }
        box(3, 0.08, 1.2, mat.deskTop, cx, 0.95, r.z + 2); box(2.8, 0.9, 1, mat.desk, cx, 0.45, r.z + 2);
        for (let i = 0; i < 3; i++) stand(r.x + 2.5 + i * 3, r.z + 3.6, [0xe8702a, 0x6aa5e8, 0xc9a45c][i], r.k, i, Math.PI);
      } else if (r.kind === "packing") {
        // tables d'emballage : carton ouvert, rouleau de scotch, papier bulle
        for (let i = 0; i < 4; i++) {
          const x = r.x + 2 + i * 3.4;
          box(2.6, 0.08, 1.4, mat.deskTop, x, 0.95, r.z + 3.4); box(2.4, 0.9, 1.2, steel, x, 0.45, r.z + 3.4);
          parcel(x - 0.5, 0.99, r.z + 3.4, 0.7); box(0.5, 0.25, 0.5, M(0xd9e6f2), x + 0.6, 1.1, r.z + 3.3);
          stand(x, r.z + 4.6, [0xe8702a, 0x4fbf8a, 0x6aa5e8, 0xb979e0][i], r.k, i, Math.PI);
        }
        for (let k = 0; k < 6; k++) parcel(r.x + 1.5 + k * 2.2, 0, r.z + r.d - 1.6, 0.8);
      } else if (r.kind === "labels") {
        for (let i = 0; i < 2; i++) {
          const x = r.x + 2.3 + i * 4.4;
          box(2.8, 0.08, 1.3, mat.deskTop, x, 0.95, r.z + 3.2); box(2.6, 0.9, 1.1, steel, x, 0.45, r.z + 3.2);
          box(0.6, 0.4, 0.5, M(0xeeeeee), x - 0.6, 1.2, r.z + 3); const scr = box(0.9, 0.55, 0.05, mat.screenOff, x + 0.5, 1.35, r.z + 2.75);
          hq.monitors.push({ m: scr, room: r.k, i });
          stand(x, r.z + 4.4, [0xc9a45c, 0xe5675f][i], r.k, i, Math.PI);
        }
      } else if (r.kind === "dock") {
        // portes de quai sur la façade + camion qui charge
        for (let i = 0; i < 3; i++) {
          const z = r.z + 3.5 + i * 7;
          box(0.3, 3.4, 4.2, orange, r.x + r.w - 0.2, 1.7, z);
          box(0.32, 3, 3.6, M(0x1d1f24, { metalness: 0.5 }), r.x + r.w - 0.18, 1.6, z);
          box(3, 0.04, 3.8, yellow, r.x + r.w - 2, 0.04, z);
          for (let k = 0; k < 3; k++) parcel(r.x + 2 + k * 1.1, 0, z + 1.2, 0.8);
          stand(r.x + 4.5, z - 0.8, [0x6aa5e8, 0xe8702a, 0x4fbf8a][i], r.k, i, Math.PI / 2);
        }
        const truck = new THREE.Group();
        box(7, 3.2, 3.2, M(0xe9e6e0, { roughness: 0.6 }), 0, 1.9, 0, truck);
        box(2.4, 2.6, 3, M(0xd9661f, { roughness: 0.4 }), 4.7, 1.6, 0, truck);
        box(0.05, 1, 2.6, new THREE.MeshBasicMaterial({ color: 0x9fd0ff }), 5.92, 2.2, 0, truck);
        [-2.2, 2, 4.6].forEach((x) => [-1.5, 1.5].forEach((z) => { const w = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.55, 0.4, 14), M(0x111111)); w.rotation.x = Math.PI / 2; w.position.set(x, 0.55, z); truck.add(w); }));
        const sign = new THREE.Mesh(new THREE.PlaneGeometry(4.6, 1.15), new THREE.MeshBasicMaterial({ map: signTex("TYNO"), transparent: true }));
        sign.rotation.x = -Math.PI / 2; sign.position.set(0, 3.52, 0); truck.add(sign);
        truck.position.set(r.x + r.w + 4.2, 0, r.z + 10.5); scene.add(truck);
        hq.truck = truck;
      } else if (r.kind === "pallets") {
        for (let i = 0; i < 8; i++) {
          const x = r.x + 2.5 + i * 4.6;
          box(2, 0.18, 2, M(0x7a5a38), x, 0.09, cz + 1); for (let k = 0; k < 3; k++) parcel(x - 0.4 + (k % 2) * 0.8, 0.18, cz + 0.6 + Math.floor(k / 2) * 0.8, 0.7);
        }
      }
    }

    // Tapis roulant : de la réception au quai, les colis avancent
    const beltZ = 13.2;
    box(42, 0.6, 1.4, steel, 1, 0.5, beltZ);
    box(42, 0.05, 1.2, M(0x15161a, { roughness: 0.9 }), 1, 0.83, beltZ);
    for (let x = -19; x <= 21; x += 2) box(0.12, 0.5, 1.5, steel, x, 0.25, beltZ);
    hq.belt = [];
    for (let i = 0; i < 12; i++) { const b = parcel(-20 + i * 3.6, 0.85, beltZ, 0.7); hq.belt.push(b); }

    ROOMS.forEach((r, ri) => {
      r.hue = ri;
      const cx = r.x + r.w / 2, cz = r.z + r.d / 2;
      const closed = ["boss", "meeting", "server", "control", "office", "studio"].includes(r.kind);
      const zone = ["stock", "reception", "packing", "labels", "dock", "pallets"].includes(r.kind);
      if (zone) {
        // marquage au sol jaune autour de la zone
        [[r.w, 0.14, cx, r.z + 0.1], [r.w, 0.14, cx, r.z + r.d - 0.1]].forEach(([w, d, x, z]) => box(w, 0.03, d, yellow, x, 0.04, z));
        [[r.x + 0.1], [r.x + r.w - 0.1]].forEach(([x]) => box(0.14, 0.03, r.d, yellow, x, 0.04, cz));
      } else {
        box(r.w - 0.2, 0.06, r.d - 0.2, r.kind === "pod" || r.kind === "office" ? mat.carpet : mat.wood, cx, 0.02, cz);
      }
      if (r.kind !== "lobby" && !zone) walls(r, !closed || r.kind === "control");
      floorGlow(cx, cz, Math.max(r.w, r.d) * 1.05, r.kind === "server" ? pool.cool : pool.warm);
      if (r.kind === "pod" || r.kind === "office") {
        const n = r.desks ?? 4, cols = 2, rows = Math.ceil(n / cols);
        for (let i = 0; i < n; i++) {
          const c = i % cols, row = Math.floor(i / cols);
          deskAt(r.x + r.w * (c === 0 ? 0.3 : 0.7), r.z + 2.2 + row * ((r.d - 3.6) / Math.max(1, rows - 1 || 1)), 0, r, i);
        }
        plant(r.x + r.w - 0.9, r.z + 0.9, 0.8);
      } else if (r.kind === "meeting") {
        box(r.w * 0.55, 0.1, 2.2, mat.deskTop, cx, 0.95, cz); box(r.w * 0.5, 0.85, 1.6, mat.desk, cx, 0.45, cz);
        for (let i = 0; i < 4; i++) { box(0.7, 0.9, 0.7, mat.chair, cx - r.w * 0.2 + i * (r.w * 0.4 / 3), 0.45, cz - 1.6); box(0.7, 0.9, 0.7, mat.chair, cx - r.w * 0.2 + i * (r.w * 0.4 / 3), 0.45, cz + 1.6); }
        box(0.1, 2.4, 3.6, mat.screenOn, r.x + 0.3, 1.6, cz).material = new THREE.MeshBasicMaterial({ color: 0x233a55 });
        plant(r.x + r.w - 1, r.z + 1);
      } else if (r.kind === "boss") {
        box(4.2, 0.1, 1.8, mat.deskTop, cx, 1.0, cz - 1); box(4, 0.95, 1.6, mat.desk, cx, 0.5, cz - 1);
        const scr = box(1.6, 0.8, 0.06, mat.screenWarm, cx, 1.5, cz - 1.6);
        hq.bossScreen = scr;
        const b = person(cx, cz + 0.2, 0xe8702a); b.rotation.y = Math.PI; hq.boss = b;
        box(2.6, 0.7, 1.2, mat.sofa, cx - 3.5, 0.35, cz + 3); box(2.6, 0.7, 1.2, mat.sofa, cx + 3.5, 0.35, cz + 3);
        plant(r.x + 1, r.z + 1, 1.1); plant(r.x + r.w - 1, r.z + 1, 1.1);
        // logo au mur
        const sign = new THREE.Mesh(new THREE.PlaneGeometry(4, 1), new THREE.MeshBasicMaterial({ map: signTex("TYNO"), transparent: true }));
        sign.position.set(cx, 2.0, r.z + 0.15); scene.add(sign);
      } else if (r.kind === "control") {
        // grande console face à un mur d'écrans
        box(9, 2.2, 0.15, new THREE.MeshBasicMaterial({ color: 0x173049 }), cx, 1.3, r.z + 0.3);
        for (let i = 0; i < 3; i++) box(2.6, 1.5, 0.05, mat.screenOn, cx - 3 + i * 3, 1.4, r.z + 0.42);
        box(7, 0.1, 1.6, mat.deskTop, cx, 0.95, cz + 1.2); box(6.8, 0.9, 1.4, mat.desk, cx, 0.45, cz + 1.2);
        for (let i = 0; i < 3; i++) {
          const w = person(cx - 2.4 + i * 2.4, cz + 2.6, HUE[(ri + i) % HUE.length]); w.visible = false;
          hq.seated.push({ g: w, room: r.k, i, phase: Math.random() * 6 });
        }
      } else if (r.kind === "server") {
        for (let i = 0; i < 5; i++) {
          box(1.2, 2.2, 0.9, mat.rack, r.x + 2 + i * 2.2, 1.1, cz - 1.5);
          for (let j = 0; j < 5; j++) box(0.06, 0.06, 0.02, mat.led, r.x + 1.7 + i * 2.2 + (j % 2) * 0.3, 0.5 + j * 0.35, cz - 1.04);
        }
        box(3, 0.1, 1.2, mat.deskTop, cx, 0.95, cz + 2.4);
        const w = person(cx, cz + 3.4, 0x6aa5e8); w.rotation.y = Math.PI; hq.seated.push({ g: w, room: r.k, i: 0, phase: 1 });
      } else if (r.kind === "lounge") {
        box(3.4, 0.75, 1.3, mat.sofa, cx - 1.5, 0.37, r.z + 1.6); box(1.3, 0.75, 3, mat.sofa, r.x + 1.2, 0.37, cz + 0.6);
        cyl(1.1, 1.1, 0.5, mat.deskTop, cx, 0.5, cz + 0.6, 20);
        plant(r.x + r.w - 1, r.z + 1); plant(r.x + r.w - 1, r.z + r.d - 1);
      } else if (r.kind === "studio") {
        cyl(1.6, 1.6, 0.1, mat.deskTop, cx, 0.1, cz, 24);
        box(0.1, 3, 3, new THREE.MeshBasicMaterial({ color: 0xf2f0ea }), r.x + 0.4, 1.5, cz);
        [-1, 1].forEach((s) => { cyl(0.05, 0.05, 2.6, mat.rack, cx + s * 3, 1.3, cz + s * 1.5); box(0.8, 0.6, 0.6, new THREE.MeshBasicMaterial({ color: 0xfff3dd }), cx + s * 3, 2.6, cz + s * 1.5); });
      } else if (["stock", "reception", "packing", "labels", "dock", "pallets"].includes(r.kind)) {
        buildZone(r, cx, cz);
      } else if (r.kind === "lobby") {
        box(6, 1.1, 1.4, mat.desk, cx, 0.55, r.z + 2.4); box(6.2, 0.08, 1.6, mat.deskTop, cx, 1.12, r.z + 2.4);
        const sign = new THREE.Mesh(new THREE.PlaneGeometry(6, 1.5), new THREE.MeshBasicMaterial({ map: signTex("TYNO"), transparent: true }));
        sign.rotation.x = -Math.PI / 2; sign.position.set(cx, 0.08, r.z + r.d - 1.6); scene.add(sign);
        const p = person(cx, r.z + 1.3, 0xc9a45c); p.rotation.y = Math.PI;
        plant(r.x + 1, r.z + 1, 1.2); plant(r.x + r.w - 1, r.z + 1, 1.2);
      }
    });
    // plantes dans le couloir des bureaux
    for (let x = -30; x <= 30; x += 12) plant(x + 5, -13, 0.7);

    // Personnes qui marchent dans les couloirs
    const paths = [
      [[-32, -13], [32, -13]], [[30, -13], [-30, -13]], [[-16, 14.6], [22, 14.6]], [[20, 14.6], [-14, 14.6]], [[-10, -13], [-10, 2]],
    ];
    paths.forEach((pp, i) => {
      const w = person(pp[0][0], pp[0][1], HUE[i % HUE.length], false);
      hq.walkers.push({ g: w, a: pp[0], b: pp[1], t: Math.random(), speed: 0.025 + Math.random() * 0.02 });
    });

    // Étiquettes HTML (comme des panneaux au-dessus de chaque pièce)
    const lab = document.getElementById("hq-labels");
    lab.innerHTML = "";
    hq.labels = ROOMS.map((r) => {
      const el = document.createElement("button");
      el.className = "hq-lab" + (ROLE[r.k] ? "" : " deco");
      el.type = "button";
      el.onclick = () => select(r.k);
      lab.appendChild(el);
      return { r, el, p: new THREE.Vector3(r.x + r.w / 2, r.kind === "stock" ? 4.2 : 2.6, r.z + 1.4) };
    });

    // Caméra : vue plongeante, glisser pour tourner, molette / boutons pour zoomer
    hq.cam = { yaw: 0, pitch: 1.05, dist: 82, tx: 0, tz: 0 };
    let drag = null;
    const el = renderer.domElement;
    el.addEventListener("pointerdown", (e) => { drag = { x: e.clientX, y: e.clientY, yaw: hq.cam.yaw, pitch: hq.cam.pitch, tx: hq.cam.tx, tz: hq.cam.tz, pan: e.button === 2 || e.shiftKey }; el.setPointerCapture(e.pointerId); });
    el.addEventListener("pointermove", (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (drag.pan) { hq.cam.tx = drag.tx - dx * 0.06; hq.cam.tz = drag.tz - dy * 0.06; }
      else { const y0 = hq.fitYaw ?? 0; hq.cam.yaw = Math.max(y0 - 0.9, Math.min(y0 + 0.9, drag.yaw - dx * 0.004)); hq.cam.pitch = Math.max(0.6, Math.min(1.35, drag.pitch + dy * 0.003)); }
    });
    el.addEventListener("pointerup", () => { drag = null; });
    el.addEventListener("contextmenu", (e) => e.preventDefault());
    el.addEventListener("wheel", (e) => { e.preventDefault(); zoom(e.deltaY > 0 ? 1.08 : 0.92); }, { passive: false });

    hq.ok = true;
    if (window.ResizeObserver) new ResizeObserver(() => size()).observe(host);
    size();
    update();
    loop();
  }

  function zoom(f) { if (hq.cam) hq.cam.dist = Math.max(28, Math.min(120, hq.cam.dist * f)); }
  function recenter() { if (hq.cam) Object.assign(hq.cam, { yaw: hq.fitYaw ?? 0, pitch: hq.fitPitch ?? 1.05, dist: hq.fitDist ?? 82, tx: hq.fitTx ?? 0, tz: 0 }); }

  function size() {
    if (!hq.ok) return;
    const w = hq.host.clientWidth, h = hq.host.clientHeight;
    if (!w || !h) return;
    hq.renderer.setSize(w, h);
    hq.camera.aspect = w / h;
    hq.camera.updateProjectionMatrix();
    // distance pour voir tout l'étage (72 de large) quelle que soit la largeur
    const tan = Math.tan((hq.camera.fov * Math.PI) / 360);
    const portrait = w / h < 0.85;                        // téléphone : l'étage est tourné pour tenir en hauteur
    const free = w > 900 ? (w - 230) / w : 1;             // place laissée par les compteurs à droite
    const fit = portrait
      ? 1.08 * Math.max(27 / (tan * (w / h)), 30 / tan)
      : 1.12 * Math.max(38 / (tan * Math.max(0.9, (w / h) * free)), 27 / tan);
    const fresh = !hq.fitDist || Math.abs(hq.cam.dist - hq.fitDist) < 0.5;
    hq.fitDist = fit;
    hq.fitTx = w > 900 ? (230 / w) * 38 * 1.1 : 0;       // décale l'étage vers la gauche
    hq.fitYaw = portrait ? Math.PI / 2 : 0;
    hq.fitPitch = portrait ? 1.3 : 1.05;
    if (fresh) Object.assign(hq.cam, { dist: fit, tx: hq.fitTx, yaw: hq.fitYaw, pitch: hq.fitPitch, tz: 0 });
  }

  let last = 0;
  function loop(t = 0) {
    if (!hq.ok) return;
    requestAnimationFrame(loop);
    if (view !== "warehouse" || document.hidden) return;
    const dt = Math.min(0.05, (t - last) / 1000 || 0.016); last = t;
    const c = hq.cam;
    const cy = Math.sin(c.pitch) * c.dist, r = Math.cos(c.pitch) * c.dist;
    hq.camera.position.set(c.tx + Math.sin(c.yaw) * r, cy, c.tz + Math.cos(c.yaw) * r);
    hq.camera.lookAt(c.tx, 0, c.tz);
    hq.scene.fog.near = c.dist + 10; hq.scene.fog.far = c.dist + 90;
    // agents qui travaillent : petit mouvement + écrans qui scintillent
    hq.seated.forEach((s) => { if (s.g.visible && s.g.userData.head) s.g.userData.head.position.y = (s.base ?? 1.45) + Math.sin(t / 400 + s.phase) * 0.03; });
    const speed = hq.beltSpeed ?? 1;
    (hq.belt ?? []).forEach((b, i) => { b.visible = i < (hq.beltCount ?? 12); b.position.x += dt * 2.2 * speed; if (b.position.x > 21.5) b.position.x = -20; });
    hq.monitors.forEach((m) => { if (m.on && Math.random() < 0.004) m.m.material = m.m.material === hq.mScreenA ? hq.mScreenB : hq.mScreenA; });
    hq.walkers.forEach((w) => {
      w.t += w.speed * dt * 6;
      if (w.t > 1) { w.t = 0; [w.a, w.b] = [w.b, w.a]; }
      const x = w.a[0] + (w.b[0] - w.a[0]) * w.t, z = w.a[1] + (w.b[1] - w.a[1]) * w.t;
      w.g.position.set(x, Math.abs(Math.sin(w.t * 60)) * 0.06, z);
      w.g.rotation.y = Math.atan2(w.b[0] - w.a[0], w.b[1] - w.a[1]) + (w.vehicle ? Math.PI : 0);
      if (w.vehicle) w.g.position.y = 0;
    });
    if (hq.bossScreen) hq.bossScreen.material.color.setHSL(0.08, 0.9, 0.55 + Math.sin(t / 900) * 0.05);
    hq.renderer.render(hq.scene, hq.camera);
    // étiquettes
    const W = hq.host.clientWidth, H = hq.host.clientHeight;
    hq.labels.forEach((l) => {
      const v = l.p.clone().project(hq.camera);
      const vis = v.z < 1 && v.x > -1.1 && v.x < 1.1 && v.y > -1.1 && v.y < 1.1;
      l.el.style.display = vis ? "" : "none";
      if (vis) l.el.style.transform = `translate(-50%, -100%) translate(${((v.x + 1) / 2) * W}px, ${((1 - v.y) / 2) * H}px)`;
    });
  }

  // ── Mise à jour avec les vraies données ─────────────────────────────────────
  function update() {
    const box = document.getElementById("hq-stats");
    if (!box) return;
    const { A, today, ca, pend } = agents();
    const keys = Object.keys(A).filter((k) => ROOMS.some((r) => r.k === k));
    const active = keys.filter((k) => A[k].s === "mission").length;
    const waitN = keys.filter((k) => A[k].s === "wait").reduce((t, k) => t + Math.max(1, A[k].n), 0);
    const tasks = keys.reduce((t, k) => t + (A[k].s === "mission" ? A[k].n : 0), 0);
    box.innerHTML = [
      ["Équipes en mission", `${active}<small> / ${keys.length}</small>`, active / keys.length, "#e8702a"],
      ["Tâches en cours", tasks, Math.min(1, tasks / 20), "#6aa5e8"],
      ["À valider par toi", waitN, Math.min(1, waitN / 10), "#e6b04a"],
      ["Ventes aujourd'hui", `${today.length}<small> · ${eurShort(today.reduce((a, s) => a + s.salePriceEur, 0))}</small>`, Math.min(1, today.length / 10), "#4fbf8a"],
      ["CA du mois", eurShort(ca), Math.min(1, ca / 3000), "#c9a45c"],
    ].map(([l, v, p, c]) => `<div class="hq-stat"><div class="l"><i style="background:${c}"></i>${l}</div><div class="v num">${v}</div><div class="b"><i style="width:${Math.round(p * 100)}%;background:${c}"></i></div></div>`).join("");
    document.getElementById("hq-badge").textContent = DEMO ? "DÉMO" : "RÉEL · EN DIRECT";
    document.getElementById("hq-sub").textContent = `bureaux + entrepôt · ${keys.length} équipes · ${pend.length} colis en cours`;

    hq.labels.forEach((l) => {
      const a = A[l.r.k];
      const st = a ? ST[a.s] : ST.meet;
      l.el.innerHTML = `<span class="ic">${l.r.ic}</span><span class="tx"><b>${esc(l.r.name)}</b><span class="st"><i style="background:${st.c}"></i>${esc(a ? a.line : st.t)}</span></span>`;
      l.el.style.setProperty("--c", st.c);
      l.el.classList.toggle("hot", !!a && a.s !== "ok");
    });
    // qui est à son bureau : plus il y a de travail, plus il y a de monde
    if (hq.ok) {
      if (!hq.mScreenA) { hq.mScreenA = new THREE.MeshBasicMaterial({ color: 0x7fd0ff }); hq.mScreenB = new THREE.MeshBasicMaterial({ color: 0xffb36b }); }
      const busy = (k) => (A[k] ? (A[k].s === "ok" ? 1 : Math.min(4, 1 + A[k].n)) : 0);
      hq.beltCount = Math.max(2, Math.min(12, (A.emballage?.n ?? 0) + (A.reception?.n ?? 0) + (A.quai?.n ?? 0)));
      hq.beltSpeed = hq.beltCount > 6 ? 1.4 : 1;
      hq.seated.forEach((s) => { if (A[s.room]) s.g.visible = s.i < busy(s.room); });
      hq.monitors.forEach((m) => { m.on = !!A[m.room] && m.i < busy(m.room); m.m.material = m.on ? hq.mScreenA : new THREE.MeshStandardMaterial({ color: 0x0a0b0d, roughness: 0.3 }); });
    }
    renderLog(A);
    if (hq.sel) select(hq.sel, true);
  }

  // Journal du QG : ce que les agents viennent de faire
  function renderLog(A) {
    const lines = [];
    const t = (d) => new Date(d ?? Date.now()).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
    (state.dash?.recentActivity ?? []).slice(0, 4).forEach((a) => lines.push([a.timestamp, a.type === "sale_confirmed" ? "CONTRÔLE" : "ANNONCES", a.type === "sale_confirmed" ? "nouvelle vente reçue, vérification du stock Temu" : "annonce publiée sur Leboncoin"]));
    (state.convs ?? []).slice(0, 2).forEach((c) => lines.push([c.lastAt, "SERVICE CLIENT", c.needsYou ? `${c.buyerName ?? "un acheteur"} attend ta réponse` : `réponse automatique à ${c.buyerName ?? "un acheteur"}`]));
    if (A.achats.n) lines.push([Date.now(), "ACHATS TEMU", `${A.achats.n} commande${A.achats.n > 1 ? "s" : ""} prête${A.achats.n > 1 ? "s" : ""}, en attente de ta validation`]);
    if (A.etiquetage.n) lines.push([Date.now(), "ÉTIQUETAGE", `en attente de ${A.etiquetage.n} numéro${A.etiquetage.n > 1 ? "s" : ""} de suivi Temu`]);
    if (A.quai.n) lines.push([Date.now(), "QUAI", `${A.quai.n} colis en route vers les acheteurs`]);
    hq.log.forEach((l) => lines.push(l));
    lines.sort((a, b) => new Date(b[0]) - new Date(a[0]));
    document.getElementById("hq-log").innerHTML = lines.slice(0, 7).map(([d, who, what]) =>
      `<div class="hq-ln"><span class="tm">${t(d)}</span><b>${esc(who)}</b> ${esc(what)}</div>`).join("") || '<div class="hq-ln">Le QG attend sa première mission…</div>';
  }

  // Détail d'un agent
  function select(k, keep = false) {
    const r = ROOMS.find((x) => x.k === k);
    const panel = document.getElementById("hq-panel");
    if (!r || (!keep && hq.sel === k)) { hq.sel = null; panel.classList.remove("show"); return; }
    hq.sel = k;
    const { A } = agents();
    const a = A[k], st = a ? ST[a.s] : ST.meet;
    panel.innerHTML = `<button class="x" onclick="hqSelect('${k}')">✕</button>
      <div class="hd"><span class="ic">${r.ic}</span><div><b>${esc(r.name)}</b><div class="st"><i style="background:${st.c}"></i>${esc(st.t)}</div></div></div>
      ${ROLE[k] ? `<p>${esc(ROLE[k])}</p>` : "<p>Une pièce pour souffler entre deux missions.</p>"}
      ${a ? `<div class="now">${esc(a.line)}</div>` : ""}
      ${r.page ? `<button class="btn primary" onclick="go('${r.page}')">Ouvrir « ${esc((typeof TITLES !== "undefined" && TITLES[r.page]) || r.name)} » →</button>` : ""}`;
    panel.classList.add("show");
  }

  // « Écris au Boss » : une mission en mots → la bonne page
  const ROUTES = [
    [/command|temu|achat|panier/, "temu", "ACHATS TEMU", "je m'occupe des commandes Temu"],
    [/suivi|etiquet|exp[ée]di/, "temu", "ÉTIQUETAGE", "je récupère les numéros de suivi"],
    [/emball|colis|prepa/, "temu", "EMBALLAGE", "je regarde les colis en préparation"],
    [/stock|rayon/, "listings", "STOCK", "j'ouvre les articles en rayon"],
    [/livr|quai|camion/, "sales", "QUAI", "je suis les colis en route"],
    [/vente|valid/, "sales", "CONTRÔLE", "je vérifie les ventes"],
    [/message|acheteur|r[ée]pon|client/, "messages", "SERVICE CLIENT", "je regarde les messages"],
    [/factur|avoir/, "facturation", "FACTURATION", "je prépare les factures"],
    [/urssaf|d[ée]clar/, "facturation", "URSSAF", "je prépare la déclaration"],
    [/rapport|bilan|semaine|mois/, "reports", "RAPPORTS", "j'ouvre le rapport financier"],
    [/compta|b[ée]n[ée]fice|chiffre/, "compta", "COMPTABILITÉ", "j'ouvre la comptabilité"],
    [/retrait|argent|tr[ée]so|compte/, "accounts", "TRÉSORERIE", "je regarde l'argent des comptes"],
    [/annonce|publi|poster/, "listings", "ANNONCES", "j'ouvre les annonces"],
    [/niche|produit|vend pas|marche/, "products", "RECHERCHE NICHES", "j'analyse les produits"],
    [/entrep|warehouse|d[ée]fi|objectif/, "warehouse", "BOSS", "direction l'entrepôt"],
  ];
  function mission(text) {
    const q = String(text ?? "").trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
    if (!q) { openTasks(); return; }
    const hit = ROUTES.find(([re]) => re.test(q));
    if (!hit) { toast("🤔 Mission pas comprise. Essaie : « commandes », « suivis », « factures », « rapport »…"); return; }
    hq.log.push([Date.now(), hit[2], `mission du Boss : ${hit[3]}`]);
    toast(`👑 ${hit[2]} : ${hit[3]}`);
    renderLog(agents().A);
    setTimeout(() => go(hit[1]), 650);
  }

  // ── Branchement sur la page ─────────────────────────────────────────────────
  window.hqSelect = (k) => select(k);
  window.hqOpen = () => { init(); setTimeout(() => { size(); update(); }, 30); };
  window.hqUpdate = () => { if (document.getElementById("hq-stats")) update(); };
  window.hqZoom = (f) => zoom(f);
  window.hqRecenter = recenter;
  window.addEventListener("resize", () => { if (view === "warehouse") size(); });
  // La page a pu ouvrir Tyno Warehouse avant le chargement de ce fichier
  if (typeof view !== "undefined" && view === "warehouse") window.hqOpen();
  const form = document.getElementById("hq-cmd");
  if (form) form.onsubmit = (e) => { e.preventDefault(); const i = document.getElementById("hq-in"); mission(i.value); i.value = ""; };
  const mb = document.getElementById("hq-mission");
  if (mb) mb.onclick = () => { const i = document.getElementById("hq-in"); mission(i.value); i.value = ""; };
})();
