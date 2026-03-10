"use strict";

const PLUGIN_NAME = "homebridge-arduino-diy-platform";
const PLATFORM_NAME = "ArduinoPlatformDIY";

let Service;
let Characteristic;
let PlatformAccessory;
let UUIDGen;

async function fetchCompat(url, options) {
  if (typeof fetch === "function") {
    return fetch(url, options);
  }

  const { default: nodeFetch } = await import("node-fetch");
  return nodeFetch(url, options);
}

module.exports = (api) => {
  Service = api.hap.Service;
  Characteristic = api.hap.Characteristic;
  PlatformAccessory = api.platformAccessory;
  UUIDGen = api.hap.uuid;

  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, ArduinoPlatformDIY);
};

class ArduinoPlatformDIY {
  constructor(log, config, api) {
    this.log = log;
    this.config = config || {};
    this.api = api;

    this.serverUrl = sanitizeServerUrl(this.config.serverurl);
    this.pollerSeconds = Math.max(1, Number(this.config.pollerseconds) || 10);
    this.debugEnabled = !!this.config.debug;

    this.cachedAccessories = new Map();
    this.runtimeByServiceId = new Map();
    this.pollTimer = null;
    this.isShuttingDown = false;

    this.api.on("didFinishLaunching", async () => {
      try {
        await this.syncConfiguredAccessories();
        this.startPolling();
      } catch (error) {
        this.log.error("Failed to initialize platform:", formatError(error));
      }
    });

    this.api.on("shutdown", () => {
      this.isShuttingDown = true;
      if (this.pollTimer) {
        clearInterval(this.pollTimer);
        this.pollTimer = null;
      }
    });
  }

  configureAccessory(accessory) {
    this.cachedAccessories.set(accessory.UUID, accessory);
  }

  async syncConfiguredAccessories() {
    if (!this.serverUrl) {
      this.log.error("Missing required config: serverurl");
      return;
    }

    const devices = Array.isArray(this.config.devices) ? this.config.devices : [];
    const seenAccessoryUuids = new Set();
    this.runtimeByServiceId = new Map();
    const accessoriesToRegister = [];
    const accessoriesToUpdate = [];

    for (const deviceConfig of devices) {
      if (!deviceConfig || !deviceConfig.token) {
        this.log.warn("Skipping device with missing token.");
        continue;
      }

      if (deviceConfig.discover) {
        this.log.warn(`[${deviceConfig.name || deviceConfig.token}] auto discovery is not implemented in this build; using explicit accessories from config.`);
      }

      const accessories = Array.isArray(deviceConfig.accessories) ? deviceConfig.accessories : [];
      for (const accessoryConfig of accessories) {
        if (!accessoryConfig || typeof accessoryConfig.pinnumber === "undefined" || !accessoryConfig.typeOf) {
          this.log.warn("Skipping accessory with missing typeOf or pinnumber.");
          continue;
        }

        const uuid = this.makeAccessoryUuid(deviceConfig, accessoryConfig);
        seenAccessoryUuids.add(uuid);

        let accessory = this.cachedAccessories.get(uuid);
        let isNewAccessory = false;

        if (!accessory) {
          accessory = new PlatformAccessory(accessoryConfig.name || `V${accessoryConfig.pinnumber}`, uuid);
          this.cachedAccessories.set(uuid, accessory);
          isNewAccessory = true;
        }

        accessory.context.deviceConfig = clone(deviceConfig);
        accessory.context.accessoryConfig = clone(accessoryConfig);
        accessory.context.pluginVersion = "1.0.0";

        await this.configurePlatformAccessory(accessory, deviceConfig, accessoryConfig, isNewAccessory);

        if (isNewAccessory) {
          accessoriesToRegister.push(accessory);
        } else {
          accessoriesToUpdate.push(accessory);
        }
      }
    }

    const staleAccessories = [];
    for (const [uuid, accessory] of this.cachedAccessories.entries()) {
      if (!seenAccessoryUuids.has(uuid)) {
        staleAccessories.push(accessory);
        this.cachedAccessories.delete(uuid);
      }
    }

    if (accessoriesToRegister.length) {
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, accessoriesToRegister);
    }

    if (accessoriesToUpdate.length) {
      this.api.updatePlatformAccessories(accessoriesToUpdate);
    }

    if (staleAccessories.length) {
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, staleAccessories);
    }
  }

  async configurePlatformAccessory(accessory, deviceConfig, accessoryConfig, isNewAccessory) {
    const infoService = accessory.getService(Service.AccessoryInformation)
      || accessory.addService(Service.AccessoryInformation);

    infoService
      .setCharacteristic(Characteristic.Manufacturer, deviceConfig.manufacturer || "Arduino DIY Server")
      .setCharacteristic(Characteristic.Model, accessoryConfig.model || accessoryConfig.typeOf || "Arduino DIY Accessory")
      .setCharacteristic(Characteristic.SerialNumber, `${deviceConfig.deviceId || 0}-${accessoryConfig.typeOf}-V${accessoryConfig.pinnumber}`)
      .setCharacteristic(Characteristic.FirmwareRevision, "1.0.0");

    const runtimeContexts = [];

    if (accessoryConfig.typeOf === "IRRIGATION_SYSTEM") {
      await this.configureIrrigationAccessory(accessory, deviceConfig, accessoryConfig, isNewAccessory, runtimeContexts);
    } else {
      const mainDefinition = this.ensureMainService(accessory, deviceConfig, accessoryConfig);
      runtimeContexts.push(mainDefinition.runtime);
      await this.finalizeRuntime(mainDefinition.runtime, mainDefinition.isNewService || isNewAccessory);
      this.removeStaleServices(accessory, new Set([mainDefinition.runtime.serviceKey]));
    }

    const allowedKeys = new Set(runtimeContexts.map((runtime) => runtime.serviceKey));
    this.removeStaleServices(accessory, allowedKeys);

    for (const runtime of runtimeContexts) {
      this.runtimeByServiceId.set(runtime.serviceKey, runtime);
    }
  }

  async configureIrrigationAccessory(accessory, deviceConfig, accessoryConfig, isNewAccessory, runtimeContexts) {
    const irrigationCtor = requireServiceCtor(Service, "IrrigationSystem");
    const valveCtor = requireServiceCtor(Service, "Valve");

    const irrigationResult = this.ensureServiceRuntime({
      accessory,
      serviceCtor: irrigationCtor,
      displayName: accessoryConfig.name || "Irrigation System",
      subtype: `irrigation-${accessoryConfig.pinnumber}`,
      typeOf: accessoryConfig.typeOf,
      vpin: accessoryConfig.pinnumber,
      token: deviceConfig.token,
      model: accessoryConfig.model,
      manufacturer: deviceConfig.manufacturer,
      deviceId: deviceConfig.deviceId,
      configName: accessoryConfig.name || "Irrigation System",
      extraSeedState: {},
      isValve: false,
      parentServiceKey: null,
    });

    irrigationResult.service.setPrimaryService(true);

    const valves = Array.isArray(accessoryConfig.valves) ? accessoryConfig.valves : [];
    const linkedValveServices = [];

    valves.forEach((valveConfig, index) => {
      const valveName = valveConfig.valveName || `Valve ${index + 1}`;
      const serviceLabelIndex = index + 1;
      const valveResult = this.ensureServiceRuntime({
        accessory,
        serviceCtor: valveCtor,
        displayName: valveName,
        subtype: `valve-${accessoryConfig.valvePinNumber}-${serviceLabelIndex}`,
        typeOf: "VALVE",
        vpin: valveConfig.valvePinNumber,
        token: deviceConfig.token,
        model: valveConfig.model || accessoryConfig.model,
        manufacturer: deviceConfig.manufacturer,
        deviceId: deviceConfig.deviceId,
        configName: valveName,
        extraSeedState: {
          "Is Configured": "1",
          "Service Label Index": String(serviceLabelIndex),
          "Valve Type": String(toNumberOrDefault(valveConfig.valveType, 1)),
          "Set Duration": String(toNumberOrDefault(valveConfig.valveSetDuration, 10)),
        },
        isValve: true,
        parentServiceKey: irrigationResult.runtime.serviceKey,
      });

      linkedValveServices.push(valveResult.service);
      runtimeContexts.push(valveResult.runtime);
    });

    for (const valveService of linkedValveServices) {
      irrigationResult.service.addLinkedService(valveService);
    }

    runtimeContexts.push(irrigationResult.runtime);

    for (const runtime of runtimeContexts) {
      const shouldSeed = runtime.isNewService || isNewAccessory;
      await this.finalizeRuntime(runtime, shouldSeed);
    }
  }

  ensureMainService(accessory, deviceConfig, accessoryConfig) {
    const serviceCtor = resolveServiceCtor(Service, accessoryConfig.typeOf);
    return this.ensureServiceRuntime({
      accessory,
      serviceCtor,
      displayName: accessoryConfig.name || accessoryConfig.typeOf,
      subtype: `main-${accessoryConfig.pinnumber}`,
      typeOf: accessoryConfig.typeOf,
      vpin: accessoryConfig.pinnumber,
      token: deviceConfig.token,
      model: accessoryConfig.model,
      manufacturer: deviceConfig.manufacturer,
      deviceId: deviceConfig.deviceId,
      configName: accessoryConfig.name || accessoryConfig.typeOf,
      extraSeedState: {},
      isValve: accessoryConfig.typeOf === "VALVE",
      parentServiceKey: null,
    });
  }

  ensureServiceRuntime(options) {
    const existing = options.accessory.getServiceById(options.serviceCtor, options.subtype);
    const service = existing || options.accessory.addService(options.serviceCtor, options.displayName, options.subtype);
    const isNewService = !existing;

    materializeAllOptionalCharacteristics(service);

    const runtime = {
      accessory: options.accessory,
      service,
      token: options.token,
      vpin: normalizeVpin(options.vpin),
      typeOf: options.typeOf,
      model: options.model || options.typeOf,
      manufacturer: options.manufacturer || "Arduino DIY Server",
      deviceId: options.deviceId || 0,
      configName: options.configName,
      state: {},
      writePromise: Promise.resolve(),
      isValve: !!options.isValve,
      parentServiceKey: options.parentServiceKey,
      serviceKey: this.makeServiceKey(options.token, options.vpin, service.UUID, options.subtype),
      extraSeedState: clone(options.extraSeedState || {}),
      isNewService,
      handlersBound: false,
    };

    service.__arduinoDiyServiceKey = runtime.serviceKey;

    this.applySeedState(runtime);
    this.bindServiceHandlers(runtime);

    return { service, runtime, isNewService };
  }

  async finalizeRuntime(runtime, shouldSeed) {
    if (shouldSeed) {
      await this.writeWholeState(runtime, { reason: "seed" });
    } else {
      try {
        await this.refreshRuntimeFromServer(runtime, { updateHomeKit: true });
      } catch (error) {
        this.debug(`[${runtime.configName}] initial refresh skipped: ${formatError(error)}`);
      }
    }
  }

  bindServiceHandlers(runtime) {
    if (runtime.handlersBound) {
      return;
    }

    for (const characteristic of runtime.service.characteristics) {
      const perms = Array.isArray(characteristic.props?.perms) ? characteristic.props.perms : [];
      const canRead = perms.includes("pr");
      const canWrite = perms.includes("pw");

      if (canRead) {
        characteristic.onGet(async () => {
          if (runtime.isValve && characteristic.displayName === "Remaining Duration") {
            await this.refreshRuntimeFromServer(runtime, { updateHomeKit: true });
          }

          const currentState = runtime.state;
          const key = this.findStateKeyForCharacteristic(runtime, characteristic);
          if (typeof key !== "undefined" && typeof currentState[key] !== "undefined") {
            return fromServerValue(characteristic, currentState[key]);
          }

          return getDefaultCharacteristicValue(characteristic);
        });
      }

      if (canWrite && !shouldSkipSetBinding(runtime, characteristic)) {
        characteristic.onSet(async (value) => {
          await this.handleCharacteristicSet(runtime, characteristic, value);
        });
      }
    }

    runtime.handlersBound = true;
  }

  async handleCharacteristicSet(runtime, characteristic, value) {
    const nextValue = toServerValue(characteristic, value);
    runtime.state[characteristic.displayName] = nextValue;

    if (characteristic.displayName === "Configured Name") {
      runtime.state.Name = String(value);
    }

    if (characteristic.displayName === "Name") {
      runtime.state["Configured Name"] = String(value);
    }

    await this.writeWholeState(runtime, {
      reason: `set:${characteristic.displayName}`,
    });
  }

  async refreshRuntimeFromServer(runtime, options = {}) {
    const raw = await this.httpGet(runtime.token, runtime.vpin);
    const parsed = parseServerResponse(raw);
    const normalized = normalizeIncomingState(parsed);

    if (normalized.Name && typeof normalized["Configured Name"] === "undefined") {
      normalized["Configured Name"] = normalized.Name;
    }

    runtime.state = {
      ...runtime.state,
      ...normalized,
    };

    if (options.updateHomeKit) {
      this.pushRuntimeStateToHomeKit(runtime);
    }

    return runtime.state;
  }

  pushRuntimeStateToHomeKit(runtime) {
    for (const characteristic of runtime.service.characteristics) {
      const key = this.findStateKeyForCharacteristic(runtime, characteristic);
      if (typeof key === "undefined") {
        continue;
      }

      if (typeof runtime.state[key] === "undefined") {
        continue;
      }

      try {
        characteristic.updateValue(fromServerValue(characteristic, runtime.state[key]));
      } catch (error) {
        this.debug(`[${runtime.configName}] updateValue failed for ${characteristic.displayName}: ${formatError(error)}`);
      }
    }
  }

  applySeedState(runtime) {
    const seeded = buildStateFromService(runtime.service);
    const preferredName = getPreferredServiceName(runtime.service, runtime.configName);

    seeded.Name = preferredName;
    if (Characteristic.ConfiguredName && runtime.service.testCharacteristic(Characteristic.ConfiguredName)) {
      seeded["Configured Name"] = preferredName;
      runtime.service.getCharacteristic(Characteristic.ConfiguredName).updateValue(preferredName);
    }

    Object.assign(seeded, runtime.extraSeedState);
    runtime.state = seeded;

    this.pushRuntimeStateToHomeKit(runtime);
  }

  async writeWholeState(runtime, meta = {}) {
    const payload = JSON.stringify(sortStateForStableWrites(runtime.state));

    runtime.writePromise = runtime.writePromise
      .catch(() => undefined)
      .then(async () => {
        await this.httpUpdate(runtime.token, runtime.vpin, payload);
        this.debug(`[${runtime.configName}] wrote V${runtime.vpin} (${meta.reason || "write"}) ${payload}`);
      });

    return runtime.writePromise;
  }

  startPolling() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
    }

    this.pollTimer = setInterval(async () => {
      if (this.isShuttingDown) {
        return;
      }

      const runtimes = Array.from(this.runtimeByServiceId.values());
      for (const runtime of runtimes) {
        try {
          await this.refreshRuntimeFromServer(runtime, { updateHomeKit: true });
        } catch (error) {
          this.debug(`[${runtime.configName}] poll failed: ${formatError(error)}`);
        }
      }
    }, this.pollerSeconds * 1000);
  }

  removeStaleServices(accessory, allowedKeys) {
    const services = accessory.services.slice();

    for (const service of services) {
      if (service.UUID === Service.AccessoryInformation.UUID) {
        continue;
      }

      const serviceKey = service.__arduinoDiyServiceKey || null;
      if (serviceKey && allowedKeys.has(serviceKey)) {
        continue;
      }

      try {
        accessory.removeService(service);
      } catch (error) {
        this.debug(`Failed removing stale service ${service.displayName}: ${formatError(error)}`);
      }
    }
  }

  makeAccessoryUuid(deviceConfig, accessoryConfig) {
    return UUIDGen.generate([
      PLATFORM_NAME,
      deviceConfig.token,
      deviceConfig.deviceId || 0,
      accessoryConfig.typeOf,
      normalizeVpin(accessoryConfig.pinnumber),
      accessoryConfig.name || "Unnamed",
    ].join("|"));
  }

  makeServiceKey(token, vpin, serviceUUID, subtype) {
    return [token, normalizeVpin(vpin), serviceUUID, subtype || ""].join("|");
  }

  findStateKeyForCharacteristic(runtime, characteristic) {
    if (typeof runtime.state[characteristic.displayName] !== "undefined") {
      return characteristic.displayName;
    }

    if (characteristic.displayName === "Configured Name" && typeof runtime.state.Name !== "undefined") {
      return "Name";
    }

    if (characteristic.displayName === "Name" && typeof runtime.state["Configured Name"] !== "undefined") {
      return "Configured Name";
    }

    return characteristic.displayName;
  }

  buildApiUrl(token, action, vpin) {
    const endpoint = buildPhpApiEndpoint(this.serverUrl);
    const url = new URL(endpoint);
    url.searchParams.set("token", String(token || "").trim());
    url.searchParams.set("action", action);
    url.searchParams.set("vpin", `V${normalizeVpin(vpin)}`);
    return url.toString();
  }

  async httpGet(token, vpin) {
    const url = this.buildApiUrl(token, "get", vpin);
    this.debug(`GET ${url}`);

    const response = await fetchCompat(url, {
      method: "GET",
      headers: {
        Accept: "application/json, text/plain;q=0.9, */*;q=0.8",
      },
    });

    const bodyText = await response.text();

    if (!response.ok) {
      throw new Error(`GET V${vpin} failed with status ${response.status}: ${bodyText || "empty response"}`);
    }

    return bodyText;
  }

  async httpUpdate(token, vpin, value) {
    const url = this.buildApiUrl(token, "update", vpin);
    this.debug(`POST ${url} value=${value}`);

    const response = await fetchCompat(url, {
      method: "POST",
      headers: {
        Accept: "application/json, text/plain;q=0.9, */*;q=0.8",
        "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
      },
      body: `value=${encodeURIComponent(value)}`,
    });

    const bodyText = await response.text();

    if (!response.ok) {
      throw new Error(`UPDATE V${vpin} failed with status ${response.status}: ${bodyText || "empty response"}`);
    }

    return bodyText;
  }

  debug(message) {
    if (this.debugEnabled) {
      this.log.info(message);
    }
  }
}

function resolveServiceCtor(ServiceObject, typeOf) {
  const map = {
    OUTLET: requireServiceCtor(ServiceObject, "Outlet"),
    LIGHTBULB: requireServiceCtor(ServiceObject, "Lightbulb"),
    FAN: ServiceObject.Fanv2 || requireServiceCtor(ServiceObject, "Fan"),
    SWITCH: requireServiceCtor(ServiceObject, "Switch"),
    VALVE: requireServiceCtor(ServiceObject, "Valve"),
    IRRIGATION_SYSTEM: requireServiceCtor(ServiceObject, "IrrigationSystem"),
    THERMOSTAT: requireServiceCtor(ServiceObject, "Thermostat"),
    HEATER_COOLER: requireServiceCtor(ServiceObject, "HeaterCooler"),
    HUMIDIFIER_DEHUMIDIFIER: requireServiceCtor(ServiceObject, "HumidifierDehumidifier"),
    AIR_PURIFIER: requireServiceCtor(ServiceObject, "AirPurifier"),
    LOCK_MECHANISM: requireServiceCtor(ServiceObject, "LockMechanism"),
    GARAGE_DOOR_OPENER: requireServiceCtor(ServiceObject, "GarageDoorOpener"),
    SECURITY_SYSTEM: requireServiceCtor(ServiceObject, "SecuritySystem"),
    TEMPERATURE_SENSOR: requireServiceCtor(ServiceObject, "TemperatureSensor"),
    HUMIDITY_SENSOR: requireServiceCtor(ServiceObject, "HumiditySensor"),
    MOTION_SENSOR: requireServiceCtor(ServiceObject, "MotionSensor"),
    CONTACT_SENSOR: requireServiceCtor(ServiceObject, "ContactSensor"),
    LEAK_SENSOR: requireServiceCtor(ServiceObject, "LeakSensor"),
    LIGHT_SENSOR: requireServiceCtor(ServiceObject, "LightSensor"),
    SMOKE_SENSOR: requireServiceCtor(ServiceObject, "SmokeSensor"),
    CARBON_MONOXIDE_SENSOR: requireServiceCtor(ServiceObject, "CarbonMonoxideSensor"),
    OCCUPANCY_SENSOR: requireServiceCtor(ServiceObject, "OccupancySensor"),
    DOOR: requireServiceCtor(ServiceObject, "Door"),
    WINDOW: requireServiceCtor(ServiceObject, "Window"),
    WINDOW_COVERING: requireServiceCtor(ServiceObject, "WindowCovering"),
    FAUCET: requireServiceCtor(ServiceObject, "Faucet"),
  };

  const ctor = map[typeOf];
  if (!ctor) {
    throw new Error(`Unsupported service typeOf: ${typeOf}`);
  }

  return ctor;
}

function requireServiceCtor(ServiceObject, key) {
  if (!ServiceObject[key]) {
    throw new Error(`Your Homebridge/HAP build does not expose Service.${key}`);
  }
  return ServiceObject[key];
}

function materializeAllOptionalCharacteristics(service) {
  const current = new Set(service.characteristics.map((characteristic) => characteristic.UUID));
  const optionals = Array.isArray(service.optionalCharacteristics)
    ? service.optionalCharacteristics.slice()
    : [];

  for (const optionalCharacteristic of optionals) {
    const ctor = optionalCharacteristic?.constructor;
    const uuid = ctor?.UUID || optionalCharacteristic?.UUID;
    if (!ctor || !uuid || current.has(uuid)) {
      continue;
    }

    try {
      service.getCharacteristic(ctor);
      current.add(uuid);
    } catch (error) {
      // Ignore characteristics that cannot be materialized by the current HAP build.
    }
  }
}

function buildStateFromService(service) {
  const state = {};

  for (const characteristic of service.characteristics) {
    if (!characteristic || !characteristic.displayName) {
      continue;
    }

    const sourceValue = (typeof characteristic.value !== "undefined" && characteristic.value !== null)
      ? characteristic.value
      : getDefaultCharacteristicValue(characteristic);
    state[characteristic.displayName] = toServerValue(characteristic, sourceValue);
  }

  return state;
}


function getPreferredServiceName(service, fallbackName) {
  if (Characteristic.ConfiguredName && service.testCharacteristic(Characteristic.ConfiguredName)) {
    const configuredName = service.getCharacteristic(Characteristic.ConfiguredName).value;
    if (typeof configuredName === "string" && configuredName.trim()) {
      return configuredName.trim();
    }
  }

  if (service.testCharacteristic(Characteristic.Name)) {
    const nameValue = service.getCharacteristic(Characteristic.Name).value;
    if (typeof nameValue === "string" && nameValue.trim()) {
      return nameValue.trim();
    }
  }

  return fallbackName;
}

function getDefaultCharacteristicValue(characteristic) {
  const currentValue = characteristic.value;
  if (typeof currentValue !== "undefined" && currentValue !== null) {
    return currentValue;
  }

  const format = characteristic.props?.format;
  const minValue = typeof characteristic.props?.minValue === "number" ? characteristic.props.minValue : undefined;

  switch (format) {
    case Characteristic.Formats.BOOL:
      return false;
    case Characteristic.Formats.STRING:
      return "";
    case Characteristic.Formats.FLOAT:
    case Characteristic.Formats.INT:
    case Characteristic.Formats.UINT8:
    case Characteristic.Formats.UINT16:
    case Characteristic.Formats.UINT32:
    case Characteristic.Formats.UINT64:
      return typeof minValue === "number" ? minValue : 0;
    default:
      return "";
  }
}

function toServerValue(characteristic, value) {
  const format = characteristic.props?.format;

  if (typeof value === "undefined" || value === null) {
    value = getDefaultCharacteristicValue(characteristic);
  }

  if (format === Characteristic.Formats.BOOL) {
    return value ? "1" : "0";
  }

  if (format === Characteristic.Formats.STRING) {
    return String(value);
  }

  if (
    format === Characteristic.Formats.FLOAT
    || format === Characteristic.Formats.INT
    || format === Characteristic.Formats.UINT8
    || format === Characteristic.Formats.UINT16
    || format === Characteristic.Formats.UINT32
    || format === Characteristic.Formats.UINT64
  ) {
    const numberValue = Number(value);
    return Number.isFinite(numberValue) ? String(numberValue) : "0";
  }

  return String(value);
}

function fromServerValue(characteristic, value) {
  const format = characteristic.props?.format;

  if (format === Characteristic.Formats.BOOL) {
    return value === true || value === 1 || value === "1" || value === "true";
  }

  if (format === Characteristic.Formats.STRING) {
    return String(value);
  }

  if (
    format === Characteristic.Formats.FLOAT
    || format === Characteristic.Formats.INT
    || format === Characteristic.Formats.UINT8
    || format === Characteristic.Formats.UINT16
    || format === Characteristic.Formats.UINT32
    || format === Characteristic.Formats.UINT64
  ) {
    const num = Number(value);
    if (!Number.isFinite(num)) {
      return getDefaultCharacteristicValue(characteristic);
    }

    return clampNumericCharacteristicValue(characteristic, num);
  }

  return value;
}

function clampNumericCharacteristicValue(characteristic, value) {
  let nextValue = value;
  const minValue = characteristic.props?.minValue;
  const maxValue = characteristic.props?.maxValue;

  if (typeof minValue === "number" && nextValue < minValue) {
    nextValue = minValue;
  }

  if (typeof maxValue === "number" && nextValue > maxValue) {
    nextValue = maxValue;
  }

  const format = characteristic.props?.format;
  const integerFormats = new Set([
    Characteristic.Formats.INT,
    Characteristic.Formats.UINT8,
    Characteristic.Formats.UINT16,
    Characteristic.Formats.UINT32,
    Characteristic.Formats.UINT64,
  ]);

  if (integerFormats.has(format)) {
    nextValue = Math.round(nextValue);
  }

  return nextValue;
}

function parseServerResponse(raw) {
  if (raw === null || typeof raw === "undefined") {
    return {};
  }

  const text = String(raw).trim();
  if (!text) {
    return {};
  }

  const direct = tryParseJson(text);
  if (Array.isArray(direct)) {
    const first = direct[0];
    if (typeof first === "string") {
      const nested = tryParseJson(first);
      if (nested && typeof nested === "object") {
        return nested;
      }
    }

    if (first && typeof first === "object") {
      return first;
    }
  }

  if (direct && typeof direct === "object") {
    return direct;
  }

  if (text.length >= 4 && text.startsWith('["') && text.endsWith('"]')) {
    const inner = text
      .slice(2, -2)
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\");

    const nested = tryParseJson(inner);
    if (nested && typeof nested === "object") {
      return nested;
    }
  }

  if (text.length > 4) {
    const sliced = text.slice(2, -2);
    const nested = tryParseJson(sliced);
    if (nested && typeof nested === "object") {
      return nested;
    }
  }

  throw new Error(`Unable to parse PHP server payload: ${text}`);
}

function tryParseJson(text) {
  try {
    return JSON.parse(text);
  } catch (error) {
    return undefined;
  }
}

function normalizeIncomingState(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const normalized = {};

  for (const [key, entry] of Object.entries(value)) {
    normalized[String(key)] = typeof entry === "string" ? entry : String(entry);
  }

  return normalized;
}

function sortStateForStableWrites(state) {
  const ordered = {};

  if (typeof state.Name !== "undefined") {
    ordered.Name = state.Name;
  }

  for (const key of Object.keys(state).sort((a, b) => a.localeCompare(b))) {
    if (key === "Name") {
      continue;
    }
    ordered[key] = state[key];
  }

  return ordered;
}

function sanitizeServerUrl(url) {
  if (!url) {
    return "";
  }
  return String(url).trim().replace(/\/+$/, "");
}

function buildPhpApiEndpoint(serverUrl) {
  const base = sanitizeServerUrl(serverUrl);
  if (!base) {
    return "";
  }

  if (/\/api\.php$/i.test(base)) {
    return base;
  }

  return `${base}/api.php`;
}

function normalizeVpin(vpin) {
  return String(vpin).replace(/^V/i, "");
}

function shouldSkipSetBinding(runtime, characteristic) {
  if (runtime.typeOf === "IRRIGATION_SYSTEM" && characteristic.displayName === "Name") {
    return true;
  }

  return false;
}

function toNumberOrDefault(value, fallback) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : fallback;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value || {}));
}

function formatError(error) {
  if (!error) {
    return "Unknown error";
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

