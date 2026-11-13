import { createHash } from 'node:crypto';
import { extractDeadline, parsePosted, validTime } from '../core/time.mjs';

export const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex').slice(0, 20);
const flatten = value => typeof value === 'string' ? value : Array.isArray(value) ? value.map(flatten).join('\n') : value && typeof value === 'object' ? Object.values(value).map(flatten).join('\n') : '';

export function prepareDocument(input) {
  const courseCode = String(input.courseCode || '').trim(), term = String(input.term || '').trim();
  const text = String(input.text || '').trim(), title = String(input.title || '导入材料').trim();
  if (!courseCode || !term || !text) throw new Error('资料需要课程代码、学期年份和正文。');
  if (input.publishedAt && !validTime(input.publishedAt)) throw new Error('资料发布时间无效。');
  const id = input.id || `${courseCode}:${term}:document:${hash(title)}`;
  return { id, courseCode, term, title, text, publishedAt: input.publishedAt || null,
    sourcePath: input.sourcePath || '用户导入资料', locator: input.locator || title,
    contentId: input.contentId || null, type: input.type || 'pasted',
    version: hash([text, input.publishedAt || null]) };
}

export function buildDocuments(feed) {
  const result = [];
  for (const course of feed.courses) {
    const years = course.ann.map(a => parsePosted(a.posted)?.slice(0, 4)).filter(Boolean);
    const term = years.sort((a, b) => years.filter(y => y === b).length - years.filter(y => y === a).length)[0];
    if (!term) continue;
    for (const [i, a] of course.ann.entries()) result.push(prepareDocument({
      id: `${course.code}:${term}:announcement:${hash([a.title, a.posted])}`,
      courseCode: course.code, term, title: a.title, text: a.body, publishedAt: parsePosted(a.posted),
      sourcePath: `courses/${course.code}.json`, locator: `ann[${i}]`, type: 'announcement'
    }));
    for (const [pi, page] of course.pages.entries()) for (const [ri, row] of page.rows.entries()) {
      if (!row.body?.trim()) continue;
      const assessment = row.links.find(l => /uploadAssignment|launchAssessment/.test(l.u));
      const link = assessment || row.links[0];
      const contentId = link && new URL(link.u).searchParams.get('content_id');
      const document = prepareDocument({ id: `${course.code}:${term}:content:${contentId || hash([page.u, row.title])}`,
        courseCode: course.code, term, title: row.title, text: `${row.title}\n${row.body}`,
        sourcePath: `courses/${course.code}.json`, locator: `pages[${pi}].rows[${ri}]`, contentId, type: 'content' });
      if (assessment && !/last year|practice|solution|answer/i.test(`${page.n} ${row.title}`)) {
        const candidates = [{ text: row.body, sourcePath: document.sourcePath, locator: document.locator }];
        for (const ref of row.links) {
          const file = (feed.attachments[course.code] || []).find(a => a.sourceUrl === ref.u && a.contentFile && !/answer|solution/i.test(a.name));
          if (file) candidates.push({text: flatten(feed.texts[file.contentFile]), sourcePath: file.contentFile, locator: file.name});
        }
        const evidence = candidates.flatMap(candidate => candidate.text.split('\n').flatMap(quote => {
          if (!/\b(?:due\s+(?:at|on|by)|deadline\s*[:：]|submission deadline\s+is)\b|\bdeadline\s*[:：]/i.test(quote) ||
              /\blate submission\b.*\bdue\b|\bafter the deadline\b/i.test(quote)) return [];
          const deadline = extractDeadline(quote, term);
          return deadline ? [{ deadline, quote: quote.trim(), path: candidate.sourcePath, locator: candidate.locator }] : [];
        }));
        const first = evidence.find(e => e.deadline.at) || evidence[0];
        if (first && evidence.every(e => e.deadline.date === first.deadline.date && (!e.deadline.at || e.deadline.at === first.deadline.at))) {
          document.assessment = { kind: /launchAssessment/.test(assessment.u) ? 'quiz' : 'assignment', ...first };
        }
      }
      result.push(document);
    }
    for (const a of feed.attachments[course.code] || []) {
      // Do not send grade rows, submission history, rosters or binary files to the model.
      if (a.contentStatus !== 'text_extracted' || !a.contentFile) continue;
      const text = flatten(feed.texts[a.contentFile]);
      if (!text.trim()) continue;
      result.push(prepareDocument({ id: `${course.code}:${term}:file:${hash(a.sourceUrl)}`, courseCode: course.code, term,
        title: a.name, text, sourcePath: a.contentFile, locator: '附件抽取文字（页码／段落仍在原文件）', type: 'attachment' }));
    }
  }
  return result;
}

export function documentsFromUpload(value) {
  if (Array.isArray(value.documents)) return value.documents.map(prepareDocument);
  if (value.code && Array.isArray(value.ann) && Array.isArray(value.pages)) {
    return buildDocuments({ courses: [value], attachments: { [value.code]: [] }, texts: {} });
  }
  return [prepareDocument(value)];
}

export const documentSummary = doc => ({ ...doc, text: undefined, characters: doc.text.length });
