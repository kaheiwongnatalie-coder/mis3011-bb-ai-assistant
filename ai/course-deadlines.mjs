import { slug } from '../core/model.mjs';
import { applyEvent } from '../core/engine.mjs';
import { hash } from './documents.mjs';

// A page snapshot has no publication timestamp. Use it to fill missing facts,
// but leave explicit dates from dated announcements or personal edits intact.
export function syncCourseDeadlines(state, documents) {
  if (!state.automation?.enabled) return state;
  const subscriptions = new Set(state.automation.subscriptions.map(course => `${course.courseCode}:${course.term}`));
  const updates = [];
  for (const document of documents) {
    const { assessment, courseCode, term } = document;
    const scope = `${courseCode}:${term}`;
    if (!assessment || !subscriptions.has(scope)) continue;
    const id = `${scope}:${document.contentId || document.id}`;
    const matches = state.tasks.filter(task => task.courseCode === courseCode && task.term === term &&
      task.kind === assessment.kind && (task.id === id || slug(task.title) === slug(document.title) ||
        (document.contentId && task.sources.some(source => source.contentId === document.contentId))));
    if (matches.length > 1) continue;
    const existing = matches[0];
    const known = existing?.deadline;
    if (known?.origin === 'user_confirmed' || known?.precision === 'conflict' ||
        (known?.at && known.origin !== 'course_page') ||
        (known?.date && known.origin !== 'course_page' && known.date !== assessment.deadline.date)) continue;
    const deadline = { ...assessment.deadline, origin: 'course_page' };
    const proof = { documentId: document.id, contentId: document.contentId, path: assessment.path,
      locator: assessment.locator, quote: assessment.quote, role: 'course_page' };
    if (JSON.stringify(known) === JSON.stringify(deadline) &&
        existing.sources.some(source => JSON.stringify(source) === JSON.stringify(proof))) continue;
    const sources = [...(existing?.sources || []).filter(source => source.role !== 'course_page' || source.documentId !== document.id), proof];
    const aiUncertainties = (existing?.aiUncertainties || []).filter(issue => issue.field !== 'deadlineDate' && (issue.field !== 'deadlineAt' || !deadline.at));
    const resolved = (existing?.aiUncertainties || []).filter(issue => !aiUncertainties.includes(issue));
    const issues = (existing?.issues || []).filter(issue => !resolved.some(item => item.question === issue));
    updates.push(existing ? { id: existing.id, deadline, sources, issues, aiUncertainties } : {
      id, courseCode, term, title: document.title, kind: assessment.kind, channel: 'bb', deadline, sources,
      remainingMinutes: assessment.kind === 'quiz' ? 30 : 90, estimateOrigin: 'default_estimate',
      splittable: assessment.kind !== 'quiz'
    });
  }
  if (!updates.length) return state;
  return applyEvent(state, { id: `course-deadlines:${hash([state.events.length, updates])}`, type: 'TASKS_UPSERTED', tasks: updates });
}
