import { BinarySensor, MediaObject, MediaStreamUrl, MotionSensor, Online, OnOff, RequestMediaStreamOptions, ResponseMediaStreamOptions, Device as ScryptedDevice, ScryptedDeviceBase, ScryptedDeviceType, ScryptedInterface, ScryptedMimeTypes, VideoCamera } from "@scrypted/sdk";
import { TuyaPlugin } from "../plugin";
import { TuyaDevice, TuyaDeviceStatus } from "../tuya/const";

import { TuyaAccessory } from "./accessory";
import { TuyaCamera } from "./camera";
import { isCameraCategory } from "../discovery/cameraCategories";

export function createTuyaDevice(state: TuyaDevice, plugin: TuyaPlugin): TuyaAccessory | null {
  if (isCameraCategory(state.category)) {
    return new TuyaCamera(state, plugin);
  }
  return null;
}
