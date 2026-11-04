"use strict";

// ─── Config ──────────────────────────────────────────────────────────────────

function getApiBase() {
  return (localStorage.getItem("tyno_api_url") || "").replace(/\/$/, "");
}

// ─── Mock data (shown with DÉMO badge when API unreachable) ───────────────────

const MOCK = {
  dashboard: {
    activeSales: 7,
    caDuJour: 234.50,
    margeNette: 87.20,
    jobsPending: 2,
    lastSales: [
      { title: "Chargeur USB-C 65W", price: 24.90, status: "order_placed", date: "2026-11-04T07:30:00Z" },
      { title: "Organisateur tiroir", price: 18.90, status: "confirmed",   date: "2026-11-04T06:10:00Z" },
      { title: "Support téléphone voiture", price: 15.90, status: "shipped", date: "2026-11-03T22:45:00Z" },
      { title: "Cache-pot décoratif", price: 21.50, status: "confirmed",   date: "2026-11-03T20:15:00Z" },
      { title: "Lampe bureau LED", price: 32.00, status: "order_placed",  date: "2026-11-03T18:00:00Z" },
    ],
  },
  sales: [
    { saleId: "s1", title: "Chargeur USB-C", price: 24.90, status: "order_placed", city: "Lyon",  date: "2026-11-04T07:30:00Z" },
    { saleId: "s2", title: "Organisateur", price: 18.90, status: "confirmed",   city: "Paris", date: "2026-11-04T06:10:00Z" },
    { saleId: "s3", title: "Support voiture", price: 15.90, status: "shipped", city: "Nantes", date: "2026-11-03T22:45:00Z" },
    { saleId: "s4", title: "Cache-pot", price: 21.50, status: "confirmed",   city: "Toulouse", date: "2026-11-03T20:15:00Z" },
    { saleId: "s5", title: "Lampe LED", price: 32.00, status: "order_placed",city: "Bordeaux", date: "2026-11-03T18:00:00Z" },
  ],
  products: [
    { temuItemId: "p1", title: "Chargeur USB-C 65W GaN", costEur: 6.20, imageUrls: [] },
    { temuItemId: "p2", title: "Organisateur tiroir bambou", costEur: 4.80, imageUrls: [] },
    { temuItemId: "p3", title: "Support téléphone voiture magnétique", costEur: 3.90, imageUrls: [] },
    { temuItemId: "p4", title: "Cache-pot céramique décoratif", costEur: 5.30, imageUrls: [] },
    { temuItemId: "p5", title: "Lampe bureau LED tactile", costEur: 7.90, imageUrls: [] },
    { temuItemId: "p6", title: "Coussin lombaire ergonomique", costEur: 8.50, imageUrls: [] },
  ],
  listings: [
    { listingId: "l1", title: "Chargeur USB-C 65W GaN",   channel: "leboncoin", accountId: "acc1", priceEur: 24.90, status: "active",  updatedAt: "2026-11-04T07:00:00Z" },
    { listingId: "l2", title: "Organisateur tiroir bambou", channel: "vinted", accountId: "acc2", priceEur: 18.90, status: "draft",   updatedAt: "2026-11-03T16:00:00Z" },
    { listingId: "l3", title: "Support voiture magnétique", channel: "leboncoin", accountId: "acc1", priceEur: 15.90, status: "active",  updatedAt: "2026-11-03T12:00:00Z" },
  ],
  messages: [
    { id: 1, listingId: "l1", buyerName: "Paul M.", message: "Bonjour, est-ce disponible en noir ?", receivedAt: "2026-11-04T08:15:00Z" },
    { id: 2, listingId: "l3", buyerName: "Sophie K.", message: "Peut-on négocier à 12€ ?", receivedAt: "2026-11-04T07:45:00Z" },
  ],
  agents: [
    { name: "Job Runner",      status: "active", lastActivity: "2026-11-04T08:20:00Z", jobsProcessed: 142 },
    { name: "Photo Pipeline",  status: "idle",   lastActivity: "2026-11-04T06:00:00Z", jobsProcessed: 38  },
    { name: "Tracking Sync",   status: "idle",   lastActivity: "2026-11-04T02:00:00Z", jobsProcessed: 12  },
    { name: "Scheduler Nuit",  status: "active", lastActivity: "2026-11-04T07:00:00Z", jobsProcessed: 56  },
  ],
};

// ─── API ──────────────────────────────────────────────────────────────────────

async function apiFetch(path) {
  const base = getApiBase();
  if (!base) return { ok: false, demo: true };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const r = await fetch(`${base}${path}`, { signal: ctrl.signal });
    if (!r.ok) return { ok: false, status: r.status };
    const d = await r.json();
    return { ok: true, data: d };
  } catch (e) {
    return { ok: false, demo: true };
  } finally {
    clearTimeout(timer);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const fmtParis = (iso) =>
  new Intl.DateTimeFormat("fr-FR", { timeZone: "Europe/Paris", dateStyle: "short", timeStyle: "short" }).format(new Date(iso));

const fmtEur = (n) =>
  new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" }).format(n);

function statusBadge(s) {
  const labels = { draft: "Brouillon", active: "Actif", order_placed: "Commandé", shipped: "Expédié", failed: "Échoué", confirmed: "Confirmé" };
  return `<span class="status-badge s-${s}">${labels[s] ?? s}</span>`;
}

function showDemo(id, show) {
  const el = document.getElementById(`demo-badge-${id}`);
  if (el) el.style.display = show ? "" : "none";
}

// ─── Navigation SPA ──────────────────────────────────────────────────────────

const SECTION_TITLES = {
  dashboard: "Dashboard", ventes: "Ventes", produits: "Produits", annonces: "Annonces",
  messages: "Messages", agents: "Agents", nuit: "Nuit", parametres: "Paramètres",
};

function showSection(name) {
  document.querySelectorAll(".section").forEach(s => s.classList.remove("active"));
  document.querySelectorAll(".nav-item").forEach(n => n.classList.remove("active"));

  const sec = document.getElementById(`sec-${name}`);
  if (sec) sec.classList.add("active");

  const nav = document.querySelector(`.nav-item[data-section="${name}"]`);
  if (nav) nav.classList.add("active");

  const titleEl = document.getElementById("header-title");
  if (titleEl) titleEl.textContent = SECTION_TITLES[name] ?? name;

  loadSection(name);
}

document.querySelectorAll(".nav-item").forEach(item => {
  item.addEventListener("click", (e) => {
    e.preventDefault();
    const sec = item.dataset.section;
    history.replaceState(null, "", `#${sec}`);
    showSection(sec);
  });
});

document.getElementById("sidebar-toggle")?.addEventListener("click", () => {
  document.getElementById("sidebar").classList.toggle("collapsed");
});

// ─── Clock ────────────────────────────────────────────────────────────────────

function updateClock() {
  const el = document.getElementById("header-time");
  if (!el) return;
  el.textContent = new Intl.DateTimeFormat("fr-FR", {
    timeZone: "Europe/Paris", weekday: "short", day: "2-digit", month: "short",
    hour: "2-digit", minute: "2-digit",
  }).format(new Date());
}
updateClock();
setInterval(updateClock, 10_000);

// ─── API status ───────────────────────────────────────────────────────────────

async function checkApiStatus() {
  const dot = document.getElementById("status-dot");
  const lbl = document.getElementById("status-label");
  const res = await apiFetch("/api/dashboard");
  if (res.ok) {
    dot.className = "status-dot ok"; lbl.textContent = "API connectée";
  } else if (res.demo) {
    dot.className = "status-dot"; lbl.textContent = "API non configurée";
  } else {
    dot.className = "status-dot error"; lbl.textContent = `Erreur ${res.status ?? ""}`;
  }
}
checkApiStatus();
setInterval(checkApiStatus, 60_000);

// ─── Section loaders ──────────────────────────────────────────────────────────

async function loadSection(name) {
  if (name === "dashboard") return loadDashboard();
  if (name === "ventes")    return loadVentes();
  if (name === "produits")  return loadProduits();
  if (name === "annonces")  return loadAnnonces();
  if (name === "messages")  return loadMessages();
  if (name === "agents")    return loadAgents();
  if (name === "nuit")      return loadNuit();
  if (name === "parametres")return loadParametres();
}

// ── Dashboard ─────────────────────────────────────────────────────────────────

async function loadDashboard() {
  const res = await apiFetch("/api/dashboard");
  const isDemo = !res.ok;
  const d = res.ok ? res.data : MOCK.dashboard;
  showDemo("dash", isDemo);

  document.getElementById("kv-ventes").textContent = d.activeSales ?? "—";
  document.getElementById("kv-ca").textContent = d.caDuJour != null ? fmtEur(d.caDuJour) : "—";
  document.getElementById("kv-marge").textContent = d.margeNette != null ? fmtEur(d.margeNette) : "—";
  document.getElementById("kv-jobs").textContent = d.jobsPending ?? "—";

  const tbody = document.getElementById("dash-sales-body");
  const sales = d.lastSales ?? d.activeSales ?? [];
  if (!Array.isArray(sales) || !sales.length) {
    tbody.innerHTML = `<tr><td colspan="4" class="loading">Aucune vente récente</td></tr>`;
    return;
  }
  tbody.innerHTML = sales.map(s => `
    <tr>
      <td>${s.title ?? s.productTitle ?? "—"}</td>
      <td>${s.price != null ? fmtEur(s.price) : s.salePriceEur != null ? fmtEur(s.salePriceEur) : "—"}</td>
      <td>${statusBadge(s.status)}</td>
      <td>${s.date ? fmtParis(s.date) : s.confirmedAt ? fmtParis(s.confirmedAt) : "—"}</td>
    </tr>`).join("");

  const agRes = await apiFetch("/api/agents/status");
  const agents = agRes.ok ? (agRes.data.agents ?? []) : MOCK.agents;
  renderAgentsMini(document.getElementById("agents-status-dash"), agents);
}

function renderAgentsMini(container, agents) {
  if (!container) return;
  container.innerHTML = agents.map(a => `
    <div class="agent-item">
      <div class="agent-dot ${a.status}"></div>
      <div>
        <div class="agent-name">${a.name}</div>
        <div class="agent-info">${a.jobsProcessed ?? 0} jobs — dernier: ${a.lastActivity ? fmtParis(a.lastActivity) : "—"}</div>
      </div>
    </div>`).join("");
}

// ── Ventes ────────────────────────────────────────────────────────────────────

let _ventesAll = [], _ventesPage = 0;
const VENTES_PER_PAGE = 15;

async function loadVentes() {
  const res = await apiFetch("/api/sales");
  const isDemo = !res.ok;
  _ventesAll = res.ok ? (res.data.sales ?? res.data ?? []) : MOCK.sales;
  showDemo("ventes", isDemo);
  _ventesPage = 0;
  renderVentesPage();
}

function renderVentesPage() {
  const start = _ventesPage * VENTES_PER_PAGE;
  const page = _ventesAll.slice(start, start + VENTES_PER_PAGE);
  const total = _ventesAll.length;
  const tbody = document.getElementById("ventes-body");

  document.getElementById("ventes-page-info").textContent =
    `${start + 1}–${Math.min(start + VENTES_PER_PAGE, total)} / ${total}`;
  document.getElementById("ventes-prev").disabled = _ventesPage === 0;
  document.getElementById("ventes-next").disabled = start + VENTES_PER_PAGE >= total;

  tbody.innerHTML = page.length ? page.map(s => `
    <tr>
      <td>${s.title ?? s.productTitle ?? "—"}</td>
      <td>${s.price != null ? fmtEur(s.price) : s.salePriceEur != null ? fmtEur(s.salePriceEur) : "—"}</td>
      <td>${statusBadge(s.status)}</td>
      <td>${s.city ?? s.deliveryCity ?? "—"}</td>
      <td>${s.date ? fmtParis(s.date) : s.confirmedAt ? fmtParis(s.confirmedAt) : "—"}</td>
      <td>
        <button class="btn-action" onclick="alert('Détail: ${s.saleId ?? s.sale_id ?? ""}')">Voir</button>
        <button class="btn-action" onclick="alert('Suivi: ${s.saleId ?? s.sale_id ?? ""}')">Suivi</button>
      </td>
    </tr>`).join("")
  : `<tr><td colspan="6" class="loading">Aucune vente</td></tr>`;
}

document.getElementById("ventes-prev")?.addEventListener("click", () => { _ventesPage--; renderVentesPage(); });
document.getElementById("ventes-next")?.addEventListener("click", () => { _ventesPage++; renderVentesPage(); });

// ── Produits ──────────────────────────────────────────────────────────────────

async function loadProduits() {
  const res = await apiFetch("/api/products");
  const isDemo = !res.ok;
  const products = res.ok ? (res.data.products ?? res.data ?? []) : MOCK.products;
  showDemo("produits", isDemo);

  const grid = document.getElementById("produits-grid");
  grid.innerHTML = products.length ? products.map(p => {
    const img = Array.isArray(p.imageUrls) && p.imageUrls[0]
      ? `<img class="product-img" src="${p.imageUrls[0]}" alt="${p.title}" loading="lazy">`
      : `<div class="product-img-placeholder">📦</div>`;
    return `
      <div class="product-card">
        ${img}
        <div class="product-info">
          <div class="product-title" title="${p.title}">${p.title}</div>
          <div class="product-cost">Coût: ${p.costEur != null ? fmtEur(p.costEur) : p.cost_eur_cents != null ? fmtEur(p.cost_eur_cents / 100) : "—"}</div>
          <div class="product-actions">
            <button class="btn-primary" style="font-size:12px;padding:5px 10px" onclick="alert('Annonce: ${p.temuItemId ?? p.temu_item_id ?? ""}')">+ Annonce</button>
          </div>
        </div>
      </div>`;
  }).join("") : `<div class="loading">Aucun produit</div>`;
}

// ── Annonces ──────────────────────────────────────────────────────────────────

async function loadAnnonces() {
  const res = await apiFetch("/api/listings");
  const isDemo = !res.ok;
  const listings = res.ok ? (res.data.listings ?? res.data ?? []) : MOCK.listings;
  showDemo("annonces", isDemo);

  const tbody = document.getElementById("annonces-body");
  tbody.innerHTML = listings.length ? listings.map(l => `
    <tr>
      <td>${l.title ?? "—"}</td>
      <td>${l.channel ?? "—"}</td>
      <td>${l.accountId ?? l.account_id ?? "—"}</td>
      <td>${l.priceEur != null ? fmtEur(l.priceEur) : l.price_eur_cents != null ? fmtEur(l.price_eur_cents / 100) : "—"}</td>
      <td>${statusBadge(l.status)}</td>
      <td>${l.updatedAt ? fmtParis(l.updatedAt) : l.updated_at ? fmtParis(l.updated_at) : "—"}</td>
      <td>
        <button class="btn-action" onclick="alert('Bump: ${l.listingId ?? l.listing_id ?? ""}')">⬆ Bump</button>
        <button class="btn-action" onclick="alert('Désactiver: ${l.listingId ?? l.listing_id ?? ""}')">✕</button>
      </td>
    </tr>`).join("")
  : `<tr><td colspan="7" class="loading">Aucune annonce</td></tr>`;
}

// ── Messages ──────────────────────────────────────────────────────────────────

async function loadMessages() {
  const res = await apiFetch("/api/messages/unread");
  const isDemo = !res.ok;
  const msgs = res.ok ? (res.data.messages ?? res.data ?? []) : MOCK.messages;
  showDemo("messages", isDemo);

  const list = document.getElementById("messages-list");
  const badge = document.getElementById("badge-messages");
  badge.textContent = msgs.length > 0 ? String(msgs.length) : "";

  list.innerHTML = msgs.length ? msgs.map(m => `
    <div class="message-item">
      <div class="message-header">
        <span class="message-buyer">${m.buyerName ?? m.buyer_name ?? "Inconnu"}</span>
        <span class="message-date">${m.receivedAt ? fmtParis(m.receivedAt) : m.received_at ? fmtParis(m.received_at) : "—"}</span>
      </div>
      <div class="message-text">${m.message}</div>
      <div class="message-actions">
        <button class="btn-primary" style="font-size:12px;padding:5px 12px" onclick="alert('Réponse auto: ${m.id ?? ""}')">Répondre auto</button>
      </div>
    </div>`).join("")
  : `<div class="card"><div class="loading">Aucun message non lu</div></div>`;
}

// ── Agents ────────────────────────────────────────────────────────────────────

async function loadAgents() {
  const res = await apiFetch("/api/agents/status");
  const isDemo = !res.ok;
  const agents = res.ok ? (res.data.agents ?? []) : MOCK.agents;
  showDemo("agents", isDemo);

  const list = document.getElementById("agents-list");
  list.innerHTML = agents.map(a => `
    <div class="agent-item" style="flex-direction:column;align-items:flex-start;gap:6px">
      <div style="display:flex;align-items:center;gap:10px">
        <div class="agent-dot ${a.status}"></div>
        <span class="agent-name">${a.name}</span>
        ${statusBadge(a.status)}
      </div>
      <div class="agent-info">
        Jobs traités: <strong>${a.jobsProcessed ?? 0}</strong>
        — Dernier: ${a.lastActivity ? fmtParis(a.lastActivity) : "—"}
      </div>
    </div>`).join("");
}

// ── Nuit ──────────────────────────────────────────────────────────────────────

function nextNuitExec() {
  const now = new Date();
  const paris = new Intl.DateTimeFormat("fr-FR", {
    timeZone: "Europe/Paris", hour: "numeric", hour12: false,
  }).format(now);
  const hour = parseInt(paris, 10);
  const isNocturnal = hour >= 22 || hour < 8;
  if (isNocturnal) return "Maintenant (plage active)";
  const next = new Date(now);
  next.setHours(22, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return fmtParis(next.toISOString());
}

function loadNuit() {
  document.getElementById("nuit-next").textContent = nextNuitExec();
  document.getElementById("nuit-bumps").textContent = "— (données en direct non disponibles)";

  const toggle = document.getElementById("nuit-toggle");
  toggle.checked = localStorage.getItem("tyno_nuit_enabled") === "1";
  toggle.addEventListener("change", () => {
    localStorage.setItem("tyno_nuit_enabled", toggle.checked ? "1" : "0");
    document.getElementById("nuit-next").textContent = toggle.checked ? nextNuitExec() : "Désactivé";
  });
}

// ── Paramètres ────────────────────────────────────────────────────────────────

function loadParametres() {
  const urlInput = document.getElementById("param-api-url");
  if (urlInput) urlInput.value = localStorage.getItem("tyno_api_url") || "";
}

document.getElementById("btn-save-params")?.addEventListener("click", () => {
  const url = document.getElementById("param-api-url").value.trim();
  localStorage.setItem("tyno_api_url", url);
  const r = document.getElementById("conn-result");
  r.className = "ok"; r.textContent = "✓ Enregistré";
  setTimeout(() => { r.textContent = ""; }, 3000);
  checkApiStatus();
});

document.getElementById("btn-test-conn")?.addEventListener("click", async () => {
  const r = document.getElementById("conn-result");
  r.className = ""; r.textContent = "Test en cours…";
  const res = await apiFetch("/api/dashboard");
  if (res.ok) {
    r.className = "ok"; r.textContent = "✓ Connexion OK";
  } else if (res.demo) {
    r.className = "err"; r.textContent = "✗ URL non configurée";
  } else {
    r.className = "err"; r.textContent = `✗ Erreur ${res.status ?? "réseau"}`;
  }
});

// ─── Export CSV ───────────────────────────────────────────────────────────────

document.getElementById("btn-export-csv")?.addEventListener("click", () => {
  const apiUrl = localStorage.getItem("tyno_api_url") || "";
  if (!apiUrl) { alert("Configure d'abord l'URL API dans les Paramètres."); return; }
  const today = new Date().toISOString().slice(0, 10);
  const from  = new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10);
  window.open(`${apiUrl}/api/export/sales?from=${from}&to=${today}`, "_blank");
});

// ─── Pause globale ────────────────────────────────────────────────────────────

document.getElementById("btn-pause-toggle")?.addEventListener("click", async () => {
  const btn = document.getElementById("btn-pause-toggle");
  const paused = btn.dataset.paused === "1";
  const res = await apiFetch("/api/system/pause", "POST", { pause: !paused });
  if (res.ok) {
    btn.dataset.paused = paused ? "0" : "1";
    btn.textContent = paused ? "⏸ Mettre en pause" : "▶ Reprendre";
    btn.className = paused ? "btn btn-warning" : "btn btn-success";
  }
});

async function loadSystemStatus() {
  const res = await apiFetch("/status");
  if (!res.ok || res.demo) return;
  const d = res.data ?? res;
  const el = document.getElementById("system-status-bar");
  if (!el) return;
  el.innerHTML = [
    `<span class="badge ${d.jobs?.failedToday > 0 ? 'badge-err' : 'badge-ok'}">Jobs échoués: ${d.jobs?.failedToday ?? 0}</span>`,
    `<span class="badge badge-info">En attente: ${d.jobs?.pending ?? 0}</span>`,
    `<span class="badge badge-info">Messages: ${d.messages?.unread ?? 0} non lus</span>`,
    `<span class="badge badge-ok">Uptime: ${Math.floor((d.uptime ?? 0) / 60)}min</span>`,
  ].join(" ");
}

// ─── Auto-refresh Dashboard ───────────────────────────────────────────────────

setInterval(() => {
  const active = document.querySelector(".nav-item.active")?.dataset?.section;
  if (active === "dashboard") { loadDashboard(); loadSystemStatus(); }
}, 30_000);

// ─── Init ─────────────────────────────────────────────────────────────────────

(function init() {
  const hash = location.hash.replace("#", "") || "dashboard";
  showSection(SECTION_TITLES[hash] ? hash : "dashboard");
  loadSystemStatus();
})();
