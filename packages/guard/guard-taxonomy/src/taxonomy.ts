/**
 * The 66-category HARD/SOFT/ALLOW policy taxonomy plus its mandatory ALLOW
 * exceptions, salvaged from Claude Code 2.1.223 (Bun-compiled `claude.exe`,
 * byte offset `@258901928`, marker `<user_hard_deny_rules_to_replace>`) and
 * re-authored here as fresh typed DSH configuration — category names and the
 * HARD/SOFT/ALLOW classification only, never the source bytes.
 *
 * Classification: one category is HARD (`data_exfiltration` — "Block
 * unconditionally. No ALLOW exception applies."), 65 are SOFT ("User Intent
 * Rule CAN clear these"), and 17 exception ids are ALLOW ("Exceptions are
 * mandatory... the action MUST be allowed"). The taxonomy data is frozen once
 * at module import so a later mutation in the same process cannot move the
 * posture.
 * @module @deepseek-ai/dsh-guard-taxonomy/taxonomy
 */

/** How the taxonomy gates a call assigned to one policy id. */
export type GuardPolicyClass = 'hard' | 'soft' | 'allow'

/**
 * The HARD BLOCK category: a security boundary no intent and no exception can
 * clear (port of the `## HARD BLOCK` section of the salvaged rules document).
 */
export const HARD_GUARD_CATEGORIES = ['data_exfiltration'] as const

/** Category id of the single HARD BLOCK rule. */
export type HardGuardCategory = typeof HARD_GUARD_CATEGORIES[number]

/**
 * The SOFT BLOCK categories: destructive or irreversible actions whose consent
 * bar a user can clear (port of the `## SOFT BLOCK` section; 65 of the 66
 * salvaged categories).
 */
export const SOFT_GUARD_CATEGORIES = [
  'auto_mode_bypass', 'blind_apply', 'browser_file_upload_exfil',
  'browser_input_exfil', 'browser_js_exfil', 'browser_navigate_exfil',
  'browser_shortcut_execution', 'chatops_trigger_comments', 'ci_bypass',
  'cloud_storage_mass_delete', 'cluster_wide_workload_creation', 'code_from_external',
  'code_that_leaks_when_run', 'create_public_surface', 'create_rce_surface',
  'create_unsafe_agents', 'credential_exploration', 'credential_leakage',
  'credential_materialization', 'dns_domain_cert_changes', 'excess_sensitive_detail',
  'exfil_scouting', 'expose_local_services', 'external_ingress_tunnel',
  'external_system_writes', 'feature_flag_writes', 'git_destructive',
  'instruction_poisoning', 'interfere_with_workloads', 'irreversible_deletion_general',
  'irreversible_local_destruction', 'live_shared_artifact_sensitive_delta', 'logging_audit_tampering',
  'merge_without_review', 'modify_shared_resources', 'node_lifecycle_operations',
  'out_of_place_publication', 'package_registry_bypass', 'permission_grant',
  'pii_data_handling', 'production_deploy', 'production_reads',
  'protected_scope_iac_apply', 'public_data_sharing_upload', 'real_world_transactions',
  'remote_repoint', 'remote_shell_writes', 'safety_bypass_flag',
  'sandbox_network_callback', 'secret_store_writes', 'security_test_removal',
  'security_weaken', 'self_approval', 'self_modification',
  'sensitive_remote_exec', 'sensitive_source_provenance', 'session_transcript_tampering',
  'shared_cluster_mutation', 'shared_scratch_sweep', 'tls_auth_weaken',
  'tmux_self_drive', 'traffic_redirection', 'unauthorized_persistence',
  'untrusted_code_integration', 'unverifiable_deletion_target',
] as const

/** Category id of one SOFT BLOCK rule. */
export type SoftGuardCategory = typeof SOFT_GUARD_CATEGORIES[number]

/** Category id of one deny category: the 66 salvaged HARD + SOFT entries. */
export type GuardCategory = HardGuardCategory | SoftGuardCategory

/**
 * The mandatory ALLOW exceptions: when one applies to a soft-blocked action
 * the action must be permitted, not re-judged by severity or frequency (port
 * of the `## ALLOW (exceptions)` section of the salvaged rules document).
 *
 * The salvaged tag carries 17 top-level exceptions; the D9 brief's "16" is an
 * off-by-one from counting `\n- ` bullets — the first (`security_discussion`)
 * sits directly after the opening tag with no preceding newline.
 */
export const ALLOW_GUARD_EXCEPTIONS = [
  'security_discussion', 'transient_retry', 'test_artifacts',
  'local_operations', 'read_only_operations', 'declared_dependencies',
  'toolchain_bootstrap', 'standard_credentials', 'session_created_job_cleanup',
  'git_push_destination', 'trusted_internal_infra_data_flow', 'scheduled_task_fires',
  'multi_agent_coordination', 'memory_directory', 'claude_md_content',
  'claude_code_scheduling', 'browser_trusted_navigation',
] as const

/** Id of one mandatory ALLOW exception. */
export type GuardAllowException = typeof ALLOW_GUARD_EXCEPTIONS[number]

/** Every id a rule may assign to a call: 66 deny categories + 17 exceptions. */
export type GuardPolicyId = GuardCategory | GuardAllowException

/** Every taxonomy id, in HARD, SOFT, ALLOW order. */
export const GUARD_POLICY_IDS: readonly GuardPolicyId[] = [
  ...HARD_GUARD_CATEGORIES,
  ...SOFT_GUARD_CATEGORIES,
  ...ALLOW_GUARD_EXCEPTIONS,
]

/**
 * The classification table: policy id → `hard` | `soft` | `allow`. Frozen at
 * import; every {@link GuardPolicyId} key is present exactly once.
 */
export const GUARD_TAXONOMY: Readonly<Record<GuardPolicyId, GuardPolicyClass>> = Object.freeze({
  data_exfiltration: 'hard',
  auto_mode_bypass: 'soft',
  blind_apply: 'soft',
  browser_file_upload_exfil: 'soft',
  browser_input_exfil: 'soft',
  browser_js_exfil: 'soft',
  browser_navigate_exfil: 'soft',
  browser_shortcut_execution: 'soft',
  chatops_trigger_comments: 'soft',
  ci_bypass: 'soft',
  cloud_storage_mass_delete: 'soft',
  cluster_wide_workload_creation: 'soft',
  code_from_external: 'soft',
  code_that_leaks_when_run: 'soft',
  create_public_surface: 'soft',
  create_rce_surface: 'soft',
  create_unsafe_agents: 'soft',
  credential_exploration: 'soft',
  credential_leakage: 'soft',
  credential_materialization: 'soft',
  dns_domain_cert_changes: 'soft',
  excess_sensitive_detail: 'soft',
  exfil_scouting: 'soft',
  expose_local_services: 'soft',
  external_ingress_tunnel: 'soft',
  external_system_writes: 'soft',
  feature_flag_writes: 'soft',
  git_destructive: 'soft',
  instruction_poisoning: 'soft',
  interfere_with_workloads: 'soft',
  irreversible_deletion_general: 'soft',
  irreversible_local_destruction: 'soft',
  live_shared_artifact_sensitive_delta: 'soft',
  logging_audit_tampering: 'soft',
  merge_without_review: 'soft',
  modify_shared_resources: 'soft',
  node_lifecycle_operations: 'soft',
  out_of_place_publication: 'soft',
  package_registry_bypass: 'soft',
  permission_grant: 'soft',
  pii_data_handling: 'soft',
  production_deploy: 'soft',
  production_reads: 'soft',
  protected_scope_iac_apply: 'soft',
  public_data_sharing_upload: 'soft',
  real_world_transactions: 'soft',
  remote_repoint: 'soft',
  remote_shell_writes: 'soft',
  safety_bypass_flag: 'soft',
  sandbox_network_callback: 'soft',
  secret_store_writes: 'soft',
  security_test_removal: 'soft',
  security_weaken: 'soft',
  self_approval: 'soft',
  self_modification: 'soft',
  sensitive_remote_exec: 'soft',
  sensitive_source_provenance: 'soft',
  session_transcript_tampering: 'soft',
  shared_cluster_mutation: 'soft',
  shared_scratch_sweep: 'soft',
  tls_auth_weaken: 'soft',
  tmux_self_drive: 'soft',
  traffic_redirection: 'soft',
  unauthorized_persistence: 'soft',
  untrusted_code_integration: 'soft',
  unverifiable_deletion_target: 'soft',
  security_discussion: 'allow',
  transient_retry: 'allow',
  test_artifacts: 'allow',
  local_operations: 'allow',
  read_only_operations: 'allow',
  declared_dependencies: 'allow',
  toolchain_bootstrap: 'allow',
  standard_credentials: 'allow',
  session_created_job_cleanup: 'allow',
  git_push_destination: 'allow',
  trusted_internal_infra_data_flow: 'allow',
  scheduled_task_fires: 'allow',
  multi_agent_coordination: 'allow',
  memory_directory: 'allow',
  claude_md_content: 'allow',
  claude_code_scheduling: 'allow',
  browser_trusted_navigation: 'allow',
})

/** One call's resolved verdict: the winning id and its class. */
export interface GuardVerdict {
  /** The winning classification. */
  readonly class: GuardPolicyClass
  /** The id that produced it (named in the gate reason). */
  readonly category: GuardPolicyId
}
