const express = require('express');
const multer = require('multer');
const cors = require('cors');
const mqtt = require('mqtt');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { WebSocketServer } = require('ws');
const sensorProto = require('./sensor_pb.js');
const fileopsProto = require('./fileops_pb.js');
const actionsProto = require('./actions_pb.js');
const config = require('./config/config.json');

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

// --- Upload Endpoint (multipart/form-data, uses multer, returns JSON, publishes MQTT event) ---
app.post('/api/upload', upload.single('file'), (req, res) => {
  try {
    const buttonName = req.body.button_name || null;
    const uploadCfg = getUploadConfig(buttonName) || getUploadConfig();
    if (!uploadCfg) throw new Error('No upload config found');
    if (!req.file) throw new Error('No file uploaded');
    const filename = req.file.originalname;
    const ext = path.extname(filename);
    if (uploadCfg.allowed_extensions && !uploadCfg.allowed_extensions.includes(ext)) {
      fs.unlinkSync(req.file.path);
      throw new Error('File type not allowed');
    }
    if (uploadCfg.max_file_size && req.file.size > uploadCfg.max_file_size) {
      fs.unlinkSync(req.file.path);
      throw new Error('File size exceeds limit');
    }
    const uploadDir = resolveDir(__dirname, uploadCfg.upload_directory);
    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
    const destPath = path.join(uploadDir, filename);
    if (req.file.path !== destPath) {
      fs.renameSync(req.file.path, destPath);
    }
    // Publish MQTT event after upload
    if (mqttClient && mqttClient.connected && fileopsProto.FileEvent) {
      const relPath = path.relative(uploadDir, destPath);
      const eventMsg = new fileopsProto.FileEvent();
      eventMsg.setFilename(relPath);
      eventMsg.setSize(req.file.size);
      eventMsg.setButtonName(buttonName || '');
      const eventBuffer = eventMsg.serializeBinary();
      mqttClient.publish('file/uploaded', eventBuffer);
    }
    res.json({ filename, success: true, error: '' });
  } catch (err) {
    res.json({ filename: '', success: false, error: err.message || 'Upload failed' });
  }
});
// --- Download Endpoint (POST, JSON, sends file as download, supports filename or path, publishes MQTT event) ---
app.post('/api/download', express.json(), (req, res) => {
  try {
    const buttonName = req.body.button_name || null;
    const downloadCfg = getDownloadConfig(buttonName) || getDownloadConfig();
    if (!downloadCfg) throw new Error('No download config found');
    const filename = req.body.filename || req.body.path;
    if (!filename) throw new Error('No filename provided');
    const ext = path.extname(filename);
    if (downloadCfg.allowed_extensions && !downloadCfg.allowed_extensions.includes(ext)) {
      throw new Error('File type not allowed');
    }
    const rootDir = resolveDir(__dirname, downloadCfg.root_directory);
    const filePath = path.join(rootDir, filename);
    if (!fs.existsSync(filePath)) throw new Error('File not found');
    // Publish MQTT event after download
    if (mqttClient && mqttClient.connected && fileopsProto.FileEvent) {
      const relPath = path.relative(rootDir, filePath);
      const stats = fs.statSync(filePath);
      const eventMsg = new fileopsProto.FileEvent();
      eventMsg.setFilename(relPath);
      eventMsg.setSize(stats.size);
      eventMsg.setButtonName(buttonName || '');
      const eventBuffer = eventMsg.serializeBinary();
      mqttClient.publish('file/downloaded', eventBuffer);
    }
    res.download(filePath, path.basename(filename));
  } catch (err) {
    res.status(400).json({ filename: '', success: false, error: err.message || 'Download failed' });
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

// --- Browse Endpoint (supports button_name, prevents parent directory escape, with debug logs) ---
app.get('/api/browse', (req, res) => {
  try {
    const buttonName = req.query.button_name || null;
    const downloadCfg = getDownloadConfig(buttonName) || getDownloadConfig();
    if (!downloadCfg) throw new Error('No download config found');
    // FIX: Use __dirname for download root
    const rootDir = resolveDir(__dirname, downloadCfg.root_directory);
    let relPath = req.query.path || '';
    relPath = relPath.replace(/\\/g, '/').replace(/\.{2,}/g, '');
    const absPath = path.join(rootDir, relPath);
    const resolvedRoot = path.resolve(rootDir);
    const resolvedAbs = path.resolve(absPath);
    // Debug logs
    console.log('[BROWSE] button_name:', buttonName);
    console.log('[BROWSE] rootDir:', rootDir);
    console.log('[BROWSE] relPath:', relPath);
    console.log('[BROWSE] absPath:', absPath);
    console.log('[BROWSE] resolvedRoot:', resolvedRoot);
    console.log('[BROWSE] resolvedAbs:', resolvedAbs);
    if (!resolvedAbs.startsWith(resolvedRoot)) {
      return res.status(400).json({ error: 'Access outside of root directory is not allowed' });
    }
    fs.readdir(absPath, { withFileTypes: true }, (err, entries) => {
      if (err) return res.status(500).json({ error: 'Failed to list directory' });
      const directories = entries.filter(e => e.isDirectory()).map(e => e.name);
      const files = entries.filter(e => e.isFile()).map(e => ({ filename: e.name }));
      res.json({
        path: relPath,
        directories,
        files
      });
    });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Browse failed' });
  }
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

// Helper to get unit from config for a given topic
function getUnitForTopic(topic) {
  for (const tab of config.tabs) {
    for (const member of tab.members) {
      if (member.type === 'sensor' && member.topic === topic) {
        return member.unit || '';
      }
    }
  }
  return '';
}

function formatSensorData(topic, parsed) {
  // Try to find the first numeric property in parsed
  let value = undefined;
  for (const key in parsed) {
    if (typeof parsed[key] === 'number') {
      value = parsed[key];
      break;
    }
  }
  // If still undefined, use the whole parsed object
  if (value === undefined) value = parsed;
  const unit = getUnitForTopic(topic);
  const timestamp = Date.now();
  return { value, unit, timestamp };
}

// --- Dynamic sensor topic extraction and decoder mapping ---
const sensorTopics = [];
const topicDecoderMap = {};

for (const tab of config.tabs) {
  for (const member of tab.members) {
    if (member.type === 'sensor' && member.topic) {
      sensorTopics.push(member.topic);
      // Map topic to deserializeBinary function based on sensor name/type
      if (member.topic === 'sensor/temperature') {
        topicDecoderMap[member.topic] = sensorProto.TemperatureData.deserializeBinary;
      } else if (member.topic === 'sensor/compass') {
        topicDecoderMap[member.topic] = sensorProto.CompassData.deserializeBinary;
      } else if (member.topic === 'sensor/gps') {
        topicDecoderMap[member.topic] = sensorProto.GpsPositionData.deserializeBinary;
      } else if (member.topic === 'sensor/status') {
        topicDecoderMap[member.topic] = sensorProto.StatusMessage.deserializeBinary;
      } else {
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
    // Log the outgoing sensor data
    console.log('[SENSOR OUT]', topic, formatted);
    updateLatestSensorData(topic, formatted);
    broadcastWS({ type: 'sensor_update', sensor: topic.split('/')[1], data: formatted });
  }
});

const PORT = 8000;
server.listen(PORT, () => console.log(`Backend server running at http://localhost:${PORT}`)); 