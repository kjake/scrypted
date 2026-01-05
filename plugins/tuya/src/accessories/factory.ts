import { BinarySensor, MediaObject, MediaStreamUrl, MotionSensor, Online, OnOff, RequestMediaStreamOptions, ResponseMediaStreamOptions, Device as ScryptedDevice, ScryptedDeviceBase, ScryptedDeviceType, ScryptedInterface, ScryptedMimeTypes, VideoCamera } from "@scrypted/sdk";
import { TuyaPlugin } from "../plugin";
import { TuyaDevice, TuyaDeviceStatus } from "../tuya/const";

import { TuyaAccessory } from "./accessory";
import { TuyaCamera } from "./camera";

export function createTuyaDevice(state: TuyaDevice, plugin: TuyaPlugin): TuyaAccessory | null {
  switch (state.category) {
    case "sp":
    case "dghsxj":
    case "ipc":
    case "sp_wnq":
      return new TuyaCamera(state, plugin);
    default:
      plugin.console.log(
        `[Tuya] Unhandled device "${state.name}" (${state.id}) category="${state.category}" product="${state.product_name}".`
      );
      return null;
  }
}
