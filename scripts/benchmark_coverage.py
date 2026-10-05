"""Trusted acceptance scope; a successful subset never closes a large task.

This inventory describes the checks actually implemented by the evaluator.
Unverified requirements may only be removed when independent behavioral checks
exist for them. Neither an application nor a report's PASS label can do that.
"""

from __future__ import annotations

COMMON_CHECKS = ("generated_test_suite", "production_build")
NOC_ROUND_CHECKS = (
    "independent_interface_counters_and_rates",
    "independent_fault_noBuffers", "independent_fault_CRC", "independent_fault_HighPPS",
    "independent_alert_dedup_ack_and_recovery",
    "independent_topology_dependency_rca",
    "independent_configuration_diff_rollback_audit",
    "independent_server_write_permissions",
)
RTS_SCENARIOS = (
    "seed_and_tick", "save_load", "fog_save", "battle_100v100", "movement_200",
    "continuation_determinism", "long_run_cleanup",
)

# Keep partial coverage explicit: e.g. one RCA target is not all RCA scenarios,
# and a saved fog array is not visibility correctness or hidden-enemy rendering.
UNVERIFIED_REQUIREMENTS = {
    "counter": (),
    "noc": (
        "all_14_pages_and_table_sort_filter_search",
        "complete_device_interface_fields_sites_and_roles",
        "counter_derived_rates_and_restart_reset_handling",
        "realtime_stream_and_correlated_traffic_patterns",
        "all_chart_ranges_and_device_interface_details",
        "topology_hierarchy_layout_interactions_and_endpoint_link_states",
        "all_alert_rules_threshold_durations_and_state_transitions",
        "syslog_filters_bounded_ui_and_event_alert_separation",
        "complete_ospf_bgp_state_and_core_wan_dependency_recovery",
        "all_fault_types_manual_and_timed_recovery",
        "configuration_backup_schedule_metadata_and_rollback_preview",
        "health_score_and_global_search",
        "all_roles_all_write_routes_and_ui_permission_consistency",
        "refresh_and_process_restart_persistence",
        "disconnect_reconnect_batching_rate_limit_and_stale_event_discard",
        "stress_20_charts_100_faults_dedup_rca_and_interactive_performance",
    ),
    "rts": (
        "map_size_terrain_fair_spawns_resources_connectivity_and_chokes",
        "camera_selection_control_groups_and_context_commands",
        "all_commands_unit_types_and_complete_attributes",
        "worker_gather_carry_deposit_depletion_and_resource_conservation",
        "building_types_placement_construction_repair_cancel_and_refunds",
        "production_population_queues_refunds_and_blocked_exits",
        "combat_range_cooldown_armor_projectiles_retarget_and_no_friendly_fire",
        "dynamic_three_state_fog_hidden_enemies_and_minimap",
        "path_budget_terrain_buildings_formation_separation_choke_and_replanning",
        "spatial_index_and_fixed_tick_render_ai_economy_separation",
        "ai_resource_bound_economy_construction_scout_defend_attack_and_fog",
        "technology_cost_time_prerequisites_and_actual_upgrade_effects",
        "hud_commands_audio_alerts_animation_and_visual_identity",
        "full_match_statistics_and_death_cleanup_across_all_references",
        "complete_save_load_of_map_research_ai_queues_and_time",
        "normal_mode_debug_restrictions_and_real_f3_metrics",
        "300_units_50_buildings_combined_stress_and_bounded_memory",
        "playable_skirmish_economy_to_victory_and_defeat",
    ),
}


def expected_checks(case: str, rounds: int) -> set[str]:
    if case not in UNVERIFIED_REQUIREMENTS:
        raise ValueError("unknown_benchmark_case")
    if type(rounds) is not int or not 1 <= rounds <= 10:
        raise ValueError("invalid_acceptance_rounds")
    names = set(COMMON_CHECKS)
    if case == "counter":
        return names | {"independent_browser_interactions"}
    names.add("browser_boot_only")
    if case == "noc":
        names.update(("api_boot", "independent_test_identity", "baseline_inventory",
                      "simulation_progress", "stress_inventory"))
        repeated = NOC_ROUND_CHECKS
    else:
        repeated = tuple("independent_engine_" + name for name in RTS_SCENARIOS)
    names.update(f"{name}_round_{index}" for index in range(1, rounds + 1) for name in repeated)
    return names


def acceptance_summary(case: str, report: dict | None) -> dict:
    """Recompute scope from real named records, ignoring self-declared verdicts."""
    missing_requirements = list(UNVERIFIED_REQUIREMENTS[case])
    invalid = []
    expected = set()
    records = {}
    if not isinstance(report, dict) or report.get("case") != case:
        invalid.append("missing_or_mismatched_acceptance_report")
    else:
        try:
            expected = expected_checks(case, report.get("rounds"))
        except ValueError as exc:
            invalid.append(str(exc))
        rows = report.get("checks")
        if not isinstance(rows, list) or not rows:
            invalid.append("missing_acceptance_checks")
        else:
            for row in rows:
                if not isinstance(row, dict) or not isinstance(row.get("name"), str):
                    invalid.append("invalid_acceptance_check")
                    continue
                name = row["name"]
                if name in records:
                    invalid.append("duplicate_acceptance_check:" + name)
                if row.get("status") not in ("PASS", "FAIL"):
                    invalid.append("invalid_acceptance_status:" + name)
                records[name] = row.get("status")
        if case != "counter" and type(report.get("rounds")) is int and report["rounds"] < 3:
            missing_requirements.append("at_least_three_independent_acceptance_rounds")
    missing_checks = sorted(expected - records.keys())
    failed_checks = sorted(name for name, status in records.items() if status != "PASS")
    invalid.extend("unexpected_acceptance_check:" + name for name in sorted(records.keys() - expected))
    named_passed = bool(expected) and not (invalid or missing_checks or failed_checks)
    full_passed = named_passed and not missing_requirements
    return {
        "status": "PASS" if full_passed else "INCOMPLETE" if named_passed else "FAIL",
        "named_acceptance_passed": named_passed,
        "full_benchmark_acceptance": "PASS" if full_passed else "NOT VERIFIED",
        "unverified_requirements": missing_requirements,
        "missing_checks": missing_checks,
        "failed_checks": failed_checks,
        "invalid_evidence": invalid,
    }
