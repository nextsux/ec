import GObject from "gi://GObject";
import Gio from "gi://Gio";
import * as Main from "resource:///org/gnome/shell/ui/main.js";
import {
  Extension,
  gettext as _,
} from "resource:///org/gnome/shell/extensions/extension.js";
import {
  QuickSlider,
  SystemIndicator,
} from "resource:///org/gnome/shell/ui/quickSettings.js";

const BUS_NAME = "org.system76.FanControl";
const OBJECT_PATH = "/org/system76/FanControl";
const FanSpeedProxyIface = [
  "",
  "  <node>",
  '    <interface name="org.system76.FanControl">',
  '      <method name="SetSpeed">',
  '        <arg name="speed" type="y" direction="in"/>',
  "      </method>",
  '      <method name="GetSpeed">',
  '        <arg type="y" direction="out"/>',
  "      </method>",
  '      <method name="SetMode">',
  '        <arg name="mode" type="s" direction="in"/>',
  "      </method>",
  '      <method name="GetMode">',
  '        <arg type="s" direction="out"/>',
  "      </method>",
  "    </interface>",
  "  </node>",
].join("");

const FanSpeedProxy = Gio.DBusProxy.makeProxyWrapper(FanSpeedProxyIface);
const FanControlSlider = GObject.registerClass(
  class FanControlSlider extends QuickSlider {
    constructor(metadata) {
      super({
        // gicon: this._getGicon("icon-fan-question"),
        iconName: "",
        iconLabel: _("Fan Control"),
        metadata: metadata,
      });

      this._proxy = FanSpeedProxy(
        Gio.DBus.system,
        BUS_NAME,
        OBJECT_PATH,
        (proxy, error) => {
          if (error) {
            console.error(error.message);
          } else {
            this._proxy.connect("g-properties-changed", () => this._sync());
          }
          this._sync();
        },
      );

      this._sliderChangedId = this.slider.connect(
        "notify::value",
        this._sliderChanged.bind(this),
      );

      this.iconReactive = true;
      this._iconClickedId = this.connect("icon-clicked", () =>
        this._toggleMode(),
      );
    }

    _init(metadata) {
      console.error("my metadata 2", metadata);

      super._init();
      this.metadata = metadata.metadata;
    }

    _sliderChanged() {
      const speed = Math.round(this.slider.value * 255);
      console.log(`Setting fan speed to ${speed}`);

      try {
        this._proxy.SetSpeedSync(speed);
      } catch (e) {
        console.error("Failed to set fan speed", e);
      }
    }

    _changeSlider(value) {
      if (this._sliderChangedId) {
        this.slider.block_signal_handler(this._sliderChangedId);
        this.slider.value = value;
        this.slider.unblock_signal_handler(this._sliderChangedId);
      }
    }

    _toggleMode() {
      if (this._currentMode === "pwm") {
        this._proxy.SetSpeedSync(0);
        this._proxy.SetModeSync("auto");
      } else {
        this._proxy.SetModeSync("pwm");
        this._proxy.SetSpeedSync(128.0);
      }
      this._sync();
    }

    _setModeIcon() {
      if (this._currentMode === "pwm") {
        this.gicon = this._getGicon("icon-fan-manual");
      } else if (this._currentMode === "auto") {
        this.gicon = this._getGicon("icon-fan-auto");
      } else {
        this.gicon = this._getGicon("icon-fan-question");
      }
    }

    _getIconPath(iconName) {
      return `${this.metadata.path}/${iconName}.svg`;
    }

    _getGicon(name) {
      const path = this._getIconPath(name);
      return Gio.icon_new_for_string(path);
    }

    _sync() {
      try {
        const result = this._proxy.GetSpeedSync();

        if (result) {
          const [speed] = result;
          console.log(`Current fan speed: ${speed}`);
          this._changeSlider(speed / 255.0);
        }
      } catch (e) {
        console.error("Failed to get fan speed", e);
      }

      try {
        const result = this._proxy.GetModeSync();

        if (result) {
          const [mode] = result;
          this._currentMode = mode;
          console.log(`Current mode speed: ${mode}`);
          if (mode === "auto") {
            this._changeSlider(0.0);
          }
          this._setModeIcon();
        }
      } catch (e) {
        console.error("Failed to get fan mode", e);
      }
    }
  },
);

const FanControlIndicator = GObject.registerClass(
  class FanControlIndicator extends SystemIndicator {
    constructor(metadata) {
      super();

      const slider = new FanControlSlider(metadata);
      slider.connect("destroy", () => {
        this.quickSettingsItems = this.quickSettingsItems.filter(
          (item) => item !== slider,
        );
      });

      this.quickSettingsItems.push(slider);
    }

    _init(metadata) {
      super._init();
      this.metadata = metadata;
    }
  },
);

export default class QuickSettingsFanControlExtension extends Extension {
  enable() {
    this._indicator = new FanControlIndicator(this.metadata);
    Main.panel.statusArea.quickSettings.addExternalIndicator(
      this._indicator,
      2,
    );
  }

  disable() {
    this._indicator.quickSettingsItems.forEach((item) => item.destroy());
    this._indicator.destroy();
    this._indicator = null;
  }
}
