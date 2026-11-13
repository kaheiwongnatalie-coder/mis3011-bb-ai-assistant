import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';
import { atLocal, localDate, nextDate } from '../core/time.mjs';
import { assignmentText, fakeProvider, item, operation } from './ai-fixtures.mjs';

test('student workspace excludes historical routes, persists tasks and keeps the real clock through AI use', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'bb-student-'));
  const stateFile = join(temp, 'student.json'), inboxRoot = join(temp, 'inbox');
  const start = async (aiProvider) => {
    const server = await createApp({ studentWorkspace: true, stateFile, inboxRoot, aiProvider });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    return { server, async call(path, data) {
      const response = await fetch(base + path, data === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
      return { status: response.status, body: await response.json() };
    } };
  };
  let app;
  try {
    const later = nextDate(localDate(new Date().toISOString()), 3), meetingDay = nextDate(later, -1);
    const text = assignmentText.replace('November 14, 2026 at 3 PM', `${later} at 3 PM`);
    const provider = fakeProvider([
      { summary: '新增作业', items: [item({ deadlineAt: atLocal(later, '15:00'), deadlineDate: later, evidence: [{ documentId: 'source-omega', quote: text, fields: ['deadlineAt', 'deadlineDate', 'requirements', 'policy'] }] })], questions: [] },
      { intent: 'apply', summary: '小组会', operations: [operation({ start: atLocal(meetingDay, '19:00'), end: atLocal(meetingDay, '20:00') })], questions: [] },
      { reply: '这是原公告中的考试安排。' },
      { reply: '按明晚 18:00 到午夜避开。', operations: [
        operation({ start: atLocal(nextDate(later, -2), '18:00'), end: atLocal(meetingDay, '00:00') })
      ], questions: [] }
    ]);
    app = await start(provider);
    const { body: initial } = await app.call('/api/state');
    assert.equal(initial.studentWorkspace, true);
    assert.equal(initial.mode, 'live');
    assert.deepEqual(initial.tasks, []);
    assert.equal(initial.scenarios, undefined);
    const { body: documents } = await app.call('/api/ai/documents');
    assert.ok(documents.length > 400);
    assert.ok(documents.every(d => !d.text && d.type !== 'grade'));
    const exam = documents.find(d => d.courseCode === 'CSC1001' && d.title === 'Important Update of Midterm Date and Time');
    const { body: original } = await app.call(`/api/ai/document?id=${encodeURIComponent(exam.id)}`);
    assert.ok(original.text);
    for (const [path, body] of [['/api/import', { scenario: 'submission' }], ['/api/demo/event', {}], ['/api/ai/session', { now: '2024-10-23T10:00:00+08:00' }]]) {
      assert.equal((await app.call(path, body)).status, 404);
    }
    const { body: added, status } = await app.call('/api/tasks', { courseCode: 'MIS3011', title: 'My report', deadline: atLocal(later, '21:00'), remainingMinutes: 60 });
    assert.equal(status, 200);
    const id = added.tasks[0].id;
    assert.ok(added.plan.blocks.some(b => b.taskId === id));
    assert.ok(added.notifications.some(n => n.taskId === id && n.status === 'pending'));
    const { body: analyzed } = await app.call('/api/ai/analyze', { documents: [{ id: 'source-omega', courseCode: 'OMEGA', term: later.slice(0, 4), title: 'Omega', text }] });
    assert.equal(analyzed.mode, 'live');
    assert.ok(analyzed.tasks.some(t => t.title === 'Assignment Omega'));
    assert.ok(analyzed.tasks.some(t => t.id === id));
    const { body: preview } = await app.call('/api/ai/command', { instruction: '明晚有小组会，帮我调整日程', apply: false });
    assert.equal(preview.profile.busy.length, 0);
    const { body: applied } = await app.call('/api/ai/apply-preview', { runId: preview.aiResult.runId });
    assert.equal(applied.profile.busy.length, 1);
    const { body: answer } = await app.call('/api/ai/chat', { documentId: exam.id, messages: [{ role: 'user', content: '考试什么时候？' }] });
    assert.equal(answer.reply, '这是原公告中的考试安排。');
    const chatInput = JSON.parse(provider.calls.at(-1).at(-1).content.split('\n').at(-1));
    assert.equal(chatInput.context.source.text, original.text);
    assert.deepEqual((await app.call('/api/state')).body.tasks, applied.tasks);
    const { body: chatPlan } = await app.call('/api/ai/chat', { messages: [{ role: 'user', content: '明晚没空，帮我排一下' }] });
    assert.ok(chatPlan.proposal.runId);
    assert.deepEqual((await app.call('/api/state')).body.profile.busy, applied.profile.busy);
    const { body: chatApplied } = await app.call('/api/ai/apply-preview', { runId: chatPlan.proposal.runId });
    assert.equal(chatApplied.profile.busy.length, 2);
    assert.deepEqual(chatApplied.tasks.map(t => t.deadline), applied.tasks.map(t => t.deadline));
    const blocked = chatApplied.profile.busy.at(-1);
    assert.ok(chatApplied.plan.blocks.every(block =>
      Date.parse(block.end) <= Date.parse(blocked.start) || Date.parse(block.start) >= Date.parse(blocked.end)
    ));
    const { body: completed } = await app.call('/api/events', { id: 'student-complete', type: 'STATUS_RECORDED', taskId: id, value: 'user_confirmed', origin: 'user' });
    assert.ok(!completed.plan.blocks.some(b => b.taskId === id));
    assert.ok(!completed.notifications.some(n => n.taskId === id && n.status === 'pending'));
    const { body: dateChanged } = await app.call('/api/workspace/date', { date: '2024-10-23' });
    assert.equal(dateChanged.now, atLocal('2024-10-23', '12:00'));
    assert.deepEqual(dateChanged.tasks, completed.tasks);
    assert.equal((await app.call('/api/workspace/date', { date: '2024-02-30' })).status, 400);
    const { body: historical } = await app.call('/api/tasks', { courseCode: 'CSC1001', title: 'Historical report', deadline: atLocal('2024-10-26', '21:00'), remainingMinutes: 60 });
    const historicalTask = historical.tasks.find(task => task.title === 'Historical report');
    assert.equal(historicalTask.term, '2024');
    assert.ok(historical.plan.blocks.some(block => block.taskId === historicalTask.id &&
      block.start >= new Date(historical.now).toISOString() && localDate(block.end) <= '2024-10-26'));
    app.server.close();
    await once(app.server, 'close');
    app = await start();
    const { body: restored } = await app.call('/api/state');
    assert.equal(restored.now, atLocal('2024-10-23', '12:00'));
    assert.equal(restored.tasks.find(t => t.id === id).status.value, 'user_confirmed');
    assert.equal(restored.aiConnection.configured, false);
    const { body: synced } = await app.call('/api/automation/config', {
      subscriptions: [{courseCode:'CSC1001',term:'2024'}], includeExisting:true
    });
    const assignment = synced.tasks.find(t => t.title === 'Assignment 2' && t.courseCode === 'CSC1001');
    assert.equal(assignment.deadline.at, '2024-11-24T23:59:00+08:00');
    assert.ok(assignment.sources.some(source => source.role === 'course_page' && source.quote.includes('24 November')));
    const { body: today } = await app.call('/api/workspace/date', { date: null });
    assert.equal(localDate(today.now), localDate(new Date().toISOString()));
    await writeFile(join(temp, 'old.json'), JSON.stringify({ mode: 'replay' }));
    await assert.rejects(createApp({ studentWorkspace: true, stateFile: join(temp, 'old.json'), inboxRoot }), /不能读取历史演示状态/);
  } finally {
    if (app?.server.listening) {
      app.server.close();
      await once(app.server, 'close');
    }
    await rm(temp, { recursive: true, force: true });
  }
});
