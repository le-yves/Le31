/* LE 31 — appli téléphone — V1.0
   Données : Google Sheet via Google Apps Script. Lien d'accès à usage unique (#inv=CODE&api=URL /exec) échangé contre
   un jeton propre à l'appareil. Chacun voit le compte commun et son compte perso. config.js (apiUrl) facultatif. */
'use strict';
const APP_VERSION = '2.2';

/* ================= Barème impôt (à mettre à jour chaque année) =================
   Barème 2026 sur les revenus 2025, par part. Plafond quotient familial : 1 807 € par demi-part.
   Décote : seuils 1 982 € (seul) / 3 277 € (couple), formules 897 € / 1 483 € − 45,25 % de l'impôt. */
const IMPOT = {
  annee: 'Barème 2026 (revenus 2025)',
  tranches: [[11600, 0], [29579, .11], [84577, .30], [181917, .41], [Infinity, .45]],
  plafondDemiPart: 1807,
  decote: { seul: [1982, 897], couple: [3277, 1483], taux: .4525 }
};

/* ================= Outils ================= */
const MONTHS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];
const MONTHS_L = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
const FREQ = { M: 'Mensuel', T: 'Trimestriel', A: 'Annuel' };
const $ = id => document.getElementById(id);
const pad = n => String(n).padStart(2, '0');
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = v => { if (v === '' || v == null) return null; const n = parseFloat(String(v).replace(/\s/g, '').replace(',', '.')); return isNaN(n) ? null : n; };
const bool = v => v === true || /^(oui|true|vrai|1)$/i.test(String(v || '').trim());
const r2 = v => Math.round(v * 100) / 100;
const eur = v => (v || 0).toLocaleString('fr-FR', { style: 'currency', currency: 'EUR', minimumFractionDigits: Math.abs((v || 0) % 1) > 0.004 ? 2 : 0, maximumFractionDigits: 2 });
const eur0 = v => Math.round(v || 0).toLocaleString('fr-FR', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
const sgn = v => (v > 0.004 ? '+' : v < -0.004 ? '−' : '') + eur(Math.abs(v));
const fr = v => String(v == null ? '' : v).replace('.', ',');
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
};
// Mois au format AAAA-MM
const mk = (y, m) => y + '-' + pad(m + 1);
const pm = k => ({ y: +k.slice(0, 4), m: +k.slice(5, 7) - 1 });
const addM = (k, n) => { const { y, m } = pm(k); const t = y * 12 + m + n; return mk(Math.floor(t / 12), t % 12); };
const diffM = (a, b) => { const A = pm(a), B = pm(b); return (B.y * 12 + B.m) - (A.y * 12 + A.m); };
const dim = k => { const { y, m } = pm(k); return new Date(y, m + 1, 0).getDate(); };
const mLabel = k => { const { y, m } = pm(k); return MONTHS_L[m] + ' ' + y; };
const deMois = k => { const n = MONTHS_L[pm(k).m]; return (/^[aeiou]/.test(n) ? "d'" : 'de ') + n; };
const mShort = k => { const { y, m } = pm(k); return MONTHS[m]; };
let CUR, TODAY, TODAY_ISO;
function refreshNow() {
  const n = new Date();
  CUR = mk(n.getFullYear(), n.getMonth()); TODAY = n.getDate(); TODAY_ISO = CUR + '-' + pad(TODAY);
}
refreshNow();

/* ================= Connexion (lien d'accès à usage unique) ================= */
const CFG = window.LE31_CONFIG || {};
const API_RE = /^https:\/\/script\.google(usercontent)?\.com\/[^\s#]+$/;
const IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const STANDALONE = () => !!(navigator.standalone || matchMedia('(display-mode: standalone)').matches);
// Lit un lien d'accès (…#inv=CODE&api=https%3A…) : l'invitation sera échangée contre un jeton propre à cet appareil
function readLink(txt) {
  const i = /[#&?]inv=([A-Za-z0-9_-]+)/.exec(txt || ''), a = /[#&?]api=([^&#\s]+)/.exec(txt || '');
  let api = ''; try { api = a ? decodeURIComponent(a[1]) : ''; } catch (e) {}
  if (API_RE.test(api)) store.set('le31-api', api);
  if (i && i[1] !== store.get('le31-inv-faite', '')) store.set('le31-inv', i[1]);
  return !!i;
}
readLink(location.hash);
const API = () => API_RE.test(CFG.apiUrl || '') ? CFG.apiUrl : store.get('le31-api', '');
const apiOk = () => API_RE.test(API() || '');
const JETON = () => store.get('le31-jeton', '');
const INV = () => store.get('le31-inv', '');
let ME = store.get('le31-me', null);   // profil de cet appareil ('' = premier lancement pas terminé)
let JOIN = { busy: false, err: '', detail: '', iosOk: false };
function deviceName() {
  const u = navigator.userAgent;
  return /iPad/.test(u) || (IOS && !/iPhone/.test(u)) ? 'iPad' : /iPhone/.test(u) ? 'iPhone' : /Android/.test(u) ? 'Android' : /Windows/.test(u) ? 'PC Windows' : /Mac/.test(u) ? 'Mac' : 'Appareil';
}
// fetch avec délai maximum : l'appli ne reste jamais bloquée en attente
async function fetchT(url, opts, ms) {
  const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const tm = setTimeout(() => ctl && ctl.abort(), ms || 25000);
  try { return await fetch(url, Object.assign({}, opts, ctl ? { signal: ctl.signal } : {})); }
  catch (e) { const x = new Error(e && e.name === 'AbortError' ? 'delai' : 'reseau'); x.net = true; throw x; }
  finally { clearTimeout(tm); }
}
async function readJson(r) {
  const txt = await r.text();
  try { return JSON.parse(txt); } catch (e) { const x = new Error('html'); x.detail = txt.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160); throw x; }
}
async function api(body) {
  const r = await fetchT(API(), { method: 'POST', body: JSON.stringify(Object.assign({ jeton: JETON() }, body)) });
  const j = await readJson(r);
  if (!j.ok) { const x = new Error(j.erreur || 'erreur'); x.detail = j.detail; throw x; }
  return j;
}
async function join() {
  if (JOIN.busy || !INV() || !apiOk()) return;
  // Sur iPhone/iPad, l'appli installée ne voit pas ce que Safari a mémorisé : on attend qu'elle soit installée
  if (IOS && !STANDALONE() && !JOIN.iosOk) { render(); return; }
  JOIN.busy = true; JOIN.err = ''; JOIN.detail = ''; render();
  try {
    // connexion par GET (le chemin le plus simple et le plus fiable), POST pour un serveur plus ancien
    let j = await readJson(await fetchT(API() + '?action=rejoindre&inv=' + encodeURIComponent(INV()) + '&appareil=' + encodeURIComponent(deviceName()) + '&t=' + Date.now()));
    if (!j.ok && j.erreur === 'acces') j = await readJson(await fetchT(API(), { method: 'POST', body: JSON.stringify({ action: 'rejoindre', inv: INV(), appareil: deviceName() }) }));
    if (!j.ok) { const x = new Error(j.erreur || 'erreur'); x.detail = j.detail; throw x; }
    store.set('le31-inv-faite', INV()); store.set('le31-inv', '');
    store.set('le31-jeton', j.jeton); store.set('le31-acces', j.acces); QUEUE = []; store.set('le31-file', []);
    RAW = null; LOADED = false; SYNC.error = '';
    received(j.data, j.moi);
  } catch (e) {
    const m = String(e.message || e), keep = e.net || m === 'html' || m === 'serveur' || m === 'reseau';
    JOIN.err = m; JOIN.detail = e.detail || '';
    if (!keep) store.set('le31-inv', ''); // lien refusé pour de bon (déjà utilisé, expiré…)
  }
  JOIN.busy = false; render();
}

/* ================= Données ================= */
const TABS = { comptes: 'Comptes', profils: 'Profils', categories: 'Categories', fixes: 'Fixes', virements: 'Virements', operations: 'Operations', pointages: 'Pointages', clotures: 'Clotures', simulations: 'Simulations', regles: 'Regles', parametres: 'Parametres', appareils: 'Appareils', attente: 'Attente', banque: 'Banque', banqueConf: 'BanqueConf' };
const EMPTY = () => { const o = {}; for (const k in TABS) o[k] = []; return o; };
let RAW = store.get('le31-data', null);          // dernière copie reçue du serveur
let QUEUE = store.get('le31-file', []);          // modifications pas encore envoyées
let DB = EMPTY();
let LOADED = !!RAW;
let SYNC = { state: 'off', last: store.get('le31-last', 0), error: '' };

function rebuild() {
  DB = EMPTY();
  const src = RAW || {};
  for (const k in TABS) DB[k] = (src[TABS[k]] || []).map(r => Object.assign({}, r));
  QUEUE.forEach(applyLocal);
  CACHE = {};
}
function applyLocal(op) {
  const key = Object.keys(TABS).find(k => TABS[k] === op.onglet); if (!key) return;
  const idCol = key === 'parametres' ? 'cle' : 'id', arr = DB[key];
  if (op.op === 'maj') {
    const i = arr.findIndex(r => r[idCol] === op.ligne[idCol]);
    if (i >= 0) arr[i] = Object.assign({}, arr[i], op.ligne); else arr.push(Object.assign({}, op.ligne));
  } else if (op.op === 'suppr') {
    const i = arr.findIndex(r => r[idCol] === op.id); if (i >= 0) arr.splice(i, 1);
  }
}
function clean(ops) { ops.forEach(o => { if (o.ligne) for (const c in o.ligne) if (o.ligne[c] == null) o.ligne[c] = ''; else if (typeof o.ligne[c] !== 'string') o.ligne[c] = String(o.ligne[c]); }); return ops; }
// Enregistrer des modifications : appliquées tout de suite, envoyées au Sheet aussitôt
function commit(ops) {
  clean(ops);
  QUEUE.push(...ops); store.set('le31-file', QUEUE);
  ops.forEach(applyLocal); CACHE = {};
  render(); flush();
}
const upd = (onglet, ligne) => ({ op: 'maj', onglet, ligne });
const del = (onglet, id) => ({ op: 'suppr', onglet, id });
const isAccessErr = e => e === 'acces';

let flushing = false, flushTimer = null;
async function flush() {
  if (flushing || !QUEUE.length || !apiOk() || !JETON()) { setSync(); return; }
  flushing = true; setSync('wait');
  const batch = QUEUE.slice();
  try {
    const j = await api({ action: 'ops', ops: batch }); if (j.acces) store.set('le31-acces', j.acces); if (j.v) SYNC.v = j.v;
    QUEUE = QUEUE.slice(batch.length); store.set('le31-file', QUEUE);
    received(j.data, j.moi);
  } catch (e) {
    SYNC.error = String(e.message || e);
    if (isAccessErr(SYNC.error)) { flushing = false; setSync('err'); render(); return; }
    clearTimeout(flushTimer); flushTimer = setTimeout(flush, 8000); // nouvel essai dans 8 s
    setSync('off');
    flushing = false;
    return;
  }
  flushing = false;
  if (QUEUE.length) flush();
}
let pulling = false;
async function pull() {
  if (pulling || !apiOk() || !JETON()) return;
  if (QUEUE.length) return flush();
  pulling = true;
  try {
    const r = await fetchT(API() + '?action=tout&jeton=' + encodeURIComponent(JETON()) + '&t=' + Date.now());
    const j = await readJson(r);
    if (!j.ok) throw new Error(j.erreur || 'erreur');
    if (j.acces) store.set('le31-acces', j.acces); if (j.v) SYNC.v = j.v;
    if (!QUEUE.length) received(j.data, j.moi);
  } catch (e) {
    SYNC.error = String(e.message || e);
    setSync(isAccessErr(SYNC.error) ? 'err' : 'off');
    if (isAccessErr(SYNC.error) || !LOADED) render();
  }
  pulling = false;
}
function received(data, moi) {
  const before = JSON.stringify(RAW) + ME;
  RAW = data; store.set('le31-data', RAW);
  if (moi != null) { ME = moi; store.set('le31-me', ME); }
  SYNC.last = Date.now(); store.set('le31-last', SYNC.last); SYNC.error = '';
  const first = !LOADED; LOADED = true;
  rebuild(); setSync();
  ensurePerso();
  setTimeout(bankAuto, 0);
  if (first || before !== JSON.stringify(RAW) + ME) {
    // ne pas re-dessiner pendant qu'on tape dans un champ
    const a = document.activeElement;
    if (!a || !/INPUT|SELECT|TEXTAREA/.test(a.tagName) || first) render();
  }
}
function setSync(s) {
  if (s) SYNC.state = s; else SYNC.state = QUEUE.length ? (navigator.onLine === false ? 'off' : 'wait') : (SYNC.error ? (isAccessErr(SYNC.error) ? 'err' : 'off') : 'ok');
  const d = $('syncDot'); if (!d) return;
  d.className = 'sync' + (SYNC.state === 'ok' ? '' : ' ' + SYNC.state);
  d.title = { ok: 'Synchronisé', wait: 'Envoi en cours…', off: 'Hors ligne : les saisies seront envoyées au retour du réseau', err: 'Accès coupé' }[SYNC.state];
}

/* ================= Accès aux données ================= */
let CACHE = {};
const accRank = a => a.proprietaire === ME ? 0 : !a.proprietaire ? 1 : 2;
const accs = () => DB.comptes.slice().sort((a, b) => accRank(a) - accRank(b) || (num(a.ordre) || 0) - (num(b.ordre) || 0));
const accOf = id => DB.comptes.find(a => a.id === id) || { id, nom: id };
const accName = id => { const a = DB.comptes.find(x => x.id === id); if (a) return a.nom || id; const m = /^perso-(.+)$/.exec(id || ''); return m ? 'Perso ' + (pname(m[1]) || '') : id; };
const isShared = acc => !accOf(acc).proprietaire && DB.profils.length > 1;
const otherNames = () => DB.profils.filter(p => p.id !== ME).map(p => p.nom).join(', ');
const otherAcc = id => (accs().find(a => a.id !== id) || {}).id;
const profiles = () => DB.profils.slice().sort((a, b) => (num(a.ordre) || 0) - (num(b.ordre) || 0));
const pname = id => (DB.profils.find(p => p.id === id) || {}).nom || '';
// Sous-catégories : le nom complet est « Parent › Sous-catégorie » (ex. « Véhicule › Carburant »)
const SEP = ' › ';
const topOf = n => String(n || '').split(SEP)[0];
const leafOf = n => { n = String(n || ''); const i = n.lastIndexOf(SEP); return i < 0 ? n : n.slice(i + SEP.length); };
const inCat = (c, P) => (c || '') === P || String(c || '').startsWith(P + SEP);
const normCat = s => String(s || '').replace(/\s*(›|>|\/)\s*/g, SEP).replace(/\s+/g, ' ').trim();
const catHtml = n => n && n.includes(SEP) ? `<span class="cpar">${esc(topOf(n))} › </span>${esc(leafOf(n))}` : esc(n);
const catsOf = acc => {
  const l = DB.categories.filter(c => c.compte === acc), o = n => { const t = l.find(x => x.nom === topOf(n)); return num((t || {}).ordre) || 0; };
  return l.sort((a, b) => o(a.nom) - o(b.nom) || topOf(a.nom).localeCompare(topOf(b.nom)) || (a.nom.includes(SEP) ? 1 : 0) - (b.nom.includes(SEP) ? 1 : 0) || (num(a.ordre) || 0) - (num(b.ordre) || 0));
};
// une catégorie proposée (« Carburant ») déplacée sous un parent (« Véhicule › Carburant ») garde sa place
function resolveCat(acc, c) {
  if (!c || catsOf(acc).some(x => x.nom === c)) return c;
  const m = catsOf(acc).find(x => x.nom.includes(SEP) && leafOf(x.nom).toLowerCase() === c.toLowerCase());
  return m ? m.nom : c;
}
// opérations pour créer une catégorie (et son parent s'il n'existe pas)
function newCatOps(acc, nom, have) {
  have = have || new Set(catsOf(acc).map(c => c.nom.toLowerCase()));
  const ops = []; let ordre = Math.max(0, ...DB.categories.map(c => num(c.ordre) || 0));
  [nom.includes(SEP) ? topOf(nom) : null, nom].filter(Boolean).forEach(n => { if (!have.has(n.toLowerCase())) { have.add(n.toLowerCase()); ops.push(upd('Categories', { id: uid(), compte: acc, nom: n, budget: '', ordre: ++ordre })); } });
  return ops;
}
const param = (k, d) => { const p = DB.parametres.find(x => x.cle === k); return p ? p.valeur : d; };
const started = acc => num(accOf(acc).soldeDepart) !== null;
const startMonth = acc => accOf(acc).moisDepart || CUR;
const clot = (acc, k) => DB.clotures.find(c => c.id === acc + '|' + k);
const point = (k, cle) => DB.pointages.find(p => p.id === k + '|' + cle);

function occursF(f, k) {
  if (!bool(f.actif)) return false;
  if (f.debut && k < f.debut) return false;
  if (f.fin && k > f.fin) return false;
  const m = pm(k).m + 1, ref = num(f.moisRef) || (f.debut ? pm(f.debut).m + 1 : 1);
  if (f.frequence === 'T') return ((m - ref) % 3 + 3) % 3 === 0;
  if (f.frequence === 'A') return m === ref;
  return true;
}
function occursV(v, k) {
  if (!bool(v.actif)) return false;
  if (v.debut && k < v.debut) return false;
  if (v.fin && k > v.fin) return false;
  return true;
}
const opsOf = (acc, k) => DB.operations.filter(o => o.compte === acc && String(o.date).slice(0, 7) === k);

/* ================= Calculs ================= */
function events(acc, k, o) {
  const D = dim(k), ev = [];
  DB.fixes.filter(f => f.compte === acc && occursF(f, k)).forEach(f => {
    const p = point(k, 'f' + f.id), a = p ? num(p.montantReel) : num(f.montant) || 0;
    ev.push({ d: Math.min(num(f.jour) || 1, D), v: f.sens === '+' ? a : -a, kind: 'fixe', key: 'f' + f.id, id: f.id, label: f.libelle, cat: f.categorie || 'Autre', ok: !!p });
  });
  DB.virements.filter(v => (v.de === acc || v.vers === acc) && occursV(v, k)).forEach(v => {
    const p = point(k, 'v' + v.id), a = p ? num(p.montantReel) : num(v.montant) || 0, out = v.de === acc;
    ev.push({ d: Math.min(num(v.jour) || 1, D), v: out ? -a : a, kind: 'vir', key: 'v' + v.id, id: v.id, label: v.libelle || (out ? 'Virement vers ' + accName(v.vers) : 'Virement depuis ' + accName(v.de)), cat: out ? '→ ' + accName(v.vers) : '← ' + accName(v.de), ok: !!p, who: v.profil });
  });
  opsOf(acc, k).forEach(op => {
    const d = Math.min(+String(op.date).slice(8, 10) || 1, D);
    const kind = op.type === 'ajust' ? 'ajust' : op.type === 'vir' ? 'virop' : op.type === 'exc' || op.type === 'int' ? 'exc' : 'ponct';
    ev.push({ d, v: num(op.montant) || 0, kind, x: kind === 'exc' ? op.type : '', id: op.id, label: op.type === 'ajust' ? 'Correction de solde' : nameOf(op), cat: op.type === 'ajust' ? 'Correction de solde' : op.categorie, who: op.profil, op });
  });
  if (o && o.sim) DB.simulations.filter(s => s.compte === acc && s.mois === k && bool(s.actif)).forEach(s => {
    ev.push({ d: Math.min(15, D), v: -(num(s.montant) || 0), kind: 'sim', label: s.libelle, cat: 'Simulation' });
  });
  return ev;
}
const isPonct = o => !o.type || o.type === 'ponct';
const isIncomeCat = c => c === 'Revenus';
// Dépensé dans une catégorie (dépenses courantes uniquement : ni exceptionnel, ni virement entre comptes ; les remboursements viennent en déduction)
function spentCat(acc, k, cat, upTo) {
  if (isIncomeCat(cat)) return 0;
  const s = -opsOf(acc, k).filter(o => (o.categorie || '') === cat && isPonct(o) && (cat !== '' || (num(o.montant) || 0) < 0) && (upTo == null || +String(o.date).slice(8, 10) <= upTo))
    .reduce((a, o) => a + (num(o.montant) || 0), 0);
  return Math.max(0, s);
}
// Rentrées ponctuelles (hors fixes, exceptionnelles et virements entre comptes) : catégorie Revenus ou à classer
function incomeMonth(acc, k, upTo) {
  return opsOf(acc, k).filter(o => isPonct(o) && (num(o.montant) || 0) > 0 && (isIncomeCat(o.categorie) || !o.categorie) && (upTo == null || +String(o.date).slice(8, 10) <= upTo))
    .reduce((a, o) => a + (num(o.montant) || 0), 0);
}
const median = v => { const s = v.slice().sort((a, b) => a - b), n = s.length; return !n ? 0 : n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; };
// Habitude : médiane des 3 derniers mois (un mois hors norme ne fausse plus tout), mêlée au mois en cours dès le 10
function robust(acc, f) {
  const k0 = startMonth(acc), vals = [];
  for (let j = 1; j <= 3; j++) { const k = addM(CUR, -j); if (k >= k0) vals.push(f(k)); }
  if (!vals.length) return null;
  let h = median(vals);
  if (TODAY >= 10) { const cur = f(CUR, TODAY) * dim(CUR) / TODAY; h = (h * 2 + (h > 0 ? Math.min(cur, h * 2) : cur)) / 3; }
  return h;
}
function habit(acc, cat) {
  const ck = 'h|' + acc + '|' + cat; if (ck in CACHE) return CACHE[ck];
  const c = catsOf(acc).find(x => x.nom === cat), h = robust(acc, (k, up) => spentCat(acc, k, cat, up));
  return (CACHE[ck] = h === null ? (num(c && c.budget) || 0) : h);
}
function habitIn(acc) {
  const ck = 'hi|' + acc; if (ck in CACHE) return CACHE[ck];
  return (CACHE[ck] = robust(acc, (k, up) => incomeMonth(acc, k, up)) || 0);
}
// catégories de dépenses suivies (avec « à classer » s'il y en a)
function catList(acc) {
  const l = catsOf(acc).filter(c => !isIncomeCat(c.nom)).map(c => ({ nom: c.nom, budget: c.budget }));
  if (DB.operations.some(o => o.compte === acc && !o.categorie && isPonct(o))) l.push({ nom: '', budget: '' });
  return l;
}
const catLabel = c => c || 'À classer';
const hasHistory = acc => addM(CUR, -1) >= startMonth(acc);

function calc(acc, k, start, o) {
  o = o || {};
  const mode = o.mode || 'budget', D = dim(k), T = k < CUR ? D : k === CUR ? TODAY : 0;
  const ev = events(acc, k, o);
  // mois en cours : une charge fixe dont la date est passée mais pas encore pointée (pas vue sur le relevé) reste « à venir »
  if (k === CUR) ev.forEach(e => { if ((e.kind === 'fixe' || e.kind === 'vir') && !e.ok && e.d <= T) e.late = true; });
  const when = e => e.late ? Math.min(D, T + 1) : e.d;
  const realized = ev.filter(e => when(e) <= T).reduce((a, e) => a + e.v, 0), bal = start + realized;
  const fut = ev.filter(e => when(e) > T).reduce((a, e) => a + e.v, 0);
  const cats = catList(acc).map(c => {
    const of = e => e.kind === 'ponct' && (e.cat || '') === c.nom && (c.nom !== '' || e.v < 0);
    const spent = Math.max(0, -ev.filter(e => of(e) && e.d <= T).reduce((a, e) => a + e.v, 0));
    const planned = Math.max(0, -ev.filter(e => of(e) && e.d > T).reduce((a, e) => a + e.v, 0));
    const budget = num(c.budget);
    // « selon nos budgets » : l'enveloppe si elle existe, sinon l'habitude
    const target = k < CUR || o.noHab ? 0 : mode === 'habits' || !budget ? habit(acc, c.nom) : budget;
    return { nom: c.nom, budget, spent, target, remaining: k < CUR ? 0 : Math.max(0, target - spent - planned) };
  });
  // rentrées ponctuelles habituelles (remboursements, aides variables…) encore à venir
  const incGot = ev.filter(e => e.kind === 'ponct' && e.v > 0 && (isIncomeCat(e.cat) || !e.cat)).reduce((a, e) => a + e.v, 0);
  const incRem = k < CUR || o.noHab ? 0 : Math.max(0, habitIn(acc) - incGot);
  const varRem = cats.reduce((a, c) => a + c.remaining, 0), end = bal + fut - varRem + incRem;
  const curve = []; let low = { d: D, v: Infinity };
  for (let d = 1; d <= D; d++) {
    let v = start + ev.filter(e => when(e) <= d).reduce((a, e) => a + e.v, 0);
    if (d > T && D > T) v += (incRem - varRem) * (d - T) / (D - T);
    curve.push(v); if (d > T && v < low.v) low = { d, v };
  }
  const rev = ev.filter(e => e.v > 0 && e.kind !== 'ajust').reduce((a, e) => a + e.v, 0) + incRem;
  const chg = -ev.filter(e => (e.kind === 'fixe' || e.kind === 'vir') && e.v < 0).reduce((a, e) => a + e.v, 0);
  const vari = -ev.filter(e => (e.kind === 'ponct' || e.kind === 'sim' || e.kind === 'virop' || e.kind === 'exc') && e.v < 0).reduce((a, e) => a + e.v, 0) + varRem;
  return { k, D, T, ev, start, bal, end, cats, varRem, incRem, curve, low, rev, chg, vari, net: end - start };
}
// Solde au 1er du mois k (enchaîne les mois depuis le mois de départ, en repartant des clôtures)
function startOf(acc, k) {
  const ck = 's|' + acc + '|' + k; if (ck in CACHE) return CACHE[ck];
  const A = accOf(acc), k0 = startMonth(acc);
  let s = num(A.soldeDepart) || 0;
  for (let m = k0; m < k; m = addM(m, 1)) { const c = clot(acc, m); s = c ? num(c.soldeFin) : calc(acc, m, s).end; }
  return (CACHE[ck] = s);
}
function forecast(acc, n, o) {
  const ck = 'f|' + acc + '|' + n + '|' + JSON.stringify(o || {}); if (ck in CACHE) return CACHE[ck];
  const out = []; let s = startOf(acc, CUR);
  for (let i = 0; i < n; i++) { const r = calc(acc, addM(CUR, i), s, o); out.push(r); s = r.end; }
  return (CACHE[ck] = out);
}
const curMonth = acc => calc(acc, CUR, startOf(acc, CUR), { mode: 'budget', noHab: !UI.hab });

/* ================= Mois basé sur la paie (V2.2) ================= */
// On ne touche pas aux mois calendaires (clôtures, Bilan, Relevé complet, solde banque) : seul l'onglet Mois,
// pour son chiffre de fin et sa courbe, peut afficher la fenêtre « d'une paie à l'autre » plutôt que le 1er → 31.
// La fenêtre est recalculée à chaque ouverture et ne fait que découper les jours déjà calculés par mois calendaire :
// un même jour n'appartient jamais qu'à une seule fenêtre, donc rien ne peut être compté deux fois ni oublié.
const dLabel = iso => (+iso.slice(8, 10)) + ' ' + MONTHS[pm(iso.slice(0, 7)).m];
const daysBetween = (a, b) => Math.round((new Date(b + 'T12:00:00Z') - new Date(a + 'T12:00:00Z')) / 864e5);
// Rentrée fixe choisie comme déclencheur (réglage explicite, sinon la plus grosse rentrée mensuelle active)
function salaryFixeId(acc) {
  const stored = param('payeFixe|' + acc, '');
  if (stored && DB.fixes.some(f => f.id === stored && f.compte === acc && bool(f.actif) && f.sens === '+')) return stored;
  const cands = DB.fixes.filter(f => f.compte === acc && bool(f.actif) && f.sens === '+' && (f.frequence || 'M') === 'M');
  if (!cands.length) return null;
  const amtOf = f => { const pts = DB.pointages.filter(p => p.cle === 'f' + f.id).map(p => num(p.montantReel)).filter(x => x != null); return pts.length ? median(pts) : (num(f.montant) || 0); };
  return cands.slice().sort((a, b) => amtOf(b) - amtOf(a))[0].id;
}
function payOn(acc) { const v = param('payeOn|' + acc, ''); return v ? v === 'oui' : !!salaryFixeId(acc); }
function payHisto(acc) { try { return JSON.parse(param('paye|' + acc, '{}')) || {}; } catch (e) { return {}; } }
// Dates de la rentrée choisie, mois par mois : réelle si on l'a vue passer (banque/import), sinon son jour habituel
function payDates(acc, fid) {
  const f = DB.fixes.find(x => x.id === fid); if (!f) return {};
  const h = payHisto(acc)[fid] || {}, out = {};
  for (let k = startMonth(acc); k <= CUR; k = addM(k, 1)) if (occursF(f, k)) out[k] = h[k] || (k + '-' + pad(Math.min(num(f.jour) || 1, dim(k))));
  return out;
}
// Fenêtre en cours : de la dernière paie détectée à la prochaine estimée (ou fixée à la main si elle n'est pas encore passée)
function payState(acc) {
  if (!payOn(acc)) return null;
  const fid = salaryFixeId(acc); if (!fid) return null;
  const dates = payDates(acc, fid), ks = Object.keys(dates).sort();
  const past = ks.filter(k => dates[k] <= TODAY_ISO); if (!past.length) return null;
  const startK = past[past.length - 1], start = dates[startK], idx = ks.indexOf(startK);
  const gaps = []; for (let i = Math.max(1, idx - 2); i <= idx; i++) if (ks[i - 1] !== undefined) gaps.push(daysBetween(dates[ks[i - 1]], dates[ks[i]]));
  const avg = gaps.length ? Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length) : 30;
  const auto = isoAdd(start, Math.min(40, Math.max(20, avg)));
  const over = param('payeFin|' + acc, ''), manual = !!(over && over > TODAY_ISO && over > start);
  return { fixe: fid, start, end: manual ? over : auto, auto, manual };
}
// Courbe de solde jour par jour sur la fenêtre de paie : enchaîne les mois calendaires déjà calculés par calc(), sans dupliquer le moteur
function periodCalc(acc, PS) {
  const months = []; for (let k = PS.start.slice(0, 7); k <= PS.end.slice(0, 7); k = addM(k, 1)) months.push(k);
  let s = startOf(acc, months[0]); const dates = [], curve = [];
  months.forEach(k => {
    const r = calc(acc, k, s, { mode: 'budget', noHab: !UI.hab });
    for (let d = 1; d <= r.D; d++) { const date = k + '-' + pad(d); if (date >= PS.start && date < PS.end) { dates.push(date); curve.push(r.curve[d - 1]); } }
    s = r.end;
  });
  const D = dates.length, T = dates.filter(d => d <= TODAY_ISO).length;
  const bal = T ? curve[T - 1] : (num(accOf(acc).soldeDepart) || 0), end = curve[D - 1];
  let low = { d: D, v: Infinity }; for (let i = T; i < D; i++) if (curve[i] < low.v) low = { d: i + 1, v: curve[i] };
  return { D, T, dates, curve, bal, end, low };
}
// Marchand avec deux usages distincts selon le montant (ex. MAGASIN U = courses ou carburant)
function seuilRule(acc, lib) { try { return JSON.parse(param('seuilCat|' + acc + '|' + keyOf(lib), '')) || null; } catch (e) { return null; } }

function status(end, seuil) {
  if (end < 0) return { c: 'bad', t: 'Dépassement prévu', msg: `Il manque ${eur0(-end)} pour finir le mois` };
  if (end < seuil) return { c: 'warn', t: 'Budget serré', msg: `Marge de ${eur0(end)}, sous le seuil de ${eur0(seuil)}` };
  return { c: 'good', t: 'Budget tenu', msg: `Épargne possible : ${eur0(end - seuil)}` };
}
const seuilOf = acc => num(accOf(acc).seuil) || 0;
function margeHab(acc) {
  const ck = 'mh|' + acc; if (ck in CACHE) return CACHE[ck];
  const r = forecast(acc, 7, { mode: 'habits' }).slice(1);
  return (CACHE[ck] = r.reduce((a, x) => a + x.net, 0) / r.length);
}
function firstUnclosed(acc) {
  if (!started(acc)) return null;
  for (let k = startMonth(acc); k < CUR; k = addM(k, 1)) if (!clot(acc, k)) return k;
  return null;
}

/* ================= Simulations ================= */
const simI = s => diffM(CUR, s.mois);
const activeSims = acc => DB.simulations.filter(s => s.compte === acc && bool(s.actif) && simI(s) >= 0).sort((a, b) => simI(a) - simI(b) || String(a.id).localeCompare(String(b.id)));
function reservedBefore(s, list) {
  const idx = list.findIndex(x => x.id === s.id), prev = idx < 0 ? list : list.slice(0, idx), k = simI(s);
  if (k <= 0) return { avg: 0, names: [] };
  let tot = 0; const names = new Set();
  for (let mo = 1; mo <= k; mo++) prev.forEach(p => { const pk = simI(p); if (pk > 0 && mo <= pk) { tot += num(p.montant) / pk; names.add(p.libelle); } });
  return { avg: tot / k, names: [...names] };
}
function simsSummary(acc) {
  const all = activeSims(acc), list = all.filter(x => simI(x) > 0), marge = margeHab(acc);
  if (all.length < 2) return null;
  let peak = 0; const maxK = list.length ? Math.max(...list.map(simI)) : 0;
  for (let mo = 1; mo <= maxK; mo++) peak = Math.max(peak, list.filter(x => mo <= simI(x)).reduce((a, x) => a + num(x.montant) / simI(x), 0));
  return { n: all.length, total: all.reduce((a, x) => a + num(x.montant), 0), peak, marge, ratio: marge > 0 ? peak / marge : Infinity };
}
function simPlan(s) {
  const acc = s.compte, margeTot = margeHab(acc), k = simI(s), amt = num(s.montant) || 0;
  const need = k > 0 ? amt / k : amt;
  const res = reservedBefore(s, bool(s.actif) ? activeSims(acc) : activeSims(acc).concat([s]));
  const marge = margeTot - res.avg, ratio = marge > 0 ? need / marge : Infinity;
  const c = ratio <= 0.5 ? 'good' : ratio <= 0.9 ? 'warn' : 'bad';
  const label = c === 'good' ? 'Faisable' : c === 'warn' ? 'Tendu' : 'Difficile';
  let over = null;
  catsOf(acc).filter(x => num(x.budget)).forEach(x => { const h = habit(acc, x.nom) - num(x.budget); if (h > 15 && (!over || h > over.d)) over = { n: x.nom, d: h }; });
  const kmin = marge > 0 ? Math.ceil(amt / (marge * 0.5)) : null;
  const end = forecast(acc, Math.max(6, k + 2), { sim: true, mode: 'habits' });
  const neg = end.find(r => r.low.v < 0);
  let txt;
  if (k === 0) txt = `L'achat tombe ce mois-ci : il est pris directement sur la fin de mois.`;
  else if (res.avg > 0) txt = `Il reste habituellement ${eur0(margeTot)} en fin de mois, dont <b>${eur0(res.avg)}</b> déjà réservés pour ${res.names.map(esc).join(', ')}. Mettre <b>${eur0(need)}</b> de côté représente <b>${marge > 0 ? Math.round(ratio * 100) + ' %' : 'plus que tout'}</b> de ce qui reste disponible (${eur0(marge)}).`;
  else txt = `Mettre <b>${eur0(need)}</b> de côté chaque mois représente <b>${marge > 0 ? Math.round(ratio * 100) + ' %' : 'plus que tout'}</b> de ce qu'il reste habituellement en fin de mois (${eur0(margeTot)}).`;
  if (!hasHistory(acc)) txt += ` <i>Peu d'historique pour l'instant : les budgets servent d'estimation.</i>`;
  if (over) txt += ` D'après les saisies, l'enveloppe <b>${esc(over.n)}</b> est dépassée de ${eur0(over.d)} par mois en moyenne : c'est pris en compte.`;
  if (c !== 'good' && kmin && kmin > k) txt += ` Plus confortable en visant <b>${mLabel(addM(CUR, kmin))}</b> (${eur0(amt / kmin)}/mois).`;
  if (neg && bool(s.actif)) txt += ` Attention, découvert possible en ${mLabel(neg.k)}.`;
  if (!bool(s.actif)) txt = `<i>Simulation désactivée, évaluée comme si on l'ajoutait aux autres.</i> ` + txt;
  return { k, need, c: neg && bool(s.actif) ? 'bad' : c, label: neg && bool(s.actif) ? 'Risqué' : label, txt };
}

/* ================= Impôts ================= */
function bareme(q) { let t = 0, p = 0; for (const [l, r] of IMPOT.tranches) { if (q > p) t += (Math.min(q, l) - p) * r; p = l; } return t; }
function taxParams() {
  return { mode: param('impMode', 'commune'), kids: num(param('impEnfants')) || 0, sal1: num(param('impSal1')) || 0, sal2: num(param('impSal2')) || 0, autres: num(param('impAutres')) || 0, autresAb: num(param('impAutresAb')) || 50, taux: num(param('impTaux')) || 0 };
}
function calcTax(X, extra) {
  const couple = X.mode === 'commune', sal = (X.sal1 + extra) + (couple ? X.sal2 : 0);
  const Rsal = Math.max(0, sal * 0.9), Raut = X.autres * (1 - X.autresAb / 100), R = Rsal + Raut;
  const base = couple ? 2 : 1, parts = base + (X.kids <= 2 ? X.kids * 0.5 : 1 + (X.kids - 2));
  const Ifull = bareme(R / parts) * parts, Ibase = bareme(R / base) * base, cap = (parts - base) * 2 * IMPOT.plafondDemiPart;
  let I = Math.max(Ifull, Ibase - cap); const plaf = Ibase - cap > Ifull;
  const [sd, dx] = couple ? IMPOT.decote.couple : IMPOT.decote.seul; let dec = 0;
  if (I < sd) { dec = Math.min(I, Math.max(0, dx - IMPOT.decote.taux * I)); I -= dec; }
  const q = R / parts, TR = IMPOT.tranches; let k = 0; while (q > TR[k][0]) k++;
  const share = R > 0 ? Rsal / R : 0;
  return { R, parts, I, dec, plaf, q, tmi: TR[k][1], toNext: (TR[k][0] - q) * parts / 0.9, nextRate: TR[Math.min(k + 1, TR.length - 1)][1], tauxEst: sal > 0 ? I * share / sal * 100 : 0, prelev: sal * X.taux / 100, duSal: I * share, sal };
}

/* ================= Graphiques ================= */
function niceStep(s) { if (!(s > 0)) return 100; const p = Math.pow(10, Math.floor(Math.log10(s))), n = s / p; return (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * p; }
function curveSVG(r, seuil, dv) {
  const W = 340, H = 150, L = 44, R = 8, Tp = 10, B = 22, vals = r.curve.concat([0, seuil]);
  let mn = Math.min(...vals), mx = Math.max(...vals); const padv = (mx - mn) * .08 || 50; mn -= padv; mx += padv;
  const x = d => L + (d - 1) * (W - L - R) / (r.D - 1), yv = v => Tp + (mx - v) * (H - Tp - B) / (mx - mn);
  const step = niceStep((mx - mn) / 4), ticks = []; for (let t = Math.ceil(mn / step) * step; t <= mx; t += step) ticks.push(t);
  const pts = r.curve.map((v, i) => [x(i + 1), yv(v)]), T = Math.max(1, r.T);
  let g = ticks.map(t => `<line x1="${L}" x2="${W - R}" y1="${yv(t)}" y2="${yv(t)}" stroke="var(--line)"/><text x="${L - 6}" y="${yv(t) + 4}" text-anchor="end" font-size="10" fill="var(--muted)">${Math.round(t)}</text>`).join('');
  g += `<line x1="${L}" x2="${W - R}" y1="${yv(seuil)}" y2="${yv(seuil)}" stroke="var(--warn)" stroke-dasharray="3 3" stroke-width="1.2"/><text x="${W - R}" y="${yv(seuil) - 4}" text-anchor="end" font-size="10" fill="var(--warn)">seuil ${Math.round(seuil)} €</text>`;
  if (mn < 0) g += `<line x1="${L}" x2="${W - R}" y1="${yv(0)}" y2="${yv(0)}" stroke="var(--bad)" stroke-width="1.2"/>`;
  [1, 10, 20, r.D].forEach(d => g += `<text x="${x(d)}" y="${H - 6}" text-anchor="middle" font-size="10" fill="var(--muted)">${d}</text>`);
  const past = pts.slice(0, T).map(p => p.join(',')).join(' ');
  g += `<polygon points="${x(1)},${yv(mn)} ${past} ${x(T)},${yv(mn)}" fill="var(--accent)" opacity=".10"/>`;
  g += `<polyline points="${past}" fill="none" stroke="var(--accent)" stroke-width="2.4" stroke-linejoin="round"/>`;
  g += `<polyline points="${pts.slice(T - 1).map(p => p.join(',')).join(' ')}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-dasharray="5 4"/>`;
  if (r.T) g += `<circle cx="${x(T)}" cy="${yv(r.curve[T - 1])}" r="4.5" fill="var(--accent)" stroke="var(--surface)" stroke-width="2"/>`;
  g += `<circle cx="${x(r.D)}" cy="${yv(r.end)}" r="4" fill="var(--surface)" stroke="var(--accent)" stroke-width="2"/>`;
  if (dv) { const v = r.curve[dv - 1]; g += `<line x1="${x(dv)}" x2="${x(dv)}" y1="${Tp}" y2="${H - B}" stroke="var(--ink)" stroke-width="1" opacity=".35"/><circle cx="${x(dv)}" cy="${yv(v)}" r="5.5" fill="var(--surface)" stroke="var(--ink)" stroke-width="2.4"/>`; }
  return `<svg class="curve" viewBox="0 0 ${W} ${H}" role="img" aria-label="Évolution du solde sur le mois">${g}</svg>`;
}

/* ================= Interface ================= */
const UI = { acc: store.get('le31-compte', 'perso'), tab: 'home', foreTab: 'budget', horizon: 6, mode: 'habits', theme: store.get('le31-theme', 'auto'), hab: store.get('le31-hab', true), dayV: null };
const draft = { sens: '-', cat: null, to: null };
const main = $('main');

function render() {
  refreshNow();
  if (!DB.comptes.find(a => a.id === UI.acc) && DB.comptes.length) UI.acc = accs()[0].id;
  const L = $('monthLbl'); if (L) L.textContent = mLabel(CUR);
  $('foot').textContent = 'Le 31 · V' + APP_VERSION;
  document.querySelectorAll('nav.tabs button, #gearBtn').forEach(b => b.setAttribute('aria-current', b.dataset.tab === UI.tab));
  const blocked = BK.view === 'retour' ? null : gate(), imp = !blocked && UI.imp && IMP;
  const bkv = !blocked && !imp && (BK.view || (bkPend() ? 'map' : null));
  $('tabs').hidden = !!blocked || !!imp || !!bkv; $('gearBtn').hidden = !!blocked || !!imp || !!bkv;
  $('top').querySelector('.seg').hidden = !!blocked || !!imp || accs().length < 2 || (UI.tab === 'fore' && UI.foreTab === 'tax') || UI.tab === 'set';
  $('accSeg').innerHTML = accs().map(a => `<button data-acc="${esc(a.id)}" aria-pressed="${a.id === UI.acc}">${esc(a.nom)}</button>`).join('');
  try {
    main.innerHTML = blocked || (imp ? vImport() : bkv ? vBank() : ({ home: vHome, fixed: vFixed, add: vAdd, ponct: vPonct, bilan: vBilan, fore: vFore, set: vSet }[UI.tab] || vHome)());
  } catch (e) {
    console.error(e);
    main.innerHTML = `<section class="view"><div class="note bad">Un problème d'affichage est survenu : ${esc(e.message)}. Va dans Réglages ou recharge l'appli.</div></section>`;
  }
  setSync(); bankChip();
}
// Écrans bloquants : appli pas encore reliée, lien refusé, accès coupé, premier chargement, premier lancement
function gate() {
  const logo = `<div class="logo31">Le 31<span>.</span></div>`;
  const paste = `<form class="form" id="keyForm" novalidate style="text-align:left"><div class="field"><label for="keyIn">Colle ici le lien reçu</label><input id="keyIn" placeholder="https://…#inv=…" autocomplete="off"></div><button class="btn" type="submit">Relier l'appli</button></form>`;
  if (INV() && apiOk()) {
    if (IOS && !STANDALONE() && !JOIN.iosOk) return `<section class="view center">${logo}<h2>Installe d'abord Le 31</h2>
      <p class="hint" style="font-size:14px">Sur iPhone et iPad : bouton <b>Partager</b> puis <b>Sur l'écran d'accueil</b>. Ouvre ensuite Le 31 depuis l'écran d'accueil : si l'appli te le demande, colle le lien reçu.</p>
      <p class="hint">Ce lien ne marche qu'une fois, sur un seul appareil.</p><button class="btn ghost" data-iosok="1">Utiliser Le 31 dans Safari plutôt</button></section>`;
    const E = JOIN.err;
    if (!JOIN.busy && E) {
      const api = API(), short = api.replace(/^https:\/\/script\.google\.com\/macros\/s\/(.{6}).*(.{6})\/exec$/, '…/s/$1…$2/exec');
      const why = E === 'delai' ? "Le serveur n'a pas répondu à temps."
        : E === 'reseau' ? "Impossible de joindre le serveur (réseau, ou adresse du serveur incorrecte dans le lien)."
        : E === 'html' ? "L'adresse du serveur contenue dans le lien ne répond pas comme prévu : ce n'est sans doute pas la bonne (ou le déploiement n'est pas en « Tout le monde »)."
        : E === 'serveur' ? 'Le serveur a rencontré une erreur.' : 'Erreur : ' + esc(E);
      return `<section class="view center">${logo}<h2>Connexion impossible</h2>
        <p class="hint" style="font-size:14px">${why}</p>
        ${JOIN.detail ? `<div class="note" style="text-align:left;font-size:12px;word-break:break-word">Détail : ${esc(JOIN.detail)}</div>` : ''}
        <div class="note" style="text-align:left;font-size:13px">Adresse du serveur dans ton lien :<br><b style="word-break:break-all">${esc(short)}</b><br>Elle doit être identique à l'<b>URL de l'application Web</b> du déploiement. Ouverte dans Safari, elle doit afficher « Le 31 : serveur actif ». Sinon, recrée le lien depuis le menu « Le 31 » du Google Sheet en collant la bonne adresse.</div>
        <button class="btn" data-joinretry="1">Réessayer</button>
        ${paste}</section>`;
    }
    return `<section class="view center">${logo}<p class="hint">Connexion de cet appareil…</p></section>`;
  }
  if (!JETON() || !apiOk() || isAccessErr(SYNC.error)) {
    const E = JOIN.err, cut = isAccessErr(SYNC.error) && JETON();
    const msg = E === 'utilisee' ? "Ce lien a déjà servi : chaque lien ne marche qu'une fois. Demande un nouveau lien (Réglages > Profils sur le téléphone de l'autre personne, ou menu « Le 31 » du Google Sheet)."
      : E === 'expiree' ? 'Ce lien a expiré (14 jours). Demande-en un nouveau.'
      : E === 'annulee' ? 'Ce lien a été remplacé par un plus récent : utilise le dernier lien reçu.'
      : E === 'reseau' ? 'Pas de réseau : réessaie dès que possible.'
      : E ? 'Lien non reconnu.'
      : cut ? "L'accès de cet appareil a été coupé. Demande un nouveau lien pour le reconnecter."
      : "Ouvre le lien d'accès reçu par message pour relier l'appli à vos comptes.";
    return `<section class="view center">${logo}<h2>${cut ? 'Accès coupé' : E ? 'Lien refusé' : 'Bienvenue'}</h2><p class="hint" style="font-size:14px">${msg}</p>${paste}</section>`;
  }
  if (!LOADED) return `<section class="view center">${logo}<p class="hint">${SYNC.state === 'off' ? 'Pas de réseau pour le premier chargement. Réessaie dès que possible.' : 'Chargement des comptes…'}</p>${SYNC.state === 'off' ? '<button class="btn ghost" data-retry="1">Réessayer</button>' : ''}</section>`;
  if (ME === '') return vOnboard();
  if (!DB.comptes.length) return `<section class="view center">${logo}<p class="hint">Aucun compte visible pour ce profil. Ajoute un compte perso dans Réglages ou demande à être relié au compte commun.</p></section>`;
  return null;
}

function rowEv(e) {
  const attr = e.kind === 'ponct' || e.kind === 'exc' || e.kind === 'ajust' || e.kind === 'virop' ? `data-oid="${esc(e.id)}"` : e.kind === 'fixe' ? `data-fid="${esc(e.id)}"` : e.kind === 'vir' ? `data-vid="${esc(e.id)}"` : 'disabled';
  const who = e.who && DB.profils.length > 1 ? ' · ' + esc(pname(e.who)) : '';
  const tag = e.kind === 'vir' || e.kind === 'virop' ? '<span class="tag">lié</span>' : e.x === 'exc' ? '<span class="tag w">exceptionnel</span>' : e.x === 'int' ? '<span class="tag g">entre mes comptes</span>' : '';
  return `<button class="item" ${attr}><span class="day">${e.d}</span><span class="lbl"><b>${esc(e.label)}${tag}</b><small>${e.kind === 'ponct' && !e.cat ? 'À classer' : esc(e.cat || '')}${e.kind === 'fixe' ? ' · fixe' : ''}${who}</small></span><span class="amt ${e.v > 0 ? 'pos' : 'neg'}">${sgn(e.v)}</span></button>`;
}

/* ----- Onglet Mois ----- */
function vHome() {
  const acc = UI.acc, A = accOf(acc);
  if (!started(acc)) return `<section class="view"><div class="hero">
      <div class="rowhead"><span class="sub">Pour commencer</span></div>
      <h2>Démarrer : ${esc(A.nom)}</h2>
      <h3 style="margin:4px 0 0">Importer un relevé <span class="tag">recommandé</span></h3>
      <p class="hint" style="font-size:14px">Télécharge l'historique du compte sur le site de ta banque (format <b>CSV</b> ou <b>OFX</b>, idéalement 3 mois). Le 31 repère les prélèvements, classe les dépenses et calcule vos habitudes tout de suite.</p>
      <label class="btn" style="text-align:center">Choisir le fichier<input type="file" id="impFile" accept=".csv,.ofx,.qfx,.txt,text/csv" hidden></label>
      <div id="impErr"></div>
    </div>
    <div class="hero"><h3 style="margin:0">Ou saisir le solde à la main</h3>
      <p class="hint">Le solde affiché par la banque aujourd'hui. Tu ajouteras ensuite les charges fixes dans l'onglet Charges.</p>
      <form class="form" id="startForm" novalidate><div class="amountbox"><input id="startBal" inputmode="decimal" placeholder="0,00" aria-label="Solde actuel" autocomplete="off"><span>€</span></div>
      <button class="btn ghost" type="submit">Démarrer avec ce solde</button></form></div>
    ${isShared(acc) ? `<div class="note">Compte partagé : une seule personne le démarre, l'autre le retrouvera déjà prêt.</div>` : ''}</section>`;
  const r = curMonth(acc), seuil = seuilOf(acc);
  const PS = payState(acc), PC = PS && periodCalc(acc, PS), H = PC || r, st = status(H.end, seuil);
  const upcoming = r.ev.filter(e => e.d > r.T).sort((a, b) => a.d - b.d);
  const recent = r.ev.filter(e => e.d <= r.T && ['ponct', 'exc', 'ajust', 'virop'].includes(e.kind)).sort((a, b) => b.d - a.d || String(b.id).localeCompare(String(a.id))).slice(0, 5);
  const toRecon = r.ev.filter(e => (e.kind === 'fixe' || e.kind === 'vir') && e.d <= r.T && !e.ok).sort((a, b) => a.d - b.d);
  const fx = r.ev.filter(e => e.kind === 'fixe' || e.kind === 'vir'), fxOut = -fx.filter(e => e.v < 0).reduce((a, e) => a + e.v, 0);
  const fxDone = fx.filter(e => e.d <= r.T).length;
  const pSpent = r.cats.reduce((a, c) => a + c.spent, 0), pHab = r.cats.reduce((a, c) => a + c.target, 0);
  const grp = {}; r.cats.forEach(c => { const t = topOf(c.nom), g = grp[t] = grp[t] || { nom: t, spent: 0, target: 0, budget: 0, n: 0 }; g.spent += c.spent; g.target += c.target; g.budget += num(c.budget) || 0; g.n += c.nom.includes(SEP) ? 1 : 0; });
  const cats = Object.values(grp).filter(c => c.spent > 0.5 || c.target > 0.5).sort((a, b) => Math.max(b.spent, b.target) - Math.max(a.spent, a.target)).slice(0, 6);
  const unc = firstUnclosed(acc), frac = r.T / r.D, dv = Math.min(H.D, Math.max(1, UI.dayV || H.T || 1));
  const dayTxt = PC ? dLabel(PC.dates[dv - 1]) : dv + ' ' + MONTHS[pm(CUR).m];
  const lowTxt = PC ? dLabel(PC.dates[H.low.d - 1]) : H.low.d + ' ' + MONTHS[pm(CUR).m];
  return `<section class="view">
  ${banners(acc)}
  ${unc ? `<div class="banner warn"><span><b>${mLabel(unc)}</b> n'est pas clôturé.</span><button class="btn small" data-close-month="${unc}">Clôturer</button></div>` : ''}
  <div class="hero">
    <div class="rowhead"><span class="sub">${PC ? `Avant la prochaine paie${PS.manual ? ' (date fixée à la main)' : ' · estimée au ' + dLabel(PS.end)}` : `Fin ${MONTHS_L[pm(CUR).m]} prévue`}</span><span class="pill ${st.c}">${st.t}</span></div>
    <div class="big num">${eur0(H.end)}</div>
    <div style="font-weight:600;color:var(--${st.c})">${st.msg}</div>
    ${PC ? `<div class="hint" style="margin-top:-4px">Période en cours : du ${dLabel(PS.start)} au ${dLabel(PS.end)}, d'après ta rentrée « ${esc((DB.fixes.find(f => f.id === PS.fixe) || {}).libelle || '')} ». Modifiable dans Réglages.</div>` : ''}
    <div class="kv">
      <div><small>Solde estimé au ${TODAY} ${MONTHS[pm(CUR).m]}</small><b>${eur(H.bal)}</b></div>
      <div><small>D'ici le ${PC ? dLabel(PS.end) : r.D}</small><b>${sgn(r2(H.end - H.bal))}</b></div>
    </div>
    ${curveSVG(H, seuil, dv)}
    <label class="daysim" for="dayV"><span>Le <b class="num">${dayTxt}</b></span><input type="range" id="dayV" min="1" max="${H.D}" value="${dv}" aria-label="Jour"><b class="num" style="color:var(--${H.curve[dv - 1] < 0 ? 'bad' : 'ink'})">${eur0(H.curve[dv - 1])}</b></label>
    <div class="hint" style="margin-top:-8px">${dv < H.T ? 'Solde réel ce jour-là (opérations connues).' : dv === H.T ? 'Solde estimé aujourd\'hui.' : `Solde prévu ce jour-là : charges fixes à leur date${UI.hab ? ', ponctuel habituel réparti sur les jours' : ''}.`} Fais glisser pour voir un autre jour.</div>
    <label class="switch" for="habOn" style="gap:10px"><span style="font-size:14px">Prévoir le ponctuel d'après nos habitudes<small class="mini" style="display:block">${UI.hab ? `Reste estimé : ${eur0(r.varRem)} de dépenses${r.incRem > 0.5 ? `, ${eur0(r.incRem)} de rentrées` : ''}` : 'Coupé : seulement les charges fixes et les opérations connues'}</small></span><input type="checkbox" id="habOn" ${UI.hab ? 'checked' : ''}></label>
    ${H.low.v < 0 ? `<div class="alert bad">Découvert prévu le ${lowTxt} : ${eur0(H.low.v)}</div>` : ''}
    <div class="actions"><button class="btn ghost small" data-fixbal="1">Corriger le solde</button><label class="btn ghost small" style="text-align:center;flex:1">Importer un relevé<input type="file" id="impFile" accept=".csv,.ofx,.qfx,.txt,text/csv" hidden></label></div>
    <div id="impErr"></div>
  </div>
  <div class="tiles">
    <button class="tile" data-go="fixed"><small>Fixes ${deMois(CUR)}</small><b>${fxOut ? '−' + eur0(fxOut) : eur0(0)}</b><span>${fxDone} passé${fxDone > 1 ? 's' : ''} · ${fx.length - fxDone} à venir</span></button>
    <button class="tile" data-go="ponct"><small>Ponctuel ${deMois(CUR)}</small><b>${pSpent ? '−' + eur0(pSpent) : eur0(0)}</b><span>${pHab ? `habitude ${eur0(pHab)} / mois` : 'dépenses hors fixes'}</span></button>
  </div>
  ${toRecon.length ? `<div class="block"><div class="rowhead"><h2>À pointer sur le relevé</h2><span class="sub">${toRecon.length} en attente</span></div>
    <div class="list">${toRecon.map(e => `<div class="recon"><span class="day" style="font-family:var(--f-mono);font-size:12px;text-align:center;background:var(--sunk);border-radius:8px;padding:5px 0;color:var(--muted)">${e.d}</span><span class="lbl"><b>${esc(e.label)}</b><small>prévu ${eur(Math.abs(e.v))} · pas encore vu</small></span><input id="rc-${esc(e.key)}" inputmode="decimal" value="${fr(r2(Math.abs(e.v)))}" aria-label="Montant réel"><button class="chk" data-recon="${esc(e.key)}" aria-label="Pointer">✓</button></div>`).join('')}</div>
    <div class="hint">Date passée mais pas encore vu sur le compte : compté dans la fin de mois, pas dans le solde du jour. Pointe-le quand il passe (corrige le montant si besoin) ; importer le relevé les pointe tout seul.</div>
  </div>` : ''}
  ${cats.length ? `<div class="block"><div class="rowhead"><h2>Ponctuel : où part l'argent</h2><button class="btn ghost small" data-go="ponct">Détail</button></div>
    <div class="list">${cats.map(c => { const p = c.target ? c.spent / c.target : (c.spent ? 2 : 0), cl = p > 1 ? 'over' : p > frac + .15 ? 'near' : '';
      return `<button class="catbar" data-pcat="${esc(c.nom)}"><div class="t"><b>${esc(catLabel(c.nom))}${c.n ? '<small class="mini"> · détail</small>' : ''}</b><span>${eur0(c.spent)} / ${eur0(c.target)}${c.budget ? ' budget' : ''}</span></div><div class="bar"><i class="${cl}" style="width:${Math.min(100, p * 100)}%"></i><em style="left:${frac * 100}%"></em></div></button>`; }).join('')}</div>
    <div class="hint">Dépensé ce mois-ci / habitude (ou budget s'il y en a un). Le trait : où vous devriez en être au ${TODAY}. Hors fixes et hors mouvements exceptionnels.</div></div>` : ''}
  <div class="block"><div class="rowhead"><h2>À venir d'ici le ${r.D}</h2><span class="sub">${upcoming.length} opération${upcoming.length > 1 ? 's' : ''}</span></div>
    <div class="list">${upcoming.length ? upcoming.map(rowEv).join('') : `<div class="empty">Plus rien de prévu ce mois-ci.</div>`}
    ${r.varRem > 0.5 ? `<div class="item" disabled><span class="day">~</span><span class="lbl"><b>Reste du ponctuel</b><small>estimé d'après les habitudes, réparti sur les jours restants</small></span><span class="amt neg">${sgn(-r.varRem)}</span></div>` : ''}
    ${r.incRem > 0.5 ? `<div class="item" disabled><span class="day">~</span><span class="lbl"><b>Rentrées habituelles</b><small>remboursements, aides… estimées</small></span><span class="amt pos">${sgn(r.incRem)}</span></div>` : ''}</div>
  </div>
  <div class="block"><div class="rowhead"><h2>Dernières opérations</h2><button class="btn ghost small" data-go="ponct">Tout voir</button></div>
    <div class="list">${recent.length ? recent.map(rowEv).join('') : `<div class="empty">Aucune opération ce mois-ci.</div>`}</div>
  </div></section>`;
}

// Bandeaux : serveur à mettre à jour, doublons virement lié / rentrée fixe, compte importé avant la V1.4
function banners(acc) {
  let h = bankBanners(acc);
  if (SYNC.v && SYNC.v < '1.4') h += `<div class="banner warn"><span>Serveur en V${esc(SYNC.v)} : mets à jour <b>Code.gs</b> (Apps Script, nouvelle version) pour garder les noms et catégories appris.</span></div>`;
  DB.virements.filter(v => v.vers === acc && bool(v.actif)).forEach(v => { const f = dupFixeFor(v); if (f) h += `<div class="banner warn"><span>« <b>${esc(f.libelle)}</b> » fait doublon avec le virement lié « ${esc(v.libelle)} » : compté deux fois.</span><button class="btn small" data-dupfix="${esc(f.id)}" data-dupvir="${esc(v.id)}">Corriger</button></div>`; });
  if (DB.operations.some(o => o.compte === acc && o.ref) && !param('imp14|' + acc, '') && !store.get('le31-noreimp|' + acc, false))
    h += `<div class="banner"><span style="display:flex;flex-direction:column;gap:8px">Ce compte a été importé avec une ancienne version. <span><b>Refais l'import</b> avec le même relevé et choisis « Tout refaire » : charges fixes, noms et prévisions seront justes.</span><span class="actions"><label class="btn small" style="text-align:center">Choisir le relevé<input type="file" id="impFile" accept=".csv,.ofx,.qfx,.txt,text/csv" hidden></label><button class="btn ghost small" data-noreimp="${esc(acc)}">Plus tard</button></span></span></div>`;
  const PS = payState(acc);
  if (PS) {
    const vuKey = 'le31-payeVu|' + acc, vu = store.get(vuKey, '');
    if (vu && vu !== PS.start) { store.set(vuKey, PS.start); h += `<div class="banner"><span>Nouvelle paie détectée le <b>${dLabel(PS.start)}</b> : la période affichée va maintenant jusqu'au ${dLabel(PS.end)} environ. Rien n'est compté en double : c'est seulement la fenêtre affichée qui avance avec la paie.</span></div>`; }
    else if (!vu) store.set(vuKey, PS.start);
  }
  return h;
}

/* ----- Onglet Ponctuel : toutes les opérations, mois par mois ----- */
const P = { k: null, q: '', f: 'tout', cat: '', view: store.get('le31-pview', 'ponct') };
function vPonct() {
  const acc = UI.acc;
  if (!started(acc)) return `<section class="view"><div class="note">Démarre d'abord le compte dans l'onglet Mois (import d'un relevé ou solde à la main).</div></section>`;
  const vseg = `<div class="seg" role="group" aria-label="Vue"><button data-pview="ponct" aria-pressed="${P.view !== 'releve'}">Ponctuel</button><button data-pview="releve" aria-pressed="${P.view === 'releve'}">Relevé complet</button></div>`;
  if (P.view === 'releve') return vReleve(vseg);
  const k0 = startMonth(acc), lastOp = DB.operations.filter(o => o.compte === acc).reduce((m, o) => String(o.date).slice(0, 7) > m ? String(o.date).slice(0, 7) : m, CUR);
  if (!P.k || P.k < k0) P.k = CUR;
  const q = NORM(P.q.trim()), all = DB.operations.filter(o => o.compte === acc);
  const base = q ? all.filter(o => NORM(nameOf(o) + ' ' + o.libelle + ' ' + (o.categorie || '')).includes(q)) : all.filter(o => String(o.date).slice(0, 7) === P.k);
  const F = { tout: o => true, nc: o => isPonct(o) && !o.categorie, exc: o => o.type === 'exc' || o.type === 'int', in: o => (num(o.montant) || 0) > 0 && isPonct(o), cat: o => (P.cat ? inCat(o.categorie, P.cat) : !o.categorie) && isPonct(o) };
  const list = base.filter(F[P.f] || F.tout).sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(b.id).localeCompare(String(a.id)));
  const ncAll = all.filter(F.nc).length;
  const r = calc(acc, P.k, startOf(acc, P.k)), spent = r.cats.reduce((a, c) => a + c.spent, 0), hab = catList(acc).reduce((a, c) => a + habit(acc, c.nom), 0);
  const inc = incomeMonth(acc, P.k), ratio = hab ? spent / (hab * (P.k === CUR ? Math.max(.2, TODAY / dim(CUR)) : 1)) : 0;
  const pill = !hab ? '' : ratio > 1.1 ? '<span class="pill bad">au-dessus</span>' : ratio > .95 ? '<span class="pill warn">dans la moyenne</span>' : '<span class="pill good">sous l\'habitude</span>';
  const groups = {}; list.slice(0, 300).forEach(o => { const g = q ? String(o.date).slice(0, 7) : String(o.date); (groups[g] = groups[g] || []).push(o); });
  const head = g => q ? mLabel(g) : (+g.slice(8, 10)) + ' ' + MONTHS_L[pm(g.slice(0, 7)).m];
  const row = o => { const v = num(o.montant) || 0, tg = o.type === 'exc' ? '<span class="tag w">exceptionnel</span>' : o.type === 'int' ? '<span class="tag g">entre mes comptes</span>' : o.type === 'vir' ? '<span class="tag">lié</span>' : '';
    return `<button class="item" data-oid="${esc(o.id)}" style="grid-template-columns:1fr auto"><span class="lbl"><b>${esc(nameOf(o))}${tg}</b><small>${o.type === 'ajust' ? 'Correction de solde' : o.categorie ? catHtml(o.categorie) : '<span style="color:var(--warn);font-weight:700">À classer</span>'}${q ? ' · ' + (+String(o.date).slice(8, 10)) + ' ' + MONTHS[pm(String(o.date).slice(0, 7)).m] + ' ' + String(o.date).slice(2, 4) : ''}${o.profil && DB.profils.length > 1 && o.profil !== ME ? ' · ' + esc(pname(o.profil)) : ''}</small></span><span class="amt ${v > 0 ? 'pos' : 'neg'}">${sgn(v)}</span></button>`; };
  return `<section class="view">${vseg}
    ${q ? `<div class="rowhead"><h2>${list.length} résultat${list.length > 1 ? 's' : ''}</h2><span class="sub">tous les mois</span></div>` : `<div class="mnav"><button data-pm="-1" aria-label="Mois précédent" ${P.k <= k0 ? 'disabled' : ''}>‹</button><b>${mLabel(P.k)}</b><button data-pm="1" aria-label="Mois suivant" ${P.k >= lastOp ? 'disabled' : ''}>›</button></div>
    <div class="hero" style="gap:8px"><div class="rowhead"><span class="sub">Dépenses ponctuelles${P.k === CUR ? ' à ce jour' : ''}</span>${P.k <= CUR ? pill : ''}</div>
      <div class="big num" style="font-size:34px">${eur0(spent)}</div>
      <div class="hint" style="font-size:13px">Habitude : ${eur0(hab)} par mois${inc > 0.5 ? ` · rentrées ponctuelles : ${eur0(inc)}` : ''}. Hors charges fixes, hors exceptionnel et virements entre tes comptes.</div></div>`}
    <div class="search"><input id="pQ" type="search" placeholder="Rechercher (Amazon, resto…)" value="${esc(P.q)}" aria-label="Rechercher" autocomplete="off" enterkeyhint="search"></div>
    <div class="chips">${[['tout', 'Tout'], ['nc', 'À classer' + (ncAll ? ' · ' + ncAll : '')], ['exc', 'Exceptionnels'], ['in', 'Rentrées']].concat(P.f === 'cat' ? [['cat', catLabel(P.cat)]] : []).map(([k, l]) => `<button class="chip" data-pf="${k}" aria-pressed="${P.f === k}">${esc(l)}</button>`).join('')}</div>
    ${P.f === 'nc' && !q && ncAll > list.length ? `<div class="hint">${ncAll} opération(s) à classer en tout, sur plusieurs mois : tape une lettre dans la recherche pour les voir toutes, ou change de mois.</div>` : ''}
    ${Object.keys(groups).length ? Object.keys(groups).sort().reverse().map(g => `<div class="dayhead">${head(g)}</div><div class="list">${groups[g].map(row).join('')}</div>`).join('') : `<div class="empty">Aucune opération${q ? ' trouvée' : ' ce mois-ci'}.</div>`}
    ${list.length > 300 ? '<div class="hint">300 premières affichées : précise la recherche.</div>' : ''}
    <div class="hint">Touche une opération pour la renommer, la classer (avec toutes celles du même marchand), ou la marquer exceptionnelle.</div>
  </section>`;
}


/* ----- Relevé complet : toutes les entrées et sorties du mois, comme sur le relevé de la banque, avec le solde après chaque ligne ----- */
function vReleve(vseg) {
  const acc = UI.acc, k0 = startMonth(acc);
  if (!P.k || P.k < k0) P.k = CUR;
  const k = P.k, start = startOf(acc, k), r = calc(acc, k, start);
  const passed = r.ev.filter(e => e.kind !== 'sim' && !e.late && e.d <= (k < CUR ? r.D : k === CUR ? r.T : 0)), todo = r.ev.filter(e => e.kind !== 'sim' && !passed.includes(e));
  const ord = (a, b) => a.d - b.d || (b.v > 0) - (a.v > 0);
  let s = start; const rows = passed.slice().sort(ord).map(e => { s += e.v; return { e, s }; });
  const inn = passed.filter(e => e.v > 0).reduce((x, e) => x + e.v, 0), out = -passed.filter(e => e.v < 0).reduce((x, e) => x + e.v, 0);
  const bk = bkRow(acc), bkS = bk && bk.solde !== '' ? num(bk.solde) : null, gap = bkS !== null && k === CUR ? r2(r.bal - bkS) : null;
  // doublons possibles : même jour, même montant
  const seen = {}; passed.forEach(e => { const kk = e.d + '|' + r2(e.v); seen[kk] = (seen[kk] || 0) + 1; });
  const line = (e, sAfter, fut) => {
    const attr = e.kind === 'fixe' ? `data-fid="${esc(e.id)}"` : e.kind === 'vir' ? `data-vid="${esc(e.id)}"` : `data-oid="${esc(e.id)}"`;
    const tag = e.kind === 'fixe' ? `<span class="tag ${e.ok ? 'ok' : ''}">fixe${e.ok ? ' ✓' : ''}</span>` : e.kind === 'vir' || e.kind === 'virop' ? '<span class="tag">lié</span>' : e.kind === 'ajust' ? '<span class="tag w">correction</span>' : e.x === 'exc' ? '<span class="tag w">exceptionnel</span>' : e.x === 'int' ? '<span class="tag g">entre mes comptes</span>' : '';
    const dbl = !fut && seen[e.d + '|' + r2(e.v)] > 1 ? '<span class="tag w">même jour, même montant</span>' : '';
    const sub = fut ? (e.late ? 'date passée, pas encore vue sur le compte' : 'prévu') : e.kind === 'ajust' ? 'écart corrigé pour coller au solde réel' : e.kind === 'fixe' || e.kind === 'vir' ? (e.ok ? 'vu sur le compte' : 'prévu, pas pointé') : (e.cat ? esc(e.cat) : 'À classer');
    return `<button class="item rl2" ${attr} style="grid-template-columns:34px 1fr auto"><span class="day">${e.d}</span><span class="lbl"><b>${esc(e.label || '')}${tag}${dbl}</b><small>${sub}</small></span><span class="amt ${e.v > 0 ? 'pos' : 'neg'}">${sgn(e.v)}${sAfter != null ? `<small>solde ${eur(r2(sAfter))}</small>` : ''}</span></button>`;
  };
  return `<section class="view">${vseg}
    <div class="mnav"><button data-pm="-1" aria-label="Mois précédent" ${k <= k0 ? 'disabled' : ''}>‹</button><b>${mLabel(k)}</b><button data-pm="1" aria-label="Mois suivant" ${k >= CUR ? 'disabled' : ''}>›</button></div>
    <div class="hero" style="gap:10px">
      <div class="kv"><div><small>Solde au 1er</small><b>${eur(r2(start))}</b></div><div><small>${k === CUR ? 'Solde aujourd\'hui' : 'Solde fin de mois'}</small><b>${eur(r2(s))}</b></div></div>
      <div class="kv"><div><small>Entrées</small><b class="pos">+${eur(r2(inn))}</b></div><div><small>Sorties</small><b>−${eur(r2(out))}</b></div></div>
      ${gap !== null ? (Math.abs(gap) >= 1 ? `<div class="note warn"><b>Écart avec la banque : ${sgn(gap)}</b> (banque : ${eur(bkS)}, lu ${esc(bkTime(acc))}). Cherche une ligne en double ou en trop ci-dessous (repère « même jour, même montant » ou « correction ») : touche-la pour la corriger ou la supprimer.</div>` : `<div class="note good">Identique au solde de la banque (${eur(bkS)}, lu ${esc(bkTime(acc))}).</div>`) : ''}
    </div>
    ${todo.length ? `<div class="dayhead">À venir d'ici le ${r.D}</div><div class="list">${todo.slice().sort(ord).map(e => line(e, null, true)).join('')}</div>` : ''}
    <div class="dayhead">Passé · du plus récent au plus ancien</div>
    <div class="list">${rows.length ? rows.slice().reverse().map(x => line(x.e, x.s)).join('') : '<div class="empty">Aucun mouvement ce mois-ci.</div>'}</div>
    <div class="hint">Toutes les lignes du mois : charges fixes (✓ = vues sur le compte), virements liés, dépenses et rentrées ponctuelles, corrections de solde. Le solde après chaque ligne se compare au relevé de la banque.</div>
  </section>`;
}

/* ----- Onglet Bilan : évolution mois par mois des thèmes choisis ----- */
const BIL = { n: store.get('le31-bil-n', 12), mode: store.get('le31-bil-mode', 'barres'), exc: false, sel: null, table: false };
const BTHEMES = { __ponct: 'Tout le ponctuel', __fixes: 'Toutes les charges fixes' };
const bLabel = c => BTHEMES[c] || catLabel(leafOf(c));
// remplacer une catégorie principale par toutes ses sous-catégories
function bilDetail(acc, P) {
  const S = bilSel(acc), kids = catsOf(acc).map(c => c.nom).filter(n => n.startsWith(P + SEP));
  S.cats = S.cats.filter(c => c !== P); delete S.col[P];
  kids.forEach(k => { if (S.cats.length < 8 && !S.cats.includes(k)) { const u = new Set(Object.values(S.col)); let s = 1; while (u.has(s)) s++; S.cats.push(k); S.col[k] = s; } });
  store.set('le31-bil|' + acc, S); render();
}
function bilSel(acc) {
  const s = store.get('le31-bil|' + acc, null);
  if (s && s.cats) return s;
  // par défaut : les 3 catégories où part le plus d'argent
  const tot = {}; DB.operations.filter(o => o.compte === acc && isPonct(o) && o.categorie && (num(o.montant) || 0) < 0).forEach(o => tot[o.categorie] = (tot[o.categorie] || 0) - num(o.montant));
  const cats = Object.entries(tot).filter(([c]) => !isIncomeCat(c)).sort((a, b) => b[1] - a[1]).slice(0, 3).map(x => x[0]);
  const col = {}; cats.forEach((c, i) => col[c] = i + 1);
  return { cats, col };
}
// montant d'un thème sur un mois (dépenses en positif ; pour une catégorie de rentrées, les rentrées)
function bilVal(acc, k, c) {
  const ev = events(acc, k), T = k < CUR ? 99 : k === CUR ? TODAY : 0;
  const okOp = o => isPonct(o) || (BIL.exc && (o.type === 'exc'));
  if (c === '__ponct') return Math.max(0, -opsOf(acc, k).filter(o => okOp(o) && !isIncomeCat(o.categorie) && (o.categorie || (num(o.montant) || 0) < 0)).reduce((a, o) => a + (num(o.montant) || 0), 0));
  const fx = e => (e.kind === 'fixe' || e.kind === 'vir') && (e.ok || e.d <= T);
  if (c === '__fixes') return -ev.filter(e => fx(e) && e.v < 0).reduce((a, e) => a + e.v, 0);
  const mine = x => c ? inCat(x, c) : !x; // une catégorie principale comprend ses sous-catégories
  const ops = opsOf(acc, k).filter(o => okOp(o) && mine(o.categorie)).reduce((a, o) => a + (num(o.montant) || 0), 0);
  const fix = ev.filter(e => fx(e) && e.kind === 'fixe' && mine(e.cat === 'Autre' ? '' : e.cat)).reduce((a, e) => a + e.v, 0);
  const net = ops + fix;
  return isIncomeCat(c) ? Math.max(0, net) : Math.max(0, -net);
}
function vBilan() {
  const acc = UI.acc;
  if (!started(acc)) return `<section class="view"><div class="note">Démarre d'abord le compte dans l'onglet Mois (import d'un relevé ou solde à la main).</div></section>`;
  const S = bilSel(acc), k0 = startMonth(acc), n = BIL.n === 0 ? diffM(k0, CUR) + 1 : Math.min(BIL.n, diffM(k0, CUR) + 1);
  const months = Array.from({ length: n }, (_, i) => addM(CUR, i - n + 1));
  const used = new Set(DB.operations.filter(o => o.compte === acc && (isPonct(o) || o.type === 'exc')).map(o => o.categorie || ''));
  DB.fixes.filter(f => f.compte === acc).forEach(f => used.add(f.categorie || ''));
  [...used].forEach(c => { if (c.includes(SEP)) used.add(topOf(c)); });
  const cats = catsOf(acc).map(c => c.nom).filter(c => used.has(c)).concat([...used].filter(c => c && !catsOf(acc).some(x => x.nom === c) && !['Virement', 'Correction de solde'].includes(c))).concat(used.has('') ? [''] : []);
  const themes = ['__ponct', '__fixes'].concat(cats), sel = S.cats.filter(c => themes.includes(c));
  const data = sel.map(c => ({ c, v: months.map(k => bilVal(acc, k, c)) }));
  // « Tout le ponctuel » contient déjà les catégories : on ne les additionne pas (barres côte à côte, pas de total)
  const fixCats = new Set(DB.fixes.filter(f => f.compte === acc).map(f => f.categorie || ''));
  const overlap = (sel.includes('__ponct') && sel.some(c => !BTHEMES[c])) || (sel.includes('__fixes') && sel.some(c => !BTHEMES[c] && [...fixCats].some(f => inCat(f, c))))
    || sel.some(c => !BTHEMES[c] && sel.some(d => d !== c && !BTHEMES[d] && inCat(d, c)));
  BIL.overlap = overlap;
  data.forEach(d => { const f = months.map((k, i) => i).filter(i => months[i] < CUR); d.avg = f.length ? f.reduce((x, i) => x + d.v[i], 0) / f.length : 0; });
  const tot = months.map((k, i) => data.reduce((a, d) => a + d.v[i], 0));
  const full = months.map((k, i) => i).filter(i => months[i] < CUR), avg = full.length ? full.reduce((a, i) => a + tot[i], 0) / full.length : 0;
  const l3 = full.slice(-3), p3 = full.slice(-6, -3), m3 = l3.length ? l3.reduce((a, i) => a + tot[i], 0) / l3.length : 0, mp = p3.length ? p3.reduce((a, i) => a + tot[i], 0) / p3.length : 0;
  const trend = p3.length && mp > 0 ? (m3 - mp) / mp : null;
  const hasKids = c => !BTHEMES[c] && cats.some(x => x.startsWith(c + SEP));
  const chip = c => { const on = sel.includes(c), kid = c.includes(SEP); return `<button class="chip bchip ${kid ? 'kid' : ''}" data-bcat="${esc(c)}" aria-pressed="${on}">${on ? `<i style="background:var(--s${S.col[c] || 1})"></i>` : ''}${kid ? '↳ ' + esc(leafOf(c)) : esc(bLabel(c)) + (hasKids(c) ? ' (tout)' : '')}</button>${hasKids(c) && on ? `<button class="chip bdet" data-bdet="${esc(c)}">Détailler ${esc(c)}</button>` : ''}`; };
  const selM = BIL.sel && months.includes(BIL.sel) ? BIL.sel : null;
  return `<section class="view">
    <div class="rowhead"><h2>Bilan</h2><span class="sub">${esc(accName(acc))}</span></div>
    <div class="block" style="gap:8px"><div class="mini">Thèmes à suivre (8 au plus) :</div>
      <div class="chips">${themes.map(chip).join('')}</div></div>
    <div class="bctl"><div class="seg" style="grid-template-columns:1fr 1fr 1fr" role="group" aria-label="Période">${[[6, '6 mois'], [12, '12 mois'], [0, 'Tout']].map(([v, l]) => `<button data-bn="${v}" aria-pressed="${BIL.n === v}">${l}</button>`).join('')}</div>
      <div class="seg" role="group" aria-label="Graphique">${[['barres', 'Barres'], ['courbes', 'Courbes']].map(([v, l]) => `<button data-bmode="${v}" aria-pressed="${BIL.mode === v}">${l}</button>`).join('')}</div></div>
    ${!sel.length ? `<div class="note">Choisis un ou plusieurs thèmes ci-dessus : par exemple <b>Abonnements</b>, <b>Courses</b> et <b>Carburant</b>, ou <b>Tout le ponctuel</b>.</div>` : `
    <div class="hero" style="gap:12px">
      ${overlap ? '<div class="hint">« Tout le ponctuel » comprend déjà les catégories choisies : les barres sont côte à côte, sans total.</div>' : `<div class="kv"><div><small>Moyenne / mois${full.length < months.length ? ' (mois complets)' : ''}</small><b>${eur0(avg)}</b></div><div><small>${trend === null ? 'Total sur la période' : '3 derniers mois / 3 précédents'}</small><b style="color:var(--${trend === null ? 'ink' : trend > 0.05 ? 'bad' : trend < -0.05 ? 'good' : 'ink'})">${trend === null ? eur0(tot.reduce((a, b) => a + b, 0)) : (trend > 0 ? '+' : '') + Math.round(trend * 100) + ' %'}</b></div></div>`}
      ${bilChart(months, data, S, selM)}
      <div class="legend">${data.map(d => `<span><i style="background:var(--s${S.col[d.c] || 1})"></i>${esc(bLabel(d.c))} · <b class="num" style="color:var(--ink)">${eur0(d.avg)}</b>/mois</span>`).join('')}</div>
      ${selM ? (() => { const i = months.indexOf(selM); return `<div class="note" style="display:flex;flex-direction:column;gap:4px"><b>${mLabel(selM)}${selM === CUR ? ' (en cours)' : ''}</b>${data.map(d => `<span style="display:flex;justify-content:space-between;gap:8px"><span>${esc(bLabel(d.c))}</span><b class="num">${eur(r2(d.v[i]))}</b></span>`).join('')}${data.length > 1 && !overlap ? `<span style="display:flex;justify-content:space-between;border-top:1px solid var(--line);padding-top:4px"><span>Total</span><b class="num">${eur(r2(tot[i]))}</b></span>` : ''}</div>`; })() : '<div class="hint">Touche un mois sur le graphique pour voir le détail. Le mois en cours est plus clair : il n\'est pas fini.</div>'}
    </div>
    <label class="switch" for="bExc"><span style="font-size:14px">Inclure les dépenses exceptionnelles</span><input type="checkbox" id="bExc" ${BIL.exc ? 'checked' : ''}></label>
    <div class="block"><div class="rowhead"><h2>Mois par mois</h2></div>
      <div class="tablewrap"><table><thead><tr><th>Mois</th>${data.map(d => `<th>${esc(bLabel(d.c))}</th>`).join('')}${data.length > 1 && !overlap ? '<th>Total</th>' : ''}</tr></thead><tbody>
      ${months.slice().reverse().map(k => { const i = months.indexOf(k); return `<tr><td>${mShort(k)} ${String(pm(k).y).slice(2)}${k === CUR ? ' · en cours' : ''}</td>${data.map(d => `<td>${eur0(d.v[i])}</td>`).join('')}${data.length > 1 && !overlap ? `<td class="end">${eur0(tot[i])}</td>` : ''}</tr>`; }).join('')}
      </tbody></table></div>
      <div class="hint">Charges fixes comprises dans chaque catégorie (ex. Netflix dans Abonnements). Remboursements déduits. Les virements entre tes comptes ne comptent pas.</div></div>`}
  </section>`;
}
function bilChart(months, data, S, selM) {
  const W = 340, H = 190, L = 40, R = 6, Tp = 10, B = 24, n = months.length;
  const stack = BIL.mode === 'barres' && !BIL.overlap, group = BIL.mode === 'barres' && BIL.overlap;
  const mxv = Math.max(1, ...months.map((k, i) => stack ? data.reduce((a, d) => a + d.v[i], 0) : Math.max(...data.map(d => d.v[i]))));
  const step = niceStep(mxv / 4), top = Math.ceil(mxv / step) * step;
  const bw = (W - L - R) / n, x = i => L + i * bw, y = v => Tp + (top - v) * (H - Tp - B) / top;
  let g = '';
  for (let t = 0; t <= top + 0.1; t += step) g += `<line x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}" stroke="var(--line)" stroke-width="1"/><text x="${L - 5}" y="${y(t) + 3.5}" text-anchor="end" font-size="9.5" fill="var(--muted)">${t >= 1000 ? (t / 1000).toLocaleString('fr-FR') + ' k' : Math.round(t)}</text>`;
  const lab = Math.ceil(n / 7);
  months.forEach((k, i) => { if ((n - 1 - i) % lab === 0) g += `<text x="${x(i) + bw / 2}" y="${H - 8}" text-anchor="middle" font-size="9.5" fill="var(--muted)">${mShort(k).replace('.', '')}${pm(k).m === 0 ? ' ' + String(pm(k).y).slice(2) : ''}</text>`; });
  if (group) {
    const gw = Math.min(bw * 0.8, 10 * data.length + 8), w = Math.max(2, gw / data.length - 2);
    months.forEach((k, i) => data.forEach((d, j) => { const v = d.v[i]; if (v <= 0.5) return; const cx = x(i) + (bw - gw) / 2 + j * (w + 2), y1 = y(v), h = Math.max(1, y(0) - y1), rr = Math.min(3, w / 2, h);
      g += `<path d="M${cx},${y(0)} V${y1 + rr} q0,-${rr} ${rr},-${rr} H${cx + w - rr} q${rr},0 ${rr},${rr} V${y(0)} Z" fill="var(--s${S.col[d.c] || 1})" opacity="${k === CUR ? .45 : 1}"/>`; }));
  } else if (stack) {
    const w = Math.max(3, Math.min(26, bw * 0.62));
    months.forEach((k, i) => {
      let base = 0; const cx = x(i) + (bw - w) / 2, cur = k === CUR;
      data.forEach((d, j) => { const v = d.v[i]; if (v <= 0.5) return; const y1 = y(base + v), y0 = y(base), last = data.slice(j + 1).every(e => e.v[i] <= 0.5);
        const h = Math.max(1, y0 - y1 - (base > 0 ? 2 : 0));
        g += last ? `<path d="M${cx},${y0 - (base > 0 ? 2 : 0)} V${y1 + Math.min(4, h / 2)} q0,-${Math.min(4, h / 2)} ${Math.min(4, w / 2)},-${Math.min(4, h / 2)} H${cx + w - Math.min(4, w / 2)} q${Math.min(4, w / 2)},0 ${Math.min(4, w / 2)},${Math.min(4, h / 2)} V${y0 - (base > 0 ? 2 : 0)} Z" fill="var(--s${S.col[d.c] || 1})" opacity="${cur ? .45 : 1}"/>`
          : `<rect x="${cx}" y="${y1}" width="${w}" height="${h}" fill="var(--s${S.col[d.c] || 1})" opacity="${cur ? .45 : 1}"/>`;
        base += v; });
    });
  } else {
    data.forEach(d => {
      const pts = d.v.map((v, i) => [x(i) + bw / 2, y(v)]), col = `var(--s${S.col[d.c] || 1})`, done = pts.slice(0, months[n - 1] === CUR ? n - 1 : n);
      g += `<polyline points="${done.map(p => p.join(',')).join(' ')}" fill="none" stroke="${col}" stroke-width="2" stroke-linejoin="round"/>`;
      if (months[n - 1] === CUR && n > 1) g += `<polyline points="${pts.slice(n - 2).map(p => p.join(',')).join(' ')}" fill="none" stroke="${col}" stroke-width="2" stroke-dasharray="4 3"/>`;
      if (n <= 13) pts.forEach(p => g += `<circle cx="${p[0]}" cy="${p[1]}" r="3.2" fill="${col}" stroke="var(--surface)" stroke-width="1.5"/>`);
    });
  }
  if (selM) { const i = months.indexOf(selM); g = `<rect x="${x(i)}" y="${Tp}" width="${bw}" height="${H - Tp - B}" fill="var(--accent-soft)" rx="4"/>` + g; }
  g += `<line x1="${L}" x2="${W - R}" y1="${y(0)}" y2="${y(0)}" stroke="var(--muted)" stroke-width="1"/>`;
  months.forEach((k, i) => g += `<rect x="${x(i)}" y="0" width="${bw}" height="${H}" fill="transparent" data-bm="${k}" style="cursor:pointer"><title>${mLabel(k)}</title></rect>`);
  return `<svg class="curve" viewBox="0 0 ${W} ${H}" role="img" aria-label="Évolution mois par mois">${g}</svg>`;
}
function bilToggle(acc, c) {
  const S = bilSel(acc);
  if (S.cats.includes(c)) { S.cats = S.cats.filter(x => x !== c); delete S.col[c]; }
  else { if (S.cats.length >= 8) { toast('8 thèmes au plus : retires-en un'); return; } const usedC = new Set(Object.values(S.col)); let s = 1; while (usedC.has(s)) s++; S.cats.push(c); S.col[c] = s; }
  store.set('le31-bil|' + acc, S); render();
}

/* ----- Onglet Charges ----- */
function vFixed() {
  const acc = UI.acc, A = accOf(acc), sortd = a => a.slice().sort((x, y) => (num(x.jour) || 0) - (num(y.jour) || 0));
  const per = f => { const a = num(f.montant) || 0; return f.frequence === 'T' ? a / 3 : f.frequence === 'A' ? a / 12 : a; };
  const fx = DB.fixes.filter(f => f.compte === acc);
  const live = f => bool(f.actif) && (!f.fin || f.fin >= CUR);
  const vr = DB.virements.filter(v => v.de === acc || v.vers === acc);
  const vrIn = v => v.vers === acc;
  const tot = fx.filter(f => live(f) && f.sens !== '+').reduce((a, f) => a + per(f), 0) + vr.filter(v => bool(v.actif) && !vrIn(v)).reduce((a, v) => a + (num(v.montant) || 0), 0);
  const totR = fx.filter(f => live(f) && f.sens === '+').reduce((a, f) => a + per(f), 0) + vr.filter(v => bool(v.actif) && vrIn(v)).reduce((a, v) => a + (num(v.montant) || 0), 0);
  const stateTxt = (cle, day, occ, active) => !active ? ' · en pause' : point(CUR, cle) ? ' · pointé ✓' : occ && day <= TODAY ? ' · à pointer' : occ ? ' · à venir' : '';
  const row = f => {
    const occ = occursF(f, CUR), fin = f.fin ? ` · jusqu'à ${mShort(f.fin)} ${pm(f.fin).y}` : '';
    return `<button class="item ${bool(f.actif) && (!f.fin || f.fin >= CUR) ? '' : 'off'}" data-fid="${esc(f.id)}"><span class="day">le ${esc(f.jour)}</span><span class="lbl"><b>${esc(f.libelle)}</b><small>${esc(f.categorie || 'Autre')} · ${FREQ[f.frequence] || 'Mensuel'}${f.frequence === 'T' || f.frequence === 'A' ? ' (' + MONTHS[(num(f.moisRef) || 1) - 1] + ')' : ''}${fin}${stateTxt('f' + f.id, num(f.jour), occ, bool(f.actif))}</small></span><span class="amt ${f.sens === '+' ? 'pos' : 'neg'}">${f.sens === '+' ? '+' : '−'}${eur(num(f.montant) || 0)}${f.frequence === 'T' || f.frequence === 'A' ? `<small>≈ ${eur(per(f))}/mois</small>` : ''}</span></button>`;
  };
  const rowV = v => `<button class="item ${bool(v.actif) ? '' : 'off'}" data-vid="${esc(v.id)}"><span class="day">le ${esc(v.jour)}</span><span class="lbl"><b>${esc(v.libelle || 'Virement')}<span class="tag">lié</span></b><small>${esc(accName(v.de))} → ${esc(accName(v.vers))}${v.profil ? ' · ' + esc(pname(v.profil)) : ''}${stateTxt('v' + v.id, num(v.jour), occursV(v, CUR), bool(v.actif))}</small></span><span class="amt ${vrIn(v) ? 'pos' : 'neg'}">${vrIn(v) ? '+' : '−'}${eur(num(v.montant) || 0)}</span></button>`;
  const rev = sortd(fx.filter(f => f.sens === '+')), men = sortd(fx.filter(f => f.sens !== '+' && (f.frequence || 'M') === 'M')), oth = sortd(fx.filter(f => f.sens !== '+' && f.frequence && f.frequence !== 'M'));
  const env = catsOf(acc).reduce((a, c) => a + (num(c.budget) || 0), 0);
  return `<section class="view">
    <div class="hero" style="gap:10px">
      <div class="kv"><div><small>Rentrées fixes / mois</small><b class="pos">${eur(totR)}</b></div><div><small>Sorties fixes / mois</small><b>${eur(tot)}</b></div></div>
      <div class="hint" style="font-size:13px">Reste pour vivre après les fixes : <b style="color:var(--ink)">${eur(totR - tot)}</b>${env ? `, dont ${eur0(env)} en enveloppes` : ''}.</div>
    </div>
    <div class="block"><div class="rowhead"><h2>Virements liés</h2><span class="sub">entre les comptes</span></div>
      <div class="list">${vr.length ? sortd(vr).map(rowV).join('') : `<div class="empty">Aucun virement lié.</div>`}</div>
      <div class="hint">Une seule ligne : elle débite un compte et crédite l'autre automatiquement.</div></div>
    <div class="block"><div class="rowhead"><h2>Rentrées</h2></div><div class="list">${rev.length ? rev.map(row).join('') : `<div class="empty">Aucune rentrée fixe (salaire…).</div>`}</div></div>
    <div class="block"><div class="rowhead"><h2>Charges mensuelles</h2><span class="sub">${men.length}</span></div><div class="list">${men.length ? men.map(row).join('') : `<div class="empty">Aucune charge mensuelle.</div>`}</div></div>
    <div class="block"><div class="rowhead"><h2>Trimestrielles et annuelles</h2></div><div class="list">${oth.length ? oth.map(row).join('') : `<div class="empty">Aucune.</div>`}</div></div>
    <div class="actions"><button class="btn" data-newfixed="1">Ajouter une charge, rentrée ou virement fixe</button></div>
  </section>`;
}

/* ----- Onglet Saisir ----- */
function vAdd() {
  const acc = UI.acc, cats = catsOf(acc).map(c => c.nom), oth = otherAcc(acc);
  if (!cats.includes(draft.cat)) draft.cat = cats[0] || null;
  const others = accs().filter(a => a.id !== acc);
  if (!others.find(a => a.id === draft.to)) draft.to = others[0] && others[0].id;
  const isVir = draft.sens === 'v' && others.length > 0;
  return `<section class="view"><form class="form" id="addForm" novalidate>
    <div class="seg" role="group" aria-label="Type" style="grid-template-columns:1fr 1fr 1fr"><button type="button" data-sens="-" aria-pressed="${draft.sens === '-'}">Dépense</button><button type="button" data-sens="+" aria-pressed="${draft.sens === '+'}">Rentrée</button>${others.length ? `<button type="button" data-sens="v" aria-pressed="${isVir}">Virement</button>` : ''}</div>
    <div class="amountbox"><input id="amt" inputmode="decimal" placeholder="0,00" aria-label="Montant" autocomplete="off"><span>€</span></div>
    ${isVir ? (others.length > 1 ? `<div class="field"><label for="vto">Vers</label><select id="vto" data-vto="1">${others.map(a => `<option value="${esc(a.id)}" ${a.id === draft.to ? 'selected' : ''}>${esc(a.nom)}</option>`).join('')}</select></div>` : '') + `<div class="note">De <b>${esc(accName(acc))}</b> vers <b>${esc(accName(draft.to))}</b> : l'opération apparaît sur les deux comptes.</div>` :
    `<div class="field"><label>Type de dépense</label><div class="chips">${cats.map(c => `<button type="button" class="chip" data-cat="${esc(c)}" aria-pressed="${c === draft.cat}">${catHtml(c)}</button>`).join('')}<button type="button" class="chip" data-newcat="${esc(acc)}" style="border-style:dashed;color:var(--accent)">＋ Nouvelle</button></div></div>`}
    <div class="two"><div class="field"><label for="dt">Date</label><input id="dt" type="date" value="${TODAY_ISO}"></div>
    <div class="field"><label for="lb">Libellé</label><input id="lb" placeholder="${isVir ? 'Ex. Complément courses' : 'Ex. Drive'}" autocomplete="off"></div></div>
    ${isVir ? '' : `<label class="switch" for="addExc"><span style="font-size:14px">Exceptionnel (hors habitudes)</span><input type="checkbox" id="addExc"></label>`}
    <div class="hint" style="font-size:13px">Compte : <b style="color:var(--ink)">${esc(accName(acc))}</b>. Une date dans un mois futur crée une opération prévue, prise en compte dans les prévisions.</div>
    <button class="btn" type="submit">Enregistrer</button>
  </form></section>`;
}

/* ----- Onglet Prévisions ----- */
function vFore() {
  const seg = `<div class="seg" role="group" aria-label="Vue"><button data-ftab="budget" aria-pressed="${UI.foreTab === 'budget'}">Budget</button><button data-ftab="tax" aria-pressed="${UI.foreTab === 'tax'}">Impôts</button></div>`;
  return seg + (UI.foreTab === 'tax' ? vTax() : vBudget());
}
function vBudget() {
  const acc = UI.acc;
  if (!started(acc)) return `<section class="view"><div class="note">Indique d'abord le solde actuel du compte dans l'onglet Mois.</div></section>`;
  const seuil = seuilOf(acc), rows = forecast(acc, UI.horizon, { sim: true, mode: UI.mode }), base = forecast(acc, UI.horizon, { mode: UI.mode });
  const last = rows[rows.length - 1], lastBase = base[base.length - 1];
  const avgNet = rows.slice(1).reduce((a, r) => a + r.net, 0) / Math.max(1, rows.length - 1), neg = rows.find(r => r.low.v < 0);
  const W = 340, H = 140, L = 8, B = 22, mxA = Math.max(...rows.map(r => Math.abs(r.net)), 1), bw = (W - L * 2) / rows.length, y0 = (H - B) / 2 + 4;
  const bars = rows.map((r, i) => { const h = Math.abs(r.net) / mxA * ((H - B) / 2 - 12), x = L + i * bw + bw * .18, w = bw * .64, y = r.net >= 0 ? y0 - h : y0;
    return `<rect x="${x}" y="${y}" width="${w}" height="${Math.max(1, h)}" rx="3" fill="var(--${r.net >= 0 ? 'good' : 'bad'})"/><text x="${x + w / 2}" y="${r.net >= 0 ? y - 4 : y + h + 11}" text-anchor="middle" font-size="9.5" fill="var(--muted)">${r.net >= 0 ? '+' : '−'}${Math.round(Math.abs(r.net))}</text><text x="${x + w / 2}" y="${H - 4}" text-anchor="middle" font-size="10" fill="var(--muted)">${mShort(r.k)}</text>`; }).join('');
  const sims = DB.simulations.filter(s => s.compte === acc).sort((a, b) => simI(a) - simI(b) || String(a.id).localeCompare(String(b.id)));
  const habits = catList(acc).map(c => ({ n: catLabel(c.nom), h: habit(acc, c.nom), b: num(c.budget) })).filter(x => x.h > 0.5 || x.b), hin = habitIn(acc);
  const sum = simsSummary(acc), stL = status(last.end, seuil);
  return `<section class="view">
    <div class="chips" role="group" aria-label="Horizon">${[3, 6, 12].map(n => `<button class="chip" data-h="${n}" aria-pressed="${UI.horizon === n}">${n} mois</button>`).join('')}</div>
    <div class="seg" role="group" aria-label="Base de calcul"><button data-mode="habits" aria-pressed="${UI.mode === 'habits'}">Selon nos habitudes</button><button data-mode="budget" aria-pressed="${UI.mode === 'budget'}">Selon nos budgets</button></div>
    ${UI.mode === 'budget' ? '<div class="hint">Les catégories sans budget suivent les habitudes.</div>' : ''}
    <div class="hero">
      <div class="rowhead"><span class="sub">Solde fin ${mLabel(last.k)}</span><span class="pill ${stL.c}">${stL.t}</span></div>
      <div class="big num">${eur0(last.end)}</div>
      <div class="kv"><div><small>Gagné en moyenne / mois</small><b style="color:var(--${avgNet >= 0 ? 'good' : 'bad'})">${sgn(Math.round(avgNet))}</b></div>
      <div><small>Épargnable sur la période</small><b>${eur0(Math.max(0, last.end - seuil))}</b></div></div>
      ${neg ? `<div class="alert bad">Risque de découvert en ${mLabel(neg.k)} (point bas ${eur0(neg.low.v)} le ${neg.low.d})</div>` : ''}
      ${DB.simulations.some(s => s.compte === acc && bool(s.actif) && simI(s) >= 0) ? `<div class="hint" style="font-size:13px">Sans les simulations : ${eur0(lastBase.end)}</div>` : ''}
      ${UI.mode === 'habits' && !hasHistory(acc) ? `<div class="hint">Peu d'historique pour l'instant : les budgets d'enveloppes servent d'estimation jusqu'à la fin du premier mois.</div>` : ''}
      <svg class="curve" viewBox="0 0 ${W} ${H}" role="img" aria-label="Solde gagné ou perdu par mois"><line x1="${L}" x2="${W - L}" y1="${y0}" y2="${y0}" stroke="var(--line)"/>${bars}</svg>
    </div>
    <div class="block"><div class="rowhead"><h2>Et si…</h2><span class="sub">simulations</span></div>
      ${sum ? (() => { const c = sum.ratio <= 0.5 ? 'good' : sum.ratio <= 0.9 ? 'warn' : 'bad';
        return `<div class="note ${c}"><b>Toutes les simulations ensemble :</b> ${sum.n} achats pour ${eur0(sum.total)}. Au plus fort, il faut mettre <b>${eur0(sum.peak)}/mois</b> de côté, soit <b>${sum.marge > 0 ? Math.round(sum.ratio * 100) + ' %' : 'plus que tout'}</b> de la marge habituelle (${eur0(sum.marge)}). Les achats sont financés par ordre de date.</div>`; })() : ''}
      ${sims.map(s => { const past = simI(s) < 0;
        if (past) return `<div class="simcard off"><div class="simhead"><div><b>${esc(s.libelle)}</b><div class="mini">${eur0(num(s.montant))} en ${mLabel(s.mois)} · date passée</div></div></div><div class="actions"><button class="btn ghost small" data-simdel="${esc(s.id)}">Retirer</button></div></div>`;
        const p = simPlan(s);
        return `<div class="simcard ${bool(s.actif) ? '' : 'off'}">
        <div class="simhead"><div><b>${esc(s.libelle)}</b><div class="mini" style="font-size:13px">${eur0(num(s.montant))} en ${mLabel(s.mois)}</div></div>
        <div style="display:flex;gap:8px;align-items:center"><span class="pill ${p.c}">${p.label}</span><input type="checkbox" aria-label="Activer la simulation" data-simtog="${esc(s.id)}" ${bool(s.actif) ? 'checked' : ''}></div></div>
        ${p.k > 0 ? `<div class="save"><strong class="num">${eur0(p.need)}</strong><span>à mettre de côté par mois, de ${MONTHS_L[pm(addM(CUR, 1)).m]} à ${MONTHS_L[pm(s.mois).m]} (${p.k} mois)</span></div>` : ''}
        <div class="note ${p.c}">${p.txt}</div>
        <div class="actions"><button class="btn ghost small" data-simdel="${esc(s.id)}">Retirer</button></div></div>`; }).join('') || `<div class="note">Teste un achat avant de le faire : il s'ajoute aux prévisions sans toucher au réel.</div>`}
      <form class="form" id="simForm" novalidate style="gap:10px">
        <div class="two"><div class="field"><label for="simL">Achat envisagé</label><input id="simL" placeholder="Ex. Week-end" autocomplete="off"></div>
        <div class="field"><label for="simA">Montant (€)</label><input id="simA" inputmode="decimal" placeholder="800" autocomplete="off"></div></div>
        <div class="two"><div class="field"><label for="simM">Mois de l'achat</label><select id="simM">${Array.from({ length: 24 }, (_, i) => { const k = addM(CUR, i); return `<option value="${k}" ${i === 3 ? 'selected' : ''}>${mLabel(k)}</option>`; }).join('')}</select></div>
        <div class="field" style="justify-content:flex-end"><button class="btn ghost" type="submit">Simuler</button></div></div>
      </form>
    </div>
    <div class="block"><div class="rowhead"><h2>Nos habitudes</h2><span class="sub">moyenne / mois</span></div>
      <div class="list">${habits.length ? habits.map(x => { const d = x.b ? x.h - x.b : null;
        return `<div class="habit"><b>${esc(x.n)}</b><span>${x.b ? 'budget ' + eur0(x.b) : 'sans enveloppe'}</span><span style="font-weight:700;color:var(--${d !== null && d > 15 ? 'bad' : d !== null && d < -15 ? 'good' : 'ink'})">${eur0(x.h)}</span></div>`; }).join('') : `<div class="empty">Les habitudes apparaîtront au fil des saisies.</div>`}</div>
      ${hin > 0.5 ? `<div class="hint">Rentrées ponctuelles habituelles (hors fixes) : <b>${eur0(hin)}</b> par mois, comptées dans les prévisions.</div>` : ''}
      <div class="hint">Médiane des 3 derniers mois, mêlée au mois en cours à partir du 10. Les mouvements exceptionnels et les virements entre tes comptes n'y entrent pas.</div>
    </div>
    <div class="block"><h2>Mois par mois</h2>
      <div class="tablewrap"><table><thead><tr><th>Mois</th><th>Rentrées</th><th>Fixes</th><th>Variables</th><th>Fin</th></tr></thead><tbody>
      ${rows.map(r => { const st = status(r.end, seuil).c; return `<tr><td>${mShort(r.k)}${pm(r.k).m === 0 ? ' ' + String(pm(r.k).y).slice(2) : ''}${r.k === CUR ? ' · en cours' : ''}</td><td class="pos">${eur0(r.rev)}</td><td>${eur0(r.chg)}</td><td>${eur0(r.vari)}</td><td class="end" style="color:var(--${st === 'good' ? 'ink' : st})">${eur0(r.end)}</td></tr>`; }).join('')}
      </tbody></table></div>
    </div>
  </section>`;
}
let TAX_DELTA = 0;
function vTax() {
  const X = taxParams(), t = calcTax(X, TAX_DELTA), t0 = calcTax(X, 0), t1 = calcTax(X, TAX_DELTA + 1000);
  const p = profiles(), n1 = (p[0] || {}).nom || 'Personne 1', n2 = (p[1] || {}).nom || 'Personne 2';
  const ecart = t.prelev - t.duSal, pct = t.duSal > 0 ? Math.abs(ecart) / t.duSal : 0;
  const verdict = t.sal <= 0 ? { c: '', t: 'À compléter', m: 'Renseigne les salaires nets imposables plus bas pour lancer l\'estimation.' }
    : Math.abs(ecart) < 150 ? { c: 'good', t: 'Taux bien calé', m: `Écart d'environ ${eur0(Math.abs(ecart))} sur l'année : rien à changer.` }
    : ecart > 0 ? { c: 'warn', t: 'Prélèvement trop élevé', m: `Environ ${eur0(ecart)} de trop sur l'année, remboursés l'été suivant. ${pct > 0.10 && ecart > 200 ? 'L\'écart dépasse 10 % et 200 € : une baisse du taux est possible sur impots.gouv.fr, rubrique « Gérer mon prélèvement à la source ».' : 'L\'écart reste sous les seuils pour demander une baisse.'}` }
    : { c: 'bad', t: 'Prélèvement trop faible', m: `Il manquera environ ${eur0(-ecart)}, régularisés en fin d'année suivante. Le taux peut être augmenté librement sur impots.gouv.fr pour lisser.` };
  const maxQ = 90000, seg = IMPOT.tranches.slice(0, 4).map((tr, k) => { const lo = k ? IMPOT.tranches[k - 1][0] : 0, hi = Math.min(tr[0], maxQ); return `<i style="width:${(hi - lo) / maxQ * 100}%;background:var(--${['sunk', 'accent-soft', 'warn-soft', 'bad-soft'][k]})"></i>`; }).join('');
  const inp = (id, key, val, label, attrs) => `<div class="field"><label for="${id}">${label}</label><input id="${id}" data-tax="${key}" inputmode="decimal" value="${fr(val)}" ${attrs || ''}></div>`;
  return `<section class="view">
    <div class="hero">
      <div class="rowhead"><span class="sub">Impôt estimé du foyer</span><span class="pill ${t.tmi >= 0.30 ? 'warn' : 'good'}">Tranche ${Math.round(t.tmi * 100)} %</span></div>
      <div class="big num">${eur0(t.I)}</div>
      <div class="kv"><div><small>Revenu imposable</small><b>${eur0(t.R)}</b></div><div><small>Parts / taux moyen</small><b>${fr(t.parts)} · ${t.R > 0 ? fr((t.I / t.R * 100).toFixed(1)) : '0'} %</b></div></div>
      <div style="display:flex;flex-direction:column;gap:6px">
        <div class="tranche">${seg}<span class="tranche-marker" style="left:calc(${Math.min(t.q, maxQ) / maxQ * 100}% - 1px)"></span></div>
        <div class="tlegend"><span>0 %</span><span>11 %</span><span>30 %</span><span>41 %</span></div>
      </div>
      <div class="note">${t.tmi < 0.45 ? `Encore <b>${eur0(t.toNext)}</b> de salaire net imposable avant la tranche à <b>${Math.round(t.nextRate * 100)} %</b>.` : 'Tranche la plus haute.'} ${t.dec > 0 ? `Décote appliquée : ${eur0(t.dec)}.` : ''} ${t.plaf ? 'Plafonnement du quotient familial appliqué.' : ''}</div>
    </div>
    <div class="block"><div class="rowhead"><h2>Prélèvement à la source</h2></div>
      <div class="hero" style="gap:12px">
        <div class="kv"><div><small>Taux actuel</small><b>${fr(X.taux)} %</b></div><div><small>Taux estimé juste</small><b>${fr(t.tauxEst.toFixed(1))} %</b></div></div>
        <div class="kv"><div><small>Prélevé sur l'année</small><b>${eur0(t.prelev)}</b></div><div><small>Impôt dû sur les salaires</small><b>${eur0(t.duSal)}</b></div></div>
        <div class="note ${verdict.c}"><b>${verdict.t}.</b> ${verdict.m}</div>
      </div></div>
    <div class="block"><div class="rowhead"><h2>Simuler un changement de revenu</h2></div>
      <div class="hero" style="gap:10px">
        <label class="daysim" for="taxdelta" style="color:var(--ink)">Prime / augmentation (${esc(n1)}) <input type="range" id="taxdelta" min="-10000" max="20000" step="500" value="${TAX_DELTA}"> <b class="num">${TAX_DELTA >= 0 ? '+' : ''}${eur0(TAX_DELTA)}</b></label>
        <div class="kv"><div><small>Impôt après changement</small><b>${eur0(t.I)}</b></div><div><small>Différence</small><b style="color:var(--${t.I > t0.I + 0.5 ? 'bad' : 'good'})">${sgn(Math.round(t.I - t0.I))}</b></div></div>
        <div class="note">Sur 1 000 € de salaire en plus, environ <b>${eur0(t1.I - t.I)}</b> partent en impôt.</div>
      </div></div>
    <div class="block"><div class="rowhead"><h2>Données du foyer</h2></div>
      <div class="form">
        <div class="seg"><button type="button" data-taxmode="commune" aria-pressed="${X.mode === 'commune'}">Déclaration commune</button><button type="button" data-taxmode="seule" aria-pressed="${X.mode === 'seule'}">Déclaration séparée</button></div>
        <div class="two">${inp('tx-s1', 'impSal1', X.sal1, 'Salaire net imposable ' + esc(n1) + ' / an')}${X.mode === 'commune' ? inp('tx-s2', 'impSal2', X.sal2, 'Salaire net imposable ' + esc(n2) + ' / an') : inp('tx-k', 'impEnfants', X.kids, 'Enfants rattachés')}</div>
        <div class="two">${X.mode === 'commune' ? inp('tx-k', 'impEnfants', X.kids, 'Enfants à charge') : ''}${inp('tx-t', 'impTaux', X.taux, 'Taux de prélèvement actuel (%)')}</div>
        <div class="two">${inp('tx-a', 'impAutres', X.autres, 'Autres revenus (micro-entreprise) / an')}
        <div class="field"><label for="tx-ab">Abattement</label><select id="tx-ab" data-tax="impAutresAb">${[71, 50, 34].map(a => `<option value="${a}" ${a === X.autresAb ? 'selected' : ''}>${a} %</option>`).join('')}</select></div></div>
      </div>
      <div class="hint">Estimation indicative : ${IMPOT.annee}, abattement de 10 % sur les salaires. Le simulateur officiel d'impots.gouv.fr fait foi. Le salaire net imposable figure sur la fiche de paie de décembre (cumul annuel).</div>
    </div>
  </section>`;
}

/* ----- Onglet Réglages ----- */
function vSet() {
  const sysDark = matchMedia('(prefers-color-scheme: dark)').matches, dark = UI.theme === 'dark' || (UI.theme === 'auto' && sysDark);
  const accBlock = A => { const k = A.id, cats = catsOf(k);
    return `<div class="hero" style="gap:12px"><div class="rowhead"><h2>${esc(A.nom)}</h2><span class="sub">${A.proprietaire ? 'privé' : DB.profils.length > 1 ? 'partagé' : ''}</span></div>
    ${isShared(k) ? `<div class="hint">Compte partagé : les changements ici s'appliquent aussi pour ${esc(otherNames())}.</div>` : ''}
    <div class="field"><label for="an-${esc(k)}">Nom du compte</label><input id="an-${esc(k)}" data-accname="${esc(k)}" value="${esc(A.nom)}"></div>
    <div class="two"><div class="field"><label for="op-${esc(k)}">Solde au 1er ${started(k) ? MONTHS_L[pm(startMonth(k)).m] : 'du mois de départ'}</label><input id="op-${esc(k)}" data-open="${esc(k)}" inputmode="decimal" value="${fr(A.soldeDepart)}" placeholder="non renseigné"></div>
    <div class="field"><label for="se-${esc(k)}">Seuil de sécurité (€)</label><input id="se-${esc(k)}" data-seuil="${esc(k)}" inputmode="decimal" value="${fr(A.seuil)}"></div></div>
    <div class="field"><label for="md-${esc(k)}">Mois de départ</label><input id="md-${esc(k)}" type="month" data-mdep="${esc(k)}" value="${esc(startMonth(k))}" max="${CUR}"></div>
    <div class="hint">Le solde de départ est le solde au 1er du mois de départ. Pour recaler en cours de mois, utilise plutôt « Corriger le solde » dans l'onglet Mois.</div>
    <div class="field"><label>Catégories de dépenses</label><div class="list">${cats.length ? cats.map(c => `<button class="item ${c.nom.includes(SEP) ? 'child' : ''}" data-editcat="${esc(c.id)}"><span class="day">${c.nom.includes(SEP) ? '↳' : num(c.budget) ? '◔' : '·'}</span><span class="lbl"><b>${esc(leafOf(c.nom))}</b><small>${num(c.budget) ? 'enveloppe mensuelle' : 'sans enveloppe'}</small></span><span class="amt">${num(c.budget) ? eur0(num(c.budget)) : ''}</span></button>`).join('') : '<div class="empty">Aucune catégorie.</div>'}</div></div>
    <button class="btn ghost small" data-newcat="${esc(k)}">＋ Ajouter une catégorie</button></div>
    ${(() => {
      const cands = DB.fixes.filter(f => f.compte === k && bool(f.actif) && f.sens === '+' && (f.frequence || 'M') === 'M');
      if (!cands.length) return '';
      const fid = salaryFixeId(k), on = payOn(k), PS2 = on && payState(k);
      return `<div class="hero" style="gap:10px"><div class="rowhead"><h2>Mois basé sur la paie</h2></div>
      <label class="switch" for="payOn-${esc(k)}"><span>Le mois affiché (onglet Mois) commence à la paie plutôt qu'au calendaire<small class="mini" style="display:block">Détection automatique de l'arrivée de la rentrée, projection de la prochaine</small></span><input type="checkbox" id="payOn-${esc(k)}" data-payon="${esc(k)}" ${on ? 'checked' : ''}></label>
      ${on ? (cands.length > 1 ? `<div class="field"><label for="payF-${esc(k)}">Rentrée qui déclenche le mois</label><select id="payF-${esc(k)}" data-payfixe="${esc(k)}">${cands.map(f => `<option value="${esc(f.id)}" ${f.id === fid ? 'selected' : ''}>${esc(f.libelle)}</option>`).join('')}</select></div>` : `<div class="hint">Déclencheur : <b>${esc(cands[0].libelle)}</b>.</div>`) : ''}
      ${on ? (PS2 ? `<div class="hint">Période en cours : du ${dLabel(PS2.start)} au ${dLabel(PS2.end)}${PS2.manual ? ' (date de fin fixée à la main)' : ' (estimation automatique, d\'après les dernières paies)'}.</div>
      <div class="two"><div class="field"><label for="payEnd-${esc(k)}">Date de fin de la période (modifiable)</label><input type="date" id="payEnd-${esc(k)}" data-payend="${esc(k)}" value="${esc(PS2.end)}"></div>${PS2.manual ? `<button type="button" class="btn ghost small" data-payauto="${esc(k)}" style="align-self:end">Recalculer automatiquement</button>` : ''}</div>` : `<div class="hint">Pas encore de paie vue sur ce compte depuis le début du mois de départ : le mois calendaire est utilisé pour l'instant.</div>`) : ''}
      </div>`; })()}
    `; };
  const syncTxt = { ok: 'Synchronisé', wait: 'Envoi en cours…', off: 'Hors ligne', err: 'Accès coupé' }[SYNC.state] || '';
  return `<section class="view">
    <div class="hero" style="gap:6px"><div class="rowhead"><h2>Apparence</h2></div>
      <label class="switch" for="th-auto"><span>Suivre le réglage du téléphone</span><input type="checkbox" id="th-auto" data-theme-auto="1" ${UI.theme === 'auto' ? 'checked' : ''}></label>
      <label class="switch" for="th-dark" style="${UI.theme === 'auto' ? 'opacity:.45' : ''}"><span>Mode sombre</span><input type="checkbox" id="th-dark" data-theme-dark="1" ${dark ? 'checked' : ''} ${UI.theme === 'auto' ? 'disabled' : ''}></label>
      <div class="hint">${UI.theme === 'auto' ? "L'appli passe en sombre quand le téléphone l'est." : 'Choix forcé, quel que soit le réglage du téléphone.'} Réglage propre à ce téléphone.</div>
    </div>
    ${vBankSet()}
    ${accs().map(accBlock).join('')}
    ${vProfiles()}
    <div class="hero" style="gap:8px"><div class="rowhead"><h2>Synchronisation</h2><span class="pill ${SYNC.state === 'ok' ? 'good' : SYNC.state === 'err' ? 'bad' : 'warn'}">${syncTxt}</span></div>
      <div class="hint">Les saisies partent tout de suite vers le Google Sheet et l'appli se met à jour seule toutes les 30 secondes. Sans réseau, elles sont gardées et envoyées au retour de la connexion.${QUEUE.length ? ` <b>${QUEUE.length} modification(s) en attente d'envoi.</b>` : ''}</div>
      <div class="hint">Dernière synchro : ${SYNC.last ? new Date(SYNC.last).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }) : 'jamais'}</div>
      <button class="btn ghost small" data-syncnow="1">Synchroniser maintenant</button>
    </div>
  </section>`;
}

/* ================= Premier lancement ================= */
const CATS_PERSO = ['Courses', 'Carburant', 'Restaurants', 'Loisirs', 'Shopping', 'Santé', 'Cadeaux', 'Divers'];
const CATS_COMMUN = ['Courses', 'Maison', 'Enfants', 'Santé', 'Sorties', 'Restaurants', 'Divers'];
const catOps = (acc, list) => list.map((n, i) => upd('Categories', { id: uid(), compte: acc, nom: n, budget: '', ordre: i + 1 }));
const ONB = { step: 0, name: '', mode: '', partner: '', commun: true, busy: false };
function vOnboard() {
  const O = ONB, head = n => `<div class="steps" style="display:flex;gap:6px">${[0, 1, 2].map(i => `<i style="flex:1;height:4px;border-radius:9px;background:var(--${i <= n ? 'accent' : 'line'})"></i>`).join('')}</div>`;
  if (O.step === 0) return `<section class="view">${head(0)}<h2 style="font-size:24px">Bienvenue sur Le 31</h2><p class="hint" style="font-size:14px">L'appli qui vous dit si vous tenez jusqu'au 31. Deux questions pour commencer.</p>
    <form class="form" id="onbName" novalidate><div class="field"><label for="onbN">Ton prénom</label><input id="onbN" value="${esc(O.name)}" placeholder="Ex. Alex" autocomplete="given-name"></div><button class="btn" type="submit">Continuer</button></form></section>`;
  if (O.step === 1) return `<section class="view">${head(1)}<h2 style="font-size:24px">Tu utilises Le 31…</h2>
    <div class="two"><button class="chip" style="border-radius:16px;padding:14px;text-align:left" data-onbmode="solo" aria-pressed="${O.mode === 'solo'}"><b style="font-size:16px;display:block">Seul</b><span style="font-weight:500">Mon compte, et un compte commun si j'en ai un</span></button>
    <button class="chip" style="border-radius:16px;padding:14px;text-align:left" data-onbmode="duo" aria-pressed="${O.mode === 'duo'}"><b style="font-size:16px;display:block">À deux</b><span style="font-weight:500">Un perso chacun et un compte commun</span></button></div>
    ${O.mode === 'duo' ? `<div class="field"><label for="onbP">Prénom de ton/ta partenaire</label><input id="onbP" value="${esc(O.partner)}" placeholder="Ex. Camille" autocomplete="off"></div>
      <div class="note">Chacun aura son propre lien d'accès. ${esc(O.partner || 'Ton/ta partenaire')} verra le <b>compte commun</b> et <b>son</b> compte perso, jamais le tien.</div>` : ''}
    ${O.mode === 'solo' ? `<label class="switch" for="onbC"><span>J'ai aussi un compte commun à suivre</span><input type="checkbox" id="onbC" ${O.commun ? 'checked' : ''}></label>` : ''}
    <div class="actions"><button class="btn ghost" data-onbstep="0">Retour</button><button class="btn" data-onbstep="2">Continuer</button></div></section>`;
  const accsL = [`<b>Compte perso de ${esc(O.name)}</b> · visible seulement par toi`];
  if (O.mode === 'duo') accsL.push(`<b>Compte perso de ${esc(O.partner)}</b> · visible seulement par ${esc(O.partner)}, démarré sur son téléphone`);
  if (O.mode === 'duo' || O.commun) accsL.push(`<b>Compte commun</b> · visible par ${O.mode === 'duo' ? 'vous deux' : 'toi'}`);
  return `<section class="view">${head(2)}<h2 style="font-size:24px">Vos comptes</h2>
    <div class="list">${accsL.map(l => `<div class="item" disabled style="grid-template-columns:1fr"><span class="lbl" style="white-space:normal">${l}</span></div>`).join('')}</div>
    <div class="hint">Les noms se changent ensuite dans Réglages.${O.mode === 'duo' ? ` Tu enverras son lien à ${esc(O.partner)} depuis Réglages > Profils.` : ''}</div>
    <div class="actions"><button class="btn ghost" data-onbstep="1">Retour</button><button class="btn" data-onbdone="1" ${O.busy ? 'disabled' : ''}>${O.busy ? 'Création…' : 'Créer mes comptes'}</button></div></section>`;
}
async function finishOnboard() {
  const O = ONB; if (O.busy) return;
  const p1 = 'p' + uid(), ops = [upd('Profils', { id: p1, nom: O.name, perso: 'oui', ordre: 1 })];
  ops.push(upd('Comptes', { id: 'perso-' + p1, nom: 'Perso ' + O.name, proprietaire: p1, soldeDepart: '', moisDepart: '', seuil: 200, ordre: 1 }), ...catOps('perso-' + p1, CATS_PERSO));
  if (O.mode === 'duo') ops.push(upd('Profils', { id: 'p' + uid(), nom: O.partner, perso: 'oui', ordre: 2 }));
  if (O.mode === 'duo' || O.commun) ops.push(upd('Comptes', { id: 'commun', nom: 'Compte commun', proprietaire: '', soldeDepart: '', moisDepart: '', seuil: 150, ordre: 2 }), ...catOps('commun', CATS_COMMUN));
  if (O.mode === 'solo') ops.push(upd('Parametres', { cle: 'impMode', valeur: 'seule' }));
  O.busy = true; render();
  try { const j = await api({ action: 'ops', ops: clean(ops), associer: p1 }); UI.acc = 'perso-' + p1; received(j.data, j.moi); toast('Comptes créés'); }
  catch (e) { toast(e instanceof TypeError ? 'Connexion nécessaire pour créer les comptes' : 'Erreur : ' + e.message); }
  O.busy = false; render();
}
// La personne invitée crée son compte perso à sa première ouverture
function ensurePerso() {
  if (!ME) return;
  const p = DB.profils.find(x => x.id === ME);
  if (!p || p.perso !== 'oui' || DB.comptes.some(c => c.proprietaire === ME)) return;
  const id = 'perso-' + ME;
  UI.acc = id;
  commit([upd('Comptes', { id, nom: 'Perso ' + p.nom, proprietaire: ME, soldeDepart: '', moisDepart: '', seuil: 200, ordre: 1 }), ...catOps(id, CATS_PERSO)]);
}

/* ================= Import de relevé (CSV / OFX) ================= */
const NORM = s => String(s || '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const STOP = new Set('PRLV PRELEVEMENT PRELEV SEPA CB CARTE PAIEMENT PAIE VIR VIREMENT VIRT INST INSTANTANE RECU RECUE EMIS EMISE DE DU DES LA LE LES ET FACT FACTURE ECH REF MANDAT ICS RUM NUM NO PAR POUR SUR AVEC EN AU AUX FR EUR WWW COM SA SAS SARL MOTIF VERS BENEF BENEFICIAIRE ORDRE EMETTEUR'.split(' '));
// motif « historique » (V1.0 à 1.3) : sert aux références anti-doublon et aux charges déjà créées. Ne pas modifier.
function motifOf(lib) {
  const w = NORM(lib).replace(/\d{1,2}[\/.-]\d{1,2}([\/.-]\d{2,4})?/g, ' ').replace(/[^A-Z ]/g, ' ').split(/\s+/).filter(x => x.length > 1 && !STOP.has(x));
  return w.slice(0, 3).join(' ') || NORM(lib).replace(/[^A-Z0-9 ]/g, '').trim().slice(0, 24);
}
const pretty = m => m.toLowerCase().replace(/(^|[\s'-])\S/g, c => c.toUpperCase());
// Noms connus : [motif, nom, catégorie si dépense, catégorie si rentrée]
const NOMS = [
  [/DEBLOCAGE/, 'Déblocage de prêt', '', ''],
  [/AMAZON PRIME/, 'Amazon Prime', 'Abonnements'], [/AMAZON/, 'Amazon', 'Shopping'],
  [/NETFLIX/, 'Netflix', 'Abonnements'], [/SPOTIFY/, 'Spotify', 'Abonnements'], [/DISNEY/, 'Disney+', 'Abonnements'], [/DEEZER/, 'Deezer', 'Abonnements'],
  [/CANAL ?PLUS|CANAL\+|CANALPLUS/, 'Canal+', 'Abonnements'], [/APPLE COM|ITUNES/, 'Apple', 'Abonnements'], [/GOOGLE/, 'Google', 'Abonnements'],
  [/CLAUDE|ANTHROPIC/, 'Claude (Anthropic)', 'Abonnements'], [/OPENAI|CHATGPT/, 'ChatGPT', 'Abonnements'],
  [/BATTLE ?NET|BLIZZARD/, 'Battle.net', 'Loisirs'], [/STEAM/, 'Steam', 'Loisirs'], [/WINAMAX/, 'Winamax', 'Loisirs'], [/CASINO BARRIERE|BARRIERE POKER|PARTOUCHE|\bJOA\b|POKERSTARS/, 'Casino (jeux)', 'Loisirs'], [/BETCLIC/, 'Betclic', 'Loisirs'], [/\bFDJ\b/, 'FDJ', 'Loisirs'],
  [/INTERMARCHE/, 'Intermarché', 'Courses'], [/MAGASINS? U\b|SUPER U|HYPER U|U EXPRESS|SYSTEME U/, 'Super U', 'Courses'], [/LECLERC/, 'Leclerc', 'Courses'],
  [/CARREFOUR/, 'Carrefour', 'Courses'], [/AUCHAN/, 'Auchan', 'Courses'], [/\bLIDL\b/, 'Lidl', 'Courses'], [/\bALDI\b/, 'Aldi', 'Courses'], [/GRAND FRAIS/, 'Grand Frais', 'Courses'],
  [/PICARD/, 'Picard', 'Courses'], [/BIOCOOP/, 'Biocoop', 'Courses'], [/MONOPRIX/, 'Monoprix', 'Courses'], [/FRANPRIX/, 'Franprix', 'Courses'], [/NETTO/, 'Netto', 'Courses'],
  [/BRICO ?DEPOT/, 'Brico Dépôt', 'Maison'], [/CASTORAMA/, 'Castorama', 'Maison'], [/LEROY ?MERLIN/, 'Leroy Merlin', 'Maison'], [/\bIKEA\b/, 'Ikea', 'Maison'],
  [/BRICOMARCHE/, 'Bricomarché', 'Maison'], [/WELDOM/, 'Weldom', 'Maison'], [/JARDILAND/, 'Jardiland', 'Maison'], [/GAMM VERT/, 'Gamm Vert', 'Maison'],
  [/ELECTRO ?DEPOT/, 'Electro Dépôt', 'Shopping'], [/\bBOULANGER\b/, 'Boulanger', 'Shopping'], [/DARTY/, 'Darty', 'Shopping'], [/\bFNAC\b/, 'Fnac', 'Shopping'],
  [/DECATHLON/, 'Decathlon', 'Shopping'], [/LEBONCOIN/, 'Leboncoin', 'Shopping'], [/CDISCOUNT/, 'Cdiscount', 'Shopping'], [/ALIEXPRESS/, 'AliExpress', 'Shopping'],
  [/VINTED/, 'Vinted', 'Shopping'], [/SHEIN/, 'Shein', 'Shopping'], [/\bTEMU\b/, 'Temu', 'Shopping'], [/KIABI/, 'Kiabi', 'Shopping'], [/PRIMARK/, 'Primark', 'Shopping'],
  [/ACTION LOGEMENT/, 'Action Logement', 'Crédits', 'Revenus'], [/\bACTION\b/, 'Action', 'Shopping'],
  [/DIRECTION GENERALE DES FINANCES|DIRECTION GENERALE DE|DGFIP|TRESOR PUBLIC|IMPOTS?\b/, 'Impôts', 'Impôts', 'Impôts'],
  [/ECH PRET|ECHEANCE PRET|\bPRET\b/, 'Échéance de prêt', 'Crédits'],
  [/CREDIT MUTUEL/, 'Crédit Mutuel', 'Banque', 'Banque'], [/\bCOTIS|COMMISSION|AGIOS|FRAIS BANC|INTERETS DEBIT/, 'Frais bancaires', 'Banque'],
  [/\bCAF\b|ALLOCATIONS? FAMILIALES/, 'CAF', 'Enfants', 'Revenus'], [/PAJEMPLOI/, 'Pajemploi (nounou)', 'Enfants'],
  [/\bC ?P ?A ?M\b|AMELI|ASSURANCE MALADIE/, 'CPAM', 'Santé', 'Santé'], [/MUTU?T?ELLE/, 'Mutuelle', 'Santé', 'Santé'], [/PHARMA/, 'Pharmacie', 'Santé'],
  [/\bEDF\b/, 'EDF', 'Énergie'], [/ENGIE/, 'Engie', 'Énergie'], [/TOTALENERGIES/, 'TotalEnergies', 'Énergie'], [/VEOLIA|\bSAUR\b|\bSUEZ\b/, 'Eau', 'Énergie'], [/GRDF/, 'Gaz', 'Énergie'],
  [/ZE ?WATT|IZIVIA|CHARGEMAP|ELECTRA|IONITY|SUPERCHARG/, 'Recharge voiture', 'Carburant'],
  [/ORANGE|\bSOSH\b/, 'Orange', 'Abonnements'], [/\bSFR\b|RED BY SFR/, 'SFR', 'Abonnements'], [/BOUYGUES/, 'Bouygues Telecom', 'Abonnements'], [/FREE MOBILE|FREE TELECOM|\bFREE\b/, 'Free', 'Abonnements'],
  [/MACIF/, 'Macif', 'Assurances'], [/\bMAAF\b/, 'MAAF', 'Assurances'], [/MATMUT/, 'Matmut', 'Assurances'], [/\bAXA\b/, 'AXA', 'Assurances'], [/ALLIANZ/, 'Allianz', 'Assurances'],
  [/\bGMF\b/, 'GMF', 'Assurances'], [/\bMAIF\b/, 'MAIF', 'Assurances'], [/GROUPAMA/, 'Groupama', 'Assurances'],
  [/SICTOM|SMICTOM|ORDURES/, 'Sictom (ordures)', 'Maison'],
  [/AUTOROUTE|\bAPRR\b|\bSANEF\b|\bVINCI\b|PEAGE/, 'Péage', 'Transports'], [/\bSNCF\b|OUIGO|TRAINLINE|EUROSTAR/, 'Train', 'Transports'], [/PARKING|INDIGO|EFFIA/, 'Parking', 'Transports'],
  [/MC ?DONALD|MCDO/, 'McDonald\'s', 'Restaurants'], [/\bKFC\b/, 'KFC', 'Restaurants'], [/BURGER KING/, 'Burger King', 'Restaurants'], [/DELIVEROO/, 'Deliveroo', 'Restaurants'],
  [/UBER ?EATS/, 'Uber Eats', 'Restaurants'], [/STARBUCKS/, 'Starbucks', 'Restaurants'],
  [/RETRAIT|\bDAB\b|\bGAB\b/, 'Retrait d\'espèces', 'Retraits'],
  [/^CHEQUE|\bREM CHQ|REMISE CHEQUE/, 'Chèque', '', ''],
  [/SALAIRE|REMUNERATION/, 'Salaire', 'Revenus', 'Revenus'], [/FRANCE TRAVAIL|POLE EMPLOI/, 'France Travail', 'Revenus', 'Revenus']
];
const STOP2 = new Set([...STOP, 'M', 'MR', 'MME', 'MLLE', 'MONSIEUR', 'MADAME', 'PRLVT', 'VIREMENTS', 'OU', 'CLIENTS', 'PARTICULI', 'PARTICULIERS', 'VOTRE', 'EUROP', 'EUROPE', 'PAYMENTS', 'INTERNA', 'LTD', 'INC', 'GMBH', 'BV', 'SL', 'SRL', 'SNC', 'EURL']);
const isCB = N => /^(PAIEMENT|PAIE)\s+(CB|PSC|CARTE|SANS CONTACT)\b|^(CB|CARTE)\s/.test(N);
const isVIR = N => /^VIR(EMENT)?\b/.test(N);
const dico = N => NOMS.find(x => x[0].test(N));
// Mots utiles d'un libellé (sans préfixe bancaire, références, ville pour les cartes)
function words(lib) {
  let N = NORM(lib).replace(/\s+CARTE\s+X*\d+.*$/, '');
  N = N.replace(/^(PAIEMENT|PAIE)\s+(CB|PSC|CARTE|SANS CONTACT)\s+(\d{4}\s+)?|^(CB|CARTE)\s+(\d{2}\/?\d{2}\s+)?|^(PRLV|PRELEVEMENT)(\s+SEPA)?\s+|^VIR(EMENT)?(\s+(SEPA|INST|INSTANTANE|RECU|EMIS|PERMANENT))*\s+|^ECH\s+|^F\s+/, '');
  let t = N.replace(/[^A-Z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
  const out = []; // lettres isolées consécutives regroupées (C P A M → CPAM)
  for (let i = 0; i < t.length; i++) { if (t[i].length === 1 && t[i + 1] && t[i + 1].length === 1) { let s = ''; while (t[i] && t[i].length === 1) s += t[i++]; i--; out.push(s); } else out.push(t[i]); }
  t = out.filter((w, i) => !/\d/.test(w) && w.length > 1 && !STOP2.has(w) && out.indexOf(w) === i);
  if (/^(PAIEMENT|PAIE)\s+(CB|PSC|CARTE)\s+\d{4}\s/.test(NORM(lib)) && t.length >= 2) t = t.slice(1); // « PAIEMENT CB 2110 VILLE MARCHAND » : la ville vient avant le marchand
  return t;
}
// Clé de regroupement d'un libellé (même marchand = même clé)
const KEYS = new Map();
function keyOf(lib) {
  if (KEYS.has(lib)) return KEYS.get(lib);
  const N = NORM(lib), d = dico(N), w = words(lib);
  const k = d ? d[1].toUpperCase() : (w.slice(0, isVIR(N) ? 2 : 3).join(' ') || (isVIR(N) ? 'VIREMENT' : motifOf(lib)));
  KEYS.set(lib, k); return k;
}
function smartName(lib) {
  const N = NORM(lib), d = dico(N); if (d) return d[1];
  const w = words(lib).slice(0, 3); if (!w.length) return isVIR(N) ? 'Virement' : pretty(motifOf(lib).replace(/\d+/g, '').trim() || 'Opération');
  return (isVIR(N) ? 'Virement ' : '') + pretty(w.join(' '));
}
const AUTO = [
  [/SALAIRE|REMUNERATION|POLE EMPLOI|FRANCE TRAVAIL|\bCAF\b|ALLOCATION|PENSION|RETRAITE/, 'Revenus'],
  [/DGFIP|IMPOT|TRESOR PUBLIC|FINANCES PUBLIQUES|DIRECTION GENERALE DE/, 'Impôts'],
  [/\bPRET\b|COFIDIS|CETELEM|SOFINCO|FRANFINANCE|ONEY/, 'Crédits'],
  [/MUTUELLE|ASSUR|MAAF|MACIF|MATMUT|\bAXA\b|ALLIANZ|\bGMF\b|\bMAIF\b|GROUPAMA|HARMONIE|MGEN|GENERALI/, 'Assurances'],
  [/\bEDF\b|ENGIE|TOTALENERGIES ELEC|VEOLIA|\bSAUR\b|SUEZ|\bEAU\b|GRDF|ENERCOOP|EKWATEUR/, 'Énergie'],
  [/FREE MOBILE|FREE TELECOM|\bFREE\b|ORANGE|\bSFR\b|BOUYGUES|\bSOSH\b|RED BY/, 'Abonnements'],
  [/NETFLIX|SPOTIFY|DEEZER|DISNEY|CANAL|AMAZON PRIME|APPLE\.COM|ITUNES|GOOGLE PLAY|YOUTUBE/, 'Abonnements'],
  [/CARREFOUR|LECLERC|AUCHAN|INTERMARCHE|\bLIDL\b|\bALDI\b|SUPER U|HYPER U|\bU EXPRESS|CASINO|FRANPRIX|MONOPRIX|NETTO|GRAND FRAIS|PICARD|\bSPAR\b|PROXI|\bCORA\b|BIOCOOP|MARCHE|BOUCHERIE|PRIMEUR/, 'Courses'],
  [/TOTAL|ESSO|SHELL|\bBP\b|\bAVIA\b|STATION|CARBU|DYNEFF|\bAGIP\b|AS24/, 'Carburant'],
  [/RESTAU|MC ?DONALD|MCDO|BURGER|\bKFC\b|DELIVEROO|UBER ?EATS|PIZZ|BRASSERIE|\bCAFE\b|BOULANG|SUSHI|KEBAB|STARBUCKS|\bBAR\b|TRAITEUR/, 'Restaurants'],
  [/PHARMA|DOCTEUR|\bDR\b|MEDEC|CPAM|AMELI|DENTIST|OPTIC|LABO|KINE|HOPITAL|CLINIQUE|OSTEO/, 'Santé'],
  [/AMAZON|FNAC|DARTY|ZALANDO|VINTED|DECATHLON|KIABI|\bACTION\b(?! LOGEMENT)|CDISCOUNT|SHEIN|LEBONCOIN|ZARA|H ?& ?M|PRIMARK/, 'Shopping'],
  [/LEROY|CASTORAMA|BRICO|WELDOM|JARDILAND|\bIKEA\b|CONFORAMA|\bBUT\b/, 'Maison'],
  [/CINEMA|\bCINE\b|STEAM|PLAYSTATION|XBOX|NINTENDO|BOWLING|PARC|MUSEE|CONCERT|TICKETMASTER/, 'Loisirs'],
  [/RETRAIT|\bDAB\b|\bGAB\b/, 'Retraits']
];
// Règles apprises : par compte (V1.4), sinon anciennes règles communes
// (une rentrée a sa propre règle « +clé » : la CAF qui verse et la CAF qu'on paie ne se classent pas pareil)
const sk = (key, montant) => (montant > 0 ? '+' : '') + key;
function ruleOf(acc, lib, montant) {
  const k = keyOf(lib), m = motifOf(lib), s = montant > 0 ? '+' + k : null;
  return (s && DB.regles.find(x => x.compte === acc && x.motif === s)) || DB.regles.find(x => x.compte === acc && x.motif === k) || DB.regles.find(x => !x.compte && (x.motif === k || x.motif === m));
}
function guessCat(lib, montant, acc) {
  acc = acc || UI.acc;
  const sr = seuilRule(acc, lib); if (sr) return resolveCat(acc, Math.abs(num(montant) || 0) > num(sr.s) ? sr.haut : sr.bas);
  return resolveCat(acc, guessCat0(lib, montant, acc));
}
function guessCat0(lib, montant, acc) {
  const r = ruleOf(acc || UI.acc, lib, montant); if (r && r.categorie) return r.categorie;
  const N = NORM(lib), d = dico(N);
  if (d) return montant > 0 && d[3] !== undefined ? d[3] : d[2]; // un remboursement reste dans la catégorie du marchand
  if (montant > 0) return /\bVIR|REMISE|REM CHQ/.test(N) ? 'Revenus' : '';
  for (const [re, c] of AUTO) if (re.test(N)) return c;
  return '';
}
// Nom affiché d'une opération (importée : nom appris, sinon nom proposé ; saisie à la main : son libellé)
function nameOf(o) {
  if (!o.ref) return o.libelle || o.categorie || '';
  const r = ruleOf(o.compte, o.libelle, num(o.montant)); return (r && r.nom) || smartName(o.libelle);
}
// Virement entre ses propres comptes (épargne, livret, autre banque à son nom)
function isInternal(lib, acc) {
  const N = NORM(lib), me = NORM(pname(ME)).trim(), perso = !!accOf(acc || UI.acc).proprietaire;
  return /EPARGNE|\bLIVRET|\bLDD\b|\bLEP\b|\bPEL\b|\bCEL\b|ASSURANCE VIE|\bPEA\b|ARRONDI/.test(N) || (perso && isVIR(N) && me.length > 2 && new RegExp('\\b' + me + '\\b').test(N) && !/SALAIRE/.test(N));
}
function parseAmount(v) {
  let s = String(v == null ? '' : v).replace(/[ \s€]|EUR/gi, '').replace(/^\+/, '');
  if (!s) return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  if (/-$/.test(s)) { neg = true; s = s.slice(0, -1); }
  if (s.includes(',') && s.includes('.')) s = s.lastIndexOf(',') > s.lastIndexOf('.') ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  else if (s.includes(',')) s = s.replace(',', '.');
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  const n = parseFloat(s); return neg ? -Math.abs(n) : n;
}
function parseDate(v) {
  const s = String(v || '').trim();
  let m = /^(\d{4})-?(\d{2})-?(\d{2})/.exec(s);
  if (m && +m[2] >= 1 && +m[2] <= 12) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})/.exec(s);
  if (m) { const y = m[3].length === 2 ? '20' + m[3] : m[3]; if (+m[2] >= 1 && +m[2] <= 12 && +m[1] >= 1 && +m[1] <= 31) return `${y}-${pad(+m[2])}-${pad(+m[1])}`; }
  return null;
}
function parseOFX(t) {
  const tx = [];
  t.split(/<STMTTRN>/i).slice(1).forEach(b => {
    const g = tag => { const m = new RegExp('<' + tag + '>([^<\\r\\n]*)', 'i').exec(b); return m ? m[1].trim() : ''; };
    const d = parseDate(g('DTPOSTED').slice(0, 8)), a = parseAmount(g('TRNAMT'));
    if (d && a !== null) tx.push({ date: d, montant: a, libelle: [g('NAME'), g('MEMO')].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim() });
  });
  const lb = /<LEDGERBAL>[\s\S]*?<BALAMT>([^<\r\n]+)[\s\S]*?<DTASOF>(\d{8})/i.exec(t);
  return { tx, solde: lb && parseAmount(lb[1]) !== null ? { montant: parseAmount(lb[1]), date: parseDate(lb[2]) } : null, format: 'OFX' };
}
function parseCSV(t) {
  const lines = t.split(/\r?\n/).filter(l => l.trim());
  const sep = [';', '\t', ',', '|'].map(c => [c, lines.slice(0, 40).reduce((a, l) => a + (l.split(c).length - 1), 0)]).sort((a, b) => b[1] - a[1])[0][0];
  const split = l => { const out = []; let cur = '', q = false; for (let i = 0; i < l.length; i++) { const ch = l[i]; if (ch === '"') { if (q && l[i + 1] === '"') { cur += '"'; i++; } else q = !q; continue; } if (ch === sep && !q) { out.push(cur); cur = ''; continue; } cur += ch; } out.push(cur); return out.map(x => x.trim()); };
  const rows = lines.map(split);
  const find = (h, re, not) => h.findIndex(x => re.test(x) && !(not && not.test(x)));
  let hi = -1, c = {};
  for (let i = 0; i < Math.min(rows.length, 40); i++) {
    const h = rows[i].map(NORM);
    const date = (() => { let k = find(h, /DATE.*(OPE|COMPTA)/); if (k < 0) k = find(h, /^DATE|DATE$|^JOUR/, /VALEUR/); return k; })();
    const montant = find(h, /^MONTANT|AMOUNT|^SOMME/), debit = find(h, /DEBIT/), credit = find(h, /CREDIT/);
    if (date >= 0 && (montant >= 0 || debit >= 0 || credit >= 0)) {
      c = { date, montant, debit, credit, solde: find(h, /SOLDE|BALANCE/), lib: find(h, /LIBELLE|DESCRIPTION|INTITULE|DETAIL|LABEL|NATURE|OPERATION|BENEFICIAIRE/, /DATE|MONTANT|TYPE/) };
      hi = i; break;
    }
  }
  if (hi < 0) { // sans en-tête : on devine
    const sample = rows.slice(0, 20);
    const nc = Math.max(...sample.map(r => r.length));
    const score = (k, f) => sample.filter(r => f(r[k])).length;
    const cols = Array.from({ length: nc }, (_, k) => k);
    c.date = cols.find(k => score(k, parseDate) > sample.length * 0.6);
    const numc = cols.filter(k => k !== c.date && score(k, v => parseAmount(v) !== null && /\d/.test(v || '')) > sample.length * 0.5);
    if (c.date === undefined || !numc.length) throw new Error('Colonnes non reconnues');
    c.montant = numc[0]; c.debit = -1; c.credit = -1; c.solde = numc.length > 1 ? numc[numc.length - 1] : -1;
    c.lib = cols.filter(k => k !== c.date && !numc.includes(k)).sort((a, b) => score(b, v => (v || '').length > 6) - score(a, v => (v || '').length > 6))[0];
  }
  const tx = []; let soldeRow = null;
  rows.slice(hi + 1).forEach(r => {
    const d = parseDate(r[c.date]); if (!d) return;
    let a = c.montant >= 0 ? parseAmount(r[c.montant]) : null;
    if (a === null) { const de = c.debit >= 0 ? parseAmount(r[c.debit]) : null, cr = c.credit >= 0 ? parseAmount(r[c.credit]) : null; if (de === null && cr === null) return; a = (cr ? Math.abs(cr) : 0) - (de ? Math.abs(de) : 0); }
    const t2 = { date: d, montant: a, libelle: (c.lib >= 0 ? r[c.lib] : '') || r.filter((x, k) => k !== c.date && parseAmount(x) === null).join(' ') };
    tx.push(t2);
    if (c.solde >= 0) { const sv = parseAmount(r[c.solde]); if (sv !== null && (!soldeRow || d >= soldeRow.date)) soldeRow = { montant: sv, date: d }; }
  });
  if (!soldeRow) { // « Solde au 25/10/2026 : 1 482,25 » dans l'en-tête
    for (const l of lines.slice(0, Math.max(hi, 0) + 1)) { const m = /SOLDE[^0-9-]*(\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4})?[^0-9-]*(-?[\d\s.,]+\d)/i.exec(NORM(l)); if (m && parseAmount(m[2]) !== null) { soldeRow = { montant: parseAmount(m[2]), date: parseDate(m[1]) }; break; } }
  }
  return { tx, solde: soldeRow, format: 'CSV' };
}
function readImportFile(file) {
  return file.arrayBuffer().then(buf => {
    let t; try { t = new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch (e) { t = new TextDecoder('windows-1252').decode(buf); }
    t = t.replace(/^﻿/, '');
    const p = /<OFX>|OFXHEADER|<STMTTRN>/i.test(t) ? parseOFX(t) : parseCSV(t);
    if (!p.tx.length) throw new Error('Aucune opération trouvée dans ce fichier');
    return p;
  });
}
const refOf = t => t.date + '|' + r2(t.montant) + '|' + motifOf(t.libelle);
const dayGap = (a, b) => { const d = Math.abs(a - b); return Math.min(d, 31 - d); }; // le 30 et le 1er sont voisins
// Prélèvement fixe ou virement lié correspondant à une opération du relevé
function matchFixed(t, acc, used) {
  const k = t.date.slice(0, 7), d = +t.date.slice(8, 10), a = Math.abs(t.montant), neg = t.montant < 0;
  const near = (m, j) => Math.abs((num(m) || 0) - a) <= Math.max(0.15 * (num(m) || 0), 5) && dayGap(num(j) || 1, d) <= 4;
  const free = key => !used.has(k + '|' + key);
  const same = m => m && (m === t.motif || m === t.key);
  const ok = f => Math.abs((num(f.montant) || 0) - a) <= Math.max(0.5 * (num(f.montant) || 0), 20); // même libellé : montant du même ordre
  const best = list => list.sort((x, y) => Math.abs((num(x.montant) || 0) - a) - Math.abs((num(y.montant) || 0) - a))[0];
  const fx = DB.fixes.filter(f => f.compte === acc && occursF(f, k) && (f.sens === '+') !== neg && free('f' + f.id));
  // banque : le libellé peut différer de celui des relevés ; on accepte alors une charge au montant très proche, à la bonne date
  const bankNear = f => t.bank && Math.abs((num(f.montant) || 0) - a) <= Math.max(0.1 * (num(f.montant) || 0), 2) && dayGap(num(f.jour) || 1, d) <= 4;
  const f = best(fx.filter(f => same(f.motif) && ok(f))) || best(fx.filter(f => !f.motif && near(f.montant, f.jour))) || best(fx.filter(bankNear));
  if (f) return 'f' + f.id;
  const vx = DB.virements.filter(v => occursV(v, k) && ((v.de === acc && neg) || (v.vers === acc && !neg)) && free('v' + v.id));
  const v = best(vx.filter(v => v.motif && v.de === acc && same(v.motif) && ok(v))) || best(vx.filter(v => !(v.motif && v.de === acc) && near(v.montant, v.jour)));
  return v ? 'v' + v.id : null;
}
// Jour « médian » sur un cercle (le 30 et le 1er sont proches) et écart maximal
// (fenêtre de 8 jours qui couvre le plus d'occurrences : un mois décalé ne fait pas tout rejeter)
function circDays(days) {
  let best = null;
  days.forEach(start => { const rel = days.map(d => (d - start + 31) % 31).filter(x => x <= 8).sort((a, b) => a - b); if (!best || rel.length > best.rel.length) best = { start, rel }; });
  const mid = best.rel[Math.floor(best.rel.length / 2)];
  return { cover: best.rel.length / days.length, jour: ((best.start + mid - 1) % 31) + 1 };
}
// Opérations qui reviennent chaque mois : même marchand, montant du même ordre, même période du mois
function detectRecurring(tx, acc) {
  const months = [...new Set(tx.map(t => t.date.slice(0, 7)))].sort(), span = months.length;
  if (span < 2) return [];
  const groups = {};
  tx.forEach(t => { const k = (t.montant < 0 ? '-' : '+') + t.key; (groups[k] = groups[k] || []).push(t); });
  const commun = accOf(acc).proprietaire ? accs().find(a => !a.proprietaire) : null;
  const out = [];
  Object.values(groups).forEach(all => {
    // un même libellé peut cacher plusieurs flux (deux prêts, salaire + remboursements de frais) : on sépare par montant
    const srt = all.slice().sort((a, b) => Math.abs(a.montant) - Math.abs(b.montant)), clusters = [];
    const cb = isCB(NORM(all[0].libelle)); // carte : on ne regroupe que les montants quasi identiques (abonnements)
    srt.forEach(t => { const c = clusters[clusters.length - 1], a = Math.abs(t.montant), p = c && Math.abs(c[c.length - 1].montant); if (c && a - p <= (cb ? Math.max(0.03 * p, 0.5) : Math.max(0.25 * p, 3))) c.push(t); else clusters.push([t]); });
    const found = [];
    clusters.forEach(g => {
      g.sort((a, b) => a.date.localeCompare(b.date));
      const ms = new Set(g.map(t => t.date.slice(0, 7))), mL = months[months.length - 1];
      // présent quasiment chaque mois depuis sa première apparition (un abonnement récent compte) et toujours actif
      const from = diffM(g[0].date.slice(0, 7), mL) + 1, lastOcc = g[g.length - 1].date.slice(0, 7);
      if (ms.size < Math.min(3, span) || ms.size < 2 || ms.size < Math.ceil(from * 0.75) || lastOcc < addM(mL, -1) || g.length > ms.size * 1.5) return;
      const amts = g.map(t => Math.abs(t.montant)).sort((a, b) => a - b), med = amts[Math.floor(amts.length / 2)];
      const wide = amts[amts.length - 1] - amts[0] > Math.max(0.3 * med, 15);
      if (wide && (ms.size < Math.ceil(from * 0.85) || g.length > ms.size * 1.2)) return; // montant très variable : seulement si quasi tous les mois, une fois
      const N0 = NORM(g[0].libelle);
      if (isCB(N0) && (amts[amts.length - 1] - amts[0] > Math.max(0.5, 0.02 * med) || g.length > ms.size * 1.1)) return; // carte : seulement un abonnement (montant quasi fixe, une fois par mois)
      const cd = circDays(g.map(t => +t.date.slice(8, 10)));
      if (cd.cover < 0.75) return;
      const neg = g[0].montant < 0, last = g[g.length - 1];
      found.push({ g, ms, amts, med, wide, cd, neg, last, N0 });
    });
    found.sort((a, b) => b.med - a.med).forEach((F, i) => {
      const { g, ms, amts, med, wide, cd, neg, last, N0 } = F;
      let nom = (ruleOf(acc, g[0].libelle, g[0].montant) || {}).nom || smartName(g[0].libelle);
      if (!neg && med >= 900 && isVIR(N0) && accOf(acc).proprietaire && !/SALAIRE/.test(nom.toUpperCase()) && !isInternal(g[0].libelle, acc) && !dico(N0)) nom = 'Salaire (' + pretty(words(g[0].libelle).slice(0, 2).join(' ')) + ')';
      else if (/\bLOYER\b/.test(N0)) nom = 'Loyer';
      if (found.length > 1) nom += ' n°' + (i + 1);
      out.push({ id: 'r' + out.length, motif: g[0].key, nom, montant: r2(wide ? med : Math.abs(last.montant)), sens: neg ? '-' : '+', jour: cd.jour,
        cat: guessCat(g[0].libelle, g[0].montant, acc) || (neg ? 'Autre' : 'Revenus'), variable: amts[amts.length - 1] - amts[0] > 2 ? [amts[0], amts[amts.length - 1]] : null,
        txs: g, months: ms.size, span, lib: g[0].libelle, vir: neg && isVIR(N0) && commun && !isInternal(g[0].libelle, acc) ? commun.id : null });
    });
  });
  return out.sort((a, b) => (a.sens === b.sens ? 0 : a.sens === '+' ? -1 : 1) || b.montant - a.montant);
}

/* ----- Déroulé de l'import ----- */
let IMP = null;
// Effacer un compte pour repartir d'un relevé (profils, accès, catégories et noms appris sont gardés)
function resetOps(acc) {
  const ops = [], virs = DB.virements.filter(v => v.de === acc), vk = new Set(virs.map(v => 'v' + v.id));
  DB.fixes.filter(f => f.compte === acc).forEach(f => ops.push(del('Fixes', f.id)));
  virs.forEach(v => ops.push(del('Virements', v.id)));
  const opsAcc = DB.operations.filter(o => o.compte === acc), liens = new Set(opsAcc.filter(o => o.type === 'vir' && o.lien).map(o => o.lien));
  DB.operations.filter(o => o.compte === acc || (o.lien && liens.has(o.lien))).forEach(o => ops.push(del('Operations', o.id)));
  DB.pointages.filter(p => p.compte === acc || vk.has(p.cle)).forEach(p => ops.push(del('Pointages', p.id)));
  DB.clotures.filter(c => c.compte === acc).forEach(c => ops.push(del('Clotures', c.id)));
  ops.push(upd('Comptes', { id: acc, soldeDepart: '', moisDepart: '' }));
  return ops;
}
function startImport(parsed, mode, opt) {
  opt = opt || {}; const acc = opt.acc || UI.acc;
  if (started(acc) && !mode) { IMP = { acc, parsed, step: 'choice' }; UI.imp = 'go'; render(); scrollTo(0, 0); return; }
  if (mode === 'reset') commit(resetOps(acc));
  const first = !started(acc), used = new Set();
  const tx = parsed.tx.slice().sort((a, b) => a.date.localeCompare(b.date));
  const seen = {};
  tx.forEach(t => { t.bank = parsed.format === 'Banque'; t.motif = motifOf(t.libelle); t.key = keyOf(t.libelle); t.ref = (t.bank ? 'bk|' : '') + refOf(t); seen[t.ref] = (seen[t.ref] || 0) + 1; if (seen[t.ref] > 1) t.ref += '#' + seen[t.ref]; });
  const I = { acc, first, parsed, tx, recur: [], keep: {}, virOn: {}, gname: {}, gcat: {}, gtouch: {}, kind: {}, newCats: [], gshow: 30, solde: parsed.solde, recal: true, reset: mode === 'reset' };
  if (first) {
    const m0 = tx[0].date.slice(0, 7), mL = tx[tx.length - 1].date.slice(0, 7);
    I.mois = +tx[0].date.slice(8, 10) <= 3 || m0 === mL ? m0 : addM(m0, 1);
  } else I.mois = startMonth(acc);
  I.kept = tx.filter(t => t.date.slice(0, 7) >= I.mois && t.date <= TODAY_ISO.slice(0, 7) + '-31');
  // déjà connus : prélèvements fixes / virements liés, opérations déjà importées ou saisies à la main
  const refs = new Set(DB.operations.filter(o => o.compte === acc && o.ref).map(o => o.ref));
  const manual = DB.operations.filter(o => o.compte === acc && !o.ref && o.type !== 'ajust');
  // banque : une opération déjà importée d'un relevé (même jour, même montant) peut avoir un libellé un peu différent
  const dayAmt = {}; if (parsed.format === 'Banque') DB.operations.filter(o => o.compte === acc && o.ref && !String(o.ref).startsWith('bk|')).forEach(o => { const k = o.date + '|' + r2(num(o.montant)); dayAmt[k] = (dayAmt[k] || 0) + 1; });
  I.kept.forEach(t => {
    if (refs.has(t.ref)) { t.dup = true; return; }
    const da = t.date + '|' + r2(t.montant); if (dayAmt[da]) { dayAmt[da]--; t.dup = true; return; }
    const m = matchFixed(t, acc, used);
    if (m) { used.add(t.date.slice(0, 7) + '|' + m); if (point(t.date.slice(0, 7), m)) t.dup = true; else t.match = m; return; } // déjà pointé = déjà compté
    const mo = manual.find(o => Math.abs((num(o.montant) || 0) - t.montant) < 0.01 && Math.abs(new Date(o.date) - new Date(t.date)) <= 4 * 864e5);
    if (mo) { t.same = mo.id; manual.splice(manual.indexOf(mo), 1); }
  });
  if (first) { I.recur = detectRecurring(tx.filter(t => !t.match && !t.dup), acc); /* déjà pointé (virement lié importé de l'autre côté) : pas une nouvelle charge */ I.recur.forEach(r => { I.keep[r.id] = true; if (r.vir) I.virOn[r.id] = true; }); }
  // gros mouvements et virements entre ses comptes
  impRest(I).forEach(t => {
    const r = ruleOf(acc, t.libelle, t.montant), a = Math.abs(t.montant);
    if (r && (r.type === 'int' || r.type === 'exc')) { I.kind[t.ref] = r.type; t.big = r.type === 'int' || a >= 800; return; }
    if (isInternal(t.libelle, acc)) { I.kind[t.ref] = 'int'; t.big = true; }
    else if (a >= 800) { I.kind[t.ref] = a >= 1500 || /DEBLOCAGE/.test(NORM(t.libelle)) ? 'exc' : 'norm'; t.big = true; }
  });
  I.steps = [first && I.recur.length ? 'recur' : '', 'big', 'groups', first ? 'solde' : ''].filter(Boolean);
  I.step = I.steps[0];
  if (opt.silent) return I;
  IMP = I; UI.imp = 'go'; render(); scrollTo(0, 0);
}
// opérations à créer (hors prélèvements reconnus et doublons)
function impRest(I) {
  const inRecur = new Set(); if (I.first) I.recur.filter(r => I.keep[r.id]).forEach(r => r.txs.forEach(t => inRecur.add(t)));
  return I.kept.filter(t => !t.dup && !t.match && !t.same && !inRecur.has(t));
}
const gk = t => sk(t.key, t.montant);
const impCat = (I, t) => gk(t) in I.gcat ? I.gcat[gk(t)] : guessCat(t.libelle, t.montant, I.acc) || (I.kind[t.ref] === 'int' ? 'Entre mes comptes' : '');
const impName = (I, t) => I.gname[gk(t)] || (ruleOf(I.acc, t.libelle, t.montant) || {}).nom || smartName(t.libelle);
// groupes par marchand (et par sens : dépense / rentrée)
function impGroups(I) {
  const g = {};
  impRest(I).forEach(t => { const k = gk(t); (g[k] = g[k] || { key: k, txs: [], tot: 0 }); g[k].txs.push(t); g[k].tot += t.montant; });
  return Object.values(g).map(x => Object.assign(x, { cat: impCat(I, x.txs[0]), nom: impName(I, x.txs[0]), lib: x.txs[x.txs.length - 1].libelle }))
    .sort((a, b) => (a.cat ? 1 : 0) - (b.cat ? 1 : 0) || Math.abs(b.tot) - Math.abs(a.tot));
}
const impCats = I => { const s = new Set(catsOf(I.acc).map(c => c.nom).concat(I.newCats)); impRest(I).forEach(t => { const c = impCat(I, t); if (c) s.add(c); }); return [...s]; };
function impNext(I) { const s = I.steps || [], i = s.indexOf(I.step); return s[i + 1] || 'go'; }
function impPrev(I) { const s = I.steps || [], i = s.indexOf(I.step); return i > 0 ? s[i - 1] : ''; }
function vImport() {
  const I = IMP, A = accOf(I.acc);
  const close = `<button class="btn ghost small" data-impclose="1">Annuler</button>`;
  const top = (t, sub) => `${I.steps ? `<div class="steps">${I.steps.map((s, i) => `<i class="${i <= I.steps.indexOf(I.step) ? 'on' : ''}"></i>`).join('')}</div>` : ''}<div class="rowhead"><h2 style="font-size:20px">${t}</h2>${close}</div>${sub ? `<p class="hint" style="font-size:14px;margin:0">${sub}</p>` : ''}`;
  const back = impPrev(I) ? `<button class="btn ghost" data-impstep="${impPrev(I)}">Retour</button>` : '';
  const nextBtn = label => `<div class="actions">${back}<button class="btn" data-impstep="${impNext(I)}">${label}</button></div>`;
  if (I.step === 'choice') {
    const n = DB.operations.filter(o => o.compte === I.acc && o.ref).length;
    return `<section class="view">${top('Importer dans ' + esc(A.nom), `${I.parsed.format} · ${I.parsed.tx.length} opérations.`)}
      <button class="choice" data-impmode="add"><b>Ajouter les nouvelles opérations</b><span>Le compte garde tout ce qu'il a. Les opérations déjà présentes sont ignorées, les prélèvements se pointent tout seuls.</span></button>
      <button class="choice" data-impmode="reset"><b>Tout refaire à partir de ce relevé</b><span>Le compte est vidé (charges fixes, opérations${n ? ` dont ${n} importées` : ''}, clôtures${DB.virements.some(v => v.de === I.acc) ? ', virements liés partant de ce compte' : ''}) puis reconstruit avec ce relevé. Profils, accès, catégories et noms appris sont gardés.</span></button>
      <div class="note">« Tout refaire » est conseillé si le compte a été importé avec une version avant la V1.4.</div></section>`;
  }
  const span = `${I.parsed.format} · ${I.tx.length} opérations · du ${I.tx[0].date.split('-').reverse().join('/')} au ${I.tx[I.tx.length - 1].date.split('-').reverse().join('/')}`;
  if (I.step === 'recur') {
    const nRec = I.recur.filter(r => I.keep[r.id]).length;
    return `<section class="view">${top(`${I.recur.length} opération${I.recur.length > 1 ? 's' : ''} qui revien${I.recur.length > 1 ? 'nent' : 't'} chaque mois`, `${span}. Pour chacune : est-ce une <b>charge fixe</b> (ou un revenu fixe) ? Le nom proposé se modifie.`)}
    <div class="list">${I.recur.map(r => `<div class="rec ${I.keep[r.id] ? '' : 'off'}">
      <div class="rl"><input class="nm" data-rname="${r.id}" value="${esc(r.nom)}" aria-label="Nom">
        <div class="raw">${esc(r.lib.slice(0, 60))}</div>
        <div class="mini">le ${r.jour} · ${esc(r.cat)} · ${r.months}/${r.span} mois${r.variable ? ` · <span class="tag w">variable ${eur0(r.variable[0])} à ${eur0(r.variable[1])}</span>` : ''}</div>
        ${r.vir ? `<label class="mini" style="display:flex;gap:6px;align-items:center"><input type="checkbox" data-rvir="${r.id}" ${I.virOn[r.id] ? 'checked' : ''} style="width:18px;height:18px"> Virement lié vers ${esc(accName(r.vir))}</label>` : ''}</div>
      <div class="rr"><span class="amt ${r.sens === '+' ? 'pos' : 'neg'}">${r.sens === '+' ? '+' : '−'}${eur(r.montant)}${r.variable ? '<small>moyenne</small>' : ''}</span>
        <div class="yn"><button class="y" data-rkeep="${r.id}" data-v="1" aria-pressed="${!!I.keep[r.id]}">Fixe</button><button class="n" data-rkeep="${r.id}" data-v="0" aria-pressed="${!I.keep[r.id]}">Non</button></div></div></div>`).join('')}</div>
    ${I.recur.some(r => r.vir) ? `<div class="note">Un <b>virement lié</b> apparaît aussi sur le compte commun : il n'est compté qu'une fois, même si le relevé du commun a déjà été importé.</div>` : ''}
    <div class="hint">Les opérations « Non » rejoignent les opérations ponctuelles à l'étape suivante.</div>
    ${nextBtn(`Ajouter ${nRec} charge${nRec > 1 ? 's' : ''} fixe${nRec > 1 ? 's' : ''} · continuer`)}</section>`;
  }
  if (I.step === 'big') {
    const big = impRest(I).filter(t => t.big).sort((a, b) => Math.abs(b.montant) - Math.abs(a.montant));
    if (!big.length) { I.step = impNext(I); if (I.step === 'go') { setTimeout(commitImport); return '<section class="view"><p class="hint">Import…</p></section>'; } return vImport(); }
    return `<section class="view">${top('Gros mouvements et virements entre tes comptes', 'Ils fausseraient tes habitudes de dépenses. Comment les compter ?')}
    <div class="list">${big.map(t => `<div class="rec"><div class="rl"><b>${esc(impName(I, t))}</b><div class="raw">${t.date.split('-').reverse().join('/')} · ${esc(t.libelle.slice(0, 60))}</div>
      <div class="chips">${[['exc', 'Exceptionnel'], ['int', 'Entre mes comptes'], ['norm', 'Normal']].map(([k, l]) => `<button class="chip" data-bigk="${esc(t.ref)}" data-k="${k}" aria-pressed="${I.kind[t.ref] === k}">${l}</button>`).join('')}</div></div>
      <div class="rr"><span class="amt ${t.montant > 0 ? 'pos' : 'neg'}">${sgn(t.montant)}</span></div></div>`).join('')}</div>
    <div class="note"><b>Exceptionnel</b> : compté dans le solde, mais pas dans les habitudes ni les prévisions (achat de voiture, travaux, prime…).<br><b>Entre mes comptes</b> : épargne, livret, autre compte à toi. Ni dépense ni revenu. Retenu pour les prochains imports.</div>
    ${nextBtn('Continuer')}</section>`;
  }
  if (I.step === 'groups') {
    const G = impGroups(I), cats = impCats(I), nc = G.filter(g => !g.cat).length, n = impRest(I).length;
    if (!G.length) { I.step = impNext(I); if (I.step === 'go') { setTimeout(commitImport); return '<section class="view"><p class="hint">Import…</p></section>'; } return vImport(); }
    const q = NORM(I.q || ''), list = q ? G.filter(g => NORM(g.nom + ' ' + g.lib).includes(q)) : G, shown = list.slice(0, I.gshow);
    const known = I.kept.filter(t => t.dup || t.same).length, pts = I.kept.filter(t => t.match).length;
    return `<section class="view">${top(I.first ? 'Toutes les autres opérations' : 'Nouvelles opérations', `${n} opération${n > 1 ? 's' : ''} en ${G.length} groupe${G.length > 1 ? 's' : ''} par marchand${nc ? `, dont <b>${nc} à classer</b>` : ''}. Corrige seulement ce qui ne va pas : ton choix s'applique à tout le groupe et sert aux prochains imports.`)}
    ${!I.first ? `<div class="kv"><div><small>Nouvelles opérations</small><b>${n}</b></div><div><small>Prélèvements pointés</small><b>${pts}</b></div></div>${known ? `<div class="hint">${known} opération(s) déjà présente(s) ignorée(s) : pas de doublon.</div>` : ''}` : ''}
    <div class="search"><input id="impQ" placeholder="Rechercher un libellé…" value="${esc(I.q || '')}" aria-label="Rechercher" autocomplete="off"></div>
    <div class="list">${shown.map(g => `<div class="rec"><div class="rl">
        <input class="nm" data-gname="${esc(g.key)}" value="${esc(g.nom)}" aria-label="Nom">
        <div class="raw">${esc(g.lib.slice(0, 60))} · ${g.txs.length} opération${g.txs.length > 1 ? 's' : ''}</div>
        ${I.creating === g.key ? `<div class="inline"><input id="newCatIn" placeholder="Ex. Véhicule > Garage" autocomplete="off" style="flex:1;min-width:0"><button class="btn small" data-gnewok="${esc(g.key)}">Créer</button></div>`
        : `<select data-gcat="${esc(g.key)}" aria-label="Catégorie" class="${g.cat ? '' : 'todo'}"><option value="" ${g.cat ? '' : 'selected'}>À classer…</option>${cats.map(c => `<option ${c === g.cat ? 'selected' : ''}>${esc(c)}</option>`).join('')}<option value="__new">＋ Nouvelle catégorie…</option></select>`}
      </div><div class="rr"><span class="amt ${g.tot > 0 ? 'pos' : 'neg'}">${sgn(r2(g.tot))}</span>${g.txs.length > 1 ? '<small class="mini">au total</small>' : ''}</div></div>`).join('') || '<div class="empty">Aucun résultat.</div>'}
      ${list.length > shown.length ? `<button class="item" data-gmore="1" style="grid-template-columns:1fr;text-align:center;color:var(--accent);font-weight:700">Afficher ${Math.min(30, list.length - shown.length)} de plus (${list.length - shown.length} restants)</button>` : ''}</div>
    <div class="hint">Ce qui reste « à classer » pourra l'être plus tard dans l'onglet <b>Ponctuel</b>.</div>
    ${!I.first && I.solde ? (() => { const d = soldeDelta(I); return Math.abs(d.delta) >= 1 ? `<label class="switch" for="recal"><span>Recaler le solde sur le relevé (${eur(I.solde.montant)} au ${I.solde.date.split('-').reverse().join('/')}, écart ${sgn(r2(d.delta))})</span><input type="checkbox" id="recal" data-recal="1" ${I.recal ? 'checked' : ''}></label>` : ''; })() : ''}
    ${nextBtn(I.first ? 'Continuer' : 'Importer')}</section>`;
  }
  if (I.step === 'solde') return `<section class="view">${top('Solde du compte', '')}
    ${I.solde ? `<div class="hero"><span class="sub">Solde lu dans le relevé au ${I.solde.date.split('-').reverse().join('/')}</span><div class="big num">${eur(I.solde.montant)}</div>
      <div class="hint">Si ce n'est pas le bon, corrige-le :</div><div class="amountbox"><input id="impSolde" inputmode="decimal" value="${fr(I.solde.montant)}" aria-label="Solde"><span>€</span></div></div>`
    : `<div class="hero"><div class="hint" style="font-size:14px">Le fichier n'indique pas le solde. Indique le solde affiché par la banque à la date de la dernière opération du relevé (${I.tx[I.tx.length - 1].date.split('-').reverse().join('/')}).</div><div class="amountbox"><input id="impSolde" inputmode="decimal" placeholder="0,00" aria-label="Solde"><span>€</span></div></div>`}
    <div class="note">Le 31 démarre le compte au <b>1er ${mLabel(I.mois)}</b>, recalcule chaque mois passé et les clôture automatiquement.</div>
    <div class="actions">${back}<button class="btn" data-impstep="go">Créer le compte</button></div></section>`;
  const R = I.result || {};
  return `<section class="view"><h2 style="font-size:22px">${I.first ? 'Compte prêt' : 'Relevé importé'}</h2>
    <div class="hero"><div class="kv"><div><small>Opérations ajoutées</small><b>${R.ops || 0}</b></div><div><small>${I.first ? 'Charges fixes créées' : 'Prélèvements pointés'}</small><b>${I.first ? R.fixes || 0 : R.pts || 0}</b></div></div>
    ${R.exc ? `<div class="hint">${R.exc} mouvement${R.exc > 1 ? 's' : ''} exceptionnel${R.exc > 1 ? 's' : ''} ou entre tes comptes, hors habitudes.</div>` : ''}
    ${R.nc ? `<div class="hint">${R.nc} opération${R.nc > 1 ? 's' : ''} à classer : onglet <b>Ponctuel</b>, filtre « À classer ».</div>` : ''}
    ${R.dbl ? `<div class="note good">${R.dbl} rentrée${R.dbl > 1 ? 's' : ''} fixe${R.dbl > 1 ? 's' : ''} du compte commun remplacée${R.dbl > 1 ? 's' : ''} par le virement lié correspondant : plus de doublon.</div>` : ''}
    ${I.first ? `<div class="note good">Les habitudes sont calculées sur les dépenses courantes${R.clos ? ` et ${R.clos} mois passé${R.clos > 1 ? 's sont clôturés' : ' est clôturé'}` : ''}.</div>` : ''}
    ${R.recal ? `<div class="note">Solde recalé de ${sgn(R.recal)}.</div>` : ''}
    <div class="hint">Pour la suite : importe un nouveau relevé quand tu veux (bouton « Importer un relevé » dans l'onglet Mois). Les doublons sont ignorés et les prélèvements se pointent tout seuls.</div></div>
    <button class="btn" data-impclose="1">Voir le mois</button></section>`;
}
// écart entre le solde calculé par l'appli et le solde du relevé
function soldeDelta(I) {
  const d = I.solde.date, k = d.slice(0, 7);
  if (k < startMonth(I.acc) || k > CUR) return { delta: 0 };
  const r = calc(I.acc, k, startOf(I.acc, k)), day = Math.min(+d.slice(8, 10), r.D);
  // nouvelles opérations : celles du mois, et celles d'un mois passé pas encore clôturé
  const rest = impRest(I).filter(t => t.date <= d && (t.date.slice(0, 7) === k || !clot(I.acc, t.date.slice(0, 7)))).reduce((a, t) => a + t.montant, 0);
  // charge fixe reconnue : la courbe compte déjà son montant prévu seulement si elle y figure (pas « en retard », date passée)
  const ptsDiff = I.kept.filter(t => t.match && t.date <= d && t.date.slice(0, 7) === k).reduce((a, t) => { const ev = r.ev.find(e => e.key === t.match), inCurve = ev && !ev.late && ev.d <= day; return a + t.montant - (inCurve ? ev.v : 0); }, 0);
  return { delta: I.solde.montant - (r.curve[day - 1] + rest + ptsDiff) };
}
// Règle apprise (nom, catégorie, type) pour un marchand de ce compte
function ruleOp(acc, key, fields) {
  const ex = DB.regles.find(x => x.compte === acc && x.motif === key);
  return upd('Regles', Object.assign({ id: ex ? ex.id : uid(), compte: acc, motif: key }, ex ? {} : { categorie: '', nom: '', type: '' }, fields));
}
// Rentrée fixe du commun qui fait doublon avec un virement lié (montant et jour proches)
function dupFixeFor(v) {
  const a = num(v.montant) || 0, j = num(v.jour) || 1;
  return DB.fixes.find(f => f.compte === v.vers && f.sens === '+' && bool(f.actif) && Math.abs((num(f.montant) || 0) - a) <= Math.max(2, a * 0.02) && dayGap(num(f.jour) || 1, j) <= 5);
}
function commitImport(I0, silent) {
  const I = I0 || IMP, acc = I.acc, ops = [], pts = {}, res = { ops: 0, fixes: 0, pts: 0, clos: 0, exc: 0, nc: 0, dbl: 0 };
  const addPt = (t, cle) => { const k = t.date.slice(0, 7), id = k + '|' + cle; if (!pts[id]) pts[id] = { id, compte: acc, mois: k, cle, montantReel: 0 }; pts[id].montantReel = r2(pts[id].montantReel + Math.abs(t.montant)); };
  // date réelle d'une rentrée fixe vue passer (banque ou import) : gardée pour détecter automatiquement le jour de paie (V2.2)
  const payArr = {}, notePay = (fid, t) => { (payArr[fid] = payArr[fid] || {})[t.date.slice(0, 7)] = t.date; };
  I.kept.filter(t => t.match).forEach(t => { addPt(t, t.match); if (t.match[0] === 'f') { const f = DB.fixes.find(x => x.id === t.match.slice(1)); if (f && f.sens === '+') notePay(f.id, t); } });
  I.kept.filter(t => t.same).forEach(t => ops.push(upd('Operations', { id: t.same, ref: t.ref })));
  const have = new Set(catsOf(acc).map(c => c.nom.toLowerCase()));
  let ordre = Math.max(0, ...DB.categories.map(c => num(c.ordre) || 0));
  const needCat = cat => { if (cat) ops.push(...newCatOps(acc, cat, have)); };
  if (I.first) I.recur.filter(r => I.keep[r.id]).forEach(r => {
    const id = uid(), inK = r.txs.filter(t => t.date.slice(0, 7) >= I.mois);
    if (r.vir && I.virOn[r.id]) {
      const v = { id, de: acc, vers: r.vir, libelle: r.nom, montant: r.montant, jour: r.jour, profil: ME, debut: I.mois, fin: '', actif: 'oui', motif: r.motif };
      ops.push(upd('Virements', v)); inK.forEach(t => addPt(t, 'v' + id));
      const f = dupFixeFor(v); // le relevé du commun a déjà créé cette rentrée : on la remplace par le virement lié
      if (f) { ops.push(del('Fixes', f.id)); DB.pointages.filter(p => p.cle === 'f' + f.id).forEach(p => { ops.push(del('Pointages', p.id)); const nid = p.mois + '|v' + id; if (!pts[nid]) pts[nid] = { id: nid, compte: p.compte, mois: p.mois, cle: 'v' + id, montantReel: p.montantReel }; }); res.dbl++; }
    } else { ops.push(upd('Fixes', { id, compte: acc, libelle: r.nom, montant: r.montant, sens: r.sens, jour: r.jour, frequence: 'M', moisRef: '', categorie: r.cat, debut: I.mois, fin: '', actif: 'oui', motif: r.motif })); inK.forEach(t => { addPt(t, 'f' + id); if (r.sens === '+') notePay(id, t); }); }
    res.fixes++;
  });
  const rest = impRest(I);
  rest.forEach(t => {
    const cat = impCat(I, t), k = I.kind[t.ref], type = k === 'exc' || k === 'int' ? k : 'ponct';
    needCat(cat);
    ops.push(upd('Operations', { id: uid(), compte: acc, date: t.date, montant: r2(t.montant), categorie: cat, libelle: t.libelle.slice(0, 80), profil: ME, type, lien: '', ref: t.ref }));
    res.ops++; if (type !== 'ponct') res.exc++; if (!cat) res.nc++;
  });
  // noms et catégories corrigés, virements entre comptes : retenus pour les prochains imports
  const rk = {};
  Object.keys(I.gtouch).forEach(k => { rk[k] = rk[k] || {}; if (k in I.gname) rk[k].nom = I.gname[k]; if (k in I.gcat) rk[k].categorie = I.gcat[k]; });
  rest.filter(t => I.kind[t.ref] === 'int').forEach(t => { rk[gk(t)] = Object.assign(rk[gk(t)] || {}, { type: 'int' }); });
  Object.entries(rk).forEach(([k, f]) => ops.push(ruleOp(acc, k, f)));
  Object.values(pts).forEach(p => ops.push(upd('Pointages', p)));
  res.pts = Object.keys(pts).length;
  if (I.first) {
    const sIn = num(($('impSolde') || {}).value);
    const S = sIn !== null ? sIn : I.solde ? I.solde.montant : 0, D = I.solde && sIn === I.solde.montant ? I.solde.date : I.tx[I.tx.length - 1].date;
    const M = I.kept.filter(t => t.date <= D).reduce((a, t) => a + t.montant, 0), s0 = r2(S - M);
    ops.push(upd('Comptes', { id: acc, soldeDepart: s0, moisDepart: I.mois }));
    const lastM = I.kept.length ? I.kept[I.kept.length - 1].date.slice(0, 7) : I.mois;
    for (let k = I.mois; k < lastM && k < CUR; k = addM(k, 1)) {
      const end = k + '-31', bal = s0 + I.kept.filter(t => t.date <= end).reduce((a, t) => a + t.montant, 0);
      ops.push(upd('Clotures', { id: acc + '|' + k, compte: acc, mois: k, soldeFin: r2(bal), dateCloture: TODAY_ISO })); res.clos++;
    }
  }
  ops.push(upd('Parametres', { cle: 'imp14|' + acc, valeur: TODAY_ISO }));
  if (Object.keys(payArr).length) {
    let h; try { h = JSON.parse(param('paye|' + acc, '{}')) || {}; } catch (e) { h = {}; }
    Object.entries(payArr).forEach(([fid, ms]) => h[fid] = Object.assign(h[fid] || {}, ms));
    ops.push(upd('Parametres', { cle: 'paye|' + acc, valeur: JSON.stringify(h) }));
  }
  const recal = !I.first && I.solde && I.recal ? r2(soldeDelta(I).delta) : 0;
  commit(ops);
  if (Math.abs(recal) >= 1) { commit([upd('Operations', { id: uid(), compte: acc, date: I.solde.date, montant: recal, categorie: 'Correction de solde', libelle: I.parsed.format === 'Banque' ? 'Correction (solde de la banque)' : 'Correction (relevé importé)', profil: ME, type: 'ajust', lien: '', ref: '' })]); res.recal = recal; }
  if (silent) return res;
  I.result = res; I.step = 'done'; I.steps = null; render(); scrollTo(0, 0);
}



/* ================= V2 : connexion bancaire ================= */
const BK = { busy: false, last: store.get('le31-bk-last', 0), res: null, err: {}, view: null, acc: null, q: '', list: null, sel: {}, mode: {}, queue: [], auto: store.get('le31-bk-auto', true), msg: '' };
const bkConf = () => DB.banqueConf[0] || {};
const bkOn = () => bkConf().ok === 'oui';
const bkRow = acc => DB.banque.find(r => r.compte === acc && r.actif === 'oui');
const bkLinked = () => accs().filter(a => bkRow(a.id)).map(a => a.id);
function bkPend() { try { return JSON.parse(bkConf().attente || 'null'); } catch (e) { return null; } }
const bkDays = r => r && r.jusqua ? Math.floor((new Date(r.jusqua) - Date.now()) / 864e5) : 999;
const isoAdd = (iso, n) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const lastRefDate = acc => DB.operations.filter(o => o.compte === acc && o.ref).reduce((m, o) => String(o.date) > m ? String(o.date) : m, '');

// Lecture de la banque : silencieuse pour un compte déjà démarré, import guidé pour un compte neuf ou « tout reconstruire »
async function bankSync(o) {
  o = o || {};
  if (BK.busy || !bkOn() || !JETON()) return;
  const linked = bkLinked(); if (!linked.length) return;
  BK.busy = true; BK.msg = ''; render();
  const depuis = {}, first = o.first || {}, P = [];
  linked.forEach(acc => {
    const b0 = param('bk0|' + acc, '');
    if (first[acc] === 'refaire' || !started(acc)) depuis[acc] = isoAdd(TODAY_ISO, -400); // la banque fournit ce qu'elle peut (souvent 90 j à 13 mois)
    else if (first[acc] === 'reprendre' || !b0) depuis[acc] = lastRefDate(acc) || isoAdd(TODAY_ISO, -60); // dès le jour du dernier import : les opérations déjà là sont reconnues
    else depuis[acc] = [b0, lastRefDate(acc) ? isoAdd(lastRefDate(acc), -10) : b0].sort().pop(); // 10 jours de recouvrement : les doublons sont ignorés
    if (!b0 || first[acc]) P.push(upd('Parametres', { cle: 'bk0|' + acc, valeur: depuis[acc] }));
  });
  try {
    const j = await api({ action: 'banqueSync', depuis, force: !!o.force });
    if (j.acces) store.set('le31-acces', j.acces);
    received(j.data, j.moi);
    if (P.length) commit(P);
    BK.last = Date.now(); store.set('le31-bk-last', BK.last);
    const tot = { ops: 0, pts: 0, nc: 0, recal: 0, n: 0 };
    (j.comptes || []).forEach(c => {
      BK.err[c.compte] = c.erreur === 'recent' ? '' : c.erreur;
      if (c.erreur) return;
      const parsed = { tx: c.tx, solde: c.solde, format: 'Banque' };
      if (!c.tx.length && !c.solde) return;
      if (first[c.compte] === 'refaire' || !started(c.compte)) { if (c.tx.length) BK.queue.push({ acc: c.compte, parsed, mode: first[c.compte] === 'refaire' ? 'reset' : null }); return; }
      const I = startImport(parsed, 'add', { acc: c.compte, silent: true });
      const r = commitImport(I, true); tot.ops += r.ops; tot.pts += r.pts; tot.nc += r.nc; tot.n++; if (r.recal) tot.recal += r.recal;
    });
    BK.res = tot.n ? tot : BK.res;
  } catch (e) { BK.msg = String(e.message || e); }
  BK.busy = false;
  if (BK.queue.length && !UI.imp) { const q = BK.queue.shift(); UI.acc = q.acc; startImport(q.parsed, q.mode, { acc: q.acc }); }
  render();
}
function bankAuto() {
  if (!BK.auto || BK.busy || UI.imp || BK.view || !LOADED || !bkOn() || bkPend()) return;
  if (Date.now() - BK.last < 2 * 3600 * 1000) return;
  if (bkLinked().some(a => bkDays(bkRow(a)) >= 0)) bankSync({});
}
async function bankStart(acc, aspsp) {
  BK.busy = true; render();
  try {
    const j = await api({ action: 'banqueAuth', compte: acc, aspsp, retour: location.origin + location.pathname });
    store.set('le31-bk-going', { acc, aspsp, t: Date.now() });
    location.href = j.url;
  } catch (e) { BK.busy = false; toast('Banque : ' + (e.detail || e.message)); render(); }
}
// retour de la banque : ?code=…&state=…
async function bankReturn(code, state) {
  BK.view = 'retour'; BK.busy = true; render();
  try {
    if (!apiOk()) throw Object.assign(new Error('safari'), {});
    const r = await fetchT(API(), { method: 'POST', body: JSON.stringify({ action: 'banqueRetour', code, state }) });
    const j = await readJson(r); if (!j.ok) throw Object.assign(new Error(j.erreur || 'erreur'), { detail: j.detail });
    store.set('le31-bk-going', null);
    BK.view = null; BK.busy = false; await pull(); render();
  } catch (e) { BK.busy = false; BK.msg = e.message === 'safari' ? 'safari' : (e.detail || e.message); render(); }
}
async function bankLink() {
  const P = bkPend(); if (!P) return;
  const liens = P.comptes.map(a => ({ uid: a.uid, compte: BK.sel[a.uid] || '' }));
  const used = liens.map(l => l.compte).filter(Boolean);
  if (new Set(used).size !== used.length) { toast('Un compte de Le 31 ne peut suivre qu\'un seul compte bancaire'); return; }
  BK.busy = true; render();
  try {
    const j = await api({ action: 'banqueLier', sid: P.sid, liens }); received(j.data, j.moi);
    BK.busy = false; BK.view = null;
    if (!used.length) { toast('Aucun compte suivi'); render(); return; }
    const first = {}; used.forEach(a => first[a] = started(a) ? (BK.mode[a] || 'reprendre') : 'neuf');
    toast('Compte' + (used.length > 1 ? 's reliés' : ' relié') + ' : première lecture…');
    await bankSync({ force: true, first });
  } catch (e) { BK.busy = false; toast('Banque : ' + (e.detail || e.message)); render(); }
}
async function bankUnlink(acc) {
  try { const j = await api({ action: 'banqueDelier', compte: acc }); received(j.data, j.moi); toast('Compte délié : retour à l\'import de relevés'); } catch (e) { toast('Erreur : ' + e.message); }
}
// défaut proposé : compte courant -> compte choisi, compte joint -> commun, épargne -> ne pas suivre
function bkGuess(P) {
  const sel = {}, taken = new Set(), N = s => NORM(s);
  // renouvellement : mêmes associations qu'avant (repérées par la fin de l'IBAN)
  P.comptes.forEach(a => { const r = a.fin && DB.banque.find(x => x.fin === a.fin && x.aspsp === P.aspsp); if (r && !taken.has(r.compte)) { sel[a.uid] = r.compte; taken.add(r.compte); } });
  const commun = accs().find(a => !a.proprietaire);
  P.comptes.forEach(a => { if (/LIVRET|EPARGNE|LDD|LEP|PEL\b|CEL\b|ASSURANCE|PEA|TITRE/.test(N(a.nom))) sel[a.uid] = ''; });
  P.comptes.forEach(a => { if (sel[a.uid] === undefined && /JOINT|COMMUN/.test(N(a.nom)) && commun && !taken.has(commun.id)) { sel[a.uid] = commun.id; taken.add(commun.id); } });
  P.comptes.forEach(a => { if (sel[a.uid] === undefined && !taken.has(P.compte)) { sel[a.uid] = P.compte; taken.add(P.compte); } });
  P.comptes.forEach(a => { if (sel[a.uid] === undefined) sel[a.uid] = ''; });
  return sel;
}
const bkTime = acc => { const r = bkRow(acc); if (!r || !r.derniere) return ''; const d = new Date(r.derniere); return d.toDateString() === new Date().toDateString() ? d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : fmtD(r.derniere); };
function bankChip() {
  const el = $('bankChip'); if (!el) return;
  const acc = UI.acc, r = bkRow(acc);
  el.hidden = !bkOn() || !r || !!gate() || !!(UI.imp && IMP) || !!BK.view;
  if (el.hidden) return;
  const warn = bkDays(r) <= 7 || BK.err[acc] === 'expire';
  el.className = 'bkchip' + (BK.busy ? ' busy' : warn || BK.err[acc] ? ' warn' : '');
  el.innerHTML = BK.busy ? '<span class="spin"></span>Banque…' : warn ? '⚠ Banque' : `✓ Banque${bkTime(acc) ? ' · ' + bkTime(acc) : ''}`;
  el.title = warn ? 'Accord bancaire à renouveler' : 'Lire la banque maintenant';
}
// bandeaux de l'onglet Mois
function bankBanners(acc) {
  if (!bkOn()) return '';
  let h = ''; const r = bkRow(acc), e = BK.err[acc];
  if (BK.res && BK.res.ops + BK.res.pts > 0) h += `<div class="banner good"><span><b>${BK.res.ops} nouvelle${BK.res.ops > 1 ? 's' : ''} opération${BK.res.ops > 1 ? 's' : ''}</b> de la banque${BK.res.pts ? ` · ${BK.res.pts} prélèvement${BK.res.pts > 1 ? 's' : ''} pointé${BK.res.pts > 1 ? 's' : ''}` : ''}${BK.res.nc ? ` · <b>${BK.res.nc} à classer</b>` : ''}</span><span style="display:flex;gap:6px">${BK.res.nc ? '<button class="btn small" data-bkvoir="1">Voir</button>' : ''}<button class="btn ghost small" data-bkok="1">OK</button></span></div>`;
  if (r && (e === 'expire' || bkDays(r) < 0)) h += `<div class="banner warn"><span>L'accord avec <b>${esc(r.aspsp)}</b> est terminé : Le 31 ne lit plus ce compte.</span><button class="btn small" data-bkrenew="${esc(acc)}">Renouveler</button></div>`;
  else if (r && bkDays(r) <= 7) h += `<div class="banner warn"><span>L'accord avec <b>${esc(r.aspsp)}</b> se termine dans <b>${bkDays(r)} jour${bkDays(r) > 1 ? 's' : ''}</b>.</span><button class="btn small" data-bkrenew="${esc(acc)}">Renouveler</button></div>`;
  if (r && e === 'limite') h += `<div class="banner warn"><span>${esc(r.aspsp)} limite le nombre de lectures par jour : nouvel essai plus tard. Données du ${esc(bkTime(acc) || 'dernier passage')}.</span></div>`;
  else if (r && e && e !== 'expire') h += `<div class="banner warn"><span>Lecture de la banque impossible pour l'instant (${esc(e)}).</span><button class="btn ghost small" data-bksync="1">Réessayer</button></div>`;
  if (BK.msg && BK.msg !== 'safari') h += `<div class="banner warn"><span>Banque : ${esc(BK.msg)}</span><button class="btn ghost small" data-bksync="1">Réessayer</button></div>`;
  return h;
}
// Réglages > Connexion bancaire
function vBankSet() {
  const head = `<div class="rowhead"><h2>Connexion bancaire</h2><span class="sub">V2</span></div>`;
  if (!bkOn()) return `<div class="hero" style="gap:10px">${head}<div class="hint" style="font-size:13px">Pas encore configurée. La personne qui a installé Le 31 la met en place une fois : application Enable Banking (tuto <b>4-ENABLE-BANKING</b>), puis menu <b>Le 31 > Connexion bancaire</b> dans le Google Sheet. En attendant, l'import de relevés marche comme avant.</div></div>`;
  const row = a => { const r = bkRow(a.id), d = bkDays(r);
    return `<div class="item" style="grid-template-columns:40px 1fr auto" disabled><span class="day" style="${r ? 'background:var(--good-soft);color:var(--good)' : ''}">${r ? '✓' : '—'}</span><span class="lbl"><b>${esc(a.nom)}</b><small>${r ? `${esc(r.aspsp)} ${esc(r.fin)} · ${d < 0 ? '<span style="color:var(--bad)">accord terminé</span>' : 'accord jusqu\'au ' + fmtD(r.jusqua)}${r.derniere ? ' · lu ' + esc(bkTime(a.id)) : ''}` : 'Pas relié : import de relevés à la main'}</small></span>
      <span style="display:flex;gap:6px">${r ? `${d <= 30 ? `<button class="btn small" data-bkrenew="${esc(a.id)}">Renouveler</button>` : ''}<button class="btn ghost small" data-bkunlink="${esc(a.id)}">Délier</button>` : `<button class="btn small" data-bklink="${esc(a.id)}">Relier</button>`}</span></div>`; };
  return `<div class="hero" style="gap:10px">${head}
    <div class="hint" style="font-size:13px">Le 31 lit les opérations de la banque à chaque ouverture (lecture seule : aucun virement possible). Via Enable Banking, avec la clé du foyer gardée dans Apps Script.</div>
    <div class="list">${accs().map(row).join('')}</div>
    ${DB.profils.length > 1 ? '<div class="hint">À deux : chacun relie son compte perso depuis son téléphone ; le compte commun est relié une seule fois, par l\'un des deux.</div>' : ''}
    <label class="switch" for="bkAuto"><span style="font-size:14px">Lire la banque à l'ouverture<small class="mini" style="display:block">au plus toutes les 2 h ; « Banque » en haut pour forcer</small></span><input type="checkbox" id="bkAuto" ${BK.auto ? 'checked' : ''}></label>
    ${bkLinked().length ? `<button class="btn ghost small" data-bksync="1">Lire la banque maintenant</button>` : ''}</div>`;
}
// écrans pleine page : choix de la banque, retour, association des comptes
function vBank() {
  const close = `<button class="btn ghost small" data-bkclose="1">Annuler</button>`;
  if (BK.view === 'retour') {
    if (BK.busy) return `<section class="view center"><div class="logo31">Le 31<span>.</span></div><p class="hint"><span class="spin"></span> Retour de la banque…</p></section>`;
    if (BK.msg === 'safari') return `<section class="view center"><div class="logo31">Le 31<span>.</span></div><h2>Presque fini</h2><p class="hint" style="font-size:14px">La banque est revenue dans le navigateur plutôt que dans l'appli. Ouvre <b>Le 31</b> depuis l'écran d'accueil et relance <b>Relier</b> : ça prend 30 secondes.</p></section>`;
    return `<section class="view center"><div class="logo31">Le 31<span>.</span></div><h2>La banque n'a pas confirmé</h2><p class="hint">${esc(BK.msg)}</p><button class="btn" data-bkclose="1">Revenir à l'appli</button></section>`;
  }
  if (BK.view === 'bank') {
    if (!BK.list) return `<section class="view"><div class="rowhead"><h2>Ta banque</h2>${close}</div><p class="hint"><span class="spin"></span> Liste des banques…</p></section>`;
    const q = NORM(BK.q), l = BK.list.filter(b => !q || NORM(b.n).includes(q)).slice(0, 60);
    return `<section class="view"><div class="steps"><i class="on"></i><i></i><i></i></div><div class="rowhead"><h2>Ta banque</h2>${close}</div>
      <p class="hint" style="font-size:14px;margin:0">Pour : <b>${esc(accName(BK.acc))}</b>. Tu vas passer quelques instants sur la page de ta banque pour donner ton accord (lecture seule, ${'180'} jours au plus).</p>
      <div class="search"><input id="bkQ" placeholder="Rechercher (Crédit Mutuel, Bourso…)" value="${esc(BK.q)}" autocomplete="off"></div>
      <div class="list">${l.map(b => `<button class="item" style="grid-template-columns:1fr auto" data-bkbank="${esc(b.n)}" ${BK.busy ? 'disabled' : ''}><span class="lbl"><b>${esc(b.n)}</b></span><span>›</span></button>`).join('') || '<div class="empty">Banque introuvable : elle n\'est peut-être pas couverte. L\'import de relevés reste possible.</div>'}</div>
      ${BK.busy ? '<p class="hint"><span class="spin"></span> Direction la banque…</p>' : ''}
      ${IOS ? '<div class="note">Sur iPhone/iPad : si la banque ouvre son application pour valider, reviens ensuite sur la page de la banque, elle te ramènera dans Le 31.</div>' : ''}</section>`;
  }
  const P = bkPend(); if (!P) { BK.view = null; return ''; }
  if (!Object.keys(BK.sel).length || !P.comptes.every(a => a.uid in BK.sel)) BK.sel = bkGuess(P);
  const opts = sel => `<option value="" ${!sel ? 'selected' : ''}>Ne pas suivre</option>` + accs().map(a => `<option value="${esc(a.id)}" ${sel === a.id ? 'selected' : ''}>→ ${esc(a.nom)}</option>`).join('');
  const chosen = [...new Set(Object.values(BK.sel).filter(Boolean))];
  return `<section class="view"><div class="steps"><i class="on"></i><i class="on"></i><i></i></div><div class="rowhead"><h2 style="font-size:20px">Quels comptes suivre ?</h2>${close}</div>
    <p class="hint" style="font-size:14px;margin:0">${esc(P.aspsp)} a partagé ${P.comptes.length} compte${P.comptes.length > 1 ? 's' : ''}. Associe chacun à un compte de Le 31.</p>
    <div class="list">${P.comptes.map(a => `<div class="rec" style="grid-template-columns:1fr auto"><div class="rl"><b>${esc(a.nom)}</b><div class="raw">${esc(a.fin)}</div><select data-bksel="${esc(a.uid)}">${opts(BK.sel[a.uid])}</select></div><div class="rr">${a.solde ? `<span class="amt ${a.solde.montant >= 0 ? '' : 'neg'}">${eur(a.solde.montant)}</span>` : ''}</div></div>`).join('')}</div>
    <div class="hint">Un livret d'épargne peut rester « Ne pas suivre » : les virements vers lui sont déjà reconnus comme « Entre mes comptes ».</div>
    ${chosen.map(acc => started(acc) ? `<div class="hero" style="gap:8px"><b>${esc(accName(acc))}</b>
      <label class="check"><input type="radio" name="bkm-${esc(acc)}" data-bkmode="${esc(acc)}" value="reprendre" ${(BK.mode[acc] || 'reprendre') === 'reprendre' ? 'checked' : ''}><span><b>Reprendre après le dernier import</b>${lastRefDate(acc) ? ` (${fmtD(lastRefDate(acc))})` : ''}<br><small class="mini">Recommandé : catégories, noms et charges fixes gardés. Seules les nouvelles opérations arrivent, et le solde est recalé sur celui de la banque.</small></span></label>
      <label class="check"><input type="radio" name="bkm-${esc(acc)}" data-bkmode="${esc(acc)}" value="refaire" ${BK.mode[acc] === 'refaire' ? 'checked' : ''}><span><b>Tout reconstruire depuis la banque</b><br><small class="mini">Comme « Tout refaire » avec un relevé, sur l'historique fourni par la banque (souvent 90 jours à 13 mois).</small></span></label></div>`
      : `<div class="note">${esc(accName(acc))} : premier import à partir de l'historique de la banque (charges fixes à confirmer, comme avec un relevé).</div>`).join('')}
    <button class="btn" data-bklier="1" ${BK.busy ? 'disabled' : ''}>${BK.busy ? 'Enregistrement…' : 'Valider'}</button></section>`;
}
// annuler l'association : la session bancaire est refermée côté serveur
async function bankLinkCancel() { const P = bkPend(); if (!P) return; try { const j = await api({ action: 'banqueLier', sid: P.sid, liens: [] }); received(j.data, j.moi); } catch (e) {} }

/* ----- Profils et accès ----- */
const fmtD = iso => { const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' }); };
function vProfiles() {
  const myAcc = store.get('le31-acces', '');
  const rows = profiles().map(p => {
    const me = p.id === ME, devs = DB.appareils.filter(a => a.profil === p.id && a.actif === 'oui'), wait = DB.attente.some(a => a.profil === p.id);
    const sees = 'Voit : ' + [accs().some(a => !a.proprietaire) || DB.comptes.some(a => !a.proprietaire) ? 'le compte commun' : '', p.perso === 'oui' ? 'son compte perso' : ''].filter(Boolean).join(' + ');
    return `<div class="env" style="gap:8px">
      <div class="inline"><input id="pf-${esc(p.id)}" data-prof="${esc(p.id)}" value="${esc(p.nom)}" aria-label="Prénom" style="border:1px solid var(--line);background:var(--surface);border-radius:10px;padding:8px 10px;font-weight:600;min-width:0">${me ? '<span class="tag">toi</span>' : ''}</div>
      <div class="mini">${esc(sees)}</div>
      ${devs.map(d => `<div class="inline" style="justify-content:space-between;font-size:13px"><span>📱 ${esc(d.appareil)} · depuis le ${fmtD(d.cree)}${d.vu ? ' · vu le ' + fmtD(d.vu) : ''}${d.id === myAcc ? ' · <b>cet appareil</b>' : ''}</span>${d.id === myAcc ? '' : `<button class="btn danger small" data-cut="${esc(d.id)}" data-cutname="${esc(p.nom)}">Couper</button>`}</div>`).join('') || `<div class="mini">${wait ? 'Lien envoyé, pas encore utilisé.' : 'Aucun appareil connecté.'}</div>`}
      ${devs.length && wait ? '<div class="mini">Un nouveau lien est en attente d\'utilisation.</div>' : ''}
      <div class="actions"><button class="btn ghost small" data-invite="${esc(p.id)}">${me ? 'Lien pour un autre appareil' : 'Envoyer son lien'}</button>${!me && devs.length ? `<button class="btn danger small" data-cutall="${esc(p.id)}" data-cutname="${esc(p.nom)}">Couper tous ses accès</button>` : ''}</div>
    </div>`;
  }).join('');
  return `<div class="hero" style="gap:12px"><div class="rowhead"><h2>Profils et accès</h2></div>
    <div class="list">${rows}</div>
    <form class="form" id="profForm" novalidate style="gap:8px"><div class="field"><label for="pfnew">Ajouter une personne</label><input id="pfnew" placeholder="Prénom" autocomplete="off"></div>
      <label class="switch" for="pfperso"><span>Lui créer un compte perso</span><input type="checkbox" id="pfperso" checked></label>
      <button class="btn ghost small" type="submit">Ajouter et envoyer son lien</button></form>
    <div class="hint">Chacun a son propre lien, qui ne marche qu'une fois, sur un seul appareil. Chacun voit le compte commun et son compte perso, jamais celui de l'autre. Téléphone perdu : l'autre personne coupe son accès ici, puis lui renvoie un lien. En dernier recours : menu « Le 31 » du Google Sheet. Le propriétaire du Google Sheet peut techniquement tout voir dans le Sheet.</div>
  </div>`;
}
async function invite(pid) {
  const p = DB.profils.find(x => x.id === pid); if (!p) return;
  try {
    const j = await api({ action: 'inviter', profil: pid });
    const link = location.origin + location.pathname + '#inv=' + j.code + '&api=' + encodeURIComponent(API());
    received(j.data, j.moi);
    const me = pid === ME;
    const msg = me ? `Mon accès à *Le 31* pour un autre appareil :\n${link}` : `Salut ${p.nom} 👋\nVoici ton accès à *Le 31*, notre appli de budget.\nOuvre ce lien sur ton téléphone puis appuie sur _Installer_ (iPhone : Partager > Sur l'écran d'accueil) :\n${link}\n_Ce lien est personnel et ne marche qu'une fois._`;
    openSheet(`<div class="form"><h2>${me ? 'Lien pour un autre appareil' : 'Envoyer son lien à ' + esc(p.nom)}</h2>
      <textarea id="shareTxt" readonly style="width:100%;min-height:150px;border:1px solid var(--line);background:var(--surface);border-radius:12px;padding:10px;font:inherit;font-size:14px">${esc(msg)}</textarea>
      <div class="note warn">Ce lien ouvre le compte commun${p.perso === 'oui' ? ' et le compte perso de ' + esc(p.nom) : ''}. ${me ? 'Garde-le pour toi.' : 'Envoie-le seulement à ' + esc(p.nom) + '.'} Il ne marche qu'une fois, pendant 14 jours.</div>
      <div class="actions"><button class="btn ghost" data-copyshare="1">Copier</button><button class="btn" data-doshare="1">Partager…</button></div></div>`);
  } catch (e) { toast(e instanceof TypeError ? 'Connexion nécessaire pour créer un lien' : 'Erreur : ' + e.message); }
}
async function cutAccess(body, label) {
  try { const j = await api(Object.assign({ action: 'couper' }, body)); received(j.data, j.moi); closeSheet(); toast(label); render(); }
  catch (e) { toast(e instanceof TypeError ? 'Connexion nécessaire' : 'Erreur : ' + e.message); }
}

/* ================= Feuilles (fenêtres) ================= */
const sheetRoot = $('sheetRoot');
function openSheet(html) { sheetRoot.innerHTML = `<div class="sheet-bg" data-closebg="1"><div class="sheet" role="dialog" aria-modal="true"><div class="grab"></div>${html}</div></div>`; const f = sheetRoot.querySelector('input:not([type=checkbox]),select'); if (f && !f.value && f.id !== 'fF') setTimeout(() => f.focus(), 50); }
function closeSheet() { sheetRoot.innerHTML = ''; }
function monthOpts(sel, from, n) { return Array.from({ length: n }, (_, i) => { const k = addM(from, i); return `<option value="${k}" ${k === sel ? 'selected' : ''}>${mLabel(k)}</option>`; }).join(''); }
// Opération ponctuelle -> charge fixe : ses opérations (et celles du même marchand) depuis le mois choisi deviennent les prélèvements de la charge
function fixFromOp(o) {
  const sim = [o].concat(simOps(o)).sort((x, y) => String(x.date).localeCompare(String(y.date)));
  const recent = sim.filter(x => String(x.date).slice(0, 7) >= addM(CUR, -12)), amts = recent.slice(-6).map(x => Math.abs(num(x.montant) || 0));
  const first = String((recent[0] || o).date).slice(0, 7);
  sheetRoot.dataset.sens = (num(o.montant) || 0) > 0 ? '+' : '-';
  fixedSheet({ id: '', libelle: nameOf(o), montant: r2(median(amts)), sens: (num(o.montant) || 0) > 0 ? '+' : '-', jour: String(+String(o.date).slice(8, 10)), frequence: 'M', moisRef: '', categorie: o.categorie || '', debut: first < startMonth(o.compte) ? startMonth(o.compte) : first, fin: '', actif: 'oui', compte: o.compte }, 'fix', o);
}
function fixedSheet(f, kind, fromOp) {
  const isNew = !f || (fromOp && !f.id), acc = fromOp ? fromOp.compte : UI.acc, oth = otherAcc(acc);
  kind = kind || 'fix';
  if (kind === 'vir') f = f || { id: '', libelle: 'Apport au ' + accName(oth), montant: '', jour: '1', de: acc, vers: oth, profil: (profiles()[0] || {}).id, debut: CUR, fin: '', actif: 'oui' };
  else f = f || { id: '', libelle: '', montant: '', sens: sheetRoot.dataset.sens || '-', jour: '1', frequence: 'M', moisRef: String(pm(CUR).m + 1), categorie: '', debut: CUR, fin: '', actif: 'oui' };
  const p = !isNew && point(CUR, (kind === 'vir' ? 'v' : 'f') + f.id);
  const catList = [...new Set(catsOf(acc).map(c => c.nom).concat(DB.fixes.map(x => x.categorie)).filter(Boolean).concat(['Logement', 'Crédits', 'Énergie', 'Assurances', 'Abonnements', 'Impôts', 'Enfants', 'Épargne', 'Revenus']))];
  const nSim = fromOp ? 1 + simOps(fromOp).length : 0;
  openSheet(`<form class="form" id="fixForm" data-id="${esc(f.id)}" data-kind="${kind}" data-fromop="${fromOp ? esc(fromOp.id) : ''}" novalidate>
    <h2>${fromOp ? 'Passer en charge fixe' : isNew ? 'Nouvelle opération fixe' : 'Modifier'}</h2>
    ${fromOp ? `<div class="note">Le montant proposé est la médiane des derniers mois. Les opérations « ${esc(nameOf(fromOp))} » (${nSim} en tout) à partir du mois choisi deviennent les prélèvements de cette charge : elles sont comptées une seule fois. Une charge qui s'arrête un temps (abonnement en pause) se met en pause dans l'onglet Fixes.</div>` : ''}
    ${isNew && !fromOp ? `<div class="seg" style="grid-template-columns:1fr 1fr 1fr"><button type="button" data-fkind="-" aria-pressed="${kind === 'fix' && f.sens === '-'}">Charge</button><button type="button" data-fkind="+" aria-pressed="${kind === 'fix' && f.sens === '+'}">Rentrée</button><button type="button" data-fkind="vir" aria-pressed="${kind === 'vir'}">Virement</button></div>` : ''}
    ${kind === 'vir' ? `<div class="field"><label for="fDir">Sens</label><select id="fDir">${accs().map(a => accs().filter(b => b.id !== a.id).map(b => `<option value="${esc(a.id)}>${esc(b.id)}" ${f.de === a.id && f.vers === b.id ? 'selected' : ''}>${esc(a.nom)} → ${esc(b.nom)}</option>`).join('')).join('')}</select></div>` : ''}
    <div class="field"><label for="fL">Libellé</label><input id="fL" value="${esc(f.libelle)}" placeholder="${kind === 'vir' ? 'Ex. Apport mensuel' : 'Ex. Électricité'}" autocomplete="off"></div>
    <div class="two"><div class="field"><label for="fA">Montant (€)</label><input id="fA" inputmode="decimal" value="${fr(f.montant)}"></div>
    <div class="field"><label for="fD">Jour du prélèvement</label><input id="fD" type="number" inputmode="numeric" min="1" max="31" value="${esc(f.jour)}"></div></div>
    ${kind === 'vir' ? (profiles().length > 1 ? `<div class="field"><label for="fW">Versé par</label><select id="fW"><option value="">—</option>${profiles().map(x => `<option value="${esc(x.id)}" ${x.id === f.profil ? 'selected' : ''}>${esc(x.nom)}</option>`).join('')}</select></div>` : '') :
    `<div class="two"><div class="field"><label for="fF">Fréquence</label><select id="fF">${Object.entries(FREQ).map(([k, v]) => `<option value="${k}" ${k === (f.frequence || 'M') ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
    <div class="field"><label for="fS">Mois du prélèvement</label><select id="fS">${MONTHS_L.map((n, i) => `<option value="${i + 1}" ${i + 1 === (num(f.moisRef) || 1) ? 'selected' : ''}>${n}</option>`).join('')}</select></div></div>
    <div class="hint" style="margin-top:-6px">Le mois du prélèvement ne sert que pour le trimestriel et l'annuel.</div>
    <div class="field"><label for="fC">Catégorie</label><input id="fC" list="fCl" value="${esc(f.categorie)}" placeholder="Ex. Énergie" autocomplete="off"><datalist id="fCl">${catList.map(c => `<option value="${esc(c)}">`).join('')}</datalist></div>`}
    <div class="two"><div class="field"><label for="fB">À partir de</label><select id="fB">${monthOpts(f.debut || CUR, addM(f.debut && f.debut < CUR ? f.debut : CUR, -12), 36)}</select></div>
    <div class="field"><label for="fE">Dernière échéance</label><select id="fE"><option value="">Sans fin</option>${monthOpts(f.fin, f.fin && f.fin < addM(CUR, -1) ? f.fin : addM(CUR, -1), 120)}</select></div></div>
    <label class="switch" for="fOn"><span>Active (décomptée automatiquement)</span><input type="checkbox" id="fOn" ${bool(f.actif) ? 'checked' : ''}></label>
    ${p ? `<div class="note good" style="display:flex;justify-content:space-between;align-items:center;gap:8px"><span>Pointé ce mois : <b>${eur(num(p.montantReel))}</b></span><button type="button" class="btn ghost small" data-unpoint="${esc(p.id)}">Annuler</button></div>` : ''}
    ${(kind === 'vir' ? (isShared(f.de) || isShared(f.vers)) : isShared(f.compte || acc)) ? `<div class="note">Compte partagé : ${isNew ? 'cette opération sera visible' : 'cette modification s\'applique'} aussi pour ${esc(otherNames())}.</div>` : ''}
    <div class="actions">${isNew ? '' : `<button type="button" class="btn danger" data-del="${kind}:${esc(f.id)}">Supprimer</button>`}<button class="btn" type="submit">Enregistrer</button></div>
    <div class="hint">Pour une charge qui s'arrête (fin de crédit…), indique la dernière échéance plutôt que de la supprimer : l'historique reste juste.</div>
    <div id="confirmBox"></div>
  </form>`);
}
function catSheet(acc, c) {
  openSheet(`<form class="form" id="catForm" data-acc="${esc(acc)}" data-id="${c ? esc(c.id) : ''}" novalidate>
    <h2>${c ? 'Modifier la catégorie' : 'Nouvelle catégorie'}</h2>
    <div class="mini" style="font-size:13px">${esc(accName(acc))}</div>
    <div class="field"><label for="cN">Nom</label><input id="cN" value="${c ? esc(leafOf(c.nom)) : ''}" placeholder="Ex. Garage" autocomplete="off"></div>
    ${(() => { const kids = c && catsOf(acc).some(x => x.nom.startsWith(c.nom + SEP)), tops = catsOf(acc).filter(x => !x.nom.includes(SEP) && (!c || x.id !== c.id) && !isIncomeCat(x.nom));
      return kids ? `<div class="hint">Catégorie principale : ses sous-catégories sont ${catsOf(acc).filter(x => x.nom.startsWith(c.nom + SEP)).map(x => esc(leafOf(x.nom))).join(', ')}.</div>`
        : `<div class="field"><label for="cP">Ranger dans</label><select id="cP"><option value="">— Catégorie principale —</option>${tops.map(x => `<option ${c && topOf(c.nom) === x.nom && c.nom.includes(SEP) ? 'selected' : ''}>${esc(x.nom)}</option>`).join('')}</select>
        <div class="hint">Ex. ranger Carburant, Garage et Péage dans Véhicule : le Bilan et l'onglet Mois pourront montrer Véhicule en entier ou dans le détail.</div></div>`; })()}
    <div class="field"><label for="cB">Enveloppe mensuelle (€, optionnel)</label><input id="cB" inputmode="decimal" value="${c ? fr(c.budget) : ''}" placeholder="Vide = pas d'enveloppe"></div>
    ${isShared(acc) ? `<div class="note">Compte partagé : la catégorie est la même pour ${esc(otherNames())}.</div>` : ''}
    <div class="actions">${c ? `<button type="button" class="btn danger" data-catdel="${esc(c.id)}">Supprimer</button>` : ''}<button class="btn" type="submit">Enregistrer</button></div>
    <div id="confirmBox"></div></form>`);
}
function simOps(o) { if (!o.ref) return []; const k = keyOf(o.libelle), pos = (num(o.montant) || 0) > 0; return DB.operations.filter(x => x.compte === o.compte && x.ref && x.id !== o.id && keyOf(x.libelle) === k && ((num(x.montant) || 0) > 0) === pos); }
function opSheet(o) {
  const acc = o.compte, isVir = o.type === 'vir', isAdj = o.type === 'ajust', amt = num(o.montant) || 0, imp = !!o.ref, sim = simOps(o);
  const cats = catsOf(acc).map(c => c.nom); if (o.categorie && !cats.includes(o.categorie) && !isVir && !isAdj) cats.push(o.categorie);
  const kind = o.type === 'exc' || o.type === 'int' ? o.type : 'ponct';
  openSheet(`<form class="form" id="opForm" data-id="${esc(o.id)}" novalidate>
    <h2>${isAdj ? 'Correction de solde' : isVir ? 'Virement entre comptes' : amt < 0 ? 'Dépense' : 'Rentrée'}</h2>
    <div class="mini" style="font-size:13px">${esc(accName(acc))}${o.profil ? ' · ' + (imp ? 'importé par ' : 'saisi par ') + esc(pname(o.profil)) : ''}</div>
    ${imp ? `<div class="raw">Relevé : ${esc(o.libelle)}</div>` : ''}
    <div class="amountbox"><input id="oA" inputmode="decimal" value="${fr(r2(Math.abs(amt)))}" aria-label="Montant"><span>€</span></div>
    ${isAdj ? `<div class="note">${amt >= 0 ? 'Ajout' : 'Retrait'} de ${eur(Math.abs(amt))} pour recaler le solde sur la banque.</div>` : ''}
    <div class="field"><label for="oL">${imp ? 'Nom' + (sim.length ? ` (pour les ${sim.length + 1} opérations de ce marchand)` : '') : 'Libellé'}</label><input id="oL" value="${esc(nameOf(o))}" autocomplete="off"></div>
    ${!isVir && !isAdj ? `<div class="field"><label for="oC">Catégorie</label><select id="oC" data-ocat="1"><option value="" ${o.categorie ? '' : 'selected'}>À classer</option>${cats.map(c => `<option ${c === o.categorie ? 'selected' : ''}>${esc(c)}</option>`).join('')}<option value="__new">＋ Nouvelle catégorie…</option></select>
      <input id="oCnew" placeholder="Ex. Véhicule > Garage (sous-catégorie) ou Animaux" autocomplete="off" hidden style="margin-top:6px"></div>
      ${sim.length ? `<label class="switch" for="oSim" style="gap:10px"><span style="font-size:14px">Appliquer la catégorie aux <b>${sim.length}</b> autre${sim.length > 1 ? 's' : ''} opération${sim.length > 1 ? 's' : ''} de ce marchand, et aux prochains imports</span><input type="checkbox" id="oSim" checked></label>` : ''}
      ${imp ? `<button type="button" class="btn ghost small" data-seuil2="${esc(o.id)}" style="margin-top:2px">${seuilRule(acc, o.libelle) ? 'Modifier la séparation par montant' : 'Ce marchand a deux usages différents (ex. courses et carburant) : séparer par le montant'}</button>` : ''}
      <div class="field"><label>Compter comme</label><div class="seg" style="grid-template-columns:1fr 1fr 1fr" role="group" aria-label="Type">${[['ponct', 'Normal'], ['exc', 'Exceptionnel'], ['int', 'Entre mes comptes']].map(([k, l]) => `<button type="button" data-okind="${k}" aria-pressed="${kind === k}">${l}</button>`).join('')}</div>
      <div class="hint" id="kindHint">${kind === 'exc' ? 'Compté dans le solde, pas dans les habitudes ni les prévisions.' : kind === 'int' ? 'Épargne, livret, autre compte à toi : ni dépense ni revenu.' : 'Dépense ou rentrée courante : entre dans les habitudes.'}</div></div>` : ''}
    <div class="field"><label for="oD">Date</label><input id="oD" type="date" value="${esc(o.date)}"></div>
    ${!isVir && !isAdj ? `<button type="button" class="btn ghost" data-tofix="${esc(o.id)}">↻ C'est une charge ${amt > 0 ? 'ou une rentrée ' : ''}régulière : passer en fixe</button>` : ''}
    <div class="actions"><button type="button" class="btn danger" data-odel="${esc(o.id)}">Supprimer</button><button class="btn" type="submit">Enregistrer</button></div>
    <div id="confirmBox"></div></form>`);
}
// Séparer un même libellé bancaire en deux catégories selon le montant (ex. MAGASIN U : courses ou carburant)
function seuilSheet(o) {
  const acc = o.compte, key = keyOf(o.libelle), cur = seuilRule(acc, o.libelle), cats = catsOf(acc).map(c => c.nom);
  const v = cur || { s: Math.round(Math.abs(num(o.montant) || 0)), bas: '', haut: o.categorie || '' };
  openSheet(`<form class="form" id="seuilForm" data-acc="${esc(acc)}" data-key="${esc(key)}" novalidate>
    <h2>Séparer « ${esc(nameOf(o))} » par le montant</h2>
    <div class="hint">Utile quand la banque donne le même libellé à deux usages différents (ex. « MAGASIN U » pour les courses et le carburant). En dessous ou égal au seuil : une catégorie ; au-dessus : l'autre. S'applique tout de suite aux opérations déjà importées de ce marchand sur ce compte, et aux prochaines (import comme banque).</div>
    <div class="field"><label for="seS">Seuil (€)</label><input id="seS" inputmode="decimal" value="${fr(v.s)}"></div>
    <div class="two"><div class="field"><label for="seBas">Montant ≤ seuil</label><input id="seBas" list="seCl" value="${esc(v.bas)}" placeholder="Ex. Courses" autocomplete="off"></div>
    <div class="field"><label for="seHaut">Montant &gt; seuil</label><input id="seHaut" list="seCl" value="${esc(v.haut)}" placeholder="Ex. Carburant" autocomplete="off"></div></div>
    <datalist id="seCl">${cats.map(c => `<option value="${esc(c)}">`).join('')}</datalist>
    <div class="actions">${cur ? `<button type="button" class="btn danger" data-seuildel="${esc(acc)}|${esc(key)}">Ne plus séparer</button>` : ''}<button class="btn" type="submit">Enregistrer</button></div>
    <div id="confirmBox"></div></form>`);
}
function balSheet() {
  const r = curMonth(UI.acc);
  openSheet(`<form class="form" id="balForm" novalidate><h2>Corriger le solde</h2>
    <div class="note">Le 31 calcule <b>${eur(r.bal)}</b> aujourd'hui. Indique le solde affiché par la banque : l'écart est enregistré comme correction et toutes les prévisions repartent de là.</div>
    <div class="amountbox"><input id="realBal" inputmode="decimal" placeholder="${fr(r2(r.bal))}" aria-label="Solde réel" autocomplete="off"><span>€</span></div>
    <div class="hint">Avant de corriger, pointe les prélèvements passés : un écart vient souvent d'une dépense oubliée.</div>
    <button class="btn" type="submit">Recaler</button></form>`);
}
function closeMonthSheet(k) {
  const acc = UI.acc, r = calc(acc, k, startOf(acc, k));
  const rows = r.cats.filter(c => c.budget || c.spent).map(c => { const d = c.budget ? c.spent - c.budget : null; return `<div class="habit"><b>${esc(c.nom)}</b><span>${c.budget ? 'budget ' + eur0(c.budget) : '—'}</span><span style="font-weight:700;color:var(--${d > 0 ? 'bad' : 'ink'})">${eur0(c.spent)}</span></div>`; }).join('');
  openSheet(`<form class="form" id="closeForm" data-k="${k}" novalidate><h2>Clôturer ${mLabel(k)}</h2>
    ${rows ? `<div class="list">${rows}</div>` : ''}
    <div class="kv"><div><small>Solde calculé au ${r.D} ${MONTHS[pm(k).m]}</small><b>${eur(r.end)}</b></div><div><small>Rentrées / sorties</small><b>${eur0(r.rev)} / ${eur0(r.chg + r.vari)}</b></div></div>
    <div class="field"><label for="clReal">Solde réel du relevé au ${r.D} (si différent)</label><input id="clReal" inputmode="decimal" placeholder="Laisser vide si juste" autocomplete="off"></div>
    <div class="note">Le mois est archivé : son solde de fin sert de départ au mois suivant et ses dépenses alimentent les habitudes.</div>
    <button class="btn" type="submit">Clôturer et reporter</button></form>`);
}
function copyText(txt, el) {
  const done = () => toast('Copié');
  const fallback = () => { if (el) { el.focus(); el.select(); el.setSelectionRange && el.setSelectionRange(0, 99999); } try { document.execCommand('copy'); done(); } catch (e) { toast('Sélectionne le texte et copie-le'); } };
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(txt).then(done, fallback); else fallback();
}
let toastT;
function toast(t) { document.querySelectorAll('.toast').forEach(x => x.remove()); const d = document.createElement('div'); d.className = 'toast'; d.textContent = t; document.body.appendChild(d); clearTimeout(toastT); toastT = setTimeout(() => d.remove(), 2600); }

/* ================= Thème ================= */
function applyTheme() {
  const r = document.documentElement;
  if (UI.theme === 'auto') r.removeAttribute('data-theme'); else r.setAttribute('data-theme', UI.theme);
  store.set('le31-theme', UI.theme);
  const dark = UI.theme === 'dark' || (UI.theme === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  const m = $('themeColor'); if (m) m.setAttribute('content', dark ? '#0D1120' : '#EDF0F6');
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { applyTheme(); if (UI.tab === 'set') render(); });

/* ================= Événements ================= */
document.addEventListener('click', ev => {
  const bm = ev.target.closest && ev.target.closest('[data-bm]'); if (bm) { BIL.sel = BIL.sel === bm.dataset.bm ? null : bm.dataset.bm; render(); return; }
  const t = ev.target.closest('button,.sheet-bg,input[type=checkbox]'); if (!t) return;
  if (t.classList.contains('sheet-bg')) { if (ev.target === t) closeSheet(); return; }
  const ds = t.dataset;
  if (ds.retry) { pull(); return; }
  if (ds.acc) { UI.acc = ds.acc; store.set('le31-compte', UI.acc); render(); return; }
  if (ds.tab) { UI.tab = ds.tab; render(); scrollTo(0, 0); return; }
  if (ds.go) { UI.tab = ds.go; render(); scrollTo(0, 0); return; }
  if (ds.ftab) { UI.foreTab = ds.ftab; render(); return; }
  if (ds.mode) { UI.mode = ds.mode; render(); return; }
  if (ds.h) { UI.horizon = +ds.h; render(); return; }
  if (ds.fid) { const f = DB.fixes.find(x => x.id === ds.fid); if (f) fixedSheet(f, 'fix'); return; }
  if (ds.vid) { const v = DB.virements.find(x => x.id === ds.vid); if (v) fixedSheet(v, 'vir'); return; }
  if (ds.oid) { const o = DB.operations.find(x => x.id === ds.oid); if (o) opSheet(o); return; }
  if (ds.newfixed) { sheetRoot.dataset.sens = '-'; fixedSheet(null, 'fix'); return; }
  if (ds.fkind) { if (ds.fkind === 'vir') fixedSheet(null, 'vir'); else { sheetRoot.dataset.sens = ds.fkind; fixedSheet(null, 'fix'); } return; }
  if (ds.sens) { draft.sens = ds.sens; const a = $('amt') && $('amt').value, l = $('lb') && $('lb').value, d = $('dt') && $('dt').value; render(); if (a) $('amt').value = a; if (l) $('lb').value = l; if (d) $('dt').value = d; return; }
  if (ds.cat) { draft.cat = ds.cat; t.parentNode.querySelectorAll('[data-cat]').forEach(b => b.setAttribute('aria-pressed', b === t)); return; }
  if (ds.newcat) { catSheet(ds.newcat, null); return; }
  if (ds.editcat) { const c = DB.categories.find(x => x.id === ds.editcat); if (c) catSheet(c.compte, c); return; }
  if (ds.simtog) { const s = DB.simulations.find(x => x.id === ds.simtog); if (s) commit([upd('Simulations', { id: s.id, actif: t.checked ? 'oui' : 'non' })]); return; }
  if (ds.simdel) { commit([del('Simulations', ds.simdel)]); toast('Simulation retirée'); return; }
  if (ds.recon) {
    const v = num($('rc-' + ds.recon).value); if (v === null || v < 0) { toast('Montant invalide'); return; }
    const id = CUR + '|' + ds.recon;
    commit([upd('Pointages', { id, compte: UI.acc, mois: CUR, cle: ds.recon, montantReel: r2(v) })]); toast('Pointé : la prévision passe en réel'); return;
  }
  if (ds.unpoint) { commit([del('Pointages', ds.unpoint)]); closeSheet(); toast('Pointage annulé'); return; }
  if (ds.fixbal) { balSheet(); return; }
  if (ds.closeMonth) { closeMonthSheet(ds.closeMonth); return; }
  if (ds.taxmode) { commit([upd('Parametres', { cle: 'impMode', valeur: ds.taxmode })]); return; }
  if (ds.syncnow) { QUEUE.length ? flush() : pull(); toast('Synchronisation lancée'); return; }
  if (ds.iosok) { JOIN.iosOk = true; join(); return; }
  if (ds.joinretry) { JOIN.err = ''; join(); return; }
  if (ds.onbmode) { ONB.mode = ds.onbmode; render(); return; }
  if (ds.onbstep) {
    const P = $('onbP'); if (P) ONB.partner = P.value.trim();
    if (ds.onbstep === '2' && (!ONB.mode || (ONB.mode === 'duo' && !ONB.partner))) { toast(ONB.mode ? 'Indique le prénom de ton/ta partenaire' : 'Choisis seul ou à deux'); return; }
    ONB.step = +ds.onbstep; render(); return;
  }
  if (ds.onbdone) { finishOnboard(); return; }
  if (ds.impstep) {
    if (ds.impstep === 'go') { commitImport(); return; }
    IMP.step = ds.impstep; render(); scrollTo(0, 0); return;
  }
  if (ds.impclose) { UI.imp = null; IMP = null; UI.tab = 'home'; if (BK.queue.length) { const q = BK.queue.shift(); UI.acc = q.acc; startImport(q.parsed, q.mode, { acc: q.acc }); return; } render(); scrollTo(0, 0); return; }
  if (ds.bklink) { BK.view = 'bank'; BK.acc = ds.bklink; BK.q = ''; BK.list = BK.list || null; render(); scrollTo(0, 0); if (!BK.list) api({ action: 'banques' }).then(j => { BK.list = j.banques; render(); }).catch(e => { toast('Banque : ' + e.message); BK.view = null; render(); }); return; }
  if (ds.bkbank) { bankStart(BK.acc, ds.bkbank); return; }
  if (ds.bkrenew) { const r = bkRow(ds.bkrenew); if (r) bankStart(ds.bkrenew, r.aspsp); return; }
  if (ds.bkunlink) { $('main').querySelector(`[data-bkunlink="${ds.bkunlink}"]`).outerHTML = `<button class="btn danger small" data-bkunlinkok="${esc(ds.bkunlink)}">Confirmer</button>`; return; }
  if (ds.bkunlinkok) { bankUnlink(ds.bkunlinkok); return; }
  if (ds.bksync) { bankSync({ force: true }); return; }
  if (ds.bkok) { BK.res = null; render(); return; }
  if (ds.bkvoir) { BK.res = null; P.f = 'nc'; P.k = CUR; P.q = ''; UI.tab = 'ponct'; render(); scrollTo(0, 0); return; }
  if (ds.bkclose) { BK.view = null; BK.msg = ''; if (bkPend()) { BK.view = null; bankLinkCancel(); } render(); return; }
  if (ds.bklier) { bankLink(); return; }
  if (ds.impmode) {
    if (ds.impmode === 'reset') { $('main').querySelector('[data-impmode=reset]').outerHTML = `<div class="note bad" style="display:flex;flex-direction:column;gap:10px"><span>Tout effacer sur <b>${esc(accName(IMP.acc))}</b> et repartir de ce relevé ?${isShared(IMP.acc) ? ` C'est aussi effacé pour ${esc(otherNames())}.` : ''}</span><button class="btn danger" data-impmode="resetok">Oui, tout refaire</button></div>`; return; }
    startImport(IMP.parsed, ds.impmode === 'resetok' ? 'reset' : 'add'); return;
  }
  if (ds.rkeep) { IMP.keep[ds.rkeep] = ds.v === '1'; render(); return; }
  if (ds.bigk) { IMP.kind[ds.bigk] = ds.k; t.parentNode.querySelectorAll('[data-bigk]').forEach(b => b.setAttribute('aria-pressed', b === t)); return; }
  if (ds.gnewok) { const n = normCat($('newCatIn').value); if (!n) { toast('Donne un nom'); return; } if (!IMP.newCats.includes(n)) IMP.newCats.push(n); IMP.gcat[ds.gnewok] = n; IMP.gtouch[ds.gnewok] = 1; IMP.creating = null; render(); toast(`Catégorie « ${n} » créée`); return; }
  if (ds.gmore) { IMP.gshow += 30; render(); return; }
  if (ds.noreimp) { store.set('le31-noreimp|' + ds.noreimp, true); render(); return; }
  if (ds.dupfix) {
    const f = DB.fixes.find(x => x.id === ds.dupfix); if (!f) return;
    const ops = [del('Fixes', f.id)];
    DB.pointages.filter(p => p.cle === 'f' + f.id).forEach(p => { ops.push(del('Pointages', p.id)); if (!point(p.mois, 'v' + ds.dupvir)) ops.push(upd('Pointages', { id: p.mois + '|v' + ds.dupvir, compte: p.compte, mois: p.mois, cle: 'v' + ds.dupvir, montantReel: p.montantReel })); });
    commit(ops); toast('Doublon supprimé : compté une seule fois'); return;
  }
  if ('bcat' in ds) { bilToggle(UI.acc, ds.bcat); return; }
  if (ds.bdet) { bilDetail(UI.acc, ds.bdet); return; }
  if (ds.bn) { BIL.n = +ds.bn; store.set('le31-bil-n', BIL.n); render(); return; }
  if (ds.bmode) { BIL.mode = ds.bmode; store.set('le31-bil-mode', BIL.mode); render(); return; }
  if (ds.tofix) { const o = DB.operations.find(x => x.id === ds.tofix); if (o) { closeSheet(); fixFromOp(o); } return; }
  if (ds.seuil2) { const o = DB.operations.find(x => x.id === ds.seuil2); if (o) seuilSheet(o); return; }
  if (ds.seuildel) { const i = ds.seuildel.indexOf('|'), acc = ds.seuildel.slice(0, i), key = ds.seuildel.slice(i + 1); commit([upd('Parametres', { cle: 'seuilCat|' + acc + '|' + key, valeur: '' })]); closeSheet(); toast('Ce marchand n\'est plus séparé par le montant'); return; }
  if (ds.payauto) { commit([upd('Parametres', { cle: 'payeFin|' + ds.payauto, valeur: '' })]); toast('Date de fin recalculée automatiquement'); return; }
  if (ds.pview) { P.view = ds.pview; store.set('le31-pview', P.view); render(); return; }
  if (ds.pm) { P.k = addM(P.k || CUR, +ds.pm); render(); return; }
  if (ds.pf) { P.f = ds.pf; render(); return; }
  if ('pcat' in ds) { P.f = 'cat'; P.cat = ds.pcat; P.k = CUR; P.q = ''; UI.tab = 'ponct'; render(); scrollTo(0, 0); return; }
  if (ds.okind) { t.parentNode.querySelectorAll('[data-okind]').forEach(b => b.setAttribute('aria-pressed', b === t)); const h = $('kindHint'); if (h) h.textContent = ds.okind === 'exc' ? 'Compté dans le solde, pas dans les habitudes ni les prévisions.' : ds.okind === 'int' ? 'Épargne, livret, autre compte à toi : ni dépense ni revenu.' : 'Dépense ou rentrée courante : entre dans les habitudes.'; return; }
  if (ds.rvir) { IMP.virOn[ds.rvir] = t.checked; return; }
  if (ds.recal) { IMP.recal = t.checked; return; }
  if (ds.ucat) { IMP.ucat[ds.ucat] = ds.c; render(); return; }
  if (ds.invite) { invite(ds.invite); return; }
  if (ds.cut || ds.cutall) {
    openSheet(`<div class="form"><h2>Couper ${ds.cut ? 'cet appareil' : 'tous les accès'} de ${esc(ds.cutname)} ?</h2>
      <div class="note warn">${ds.cut ? "Cet appareil ne pourra plus rien voir ni saisir, tout de suite." : 'Tous ses appareils seront déconnectés et ses liens en attente annulés.'} Les données restent intactes. Envoie ensuite un nouveau lien à ${esc(ds.cutname)} pour son nouvel appareil.</div>
      <div class="actions"><button class="btn ghost" data-closebtn="1">Annuler</button><button class="btn danger" data-cutok="${esc(ds.cut || '')}" data-cutprof="${esc(ds.cutall || '')}">Couper l'accès</button></div></div>`);
    return;
  }
  if ('cutok' in ds) { cutAccess(ds.cutok ? { acces: ds.cutok } : { profil: ds.cutprof }, 'Accès coupé'); return; }
  if (ds.closebtn) { closeSheet(); return; }
  if (ds.copyshare) { const tx = $('shareTxt'); copyText(tx.value, tx); return; }
  if (ds.doshare) {
    const tx = $('shareTxt').value;
    if (navigator.share) navigator.share({ text: tx }).then(() => { closeSheet(); toast('Lien partagé'); }).catch(() => {});
    else copyText(tx, $('shareTxt'));
    return;
  }
  if (ds.del) { $('confirmBox').innerHTML = `<div class="alert bad" style="display:flex;justify-content:space-between;align-items:center;gap:8px">Supprimer définitivement ? L'historique des mois passés sera recalculé sans elle${DB.profils.length > 1 ? ', pour tout le monde' : ''}.<button type="button" class="btn danger small" data-delok="${esc(ds.del)}">Supprimer</button></div>`; return; }
  if (ds.delok) {
    const [k, id] = ds.delok.split(':'), cle = (k === 'vir' ? 'v' : 'f') + id;
    const ops = [del(k === 'vir' ? 'Virements' : 'Fixes', id)].concat(DB.pointages.filter(p => p.cle === cle).map(p => del('Pointages', p.id)));
    commit(ops); closeSheet(); toast('Opération supprimée'); return;
  }
  if (ds.odel) { $('confirmBox').innerHTML = `<div class="alert bad" style="display:flex;justify-content:space-between;align-items:center;gap:8px">Supprimer cette saisie ?<button type="button" class="btn danger small" data-odelok="${esc(ds.odel)}">Supprimer</button></div>`; return; }
  if (ds.odelok) {
    const o = DB.operations.find(x => x.id === ds.odelok); if (!o) { closeSheet(); return; }
    const ops = [del('Operations', o.id)]; if (o.type === 'vir' && o.lien) DB.operations.filter(x => x.lien === o.lien && x.id !== o.id).forEach(x => ops.push(del('Operations', x.id)));
    commit(ops); closeSheet(); toast(o.type === 'vir' ? 'Virement supprimé des deux comptes' : 'Saisie supprimée'); return;
  }
  if (ds.catdel) { $('confirmBox').innerHTML = `<div class="alert bad" style="display:flex;justify-content:space-between;align-items:center;gap:8px">Les saisies existantes gardent leur catégorie.<button type="button" class="btn danger small" data-catdelok="${esc(ds.catdel)}">Supprimer</button></div>`; return; }
  if (ds.catdelok) { commit([del('Categories', ds.catdelok)]); closeSheet(); toast('Catégorie supprimée'); return; }
});
const refocus = id => { const e = $(id); if (e) { e.focus(); const n = e.value.length; try { e.setSelectionRange(n, n); } catch (x) {} } };
let qT;
document.addEventListener('input', ev => {
  if (ev.target.id === 'taxdelta') { TAX_DELTA = +ev.target.value; render(); const e = $('taxdelta'); if (e) e.focus(); }
  if (ev.target.id === 'bkQ') { BK.q = ev.target.value; clearTimeout(qT); qT = setTimeout(() => { render(); refocus('bkQ'); }, 200); return; }
  if (ev.target.id === 'dayV') { UI.dayV = +ev.target.value; render(); const e = $('dayV'); if (e) e.focus(); return; }
  if (ev.target.id === 'pQ') { P.q = ev.target.value; clearTimeout(qT); qT = setTimeout(() => { render(); refocus('pQ'); }, 250); }
  if (ev.target.id === 'impQ') { IMP.q = ev.target.value; IMP.gshow = 30; clearTimeout(qT); qT = setTimeout(() => { render(); refocus('impQ'); }, 250); }
});
document.addEventListener('change', ev => {
  const el = ev.target, ds = el.dataset;
  if (ds.themeAuto) { UI.theme = el.checked ? 'auto' : (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'); applyTheme(); render(); return; }
  if (ds.themeDark) { UI.theme = el.checked ? 'dark' : 'light'; applyTheme(); render(); return; }
  if (ds.accname) { const v = el.value.trim(); if (v) { commit([upd('Comptes', { id: ds.accname, nom: v })]); toast(isShared(ds.accname) ? 'Compte renommé pour tout le monde' : 'Compte renommé'); } return; }
  if (el.id === 'impFile' && el.files && el.files[0]) {
    const box = $('impErr'); if (box) box.innerHTML = '<div class="hint">Lecture du fichier…</div>';
    readImportFile(el.files[0]).then(p => startImport(p)).catch(e => { const b = $('impErr'); if (b) b.innerHTML = `<div class="note bad">Fichier non reconnu : ${esc(e.message)}. Choisis un export CSV ou OFX de ta banque (pas un PDF).</div>`; });
    return;
  }
  if (ds.rname) { const r = IMP && IMP.recur.find(x => x.id === ds.rname); if (r && el.value.trim()) r.nom = el.value.trim(); return; }
  if (ds.gname) { const v = el.value.trim(); if (v) { IMP.gname[ds.gname] = v; IMP.gtouch[ds.gname] = 1; } return; }
  if (ds.gcat) { if (el.value === '__new') { IMP.creating = ds.gcat; render(); refocus('newCatIn'); return; } IMP.gcat[ds.gcat] = el.value; IMP.gtouch[ds.gcat] = 1; el.classList.toggle('todo', !el.value); return; }
  if (ds.ocat) { const n = $('oCnew'); if (n) { n.hidden = el.value !== '__new'; if (!n.hidden) n.focus(); } return; }
  if (ds.vto) { draft.to = el.value; render(); return; }
  if (el.id === 'onbC') { ONB.commun = el.checked; return; }
  if (ds.bksel) { BK.sel[ds.bksel] = el.value; render(); return; }
  if (ds.bkmode) { BK.mode[ds.bkmode] = el.value; return; }
  if (el.id === 'bkAuto') { BK.auto = el.checked; store.set('le31-bk-auto', BK.auto); return; }
  if (el.id === 'habOn') { UI.hab = el.checked; store.set('le31-hab', UI.hab); render(); return; }
  if (el.id === 'bExc') { BIL.exc = el.checked; render(); return; }
  if (ds.open) { const v = num(el.value); if (el.value.trim() === '' || v !== null) { commit([upd('Comptes', { id: ds.open, soldeDepart: v === null ? '' : r2(v), moisDepart: startMonth(ds.open) })]); toast('Solde de départ mis à jour'); } else toast('Montant invalide'); return; }
  if (ds.seuil) { const v = num(el.value); if (v !== null) { commit([upd('Comptes', { id: ds.seuil, seuil: r2(v) })]); toast('Seuil mis à jour'); } return; }
  if (ds.mdep) { const v = el.value; if (/^\d{4}-\d{2}$/.test(v) && v <= CUR) { commit([upd('Comptes', { id: ds.mdep, moisDepart: v })]); toast('Mois de départ mis à jour'); } else toast('Choisis un mois passé ou le mois en cours'); return; }
  if (ds.prof) { const v = el.value.trim(); if (v) { commit([upd('Profils', { id: ds.prof, nom: v })]); toast(DB.profils.length > 1 ? 'Prénom changé pour tout le monde' : 'Prénom changé'); } return; }
  if (ds.tax) { const v = ds.tax === 'impAutresAb' ? el.value : num(el.value); if (v !== null && v !== '') commit([upd('Parametres', { cle: ds.tax, valeur: v })]); return; }
  if (ds.payon) { commit([upd('Parametres', { cle: 'payeOn|' + ds.payon, valeur: el.checked ? 'oui' : 'non' })]); render(); return; }
  if (ds.payfixe) { commit([upd('Parametres', { cle: 'payeFixe|' + ds.payfixe, valeur: el.value })]); render(); return; }
  if (ds.payend) { const v = el.value; if (/^\d{4}-\d{2}-\d{2}$/.test(v)) { commit([upd('Parametres', { cle: 'payeFin|' + ds.payend, valeur: v })]); toast('Date de fin de la période mise à jour'); } return; }
});
document.addEventListener('submit', ev => {
  ev.preventDefault(); const f = ev.target;
  if (f.id === 'keyForm') {
    if (!readLink($('keyIn').value.trim())) { toast("Lien non reconnu : il doit contenir #inv="); return; }
    if (!apiOk()) { toast("Le lien ne contient pas l'adresse du serveur : refais-le"); return; }
    JOIN.iosOk = true; JOIN.err = ''; SYNC.error = ''; join(); return;
  }
  if (f.id === 'onbName') {
    const n = $('onbN').value.trim(); if (!n) { toast('Indique ton prénom'); return; }
    ONB.name = n; ONB.step = 1; render(); return;
  }
  if (f.id === 'startForm') {
    const v = num($('startBal').value); if (v === null) { toast('Indique le solde'); return; }
    const sofar = calc(UI.acc, CUR, 0).bal; // opérations déjà passées ce mois-ci
    commit([upd('Comptes', { id: UI.acc, soldeDepart: r2(v - sofar), moisDepart: CUR })]); toast('C\'est parti !'); return;
  }
  if (f.id === 'addForm') {
    const a = num($('amt').value), dt = $('dt').value;
    if (!a || a <= 0) { toast('Indique un montant'); return; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dt)) { toast('Indique une date'); return; }
    const who = ME || '', acc = UI.acc;
    if (draft.sens === 'v') {
      const oth = draft.to || otherAcc(acc), lien = uid(), lb = $('lb').value.trim() || 'Virement';
      commit([upd('Operations', { id: uid(), compte: acc, date: dt, montant: r2(-a), categorie: 'Virement', libelle: lb, profil: who, type: 'vir', lien }),
              upd('Operations', { id: uid(), compte: oth, date: dt, montant: r2(a), categorie: 'Virement', libelle: lb, profil: who, type: 'vir', lien })]);
      toast(`Virement de ${eur(a)} vers ${accName(oth)} enregistré`);
      draft.sens = '-';
    } else {
      if (!draft.cat) { toast('Crée d\'abord une catégorie'); return; }
      const lb = $('lb').value.trim() || draft.cat;
      commit([upd('Operations', { id: uid(), compte: acc, date: dt, montant: r2(draft.sens === '-' ? -a : a), categorie: draft.cat, libelle: lb, profil: who, type: $('addExc') && $('addExc').checked ? 'exc' : 'ponct', lien: '' })]);
      toast(`${draft.sens === '-' ? 'Dépense' : 'Rentrée'} ${dt.slice(0, 7) > CUR ? 'prévue' : 'ajoutée'} : ${lb} ${eur(a)}`);
    }
    UI.tab = dt.slice(0, 7) > CUR ? 'fore' : 'home'; UI.foreTab = 'budget'; render(); scrollTo(0, 0); return;
  }
  if (f.id === 'fixForm') {
    const id = f.dataset.id || uid(), kind = f.dataset.kind, isNew = !f.dataset.id;
    const libelle = $('fL').value.trim(), montant = num($('fA').value);
    const jour = Math.min(31, Math.max(1, parseInt($('fD').value, 10) || 1)), actif = $('fOn').checked ? 'oui' : 'non';
    const debut = $('fB').value, fin = $('fE').value;
    if (!libelle || !montant || montant <= 0) { toast('Libellé et montant requis'); return; }
    if (fin && fin < debut) { toast('La dernière échéance est avant le début'); return; }
    if (kind === 'vir') {
      const [de, vers] = $('fDir').value.split('>');
      commit([upd('Virements', { id, de, vers, libelle, montant: r2(montant), jour, profil: $('fW') ? $('fW').value : '', debut, fin, actif })]);
      toast(isNew ? 'Virement lié créé sur les deux comptes' : 'Virement mis à jour');
    } else {
      const sb = f.querySelector('[data-fkind][aria-pressed=true]');
      const row = { id, compte: isNew ? UI.acc : (DB.fixes.find(x => x.id === id) || {}).compte || UI.acc, libelle, montant: r2(montant), jour, frequence: $('fF').value, moisRef: $('fS').value, categorie: $('fC').value.trim() || 'Autre', debut, fin, actif };
      if (isNew) row.sens = sb ? sb.dataset.fkind : (sheetRoot.dataset.sens || '-');
      const fo = f.dataset.fromop && DB.operations.find(x => x.id === f.dataset.fromop), ops = [];
      if (fo) {
        row.compte = fo.compte; row.motif = keyOf(fo.libelle); row.sens = (num(fo.montant) || 0) > 0 ? '+' : '-';
        const pts = {};
        [fo].concat(simOps(fo)).filter(x => String(x.date).slice(0, 7) >= debut && (!fin || String(x.date).slice(0, 7) <= fin)).forEach(x => {
          const k = String(x.date).slice(0, 7), pid = k + '|f' + id; ops.push(del('Operations', x.id));
          pts[pid] = pts[pid] || { id: pid, compte: fo.compte, mois: k, cle: 'f' + id, montantReel: 0 }; pts[pid].montantReel = r2(pts[pid].montantReel + Math.abs(num(x.montant) || 0));
        });
        Object.values(pts).forEach(x => ops.push(upd('Pointages', x)));
        commit([upd('Fixes', row)].concat(ops)); toast(`Charge fixe créée : ${Object.keys(pts).length} mois pointés`);
      } else { commit([upd('Fixes', row)]); toast('Charges recalculées'); }
    }
    closeSheet(); return;
  }
  if (f.id === 'catForm') {
    const acc = f.dataset.acc, id = f.dataset.id, leaf = $('cN').value.trim(), b = num($('cB').value), par = $('cP') ? $('cP').value : '';
    if (!leaf) { toast('Donne un nom'); return; }
    if (/›|>|\//.test(leaf)) { toast('Pour une sous-catégorie, choisis « Ranger dans »'); return; }
    const cur0 = id && DB.categories.find(c => c.id === id), nom = par ? par + SEP + leaf : (cur0 && cur0.nom.includes(SEP) && !$('cP') ? topOf(cur0.nom) + SEP + leaf : leaf);
    if (catsOf(acc).some(c => c.nom.toLowerCase() === nom.toLowerCase() && c.id !== id)) { toast('Cette catégorie existe déjà'); return; }
    if (!id) {
      const ordre = Math.max(0, ...DB.categories.map(c => num(c.ordre) || 0)) + 1;
      commit([upd('Categories', { id: uid(), compte: acc, nom, budget: b > 0 ? r2(b) : '', ordre })]);
      if (UI.tab === 'add') draft.cat = nom;
    } else {
      const old = DB.categories.find(c => c.id === id), ops = [upd('Categories', { id, nom, budget: b > 0 ? r2(b) : '' })];
      if (old && old.nom !== nom) { // renommée ou rangée ailleurs : sous-catégories, opérations, charges fixes et règles suivent
        const mv = n => n === old.nom ? nom : String(n || '').startsWith(old.nom + SEP) ? nom + n.slice(old.nom.length) : null;
        DB.categories.filter(c => c.compte === acc && c.id !== id && mv(c.nom)).forEach(c => ops.push(upd('Categories', { id: c.id, nom: mv(c.nom) })));
        DB.operations.filter(o => o.compte === acc && mv(o.categorie)).forEach(o => ops.push(upd('Operations', { id: o.id, categorie: mv(o.categorie) })));
        DB.fixes.filter(x => x.compte === acc && mv(x.categorie)).forEach(x => ops.push(upd('Fixes', { id: x.id, categorie: mv(x.categorie) })));
        DB.regles.filter(r => (r.compte === acc || !r.compte) && mv(r.categorie)).forEach(r => ops.push(upd('Regles', { id: r.id, categorie: mv(r.categorie) })));
      }
      commit(ops);
    }
    closeSheet(); toast('Catégorie enregistrée'); return;
  }
  if (f.id === 'opForm') {
    const o = DB.operations.find(x => x.id === f.dataset.id); if (!o) { closeSheet(); return; }
    const a = num($('oA').value), dt = $('oD').value; if (!a || a <= 0) { toast('Indique un montant'); return; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dt)) { toast('Indique une date'); return; }
    const neg = (num(o.montant) || 0) < 0, lb = $('oL').value.trim(), imp = !!o.ref, ops = [];
    let cat = $('oC') ? $('oC').value : o.categorie;
    if (cat === '__new') { cat = normCat($('oCnew').value); if (!cat) { toast('Donne un nom à la catégorie'); return; } }
    if (cat && !['Virement', 'Correction de solde'].includes(cat)) ops.push(...newCatOps(o.compte, cat));
    const kb = f.querySelector('[data-okind][aria-pressed=true]'), type = kb ? kb.dataset.okind : o.type;
    const row = { id: o.id, montant: r2(neg ? -a : a), date: dt, categorie: cat, type: o.type === 'vir' || o.type === 'ajust' ? o.type : type };
    if (!imp) row.libelle = lb;
    ops.push(upd('Operations', row));
    if (o.type === 'vir' && o.lien) DB.operations.filter(x => x.lien === o.lien && x.id !== o.id).forEach(x => ops.push(upd('Operations', { id: x.id, montant: r2(neg ? a : -a), date: dt, libelle: lb })));
    let n = 0;
    if (imp && o.type !== 'vir' && o.type !== 'ajust') {
      const sim = $('oSim') && $('oSim').checked, rf = {};
      if (lb && lb !== nameOf(o)) rf.nom = lb;
      if (sim || !simOps(o).length) { rf.categorie = cat; simOps(o).filter(x => isPonct(x) || x.type === 'exc' || x.type === 'int').forEach(x => { if ((x.categorie || '') !== cat) { ops.push(upd('Operations', { id: x.id, categorie: cat })); n++; } }); }
      if (type === 'int' || (o.type === 'int' && type !== 'int')) rf.type = type === 'int' ? 'int' : '';
      if (Object.keys(rf).length) ops.push(ruleOp(o.compte, sk(keyOf(o.libelle), num(o.montant)), rf));
    }
    commit(ops); closeSheet(); toast(n ? `Mis à jour, avec ${n} opération${n > 1 ? 's' : ''} du même marchand` : 'Opération mise à jour'); return;
  }
  if (f.id === 'seuilForm') {
    const acc = f.dataset.acc, key = f.dataset.key, s = num($('seS').value), bas = $('seBas').value.trim(), haut = $('seHaut').value.trim();
    if (s === null || s <= 0 || !bas || !haut) { toast('Indique un seuil et les deux catégories'); return; }
    const ops = [...newCatOps(acc, bas), ...newCatOps(acc, haut), upd('Parametres', { cle: 'seuilCat|' + acc + '|' + key, valeur: JSON.stringify({ s: r2(s), bas, haut }) })];
    DB.operations.filter(o => o.compte === acc && keyOf(o.libelle) === key && isPonct(o)).forEach(o => { const c = Math.abs(num(o.montant) || 0) > s ? haut : bas; if ((o.categorie || '') !== c) ops.push(upd('Operations', { id: o.id, categorie: c })); });
    commit(ops); closeSheet(); toast('Séparation enregistrée'); return;
  }
  if (f.id === 'balForm') {
    const v = num($('realBal').value); if (v === null) { toast('Indique le solde de la banque'); return; }
    const delta = r2(v - curMonth(UI.acc).bal);
    if (Math.abs(delta) >= 0.01) commit([upd('Operations', { id: uid(), compte: UI.acc, date: TODAY_ISO, montant: delta, categorie: 'Correction de solde', libelle: 'Correction de solde', profil: '', type: 'ajust', lien: '' })]);
    closeSheet(); toast(Math.abs(delta) >= 0.01 ? `Solde recalé (${sgn(delta)})` : 'Le solde était déjà juste'); render(); return;
  }
  if (f.id === 'closeForm') {
    const k = f.dataset.k, acc = UI.acc, comp = calc(acc, k, startOf(acc, k)).end, v = num($('clReal').value);
    commit([upd('Clotures', { id: acc + '|' + k, compte: acc, mois: k, soldeFin: r2(v === null ? comp : v), dateCloture: TODAY_ISO })]);
    closeSheet(); toast(`${mLabel(k)} clôturé : solde reporté`); return;
  }
  if (f.id === 'simForm') {
    const a = num($('simA').value); if (!a || a <= 0) { toast('Indique un montant'); return; }
    commit([upd('Simulations', { id: uid(), compte: UI.acc, libelle: $('simL').value.trim() || 'Achat', montant: r2(a), mois: $('simM').value, actif: 'oui' })]);
    toast('Simulation ajoutée'); return;
  }
  if (f.id === 'profForm') {
    const n = $('pfnew').value.trim(); if (!n) { toast('Indique un prénom'); return; }
    const id = 'p' + uid();
    commit([upd('Profils', { id, nom: n, perso: $('pfperso').checked ? 'oui' : 'non', ordre: Math.max(0, ...DB.profils.map(p => num(p.ordre) || 0)) + 1 })]);
    setTimeout(() => invite(id), 400); return;
  }
});

/* ================= Installation sur l'écran d'accueil ================= */
let installEvt = null;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvt = e; showInstall(); });
function showInstall() {
  if (matchMedia('(display-mode: standalone)').matches || navigator.standalone || store.get('le31-noinstall', false)) return;
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  if (!installEvt && !ios) return;
  if (document.querySelector('.install')) return;
  const b = document.createElement('div');
  b.className = 'banner install';
  b.style.cssText = 'position:fixed;left:12px;right:12px;bottom:calc(84px + env(safe-area-inset-bottom,0px));z-index:15;max-width:440px;margin:0 auto;box-shadow:0 6px 20px rgba(0,0,0,.18)';
  b.innerHTML = ios ? `<span>Pour installer : bouton <b>Partager</b> puis <b>Sur l'écran d'accueil</b>.</span><button class="btn ghost small" data-noinst="1">OK</button>`
    : `<span><b>Installer Le 31</b> sur ce téléphone</span><span style="display:flex;gap:6px"><button class="btn small" data-inst="1">Installer</button><button class="btn ghost small" data-noinst="1">Plus tard</button></span>`;
  document.body.appendChild(b);
  b.addEventListener('click', async e => {
    if (e.target.dataset.inst && installEvt) { installEvt.prompt(); await installEvt.userChoice; installEvt = null; b.remove(); }
    if (e.target.dataset.noinst) { store.set('le31-noinstall', true); b.remove(); }
  });
}
window.addEventListener('appinstalled', () => { const b = document.querySelector('.install'); if (b) b.remove(); });

/* ================= Démarrage ================= */
applyTheme();
rebuild();
const BKQ = new URLSearchParams(location.search);
if (BKQ.get('code') && BKQ.get('state')) { history.replaceState(null, '', location.pathname + location.hash); bankReturn(BKQ.get('code'), BKQ.get('state')); }
else if (BKQ.get('error')) { history.replaceState(null, '', location.pathname + location.hash); BK.view = 'retour'; BK.msg = 'Accord refusé ou annulé à la banque (' + BKQ.get('error') + ').'; }
document.getElementById('bankChip').addEventListener('click', () => { const r = bkRow(UI.acc); if (r && (bkDays(r) <= 7 || BK.err[UI.acc] === 'expire')) bankStart(UI.acc, r.aspsp); else bankSync({ force: true }); });
render();
if (INV() && apiOk()) join(); else { pull(); flush(); }
setTimeout(showInstall, 1500);
setInterval(() => { if (document.visibilityState === 'visible') { pull(); } }, 30000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { refreshNow(); pull(); flush(); } });
window.addEventListener('online', () => { flush(); pull(); });
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  const had = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register('sw.js').then(reg => { setInterval(() => reg.update(), 60 * 60 * 1000); }).catch(() => {});
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (had && !reloaded) { reloaded = true; location.reload(); } });
}
