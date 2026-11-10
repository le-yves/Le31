/* LE 31 — appli téléphone — V3.1.1 (V3.0 + évolution du salaire, épargne, mois par mois ; aucune donnée personnelle dans le code)
   Pilotage par cycles de paie : Perso du salaire à la veille du suivant, Commun de l'arrivée du virement de début de cycle
   à la veille du suivant. Opérations lues à la banque (Enable Banking), classées à la main le premier cycle (« À classer »),
   puis automatiquement quand c'est sûr. Données : Google Sheet via Google Apps Script (Code.gs 3.1). */
'use strict';
const APP_VERSION = '3.1.1';

/* ================= Outils ================= */
const MONTHS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];
const MONTHS_L = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
const MONTHS_C = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];
const FREQ = { M: 'Mensuel', T: 'Trimestriel', A: 'Annuel' };
const $ = id => document.getElementById(id);
const pad = n => String(n).padStart(2, '0');
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = v => { if (v === '' || v == null) return null; const n = parseFloat(String(v).replace(/\s/g, '').replace(',', '.')); return isNaN(n) ? null : n; };
const bool = v => v === true || /^(oui|true|vrai|1)$/i.test(String(v || '').trim());
const r2 = v => Math.round(v * 100) / 100;
const eur = v => (v || 0).toLocaleString('fr-FR', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2, maximumFractionDigits: 2 });
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
  const n = window.LE31_TODAY ? new Date(window.LE31_TODAY + 'T12:00:00') : new Date(); // LE31_TODAY : date fixée par les tests
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
const TABS = { comptes: 'Comptes', profils: 'Profils', parametres: 'Parametres', appareils: 'Appareils', attente: 'Attente', banque: 'Banque', banqueConf: 'BanqueConf',
  mouvements: 'Mouvements', recurrents: 'Recurrents', cycles: 'Cycles', prevues: 'Prevues', budgets: 'Budgets', apprentissage: 'Apprentissage', livrets: 'Livrets', mvtsLivret: 'MvtsLivret', reglages: 'Reglages' };
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
  migrate31();
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
const isPerso = acc => !!accOf(acc).proprietaire;
const isShared = acc => !accOf(acc).proprietaire && DB.profils.length > 1;
const otherNames = () => DB.profils.filter(p => p.id !== ME).map(p => p.nom).join(', ');
const profiles = () => DB.profils.slice().sort((a, b) => (num(a.ordre) || 0) - (num(b.ordre) || 0));
const pname = id => (DB.profils.find(p => p.id === id) || {}).nom || '';
const param = (k, d) => { const p = DB.parametres.find(x => x.cle === k); return p ? p.valeur : d; };
const shortAcc = id => isPerso(id) ? 'Perso' : 'Commun';

/* ================= Dates ================= */
const DD = iso => new Date(iso + 'T12:00:00Z');
const addD = (iso, n) => { const d = DD(iso); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const dDiff = (a, b) => Math.round((DD(b) - DD(a)) / 864e5);
const dayOn = (k, j) => k + '-' + pad(Math.min(Math.max(1, j), dim(k)));   // jour j du mois k (plafonné au dernier jour)
const fmtJ = iso => iso ? iso.slice(8, 10) + '/' + iso.slice(5, 7) : '';
const fmtJA = iso => iso ? fmtJ(iso) + '/' + iso.slice(2, 4) : '';
const WD = ['dim.', 'lun.', 'mar.', 'mer.', 'jeu.', 'ven.', 'sam.'];
const wd = iso => WD[DD(iso).getUTCDay()];
const dLong = iso => (+iso.slice(8, 10)) + ' ' + MONTHS[pm(iso.slice(0, 7)).m];
const dayGap = (a, b) => { const d = Math.abs(a - b); return Math.min(d, 31 - d); }; // le 30 et le 1er sont voisins
// Un cycle porte le nom du mois qu'il finance : du 27/10 au 27/11 = « novembre » (comme dans le fichier Excel)
const labelMonth = debut => addD(debut, 10).slice(0, 7);
const cycName = k => MONTHS_L[pm(k).m] + (pm(k).y !== pm(labelMonth(TODAY_ISO)).y ? ' ' + pm(k).y : '');

/* ================= Démarrage V3 d'un compte =================
   Parametres « v3|<compte> » = { debut: date de début du 1er cycle suivi, mois, montant (revenu du cycle), jour (jour habituel) } */
// V3.1 : réglages privés d'un compte (onglet Reglages : id = compte|cle, valeur JSON) ; avant, « v3 » était dans Parametres (partagé)
const regJ = (acc, k) => { const r = DB.reglages.find(x => x.id === acc + '|' + k); if (!r) return null; try { return JSON.parse(r.valeur); } catch (e) { return null; } };
const regOp = (acc, k, v) => upd('Reglages', { id: acc + '|' + k, compte: acc, cle: k, valeur: JSON.stringify(v) });
const v3 = acc => { const r = regJ(acc, 'v3'); if (r) return r; try { return JSON.parse(param('v3|' + acc, 'null')); } catch (e) { return null; } };
const started3 = acc => !!(v3(acc) || {}).debut;
const defJour = acc => num((v3(acc) || {}).jour) || 26;
const salLabel = acc => isPerso(acc) ? 'Salaire' : (param('v3nomrev|' + acc, '') || 'Virement de début de cycle');

/* ================= Cycles (Calendrier salaires) =================
   Début d'un cycle : date saisie (Calendrier) > date de la rentrée vue à la banque > estimation (jour habituel du mois d'avant).
   Fin = veille du cycle suivant. Onglet Cycles : id = compte|mois, manuel = d (date), m (montant), s (solde saisi), b (solde lu à la banque). */
function cyclesOf(acc) {
  const ck = 'cy|' + acc; if (CACHE[ck]) return CACHE[ck];
  const S = v3(acc); if (!S || !S.debut) return (CACHE[ck] = []);
  const rows = {}; DB.cycles.filter(c => c.compte === acc).forEach(c => rows[c.mois] = c);
  const sal = {}; allMovs().filter(o => o.compte === acc && o.type === 'sal').forEach(o => { if (!sal[o.lien] || o.date < sal[o.lien].date) sal[o.lien] = o; });
  const list = [], P = salPlan(acc); let k = S.mois, baseM = num(S.montant) || 0, baseK = S.mois;
  const n = Math.max(15, diffM(S.mois, labelMonth(TODAY_ISO)) + 15);
  for (let i = 0; i < n; i++) {
    const r = rows[k] || {}, so = sal[k], man = String(r.manuel || '');
    let debut = i === 0 ? S.debut : (man.includes('d') && r.debut) || (so && so.date) || r.debut || dayOn(addM(k, -1), defJour(acc));
    if (i > 0 && dDiff(list[i - 1].debut, debut) < 15) debut = addD(list[i - 1].debut, 15); // garde-fou : deux débuts trop proches
    if (man.includes('m') && num(r.montant) !== null && r.montant !== '') { baseM = num(r.montant); baseK = k; }
    const X = expectedPay(P, baseM, baseK, k);
    list.push({ i, acc, mois: k, debut, montant: X.total, base: X.base, detail: X, row: r, sal: so || null, man, dateBanque: so ? so.date : '' });
    k = addM(k, 1);
  }
  list.forEach((c, i) => c.fin = i + 1 < list.length ? addD(list[i + 1].debut, -1) : addD(c.debut, 30));
  list.pop();
  return (CACHE[ck] = list);
}
const cycleAt = (acc, iso) => { const l = cyclesOf(acc); let c = null; for (const x of l) { if (x.debut <= iso) c = x; else break; } return c; };
const curCycle = acc => cycleAt(acc, TODAY_ISO) || cyclesOf(acc)[0];
const cycleByMois = (acc, k) => cyclesOf(acc).find(c => c.mois === k);

/* ================= Mouvements ================= */
let STAGE = null; // mouvements en cours d'ajout (lecture de la banque) : vus par les règles avant l'envoi
const allMovs = () => DB.mouvements;
const movsIn = (acc, a, b) => allMovs().filter(o => o.compte === acc && o.date >= a && o.date <= b);
const recOf = id => DB.recurrents.find(r => r.id === id);
const budgetsOf = acc => DB.budgets.filter(b => b.compte === acc).sort((a, b) => (num(a.ordre) || 0) - (num(b.ordre) || 0) || a.nom.localeCompare(b.nom));
const catNames = acc => { const s = new Set(budgetsOf(acc).map(b => b.nom)); return [...s]; };
const TYPES = { ponct: 'Ponctuel', fixe: 'Fixe', sal: 'Revenu du cycle', ajust: 'Correction', '': 'À classer' };

// Dates d'un récurrent entre a et b (jour plafonné à la fin du mois, comme dans l'Excel)
function occDates(r, a, b) {
  if (!bool(r.actif)) return [];
  const j = num(r.jour) || 1, out = [];
  for (let k = a.slice(0, 7); k <= b.slice(0, 7); k = addM(k, 1)) {
    const d = dayOn(k, j);
    if (d < a || d > b || (r.debut && d < r.debut) || (r.fin && d > r.fin)) continue;
    out.push(d);
  }
  return out;
}

/* ================= Calcul d'un cycle (logique du fichier Excel) =================
   Solde actuel = départ + opérations réelles jusqu'à aujourd'hui (= banque).
   Atterrissage sans budget = départ + réel + à venir (revenu du cycle pas encore vu, fixes pas encore vus, prévues).
   Budget restant = somme des « reste » des budgets (cycle en cours), budget complet (cycle futur), 0 (cycle fini).
   Atterrissage avec budget = sans budget − budget restant. */
function cycleCalc(acc, c) {
  const ck = 'cc|' + acc + '|' + c.mois; if (CACHE[ck]) return CACHE[ck];
  const depart = departOf(acc, c);
  const real = movsIn(acc, c.debut, c.fin);
  const isPast = c.fin < TODAY_ISO, isFut = c.debut > TODAY_ISO, isCur = !isPast && !isFut;
  const tomorrow = addD(TODAY_ISO, 1), place = d => d > TODAY_ISO ? d : (tomorrow <= c.fin ? tomorrow : c.fin);
  const proj = [];
  if (!isPast) {
    // une opération encore « à classer » qui ressemble au revenu du cycle ou à un fixe compte comme déjà vue (pas de double compte)
    const pend = real.filter(o => !o.type), used = new Set();
    const take = f => { const o = pend.find(x => !used.has(x.id) && f(x)); if (o) used.add(o.id); return !!o; };
    const salSeen = real.some(o => o.type === 'sal') || c.i === 0 && c.debut <= TODAY_ISO
      || take(o => (num(o.montant) || 0) > 0 && Math.abs((num(o.montant) || 0) - c.montant) <= 0.25 * c.montant && Math.abs(dDiff(c.debut, o.date)) <= 4);
    if (!salSeen && c.montant) proj.push({ d: place(c.debut), v: c.montant, label: salLabel(acc), kind: 'sal', late: c.debut <= TODAY_ISO });
    DB.recurrents.filter(r => r.compte === acc).forEach(r => {
      const occ = occDates(r, c.debut, c.fin); if (!occ.length) return;
      const m = num(r.montant) || 0, key = r.motif;
      let seen = real.filter(o => o.type === 'fixe' && o.lien === r.id).length;
      while (seen < occ.length && take(o => ((num(o.montant) || 0) > 0) === (r.sens === '+') && Math.abs(Math.abs(num(o.montant) || 0) - m) <= Math.max(0.1 * m, 3)
        && ((key && (skOf(o) === key || keyOf(o.libelle || '') === key)) || dayGap(num(r.jour) || 1, +o.date.slice(8, 10)) <= 4))) seen++;
      const v = (r.sens === '+' ? 1 : -1) * m;
      occ.slice(seen).forEach(d => proj.push({ d: place(d), v, label: r.libelle, kind: 'fixe', id: r.id, cat: r.categorie, late: d <= TODAY_ISO, prevu: d }));
    });
    primeParts(acc, c.debut, c.fin).forEach(p => {
      const seen = real.some(o => o.lien === p.key) || take(o => (num(o.montant) || 0) > 0 && Math.abs((num(o.montant) || 0) - p.v) <= 0.1 * p.v && Math.abs(dDiff(p.date, o.date)) <= 4);
      if (!seen) proj.push({ d: place(p.date), v: p.v, label: p.nom, kind: 'prime', late: p.date <= TODAY_ISO, prevu: p.date });
    });
    DB.prevues.filter(p => p.compte === acc && !p.etat && p.date >= c.debut && p.date <= c.fin)
      .forEach(p => proj.push({ d: place(p.date), v: num(p.montant) || 0, label: p.libelle, kind: 'prev', id: p.id, cat: p.categorie, late: p.date <= TODAY_ISO, prevu: p.date }));
  }
  const buds = budgetsOf(acc).filter(b => (num(b.budget) || 0) > 0).map(b => {
    const spent = r2(-real.filter(o => o.type === 'ponct' && o.categorie === b.nom).reduce((a, o) => a + (num(o.montant) || 0), 0));
    const bud = num(b.budget);
    return { b, nom: b.nom, budget: bud, spent, reste: r2(Math.max(0, bud - spent)), over: r2(Math.max(0, spent - bud)) };
  });
  const reserve = r2(isPast ? 0 : isFut ? buds.reduce((a, x) => a + x.budget, 0) : buds.reduce((a, x) => a + x.reste, 0));
  const items = real.map(o => ({ d: o.date, v: num(o.montant) || 0, label: nameOf(o), kind: o.type || 'todo', id: o.id, cat: o.categorie, real: true })).concat(proj);
  const byDay = {}; items.forEach(it => (byDay[it.d] = byDay[it.d] || []).push(it));
  const days = []; let bal = depart;
  for (let d = c.debut; d <= c.fin; d = addD(d, 1)) { const l = byDay[d] || []; const mv = r2(l.reduce((a, x) => a + x.v, 0)); bal = r2(bal + mv); days.push({ d, items: l, mv, bal }); }
  const sumReal = l => r2(l.reduce((a, o) => a + (num(o.montant) || 0), 0));
  const realEnd = r2(depart + sumReal(real));
  const atterSans = isPast ? realEnd : (days.length ? days[days.length - 1].bal : depart);
  const res = { c, depart, real, proj, days, buds, reserve, isPast, isCur, isFut, realEnd,
    soldeActuel: r2(depart + sumReal(real.filter(o => o.date <= TODAY_ISO))), atterSans, atterAvec: r2(atterSans - reserve),
    todo: real.filter(o => !o.type).length };
  return (CACHE[ck] = res);
}
// Solde de départ : saisi (Calendrier) ou lu à la banque, sinon fin réelle du cycle précédent (fini) ou son atterrissage avec budget
function departOf(acc, c) {
  const s = num(c.row.soldeDepart); if (s !== null && c.row.soldeDepart !== '') return s;
  if (c.i === 0) return 0;
  const p = cyclesOf(acc)[c.i - 1], P = cycleCalc(acc, p);
  return P.isPast ? P.realEnd : P.atterAvec;
}
const departKind = c => num(c.row.soldeDepart) !== null && c.row.soldeDepart !== '' ? (c.man.includes('b') ? 'banque' : 'saisi') : c.i === 0 ? 'à renseigner' : c.fin < TODAY_ISO || c.debut <= TODAY_ISO ? 'réel' : 'projeté';
// Solde calculé à une date (pour recaler sur la banque)
function balanceAt(acc, iso) {
  const c = cycleAt(acc, iso); if (!c) return null;
  return r2(departOf(acc, c) + movsIn(acc, c.debut, iso).reduce((a, o) => a + (num(o.montant) || 0), 0));
}

/* ================= Simulation (même logique que l'onglet « Simulation achat » de l'Excel) =================
   12 cycles à partir du cycle en cours ; un achat est possible si le solde de fin AVEC budget reste ≥ 0
   à la fin de son cycle et de tous les suivants. */
function simBase(acc) {
  const cy = cyclesOf(acc), cur = curCycle(acc); if (!cur) return [];
  return cy.slice(cur.i, cur.i + 12).map(c => ({ c, end: cycleCalc(acc, c).atterAvec }));
}
const simIdx = (base, iso) => { if (!base.length) return -1; if (iso < base[0].c.debut) return 0; return base.findIndex(x => iso >= x.c.debut && iso <= x.c.fin); };
function simAchat(base, a) {
  const j = simIdx(base, a.date), m = num(a.montant) || 0;
  if (j < 0 || !(m > 0)) return null;
  const after = base.slice(j), low = r2(Math.min(...after.map(x => x.end - m))), max = r2(Math.max(0, Math.min(...after.map(x => x.end))));
  let conseil = null;
  if (low < 0) for (let jj = j + 1; jj < base.length; jj++) if (Math.min(...base.slice(jj).map(x => x.end)) >= m) { conseil = base[jj].c.debut; break; }
  return { j, ok: low >= 0, low, max, conseil };
}
function simAll(base, achats) {
  const ends = base.map(x => x.end);
  achats.forEach(a => { const j = simIdx(base, a.date), m = num(a.montant) || 0; if (j >= 0 && m > 0) for (let k = j; k < ends.length; k++) ends[k] -= m; });
  return { ends: ends.map(r2), ok: ends.every(v => v >= 0) };
}
// Crédit : mensualité chaque mois au jour du 1er prélèvement (plafonné à la fin du mois), entre les deux dates ;
// « remplace » : la charge fixe choisie n'est plus prélevée à partir du 1er prélèvement ; frais débités à la 1re date.
function simCredit(acc, base, cr) {
  const M = num(cr.mens) || 0; if (!base.length || !cr.debut) return null;
  const jour = +cr.debut.slice(8, 10), fin = cr.fin || '9999-12-31', rp = cr.remplace && recOf(cr.remplace);
  let cumPay = 0, cumOther = 0, low = Infinity, maxM = Infinity;
  const rows = base.map(x => {
    let n = 0;
    for (let k = x.c.debut.slice(0, 7); k <= x.c.fin.slice(0, 7); k = addM(k, 1)) { const d = dayOn(k, jour); if (d >= x.c.debut && d <= x.c.fin && d >= cr.debut && d <= fin) n++; }
    let saved = 0;
    if (rp && rp.sens !== '+') { const a0 = cr.debut > x.c.debut ? cr.debut : x.c.debut; if (a0 <= x.c.fin) saved = occDates(rp, a0, x.c.fin).length * (num(rp.montant) || 0); }
    const frais = cr.debut >= x.c.debut && cr.debut <= x.c.fin ? (num(cr.frais) || 0) : 0;
    cumPay += n; cumOther += saved - frais;
    const end = r2(x.end + cumOther - M * cumPay);
    low = Math.min(low, end);
    if (cumPay > 0) maxM = Math.min(maxM, (x.end + cumOther) / cumPay);
    return { c: x.c, n, end, base: x.end };
  });
  return { rows, ok: low >= 0, low: r2(low), impact: r2(cumOther - M * cumPay), nPay: cumPay, max: maxM === Infinity ? null : r2(Math.max(0, Math.floor(maxM * 100) / 100)) };
}

/* ================= V3.1 : évolution du salaire =================
   Réglage « salaire » : { moisHausse: 6, rattrapDepuis: 1, hausses: { "2027": 2 }, primes: [{ id, nom, type: "paie"|"part", mois, jour, montants: { "2026": 2000 } }] }
   La paie d'un mois ouvre le cycle du mois suivant (paie de juin → cycle de juillet). */
const salPlan = acc => regJ(acc, 'salaire') || { moisHausse: 6, rattrapDepuis: 1, hausses: {}, primes: [] };
const payMonth = k => addM(k, -1);
// pourcentage d'une année : celui saisi, sinon le dernier saisi avant (les années suivantes le reprennent)
function pctOf(P, y) {
  const ys = Object.keys(P.hausses || {}).map(Number).filter(x => !isNaN(x)).sort((a, b) => a - b);
  if (!ys.length || y < ys[0]) return 0;
  const k = ys.filter(x => x <= y).pop(); return num(P.hausses[k]) || 0;
}
// montant d'une prime pour une année : celui saisi, sinon celui de l'année d'avant la plus proche
function primeAmt(p, y) {
  const m = p.montants || {}; const ys = Object.keys(m).map(Number).filter(x => x <= y && num(m[x]) > 0).sort((a, b) => a - b);
  return ys.length ? num(m[ys.pop()]) : 0;
}
// Paie attendue pour le cycle k : salaire de base augmenté + rattrapage (paie de l'augmentation) + primes versées avec la paie
function expectedPay(P, baseM, baseK, k) {
  const mh = Math.min(12, Math.max(1, num(P.moisHausse) || 6)), rd = Math.min(mh, Math.max(1, num(P.rattrapDepuis) || 1));
  const pk = payMonth(k), p0 = payMonth(baseK);
  let base = baseM, rappel = 0, hausse = 0;
  for (let y = +p0.slice(0, 4); y <= +pk.slice(0, 4); y++) {
    const e = y + '-' + pad(mh), pc = pctOf(P, y);
    if (!pc || e <= p0 || e > pk) continue;
    const before = base; base = r2(base * (1 + pc / 100));
    if (e === pk) { hausse = pc; rappel = r2((base - before) * (mh - rd)); }
  }
  const primes = (P.primes || []).filter(p => p.type !== 'part' && +p.mois === +pk.slice(5, 7)).map(p => ({ nom: p.nom, v: primeAmt(p, +pk.slice(0, 4)) })).filter(p => p.v > 0);
  return { base: r2(base), rappel, hausse, primes, total: r2(base + rappel + primes.reduce((a, p) => a + p.v, 0)) };
}
// Primes versées à part (ex. ½ 13ème mois le 15 juin et le 15 décembre) entre a et b
function primeParts(acc, a, b) {
  const P = salPlan(acc), out = [];
  (P.primes || []).filter(p => p.type === 'part').forEach(p => {
    for (let y = +a.slice(0, 4); y <= +b.slice(0, 4); y++) {
      const d = dayOn(y + '-' + pad(+p.mois || 12), +p.jour || 15), v = primeAmt(p, y);
      if (d >= a && d <= b && v > 0) out.push({ id: p.id, nom: p.nom, date: d, v, key: 'pr|' + p.id + '|' + y });
    }
  });
  return out;
}

/* ================= V3.1 : épargne =================
   Livrets(compte = compte courant propriétaire, type livret|invest, pointZero au dateZero, objectif mensuel).
   Un mouvement du compte courant alimente un livret : type « epargne » (livret choisi), fixe lié à un livret, prévue liée.
   Sortie du compte = versement sur le livret ; rentrée depuis le livret = retrait. MvtsLivret : intérêts (recalage) et mouvements à la main. */
const livretsOf = acc => DB.livrets.filter(l => l.compte === acc && l.actif !== 'non').sort((a, b) => (num(a.ordre) || 0) - (num(b.ordre) || 0));
const livOf = id => DB.livrets.find(l => l.id === id);
const livretOfMov = o => o.type === 'epargne' ? o.livret || '' : o.type === 'fixe' ? ((recOf(o.lien) || {}).livret || '') : o.livret || '';
const monthEnd = k => k + '-' + pad(dim(k));
function livFlows(L) {
  const ck = 'lf|' + L.id; if (CACHE[ck]) return CACHE[ck];
  const out = [];
  DB.mouvements.filter(o => o.compte === L.compte && o.date > L.dateZero && livretOfMov(o) === L.id).forEach(o => { const v = r2(-(num(o.montant) || 0)); out.push({ date: o.date, v, kind: v >= 0 ? 'vers' : 'retr', label: nameOf(o), oid: o.id }); });
  DB.mvtsLivret.filter(m => m.livret === L.id && m.date > L.dateZero).forEach(m => { const v = num(m.montant) || 0; out.push({ date: m.date, v, kind: m.type === 'interets' ? 'int' : v >= 0 ? 'vers' : 'retr', label: m.libelle || (m.type === 'interets' ? 'Intérêts' : 'Mouvement'), mid: m.id }); });
  return (CACHE[ck] = out.sort((a, b) => a.date.localeCompare(b.date)));
}
// À venir sur un mois : fixes liés pas encore vus ce mois-là, prévues liées (mois en cours et suivants)
function livProj(L, k) {
  if (k < CUR) return [];
  const a = k + '-01', b = monthEnd(k), out = [];
  DB.recurrents.filter(r => r.compte === L.compte && r.livret === L.id).forEach(r => {
    const occ = occDates(r, a, b), seen = DB.mouvements.filter(o => o.type === 'fixe' && o.lien === r.id && o.date >= a && o.date <= b).length;
    occ.slice(seen).forEach(d => out.push({ date: d, v: (r.sens === '+' ? -1 : 1) * (num(r.montant) || 0), kind: r.sens === '+' ? 'retr' : 'vers', label: r.libelle, prevu: true }));
  });
  DB.prevues.filter(p => p.compte === L.compte && p.livret === L.id && !p.etat && p.date >= a && p.date <= b)
    .forEach(p => { const v = -(num(p.montant) || 0); out.push({ date: p.date, v, kind: v >= 0 ? 'vers' : 'retr', label: p.libelle, prevu: true }); });
  return out;
}
const livSolde = (L, iso) => r2((num(L.pointZero) || 0) + livFlows(L).filter(f => f.date <= iso).reduce((a, f) => a + f.v, 0));
// Mois du livret : du mois qui suit le point zéro jusqu'à `last` ; réel jusqu'à aujourd'hui, prévu ensuite
function livMonths(L, last) {
  const ck = 'lm|' + L.id + '|' + last; if (CACHE[ck]) return CACHE[ck];
  const out = []; let bal = num(L.pointZero) || 0;
  for (let k = addM(L.dateZero.slice(0, 7), 1); k <= last; k = addM(k, 1)) {
    const fl = livFlows(L).filter(f => f.date.slice(0, 7) === k), pr = livProj(L, k), all = fl.concat(pr);
    const vers = r2(all.filter(f => f.kind === 'vers').reduce((a, f) => a + f.v, 0)), retr = r2(-all.filter(f => f.kind === 'retr').reduce((a, f) => a + f.v, 0)), int = r2(all.filter(f => f.kind === 'int').reduce((a, f) => a + f.v, 0));
    const realNet = r2(fl.filter(f => f.kind !== 'int').reduce((a, f) => a + f.v, 0)), projNet = r2(pr.reduce((a, f) => a + f.v, 0));
    bal = r2(bal + vers - retr + int);
    out.push({ k, vers, retr, int, net: r2(vers - retr), fin: bal, realNet, projNet, real: fl, proj: pr, st: k < CUR ? 'real' : k === CUR ? 'cur' : 'fut' });
  }
  return (CACHE[ck] = out);
}
// objectif du mois : atteint (réel), à venir (réel + prévu), en retard
function livObj(L, m) {
  const o = num(L.objectif) || 0; if (!o || !m) return null;
  return m.realNet >= o - 0.005 ? 'ok' : m.st !== 'real' && m.realNet + m.projNet >= o - 0.005 ? 'wait' : 'late';
}

/* ================= V3.1 : courbe (accueil et épargne) ================= */
function lineSvg(pts, label) {
  const ok = pts.filter(p => p.v !== null && p.v !== undefined); if (!ok.length) return '';
  const W = 330, H = 180, x0 = 22, x1 = 306, yb = 150, yt = 22;
  const vs = ok.map(p => p.v), mn = Math.min(0, ...vs), mx = Math.max(1, ...vs);
  const X = i => pts.length < 2 ? (x0 + x1) / 2 : x0 + i * (x1 - x0) / (pts.length - 1), Y = v => yb - (v - mn) * (yb - yt) / (mx - mn || 1);
  const seg = (a, b) => `M${X(a.i).toFixed(1)} ${Y(a.v).toFixed(1)} L${X(b.i).toFixed(1)} ${Y(b.v).toFixed(1)}`;
  const P = pts.map((p, i) => Object.assign({ i }, p)).filter(p => p.v !== null && p.v !== undefined);
  let solid = '', dash = '';
  for (let j = 1; j < P.length; j++) { const s = seg(P[j - 1], P[j]); if (P[j].st === 'fut') dash += s + ' '; else solid += s + ' '; }
  const dots = P.map(p => p.st === 'fut' ? `<circle cx="${X(p.i).toFixed(1)}" cy="${Y(p.v).toFixed(1)}" r="3" fill="var(--surface)" stroke="${p.v < 0 ? 'var(--warn)' : 'var(--accent)'}" stroke-width="2"/>` : `<circle cx="${X(p.i).toFixed(1)}" cy="${Y(p.v).toFixed(1)}" r="${p.st === 'cur' ? 5 : 3.5}" fill="${p.v < 0 ? 'var(--warn)' : 'var(--accent)'}"/>`).join('');
  const labs = pts.map((p, i) => `<text x="${X(i).toFixed(1)}" y="170" text-anchor="middle">${esc(p.lab)}</text>`).join('');
  const fmt = v => Math.round(v).toLocaleString('fr-FR');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}">
    <line x1="${x0}" y1="${Y(0).toFixed(1)}" x2="${x1}" y2="${Y(0).toFixed(1)}" class="zero"/>
    ${solid ? `<path d="${solid}" class="ln"/>` : ''}${dash ? `<path d="${dash}" class="ln dash"/>` : ''}${dots}
    <g class="lab">${labs}</g><g class="lab"><text x="${W - 2}" y="${(Y(mx) + 3).toFixed(1)}" text-anchor="end">${fmt(mx)}</text><text x="${W - 2}" y="${(Y(0) + 3).toFixed(1)}" text-anchor="end">0</text></g></svg>`;
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

/* ================= Classement et apprentissage (V3) =================
   1er cycle suivi : tout arrive dans « À classer ». Ensuite, une opération n'est classée seule que si c'est sûr :
   - revenu du cycle (salaire / virement de début de cycle) : même marchand, montant à ± 25 % ;
   - charge fixe : même marchand qu'un fixe, montant à ± 10 % (3 € mini), jour à ± 4, pas encore vue dans le cycle ;
   - ponctuel : marchand toujours classé dans la même catégorie (ou séparé par montant) ;
   - prévue : même montant (± 1 %) à ± 4 jours.
   Sinon elle reste « À classer », avec une suggestion. Onglet Apprentissage : cle = marchand (« + » devant pour une rentrée),
   type = ponct | sal | ask (toujours demander), categorie (« A|B » si classé dans deux catégories), nom, montant. */
const skOf = o => ((num(o.montant) || 0) > 0 ? '+' : '') + keyOf(o.libelle || '');
const ruleOf3 = (acc, key) => DB.apprentissage.find(r => r.compte === acc && r.cle === key);
function seuilRule(acc, key) { try { return JSON.parse(param('seuilCat|' + acc + '|' + key, 'null')); } catch (e) { return null; } }
function nameOf(o) {
  if (o.nom) return o.nom;
  if (!o.ref) return o.libelle || o.categorie || 'Opération';
  const r = ruleOf3(o.compte, skOf(o)); return (r && r.nom) || smartName(o.libelle);
}
// Suggestion pour une opération : { kind: 'fixe'|'sal'|'ponct'|'ask', sure, why, r, cats }
function suggest(o) {
  const acc = o.compte, key = skOf(o), k0 = keyOf(o.libelle || ''), v = num(o.montant) || 0, a = Math.abs(v), neg = v < 0;
  const rule = ruleOf3(acc, key);
  if (rule && rule.type === 'ask') return { kind: 'ask', sure: false, why: 'Toujours demander pour ce marchand' };
  if (!neg) { // prime versée à part (½ 13ème mois…) : montant à ± 10 %, date à ± 4 jours
    const pp = primeParts(acc, addD(o.date, -4), addD(o.date, 4)).find(p => Math.abs(a - p.v) <= 0.1 * p.v && !allMovs().some(x => x.id !== o.id && x.lien === p.key));
    if (pp) return { kind: 'prime', p: pp, sure: true, why: '' };
  }
  if (!neg && rule && rule.type === 'sal') {
    const c = cycleByMois(acc, labelMonth(o.date)), exp = c ? c.montant : (num(rule.montant) || a);
    const ok = Math.abs(a - exp) <= 0.1 * exp || (!(c && (c.detail.rappel || c.detail.primes.length)) && Math.abs(a - (num(rule.montant) || exp)) <= 0.25 * (num(rule.montant) || exp));
    return { kind: 'sal', sure: ok, why: ok ? '' : `Montant inhabituel (attendu ${eur(exp)})` };
  }
  if (rule && rule.type === 'epargne' && livOf(rule.categorie)) return { kind: 'epargne', livret: rule.categorie, sure: true, why: '' };
  const recs = DB.recurrents.filter(r => r.compte === acc && bool(r.actif) && (r.sens === '+') === !neg && (r.motif === key || r.motif === k0));
  if (recs.length) {
    const c = cycleAt(acc, o.date), day = +String(o.date).slice(8, 10);
    const cand = recs.map(r => {
      const occ = c ? occDates(r, c.debut, c.fin) : [];
      const seen = c ? allMovs().filter(x => x.id !== o.id && x.compte === acc && x.type === 'fixe' && x.lien === r.id && x.date >= c.debut && x.date <= c.fin).length : 0;
      const m = num(r.montant) || 0, amtOk = Math.abs(a - m) <= Math.max(0.1 * m, 3), dayOk = dayGap(num(r.jour) || 1, day) <= 4, free = seen < Math.max(1, occ.length);
      return { r, amtOk, dayOk, free, sc: (amtOk ? 4 : 0) + (free ? 2 : 0) + (dayOk ? 1 : 0), d: Math.abs(a - m) };
    }).sort((x, y) => y.sc - x.sc || x.d - y.d)[0];
    const sure = cand.amtOk && cand.dayOk && cand.free;
    const why = !cand.amtOk ? `Montant inhabituel (d'habitude ${eur(num(cand.r.montant))})` : !cand.free ? 'Déjà vue dans ce cycle' : !cand.dayOk ? `Date inhabituelle (d'habitude le ${cand.r.jour})` : '';
    return { kind: 'fixe', r: cand.r, sure, why };
  }
  if (!rule) { // nom d'un livret dans le libellé : versement (débit) ou retrait (crédit), à confirmer
    const nl = NORM(o.libelle || ''), L = livretsOf(acc).find(x => x.nom && nl.includes(NORM(x.nom)));
    if (L) return { kind: 'epargne', livret: L.id, sure: false, why: '' };
  }
  const sr = neg && seuilRule(acc, k0);
  if (sr) return { kind: 'ponct', cats: [a > num(sr.s) ? sr.haut : sr.bas], sure: true, why: '' };
  if (rule && rule.type === 'ponct') {
    const cats = String(rule.categorie || '').split('|').filter(Boolean);
    return { kind: 'ponct', cats, sure: cats.length === 1, why: cats.length > 1 ? `Déjà classé en ${cats.join(' et en ')} : lequel ?` : '' };
  }
  return null;
}
// Classement automatique d'une nouvelle opération (renvoie les écritures annexes : prévue réalisée, date du cycle)
function autoClass(o) {
  const acc = o.compte, v = num(o.montant) || 0, a = Math.abs(v), S = v3(acc) || {}, ops = [];
  const pv = DB.prevues.find(p => p.compte === acc && !p.etat && Math.sign(num(p.montant) || 0) === Math.sign(v) && Math.abs(Math.abs(num(p.montant) || 0) - a) <= Math.max(0.01 * a, 1) && Math.abs(dDiff(p.date, o.date)) <= 4);
  if (pv) { Object.assign(o, pv.livret ? { type: 'epargne', livret: pv.livret, categorie: pv.categorie || 'Épargne', nom: pv.libelle, auto: '1' } : { type: 'ponct', categorie: pv.categorie || '', nom: pv.libelle, auto: '1' }); ops.push(upd('Prevues', { id: pv.id, etat: 'realisee', lien: o.id })); return ops; }
  const c = cycleAt(acc, o.date), s = suggest(o);
  if (!s || !s.sure) return ops;
  if (s.kind === 'prime') { Object.assign(o, { type: 'ponct', categorie: 'Primes', lien: s.p.key, nom: s.p.nom, auto: '1' }); return ops; }
  // le revenu du cycle suivant peut arriver avant la date estimée : accepté dès 15 jours après le début du suivi
  const allowed = (c && c.i >= 1) || (s.kind === 'sal' && S.debut && dDiff(S.debut, o.date) >= 15);
  if (!allowed) return ops;
  if (s.kind === 'sal') { Object.assign(o, { type: 'sal', lien: labelMonth(o.date), categorie: '', auto: '1' }); ops.push(...cycleDateOps(acc, o)); }
  else if (s.kind === 'fixe') Object.assign(o, { type: 'fixe', lien: s.r.id, categorie: s.r.categorie || '', nom: s.r.libelle, auto: '1' });
  else if (s.kind === 'ponct') { const r = ruleOf3(acc, skOf(o)); Object.assign(o, { type: 'ponct', categorie: s.cats[0], nom: (r && r.nom) || '', auto: '1' }); }
  else if (s.kind === 'epargne') Object.assign(o, { type: 'epargne', livret: s.livret, categorie: 'Épargne', auto: '1' });
  return ops;
}
// Le revenu vu à la banque fixe la date de début (et le montant) du cycle, sauf si on les a saisis à la main
function cycleDateOps(acc, o) {
  const k = o.lien || labelMonth(o.date), S = v3(acc) || {}, id = acc + '|' + k;
  const r = DB.cycles.find(x => x.id === id) || {}, man = String(r.manuel || ''), row = { id, compte: acc, mois: k };
  if (k !== S.mois && !man.includes('d')) row.debut = o.date;
  return Object.keys(row).length > 3 ? [upd('Cycles', row)] : [];
}
// Classement à la main (ou correction) : h = { type, categorie, nom, recId, newRec: {libelle, jour, montant}, ask }
function classifyOps(o, h) {
  const acc = o.compte, key = skOf(o), ops = [], v = num(o.montant) || 0;
  const row = { id: o.id, type: h.type === 'prime' ? 'ponct' : h.type, categorie: h.categorie || '', lien: '', auto: '', nom: h.nom || '', livret: '' };
  const rule = ruleOf3(acc, key), rid0 = rule ? rule.id : uid(), learn = f => ops.push(upd('Apprentissage', Object.assign({ id: rid0, compte: acc, cle: key }, rule ? {} : { type: '', categorie: '', nom: '', montant: '' }, f)));
  if (h.type === 'fixe') {
    let rid = h.recId;
    if (!rid) {
      rid = uid(); const c = cycleAt(acc, o.date);
      ops.push(upd('Recurrents', { id: rid, compte: acc, libelle: h.newRec.libelle || nameOf(o), montant: r2(Math.abs(num(h.newRec.montant) || Math.abs(v))), sens: v > 0 ? '+' : '-', jour: num(h.newRec.jour) || +o.date.slice(8, 10), categorie: h.categorie || '', debut: c ? c.debut : o.date, fin: '', actif: 'oui', motif: key, livret: h.newRec.livret || '' }));
      row.nom = h.newRec.libelle || nameOf(o);
    } else {
      const r = recOf(rid); if (r) { if (r.motif !== key) ops.push(upd('Recurrents', { id: rid, motif: key })); row.categorie = h.categorie || r.categorie || ''; row.nom = r.libelle; }
    }
    row.lien = rid;
  } else if (h.type === 'epargne') {
    row.livret = h.livret || ''; row.categorie = h.categorie || 'Épargne';
    learn({ type: 'epargne', categorie: h.livret || '' });
  } else if (h.type === 'prime') {
    row.lien = h.key; row.categorie = 'Primes'; row.nom = h.nom || '';
  } else if (h.type === 'sal') {
    row.lien = labelMonth(o.date); row.categorie = '';
    ops.push(...cycleDateOps(acc, Object.assign({}, o, { lien: row.lien })));
    learn({ type: 'sal', montant: r2(Math.abs(v)) });
  } else if (h.type === 'ponct') {
    const cat = h.categorie || '';
    const prev = rule && rule.type === 'ponct' ? String(rule.categorie || '').split('|').filter(Boolean) : [];
    const cats = cat && !prev.includes(cat) ? prev.concat(cat) : prev.length ? prev : [cat].filter(Boolean);
    const f = { type: 'ponct', categorie: cats.join('|') };
    if (h.nom && h.nom !== smartName(o.libelle || '')) f.nom = h.nom;
    learn(f);
  }
  if (h.ask !== undefined && (h.ask || (rule && rule.type === 'ask'))) learn({ type: h.ask ? 'ask' : (h.type === 'sal' ? 'sal' : 'ponct') });
  if (h.categorie) ops.push(...newCatOps(acc, h.categorie));
  ops.push(upd('Mouvements', row));
  return ops;
}
// Catégorie absente de la liste : créée (sans budget)
function newCatOps(acc, nom) {
  nom = String(nom || '').trim(); if (!nom || budgetsOf(acc).some(b => b.nom.toLowerCase() === nom.toLowerCase())) return [];
  return [upd('Budgets', { id: uid(), compte: acc, nom, budget: '', ordre: Math.max(0, ...budgetsOf(acc).map(b => num(b.ordre) || 0)) + 1 })];
}

/* ================= Lecture de la banque : nouvelles opérations ================= */
// Écritures appliquées tout de suite en local (les suivantes en tiennent compte), envoyées en une fois
function stage(ops) { clean(ops); QUEUE.push(...ops); store.set('le31-file', QUEUE); ops.forEach(applyLocal); CACHE = {}; }
const lastBankDate = acc => DB.mouvements.filter(o => o.compte === acc && String(o.ref || '').startsWith('bk|')).reduce((m, o) => o.date > m ? o.date : m, '');
function ingest(acc, tx, solde, st) {
  const S = st || v3(acc), res = { n: 0, auto: 0, todo: 0, recal: 0 };
  if (!S || !S.debut) return res;
  const refs = new Set(DB.mouvements.filter(o => o.compte === acc && o.ref).map(o => o.ref));
  const manual = DB.mouvements.filter(o => o.compte === acc && !o.ref && o.type !== 'ajust');
  const seen = {};
  tx.filter(t => t.date >= S.debut).sort((x, y) => x.date.localeCompare(y.date)).forEach(t => {
    let ref = 'bk|' + t.date + '|' + r2(t.montant) + '|' + motifOf(t.libelle); seen[ref] = (seen[ref] || 0) + 1; if (seen[ref] > 1) ref += '#' + seen[ref];
    if (refs.has(ref)) return;
    // saisie à la main déjà là (même montant à ± 4 jours) : c'est la même opération
    const mo = manual.find(x => Math.abs((num(x.montant) || 0) - t.montant) < 0.01 && Math.abs(dDiff(x.date, t.date)) <= 4);
    if (mo) { manual.splice(manual.indexOf(mo), 1); stage([upd('Mouvements', { id: mo.id, ref, date: t.date })]); return; }
    const o = { id: uid(), compte: acc, date: t.date, montant: r2(t.montant), libelle: String(t.libelle || '').slice(0, 120), nom: '', categorie: '', type: '', lien: '', auto: '', ref, profil: ME || '', livret: '' };
    const extra = st ? [] : autoClass(o);
    stage([upd('Mouvements', o)].concat(extra));
    res.n++; if (o.auto) res.auto++; if (!o.type) res.todo++;
  });
  if (solde && typeof solde.montant === 'number') {
    if (st) { // démarrage : solde de départ = solde de la banque − opérations depuis le début du cycle
      const sum = DB.mouvements.filter(o => o.compte === acc && o.date >= S.debut && o.date <= solde.date).reduce((a, o) => a + (num(o.montant) || 0), 0);
      stage([upd('Cycles', { id: acc + '|' + S.mois, compte: acc, mois: S.mois, debut: S.debut, montant: S.montant || '', soldeDepart: r2(solde.montant - sum), manuel: 'b' })]);
    } else if (solde.date >= S.debut) { // recalage : la banque fait foi
      const b = balanceAt(acc, solde.date), delta = b === null ? 0 : r2(solde.montant - b);
      if (Math.abs(delta) >= 1) { stage([upd('Mouvements', { id: uid(), compte: acc, date: solde.date, montant: delta, libelle: 'Correction (solde de la banque)', nom: 'Correction (solde de la banque)', categorie: '', type: 'ajust', lien: '', auto: '', ref: '', profil: '' })]); res.recal = delta; }
    }
  }
  return res;
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

// Lecture de la banque (V3) : à partir du début du suivi du compte, 10 jours de recouvrement (les doublons sont ignorés)
// o.start = { compte: {debut, mois, montant} } : premier passage, le solde de départ est calculé depuis la banque
async function bankSync(o) {
  o = o || {};
  if (BK.busy || !bkOn() || !JETON()) return;
  const linked = bkLinked().filter(a => started3(a) || (o.start && o.start[a])); if (!linked.length) return;
  BK.busy = true; BK.msg = ''; render();
  const depuis = {};
  linked.forEach(acc => { const S = (o.start && o.start[acc]) || v3(acc), last = lastBankDate(acc), d = last ? isoAdd(last, -10) : S.debut; depuis[acc] = d > S.debut ? d : S.debut; });
  try {
    const j = await api({ action: 'banqueSync', depuis, comptes: linked, force: !!o.force });
    if (j.acces) store.set('le31-acces', j.acces);
    received(j.data, j.moi);
    BK.last = Date.now(); store.set('le31-bk-last', BK.last);
    const tot = { n: 0, auto: 0, todo: 0, recal: 0, k: 0 };
    (j.comptes || []).forEach(c => {
      BK.err[c.compte] = c.erreur === 'recent' ? '' : c.erreur;
      if (c.erreur) return;
      const r = ingest(c.compte, c.tx || [], c.solde, o.start && o.start[c.compte]);
      tot.n += r.n; tot.auto += r.auto; tot.todo += r.todo; tot.recal += r.recal || 0; tot.k++;
    });
    if (tot.n) BK.res = tot;
    commit([]);
  } catch (e) { BK.msg = String(e.message || e); }
  BK.busy = false;
  render();
}
function bankAuto() {
  if (!BK.auto || BK.busy || BK.view || !LOADED || !bkOn() || bkPend()) return;
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
    toast('Compte' + (used.length > 1 ? 's reliés' : ' relié'));
    if (used.some(started3)) await bankSync({ force: true });
  } catch (e) { BK.busy = false; toast('Banque : ' + (e.detail || e.message)); render(); }
}
async function bankUnlink(acc) {
  try { const j = await api({ action: 'banqueDelier', compte: acc }); received(j.data, j.moi); toast('Compte délié : saisie à la main'); } catch (e) { toast('Erreur : ' + e.message); }
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
  el.hidden = !bkOn() || !r || !!gate() || !!BK.view;
  if (el.hidden) return;
  const warn = bkDays(r) <= 7 || BK.err[acc] === 'expire';
  el.className = 'bkchip' + (BK.busy ? ' busy' : warn || BK.err[acc] ? ' warn' : '');
  el.innerHTML = BK.busy ? '<span class="spin"></span>Banque…' : warn ? '⚠ Banque' : `✓ Banque${bkTime(acc) ? ' · ' + bkTime(acc) : ''}`;
  el.title = warn ? 'Accord bancaire à renouveler' : 'Lire la banque maintenant';
}
// bandeaux de l'accueil
function bankBanners(acc) {
  if (!bkOn()) return '';
  let h = ''; const r = bkRow(acc), e = BK.err[acc];
  if (BK.res && BK.res.n > 0) h += `<div class="banner good"><span><b>${BK.res.n} nouvelle${BK.res.n > 1 ? 's' : ''} opération${BK.res.n > 1 ? 's' : ''}</b> de la banque${BK.res.auto ? ` · ${BK.res.auto} classée${BK.res.auto > 1 ? 's' : ''} seule${BK.res.auto > 1 ? 's' : ''}` : ''}${BK.res.todo ? ` · <b>${BK.res.todo} à classer</b>` : ''}</span><span style="display:flex;gap:6px">${BK.res.todo ? '<button class="btn small" data-tab="todo">Voir</button>' : ''}<button class="btn ghost small" data-bkok="1">OK</button></span></div>`;
  if (r && (e === 'expire' || bkDays(r) < 0)) h += `<div class="banner warn"><span>L'accord avec <b>${esc(r.aspsp)}</b> est terminé : Le 31 ne lit plus ce compte.</span><button class="btn small" data-bkrenew="${esc(acc)}">Renouveler</button></div>`;
  else if (r && bkDays(r) <= 7) h += `<div class="banner warn"><span>L'accord avec <b>${esc(r.aspsp)}</b> se termine dans <b>${bkDays(r)} jour${bkDays(r) > 1 ? 's' : ''}</b>.</span><button class="btn small" data-bkrenew="${esc(acc)}">Renouveler</button></div>`;
  if (r && e === 'limite') h += `<div class="banner warn"><span>${esc(r.aspsp)} limite le nombre de lectures par jour : nouvel essai plus tard. Données du ${esc(bkTime(acc) || 'dernier passage')}.</span></div>`;
  else if (r && e && e !== 'expire') h += `<div class="banner warn"><span>Lecture de la banque impossible pour l'instant (${esc(e)}).</span><button class="btn ghost small" data-bksync="1">Réessayer</button></div>`;
  if (BK.msg && BK.msg !== 'safari') h += `<div class="banner warn"><span>Banque : ${esc(BK.msg)}</span><button class="btn ghost small" data-bksync="1">Réessayer</button></div>`;
  return h;
}
// Réglages > Connexion bancaire
function vBankSet() {
  const head = `<div class="rowhead"><h2>Connexion bancaire</h2></div>`;
  if (!bkOn()) return `<div class="hero" style="gap:10px">${head}<div class="hint" style="font-size:13px">Pas encore configurée. La personne qui a installé Le 31 la met en place une fois : application Enable Banking (tuto <b>4-ENABLE-BANKING</b>), puis menu <b>Le 31 > Connexion bancaire</b> dans le Google Sheet. En attendant, les opérations se saisissent à la main.</div></div>`;
  const row = a => { const r = bkRow(a.id), d = bkDays(r);
    return `<div class="item" style="grid-template-columns:40px 1fr auto" disabled><span class="day" style="${r ? 'background:var(--good-soft);color:var(--good)' : ''}">${r ? '✓' : '—'}</span><span class="lbl"><b>${esc(a.nom)}</b><small>${r ? `${esc(r.aspsp)} ${esc(r.fin)} · ${d < 0 ? '<span style="color:var(--bad)">accord terminé</span>' : 'accord jusqu\'au ' + fmtD(r.jusqua)}${r.derniere ? ' · lu ' + esc(bkTime(a.id)) : ''}` : 'Pas relié : saisie à la main'}</small></span>
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
      <div class="list">${l.map(b => `<button class="item" style="grid-template-columns:1fr auto" data-bkbank="${esc(b.n)}" ${BK.busy ? 'disabled' : ''}><span class="lbl"><b>${esc(b.n)}</b></span><span>›</span></button>`).join('') || '<div class="empty">Banque introuvable : elle n\'est peut-être pas couverte. La saisie à la main reste possible.</div>'}</div>
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
    ${chosen.filter(a => !started3(a)).map(acc => `<div class="note">${esc(accName(acc))} : le suivi démarre ensuite depuis l'accueil (date de début du cycle), la banque est lue à partir de cette date.</div>`).join('')}
    <button class="btn" data-bklier="1" ${BK.busy ? 'disabled' : ''}>${BK.busy ? 'Enregistrement…' : 'Valider'}</button></section>`;
}
// annuler l'association : la session bancaire est refermée côté serveur
async function bankLinkCancel() { const P = bkPend(); if (!P) return; try { const j = await api({ action: 'banqueLier', sid: P.sid, liens: [] }); received(j.data, j.moi); } catch (e) {} }

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
/* ================= Premier lancement ================= */
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
  ops.push(upd('Comptes', { id: 'perso-' + p1, nom: 'Perso ' + O.name, proprietaire: p1, soldeDepart: '', moisDepart: '', seuil: 200, ordre: 1 }));
  if (O.mode === 'duo') ops.push(upd('Profils', { id: 'p' + uid(), nom: O.partner, perso: 'oui', ordre: 2 }));
  if (O.mode === 'duo' || O.commun) ops.push(upd('Comptes', { id: 'commun', nom: 'Compte commun', proprietaire: '', soldeDepart: '', moisDepart: '', seuil: 150, ordre: 2 }));
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
  commit([upd('Comptes', { id, nom: 'Perso ' + p.nom, proprietaire: ME, soldeDepart: '', moisDepart: '', seuil: 200, ordre: 1 })]);
}


/* ================= Interface ================= */
const UI = { acc: store.get('le31-compte', ''), tab: 'home', txTab: 'ponct', txSeg: 'real', cyc: {}, jpj: store.get('le31-jpj', true), jpjAll: false,
  td: {}, simTab: 'achat', theme: store.get('le31-theme', 'auto'), startAcc: {},
  calTab: 'cyc', mpm: store.get('le31-mpm', 'g'), mpmOpen: store.get('le31-mpmo', false), epM: '', epL: '', epS: 'tot', epMpmOpen: store.get('le31-epmo', false), epMpm: store.get('le31-epmpm', 'g'), eplAll: false };
const main = $('main');
const VIEWS = { home: () => vHome(), todo: () => vTodo(), tx: () => vTx(), bud: () => vBud(), plus: () => vPlus(), cal: () => vCal(), sim: () => vSim(), set: () => vSet(), epa: () => vEpa(), epl: () => vEpl() };
const todoCount = acc => DB.mouvements.filter(o => o.compte === acc && !o.type).length;
function render() {
  refreshNow();
  if (!DB.comptes.find(a => a.id === UI.acc) && DB.comptes.length) UI.acc = accs()[0].id;
  $('foot').textContent = 'Le 31 · V' + APP_VERSION;
  const tabOf = { cal: 'plus', sim: 'plus', set: 'plus', epa: 'plus', epl: 'plus' }[UI.tab] || UI.tab;
  document.querySelectorAll('nav.tabs button').forEach(b => b.setAttribute('aria-current', b.dataset.tab === tabOf));
  const blocked = BK.view === 'retour' ? null : gate();
  const bkv = !blocked && (BK.view || (bkPend() ? 'map' : null));
  $('tabs').hidden = !!blocked || !!bkv;
  $('accSeg').hidden = !!blocked || !!bkv || accs().length < 2 || ['plus', 'set', 'epl'].includes(UI.tab);
  $('accSeg').innerHTML = accs().map(a => { const n = UI.tab === 'todo' ? todoCount(a.id) : 0; return `<button data-acc="${esc(a.id)}" aria-pressed="${a.id === UI.acc}">${esc(shortAcc(a.id))}${UI.tab === 'todo' ? ' · ' + n : ''}</button>`; }).join('');
  const nb = accs().reduce((a, x) => a + todoCount(x.id), 0), bd = $('todoBadge'); if (bd) { bd.textContent = nb; bd.hidden = !nb; }
  try { main.innerHTML = blocked || (bkv ? vBank() : (VIEWS[UI.tab] || VIEWS.home)()); }
  catch (e) { console.error(e); main.innerHTML = `<section class="view"><div class="note bad">Un problème d'affichage est survenu : ${esc(e.message)}. Recharge l'appli.</div></section>`; }
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
      const why = E === 'delai' ? "Le serveur n'a pas répondu à temps." : E === 'reseau' ? "Impossible de joindre le serveur (réseau, ou adresse du serveur incorrecte dans le lien)."
        : E === 'html' ? "L'adresse du serveur contenue dans le lien ne répond pas comme prévu (déploiement pas en « Tout le monde » ?)." : E === 'serveur' ? 'Le serveur a rencontré une erreur.' : 'Erreur : ' + esc(E);
      return `<section class="view center">${logo}<h2>Connexion impossible</h2><p class="hint" style="font-size:14px">${why}</p>
        ${JOIN.detail ? `<div class="note" style="text-align:left;font-size:12px;word-break:break-word">Détail : ${esc(JOIN.detail)}</div>` : ''}
        <div class="note" style="text-align:left;font-size:13px">Adresse du serveur dans ton lien :<br><b style="word-break:break-all">${esc(short)}</b></div>
        <button class="btn" data-joinretry="1">Réessayer</button>${paste}</section>`;
    }
    return `<section class="view center">${logo}<p class="hint">Connexion de cet appareil…</p></section>`;
  }
  if (!JETON() || !apiOk() || isAccessErr(SYNC.error)) {
    const E = JOIN.err, cut = isAccessErr(SYNC.error) && JETON();
    const msg = E === 'utilisee' ? "Ce lien a déjà servi : chaque lien ne marche qu'une fois. Demande un nouveau lien." : E === 'expiree' ? 'Ce lien a expiré (14 jours). Demande-en un nouveau.'
      : E === 'annulee' ? 'Ce lien a été remplacé par un plus récent : utilise le dernier lien reçu.' : E === 'reseau' ? 'Pas de réseau : réessaie dès que possible.' : E ? 'Lien non reconnu.'
      : cut ? "L'accès de cet appareil a été coupé. Demande un nouveau lien pour le reconnecter." : "Ouvre le lien d'accès reçu par message pour relier l'appli à vos comptes.";
    return `<section class="view center">${logo}<h2>${cut ? 'Accès coupé' : E ? 'Lien refusé' : 'Bienvenue'}</h2><p class="hint" style="font-size:14px">${msg}</p>${paste}</section>`;
  }
  if (!LOADED) return `<section class="view center">${logo}<p class="hint">${SYNC.state === 'off' ? 'Pas de réseau pour le premier chargement. Réessaie dès que possible.' : 'Chargement des comptes…'}</p>${SYNC.state === 'off' ? '<button class="btn ghost" data-retry="1">Réessayer</button>' : ''}</section>`;
  if (ME === '') return vOnboard();
  if (!DB.comptes.length) return `<section class="view center">${logo}<p class="hint">Aucun compte visible pour ce profil.</p></section>`;
  return null;
}

/* ----- Outils d'affichage ----- */
const money = v => `<span class="mono">${sgn(v)}</span>`;
const nbM = v => (v < -0.004 ? '−' : '') + eur(Math.abs(v)).replace(/\s?€/, '');
const eurM = v => (v < -0.004 ? '− ' : '') + eur(Math.abs(v)).replace(/\s?€/, '') + ' €';
const selCycle = acc => (UI.cyc[acc] && cycleByMois(acc, UI.cyc[acc])) || curCycle(acc);
function cycNav(acc, c) {
  const cy = cyclesOf(acc), cur = curCycle(acc);
  const prev = c.i > 0, next = c.i < Math.min(cy.length - 1, cur.i + 11);
  return `<div class="cycnav"><button class="nb" data-cyc="-1" ${prev ? '' : 'disabled'} aria-label="Cycle précédent">‹</button>
    <div class="cyct"><b>Cycle ${deMois(c.mois)}${pm(c.mois).y !== pm(labelMonth(TODAY_ISO)).y ? ' ' + pm(c.mois).y : ''}</b><span class="mono">${fmtJ(c.debut)} → ${fmtJ(c.fin)}${c.debut <= TODAY_ISO && TODAY_ISO <= c.fin ? ` · J${dDiff(c.debut, TODAY_ISO) + 1}/${dDiff(c.debut, c.fin) + 1}` : ''}</span></div>
    <button class="nb" data-cyc="1" ${next ? '' : 'disabled'} aria-label="Cycle suivant">›</button></div>`;
}
const progBar = c => { const n = dDiff(c.debut, c.fin) + 1, k = Math.max(0, Math.min(n, dDiff(c.debut, TODAY_ISO) + 1)); return `<div class="prog"><i style="width:${Math.round(100 * k / n)}%"></i></div>`; };

/* ----- Démarrage du suivi d'un compte ----- */
// Pré-remplissage facultatif du démarrage (window.LE31_PREFILL, absent de l'appli livrée : utilisé par les tests).
// Forme : { label, perso: { qui (regex du prénom), debut, montant, jour, budgets, cats, dates, prevues, epargne, primes }, commun: { … } }
const PREFILL = (typeof window !== 'undefined' && window.LE31_PREFILL) || null;
const EPA_DEF = { perso: [['Livret A', 'livret'], ['LDD', 'livret'], ['Investissement', 'invest']], commun: [['Livret commun', 'livret']] };
const CATS_DEF = ['Courses', 'Carburant', 'Restaurants', 'Loisirs', 'Shopping', 'Santé', 'Abonnement', 'Crédit', 'Épargne', 'Divers'];
const excelFor = acc => (PREFILL && PREFILL[isPerso(acc) ? 'perso' : 'commun']) || null;
const excelLikely = acc => { const X = excelFor(acc); return !!X && (!isPerso(acc) || !X.qui || new RegExp(X.qui, 'i').test(pname(accOf(acc).proprietaire))); };
function defStart(acc) {
  const j = 26, d = TODAY >= j ? CUR + '-' + j : addM(CUR, -1) + '-' + j, X = excelFor(acc);
  return excelLikely(acc) && X.debut && labelMonth(X.debut) === labelMonth(d) ? X.debut : d;
}
function vStart(acc) {
  const P = isPerso(acc), X = excelFor(acc), ex = excelLikely(acc), bk = !!bkRow(acc), f = UI.startAcc[acc] || {};
  return `<section class="view">${bankBanners(acc)}<div class="hero" style="gap:14px">
    <div class="rowhead"><h2>Démarrer le suivi · ${esc(shortAcc(acc))}</h2></div>
    <p class="hint" style="font-size:13px;margin:0">Le 31 suit ce compte par cycles : ${P ? 'du jour du salaire à la veille du suivant' : "de l'arrivée du virement de début de cycle à la veille du suivant"}. ${bk ? 'La banque est lue à partir du début du cycle (rien avant) et toutes les opérations arrivent dans « À classer ».' : ''}</p>
    <form class="form" id="startForm" data-acc="${esc(acc)}" novalidate>
      <div class="field"><label for="stD">${P ? 'Début du cycle en cours (jour du salaire)' : 'Début du cycle en cours (arrivée du virement)'}</label><input type="date" id="stD" value="${esc(f.debut || defStart(acc))}" max="${TODAY_ISO}"></div>
      ${P ? '' : `<div class="field"><label for="stN">Nom de ce virement</label><input id="stN" value="${esc(f.nom || (ex ? X.nom : ''))}" placeholder="Ex. Virement du conjoint"></div>`}
      <div class="two"><div class="field"><label for="stM">${P ? 'Salaire net habituel (€)' : 'Montant habituel (€)'}</label><input id="stM" inputmode="decimal" value="${esc(f.montant != null ? f.montant : ex ? fr(X.montant) : '')}"></div>
      <div class="field"><label for="stJ">Jour habituel</label><input id="stJ" inputmode="numeric" value="${esc(f.jour || 26)}"></div></div>
      ${bk ? `<label class="check"><input type="checkbox" id="stBk" checked><span><b>Solde de départ lu à la banque</b><br><small class="mini">Recommandé : solde de la banque moins les opérations depuis le début du cycle.</small></span></label>` : ''}
      <div class="field" id="stSWrap" ${bk ? 'hidden' : ''}><label for="stS">Solde juste avant ${P ? 'le salaire' : 'le virement'} (€)</label><input id="stS" inputmode="decimal" placeholder="Ex. 0,00"></div>
      ${ex ? `<label class="check"><input type="checkbox" id="stX" checked><span><b>${esc(PREFILL.label || 'Pré-remplir')}</b><br><small class="mini">Budgets, dates et prévues proposés. Les charges fixes viennent de ton classement.</small></span></label>` : ''}
      <button class="btn" type="submit" ${BK.busy ? 'disabled' : ''}>${BK.busy ? '<span class="spin"></span> Lecture de la banque…' : 'Démarrer'}</button>
    </form></div></section>`;
}
async function startAccount(acc) {
  const d = $('stD').value, m = num($('stM').value), j = Math.min(31, Math.max(1, num($('stJ').value) || 26));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || d > TODAY_ISO) { toast('Indique la date de début du cycle (passée)'); return; }
  const bk = $('stBk') && $('stBk').checked, s = num($('stS').value);
  if (!bk && s === null) { toast('Indique le solde de départ'); return; }
  const S = { debut: d, mois: labelMonth(d), montant: m === null ? '' : r2(m), jour: j };
  const ops = [isPerso(acc) ? regOp(acc, 'v3', S) : upd('Parametres', { cle: 'v3|' + acc, valeur: JSON.stringify(S) })];
  if (isPerso(acc) && !DB.reglages.some(r => r.id === acc + '|salaire')) ops.push(regOp(acc, 'salaire', defaultPlan(acc, $('stX') && $('stX').checked)));
  if ($('stN') && $('stN').value.trim()) ops.push(upd('Parametres', { cle: 'v3nomrev|' + acc, valeur: $('stN').value.trim() }));
  ops.push(upd('Cycles', { id: acc + '|' + S.mois, compte: acc, mois: S.mois, debut: d, montant: S.montant, soldeDepart: bk ? '' : r2(s), manuel: bk ? '' : 's' }));
  const X = $('stX') && $('stX').checked ? excelFor(acc) : null;
  let ordre = Math.max(0, ...budgetsOf(acc).map(b => num(b.ordre) || 0));
  const have = new Set(budgetsOf(acc).map(b => b.nom.toLowerCase()));
  const addB = (nom, bud) => { if (have.has(nom.toLowerCase())) { const b = budgetsOf(acc).find(x => x.nom.toLowerCase() === nom.toLowerCase()); if (bud) ops.push(upd('Budgets', { id: b.id, budget: bud })); return; } have.add(nom.toLowerCase()); ops.push(upd('Budgets', { id: uid(), compte: acc, nom, budget: bud || '', ordre: ++ordre })); };
  if (X) {
    X.budgets.forEach(([n, b]) => addB(n, b)); X.cats.forEach(n => addB(n, ''));
    Object.entries(X.dates).forEach(([k, dt]) => { if (k > S.mois) ops.push(upd('Cycles', { id: acc + '|' + k, compte: acc, mois: k, debut: dt, montant: '', soldeDepart: '', manuel: '' })); });
    X.prevues.forEach(([dt, l, v, c]) => { if (dt >= d) ops.push(upd('Prevues', { id: uid(), compte: acc, date: dt, libelle: l, montant: v, categorie: c, etat: '', lien: '' })); });
  } else if (!budgetsOf(acc).length) CATS_DEF.forEach(n => addB(n, ''));
  commit(ops);
  UI.startAcc[acc] = null; UI.cyc[acc] = null;
  if (bk) { await bankSync({ force: true, start: { [acc]: S } }); if (!num((DB.cycles.find(c => c.id === acc + '|' + S.mois) || {}).soldeDepart) && (DB.cycles.find(c => c.id === acc + '|' + S.mois) || {}).soldeDepart === '') toast('Solde de la banque indisponible : saisis le solde de départ dans Calendrier salaires'); }
  toast('Suivi démarré'); render();
}

/* ----- Accueil ----- */
function vHome() {
  const acc = UI.acc; if (!started3(acc)) return vStart(acc);
  const c = selCycle(acc), R = cycleCalc(acc, c), nTodo = todoCount(acc);
  const bigLbl = R.isCur ? 'Solde actuel' : R.isPast ? 'Solde de fin (réel)' : 'Solde de départ (projeté)';
  const bigV = R.isCur ? R.soldeActuel : R.isPast ? R.realEnd : R.depart;
  const neg = R.atterAvec < 0;
  return `<section class="view">${bankBanners(acc)}
    <div class="block">${cycNav(acc, c)}${R.isCur ? progBar(c) : ''}</div>
    <div class="bigsolde"><small>${bigLbl}</small><b class="mono">${eurM(bigV)}</b>${num(c.row.soldeDepart) === null || c.row.soldeDepart === '' ? (c.i === 0 ? '<span class="mini warn">Solde de départ à renseigner (Calendrier salaires)</span>' : '') : ''}</div>
    <div class="kpis">
      <div class="kv1"><span>Atterrissage sans budget</span><b class="mono">${eurM(R.atterSans)}</b></div>
      <div class="kv1"><span>Budget restant</span><b class="mono">${R.reserve ? '− ' + eurM(R.reserve) : eurM(0)}</b></div>
      <div class="kv1 main ${neg ? 'neg' : ''}"><span>Atterrissage avec budget</span><b class="mono">${neg ? '▼ ' : ''}${eurM(R.atterAvec)}</b></div>
    </div>
    ${nTodo ? `<button class="todoline" data-tab="todo"><span><b>${nTodo}</b> opération${nTodo > 1 ? 's' : ''} à classer</span><span>›</span></button>` : ''}
    ${vJpj(acc, c, R)}
    ${vMpm(acc)}
  </section>`;
}
function vJpj(acc, c, R) {
  const rows = []; let marked = !R.isCur;
  const todayMark = `<div class="todaymark"><i></i>AUJOURD'HUI<i></i></div>`;
  R.days.forEach(dd => {
    if (!marked && dd.d > TODAY_ISO) { rows.push(todayMark); marked = true; }
    if (!dd.items.length && !UI.jpjAll) return;
    const fut = dd.d > TODAY_ISO, l = dd.items, one = l.length === 1 ? l[0] : null;
    const lab = !l.length ? '<span class="mini">—</span>' : one ? `${esc(one.label)}${one.real ? (one.kind === 'todo' ? ' <span class="tag w">à classer</span>' : '') : ` <span class="mini">· ${one.late ? 'pas encore vu' : 'prévu'}</span>`}`
      : `${l.length} mouvements<small>${l.map(x => `${esc(x.label)} ${eurM(x.v).replace('− ', '−')}`).join(' · ')}</small>`;
    rows.push(`<div class="dayrow ${fut || (l.length && l.every(x => !x.real)) ? 'fut' : ''}"><span class="mono dd">${wd(dd.d)} ${fmtJ(dd.d)}</span><span class="dl">${lab}</span><span class="mono dv">${l.length ? `<span class="${dd.mv > 0 ? 'pos' : ''}">${sgn(dd.mv)}</span>` : ''}<small>${eurM(dd.bal)}</small></span></div>`);
  });
  if (!marked) rows.push(todayMark);
  return `<details class="jpj" id="jpj" ${UI.jpj ? 'open' : ''}><summary>Jour par jour<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M6 9l6 6 6-6"/></svg></summary>
    <div class="dayhead2"><span>Départ ${fmtJ(c.debut)}</span><span class="mono">${eurM(R.depart)}</span></div>
    ${rows.join('')}
    <button class="linkbtn" data-jpjall="1">${UI.jpjAll ? 'Masquer les jours sans mouvement' : 'Afficher aussi les jours sans mouvement'}</button></details>`;
}

/* ----- À classer ----- */
function vTodo() {
  const acc = UI.acc; if (!started3(acc)) return vStart(acc);
  const list = DB.mouvements.filter(o => o.compte === acc && !o.type).sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  const c = curCycle(acc), S = v3(acc);
  const autos = DB.mouvements.filter(o => o.compte === acc && o.auto === '1' && o.date >= (c ? c.debut : '')).sort((a, b) => b.date.localeCompare(a.date));
  if (!list.some(o => o.id === UI.td.id)) UI.td = list.length ? { id: list[0].id } : {};
  const first = c && c.i === 0;
  return `<section class="view">
    <div class="rowhead"><h2 class="title">À classer</h2><span class="mono mini">${list.length} opération${list.length > 1 ? 's' : ''}</span></div>
    <p class="hint" style="font-size:13px;margin:-8px 0 0">${first ? `Opérations reçues de la banque depuis le début du cycle ${deMois(S.mois)} (${fmtJ(S.debut)}). Elles comptent déjà dans le solde ; il reste à dire ce qu'elles sont. Ce que tu classes ce mois-ci sert ensuite à classer tout seul.` : 'Le reste a été classé tout seul d\'après tes choix. Ici, seulement les cas de doute et les nouveaux marchands.'}</p>
    ${list.length ? list.map(o => o.id === UI.td.id ? todoCard(o) : todoRow(o)).join('') : '<div class="note good">Rien à classer.</div>'}
    ${autos.length ? `<div class="rowhead" style="margin-top:6px"><span class="sublbl">Classées automatiquement · ${autos.length}</span></div>
      <div class="list">${autos.slice(0, UI.autoAll ? 999 : 6).map(o => `<button class="item" data-oid="${esc(o.id)}" style="grid-template-columns:1fr auto"><span class="lbl"><b>${esc(nameOf(o))}<span class="tag g">AUTO</span></b><small>${fmtJ(o.date)} · ${esc(o.type === 'fixe' ? 'fixe ✓' + (o.categorie ? ' · ' + o.categorie : '') : o.type === 'sal' ? 'début du cycle · Calendrier' : o.categorie || TYPES[o.type])}</small></span><span class="amt ${num(o.montant) > 0 ? 'pos' : ''}">${sgn(num(o.montant))}</span></button>`).join('')}</div>
      ${autos.length > 6 ? `<button class="linkbtn" data-autoall="1">${UI.autoAll ? 'Moins' : 'Tout voir'}</button>` : ''}
      <p class="hint">Touche une ligne pour la corriger : la règle est corrigée pour les mois suivants.</p>` : ''}
  </section>`;
}
function todoRow(o) {
  const s = suggest(o), v = num(o.montant) || 0;
  return `<div class="todorow"><div class="tl"><b>${esc(o.libelle)}</b><span class="mono mini">${wd(o.date)} ${fmtJ(o.date)}</span>${s && s.why ? `<span class="sug">${esc(s.why)}</span>` : s && s.kind === 'fixe' ? `<span class="sug">Fixe « ${esc(s.r.libelle)} » ?</span>` : s && s.kind === 'epargne' ? `<span class="sug">Épargne · ${livName(livOf(s.livret))} ?</span>` : ''}</div>
    <div class="tr"><span class="mono ${v > 0 ? 'pos' : ''}">${sgn(v)}</span><span class="qb2"><button class="qb" data-tsel="${esc(o.id)}" data-tk="ponct">Ponctuel</button>${s && s.kind === 'epargne' ? `<button class="qb" data-tsel="${esc(o.id)}" data-tk="epargne">Épargne</button>` : `<button class="qb" data-tsel="${esc(o.id)}" data-tk="${v > 0 && !s ? 'sal' : 'fixe'}">${v > 0 && !s ? 'Revenu' : 'Fixe'}</button>`}</span></div></div>`;
}
function todoCard(o) {
  const acc = o.compte, v = num(o.montant) || 0, s = suggest(o), T = UI.td;
  const Ls = livretsOf(acc);
  if (T.liv === undefined) T.liv = s && s.kind === 'epargne' ? s.livret : ((Ls.find(L => NORM(o.libelle || '').includes(NORM(L.nom))) || {}).id || '');
  if (!T.kind) T.kind = s && (s.kind === 'fixe' || s.kind === 'sal' || s.kind === 'prime' || s.kind === 'epargne') ? s.kind : T.liv && Ls.length ? 'epargne' : 'ponct';
  if (T.cat === undefined) T.cat = s && s.kind === 'ponct' && s.cats.length === 1 ? s.cats[0] : s && s.kind === 'fixe' ? (s.r.categorie || '') : (ruleOf3(acc, skOf(o)) || {}).categorie && !String(ruleOf3(acc, skOf(o)).categorie).includes('|') ? ruleOf3(acc, skOf(o)).categorie : '';
  if (T.rec === undefined) T.rec = s && s.kind === 'fixe' ? s.r.id : '';
  const cats = catNames(acc), recs = DB.recurrents.filter(r => r.compte === acc && bool(r.actif) && (r.sens === '+') === (v > 0));
  const kinds = [['ponct', 'Ponctuel'], ['fixe', 'Fixe']].concat(v > 0 ? [['sal', isPerso(acc) ? 'Salaire' : 'Début de cycle']] : []).concat(Ls.length ? [['epargne', 'Épargne']] : []).concat(s && s.kind === 'prime' ? [['prime', 'Prime']] : []);
  const rule = ruleOf3(acc, skOf(o));
  let sugg = '';
  if (s && s.kind === 'fixe') sugg = `<div class="sug">Fixe « ${esc(s.r.libelle)} » ?${s.why ? ' ' + esc(s.why) : ''}</div>`;
  else if (s && s.kind === 'sal') sugg = `<div class="sug">${esc(salLabel(acc))} ?${s.why ? ' ' + esc(s.why) : ''}</div>`;
  else if (s && s.kind === 'prime') sugg = `<div class="sug">${esc(s.p.nom)} du ${fmtJ(s.p.date)} ?</div>`;
  else if (s && s.kind === 'epargne') sugg = `<div class="sug">Épargne · ${livName(livOf(s.livret))} ?</div>`;
  else if (s && s.why) sugg = `<div class="sug">${esc(s.why)}</div>`;
  const chips = `<div class="chips" id="tdCats">${cats.map(n => `<button type="button" class="chip" data-tcat="${esc(n)}" aria-pressed="${T.cat === n}">${esc(n)}</button>`).join('')}<button type="button" class="chip" data-tcat="__new" aria-pressed="${T.cat === '__new'}">+ Nouvelle</button></div>
    <input id="tdCatNew" placeholder="Nouvelle catégorie" ${T.cat === '__new' ? '' : 'hidden'} value="${esc(T.catNew || '')}">`;
  let body = '';
  if (T.kind === 'ponct') body = `<div class="field"><label for="tdNom">Nom</label><input id="tdNom" value="${esc(T.nom != null ? T.nom : nameOf(o))}"></div>
    <div class="field"><label>Catégorie</label>${chips}</div>
    ${s && s.why && s.cats && s.cats.length > 1 ? `<button type="button" class="linkbtn" data-seuil="${esc(o.id)}">Séparer ce marchand par montant…</button>` : ''}`;
  else if (T.kind === 'fixe') {
    const nr = T.rec === '' || !recOf(T.rec);
    body = `<div class="field"><label for="tdRec">Charge fixe</label><select id="tdRec">${recs.map(r => `<option value="${esc(r.id)}" ${r.id === T.rec ? 'selected' : ''}>${esc(r.libelle)} · le ${esc(r.jour)} · ${eurM(num(r.montant))}</option>`).join('')}<option value="" ${nr ? 'selected' : ''}>Nouvelle charge fixe…</option></select></div>
    ${nr ? `<div class="field"><label for="tdNom">Nom</label><input id="tdNom" value="${esc(T.nom != null ? T.nom : nameOf(o))}"></div>
      <div class="two"><div class="field"><label for="tdJour">Jour du mois</label><input id="tdJour" inputmode="numeric" value="${esc(T.jour || +o.date.slice(8, 10))}"></div><div class="field"><label for="tdMt">Montant habituel (€)</label><input id="tdMt" inputmode="decimal" value="${esc(T.mt != null ? T.mt : fr(Math.abs(v)))}"></div></div>` : ''}
    ${nr && v < 0 ? livSelect(acc, T.liv, 'tdLiv') : ''}
    <div class="field"><label>Catégorie</label>${chips}</div>`;
  } else if (T.kind === 'epargne') {
    body = `<div class="field"><label>${v < 0 ? 'Versement vers' : 'Retrait depuis'}</label><div class="chips">${Ls.map(L => `<button type="button" class="chip" data-tliv="${esc(L.id)}" aria-pressed="${T.liv === L.id}">${livName(L)}</button>`).join('')}</div></div>
      <div class="hint">${v < 0 ? 'Le livret augmente de ' + eurM(-v) : 'Le livret baisse de ' + eurM(v) + ', ton compte monte'}. Pour un virement qui revient chaque mois, choisis plutôt « Fixe » et lie-le au livret : il sera reconnu seul ensuite.</div>`;
  } else if (T.kind === 'prime') {
    body = `<div class="note">Reconnue comme <b>${esc(s.p.nom)}</b> du ${fmtJA(s.p.date)} (attendu ${eurM(s.p.v)}), réglée dans Calendrier salaires → Évolution du salaire.</div>`;
  } else {
    const k = labelMonth(o.date);
    body = `<div class="note">Début du cycle ${deMois(k)} le <b>${fmtJ(o.date)}</b>, montant <b>${eurM(v)}</b> : repris dans le Calendrier salaires${(cycleByMois(acc, k) || { man: '' }).man.includes('d') ? ' (sauf la date, saisie à la main)' : ''}.</div>`;
  }
  return `<form class="todocard" id="todoForm" data-id="${esc(o.id)}" novalidate>
    <div class="rowhead"><div class="tl"><b>${esc(o.libelle)}</b><span class="mono mini">${wd(o.date)} ${fmtJ(o.date)}</span></div><span class="mono amt ${v > 0 ? 'pos' : ''}">${sgn(v)}</span></div>
    ${sugg}
    <div class="seg seg${kinds.length}">${kinds.map(([k, l]) => `<button type="button" data-tkind="${k}" aria-pressed="${T.kind === k}">${l}</button>`).join('')}</div>
    ${body}
    <label class="check"><input type="checkbox" id="tdAsk" ${rule && rule.type === 'ask' ? 'checked' : ''}><span class="mini">Toujours me demander pour ce marchand</span></label>
    <button class="btn dark" type="submit">Classer</button>
  </form>`;
}
function readTodo(o) {
  const T = UI.td, h = { type: T.kind, ask: $('tdAsk') ? $('tdAsk').checked : undefined };
  let cat = T.cat || ''; if (cat === '__new') cat = ($('tdCatNew') ? $('tdCatNew').value : '').trim();
  h.categorie = cat;
  if (T.kind === 'ponct') { h.nom = $('tdNom') ? $('tdNom').value.trim() : ''; if (h.nom === smartName(o.libelle || '')) h.nom = ''; }
  if (T.kind === 'fixe') {
    h.recId = $('tdRec') ? $('tdRec').value : '';
    if (!h.recId) h.newRec = { libelle: ($('tdNom').value || '').trim() || nameOf(o), jour: num($('tdJour').value), montant: num($('tdMt').value), livret: $('tdLiv') ? $('tdLiv').value : '' };
  }
  if (T.kind === 'epargne') { h.livret = T.liv || ''; h.categorie = 'Épargne'; }
  if (T.kind === 'prime') { const s = suggest(o); if (s && s.kind === 'prime') { h.key = s.p.key; h.nom = s.p.nom; } }
  return h;
}
function keepTodoInputs() {
  const T = UI.td;
  if ($('tdNom')) T.nom = $('tdNom').value; if ($('tdJour')) T.jour = $('tdJour').value; if ($('tdMt')) T.mt = $('tdMt').value;
  if ($('tdRec')) T.rec = $('tdRec').value; if ($('tdCatNew')) T.catNew = $('tdCatNew').value; if ($('tdLiv')) T.liv = $('tdLiv').value;
}

/* ----- Transactions (Ponctuels | Fixes) ----- */
function vTx() {
  const acc = UI.acc; if (!started3(acc)) return vStart(acc);
  const c = selCycle(acc), R = cycleCalc(acc, c);
  const tabs = `<div class="ultabs"><button data-txtab="ponct" aria-pressed="${UI.txTab === 'ponct'}">Ponctuels</button><button data-txtab="fixe" aria-pressed="${UI.txTab === 'fixe'}">Fixes</button></div>`;
  const head = (btn) => `<div class="rowhead"><h2 class="title">Transactions</h2>${btn}</div>${tabs}`;
  if (UI.txTab === 'fixe') return vFixes(acc, c, R, head(`<button class="btn small pill2" data-newrec="1">＋ Ajouter</button>`));
  const prev = DB.prevues.filter(p => p.compte === acc && !p.etat).sort((a, b) => a.date.localeCompare(b.date));
  const done = DB.prevues.filter(p => p.compte === acc && p.etat).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 5);
  let body;
  if (UI.txSeg === 'prev') body = `<div class="list">${prev.length ? prev.map(p => `<button class="item" data-pid="${esc(p.id)}" style="grid-template-columns:62px 1fr auto"><span class="day">${fmtJ(p.date)}</span><span class="lbl"><b><i>${esc(p.libelle)}</i></b><small>${esc(p.categorie || '')} · prévu${p.date <= TODAY_ISO ? ' (pas encore vu)' : ''}</small></span><span class="amt ${num(p.montant) > 0 ? 'pos' : ''}">${sgn(num(p.montant))}</span></button>`).join('') : '<div class="empty">Aucune opération prévue.</div>'}</div>
    ${done.length ? `<div class="sublbl">Réalisées</div><div class="list">${done.map(p => `<button class="item off" data-pid="${esc(p.id)}" style="grid-template-columns:62px 1fr auto"><span class="day">${fmtJ(p.date)}</span><span class="lbl"><b>${esc(p.libelle)}</b><small>réalisée</small></span><span class="amt">${sgn(num(p.montant))}</span></button>`).join('')}</div>` : ''}
    <p class="hint">Une prévue compte dans l'atterrissage. Elle passe en réalisée quand la banque la remonte (même montant à ± 4 jours) ou d'un geste.</p>`;
  else {
    const l = R.real.filter(o => o.type === 'ponct' || o.type === 'ajust' || !o.type).sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id));
    const tot = r2(l.filter(o => o.type === 'ponct').reduce((a, o) => a + (num(o.montant) || 0), 0));
    const groups = {}; l.forEach(o => (groups[o.date] = groups[o.date] || []).push(o));
    body = `<div class="sumline"><span>Ponctuel du cycle</span><b class="mono">${sgn(tot)}</b></div>
      ${l.length ? `<div class="list">${Object.keys(groups).map(d => `<div class="grp">${wd(d).toUpperCase()} ${dLong(d).toUpperCase()}</div>` + groups[d].map(o => `<button class="item" data-oid="${esc(o.id)}" style="grid-template-columns:1fr auto"><span class="lbl"><b>${esc(nameOf(o))}${!o.type ? '<span class="tag w">à classer</span>' : ''}${o.auto === '1' ? '<span class="tag g">AUTO</span>' : ''}</b><small>${esc(o.type === 'ajust' ? 'Correction' : o.categorie || '—')}${o.ref ? ' · banque' : ' · saisie'}</small></span><span class="amt ${num(o.montant) > 0 ? 'pos' : ''}">${sgn(num(o.montant))}</span></button>`).join('')).join('')}</div>` : '<div class="empty card0">Aucun ponctuel dans ce cycle.</div>'}`;
  }
  return `<section class="view">${head(`<button class="btn small pill2" data-newop="1">＋ Saisir</button>`)}
    ${cycNav(acc, c)}
    <div class="chips"><button class="chip" data-txseg="real" aria-pressed="${UI.txSeg === 'real'}">Réalisées</button><button class="chip" data-txseg="prev" aria-pressed="${UI.txSeg === 'prev'}">Prévues · ${prev.length}</button></div>
    ${body}</section>`;
}
function vFixes(acc, c, R, head) {
  const recs = DB.recurrents.filter(r => r.compte === acc).sort((a, b) => (num(a.jour) || 0) - (num(b.jour) || 0) || a.libelle.localeCompare(b.libelle));
  let seenN = 0, waitN = 0, tot = 0;
  const row = r => {
    const occ = occDates(r, c.debut, c.fin), seen = R.real.filter(o => o.type === 'fixe' && o.lien === r.id), sgnV = r.sens === '+' ? 1 : -1;
    const sv = seen.reduce((a, o) => a + (num(o.montant) || 0), 0), rest = occ.slice(seen.length);
    tot += sv + rest.length * sgnV * (num(r.montant) || 0); seenN += seen.length; waitN += rest.length;
    const st = !bool(r.actif) ? '<span class="mini">arrêtée</span>' : seen.length ? `<span class="ok">✓ vu le ${seen.map(o => fmtJ(o.date)).join(', ')}</span>` : rest.length ? `<span class="mini">${rest[0] <= TODAY_ISO ? 'pas encore vu (prévu le ' + fmtJ(rest[0]) + ')' : 'à venir'}</span>` : '<span class="mini">pas dans ce cycle</span>';
    return `<button class="item ${!bool(r.actif) ? 'off' : ''}" data-rid="${esc(r.id)}"><span class="day">${pad(num(r.jour) || 1)}</span><span class="lbl"><b>${esc(r.libelle)}</b><small>${st}${r.categorie ? ' · ' + esc(r.categorie) : ''}${r.livret && livOf(r.livret) ? ' · → ' + livName(livOf(r.livret)) : ''}${r.fin ? ' · jusqu\'au ' + fmtJA(r.fin) : ''}</small></span><span class="amt ${r.sens === '+' ? 'pos' : ''}">${r.sens === '+' ? '+' : '−'} ${eurM(num(r.montant) || 0)}</span></button>`;
  };
  const ins = recs.filter(r => r.sens === '+'), outs = recs.filter(r => r.sens !== '+');
  const html = [ins.length ? `<div class="grp">RENTRÉES</div>${ins.map(row).join('')}` : '', outs.length ? `<div class="grp">CHARGES ET VIREMENTS</div>${outs.map(row).join('')}` : ''].join('');
  return `<section class="view">${head}
    ${cycNav(acc, c)}
    <div class="sumline"><span>Fixes du cycle<small>${seenN} vu${seenN > 1 ? 's' : ''} à la banque · ${waitN} à venir</small></span><b class="mono">${sgn(r2(tot))}</b></div>
    ${recs.length ? `<div class="list">${html}</div>` : '<div class="empty card0">Aucune charge fixe pour l\'instant : elles se créent en classant les opérations (« Fixe »), ou avec « Ajouter ».</div>'}
    <p class="hint">Le ${isPerso(acc) ? 'salaire' : 'virement de début de cycle'} n'est pas ici : il vient du Calendrier salaires. Une charge vue à la banque est cochée avec son vrai montant ; tant qu'elle n'est pas vue, elle reste « à venir » dans l'atterrissage.</p></section>`;
}

/* ----- Budgets ----- */
function vBud() {
  const acc = UI.acc; if (!started3(acc)) return vStart(acc);
  const c = selCycle(acc), R = cycleCalc(acc, c), B = R.buds;
  const tb = r2(B.reduce((a, x) => a + x.budget, 0)), ts = r2(B.reduce((a, x) => a + x.spent, 0));
  const others = budgetsOf(acc).filter(b => !(num(b.budget) > 0));
  return `<section class="view"><div class="rowhead"><h2 class="title">Budgets</h2></div>
    ${cycNav(acc, c)}
    <div class="tiles3"><div><small>Budget</small><b class="mono">${eurM(tb)}</b></div><div><small>Dépensé</small><b class="mono">${eurM(ts)}</b></div><div><small>À réserver</small><b class="mono acc">${eurM(R.reserve)}</b></div></div>
    <div class="list">${B.length ? B.map(x => { const pc = x.budget ? Math.min(100, Math.round(100 * x.spent / x.budget)) : 0;
      return `<button class="env2" data-bid="${esc(x.b.id)}"><span class="t"><b>${esc(x.nom)}</b><span class="mono">${eurM(x.spent)} / ${eurM(x.budget).replace(',00', '')}</span></span><span class="bar"><i class="${x.over ? 'over' : ''}" style="width:${x.over ? 100 : pc}%"></i></span><span class="mono mini ${x.over ? 'warnt' : ''}">${x.over ? '▲ dépassé de ' + eurM(x.over) : 'reste ' + eurM(x.reste)}</span></button>`; }).join('') : '<div class="empty">Aucun budget.</div>'}</div>
    <button class="btn dashed" data-newbud="1">+ Ajouter un budget</button>
    ${others.length ? `<details class="plain"><summary>Catégories sans budget · ${others.length}</summary><div class="list">${others.map(b => `<button class="item" data-bid="${esc(b.id)}" style="grid-template-columns:1fr auto"><span class="lbl"><b>${esc(b.nom)}</b></span><span class="mini">ajouter un budget ›</span></button>`).join('')}</div></details>` : ''}
    <p class="hint">Les ponctuels classés dans une catégorie budgétée réduisent son reste. Le reste à réserver d'un cycle en cours est déduit de l'atterrissage ; pour un cycle à venir, c'est le budget complet ; un cycle fini ne réserve plus rien.</p></section>`;
}

/* ----- Plus ----- */
function vPlus() {
  const it = (tab, ic, t, s) => `<button class="mitem" data-tab="${tab}"><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${ic}</svg><span><b>${t}</b><small>${s}</small></span><span class="ch">›</span></button>`;
  const bk = bkOn() && bkLinked().length;
  return `<section class="view"><h2 class="title">Plus</h2>
    <div class="sublbl">PILOTAGE</div><div class="list">
      ${it('cal', '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>', 'Calendrier salaires', 'Cycles, augmentations, primes')}
      ${it('epa', '<path d="M4 10h16v10H4z"/><path d="M12 4l8 6H4z"/><path d="M12 13v4M9.5 15h5"/>', 'Épargne', 'Livrets et investissement, objectifs du mois')}
      ${it('sim', '<path d="M3 20h18M6 16v-5M11 16V7M16 16v-3M21 4l-5 5"/>', 'Simulation', 'Tester un achat ou un crédit')}
    </div>
    <div class="sublbl">RÉGLAGES</div><div class="list">
      ${it('set', '<path d="M3 10l9-6 9 6M5 10v9M19 10v9M9 10v9M15 10v9M3 21h18"/>', 'Connexion bancaire, comptes, profils', bk ? '<span class="ok">✓ Banque reliée</span>' : 'Banque, accès, apparence')}
    </div>
    <p class="mono mini" style="text-align:center;margin-top:10px">Le 31 · V${APP_VERSION}</p></section>`;
}
const backPlus = `<button class="back" data-tab="plus">‹ Plus</button>`;

/* ----- Calendrier salaires ----- */
function vCal() {
  const acc = UI.acc; if (!started3(acc)) return backPlus + vStart(acc);
  if (isPerso(acc) && UI.calTab === 'evo') return vEvo(acc);
  const cy = cyclesOf(acc), cur = curCycle(acc), P = isPerso(acc), S = v3(acc);
  const rows = cy.slice(0, cur.i + 12).map(c => {
    const R = cycleCalc(acc, c), isC = c.i === cur.i, k = departKind(c);
    const banque = c.sal ? `<span class="ok">✓ vu à la banque${c.man.includes('d') && c.sal.date !== c.debut ? ' le ' + fmtJ(c.sal.date) : ''}</span>` : c.debut > TODAY_ISO ? (c.row.debut ? '' : 'estimé') : c.i === 0 ? '' : '<span class="warnt">pas encore vu</span>';
    const xtra = [c.detail.rappel ? `+${c.detail.hausse} % et rattrapage` : '', ...c.detail.primes.map(p => '+ ' + p.nom)].filter(Boolean).join(' · ');
    return `<button class="cyrow ${isC ? 'cur' : ''}" data-cycm="${esc(c.mois)}"><span class="a"><b>${esc(MONTHS_L[pm(c.mois).m])}${pm(c.mois).y !== pm(S.mois).y ? ' ' + pm(c.mois).y : ''}${isC ? ' <i class="en">EN COURS</i>' : ''}</b><small><span class="mono">${fmtJ(c.debut)}</span> · ${eurM(c.montant).replace(',00', '')}${xtra ? ' <b class="acc2">' + esc(xtra) + '</b>' : ''}${c.man.includes('d') ? ' · date saisie' : ''}${banque ? ' · ' + banque : ''}</small></span>
      <span class="b"><span class="mono">${eurM(R.depart)} → ${eurM(R.isPast ? R.realEnd : R.atterAvec)}</span><small>départ : ${esc(k)}</small></span></button>`;
  }).join('');
  return `<section class="view">${backPlus}<h2 class="title">Calendrier salaires</h2>${calTabs(acc)}
    <p class="hint" style="font-size:13px;margin:-8px 0 0">${P ? 'Un cycle va du jour du salaire à la veille du suivant.' : `Le cycle commence à l'arrivée du ${esc(salLabel(acc).toLowerCase().startsWith('virement') ? salLabel(acc) : 'virement')} ; tant qu'il n'est pas arrivé, la date est estimée au ${defJour(acc)}.`} Touche un cycle pour modifier sa date, son montant ou son solde de départ.</p>
    <div class="list"><div class="cyrow h"><span>CYCLE · ${P ? 'SALAIRE' : esc(salLabel(acc).toUpperCase())}</span><span>DÉPART → ARRIVÉE</span></div>${rows}</div>
    <div class="hero" style="gap:10px"><h2>Réglages du cycle</h2>
      <div class="two"><div class="field"><label for="cfJ">Jour habituel (estimation)</label><input id="cfJ" data-cfj="${esc(acc)}" inputmode="numeric" value="${esc(defJour(acc))}"></div>
      ${P ? '' : `<div class="field"><label for="cfN">Nom du virement</label><input id="cfN" data-cfn="${esc(acc)}" value="${esc(param('v3nomrev|' + acc, ''))}" placeholder="Ex. Virement du conjoint"></div>`}</div>
      <div class="hint">Début du suivi : ${fmtJA(S.debut)}. Les opérations d'avant ne sont pas lues.</div></div></section>`;
}

/* ----- Simulation ----- */
const SIM = store.get('le31-sim', {});
const simOf = acc => (SIM[acc] = SIM[acc] || { achats: [{ lib: '', date: '', montant: '' }], credits: [{ lib: '', mens: '', debut: '', fin: '', remplace: '', frais: '' }] });
const saveSim = () => store.set('le31-sim', SIM);
function saVerdict(base, a) {
  const r = simAchat(base, a); if (!r) return '';
  return r.ok ? `<div class="verdict good"><b>✓ Possible le ${fmtJ(a.date)}</b><div class="two"><span><small>Point le plus bas ensuite</small><b class="mono">${eurM(r.low)}</b></span><span><small>Maximum possible ce jour-là</small><b class="mono">${eurM(r.max)}</b></span></div></div>`
    : `<div class="verdict warn"><b>▲ Pas possible le ${fmtJ(a.date)}</b><div class="two"><span><small>Date conseillée</small><b class="mono">${r.conseil ? fmtJA(r.conseil) : 'aucune sur 12 cycles'}</b></span><span><small>Maximum possible ce jour-là</small><b class="mono">${eurM(r.max)}</b></span></div></div>`;
}
function saTable(base, achats) {
  const valid = achats.filter(a => simAchat(base, a)), all = simAll(base, valid);
  return `${valid.length > 1 ? `<div class="note ${all.ok ? 'good' : 'warn'}"><b>Ensemble des achats : ${all.ok ? 'le cumul passe' : 'le cumul ne passe pas'}</b></div>` : ''}
    <div class="list tbl"><div class="trow h"><span>FIN DE CYCLE AVEC BUDGET</span><span>SANS</span><span>AVEC ${valid.length > 1 ? 'ACHATS' : 'ACHAT'}</span></div>
    ${base.map((x, k) => `<div class="trow"><span>${esc(MONTHS_L[pm(x.c.mois).m])}</span><span class="mono mini">${eurM(x.end)}</span><span class="mono ${all.ends[k] < 0 ? 'warnt' : ''}">${eurM(all.ends[k])}</span></div>`).join('')}</div>`;
}
function scResult(acc, base, cr) {
  const r = simCredit(acc, base, cr); if (!r || !num(cr.mens)) return '';
  return `<div class="verdict ${r.ok ? 'good' : 'warn'}"><b>${r.ok ? '✓ Supportable' : '▲ Pas supportable'} sur 12 cycles</b><div class="two"><span><small>Impact net</small><b class="mono">${sgn(r.impact)}</b></span><span><small>Point le plus bas</small><b class="mono">${eurM(r.low)}</b></span></div><div class="two"><span><small>Mensualité max supportable</small><b class="mono">${r.max === null ? '—' : eurM(r.max)}</b></span><span><small>Prélèvements</small><b class="mono">${r.nPay}</b></span></div></div>
    <div class="list tbl"><div class="trow h"><span>FIN DE CYCLE AVEC BUDGET</span><span>SANS</span><span>AVEC</span></div>${r.rows.map(x => `<div class="trow"><span>${esc(MONTHS_L[pm(x.c.mois).m])}</span><span class="mono mini">${eurM(x.base)}</span><span class="mono ${x.end < 0 ? 'warnt' : ''}">${eurM(x.end)}</span></div>`).join('')}</div>`;
}
// Mise à jour des résultats sans redessiner les champs (on peut passer d'un champ à l'autre sans perdre la saisie)
function simRefresh() {
  const acc = UI.acc, base = simBase(acc), S = simOf(acc);
  S.achats.forEach((a, i) => { const e = $('saV' + i); if (e) e.innerHTML = saVerdict(base, a); });
  const t = $('saT'); if (t) t.innerHTML = saTable(base, S.achats);
  S.credits.forEach((cr, i) => { const e = $('scV' + i); if (e) e.innerHTML = scResult(acc, base, cr); });
}
function vSim() {
  const acc = UI.acc; if (!started3(acc)) return backPlus + vStart(acc);
  const base = simBase(acc), S = simOf(acc);
  const seg = `<div class="seg"><button data-simtab="achat" aria-pressed="${UI.simTab === 'achat'}">Achat</button><button data-simtab="credit" aria-pressed="${UI.simTab === 'credit'}">Crédit</button></div>`;
  let body;
  if (UI.simTab === 'achat') {
    body = S.achats.map((a, i) => `<div class="simcard2"><div class="field"><label for="saL${i}">Achat</label><input id="saL${i}" data-sa="${i}" data-f="lib" value="${esc(a.lib)}" placeholder="Ex. Cadeau de Noël"></div>
        <div class="two"><div class="field"><label for="saD${i}">Date</label><input type="date" id="saD${i}" data-sa="${i}" data-f="date" value="${esc(a.date)}"></div><div class="field"><label for="saM${i}">Montant (€)</label><input id="saM${i}" data-sa="${i}" data-f="montant" inputmode="decimal" value="${esc(a.montant)}"></div></div>
        <div id="saV${i}">${saVerdict(base, a)}</div>${S.achats.length > 1 ? `<button class="linkbtn" data-sadel="${i}">Retirer</button>` : ''}</div>`).join('')
      + `${S.achats.length < 5 ? '<button class="btn dashed" data-saadd="1">+ Tester un autre achat (5 max)</button>' : ''}
      <div id="saT">${saTable(base, S.achats)}</div>
      <p class="hint">Rien n'est enregistré. Un achat est possible si, après l'avoir déduit, le solde de fin de cycle avec budgets reste positif à la fin de son cycle et de tous les suivants.</p>`;
  } else {
    const recs = DB.recurrents.filter(r => r.compte === acc && r.sens !== '+' && bool(r.actif));
    body = S.credits.map((cr, i) => `<div class="simcard2"><div class="field"><label for="scL${i}">Crédit</label><input id="scL${i}" data-sc="${i}" data-f="lib" value="${esc(cr.lib)}" placeholder="Ex. Nouvelle voiture"></div>
        <div class="two"><div class="field"><label for="scM${i}">Mensualité (€)</label><input id="scM${i}" data-sc="${i}" data-f="mens" inputmode="decimal" value="${esc(cr.mens)}"></div><div class="field"><label for="scF${i}">Frais ponctuels (€)</label><input id="scF${i}" data-sc="${i}" data-f="frais" inputmode="decimal" value="${esc(cr.frais)}"></div></div>
        <div class="two"><div class="field"><label for="scD${i}">1er prélèvement</label><input type="date" id="scD${i}" data-sc="${i}" data-f="debut" value="${esc(cr.debut)}"></div><div class="field"><label for="scE${i}">Dernier prélèvement</label><input type="date" id="scE${i}" data-sc="${i}" data-f="fin" value="${esc(cr.fin)}"></div></div>
        <div class="field"><label for="scR${i}">Remplace</label><select id="scR${i}" data-sc="${i}" data-f="remplace"><option value="">Rien (crédit en plus)</option>${recs.map(x => `<option value="${esc(x.id)}" ${x.id === cr.remplace ? 'selected' : ''}>${esc(x.libelle)} · ${eurM(num(x.montant))}</option>`).join('')}</select></div>
        <div id="scV${i}">${scResult(acc, base, cr)}</div>
        ${S.credits.length > 1 ? `<button class="linkbtn" data-scdel="${i}">Retirer</button>` : ''}</div>`).join('')
      + `${S.credits.length < 3 ? '<button class="btn dashed" data-scadd="1">+ Tester un autre crédit (3 max)</button>' : ''}
      <p class="hint">Nouveau crédit : laisse « Remplace » vide. Remplacement : choisis la charge fixe remplacée (ex. Crédit Tesla) ; elle n'est plus prélevée à partir du 1er prélèvement du nouveau crédit. Les frais sont débités à cette date. Chaque crédit est jugé seul.</p>`;
  }
  return `<section class="view">${backPlus}<h2 class="title">Simulation</h2>${seg}${body}</section>`;
}

/* ================= V3.1 : mois par mois (accueil) ================= */
const iniM = k => MONTHS_L[pm(k).m].charAt(0).toUpperCase();
const mpmSeg = (attr, cur) => `<div class="seg"><button data-${attr}="g" aria-pressed="${cur !== 'y'}">12 mois glissants</button><button data-${attr}="y" aria-pressed="${cur === 'y'}">Année ${pm(CUR).y}</button></div>`;
const legend = `<div class="legend"><span><i class="dot"></i>en cours / réel</span><span><i class="dsh"></i>prévu</span></div>`;
function vMpm(acc) {
  const cy = cyclesOf(acc), cur = curCycle(acc), y = pm(labelMonth(TODAY_ISO)).y;
  const L = (UI.mpm === 'y' ? Array.from({ length: 12 }, (_, i) => y + '-' + pad(i + 1)).map(k => ({ k, c: cy.find(c => c.mois === k) || null })) : cy.slice(cur.i, cur.i + 12).map(c => ({ k: c.mois, c })))
    .map(x => { if (!x.c) return { k: x.k, v: null }; const R = cycleCalc(acc, x.c); return { k: x.k, c: x.c, v: R.isPast ? R.realEnd : R.atterAvec, d: R.depart, st: R.isPast ? 'real' : R.isCur ? 'cur' : 'fut' }; });
  const ok = L.filter(x => x.v !== null), low = ok.reduce((m, x) => !m || x.v < m.v ? x : m, null), neg = ok.find(x => x.v < 0);
  const rows = L.map(x => x.v === null ? `<div class="mrow off"><span>${esc(MONTHS_L[pm(x.k).m])}</span><span class="mini">avant le suivi</span><span></span></div>`
    : `<button class="mrow ${x.st}" data-gocyc="${esc(x.k)}"><span><b>${esc(MONTHS_L[pm(x.k).m])}</b><small>${x.st === 'real' ? 'réel' : x.st === 'cur' ? 'en cours' : 'prévu'}</small></span><span class="mono mini">${nbM(x.d)} → ${nbM(x.v)}</span><span class="mono ${x.v - x.d >= 0 ? 'pos' : 'warnt'}">${sgn(r2(x.v - x.d))}</span></button>`).join('');
  return `<details class="jpj" id="mpm" ${UI.mpmOpen ? 'open' : ''}><summary>Mois par mois<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M6 9l6 6 6-6"/></svg></summary>
    <div class="mpmbody">${mpmSeg('mpm', UI.mpm)}
    <div class="mini">Atterrissage avec budget, fin de chaque cycle${neg ? ` · <b class="warnt">▼ négatif en ${esc(MONTHS_L[pm(neg.k).m])}</b>` : low ? ` · point le plus bas : <b class="mono">${eurM(low.v)}</b> en ${esc(MONTHS_L[pm(low.k).m])}` : ''}</div>
    ${lineSvg(L.map(x => ({ lab: iniM(x.k), v: x.v, st: x.st })), 'Atterrissage avec budget, mois par mois')}${legend}
    <div class="mrows">${rows}</div><p class="hint">Touche un mois pour ouvrir son cycle.</p></div></details>`;
}

/* ================= V3.1 : Calendrier > Évolution du salaire ================= */
const calTabs = acc => isPerso(acc) ? `<div class="ultabs"><button data-caltab="cyc" aria-pressed="${UI.calTab !== 'evo'}">Cycles</button><button data-caltab="evo" aria-pressed="${UI.calTab === 'evo'}">Évolution du salaire</button></div>` : '';
const monthSel = (id, v, attrs) => `<select id="${id}" ${attrs}>${MONTHS_L.map((m, i) => `<option value="${i + 1}" ${+v === i + 1 ? 'selected' : ''}>${m}</option>`).join('')}</select>`;
function defaultPlan(acc, excel) {
  const P = { moisHausse: 6, rattrapDepuis: 1, hausses: {}, primes: [] };
  // primes habituelles (bonus sur la paie de mars, ½ 13ème mois de juin et de décembre), sans montant : une prime sans montant ne compte pas
  const pf = excel !== false && excelLikely(acc) && isPerso(acc) ? excelFor(acc).primes || {} : {};
  P.primes = [
    { id: uid(), nom: 'Bonus', type: 'paie', mois: 3, jour: '', montants: pf.bonus || {} },
    { id: uid(), nom: '½ 13ème mois', type: 'part', mois: 6, jour: 15, montants: pf.juin || {} },
    { id: uid(), nom: '½ 13ème mois', type: 'part', mois: 12, jour: 15, montants: pf.dec || {} }];
  return P;
}
function vEvo(acc) {
  const P = salPlan(acc), cy = cyclesOf(acc), cur = curCycle(acc), mh = num(P.moisHausse) || 6;
  const ys = Object.keys(P.hausses || {}).map(Number).sort((a, b) => a - b);
  const payOf = y => cy.find(c => payMonth(c.mois) === y + '-' + pad(mh));
  const hRows = ys.map(y => { const c = payOf(y), d = c && c.detail;
    return `<div class="evrow"><span class="y"><b>${y}</b><small>${d && d.rappel ? `Paie de ${MONTHS_L[mh - 1]} : ${eurM(d.base)} + rattrapage ${eurM(d.rappel)}` : 'hors des 12 prochains mois'}</small></span>
      <span class="evin"><input id="evh${y}" data-evoh="${y}" inputmode="decimal" value="${esc(fr(P.hausses[y]))}" aria-label="Augmentation ${y} en %"><i>%</i></span>
      ${d && d.rappel ? `<span class="mono tot">${eurM(d.base + d.rappel)}</span>` : '<span></span>'}<button class="x" data-evohdel="${y}" aria-label="Retirer ${y}">×</button></div>`; }).join('');
  const nextYear = p => { if (p.type === 'part') { for (let y = pm(CUR).y; y < pm(CUR).y + 3; y++) if (dayOn(y + '-' + pad(+p.mois || 12), +p.jour || 15) >= TODAY_ISO) return y; } const pmNow = payMonth(cur.mois); return +p.mois >= +pmNow.slice(5, 7) && +pmNow.slice(0, 4) === pm(CUR).y ? pm(pmNow).y : pm(pmNow).y + (+p.mois < +pmNow.slice(5, 7) ? 1 : 0); };
  const pRows = (P.primes || []).map(p => { const y = nextYear(p), m = (p.montants || {})[y];
    return `<div class="evp"><div class="two"><div class="field"><label for="epn${p.id}">Prime</label><input id="epn${p.id}" data-evp="${esc(p.id)}" data-f="nom" value="${esc(p.nom)}"></div>
      <div class="field"><label for="ept${p.id}">Versée</label><select id="ept${p.id}" data-evp="${esc(p.id)}" data-f="type"><option value="paie" ${p.type !== 'part' ? 'selected' : ''}>dans la paie</option><option value="part" ${p.type === 'part' ? 'selected' : ''}>virement à part</option></select></div></div>
      <div class="two"><div class="field"><label for="epm${p.id}">${p.type === 'part' ? 'Mois' : 'Sur la paie de'}</label>${monthSel('epm' + p.id, p.mois, `data-evp="${esc(p.id)}" data-f="mois"`)}</div>
      ${p.type === 'part' ? `<div class="field"><label for="epj${p.id}">Jour</label><input id="epj${p.id}" data-evp="${esc(p.id)}" data-f="jour" inputmode="numeric" value="${esc(p.jour || 15)}"></div>` : '<span></span>'}</div>
      <div class="evrow" style="border:0;padding:4px 0 0"><span class="y"><b>${y}</b><small>${m === undefined || m === '' ? (primeAmt(p, y) ? 'repris : ' + eurM(primeAmt(p, y)) : 'montant à saisir') : 'saisi'}</small></span>
      <span class="evin"><input id="epv${p.id}" data-evpm="${esc(p.id)}" data-y="${y}" inputmode="decimal" value="${m !== undefined && m !== '' ? esc(fr(m)) : ''}" placeholder="${primeAmt(p, y) ? esc(fr(primeAmt(p, y))) : 'à saisir'}" aria-label="Montant ${esc(p.nom)} ${y}"><i>€</i></span><span></span>
      <button class="x" data-evpdel="${esc(p.id)}" aria-label="Retirer la prime">×</button></div></div>`; }).join('');
  // ce que Le 31 attend à la banque (12 prochains mois)
  const exp = []; cy.slice(cur.i + 1, cur.i + 13).forEach(c => { const d = c.detail; if (d.rappel || d.primes.length) exp.push({ date: c.debut, lab: `paie de ${MONTHS_L[pm(payMonth(c.mois)).m]}${d.rappel ? ' + augmentation' : ''}${d.primes.length ? ' + ' + d.primes.map(p => p.nom.toLowerCase()).join(', ') : ''}`, det: `${eurM(d.base)}${d.rappel ? ' + rattrapage ' + eurM(d.rappel) : ''}${d.primes.map(p => ' + ' + eurM(p.v)).join('')}`, v: c.montant, est: !c.row.debut }); });
  primeParts(acc, TODAY_ISO, addD(TODAY_ISO, 366)).forEach(p => exp.push({ date: p.date, lab: p.nom, det: 'virement à part', v: p.v }));
  (P.primes || []).filter(p => p.type === 'part').forEach(p => { const y = nextYear(p), d = dayOn(y + '-' + pad(+p.mois || 12), +p.jour || 15); if (!primeAmt(p, y) && d <= addD(TODAY_ISO, 366)) exp.push({ date: d, lab: p.nom, det: 'montant à saisir', v: null }); });
  exp.sort((a, b) => a.date.localeCompare(b.date));
  return `<section class="view">${backPlus}<h2 class="title">Calendrier salaires</h2>${calTabs(acc)}
    <div class="hero" style="gap:10px"><div class="rowhead"><h2>Augmentation annuelle</h2><span class="mini" style="text-align:right">salaire actuel<br><b class="mono" style="white-space:nowrap">${eurM(cur.base)}</b></span></div>
      <div class="two"><div class="field"><label for="evMh">Sur la paie de</label>${monthSel('evMh', mh, 'data-evo="moisHausse"')}</div><div class="field"><label for="evRd">Rattrapage depuis</label>${monthSel('evRd', P.rattrapDepuis || 1, 'data-evo="rattrapDepuis"')}</div></div>
      <div class="evlist">${hRows || '<div class="mini">Aucune augmentation prévue.</div>'}</div>
      <button class="btn dashed" data-evohadd="1">+ Ajouter une année</button>
      <div class="hint">L'augmentation et le rattrapage arrivent dans le virement de la paie de ${MONTHS_L[mh - 1]} (cycle de ${MONTHS_L[mh % 12]}). Les années suivantes reprennent le dernier pourcentage. Corrige-le quand tu connais le vrai chiffre.</div></div>
    <div class="hero" style="gap:10px"><div class="rowhead"><h2>Primes</h2></div>${pRows || '<div class="mini">Aucune prime.</div>'}
      <button class="btn dashed" data-evpadd="1">+ Ajouter une prime</button>
      <div class="hint">Chaque année reprend le montant de l'année d'avant tant que tu ne le changes pas. Une prime sans montant n'est pas comptée.</div></div>
    <div class="hero" style="gap:6px"><div class="rowhead"><h2>Ce que Le 31 attend à la banque</h2></div>
      <div class="list">${exp.length ? exp.map(e => `<div class="item" style="grid-template-columns:1fr auto"><span class="lbl"><b style="white-space:normal">${fmtJA(e.date)} · ${esc(e.lab)}</b><small>${esc(e.det)}</small></span><span class="amt ${e.v ? 'pos' : ''}">${e.v ? sgn(e.v) : '—'}</span></div>`).join('') : '<div class="empty">Rien de particulier sur les 12 prochains mois : paie habituelle de ' + eurM(cur.base) + '.</div>'}</div>
      <div class="hint">Ces montants comptent dans l'atterrissage, les cycles suivants et la simulation. Quand la banque les voit, elle les reconnaît seule (montant attendu à ± 10 %).</div></div></section>`;
}
function saveEvo(acc, f) { const P = JSON.parse(JSON.stringify(salPlan(acc))); f(P); stage([regOp(acc, 'salaire', P)]); flush(); renderKeep(); }
function renderKeep() { setTimeout(() => { const a = document.activeElement, id = a && a.id; render(); const e = id && $(id); if (e) { try { e.focus(); } catch (x) {} } }, 0); }

/* ================= V3.1 : Épargne ================= */
const lastDayPrev = () => addD(CUR + '-01', -1);
const livName = L => esc(L.nom);
function vEpaStart(acc) {
  const X = excelFor(acc), ex = excelLikely(acc) && !!X.epargne, rows = (ex ? X.epargne : EPA_DEF[isPerso(acc) ? 'perso' : 'commun']).map(([n, t, pz, ob]) => ({ n, t, pz: ex ? pz : '', ob: ex ? ob : '' })).concat([{ n: '', t: 'livret', pz: '', ob: '' }]);
  return `<section class="view">${backPlus}<h2 class="title">Démarrer l'épargne · ${esc(shortAcc(acc))}</h2>
    <p class="hint" style="font-size:13px;margin:-8px 0 0">Point zéro : le solde de chaque livret à la date ci-dessous au soir. Ensuite, tout se calcule avec tes virements. Les mois vont du 1er au dernier jour.</p>
    <form class="form" id="epaStart" data-acc="${esc(acc)}" novalidate>
      <div class="field"><label for="ezD">Date du point zéro</label><input type="date" id="ezD" value="${lastDayPrev()}"></div>
      <div class="list">${rows.map((r, i) => `<div class="env" style="gap:8px"><div class="two"><div class="field"><label for="ezN${i}">Livret</label><input id="ezN${i}" value="${esc(r.n)}" data-t="${r.t}"></div><div class="field"><label for="ezT${i}">Type</label><select id="ezT${i}"><option value="livret" ${r.t !== 'invest' ? 'selected' : ''}>Livret</option><option value="invest" ${r.t === 'invest' ? 'selected' : ''}>Investissement</option></select></div></div>
        <div class="two"><div class="field"><label for="ezS${i}">${r.t === 'invest' ? 'Déjà versé' : 'Solde'} au point zéro (€)</label><input id="ezS${i}" inputmode="decimal" value="${esc(r.pz === '' ? '' : fr(r.pz))}" placeholder="0,00"></div><div class="field"><label for="ezO${i}">Objectif / mois (€)</label><input id="ezO${i}" inputmode="decimal" value="${esc(r.ob === '' ? '' : fr(r.ob))}" placeholder="—"></div></div></div>`).join('')}</div>
      ${ex ? '<div class="note">Montants pré-remplis : vérifie-les avant de démarrer.</div>' : '<div class="note">Efface le nom d\'un livret que tu n\'as pas ; la ligne vide sert à en ajouter un.</div>'}
      <div class="hint">Investissement : on suit ce que tu verses, pas la valeur du placement. Les charges fixes et prévues dont le nom contient celui d'un livret (ex. « Économie → Livret A ») y sont rattachées tout de suite.</div>
      <button class="btn" type="submit">Démarrer</button></form></section>`;
}
function startEpaOps(acc) {
  const d = $('ezD').value, ops = [], made = [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) { toast('Indique la date du point zéro'); return null; }
  for (let i = 0; $('ezN' + i); i++) {
    const n = $('ezN' + i).value.trim(); if (!n) continue;
    const L = { id: uid(), compte: acc, nom: n, type: $('ezT' + i).value, pointZero: r2(num($('ezS' + i).value) || 0), dateZero: d, objectif: num($('ezO' + i).value) === null ? '' : r2(num($('ezO' + i).value)), ordre: i + 1, actif: 'oui' };
    ops.push(upd('Livrets', L)); made.push(L);
  }
  if (!made.length) { toast('Indique au moins un livret'); return null; }
  ops.push(...linkOps(acc, made));
  return ops;
}
// rattache les fixes et prévues dont le nom (ou la catégorie) désigne un livret
function linkOps(acc, Ls) {
  const ops = [], hit = (txt, L) => NORM(txt).includes(NORM(L.nom));
  const find = (lib, cat) => Ls.find(L => hit(lib, L)) || Ls.find(L => cat && NORM(cat) === NORM(L.nom)) || Ls.find(L => L.type === 'invest' && /INVEST|TRADE|BOURSE|PEA|CTO/.test(NORM(lib + ' ' + (cat || ''))));
  DB.recurrents.filter(r => r.compte === acc && !r.livret && r.sens !== '+').forEach(r => { const L = find(r.libelle, r.categorie); if (L) ops.push(upd('Recurrents', { id: r.id, livret: L.id })); });
  DB.prevues.filter(p => p.compte === acc && !p.livret && !p.etat && (num(p.montant) || 0) < 0).forEach(p => { const L = find(p.libelle, p.categorie); if (L) ops.push(upd('Prevues', { id: p.id, livret: L.id })); });
  return ops;
}
function vEpa() {
  const acc = UI.acc; if (!started3(acc)) return backPlus + vStart(acc);
  const Ls = livretsOf(acc); if (!Ls.length) return vEpaStart(acc);
  const first = addM(Ls.map(L => L.dateZero).sort()[0].slice(0, 7), 1), k = UI.epM && UI.epM >= first ? UI.epM : (CUR >= first ? CUR : first);
  const last = addM(CUR, 12), data = Ls.map(L => ({ L, m: livMonths(L, last).find(x => x.k === k) }));
  const sumNet = r2(data.reduce((a, x) => a + (x.m ? (x.m.st === 'fut' ? x.m.realNet + x.m.projNet : x.m.realNet) : 0), 0)), sumObj = r2(Ls.reduce((a, L) => a + (num(L.objectif) || 0), 0));
  const cards = data.map(({ L, m }) => {
    const solde = k === CUR ? livSolde(L, TODAY_ISO) : m ? m.fin : num(L.pointZero) || 0, o = num(L.objectif) || 0, st = livObj(L, m);
    const done = m ? (m.st === 'fut' ? m.realNet + m.projNet : m.realNet) : 0, pc = o ? Math.max(0, Math.min(100, Math.round(100 * done / o))) : 0;
    return `<button class="env2" data-livid="${esc(L.id)}"><span class="t"><b>${livName(L)}${L.type === 'invest' ? '<small class="mini" style="display:block;font-weight:400">total versé</small>' : ''}</b><span class="mono" style="font-size:16px;color:var(--ink)">${eurM(solde)}</span></span>
      ${o ? `<span class="bar"><i class="${st === 'late' ? 'over' : ''}" style="width:${pc}%"></i></span>` : ''}
      <span class="t"><span class="mono mini">${sgn(done)}${o ? ' / ' + eurM(o) : ''} ce mois</span>${st === 'ok' ? '<span class="ok mini">✓ atteint</span>' : st === 'wait' ? '<span class="mini">à venir</span>' : st === 'late' ? '<span class="warnt mini">▼ en retard</span>' : ''}</span></button>`;
  }).join('');
  return `<section class="view">${backPlus}<h2 class="title">Épargne</h2>
    <div class="cycnav"><button class="nb" data-epm="-1" ${k > first ? '' : 'disabled'} aria-label="Mois précédent">‹</button><div class="cyct"><b>${esc(MONTHS_L[pm(k).m].replace(/^./, x => x.toUpperCase()))} ${pm(k).y}</b><span class="mono">${fmtJ(k + '-01')} → ${fmtJ(monthEnd(k))}</span></div><button class="nb" data-epm="1" ${k < addM(CUR, 11) ? '' : 'disabled'} aria-label="Mois suivant">›</button></div>
    <div class="bigsolde" style="flex-direction:row;justify-content:space-between;align-items:flex-end"><span style="display:flex;flex-direction:column;gap:2px"><small>${k > CUR ? 'Prévu ce mois' : 'Épargné ce mois'}</small><b class="mono" style="font-size:32px">${sgn(sumNet)}</b></span>${sumObj ? `<span class="mono mini" style="text-align:right">objectif<br>${eurM(sumObj)}</span>` : ''}</div>
    <div class="list">${cards}</div>
    <button class="btn dashed" data-newliv="1">+ Ajouter un livret</button>
    ${vEpaMpm(acc, Ls)}
    <p class="hint">Un livret se remplit avec les virements classés « Épargne » dans À classer et avec les charges fixes liées à un livret. Une rentrée depuis un livret est un retrait.</p></section>`;
}
function vEpaMpm(acc, Ls) {
  const sel = UI.epS !== 'tot' && Ls.find(L => L.id === UI.epS) ? [Ls.find(L => L.id === UI.epS)] : Ls, y = pm(CUR).y;
  const ks = UI.epMpm === 'y' ? Array.from({ length: 12 }, (_, i) => y + '-' + pad(i + 1)) : Array.from({ length: 12 }, (_, i) => addM(CUR, i));
  const last = ks[ks.length - 1] > addM(CUR, 12) ? ks[ks.length - 1] : addM(CUR, 12);
  const rows = ks.map(k => { const ms = sel.map(L => livMonths(L, last).find(x => x.k === k)); if (ms.every(m => !m)) return { k, v: null };
    return { k, v: r2(ms.reduce((a, m) => a + (m ? m.fin : 0), 0)), net: r2(ms.reduce((a, m) => a + (m ? m.net + m.int : 0), 0)), st: k < CUR ? 'real' : k === CUR ? 'cur' : 'fut' }; });
  const pz = r2(sel.reduce((a, L) => a + (num(L.pointZero) || 0), 0));
  return `<details class="jpj" id="epmpm" ${UI.epMpmOpen ? 'open' : ''}><summary>Mois par mois<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M6 9l6 6 6-6"/></svg></summary>
    <div class="mpmbody">${mpmSeg('epmpm', UI.epMpm)}
    ${Ls.length > 1 ? `<div class="chips">${[['tot', 'Total']].concat(Ls.map(L => [L.id, L.nom])).map(([id, n]) => `<button class="chip" data-eps="${esc(id)}" aria-pressed="${(UI.epS === id) || (id === 'tot' && sel === Ls)}">${esc(n)}</button>`).join('')}</div>` : ''}
    <div class="mini">${sel.length > 1 ? 'Épargne totale' : esc(sel[0].nom)} en fin de mois · point zéro <b class="mono">${eurM(pz)}</b> au ${fmtJ(sel[0].dateZero)}</div>
    ${lineSvg(rows.map(x => ({ lab: iniM(x.k), v: x.v, st: x.st })), 'Épargne, mois par mois')}${legend}
    <div class="mrows"><div class="mrow h"><span>MOIS</span><span>VERSÉ − RETIRÉ</span><span>SOLDE FIN</span></div>${rows.map(x => x.v === null ? `<div class="mrow off"><span>${esc(MONTHS_L[pm(x.k).m])}</span><span class="mini">avant le point zéro</span><span></span></div>`
      : `<button class="mrow ${x.st}" data-epgo="${esc(x.k)}"><span><b>${esc(MONTHS_L[pm(x.k).m])}</b><small>${x.st === 'real' ? 'réel' : x.st === 'cur' ? 'en cours' : 'prévu'}</small></span><span class="mono ${x.net >= 0 ? 'pos' : 'warnt'}">${sgn(x.net)}</span><span class="mono">${eurM(x.v)}</span></button>`).join('')}</div>
    <p class="hint">Les mois prévus viennent des charges fixes et des prévues liées aux livrets.</p></div></details>`;
}
function vEpl() {
  const L = livOf(UI.epL); if (!L) { UI.tab = 'epa'; return vEpa(); }
  const first = addM(L.dateZero.slice(0, 7), 1), ms = livMonths(L, addM(CUR, 12)), k = UI.epM && UI.epM >= first ? UI.epM : (CUR >= first ? CUR : first);
  const m = ms.find(x => x.k === k), show = UI.eplAll ? ms : ms.filter(x => x.k >= (CUR >= first ? CUR : first)).slice(0, 5);
  const inv = L.type === 'invest';
  return `<section class="view"><button class="back" data-tab="epa">‹ Épargne</button>
    <div class="rowhead"><h2 class="title">${livName(L)}</h2><span class="mini">${esc(shortAcc(L.compte))}</span></div>
    <div class="tiles3"><div><small>${inv ? 'Total versé' : 'Solde actuel'}</small><b class="mono">${eurM(livSolde(L, TODAY_ISO))}</b></div><div><small>Point zéro ${fmtJ(L.dateZero)}</small><b class="mono">${eurM(num(L.pointZero) || 0)}</b></div><div><small>Objectif / mois</small><b class="mono acc">${num(L.objectif) ? eurM(num(L.objectif)) : '—'}</b></div></div>
    <div class="list tbl"><div class="trow5 h"><span>MOIS</span><span>VERSÉ</span><span>RETIRÉ</span><span>${inv ? '' : 'INTÉR.'}</span><span>FIN (€)</span></div>
      ${show.map(x => `<button class="trow5 ${x.st}" data-epgo="${esc(x.k)}"><span>${esc(MONTHS_C[pm(x.k).m])}${x.k.slice(0, 4) !== String(pm(CUR).y) ? ' ' + x.k.slice(2, 4) : ''}<small>${x.st === 'real' ? 'réel' : x.st === 'cur' ? 'en cours' : 'prévu'}</small></span><span class="mono">${x.vers ? nbM(x.vers) : '—'}</span><span class="mono">${x.retr ? nbM(x.retr) : '—'}</span><span class="mono">${inv ? '' : x.int ? nbM(x.int) : '—'}</span><span class="mono b">${nbM(x.fin)}</span></button>`).join('')}
      <button class="linkbtn" style="padding-left:14px" data-eplall="1">${UI.eplAll ? 'Moins' : 'Voir tous les mois'}</button></div>
    <div class="hero" style="gap:6px"><div class="rowhead"><h2>Mouvements · ${esc(MONTHS_L[pm(k).m])} ${pm(k).y}</h2></div>
      <div class="list">${m && (m.real.length || m.proj.length) ? m.real.concat(m.proj).sort((a, b) => a.date.localeCompare(b.date)).map(f => `<${f.mid ? `button data-mvlid="${esc(f.mid)}"` : f.oid ? `button data-oid="${esc(f.oid)}"` : 'div'} class="item ${f.prevu ? 'off' : ''}" style="grid-template-columns:52px 1fr auto"><span class="day">${fmtJ(f.date)}</span><span class="lbl"><b>${esc(f.label)}</b><small>${f.prevu ? 'prévu' : f.kind === 'int' ? 'intérêts' : f.mid ? 'à la main' : 'vu à la banque'}</small></span><span class="amt ${f.v > 0 ? 'pos' : ''}">${sgn(f.v)}</span></${f.mid || f.oid ? 'button' : 'div'}>`).join('') : '<div class="empty">Aucun mouvement ce mois-ci.</div>'}</div></div>
    ${inv ? '' : `<form class="hero" id="recalForm" data-l="${esc(L.id)}" style="gap:8px" novalidate><div class="rowhead"><h2>Recaler le solde</h2></div>
      <div class="hint">Tape le solde réel du livret (relevé, appli de la banque) : l'écart est enregistré en intérêts, aujourd'hui.</div>
      <div class="rcrow"><input id="rcV" inputmode="decimal" placeholder="${esc(fr(livSolde(L, TODAY_ISO)))}" aria-label="Solde réel"><button class="btn dark" type="submit">Recaler</button></div></form>`}
    <div class="two"><button class="btn ghost" data-livedit="${esc(L.id)}">Modifier</button><button class="btn ghost" data-mvlnew="${esc(L.id)}">Mouvement à la main</button></div></section>`;
}
function livSheet(acc, L) {
  openSheet(`<form class="form" id="livForm" data-acc="${esc(acc)}" data-id="${esc(L ? L.id : '')}" novalidate><h2>${L ? livName(L) : 'Nouveau livret'}</h2>
    <div class="two"><div class="field"><label for="lvN">Nom</label><input id="lvN" value="${esc(L ? L.nom : '')}" placeholder="Ex. PEL"></div><div class="field"><label for="lvT">Type</label><select id="lvT"><option value="livret">Livret</option><option value="invest" ${L && L.type === 'invest' ? 'selected' : ''}>Investissement</option></select></div></div>
    <div class="two"><div class="field"><label for="lvZ">Point zéro (€)</label><input id="lvZ" inputmode="decimal" value="${L ? esc(fr(L.pointZero)) : ''}"></div><div class="field"><label for="lvD">Au</label><input type="date" id="lvD" value="${esc(L ? L.dateZero : lastDayPrev())}"></div></div>
    <div class="field"><label for="lvO">Objectif / mois (€)</label><input id="lvO" inputmode="decimal" value="${L && L.objectif !== '' ? esc(fr(L.objectif)) : ''}" placeholder="—"></div>
    <div class="actions">${L ? `<button type="button" class="btn danger" data-livdel="${esc(L.id)}">Supprimer</button>` : ''}<button class="btn" type="submit">Enregistrer</button></div><div id="confirmBox"></div></form>`);
}
function mvlSheet(L, mv) {
  const v = mv ? num(mv.montant) || 0 : 0, t = mv ? (mv.type === 'interets' ? 'int' : v < 0 ? 'retr' : 'vers') : 'vers';
  openSheet(`<form class="form" id="mvlForm" data-l="${esc(L.id)}" data-id="${esc(mv ? mv.id : '')}" novalidate><h2>${livName(L)} · mouvement</h2>
    <div class="seg seg3" id="mvlT"><button type="button" data-mvlt="vers" aria-pressed="${t === 'vers'}">Versement</button><button type="button" data-mvlt="retr" aria-pressed="${t === 'retr'}">Retrait</button><button type="button" data-mvlt="int" aria-pressed="${t === 'int'}">Intérêts</button></div>
    <div class="two"><div class="field"><label for="mvA">Montant (€)</label><input id="mvA" inputmode="decimal" value="${mv ? esc(fr(Math.abs(v))) : ''}"></div><div class="field"><label for="mvD">Date</label><input type="date" id="mvD" value="${esc(mv ? mv.date : TODAY_ISO)}"></div></div>
    <div class="field"><label for="mvL">Libellé</label><input id="mvL" value="${esc(mv ? mv.libelle : '')}" placeholder="Ex. virement depuis une autre banque"></div>
    <div class="hint">Seulement pour ce qui ne passe pas par ton compte suivi (sinon, classe l'opération « Épargne » dans À classer).</div>
    <div class="actions">${mv ? `<button type="button" class="btn danger" data-mvldel="${esc(mv.id)}">Supprimer</button>` : ''}<button class="btn" type="submit">Enregistrer</button></div></form>`);
}
const livSelect = (acc, sel, id) => livretsOf(acc).length ? `<div class="field"><label for="${id}">Va vers le livret</label><select id="${id}"><option value="">—</option>${livretsOf(acc).map(L => `<option value="${esc(L.id)}" ${L.id === sel ? 'selected' : ''}>${livName(L)}</option>`).join('')}</select></div>` : '';

/* ----- migration V3.0 → V3.1 (une fois, sur l'appareil du propriétaire) ----- */
let MIG31 = false;
function migrate31() {
  if (MIG31 || !LOADED || !ME) return;
  MIG31 = true;
  const ops = [];
  accs().filter(a => a.proprietaire === ME).forEach(a => {
    const pv = DB.parametres.find(p => p.cle === 'v3|' + a.id);
    if (pv && !DB.reglages.some(r => r.id === a.id + '|v3')) ops.push(upd('Reglages', { id: a.id + '|v3', compte: a.id, cle: 'v3', valeur: pv.valeur }), del('Parametres', 'v3|' + a.id));
    if (started3(a.id) && !DB.reglages.some(r => r.id === a.id + '|salaire')) {
      // la prévue « ½ 13ème mois » de la V3.0 devient la prime du même mois (son montant est repris)
      const P = defaultPlan(a.id), parts = P.primes.filter(p => p.type === 'part');
      DB.prevues.filter(p => p.compte === a.id && !p.etat && /13/.test(p.libelle)).forEach(p => {
        const pr = parts.find(x => +x.mois === +p.date.slice(5, 7)), v = Math.abs(num(p.montant) || 0);
        if (!pr) return;
        if (v && !pr.montants[p.date.slice(0, 4)]) pr.montants[p.date.slice(0, 4)] = r2(v);
        ops.push(del('Prevues', p.id));
      });
      ops.push(regOp(a.id, 'salaire', P));
    }
  });
  if (ops.length) commit(ops);
}

/* ----- Réglages ----- */
function vSet() {
  const sysDark = matchMedia('(prefers-color-scheme: dark)').matches, dark = UI.theme === 'dark' || (UI.theme === 'auto' && sysDark);
  const syncTxt = { ok: 'Synchronisé', wait: 'Envoi en cours…', off: 'Hors ligne', err: 'Accès coupé' }[SYNC.state] || '';
  const accBlock = A => `<div class="env" style="gap:8px"><div class="field"><label for="an-${esc(A.id)}">Nom du compte</label><input id="an-${esc(A.id)}" data-accname="${esc(A.id)}" value="${esc(A.nom)}"></div>
    <div class="mini">${A.proprietaire ? 'Compte privé' : DB.profils.length > 1 ? 'Compte partagé' : ''}${started3(A.id) ? ` · suivi depuis le ${fmtJA(v3(A.id).debut)}` : ' · suivi pas encore démarré'}</div>
    ${started3(A.id) ? `<div class="actions" id="rs-${esc(A.id)}"><button class="btn danger small" data-reset="${esc(A.id)}">Recommencer le suivi de ce compte</button></div>` : ''}</div>`;
  return `<section class="view">${backPlus}<h2 class="title">Réglages</h2>
    ${vBankSet()}
    <div class="hero" style="gap:10px"><div class="rowhead"><h2>Comptes</h2></div><div class="list">${accs().map(accBlock).join('')}</div>
      <div class="hint">« Recommencer » efface les opérations, fixes, cycles, prévues et règles apprises de ce compte dans Le 31 (pas à la banque), pour redémarrer à une autre date. Les budgets sont gardés.</div></div>
    ${vProfiles()}
    <div class="hero" style="gap:6px"><div class="rowhead"><h2>Apparence</h2></div>
      <label class="switch" for="th-auto"><span>Suivre le réglage du téléphone</span><input type="checkbox" id="th-auto" data-theme-auto="1" ${UI.theme === 'auto' ? 'checked' : ''}></label>
      <label class="switch" for="th-dark" style="${UI.theme === 'auto' ? 'opacity:.45' : ''}"><span>Mode sombre</span><input type="checkbox" id="th-dark" data-theme-dark="1" ${dark ? 'checked' : ''} ${UI.theme === 'auto' ? 'disabled' : ''}></label></div>
    <div class="hero" style="gap:8px"><div class="rowhead"><h2>Synchronisation</h2><span class="pill ${SYNC.state === 'ok' ? 'good' : SYNC.state === 'err' ? 'bad' : 'warn'}">${syncTxt}</span></div>
      <div class="hint">Les saisies partent tout de suite vers le Google Sheet ; sans réseau, elles sont gardées et envoyées au retour de la connexion.${QUEUE.length ? ` <b>${QUEUE.length} modification(s) en attente.</b>` : ''} Dernière synchro : ${SYNC.last ? new Date(SYNC.last).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }) : 'jamais'}.</div>
      <button class="btn ghost small" data-syncnow="1">Synchroniser maintenant</button></div>
  </section>`;
}
function resetOps3(acc) {
  const ops = [];
  ['mouvements', 'recurrents', 'cycles', 'prevues', 'apprentissage'].forEach(k => DB[k].filter(r => r.compte === acc).forEach(r => ops.push(del(TABS[k], r.id))));
  ops.push(del('Parametres', 'v3|' + acc));
  return ops;
}

/* ================= Feuilles ================= */
const catSelect = (acc, sel, id) => `<select id="${id}"><option value="">—</option>${catNames(acc).map(n => `<option ${n === sel ? 'selected' : ''}>${esc(n)}</option>`).join('')}${sel && !catNames(acc).includes(sel) ? `<option selected>${esc(sel)}</option>` : ''}<option value="__new">+ Nouvelle catégorie…</option></select><input id="${id}New" placeholder="Nouvelle catégorie" hidden>`;
const readCat = id => { const v = $(id).value; return v === '__new' ? ($(id + 'New').value || '').trim() : v; };
// Une opération (correction du classement, saisie à la main)
function opSheet(o) {
  const acc = o.compte, v = num(o.montant) || 0, man = !o.ref && o.type !== 'ajust';
  const kinds = [['ponct', 'Ponctuel'], ['fixe', 'Fixe']].concat(v > 0 ? [['sal', isPerso(acc) ? 'Salaire' : 'Début de cycle']] : []).concat(livretsOf(acc).length ? [['epargne', 'Épargne']] : []).concat([['', 'À classer']]);
  const recs = DB.recurrents.filter(r => r.compte === acc && (r.sens === '+') === (v > 0));
  const k = o.type === 'ajust' ? 'ajust' : (o.type || '');
  openSheet(`<form class="form" id="opForm" data-id="${esc(o.id)}" novalidate>
    <div class="rowhead"><h2>${esc(nameOf(o))}</h2><span class="mono">${sgn(v)}</span></div>
    ${o.ref ? `<div class="raw">${esc(o.libelle)} · ${fmtJA(o.date)} · banque</div>` : ''}
    ${o.type === 'ajust' ? `<div class="note">Correction ajoutée pour que le solde de Le 31 soit égal à celui de la banque (${fmtJA(o.date)}).</div>` : `
    <div class="seg seg${kinds.length}" id="opKinds">${kinds.map(([x, l]) => `<button type="button" data-okind="${x}" aria-pressed="${k === x}">${l}</button>`).join('')}</div>
    ${man ? `<div class="two"><div class="field"><label for="oD">Date</label><input type="date" id="oD" value="${esc(o.date)}"></div><div class="field"><label for="oA">Montant (€)</label><input id="oA" inputmode="decimal" value="${fr(Math.abs(v))}"></div></div>
      <div class="field"><label for="oL">Libellé</label><input id="oL" value="${esc(o.libelle)}"></div>` : `<div class="field"><label for="oN">Nom</label><input id="oN" value="${esc(nameOf(o))}"></div>`}
    <div class="field" data-for="fixe" ${k === 'fixe' ? '' : 'hidden'}><label for="oR">Charge fixe</label><select id="oR">${recs.map(r => `<option value="${esc(r.id)}" ${r.id === o.lien ? 'selected' : ''}>${esc(r.libelle)} · le ${esc(r.jour)}</option>`).join('')}<option value="" ${!recOf(o.lien) ? 'selected' : ''}>Nouvelle charge fixe (avec ce nom)</option></select></div>
    <div class="field" data-for="cat" ${k === 'ponct' || k === 'fixe' ? '' : 'hidden'}><label for="oC">Catégorie</label>${catSelect(acc, o.categorie, 'oC')}</div>
    ${livretsOf(acc).length ? `<div class="field" data-for="liv" ${k === 'epargne' ? '' : 'hidden'}><label for="oLiv">${v < 0 ? 'Versement vers' : 'Retrait depuis'}</label><select id="oLiv">${livretsOf(acc).map(L => `<option value="${esc(L.id)}" ${L.id === o.livret ? 'selected' : ''}>${livName(L)}</option>`).join('')}</select></div>` : ''}`}
    <div class="actions">${man ? `<button type="button" class="btn danger" data-odel="${esc(o.id)}">Supprimer</button>` : o.type === 'ajust' ? `<button type="button" class="btn danger" data-odel="${esc(o.id)}">Supprimer</button>` : ''}<button class="btn" type="submit">Enregistrer</button></div>
    <div id="confirmBox"></div></form>`);
}
// Saisie à la main : réalisée (ponctuel) ou prévue
function addSheet(acc, p) {
  const v = p ? num(p.montant) || 0 : -1, isP = !!p;
  openSheet(`<form class="form" id="addForm" data-acc="${esc(acc)}" data-pid="${esc(p ? p.id : '')}" novalidate>
    <h2>${p ? 'Opération prévue' : 'Saisir · ' + esc(shortAcc(acc))}</h2>
    <div class="seg" id="addSens"><button type="button" data-asens="-" aria-pressed="${v < 0}">Dépense</button><button type="button" data-asens="+" aria-pressed="${v > 0}">Rentrée</button></div>
    <div class="amountbox"><input id="aA" inputmode="decimal" placeholder="0" value="${p ? fr(Math.abs(v)) : ''}"><span>€</span></div>
    <div class="field"><label for="aL">Libellé</label><input id="aL" value="${esc(p ? p.libelle : '')}" placeholder="Ex. Cadeau"></div>
    <div class="two"><div class="field"><label for="aD">Date</label><input type="date" id="aD" value="${esc(p ? p.date : TODAY_ISO)}"></div><div class="field"><label for="aC">Catégorie</label>${catSelect(acc, p ? p.categorie : '', 'aC')}</div></div>
    ${livSelect(acc, p ? p.livret : '', 'aLiv')}
    ${p ? `<label class="check"><input type="checkbox" id="aDone" ${p.etat ? 'checked' : ''}><span>Réalisée (ne compte plus dans l'atterrissage)</span></label>` : `<label class="check"><input type="checkbox" id="aPrev"><span><b>Prévue</b> (pas encore passée) : compte dans l'atterrissage jusqu'à ce que la banque la voie</span></label>`}
    <div class="actions">${p ? `<button type="button" class="btn danger" data-pdel="${esc(p.id)}">Supprimer</button>` : ''}<button class="btn" type="submit">Enregistrer</button></div>
    ${isP ? '' : '<p class="hint">Avec la banque reliée, inutile de saisir ce qu\'elle va remonter : une saisie est reconnue quand la banque voit le même montant à ± 4 jours.</p>'}</form>`);
}
// Charge fixe (récurrente)
function recSheet(acc, r) {
  openSheet(`<form class="form" id="recForm" data-acc="${esc(acc)}" data-id="${esc(r ? r.id : '')}" novalidate>
    <h2>${r ? 'Charge fixe' : 'Nouvelle charge fixe'}</h2>
    <div class="seg" id="recSens"><button type="button" data-rsens="-" aria-pressed="${!r || r.sens !== '+'}">Charge / virement</button><button type="button" data-rsens="+" aria-pressed="${!!r && r.sens === '+'}">Rentrée</button></div>
    <div class="field"><label for="rL">Nom</label><input id="rL" value="${esc(r ? r.libelle : '')}" placeholder="Ex. Orange"></div>
    <div class="two"><div class="field"><label for="rA">Montant (€)</label><input id="rA" inputmode="decimal" value="${r ? fr(r.montant) : ''}"></div><div class="field"><label for="rJ">Jour du mois</label><input id="rJ" inputmode="numeric" value="${esc(r ? r.jour : '')}"></div></div>
    <div class="field"><label for="rC">Catégorie</label>${catSelect(acc, r ? r.categorie : '', 'rC')}</div>
    ${livSelect(acc, r ? r.livret : '', 'rLiv')}
    <div class="two"><div class="field"><label for="rD">Début</label><input type="date" id="rD" value="${esc(r ? r.debut : (curCycle(acc) || {}).debut || TODAY_ISO)}"></div><div class="field"><label for="rF">Fin (facultatif)</label><input type="date" id="rF" value="${esc(r ? r.fin : '')}"></div></div>
    ${r ? `<label class="switch" for="rOn"><span>Active</span><input type="checkbox" id="rOn" ${bool(r.actif) ? 'checked' : ''}></label>` : ''}
    ${r && r.motif ? `<div class="hint">Reconnue à la banque sous « ${esc(r.motif.replace(/^\+/, ''))} ».</div>` : ''}
    <div class="actions">${r ? `<button type="button" class="btn danger" data-rdel="${esc(r.id)}">Supprimer</button>` : ''}<button class="btn" type="submit">Enregistrer</button></div><div id="confirmBox"></div></form>`);
}
function budSheet(acc, b) {
  openSheet(`<form class="form" id="budForm" data-acc="${esc(acc)}" data-id="${esc(b ? b.id : '')}" novalidate>
    <h2>${b ? esc(b.nom) : 'Nouveau budget'}</h2>
    <div class="field"><label for="bN">Catégorie</label><input id="bN" value="${esc(b ? b.nom : '')}" placeholder="Ex. Courses"></div>
    <div class="field"><label for="bB">Budget par cycle (€)</label><input id="bB" inputmode="decimal" value="${b ? fr(b.budget) : ''}" placeholder="vide = catégorie sans budget"></div>
    <div class="actions">${b ? `<button type="button" class="btn danger" data-bdel="${esc(b.id)}">Supprimer</button>` : ''}<button class="btn" type="submit">Enregistrer</button></div>
    <div class="hint">Supprimer une catégorie ne change pas les opérations déjà classées.</div><div id="confirmBox"></div></form>`);
}
function cycSheet(acc, c) {
  const R = cycleCalc(acc, c), P = isPerso(acc), k = departKind(c);
  openSheet(`<form class="form" id="cycForm" data-acc="${esc(acc)}" data-mois="${esc(c.mois)}" novalidate>
    <h2>Cycle ${deMois(c.mois)} ${pm(c.mois).y}</h2>
    ${c.sal ? `<div class="note good">${P ? 'Salaire' : esc(salLabel(acc))} vu à la banque le <b>${fmtJA(c.sal.date)}</b> (${eurM(num(c.sal.montant))}).</div>` : ''}
    <div class="two"><div class="field"><label for="cyD">${P ? 'Date du salaire' : 'Date du virement'}</label><input type="date" id="cyD" value="${esc(c.debut)}" ${c.i === 0 ? 'disabled' : ''}></div>
    <div class="field"><label for="cyM">${P ? 'Salaire de base (€)' : 'Montant (€)'}</label><input id="cyM" inputmode="decimal" value="${fr(c.base)}"></div></div>
    ${c.detail.rappel || c.detail.primes.length ? `<div class="note">Paie attendue : ${eurM(c.base)}${c.detail.rappel ? ' + rattrapage ' + eurM(c.detail.rappel) : ''}${c.detail.primes.map(p => ' + ' + esc(p.nom.toLowerCase()) + ' ' + eurM(p.v)).join('')} = <b>${eurM(c.montant)}</b></div>` : ''}
    <div class="field"><label for="cyS">Solde de départ (vide = automatique)</label><input id="cyS" inputmode="decimal" value="${c.man.includes('s') || c.man.includes('b') ? fr(c.row.soldeDepart) : ''}" placeholder="automatique : ${esc(eurM(R.depart))}"></div>
    <div class="hint">Solde juste avant ${P ? 'le salaire' : 'le virement'}. Automatique : ${c.i === 0 ? 'solde lu à la banque au démarrage' : 'fin réelle du cycle précédent quand il est fini, sinon son atterrissage avec budget'}. Actuellement : <b>${esc(k)}</b>.${c.i === 0 ? ' La date de début du suivi ne se change pas ici (Réglages > Recommencer le suivi).' : ''}</div>
    <div class="actions">${c.man ? `<button type="button" class="btn ghost" data-cyauto="${esc(c.mois)}">Tout en automatique</button>` : ''}<button class="btn" type="submit">Enregistrer</button></div></form>`);
}
function seuilSheet(o) {
  const acc = o.compte, key = keyOf(o.libelle), r = ruleOf3(acc, skOf(o)), cats = r ? String(r.categorie || '').split('|').filter(Boolean) : [];
  openSheet(`<form class="form" id="seuilForm" data-acc="${esc(acc)}" data-key="${esc(key)}" novalidate><h2>Séparer « ${esc(nameOf(o))} » par montant</h2>
    <div class="field"><label for="seS">Seuil (€)</label><input id="seS" inputmode="decimal" placeholder="Ex. 40"></div>
    <div class="two"><div class="field"><label for="seBas">Jusqu'au seuil</label><input id="seBas" value="${esc(cats[0] || '')}"></div><div class="field"><label for="seHaut">Au-dessus</label><input id="seHaut" value="${esc(cats[1] || '')}"></div></div>
    <div class="hint">Ex. Super U : courses jusqu'à 40 €, carburant au-dessus. Chaque opération est ensuite classée seule selon son montant.</div>
    <button class="btn" type="submit">Enregistrer</button></form>`);
}

/* ================= Événements ================= */
document.addEventListener('toggle', ev => { if (ev.target && ev.target.id === 'jpj') { UI.jpj = ev.target.open; store.set('le31-jpj', UI.jpj); } }, true);
document.addEventListener('click', ev => {
  const t = ev.target.closest('button,.sheet-bg,input[type=checkbox]'); if (!t) return;
  if (t.classList.contains('sheet-bg')) { if (ev.target === t) closeSheet(); return; }
  const ds = t.dataset, acc = UI.acc;
  if (ds.retry) { pull(); return; }
  if (ds.closebtn) { closeSheet(); return; }
  if (ds.acc) { UI.acc = ds.acc; store.set('le31-compte', UI.acc); UI.td = {}; render(); return; }
  if (ds.tab) { UI.tab = ds.tab; if (ds.tab === 'todo') BK.res = null; render(); scrollTo(0, 0); return; }
  if (ds.cyc) { const cy = cyclesOf(acc), c = selCycle(acc), n = cy[c.i + (+ds.cyc)]; if (n) UI.cyc[acc] = n.mois; render(); return; }
  if (ds.jpjall) { UI.jpjAll = !UI.jpjAll; render(); return; }
  if (ds.autoall) { UI.autoAll = !UI.autoAll; render(); return; }
  if (ds.tsel) { UI.td = { id: ds.tsel, kind: ds.tk }; render(); const f = $('todoForm'); if (f) f.scrollIntoView({ block: 'start' }); return; }
  if (ds.tkind) { keepTodoInputs(); UI.td.kind = ds.tkind; if (ds.tkind === 'fixe' && UI.td.rec === undefined) UI.td.rec = ''; render(); return; }
  if (ds.tcat) { UI.td.cat = UI.td.cat === ds.tcat && ds.tcat !== '__new' ? '' : ds.tcat; document.querySelectorAll('[data-tcat]').forEach(b => b.setAttribute('aria-pressed', b.dataset.tcat === UI.td.cat)); const n = $('tdCatNew'); if (n) { n.hidden = UI.td.cat !== '__new'; if (!n.hidden) n.focus(); } return; }
  if (ds.seuil) { const o = DB.mouvements.find(x => x.id === ds.seuil); if (o) seuilSheet(o); return; }
  if (ds.oid) { const o = DB.mouvements.find(x => x.id === ds.oid); if (o) opSheet(o); return; }
  if (ds.okind !== undefined) { document.querySelectorAll('[data-okind]').forEach(b => b.setAttribute('aria-pressed', b === t)); const f = document.querySelector('[data-for="fixe"]'), c = document.querySelector('[data-for="cat"]'); if (f) f.hidden = ds.okind !== 'fixe'; if (c) c.hidden = !(ds.okind === 'ponct' || ds.okind === 'fixe'); const lv = document.querySelector('[data-for="liv"]'); if (lv) lv.hidden = ds.okind !== 'epargne'; return; }
  if (ds.txtab) { UI.txTab = ds.txtab; render(); return; }
  if (ds.txseg) { UI.txSeg = ds.txseg; render(); return; }
  if (ds.newop) { addSheet(acc, null); return; }
  if (ds.pid) { const p = DB.prevues.find(x => x.id === ds.pid); if (p) addSheet(p.compte, p); return; }
  if (ds.asens) { document.querySelectorAll('[data-asens]').forEach(b => b.setAttribute('aria-pressed', b === t)); return; }
  if (ds.rsens) { document.querySelectorAll('[data-rsens]').forEach(b => b.setAttribute('aria-pressed', b === t)); return; }
  if (ds.newrec) { recSheet(acc, null); return; }
  if (ds.rid) { const r = recOf(ds.rid); if (r) recSheet(r.compte, r); return; }
  if (ds.newbud) { budSheet(acc, null); return; }
  if (ds.bid) { const b = DB.budgets.find(x => x.id === ds.bid); if (b) budSheet(b.compte, b); return; }
  if (ds.cycm) { const c = cycleByMois(acc, ds.cycm); if (c) cycSheet(acc, c); return; }
  if (ds.cyauto) {
    const id = acc + '|' + ds.cyauto, r = DB.cycles.find(x => x.id === id) || {}, b = String(r.manuel || '').includes('b'), first = ds.cyauto === (v3(acc) || {}).mois;
    const row = { id, compte: acc, mois: ds.cyauto, manuel: b ? 'b' : '' }; if (!b) row.soldeDepart = ''; if (!first) row.debut = '';
    commit([upd('Cycles', row)]); closeSheet(); toast('Cycle en automatique'); return;
  }
  if (ds.simtab) { UI.simTab = ds.simtab; render(); return; }
  if (ds.saadd) { simOf(acc).achats.push({ lib: '', date: '', montant: '' }); saveSim(); render(); return; }
  if (ds.sadel) { simOf(acc).achats.splice(+ds.sadel, 1); saveSim(); render(); return; }
  if (ds.scadd) { simOf(acc).credits.push({ lib: '', mens: '', debut: '', fin: '', remplace: '', frais: '' }); saveSim(); render(); return; }
  if (ds.scdel) { simOf(acc).credits.splice(+ds.scdel, 1); saveSim(); render(); return; }
  if (ds.reset) { $('rs-' + ds.reset).innerHTML = `<div class="alert bad" style="display:flex;justify-content:space-between;align-items:center;gap:8px">Tout effacer pour ce compte et redémarrer ?<button class="btn danger small" data-resetok="${esc(ds.reset)}">Effacer</button></div>`; return; }
  if (ds.resetok) { commit(resetOps3(ds.resetok)); UI.tab = 'home'; UI.acc = ds.resetok; toast('Suivi effacé : choisis la nouvelle date de début'); render(); return; }
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
  if (ds.bklink) { BK.view = 'bank'; BK.acc = ds.bklink; BK.q = ''; render(); scrollTo(0, 0); if (!BK.list) api({ action: 'banques' }).then(j => { BK.list = j.banques; render(); }).catch(e => { toast('Banque : ' + e.message); BK.view = null; render(); }); return; }
  if (ds.bkbank) { bankStart(BK.acc, ds.bkbank); return; }
  if (ds.bkrenew) { const r = bkRow(ds.bkrenew); if (r) bankStart(ds.bkrenew, r.aspsp); return; }
  if (ds.bkunlink) { t.outerHTML = `<button class="btn danger small" data-bkunlinkok="${esc(ds.bkunlink)}">Confirmer</button>`; return; }
  if (ds.bkunlinkok) { bankUnlink(ds.bkunlinkok); return; }
  if (ds.bksync) { bankSync({ force: true }); return; }
  if (ds.bkok) { BK.res = null; render(); return; }
  if (ds.bkclose) { BK.view = null; BK.msg = ''; if (bkPend()) bankLinkCancel(); render(); return; }
  if (ds.bklier) { bankLink(); return; }
  if (ds.invite) { invite(ds.invite); return; }
  if (ds.cut || ds.cutall) {
    openSheet(`<div class="form"><h2>Couper ${ds.cut ? 'cet appareil' : 'tous les accès'} de ${esc(ds.cutname)} ?</h2>
      <div class="note warn">${ds.cut ? 'Cet appareil ne pourra plus rien voir ni saisir, tout de suite.' : 'Tous ses appareils seront déconnectés et ses liens en attente annulés.'} Les données restent intactes.</div>
      <div class="actions"><button class="btn ghost" data-closebtn="1">Annuler</button><button class="btn danger" data-cutok="${esc(ds.cut || '')}" data-cutprof="${esc(ds.cutall || '')}">Couper l'accès</button></div></div>`);
    return;
  }
  if ('cutok' in ds) { cutAccess(ds.cutok ? { acces: ds.cutok } : { profil: ds.cutprof }, 'Accès coupé'); return; }
  if (ds.copyshare) { const tx = $('shareTxt'); copyText(tx.value, tx); return; }
  if (ds.doshare) { const tx = $('shareTxt').value; if (navigator.share) navigator.share({ text: tx }).then(() => { closeSheet(); toast('Lien partagé'); }).catch(() => {}); else copyText(tx, $('shareTxt')); return; }
  const box = () => $('confirmBox'), conf = (txt, attr, id) => { box().innerHTML = `<div class="alert bad" style="display:flex;justify-content:space-between;align-items:center;gap:8px">${txt}<button type="button" class="btn danger small" data-${attr}="${esc(id)}">Supprimer</button></div>`; };
  if (ds.odel) { conf('Supprimer cette opération ?', 'odelok', ds.odel); return; }
  if (ds.odelok) { commit([del('Mouvements', ds.odelok)]); closeSheet(); toast('Opération supprimée'); return; }
  if (ds.pdel) { commit([del('Prevues', ds.pdel)]); closeSheet(); toast('Prévue supprimée'); return; }
  if (ds.rdel) { conf('Les opérations déjà classées en fixe repasseront à classer.', 'rdelok', ds.rdel); return; }
  if (ds.rdelok) { const ops = [del('Recurrents', ds.rdelok)]; DB.mouvements.filter(o => o.type === 'fixe' && o.lien === ds.rdelok).forEach(o => ops.push(upd('Mouvements', { id: o.id, type: '', lien: '', auto: '' }))); commit(ops); closeSheet(); toast('Charge fixe supprimée'); return; }
  if (ds.bdel) { commit([del('Budgets', ds.bdel)]); closeSheet(); toast('Catégorie supprimée'); return; }
});
const refocus = id => { const e = $(id); if (e) { e.focus(); const n = e.value.length; try { e.setSelectionRange(n, n); } catch (x) {} } };
let qT;
document.addEventListener('input', ev => {
  const ds = ev.target.dataset || {};
  if (ds.sa !== undefined || ds.sc !== undefined) { const L = ds.sa !== undefined ? simOf(UI.acc).achats[+ds.sa] : simOf(UI.acc).credits[+ds.sc]; L[ds.f] = ev.target.value; saveSim(); clearTimeout(qT); qT = setTimeout(simRefresh, 250); return; }
  if (ev.target.id === 'bkQ') { BK.q = ev.target.value; clearTimeout(qT); qT = setTimeout(() => { render(); refocus('bkQ'); }, 200); return; }
});
document.addEventListener('change', ev => {
  const el = ev.target, ds = el.dataset;
  if (ds.themeAuto) { UI.theme = el.checked ? 'auto' : (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'); applyTheme(); render(); return; }
  if (ds.themeDark) { UI.theme = el.checked ? 'dark' : 'light'; applyTheme(); render(); return; }
  if (el.id === 'stBk') { $('stSWrap').hidden = el.checked; return; }
  if (el.tagName === 'SELECT' && el.value === '__new' && $(el.id + 'New')) { $(el.id + 'New').hidden = false; $(el.id + 'New').focus(); return; }
  if (el.id === 'tdRec') { keepTodoInputs(); render(); return; }
  if (ds.sa !== undefined) { simOf(UI.acc).achats[+ds.sa][ds.f] = el.value; saveSim(); simRefresh(); return; }
  if (ds.sc !== undefined) { simOf(UI.acc).credits[+ds.sc][ds.f] = el.value; saveSim(); simRefresh(); return; }
  if (ds.accname) { const v = el.value.trim(); if (v) commit([upd('Comptes', { id: ds.accname, nom: v })]); return; }
  if (ds.prof) { const v = el.value.trim(); if (v) commit([upd('Profils', { id: ds.prof, nom: v })]); return; }
  if (ds.cfj) { const j = Math.min(31, Math.max(1, num(el.value) || 26)), S = v3(ds.cfj); if (S) commit([upd('Parametres', { cle: 'v3|' + ds.cfj, valeur: JSON.stringify(Object.assign({}, S, { jour: j })) })]); return; }
  if (ds.cfn) { commit([upd('Parametres', { cle: 'v3nomrev|' + ds.cfn, valeur: el.value.trim() })]); return; }
  if (el.id === 'onbC') { ONB.commun = el.checked; return; }
  if (ds.bksel) { BK.sel[ds.bksel] = el.value; render(); return; }
  if (el.id === 'bkAuto') { BK.auto = el.checked; store.set('le31-bk-auto', BK.auto); return; }
});
document.addEventListener('submit', ev => {
  ev.preventDefault(); const f = ev.target;
  if (f.id === 'keyForm') {
    if (!readLink($('keyIn').value.trim())) { toast("Lien non reconnu : il doit contenir #inv="); return; }
    if (!apiOk()) { toast("Le lien ne contient pas l'adresse du serveur : refais-le"); return; }
    JOIN.iosOk = true; JOIN.err = ''; SYNC.error = ''; join(); return;
  }
  if (f.id === 'onbName') { const n = $('onbN').value.trim(); if (!n) { toast('Indique ton prénom'); return; } ONB.name = n; ONB.step = 1; render(); return; }
  if (f.id === 'startForm') { startAccount(f.dataset.acc); return; }
  if (f.id === 'todoForm') {
    const o = DB.mouvements.find(x => x.id === f.dataset.id); if (!o) return;
    keepTodoInputs(); const h = readTodo(o);
    if (h.type === 'ponct' && !h.categorie) { toast('Choisis une catégorie'); return; }
    if (h.type === 'fixe' && !h.recId && !(h.newRec.montant > 0)) { toast('Indique le montant habituel'); return; }
    commit(classifyOps(o, h)); UI.td = {}; toast('Classée'); return;
  }
  if (f.id === 'opForm') {
    const o = DB.mouvements.find(x => x.id === f.dataset.id); if (!o) { closeSheet(); return; }
    if (o.type === 'ajust') { closeSheet(); return; }
    const kb = f.querySelector('[data-okind][aria-pressed=true]'), type = kb ? kb.dataset.okind : (o.type || '');
    const ops = [];
    if (!o.ref) { // saisie à la main : date, montant, libellé modifiables
      const a = num($('oA').value), dt = $('oD').value; if (!(a > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(dt)) { toast('Indique la date et le montant'); return; }
      const neg = (num(o.montant) || 0) < 0; o.montant = r2(neg ? -a : a); o.date = dt; o.libelle = $('oL').value.trim() || o.libelle;
      ops.push(upd('Mouvements', { id: o.id, montant: o.montant, date: dt, libelle: o.libelle }));
    }
    if (!type) ops.push(upd('Mouvements', { id: o.id, type: '', lien: '', categorie: '', auto: '', nom: '' }));
    else {
      const cat = readCat('oC'), nom = $('oN') ? $('oN').value.trim() : '';
      const h = { type, categorie: cat, nom: nom && nom !== smartName(o.libelle || '') ? nom : '' };
      if (type === 'fixe') { h.recId = $('oR').value; if (!h.recId) h.newRec = { libelle: nom || nameOf(o), jour: +o.date.slice(8, 10), montant: Math.abs(num(o.montant) || 0) }; }
      if (type === 'epargne') { h.livret = $('oLiv') ? $('oLiv').value : ''; h.categorie = 'Épargne'; }
      ops.push(...classifyOps(o, h));
    }
    commit(ops); closeSheet(); toast('Opération mise à jour'); return;
  }
  if (f.id === 'addForm') {
    const acc = f.dataset.acc, a = num($('aA').value), dt = $('aD').value, lb = $('aL').value.trim(), cat = readCat('aC');
    const neg = (f.querySelector('[data-asens][aria-pressed=true]') || {}).dataset.asens !== '+';
    if (!(a > 0)) { toast('Indique un montant'); return; } if (!/^\d{4}-\d{2}-\d{2}$/.test(dt)) { toast('Indique une date'); return; }
    const v = r2(neg ? -a : a), ops = cat ? newCatOps(acc, cat) : [];
    const liv = $('aLiv') ? $('aLiv').value : '';
    if (f.dataset.pid) ops.push(upd('Prevues', { id: f.dataset.pid, date: dt, libelle: lb || cat || 'Prévue', montant: v, categorie: cat, etat: $('aDone').checked ? 'realisee' : '', livret: liv }));
    else if ($('aPrev').checked) ops.push(upd('Prevues', { id: uid(), compte: acc, date: dt, libelle: lb || cat || 'Prévue', montant: v, categorie: cat, etat: '', lien: '', livret: liv }));
    else ops.push(upd('Mouvements', { id: uid(), compte: acc, date: dt, montant: v, libelle: lb || cat || 'Opération', nom: '', categorie: cat || (liv ? 'Épargne' : ''), type: liv ? 'epargne' : 'ponct', lien: '', auto: '', ref: '', profil: ME || '', livret: liv }));
    commit(ops); closeSheet(); toast('Enregistré'); return;
  }
  if (f.id === 'recForm') {
    const acc = f.dataset.acc, a = num($('rA').value), j = num($('rJ').value), l = $('rL').value.trim(), cat = readCat('rC');
    if (!l || !(a > 0) || !(j >= 1 && j <= 31)) { toast('Indique le nom, le montant et le jour (1 à 31)'); return; }
    const sens = (f.querySelector('[data-rsens][aria-pressed=true]') || {}).dataset.rsens || '-';
    const row = { id: f.dataset.id || uid(), compte: acc, libelle: l, montant: r2(a), sens, jour: j, categorie: cat, debut: $('rD').value, fin: $('rF').value, actif: $('rOn') ? ($('rOn').checked ? 'oui' : 'non') : 'oui', livret: $('rLiv') ? $('rLiv').value : '' };
    if (!f.dataset.id) row.motif = '';
    commit([...(cat ? newCatOps(acc, cat) : []), upd('Recurrents', row)]); closeSheet(); toast('Charge fixe enregistrée'); return;
  }
  if (f.id === 'budForm') {
    const acc = f.dataset.acc, n = $('bN').value.trim(), b = num($('bB').value); if (!n) { toast('Indique la catégorie'); return; }
    const ex = f.dataset.id && DB.budgets.find(x => x.id === f.dataset.id), ops = [];
    ops.push(upd('Budgets', { id: f.dataset.id || uid(), compte: acc, nom: n, budget: b === null ? '' : r2(b), ordre: ex ? ex.ordre : Math.max(0, ...budgetsOf(acc).map(x => num(x.ordre) || 0)) + 1 }));
    if (ex && ex.nom !== n) { // renommer : les opérations, fixes et règles suivent
      DB.mouvements.filter(o => o.compte === acc && o.categorie === ex.nom).forEach(o => ops.push(upd('Mouvements', { id: o.id, categorie: n })));
      DB.recurrents.filter(r => r.compte === acc && r.categorie === ex.nom).forEach(r => ops.push(upd('Recurrents', { id: r.id, categorie: n })));
      DB.apprentissage.filter(r => r.compte === acc && String(r.categorie).split('|').includes(ex.nom)).forEach(r => ops.push(upd('Apprentissage', { id: r.id, categorie: String(r.categorie).split('|').map(x => x === ex.nom ? n : x).join('|') })));
    }
    commit(ops); closeSheet(); toast('Budget enregistré'); return;
  }
  if (f.id === 'cycForm') {
    const acc = f.dataset.acc, k = f.dataset.mois, c = cycleByMois(acc, k), d = $('cyD').value, m = num($('cyM').value), sRaw = $('cyS').value.trim(), s = num(sRaw);
    const man = new Set(String(c.row.manuel || '').split('').filter(x => x !== 'b' || !sRaw)), row = { id: acc + '|' + k, compte: acc, mois: k };
    if (c.i > 0 && /^\d{4}-\d{2}-\d{2}$/.test(d) && d !== c.debut) { row.debut = d; man.add('d'); }
    if (m !== null && r2(m) !== r2(c.base)) { row.montant = r2(m); man.add('m'); }
    if (sRaw && s !== null) { row.soldeDepart = r2(s); if (!(c.man.includes('b') && r2(s) === r2(num(c.row.soldeDepart)))) { man.delete('b'); man.add('s'); } }
    else if (!sRaw && !c.man.includes('b')) { row.soldeDepart = ''; man.delete('s'); }
    row.manuel = [...man].join('');
    if (c.i === 0) row.debut = c.debut;
    commit([upd('Cycles', row)]); closeSheet(); toast('Cycle enregistré'); return;
  }
  if (f.id === 'seuilForm') {
    const acc = f.dataset.acc, key = f.dataset.key, s = num($('seS').value), bas = $('seBas').value.trim(), haut = $('seHaut').value.trim();
    if (s === null || s <= 0 || !bas || !haut) { toast('Indique un seuil et les deux catégories'); return; }
    commit([...newCatOps(acc, bas), ...newCatOps(acc, haut), upd('Parametres', { cle: 'seuilCat|' + acc + '|' + key, valeur: JSON.stringify({ s: r2(s), bas, haut }) })]);
    closeSheet(); UI.td.cat = undefined; toast('Séparation enregistrée'); return;
  }
  if (f.id === 'profForm') {
    const n = $('pfnew').value.trim(); if (!n) { toast('Indique un prénom'); return; }
    const id = 'p' + uid();
    commit([upd('Profils', { id, nom: n, perso: $('pfperso').checked ? 'oui' : 'non', ordre: Math.max(0, ...DB.profils.map(p => num(p.ordre) || 0)) + 1 })]);
    setTimeout(() => invite(id), 400); return;
  }
});

/* ================= V3.1 : événements (évolution du salaire, épargne, mois par mois) ================= */
document.addEventListener('toggle', ev => {
  const id = ev.target && ev.target.id;
  if (id === 'mpm') { UI.mpmOpen = ev.target.open; store.set('le31-mpmo', UI.mpmOpen); }
  if (id === 'epmpm') { UI.epMpmOpen = ev.target.open; store.set('le31-epmo', UI.epMpmOpen); }
}, true);
document.addEventListener('click', ev => {
  const t = ev.target.closest('button'); if (!t) return;
  const ds = t.dataset, acc = UI.acc;
  if (ds.gocyc) { UI.cyc[acc] = ds.gocyc; render(); scrollTo(0, 0); return; }
  if (ds.mpm) { UI.mpm = ds.mpm; store.set('le31-mpm', UI.mpm); render(); return; }
  if (ds.epmpm) { UI.epMpm = ds.epmpm; store.set('le31-epmpm', UI.epMpm); render(); return; }
  if (ds.eps) { UI.epS = ds.eps; render(); return; }
  if (ds.epm) { UI.epM = addM(UI.epM || CUR, +ds.epm); render(); return; }
  if (ds.epgo) { UI.epM = ds.epgo; render(); if (UI.tab === 'epa') scrollTo(0, 0); return; }
  if (ds.livid) { UI.epL = ds.livid; UI.tab = 'epl'; UI.eplAll = false; render(); scrollTo(0, 0); return; }
  if (ds.eplall) { UI.eplAll = !UI.eplAll; render(); return; }
  if (ds.newliv) { livSheet(acc, null); return; }
  if (ds.livedit) { const L = livOf(ds.livedit); if (L) livSheet(L.compte, L); return; }
  if (ds.livdel) { $('confirmBox').innerHTML = `<div class="alert bad" style="display:flex;justify-content:space-between;align-items:center;gap:8px">Supprimer ce livret ? Les opérations restent, sans lien.<button type="button" class="btn danger small" data-livdelok="${esc(ds.livdel)}">Supprimer</button></div>`; return; }
  if (ds.livdelok) {
    const id = ds.livdelok, ops = [del('Livrets', id)];
    DB.recurrents.filter(r => r.livret === id).forEach(r => ops.push(upd('Recurrents', { id: r.id, livret: '' })));
    DB.prevues.filter(p => p.livret === id).forEach(p => ops.push(upd('Prevues', { id: p.id, livret: '' })));
    DB.mvtsLivret.filter(m => m.livret === id).forEach(m => ops.push(del('MvtsLivret', m.id)));
    DB.mouvements.filter(o => o.livret === id).forEach(o => ops.push(upd('Mouvements', o.type === 'epargne' ? { id: o.id, livret: '', type: '', auto: '' } : { id: o.id, livret: '' })));
    UI.tab = 'epa'; commit(ops); closeSheet(); toast('Livret supprimé'); return;
  }
  if (ds.mvlnew) { const L = livOf(ds.mvlnew); if (L) mvlSheet(L, null); return; }
  if (ds.mvlid) { const m = DB.mvtsLivret.find(x => x.id === ds.mvlid); if (m && livOf(m.livret)) mvlSheet(livOf(m.livret), m); return; }
  if (ds.mvldel) { commit([del('MvtsLivret', ds.mvldel)]); closeSheet(); toast('Mouvement supprimé'); return; }
  if (ds.mvlt) { document.querySelectorAll('[data-mvlt]').forEach(b => b.setAttribute('aria-pressed', b === t)); return; }
  if (ds.tliv) { UI.td.liv = ds.tliv; document.querySelectorAll('[data-tliv]').forEach(b => b.setAttribute('aria-pressed', b.dataset.tliv === ds.tliv)); return; }
  if (ds.caltab) { UI.calTab = ds.caltab; render(); return; }
  if (ds.evohadd) { saveEvo(acc, P => { P.hausses = P.hausses || {}; const ys = Object.keys(P.hausses).map(Number); const y = ys.length ? Math.max(...ys) + 1 : pm(CUR).y + 1; P.hausses[y] = ys.length ? P.hausses[Math.max(...ys)] : 2; }); return; }
  if (ds.evohdel) { saveEvo(acc, P => { delete P.hausses[ds.evohdel]; }); return; }
  if (ds.evpadd) { saveEvo(acc, P => { (P.primes = P.primes || []).push({ id: uid(), nom: 'Prime', type: 'part', mois: 12, jour: 15, montants: {} }); }); return; }
  if (ds.evpdel) { saveEvo(acc, P => { P.primes = (P.primes || []).filter(p => p.id !== ds.evpdel); }); return; }
});
document.addEventListener('change', ev => {
  const el = ev.target, ds = el.dataset || {}, acc = UI.acc;
  if (ds.evo) { saveEvo(acc, P => { P[ds.evo] = +el.value; }); return; }
  if (ds.evoh) { const v = num(el.value); saveEvo(acc, P => { P.hausses = P.hausses || {}; if (v === null) delete P.hausses[ds.evoh]; else P.hausses[ds.evoh] = v; }); return; }
  if (ds.evp) { saveEvo(acc, P => { const p = (P.primes || []).find(x => x.id === ds.evp); if (!p) return; p[ds.f] = ds.f === 'mois' || ds.f === 'jour' ? +el.value || '' : el.value.trim(); }); return; }
  if (ds.evpm) { const v = num(el.value); saveEvo(acc, P => { const p = (P.primes || []).find(x => x.id === ds.evpm); if (!p) return; p.montants = p.montants || {}; if (v === null) delete p.montants[ds.y]; else p.montants[ds.y] = v; }); return; }
});
document.addEventListener('submit', ev => {
  const f = ev.target; ev.preventDefault();
  if (f.id === 'epaStart') { const ops = startEpaOps(f.dataset.acc); if (ops) { commit(ops); toast('Épargne démarrée'); } return; }
  if (f.id === 'livForm') {
    const acc = f.dataset.acc, n = $('lvN').value.trim(), d = $('lvD').value; if (!n || !/^\d{4}-\d{2}-\d{2}$/.test(d)) { toast('Indique le nom et la date du point zéro'); return; }
    const L = { id: f.dataset.id || uid(), compte: acc, nom: n, type: $('lvT').value, pointZero: r2(num($('lvZ').value) || 0), dateZero: d, objectif: num($('lvO').value) === null ? '' : r2(num($('lvO').value)), actif: 'oui' };
    if (!f.dataset.id) L.ordre = Math.max(0, ...livretsOf(acc).map(x => num(x.ordre) || 0)) + 1;
    const ops = [upd('Livrets', L)]; if (!f.dataset.id) ops.push(...linkOps(acc, [L]));
    commit(ops); closeSheet(); toast('Livret enregistré'); return;
  }
  if (f.id === 'mvlForm') {
    const L = livOf(f.dataset.l), a = num($('mvA').value), d = $('mvD').value, t = (f.querySelector('[data-mvlt][aria-pressed=true]') || {}).dataset.mvlt || 'vers';
    if (!L || !(a > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(d)) { toast('Indique le montant et la date'); return; }
    commit([upd('MvtsLivret', { id: f.dataset.id || uid(), compte: L.compte, livret: L.id, date: d, montant: r2(t === 'retr' ? -a : a), type: t === 'int' ? 'interets' : t === 'retr' ? 'retrait' : 'versement', libelle: $('mvL').value.trim() || (t === 'int' ? 'Intérêts' : t === 'retr' ? 'Retrait' : 'Versement') })]);
    closeSheet(); toast('Mouvement enregistré'); return;
  }
  if (f.id === 'recalForm') {
    const L = livOf(f.dataset.l), v = num($('rcV').value); if (!L || v === null) { toast('Indique le solde réel'); return; }
    const delta = r2(v - livSolde(L, TODAY_ISO)); if (Math.abs(delta) < 0.005) { toast('Déjà juste'); return; }
    commit([upd('MvtsLivret', { id: uid(), compte: L.compte, livret: L.id, date: TODAY_ISO, montant: delta, type: 'interets', libelle: 'Intérêts (recalage)' })]);
    toast('Recalé : ' + sgn(delta) + ' en intérêts'); return;
  }
});
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
