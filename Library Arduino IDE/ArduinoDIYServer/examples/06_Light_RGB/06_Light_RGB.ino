#include <ArduinoDIYServer.h>

/*
  ============================================================
  Example 01 - Outlet
  ============================================================
  JSON format used by this example:
  {"Name":"Led","Brightness":"100","Characteristic Value Active Transition Count":"0","Characteristic Value Transition Control":"","Color Temperature":"163","Configured Name":"Led","Hue":"0","On":"0","Saturation":"100","Supported Characteristic Value Transition Configuration":""}

  What this example does:
    - Polls one VPin from the server
    - Reads the global JSON document
    - Uses the field "On" to control one relay
    - Updates the field "Outlet In Use"
    - Sends the modified JSON back to the server
*/

// ------------------------------------------------------------
// User configuration block
// ------------------------------------------------------------
const char* WIFI_SSID = "YOUR_WIFI_SSID";
const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";
const char* SERVER_BASE_URL = "http://IP-SERVER:8181";
const char* PROJECT_TOKEN = "YOUR_48_CHARACTER_PROJECT_TOKEN";

// ------------------------------------------------------------
// Timing configuration block
// ------------------------------------------------------------
const unsigned long POLL_INTERVAL_MS = 1000UL;

// ------------------------------------------------------------
// Optional OTA configuration block
// ------------------------------------------------------------
const bool ENABLE_OTA = true;
const char* OTA_HOSTNAME = "light_rgb-device";
const char* OTA_PASSWORD = "YOUR_OTA_PASSWORD";

// ------------------------------------------------------------
// Client object block
// ------------------------------------------------------------
DIYServerClient server(WIFI_SSID, WIFI_PASSWORD, SERVER_BASE_URL, PROJECT_TOKEN);

// ------------------------------------------------------------
// Runtime state block
// ------------------------------------------------------------
unsigned long lastPollMs = 0;
const uint8_t PIN_R = D5;
const uint8_t PIN_G = D6;
const uint8_t PIN_B = D7;
bool hkOn = false;
float hkBrightness = 0.0;   // 0..100
float hkHue = 0.0;            // 0..360
float hkSaturation = 0.0;   // 0..100
// Set to true if your RGB LED is common anode
const bool COMMON_ANODE = false;
const char* VPIN_LIGHT_RBG = "V11";
StaticJsonDocument<256> doc;
String json = "";

// ------------------------------------------------------------
// Update block
// ------------------------------------------------------------
void updateVpinOnServer(String Vpin) {
  json = "";
  serializeJson(doc, json);
  server.updateVpin(Vpin, json);
}

// ------------------------------------------------------------
// Poll block
// ------------------------------------------------------------
void pollVpinFromServer(String Vpin) {
	json = "";
  if (server.pollVpin(Vpin, json)) {
		doc.clear();
    deserializeJson(doc, json);
  }
}

// ------------------------------------------------------------
// Setup block
// ------------------------------------------------------------
void setup() {
  Serial.begin(115200);
  delay(200);

  pinMode(PIN_R, OUTPUT);
  pinMode(PIN_G, OUTPUT);
  pinMode(PIN_B, OUTPUT);

  analogWriteRange(255);
  analogWriteFreq(1000);

  server.begin();

  if (ENABLE_OTA) {
    server.enableOTA(OTA_HOSTNAME, OTA_PASSWORD);
  }
}

// ------------------------------------------------------------
// Main loop block
// ------------------------------------------------------------
void loop() {
  server.loop();

  if (millis() - lastPollMs >= POLL_INTERVAL_MS) {
    lastPollMs = millis();

    pollVpinFromServer(VPIN_LIGHT_RBG);

    if (doc["On"] == "1") {
      hkOn = true;
    } else {
      hkOn = false;
    }
    hkBrightness = doc["Brightness"];
    hkHue = doc["Hue"];
    hkSaturation = doc["Saturation"];

    applyColor();
  }
}

void writeChannel(int pin, int value) {
  value = constrain(value, 0, 255);

  if (COMMON_ANODE) {
    value = 255 - value;
  }

  analogWrite(pin, value);
}

void hsvToRgb(float h, float s, float v, int &r, int &g, int &b) {
  s = constrain(s, 0.0, 100.0) / 100.0;
  v = constrain(v, 0.0, 100.0) / 100.0;

  float c = v * s;
  float x = c * (1.0 - fabs(fmod(h / 60.0, 2.0) - 1.0));
  float m = v - c;

  float r1 = 0, g1 = 0, b1 = 0;

  if (h >= 0 && h < 60) {
    r1 = c; g1 = x; b1 = 0;
  } else if (h < 120) {
    r1 = x; g1 = c; b1 = 0;
  } else if (h < 180) {
    r1 = 0; g1 = c; b1 = x;
  } else if (h < 240) {
    r1 = 0; g1 = x; b1 = c;
  } else if (h < 300) {
    r1 = x; g1 = 0; b1 = c;
  } else {
    r1 = c; g1 = 0; b1 = x;
  }

  r = (int)((r1 + m) * 255.0);
  g = (int)((g1 + m) * 255.0);
  b = (int)((b1 + m) * 255.0);
}

void applyColor() {
  if (!hkOn) {
    writeChannel(PIN_R, 0);
    writeChannel(PIN_G, 0);
    writeChannel(PIN_B, 0);
    return;
  }

  int r, g, b;
  hsvToRgb(hkHue, hkSaturation, hkBrightness, r, g, b);

  writeChannel(PIN_R, r);
  writeChannel(PIN_G, g);
  writeChannel(PIN_B, b);
}