#!/usr/bin/env python3
"""Enable, disable, or inspect Linux desktop login startup for Cuttle Pets."""
import argparse
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('mode', choices=['enable', 'disable', 'status'])
args = parser.parse_args()
config = Path(os.environ.get('XDG_CONFIG_HOME', Path.home() / '.config'))
entry = config / 'autostart' / 'cuttle-pets.desktop'
if args.mode == 'enable':
    entry.parent.mkdir(parents=True, exist_ok=True)
    # Exec uses desktop-entry quoting, not shell quoting.
    def quote(value):
        return '"' + str(value).replace('\\', '\\\\').replace('"', '\\"').replace('`', '\\`').replace('$', '\\$').replace('%', '%%') + '"'
    entry.write_text('\n'.join([
        '[Desktop Entry]', 'Type=Application', 'Name=Cuttle Pets',
        'Comment=Desktop pet with automatic Cuttle connection',
        'Exec=/usr/bin/bash ' + quote(ROOT / 'scripts' / 'login_start.sh'),
        'Icon=' + str(ROOT / 'app/src-tauri/icons/128x128.png'),
        'Terminal=false', 'X-GNOME-Autostart-enabled=true', 'X-GNOME-Autostart-Delay=10', ''
    ]))
    print('Cuttle Pets will start automatically at desktop login.')
elif args.mode == 'disable':
    entry.unlink(missing_ok=True)
    print('Cuttle Pets login startup disabled.')
else:
    print('Enabled' if entry.exists() else 'Disabled')
