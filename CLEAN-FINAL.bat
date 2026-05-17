@echo off
cd /d "%~dp0"

del "*.bat" 2>nul
del "Clique" 2>nul
del "Run workflow" 2>nul
del "ETAPE3-DETAILLEE.bat" 2>nul
del "CRON-JOB-SETUP.bat" 2>nul

echo.
echo ================================================
echo PROJET 100% TERMINE!
echo ================================================
echo.
echo Configuration finale:
echo - Workflow: Auto Sync
echo - Schedule: */5 * * * * (toutes les 5 min)
echo - Push trigger: Active
echo - Auto commit/push: Active
echo - GitHub Pages: main branch
echo.
echo Fonctionnement:
echo 1. Sync toutes les 5 minutes
echo 2. Si runs trouves: commit + push
echo 3. Le push redemarre le workflow (boucle auto)
echo 4. GitHub Pages se met a jour automatiquement
echo.
echo Token: Utilise GITHUB_TOKEN (pas besoin de PAT)
echo GITHUB_PAGES_TOKEN: Peut etre supprime (inutile)
echo.
echo ================================================
echo.
pause
