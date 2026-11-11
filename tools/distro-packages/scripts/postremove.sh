#!/bin/sh
# Shared post-remove for the Astra distro packages (alpha). Best-effort.
update-desktop-database /usr/share/applications >/dev/null 2>&1 || true
gtk-update-icon-cache -q -t /usr/share/icons/hicolor >/dev/null 2>&1 || true
exit 0
