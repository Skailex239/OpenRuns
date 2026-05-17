@echo off
echo.
echo ================================================
echo ETAPE 3: Configuration POST (Detaillee)
echo ================================================
echo.
echo Quand tu es sur la page "Create cronjob":
echo.
echo 1. METHODE HTTP:
echo    - Trouve le menu deroulant "Request method"
echo    - Selectionne "POST" (au lieu de GET)
echo.
echo 2. CORPS DE LA REQUETE (POST body):
echo    - Trouve la zone "POST body"
echo    - Copie-colle EXACTEMENT ca:
echo.
echo      {"ref":"main"}
echo.
echo 3. HEADERS (en bas de page):
echo    - Clique sur "Add header"
echo    - Premier champ: Authorization
necho    - Deuxieme champ: Bearer TON_TOKEN
necho      (remplace TON_TOKEN par ton vrai token GitHub)
echo.
echo    - Clique "Add header" encore
necho    - Premier champ: Accept
necho    - Deuxieme champ: application/vnd.github.v3+json
echo.
echo EXEMPLE COMPLET:
echo -----------------
echo Title: OpenFront Sync
echo URL: https://api.github.com/repos/Skailex239/Speed.run-Openfront/actions/workflows/sync.yml/dispatches
echo Schedule: Every 5 minutes
echo Method: POST
echo Body: {"ref":"main"}
echo Headers:
echo   Authorization: Bearer ghp_1234567890abcdef
echo   Accept: application/vnd.github.v3+json
echo.
echo ================================================
echo.
pause
