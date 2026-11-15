// The ՀԴՄ (fiscal cash register) connection, set per computer.
// 'test' mode simulates the device so the flow can be tried without printing real fiscal receipts.
// 'device' mode needs Evocabank's protocol for their device, which is not available yet.

const DEFAULTS = {
  enabled: false,
  mode: 'test', // 'test' | 'device'
  host: '',
  port: '',
  cashier: '',
  password: '',
  methods: ['card'], // payment methods that need a receipt
  testCounter: 0,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * receipt: { items: [{ label, amount }], total, method, student, cashier }
 * nextTestNo: returns the next simulated receipt number
 */
async function printReceipt(settings, receipt, nextTestNo) {
  if (!settings.enabled) return { ok: false, error: 'HDM_DISABLED' };
  if (settings.mode === 'device') return { ok: false, error: 'HDM_DEVICE_PENDING' };
  if (!receipt?.items?.length || !(receipt.total > 0)) return { ok: false, error: 'AMOUNT_REQUIRED' };

  await sleep(1300); // roughly how long a real device takes to answer
  return {
    ok: true,
    result: {
      test: true,
      receiptNo: `T-${String(nextTestNo()).padStart(6, '0')}`,
      fiscalNo: String(Math.floor(10000000 + Math.random() * 89999999)),
      printedAt: new Date().toISOString(),
    },
  };
}

module.exports = { DEFAULTS, printReceipt };
