-- Add inventory_freight to the request_type check constraint on payment_requests.
-- Drop the existing constraint and re-create it with the new value included.

alter table public.payment_requests
  drop constraint if exists payment_requests_request_type_check;

alter table public.payment_requests
  add constraint payment_requests_request_type_check
  check (request_type in (
    'invoice_vendor_payment',
    'inventory_deposit',
    'inventory_balance',
    'inventory_freight',
    'employee_reimbursement',
    'customer_refund'
  ));
