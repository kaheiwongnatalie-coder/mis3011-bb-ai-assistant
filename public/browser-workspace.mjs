import { applyEvent, createState, reconcile, summarize, validateProfile } from '../core/engine.mjs';
import { loadScenario, scenarioEvents, scenarios } from '../demo/scenarios.mjs';
import { createTask } from '../core/model.mjs';
import { localDate, ms, validTime } from '../core/time.mjs';

function createStudentPreview(preview, storage) {
  const key = 'bb-companion:student-preview:v1';
  const create = (now, tasks) => {
    const state = createState({now, mode:'replay', tasks});
    state.planningEnabled = true;
    return reconcile(state);
  };
  const { evidence, replay } = preview;
  let state = create(evidence.now, evidence.tasks);
  try {
    const saved = JSON.parse(storage?.getItem(key) || 'null');
    if (saved?.schemaVersion === 1 && saved.mode === 'replay' && validTime(saved.now) && Array.isArray(saved.tasks)) {
      validateProfile(saved.profile);
      state = reconcile(saved);
    }
  } catch { /* The included sample is used if saved browser data cannot be read. */ }
  const view = () => structuredClone({ ...state, studentWorkspace:true, publicPreview:true, workspaceDate:localDate(state.now),
    summary:summarize(state), aiConnection:{configured:false,consent:false} });
  const commit = next => {
    state = next;
    try { storage?.setItem(key, JSON.stringify(state)); } catch { /* The current tab remains usable. */ }
    return view();
  };
  async function request(path, body) {
    if (body === undefined && ['/api/state','/api/export'].includes(path)) return view();
    if (path === '/public/restore') return commit(create(evidence.now,evidence.tasks));
    if (path === '/public/start-replay') {
      return commit(create(replay.now,[replay.exam,...evidence.tasks.filter(task => task.id !== replay.finalExamId && task.kind !== 'tutorial')]));
    }
    if (path === '/public/release-update') {
      if (!state.tasks.some(task => task.id === replay.exam.id)) throw new Error('请先载入改期前的课程资料。');
      let next = state;
      for (const event of replay.events) {
        if (event.type === 'CLOCK_ADVANCED' && ms(event.to) <= ms(next.now)) continue;
        next = applyEvent(next, event);
      }
      return commit(next);
    }
    if (path === '/api/events') {
      let next = state;
      for (const event of body.events || [body]) next = applyEvent(next, event);
      return commit(next);
    }
    if (path === '/api/tasks') {
      const title = String(body.title || '').trim(), courseCode = String(body.courseCode || '').trim();
      if (!title || !courseCode || !validTime(body.deadline) || ms(body.deadline) <= ms(state.now)) throw new Error('请填写课程、任务名称和未来的截止时间。');
      const id = crypto.randomUUID();
      return commit(applyEvent(state, { id, type:'TASK_ADDED', task:{id:`manual:${id}`,title,courseCode,
        term:localDate(state.now).slice(0,4), channel:'external', remainingMinutes:body.remainingMinutes, estimateOrigin:'user',
        deadline:{at:body.deadline,date:localDate(body.deadline),precision:'minute',origin:'user_confirmed'}
      }}));
    }
    throw new Error('请在本地学生版使用该功能。');
  }
  return { request };
}

// The public view reuses the exact core engine; AI results come from a captured run.
export function createPublicWorkspace({ feed, evidence, preview, storage = null }) {
  if (preview) return createStudentPreview(preview, storage);
  const storageKey = 'bb-companion:public:v1';
  const initial = () => {
    const state = createState({ now: evidence.now, mode: 'replay', tasks: evidence.tasks });
    state.aiRuns = structuredClone(evidence.modelRuns);
    state.workspace = 'public';
    state.planningEnabled = true;
    return reconcile(state);
  };
  let state = initial();
  try {
    const saved = JSON.parse(storage?.getItem(storageKey) || 'null');
    if (saved?.schemaVersion === 1 && saved.workspace === 'public') {
      validateProfile(saved.profile);
      if (validTime(saved.now) && Array.isArray(saved.tasks)) state = saved;
    }
  } catch { /* Start with the published run when browser storage is unavailable. */ }
  const view = () => structuredClone({ ...state, summary: summarize(state), scenarios });
  const commit = next => {
    state = next;
    state.workspace = 'public';
    try { storage?.setItem(storageKey, JSON.stringify(state)); } catch { /* The current tab still works. */ }
    return view();
  };
  async function request(path, body) {
    if (body === undefined) {
      if (path === '/api/state' || path === '/api/export') return view();
      if (path === '/api/catalog') return { stats: feed.stats };
      throw new Error('此入口由仓库中的 Node 服务提供。');
    }
    if (path === '/public/restore') return commit(initial());
    if (path === '/api/events') {
      let next = state;
      for (const event of body.events || [body]) next = applyEvent(next, event);
      return commit(next);
    }
    if (path === '/api/import') return commit(loadScenario(feed, body.scenario || 'submission', evidence.now));
    if (path === '/api/demo/event') {
      if (!state.scenario) throw new Error('先选择一组经典演示。');
      let next = state;
      for (const event of scenarioEvents(feed, state)) {
        if (event.type !== 'CLOCK_ADVANCED' || ms(event.to) > ms(next.now)) next = applyEvent(next, event);
      }
      return commit(next);
    }
    if (path === '/api/tasks/import') {
      if (!Array.isArray(body.tasks) || !body.tasks.length) throw new Error('请选择包含 tasks 数组的任务文件。');
      if (!validTime(body.now)) throw new Error('历史任务文件需要有效的 now 回放时间。');
      const next = createState({ now: body.now, mode: 'replay', tasks: body.tasks.map(createTask), profile: body.profile });
      validateProfile(next.profile);
      return commit(reconcile(next));
    }
    if (path === '/api/reset') return commit(createState({ now: evidence.now, mode: 'replay' }));
    throw new Error('AI 连接与新资料自动处理请运行仓库中的 Node 服务。');
  }
  return { request };
}
