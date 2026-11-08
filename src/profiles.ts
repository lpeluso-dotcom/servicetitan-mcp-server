import { toolsForRole, type ToolDef } from './tools';
import type { Env } from './env';

// Profiles only narrow the role catalog. They never grant permission to write.
export const TOOL_PROFILES: Readonly<Record<string, readonly string[]>> = {
  'daily-operations': ['find_customer','get_customer','get_customer_locations','list_customer_jobs','get_customer_membership','add_customer_note','get_job','list_jobs_today','get_job_appointments','get_job_history','add_job_note','get_capacity','find_technician_by_name','list_technicians_available','get_invoice','list_invoices_job','get_invoice_balance','list_unpaid_invoices','customer_snapshot','list_open_tasks','list_memberships_active','list_memberships_expiring'],
  pricebook: ['st_get_pricebook','search_pricebook_all','search_pricebook_services','search_materials','list_service_categories','get_service_details','get_configurable_equipment_children','search_pricebook_templates','get_proposal_tiers','list_estimate_templates','get_estimate_template'],
  reporting: ['st_run_report','st_report_start','st_report_status','st_report_results','list_campaigns','get_campaign_performance','payments_list','ap_bills_list','payroll_payrolls_list','payroll_job_timesheets_list'],
  investigation: ['customer_snapshot','job_closeout_report','find_customer','get_customer','get_job','get_job_history','list_estimates_job','get_estimate','estimate_reference_evidence','get_call','calls_list','call_recording_get','call_voicemail_get','get_form_submission','equipment_installed_list','equipment_installed_get','equipment_systems_list','service_agreements_list','service_agreement_get','leads_list','lead_get','bookings_list','booking_get','purchase_orders_list','purchase_order_get','payment_get','ap_bill_get'],
  'configuration-admin': ['configuration_snapshot','compare_configuration_snapshots','list_job_types','get_job_type','create_job_type','update_job_type','list_business_units','get_business_unit','update_business_unit_metadata','list_tag_types','get_tag_type','create_tag_type','update_tag_type'],
};
export const PROFILE_FOLLOW_UPS = ['get_result_page','st_operation_status'];
export function resolveVisibleTools(role:'default'|'admin'|'readonly'|'lockdown', grants:readonly string[]|undefined, profile:string|undefined):readonly ToolDef<any>[] {
  let visible=toolsForRole(role);
  if(grants!==undefined) visible=visible.filter(t=>PROFILE_FOLLOW_UPS.includes(t.name)||grants.includes(t.name));
  if(profile===undefined)return visible;
  if(!Object.hasOwn(TOOL_PROFILES,profile))return [];
  const allowed=new Set([...TOOL_PROFILES[profile],...PROFILE_FOLLOW_UPS]);
  return visible.filter(t=>allowed.has(t.name));
}
export function profileFor(env:Pick<Env,'TOOL_PROFILES_JSON'>,principal:string|undefined):string|undefined {
  // The configuration credential is dedicated to configuration; configuration cannot widen it.
  if(principal==='configuration-admin')return 'configuration-admin';
  if(!env.TOOL_PROFILES_JSON)return undefined;
  const raw:unknown=JSON.parse(env.TOOL_PROFILES_JSON);
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('Invalid profile mapping');
  const entries=new Map<string,string>();
  for(const [key,value] of Object.entries(raw)) {
    if(typeof value!=='string'||!Object.hasOwn(TOOL_PROFILES,value)||entries.has(key.toLowerCase()))throw new Error('Invalid profile mapping');
    entries.set(key.toLowerCase(),value);
  }
  return principal?entries.get(principal.toLowerCase()):undefined;
}
