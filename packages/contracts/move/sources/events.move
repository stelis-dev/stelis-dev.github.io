module stelis::events {
    use sui::event;

    // --- Core Events ---

    /// Emitted when a settlement occurs.
    public struct SettleEvent has copy, drop {
        receipt_id: vector<u8>,
        nonce: u64,                    // S-14: monotonic nonce for replay prevention
        policy_hash: vector<u8>,
        quote_timestamp_ms: u64,
        exec_timestamp_ms: u64,
        // Audit fields: components used to compute execution_cost_claim_mist (informational only).
        sim_gas_reported: u64,
        gas_variance_fixed_mist: u64,
        slippage_buffer_mist: u64,
        // Authoritative payout inputs.
        execution_cost_claim_mist: u64,
        quoted_host_fee_mist: u64,  // Exact fee quoted by the Host (bound in PTB)
        protocol_fee: u64,             // Fixed protocol fee per TX
        protocol_treasury: address,
        payout: u64,                   // execution_cost_claim_mist + quoted_host_fee_mist
        total_in: u64,
        surplus_credited: u64,
        config_version: u64,           // Config version at settlement time
        user: address,
        settlement_payout_recipient: address,
        order_id_hash: vector<u8>,     // sha256(orderId) if provided, empty otherwise (0 or 32 bytes)
    }

    public(package) fun emit_settle_event(
        receipt_id: vector<u8>,
        nonce: u64,
        policy_hash: vector<u8>,
        quote_timestamp_ms: u64,
        exec_timestamp_ms: u64,
        sim_gas_reported: u64,
        gas_variance_fixed_mist: u64,
        slippage_buffer_mist: u64,
        execution_cost_claim_mist: u64,
        quoted_host_fee_mist: u64,
        protocol_fee: u64,
        protocol_treasury: address,
        payout: u64,
        total_in: u64,
        surplus_credited: u64,
        config_version: u64,
        user: address,
        settlement_payout_recipient: address,
        order_id_hash: vector<u8>,
    ) {
        event::emit(SettleEvent {
            receipt_id,
            nonce,
            policy_hash,
            quote_timestamp_ms,
            exec_timestamp_ms,
            sim_gas_reported,
            gas_variance_fixed_mist,
            slippage_buffer_mist,
            execution_cost_claim_mist,
            quoted_host_fee_mist,
            protocol_fee,
            protocol_treasury,
            payout,
            total_in,
            surplus_credited,
            config_version,
            user,
            settlement_payout_recipient,
            order_id_hash,
        });
    }

    // --- Vault Events ---

    public struct CreditUsedEvent has copy, drop {
        user: address,
        amount: u64,
        remaining: u64,
    }

    public(package) fun emit_credit_used_event(user: address, amount: u64, remaining: u64) {
        event::emit(CreditUsedEvent { user, amount, remaining });
    }

    public struct WithdrawEvent has copy, drop {
        user: address,
        amount: u64,
    }

    public(package) fun emit_withdraw_event(user: address, amount: u64) {
        event::emit(WithdrawEvent { user, amount });
    }

    // --- Admin Events ---

    /// Emitted when Config fees or limits are updated.
    public struct ConfigUpdatedEvent has copy, drop {
        old_max_host_fee_mist: u64,
        new_max_host_fee_mist: u64,
        old_protocol_flat_fee_mist: u64,
        new_protocol_flat_fee_mist: u64,
        old_max_claim_mist: u64,
        new_max_claim_mist: u64,
        old_min_settle_mist: u64,
        new_min_settle_mist: u64,
        old_max_spread_bps: u64,
        new_max_spread_bps: u64,
        new_config_version: u64,   // Version after this update (for drift tracking)
        by: address,
        epoch: u64,
    }

    public(package) fun emit_config_updated_event(
        old_max_host_fee_mist: u64,
        new_max_host_fee_mist: u64,
        old_protocol_flat_fee_mist: u64,
        new_protocol_flat_fee_mist: u64,
        old_max_claim_mist: u64,
        new_max_claim_mist: u64,
        old_min_settle_mist: u64,
        new_min_settle_mist: u64,
        old_max_spread_bps: u64,
        new_max_spread_bps: u64,
        new_config_version: u64,
        by: address,
        epoch: u64,
    ) {
        event::emit(ConfigUpdatedEvent {
            old_max_host_fee_mist,
            new_max_host_fee_mist,
            old_protocol_flat_fee_mist,
            new_protocol_flat_fee_mist,
            old_max_claim_mist,
            new_max_claim_mist,
            old_min_settle_mist,
            new_min_settle_mist,
            old_max_spread_bps,
            new_max_spread_bps,
            new_config_version,
            by,
            epoch,
        });
    }

    public struct TreasuryUpdatedEvent has copy, drop {
        old_treasury: address,
        new_treasury: address,
        by: address,
        epoch: u64,
    }

    public(package) fun emit_treasury_updated_event(
        old_treasury: address,
        new_treasury: address,
        by: address,
        epoch: u64,
    ) {
        event::emit(TreasuryUpdatedEvent { old_treasury, new_treasury, by, epoch });
    }

    public struct PausedEvent has copy, drop {
        is_paused: bool,
        by: address,
        epoch: u64,
    }

    public(package) fun emit_paused_event(is_paused: bool, by: address, epoch: u64) {
        event::emit(PausedEvent { is_paused, by, epoch });
    }

    public struct AdminProposedEvent has copy, drop {
        current_admin: address,
        proposed_admin: address,
        epoch: u64,
    }

    public(package) fun emit_admin_proposed_event(current_admin: address, proposed_admin: address, epoch: u64) {
        event::emit(AdminProposedEvent { current_admin, proposed_admin, epoch });
    }

    /// Emitted when a pending admin proposal is cancelled by the current admin.
    public struct AdminProposalCancelledEvent has copy, drop {
        /// The current admin who cancelled the proposal.
        admin: address,
        /// The proposed admin address that was cancelled.
        cancelled_proposed: address,
        epoch: u64,
    }

    public(package) fun emit_admin_proposal_cancelled_event(
        admin: address,
        cancelled_proposed: address,
        epoch: u64,
    ) {
        event::emit(AdminProposalCancelledEvent { admin, cancelled_proposed, epoch });
    }

    public struct AdminTransferredEvent has copy, drop {
        old_admin: address,
        new_admin: address,
        by: address,
        epoch: u64,
    }

    public(package) fun emit_admin_transferred_event(old_admin: address, new_admin: address, by: address, epoch: u64) {
        event::emit(AdminTransferredEvent { old_admin, new_admin, by, epoch });
    }


    // ─── Test-only accessors for ConfigUpdatedEvent ──────────────────────────
    // Struct fields are module-private in Move 2024.
    // These let settle_tests.move verify event payload semantics.

    #[test_only]
    public fun config_evt_old_max_spread_bps(e: &ConfigUpdatedEvent): u64 { e.old_max_spread_bps }
    #[test_only]
    public fun config_evt_new_max_spread_bps(e: &ConfigUpdatedEvent): u64 { e.new_max_spread_bps }
    #[test_only]
    public fun config_evt_new_config_version(e: &ConfigUpdatedEvent): u64 { e.new_config_version }
    #[test_only]
    public fun config_evt_old_max_host_fee(e: &ConfigUpdatedEvent): u64 { e.old_max_host_fee_mist }
    #[test_only]
    public fun config_evt_new_max_host_fee(e: &ConfigUpdatedEvent): u64 { e.new_max_host_fee_mist }
}
