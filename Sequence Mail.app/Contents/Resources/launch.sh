#!/bin/zsh
PROJECT_DIR=/Users/jacquesmougeot/Desktop/prospection/Sequence-mail
APP_URL=http://localhost:3000
APP_PORT=3000
CHROME_APP=/Applications/Google\ Chrome.app
cd "$PROJECT_DIR" || exit 1

# 1) S'assurer que le serveur tourne. Test tolérant à une machine chargée :
#    plusieurs essais avec délai large avant de conclure qu'il est éteint (avec
#    un seul curl --max-time 1, le moindre pic de charge concluait « éteint » à
#    tort). On ne (re)démarre que s'il est RÉELLEMENT éteint — le garde lsof
#    évite de relancer un 2e serveur (EADDRINUSE) sur un clic rapproché.
server_up() { /usr/bin/curl -s -o /dev/null --max-time 2 "$APP_URL"; }
running=""
for i in 1 2 3; do server_up && { running=1; break; }; sleep 0.3; done
if [[ -z "$running" ]] && ! /usr/sbin/lsof -nP -iTCP:"$APP_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  PORT="$APP_PORT" BASE_URL="$APP_URL" nohup npm start >> ./data/launcher.log 2>&1 &
  for i in $(seq 1 60); do server_up && break; sleep 0.5; done
fi

# 2) Afficher l'UI. Avec Chrome : si une fenêtre montre déjà l'app on la
#    focalise ; sinon on en ouvre une en « mode app » (sans onglets ni barre
#    d'adresse). D'où « focus si ouverte, sinon ouvrir », sans jamais de doublon.
if [[ -n "$CHROME_APP" ]]; then
  focused=$(/usr/bin/osascript - "$APP_URL" <<'OSA'
on run argv
  set target to item 1 of argv
  if application "Google Chrome" is not running then return "notrunning"
  tell application "Google Chrome"
    repeat with w in windows
      set tabList to tabs of w
      repeat with i from 1 to (count of tabList)
        if (URL of (item i of tabList)) starts with target then
          set active tab index of w to i
          set index of w to 1
          activate
          return "focused"
        end if
      end repeat
    end repeat
  end tell
  return "notfound"
end run
OSA
)
  if [[ "$focused" != "focused" ]]; then
    open -na "$CHROME_APP" --args --app="$APP_URL"
  fi
else
  open "$APP_URL"
fi
