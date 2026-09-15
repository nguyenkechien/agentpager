# agentpager installer hooks (included by electron-builder's NSIS template).
#
# Defining customCheckAppRunning makes electron-builder skip these two lines, which its own _CHECK_APP_RUNNING needs.
!include "getProcessInfo.nsh"
Var pid

# Before files are replaced (fresh install over an old one, manual installer run, or auto-update): ask the installed
# app to quit its window and stop a bot that runs from this folder gracefully, remembering to start it again.
# electron-builder's check still runs afterwards and closes anything left in $INSTDIR.
!macro customCheckAppRunning
  ${if} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
    DetailPrint "Stopping agentpager gracefully"
    ExecWait '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --prepare-update' $0
    DetailPrint "agentpager --prepare-update exited with $0"
  ${endIf}
  !insertmacro IS_POWERSHELL_AVAILABLE
  !insertmacro _CHECK_APP_RUNNING
!macroend

# A real uninstall (not the old version's uninstaller running during an update): stop the bot if it runs from this
# folder, remove autostart and the login item when they point here, and delete the app's Chromium profile.
# %APPDATA%\agentpager (config, state, logs) is shared with agentpager cli and is never removed.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    ${if} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
      ExecWait '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --uninstall-cleanup' $0
      DetailPrint "agentpager --uninstall-cleanup exited with $0"
    ${endIf}
    RMDir /r "$APPDATA\agentpager-desktop"
  ${endIf}
!macroend
