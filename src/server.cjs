const { normalizeConfig } = require('./config.cjs');
const { Logger, errorDetails } = require('./log.cjs');
const http = require('node:http');
const crypto = require('node:crypto');
const { WebSocketServer, WebSocket } = require('ws');
const { delta, VolaReader, discover } = require('./reader.cjs');
const { html, script } = require('./control.cjs');
const fs = require('node:fs');
const path = require('node:path');
class Bridge {
  constructor(reader, key, config, logger, saveSelection = () => {}) {
    this.saveSelection = saveSelection; this.controlToken = crypto.randomBytes(32).toString("hex");
    this.reader = reader; this.key = key; this.config = config; this.log = logger;
    this.sessionId = crypto.randomUUID(); this.revision = 0; this.state = null;
    this.health = { ok: false, message: 'Waiting for database', lastReadAt: null };
    this.ws = new WebSocketServer({ noServer: true, maxPayload: 4096, perMessageDeflate: false });
    this.server = http.createServer((req, res) => {
      if (req.url === '/' || req.url === '/control.js' || req.url?.startsWith('/control/')) {
        this.control(req, res).catch(() => { if (!res.headersSent) res.writeHead(500); res.end(); }); return;
      }
      if (!this.authorized(req)) { this.log.write('auth-rejected'); res.writeHead(401); return res.end(); }
      const data = req.url === '/api/v1/snapshot' ? this.snapshot() : req.url === '/api/v1/health' ? { ...this.health, revision: this.revision, clients: this.ws.clients.size } : null;
      res.writeHead(data ? 200 : 404, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data));
    });
    this.server.on('upgrade', (req, socket, head) => {
      if (req.url !== '/api/v1/events' || !this.authorized(req) || req.headers.origin) {
        this.log.write('auth-rejected'); socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
      }
      this.ws.handleUpgrade(req, socket, head, ws => this.ws.emit('connection', ws));
    });
    this.ws.on('connection', ws => {
      ws.alive = true; ws.on('pong', () => { ws.alive = true; }); ws.on('error', () => {});
      this.log.write('connected', { clients: this.ws.clients.size }); this.send(ws, this.snapshot());
      ws.on('message', (raw, binary) => {
        try {
          const data = JSON.parse(raw.toString());
          if (binary || data?.type !== 'state.request') throw new Error();
          this.log.write('resync', { revision: this.revision }); this.send(ws, this.snapshot());
        } catch { ws.close(1008, 'Invalid request'); }
      });
      ws.on('close', () => this.log.write('disconnected', { clients: this.ws.clients.size }));
    });
  }
  async control(req, res) {
    const port = this.server.address()?.port;
    const hosts = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];
    const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
    const host = req.headers.host;
    const json = (code, value) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(value)); };
    if (!local || !hosts.includes(host) || (req.headers.origin && req.headers.origin !== `http://${host}`)) return json(403, { error: 'Control is available only on this computer.' });
    if (req.method === 'GET' && (req.url === '/' || req.url === '/control.js')) {
      res.writeHead(200, { 'Content-Type': req.url === '/' ? 'text/html; charset=utf-8' : 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'" });
      return res.end(req.url === '/' ? html : script);
    }
    if (req.method === 'GET' && req.url === '/control/state') return json(200, {
      token: this.controlToken, event: this.config.event, heats: this.state?.competition.heats || this.config.heats, debug: this.log.debug,
      name: this.state?.competition.name, health: this.health, clients: this.ws.clients.size,
      competitors: Object.keys(this.state?.competitors || {}).length,
      finishers: Object.values(this.state?.results || {}).filter(r => r.status === 'finish').length,
      warnings: this.state?.competition.warnings || [],
      simulation: this.simulationStatus(),
      active: Object.keys(this.state?.active || {}).length, timingMode: this.state?.competition.timingMode || 'off',
    });
    if (req.method === 'GET' && req.url === '/control/settings') {
      const { folder, event, bind, port, pollIntervalMs, reconcileIntervalMs, logDirectory, timing } = this.config;
      return json(200, { folder, event, bind, port, pollIntervalMs, reconcileIntervalMs, logDirectory, timing: timing || { mode: 'off' }, debug: this.log.debug });
    }
    if (req.method === 'POST' && ['/control/key', '/control/folder', '/control/settings'].includes(req.url)) {
      if (req.headers['x-control-token'] !== this.controlToken || !req.headers['content-type']?.startsWith('application/json')) return json(403, { error: 'Invalid control request.' });
      let input = '';
      for await (const chunk of req) { input += chunk; if (Buffer.byteLength(input) > 8192) return json(413, { error: 'Request too large.' }); }
      if (this.applying) return json(409, { error: 'Settings are being applied. Try again shortly.' });
      try {
        const data = JSON.parse(input);
        if (req.url === '/control/key') return json(200, { key: this.key });
        if (req.url === '/control/folder') {
          if (typeof data.folder !== 'string' || !path.isAbsolute(data.folder)) throw Error('Enter an absolute folder path.');
          const events = discover(data.folder);
          if (!events.length) throw Error('No readable VOLA database pairs found in this folder.');
          return json(200, { folder: data.folder, events });
        }
        this.applying = true;
        try { return json(200, await this.applySettings(data)); } finally { this.applying = false; }
      } catch (error) { return json(400, { error: error.publicMessage || (req.url === '/control/folder' ? 'Cannot read VOLA database pairs. Check the absolute folder path and permissions.' : 'Settings were not applied. Check the folder, competition, timing fields, log directory and port. Previous settings remain active.') }); }
    }
    if (req.method === 'GET' && req.url === '/control/events') {
      let events = []; try { events = discover(this.config.folder); } catch {}
      return json(200, { folder: this.config.folder, events });
    }
    if (req.method === 'GET' && req.url === '/control/logs') {
      const file = path.join(this.log.directory, 'diagnostics-download.json.gz');
      this.log.export(file);
      res.writeHead(200, { 'Content-Type': 'application/gzip', 'Content-Disposition': 'attachment; filename="ski-stream-bridge-diagnostics.json.gz"', 'Cache-Control': 'no-store' });
      return res.end(fs.readFileSync(file));
    }
    if (req.method === 'POST' && req.url === '/control/simulation') {
      if (req.headers['x-control-token'] !== this.controlToken || !req.headers['content-type']?.startsWith('application/json') || this.config.timing?.mode !== 'simulation') return json(403, { error: 'Simulation control is unavailable.' });
      let input = '';
      for await (const chunk of req) { input += chunk; if (Buffer.byteLength(input) > 4096) return json(413, { error: 'Request too large.' }); }
      try {
        const { action } = JSON.parse(input);
        if (!['resume','pause','next','reset'].includes(action)) return json(400, { error: 'Unknown simulation command.' });
        const status = this.simulationStatus();
        if (!status?.available) return json(409, { error: 'Start the live replay writer first.' });
        const file = path.join(this.config.folder, 'simulation-command.json');
        fs.writeFileSync(file + '.tmp', JSON.stringify({ id: crypto.randomUUID(), action }), { mode: 0o600 });
        fs.renameSync(file + '.tmp', file);
        return json(200, { ok: true });
      } catch { return json(400, { error: 'Could not send simulation command.' }); }
    }
    if (req.method === 'POST' && req.url === '/control/select') {
      if (this.applying) return json(409, { error: 'Settings are being applied.' });
      if (req.headers['x-control-token'] !== this.controlToken || !req.headers['content-type']?.startsWith('application/json')) return json(403, { error: 'Invalid control request.' });
      let input = '';
      for await (const chunk of req) { input += chunk; if (Buffer.byteLength(input) > 4096) return json(413, { error: 'Request too large.' }); }
      let candidate;
      try {
        const selection = JSON.parse(input);
        if (selection.autoStandings === true && selection.heats === undefined) selection.heats = [1];
        if (!Number.isInteger(selection.event) || selection.event < 1 || !Array.isArray(selection.heats) || !selection.heats.length || selection.heats.length > 9 || selection.heats.some(h => !Number.isInteger(h) || h < 1 || h > 9) || typeof selection.debug !== 'boolean') throw Error('Invalid selection');
        const next = { ...this.config, autoStandings: selection.autoStandings === true || this.config.autoStandings !== false, event: selection.event, heats: [...new Set(selection.heats)].sort(), debug: selection.debug };
        if (selection.simulationHeat !== undefined) {
          if (this.config.timing?.mode !== 'simulation' || next.event !== this.config.event || !Number.isInteger(selection.simulationHeat) || selection.simulationHeat !== Math.max(...next.heats)) throw Error('Invalid simulation heat');
          next.timing = { ...next.timing, heat: selection.simulationHeat };
        }
        if (next.timing?.mode !== 'off' && (next.event !== this.config.event || !next.heats.includes(next.timing?.heat) || next.timing?.heat !== Math.max(...next.heats))) next.timing = { mode: 'off' };
        candidate = new VolaReader(next);
        const state = candidate.read(); // Validate the complete new source before changing anything.
        this.saveSelection({ event: next.event, heats: next.heats, debug: next.debug, timing: next.timing, autoStandings: next.autoStandings });
        const previous = this.reader; this.reader = candidate; candidate = null; previous.close();
        this.config = next; this.log.debug = next.debug; this.state = state;
        this.sessionId = crypto.randomUUID(); this.revision = 1;
        this.health = { ok: true, message: 'Database readable', lastReadAt: Date.now() };
        this.broadcast(this.snapshot());
        this.log.write('snapshot', { eventNumber: next.event, heatCount: next.heats.length, revision: 1, competitors: Object.keys(state.competitors).length, results: Object.keys(state.results).length });
        return json(200, { ok: true });
      } catch (error) { candidate?.close(); return json(400, { error: 'Cannot select that competition or save its settings. Check the available heats and config file permissions.' }); }
    }
    return json(404, { error: 'Control route not found.' });
  }
  async applySettings(data) {
    const keys = ['folder', 'event', 'bind', 'port', 'pollIntervalMs', 'reconcileIntervalMs', 'logDirectory', 'debug', 'timing'];
    if (!data || typeof data !== 'object' || keys.some(k => !Object.hasOwn(data, k)) || !['127.0.0.1', '0.0.0.0'].includes(data.bind) || !path.isAbsolute(data.folder) || !path.isAbsolute(data.logDirectory)) throw Error('Invalid settings');
    const values = Object.fromEntries(keys.map(k => [k, data[k]]));
    const timing = values.timing;
    const next = normalizeConfig({ ...this.config, ...values, autoStandings: true, heats: timing?.mode !== 'off' ? [timing?.heat] : [1] }, path.join(this.config.folder, 'unused.json'));
    let reader, replacement, oldClosed = false;
    const old = this.server, oldAddress = old.address(), networkChanged = next.bind !== this.config.bind || next.port !== oldAddress.port;
    const listen = (server, port, bind) => new Promise((resolve, reject) => {
      const fail = error => { server.off('listening', done); reject(error); };
      const done = () => { server.off('error', fail); resolve(); };
      server.once('error', fail); server.once('listening', done); server.listen(port, bind);
    });
    try {
      reader = new VolaReader(next); const state = reader.read();
      const logger = new Logger(next.logDirectory, next.debug);
      fs.accessSync(next.logDirectory, fs.constants.W_OK);
      if (networkChanged) {
        replacement = http.createServer();
        for (const event of ['request', 'upgrade']) for (const listener of old.listeners(event)) replacement.on(event, listener);
        // Same-port address changes release the old listener first; existing HTTP requests can finish.
        if (next.port === oldAddress.port) { old.close(); oldClosed = true; }
        await listen(replacement, next.port, next.bind);
      }
      this.saveSelection({ ...values, timing: next.timing, autoStandings: true, heats: next.heats });
      const previous = this.reader;
      this.reader = reader; reader = null; this.config = next; this.log = logger; this.state = state;
      this.sessionId = crypto.randomUUID(); this.revision = 1;
      this.health = { ok: true, message: 'Database readable', lastReadAt: Date.now() };
      clearInterval(this.timer); this.timer = setInterval(() => this.poll(), next.pollIntervalMs);
      previous.close();
      if (replacement) { this.server = replacement; if (!oldClosed) old.close(); for (const ws of this.ws.clients) ws.close(1012, 'Connection settings changed'); }
      else this.broadcast(this.snapshot());
      return { ok: true, networkChanged, controlUrl: `http://127.0.0.1:${next.port}/`, port: next.port };
    } catch (error) {
      reader?.close(); if (replacement?.listening) replacement.close();
      if (oldClosed) await listen(old, oldAddress.port, this.config.bind);
      throw error;
    }
  }
  simulationStatus() {
    if (this.config.timing?.mode !== 'simulation') return null;
    try {
      const s = JSON.parse(fs.readFileSync(path.join(this.config.folder, 'simulation-status.json'), 'utf8'));
      return { available: Date.now() - s.updatedAt < 5000, running: Boolean(s.running), heat: Number(s.heat), phase: s.phase, started: Number(s.started), total: Number(s.total), onCourse: Number(s.onCourse) };
    } catch { return { available: false }; }
  }
  authorized(req) {
    const actual = Buffer.from(req.headers.authorization || ''), expected = Buffer.from('Bearer ' + this.key);
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  }
  envelope(type, extra = {}) { return { apiVersion: 1, type, sessionId: this.sessionId, revision: this.revision, serverNow: Date.now(), ...extra }; }
  snapshot() { return this.envelope('state.snapshot', { state: this.state, health: this.health }); }
  send(ws, frame) {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > 4 * 1024 * 1024) { this.log.write('slow-client'); ws.terminate(); return; }
    ws.send(JSON.stringify(frame), error => { if (error) ws.terminate(); });
  }
  broadcast(frame) { for (const ws of this.ws.clients) this.send(ws, frame); }
  poll() {
    const before = performance.now(), tables = this.reader.tablesRead;
    try {
      const state = this.reader.read(), recovered = !this.health.ok;
      this.health = { ok: true, message: 'Database readable', lastReadAt: Date.now() };
      if (!this.state) { this.state = state; this.revision++; this.broadcast(this.snapshot()); this.log.write('snapshot', { revision: this.revision, competitors: Object.keys(state.competitors).length, results: Object.keys(state.results).length }); }
      else {
        const changes = delta(this.state, state);
        if (Object.keys(changes).length) {
          const baseRevision = this.revision; this.state = state; this.revision++;
          const frame = this.envelope('state.delta', { baseRevision, changes, health: this.health }); this.broadcast(frame);
          this.log.write('delta', { revision: this.revision, bytes: Buffer.byteLength(JSON.stringify(frame)), upserts: (changes.competitors?.upsert.length || 0) + (changes.results?.upsert.length || 0), deletes: (changes.competitors?.delete.length || 0) + (changes.results?.delete.length || 0) });
        } else if (recovered) this.broadcast(this.envelope('health', { health: this.health }));
      }
      if (recovered) this.log.write('recovered');
      this.log.write('read', { durationMs: Math.round((performance.now() - before) * 100) / 100, tablesRead: this.reader.tablesRead - tables, ok: true }, true);
    } catch (error) {
      if (this.health.ok || !this.failedOnce) this.log.write('read-failed', { ok: false, ...errorDetails(error) });
      this.failedOnce = true;
      this.health = { ...this.health, ok: false, message: 'Database unavailable or unsupported; retrying. Last results retained.' };
      this.broadcast(this.envelope('health', { health: this.health }));
    }
  }
  async start() {
    await new Promise((resolve, reject) => { this.server.once('error', reject); this.server.listen(this.config.port, this.config.bind, resolve); });
    this.poll(); this.timer = setInterval(() => this.poll(), this.config.pollIntervalMs);
    this.heartbeat = setInterval(() => { for (const ws of this.ws.clients) { if (!ws.alive) { ws.terminate(); continue; } ws.alive = false; ws.ping(); this.send(ws, this.envelope('health', { health: this.health })); } }, 2000);
    this.log.write('started', { port: this.server.address().port, eventNumber: this.config.event, heatCount: this.config.heats.length, nodeVersion: process.version, platform: process.platform, arch: process.arch });
  }
  async close() {
    clearInterval(this.timer); clearInterval(this.heartbeat);
    for (const ws of this.ws.clients) ws.terminate();
    await new Promise(resolve => this.ws.close(resolve));
    await new Promise(resolve => this.server.close(resolve));
    this.reader.close(); this.log.write('stopped');
  }
}
module.exports = { Bridge };
