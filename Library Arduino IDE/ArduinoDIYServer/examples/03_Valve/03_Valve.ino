#include <ArduinoDIYServer.h>

/*
  ============================================================
  Example 03 - Fan
  ============================================================
  JSON format used by this example:
  {"Name":"valve","Active":"0","Configured Name":"valve","In Use":"0","Is Configured":"1","Remaining Duration":"0","Service Label Index":"1","Set Duration":"300","Status Fault":"0","Valve Type":"0"}

  What this example does:
    - Polls one VPin from the server
    - Reads the global JSON document
    - Uses the field "Active" to control one output
    - Prints the fan values to Serial
    - Updates the field "Current Fan State"
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
const char* OTA_HOSTNAME = "valve-device";
const char* OTA_PASSWORD = "YOUR_OTA_PASSWORD";

// ------------------------------------------------------------
// Client object block
// ------------------------------------------------------------
DIYServerClient server(WIFI_SSID, WIFI_PASSWORD, SERVER_BASE_URL, PROJECT_TOKEN);

// ------------------------------------------------------------
// Runtime state block
// ------------------------------------------------------------
unsigned long lastPollMs = 0;
const uint8_t RELAY_PIN = D1;
const char* VPIN = "V7";
StaticJsonDocument<384> doc;
String json = "";

// ------------------------------------------------------------
// Update block
// ------------------------------------------------------------
void updateVpinFromServer(String Vpin) {
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

  pinMode(RELAY_PIN, OUTPUT);
  digitalWrite(RELAY_PIN, HIGH);

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

    pollVpinFromServer(VPIN);

    if (doc["Active"] == "1" && doc["Is Configured"] == "1" && doc["In Use"] == "0") {
      digitalWrite(RELAY_PIN, LOW);
      doc["In Use"] = "1";
      doc["Remaining Duration"] = doc["Set Duration"];
    }else if (doc["Active"] == "1" && doc["Is Configured"] == "1" && doc["In Use"] == "1") {
      int remaining = doc["Remaining Duration"].as<int>() - 1;
      doc["Remaining Duration"] = String(remaining);
      if (doc["Remaining Duration"] == "0") {
        digitalWrite(RELAY_PIN, HIGH);
        doc["Active"] = "0";
        doc["In Use"] = "0";
      }
    }else {
      digitalWrite(RELAY_PIN, HIGH);
      doc["Remaining Duration"] = "0";
      doc["In Use"] = "0";
    }

    updateVpinFromServer(VPIN);
  }
}
