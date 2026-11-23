@echo off
rem Bat server AUTOFB trong mot cua so thu nho; server tu bat cac agent da danh dau.
rem Duoc goi tu loi tat trong thu muc Startup cua Windows (scripts\install-autostart.ps1).
rem File nay de chu khong dau vi cmd doc file theo bang ma cu.
cd /d "%~dp0.."

rem Server da chay (cong 3000 dang nghe) thi khong bat them.
netstat -ano | findstr /r /c:":3000 .*LISTENING" >nul
if errorlevel 1 (
  start "AUTOFB server" /min cmd /k npm start
  timeout /t 5 /nobreak >nul
)

rem Cac agent (research, Leader, designer...) do server tu bat theo muc "Tu bat" o tab Claude Code > Agent dang chay.
