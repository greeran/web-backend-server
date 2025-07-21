# IMX8MP Web Server Backend

## Overview
This backend is a Node.js + Express server that dynamically configures its endpoints and MQTT subscriptions based on `config/config.json`. It supports sensors, buttons, file uploads, and downloads, all defined in the config file.

## Dynamic Configuration
- The backend reads `config/config.json` at startup.
- All tabs and members (sensors, buttons, uploads, downloads) are defined in this file.
- No code changes are needed to add/remove sensors, buttons, uploads, or downloads—just update the config and restart the backend.

## Endpoints
- `GET /api/config` — Returns the current config to the frontend.
- `POST /api/upload` — Upload a file (protobuf-encoded, must include `button_name` if multiple upload configs exist).
- `POST /api/download` — Download a file (protobuf-encoded, must include `button_name` if multiple download configs exist).
- `POST /api/action` — Trigger a button action (protobuf-encoded, topic must match a button in config).
- `GET /api/sensors` — Get latest sensor data.
- `GET /api/files` — List uploaded files (for default upload dir).
- `GET /api/browse` — Browse files in a directory (for download root).
- WebSocket — Receives live sensor updates.

## Adding New Types
- **Sensor:** Add a new member with `type: "sensor"` and a unique `topic`.
- **Button:** Add a new member with `type: "button"`, `button_name`, and `publish_topic`.
- **Upload:** Add a new member with `type: "upload"`, `button_name`, `upload_directory`, `allowed_extensions`, and `max_file_size`.
- **Download:** Add a new member with `type: "download"`, `button_name`, `root_directory`, and `allowed_extensions`.

## Frontend Integration
- Fetch `/api/config` to build the UI dynamically.
- For uploads/downloads, send the correct `button_name` in the protobuf message.
- For actions, use the correct `publish_topic` as the topic in the protobuf message.
- Listen to WebSocket for live sensor updates.

## Testing
- Use Postman, curl, or Node.js scripts to send protobuf-encoded requests to the endpoints.
- See the backend logs for detailed error messages and config validation.

## Error Handling
- The backend validates the config at startup and will not start if there are errors.
- All endpoints return detailed error messages for invalid requests or config mismatches.

---
For more details, see the code comments and config file examples. 