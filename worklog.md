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
