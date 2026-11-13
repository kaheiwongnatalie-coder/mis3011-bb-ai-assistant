import { request } from './browser-api.mjs';
import { CLOSED, KIND_LABELS, applicability, fixedFor, taskEnd } from './core/model.mjs';
import { localDate, localClock, atLocal, nextDate, weekday, ms, iso, MINUTE, duration } from './core/time.mjs';
import { createAIPanel } from './ai-panel.mjs';

const $ = s => document.querySelector(s);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const fmt = v => v ? new Intl.DateTimeFormat('zh-CN', { timeZone:'Asia/Shanghai', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hour12:false }).format(new Date(v)) : '时间待补充';
const inputTime = v => v ? `${localDate(v)}T${localClock(v)}` : '';
const localISO = v => v ? `${v}:00+08:00` : null;
const btn = (action, label, id = '', cls = '') => `<button class="button ${cls}" data-action="${action}" data-id="${esc(id)}">${label}</button>`;
const textBtn = (action, label, id = '') => `<button class="text-button" data-action="${action}" data-id="${esc(id)}">${label}</button>`;
const empty = (title, subtitle = '') => `<div class="empty"><h2>${title}</h2><p>${subtitle}</p></div>`;
const statusNames = { unknown:'待处理', draft:'进行中', submitted:'BB 已提交', graded:'已评分', user_confirmed:'已确认完成', cancelled:'已取消', exempt:'已豁免' };
let state, busy = false, tab = 'overview', search = '', taskFilter = 'open', noticeFilter = 'inbox', noticeType = 'all', toastTimer;
let planWeekOffset = 0, planView = 'month', calendarMonth, calendarSelectedDate;
const taskOf = id => state.tasks.find(t => t.id === id);
const timeMode = t => Boolean(fixedFor(t, state.profile)) || ['exam','tutorial'].includes(t.kind) || (t.kind === 'presentation' && !t.deadline?.at);


function toast(message) { $('#toast').textContent = message; $('#toast').classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => $('#toast').classList.remove('show'), 4500); }
function guard(fn) { Promise.resolve().then(fn).catch(error => toast(error.message)); }
async function run(path, body, message = '') {
  if (busy) throw new Error('正在处理，请稍候。');
  busy = true; document.body.dataset.busy = 'true'; $('#main').setAttribute('aria-busy','true'); $('#operation-status').textContent = path.startsWith('/api/ai/') && !path.endsWith('/config') ? 'AI 处理中…' : '更新中…';
  try {
    state = await request(path, body);
    render(); if (message) toast(message); return state;
  } finally { busy = false; document.body.dataset.busy = 'false'; $('#main').setAttribute('aria-busy','false'); $('#operation-status').textContent = ''; }
}
const event = (type, values = {}, message = '已更新') => run('/api/events', { id:crypto.randomUUID(), type, ...values }, message);
function openModal(title, body, foot = '') {
  $('#dialog-content').innerHTML = `<div class="dialog-head"><h2 id="dialog-title">${esc(title)}</h2><button class="close" data-action="close" aria-label="关闭">×</button></div><div class="dialog-body">${body}</div>${foot ? `<div class="dialog-foot">${foot}</div>` : ''}`;
  if (!$('#task-dialog').open) $('#task-dialog').showModal();
}
const closeModal = () => $('#task-dialog').close();
function go(next) { tab = next; location.hash = next; render(); }
const ai = createAIPanel({ getState:() => state, request, run, event, openModal, closeModal, go, render, toast, esc, fmt, inputTime, localISO, btn, textBtn });

function officialTime(t) {
  const fixed = fixedFor(t, state.profile);
  if (t.deadline?.precision === 'conflict') return '截止时间待核对';
  return t.deadline?.at ? `截止 ${fmt(t.deadline.at)}`
    : t.deadline?.date ? `截止 ${t.deadline.date} · 时刻待定`
    : fixed ? `${fmt(fixed.start)}–${localClock(fixed.end)}`
    : ['assignment','quiz','upload'].includes(t.kind) ? '截止时间未确认' : '活动时间待确认';
}
function status(t) {
  const applies = applicability(t, state.profile);
  if (t.status.value === 'submitted' && t.status.origin === 'demo_bb') return '演示已提交';
  return applies === 'not_applicable' ? '无需处理' : applies === 'unknown' && !CLOSED.has(t.status.value) ? '条件待补充' : statusNames[t.status.value];
}
function scenarioStep() {
  if (!state.scenario) return null;
  if (!state.planningEnabled) return { action:'plan', label:'下一步：生成计划' };
  const id = state.scenario.id;
  const finished = id === 'submission' ? state.tasks.some(t => t.status.origin === 'demo_bb')
    : id === 'exam-change' ? state.events.some(e => e.id === 'replay:notice-1017:exam')
    : id === 'capacity' ? state.events.some(e => e.id === 'replay:capacity:postpone') : state.tasks.some(t => t.status.origin === 'demo_bb');
  if (finished) return { label:'这组演示已完成', action:null };
  if (id === 'submission' && !state.notifications.some(n => n.type === 'plan' && ['read','delivered'].includes(n.status))) return { action:'next-notice', label:'下一步：触发提醒' };
  return { action:'demo-event', label:{ submission:'下一步：模拟提交', 'exam-change':'下一步：接收改期通知', capacity:'下一步：推迟准备', english:'下一步：模拟上传幻灯片' }[id] };
}
function render() {
  if (!state) return;
  document.body.classList.toggle('student-workspace', Boolean(state.studentWorkspace));
  $('#open-ai-chat').hidden = !state.studentWorkspace || Boolean(state.publicPreview);
  const previousCalendar = $('#plan-calendar');
  const previousScroll = previousCalendar?.scrollLeft;
  const hash = location.hash.slice(1);
  const chatEnabled = state.studentWorkspace && !state.publicPreview;
  tab = ['tasks','plan','reminders'].includes(hash) || (chatEnabled && hash === 'chat') ? hash : state.publicPreview && !hash ? 'plan' : 'overview';
  $('#main').dataset.tab = tab;
  document.querySelectorAll('nav [data-tab]').forEach(el => { el.classList.toggle('active', el.dataset.tab === tab); el.setAttribute('aria-current', el.dataset.tab === tab ? 'page' : 'false'); });
  const unread = state.notifications.filter(n => n.status === 'delivered').length;
  $('#nav-unread').textContent = unread || '';
  const step = scenarioStep(), mode = state.studentWorkspace ? '学生工作区' : state.scenario?.title || ({ replay:'历史课程演示', snapshot:'历史数据', live:'当前安排', empty:'' }[state.mode]);
  const showStep = step && (step.action !== 'plan' || !['overview','plan'].includes(tab));
  const dateText = `${localDate(state.now)}${state.workspaceDate ? '' : ' ' + localClock(state.now)}`;
  const dateLabel = chatEnabled ? textBtn('workspace-date', `${esc(dateText)} · 切换日期`) : `<span>${esc(dateText)}</span>`;
  $('#context').innerHTML = `${mode ? `<span class="mode">${esc(mode)}</span>${dateLabel}` : ''}${showStep ? (step.action ? textBtn(step.action, step.label) : `<span>${step.label}</span>`) : ''}`;
  $('#main').innerHTML = ({ overview:overviewPage, tasks:tasksPage, plan:planPage, reminders:remindersPage, chat:ai.chatPage })[tab]();
  if (tab === 'chat' || (tab === 'plan' && state.studentWorkspace)) ai.scrollChat();
  const calendar = $('#plan-calendar');
  if (calendar && previousCalendar?.dataset.week === calendar.dataset.week) calendar.scrollLeft = previousScroll;
  else if (calendar) {
    const day = calendar.querySelector('.calendar-day-label.is-selected') || calendar.querySelector('.calendar-day-label.is-today');
    if (day && calendar.scrollWidth > calendar.clientWidth) {
      calendar.scrollLeft = day.offsetLeft - calendar.querySelector('.calendar-axis').offsetWidth;
    }
  }
}

function sourceActions() {
  if (state.studentWorkspace) return `<div class="actions">${btn('automation','课程同步','','primary')}${btn('add-task','添加任务')}</div>`;
  return `<div class="actions">${textBtn('import', '导入资料')}${btn('automation', '自动跟进', '', 'primary')}</div>`;
}

function aiSetupCard() {
  if (!state.studentWorkspace || state.publicPreview || ai.ready()) return '';
  return `<section class="panel ai-setup"><div><h2>启用 AI 助手</h2><p class="hint">连接模型后，系统可以自动识别课程更新，也可以用一句话调整日历。</p></div>${btn('settings','连接 AI')}</section>`;
}

function overviewPage() {
  const today = localDate(state.now);
  const rows = scheduleRows();
  const next = rows.find(row => localDate(row.start) >= today);
  const day = next ? localDate(next.start) : today;
  const schedule = rows.filter(row => localDate(row.start) === day);
  const received = state.notifications.filter(notice => notice.status === 'delivered' && notice.type !== 'digest')
    .sort((a, b) => ms(b.deliverAt) - ms(a.deliverAt));
  const upcoming = state.notifications.filter(notice => notice.status === 'pending' && notice.type !== 'digest')
    .sort((a, b) => ms(a.deliverAt) - ms(b.deliverAt));
  const notices = [...received, ...upcoming].slice(0, 3);
  return `<div class="heading"><h1>课程工作台</h1>${sourceActions()}</div>
    ${aiSetupCard()}${ai.automationLine()}
    <div class="overview-grid">
      <section aria-labelledby="overview-tasks">
        <div class="section-heading"><h2 id="overview-tasks">课程任务</h2></div>
        ${taskList()}
      </section>
      <div class="overview-side">
        <section class="panel overview-panel" aria-labelledby="overview-plan">
          <div class="section-heading"><h2 id="overview-plan">${day === today ? '今日安排' : '接下来安排'}</h2><a href="#plan">查看计划 →</a></div>
          ${day !== today ? `<p class="hint">${esc(day)}</p>` : ''}
          ${schedule.length ? schedule.slice(0, 4).map(scheduleRow).join('') : '<p class="hint">暂无准备安排</p>'}
          ${state.plan.risks.length ? `<a class="overview-risk" href="#plan">${state.plan.risks.length} 项安排需要检查 →</a>` : ''}
          <div class="actions overview-actions">${textBtn('profile', '设置空闲时间')}${state.tasks.length && !state.planningEnabled && state.mode !== 'snapshot' ? btn('plan', '生成计划', '', 'small') : ''}</div>
        </section>
        <section class="panel overview-panel" aria-labelledby="overview-reminders">
          <div class="section-heading"><h2 id="overview-reminders">提醒</h2><a href="#reminders">查看提醒 →</a></div>
          ${notices.length ? notices.map(noticeCard).join('') : '<p class="hint">暂无提醒</p>'}
        </section>
      </div>
    </div>`;
}

function tasksPage() {
  const active = state.tasks.filter(t => !CLOSED.has(t.status.value) && applicability(t,state.profile) !== 'not_applicable').length;
  return `<div class="heading"><div><h1>课程任务</h1>${state.tasks.length ? `<p>${active} 项待处理</p>` : ''}</div>${sourceActions()}</div>
    ${aiSetupCard()}${ai.automationLine()}${taskList()}`;
}

function taskList() {
  const list = state.tasks.filter(t => `${t.title} ${t.courseCode}`.toLowerCase().includes(search.toLowerCase()) && (taskFilter === 'all' || (taskFilter === 'closed') === CLOSED.has(t.status.value)));
  if (state.studentWorkspace) {
    const nextTime = task => {
      const time = ms(task.deadline?.at || (task.deadline?.date && atLocal(task.deadline.date, '23:59')) || taskEnd(task, state.profile));
      return time >= ms(state.now) ? time : Infinity;
    };
    list.sort((a,b) => nextTime(a) - nextTime(b) ||
      Number(b.term === localDate(state.now).slice(0,4)) - Number(a.term === localDate(state.now).slice(0,4)));
  }
  const questions = state.aiQuestions || [];
  const emptyHint = state.tasks.length ? '可以切换筛选查看其他任务。' : state.studentWorkspace
    ? (state.automation?.enabled ? '课程同步发现新任务后，会自动显示在这里。' : '开启课程同步后，新任务会自动显示在这里。')
    : '导入课程公告，或设置自动跟进。';
  return `
    ${questions.length ? `<div class="issue-line"><span>${questions.length} 项信息待补充</span>${textBtn('questions','查看')}</div>` : ''}
    ${state.tasks.length ? `<div class="toolbar"><input id="search" aria-label="搜索任务" placeholder="搜索任务或课程" value="${esc(search)}"><select id="task-filter" aria-label="筛选任务" style="width:auto">${[['open','待处理'],['all','全部'],['closed','已完成／取消']].map(([v,t]) => `<option value="${v}" ${taskFilter === v ? 'selected' : ''}>${t}</option>`).join('')}</select></div>` : ''}
    ${list.length ? `<div class="task-list">${list.map(t => `<article class="task-row ${CLOSED.has(t.status.value) ? 'done' : ''}" data-task="${esc(t.id)}"><div><button class="task-title" data-action="detail" data-id="${esc(t.id)}">${esc(t.title)}</button><small>${esc(t.courseCode)} · ${KIND_LABELS[t.kind]}</small></div><div class="task-time">${officialTime(t)}</div><span class="status ${CLOSED.has(t.status.value) ? 'done' : ''}">${status(t)}</span><div class="actions">${btn('detail','查看',t.id,'small')}</div></article>`).join('')}</div>` : `<div class="panel">${empty(state.tasks.length ? '没有符合筛选条件的任务' : '还没有课程任务', emptyHint)}</div>`}`;
}

function scheduleRows() {
  const preparation = state.plan.blocks.map(block => ({ ...block, type:'prep', title:taskOf(block.taskId)?.title }));
  const fixed = state.plan.fixed.map(row => ({ ...row, type:'fixed' }));
  const busy = state.profile.busy.map((row,index) => ({ ...row, type:'busy', index }))
    .filter(row => ms(row.end) > ms(state.now));
  return [...preparation, ...fixed, ...busy].sort((a,b) => ms(a.start) - ms(b.start));
}

function scheduleRow(row) {
  const title = esc(row.title || '已有安排');
  const label = row.type === 'fixed' ? '固定活动' : row.type === 'busy' ? '已有安排' : `${duration(row)} 分钟准备${row.locked ? ' · 已锁定' : ''}`;
  const action = row.type === 'prep' ? textBtn('lock',row.locked ? '解锁' : '锁定',row.id)
    : row.type === 'busy' ? textBtn('remove-busy','移除',String(row.index)) : '';
  return `<div class="schedule-row ${row.type}" data-block="${esc(row.id || '')}">
    <time>${localClock(row.start)}–${localClock(row.end)}</time>
    <div>${row.taskId ? `<button class="task-title" data-action="detail" data-id="${esc(row.taskId)}">${title}</button>` : `<strong>${title}</strong>`}<small>${label}</small></div>
    ${action}
  </div>`;
}

// Split events at local midnight and place overlapping events in parallel lanes.
function calendarDay(rows, date) {
  const midnight = ms(atLocal(date, '00:00'));
  const endOfDay = ms(atLocal(nextDate(date), '00:00'));
  const segments = rows.filter(row => ms(row.start) < endOfDay && ms(row.end) > midnight)
    .map(row => ({
      row,
      start: (Math.max(ms(row.start), midnight) - midnight) / MINUTE,
      end: (Math.min(ms(row.end), endOfDay) - midnight) / MINUTE
    }));
  let group = [], lanes = [];
  function closeGroup() {
    for (const segment of group) segment.lanes = lanes.length;
    group = [];
    lanes = [];
  }
  for (const segment of segments) {
    if (lanes.every(end => end <= segment.start)) closeGroup();
    const available = lanes.findIndex(end => end <= segment.start);
    segment.lane = available < 0 ? lanes.length : available;
    lanes[segment.lane] = segment.end;
    group.push(segment);
  }
  closeGroup();
  return segments;
}

function calendarBlock({ row, start, end, lane, lanes }, firstMinute) {
  const title = esc(row.title || '已有安排');
  const kind = { prep:'准备时段', fixed:'固定活动', busy:'已有安排' }[row.type];
  const minutes = `${Math.round(duration(row))} 分钟`;
  const label = `${localClock(row.start)}–${localClock(row.end)} · ${minutes}`;
  const description = `${title}，${kind}，${label}${row.locked ? '，已锁定' : ''}`;
  const compact = end - start < 35;
  const content = `<strong>${title}</strong><span>${compact ? minutes : label}</span>`;
  const action = row.type === 'prep' ? `<button class="calendar-lock" data-action="lock" data-id="${esc(row.id)}" aria-label="${row.locked ? '解锁' : '锁定'}${title}" title="${row.locked ? '解锁时段' : '锁定时段'}">${row.locked ? '●' : '○'}</button>` : '';
  return `<div class="calendar-block ${row.type}${compact ? ' compact' : ''}" data-block="${esc(row.id || '')}" style="--start:${start - firstMinute};--length:${end - start};--lane:${lane};--lanes:${lanes}" title="${description}">
    ${row.taskId ? `<button class="calendar-entry" data-action="detail" data-id="${esc(row.taskId)}" aria-label="${description}">${content}</button>` : `<div class="calendar-entry">${content}</div>`}
    ${action}
  </div>`;
}

function deadlinesOn(day) {
  return state.tasks.filter(task => !CLOSED.has(task.status.value) &&
    applicability(task, state.profile) !== 'not_applicable' && task.deadline?.precision !== 'conflict' &&
    (task.deadline?.at ? localDate(task.deadline.at) : task.deadline?.date) === day
  ).sort((a,b) => (a.deadline.at || '').localeCompare(b.deadline.at || ''));
}

const weekStart = date => nextDate(date, -((weekday(date) + 6) % 7));

function weekCalendar(rows) {
  const today = localDate(state.now);
  const monday = nextDate(weekStart(today), 7 * planWeekOffset);
  const days = Array.from({length:7}, (_, index) => nextDate(monday, index));
  const events = days.map(day => calendarDay(rows, day));
  const deadlines = days.map(deadlinesOn);
  const all = events.flat();
  const intervalMinutes = 120;
  const firstMinute = all.length ? Math.floor(Math.min(...all.map(event => event.start)) / intervalMinutes) * intervalMinutes : 8 * 60;
  const lastMinute = all.length ? Math.ceil(Math.max(...all.map(event => event.end)) / intervalMinutes) * intervalMinutes : 18 * 60;
  const ticks = Array.from({length:(lastMinute - firstMinute) / intervalMinutes}, (_, index) => (firstMinute + index * intervalMinutes) / 60);
  return `<div class="calendar-toolbar">
    <h2>${days[0].replaceAll('-', '/')} – ${days[6].slice(5).replace('-', '/')}</h2>
    <div class="actions">${btn('calendar-week','‹ 上一周','-1','small')}${btn('calendar-reset',state.workspaceDate ? '工作区当周' : state.mode === 'replay' ? '回放当周' : '本周','','small')}${btn('calendar-week','下一周 ›','1','small')}</div>
  </div>
  <ul class="calendar-legend"><li class="prep">准备时段</li><li class="fixed">考试与课堂</li><li class="busy">已有安排</li><li class="deadline">作业截止</li></ul>
  <div class="calendar-scroll" id="plan-calendar" data-week="${monday}" tabindex="0" aria-label="周日历，可横向滚动">
    <div class="calendar-grid" style="--interval-minutes:${intervalMinutes};--total-minutes:${lastMinute - firstMinute}">
      <div class="calendar-axis calendar-zone">UTC+8</div>
      ${days.map((day,index) => `<div class="calendar-day-label ${day === today ? 'is-today' : ''} ${day === calendarSelectedDate ? 'is-selected' : ''}"><span>周${'一二三四五六日'[index]}</span><time datetime="${day}">${Number(day.slice(5,7))}/${Number(day.slice(8))}</time></div>`).join('')}
      ${deadlines.some(day => day.length) ? `<div class="calendar-axis calendar-deadline-label">截止</div>${deadlines.map((tasks, index) => `<div class="calendar-deadlines" aria-label="${days[index]} 截止">
        ${tasks.map(task => `<button class="calendar-deadline" data-action="detail" data-id="${esc(task.id)}" title="${esc(task.title)} · ${task.deadline.at ? localClock(task.deadline.at) : '时刻未公布'}"><time>${task.deadline.at ? localClock(task.deadline.at) : '时刻待定'}</time> ${esc(task.title)}</button>`).join('')}
      </div>`).join('')}` : ''}
      <div class="calendar-axis calendar-times">${ticks.map(hour => `<div>${String(hour).padStart(2,'0')}:00</div>`).join('')}</div>
      ${events.map((segments,index) => `<section class="calendar-day" aria-label="${days[index]}">${segments.map(segment => calendarBlock(segment, firstMinute)).join('')}</section>`).join('')}
    </div>
  </div>
  ${all.length || deadlines.some(day => day.length) ? '' : '<p class="hint calendar-empty">本周暂无安排</p>'}`;
}

function monthCalendar(rows, today) {
  const month = calendarMonth || today.slice(0, 7);
  const first = month + '-01';
  const end = shiftMonth(month, 1) + '-01';
  const start = weekStart(first);
  const count = Math.ceil((ms(atLocal(end,'00:00')) - ms(atLocal(start,'00:00'))) / (7 * 24 * 60 * MINUTE)) * 7;
  const days = Array.from({length:count}, (_, index) => nextDate(start, index));
  return `<div class="month-head">
    <div class="month-controls"><button type="button" class="button month-arrow" data-action="calendar-month" data-id="-1" aria-label="上个月">‹</button>
      <h2>${month.slice(0,4)} 年 ${Number(month.slice(5))} 月</h2><button type="button" class="button month-arrow" data-action="calendar-month" data-id="1" aria-label="下个月">›</button>
      ${btn('calendar-today','回到工作区日期','','small')}
    </div><p class="hint">点击日期查看该周的具体安排</p>
  </div>
  <div class="month-grid" aria-label="月日历">
    ${['一','二','三','四','五','六','日'].map(day => `<span class="month-weekday">周${day}</span>`).join('')}
    ${days.map(day => {
      const entries = [
        ...deadlinesOn(day).map(task => ({title:task.title, kind:'deadline', label:task.deadline.at ? '截止 ' + localClock(task.deadline.at) : '截止时刻待定'})),
        ...calendarDay(rows, day).map(({row}) => ({title:row.title || '已有安排', kind:row.type, label:localClock(row.start)}))
      ];
      return `<button type="button" class="month-cell ${!day.startsWith(month) ? 'outside-month' : ''} ${day === today ? 'is-today' : ''}"
        data-action="calendar-open-week" data-id="${day}" aria-label="${day}，${entries.length} 项安排，查看周日历" ${day === today ? 'aria-current="date"' : ''}>
        <time class="month-day-number" datetime="${day}">${Number(day.slice(8))}</time>
        ${entries.slice(0,3).map(item => `<span class="month-chip ${item.kind}" title="${esc(item.label)} · ${esc(item.title)}"><strong>${esc(item.title)}</strong><small>${esc(item.label)}</small></span>`).join('')}
        ${entries.length > 3 ? `<span class="month-more">+${entries.length - 3} 项</span>` : ''}
      </button>`;
    }).join('')}
  </div>`;
}

function shiftMonth(month, delta) {
  const [year, number] = month.split('-').map(Number);
  return new Date(Date.UTC(year, number - 1 + delta, 1)).toISOString().slice(0,7);
}

function statCard(label, value, unit, detail) {
  return `<article class="flow-stat"><span>${label}</span><strong>${esc(value)}<small>${esc(unit)}</small></strong>
    ${detail ? `<p>${esc(detail)}</p>` : ''}</article>`;
}

function subjectBreakdown(blocks, minutes) {
  const byCourse = new Map();
  for (const block of blocks) {
    const course = taskOf(block.taskId)?.courseCode || '其他';
    byCourse.set(course, (byCourse.get(course) || 0) + duration(block));
  }
  const colors = ['#8d67c3','#d37199','#4d8cb9','#5c9d77','#d08a43'];
  let stop = 0;
  const courses = [...byCourse].sort((a,b) => b[1] - a[1]).map(([course, time], index) => {
    const color = colors[index % colors.length];
    const from = stop;
    stop += time / minutes * 100;
    return {course, time:Math.round(time), color, slice:`${color} ${from}% ${stop}%`};
  });
  return `<section class="panel flow-insight"><div class="section-heading"><h2>科目时间占比</h2><a href="#tasks">查看任务 →</a></div>
    ${courses.length ? `<div class="flow-breakdown">
      <div class="flow-donut" aria-hidden="true" style="--segments:conic-gradient(${courses.map(item => item.slice).join(',')})"><span>${Math.round(minutes)}<small>本周分钟</small></span></div>
      <ul>${courses.map(item => `<li><span style="--course-color:${item.color}">${esc(item.course)}</span><strong>${item.time} 分钟</strong></li>`).join('')}</ul>
    </div>` : '<p class="hint">本周暂无准备时段。</p>'}
  </section>`;
}

function studentPlanPage(rows) {
  const today = localDate(state.now), monday = weekStart(today), nextMonday = nextDate(monday,7);
  const thisWeek = date => date >= monday && date < nextMonday;
  const blocks = state.plan.blocks.filter(block => thisWeek(localDate(block.start)));
  const minutes = blocks.reduce((total, block) => total + duration(block), 0);
  const pending = state.tasks.filter(task => !CLOSED.has(task.status.value) && applicability(task,state.profile) !== 'not_applicable');
  const deadlines = Array.from({length:7}, (_,i) => deadlinesOn(nextDate(monday,i))).flat();
  const todayRows = rows.filter(row => localDate(row.start) === today);
  const upcoming = deadlinesOn(today);
  const syncCount = Object.keys(state.aiSources || {}).length;
  const available = state.profile.availability.filter(window => window.day === weekday(today))
    .reduce((total, window) => total + Math.max(0, (ms(atLocal(today,window.end)) - Math.max(ms(atLocal(today,window.start)),ms(state.now))) / MINUTE), 0);
  const dates = [...new Set(rows.map(row => localDate(row.start)))];
  return `<div class="heading flow-hero"><div><h1>课程日历</h1><p>查看作业截止、课程活动和准备时段。</p></div>
    <div class="actions">${btn('automation','同步 BB 课程')}${btn('profile','空闲设置')}${btn('add-task','＋ 新增任务','','primary')}</div></div>
    ${ai.automationLine()}
    <div class="flow-stats">${statCard('本周已安排',Math.round(minutes),'分钟',`${blocks.length} 个准备时段`)}
      ${statCard('待完成任务',pending.length,'项',`${deadlines.length} 项本周截止`)}
      ${statCard('今日可安排窗口',Math.round(available),'分钟','按空闲设置计算')}
      ${state.publicPreview ? statCard('资料来源','本地数据包','','历史课程公告') : statCard('已处理课程资料',syncCount,'份',state.automation?.lastScanAt ? '最近检查 ' + fmt(state.automation.lastScanAt) : '')}</div>
    <div class="flow-layout">
      <div class="flow-calendar-column">
        <section class="panel flow-calendar" aria-label="课程日历">
          <div class="flow-calendar-actions"><div class="flow-view-switch" aria-label="日历视图">
            ${[['month','月视图'],['week','周视图'],['list','列表']].map(([view,label]) => `<button type="button" class="button small ${planView===view?'is-active':''}" data-action="plan-view" data-id="${view}" aria-pressed="${planView===view}">${label}</button>`).join('')}
          </div><div class="actions">${textBtn('busy','＋ 添加已有安排')}${state.tasks.length ? textBtn('plan','重新安排') : ''}</div></div>
          ${planView === 'month' ? monthCalendar(rows,today) : planView === 'week' ? `<div class="flow-week">${weekCalendar(rows)}</div>`
            : dates.length ? `<div class="flow-week">${dates.map(date => `<section class="day"><h2 class="day-heading">${date}</h2>${rows.filter(row => localDate(row.start) === date).map(scheduleRow).join('')}</section>`).join('')}</div>`
            : empty('还没有时间安排','课程同步或新增任务后，准备时段会显示在这里。')}
        </section>
        ${state.plan.risks.length ? `<details class="panel flow-risks"><summary>需检查的安排 · ${state.plan.risks.length} 项</summary>${state.plan.risks.map(risk => `<p>${esc(taskOf(risk.taskId)?.title || '')} · ${esc(risk.message)}</p>`).join('')}</details>` : ''}
      </div>
      <aside class="flow-aside">
        ${subjectBreakdown(blocks,minutes)}
        <section class="panel flow-insight"><div class="section-heading"><h2>今日待办</h2>${textBtn('add-task','＋ 添加')}</div>
          ${upcoming.map(task => `<div class="flow-today"><time>${task.deadline.at ? localClock(task.deadline.at) : '待定'}</time>${textBtn('detail',esc(task.title),task.id)}<small>截止</small></div>`).join('')}
          ${todayRows.slice(0,5).map(row => `<div class="flow-today"><time>${localClock(row.start)}</time>${row.taskId ? textBtn('detail',esc(row.title),row.taskId) : `<strong>${esc(row.title)}</strong>`}<small>${row.type === 'prep' ? '准备' : row.type === 'fixed' ? '课堂' : '已有安排'}</small></div>`).join('')}
          ${!todayRows.length && !upcoming.length ? '<p class="hint">今天暂无待办。</p>' : ''}
        </section>
        ${ai.chatCard()}
      </aside>
    </div>`;
}

function planPage() {
  const rows = scheduleRows();
  if (state.studentWorkspace) return studentPlanPage(rows);
  const dates = [...new Set(rows.map(r => localDate(r.start)))];
  const risks = state.plan.risks;
  return `<div class="heading"><div><h1>时间计划</h1><p>${state.planningEnabled ? '查看准备安排，随时调整。' : '设好空闲时间，再生成计划。'}</p></div><div class="actions">${btn('profile','空闲设置')}${state.tasks.length && state.mode !== 'snapshot' ? btn('plan',state.planningEnabled ? '重新安排' : '生成计划','','primary') : ''}</div></div>
    ${risks.length ? `<div class="risk-list">${risks.map(r => `<p>${esc(taskOf(r.taskId)?.title || '')}：${esc(r.message)}</p>`).join('')}</div>` : ''}
    ${state.studentWorkspace && !ai.ready() ? aiSetupCard() : ''}
    ${state.studentWorkspace ? '<p class="plan-chat-link"><a class="button" href="#chat">和 AI 聊聊怎么排</a></p>' : state.tasks.length && state.mode !== 'snapshot' && !state.aiConnection?.replayOnly ? `` : ''}
    <div class="plan-summary plan-controls"><span>${state.plan.blocks.reduce((n,b) => n+duration(b),0)} 分钟准备 · ${state.plan.blocks.length} 个时段</span>
      <div class="actions">${textBtn('busy','＋ 添加已有安排')}<button class="button small" data-action="plan-view">${planView !== 'list' ? '切换到列表' : '切换到周日历'}</button></div>
    </div>
    ${planView !== 'list' ? weekCalendar(rows) : dates.length ? dates.map(date => `<section class="day"><h2 class="day-heading">${date}</h2>${rows.filter(row => localDate(row.start) === date).map(scheduleRow).join('')}</section>`).join('') : `<div class="panel">${empty('还没有时间安排', state.tasks.length ? '点击“生成计划”，或先设置空闲时间。' : '先导入课程资料。')}</div>`}
    `;
}
function noticeCard(n) {
  const readable = value => String(value).replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})/g, fmt);
  const message = n => {
    const t = taskOf(n.taskId);
    if (n.type === 'deadline' && t) return officialTime(t);
    if (n.type === 'verify') return '完成情况待确认，可在任务中更新。';
    if (n.type === 'plan') {
      const times = n.body.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})/g);
      if (times?.length >= 2) return `准备时间：${fmt(times[0])}–${fmt(times[1])}`;
    }
    return readable(n.body).replace('这是本任务的证据，不代表其他关联事项已经完成。','').replace('；完成情况仍需核实，未判定漏交。','。请核对完成情况。');
  };
  const icons = {deadline:'!', change:'↻', plan:'✓'};
  return `<article class="notice ${n.status === 'delivered' ? 'unread' : ''}">
    ${state.studentWorkspace ? `<span class="notice-icon ${icons[n.type] ? n.type : ''}" aria-hidden="true">${icons[n.type] || '·'}</span>` : ''}
    <div><h3>${esc(n.title)}</h3><p>${esc(message(n))}</p><div class="notice-foot"><span>${n.status === 'pending' ? '待提醒 · ' : ''}${fmt(n.deliveredAt || n.deliverAt)}${n.silent ? ' · 静默' : ''}</span><div class="actions">${n.taskId ? textBtn('detail','查看任务',n.taskId) : ''}${n.status === 'delivered' ? textBtn('read','已读',n.id) : ''}${n.taskId && n.status !== 'cancelled' ? textBtn('snooze','稍后提醒',n.taskId) : ''}</div></div></div></article>`;
}

function remindersPage() {
  const list = state.notifications.filter(n => {
    const statusMatches = noticeFilter === 'all' ? ['delivered','read'].includes(n.status)
      : n.status === (noticeFilter === 'inbox' ? 'delivered' : noticeFilter);
    return statusMatches && (!state.studentWorkspace || noticeType === 'all' || n.type === noticeType);
  }).sort((a,b) => ms(b.deliverAt)-ms(a.deliverAt));
  const filters = `<div class="tabs">${[['inbox','未读'],['all','全部'],['pending','待提醒'],['cancelled','已撤销']].map(([v,t]) => `<button data-action="notice-filter" data-id="${v}" class="${noticeFilter === v ? 'active' : ''}">${t}</button>`).join('')}</div>`;
  const contents = list.length ? list.map(noticeCard).join('') : empty(noticeFilter === 'pending' ? '暂无待提醒事项' : '这里暂时没有提醒');
  if (!state.studentWorkspace) return `<div class="heading"><h1>提醒</h1>${state.mode === 'replay' ? btn('next-notice','触发下一条') : ''}</div>${filters}<div>${contents}</div>`;
  const unread = state.notifications.filter(n => n.status === 'delivered');
  const pending = state.notifications.filter(n => n.status === 'pending').sort((a,b) => ms(a.deliverAt) - ms(b.deliverAt));
  const next = pending[0];
  const { start, end } = state.profile.quiet;
  return `<div class="flow-reminder-hero"><div><h1>动态提醒</h1><p>查看作业截止、课程变更和准备提醒。</p></div>${btn('profile','提醒偏好')}</div>
    <div class="flow-stats">${statCard('未读提醒',unread.length,'条','')}${statCard('待提醒',pending.length,'条','')}
      ${statCard('下一条提醒',next ? fmt(next.deliverAt) : '暂无','',next?.title)}
      ${statCard('安静时段',start === end ? '未开启' : start + '–' + end,'','')}</div>
    <div class="flow-reminder-layout"><section class="panel flow-inbox">
      <div class="section-heading"><h2>提醒收件箱</h2>${unread.length ? btn('read-all','全部标为已读','','small') : ''}</div>
      ${filters}<div class="flow-notice-types actions" aria-label="按提醒类型筛选">${[
        ['all','所有类型'],['deadline','截止提醒'],['change','课程变更'],['plan','安排提醒']
      ].map(([type,label]) => `<button type="button" class="button small" data-action="notice-type" data-id="${type}" aria-pressed="${noticeType===type}">${label}</button>`).join('')}</div>
      ${contents}</section>
      <aside class="panel flow-insight"><div class="section-heading"><h2>提醒设置</h2>${textBtn('profile','调整设置')}</div>
        <p>安静时段 <strong>${esc(start)}–${esc(end)}</strong></p>
        <p class="hint">任务详情中可以暂停单项提醒，或把提醒延后。</p>
      </aside></div>`;
}
function scenariosModal() {
  openModal('选择一个演示', `<form id="scenario-form">${state.scenarios.map((s,i) => `<label class="scenario-option"><input name="scenario" type="radio" value="${s.id}" ${i ? '' : 'checked'}><span><strong>${s.title}</strong><small>${{submission:'两项作业：排期 → 提醒 → 提交','exam-change':'改期后重新安排，更新提醒',capacity:'推迟准备，检查时间是否够用',english:'按班级与设备决定需要做什么'}[s.id]}</small></span></label>`).join('')}</form>`, `<span class="hint">载入后替换当前任务</span><button form="scenario-form" class="button primary" type="submit">开始演示</button>`);
}
function addTaskModal() {
  openModal('添加任务', `<form id="add-task-form">
    <div class="field"><label for="new-course">课程</label><input id="new-course" name="courseCode" placeholder="例如：MIS3011" maxlength="40" required></div>
    <div class="field"><label for="new-title">任务名称</label><input id="new-title" name="title" placeholder="例如：小组报告初稿" maxlength="150" required></div>
    <div class="form-grid"><div class="field"><label for="new-due">截止时间（北京时间）</label><input id="new-due" name="deadline" type="datetime-local" required></div>
    <div class="field"><label for="new-effort">预计用时（分钟）</label><input id="new-effort" name="remainingMinutes" type="number" min="1" max="10000" value="60" required></div></div>
    <p class="hint">保存后，任务会自动进入计划和提醒。</p></form>`, `${btn('close','取消')}<button class="button primary" type="submit" form="add-task-form">保存任务</button>`);
}
function taskModal(id) {
  const t = taskOf(id); if (!t) return;
  const estimate = {user:'你填写',ai_estimate:'AI 建议',feedback_calibrated:'用时反馈校准',default_estimate:'默认估计'}[t.estimateOrigin] || '可调整';
  openModal(t.title, `<div class="detail-meta"><span>${esc(t.courseCode)}</span><span>${KIND_LABELS[t.kind]}</span><span>${status(t)}</span></div><h3>时间</h3><p>${officialTime(t)}</p><p class="hint" style="margin-top:6px">预计还需 ${t.remainingMinutes} 分钟 · ${estimate}　${textBtn('edit-task','修改',id)}</p>${t.requirements.length ? `<h3 style="margin-top:22px">任务要求</h3><ul class="requirements">${t.requirements.map(r => `<li>${esc(r)}</li>`).join('')}</ul>` : ''}${t.issues.length ? `<div class="risk-list" style="margin-top:18px">${t.issues.map(r => `<p>${esc(r)}</p>`).join('')}</div>` : ''}<details><summary>来源 · ${t.sources.length} 条</summary>${t.sources.map(s => `<div class="source"><p>${esc(s.locator || s.path)}</p><pre>${esc(s.quote)}</pre>${state.studentWorkspace && s.documentId && /^(courses|attachment_text|course-inbox)\//.test(s.path) ? `<button class="text-button" data-ai-preview="${esc(s.documentId)}" data-from-task>原文</button>` : !state.studentWorkspace && /^(courses|attachment_text|attachment_files)\//.test(s.path) ? `<a href="./sources/${s.path.split('/').map(encodeURIComponent).join('/')}" target="_blank" rel="noopener">原文件 ↗</a>` : ''}</div>`).join('')}<small>记录 ID：${esc(t.id)} · v${t.version}</small></details><details><summary>实际用时（选填）</summary><form id="feedback-form" data-task="${esc(id)}" class="actions"><input type="number" name="actualMinutes" min="1" max="20000" placeholder="实际总分钟" aria-label="实际用时" required style="max-width:180px"><button class="button small" type="submit">保存反馈</button></form></details>${!CLOSED.has(t.status.value) ? `<div class="detail-actions">${state.studentWorkspace && ['unknown','draft'].includes(t.status.value) ? textBtn('progress',t.status.value==='draft'?'标为待处理':'标为进行中',id) : ''}${textBtn('defer','推迟准备',id)}${textBtn('pause',t.paused ? '恢复提醒' : '暂停提醒',id)}</div>` : ''}`, `${btn('close','返回')}${!CLOSED.has(t.status.value) && applicability(t,state.profile) !== 'not_applicable' ? btn('confirm','我已完成／提交',id,'primary') : ''}`);
}
function editModal(id) {
  const t = taskOf(id), fixed = fixedFor(t,state.profile), isFixed = timeMode(t);
  openModal('调整任务', `<form id="edit-task-form" data-task="${esc(id)}"><div class="field"><label for="remaining">预计还需／分钟</label><input id="remaining" name="remainingMinutes" type="number" min="0" max="10000" value="${t.remainingMinutes}" required></div><details><summary>修改时间</summary><div class="field"><label for="task-when">${isFixed ? '开始时间' : '截止时间'}</label><input id="task-when" name="when" type="datetime-local" value="${inputTime(fixed?.start || t.deadline?.at)}"></div>${isFixed ? `<div class="field"><label for="task-end">结束时间</label><input id="task-end" name="end" type="datetime-local" value="${inputTime(fixed?.end)}"></div>` : ''}</details></form>`, `${btn('detail','返回',id)}<button class="button primary" type="submit" form="edit-task-form">保存</button>`);
}
function profileModal() {
  const p = state.profile, courses = [...new Set([...state.tasks.map(t => t.courseCode),...Object.keys(p.sections),...Object.keys(p.devices)])], week = ['日','一','二','三','四','五','六'];
  openModal('我的空闲时间', `<form id="profile-form">${[1,2,3,4,5,6,0].map(day => { const row = p.availability.find(a => a.day === day); return `<div class="week-row"><label><input type="checkbox" name="day-${day}" ${row ? 'checked' : ''}>周${week[day]}</label><input type="time" aria-label="周${week[day]}开始" name="start-${day}" value="${row?.start || '19:00'}"><span>–</span><input type="time" aria-label="周${week[day]}结束" name="end-${day}" value="${row?.end || '21:30'}"></div>`; }).join('')}<div class="divider"></div><div class="field"><label for="daily-limit">每天最多安排／分钟</label><input id="daily-limit" name="dailyLimitMinutes" type="number" min="15" max="1440" value="${p.dailyLimitMinutes}" required></div><details><summary>班级与设备</summary>${courses.map(c => `<div class="course-row"><span>${esc(c)}</span><input name="section:${esc(c)}" placeholder="班级" aria-label="${esc(c)}班级" value="${esc(p.sections[c] || '')}"><select name="device:${esc(c)}" aria-label="${esc(c)}设备">${[['','设备未定'],['classroom','教室电脑'],['own','自带设备']].map(([v,t]) => `<option value="${v}" ${p.devices[c] === v ? 'selected' : ''}>${t}</option>`).join('')}</select></div>`).join('') || '<p class="hint">导入任务后可设置班级</p>'}</details><details><summary>安排与提醒偏好</summary><div class="form-grid">${[['blockMinutes','每段最长／分钟',p.blockMinutes],['bufferMinutes','截止前缓冲／分钟',p.bufferMinutes],['breakMinutes','段间休息／分钟',p.breakMinutes]].map(([n,t,v]) => `<div class="field"><label for="${n}">${t}</label><input id="${n}" name="${n}" type="number" min="${n === 'blockMinutes' ? 15 : 0}" max="480" value="${v}" required></div>`).join('')}<div class="field"><label for="quiet-start">安静时段开始</label><input id="quiet-start" name="quietStart" type="time" value="${p.quiet.start}" required></div><div class="field"><label for="quiet-end">安静时段结束</label><input id="quiet-end" name="quietEnd" type="time" value="${p.quiet.end}" required></div></div></details></form>`, `<button class="button primary" type="submit" form="profile-form">保存</button>`);
}
function busyModal() { openModal('添加已有安排', `<form id="busy-form"><div class="field"><label for="busy-title">事项</label><input id="busy-title" name="title" placeholder="例如：小组会议" required></div><div class="form-grid"><div class="field"><label for="busy-start">开始</label><input id="busy-start" name="start" type="datetime-local" value="${inputTime(atLocal(localDate(state.now),'19:00'))}" required></div><div class="field"><label for="busy-end">结束</label><input id="busy-end" name="end" type="datetime-local" value="${inputTime(atLocal(localDate(state.now),'20:00'))}" required></div></div></form>`, `<button class="button primary" type="submit" form="busy-form">添加</button>`); }
function clockModal() { openModal('回放时间', `<p class="hint">当前 ${localDate(state.now)} ${localClock(state.now)}</p><div class="actions" style="margin-top:20px">${btn('advance','前进 1 小时','60')}${btn('advance','前进一天','1440')}${btn('next-notice','跳到下一条提醒')}</div>`); }
function workspaceDateModal() {
  openModal('工作区日期', `
    <p class="hint">选定日期后，日历、排程、提醒和 AI 会按当天计算。</p>
    <div class="actions" style="margin:16px 0">
      ${btn('set-workspace-date','2024 学期','2024-10-23')}
      ${btn('set-workspace-date','2023 学期','2023-11-14')}
      ${btn('set-workspace-date','回到今天')}
    </div>
    <form id="workspace-date-form"><div class="field"><label for="workspace-date">自选日期</label>
      <input id="workspace-date" name="date" type="date" value="${esc(localDate(state.now))}" required>
    </div></form>
  `, `${btn('close','取消')}<button class="button primary" type="submit" form="workspace-date-form">应用日期</button>`);
}
async function setWorkspaceDate(date) {
  planWeekOffset = 0;
  calendarMonth = calendarSelectedDate = undefined;
  await run('/api/workspace/date', { date }, date ? '已切换工作区日期' : '已回到今天');
  closeModal();
}

document.addEventListener('click', e => {
  const target = e.target.closest('[data-action]'); if (!target) return;
  const { action:a, id } = target.dataset;
  guard(async () => {
    if (a === 'close') return closeModal();
    if (a === 'scenarios') return scenariosModal();
    if (a === 'import') return ai.openImport();
    if (a === 'automation') return ai.openAutomation();
    if (a === 'add-task' && state.studentWorkspace) return addTaskModal();
    if (a === 'settings') return ai.openSettings();
    if (a === 'questions') return ai.showQuestions();
    if (a === 'detail') return taskModal(id);
    if (a === 'edit-task') return editModal(id);
    if (a === 'profile') return profileModal();
    if (a === 'busy') return busyModal();
    if (a === 'clock') return clockModal();
    if (a === 'workspace-date' && state.studentWorkspace) return workspaceDateModal();
    if (a === 'set-workspace-date' && state.studentWorkspace) return setWorkspaceDate(id || null);
    if (a === 'calendar-month') {
      calendarMonth = shiftMonth(calendarMonth || localDate(state.now).slice(0,7), Number(id));
      return render();
    }
    if (a === 'calendar-today') { calendarMonth = undefined; return render(); }
    if (a === 'calendar-open-week') {
      const today = localDate(state.now);
      planWeekOffset = Math.round((ms(atLocal(weekStart(id),'00:00')) - ms(atLocal(weekStart(today),'00:00'))) / (7 * 24 * 60 * MINUTE));
      calendarSelectedDate = id;
      planView = 'week';
      render();
      $('#plan-calendar')?.focus({preventScroll:true});
      return;
    }
    if (a === 'calendar-week') { planWeekOffset += Number(id); calendarSelectedDate = undefined; return render(); }
    if (a === 'calendar-reset') { planWeekOffset = 0; calendarSelectedDate = undefined; return render(); }
    if (a === 'plan-view') { planView = id || (planView === 'list' ? 'week' : 'list'); return render(); }
    if (a === 'notice-filter') { noticeFilter = id; return render(); }
    if (a === 'notice-type') { noticeType = id; return render(); }
    if (a === 'plan') { await event('PLAN_REQUESTED',{},'计划已更新'); closeModal(); if (tab !== 'overview') return go('plan'); }
    if (a === 'demo-event') { await run('/api/demo/event',{},'演示事件已更新'); return; }
    if (a === 'next-notice') {
      const n = state.notifications.filter(n => n.status === 'pending' && ms(n.deliverAt)>ms(state.now)).sort((a,b) => ms(a.deliverAt)-ms(b.deliverAt))[0];
      if (!n) return toast('暂无待触发提醒');
      await event('CLOCK_ADVANCED',{to:n.deliverAt},'提醒已触发'); closeModal(); return go('reminders');
    }
    if (a === 'advance') { await event('CLOCK_ADVANCED',{minutes:Number(id)}); return clockModal(); }
    if (a === 'confirm') { await event('STATUS_RECORDED',{taskId:id,value:'user_confirmed',origin:'user'},'已记录完成，安排和提醒已更新'); return closeModal(); }
    if (a === 'progress' && state.studentWorkspace) { await event('STATUS_RECORDED',{taskId:id,value:taskOf(id).status.value==='draft'?'unknown':'draft',origin:'user'},'进度已更新'); return taskModal(id); }
    if (a === 'defer') { await event('TASK_DEFERRED',{taskId:id,until:atLocal(nextDate(localDate(state.now)),'19:00')},'已推迟准备'); return taskModal(id); }
    if (a === 'pause') { await event('REMINDER_PREFERENCE',{taskId:id,paused:!taskOf(id).paused}); return taskModal(id); }
    if (a === 'read') return event('NOTICE_READ',{notificationId:id});
    if (a === 'read-all') {
      const events = state.notifications.filter(notice => notice.status === 'delivered')
        .map(notice => ({id:crypto.randomUUID(),type:'NOTICE_READ',notificationId:notice.id}));
      if (events.length) return run('/api/events',{events},'提醒已标为已读');
    }
    if (a === 'snooze') return event('REMINDER_PREFERENCE',{taskId:id,until:iso(ms(state.now)+120*MINUTE)},'后续提醒延后 2 小时');
    if (a === 'lock') return event('BLOCK_LOCKED',{blockId:id,locked:!state.plan.blocks.find(b => b.id===id).locked});
    if (a === 'remove-busy') return event('PROFILE_UPDATED',{profile:{busy:state.profile.busy.filter((_,i) => i!==Number(id))}});
  });
});
document.addEventListener('submit', e => {
  const form = e.target, ids = ['scenario-form','profile-form','busy-form','edit-task-form','feedback-form','ai-command-form','add-task-form','workspace-date-form'];
  if (!ids.includes(form.id)) return;
  e.preventDefault(); const data = new FormData(form);
  guard(async () => {
    if (form.id === 'workspace-date-form') return setWorkspaceDate(data.get('date'));
    if (form.id === 'scenario-form') { planWeekOffset = 0; await run('/api/import',{scenario:data.get('scenario')}); closeModal(); taskFilter='open'; search=''; return go('tasks'); }
    if (form.id === 'ai-command-form') return ai.previewCommand(data.get('instruction'),state.studentWorkspace || data.has('previewOnly'));
    if (form.id === 'add-task-form') {
      await run('/api/tasks',{courseCode:data.get('courseCode'),title:data.get('title'),deadline:localISO(data.get('deadline')),remainingMinutes:Number(data.get('remainingMinutes'))},'任务已添加，计划和提醒已更新');
      search=''; taskFilter='open'; planWeekOffset=0; closeModal(); return render();
    }
    if (form.id === 'profile-form') {
      const p = state.profile, profile = { availability:[0,1,2,3,4,5,6].filter(d => data.has(`day-${d}`)).map(day => ({day,start:data.get(`start-${day}`),end:data.get(`end-${day}`)})), sections:{...p.sections}, devices:{...p.devices}, quiet:{start:data.get('quietStart'),end:data.get('quietEnd')} };
      for (const key of ['dailyLimitMinutes','blockMinutes','bufferMinutes','breakMinutes']) profile[key] = Number(data.get(key));
      for (const [key,value] of data.entries()) { if (key.startsWith('section:')) profile.sections[key.slice(8)] = value.trim(); if (key.startsWith('device:')) profile.devices[key.slice(7)] = value; }
      await event('PROFILE_UPDATED',{profile},'空闲时间已保存'); return closeModal();
    }
    if (form.id === 'busy-form') { await event('PROFILE_UPDATED',{profile:{busy:[...state.profile.busy,{title:data.get('title'),start:localISO(data.get('start')),end:localISO(data.get('end'))}]}},'已有安排已添加'); return closeModal(); }
    if (form.id === 'feedback-form') { await event('EFFORT_FEEDBACK_RECORDED',{taskId:form.dataset.task,actualMinutes:Number(data.get('actualMinutes'))},'用时反馈已保存'); return taskModal(form.dataset.task); }
    const id = form.dataset.task, t = taskOf(id), fixed = fixedFor(t,state.profile), patch = {remainingMinutes:Number(data.get('remainingMinutes'))}, when = data.get('when'), end = data.get('end');
    if (timeMode(t)) {
      if ((when&&!end)||(!when&&end)) throw new Error('请填完整的开始和结束时间');
      if (when && (ms(localISO(when))!==ms(fixed?.start) || ms(localISO(end))!==ms(fixed?.end))) { patch.fixed={start:localISO(when),end:localISO(end),origin:'user_confirmed'}; patch.sectionOptions=null; }
    } else if (when && ms(localISO(when))!==ms(t.deadline?.at)) patch.deadline={at:localISO(when),date:when.slice(0,10),precision:'minute',origin:'user_confirmed'};
    await event('TASK_CHANGED',{taskId:id,patch,message:'任务安排已调整'}); taskModal(id);
  });
});
document.addEventListener('input', e => { if (e.target.id === 'search') { search=e.target.value; const start=e.target.selectionStart; render(); $('#search').focus(); $('#search').setSelectionRange(start,start); } });
document.addEventListener('change', e => { if (e.target.id === 'task-filter') { taskFilter=e.target.value; render(); } });
$('#task-dialog').addEventListener('click', e => { if (e.target === $('#task-dialog')) { const r=e.target.getBoundingClientRect(); if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)closeModal(); } });
window.addEventListener('hashchange', render);
try { state = await request('/api/state'); render(); }
catch(error) { $('#main').innerHTML=empty('暂时没有连上服务',esc(error.message)); }
setInterval(async () => {
  if (!state || busy || tab === 'chat' || $('#task-dialog').open) return;
  try { const next=await request('/api/state'); if (JSON.stringify(next)!==JSON.stringify(state) && !['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName)) {state=next;render();} } catch { /* Keep the current view until the next poll. */ }
}, 3000);
