'use strict';
// Synthetic records only. Shared by browser regression tests and local preview.
const plan = { plan_key: 'growth', title: 'Growth', description: 'Your workspace, connected.',
  unit_amount_cents: 50000, currency: 'usd', billing_interval: 'month', is_active: true, sort_order: 1 };
const subscription = { ...plan, company_entity_id: 'test-company', stripe_customer_id: 'cus_demo',
  stripe_subscription_id: 'sub_demo', plan_title: 'Growth', status: 'active', quantity: 1,
  current_period_end: '2026-10-19T12:00:00Z', stripe_synced_at: '2026-09-19T12:00:00Z' };
const invoice = { id: 'invoice-demo', stripe_invoice_id: 'in_demo', number: 'INV-1042',
  company_entity_id: 'test-company', customer_display_name: 'North Coast Supply',
  customer_display_email: 'buyer@example.test', status: 'open', currency: 'usd',
  total_cents: 480000, amount_due_cents: 480000, amount_remaining_cents: 480000,
  due_date: '2026-10-19T12:00:00Z', created_at: '2026-09-19T12:00:00Z', line_count: 4,
  hosted_invoice_url: 'https://example.test/invoice', invoice_pdf_url: 'https://example.test/invoice.pdf' };
function tables(scenario = 'active') {
  const result = {
    billing_plans: [plan], billing_subscriptions_v: [subscription],
    billing_invoices: [{ ...invoice, amount_due_cents: 50000, amount_paid_cents: 50000, status: 'paid', period_start: invoice.created_at }],
    stripe_connect_status_v: [{ charges_enabled: true, default_currency: 'usd' }],
    stripe_invoice_customers: [{ id: 'customer-demo', stripe_customer_id: 'cus_demo', name: 'North Coast Supply', email: 'buyer@example.test' }],
    stripe_invoices_v: [invoice,
      { ...invoice, id: 'paid-demo', stripe_invoice_id: 'in_paid', number: 'INV-1041', status: 'paid', total_cents: 92000, amount_remaining_cents: 0, customer_display_name: 'Fieldhouse Goods' },
      { ...invoice, id: 'draft-demo', stripe_invoice_id: 'in_draft', number: null, status: 'draft', total_cents: 180000, amount_remaining_cents: 180000, customer_display_name: 'Cedar Athletics', hosted_invoice_url: null },
      { ...invoice, id: 'late-demo', stripe_invoice_id: 'in_late', number: 'INV-1040', status: 'open', is_overdue: true, customer_display_name: 'Westward Sports', total_cents: 67000, due_date: '2026-09-10T12:00:00Z' }],
    profiles: [{ id: 'test-user', role: 'owner', department: 'finance' }],
  };
  if (scenario === 'empty') {
    result.billing_subscriptions_v = []; result.billing_invoices = []; result.stripe_invoices_v = [];
  }
  if (scenario === 'no-plans') { result.billing_subscriptions_v = []; result.billing_plans = []; }
  if (scenario === 'canceled') result.billing_subscriptions_v = [{ ...subscription, status: 'canceled' }];
  if (scenario === 'ending') result.billing_subscriptions_v = [{ ...subscription, cancel_at_period_end: true }];
  if (scenario === 'past-due') result.billing_subscriptions_v = [{ ...subscription, status: 'past_due', collection_issue: true }];
  if (scenario === 'disconnected') result.stripe_connect_status_v = [];
  if (scenario === 'restricted') result.stripe_connect_status_v = [{ charges_enabled: false, is_restricted: true }];
  return result;
}
module.exports = { tables, plan, subscription, invoice };
