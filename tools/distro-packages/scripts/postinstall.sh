#!/bin/sh
# Shared post-install for the Astra distro packages (alpha).
# Best-effort everywhere: a missing helper must never fail the transaction.
update-desktop-database /usr/share/applications >/dev/null 2>&1 || true
gtk-update-icon-cache -q -t /usr/share/icons/hicolor >/dev/null 2>&1 || true
# SELinux (Fedora/RHEL): label the new tree; warn-only.
restorecon -R /usr/lib/astra >/dev/null 2>&1 || true
# AppArmor (Ubuntu 24.04+): without this the content sandbox degrades.
if [ -f /etc/apparmor.d/astra ] && command -v apparmor_parser >/dev/null 2>&1; then
  apparmor_parser -r /etc/apparmor.d/astra >/dev/null 2>&1 || true
fi
exit 0
