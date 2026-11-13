import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server.mjs';
import { createReplayClient, loadReplayData } from './feed-replay.mjs';

// Run with `node scripts/mock-bb-demo.mjs --serve` to keep the replay open.
const serve = process.argv.includes('--serve');
const requestedPort = Number(process.env.PORT || 4175);
const data = await loadReplayData();
const saved = JSON.parse(await readFile(new URL('../examples/automation-live-output.json', import.meta.url), 'utf8'));
const runsByDocument = new Map(saved.modelRuns.map(run => [run.documents[0].id, run]));
const seen = [];
const replayInfo = { configured: true, consent: true, keyStored: false, replayOnly: true, model: '已保存的模型响应（离线回放）' };
const provider = {
  info: () => replayInfo,
  configure() { throw new Error('这是独立的离线演示，请到正式服务配置模型。'); },
  async complete(messages, _schema, purpose) {
    if (purpose !== 'course_analysis') throw new Error('离线演示只回放历史公告处理。');
    const { documents } = JSON.parse(messages.at(-1).content);
    assert.equal(documents.length, 1);
    const [document] = documents;
    const savedRun = runsByDocument.get(document.id);
    assert.ok(savedRun, `找不到该公告保存的模型响应：${document.title}`);
    assert.deepEqual(documents, savedRun.documents, '公告 ID、正文、日期和来源必须与保存的响应对应');
    seen.push(document.id);
    return { value: savedRun.rawOutput, meta: { model: replayInfo.model, transport: 'recorded_replay', elapsedMs: 0 } };
  }
};

const localDir = new URL('../.local/', import.meta.url);
await mkdir(localDir, { recursive: true });
const inboxRoot = await mkdtemp(fileURLToPath(new URL('mock-bb-', localDir)));
const intervalMs = 800;
const server = await createApp({ aiProvider: provider, stateFile: null, inboxRoot, automationIntervalMs: intervalMs });
const listening = once(server, 'listening');
server.listen(serve ? requestedPort : 0, '127.0.0.1');
await listening;
const base = `http://127.0.0.1:${server.address().port}`;
const client = createReplayClient(base);
let passed = false;

try {
  const baseline = await client.begin(data);
  assert.equal(baseline.tasks.length, 0);
  assert.equal(baseline.automation.pending.length, 0);
  const initial = await client.release(data.initial);
  const exam = initial.tasks.find(task => task.kind === 'exam');
  assert.equal(exam?.fixed?.start, '2024-11-01T19:00:00+08:00');
  assert.ok(initial.plan.blocks.some(block => block.taskId === exam.id));
  const oldNotices = initial.notifications.filter(notice => notice.taskId === exam.id && notice.status === 'pending');
  assert.ok(oldNotices.length);
  console.log('通过：原始 CSC1001 公告自动生成考试、准备时段和待发提醒。');

  const revised = await client.release(data.update);
  const exams = revised.tasks.filter(task => task.kind === 'exam');
  assert.equal(exams.length, 1);
  assert.equal(exams[0].id, exam.id);
  assert.equal(exams[0].fixed.start, '2024-11-10T19:00:00+08:00');
  for (const old of oldNotices) {
    assert.equal(revised.notifications.find(notice => notice.id === old.id)?.status, 'cancelled');
  }
  console.log('通过：改期更新同一场考试，旧提醒已撤销。');

  const final = await client.includeEconometrics(data);
  const assignment = final.tasks.find(task => task.courseCode === 'ECO3121' && task.sources.some(source => source.documentId === data.assignment.id));
  assert.equal(assignment?.deadline?.at, '2024-11-02T15:00:00+08:00');
  assert.ok(final.plan.blocks.some(block => block.taskId === assignment.id));
  assert.ok(final.notifications.some(notice => notice.taskId === assignment.id && notice.status === 'pending'));
  assert.deepEqual(seen, saved.modelRuns.map(run => run.documents[0].id));
  assert.ok(final.aiRuns.every(run => run.trigger === 'source_update' && run.transport === 'recorded_replay'));
  const nextScanDeadline = Date.now() + 5000;
  let rescanned = final;
  while (rescanned.automation.lastScanAt === final.automation.lastScanAt && Date.now() < nextScanDeadline) {
    await new Promise(resolve => setTimeout(resolve, intervalMs));
    rescanned = await client.call('/api/state');
  }
  assert.notEqual(rescanned.automation.lastScanAt, final.automation.lastScanAt);
  assert.equal(seen.length, saved.modelRuns.length);
  console.log('通过：ECO3121 作业、排程和提醒已生成，重扫相同公告没有重复处理。');
  console.log(`共处理 ${seen.length} 条原始公告，生成 ${final.tasks.length} 项任务。模型响应来自仓库中的历史记录。`);
  if (serve) console.log(`打开 ${base}/#tasks 查看演示，按 Ctrl+C 停止。`);
  passed = true;
} finally {
  if (!serve || !passed) {
    const closed = once(server, 'close');
    server.close();
    await closed;
  }
}
