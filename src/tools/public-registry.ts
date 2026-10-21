import type { ToolDef } from './types';
import { get_result_page, st_operation_status } from './infra';

import { find_customer } from './crm/find_customer';
import { get_customer } from './crm/get_customer';
import { get_customer_locations } from './crm/get_customer_locations';
import { list_customer_jobs } from './crm/list_customer_jobs';
import { get_customer_membership } from './crm/get_customer_membership';
import { add_customer_note } from './crm/add_customer_note';

import { get_job } from './jobs/get_job';
import { get_job_appointments } from './jobs/get_job_appointments';
import { get_job_history } from './jobs/get_job_history';
import { jobs_hold_reasons_list } from './jobs/jobs_hold_reasons_list';
import { add_job_note } from './jobs/add_job_note';
import { list_jobs_today_public } from './public/list_jobs_today';

import { get_capacity } from './dispatch/get_capacity';
import { get_technician_shifts } from './dispatch/get_technician_shifts';
import { list_non_job_events } from './dispatch/list_non_job_events';
import { st_get_capacity_slots } from './dispatch/st_get_capacity_slots';

import { list_estimates_job } from './estimates/list_estimates_job';
import { get_estimate } from './estimates/get_estimate';
import { sell_estimate, unsell_estimate, dismiss_estimate } from './estimates/update_estimate_status';

import { get_invoice } from './invoicing/get_invoice';
import { list_invoices_job } from './invoicing/list_invoices_job';
import { get_invoice_balance } from './invoicing/get_invoice_balance';
import { list_unpaid_invoices } from './invoicing/list_unpaid_invoices';
import { st_add_invoice_line_item } from './invoicing/st_add_invoice_line_item';
import { st_create_adjustment_invoice } from './invoicing/st_create_adjustment_invoice';

import { list_memberships_active } from './memberships/list_memberships_active';
import { list_memberships_expiring } from './memberships/list_memberships_expiring';
import { create_recurring_service } from './memberships/create_recurring_service';

import { get_call } from './calls_forms/get_call';
import { get_form_submission } from './calls_forms/get_form_submission';

import { inventory_vendors_list } from './inventory/inventory_vendors_list';
import { inventory_warehouses_list } from './inventory/inventory_warehouses_list';
import { inventory_receipts_list } from './inventory/inventory_receipts_list';
import { inventory_transfers_list } from './inventory/inventory_transfers_list';

import { payroll_payrolls_list } from './payroll/payroll_payrolls_list';
import { payroll_non_job_timesheets_list } from './payroll/payroll_non_job_timesheets_list';
import { payroll_location_rates_list } from './payroll/payroll_location_rates_list';
import { payroll_settings_get } from './payroll/payroll_settings_get';
import { payroll_job_timesheets_list_public } from './public/payroll_job_timesheets_list';

import { list_campaigns } from './marketing/list_campaigns';
import { get_campaign_performance } from './marketing/get_campaign_performance';

import { st_run_report } from './reporting/st_run_report';
import { st_report_start, st_report_status, st_report_results } from './reporting/st_report_resumable';

import { create_task } from './tasks/create_task';
import { list_open_tasks } from './tasks/list_open_tasks';

import { list_estimate_templates } from './sales/list_estimate_templates';
import { get_estimate_template } from './sales/get_estimate_template';
import { create_estimate_template } from './sales/create_estimate_template';
import { update_estimate_template } from './sales/update_estimate_template';
import { delete_estimate_template } from './sales/delete_estimate_template';

import { search_pricebook_templates_public } from './public/search_pricebook_templates';
import { get_proposal_tiers_public } from './public/get_proposal_tiers';
import { create_proposal_template } from './sales/create_proposal_template';
import { update_proposal_template } from './sales/update_proposal_template';
import { delete_proposal_template } from './sales/delete_proposal_template';

import { find_technician_by_name_public } from './public/find_technician_by_name';
import { list_technicians_available_public } from './public/list_technicians_available';

import { list_service_categories } from './pricebook/list_service_categories';
import { get_service_details } from './pricebook/get_service_details';
import { get_configurable_equipment_children } from './pricebook/get_configurable_equipment_children';
import { st_get_pricebook } from './st_get_pricebook';
import { st_patch_service } from './st_patch_service';
import { st_create_service } from './st_create_service';
import { st_patch_material } from './st_patch_material';
import { st_create_material } from './st_create_material';

import { st_list_jobs } from './st_list_jobs';
import { st_list_customers } from './st_list_customers';
import { st_get_customer } from './st_get_customer';
import { st_list_appointments } from './st_list_appointments';

import { customer_snapshot } from './composites/customer_snapshot';
import { job_closeout_report } from './composites/job_closeout_report';

import { search_pricebook_all_public } from './public/search_pricebook_all';
import { search_pricebook_services_public, search_materials_public } from './public/pricebook_code_search';

export const HOUSEKEEPING_WRITES: Readonly<Record<string, string>> = {
  st_run_report: 'cancels its own timed-out ServiceTitan data query; touches no business data',
};

export const PUBLIC_TOOLS: readonly ToolDef<any>[] = [
  get_result_page, st_operation_status,
  
  find_customer, get_customer, get_customer_locations, list_customer_jobs, get_customer_membership, add_customer_note,
  
  get_job, get_job_appointments, get_job_history, jobs_hold_reasons_list, add_job_note, list_jobs_today_public,
  
  get_capacity, get_technician_shifts, list_non_job_events, st_get_capacity_slots,
  
  list_estimates_job, get_estimate, sell_estimate, unsell_estimate, dismiss_estimate,
  
  get_invoice, list_invoices_job, get_invoice_balance, list_unpaid_invoices, st_add_invoice_line_item, st_create_adjustment_invoice,
  
  list_memberships_active, list_memberships_expiring, create_recurring_service,
  
  get_call, get_form_submission,
  
  inventory_vendors_list, inventory_warehouses_list, inventory_receipts_list, inventory_transfers_list,
  
  payroll_payrolls_list, payroll_non_job_timesheets_list, payroll_location_rates_list, payroll_settings_get, payroll_job_timesheets_list_public,
  
  search_pricebook_all_public, search_pricebook_services_public, search_materials_public,
  
  list_service_categories, get_service_details, get_configurable_equipment_children, st_get_pricebook,
  
  st_patch_service, st_create_service, st_patch_material, st_create_material,
  
  st_list_jobs, st_list_customers, st_get_customer, st_list_appointments,
  
  list_campaigns, get_campaign_performance,
  
  st_run_report, st_report_start, st_report_status, st_report_results,
  
  create_task, list_open_tasks,
  
  list_estimate_templates, get_estimate_template, create_estimate_template, update_estimate_template, delete_estimate_template,
  
  search_pricebook_templates_public, get_proposal_tiers_public, create_proposal_template, update_proposal_template, delete_proposal_template,
  
  find_technician_by_name_public, list_technicians_available_public,
  
  customer_snapshot, job_closeout_report,
];

export const CUT_FROM_RELEASE_1: Readonly<Record<string, string>> = {
  find_packages_with_item: 'Which templates contain a given item is not available through ServiceTitan\'s public API — there is no reverse lookup from item to template.',
  get_service_breakout: 'The exploded contents of a service kit are not available through ServiceTitan\'s public API.',
  opportunities_list: 'no public ServiceTitan endpoint',
  opportunity_get: 'no public ServiceTitan endpoint',
  // The source (src/tools/jobs/assign_technicians.ts) and its unit tests stay;
  // only the registration is withheld.
  assign_technicians: "Held back: ServiceTitan's appointment-assignment request contract (path and body field names) is not yet verified against a live tenant, and the two-step unassign/assign is not atomic.",
};
