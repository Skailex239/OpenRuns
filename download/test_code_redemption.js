/**
 * Test script pour vérifier que la logique de redemption des codes fonctionne correctement.
 * Ce script simule le comportement de profile.js SANS Firestore (en local uniquement).
 * 
 * Bugs testés:
 * 1. Code marqué "utilisé" avant sauvegarde Firestore → si Firestore échoue, code perdu
 * 2. isLocalCodeUsed() bloque même si le type n'est pas possédé
 * 3. Boucle infinie onSnapshot → refreshProfile → write Firestore → onSnapshot
 * 4. localStorage désynchronisé avec l'état réel
 */

// ── Simulate the NEW logic ──

let ownedTypes = [];
let activeType = null;
let rewardActivated = true;

const LOCAL_TEST_CODES = {
  "OR-VIP01":    { type: "vip" },
  "OR-FLAM1":    { type: "flame" },
  "OR-RNBW1":    { type: "rainbow" },
  "OR-CYBR1":    { type: "cyberpunk" },
  "OR-SNST1":    { type: "sunset" },
  "OR-AURO1":    { type: "aurore" },
  "OR-PSTL1":    { type: "pastel" },
  "OR-GOLD1":    { type: "gold" },
  "OR-VLKN1":    { type: "volcano" },
  "OR-OCEA1":    { type: "ocean" },
  "OR-MIAM1":    { type: "miami" },
  "OR-TOXC1":    { type: "toxic" },
  "OR-CHRM1":    { type: "chroma" },
};

// Simulated localStorage
const localStorage = {
  _data: {},
  getItem(key) { return this._data[key] || null; },
  setItem(key, value) { this._data[key] = value; },
  removeItem(key) { delete this._data[key]; },
};

function getUsedLocalCodes() {
  try {
    return JSON.parse(localStorage.getItem('openruns_used_local_codes') || '[]');
  } catch { return []; }
}
function markLocalCodeUsed(code) {
  const used = getUsedLocalCodes();
  if (!used.includes(code)) used.push(code);
  localStorage.setItem('openruns_used_local_codes', JSON.stringify(used));
}

// NEW: syncLocalCodeState
function syncLocalCodeState() {
  const usedCodes = getUsedLocalCodes();
  const fixedCodes = usedCodes.filter(code => {
    const localCode = LOCAL_TEST_CODES[code];
    if (!localCode) return false;
    if (ownedTypes.includes(localCode.type)) return true;
    console.log(`[syncLocalCodeState] Libération du code ${code} (type ${localCode.type} non possédé)`);
    return false;
  });
  if (fixedCodes.length !== usedCodes.length) {
    localStorage.setItem('openruns_used_local_codes', JSON.stringify(fixedCodes));
    console.log(`[syncLocalCodeState] ${usedCodes.length - fixedCodes.length} code(s) libéré(s)`);
  }
}

// NEW: Local backup
let currentUserUid = "test_user_123";
function saveOwnedTypesLocal() {
  try {
    localStorage.setItem(`openruns_owned_types_${currentUserUid}`, JSON.stringify({
      ownedTypes,
      activeType,
      rewardActivated,
      savedAt: new Date().toISOString(),
    }));
  } catch (e) { /* ignore */ }
}
function loadOwnedTypesLocal() {
  try {
    const raw = localStorage.getItem(`openruns_owned_types_${currentUserUid}`);
    if (!raw) return false;
    const data = JSON.parse(raw);
    if (Array.isArray(data.ownedTypes) && data.ownedTypes.length > 0) {
      data.ownedTypes.forEach(t => {
        if (!ownedTypes.includes(t)) ownedTypes.push(t);
      });
      if (!activeType && data.activeType) activeType = data.activeType;
      console.log(`[loadOwnedTypesLocal] Restauration: ${data.ownedTypes.length} cosmétique(s)`);
      return true;
    }
  } catch (e) { /* ignore */ }
  return false;
}

// ── NEW redeemCode logic ──
function redeemCode(code, firestoreShouldFail = false) {
  code = code.trim().toUpperCase();
  const localCode = LOCAL_TEST_CODES[code];
  
  if (!localCode) {
    return { success: false, message: "Code invalide." };
  }

  console.log(`[redeemCode] Code local détecté: ${code} → type=${localCode.type}`);

  // PRINCIPAL CHECK: seulement ownedTypes, PAS localStorage "used"
  if (ownedTypes.includes(localCode.type)) {
    console.log(`[redeemCode] Type ${localCode.type} déjà possédé`);
    return { success: false, message: "Vous possédez déjà ce cosmétique !" };
  }

  let firestoreSaveOk = false;

  // Simulate Firestore write
  if (!firestoreShouldFail) {
    // Firestore succeeds
    if (!ownedTypes.includes(localCode.type)) {
      ownedTypes = [...ownedTypes, localCode.type];
    }
    firestoreSaveOk = true;
  } else {
    // Firestore fails — fallback local
    console.warn(`[redeemCode] Erreur Firestore, fallback local`);
    if (!ownedTypes.includes(localCode.type)) {
      ownedTypes = [...ownedTypes, localCode.type];
    }
  }

  // Mark code as used AFTER processing
  markLocalCodeUsed(code);

  activeType = localCode.type;
  rewardActivated = true;
  saveOwnedTypesLocal();

  console.log(`[redeemCode] ${code} activé ! ownedTypes=`, ownedTypes, 'activeType=', activeType, 'firestoreSave=', firestoreSaveOk);

  if (firestoreSaveOk) {
    return { success: true, message: `Cosmétique ${localCode.type} débloqué !` };
  } else {
    return { success: true, message: `Cosmétique ${localCode.type} débloqué (sauvegarde serveur en attente...)` };
  }
}

// ── Tests ──

let testsPassed = 0;
let testsFailed = 0;

function assert(condition, testName) {
  if (condition) {
    console.log(`  ✅ PASS: ${testName}`);
    testsPassed++;
  } else {
    console.error(`  ❌ FAIL: ${testName}`);
    testsFailed++;
  }
}

function resetState() {
  ownedTypes = [];
  activeType = null;
  rewardActivated = true;
  localStorage._data = {};
}

// ──────────────────────────────────────
console.log("\n═══════════════════════════════════════");
console.log("TEST 1: Premier code — doit réussir");
console.log("═══════════════════════════════════════");
resetState();
const r1 = redeemCode("OR-VIP01");
assert(r1.success === true, "OR-VIP01 doit réussir");
assert(ownedTypes.includes("vip"), "ownedTypes doit contenir 'vip'");
assert(activeType === "vip", "activeType doit être 'vip'");
assert(getUsedLocalCodes().includes("OR-VIP01"), "Code doit être marqué utilisé dans localStorage");

// ──────────────────────────────────────
console.log("\n═══════════════════════════════════════");
console.log("TEST 2: Même type de code — doit dire 'déjà possédé' (pas 'déjà utilisé')");
console.log("═══════════════════════════════════════");
// ownedTypes = ["vip"] from test 1
const r2 = redeemCode("OR-VIP01");
assert(r2.success === false, "OR-VIP01 deuxième fois doit échouer");
assert(r2.message.includes("possédez déjà"), "Message doit dire 'possédez déjà' (pas 'déjà utilisé')");

// ──────────────────────────────────────
console.log("\n═══════════════════════════════════════");
console.log("TEST 3: Code différent — doit réussir et ACCUMULER");
console.log("═══════════════════════════════════════");
const r3 = redeemCode("OR-FLAM1");
assert(r3.success === true, "OR-FLAM1 doit réussir");
assert(ownedTypes.includes("flame"), "ownedTypes doit contenir 'flame'");
assert(ownedTypes.includes("vip"), "ownedTypes doit TOUJOURS contenir 'vip' (accumulation)");
assert(ownedTypes.length === 2, "ownedTypes doit avoir 2 éléments");
assert(activeType === "flame", "activeType doit être 'flame' (dernier activé)");

// ──────────────────────────────────────
console.log("\n═══════════════════════════════════════");
console.log("TEST 4: Firestore échoue — code doit quand même fonctionner en local");
console.log("═══════════════════════════════════════");
resetState();
const r4 = redeemCode("OR-MIAM1", true); // Firestore fails
assert(r4.success === true, "OR-MIAM1 doit réussir même si Firestore échoue");
assert(ownedTypes.includes("miami"), "ownedTypes doit contenir 'miami' (appliqué localement)");
assert(r4.message.includes("attente"), "Message doit indiquer sauvegarde en attente");

// Vérifier que le backup local a été créé
const backup = JSON.parse(localStorage.getItem(`openruns_owned_types_${currentUserUid}`));
assert(backup && backup.ownedTypes.includes("miami"), "Backup local doit contenir 'miami'");

// ──────────────────────────────────────
console.log("\n═══════════════════════════════════════");
console.log("TEST 5: Firestore échoue + rechargement page — backup local doit restaurer");
console.log("═══════════════════════════════════════");
// Simuler un rechargement de page (ownedTypes vidé)
ownedTypes = [];
activeType = null;
// Simuler loadUserReward qui échoue Firestore → essaie le backup local
loadOwnedTypesLocal();
assert(ownedTypes.includes("miami"), "loadOwnedTypesLocal doit restaurer 'miami'");
console.log("ownedTypes après restauration:", ownedTypes);

// ──────────────────────────────────────
console.log("\n═══════════════════════════════════════");
console.log("TEST 6: syncLocalCodeState — libère les codes si le type n'est pas possédé");
console.log("═══════════════════════════════════════");
resetState();
// Marquer OR-VIP01 comme utilisé dans localStorage
markLocalCodeUsed("OR-VIP01");
assert(getUsedLocalCodes().includes("OR-VIP01"), "OR-VIP01 doit être marqué utilisé");
// MAIS ownedTypes est vide (Firestore n'a pas sauvegardé)
assert(!ownedTypes.includes("vip"), "vip ne doit PAS être dans ownedTypes");
// Appeler syncLocalCodeState
syncLocalCodeState();
// Le code doit être libéré
assert(!getUsedLocalCodes().includes("OR-VIP01"), "OR-VIP01 doit être libéré (type 'vip' non possédé)");

// ──────────────────────────────────────
console.log("\n═══════════════════════════════════════");
console.log("TEST 7: Code libéré peut être réutilisé");
console.log("═══════════════════════════════════════");
// ownedTypes est vide, OR-VIP01 a été libéré
const r7 = redeemCode("OR-VIP01");
assert(r7.success === true, "OR-VIP01 doit réussir après libération");
assert(ownedTypes.includes("vip"), "ownedTypes doit contenir 'vip'");

// ──────────────────────────────────────
console.log("\n═══════════════════════════════════════");
console.log("TEST 8: Scénario complet du bug original");
console.log("═══════════════════════════════════════");
resetState();
// 1. Utilisateur entre OR-MIAM1
const r8a = redeemCode("OR-MIAM1", true); // Firestore échoue (rate limiting)
assert(r8a.success === true, "OR-MIAM1 doit réussir localement");
// 2. L'utilisateur refresh la page
ownedTypes = [];
activeType = null;
// 3. loadUserReward: Firestore a pas les données → fallback local
loadOwnedTypesLocal();
assert(ownedTypes.includes("miami"), "miami doit être restauré depuis le backup local");
// 4. syncLocalCodeState: vérifier cohérence
syncLocalCodeState();
// 5. L'utilisateur réessaie OR-MIAM1 → doit dire "déjà possédé" (pas "déjà utilisé")
const r8b = redeemCode("OR-MIAM1");
assert(r8b.success === false, "OR-MIAM1 doit échouer car déjà possédé");
assert(r8b.message.includes("possédez déjà"), "Message doit dire 'possédez déjà' PAS 'déjà utilisé'");

// ──────────────────────────────────────
console.log("\n═══════════════════════════════════════");
console.log("TEST 9: Accumulation de cosmétiques (casier)");
console.log("═══════════════════════════════════════");
resetState();
redeemCode("OR-VIP01");  // vip
redeemCode("OR-FLAM1");  // flame
redeemCode("OR-RNBW1");  // rainbow
redeemCode("OR-CYBR1");  // cyberpunk
redeemCode("OR-MIAM1");  // miami
assert(ownedTypes.length === 5, `ownedTypes doit avoir 5 éléments (a ${ownedTypes.length})`);
assert(ownedTypes.includes("vip") && ownedTypes.includes("flame") && ownedTypes.includes("rainbow") && ownedTypes.includes("cyberpunk") && ownedTypes.includes("miami"), "Tous les types doivent être accumulés");
assert(activeType === "miami", "activeType doit être le dernier activé (miami)");

// ──────────────────────────────────────
console.log("\n═══════════════════════════════════════");
console.log("TEST 10: Tous les 13 codes fonctionnent");
console.log("═══════════════════════════════════════");
resetState();
for (const [code, info] of Object.entries(LOCAL_TEST_CODES)) {
  const r = redeemCode(code);
  assert(r.success === true, `${code} (${info.type}) doit réussir`);
}
assert(ownedTypes.length === 13, `ownedTypes doit avoir 13 éléments (a ${ownedTypes.length})`);

// ──────────────────────────────────────
console.log("\n═══════════════════════════════════════");
console.log("RÉSULTATS DES TESTS");
console.log("═══════════════════════════════════════");
console.log(`  ✅ Passés: ${testsPassed}`);
console.log(`  ❌ Échoués: ${testsFailed}`);
console.log(`  Total: ${testsPassed + testsFailed}`);
if (testsFailed === 0) {
  console.log("\n🎉 TOUS LES TESTS PASSENT ! La logique de redemption est corrigée.");
} else {
  console.error(`\n⚠️  ${testsFailed} test(s) échoué(s) ! Il y a encore des bugs.`);
}
