'use strict';
// Non-ASCII names must travel from a PowerShell script to the dashboard unchanged.
const test = require('node:test');
const assert = require('node:assert');
const { startBridge, fakeRunner, task } = require('./lib/harness');

const NAME = 'Caf\u00e9 \u65e5\u672c\u8a9e \u2014 \u00fcber';
const PATH = 'C:\\Users\\Ren\u00e9\\Docs\\r\u00e9sum\u00e9.exe';

test('status: a scheduled task and a process with non-ASCII names come through the API byte for byte, as UTF-8', async () => {
  const ps = fakeRunner({ 'Scheduler.ps1': () => ({ ok: true, data: { tasks: [task({ name: NAME })] } }) });
  const b = await startBridge({ ps });
  try {
    const raw = await new Promise((resolve, reject) => {
      const http = require('http');
      http.get({ host: '127.0.0.1', port: b.port, path: '/api/status?fresh=1', headers: { Host: '127.0.0.1:' + b.port, Authorization: 'Bearer ' + b.app.token } }, (res) => {
        const chunks = []; res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ type: res.headers['content-type'], body: Buffer.concat(chunks).toString('utf8') }));
      }).on('error', reject);
    });
    assert.match(raw.type, /charset=utf-8/i);
    const j = JSON.parse(raw.body);
    assert.ok(j.schedule.tasks.some((t) => t.name === NAME), 'task name is intact');
    assert.ok(!raw.body.includes('\uFFFD'), 'no replacement characters anywhere in the response');
    assert.ok(PATH.length > 0);
  } finally { b.close(); }
});
