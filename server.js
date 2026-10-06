import { createServer } from "node:http";
import { connect as connectTcp } from "node:net";
import { createSocket as createUdpSocket } from "node:dgram";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL(".", import.meta.url));
const root = join(projectRoot, "dist");
const port = Number(process.env.PORT || 5173);
const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
};

const radioClients = new Set();
const radioEvents = [];
const radioConfig = {
  transport: process.env.RADIO_TRANSPORT || "udp",
  device: process.env.RADIO_DEVICE || process.env.RADIO_HOST || "127.0.0.1",
  port: Number(process.env.RADIO_PORT || 14550),
  baud: Number(process.env.RADIO_BAUD || 115200),
};
let radioConnection = null;
let radioReconnectTimer = null;
let radioReconnectAttempt = 0;
let radioDesired = false;
let radioStatus = {
  state: "disconnected",
  transport: radioConfig.transport,
  endpoint: null,
  bytes: 0,
  frames: 0,
  lastFrameAt: null,
  lastError: null,
};
let radioBuffer = Buffer.alloc(0);
const MAVLINK_CRC_EXTRAS = new Map([[0, 50], [1, 124], [2, 137], [4, 237], [20, 214], [21, 159], [22, 220], [23, 168], [24, 24], [27, 144], [30, 39], [32, 222], [33, 104], [36, 222], [39, 254], [40, 230], [43, 132], [44, 221], [45, 232], [46, 11], [47, 153], [51, 196], [65, 118], [66, 148], [69, 243], [70, 124], [73, 38], [74, 20], [75, 158], [76, 152], [77, 143], [109, 185], [110, 84], [111, 34], [147, 154], [148, 178], [152, 208], [163, 127], [165, 21], [178, 47], [193, 71], [230, 163], [241, 90], [245, 130], [253, 83]]);

function mavlinkCrc(bytes, crc = 0xffff) {
  for (const byte of bytes) {
    let value = byte ^ (crc & 0xff);
    value ^= (value << 4) & 0xff;
    crc = ((crc >> 8) ^ (value << 8) ^ (value << 3) ^ (value >> 4)) & 0xffff;
  }
  return crc;
}

function validateMavlinkFrame(frame, messageId, signed) {
  const extra = MAVLINK_CRC_EXTRAS.get(messageId);
  if (extra === undefined) return "crc_extra_unknown";
  const crcEnd = frame.length - (signed ? 13 : 0);
  const received = frame[crcEnd - 2] | (frame[crcEnd - 1] << 8);
  let computed = mavlinkCrc(frame.subarray(1, crcEnd - 2));
  computed = mavlinkCrc(Buffer.from([extra]), computed);
  return received === computed ? "validated" : "invalid";
}

function emitRadioEvent(event) {
  const payload = JSON.stringify({ ...event, timestamp: new Date().toISOString() });
  radioEvents.push(payload);
  if (radioEvents.length > 200) radioEvents.shift();
  for (const client of radioClients) client.write(`data: ${payload}\n\n`);
}

function setRadioStatus(patch) {
  radioStatus = { ...radioStatus, ...patch };
  emitRadioEvent({ type: "status", status: radioStatus });
}

function frameLength(buffer) {
  if (buffer.length < 2) return null;
  if (buffer[0] === 0xfe) return buffer.length >= 6 ? 8 + buffer[1] : null;
  if (buffer[0] === 0xfd) return buffer.length >= 10 ? 12 + buffer[1] + ((buffer[2] & 0x01) ? 13 : 0) : null;
  return 0;
}

function ingestRadioBytes(chunk) {
  if (!chunk?.length) return;
  radioStatus.bytes += chunk.length;
  radioBuffer = Buffer.concat([radioBuffer, chunk]);
  while (radioBuffer.length) {
    const length = frameLength(radioBuffer);
    if (length === 0) {
      radioBuffer = radioBuffer.subarray(1);
      continue;
    }
    if (length === null || radioBuffer.length < length) break;
    const frame = radioBuffer.subarray(0, length);
    radioBuffer = radioBuffer.subarray(length);
    const v2 = frame[0] === 0xfd;
    const signed = v2 && Boolean(frame[2] & 0x01);
    const messageId = v2 ? frame[7] | (frame[8] << 8) | (frame[9] << 16) : frame[5];
    const crcStatus = validateMavlinkFrame(frame, messageId, signed);
    if (crcStatus === "invalid") {
      emitRadioEvent({ type: "invalid_frame", reason: "crc", protocol: v2 ? "mavlink2" : "mavlink1", messageId, bytes: length, transport: radioStatus.transport });
      continue;
    }
    const record = {
      type: "frame",
      protocol: v2 ? "mavlink2" : "mavlink1",
      messageId,
      systemId: frame[v2 ? 5 : 3],
      componentId: frame[v2 ? 6 : 4],
      bytes: length,
      event: messageId === 0 ? "heartbeat" : "telemetry",
      transport: radioStatus.transport,
      crcStatus,
    };
    radioStatus.frames += 1;
    radioStatus.lastFrameAt = new Date().toISOString();
    emitRadioEvent(record);
  }
}

function closeRadio() {
  radioDesired = false;
  if (radioReconnectTimer) clearTimeout(radioReconnectTimer);
  radioReconnectTimer = null;
  radioReconnectAttempt = 0;
  if (radioConnection) {
    radioConnection.close?.();
    radioConnection.destroy?.();
    radioConnection = null;
  }
  radioBuffer = Buffer.alloc(0);
  setRadioStatus({ state: "disconnected", endpoint: null });
}

function scheduleRadioReconnect(error) {
  if (!radioDesired || radioReconnectTimer) return;
  const delay = Math.min(500 * (2 ** radioReconnectAttempt), 5000);
  radioReconnectAttempt += 1;
  setRadioStatus({ state: "reconnecting", lastError: error?.message || String(error || "link lost"), retryInMs: delay });
  radioReconnectTimer = setTimeout(() => {
    radioReconnectTimer = null;
    openRadio(radioConfig).catch(() => {});
  }, delay);
}

async function openRadio(nextConfig = {}) {
  closeRadio();
  radioDesired = true;
  Object.assign(radioConfig, nextConfig, { port: Number(nextConfig.port || radioConfig.port), baud: Number(nextConfig.baud || radioConfig.baud) });
  const { transport, device, port } = radioConfig;
  setRadioStatus({ state: "connecting", transport, endpoint: transport === "serial" ? device : `${device}:${port}`, lastError: null });
  try {
    if (transport === "udp") {
      const socket = createUdpSocket("udp4");
      socket.on("message", ingestRadioBytes);
      socket.on("error", (error) => setRadioStatus({ state: "error", lastError: error.message }));
      await new Promise((resolve, reject) => { socket.once("listening", resolve); socket.once("error", reject); socket.bind(port, device || "0.0.0.0"); });
      radioConnection = socket;
    } else if (transport === "tcp") {
      const socket = connectTcp({ host: device, port });
      socket.on("data", ingestRadioBytes);
      socket.on("error", (error) => scheduleRadioReconnect(error));
      socket.on("close", () => { if (radioConnection === socket) { radioConnection = null; scheduleRadioReconnect(new Error("TCP radio link closed")); } });
      await new Promise((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
      radioConnection = socket;
    } else if (transport === "serial") {
      let SerialPort;
      try { ({ SerialPort } = await import("serialport")); } catch { throw new Error("Serial support requires the serialport package; run npm install"); }
      const socket = new SerialPort({ path: device, baudRate: radioConfig.baud, autoOpen: false });
      socket.on("data", ingestRadioBytes);
      socket.on("error", (error) => scheduleRadioReconnect(error));
      socket.on("close", () => { if (radioConnection === socket) { radioConnection = null; scheduleRadioReconnect(new Error("serial radio link closed")); } });
      await new Promise((resolve, reject) => socket.open((error) => error ? reject(error) : resolve()));
      radioConnection = socket;
    } else {
      throw new Error(`Unsupported radio transport: ${transport}`);
    }
    radioReconnectAttempt = 0;
    setRadioStatus({ state: "connected", endpoint: transport === "serial" ? device : `${device}:${port}`, retryInMs: null });
    return radioStatus;
  } catch (error) {
    if (radioConnection) {
      radioConnection.close?.();
      radioConnection.destroy?.();
      radioConnection = null;
    }
    setRadioStatus({ state: "error", transport, lastError: error.message });
    scheduleRadioReconnect(error);
    throw error;
  }
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; if (body.length > 1e6) reject(new Error("Request too large")); });
    request.on("end", () => { try { resolve(body ? JSON.parse(body) : {}); } catch { reject(new Error("Invalid JSON")); } });
    request.on("error", reject);
  });
}

function json(response, status, value) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-cache" });
  response.end(JSON.stringify(value));
}

const app = createServer(async (request, response) => {
  const requestedPath = decodeURIComponent((request.url || "/").split("?")[0]);

  if (requestedPath === "/api/radio/status" && request.method === "GET") return json(response, 200, { config: radioConfig, status: radioStatus });
  if (requestedPath === "/api/radio/events" && request.method === "GET") {
    response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", Connection: "keep-alive" });
    for (const event of radioEvents.slice(-50)) response.write(`data: ${event}\n\n`);
    radioClients.add(response);
    request.on("close", () => radioClients.delete(response));
    return;
  }
  if (requestedPath === "/api/radio/connect" && request.method === "POST") {
    try { const config = await readJson(request); return json(response, 200, { config: Object.assign(radioConfig, config), status: await openRadio(config) }); }
    catch (error) { return json(response, 400, { error: error.message, status: radioStatus }); }
  }
  if (requestedPath === "/api/radio/disconnect" && request.method === "POST") { closeRadio(); return json(response, 200, { status: radioStatus }); }
  if (requestedPath === "/api/radio/ingest" && request.method === "POST") {
    try { const body = await readJson(request); ingestRadioBytes(Buffer.from(body.data || "", "base64")); return json(response, 202, { status: radioStatus }); }
    catch (error) { return json(response, 400, { error: error.message }); }
  }
  const relativePath = requestedPath === "/" ? "/index.html" : requestedPath;
  const filePath = normalize(join(root, relativePath));

  if (!filePath.startsWith(root)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  try {
    const body = await readFile(filePath);
    response.writeHead(200, {
      "Content-Type": mimeTypes[extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    response.end(body);
  } catch {
    // Keep client-side navigation working when a view is opened directly.
    const body = await readFile(join(root, "index.html"));
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
    response.end(body);
  }
});

app.listen(port, "127.0.0.1", () => {
  console.log(`Q Link web app running at http://localhost:${port}`);
});
