@echo off
cd /d "%~dp0"

git add -A
git commit -m "TRIGGER: Force sync via push"
git push origin main --force

echo.
echo PUSH EFFECTUE!
echo Le workflow va se declencher automatiquement!
echo.
echo Va sur: https://github.com/Skailex239/Speed.run-Openfront/actions
echo pour voir le sync en cours!
pause
