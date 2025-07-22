import express from 'express';
import multer from 'multer';
import cors from 'cors';
import mqtt from 'mqtt';
import path from 'path';
import fs from 'fs';
import http from 'http';
import { WebSocketServer } from 'ws';
import * as sensorProto from './sensor_pb.js';
import * as fileopsProto from './fileops_pb.js';
import * as actionsProto from './actions_pb.js';
import config from './config/config.json' assert { type: 'json' };

const __dirname = path.dirname(new URL(import.meta.url).pathname);
const filesTab = config.tabs.find(tab => tab.id === 'files');
const UPLOAD_DIR = filesTab?.upload?.upload_directory
  ? path.isAbsolute(filesTab.upload.upload_directory)
    ? filesTab.upload.upload_directory
    : path.join(__dirname, filesTab.upload.upload_directory)
  : path.join(__dirname, 'uploads');
const ALLOWED_EXTENSIONS = filesTab?.upload?.allowed_extensions || [];

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => cb(null, file.originalname),
});
// Remove fileFilter from multer setup
const upload = multer({ storage });

const app = express();
app.use(cors());

let latestSensorData = {};

function updateLatestSensorData(topic, formatted) {
  // Map topic to generic key
  let key = topic.split('/')[1] || topic;
  latestSensorData[key] = formatted;
}

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

app.delete('/api/delete/:filename', (req, res) => {
  const filePath = path.join(UPLOAD_DIR, req.params.filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
  fs.unlink(filePath, err => {
    if (err) return res.status(500).json({ error: 'Failed to delete file' });
    res.json({ success: true });
  });
});

app.get('/api/sensors', (req, res) => {
  res.json(latestSensorData);
});

app.get('/api/system', async (req, res) => {
  const exec = (await import('child_process')).exec;
  const getCmd = cmd => new Promise(resolve => exec(cmd, (err, out) => resolve(out ? out.trim() : '')));
  const uptime = await getCmd('uptime');
  const cpu = await getCmd("top -bn1 | grep 'Cpu(s)' | awk '{print $2}' | cut -d'%' -f1");
  const mem = await getCmd("free -m | awk 'NR==2{printf \"%.1f%%\", $3*100/$2}'");
  broadcastWS({ type: 'system_update', data: { uptime, cpu, memory: mem } });
  res.json({ uptime, cpu, memory: mem });
});

app.get('/api/config', (req, res) => res.json(config));

// --- Helper functions to get upload/download/button config by button_name ---
function getUploadConfig(buttonName) {
  for (const tab of config.tabs) {
    for (const member of tab.members) {
      if (member.type === 'upload' && (!buttonName || member.button_name === buttonName)) {
        return member;
      }
    }
  }
  return null;
}
function getDownloadConfig(buttonName) {
  for (const tab of config.tabs) {
    for (const member of tab.members) {
      if (member.type === 'download' && (!buttonName || member.button_name === buttonName)) {
        return member;
      }
    }
  }
  return null;
}
function isValidButtonAction(topic) {
  for (const tab of config.tabs) {
    for (const member of tab.members) {
      if (member.type === 'button' && member.publish_topic === topic) {
        return true;
      }
    }
  }
  return false;
}

// --- Config Validation at Startup ---
function validateConfig(config) {
  const buttonNames = new Set();
  for (const tab of config.tabs) {
    for (const member of tab.members) {
      if ((member.type === 'upload' || member.type === 'download' || member.type === 'button') && member.button_name) {
        if (buttonNames.has(member.button_name)) {
          throw new Error(`Duplicate button_name found in config: ${member.button_name}`);
        }
        buttonNames.add(member.button_name);
      }
      if (member.type === 'upload') {
        if (!member.upload_directory) throw new Error(`Upload config missing upload_directory for button: ${member.button_name}`);
        if (!member.allowed_extensions) throw new Error(`Upload config missing allowed_extensions for button: ${member.button_name}`);
      }
      if (member.type === 'download') {
        if (!member.root_directory) throw new Error(`Download config missing root_directory for button: ${member.button_name}`);
        if (!member.allowed_extensions) throw new Error(`Download config missing allowed_extensions for button: ${member.button_name}`);
      }
      if (member.type === 'button') {
        if (!member.publish_topic) throw new Error(`Button config missing publish_topic for button: ${member.button_name}`);
      }
    }
  }
}
try {
  validateConfig(config);
  console.log('Config validation passed.');
} catch (e) {
  console.error('Config validation failed:', e.message);
  process.exit(1);
}

// --- Refactored directory path resolution helper ---
function resolveDir(baseDir, dir) {
  return path.isAbsolute(dir) ? dir : path.join(baseDir, dir);
}

// --- Upload Endpoint (multipart/form-data, uses multer, returns JSON) ---
app.post('/api/upload', upload.single('file'), (req, res) => {
  try {
    const buttonName = req.body.button_name || null;
    const uploadCfg = getUploadConfig(buttonName) || getUploadConfig();
    if (!uploadCfg) throw new Error('No upload config found');
    if (!req.file) throw new Error('No file uploaded');
    const filename = req.file.originalname;
    const ext = path.extname(filename);
    if (uploadCfg.allowed_extensions && !uploadCfg.allowed_extensions.includes(ext)) {
      // Remove the uploaded file if not allowed
      fs.unlinkSync(req.file.path);
      throw new Error('File type not allowed');
    }
    if (uploadCfg.max_file_size && req.file.size > uploadCfg.max_file_size) {
      fs.unlinkSync(req.file.path);
      throw new Error('File size exceeds limit');
    }
    // Move file to correct upload directory if needed
    const uploadDir = resolveDir(uploadCfg.upload_directory, UPLOAD_DIR);
    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
    const destPath = path.join(uploadDir, filename);
    if (req.file.path !== destPath) {
      fs.renameSync(req.file.path, destPath);
    }
    res.json({ filename, success: true, error: '' });
  } catch (err) {
    res.json({ filename: '', success: false, error: err.message || 'Upload failed' });
  }
});
// --- Protobuf Download Endpoint (dynamic, with field checks, returns JSON) ---
app.post('/api/download', express.raw({ type: 'application/octet-stream', limit: '2mb' }), (req, res) => {
  try {
    const downloadReq = fileopsProto.decodeFileDownloadRequest(new Uint8Array(req.body));
    const buttonName = downloadReq.button_name || null;
    const downloadCfg = getDownloadConfig(buttonName) || getDownloadConfig();
    if (!downloadCfg) throw new Error('No download config found');
    const filename = downloadReq.filename;
    if (!filename) throw new Error('No filename provided in download message');
    const ext = path.extname(filename);
    if (downloadCfg.allowed_extensions && !downloadCfg.allowed_extensions.includes(ext)) {
      throw new Error('File type not allowed');
    }
    const rootDir = resolveDir(downloadCfg.root_directory, UPLOAD_DIR);
    const filePath = path.join(rootDir, filename);
    if (!fs.existsSync(filePath)) throw new Error('File not found');
    // For download, you may want to send the file as a download, but for now, just return JSON meta
    res.json({ filename, success: true, error: '' });
  } catch (err) {
    res.json({ filename: '', success: false, error: err.message || 'Download failed' });
  }
});
// --- RESTful Actions Endpoint (frontend-friendly, no MQTT details exposed) ---
app.post('/api/action', express.json(), (req, res) => {
  try {
    const { action, value } = req.body;
    if (!action) throw new Error('No action provided in request');
    // Find the button in config by button_name or action
    let buttonConfig = null;
    for (const tab of config.tabs) {
      for (const member of tab.members) {
        if (member.type === 'button' && member.button_name === action) {
          buttonConfig = member;
          break;
        }
      }
      if (buttonConfig) break;
    }
    if (!buttonConfig) throw new Error('Action not found in config');
    const topic = buttonConfig.publish_topic;
    if (!topic) throw new Error('No publish_topic found for action');
    if (!mqttClient.connected) {
      mqttClient.reconnect();
    }
    const payload = value !== undefined && value !== null ? value : '';
    mqttClient.publish(topic, payload);
    res.json({ ack: 'Action sent', success: true, error: '' });
  } catch (err) {
    res.json({ ack: '', success: false, error: err.message || 'Action failed' });
  }
});

// --- File browser endpoint ---
app.get('/api/browse', (req, res) => {
  const filesTab = config.tabs.find(tab => tab.id === 'files');
  const rootDir = filesTab?.download?.root_directory
    ? path.isAbsolute(filesTab.download.root_directory)
      ? filesTab.download.root_directory
      : path.join(__dirname, filesTab.download.root_directory)
    : path.join(__dirname, 'uploads');

  // Get requested path, default to root
  let relPath = req.query.path || '';
  // Prevent directory traversal
  relPath = relPath.replace(/\\/g, '/').replace(/\.\./g, '');
  const absPath = path.join(rootDir, relPath);
  if (!absPath.startsWith(rootDir)) {
    return res.status(400).json({ error: 'Invalid path' });
  }
  fs.readdir(absPath, { withFileTypes: true }, (err, entries) => {
    if (err) return res.status(500).json({ error: 'Failed to list directory' });
    const directories = entries.filter(e => e.isDirectory()).map(e => e.name);
    const files = entries.filter(e => e.isFile()).map(e => e.name);
    res.json({
      path: relPath,
      directories,
      files
    });
  });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

wss.on('connection', ws => {
  ws.send(JSON.stringify({ type: 'init', sensors: latestSensorData }));
});

function broadcastWS(msg) {
  const data = typeof msg === 'string' ? msg : JSON.stringify(msg);
  wss.clients.forEach(client => {
    if (client.readyState === 1) client.send(data);
  });
}

function formatSensorData(topic, parsed) {
  if (topic === 'sensor/gps' && parsed.position) {
    return {
      value: `${parsed.position.latitude.toFixed(6)}, ${parsed.position.longitude.toFixed(6)}`,
      unit: parsed.unit || 'decimal_degrees',
      timestamp: new Date().toISOString(),
      description: 'GPS Location'
    };
  }
  if (topic === 'sensor/temperature' && parsed.temperature !== undefined) {
    return {
      value: parsed.temperature,
      unit: parsed.unit || '°C',
      timestamp: new Date().toISOString(),
      description: 'CPU Temperature'
    };
  }
  if (topic === 'sensor/compass' && parsed.heading !== undefined) {
    return {
      value: parsed.heading,
      unit: parsed.unit || 'degrees',
      timestamp: new Date().toISOString(),
      description: 'Compass Heading'
    };
  }
  if (topic === 'sensor/status' && parsed.status !== undefined) {
    // Status enum mapping
    const statusMap = ['UNKNOWN', 'ONLINE', 'OFFLINE', 'ERROR'];
    return {
      value: statusMap[parsed.status] || 'UNKNOWN',
      device_id: parsed.device_id || '',
      message: parsed.message || '',
      timestamp: parsed.timestamp ? new Date(Number(parsed.timestamp)).toISOString() : new Date().toISOString(),
      description: 'Sensor Status'
    };
  }
  return parsed;
}

// --- Dynamic sensor topic extraction and decoder mapping ---
// Extract all sensor topics and build a topic-to-decoder mapping from config
const sensorTopics = [];
const topicDecoderMap = {};

for (const tab of config.tabs) {
  for (const member of tab.members) {
    if (member.type === 'sensor' && member.topic) {
      sensorTopics.push(member.topic);
      // Map topic to decoder function based on sensor name/type
      // You may need to adjust this mapping if you add new sensor types
      if (member.topic === 'sensor/temperature') {
        topicDecoderMap[member.topic] = sensorProto.decodeTemperatureData;
      } else if (member.topic === 'sensor/compass') {
        topicDecoderMap[member.topic] = sensorProto.decodeCompassData;
      } else if (member.topic === 'sensor/gps') {
        topicDecoderMap[member.topic] = sensorProto.decodeGpsPositionData;
      } else if (member.topic === 'sensor/status') {
        topicDecoderMap[member.topic] = sensorProto.decodeStatusMessage;
      } else {
        // Default: no decoder, just pass raw
        topicDecoderMap[member.topic] = null;
      }
    }
  }
}

const mqttClient = mqtt.connect(`mqtt://${config.broker.host}:${config.broker.port}`);
mqttClient.on('connect', () => {
  console.log('Connected to MQTT broker');
  // Subscribe only to sensor topics from config
  for (const topic of sensorTopics) {
    mqttClient.subscribe(topic, err => {
      if (err) console.error(`Failed to subscribe to ${topic}:`, err);
      else console.log(`Subscribed to ${topic}`);
    });
  }
});
mqttClient.on('message', (topic, message) => {
  if (sensorTopics.includes(topic)) {
    let parsed;
    try {
      const decoder = topicDecoderMap[topic];
      if (decoder) {
        parsed = decoder(message);
      } else {
        parsed = { raw: message.toString('base64') };
      }
    } catch (e) {
      parsed = { raw: message.toString('base64'), error: e.message };
    }
    const formatted = formatSensorData(topic, parsed);
    updateLatestSensorData(topic, formatted);
    broadcastWS({ type: 'sensor_update', sensor: topic.split('/')[1], data: formatted });
  }
});

const PORT = 8000;
server.listen(PORT, () => console.log(`Backend server running at http://localhost:${PORT}`)); 