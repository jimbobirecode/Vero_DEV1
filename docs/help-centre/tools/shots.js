const { chromium } = require('playwright');

// Playwright finds its own browser when one is installed the usual way; this
// only kicks in on hosts that pre-stage Chromium somewhere else.
const CHROME = process.env.CHROMIUM_PATH ||
  ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome']
    .find(p => require('fs').existsSync(p));
const fs = require('fs');

const OUT = require('path').join(__dirname, '..', 'screenshots');
fs.mkdirSync(OUT, { recursive: true });

// `pre` runs before the shot; `scroll` brings a lower panel to the top.
const SHOTS = [
  { file: '01-signin', tab: null, clip: { x: 420, y: 180, width: 660, height: 640 } },
  { file: '02-overview', tab: 'overview' },
  { file: '03-members', tab: 'members', scroll: '#memberTable' },
  { file: '04-member-health', tab: 'members' },
  { file: '05-upload', tab: 'upload' },
  { file: '06-visits', tab: 'visits' },
  { file: '07-queue', tab: 'queue' },
  { file: '08-surveylog', tab: 'surveylog' },
  { file: '09-messagelog', tab: 'messagelog' },
  { file: '10-alerts', tab: 'alerts' },
  { file: '11-insights', tab: 'insights' },
  { file: '12-training', tab: 'training' },
  { file: '13-staff', tab: 'staff' },
  { file: '14-golf', tab: 'golf' },
  { file: '15-crossover', tab: 'golf', scroll: '#crossoverStrip' },
  { file: '16-teesheet', tab: 'golf', scrollText: 'Upload tee sheet' },
  { file: '17-events', tab: 'events' },
  { file: '18-builder', tab: 'builder' },
  { file: '19-settings', tab: 'settings' },
  { file: '20-settings-timing', tab: 'settings', scrollText: 'Survey delivery' },
  { file: '21-settings-team', tab: 'settings', scrollText: 'Team members' },
  { file: '22-billing', tab: 'billing' },
  { file: '23-reports', tab: 'reports', pre: () => { document.getElementById('reportRange').value = '90'; loadReport(); } },
  { file: '24-trends', tab: 'trends' },
  { file: '25-outlets', tab: 'outlets' },
];

(async () => {
  const b = await chromium.launch(CHROME ? { executablePath: CHROME } : {});
  const p = await b.newPage({ viewport: { width: 1500, height: 1000 }, deviceScaleFactor: 1.25 });
  const errs = [];
  p.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
  p.on('pageerror', e => errs.push('PAGEERROR ' + e.message));

  await p.goto('http://127.0.0.1:8900/vero-dashboard.html', { waitUntil: 'networkidle' });
  await p.waitForTimeout(1200);

  for (const s of SHOTS) {
    if (s.tab === null) {
      await p.screenshot({ path: `${OUT}/${s.file}.png`, clip: s.clip });
      await p.evaluate(async () => { await loadCurrentUser(); showApp(); });
      await p.waitForTimeout(1500);
      continue;
    }
    await p.evaluate(t => showTab(t), s.tab);
    await p.waitForTimeout(1300);
    if (s.pre) { await p.evaluate(s.pre); await p.waitForTimeout(1300); }

    if (s.scroll || s.scrollText) {
      await p.evaluate(({ sel, text }) => {
        let el = sel ? document.querySelector(sel) : null;
        if (!el && text) {
          el = [...document.querySelectorAll('.screen.active h2, .screen.active h3')]
            .find(h => h.textContent.trim().startsWith(text));
          if (el) el = el.closest('.panel') || el;
        }
        if (el) {
          const top = el.getBoundingClientRect().top + window.scrollY - 24;
          window.scrollTo(0, top);
        }
      }, { sel: s.scroll || null, text: s.scrollText || null });
      await p.waitForTimeout(500);
    } else {
      await p.evaluate(() => window.scrollTo(0, 0));
      await p.waitForTimeout(250);
    }
    await p.screenshot({ path: `${OUT}/${s.file}.png` });
  }

  fs.writeFileSync(`${OUT}/errors.txt`, [...new Set(errs)].join('\n'));
  console.log([...new Set(errs)].slice(0, 25).join('\n'));
  await b.close();
})();
