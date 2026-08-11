// Generates /vero-help.js — the article data the dashboard's Help screen reads.
//
// The point of generating it is that the printed guide and the in-app help
// cannot drift apart. Both come from content.js: change an article once, run
// this and build.js, and the .docx and the Help screen say the same thing.
const fs = require('fs');
const path = require('path');
const content = require('./content');

const OUT = path.join(__dirname, '..', '..', '..', 'vero-help.js');

// Only what the Help screen actually renders. The .docx-only fields (image
// widths, caption wording for the second screenshot) stay in content.js.
const data = {
  edition: content.edition,
  sections: content.sections.map(s => ({
    number: s.number,
    title: s.title,
    intro: s.intro,
    articles: s.articles.map(a => ({
      n: a.n,
      title: a.title,
      purpose: a.purpose,
      where: a.where,
      tab: a.tab || null,
      images: [a.image, a.extraImage].filter(Boolean),
      steps: a.steps,
      practice: a.practice,
    })),
  })),
  faq: content.troubleshooting.map(([question, answer]) => ({ question, answer })),
};

const banner = `/* Club Vero — in-app help content.
 *
 * GENERATED FILE. Do not edit by hand: run
 *   node docs/help-centre/tools/build-app-help.js
 * after editing docs/help-centre/tools/content.js, which is also what the
 * printed user guide is built from.
 *
 * Edition: ${content.edition}
 */
`;

fs.writeFileSync(OUT, banner + 'window.VERO_HELP = ' + JSON.stringify(data, null, 2) + ';\n');

const articles = data.sections.reduce((n, s) => n + s.articles.length, 0);
console.log(`wrote ${OUT} — ${articles} articles, ${data.faq.length} FAQ entries`);
