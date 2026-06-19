#!/usr/bin/env node
// Generates a static resume HTML page from resume.json.
// Usage: node build.js > index.html

const fs = require('node:fs');
const path = require('node:path');

const PROJECTS_VISIBLE = 3;

const data = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'resume.json'), 'utf8'));
const site = data.basics?.url;

// ---------- helpers ----------

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'
})[c]);

const fmtDate = (s) => {
  if (!s) return '';
  const [y, m] = s.split('-');
  return m ? `${MONTHS[parseInt(m, 10) - 1]} ${y}` : y;
};

const range = (start, end) => {
  const s = fmtDate(start), e = end ? fmtDate(end) : (start ? 'Present' : '');
  return s && e ? `${s} – ${e}` : s || e;
};

const link = (href, text) => {
  const isSameSite = site && (href === site || href.startsWith(site + '/'));
  if (isSameSite) {
    const relHref = href === site ? '/' : href.slice(site.length);
    return `<a href="${esc(relHref)}">${esc(text)}</a>`;
  }
  return `<a href="${esc(href)}" target="_blank" rel="noopener">${esc(text)}</a>`;
};

const timeTag = (datetime, text) =>
  datetime ? `<time datetime="${esc(datetime)}">${esc(text)}</time>` : esc(text);

// Renders a date range with proper <time> markup
const rangeMarked = (start, end) => {
  const startTxt = fmtDate(start);
  const endTxt = end ? fmtDate(end) : (start ? 'Present' : '');
  if (!startTxt && !endTxt) return '';
  if (!start) return endTxt;
  const left = timeTag(start, startTxt);
  const right = end ? timeTag(end, endTxt) : 'Present';
  return `${left} – ${right}`;
};

const metaWithDuration = (start, end) => {
  const r = rangeMarked(start, end);
  if (!start) return r;
  const endAttr = end ? ` data-duration-end="${esc(end)}"` : '';
  return `${r}<span class="duration" data-duration-start="${esc(start)}"${endAttr}></span>`;
};

const renderDurationScript = () => `<script>
(() => {
  const duration = (start, end) => {
    if (!start) return '';
    const [sy, sm = '1'] = start.split('-');
    const now = new Date();
    const [ey, em] = end ? end.split('-') : [String(now.getFullYear()), String(now.getMonth() + 1)];
    const total = (Number(ey) - Number(sy)) * 12 + (Number(em) - Number(sm));
    if (total < 0) return '';
    if (total < 12) return total + ' ' + (total === 1 ? 'mo' : 'mos');
    const yrs = Math.round((total / 12) * 2) / 2;
    return (Number.isInteger(yrs) ? String(yrs) : yrs.toFixed(1)) + ' ' + (yrs === 1 ? 'yr' : 'yrs');
  };

  document.querySelectorAll('[data-duration-start]').forEach((el) => {
    const text = duration(el.dataset.durationStart, el.dataset.durationEnd);
    if (text) el.textContent = ' · ' + text;
  });
})();
</script>`;

// ---------- sections ----------

function renderHeader(b) {
  if (!b) return '';
  const profileSpans = (b.profiles || [])
    .map(p => `<span>${link(p.url, `${p.network}: ${p.username}`)}</span>`)
    .join('');
  const contact = profileSpans
    ? `<address class="contact">${profileSpans}</address>`
    : '';
  const avatar = b.image
    ? `<img class="avatar" src="${esc(b.image)}" alt="${esc(b.name || '')}" width="88" height="88">`
    : '';
  return `
<header class="header">
  ${avatar}
  <div class="header-text">
    <h1>${esc(b.name || '')}</h1>
    ${b.label ? `<p class="label">${esc(b.label)}</p>` : ''}
    ${contact}
  </div>
</header>
${b.summary ? `<p class="summary">${esc(b.summary)}</p>` : ''}`;
}

function renderProject(p) {
  const titleHtml = p.url ? link(p.url, p.name) : esc(p.name);
  const meta = rangeMarked(p.startDate, p.endDate);
  const subParts = [p.entity, p.type, p.roles?.join(', ')].filter(Boolean).map(esc);
  return `
<article class="entry">
  <header class="entry-head">
    <h3>${titleHtml}</h3>
    <div class="entry-meta">${meta}</div>
  </header>
  ${subParts.length ? `<p class="entry-sub">${subParts.join(' · ')}</p>` : ''}
  ${p.description ? `<p class="entry-desc">${esc(p.description)}</p>` : ''}
  ${p.keywords?.length ? `<p class="entry-tags">${esc(p.keywords.join(' · '))}</p>` : ''}
</article>`;
}

function renderProjects(projects) {
  if (!projects?.length) return '';
  const visible = projects.slice(0, PROJECTS_VISIBLE).map(renderProject).join('');
  const hidden = projects.slice(PROJECTS_VISIBLE);
  const moreHtml = hidden.length
    ? `<details class="more">
  <summary><span class="more-show">View ${hidden.length} more</span><span class="more-hide">View less</span></summary>
  ${hidden.map(renderProject).join('')}
</details>`
    : '';
  return `
<section aria-labelledby="projects-h">
  <h2 id="projects-h">Projects</h2>
  ${visible}
  ${moreHtml}
</section>`;
}

function subLine(w, url) {
  const parts = [];
  if (url) parts.push(link(url, url.replace(/^https?:\/\//, '').replace(/\/$/, '')));
  if (w.location) parts.push(esc(w.location));
  if (!parts.length) return '';
  return `<p class="entry-sub">${parts.join(' · ')}</p>`;
}

function renderHighlights(items) {
  if (!items?.length) return '';
  return `<ul>${items.map(h => `<li>${esc(h)}</li>`).join('')}</ul>`;
}

function renderExperience(work) {
  if (!work?.length) return '';
  const groups = [];
  for (const w of work) {
    const last = groups[groups.length - 1];
    if (last && last.name === w.name) last.items.push(w);
    else groups.push({ name: w.name, url: w.url, items: [w] });
  }

  const subText = (w, url) => {
    const parts = [];
    if (url) parts.push(link(url, url.replace(/^https?:\/\//, '').replace(/\/$/, '')));
    if (w.location) parts.push(esc(w.location));
    return parts.join(' · ');
  };

  const inlineMore = (innerHtml, hasSubText) => innerHtml
    ? `<details class="inline-more"><summary>${hasSubText ? ' · ' : ''}<span class="more-text">View more</span></summary><div class="entry-body">
${innerHtml}
    </div></details>`
    : '';

  const subRow = (text, more) => (text || more)
    ? `<div class="entry-sub">${text}${more}</div>`
    : '';

  const groupHtml = groups.map(g => {
    const first = g.items[0];
    const last = g.items[g.items.length - 1];

    if (g.items.length === 1) {
      const w = first;
      const meta = metaWithDuration(w.startDate, w.endDate);
      const title = [g.name, w.position].filter(Boolean).join(' - ');
      const inner = [
        w.description ? `      <p class="entry-desc">${esc(w.description)}</p>` : '',
        w.summary ? `      <p class="entry-desc">${esc(w.summary)}</p>` : '',
        renderHighlights(w.highlights)
      ].filter(Boolean).join('\n');
      const text = subText(w, g.url);
      return `
<article class="entry">
  <header class="entry-head">
    <h3>${esc(title)}</h3>
    <div class="entry-meta">${meta}</div>
  </header>
  ${subRow(text, inlineMore(inner, !!text))}
</article>`;
    }

    const meta = metaWithDuration(last.startDate, first.endDate);
    const positions = g.items.map(w => `
      <div class="position">
        <header class="entry-head">
          <h4>${esc(w.position || '')}</h4>
          <div class="entry-meta">${rangeMarked(w.startDate, w.endDate)}</div>
        </header>
        ${w.summary ? `<p class="entry-desc">${esc(w.summary)}</p>` : ''}
        ${renderHighlights(w.highlights)}
      </div>`).join('');
    const innerMulti = [
      first.description ? `      <p class="entry-desc">${esc(first.description)}</p>` : '',
      positions
    ].filter(Boolean).join('\n');
    const text = subText(first, g.url);

    return `
<article class="entry">
  <header class="entry-head">
    <h3>${esc(g.name || '')}</h3>
    <div class="entry-meta">${meta}</div>
  </header>
  ${subRow(text, inlineMore(innerMulti, !!text))}
</article>`;
  }).join('');

  return `
<section aria-labelledby="experience-h">
  <h2 id="experience-h">Experience</h2>
  ${groupHtml}
</section>`;
}

function renderEducation(items) {
  if (!items?.length) return '';
  const html = items.map(e => {
    const title = [e.studyType, e.area].filter(Boolean).join(' in ') || e.institution;
    const subParts = [];
    if (e.institution && title !== e.institution) subParts.push(esc(e.institution));
    if (e.score) subParts.push(esc(e.score));
    return `
<article class="entry">
  <header class="entry-head">
    <h3>${esc(title)}</h3>
    <div class="entry-meta">${rangeMarked(e.startDate, e.endDate)}</div>
  </header>
  ${subParts.length ? `<p class="entry-sub">${subParts.join(' · ')}</p>` : ''}
  ${e.courses?.length ? `<ul>${e.courses.map(c => `<li>${esc(c)}</li>`).join('')}</ul>` : ''}
</article>`;
  }).join('');
  return `
<section aria-labelledby="education-h">
  <h2 id="education-h">Education</h2>
  ${html}
</section>`;
}

function renderPublications(items) {
  if (!items?.length) return '';
  const html = items.map(p => `
<article class="entry">
  <header class="entry-head">
    <h3>${p.url ? link(p.url, p.name) : esc(p.name)}</h3>
    <div class="entry-meta">${timeTag(p.releaseDate, fmtDate(p.releaseDate))}</div>
  </header>
  ${p.publisher ? `<p class="entry-sub">${esc(p.publisher)}</p>` : ''}
  ${p.summary ? `<p class="entry-desc">${esc(p.summary)}</p>` : ''}
</article>`).join('');
  return `
<section aria-labelledby="patents-h">
  <h2 id="patents-h">Patents &amp; Publications</h2>
  ${html}
</section>`;
}

function renderSkills(items) {
  if (!items?.length) return '';
  const rows = items
    .filter(s => s.keywords?.length || s.name)
    .map(s => `  <dt>${esc(s.name)}</dt>\n  <dd>${esc((s.keywords || []).join(', '))}</dd>`)
    .join('\n');
  return `
<section aria-labelledby="skills-h">
  <h2 id="skills-h">Skills</h2>
  <dl class="skills">
${rows}
  </dl>
</section>`;
}

function renderLanguages(items) {
  if (!items?.length) return '';
  const list = items
    .map(l => `${esc(l.language)} — ${esc(l.fluency)}`)
    .join(' · ');
  return `
<section aria-labelledby="languages-h">
  <h2 id="languages-h">Languages</h2>
  <p class="entry-sub">${list}</p>
</section>`;
}

// ---------- head / structured data ----------

function jsonLd(b) {
  const currentJob = (data.work || []).find(w => !w.endDate) || (data.work || [])[0];
  const employer = currentJob?.name;
  const employerUrl = currentJob?.url;
  const masters = (data.education || []).find(e => /master/i.test(e.studyType || ''));
  const obj = {
    '@context': 'https://schema.org',
    '@type': 'Person',
    name: b?.name,
    url: site,
    image: b?.image,
    sameAs: (b?.profiles || []).map(p => p.url)
  };
  if (currentJob?.position) obj.jobTitle = currentJob.position;
  if (employer) {
    obj.worksFor = { '@type': 'Organization', name: employer };
    if (employerUrl) obj.worksFor.url = employerUrl;
  }
  if (masters?.institution) {
    obj.alumniOf = { '@type': 'CollegeOrUniversity', name: masters.institution };
  }
  if (b?.summary) obj.description = b.summary;
  return JSON.stringify(obj, null, 2);
}

function renderHead(b) {
  const title = b?.name && b?.label
    ? `${b.name} — ${b.label}`
    : (b?.name || 'Resume');
  const desc = b?.summary || '';
  return `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<meta name="author" content="${esc(b?.name || '')}">
<link rel="canonical" href="${site}/">
<link rel="alternate" type="application/json" href="/resume.json" title="JSON Resume">
<meta property="og:type" content="profile">
<meta property="og:title" content="${esc(b?.name || '')}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${site}/">
<meta property="og:image" content="${esc(b?.image || '')}">
<meta name="twitter:card" content="summary">
<script type="application/ld+json">
${jsonLd(b)}
</script>
<link rel="stylesheet" href="style.css">`;
}

// ---------- compose ----------

const body = [
  renderHeader(data.basics),
  renderProjects(data.projects),
  renderExperience(data.work),
  renderEducation(data.education),
  renderPublications(data.publications),
  renderSkills(data.skills),
  renderLanguages(data.languages),
].filter(Boolean).join('\n');

const html = `<!DOCTYPE html>
<html lang="en">
<head>
${renderHead(data.basics)}
</head>
<body>
<main>
${body}
</main>
${renderDurationScript()}
</body>
</html>
`;

process.stdout.write(html);
