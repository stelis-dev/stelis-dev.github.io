module stelis::settle {
    use sui::coin::{Self, Coin};
    use sui::sui::SUI;
    use sui::clock::Clock;
    use stelis::config::{Self, Config};
    use stelis::vault::{Self, UserVault, VaultRegistry};
    use stelis::events;

    // --- Errors ---
    const EPaused: u64 = 100;
    const EClaimTooHigh: u64 = 101;
    const ETotalInTooLow: u64 = 102;
    const EInsufficientFunds: u64 = 103;
    const EInvalidReceiptId: u64 = 104;
    const EInvalidPolicyHash: u64 = 105;
    // L2 tamper-detection errors (fingerprint bypass / inconsistent PTB)
    const EConfigVersionMismatch: u64 = 106;
    const EProtocolFeeMismatch: u64 = 107;
    const EHostFeeCapExceeded: u64 = 108;
    const EInvalidOrderIdHash: u64 = 109;
    /// Spread guard: bid-ask spread exceeds Config.max_spread_bps, or book is
    /// empty / one-sided / crossed.  Only enforced on swap entrypoints.
    const ESpreadTooWide: u64 = 110;
    const SPREAD_GUARD_DEPTH: u64 = 8;
    const DEEPBOOK_PRICE_SCALE: u128 = 1_000_000_000;

    // ─────────────────────────────────────────────
    // Spread Guard — internal helper
    //
    // Checks that the DeepBook pool has a valid, narrow-enough bid-ask spread
    // before executing a swap.  Aborts with ESpreadTooWide (110) if:
    //   - bid or ask side is empty
    //   - best_ask <= best_bid (crossed book)
    //   - spread exceeds config.max_spread_bps
    //
    // Uses u128 arithmetic to prevent overflow on large prices
    // (DeepBook MAX_PRICE = (1u128 << 63) - 1).
    // ─────────────────────────────────────────────

    fun assert_spread_ok<BaseType, QuoteType>(
        config: &Config,
        pool: &deepbook::pool::Pool<BaseType, QuoteType>,
        input_amount: u64,
        is_base_for_quote: bool,
        clock: &Clock,
    ) {
        let (bid_prices, bid_qtys, ask_prices, ask_qtys) =
            deepbook::pool::get_level2_ticks_from_mid<BaseType, QuoteType>(pool, SPREAD_GUARD_DEPTH, clock);

        // Fail-closed: empty or one-sided book
        assert!(!bid_prices.is_empty() && !ask_prices.is_empty(), ESpreadTooWide);

        let (effective_bid, effective_ask) = if (is_base_for_quote) {
            (
                cumulative_bid_price_for_base_input(&bid_prices, &bid_qtys, input_amount),
                ask_prices[0],
            )
        } else {
            (
                bid_prices[0],
                cumulative_ask_price_for_quote_input(&ask_prices, &ask_qtys, input_amount),
            )
        };

        check_spread_from_prices(effective_bid, effective_ask, config::max_spread_bps(config));
    }

    fun cumulative_bid_price_for_base_input(
        prices: &vector<u64>,
        quantities: &vector<u64>,
        input_base_amount: u64,
    ): u64 {
        assert!(input_base_amount > 0, ESpreadTooWide);
        assert!(vector::length(prices) == vector::length(quantities), ESpreadTooWide);
        let mut remaining = input_base_amount;
        let mut filled_base = 0u128;
        let mut quote_out = 0u128;
        let mut i = 0;
        let len = vector::length(prices);
        while (i < len && remaining > 0) {
            let level_base = quantities[i];
            if (level_base > 0) {
                let take = if (level_base >= remaining) remaining else level_base;
                filled_base = filled_base + (take as u128);
                quote_out = quote_out + (((take as u128) * (prices[i] as u128)) / DEEPBOOK_PRICE_SCALE);
                remaining = remaining - take;
            };
            i = i + 1;
        };
        assert!(remaining == 0 && filled_base > 0 && quote_out > 0, ESpreadTooWide);
        ((quote_out * DEEPBOOK_PRICE_SCALE) / filled_base) as u64
    }

    fun cumulative_ask_price_for_quote_input(
        prices: &vector<u64>,
        quantities: &vector<u64>,
        input_quote_amount: u64,
    ): u64 {
        assert!(input_quote_amount > 0, ESpreadTooWide);
        assert!(vector::length(prices) == vector::length(quantities), ESpreadTooWide);
        let mut remaining = input_quote_amount as u128;
        let mut spent_quote = 0u128;
        let mut base_out = 0u128;
        let mut i = 0;
        let len = vector::length(prices);
        while (i < len && remaining > 0) {
            let price = prices[i] as u128;
            let level_base = quantities[i] as u128;
            let level_quote_capacity = (level_base * price) / DEEPBOOK_PRICE_SCALE;
            if (level_quote_capacity > 0) {
                if (level_quote_capacity >= remaining) {
                    let base_take = (remaining * DEEPBOOK_PRICE_SCALE) / price;
                    assert!(base_take > 0, ESpreadTooWide);
                    spent_quote = spent_quote + remaining;
                    base_out = base_out + base_take;
                    remaining = 0;
                } else {
                    spent_quote = spent_quote + level_quote_capacity;
                    base_out = base_out + level_base;
                    remaining = remaining - level_quote_capacity;
                };
            };
            i = i + 1;
        };
        assert!(remaining == 0 && spent_quote > 0 && base_out > 0, ESpreadTooWide);
        ((spent_quote * DEEPBOOK_PRICE_SCALE) / base_out) as u64
    }

    /// Pure spread judgment: aborts with ESpreadTooWide if spread is invalid.
    /// Extracted so it can be tested via #[test_only] without a real DeepBook pool.
    fun check_spread_from_prices(
        best_bid: u64,
        best_ask: u64,
        max_spread_bps: u64,
    ) {
        // Fail-closed: crossed or zero-width book
        assert!(best_ask > best_bid, ESpreadTooWide);

        // Spread calculation in u128 to avoid overflow:
        //   spread_bps = (best_ask - best_bid) * 10_000 / best_ask
        let spread_bps = (
            ((best_ask - best_bid) as u128) * 10_000u128 / (best_ask as u128)
        ) as u64;

        assert!(spread_bps <= max_spread_bps, ESpreadTooWide);
    }

    /// Test-only entry point for direct spread logic testing without a DeepBook pool.
    #[test_only]
    public fun assert_spread_ok_from_prices(
        best_bid: u64,
        best_ask: u64,
        max_spread_bps: u64,
    ) {
        check_spread_from_prices(best_bid, best_ask, max_spread_bps);
    }

    #[test_only]
    public fun assert_base_for_quote_spread_ok_from_book(
        bid_prices: vector<u64>,
        bid_quantities: vector<u64>,
        ask_prices: vector<u64>,
        ask_quantities: vector<u64>,
        input_base_amount: u64,
        max_spread_bps: u64,
    ) {
        assert!(!bid_prices.is_empty() && !ask_prices.is_empty(), ESpreadTooWide);
        assert!(vector::length(&ask_prices) == vector::length(&ask_quantities), ESpreadTooWide);
        let effective_bid = cumulative_bid_price_for_base_input(&bid_prices, &bid_quantities, input_base_amount);
        check_spread_from_prices(effective_bid, ask_prices[0], max_spread_bps);
    }

    #[test_only]
    public fun assert_quote_for_base_spread_ok_from_book(
        bid_prices: vector<u64>,
        bid_quantities: vector<u64>,
        ask_prices: vector<u64>,
        ask_quantities: vector<u64>,
        input_quote_amount: u64,
        max_spread_bps: u64,
    ) {
        assert!(!bid_prices.is_empty() && !ask_prices.is_empty(), ESpreadTooWide);
        assert!(vector::length(&bid_prices) == vector::length(&bid_quantities), ESpreadTooWide);
        let effective_ask = cumulative_ask_price_for_quote_input(&ask_prices, &ask_quantities, input_quote_amount);
        check_spread_from_prices(bid_prices[0], effective_ask, max_spread_bps);
    }

    // ─────────────────────────────────────────────
    // Core settlement logic (vault-independent)
    //
    // Handles: validations, fee splits, protocol fee, event emission.
    // Returns: surplus Coin<SUI> for caller to handle.
    //
    // Caller responsibilities:
    //   - Replay prevention (vault: check_and_advance_nonce)
    //   - Surplus handling (vault: join_surplus)
    // ─────────────────────────────────────────────

    public(package) fun settle_core(
        config: &Config,
        clock: &Clock,
        mut coin_in: Coin<SUI>,
        execution_cost_claim_mist: u64,
        settlement_payout_recipient: address,
        receipt_id: vector<u8>,
        nonce: u64,
        sim_gas_reported: u64,
        gas_variance_fixed_mist: u64,
        slippage_buffer_mist: u64,
        quoted_host_fee_mist: u64,
        expected_protocol_fee_mist: u64,
        expected_config_version: u64,
        enforce_min_settle_mist: bool,
        quote_timestamp_ms: u64,
        policy_hash: vector<u8>,
        order_id_hash: vector<u8>,
        ctx: &mut TxContext
    ): Coin<SUI> {
        // P-1: Paused check
        assert!(!config::paused(config), EPaused);

        // S-10, S-11: Length checks
        let pid_len = vector::length(&receipt_id);
        assert!(pid_len == 0 || pid_len == 32, EInvalidReceiptId);
        let ph_len = vector::length(&policy_hash);
        assert!(ph_len == 0 || ph_len == 32, EInvalidPolicyHash);
        let oid_len = vector::length(&order_id_hash);
        assert!(oid_len == 0 || oid_len == 32, EInvalidOrderIdHash);

        // S-2: Claim upper bound
        assert!(execution_cost_claim_mist <= config::max_claim_mist(config), EClaimTooHigh);

        // S-3: Total in lower bound
        let total_in = coin::value(&coin_in);
        if (enforce_min_settle_mist) {
            assert!(total_in >= config::min_settle_mist(config), ETotalInTooLow);
        };

        // L2: Config version drift detection
        assert!(config::config_version(config) == expected_config_version, EConfigVersionMismatch);

        // L2: Protocol fee tamper detection (must match on-chain value exactly)
        let protocol_fee = config::protocol_flat_fee_mist(config);
        assert!(protocol_fee == expected_protocol_fee_mist, EProtocolFeeMismatch);

        // L2: Host fee cap enforcement (quoted fee must not exceed on-chain cap)
        assert!(quoted_host_fee_mist <= config::max_host_fee_mist(config), EHostFeeCapExceeded);

        // S-4: Check sufficiency (E-9 non-loss invariant)
        // u128 defense-in-depth: prevents overflow if MAX_CLAIM_MIST is ever raised.
        let total_deduction = (execution_cost_claim_mist as u128) + (quoted_host_fee_mist as u128) + (protocol_fee as u128);
        assert!((total_in as u128) >= total_deduction, EInsufficientFunds);

        // Compute surplus — safe: config.move cap guarantees payout fits u64,
        // and the u128 assert above proves total_in >= total_deduction.
        let payout = execution_cost_claim_mist + quoted_host_fee_mist;
        let surplus = total_in - (total_deduction as u64);

        // S-9: Transfer payout coin to the settlement payout recipient
        let payout_coin = coin::split(&mut coin_in, payout, ctx);
        transfer::public_transfer(payout_coin, settlement_payout_recipient);

        // Protocol fee handling
        let protocol_treasury = config::protocol_treasury(config);
        if (protocol_fee > 0) {
            let proto_coin = coin::split(&mut coin_in, protocol_fee, ctx);
            transfer::public_transfer(proto_coin, protocol_treasury);
        };

        // Emit settle event with full audit trail
        let exec_timestamp_ms = sui::clock::timestamp_ms(clock);
        events::emit_settle_event(
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
            surplus,
            expected_config_version,
            ctx.sender(),
            settlement_payout_recipient,
            order_id_hash,
        );

        // Return surplus coin — caller decides destination
        coin_in
    }

    // ─────────────────────────────────────────────
    // Vault-path wrapper (used by all existing entry points)
    // ─────────────────────────────────────────────

    fun settle_internal(
        config: &Config,
        clock: &Clock,
        user_vault: &mut UserVault,
        coin_in: Coin<SUI>,
        execution_cost_claim_mist: u64,
        settlement_payout_recipient: address,
        receipt_id: vector<u8>,
        nonce: u64,
        sim_gas_reported: u64,
        gas_variance_fixed_mist: u64,
        slippage_buffer_mist: u64,
        quoted_host_fee_mist: u64,
        expected_protocol_fee_mist: u64,
        expected_config_version: u64,
        enforce_min_settle_mist: bool,
        quote_timestamp_ms: u64,
        policy_hash: vector<u8>,
        order_id_hash: vector<u8>,
        ctx: &mut TxContext
    ) {
        // S-14: Replay prevention (monotonic nonce)
        vault::check_and_advance_nonce(user_vault, nonce);

        let surplus_coin = settle_core(
            config, clock, coin_in,
            execution_cost_claim_mist, settlement_payout_recipient, receipt_id, nonce,
            sim_gas_reported, gas_variance_fixed_mist, slippage_buffer_mist,
            quoted_host_fee_mist, expected_protocol_fee_mist, expected_config_version,
            enforce_min_settle_mist, quote_timestamp_ms, policy_hash, order_id_hash,
            ctx,
        );

        // S-9: Deposit surplus into vault (skip join when surplus = 0)
        if (coin::value(&surplus_coin) > 0) {
            vault::join_surplus(user_vault, coin::into_balance(surplus_coin));
        } else {
            coin::destroy_zero(surplus_coin);
        };
    }

    // ─────────────────────────────────────────────
    // swap_and_settle_new_user_bfq()
    // ─────────────────────────────────────────────

    #[allow(lint(self_transfer))]
    public fun swap_and_settle_new_user_bfq<BaseType>(
        config: &Config,
        registry: &mut VaultRegistry,
        clock: &Clock,
        pool: &mut deepbook::pool::Pool<BaseType, SUI>,
        mut payment_coin: sui::coin::Coin<BaseType>,
        swap_amount: u64,
        min_sui_out: u64,
        execution_cost_claim_mist: u64,
        settlement_payout_recipient: address,
        receipt_id: vector<u8>,
        nonce: u64,
        sim_gas_reported: u64,
        gas_variance_fixed_mist: u64,
        slippage_buffer_mist: u64,
        quoted_host_fee_mist: u64,
        expected_protocol_fee_mist: u64,
        expected_config_version: u64,
        quote_timestamp_ms: u64,
        policy_hash: vector<u8>,
        order_id_hash: vector<u8>,
        ctx: &mut TxContext
    ) {
        // Spread guard: check pool health before swap
        assert_spread_ok(config, pool, swap_amount, true, clock);

        // Input-fee mode: zero DEEP coin forces DeepBook to charge fee from the
        // input token economy instead of the DEEP token economy. Stelis never
        // materializes a non-zero DEEP fee coin on the sponsored swap path.
        let deep_fee_coin = coin::zero<token::deep::DEEP>(ctx);
        let base_in = coin::split(&mut payment_coin, swap_amount, ctx);
        let (base_leftover, sui_coin, deep_leftover) = deepbook::pool::swap_exact_base_for_quote<BaseType, SUI>(
            pool, base_in, deep_fee_coin, min_sui_out, clock, ctx,
        );

        // Zero-coin cleanup: destroy 0-value leftovers to avoid unnecessary
        // storage cost (~988K MIST/object). Non-zero leftovers are returned to user.
        if (coin::value(&base_leftover) > 0) {
            transfer::public_transfer(base_leftover, ctx.sender());
        } else {
            coin::destroy_zero(base_leftover);
        };
        if (coin::value(&payment_coin) > 0) {
            transfer::public_transfer(payment_coin, ctx.sender());
        } else {
            coin::destroy_zero(payment_coin);
        };
        coin::destroy_zero(deep_leftover);

        let mut user_vault = vault::create_vault(ctx);
        vault::register_vault(registry, ctx.sender(), vault::vault_id(&user_vault));

        settle_internal(
            config, clock, &mut user_vault, sui_coin,
            execution_cost_claim_mist, settlement_payout_recipient, receipt_id, nonce,
            sim_gas_reported, gas_variance_fixed_mist, slippage_buffer_mist,
            quoted_host_fee_mist, expected_protocol_fee_mist, expected_config_version,
            true, quote_timestamp_ms, policy_hash, order_id_hash,
            ctx,
        );

        vault::transfer_vault(user_vault, ctx.sender());
    }

    // ─────────────────────────────────────────────
    // swap_and_settle_with_vault_bfq()
    // ─────────────────────────────────────────────

    #[allow(lint(self_transfer))]
    public fun swap_and_settle_with_vault_bfq<BaseType>(
        config: &Config,
        registry: &VaultRegistry,
        clock: &Clock,
        user_vault: &mut UserVault,
        pool: &mut deepbook::pool::Pool<BaseType, SUI>,
        mut payment_coin: sui::coin::Coin<BaseType>,
        swap_amount: u64,
        min_sui_out: u64,
        execution_cost_claim_mist: u64,
        settlement_payout_recipient: address,
        receipt_id: vector<u8>,
        nonce: u64,
        sim_gas_reported: u64,
        gas_variance_fixed_mist: u64,
        slippage_buffer_mist: u64,
        quoted_host_fee_mist: u64,
        expected_protocol_fee_mist: u64,
        expected_config_version: u64,
        quote_timestamp_ms: u64,
        policy_hash: vector<u8>,
        order_id_hash: vector<u8>,
        use_credit_amount: u64,
        ctx: &mut TxContext
    ) {
        vault::validate_vault(registry, ctx.sender(), vault::vault_id(user_vault));

        // Spread guard: check pool health before swap
        assert_spread_ok(config, pool, swap_amount, true, clock);

        // Input-fee mode: zero DEEP coin forces DeepBook to charge fee from the
        // input token economy instead of the DEEP token economy.
        let deep_fee_coin = coin::zero<token::deep::DEEP>(ctx);
        let base_in = coin::split(&mut payment_coin, swap_amount, ctx);

        if (use_credit_amount > 0) {
            let credit_coin = vault::use_credit(user_vault, use_credit_amount, ctx);
            let (base_leftover, mut sui_coin, deep_leftover) = deepbook::pool::swap_exact_base_for_quote<BaseType, SUI>(
                pool, base_in, deep_fee_coin, min_sui_out, clock, ctx,
            );
            coin::join(&mut sui_coin, credit_coin);
            // Zero-coin cleanup (with_vault, credit branch)
            if (coin::value(&base_leftover) > 0) {
                transfer::public_transfer(base_leftover, ctx.sender());
            } else {
                coin::destroy_zero(base_leftover);
            };
            if (coin::value(&payment_coin) > 0) {
                transfer::public_transfer(payment_coin, ctx.sender());
            } else {
                coin::destroy_zero(payment_coin);
            };
            coin::destroy_zero(deep_leftover);
            settle_internal(
                config, clock, user_vault, sui_coin,
                execution_cost_claim_mist, settlement_payout_recipient, receipt_id, nonce,
                sim_gas_reported, gas_variance_fixed_mist, slippage_buffer_mist,
                quoted_host_fee_mist, expected_protocol_fee_mist, expected_config_version,
                true, quote_timestamp_ms, policy_hash, order_id_hash,
                ctx,
            );
        } else {
            let (base_leftover, sui_coin, deep_leftover) = deepbook::pool::swap_exact_base_for_quote<BaseType, SUI>(
                pool, base_in, deep_fee_coin, min_sui_out, clock, ctx,
            );
            // Zero-coin cleanup (with_vault, non-credit branch)
            if (coin::value(&base_leftover) > 0) {
                transfer::public_transfer(base_leftover, ctx.sender());
            } else {
                coin::destroy_zero(base_leftover);
            };
            if (coin::value(&payment_coin) > 0) {
                transfer::public_transfer(payment_coin, ctx.sender());
            } else {
                coin::destroy_zero(payment_coin);
            };
            coin::destroy_zero(deep_leftover);
            settle_internal(
                config, clock, user_vault, sui_coin,
                execution_cost_claim_mist, settlement_payout_recipient, receipt_id, nonce,
                sim_gas_reported, gas_variance_fixed_mist, slippage_buffer_mist,
                quoted_host_fee_mist, expected_protocol_fee_mist, expected_config_version,
                true, quote_timestamp_ms, policy_hash, order_id_hash,
                ctx,
            );
        }
    }

    // ─────────────────────────────────────────────
    // swap_and_settle_new_user_qfb()
    // ─────────────────────────────────────────────

    #[allow(lint(self_transfer))]
    public fun swap_and_settle_new_user_qfb<QuoteType>(
        config: &Config,
        registry: &mut VaultRegistry,
        clock: &Clock,
        pool: &mut deepbook::pool::Pool<SUI, QuoteType>,
        mut payment_coin: sui::coin::Coin<QuoteType>,
        swap_amount: u64,
        min_sui_out: u64,
        execution_cost_claim_mist: u64,
        settlement_payout_recipient: address,
        receipt_id: vector<u8>,
        nonce: u64,
        sim_gas_reported: u64,
        gas_variance_fixed_mist: u64,
        slippage_buffer_mist: u64,
        quoted_host_fee_mist: u64,
        expected_protocol_fee_mist: u64,
        expected_config_version: u64,
        quote_timestamp_ms: u64,
        policy_hash: vector<u8>,
        order_id_hash: vector<u8>,
        ctx: &mut TxContext
    ) {
        // Spread guard: check pool health before swap
        assert_spread_ok(config, pool, swap_amount, false, clock);

        // Input-fee mode: zero DEEP coin forces DeepBook to charge fee from the
        // input token economy instead of the DEEP token economy.
        let deep_fee_coin = coin::zero<token::deep::DEEP>(ctx);
        let quote_in = coin::split(&mut payment_coin, swap_amount, ctx);
        // qfb: position [0] = Coin<SUI> (base output), [1] = Coin<QuoteType> (quote leftover)
        let (sui_coin, quote_leftover, deep_leftover) = deepbook::pool::swap_exact_quote_for_base<SUI, QuoteType>(
            pool, quote_in, deep_fee_coin, min_sui_out, clock, ctx,
        );

        // Zero-coin cleanup
        if (coin::value(&quote_leftover) > 0) {
            transfer::public_transfer(quote_leftover, ctx.sender());
        } else {
            coin::destroy_zero(quote_leftover);
        };
        if (coin::value(&payment_coin) > 0) {
            transfer::public_transfer(payment_coin, ctx.sender());
        } else {
            coin::destroy_zero(payment_coin);
        };
        coin::destroy_zero(deep_leftover);

        let mut user_vault = vault::create_vault(ctx);
        vault::register_vault(registry, ctx.sender(), vault::vault_id(&user_vault));

        settle_internal(
            config, clock, &mut user_vault, sui_coin,
            execution_cost_claim_mist, settlement_payout_recipient, receipt_id, nonce,
            sim_gas_reported, gas_variance_fixed_mist, slippage_buffer_mist,
            quoted_host_fee_mist, expected_protocol_fee_mist, expected_config_version,
            true, quote_timestamp_ms, policy_hash, order_id_hash,
            ctx,
        );

        vault::transfer_vault(user_vault, ctx.sender());
    }

    // ─────────────────────────────────────────────
    // swap_and_settle_with_vault_qfb()
    // ─────────────────────────────────────────────

    #[allow(lint(self_transfer))]
    public fun swap_and_settle_with_vault_qfb<QuoteType>(
        config: &Config,
        registry: &VaultRegistry,
        clock: &Clock,
        user_vault: &mut UserVault,
        pool: &mut deepbook::pool::Pool<SUI, QuoteType>,
        mut payment_coin: sui::coin::Coin<QuoteType>,
        swap_amount: u64,
        min_sui_out: u64,
        execution_cost_claim_mist: u64,
        settlement_payout_recipient: address,
        receipt_id: vector<u8>,
        nonce: u64,
        sim_gas_reported: u64,
        gas_variance_fixed_mist: u64,
        slippage_buffer_mist: u64,
        quoted_host_fee_mist: u64,
        expected_protocol_fee_mist: u64,
        expected_config_version: u64,
        quote_timestamp_ms: u64,
        policy_hash: vector<u8>,
        order_id_hash: vector<u8>,
        use_credit_amount: u64,
        ctx: &mut TxContext
    ) {
        vault::validate_vault(registry, ctx.sender(), vault::vault_id(user_vault));

        // Spread guard: check pool health before swap
        assert_spread_ok(config, pool, swap_amount, false, clock);

        // Input-fee mode: zero DEEP coin forces DeepBook to charge fee from the
        // input token economy instead of the DEEP token economy.
        let deep_fee_coin = coin::zero<token::deep::DEEP>(ctx);
        let quote_in = coin::split(&mut payment_coin, swap_amount, ctx);

        if (use_credit_amount > 0) {
            let credit_coin = vault::use_credit(user_vault, use_credit_amount, ctx);
            // qfb: position [0] = Coin<SUI> (base output), [1] = Coin<QuoteType> (quote leftover)
            let (mut sui_coin, quote_leftover, deep_leftover) = deepbook::pool::swap_exact_quote_for_base<SUI, QuoteType>(
                pool, quote_in, deep_fee_coin, min_sui_out, clock, ctx,
            );
            coin::join(&mut sui_coin, credit_coin);
            // Zero-coin cleanup (with_vault, credit branch)
            if (coin::value(&quote_leftover) > 0) {
                transfer::public_transfer(quote_leftover, ctx.sender());
            } else {
                coin::destroy_zero(quote_leftover);
            };
            if (coin::value(&payment_coin) > 0) {
                transfer::public_transfer(payment_coin, ctx.sender());
            } else {
                coin::destroy_zero(payment_coin);
            };
            coin::destroy_zero(deep_leftover);
            settle_internal(
                config, clock, user_vault, sui_coin,
                execution_cost_claim_mist, settlement_payout_recipient, receipt_id, nonce,
                sim_gas_reported, gas_variance_fixed_mist, slippage_buffer_mist,
                quoted_host_fee_mist, expected_protocol_fee_mist, expected_config_version,
                true, quote_timestamp_ms, policy_hash, order_id_hash,
                ctx,
            );
        } else {
            // qfb: position [0] = Coin<SUI> (base output), [1] = Coin<QuoteType> (quote leftover)
            let (sui_coin, quote_leftover, deep_leftover) = deepbook::pool::swap_exact_quote_for_base<SUI, QuoteType>(
                pool, quote_in, deep_fee_coin, min_sui_out, clock, ctx,
            );
            // Zero-coin cleanup (with_vault, non-credit branch)
            if (coin::value(&quote_leftover) > 0) {
                transfer::public_transfer(quote_leftover, ctx.sender());
            } else {
                coin::destroy_zero(quote_leftover);
            };
            if (coin::value(&payment_coin) > 0) {
                transfer::public_transfer(payment_coin, ctx.sender());
            } else {
                coin::destroy_zero(payment_coin);
            };
            coin::destroy_zero(deep_leftover);
            settle_internal(
                config, clock, user_vault, sui_coin,
                execution_cost_claim_mist, settlement_payout_recipient, receipt_id, nonce,
                sim_gas_reported, gas_variance_fixed_mist, slippage_buffer_mist,
                quoted_host_fee_mist, expected_protocol_fee_mist, expected_config_version,
                true, quote_timestamp_ms, policy_hash, order_id_hash,
                ctx,
            );
        }
    }

    // ─────────────────────────────────────────────
    // settle_with_credit()
    // ─────────────────────────────────────────────

    public fun settle_with_credit(
        config: &Config,
        registry: &VaultRegistry,
        clock: &Clock,
        user_vault: &mut UserVault,
        use_credit_amount: u64,
        execution_cost_claim_mist: u64,
        settlement_payout_recipient: address,
        receipt_id: vector<u8>,
        nonce: u64,
        sim_gas_reported: u64,
        gas_variance_fixed_mist: u64,
        slippage_buffer_mist: u64,
        quoted_host_fee_mist: u64,
        expected_protocol_fee_mist: u64,
        expected_config_version: u64,
        quote_timestamp_ms: u64,
        policy_hash: vector<u8>,
        order_id_hash: vector<u8>,
        ctx: &mut TxContext
    ) {
        vault::validate_vault(registry, ctx.sender(), vault::vault_id(user_vault));
        let credit_coin = vault::use_credit(user_vault, use_credit_amount, ctx);
        settle_internal(
            config, clock, user_vault, credit_coin,
            execution_cost_claim_mist, settlement_payout_recipient, receipt_id, nonce,
            sim_gas_reported, gas_variance_fixed_mist, slippage_buffer_mist,
            quoted_host_fee_mist, expected_protocol_fee_mist, expected_config_version,
            false, quote_timestamp_ms, policy_hash, order_id_hash,
            ctx,
        );
    }

    // ─────────────────────────────────────────────
    // Test-only helpers
    // ─────────────────────────────────────────────

    #[test_only]
    public fun settle_for_testing(
        config: &Config,
        registry: &mut VaultRegistry,
        clock: &Clock,
        coin_in: Coin<SUI>,
        execution_cost_claim_mist: u64,
        settlement_payout_recipient: address,
        receipt_id: vector<u8>,
        nonce: u64,
        sim_gas_reported: u64,
        gas_variance_fixed_mist: u64,
        slippage_buffer_mist: u64,
        quoted_host_fee_mist: u64,
        expected_protocol_fee_mist: u64,
        expected_config_version: u64,
        quote_timestamp_ms: u64,
        policy_hash: vector<u8>,
        order_id_hash: vector<u8>,
        ctx: &mut TxContext
    ) {
        let mut user_vault = vault::create_vault(ctx);
        vault::register_vault(registry, ctx.sender(), vault::vault_id(&user_vault));
        settle_internal(
            config, clock, &mut user_vault, coin_in,
            execution_cost_claim_mist, settlement_payout_recipient, receipt_id, nonce,
            sim_gas_reported, gas_variance_fixed_mist, slippage_buffer_mist,
            quoted_host_fee_mist, expected_protocol_fee_mist, expected_config_version,
            true, quote_timestamp_ms, policy_hash, order_id_hash,
            ctx,
        );
        vault::transfer_vault(user_vault, ctx.sender());
    }

    #[test_only]
    public fun settle_with_vault_for_testing(
        config: &Config,
        registry: &VaultRegistry,
        clock: &Clock,
        user_vault: &mut UserVault,
        coin_in: Coin<SUI>,
        execution_cost_claim_mist: u64,
        settlement_payout_recipient: address,
        receipt_id: vector<u8>,
        nonce: u64,
        sim_gas_reported: u64,
        gas_variance_fixed_mist: u64,
        slippage_buffer_mist: u64,
        quoted_host_fee_mist: u64,
        expected_protocol_fee_mist: u64,
        expected_config_version: u64,
        quote_timestamp_ms: u64,
        policy_hash: vector<u8>,
        order_id_hash: vector<u8>,
        use_credit_amount: u64,
        ctx: &mut TxContext
    ) {
        vault::validate_vault(registry, ctx.sender(), vault::vault_id(user_vault));
        if (use_credit_amount > 0) {
            let credit_coin = vault::use_credit(user_vault, use_credit_amount, ctx);
            let mut merged = coin_in;
            coin::join(&mut merged, credit_coin);
            settle_internal(
                config, clock, user_vault, merged,
                execution_cost_claim_mist, settlement_payout_recipient, receipt_id, nonce,
                sim_gas_reported, gas_variance_fixed_mist, slippage_buffer_mist,
                quoted_host_fee_mist, expected_protocol_fee_mist, expected_config_version,
                true, quote_timestamp_ms, policy_hash, order_id_hash,
                ctx,
            );
        } else {
            settle_internal(
                config, clock, user_vault, coin_in,
                execution_cost_claim_mist, settlement_payout_recipient, receipt_id, nonce,
                sim_gas_reported, gas_variance_fixed_mist, slippage_buffer_mist,
                quoted_host_fee_mist, expected_protocol_fee_mist, expected_config_version,
                true, quote_timestamp_ms, policy_hash, order_id_hash,
                ctx,
            );
        }
    }

    #[test_only]
    public fun settle_for_testing_balance_result(
        config: &Config,
        clock: &Clock,
        user_vault: &mut UserVault,
        coin_in: Coin<SUI>,
        execution_cost_claim_mist: u64,
        settlement_payout_recipient: address,
        receipt_id: vector<u8>,
        nonce: u64,
        sim_gas_reported: u64,
        gas_variance_fixed_mist: u64,
        slippage_buffer_mist: u64,
        quoted_host_fee_mist: u64,
        expected_protocol_fee_mist: u64,
        expected_config_version: u64,
        quote_timestamp_ms: u64,
        policy_hash: vector<u8>,
        order_id_hash: vector<u8>,
        ctx: &mut TxContext
    ) {
        settle_internal(
            config, clock, user_vault, coin_in,
            execution_cost_claim_mist, settlement_payout_recipient, receipt_id, nonce,
            sim_gas_reported, gas_variance_fixed_mist, slippage_buffer_mist,
            quoted_host_fee_mist, expected_protocol_fee_mist, expected_config_version,
            true, quote_timestamp_ms, policy_hash, order_id_hash,
            ctx,
        );
    }

    // ─────────────────────────────────────────────
    // Test-only helpers for swap_and_settle paths
    // These simulate the routing logic without DeepBook pool dependency,
    // allowing coverage of the non-swap portions of those entry points.
    // ─────────────────────────────────────────────

    /// Simulates swap_and_settle_new_user_bfq / swap_and_settle_new_user_qfb: create vault + settle_internal (no pool).
    #[test_only]
    #[allow(lint(self_transfer))]
    public fun swap_and_settle_new_user_for_testing(
        config: &Config,
        registry: &mut VaultRegistry,
        clock: &Clock,
        sui_coin: Coin<SUI>,
        execution_cost_claim_mist: u64,
        settlement_payout_recipient: address,
        receipt_id: vector<u8>,
        nonce: u64,
        sim_gas_reported: u64,
        gas_variance_fixed_mist: u64,
        slippage_buffer_mist: u64,
        quoted_host_fee_mist: u64,
        expected_protocol_fee_mist: u64,
        expected_config_version: u64,
        quote_timestamp_ms: u64,
        policy_hash: vector<u8>,
        order_id_hash: vector<u8>,
        ctx: &mut TxContext
    ) {
        let mut user_vault = vault::create_vault(ctx);
        vault::register_vault(registry, ctx.sender(), vault::vault_id(&user_vault));
        settle_internal(
            config, clock, &mut user_vault, sui_coin,
            execution_cost_claim_mist, settlement_payout_recipient, receipt_id, nonce,
            sim_gas_reported, gas_variance_fixed_mist, slippage_buffer_mist,
            quoted_host_fee_mist, expected_protocol_fee_mist, expected_config_version,
            true, quote_timestamp_ms, policy_hash, order_id_hash,
            ctx,
        );
        vault::transfer_vault(user_vault, ctx.sender());
    }

    /// Simulates swap_and_settle_with_vault_* (use_credit=0 branch): validate + settle_internal.
    #[test_only]
    public fun swap_and_settle_with_vault_for_testing(
        config: &Config,
        registry: &VaultRegistry,
        clock: &Clock,
        user_vault: &mut UserVault,
        sui_coin: Coin<SUI>,
        execution_cost_claim_mist: u64,
        settlement_payout_recipient: address,
        receipt_id: vector<u8>,
        nonce: u64,
        sim_gas_reported: u64,
        gas_variance_fixed_mist: u64,
        slippage_buffer_mist: u64,
        quoted_host_fee_mist: u64,
        expected_protocol_fee_mist: u64,
        expected_config_version: u64,
        quote_timestamp_ms: u64,
        policy_hash: vector<u8>,
        order_id_hash: vector<u8>,
        ctx: &mut TxContext
    ) {
        vault::validate_vault(registry, ctx.sender(), vault::vault_id(user_vault));
        settle_internal(
            config, clock, user_vault, sui_coin,
            execution_cost_claim_mist, settlement_payout_recipient, receipt_id, nonce,
            sim_gas_reported, gas_variance_fixed_mist, slippage_buffer_mist,
            quoted_host_fee_mist, expected_protocol_fee_mist, expected_config_version,
            true, quote_timestamp_ms, policy_hash, order_id_hash,
            ctx,
        );
    }

    /// Simulates swap_and_settle_with_vault_* (use_credit>0 branch): validate + merge + settle_internal.
    #[test_only]
    public fun swap_and_settle_with_vault_credit_for_testing(
        config: &Config,
        registry: &VaultRegistry,
        clock: &Clock,
        user_vault: &mut UserVault,
        mut sui_coin: Coin<SUI>,
        use_credit_amount: u64,
        execution_cost_claim_mist: u64,
        settlement_payout_recipient: address,
        receipt_id: vector<u8>,
        nonce: u64,
        sim_gas_reported: u64,
        gas_variance_fixed_mist: u64,
        slippage_buffer_mist: u64,
        quoted_host_fee_mist: u64,
        expected_protocol_fee_mist: u64,
        expected_config_version: u64,
        quote_timestamp_ms: u64,
        policy_hash: vector<u8>,
        order_id_hash: vector<u8>,
        ctx: &mut TxContext
    ) {
        vault::validate_vault(registry, ctx.sender(), vault::vault_id(user_vault));
        if (use_credit_amount > 0) {
            let credit_coin = vault::use_credit(user_vault, use_credit_amount, ctx);
            coin::join(&mut sui_coin, credit_coin);
        };
        settle_internal(
            config, clock, user_vault, sui_coin,
            execution_cost_claim_mist, settlement_payout_recipient, receipt_id, nonce,
            sim_gas_reported, gas_variance_fixed_mist, slippage_buffer_mist,
            quoted_host_fee_mist, expected_protocol_fee_mist, expected_config_version,
            true, quote_timestamp_ms, policy_hash, order_id_hash,
            ctx,
        );
    }
}
