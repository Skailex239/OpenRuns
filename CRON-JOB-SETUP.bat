@echo off
echo.
echo ================================================
echo CONFIGURATION CRON-JOB.ORG
echo ================================================
echo.
echo ETAPE 1: Creer un compte
echo ----------------------------------------
echo 1. Va sur: https://cron-job.org/en/
echo 2. Clique "Sign Up" (gratuit)
echo 3. Cree un compte avec email + mot de passe
echo 4. Valide ton email
echo.
echo ETAPE 2: Creer le job
echo ----------------------------------------
echo 1. Clique "Create cronjob"
echo 2. Title: "OpenFront Sync"
echo 3. Address: https://api.github.com/repos/Skailex239/Speed.run-Openfront/actions/workflows/sync.yml/dispatches
echo 4. Schedule: Every 2 minutes
echo.
echo ETAPE 3: Configuration POST
echo ----------------------------------------
echo 1. Coche "POST" (pas GET)
echo 2. Dans "POST body", colle:
echo    {"ref":"main"}
echo 3. Dans "Headers", ajoute:
echo    Authorization: Bearer ghp_VOTRE_TOKEN
echo    Accept: application/vnd.github.v3+json
echo.
echo ETAPE 4: Creer le token GitHub
echo ----------------------------------------
echo 1. Va sur: https://github.com/settings/tokens
echo 2. Generate new token (classic)
echo 3. Coche: repo, workflow
echo 4. Copie le token
echo 5. Mets-le dans le header Authorization
echo.
echo ETAPE 5: Tester
echo ----------------------------------------
echo 1. Coche "Execute on create" pour tester
echo 2. Clique "Create"
echo 3. Va sur GitHub Actions pour voir le workflow tourner!
echo.
echo ================================================
echo.
pause
