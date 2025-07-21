const express = require('express');
const multer = require('multer');
const cors = require('cors');
const mqtt = require('mqtt');
const path = require('path');
const fs = require('fs');
const http = require('http');
const WebSocket = require('ws');
const sensorProto = require('./sensor_pb.js');

const config = require('./config.json');
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const ALLOWED_EXTENSIONS = config.tabs.files.upload_config.allowed_extensions;

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => cb(null, file.originalname),
});
const fileFilter = (req, file, cb) => {
  const ext = path.extname(file.originalname);
  if (ALLOWED_EXTENSIONS.includes(ext)) cb(null, true);
  else cb(new Error('File type not allowed'), false);
};
const upload = multer({ storage, fileFilter });

const app = express();
app.use(cors());

// In-memory store for latest sensor data
let latestSensorData = {};

// List uploaded files
app.get('/api/files', (req, res) => {
  fs.readdir(UPLOAD_DIR, (err, files) => {
    if (err) return res.status(500).json({ error: 'Failed to list files' });
    const fileList = files.map(filename => {
      const stats = fs.statSync(path.join(UPLOAD_DIR, filename));
      return {
        filename,
        size: stats.size,
        modified: stats.mtime
      };
    });
    res.json(fileList);
  });
});

// Delete a file
app.delete('/api/delete/:filename', (req, res) => {
  const filePath = path.join(UPLOAD_DIR, req.params.filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
  fs.unlink(filePath, err => {
    if (err) return res.status(500).json({ error: 'Failed to delete file' });
    res.json({ success: true });
  });
});

// Get latest sensor data
app.get('/api/sensors', (req, res) => {
  res.json(latestSensorData);
});

// Get system info (uptime, CPU, memory)
app.get('/api/system', async (req, res) => {
  const exec = require('child_process').exec;
  const getCmd = cmd => new Promise(resolve => exec(cmd, (err, out) => resolve(out ? out.trim() : '')));
  const uptime = await getCmd('uptime');
  const cpu = await getCmd("top -bn1 | grep 'Cpu(s)' | awk '{print $2}' | cut -d'%' -f1");
  const mem = await getCmd("free -m | awk 'NR==2{printf \"%.1f%%\", $3*100/$2}'");
  // Broadcast system info update to WebSocket clients
  broadcastWS({ type: 'system_update', data: { uptime, cpu, memory: mem } });
  res.json({ uptime, cpu, memory: mem });
});

// Serve config.json
app.get('/api/config', (req, res) => res.json(config));

// File upload endpoint
app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, error: 'No file uploaded or file type not allowed' });
  // Optionally publish MQTT message here
  res.json({ success: true, filename: req.file.originalname, full_path: req.file.path });
});

// File download endpoint
app.get('/api/download/:filename', (req, res) => {
  const filePath = path.join(UPLOAD_DIR, req.params.filename);
  if (fs.existsSync(filePath)) res.download(filePath);
  else res.status(404).json({ error: 'File not found' });
});

// --- WebSocket setup for real-time updates ---
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

wss.on('connection', ws => {
  // Send initial sensor data
  ws.send(JSON.stringify({ type: 'init', sensors: latestSensorData }));
});

function broadcastWS(msg) {
  const data = typeof msg === 'string' ? msg : JSON.stringify(msg);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.send(data);
  });
}

// --- MQTT integration (parse as JSON, fallback to string) ---
const mqttClient = mqtt.connect(`mqtt://${config.broker_config.host}:${config.broker_config.port}`);
mqttClient.on('connect', () => {
  console.log('Connected to MQTT broker');
  // Subscribe to all sensor topics (wildcard)
  mqttClient.subscribe('sensor/#');
});
mqttClient.on('message', (topic, message) => {
  console.log(`MQTT message on ${topic}:`, message);
  if (topic.startsWith('sensor/')) {
    let parsed;
    try {
      // Choose the correct decode function based on topic
      if (topic === 'sensor/temperature' && sensorProto.decodeTemperatureData) {
        parsed = sensorProto.decodeTemperatureData(message);
      } else if (topic === 'sensor/compass' && sensorProto.decodeCompassData) {
        parsed = sensorProto.decodeCompassData(message);
      } else if (topic === 'sensor/gps' && sensorProto.decodeGpsPositionData) {
        parsed = sensorProto.decodeGpsPositionData(message);
      } else if (topic === 'sensor/status' && sensorProto.decodeStatusMessage) {
        parsed = sensorProto.decodeStatusMessage(message);
      } else {
        parsed = { raw: message.toString('base64') };
      }
    } catch (e) {
      parsed = { raw: message.toString('base64'), error: e.message };
    }
    latestSensorData[topic] = parsed;
    broadcastWS({ type: 'sensor_update', topic, data: parsed });
  }
});

const PORT = 8000;
server.listen(PORT, () => console.log(`Backend server running at http://localhost:${PORT}`)); 