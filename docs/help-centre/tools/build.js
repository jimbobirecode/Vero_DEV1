const fs = require('fs');
const path = require('path');
const {
  Document, Packer, Paragraph, TextRun, ImageRun, Table, TableRow, TableCell,
  WidthType, ShadingType, BorderStyle, AlignmentType, HeadingLevel, PageBreak,
  LevelFormat, convertInchesToTwip, TableLayoutType,
} = require('docx');

const DIR = __dirname;
const SHOTS = path.join(DIR, '..', 'screenshots');
const content = require('./content');

// Club Vero brand identity, taken from the dashboard's own tokens.
const FOREST = '16302A';
const BRASS = 'B08A4E';
const IVORY = 'F5F2EA';
const SAGE = '4F7359';
const INK = '20241F';
const INK_SOFT = '5B6259';
const LINE = 'E4DFD1';

const SERIF = 'Georgia';
const SANS = 'Calibri';

const CONTENT_W = 9360; // twips: 8.5in page - 1in margins each side = 6.5in

// PNG dimensions come out of the IHDR chunk, so an image is never stretched to
// an assumed aspect ratio — the sign-in shot is a crop and is not 3:2 like the
// full-screen captures.
const pngSize = (buf) => ({ w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) });

const img = (file, maxWidthPx) => {
  const data = fs.readFileSync(path.join(SHOTS, file));
  const { w, h: nh } = pngSize(data);
  const aspect = w / nh;
  // A tall image at full content width would push its own steps onto the next
  // page, so portrait-ish captures are set narrower.
  const widthPx = aspect < 1.25 ? Math.min(maxWidthPx, 360) : maxWidthPx;
  const h = Math.round(widthPx / aspect);
  return new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { before: 200, after: 60 },
    children: [new ImageRun({ type: 'png', data, transformation: { width: widthPx, height: h } })],
  });
};

const caption = (text) => new Paragraph({
  alignment: AlignmentType.CENTER,
  spacing: { after: 240 },
  children: [new TextRun({ text, italics: true, size: 17, color: INK_SOFT, font: SANS })],
});

const label = (text) => new Paragraph({
  spacing: { before: 360, after: 60 },
  children: [new TextRun({ text, bold: true, size: 15, color: BRASS, font: SANS, characterSpacing: 30 })],
});

const meta = (key, value) => new Paragraph({
  spacing: { after: 60 },
  children: [
    new TextRun({ text: key + ':  ', bold: true, size: 19, color: FOREST, font: SANS }),
    new TextRun({ text: value, size: 19, color: INK, font: SANS }),
  ],
});

const body = (text, opts = {}) => new Paragraph({
  spacing: { after: opts.after ?? 120 },
  children: [new TextRun({ text, size: 21, color: INK, font: SANS })],
});

const step = (text) => new Paragraph({
  numbering: { reference: 'steps', level: 0 },
  spacing: { after: 80 },
  children: [new TextRun({ text, size: 21, color: INK, font: SANS })],
});

// A single-cell shaded box with a brass rule down its left edge.
const callout = (heading, text) => new Table({
  width: { size: CONTENT_W, type: WidthType.DXA },
  columnWidths: [CONTENT_W],
  layout: TableLayoutType.FIXED,
  borders: {
    top: { style: BorderStyle.NONE }, bottom: { style: BorderStyle.NONE },
    right: { style: BorderStyle.NONE }, insideHorizontal: { style: BorderStyle.NONE },
    insideVertical: { style: BorderStyle.NONE },
    left: { style: BorderStyle.SINGLE, size: 18, color: BRASS },
  },
  rows: [new TableRow({
    children: [new TableCell({
      width: { size: CONTENT_W, type: WidthType.DXA },
      shading: { type: ShadingType.CLEAR, fill: IVORY, color: 'auto' },
      margins: { top: 140, bottom: 140, left: 200, right: 200 },
      children: [new Paragraph({
        children: [
          new TextRun({ text: heading + '  ', bold: true, size: 17, color: BRASS, font: SANS, characterSpacing: 30 }),
          new TextRun({ text, size: 19, color: INK, font: SANS }),
        ],
      })],
    })],
  })],
});

// Two-column reference table with a forest header row.
const refTable = (headers, rows, widths) => new Table({
  width: { size: CONTENT_W, type: WidthType.DXA },
  columnWidths: widths,
  layout: TableLayoutType.FIXED,
  borders: {
    top: { style: BorderStyle.SINGLE, size: 2, color: LINE },
    bottom: { style: BorderStyle.SINGLE, size: 2, color: LINE },
    left: { style: BorderStyle.NONE }, right: { style: BorderStyle.NONE },
    insideHorizontal: { style: BorderStyle.SINGLE, size: 2, color: LINE },
    insideVertical: { style: BorderStyle.NONE },
  },
  rows: [
    new TableRow({
      tableHeader: true,
      children: headers.map((h, i) => new TableCell({
        width: { size: widths[i], type: WidthType.DXA },
        shading: { type: ShadingType.CLEAR, fill: FOREST, color: 'auto' },
        margins: { top: 100, bottom: 100, left: 160, right: 160 },
        children: [new Paragraph({ children: [new TextRun({ text: h, bold: true, size: 15, color: IVORY, font: SANS, characterSpacing: 30 })] })],
      })),
    }),
    ...rows.map(cells => new TableRow({
      children: cells.map((c, i) => new TableCell({
        width: { size: widths[i], type: WidthType.DXA },
        margins: { top: 110, bottom: 110, left: 160, right: 160 },
        children: [new Paragraph({
          children: [new TextRun({ text: c, size: 19, color: i === 0 ? FOREST : INK, bold: i === 0, font: SANS })],
        })],
      })),
    })),
  ],
});

/* ---------------------------------------------------------------- cover */
const cover = [
  new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { before: 2200, after: 500 },
    children: [new ImageRun({
      type: 'png',
      data: fs.readFileSync(path.join(DIR, 'logo.png')),
      transformation: { width: 310, height: 74 },
    })],
  }),
  new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: 140 },
    children: [new TextRun({ text: 'HELP CENTRE', bold: true, size: 19, color: BRASS, font: SANS, characterSpacing: 90 })],
  }),
  new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: 180 },
    children: [new TextRun({ text: 'User Guide', size: 76, color: FOREST, font: SERIF })],
  }),
  new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: 900 },
    children: [new TextRun({ text: 'Step-by-step guidance for club managers and department leaders', size: 23, color: INK_SOFT, font: SANS })],
  }),
  new Paragraph({
    alignment: AlignmentType.CENTER,
    border: { top: { style: BorderStyle.SINGLE, size: 6, color: LINE } },
    spacing: { before: 200, after: 120 },
    children: [],
  }),
  new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: 60 },
    children: [new TextRun({ text: 'Publication edition · ' + content.edition, size: 19, color: INK_SOFT, font: SANS })],
  }),
  new Paragraph({
    alignment: AlignmentType.CENTER,
    children: [new TextRun({ text: 'The truth behind every visit', italics: true, size: 19, color: BRASS, font: SERIF })],
  }),
  new Paragraph({ children: [new PageBreak()] }),
];

/* ------------------------------------------------------- how to use it */
const intro = [
  new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun({ text: 'How to use this guide', size: 40, color: FOREST, font: SERIF })], spacing: { after: 200 } }),
  body('This handbook follows the order a club team actually works in: get oriented, keep the member and visit records right, act on what comes back, run golf and events, then configure the system behind it.', { after: 200 }),
  body('Every article names the exact menu path to the screen it describes, and every screenshot is taken from the Club Vero dashboard itself. Where the menu name and the screen title differ — Overview is titled Member Experience, for instance — the menu name is the one to navigate by.', { after: 280 }),
  refTable(
    ['SECTION', 'WHAT IT COVERS'],
    content.sections.map(s => [s.number + '. ' + s.title, s.intro]),
    [2600, 6760],
  ),
  new Paragraph({ spacing: { before: 320 }, children: [] }),
  callout('BEFORE YOU START',
    'Screenshots in this edition were taken from the Club Vero dashboard signed in as a General Manager, using demonstration data for a single club. Your own club name, outlets and figures will differ; the layout, the menu names and the buttons will not.'),
  new Paragraph({ children: [new PageBreak()] }),
];

/* ----------------------------------------------------------- articles */
const articleBlocks = [];
content.sections.forEach((section, si) => {
  if (si > 0) articleBlocks.push(new Paragraph({ children: [new PageBreak()] }));

  articleBlocks.push(new Paragraph({
    spacing: { after: 60 },
    children: [new TextRun({ text: 'SECTION ' + section.number, bold: true, size: 15, color: BRASS, font: SANS, characterSpacing: 60 })],
  }));
  articleBlocks.push(new Paragraph({
    heading: HeadingLevel.HEADING_1,
    spacing: { after: 140 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 8, color: BRASS, space: 6 } },
    children: [new TextRun({ text: section.title, size: 40, color: FOREST, font: SERIF })],
  }));
  articleBlocks.push(body(section.intro, { after: 240 }));

  section.articles.forEach((a, ai) => {
    if (ai > 0) articleBlocks.push(new Paragraph({ children: [new PageBreak()] }));

    articleBlocks.push(label('HELP ARTICLE ' + a.n));
    articleBlocks.push(new Paragraph({
      heading: HeadingLevel.HEADING_2,
      spacing: { after: 160 },
      children: [new TextRun({ text: a.title, size: 30, color: FOREST, font: SERIF })],
    }));
    articleBlocks.push(meta('Purpose', a.purpose));
    articleBlocks.push(meta('Where to find it', a.where));

    if (a.image) {
      articleBlocks.push(img(a.image, 600));
      articleBlocks.push(caption(a.caption));
    }

    articleBlocks.push(new Paragraph({
      heading: HeadingLevel.HEADING_3,
      spacing: { before: 120, after: 120 },
      children: [new TextRun({ text: 'Steps', size: 22, color: BRASS, font: SANS, bold: true, characterSpacing: 30 })],
    }));
    a.steps.forEach(s => articleBlocks.push(step(s)));

    if (a.extraImage) {
      articleBlocks.push(img(a.extraImage, 600));
      articleBlocks.push(caption(a.extraCaption));
    }

    articleBlocks.push(new Paragraph({ spacing: { before: 200 }, children: [] }));
    articleBlocks.push(callout('GOOD PRACTICE', a.practice));
  });
});

/* ---------------------------------------------------- troubleshooting */
const trouble = [
  new Paragraph({ children: [new PageBreak()] }),
  new Paragraph({
    heading: HeadingLevel.HEADING_1,
    spacing: { after: 140 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 8, color: BRASS, space: 6 } },
    children: [new TextRun({ text: 'Quick troubleshooting', size: 40, color: FOREST, font: SERIF })],
  }),
  body('Each of these is answered by a screen rather than by a support ticket. Work down the path in the right-hand column and stop at the first thing that looks wrong.', { after: 240 }),
  refTable(['IF THIS HAPPENS', 'WHERE TO LOOK'], content.troubleshooting, [3100, 6260]),
];

/* -------------------------------------------------- publishing notes */
const publishing = [
  new Paragraph({ children: [new PageBreak()] }),
  new Paragraph({
    heading: HeadingLevel.HEADING_1,
    spacing: { after: 140 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 8, color: BRASS, space: 6 } },
    children: [new TextRun({ text: 'Publishing notes for the Help Centre', size: 40, color: FOREST, font: SERIF })],
  }),
  body('The 23 help articles in this handbook are written to stand alone, so each one can become a single searchable article on the Help Centre site. Keep the five section names as the top-level categories — they match the five menu groups in the product, which is what a user is looking at when they go looking for help.', { after: 160 }),
  body('Each article already carries the two things a Help Centre article needs at the top: what it is for, and the exact menu path to the screen. Keep both when the articles are moved onto the site.', { after: 240 }),
  callout('MAINTENANCE',
    'When a screen changes, update that one article and re-take its screenshot rather than rewriting the handbook. The screenshots here were taken from the dashboard build of ' + content.edition + '; if a menu name changes, search this document for the old name — the menu paths are written out in full in every article, so nothing is left implied.'),
  new Paragraph({ spacing: { before: 700 }, alignment: AlignmentType.CENTER, children: [
    new TextRun({ text: 'Club Vero  ·  Member Experience Intelligence  ·  ', size: 17, color: INK_SOFT, font: SANS }),
    new TextRun({ text: 'The truth behind every visit', size: 17, color: BRASS, italics: true, font: SERIF }),
  ] }),
  new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 60 }, children: [
    new TextRun({ text: 'Interface checked against the Club Vero dashboard build of ' + content.edition + '.', size: 15, color: INK_SOFT, font: SANS }),
  ] }),
];

/* ------------------------------------------------------------ assemble */
const doc = new Document({
  creator: 'Club Vero',
  title: 'Club Vero Help Centre — User Guide',
  description: 'Step-by-step guidance for club managers and department leaders',
  numbering: {
    config: [{
      reference: 'steps',
      levels: [{
        level: 0,
        format: LevelFormat.DECIMAL,
        text: '%1',
        alignment: AlignmentType.LEFT,
        style: {
          run: { color: BRASS, bold: true, font: SANS, size: 21 },
          paragraph: { indent: { left: convertInchesToTwip(0.42), hanging: convertInchesToTwip(0.28) } },
        },
      }],
    }],
  },
  styles: {
    default: {
      document: { run: { font: SANS, size: 21, color: INK } },
    },
  },
  sections: [{
    properties: {
      page: {
        size: { width: 12240, height: 15840 },
        margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 },
      },
    },
    children: [...cover, ...intro, ...articleBlocks, ...trouble, ...publishing],
  }],
});

Packer.toBuffer(doc).then(buf => {
  const out = path.join(DIR, '..', 'Club_Vero_Help_Centre_User_Guide.docx');
  fs.writeFileSync(out, buf);
  console.log('wrote', out, buf.length, 'bytes');
});
