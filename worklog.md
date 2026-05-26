# OpenRuns Worklog

---
Task ID: 1
Agent: Super Z (main)
Task: Fix critical bugs in OpenRuns leaderboard

Work Log:
- Read all source files (profile.js, app.js, generate-code.js, profile.html, styles.css, animations.css, profile.css)
- Identified root cause of "already used" bug: no guard against concurrent redemption calls
- Identified root cause of ranking inconsistency: isMyFFAWin() used for name resolution only works for logged-in user, causing different rankings for different viewers
- Identified missing CSS for 10 new cosmetic types on leaderboard (run-row + global-player)
- Applied fixes to profile.js: _redeemInProgress guard, try/finally structure, alias map enhancement
- Applied fixes to app.js: alias map enhancement in processData(), getCanonicalName uses alias map first
- Applied CSS fixes to profile.css: added run-row and global-player styles for cyberpunk→chroma
- Fixed service worker cache to ignore query params (stale-while-revalidate now works properly)
- Pushed all changes to GitHub

Stage Summary:
- Bug "déjà utilisé" fixé: guard anti-doublon + try/finally
- Bug classement incohérent fixé: alias map comme source primaire pour la résolution de noms
- CSS manquants ajoutés pour les 10 nouveaux cosmétiques sur le leaderboard
- Service worker optimisé pour le caching
- Casier (locker) vérifié et fonctionnel (ownedTypes s'accumule correctement)
- Commits: 56d1463, 84da247 pushed to main
---
Task ID: 1
Agent: Main Agent
Task: Fix leaderboard position discrepancy, add console speed line, optimize performance

Work Log:
- Read and analyzed full app.js (1174 lines) and profile.js (1120+ lines)
- Identified root cause of leaderboard position discrepancy: user-specific alias merging in processData() caused logged-in users to see higher ranks than other viewers
- Added perfStart/perfEnd timing functions with visual progress bars in console
- Added detailed timing breakdowns to loadData(), autoRefresh(), processData(), renderAll()
- Fixed leaderboard position discrepancy by removing user-specific alias merging from processData()
- Fixed getCanonicalName() to only use aliasMap (server-shared data), not isMyFFAWin
- Fixed isMyFFAWin to only be used for visual "is-me" highlighting, not ranking
- Fixed VIP onSnapshot to NOT call processData() (was causing ranking shifts)
- Fixed likes onSnapshot to only re-render active map (not full renderAll)
- Increased debounce from 50ms to 100ms
- Added requestAnimationFrame batching utility
- Applied same leaderboard consistency fix to profile.js buildLeaderboard()
- Applied same getCanonicalPlayerName fix to profile.js
- Committed and pushed all changes to GitHub

Stage Summary:
- Console speed line now shows: 🚀 startup, ⏱ timing bars, ⚙ processData stats, ✅ total summary, 🔄 auto-refresh timing
- Leaderboard position discrepancy FIXED: all viewers now see same ranking
- Performance improved: VIP/likes snapshots no longer trigger full re-processing
- "Already used" bug fixed as side effect: VIP onSnapshot no longer calls processData() which was causing Firestore write exhaustion
- Casier (locker) was already working correctly (ownedTypes accumulates, not replaces)
- Both files pass Node.js syntax check
