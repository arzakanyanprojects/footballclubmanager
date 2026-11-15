// Fills a Word (.docx) contract template. Templates mark blanks with {placeholders};
// anything left empty prints as a line to fill in by hand.
const PizZip = require('pizzip');
const Docxtemplater = require('docxtemplater');

const BLANK = '__________';
const MONTHS = ['հունվար', 'փետրվար', 'մարտ', 'ապրիլ', 'մայիս', 'հունիս', 'հուլիս', 'օգոստոս', 'սեպտեմբեր', 'հոկտեմբեր', 'նոյեմբեր', 'դեկտեմբեր'];
const CATEGORIES = { siblings: '2 և ավել երեխա', half: '50%', war: '44 օրյա/4 օրյա պատերազմի զոհ', staff: 'Աշխատակցի երեխա' };
// Monthly fees of the two paid packages in Annex 1 («Վճարային կարգավիճակ»).
const FEE_REGULAR = 30000;
const FEE_TEAM = 35000;
const CHECKED = '☒';
const UNCHECKED = '□';

// Every placeholder a template may use (shown in the app as help for making templates).
const PLACEHOLDERS = [
  'contract_no', 'sign_day', 'sign_month', 'sign_month_gen', 'sign_year', 'start_day', 'start_month', 'start_year',
  'student_name', 'student_birth_date', 'student_document_no', 'student_birth_doc', 'student_status', 'group_name',
  'monthly_fee', 'chk_regular', 'chk_team', 'parent_name', 'parent_doc_no', 'parent_doc_issuer', 'parent_doc_date',
  'parent_ssn', 'parent_address', 'parent_phone', 'parent_email',
];

const val = (v) => (v == null || String(v).trim() === '' ? undefined : String(v).trim());
const fmtDate = (iso) => (iso ? iso.slice(0, 10).split('-').reverse().join('.') : undefined);
const money = (n) => (n ? Number(n).toLocaleString('en-US').replace(/,/g, ' ') : undefined);

function dateParts(iso) {
  if (!iso) return {};
  const m = Number(iso.slice(5, 7));
  return { day: iso.slice(8, 10), month: MONTHS[m - 1], monthGen: `${MONTHS[m - 1]}ի`, year: iso.slice(0, 4) };
}

// Values for one contract, from the student's page and the contract's own dates and number.
function contractValues(student, contract) {
  const sign = dateParts(contract.contract_date);
  const start = dateParts(contract.start_date);
  const fee = Number(student.monthly_fee) || 0;
  return {
    contract_no: val(contract.number),
    sign_day: sign.day,
    sign_month: sign.month,
    sign_month_gen: sign.monthGen,
    sign_year: sign.year,
    start_day: start.day,
    start_month: start.month,
    start_year: start.year,
    student_name: val([student.first_name, student.last_name, student.patronymic].filter(Boolean).join(' ')),
    student_birth_date: fmtDate(student.birth_date),
    student_document_no: val(student.document_no),
    student_birth_doc: val([fmtDate(student.birth_date), student.document_no].filter(Boolean).join(' / ')),
    student_status: CATEGORIES[student.category] || '—',
    group_name: val(student.group_name),
    monthly_fee: money(fee),
    chk_regular: fee === FEE_REGULAR ? CHECKED : UNCHECKED,
    chk_team: fee === FEE_TEAM ? CHECKED : UNCHECKED,
    parent_name: val([student.parent_first_name, student.parent_last_name].filter(Boolean).join(' ')),
    parent_doc_no: val(student.parent_doc_no),
    parent_doc_issuer: val(student.parent_doc_issuer),
    parent_doc_date: fmtDate(student.parent_doc_date),
    parent_ssn: val(student.parent_ssn),
    parent_address: val(student.parent_address),
    parent_phone: val(student.parent_phone),
    parent_email: val(student.parent_email),
  };
}

const options = { paragraphLoop: true, linebreaks: true, nullGetter: () => BLANK };

function fillTemplate(templateBuffer, values) {
  const doc = new Docxtemplater(new PizZip(templateBuffer), options);
  doc.render(values);
  return doc.getZip().generate({ type: 'nodebuffer', compression: 'DEFLATE' });
}

// Throws if the file is not a usable .docx template (not a Word file, or a broken {field}).
function inspectTemplate(templateBuffer) {
  new Docxtemplater(new PizZip(templateBuffer), options);
}

module.exports = { contractValues, fillTemplate, inspectTemplate, PLACEHOLDERS };
