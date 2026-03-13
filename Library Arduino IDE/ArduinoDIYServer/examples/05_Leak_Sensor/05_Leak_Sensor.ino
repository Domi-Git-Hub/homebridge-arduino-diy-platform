#include <ArduinoDIYServer.h>

/*
  ============================================================
  Example 01 - Outlet
  ============================================================
  JSON format used by this example:
  {"Name":"Water Leak","Leak Detected":"0","Status Active":"0","Status Fault":"0","Status Low Battery":"0","Status Tampered":"0"}

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
const char* OTA_HOSTNAME = "leak_sensor-device";
const char* OTA_PASSWORD = "YOUR_OTA_PASSWORD";

// ------------------------------------------------------------
// Client object block
// ------------------------------------------------------------
DIYServerClient server(WIFI_SSID, WIFI_PASSWORD, SERVER_BASE_URL, PROJECT_TOKEN);

// ------------------------------------------------------------
// Runtime state block
// ------------------------------------------------------------
unsigned long lastPollMs = 0;
const uint8_t PROBE_POWER_PIN = D1;
const uint8_t PROBE_SENSE_PIN = D2;
const char* VPIN_LEAK_SENSOR = "V10";
bool waterDetected = false;
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

  pinMode(PROBE_POWER_PIN, OUTPUT);
  digitalWrite(PROBE_POWER_PIN, LOW);

  // External 1M pulldown resistor required on PROBE_SENSE_PIN
  pinMode(PROBE_SENSE_PIN, INPUT);

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

    pollVpinFromServer(VPIN_LEAK_SENSOR);

    waterDetected = readWaterSensor();

    if (waterDetected && doc["Leak Detected"] == "0" && doc["Status Active"] == "0") {
      doc["Leak Detected"] = "1";
      doc["Status Active"] = "1";
      updateVpinOnServer(VPIN_LEAK_SENSOR);
    } else if (!waterDetected && doc["Leak Detected"] == "1" && doc["Status Active"] == "1") {
      doc["Leak Detected"] = "0";
      doc["Status Active"] = "0";
      updateVpinOnServer(VPIN_LEAK_SENSOR);
    }
  }
}

bool readWaterSensor() {
  int hits = 0;
  const int samples = 10;

  for (int i = 0; i < samples; i++) {
    // Power the probe only for a short time
    digitalWrite(PROBE_POWER_PIN, HIGH);
    delay(3);

    if (digitalRead(PROBE_SENSE_PIN) == HIGH) {
      hits++;
    }

    digitalWrite(PROBE_POWER_PIN, LOW);
    delay(20);
  }

  // Require several positive reads to avoid false triggers
  return (hits >= 3);
}