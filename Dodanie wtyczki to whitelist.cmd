@echo off
title Tlumacz - zezwolenie na instalacje z pliku CRX
net session >nul 2>&1
if errorlevel 1 (
    echo Podnosze uprawnienia administratora...
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)
set ID=gobplihcimfopmpkkmfaohagoddeaoen
set KEY=HKLM\SOFTWARE\Policies\Microsoft\Edge\ExtensionInstallAllowlist
reg add "%KEY%" /v 1 /t REG_SZ /d %ID% /f >nul
if errorlevel 1 goto fail
echo.
echo OK - wtyczka %ID%
echo dopisana do allowlisty rozszerzen Edge.
echo.
reg query "%KEY%"
echo.
echo TERAZ: zamknij CALKOWICIE Edge (wszystkie okna) i uruchom ponownie,
echo a potem przeciagnij tlumacz-pl.crx na strone edge://extensions.
echo.
echo Cofniecie: reg delete "%KEY%" /f
pause
exit /b
:fail
echo BLAD: nie udalo sie zapisac do rejestru.
pause
