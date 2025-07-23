import fetch from 'node-fetch';
import fs from 'fs';
import * as fileopsProto from './fileops_pb.js';
import * as actionsProto from './actions_pb.js';

const BASE_URL = 'http://localhost:8000';

async function testUpload() {
  const filename = 'test_upload.txt';
  const data = Buffer.from('Hello, protobuf upload!');
  const uploadMsg = { filename, data };
  const uploadBuffer = fileopsProto.encodeFileUpload(uploadMsg);
  const res = await fetch(`${BASE_URL}/api/upload`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: uploadBuffer
  });
  const buf = Buffer.from(await res.arrayBuffer());
  const response = fileopsProto.decodeFileDownloadResponse(buf);
  console.log('Upload response:', response);
}

async function testDownload() {
  const filename = 'test_upload.txt';
  const downloadReq = { filename };
  const downloadBuffer = fileopsProto.encodeFileDownloadRequest(downloadReq);
  const res = await fetch(`${BASE_URL}/api/download`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: downloadBuffer
  });
  const buf = Buffer.from(await res.arrayBuffer());
  const response = fileopsProto.decodeFileDownloadResponse(buf);
  console.log('Download response:', response);
  if (response.success) {
    fs.writeFileSync('downloaded_' + response.filename, Buffer.from(response.data));
    console.log('Downloaded file saved as:', 'downloaded_' + response.filename);
  }
}

async function testAction() {
  const actionReq = {
    topic: 'test/action',
    payload: 'test payload',
    ack_topic: '' // No ack for this test
  };
  const actionBuffer = actionsProto.encodeActionRequest(actionReq);
  const res = await fetch(`${BASE_URL}/api/action`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: actionBuffer
  });
  const buf = Buffer.from(await res.arrayBuffer());
  const response = actionsProto.decodeActionAck(buf);
  console.log('Action response:', response);
}

(async () => {
  await testUpload();
  await testDownload();
  await testAction();
})(); 