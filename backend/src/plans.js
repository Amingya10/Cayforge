// plans.js
// Single source of truth for Clayforge plan names, Paystack pricing, and monthly quotas.
// The value stored on User.plan is always one of: 'Starter' | 'Maker' | 'Professional'.

const PLANS = {
  Starter:      { label: 'Starter',      amountKobo: 0,       monthlyDesigns: 3   },
  Maker:        { label: 'Maker',        amountKobo: 850000,  monthlyDesigns: 25  }, // ₦8,500
  Professional: { label: 'Professional', amountKobo: 2200000, monthlyDesigns: 100 }, // ₦22,000
};

const DEFAULT_PLAN = 'Starter';
const PAID_PLANS = ['Maker', 'Professional'];

// Legacy keys accepted during the rename rollout, so an old client or an
// un-migrated row never breaks. Safe to delete once everything uses the new names.
const LEGACY = { FREE: 'Starter', STONEWARE: 'Maker', PORCELAIN: 'Professional' };

function normalizePlan(plan) {
  if (PLANS[plan]) return plan;          // already a new name
  if (LEGACY[plan]) return LEGACY[plan]; // map an old name
  return null;                           // unknown
}

function planLimit(plan) {
  const key = normalizePlan(plan) || DEFAULT_PLAN;
  return PLANS[key].monthlyDesigns;
}

function planAmountKobo(plan) {
  const key = normalizePlan(plan);
  return key ? PLANS[key].amountKobo : null;
}

module.exports = { PLANS, DEFAULT_PLAN, PAID_PLANS, normalizePlan, planLimit, planAmountKobo };
