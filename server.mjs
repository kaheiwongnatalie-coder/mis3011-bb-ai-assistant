import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadFeed } from './core/load-feed.mjs';
import { normalizeFeed } from './demo/feed-adapter.mjs';
import { applyEvent, createState, reconcile, summarize, validateProfile } from './core/engine.mjs';
import { loadScenario, scenarioEvents, scenarios } from './demo/scenarios.mjs';
import { atLocal, validTime, localDate, ms, nextDate } from './core/time.mjs';
import { createProvider } from './ai/provider.mjs';
import { buildDocuments, documentSummary, documentsFromUpload, prepareDocument, hash } from './ai/documents.mjs';
import { createAIService } from './ai/service.mjs';
import { createAutomation, createDocumentSource, emptyAutomation } from './ai/automation.mjs';
import { syncCourseDeadlines } from './ai/course-deadlines.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8' };

export async function createApp({ studentWorkspace = false, feedRoot = join(ROOT, 'BB_Source_Feed'), stateFile = join(ROOT, studentWorkspace ? '.local/student-state.json' : '.local/state.json'), inboxRoot = join(ROOT, studentWorkspace ? '.local/student-course-inbox' : '.local/course-inbox'), automationIntervalMs = 5000, aiProvider = createProvider() } = {}) {
  let feed = studentWorkspace ? null : await loadFeed(feedRoot);
  const capturedAt = new Date().toISOString();
  let sourceDocuments = feed ? buildDocuments(feed) : [];
  const ai = createAIService(aiProvider);
  const newState = (profile) => {
    const initial = createState({ mode: studentWorkspace ? 'live' : 'empty', profile });
    if (studentWorkspace) {
      initial.planningEnabled = true;
      initial.sync = { state: 'local', checkedAt: initial.now, message: '使用你添加的任务和导入的课程资料。' };
    }
    return initial;
  };
  let state = newState(), chain = Promise.resolve();
  let autoRunning = false, autoQueued = false;
  const readDocuments = createDocumentSource(feedRoot, inboxRoot);
  async function refreshDocuments() {
    const result = await readDocuments();
    if (result.feed) feed = result.feed;
    sourceDocuments = result.documents;
    return result;
  }
  const automation = createAutomation({
    ai, provider: aiProvider, readDocuments: refreshDocuments,
    canSync: studentWorkspace ? (document, current) => {
      const received = document.sourcePath.startsWith('course-inbox/');
      if (!received && (document.type !== 'announcement' || !document.publishedAt)) return false;
      const cutoff = current.workspaceDate ? ms(atLocal(nextDate(current.workspaceDate), '00:00')) : Date.now() + 1;
      return !document.publishedAt || ms(document.publishedAt) < cutoff;
    } : undefined
  });
  function documentById(id) {
    const document = sourceDocuments.find(item => item.id === id);
    if (!document) throw Object.assign(new Error('找不到这份课程资料。'), { code: 'ENOENT' });
    return document;
  }
  if (stateFile) {
    try { state = JSON.parse(await readFile(stateFile, 'utf8')); }
    catch (e) { if (e.code !== 'ENOENT') throw new Error(`本地状态无法读取，原文件未覆盖：${e.message}`); }
  }
  if (studentWorkspace) {
    if (state.mode !== 'live' || state.scenario) throw new Error('学生工作区不能读取历史演示状态；请使用独立的学生状态文件。');
    state = reconcile({ ...state, now: workspaceNow(state) });
    if (state.automation?.enabled) {
      await refreshDocuments();
      await save(syncCourseDeadlines(state, sourceDocuments));
    }
  }
  function workspaceNow(current) {
    return current.workspaceDate ? atLocal(current.workspaceDate, '12:00') : new Date().toISOString();
  }
  async function save(next) {
    if (stateFile) {
      await mkdir(dirname(stateFile), { recursive: true });
      await writeFile(`${stateFile}.tmp`, JSON.stringify(next, null, 2));
      await rename(`${stateFile}.tmp`, stateFile);
    }
    state = next;
  }
  const json = (res, status, value) => {
    res.writeHead(status, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(value));
  };
  async function bodyOf(req) {
    let text = '';
    for await (const chunk of req) {
      text += chunk;
      if (text.length > 8_000_000) throw new Error('导入 JSON 超过 8 MB，请拆分任务。');
    }
    return text ? JSON.parse(text) : {};
  }
  function view(extra = {}) { return { ...state, summary: summarize(state), ...(studentWorkspace ? { studentWorkspace: true } : { scenarios }), aiConnection: aiProvider.info(), automationRuntime: { running: autoRunning, inboxRoot, intervalMs: automationIntervalMs }, ...extra }; }
  function notAvailable() { throw Object.assign(new Error('学生工作区不提供此操作。'), { code: 'ENOENT' }); }
  async function mutate(path, body) {
    let next = state;
    let extra = {};
    if (studentWorkspace && (['/api/import', '/api/demo/event', '/api/ai/session', '/api/reset'].includes(path)
      || (path === '/api/tasks/import' && body.now) || (path === '/api/automation/config' && body.replaySources))) notAvailable();
    if (path === '/api/ai/config') return view({ aiConnection: aiProvider.configure(body) });
    if (path === '/api/ai/test') return view({ connectionTest: await ai.ping() });
    if (path === '/api/ai/chat' && studentWorkspace) {
      if (body.documentId) await refreshDocuments();
      return ai.chat(body.messages, state, body.documentId ? documentById(body.documentId) : null);
    }
    if (path === '/api/workspace/date' && studentWorkspace) {
      const date = body.date;
      if (date !== null && (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
          !validTime(atLocal(date, '12:00')) || localDate(atLocal(date, '12:00')) !== date)) {
        throw new Error('请选择有效日期。');
      }
      if ((state.workspaceDate ?? null) === date) return view();
      next = structuredClone(state);
      next.workspaceDate = date;
      next.now = workspaceNow(next);
      next.plan.blocks = next.plan.blocks.filter(block => ms(block.end) > ms(next.now));
      for (const notice of next.notifications) {
        if (notice.type === 'change') continue;
        if (notice.status === 'pending' || (notice.status === 'delivered' && ms(notice.deliveredAt) > ms(next.now))) {
          notice.status = 'cancelled';
        }
      }
      next = reconcile(next);
    } else if (path === '/api/feed/documents') {
      const documents = documentsFromUpload(body);
      if (!documents.length) throw new Error('请提供课程资料。');
      await mkdir(inboxRoot, { recursive: true });
      for (const document of documents) {
        const file = join(inboxRoot, `${hash([document.courseCode, document.term, document.id])}.json`);
        await writeFile(`${file}.tmp`, JSON.stringify(document, null, 2));
        await rename(`${file}.tmp`, file);
      }
      extra = { received: documents.length };
    } else if (path === '/api/tasks' && studentWorkspace) {
      const title = typeof body.title === 'string' ? body.title.trim() : '';
      const courseCode = typeof body.courseCode === 'string' ? body.courseCode.trim() : '';
      if (!title || title.length > 150 || !courseCode || courseCode.length > 40) throw new Error('请填写课程名称和任务标题。');
      if (!validTime(body.deadline) || ms(body.deadline) <= ms(state.now)) throw new Error('截止时间必须晚于现在。');
      if (!Number.isInteger(body.remainingMinutes) || body.remainingMinutes < 1 || body.remainingMinutes > 10000) throw new Error('请填写 1 至 10000 分钟的预计用时。');
      const id = randomUUID();
      next = applyEvent(state, { id: `add:${id}`, type: 'TASK_ADDED', task: {
        id: `manual:${id}`, courseCode, term: localDate(state.now).slice(0, 4), title, channel: 'external',
        remainingMinutes: body.remainingMinutes, estimateOrigin: 'user',
        deadline: { at: body.deadline, date: localDate(body.deadline), precision: 'minute', origin: 'user_confirmed' }
      } });
    } else if (path === '/api/automation/config') {
      next = await automation.configure(state, body);
      if (studentWorkspace) next = syncCourseDeadlines(next, sourceDocuments);
    }
    else if (path === '/api/automation/retry') next = automation.retry(state);
    else if (path === '/api/ai/session') {
      if (body.now && !validTime(body.now)) throw new Error('AI 工作区回放时钟无效。');
      if (stateFile) { await mkdir(dirname(stateFile), { recursive: true }); await writeFile(join(dirname(stateFile), 'state.before-ai-session.json'), JSON.stringify(state, null, 2)); }
      next = createState({ now: body.now || new Date().toISOString(), mode: body.now ? 'replay' : 'live', profile: state.profile });
      next.workspace = 'ai';
    } else if (path === '/api/ai/analyze') {
      if (state.mode === 'snapshot') throw new Error('请先新建 AI 工作区；完整历史成绩快照不作为时点推理输入。');
      if (studentWorkspace && body.documentIds?.length) await refreshDocuments();
      const selected = (body.documentIds || []).map(documentById);
      const uploaded = body.upload ? documentsFromUpload(body.upload) : [];
      const pasted = (body.documents || []).map(prepareDocument);
      const documents = [...selected, ...uploaded, ...pasted];
      let inputState = state;
      const latest = documents.map(d => d.publishedAt).filter(validTime).sort((a, b) => ms(b) - ms(a))[0];
      if (state.mode === 'replay' && latest && ms(latest) > ms(state.now)) {
        if (!body.advanceClock) throw new Error('选中公告晚于回放时钟，请推进时钟或选择按公告时间推进。');
        inputState = applyEvent(state, { id: `source-time:${latest}`, type: 'CLOCK_ADVANCED', to: latest });
      }
      const result = await ai.analyze(documents, inputState, { force: body.force === true });
      next = result.state;
      if (next.mode === 'empty') { next = structuredClone(next); next.mode = 'live'; next.workspace = 'ai'; }
      extra = { aiResult: { ...result, state: undefined } };
    } else if (path === '/api/ai/command') {
      if (state.mode === 'snapshot') throw new Error('请在 AI 工作区内调整计划。');
      const result = await ai.command(body.instruction, state, { apply: body.apply === 'auto' ? 'auto' : body.apply === true });
      next = result.state || state;
      extra = { aiResult: { ...result, state: undefined } };
    } else if (path === '/api/ai/apply-preview') {
      next = ai.applyPreview(body.runId, state);
    } else if (path === '/api/import') {
      if (body.mode === 'snapshot') {
        const snapshot = normalizeFeed(feed, capturedAt);
        next = createState({ now: capturedAt, mode: 'snapshot', tasks: snapshot.tasks, imported: { ...feed.stats, capturedAt } });
      } else next = loadScenario(feed, body.scenario || 'submission', capturedAt);
    } else if (path === '/api/tasks/import') {
      if (!Array.isArray(body.tasks) || !body.tasks.length) throw new Error('请提供非空 tasks 数组。');
      const now = studentWorkspace ? workspaceNow(state) : body.now || new Date().toISOString();
      if (!validTime(now)) throw new Error('导入时钟无效。');
      next = studentWorkspace ? { ...state, now } : createState({ now, mode: body.now ? 'replay' : 'live', imported: { courses: new Set(body.tasks.map(t => t.courseCode)).size, normalized: true, capturedAt } });
      if (body.profile) { next.profile = { ...next.profile, ...body.profile }; validateProfile(next.profile); }
      next = applyEvent(next, { id: body.id || 'normalized-import', type: 'TASKS_UPSERTED', tasks: body.tasks });
    } else if (path === '/api/events') {
      const events = Array.isArray(body.events) ? body.events : [body];
      for (const event of events) next = applyEvent(next, event);
    } else if (path === '/api/demo/event') {
      if (!state.scenario) throw new Error('请先载入演示场景。');
      for (const event of scenarioEvents(feed, state)) {
        if (event.type === 'CLOCK_ADVANCED' && ms(event.to) <= ms(next.now)) continue;
        next = applyEvent(next, event);
      }
    } else if (path === '/api/reset') next = createState();
    else throw new Error('未知操作。');
    // Regression scenarios, reset and replacement imports are separate workspaces.
    if (!studentWorkspace && ['/api/import', '/api/reset', '/api/ai/session', '/api/tasks/import'].includes(path) && state.automation) {
      next.automation = emptyAutomation();
    }
    await save(next);
    return view(extra);
  }
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/api/state') return json(res, 200, view());
      if (req.method === 'GET' && url.pathname === '/api/ai/documents') {
        if (studentWorkspace) await refreshDocuments();
        return json(res, 200, sourceDocuments.map(documentSummary));
      }
      if (req.method === 'GET' && url.pathname === '/api/ai/document') {
        if (studentWorkspace) await refreshDocuments();
        return json(res, 200, documentById(url.searchParams.get('id')));
      }
      if (req.method === 'GET' && url.pathname === '/api/catalog') {
        if (studentWorkspace) notAvailable();
        return json(res, 200, { stats: feed.stats, candidates: normalizeFeed(feed, capturedAt).tasks.length, courses: feed.courses.map(c => ({ code: c.code, title: c.title })), limitations: ['历史脱敏离线快照，不是学校认证接口。', '此处候选属于旧规则提取；实际模型解析请使用 AI 课程助理，需配置个人凭据。', '个人分数和提交时刻经模拟，不能据此推断学习习惯。'] });
      }
      if (req.method === 'GET' && url.pathname === '/api/export') {
        res.setHeader('Content-Disposition', 'attachment; filename="bb-assistant-state.json"');
        return json(res, 200, view());
      }
      if (req.method === 'POST') {
        if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) return json(res, 403, { error: '本地写操作仅接受本机同源页面。' });
        const body = await bodyOf(req);
        const operation = chain.then(() => mutate(url.pathname, body));
        chain = operation.catch(() => {});
        return json(res, 200, await operation);
      }
      let file;
      if (url.pathname === '/api/source') {
        if (studentWorkspace) notAvailable();
        const relative = url.searchParams.get('path') || '';
        file = resolve(feedRoot, relative);
        if (!file.startsWith(`${resolve(feedRoot)}${sep}`) || !['.json', '.pdf', '.txt'].includes(extname(file))) return json(res, 404, { error: '没有可用的本地来源。' });
      } else if (url.pathname.startsWith('/core/')) {
        file = resolve(ROOT, `.${url.pathname}`);
        if (!file.startsWith(`${join(ROOT, 'core')}${sep}`)) return json(res, 404, { error: 'Not found' });
      } else {
        const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
        if (!['index.html', 'app.mjs', 'ai-panel.mjs', 'style.css'].includes(name)) return json(res, 404, { error: 'Not found' });
        file = join(ROOT, 'web', name);
      }
      const content = await readFile(file);
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(content);
    } catch (e) {
      json(res, e.code === 'ENOENT' ? 404 : 400, { error: e.message });
    }
  });
  // A chosen workspace date stays fixed until the student changes it.
  const timer = setInterval(() => {
    if (state.mode !== 'live' || state.workspaceDate) return;
    chain = chain.then(() => {
      if (state.mode !== 'live' || state.workspaceDate) return;
      const next = structuredClone(state);
      next.now = workspaceNow(state);
      return save(reconcile(next));
    }).catch(e => console.error('Local tick failed:', e.message));
  }, 30_000);
  timer.unref();
  const autoTimer = setInterval(() => {
    if (!state.automation?.enabled || autoQueued) return;
    autoQueued = true;
    const operation = chain.then(async () => {
      if (!state.automation?.enabled) return;
      const scanned = await automation.scan(state);
      await save(studentWorkspace ? syncCourseDeadlines(scanned, sourceDocuments) : scanned);
      autoRunning = true;
      await save(await automation.processNext(state));
    });
    chain = operation.catch(e => console.error('Course update failed:', e.message));
    operation.finally(() => { autoRunning = false; autoQueued = false; }).catch(() => {});
  }, automationIntervalMs);
  autoTimer.unref();
  server.on('close', () => { clearInterval(timer); clearInterval(autoTimer); });
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const studentWorkspace = process.env.BB_ASSISTANT_MODE !== 'review';
  const server = await createApp({ studentWorkspace, stateFile: process.env.BB_ASSISTANT_STATE_FILE ? resolve(ROOT, process.env.BB_ASSISTANT_STATE_FILE) : undefined });
  const port = Number(process.env.PORT || 4173);
  server.on('error', e => { console.error(e.message); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => console.log(`BB Companion ${studentWorkspace ? '学生工作区' : '本地验收'}：http://127.0.0.1:${port}/\nCtrl+C 停止。`));
}
