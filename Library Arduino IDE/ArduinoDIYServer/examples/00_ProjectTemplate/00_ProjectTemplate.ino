#include <ArduinoDIYServer.h>

/*
  ============================================================
  Example 00 - Project Template
  ============================================================
  This template is the recommended starting point for new projects.
  It already contains:
    - Wi-Fi connection
    - Optional OTA hook
    - VPin polling
    - VPin update

  The JSON string received from the server is stored in the global
  variable named 'json'.

  The parsed JSON object is stored in the global variable named 'doc'.

  A device can use one VPin or many VPins.
  To use many VPins, call pollVpinFromServer("V1");
	updateVpinOnServer("V1");
  pollVpinFromServer("V2");
  updateVpinOnServer("V2");
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
const char* OTA_HOSTNAME = "template-device";
const char* OTA_PASSWORD = "YOUR_OTA_PASSWORD";

// ------------------------------------------------------------
// Client object block
// ------------------------------------------------------------
DIYServerClient server(WIFI_SSID, WIFI_PASSWORD, SERVER_BASE_URL, PROJECT_TOKEN);

// ------------------------------------------------------------
// Runtime state block
// ------------------------------------------------------------
unsigned long lastPollMs = 0;
const char* VPIN_V1 = "V1";
StaticJsonDocument<256> doc;
String json = "";

// ------------------------------------------------------------
// Update block
// ------------------------------------------------------------
void updateVpinOnServer(String Vpin) {
  // Convert the global JSON document to a JSON string.
  json = "";
  serializeJson(doc, json);

  // Send the JSON string to the selected VPin on the server.
  server.updateVpin(Vpin, json);
}

// ------------------------------------------------------------
// Poll block
// ------------------------------------------------------------
void pollVpinFromServer(String Vpin) {
  // Read the JSON string from the selected VPin on the server.
	json = "";
  if (server.pollVpin(Vpin, json)) {
    // Parse the received JSON string into the global JSON document.
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

    pollVpinFromServer(VPIN_V1);

    // Handle the data stored in the global JSON document here.
    // Example:
    // doc["Name"] = "Name";
    // doc["On"] = "0";

    updateVpinOnServer(VPIN_V1);
  }
}
