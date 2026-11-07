#!/bin/bash
# Turns a Debian 13 cloud image into the linux-computer desktop base image.
# Runs once inside the build VM (via cloud-init); output goes to the serial log on the host.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
USER_NAME=agent
progress() { echo "LC-PROGRESS: $*" | tee /dev/ttyS0; }
trap 'echo "LC_PROVISION_FAILED line $LINENO" | tee /dev/ttyS0' ERR

progress "updating package index"
apt-get update -q

progress "installing desktop, accessibility stack, browsers and OCR"
# shellcheck disable=SC2086
apt-get install -y -q --no-install-recommends \
  xserver-xorg-core xserver-xorg-input-libinput x11-xserver-utils x11-utils xauth \
  lightdm lightdm-gtk-greeter \
  xfce4-session xfwm4 xfce4-panel xfdesktop4 xfce4-settings xfconf xfce4-terminal xfce4-notifyd \
  thunar mousepad adwaita-icon-theme fonts-dejavu-core fonts-noto-core fonts-noto-color-emoji \
  dbus-user-session dbus-x11 dconf-cli dconf-gsettings-backend \
  at-spi2-core python3-pyatspi python3-websocket \
  xdotool wmctrl xclip scrot tmux zenity libnotify-bin \
  firefox-esr chromium tesseract-ocr tesseract-ocr-eng \
  openssh-server sudo curl ca-certificates git less rsync jq unzip file \
  ${LC_EXTRA_PACKAGES:-}

progress "configuring autologin desktop session"
mkdir -p /etc/lightdm/lightdm.conf.d
cat > /etc/lightdm/lightdm.conf.d/50-linux-computer.conf <<EOF
[Seat:*]
autologin-user=$USER_NAME
autologin-user-timeout=0
autologin-session=xfce
user-session=xfce
EOF

mkdir -p /etc/X11/xorg.conf.d
cat > /etc/X11/xorg.conf.d/10-linux-computer-noblank.conf <<'EOF'
Section "ServerFlags"
    Option "BlankTime" "0"
    Option "StandbyTime" "0"
    Option "SuspendTime" "0"
    Option "OffTime" "0"
EndSection
EOF

# Accessibility must be on for every toolkit so the agent can read the UI as text.
cat > /etc/X11/Xsession.d/95linux-computer-a11y <<'EOF'
export GNOME_ACCESSIBILITY=1
export QT_ACCESSIBILITY=1
export QT_LINUX_ACCESSIBILITY_ALWAYS_ON=1
export ACCESSIBILITY_ENABLED=1
export NO_AT_BRIDGE=0
export MOZ_ENABLE_WAYLAND=0
EOF

mkdir -p /etc/dconf/profile /etc/dconf/db/local.d
printf 'user-db:user\nsystem-db:local\n' > /etc/dconf/profile/user
cat > /etc/dconf/db/local.d/00-linux-computer <<'EOF'
[org/gnome/desktop/interface]
toolkit-accessibility=true

[org/gnome/desktop/a11y/applications]
screen-reader-enabled=false
EOF
dconf update

cat > /etc/xdg/autostart/linux-computer-noblank.desktop <<'EOF'
[Desktop Entry]
Type=Application
Name=Disable screen blanking
Exec=sh -c "xset s off; xset s noblank; xset -dpms"
NoDisplay=true
EOF

progress "configuring browsers"
# Chromium: expose the accessibility tree and a local-only DevTools endpoint for DOM-level driving.
cat > /etc/chromium.d/linux-computer <<'EOF'
export CHROMIUM_FLAGS="$CHROMIUM_FLAGS --force-renderer-accessibility --remote-debugging-port=9222 --remote-allow-origins=* --no-first-run --no-default-browser-check --password-store=basic --disable-features=Translate"
EOF
mkdir -p /etc/firefox-esr/policies
cat > /etc/firefox-esr/policies/policies.json <<'EOF'
{
  "policies": {
    "DisableTelemetry": true,
    "DisableDefaultBrowserAgent": true,
    "DontCheckDefaultBrowser": true,
    "OverrideFirstRunPage": "",
    "OverridePostUpdatePage": "",
    "UserMessaging": { "WhatsNew": false, "ExtensionRecommendations": false, "FeatureRecommendations": false, "SkipOnboarding": true }
  }
}
EOF

progress "configuring user session"
home=/home/$USER_NAME
xfconf_dir=$home/.config/xfce4/xfconf/xfce-perchannel-xml
mkdir -p "$xfconf_dir"
# Preseed the panel so the first login does not stop at the "default or empty panel" dialog.
cp /etc/xdg/xfce4/panel/default.xml "$xfconf_dir/xfce4-panel.xml"
cat > "$xfconf_dir/xfce4-session.xml" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<channel name="xfce4-session" version="1.0">
  <property name="general" type="empty">
    <property name="StartAssistiveTechnologies" type="bool" value="true"/>
    <property name="SaveOnExit" type="bool" value="false"/>
  </property>
</channel>
EOF
mkdir -p "$home/Desktop" "$home/.local/state/linux-computer"
chown -R "$USER_NAME:$USER_NAME" "$home"

cat > /etc/ssh/sshd_config.d/50-linux-computer.conf <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
EOF

# The host reaches the guest only over AF_VSOCK (no network ports). systemd's own ssh generator decides
# too early in boot, before the vsock transport module is loaded, so ship explicit units instead.
echo vmw_vsock_virtio_transport > /etc/modules-load.d/linux-computer-vsock.conf
mkdir -p /etc/systemd/system-generators
ln -sf /dev/null /etc/systemd/system-generators/systemd-ssh-generator
cat > /etc/systemd/system/linux-computer-sshd-vsock.socket <<'EOF'
[Unit]
Description=OpenSSH over AF_VSOCK for linux-computer
After=systemd-modules-load.service

[Socket]
ListenStream=vsock::22
Accept=yes
PollLimitIntervalSec=30s
PollLimitBurst=50

[Install]
WantedBy=sockets.target
EOF
cat > /etc/systemd/system/linux-computer-sshd-vsock@.service <<'EOF'
[Unit]
Description=OpenSSH connection over AF_VSOCK

[Service]
ExecStart=-/usr/sbin/sshd -i
StandardInput=socket
StandardError=journal
RuntimeDirectory=sshd
RuntimeDirectoryPreserve=yes
EOF

systemctl set-default graphical.target
systemctl enable lightdm ssh linux-computer-sshd-vsock.socket

# cloud-init pinned networking to the build VM's MAC address; clones get their own MACs, so use a
# generic DHCP config for every ethernet device instead.
rm -f /etc/netplan/50-cloud-init.yaml
cat > /etc/systemd/network/10-linux-computer.network <<'EOF'
[Match]
Type=ether

[Network]
DHCP=yes
EOF
systemctl enable systemd-networkd

progress "cleaning up image"
apt-get clean
rm -rf /var/lib/apt/lists/*
# Clones boot without a datasource: keep cloud-init out of the way and give each clone its own machine-id.
touch /etc/cloud/cloud-init.disabled
truncate -s 0 /etc/machine-id
rm -f /var/lib/dbus/machine-id
ln -sf /etc/machine-id /var/lib/dbus/machine-id
fstrim -av || true
sync
echo "LC_PROVISION_OK" | tee /dev/ttyS0
