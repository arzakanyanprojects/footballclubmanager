// A «Հաշվետվություններ» report as an Excel file, built in the main process when an automation's email with
// that report is sent (outbox.attachment: { report, period, from, to }). The same sheet as the Reports window
// exports (electron/reportSheets.mjs), in Armenian.
const { buildTable } = require('./xlsx');
const { sheetOf, translator, reportLabel } = require('./reportSheets.mjs');
const { dictionaries } = require('./locales.mjs');

const localToday = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** → { filename, content: Buffer } */
async function buildReportAttachment(service, spec, lang = 'hy') {
  const t = translator(dictionaries, lang);
  const rows = service.outbox.reportRows({ kind: spec.report, period: spec.period, from: spec.from, to: spec.to });
  const sheet = sheetOf(spec.report, rows || [], t);
  const { title, when } = reportLabel(spec, t, localToday());
  const club = service.settings();
  const currency = club.currency || 'AMD';
  const content = await buildTable({
    sheetName: title,
    title: `${club.club_name || 'FC Manager'} — ${title}`,
    subtitle: [when, t('reportsx.rows', { n: sheet.rows.length })].join(' · '),
    columns: sheet.columns,
    rows: sheet.rows,
    totalLabel: t('reports.grandTotal'),
    currencySymbol: currency === 'AMD' ? '֏' : currency,
  });
  return { filename: `${title} ${when}.xlsx`.replace(/[\\/:*?"<>|]/g, '_'), content: Buffer.from(content) };
}

module.exports = { buildReportAttachment };
