# System76 EC

System76 EC is a GPLv3 licensed embedded controller firmware for System76
laptops.

## Added support for gnome-shell manual fan controll

### Build

```sh
cd tool
cargo build
sudo cp tool/target/debug/fan_control_service /usr/local/bin/fan_control_service
```

create a dbus config in `/etc/dbus-1/system.d/org.system76.FanControl.conf`

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-BUS Bus Configuration 1.0//EN"
 "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig>
  <policy user="root">
    <allow own="org.system76.FanControl"/>
  </policy>
  <policy context="default">
    <allow send_destination="org.system76.FanControl"/>
    <allow receive_sender="org.system76.FanControl"/>
  </policy>
</busconfig>
```

add systemd unit `/etc/systemd/system/fan-control.service`

```plain
[Unit]
Description=System76 Fan Control Service
After=network.target

[Service]
ExecStart=/usr/local/bin/fan_control_service
Type=simple
Restart=always

[Install]
WantedBy=multi-user.target
```

enable it:

```sh
systemctl daemon-reload
systemctl enable fan-control.service
systemctl start fan-control.service
```

install gnome-shell extension:

```sh
cp -a gnome-shell-extension ~/.local/share/gnome-shell/extensions/pwmcontrol@system76
```

reboot

## Documentation

- [Supported embedded controllers](./docs/controllers.md)
- [Flashing firmware](./docs/flashing.md)
- [Debugging](./docs/debugging.md)
- [Creating a custom keyboard layout](./docs/keyboard-layout-customization.md)
- [Development environment](./docs/dev-env.md)
- [Adding a new board](./docs/adding-a-new-board.md)

## Quickstart

Install dependencies using the provided script.

```sh
./scripts/deps.sh
```

If rustup was installed as part of this, then the correct `cargo` will not be
available in the running session. Start a new shell session or source the env
file to update `PATH`.

```sh
source $HOME/.cargo/env
```

Then build the firmware for your laptop model.

```sh
make BOARD=system76/<model>
```

See [Flashing](./docs/flashing.md) for how to use the new firmware image.

## Releases

The EC firmware itself does not have tagged releases. Any commit of this repo
may be used as a part of a [System76 Open Firmware][firmware-open] release.

In official releases the EC shares the same version as the BIOS firmware. Run
the follow command from firmware-open to determine the corresponding EC commit
for a release.

```
git ls-tree <release_hash> ec
```

[firmware-open]: https://github.com/system76/firmware-open

## Legal

System76 EC is copyright System76 and contributors.

System76 EC firmware is made available under the terms of the GNU General
Public License, version 3. See [LICENSE](./LICENSE) for details.

- firmware: GPL-3.0-only
- ecflash: LGPL-2.1-or-later
- ecsim: MIT
- ectool: MIT

Datasheets for the ITE embedded controllers used in System76 laptops cannot be
shared outside of company. (However, the IT81202 datasheet is [publicly
available][it81202]. While it uses a different core, a significant portion of
the register information is the same as IT8587/IT5570.)

[it81202]: https://www.ite.com.tw/en/product/cate2/IT81202
