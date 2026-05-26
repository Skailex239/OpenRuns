---
Task ID: 1
Agent: Main Agent
Task: Fix code redemption "already used" bug + Firebase infinite loop + local backup resilience

Work Log:
- Read profile.js (1037 lines) and generate-code.js to understand the full redemption flow
- Identified 3 critical bugs:
  1. Firebase infinite loop: onSnapshot → refreshProfile() → write Firestore → onSnapshot → infinite loop → resource-exhausted
  2. Local codes "already used": isLocalCodeUsed() blocked codes even when cosmetic wasn't actually saved to Firestore
  3. No persistence fallback: when Firestore fails, ownedTypes is lost on page refresh
- Fixed Bug 1: Changed onSnapshot handler to only re-render (not call refreshProfile), added session hash check to prevent unnecessary writes, added _isRefreshFromSnapshot flag
- Fixed Bug 2: Removed isLocalCodeUsed() as primary gate, use ownedTypes.includes(type) as only check, moved markLocalCodeUsed() to after processing
- Fixed Bug 3: Added saveOwnedTypesLocal()/loadOwnedTypesLocal() for localStorage backup, syncLocalCodeState() to liberate desynced codes
- Fixed Bug 4 (found during testing): When Firestore succeeds after previous failures, it was overwriting in-memory ownedTypes with incomplete Firestore data. Added merge logic (Set-based) to combine Firestore + in-memory types before writing back
- Fixed Bug 5 (found during testing): loadUserReward() only loaded local backup when Firestore was empty. Changed to ALWAYS merge local backup and auto-resync Firestore when backup has more data
- Created comprehensive test suite (test_code_redemption.js) - 42/42 tests pass
- Created E2E test suite (test_e2e_redemption.js) - 32/32 tests pass (7 scenarios including the exact bug scenario from user console logs)
- Pushed fix to GitHub (2 commits)

Stage Summary:
- All 3+2 bugs fixed and verified with automated tests
- Profile.js pushed to GitHub main branch
- Test files saved to /home/z/my-project/download/
