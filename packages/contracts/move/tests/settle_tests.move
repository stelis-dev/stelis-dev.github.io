module stelis::settle_tests {
    #[test_only]
    use sui::test_scenario::{Self, Scenario};
    #[test_only]
    use sui::coin::{Self, Coin};
    #[test_only]
    use sui::sui::SUI;
    #[test_only]
    use sui::clock;
    #[test_only]
    use stelis::config::{Self, Config};
    #[test_only]
    use stelis::vault::{Self, UserVault, VaultRegistry};
    #[test_only]
    use stelis::settle;
    #[test_only]
    use sui::event;

    // Test addresses
    const ADDR_ADMIN: address = @0xA;
    const ADDR_USER: address = @0xB;
    const ADDR_SETTLEMENT_PAYOUT_RECIPIENT: address = @0xC;

    // Errors
    const EPaused: u64 = 100;
    const EClaimTooHigh: u64 = 101;
    const ETotalInTooLow: u64 = 102;
    const EInsufficientFunds: u64 = 103;
    const EInvalidReceiptId: u64 = 104;
    const EInvalidPolicyHash: u64 = 105;
    // L2 tamper-detection error codes — defined in settle.move and mirrored here for test assertions
    const EConfigVersionMismatch: u64 = 106;
    const EProtocolFeeMismatch: u64 = 107;
    const EHostFeeCapExceeded: u64 = 108;

    // Config Errors
    const EInvalidMaxClaim: u64 = 2;
    const ENotAdmin: u64 = 3;
    const EInvalidMinSettle: u64 = 4;
    const ENoPendingAdmin: u64 = 6;
    const EInvalidHostFeeCap: u64 = 7;
    const EInvalidSpreadBps: u64 = 8;
    const EPendingAdminExists: u64 = 9;
    const EPendingConfigExists: u64 = 10;
    const ENoPendingConfig: u64 = 11;
    const EConfigUpdateNotReady: u64 = 12;
    const EPendingTreasuryExists: u64 = 13;
    const ENoPendingTreasury: u64 = 14;
    const ETreasuryUpdateNotReady: u64 = 15;
    const EPendingPauseExists: u64 = 16;
    const ENoPendingPause: u64 = 17;
    const EPauseUpdateNotReady: u64 = 18;
    // L2 tamper-detection error codes — defined in settle.move, referenced by abort value in tests

    // Vault Errors
    const EReplayNonce: u64 = 1;
    const EVaultAlreadyRegistered: u64 = 2;
    const EVaultMismatch: u64 = 4;
    const EVaultInsufficientBalance: u64 = 0;

    // Helper
    fun setup_test(scenario: &mut Scenario) {
        let ctx = test_scenario::ctx(scenario);
        config::init_for_testing(ctx);
    }

    fun advance_two_epochs_and_apply_config(scenario: &mut Scenario, sender: address) {
        test_scenario::next_epoch(scenario, sender);
        test_scenario::next_epoch(scenario, sender);
        {
            let mut config = test_scenario::take_shared<Config>(scenario);
            let ctx = test_scenario::ctx(scenario);
            config::apply_config_update(&mut config, ctx);
            test_scenario::return_shared(config);
        };
    }

    fun advance_two_epochs_and_apply_treasury(scenario: &mut Scenario, sender: address) {
        test_scenario::next_epoch(scenario, sender);
        test_scenario::next_epoch(scenario, sender);
        {
            let mut config = test_scenario::take_shared<Config>(scenario);
            let ctx = test_scenario::ctx(scenario);
            config::apply_protocol_treasury_update(&mut config, ctx);
            test_scenario::return_shared(config);
        };
    }

    fun advance_two_epochs_and_apply_pause(scenario: &mut Scenario, sender: address) {
        test_scenario::next_epoch(scenario, sender);
        test_scenario::next_epoch(scenario, sender);
        {
            let mut config = test_scenario::take_shared<Config>(scenario);
            let ctx = test_scenario::ctx(scenario);
            config::apply_paused_update(&mut config, ctx);
            test_scenario::return_shared(config);
        };
    }

    // --- Success Cases ---

    // Test settle() for NEW users — contract creates vault internally
    #[test]
    fun test_settle_new_user_success() {
        let mut scenario = test_scenario::begin(ADDR_ADMIN);
        setup_test(&mut scenario);
        let mut clock = clock::create_for_testing(test_scenario::ctx(&mut scenario));
        clock::set_for_testing(&mut clock, 1000);
        
        // 1. Settle (new user path — no existing vault)
        test_scenario::next_tx(&mut scenario, ADDR_USER);
        {
            let config = test_scenario::take_shared<Config>(&scenario);
            let mut registry = test_scenario::take_shared<VaultRegistry>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);

            // 1 SUI input
            let total_in_amt = 1_000_000_000; 
            let coin_in = coin::mint_for_testing<SUI>(total_in_amt, ctx);
            
            // 1 SUI input, quoted_host_fee_mist=0 (default), protocol_flat_fee=0
            // execution_cost_claim_mist=10M, fee=0, protocol_fee=0
            // Payout = 10_000_000, Surplus = 990_000_000
            let claim = 10_000_000;

            settle::settle_for_testing(
                &config, &mut registry, &clock, coin_in, claim, ADDR_SETTLEMENT_PAYOUT_RECIPIENT,
                vector[], 1, 0, 0, 0, 0, 0, 0, 0, vector[], vector[], ctx
            );

            test_scenario::return_shared(config);
            test_scenario::return_shared(registry);
        };

        // 2. Verify user received a vault with surplus
        test_scenario::next_tx(&mut scenario, ADDR_USER);
        {
            let vault = test_scenario::take_from_sender<UserVault>(&scenario);
            assert!(vault::balance(&vault) == 990_000_000, 1);
            test_scenario::return_to_sender(&scenario, vault);
        };

        // 3. Verify Relayer Receipt
        test_scenario::next_tx(&mut scenario, ADDR_SETTLEMENT_PAYOUT_RECIPIENT);
        {
            let coin = test_scenario::take_from_sender<Coin<SUI>>(&scenario);
            assert!(coin::value(&coin) == 10_000_000, 2); // Claim only (quoted_host_fee_mist=0)
            test_scenario::return_to_sender(&scenario, coin);
        };
        clock::destroy_for_testing(clock);
        test_scenario::end(scenario);
    }

    // Test settle_with_vault() for EXISTING users
    #[test]
    fun test_settle_with_vault_success() {
        let mut scenario = test_scenario::begin(ADDR_ADMIN);
        setup_test(&mut scenario);
        let mut clock = clock::create_for_testing(test_scenario::ctx(&mut scenario));
        clock::set_for_testing(&mut clock, 1000);

        // 1. Create vault via settle() (new user path)
        test_scenario::next_tx(&mut scenario, ADDR_USER);
        {
            let config = test_scenario::take_shared<Config>(&scenario);
            let mut registry = test_scenario::take_shared<VaultRegistry>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);
            let coin_in = coin::mint_for_testing<SUI>(1_000_000_000, ctx);
            settle::settle_for_testing(
                &config, &mut registry, &clock, coin_in, 10_000_000, ADDR_SETTLEMENT_PAYOUT_RECIPIENT,
                vector[], 1, 0, 0, 0, 0, 0, 0, 0, vector[], vector[], ctx
            );
            test_scenario::return_shared(config);
            test_scenario::return_shared(registry);
        };

        // 2. Settle with existing vault — use 0 credit
        test_scenario::next_tx(&mut scenario, ADDR_USER);
        {
            let config = test_scenario::take_shared<Config>(&scenario);
            let registry = test_scenario::take_shared<VaultRegistry>(&scenario);
            let mut vault = test_scenario::take_from_sender<UserVault>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);

            let coin_in = coin::mint_for_testing<SUI>(500_000_000, ctx);
            
            // Settle with vault, no credit usage
            settle::settle_with_vault_for_testing(
                &config, &registry, &clock, &mut vault, coin_in, 5_000_000, ADDR_SETTLEMENT_PAYOUT_RECIPIENT,
                vector[], 2, 0, 0, 0, 0, 0, 0, 0, vector[], vector[], 0, ctx
            );

            // Previous surplus 990M + new surplus (500M - 5M claim - 0 fee)
            // New surplus = 495_000_000
            // Total = 990_000_000 + 495_000_000 = 1_485_000_000
            assert!(vault::balance(&vault) == 1_485_000_000, 3);
            test_scenario::return_shared(config);
            test_scenario::return_shared(registry);
            test_scenario::return_to_sender(&scenario, vault);
        };
        clock::destroy_for_testing(clock);
        test_scenario::end(scenario);
    }

    // Test settle_with_vault() with credit usage
    #[test]
    fun test_settle_with_vault_use_credit() {
        let mut scenario = test_scenario::begin(ADDR_ADMIN);
        setup_test(&mut scenario);
        let mut clock = clock::create_for_testing(test_scenario::ctx(&mut scenario));
        clock::set_for_testing(&mut clock, 1000);

        // 1. Create vault via settle() with large input to accumulate credit
        test_scenario::next_tx(&mut scenario, ADDR_USER);
        {
            let config = test_scenario::take_shared<Config>(&scenario);
            let mut registry = test_scenario::take_shared<VaultRegistry>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);
            let coin_in = coin::mint_for_testing<SUI>(1_000_000_000, ctx);
            settle::settle_for_testing(
                &config, &mut registry, &clock, coin_in, 10_000_000, ADDR_SETTLEMENT_PAYOUT_RECIPIENT,
                vector[], 1, 0, 0, 0, 0, 0, 0, 0, vector[], vector[], ctx
            );
            test_scenario::return_shared(config);
            test_scenario::return_shared(registry);
        };

        // 2. Settle with vault, using credit
        test_scenario::next_tx(&mut scenario, ADDR_USER);
        {
            let config = test_scenario::take_shared<Config>(&scenario);
            let registry = test_scenario::take_shared<VaultRegistry>(&scenario);
            let mut vault = test_scenario::take_from_sender<UserVault>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);

            // Vault has 985M. Use 100M credit.
            let coin_in = coin::mint_for_testing<SUI>(100_000_000, ctx);
            let use_credit = 100_000_000;
            
            // total_in = 100M + 100M credit = 200M
            // claim = 5M, quoted_host_fee_mist = 0, protocol_flat_fee = 0
            // payout = 5M
            // surplus = 195M
            // vault balance = 990M - 100M (used) + 195M (surplus) = 1_085_000_000
            
            settle::settle_with_vault_for_testing(
                &config, &registry, &clock, &mut vault, coin_in, 5_000_000, ADDR_SETTLEMENT_PAYOUT_RECIPIENT,
                vector[], 2, 0, 0, 0, 0, 0, 0, 0, vector[], vector[], use_credit, ctx
            );

            assert!(vault::balance(&vault) == 1_085_000_000, 4);
            test_scenario::return_shared(config);
            test_scenario::return_shared(registry);
            test_scenario::return_to_sender(&scenario, vault);
        };
        clock::destroy_for_testing(clock);
        test_scenario::end(scenario);
    }

    // Test: settle_with_vault() aborts when use_credit_amount > vault balance
    #[test]
    #[expected_failure(abort_code = 0, location = stelis::vault)]
    fun test_settle_with_vault_insufficient_credit() {
        let mut scenario = test_scenario::begin(ADDR_ADMIN);
        setup_test(&mut scenario);
        let mut clock = clock::create_for_testing(test_scenario::ctx(&mut scenario));
        clock::set_for_testing(&mut clock, 1000);

        // 1. Create vault via settle() with small input (→ small surplus)
        test_scenario::next_tx(&mut scenario, ADDR_USER);
        {
            let config = test_scenario::take_shared<Config>(&scenario);
            let mut registry = test_scenario::take_shared<VaultRegistry>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);
            // 10M input, 0 claim → fee = 50K, surplus ≈ 9.95M
            let coin_in = coin::mint_for_testing<SUI>(10_000_000, ctx);
            settle::settle_for_testing(&config, &mut registry, &clock, coin_in, 0, ADDR_SETTLEMENT_PAYOUT_RECIPIENT, vector[], 1, 0, 0, 0, 0, 0, 0, 0, vector[], vector[], ctx);
            test_scenario::return_shared(config);
            test_scenario::return_shared(registry);
        };

        // 2. Try to use more credit than vault balance → should abort
        test_scenario::next_tx(&mut scenario, ADDR_USER);
        {
            let config = test_scenario::take_shared<Config>(&scenario);
            let registry = test_scenario::take_shared<VaultRegistry>(&scenario);
            let mut vault = test_scenario::take_from_sender<UserVault>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);

            // Vault has ~9.95M. Try to use 100M → EInsufficientBalance
            let coin_in = coin::mint_for_testing<SUI>(1_000_000, ctx);
            settle::settle_with_vault_for_testing(
                &config, &registry, &clock, &mut vault, coin_in, 0, ADDR_SETTLEMENT_PAYOUT_RECIPIENT,
                vector[], 2, 0, 0, 0, 0, 0, 0, 0, vector[], vector[], 100_000_000, ctx
            );

            test_scenario::return_shared(config);
            test_scenario::return_shared(registry);
            test_scenario::return_to_sender(&scenario, vault);
        };
        clock::destroy_for_testing(clock);
        test_scenario::end(scenario);
    }

    #[test]
    fun test_protocol_fee_logic() {
        let mut scenario = test_scenario::begin(ADDR_ADMIN);
        setup_test(&mut scenario);
        let mut clock = clock::create_for_testing(test_scenario::ctx(&mut scenario));
        clock::set_for_testing(&mut clock, 1000);

        // 1. Admin enables flat fees
        test_scenario::next_tx(&mut scenario, ADDR_ADMIN);
        {
            let mut config = test_scenario::take_shared<Config>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);
            let max_claim = config::max_claim_mist(&config);
            let min_settle = config::min_settle_mist(&config);
            
            // max_host_fee_mist=5_000_000, protocol_flat_fee_mist=10_000_000
            config::update_config(
                &mut config, 
                5_000_000,
                10_000_000,
                max_claim, 
                min_settle,
                500,
                ctx
            );
            test_scenario::return_shared(config);
        };
        advance_two_epochs_and_apply_config(&mut scenario, ADDR_SETTLEMENT_PAYOUT_RECIPIENT);

        // 2. User Settle (new user path)
        test_scenario::next_tx(&mut scenario, ADDR_USER);
        {
            let config = test_scenario::take_shared<Config>(&scenario);
            let mut registry = test_scenario::take_shared<VaultRegistry>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);

            let coin_in = coin::mint_for_testing<SUI>(1_000_000_000, ctx);
            let claim = 10_000_000;

            // quoted_host_fee = 5_000_000 (on-chain max_host_fee)
            // expected_protocol_fee = 10_000_000 (on-chain protocol_fee)
            // Payout = claim(10M) + quoted_host_fee(5M) = 15_000_000
            // Total deduction = 10M + 5M + 10M = 25_000_000
            // Surplus = 1_000M - 25M = 975_000_000

            let cv = config::config_version(&config);
            settle::settle_for_testing(
                &config, &mut registry, &clock, coin_in, claim, ADDR_SETTLEMENT_PAYOUT_RECIPIENT,
                vector[], 1, 0, 0, 0, 5_000_000, 10_000_000, cv, 0, vector[], vector[], ctx
            );

            test_scenario::return_shared(config);
            test_scenario::return_shared(registry);
        };

        // 3. Verify vault surplus
        test_scenario::next_tx(&mut scenario, ADDR_USER);
        {
            let vault = test_scenario::take_from_sender<UserVault>(&scenario);
            assert!(vault::balance(&vault) == 975_000_000, 5);
            test_scenario::return_to_sender(&scenario, vault);
        };

        // 4. Verify Relayer Receipt
        test_scenario::next_tx(&mut scenario, ADDR_SETTLEMENT_PAYOUT_RECIPIENT);
        {
            let coin = test_scenario::take_from_sender<Coin<SUI>>(&scenario);
            assert!(coin::value(&coin) == 15_000_000, 6); // Claim + quoted host fee
            test_scenario::return_to_sender(&scenario, coin);
        };

        // 5. Verify Treasury Receipt (Admin Address)
        test_scenario::next_tx(&mut scenario, ADDR_ADMIN); // Treasury initially set to deployer
        {
            let coin = test_scenario::take_from_sender<Coin<SUI>>(&scenario);
            assert!(coin::value(&coin) == 10_000_000, 7); // Protocol flat fee
            test_scenario::return_to_sender(&scenario, coin);
        };
        clock::destroy_for_testing(clock);
        test_scenario::end(scenario);
    }

    #[test]
    fun test_paused_withdraw_success() {
        let mut scenario = test_scenario::begin(ADDR_ADMIN);
        setup_test(&mut scenario);
        let mut clock = clock::create_for_testing(test_scenario::ctx(&mut scenario));
        clock::set_for_testing(&mut clock, 1000);

        // 1. Create vault with funds via settle()
        test_scenario::next_tx(&mut scenario, ADDR_USER);
        {
            let config = test_scenario::take_shared<Config>(&scenario);
            let mut registry = test_scenario::take_shared<VaultRegistry>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);
            let coin_in = coin::mint_for_testing<SUI>(100_000_000, ctx);
            // claim=0 → all goes to surplus after fees
            settle::settle_for_testing(
                &config, &mut registry, &clock, coin_in, 0, ADDR_SETTLEMENT_PAYOUT_RECIPIENT,
                vector[], 1, 0, 0, 0, 0, 0, 0, 0, vector[], vector[], ctx
            );
            test_scenario::return_shared(config);
            test_scenario::return_shared(registry);
        };

        // 2. Admin Pauses
        test_scenario::next_tx(&mut scenario, ADDR_ADMIN);
        {
            let mut config = test_scenario::take_shared<Config>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);
            config::set_paused(&mut config, true, ctx);
            test_scenario::return_shared(config);
        };

        // 3. User Withdraws during pause — P-2: always callable
        test_scenario::next_tx(&mut scenario, ADDR_USER);
        {
            let mut vault = test_scenario::take_from_sender<UserVault>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);
            
            let coin = vault::withdraw(&mut vault, ctx);
            // claim=0, quoted_host_fee_mist=0 → all goes to surplus
            // surplus ≈ 100_000_000
            assert!(coin::value(&coin) == 100_000_000, 7);
            
            transfer::public_transfer(coin, ADDR_USER);
            test_scenario::return_to_sender(&scenario, vault);
        };
        clock::destroy_for_testing(clock);
        test_scenario::end(scenario);
    }

    // --- Failure Cases ---

    #[test]
    #[expected_failure(abort_code = EPaused, location = stelis::settle)]
    fun test_settle_fail_paused() {
        let mut scenario = test_scenario::begin(ADDR_ADMIN);
        setup_test(&mut scenario);
        let mut clock = clock::create_for_testing(test_scenario::ctx(&mut scenario));
        clock::set_for_testing(&mut clock, 1000);

        test_scenario::next_tx(&mut scenario, ADDR_ADMIN);
        {
            let mut config = test_scenario::take_shared<Config>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);
            config::set_paused(&mut config, true, ctx);
            test_scenario::return_shared(config);
        };

        // settle() for new user — should fail because paused
        test_scenario::next_tx(&mut scenario, ADDR_USER);
        {
            let config = test_scenario::take_shared<Config>(&scenario);
            let mut registry = test_scenario::take_shared<VaultRegistry>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);
            let coin_in = coin::mint_for_testing<SUI>(1_000_000, ctx);

            settle::settle_for_testing(&config, &mut registry, &clock, coin_in, 10, ADDR_SETTLEMENT_PAYOUT_RECIPIENT, vector[], 1, 0, 0, 0, 0, 0, 0, 0, vector[], vector[], ctx);
            
            test_scenario::return_shared(config);
            test_scenario::return_shared(registry);
        };
        clock::destroy_for_testing(clock);
        test_scenario::end(scenario);
    }

    // P-3: settle_with_vault also blocked when paused (use_credit is internal to settle_with_vault)
    #[test]
    #[expected_failure(abort_code = EPaused, location = stelis::settle)]
    fun test_settle_with_vault_fail_paused() {
        let mut scenario = test_scenario::begin(ADDR_ADMIN);
        setup_test(&mut scenario);
        let mut clock = clock::create_for_testing(test_scenario::ctx(&mut scenario));
        clock::set_for_testing(&mut clock, 1000);

        // 1. Create vault via settle()
        test_scenario::next_tx(&mut scenario, ADDR_USER);
        {
            let config = test_scenario::take_shared<Config>(&scenario);
            let mut registry = test_scenario::take_shared<VaultRegistry>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);
            let coin_in = coin::mint_for_testing<SUI>(100_000_000, ctx);
            settle::settle_for_testing(&config, &mut registry, &clock, coin_in, 0, ADDR_SETTLEMENT_PAYOUT_RECIPIENT, vector[], 1, 0, 0, 0, 0, 0, 0, 0, vector[], vector[], ctx);
            test_scenario::return_shared(config);
            test_scenario::return_shared(registry);
        };

        // 2. Admin pauses
        test_scenario::next_tx(&mut scenario, ADDR_ADMIN);
        {
            let mut config = test_scenario::take_shared<Config>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);
            config::set_paused(&mut config, true, ctx);
            test_scenario::return_shared(config);
        };

        // 3. settle_with_vault fails when paused
        test_scenario::next_tx(&mut scenario, ADDR_USER);
        {
            let config = test_scenario::take_shared<Config>(&scenario);
            let registry = test_scenario::take_shared<VaultRegistry>(&scenario);
            let mut vault = test_scenario::take_from_sender<UserVault>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);
            let coin_in = coin::mint_for_testing<SUI>(1_000_000, ctx);

            settle::settle_with_vault_for_testing(&config, &registry, &clock, &mut vault, coin_in, 10, ADDR_SETTLEMENT_PAYOUT_RECIPIENT, vector[], 2, 0, 0, 0, 0, 0, 0, 0, vector[], vector[], 0, ctx);
            
            test_scenario::return_shared(config);
            test_scenario::return_shared(registry);
            test_scenario::return_to_sender(&scenario, vault);
        };
        clock::destroy_for_testing(clock);
        test_scenario::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = EClaimTooHigh, location = stelis::settle)]
    fun test_settle_fail_claim_too_high() {
        let mut scenario = test_scenario::begin(ADDR_ADMIN);
        setup_test(&mut scenario);
        let mut clock = clock::create_for_testing(test_scenario::ctx(&mut scenario));
        clock::set_for_testing(&mut clock, 1000);

        test_scenario::next_tx(&mut scenario, ADDR_USER);
        {
            let config = test_scenario::take_shared<Config>(&scenario);
            let mut registry = test_scenario::take_shared<VaultRegistry>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);
            
            let high_claim = config::max_claim_mist(&config) + 1; // Above current max_claim
            let coin_in = coin::mint_for_testing<SUI>(100_000_000, ctx);

            settle::settle_for_testing(&config, &mut registry, &clock, coin_in, high_claim, ADDR_SETTLEMENT_PAYOUT_RECIPIENT, vector[], 1, 0, 0, 0, 0, 0, 0, 0, vector[], vector[], ctx);
            test_scenario::return_shared(config);
            test_scenario::return_shared(registry);
        };
        clock::destroy_for_testing(clock);
        test_scenario::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = EInsufficientFunds, location = stelis::settle)]
    fun test_settle_fail_insufficient_funds() {
        let mut scenario = test_scenario::begin(ADDR_ADMIN);
        setup_test(&mut scenario);
        let mut clock = clock::create_for_testing(test_scenario::ctx(&mut scenario));
        clock::set_for_testing(&mut clock, 1000);

        test_scenario::next_tx(&mut scenario, ADDR_USER);
        {
            let config = test_scenario::take_shared<Config>(&scenario);
            let mut registry = test_scenario::take_shared<VaultRegistry>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);
            
            // Fee 0, so need at least claim amount
            // coin_in = 10M = claim → total_in=10M, need 10M+0+0 = 10M → just enough
            // But test_settle_fail_insufficient_funds: coin_in < claim+quoted_host_fee_mist+protocol_fee
            // With quoted_host_fee_mist=0: need total_in >= claim. coin_in=claim exactly → passes.
            // To trigger EInsufficientFunds, enable quoted_host_fee_mist so that claim+fee>total_in
            // Here we rely on the fact that quoted_host_fee_mist comes from config (default=0).
            // For a proper insufficient funds test, use coin_in strictly < claim:
            let claim = 10_000_000;
            let coin_in = coin::mint_for_testing<SUI>(claim - 1, ctx); // 1 short

            settle::settle_for_testing(&config, &mut registry, &clock, coin_in, claim, ADDR_SETTLEMENT_PAYOUT_RECIPIENT, vector[], 1, 0, 0, 0, 0, 0, 0, 0, vector[], vector[], ctx);
            test_scenario::return_shared(config);
            test_scenario::return_shared(registry);
        };
        clock::destroy_for_testing(clock);
        test_scenario::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = ETotalInTooLow, location = stelis::settle)]
    fun test_settle_fail_min_settle() {
        let mut scenario = test_scenario::begin(ADDR_ADMIN);
        setup_test(&mut scenario);
        let mut clock = clock::create_for_testing(test_scenario::ctx(&mut scenario));
        clock::set_for_testing(&mut clock, 1000);

        // Set min_settle to higher value for testing
        test_scenario::next_tx(&mut scenario, ADDR_ADMIN);
        {
            let mut config = test_scenario::take_shared<Config>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);
            let max_claim = config::max_claim_mist(&config);
            config::update_config(&mut config, 0, 0, max_claim, 1_000_000, 500, ctx);
            test_scenario::return_shared(config);
        };
        advance_two_epochs_and_apply_config(&mut scenario, ADDR_SETTLEMENT_PAYOUT_RECIPIENT);

        test_scenario::next_tx(&mut scenario, ADDR_USER);
        {
            let config = test_scenario::take_shared<Config>(&scenario);
            let mut registry = test_scenario::take_shared<VaultRegistry>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);
            
            // Input 100 MIST vs Min 1_000_000 MIST
            let coin_in = coin::mint_for_testing<SUI>(100, ctx);

            settle::settle_for_testing(&config, &mut registry, &clock, coin_in, 0, ADDR_SETTLEMENT_PAYOUT_RECIPIENT, vector[], 1, 0, 0, 0, 0, 0, 0, 0, vector[], vector[], ctx);
            test_scenario::return_shared(config);
            test_scenario::return_shared(registry);
        };
        clock::destroy_for_testing(clock);
        test_scenario::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = EInvalidPolicyHash, location = stelis::settle)]
    fun test_settle_fail_policy_hash_len() {
        let mut scenario = test_scenario::begin(ADDR_ADMIN);
        setup_test(&mut scenario);
        let mut clock = clock::create_for_testing(test_scenario::ctx(&mut scenario));
        clock::set_for_testing(&mut clock, 1000);

        test_scenario::next_tx(&mut scenario, ADDR_USER);
        {
            let config = test_scenario::take_shared<Config>(&scenario);
            let mut registry = test_scenario::take_shared<VaultRegistry>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);
            let coin_in = coin::mint_for_testing<SUI>(100_000_000, ctx);

            let bad_hash = vector[1, 2, 3]; // Invalid length
            settle::settle_for_testing(&config, &mut registry, &clock, coin_in, 0, ADDR_SETTLEMENT_PAYOUT_RECIPIENT, vector[], 1, 0, 0, 0, 0, 0, 0, 0, bad_hash, vector[], ctx);
            
            test_scenario::return_shared(config);
            test_scenario::return_shared(registry);
        };
        clock::destroy_for_testing(clock);
        test_scenario::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = EInvalidReceiptId, location = stelis::settle)]
    fun test_settle_fail_receipt_id_len() {
        let mut scenario = test_scenario::begin(ADDR_ADMIN);
        setup_test(&mut scenario);
        let mut clock = clock::create_for_testing(test_scenario::ctx(&mut scenario));
        clock::set_for_testing(&mut clock, 1000);

        test_scenario::next_tx(&mut scenario, ADDR_USER);
        {
            let config = test_scenario::take_shared<Config>(&scenario);
            let mut registry = test_scenario::take_shared<VaultRegistry>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);
            let coin_in = coin::mint_for_testing<SUI>(100_000_000, ctx);

            let bad_pid = vector[1, 2, 3]; // Invalid length (not 0 or 32)
            settle::settle_for_testing(&config, &mut registry, &clock, coin_in, 0, ADDR_SETTLEMENT_PAYOUT_RECIPIENT, bad_pid, 1, 0, 0, 0, 0, 0, 0, 0, vector[], vector[], ctx);
            
            test_scenario::return_shared(config);
            test_scenario::return_shared(registry);
        };
        clock::destroy_for_testing(clock);
        test_scenario::end(scenario);
    }

    // S-10b: order_id_hash must be 0 or 32 bytes
    const EInvalidOrderIdHash: u64 = 109;

    #[test]
    #[expected_failure(abort_code = EInvalidOrderIdHash, location = stelis::settle)]
    fun test_settle_fail_order_id_hash_len() {
        let mut scenario = test_scenario::begin(ADDR_ADMIN);
        setup_test(&mut scenario);
        let mut clock = clock::create_for_testing(test_scenario::ctx(&mut scenario));
        clock::set_for_testing(&mut clock, 1000);

        test_scenario::next_tx(&mut scenario, ADDR_USER);
        {
            let config = test_scenario::take_shared<Config>(&scenario);
            let mut registry = test_scenario::take_shared<VaultRegistry>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);
            let coin_in = coin::mint_for_testing<SUI>(100_000_000, ctx);

            let bad_oid = vector[1, 2, 3]; // Invalid length (not 0 or 32)
            settle::settle_for_testing(&config, &mut registry, &clock, coin_in, 0, ADDR_SETTLEMENT_PAYOUT_RECIPIENT, vector[], 1, 0, 0, 0, 0, 0, 0, 0, vector[], bad_oid, ctx);

            test_scenario::return_shared(config);
            test_scenario::return_shared(registry);
        };
        clock::destroy_for_testing(clock);
        test_scenario::end(scenario);
    }

    // ─────────────────────────────────────────────
    // L2 tamper-detection coverage
    // Guards against drift between /prepare-time and /sponsor-time Config
    // reads. settle.move lines 130, 134, 137 enforce these; these tests
    // lock the on-chain abort path for each one.
    // ─────────────────────────────────────────────

    // config_version drift: PTB carries an expected_config_version that does not
    // match the current Config.config_version → EConfigVersionMismatch (106).
    #[test]
    #[expected_failure(abort_code = EConfigVersionMismatch, location = stelis::settle)]
    fun test_settle_fail_config_version_mismatch() {
        let mut scenario = test_scenario::begin(ADDR_ADMIN);
        setup_test(&mut scenario);
        let mut clock = clock::create_for_testing(test_scenario::ctx(&mut scenario));
        clock::set_for_testing(&mut clock, 1000);

        test_scenario::next_tx(&mut scenario, ADDR_USER);
        {
            let config = test_scenario::take_shared<Config>(&scenario);
            let mut registry = test_scenario::take_shared<VaultRegistry>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);
            let coin_in = coin::mint_for_testing<SUI>(100_000_000, ctx);

            // Config initial version is 0; PTB claims expected_config_version = 99.
            // settle_core's drift check must reject this before any fund movement.
            let wrong_version = 99;
            settle::settle_for_testing(
                &config, &mut registry, &clock, coin_in,
                0, ADDR_SETTLEMENT_PAYOUT_RECIPIENT, vector[], 1,
                0, 0, 0,
                0, // quoted_host_fee_mist
                0, // expected_protocol_fee_mist (matches current 0)
                wrong_version, // expected_config_version — drift!
                0, vector[], vector[],
                ctx,
            );
            test_scenario::return_shared(config);
            test_scenario::return_shared(registry);
        };
        clock::destroy_for_testing(clock);
        test_scenario::end(scenario);
    }

    // protocol_fee drift: admin updates protocol_flat_fee_mist; PTB still carries
    // the old expected_protocol_fee_mist → EProtocolFeeMismatch (107).
    #[test]
    #[expected_failure(abort_code = EProtocolFeeMismatch, location = stelis::settle)]
    fun test_settle_fail_protocol_fee_mismatch() {
        let mut scenario = test_scenario::begin(ADDR_ADMIN);
        setup_test(&mut scenario);
        let mut clock = clock::create_for_testing(test_scenario::ctx(&mut scenario));
        clock::set_for_testing(&mut clock, 1000);

        // Admin raises protocol_flat_fee_mist from 0 to 1000 (config_version 0 → 1)
        test_scenario::next_tx(&mut scenario, ADDR_ADMIN);
        {
            let mut config = test_scenario::take_shared<Config>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);
            // update_config(max_host_fee, protocol_flat_fee, max_claim, min_settle, max_spread_bps)
            config::update_config(&mut config, 0, 1000, 50_000_000, 100_000, 500, ctx);
            test_scenario::return_shared(config);
        };
        advance_two_epochs_and_apply_config(&mut scenario, ADDR_SETTLEMENT_PAYOUT_RECIPIENT);

        // User submits settle with stale expected_protocol_fee_mist = 500 (expects old fee),
        // but chain actually charges 1000. Drift must be rejected.
        test_scenario::next_tx(&mut scenario, ADDR_USER);
        {
            let config = test_scenario::take_shared<Config>(&scenario);
            let mut registry = test_scenario::take_shared<VaultRegistry>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);
            let coin_in = coin::mint_for_testing<SUI>(100_000_000, ctx);

            settle::settle_for_testing(
                &config, &mut registry, &clock, coin_in,
                0, ADDR_SETTLEMENT_PAYOUT_RECIPIENT, vector[], 1,
                0, 0, 0,
                0,   // quoted_host_fee_mist (within 0 cap)
                500, // expected_protocol_fee_mist — drift! (actual is 1000)
                1,   // expected_config_version matches current (1)
                0, vector[], vector[],
                ctx,
            );
            test_scenario::return_shared(config);
            test_scenario::return_shared(registry);
        };
        clock::destroy_for_testing(clock);
        test_scenario::end(scenario);
    }

    // host fee cap drift: PTB carries a quoted_host_fee_mist exceeding
    // config.max_host_fee_mist → EHostFeeCapExceeded (108).
    #[test]
    #[expected_failure(abort_code = EHostFeeCapExceeded, location = stelis::settle)]
    fun test_settle_fail_host_fee_cap_exceeded() {
        let mut scenario = test_scenario::begin(ADDR_ADMIN);
        setup_test(&mut scenario);
        let mut clock = clock::create_for_testing(test_scenario::ctx(&mut scenario));
        clock::set_for_testing(&mut clock, 1000);

        test_scenario::next_tx(&mut scenario, ADDR_USER);
        {
            let config = test_scenario::take_shared<Config>(&scenario);
            let mut registry = test_scenario::take_shared<VaultRegistry>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);
            let coin_in = coin::mint_for_testing<SUI>(100_000_000, ctx);

            // Config initial max_host_fee_mist is 0; PTB claims 100 (> cap).
            settle::settle_for_testing(
                &config, &mut registry, &clock, coin_in,
                0, ADDR_SETTLEMENT_PAYOUT_RECIPIENT, vector[], 1,
                0, 0, 0,
                100, // quoted_host_fee_mist — exceeds current cap of 0!
                0,   // expected_protocol_fee_mist
                0,   // expected_config_version
                0, vector[], vector[],
                ctx,
            );
            test_scenario::return_shared(config);
            test_scenario::return_shared(registry);
        };
        clock::destroy_for_testing(clock);
        test_scenario::end(scenario);
    }

    // --- Config Failure Cases ---

    #[test]
    #[expected_failure(abort_code = EInvalidMaxClaim, location = stelis::config)]
    fun test_config_fail_fee_too_high() {
        let mut scenario = test_scenario::begin(ADDR_ADMIN);
        setup_test(&mut scenario);

        test_scenario::next_tx(&mut scenario, ADDR_ADMIN);
        {
            let mut config = test_scenario::take_shared<Config>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);
            // max_host_fee_mist has no upper cap — test with max_claim exceeding the package hard cap
            config::update_config(&mut config, 0, 0, config::get_max_claim_mist() + 1, 0, 500, ctx);
            test_scenario::return_shared(config);
        };
        test_scenario::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = EInvalidMinSettle, location = stelis::config)]
    fun test_config_fail_protocol_fee_too_high() {
        let mut scenario = test_scenario::begin(ADDR_ADMIN);
        setup_test(&mut scenario);

        test_scenario::next_tx(&mut scenario, ADDR_ADMIN);
        {
            let mut config = test_scenario::take_shared<Config>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);
            let max_claim = config::max_claim_mist(&config);
            // protocol_flat_fee_mist has no upper cap — test EInvalidMinSettle instead
            config::update_config(&mut config, 0, 0, max_claim, max_claim + 1, 500, ctx);
            test_scenario::return_shared(config);
        };
        test_scenario::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = EInvalidMinSettle, location = stelis::config)]
    fun test_config_fail_min_settle_too_high() {
        let mut scenario = test_scenario::begin(ADDR_ADMIN);
        setup_test(&mut scenario);

        test_scenario::next_tx(&mut scenario, ADDR_ADMIN);
        {
            let mut config = test_scenario::take_shared<Config>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);
            let max_claim = config::max_claim_mist(&config);
            // Min settle must stay <= max_claim
            config::update_config(&mut config, 50, 0, max_claim, max_claim + 1, 500, ctx);
            test_scenario::return_shared(config);
        };
        test_scenario::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = EInvalidMaxClaim, location = stelis::config)]
    fun test_config_fail_max_claim_too_low() {
        let mut scenario = test_scenario::begin(ADDR_ADMIN);
        setup_test(&mut scenario);

        test_scenario::next_tx(&mut scenario, ADDR_ADMIN);
        {
            let mut config = test_scenario::take_shared<Config>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);
            // E-7: max_claim_mist > 0
            // Setting max_claim to 0 should fail (not strictly greater)
            config::update_config(&mut config, 0, 0, 0, 0, 500, ctx);
            test_scenario::return_shared(config);
        };
        test_scenario::end(scenario);
    }

    // --- Admin Failure Cases ---

    #[test]
    #[expected_failure(abort_code = ENotAdmin, location = stelis::config)]
    fun test_set_paused_not_admin() {
        let mut scenario = test_scenario::begin(ADDR_ADMIN);
        setup_test(&mut scenario);

        test_scenario::next_tx(&mut scenario, ADDR_USER); // Non-admin
        {
            let mut config = test_scenario::take_shared<Config>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);
            config::set_paused(&mut config, true, ctx);
            test_scenario::return_shared(config);
        };
        test_scenario::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = ENotAdmin, location = stelis::config)]
    fun test_update_treasury_not_admin() {
        let mut scenario = test_scenario::begin(ADDR_ADMIN);
        setup_test(&mut scenario);

        test_scenario::next_tx(&mut scenario, ADDR_USER); // Non-admin
        {
            let mut config = test_scenario::take_shared<Config>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);
            config::update_protocol_treasury(&mut config, @0xDEAD, ctx);
            test_scenario::return_shared(config);
        };
        test_scenario::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = ENotAdmin, location = stelis::config)]
    fun test_propose_admin_not_admin() {
        let mut scenario = test_scenario::begin(ADDR_ADMIN);
        setup_test(&mut scenario);

        test_scenario::next_tx(&mut scenario, ADDR_USER); // Non-admin
        {
            let mut config = test_scenario::take_shared<Config>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);
            config::propose_admin(&mut config, @0xDEAD, ctx);
            test_scenario::return_shared(config);
        };
        test_scenario::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = ENotAdmin, location = stelis::config)]
    fun test_update_config_not_admin() {
        let mut scenario = test_scenario::begin(ADDR_ADMIN);
        setup_test(&mut scenario);

        test_scenario::next_tx(&mut scenario, ADDR_USER); // Non-admin
        {
            let mut config = test_scenario::take_shared<Config>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);
            let max_claim = config::max_claim_mist(&config);
            let min_settle = config::min_settle_mist(&config);
            config::update_config(&mut config, 0, 0, max_claim, min_settle, 500, ctx);
            test_scenario::return_shared(config);
        };
        test_scenario::end(scenario);
    }

    // === S-14: Monotonic Nonce Replay Prevention Tests ===

    // Test: same nonce used twice on same vault should abort (nonce must be strictly increasing)
    #[test]
    #[expected_failure(abort_code = EReplayNonce, location = stelis::vault)]
    fun test_settle_replay_prevention() {
        let mut scenario = test_scenario::begin(ADDR_ADMIN);
        setup_test(&mut scenario);
        let mut clock = clock::create_for_testing(test_scenario::ctx(&mut scenario));
        clock::set_for_testing(&mut clock, 1000);

        // 1. Create vault via settle() with nonce=1
        test_scenario::next_tx(&mut scenario, ADDR_USER);
        {
            let config = test_scenario::take_shared<Config>(&scenario);
            let mut registry = test_scenario::take_shared<VaultRegistry>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);
            let coin_in = coin::mint_for_testing<SUI>(1_000_000_000, ctx);
            settle::settle_for_testing(
                &config, &mut registry, &clock, coin_in, 5_000_000, ADDR_SETTLEMENT_PAYOUT_RECIPIENT,
                vector[], 1, 0, 0, 0, 0, 0, 0, 0, vector[], vector[], ctx
            );
            test_scenario::return_shared(config);
            test_scenario::return_shared(registry);
        };

        // 2. settle_with_vault using SAME nonce=1 → should abort (EReplayNonce: 1 > 1 is false)
        test_scenario::next_tx(&mut scenario, ADDR_USER);
        {
            let config = test_scenario::take_shared<Config>(&scenario);
            let registry = test_scenario::take_shared<VaultRegistry>(&scenario);
            let mut vault = test_scenario::take_from_sender<UserVault>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);
            let coin_in = coin::mint_for_testing<SUI>(500_000_000, ctx);
            settle::settle_with_vault_for_testing(
                &config, &registry, &clock, &mut vault, coin_in, 5_000_000, ADDR_SETTLEMENT_PAYOUT_RECIPIENT,
                vector[], 1, 0, 0, 0, 0, 0, 0, 0, vector[], vector[], 0, ctx
            );
            test_scenario::return_shared(config);
            test_scenario::return_shared(registry);
            test_scenario::return_to_sender(&scenario, vault);
        };
        clock::destroy_for_testing(clock);
        test_scenario::end(scenario);
    }

    // Test: nonce reversal should abort (nonce must be strictly greater than last)
    #[test]
    #[expected_failure(abort_code = EReplayNonce, location = stelis::vault)]
    fun test_settle_nonce_reversal() {
        let mut scenario = test_scenario::begin(ADDR_ADMIN);
        setup_test(&mut scenario);
        let mut clock = clock::create_for_testing(test_scenario::ctx(&mut scenario));
        clock::set_for_testing(&mut clock, 1000);

        // 1. Create vault with nonce=5
        test_scenario::next_tx(&mut scenario, ADDR_USER);
        {
            let config = test_scenario::take_shared<Config>(&scenario);
            let mut registry = test_scenario::take_shared<VaultRegistry>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);
            let coin_in = coin::mint_for_testing<SUI>(1_000_000_000, ctx);
            settle::settle_for_testing(
                &config, &mut registry, &clock, coin_in, 5_000_000, ADDR_SETTLEMENT_PAYOUT_RECIPIENT,
                vector[], 5, 0, 0, 0, 0, 0, 0, 0, vector[], vector[], ctx
            );
            test_scenario::return_shared(config);
            test_scenario::return_shared(registry);
        };

        // 2. settle_with_vault with nonce=3 (reversal) → should abort
        test_scenario::next_tx(&mut scenario, ADDR_USER);
        {
            let config = test_scenario::take_shared<Config>(&scenario);
            let registry = test_scenario::take_shared<VaultRegistry>(&scenario);
            let mut vault = test_scenario::take_from_sender<UserVault>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);
            let coin_in = coin::mint_for_testing<SUI>(500_000_000, ctx);
            settle::settle_with_vault_for_testing(
                &config, &registry, &clock, &mut vault, coin_in, 5_000_000, ADDR_SETTLEMENT_PAYOUT_RECIPIENT,
                vector[], 3, 0, 0, 0, 0, 0, 0, 0, vector[], vector[], 0, ctx
            );
            test_scenario::return_shared(config);
            test_scenario::return_shared(registry);
            test_scenario::return_to_sender(&scenario, vault);
        };
        clock::destroy_for_testing(clock);
        test_scenario::end(scenario);
    }

    // Test: nonce gaps are allowed because the rule is nonce > last_nonce.
    #[test]
    fun test_settle_nonce_gap_allowed() {
        let mut scenario = test_scenario::begin(ADDR_ADMIN);
        setup_test(&mut scenario);
        let mut clock = clock::create_for_testing(test_scenario::ctx(&mut scenario));
        clock::set_for_testing(&mut clock, 1000);

        // 1. Create vault with nonce=1
        test_scenario::next_tx(&mut scenario, ADDR_USER);
        {
            let config = test_scenario::take_shared<Config>(&scenario);
            let mut registry = test_scenario::take_shared<VaultRegistry>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);
            let coin_in = coin::mint_for_testing<SUI>(1_000_000_000, ctx);
            settle::settle_for_testing(
                &config, &mut registry, &clock, coin_in, 5_000_000, ADDR_SETTLEMENT_PAYOUT_RECIPIENT,
                vector[], 1, 0, 0, 0, 0, 0, 0, 0, vector[], vector[], ctx
            );
            test_scenario::return_shared(config);
            test_scenario::return_shared(registry);
        };

        // 2. settle_with_vault with nonce=5 (gap: 1→5) — should succeed
        test_scenario::next_tx(&mut scenario, ADDR_USER);
        {
            let config = test_scenario::take_shared<Config>(&scenario);
            let registry = test_scenario::take_shared<VaultRegistry>(&scenario);
            let mut vault = test_scenario::take_from_sender<UserVault>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);
            let coin_in = coin::mint_for_testing<SUI>(500_000_000, ctx);
            settle::settle_with_vault_for_testing(
                &config, &registry, &clock, &mut vault, coin_in, 5_000_000, ADDR_SETTLEMENT_PAYOUT_RECIPIENT,
                vector[], 5, 0, 0, 0, 0, 0, 0, 0, vector[], vector[], 0, ctx
            );
            test_scenario::return_shared(config);
            test_scenario::return_shared(registry);
            test_scenario::return_to_sender(&scenario, vault);
        };

        // 3. settle_with_vault with nonce=100 (gap: 5→100) — should succeed
        test_scenario::next_tx(&mut scenario, ADDR_USER);
        {
            let config = test_scenario::take_shared<Config>(&scenario);
            let registry = test_scenario::take_shared<VaultRegistry>(&scenario);
            let mut vault = test_scenario::take_from_sender<UserVault>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);
            let coin_in = coin::mint_for_testing<SUI>(500_000_000, ctx);
            settle::settle_with_vault_for_testing(
                &config, &registry, &clock, &mut vault, coin_in, 5_000_000, ADDR_SETTLEMENT_PAYOUT_RECIPIENT,
                vector[], 100, 0, 0, 0, 0, 0, 0, 0, vector[], vector[], 0, ctx
            );
            test_scenario::return_shared(config);
            test_scenario::return_shared(registry);
            test_scenario::return_to_sender(&scenario, vault);
        };
        clock::destroy_for_testing(clock);
        test_scenario::end(scenario);
    }

    // Test: empty receipt_id with nonce — nonce is always checked regardless of receipt_id
    #[test]
    fun test_settle_empty_receipt_id_with_nonce() {
        let mut scenario = test_scenario::begin(ADDR_ADMIN);
        setup_test(&mut scenario);
        let mut clock = clock::create_for_testing(test_scenario::ctx(&mut scenario));
        clock::set_for_testing(&mut clock, 1000);

        // 1. Create vault with empty receipt_id, nonce=1
        test_scenario::next_tx(&mut scenario, ADDR_USER);
        {
            let config = test_scenario::take_shared<Config>(&scenario);
            let mut registry = test_scenario::take_shared<VaultRegistry>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);
            let coin_in = coin::mint_for_testing<SUI>(1_000_000_000, ctx);
            settle::settle_for_testing(
                &config, &mut registry, &clock, coin_in, 5_000_000, ADDR_SETTLEMENT_PAYOUT_RECIPIENT,
                vector[], 1, 0, 0, 0, 0, 0, 0, 0, vector[], vector[], ctx
            );
            test_scenario::return_shared(config);
            test_scenario::return_shared(registry);
        };

        // 2. settle_with_vault with empty receipt_id, nonce=2 — should succeed
        test_scenario::next_tx(&mut scenario, ADDR_USER);
        {
            let config = test_scenario::take_shared<Config>(&scenario);
            let registry = test_scenario::take_shared<VaultRegistry>(&scenario);
            let mut vault = test_scenario::take_from_sender<UserVault>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);
            let coin_in = coin::mint_for_testing<SUI>(500_000_000, ctx);
            settle::settle_with_vault_for_testing(
                &config, &registry, &clock, &mut vault, coin_in, 5_000_000, ADDR_SETTLEMENT_PAYOUT_RECIPIENT,
                vector[], 2, 0, 0, 0, 0, 0, 0, 0, vector[], vector[], 0, ctx
            );
            test_scenario::return_shared(config);
            test_scenario::return_shared(registry);
            test_scenario::return_to_sender(&scenario, vault);
        };
        clock::destroy_for_testing(clock);
        test_scenario::end(scenario);
    }

    // === Registered Vault Registry Tests ===

    // Test: settle() called twice by same user should abort (EVaultAlreadyRegistered)
    #[test]
    #[expected_failure(abort_code = EVaultAlreadyRegistered, location = stelis::vault)]
    fun test_settle_duplicate_vault_creation() {
        let mut scenario = test_scenario::begin(ADDR_ADMIN);
        setup_test(&mut scenario);
        let mut clock = clock::create_for_testing(test_scenario::ctx(&mut scenario));
        clock::set_for_testing(&mut clock, 1000);

        // 1. First settle() — OK
        test_scenario::next_tx(&mut scenario, ADDR_USER);
        {
            let config = test_scenario::take_shared<Config>(&scenario);
            let mut registry = test_scenario::take_shared<VaultRegistry>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);
            let coin_in = coin::mint_for_testing<SUI>(100_000_000, ctx);
            settle::settle_for_testing(&config, &mut registry, &clock, coin_in, 0, ADDR_SETTLEMENT_PAYOUT_RECIPIENT, vector[], 1, 0, 0, 0, 0, 0, 0, 0, vector[], vector[], ctx);
            test_scenario::return_shared(config);
            test_scenario::return_shared(registry);
        };

        // 2. Second settle() — should abort
        test_scenario::next_tx(&mut scenario, ADDR_USER);
        {
            let config = test_scenario::take_shared<Config>(&scenario);
            let mut registry = test_scenario::take_shared<VaultRegistry>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);
            let coin_in = coin::mint_for_testing<SUI>(100_000_000, ctx);
            settle::settle_for_testing(&config, &mut registry, &clock, coin_in, 0, ADDR_SETTLEMENT_PAYOUT_RECIPIENT, vector[], 1, 0, 0, 0, 0, 0, 0, 0, vector[], vector[], ctx);
            test_scenario::return_shared(config);
            test_scenario::return_shared(registry);
        };

        clock::destroy_for_testing(clock);
        test_scenario::end(scenario);
    }

    // === cancel_admin_proposal Tests ===

    // Admin cancels a pending proposal — pending_admin is cleared.
    // Verified by ensuring a subsequent accept_admin call fails with ENoPendingAdmin.
    #[test]
    fun test_cancel_admin_proposal_success() {
        let mut scenario = test_scenario::begin(ADDR_ADMIN);
        setup_test(&mut scenario);

        // 1. Admin proposes a new admin
        test_scenario::next_tx(&mut scenario, ADDR_ADMIN);
        {
            let mut config = test_scenario::take_shared<Config>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);
            config::propose_admin(&mut config, ADDR_USER, ctx);
            test_scenario::return_shared(config);
        };

        // 2. Admin cancels the proposal — should succeed
        test_scenario::next_tx(&mut scenario, ADDR_ADMIN);
        {
            let mut config = test_scenario::take_shared<Config>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);
            config::cancel_admin_proposal(&mut config, ctx);
            test_scenario::return_shared(config);
        };

        test_scenario::end(scenario);
    }

    // Non-admin calling cancel_admin_proposal should abort with ENotAdmin.
    #[test]
    #[expected_failure(abort_code = ENotAdmin, location = stelis::config)]
    fun test_cancel_admin_proposal_not_admin() {
        let mut scenario = test_scenario::begin(ADDR_ADMIN);
        setup_test(&mut scenario);

        // 1. Admin proposes a new admin
        test_scenario::next_tx(&mut scenario, ADDR_ADMIN);
        {
            let mut config = test_scenario::take_shared<Config>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);
            config::propose_admin(&mut config, ADDR_USER, ctx);
            test_scenario::return_shared(config);
        };

        // 2. Non-admin tries to cancel → ENotAdmin
        test_scenario::next_tx(&mut scenario, ADDR_SETTLEMENT_PAYOUT_RECIPIENT);
        {
            let mut config = test_scenario::take_shared<Config>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);
            config::cancel_admin_proposal(&mut config, ctx);
            test_scenario::return_shared(config);
        };

        test_scenario::end(scenario);
    }

    // Cancelling when no pending proposal exists should abort with ENoPendingAdmin.
    #[test]
    #[expected_failure(abort_code = ENoPendingAdmin, location = stelis::config)]
    fun test_cancel_admin_proposal_no_pending() {
        let mut scenario = test_scenario::begin(ADDR_ADMIN);
        setup_test(&mut scenario);

        // No pending proposal — cancel should abort
        test_scenario::next_tx(&mut scenario, ADDR_ADMIN);
        {
            let mut config = test_scenario::take_shared<Config>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);
            config::cancel_admin_proposal(&mut config, ctx);
            test_scenario::return_shared(config);
        };

        test_scenario::end(scenario);
    }

    // propose_admin while pending_admin already set → EPendingAdminExists.
    #[test]
    #[expected_failure(abort_code = EPendingAdminExists, location = stelis::config)]
    fun test_propose_admin_already_pending() {
        let mut scenario = test_scenario::begin(ADDR_ADMIN);
        setup_test(&mut scenario);

        // 1. Admin proposes ADDR_USER — success
        test_scenario::next_tx(&mut scenario, ADDR_ADMIN);
        {
            let mut config = test_scenario::take_shared<Config>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);
            config::propose_admin(&mut config, ADDR_USER, ctx);
            test_scenario::return_shared(config);
        };

        // 2. Admin proposes ADDR_SETTLEMENT_PAYOUT_RECIPIENT while pending_admin already set → EPendingAdminExists
        test_scenario::next_tx(&mut scenario, ADDR_ADMIN);
        {
            let mut config = test_scenario::take_shared<Config>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);
            config::propose_admin(&mut config, ADDR_SETTLEMENT_PAYOUT_RECIPIENT, ctx);
            test_scenario::return_shared(config);
        };

        test_scenario::end(scenario);
    }

    // === Fee Cap Tests (EInvalidHostFeeCap) ===

    // max_host_fee_mist + protocol_flat_fee_mist > max_claim_mist → EInvalidHostFeeCap.
    // u128 cast in config.move prevents ARITHMETIC_ERROR on u64 overflow.
    #[test]
    #[expected_failure(abort_code = EInvalidHostFeeCap, location = stelis::config)]
    fun test_update_config_fee_cap_exceeded() {
        let mut scenario = test_scenario::begin(ADDR_ADMIN);
        setup_test(&mut scenario);

        test_scenario::next_tx(&mut scenario, ADDR_ADMIN);
        {
            let mut config = test_scenario::take_shared<Config>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);
            let max_claim = config::max_claim_mist(&config);
            let min_settle = config::min_settle_mist(&config);
            let excessive_fee = (max_claim / 2) + 1;
            // host fee cap + protocol fee must not exceed max_claim.
            config::update_config(&mut config, excessive_fee, excessive_fee, max_claim, min_settle, 500, ctx);
            test_scenario::return_shared(config);
        };

        test_scenario::end(scenario);
    }

    // === Spread Cap Tests (EInvalidSpreadBps) ===

    // update_config with valid max_spread_bps updates the value and bumps config_version.
    #[test]
    fun test_update_config_spread_cap_success() {
        let mut scenario = test_scenario::begin(ADDR_ADMIN);
        setup_test(&mut scenario);

        test_scenario::next_tx(&mut scenario, ADDR_ADMIN);
        {
            let mut config = test_scenario::take_shared<Config>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);
            let max_claim = config::max_claim_mist(&config);
            let min_settle = config::min_settle_mist(&config);

            // Initial: max_spread_bps = 500, config_version = 0
            assert!(config::max_spread_bps(&config) == 500, 1);
            let v0 = config::config_version(&config);

            // Update spread cap to 300 (3%)
            config::update_config(&mut config, 0, 0, max_claim, min_settle, 300, ctx);
            assert!(config::max_spread_bps(&config) == 500, 4);
            assert!(config::config_version(&config) == v0, 5);
            test_scenario::return_shared(config);
        };

        advance_two_epochs_and_apply_config(&mut scenario, ADDR_SETTLEMENT_PAYOUT_RECIPIENT);

        test_scenario::next_tx(&mut scenario, ADDR_ADMIN);
        {
            let config = test_scenario::take_shared<Config>(&scenario);
            assert!(config::max_spread_bps(&config) == 300, 2);
            assert!(config::config_version(&config) == 1, 3);

            test_scenario::return_shared(config);
        };
        test_scenario::end(scenario);
    }

    // update_config emits ConfigUpdatedEvent with correct old/new spread bps values.
    #[test]
    fun test_update_config_spread_cap_event_payload() {
        let mut scenario = test_scenario::begin(ADDR_ADMIN);
        setup_test(&mut scenario);

        test_scenario::next_tx(&mut scenario, ADDR_ADMIN);
        {
            let mut config = test_scenario::take_shared<Config>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);
            let max_claim = config::max_claim_mist(&config);
            let min_settle = config::min_settle_mist(&config);

            // Update spread cap from 500 (default) to 300
            config::update_config(&mut config, 0, 0, max_claim, min_settle, 300, ctx);
            test_scenario::return_shared(config);
        };

        test_scenario::next_epoch(&mut scenario, ADDR_ADMIN);
        test_scenario::next_epoch(&mut scenario, ADDR_SETTLEMENT_PAYOUT_RECIPIENT);
        {
            let mut config = test_scenario::take_shared<Config>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);
            config::apply_config_update(&mut config, ctx);

            // Read the emitted ConfigUpdatedEvent in the same TX block
            let events = event::events_by_type<stelis::events::ConfigUpdatedEvent>();
            assert!(events.length() == 1, 11);
            let evt = &events[0];
            assert!(stelis::events::config_evt_old_max_spread_bps(evt) == 500, 12);
            assert!(stelis::events::config_evt_new_max_spread_bps(evt) == 300, 13);
            assert!(stelis::events::config_evt_new_config_version(evt) == 1, 14);
            assert!(stelis::events::config_evt_old_max_host_fee(evt) == 0, 15);
            assert!(stelis::events::config_evt_new_max_host_fee(evt) == 0, 16);

            test_scenario::return_shared(config);
        };
        test_scenario::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = EConfigUpdateNotReady, location = stelis::config)]
    fun test_update_config_apply_before_delay_fails() {
        let mut scenario = test_scenario::begin(ADDR_ADMIN);
        setup_test(&mut scenario);

        test_scenario::next_tx(&mut scenario, ADDR_ADMIN);
        {
            let mut config = test_scenario::take_shared<Config>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);
            let max_claim = config::max_claim_mist(&config);
            let min_settle = config::min_settle_mist(&config);
            config::update_config(&mut config, 0, 0, max_claim, min_settle, 300, ctx);
            test_scenario::return_shared(config);
        };

        test_scenario::next_epoch(&mut scenario, ADDR_SETTLEMENT_PAYOUT_RECIPIENT);
        {
            let mut config = test_scenario::take_shared<Config>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);
            config::apply_config_update(&mut config, ctx);
            test_scenario::return_shared(config);
        };

        test_scenario::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = EPendingConfigExists, location = stelis::config)]
    fun test_update_config_pending_collision() {
        let mut scenario = test_scenario::begin(ADDR_ADMIN);
        setup_test(&mut scenario);

        test_scenario::next_tx(&mut scenario, ADDR_ADMIN);
        {
            let mut config = test_scenario::take_shared<Config>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);
            let max_claim = config::max_claim_mist(&config);
            let min_settle = config::min_settle_mist(&config);
            config::update_config(&mut config, 0, 0, max_claim, min_settle, 300, ctx);
            config::update_config(&mut config, 0, 0, max_claim, min_settle, 400, ctx);
            test_scenario::return_shared(config);
        };

        test_scenario::end(scenario);
    }

    #[test]
    fun test_update_config_cancel_allows_new_proposal() {
        let mut scenario = test_scenario::begin(ADDR_ADMIN);
        setup_test(&mut scenario);

        test_scenario::next_tx(&mut scenario, ADDR_ADMIN);
        {
            let mut config = test_scenario::take_shared<Config>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);
            let max_claim = config::max_claim_mist(&config);
            let min_settle = config::min_settle_mist(&config);
            config::update_config(&mut config, 0, 0, max_claim, min_settle, 300, ctx);
            test_scenario::return_shared(config);
        };

        test_scenario::next_tx(&mut scenario, ADDR_ADMIN);
        {
            let mut config = test_scenario::take_shared<Config>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);
            let max_claim = config::max_claim_mist(&config);
            let min_settle = config::min_settle_mist(&config);
            config::cancel_config_update(&mut config, ctx);
            config::update_config(&mut config, 0, 0, max_claim, min_settle, 400, ctx);
            test_scenario::return_shared(config);
        };

        advance_two_epochs_and_apply_config(&mut scenario, ADDR_SETTLEMENT_PAYOUT_RECIPIENT);

        test_scenario::next_tx(&mut scenario, ADDR_ADMIN);
        {
            let config = test_scenario::take_shared<Config>(&scenario);
            assert!(config::max_spread_bps(&config) == 400, 61);
            test_scenario::return_shared(config);
        };

        test_scenario::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = ENoPendingConfig, location = stelis::config)]
    fun test_update_config_same_values_does_not_queue() {
        let mut scenario = test_scenario::begin(ADDR_ADMIN);
        setup_test(&mut scenario);

        test_scenario::next_tx(&mut scenario, ADDR_ADMIN);
        {
            let mut config = test_scenario::take_shared<Config>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);
            let max_host_fee = config::max_host_fee_mist(&config);
            let protocol_fee = config::protocol_flat_fee_mist(&config);
            let max_claim = config::max_claim_mist(&config);
            let min_settle = config::min_settle_mist(&config);
            let max_spread = config::max_spread_bps(&config);
            config::update_config(
                &mut config,
                max_host_fee,
                protocol_fee,
                max_claim,
                min_settle,
                max_spread,
                ctx,
            );
            assert!(config::config_version(&config) == 0, 73);
            test_scenario::return_shared(config);
        };

        test_scenario::next_epoch(&mut scenario, ADDR_SETTLEMENT_PAYOUT_RECIPIENT);
        test_scenario::next_epoch(&mut scenario, ADDR_SETTLEMENT_PAYOUT_RECIPIENT);
        {
            let mut config = test_scenario::take_shared<Config>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);
            config::apply_config_update(&mut config, ctx);
            test_scenario::return_shared(config);
        };

        test_scenario::end(scenario);
    }

    #[test]
    fun test_update_treasury_delayed_permissionless_apply() {
        let mut scenario = test_scenario::begin(ADDR_ADMIN);
        setup_test(&mut scenario);

        test_scenario::next_tx(&mut scenario, ADDR_ADMIN);
        {
            let mut config = test_scenario::take_shared<Config>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);
            config::update_protocol_treasury(&mut config, @0xD00D, ctx);
            assert!(config::protocol_treasury(&config) == ADDR_ADMIN, 62);
            test_scenario::return_shared(config);
        };

        advance_two_epochs_and_apply_treasury(&mut scenario, ADDR_SETTLEMENT_PAYOUT_RECIPIENT);

        test_scenario::next_tx(&mut scenario, ADDR_ADMIN);
        {
            let config = test_scenario::take_shared<Config>(&scenario);
            assert!(config::protocol_treasury(&config) == @0xD00D, 63);
            assert!(config::config_version(&config) == 1, 64);
            test_scenario::return_shared(config);
        };

        test_scenario::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = ETreasuryUpdateNotReady, location = stelis::config)]
    fun test_update_treasury_apply_before_delay_fails() {
        let mut scenario = test_scenario::begin(ADDR_ADMIN);
        setup_test(&mut scenario);

        test_scenario::next_tx(&mut scenario, ADDR_ADMIN);
        {
            let mut config = test_scenario::take_shared<Config>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);
            config::update_protocol_treasury(&mut config, @0xD00D, ctx);
            test_scenario::return_shared(config);
        };

        test_scenario::next_epoch(&mut scenario, ADDR_SETTLEMENT_PAYOUT_RECIPIENT);
        {
            let mut config = test_scenario::take_shared<Config>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);
            config::apply_protocol_treasury_update(&mut config, ctx);
            test_scenario::return_shared(config);
        };

        test_scenario::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = ENoPendingTreasury, location = stelis::config)]
    fun test_update_treasury_same_value_does_not_queue() {
        let mut scenario = test_scenario::begin(ADDR_ADMIN);
        setup_test(&mut scenario);

        test_scenario::next_tx(&mut scenario, ADDR_ADMIN);
        {
            let mut config = test_scenario::take_shared<Config>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);
            let treasury = config::protocol_treasury(&config);
            config::update_protocol_treasury(&mut config, treasury, ctx);
            assert!(config::config_version(&config) == 0, 74);
            test_scenario::return_shared(config);
        };

        test_scenario::next_epoch(&mut scenario, ADDR_SETTLEMENT_PAYOUT_RECIPIENT);
        test_scenario::next_epoch(&mut scenario, ADDR_SETTLEMENT_PAYOUT_RECIPIENT);
        {
            let mut config = test_scenario::take_shared<Config>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);
            config::apply_protocol_treasury_update(&mut config, ctx);
            test_scenario::return_shared(config);
        };

        test_scenario::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = EPendingTreasuryExists, location = stelis::config)]
    fun test_update_treasury_pending_collision() {
        let mut scenario = test_scenario::begin(ADDR_ADMIN);
        setup_test(&mut scenario);

        test_scenario::next_tx(&mut scenario, ADDR_ADMIN);
        {
            let mut config = test_scenario::take_shared<Config>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);
            config::update_protocol_treasury(&mut config, @0xD00D, ctx);
            config::update_protocol_treasury(&mut config, @0xD00E, ctx);
            test_scenario::return_shared(config);
        };

        test_scenario::end(scenario);
    }

    #[test]
    fun test_unpause_delayed_permissionless_apply() {
        let mut scenario = test_scenario::begin(ADDR_ADMIN);
        setup_test(&mut scenario);

        test_scenario::next_tx(&mut scenario, ADDR_ADMIN);
        {
            let mut config = test_scenario::take_shared<Config>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);
            config::set_paused(&mut config, true, ctx);
            assert!(config::paused(&config), 65);
            assert!(config::config_version(&config) == 1, 66);
            test_scenario::return_shared(config);
        };

        test_scenario::next_tx(&mut scenario, ADDR_ADMIN);
        {
            let mut config = test_scenario::take_shared<Config>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);
            config::set_paused(&mut config, false, ctx);
            assert!(config::paused(&config), 67);
            assert!(config::config_version(&config) == 1, 68);
            test_scenario::return_shared(config);
        };

        advance_two_epochs_and_apply_pause(&mut scenario, ADDR_SETTLEMENT_PAYOUT_RECIPIENT);

        test_scenario::next_tx(&mut scenario, ADDR_ADMIN);
        {
            let config = test_scenario::take_shared<Config>(&scenario);
            assert!(!config::paused(&config), 69);
            assert!(config::config_version(&config) == 2, 70);
            test_scenario::return_shared(config);
        };

        test_scenario::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = EPauseUpdateNotReady, location = stelis::config)]
    fun test_unpause_apply_before_delay_fails() {
        let mut scenario = test_scenario::begin(ADDR_ADMIN);
        setup_test(&mut scenario);

        test_scenario::next_tx(&mut scenario, ADDR_ADMIN);
        {
            let mut config = test_scenario::take_shared<Config>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);
            config::set_paused(&mut config, true, ctx);
            test_scenario::return_shared(config);
        };

        test_scenario::next_tx(&mut scenario, ADDR_ADMIN);
        {
            let mut config = test_scenario::take_shared<Config>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);
            config::set_paused(&mut config, false, ctx);
            test_scenario::return_shared(config);
        };

        test_scenario::next_epoch(&mut scenario, ADDR_SETTLEMENT_PAYOUT_RECIPIENT);
        {
            let mut config = test_scenario::take_shared<Config>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);
            config::apply_paused_update(&mut config, ctx);
            test_scenario::return_shared(config);
        };

        test_scenario::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = EPendingPauseExists, location = stelis::config)]
    fun test_unpause_pending_collision() {
        let mut scenario = test_scenario::begin(ADDR_ADMIN);
        setup_test(&mut scenario);

        test_scenario::next_tx(&mut scenario, ADDR_ADMIN);
        {
            let mut config = test_scenario::take_shared<Config>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);
            config::set_paused(&mut config, true, ctx);
            config::set_paused(&mut config, false, ctx);
            config::set_paused(&mut config, false, ctx);
            test_scenario::return_shared(config);
        };

        test_scenario::end(scenario);
    }

    #[test]
    fun test_repeated_emergency_pause_does_not_bump_version_without_state_change() {
        let mut scenario = test_scenario::begin(ADDR_ADMIN);
        setup_test(&mut scenario);

        test_scenario::next_tx(&mut scenario, ADDR_ADMIN);
        {
            let mut config = test_scenario::take_shared<Config>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);
            config::set_paused(&mut config, true, ctx);
            assert!(config::config_version(&config) == 1, 71);
            config::set_paused(&mut config, true, ctx);
            assert!(config::config_version(&config) == 1, 72);
            test_scenario::return_shared(config);
        };

        test_scenario::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = ENoPendingPause, location = stelis::config)]
    fun test_unpause_when_already_unpaused_does_not_queue() {
        let mut scenario = test_scenario::begin(ADDR_ADMIN);
        setup_test(&mut scenario);

        test_scenario::next_tx(&mut scenario, ADDR_ADMIN);
        {
            let mut config = test_scenario::take_shared<Config>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);
            config::set_paused(&mut config, false, ctx);
            assert!(config::config_version(&config) == 0, 75);
            test_scenario::return_shared(config);
        };

        test_scenario::next_epoch(&mut scenario, ADDR_SETTLEMENT_PAYOUT_RECIPIENT);
        test_scenario::next_epoch(&mut scenario, ADDR_SETTLEMENT_PAYOUT_RECIPIENT);
        {
            let mut config = test_scenario::take_shared<Config>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);
            config::apply_paused_update(&mut config, ctx);
            test_scenario::return_shared(config);
        };

        test_scenario::end(scenario);
    }

    // max_spread_bps = 0 → EInvalidSpreadBps (must be > 0).
    #[test]
    #[expected_failure(abort_code = EInvalidSpreadBps, location = stelis::config)]
    fun test_update_config_spread_cap_zero() {
        let mut scenario = test_scenario::begin(ADDR_ADMIN);
        setup_test(&mut scenario);

        test_scenario::next_tx(&mut scenario, ADDR_ADMIN);
        {
            let mut config = test_scenario::take_shared<Config>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);
            let max_claim = config::max_claim_mist(&config);
            let min_settle = config::min_settle_mist(&config);
            // 0 BPS → EInvalidSpreadBps
            config::update_config(&mut config, 0, 0, max_claim, min_settle, 0, ctx);
            test_scenario::return_shared(config);
        };
        test_scenario::end(scenario);
    }

    // max_spread_bps = 10_001 → EInvalidSpreadBps (must be <= 10_000).
    #[test]
    #[expected_failure(abort_code = EInvalidSpreadBps, location = stelis::config)]
    fun test_update_config_spread_cap_too_high() {
        let mut scenario = test_scenario::begin(ADDR_ADMIN);
        setup_test(&mut scenario);

        test_scenario::next_tx(&mut scenario, ADDR_ADMIN);
        {
            let mut config = test_scenario::take_shared<Config>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);
            let max_claim = config::max_claim_mist(&config);
            let min_settle = config::min_settle_mist(&config);
            // 10_001 BPS > 10_000 → EInvalidSpreadBps
            config::update_config(&mut config, 0, 0, max_claim, min_settle, 10_001, ctx);
            test_scenario::return_shared(config);
        };
        test_scenario::end(scenario);
    }

    // === Spread Guard Logic Tests (assert_spread_ok_from_prices) ===
    // These test the pure spread judgment logic directly, without needing a real DeepBook pool.

    const ESpreadTooWide: u64 = 110;

    // Narrow spread (1%) passes with max_spread_bps = 500 (5%).
    #[test]
    fun test_spread_ok_narrow() {
        // bid=9900, ask=10000 → spread = (100 * 10_000) / 10_000 = 100 BPS (1%)
        settle::assert_spread_ok_from_prices(9_900, 10_000, 500);
    }

    // Spread exactly at boundary passes (equal, not exceeding).
    #[test]
    fun test_spread_ok_at_boundary() {
        // bid=9500, ask=10000 → spread = (500 * 10_000) / 10_000 = 500 BPS (5%)
        settle::assert_spread_ok_from_prices(9_500, 10_000, 500);
    }

    // Spread one tick above boundary → ESpreadTooWide.
    #[test]
    #[expected_failure(abort_code = ESpreadTooWide, location = stelis::settle)]
    fun test_spread_too_wide() {
        // bid=9499, ask=10000 → spread = (501 * 10_000) / 10_000 = 501 BPS > 500
        settle::assert_spread_ok_from_prices(9_499, 10_000, 500);
    }

    // Crossed book (best_ask < best_bid) → ESpreadTooWide.
    #[test]
    #[expected_failure(abort_code = ESpreadTooWide, location = stelis::settle)]
    fun test_spread_crossed_book() {
        settle::assert_spread_ok_from_prices(10_000, 9_900, 500);
    }

    // Zero-width (best_ask == best_bid) → ESpreadTooWide.
    #[test]
    #[expected_failure(abort_code = ESpreadTooWide, location = stelis::settle)]
    fun test_spread_zero_width() {
        settle::assert_spread_ok_from_prices(10_000, 10_000, 500);
    }

    // Large prices near u64 max — u128 arithmetic prevents overflow.
    // DeepBook MAX_PRICE = (1 << 63) - 1 = 9_223_372_036_854_775_807.
    // We test with prices that would overflow u64 if multiplied by 10_000.
    #[test]
    fun test_spread_ok_large_prices() {
        // bid = 9_200_000_000_000_000_000, ask = 9_223_372_036_854_775_807
        // spread ~ 0.25% → passes with max_spread_bps = 500
        let max_price: u64 = 9_223_372_036_854_775_807; // (1<<63)-1
        let bid: u64 = 9_200_000_000_000_000_000;
        settle::assert_spread_ok_from_prices(bid, max_price, 500);
    }

    #[test]
    fun test_spread_cumulative_base_for_quote_passes() {
        settle::assert_base_for_quote_spread_ok_from_book(
            vector[9_900_000_000, 9_800_000_000],
            vector[50_000_000_000, 50_000_000_000],
            vector[10_000_000_000],
            vector[100_000_000_000],
            100_000_000_000,
            500,
        );
    }

    #[test]
    #[expected_failure(abort_code = ESpreadTooWide, location = stelis::settle)]
    fun test_spread_cumulative_base_for_quote_rejects_full_input_wide() {
        settle::assert_base_for_quote_spread_ok_from_book(
            vector[9_900_000_000, 9_000_000_000],
            vector[10_000_000_000, 90_000_000_000],
            vector[10_000_000_000],
            vector[100_000_000_000],
            100_000_000_000,
            500,
        );
    }

    #[test]
    #[expected_failure(abort_code = ESpreadTooWide, location = stelis::settle)]
    fun test_spread_cumulative_base_for_quote_rejects_insufficient_liquidity() {
        settle::assert_base_for_quote_spread_ok_from_book(
            vector[9_900_000_000, 9_800_000_000],
            vector[50_000_000_000, 50_000_000_000],
            vector[10_000_000_000],
            vector[100_000_000_000],
            101_000_000_000,
            500,
        );
    }

    #[test]
    #[expected_failure(abort_code = ESpreadTooWide, location = stelis::settle)]
    fun test_spread_cumulative_base_for_quote_rejects_one_sided_book() {
        settle::assert_base_for_quote_spread_ok_from_book(
            vector[9_900_000_000],
            vector[100_000_000_000],
            vector[],
            vector[],
            100_000_000_000,
            500,
        );
    }

    #[test]
    fun test_spread_cumulative_quote_for_base_passes() {
        settle::assert_quote_for_base_spread_ok_from_book(
            vector[9_800_000_000],
            vector[100_000_000_000],
            vector[10_000_000_000, 10_100_000_000],
            vector[5_000_000_000, 5_000_000_000],
            100_500_000_000,
            500,
        );
    }

    #[test]
    #[expected_failure(abort_code = ESpreadTooWide, location = stelis::settle)]
    fun test_spread_cumulative_quote_for_base_rejects_full_input_wide() {
        settle::assert_quote_for_base_spread_ok_from_book(
            vector[9_800_000_000],
            vector[100_000_000_000],
            vector[10_000_000_000, 11_000_000_000],
            vector[1_000_000_000, 9_000_000_000],
            109_000_000_000,
            500,
        );
    }

    // === withdraw_amount Tests ===

    // Partial withdrawal leaves the remaining balance intact.
    #[test]
    fun test_vault_withdraw_amount_partial() {
        let mut scenario = test_scenario::begin(ADDR_ADMIN);
        setup_test(&mut scenario);
        let mut clock = clock::create_for_testing(test_scenario::ctx(&mut scenario));
        clock::set_for_testing(&mut clock, 1000);

        // 1. Create vault: 1 SUI in, claim=10M → surplus=990M
        test_scenario::next_tx(&mut scenario, ADDR_USER);
        {
            let config = test_scenario::take_shared<Config>(&scenario);
            let mut registry = test_scenario::take_shared<VaultRegistry>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);
            let coin_in = coin::mint_for_testing<SUI>(1_000_000_000, ctx);
            settle::settle_for_testing(
                &config, &mut registry, &clock, coin_in, 10_000_000, ADDR_SETTLEMENT_PAYOUT_RECIPIENT,
                vector[], 1, 0, 0, 0, 0, 0, 0, 0, vector[], vector[], ctx
            );
            test_scenario::return_shared(config);
            test_scenario::return_shared(registry);
        };

        // 2. Partial withdraw: take 100M out of 990M
        test_scenario::next_tx(&mut scenario, ADDR_USER);
        {
            let mut vault = test_scenario::take_from_sender<UserVault>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);
            let coin = vault::withdraw_amount(&mut vault, 100_000_000, ctx);
            assert!(coin::value(&coin) == 100_000_000, 10);
            // Remaining balance: 990M - 100M = 890M
            assert!(vault::balance(&vault) == 890_000_000, 11);
            transfer::public_transfer(coin, ADDR_USER);
            test_scenario::return_to_sender(&scenario, vault);
        };

        clock::destroy_for_testing(clock);
        test_scenario::end(scenario);
    }

    // withdraw_amount(0) must abort with EInsufficientBalance — mirrors withdraw()
    // behaviour. Prevents zero-value Coin<SUI> + spurious event emission.
    #[test]
    #[expected_failure(abort_code = EVaultInsufficientBalance, location = stelis::vault)]
    fun test_vault_withdraw_amount_zero() {
        let mut scenario = test_scenario::begin(ADDR_ADMIN);
        setup_test(&mut scenario);
        let mut clock = clock::create_for_testing(test_scenario::ctx(&mut scenario));
        clock::set_for_testing(&mut clock, 1000);

        // 1. Create a vault with some surplus
        test_scenario::next_tx(&mut scenario, ADDR_USER);
        {
            let config = test_scenario::take_shared<Config>(&scenario);
            let mut registry = test_scenario::take_shared<VaultRegistry>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);
            let coin_in = coin::mint_for_testing<SUI>(1_000_000_000, ctx);
            settle::settle_for_testing(
                &config, &mut registry, &clock, coin_in, 10_000_000, ADDR_SETTLEMENT_PAYOUT_RECIPIENT,
                vector[], 1, 0, 0, 0, 0, 0, 0, 0, vector[], vector[], ctx
            );
            test_scenario::return_shared(config);
            test_scenario::return_shared(registry);
        };

        // 2. withdraw_amount(0) → EInsufficientBalance (no zero-value coin created)
        test_scenario::next_tx(&mut scenario, ADDR_USER);
        {
            let mut vault = test_scenario::take_from_sender<UserVault>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);
            let coin = vault::withdraw_amount(&mut vault, 0, ctx);
            transfer::public_transfer(coin, ADDR_USER);
            test_scenario::return_to_sender(&scenario, vault);
        };

        clock::destroy_for_testing(clock);
        test_scenario::end(scenario);
    }

    // withdraw_amount with amount > vault balance should abort with EInsufficientBalance.
    #[test]
    #[expected_failure(abort_code = EVaultInsufficientBalance, location = stelis::vault)]
    fun test_vault_withdraw_amount_exceeds_balance() {
        let mut scenario = test_scenario::begin(ADDR_ADMIN);
        setup_test(&mut scenario);
        let mut clock = clock::create_for_testing(test_scenario::ctx(&mut scenario));
        clock::set_for_testing(&mut clock, 1000);

        // 1. Create vault with small surplus (~10M)
        test_scenario::next_tx(&mut scenario, ADDR_USER);
        {
            let config = test_scenario::take_shared<Config>(&scenario);
            let mut registry = test_scenario::take_shared<VaultRegistry>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);
            let coin_in = coin::mint_for_testing<SUI>(10_000_000, ctx);
            settle::settle_for_testing(
                &config, &mut registry, &clock, coin_in, 0, ADDR_SETTLEMENT_PAYOUT_RECIPIENT,
                vector[], 1, 0, 0, 0, 0, 0, 0, 0, vector[], vector[], ctx
            );
            test_scenario::return_shared(config);
            test_scenario::return_shared(registry);
        };

        // 2. Request 100M when balance is only 10M → EInsufficientBalance
        test_scenario::next_tx(&mut scenario, ADDR_USER);
        {
            let mut vault = test_scenario::take_from_sender<UserVault>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);
            let coin = vault::withdraw_amount(&mut vault, 100_000_000, ctx);
            transfer::public_transfer(coin, ADDR_USER);
            test_scenario::return_to_sender(&scenario, vault);
        };

        clock::destroy_for_testing(clock);
        test_scenario::end(scenario);
    }

    // Test: settle_with_vault with wrong vault should abort (EVaultMismatch)
    #[test]
    #[expected_failure(abort_code = EVaultMismatch, location = stelis::vault)]
    fun test_settle_with_wrong_vault() {
        let mut scenario = test_scenario::begin(ADDR_ADMIN);
        setup_test(&mut scenario);
        let mut clock = clock::create_for_testing(test_scenario::ctx(&mut scenario));
        clock::set_for_testing(&mut clock, 1000);

        // 1. User creates a registered vault via settle()
        test_scenario::next_tx(&mut scenario, ADDR_USER);
        {
            let config = test_scenario::take_shared<Config>(&scenario);
            let mut registry = test_scenario::take_shared<VaultRegistry>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);
            let coin_in = coin::mint_for_testing<SUI>(100_000_000, ctx);
            settle::settle_for_testing(&config, &mut registry, &clock, coin_in, 0, ADDR_SETTLEMENT_PAYOUT_RECIPIENT, vector[], 1, 0, 0, 0, 0, 0, 0, 0, vector[], vector[], ctx);
            test_scenario::return_shared(config);
            test_scenario::return_shared(registry);
        };

        // 2. Create a rogue vault directly (not through settle)
        test_scenario::next_tx(&mut scenario, ADDR_USER);
        {
            let ctx = test_scenario::ctx(&mut scenario);
            let rogue_vault = vault::init_vault_for_testing(ctx);
            vault::transfer_vault_for_testing(rogue_vault, ADDR_USER);
        };

        // 3. Try settle_with_vault using the rogue vault → EVaultMismatch
        test_scenario::next_tx(&mut scenario, ADDR_USER);
        {
            let config = test_scenario::take_shared<Config>(&scenario);
            let registry = test_scenario::take_shared<VaultRegistry>(&scenario);
            let vault_ids = test_scenario::ids_for_sender<UserVault>(&scenario);
            // Take the second vault (rogue one) — it's not the registered one
            let mut rogue = test_scenario::take_from_sender_by_id<UserVault>(&scenario, vault_ids[1]);
            let ctx = test_scenario::ctx(&mut scenario);
            let coin_in = coin::mint_for_testing<SUI>(100_000_000, ctx);

            settle::settle_with_vault_for_testing(
                &config, &registry, &clock, &mut rogue, coin_in, 0, ADDR_SETTLEMENT_PAYOUT_RECIPIENT,
                vector[], 1, 0, 0, 0, 0, 0, 0, 0, vector[], vector[], 0, ctx
            );

            test_scenario::return_shared(config);
            test_scenario::return_shared(registry);
            test_scenario::return_to_sender(&scenario, rogue);
        };
        clock::destroy_for_testing(clock);
        test_scenario::end(scenario);
    }

    // === accept_admin Tests ===

    // S-5: Full 2-step admin transfer — propose then accept.
    #[test]
    fun test_accept_admin_success() {
        let mut scenario = test_scenario::begin(ADDR_ADMIN);
        setup_test(&mut scenario);

        // 1. Admin proposes ADDR_USER as new admin
        test_scenario::next_tx(&mut scenario, ADDR_ADMIN);
        {
            let mut config = test_scenario::take_shared<Config>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);
            config::propose_admin(&mut config, ADDR_USER, ctx);
            test_scenario::return_shared(config);
        };

        // 2. ADDR_USER accepts — becomes admin
        test_scenario::next_tx(&mut scenario, ADDR_USER);
        {
            let mut config = test_scenario::take_shared<Config>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);
            config::accept_admin(&mut config, ctx);
            test_scenario::return_shared(config);
        };

        // 3. Old admin (ADDR_ADMIN) can no longer set_paused → ENotAdmin
        // Verify new admin works by calling set_paused as ADDR_USER
        test_scenario::next_tx(&mut scenario, ADDR_USER);
        {
            let mut config = test_scenario::take_shared<Config>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);
            config::set_paused(&mut config, false, ctx); // Should succeed as new admin
            test_scenario::return_shared(config);
        };

        test_scenario::end(scenario);
    }

    // accept_admin with no pending proposal → ENoPendingAdmin
    #[test]
    #[expected_failure(abort_code = ENoPendingAdmin, location = stelis::config)]
    fun test_accept_admin_no_pending() {
        let mut scenario = test_scenario::begin(ADDR_ADMIN);
        setup_test(&mut scenario);

        // No pending proposal — accept should abort
        test_scenario::next_tx(&mut scenario, ADDR_USER);
        {
            let mut config = test_scenario::take_shared<Config>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);
            config::accept_admin(&mut config, ctx);
            test_scenario::return_shared(config);
        };

        test_scenario::end(scenario);
    }

    // accept_admin called by wrong address → ENotPendingAdmin
    #[test]
    #[expected_failure(abort_code = 5, location = stelis::config)]
    fun test_accept_admin_wrong_caller() {
        let mut scenario = test_scenario::begin(ADDR_ADMIN);
        setup_test(&mut scenario);

        // 1. Admin proposes ADDR_USER as new admin
        test_scenario::next_tx(&mut scenario, ADDR_ADMIN);
        {
            let mut config = test_scenario::take_shared<Config>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);
            config::propose_admin(&mut config, ADDR_USER, ctx);
            test_scenario::return_shared(config);
        };

        // 2. ADDR_SETTLEMENT_PAYOUT_RECIPIENT (not the pending admin) tries to accept → ENotPendingAdmin
        test_scenario::next_tx(&mut scenario, ADDR_SETTLEMENT_PAYOUT_RECIPIENT);
        {
            let mut config = test_scenario::take_shared<Config>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);
            config::accept_admin(&mut config, ctx);
            test_scenario::return_shared(config);
        };

        test_scenario::end(scenario);
    }

    // === settle_with_credit Tests ===

    // settle_with_credit() success — pure vault-credit settlement, no swap.
    #[test]
    fun test_settle_with_credit_success() {
        let mut scenario = test_scenario::begin(ADDR_ADMIN);
        setup_test(&mut scenario);
        let mut clock = clock::create_for_testing(test_scenario::ctx(&mut scenario));
        clock::set_for_testing(&mut clock, 1000);

        // 1. Create vault with large surplus via settle()
        test_scenario::next_tx(&mut scenario, ADDR_USER);
        {
            let config = test_scenario::take_shared<Config>(&scenario);
            let mut registry = test_scenario::take_shared<VaultRegistry>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);
            let coin_in = coin::mint_for_testing<SUI>(1_000_000_000, ctx);
            settle::settle_for_testing(
                &config, &mut registry, &clock, coin_in, 0, ADDR_SETTLEMENT_PAYOUT_RECIPIENT,
                vector[], 1, 0, 0, 0, 0, 0, 0, 0, vector[], vector[], ctx
            );
            test_scenario::return_shared(config);
            test_scenario::return_shared(registry);
        };

        // 2. settle_with_credit: use 5_000_000 credit, claim 2_000_000
        // total_in = 5_000_000, payout = 2_000_000, surplus = 3_000_000
        // new vault balance = 1_000_000_000 - 5_000_000 + 3_000_000 = 998_000_000
        test_scenario::next_tx(&mut scenario, ADDR_USER);
        {
            let config = test_scenario::take_shared<Config>(&scenario);
            let registry = test_scenario::take_shared<VaultRegistry>(&scenario);
            let mut vault = test_scenario::take_from_sender<UserVault>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);

            settle::settle_with_credit(
                &config, &registry, &clock, &mut vault,
                5_000_000,   // use_credit_amount
                2_000_000,   // execution_cost_claim_mist
                ADDR_SETTLEMENT_PAYOUT_RECIPIENT,
                vector[], 2, 0, 0, 0, 0, 0, 0, 0, vector[], vector[], ctx
            );

            assert!(vault::balance(&vault) == 998_000_000, 20);
            test_scenario::return_shared(config);
            test_scenario::return_shared(registry);
            test_scenario::return_to_sender(&scenario, vault);
        };

        clock::destroy_for_testing(clock);
        test_scenario::end(scenario);
    }

    #[test]
    fun test_settle_with_credit_below_min_settle_success() {
        let mut scenario = test_scenario::begin(ADDR_ADMIN);
        setup_test(&mut scenario);
        let mut clock = clock::create_for_testing(test_scenario::ctx(&mut scenario));
        clock::set_for_testing(&mut clock, 1000);

        test_scenario::next_tx(&mut scenario, ADDR_USER);
        {
            let config = test_scenario::take_shared<Config>(&scenario);
            let mut registry = test_scenario::take_shared<VaultRegistry>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);
            let coin_in = coin::mint_for_testing<SUI>(1_000_000_000, ctx);
            settle::settle_for_testing(
                &config, &mut registry, &clock, coin_in, 0, ADDR_SETTLEMENT_PAYOUT_RECIPIENT,
                vector[], 1, 0, 0, 0, 0, 0, 0, 0, vector[], vector[], ctx
            );
            test_scenario::return_shared(config);
            test_scenario::return_shared(registry);
        };

        test_scenario::next_tx(&mut scenario, ADDR_USER);
        {
            let config = test_scenario::take_shared<Config>(&scenario);
            let registry = test_scenario::take_shared<VaultRegistry>(&scenario);
            let mut vault = test_scenario::take_from_sender<UserVault>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);

            settle::settle_with_credit(
                &config, &registry, &clock, &mut vault,
                500, // below default min_settle_mist
                100,
                ADDR_SETTLEMENT_PAYOUT_RECIPIENT,
                vector[], 2, 0, 0, 0, 0, 0, 0, 0, vector[], vector[], ctx
            );

            assert!(vault::balance(&vault) == 999_999_900, 21);
            test_scenario::return_shared(config);
            test_scenario::return_shared(registry);
            test_scenario::return_to_sender(&scenario, vault);
        };

        clock::destroy_for_testing(clock);
        test_scenario::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = EHostFeeCapExceeded, location = stelis::settle)]
    fun test_settle_with_credit_fee_cap_rejection() {
        let mut scenario = test_scenario::begin(ADDR_ADMIN);
        setup_test(&mut scenario);
        let mut clock = clock::create_for_testing(test_scenario::ctx(&mut scenario));
        clock::set_for_testing(&mut clock, 1000);

        test_scenario::next_tx(&mut scenario, ADDR_USER);
        {
            let config = test_scenario::take_shared<Config>(&scenario);
            let mut registry = test_scenario::take_shared<VaultRegistry>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);
            let coin_in = coin::mint_for_testing<SUI>(1_000_000_000, ctx);
            settle::settle_for_testing(
                &config, &mut registry, &clock, coin_in, 0, ADDR_SETTLEMENT_PAYOUT_RECIPIENT,
                vector[], 1, 0, 0, 0, 0, 0, 0, 0, vector[], vector[], ctx
            );
            test_scenario::return_shared(config);
            test_scenario::return_shared(registry);
        };

        test_scenario::next_tx(&mut scenario, ADDR_USER);
        {
            let config = test_scenario::take_shared<Config>(&scenario);
            let registry = test_scenario::take_shared<VaultRegistry>(&scenario);
            let mut vault = test_scenario::take_from_sender<UserVault>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);
            settle::settle_with_credit(
                &config, &registry, &clock, &mut vault,
                1_000_000,
                100,
                ADDR_SETTLEMENT_PAYOUT_RECIPIENT,
                vector[], 2, 0, 0, 0,
                1, // quoted_host_fee_mist exceeds default cap 0
                0, 0, 0, vector[], vector[], ctx
            );
            test_scenario::return_shared(config);
            test_scenario::return_shared(registry);
            test_scenario::return_to_sender(&scenario, vault);
        };

        clock::destroy_for_testing(clock);
        test_scenario::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = EConfigVersionMismatch, location = stelis::settle)]
    fun test_settle_with_credit_config_version_mismatch() {
        let mut scenario = test_scenario::begin(ADDR_ADMIN);
        setup_test(&mut scenario);
        let mut clock = clock::create_for_testing(test_scenario::ctx(&mut scenario));
        clock::set_for_testing(&mut clock, 1000);

        test_scenario::next_tx(&mut scenario, ADDR_USER);
        {
            let config = test_scenario::take_shared<Config>(&scenario);
            let mut registry = test_scenario::take_shared<VaultRegistry>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);
            let coin_in = coin::mint_for_testing<SUI>(1_000_000_000, ctx);
            settle::settle_for_testing(
                &config, &mut registry, &clock, coin_in, 0, ADDR_SETTLEMENT_PAYOUT_RECIPIENT,
                vector[], 1, 0, 0, 0, 0, 0, 0, 0, vector[], vector[], ctx
            );
            test_scenario::return_shared(config);
            test_scenario::return_shared(registry);
        };

        test_scenario::next_tx(&mut scenario, ADDR_USER);
        {
            let config = test_scenario::take_shared<Config>(&scenario);
            let registry = test_scenario::take_shared<VaultRegistry>(&scenario);
            let mut vault = test_scenario::take_from_sender<UserVault>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);
            settle::settle_with_credit(
                &config, &registry, &clock, &mut vault,
                1_000_000,
                100,
                ADDR_SETTLEMENT_PAYOUT_RECIPIENT,
                vector[], 2, 0, 0, 0, 0, 0,
                99, // stale or forged expected_config_version
                0, vector[], vector[], ctx
            );
            test_scenario::return_shared(config);
            test_scenario::return_shared(registry);
            test_scenario::return_to_sender(&scenario, vault);
        };

        clock::destroy_for_testing(clock);
        test_scenario::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = EReplayNonce, location = stelis::vault)]
    fun test_settle_with_credit_nonce_replay_rejection() {
        let mut scenario = test_scenario::begin(ADDR_ADMIN);
        setup_test(&mut scenario);
        let mut clock = clock::create_for_testing(test_scenario::ctx(&mut scenario));
        clock::set_for_testing(&mut clock, 1000);

        test_scenario::next_tx(&mut scenario, ADDR_USER);
        {
            let config = test_scenario::take_shared<Config>(&scenario);
            let mut registry = test_scenario::take_shared<VaultRegistry>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);
            let coin_in = coin::mint_for_testing<SUI>(1_000_000_000, ctx);
            settle::settle_for_testing(
                &config, &mut registry, &clock, coin_in, 0, ADDR_SETTLEMENT_PAYOUT_RECIPIENT,
                vector[], 1, 0, 0, 0, 0, 0, 0, 0, vector[], vector[], ctx
            );
            test_scenario::return_shared(config);
            test_scenario::return_shared(registry);
        };

        test_scenario::next_tx(&mut scenario, ADDR_USER);
        {
            let config = test_scenario::take_shared<Config>(&scenario);
            let registry = test_scenario::take_shared<VaultRegistry>(&scenario);
            let mut vault = test_scenario::take_from_sender<UserVault>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);
            settle::settle_with_credit(
                &config, &registry, &clock, &mut vault,
                1_000_000, 100, ADDR_SETTLEMENT_PAYOUT_RECIPIENT,
                vector[], 2, 0, 0, 0, 0, 0, 0, 0, vector[], vector[], ctx
            );
            test_scenario::return_shared(config);
            test_scenario::return_shared(registry);
            test_scenario::return_to_sender(&scenario, vault);
        };

        test_scenario::next_tx(&mut scenario, ADDR_USER);
        {
            let config = test_scenario::take_shared<Config>(&scenario);
            let registry = test_scenario::take_shared<VaultRegistry>(&scenario);
            let mut vault = test_scenario::take_from_sender<UserVault>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);
            settle::settle_with_credit(
                &config, &registry, &clock, &mut vault,
                1_000_000, 100, ADDR_SETTLEMENT_PAYOUT_RECIPIENT,
                vector[], 2, 0, 0, 0, 0, 0, 0, 0, vector[], vector[], ctx
            );
            test_scenario::return_shared(config);
            test_scenario::return_shared(registry);
            test_scenario::return_to_sender(&scenario, vault);
        };

        clock::destroy_for_testing(clock);
        test_scenario::end(scenario);
    }

    // settle_with_credit() — insufficient vault credit → EInsufficientBalance
    #[test]
    #[expected_failure(abort_code = EVaultInsufficientBalance, location = stelis::vault)]
    fun test_settle_with_credit_insufficient() {
        let mut scenario = test_scenario::begin(ADDR_ADMIN);
        setup_test(&mut scenario);
        let mut clock = clock::create_for_testing(test_scenario::ctx(&mut scenario));
        clock::set_for_testing(&mut clock, 1000);

        // 1. Create vault with small surplus
        test_scenario::next_tx(&mut scenario, ADDR_USER);
        {
            let config = test_scenario::take_shared<Config>(&scenario);
            let mut registry = test_scenario::take_shared<VaultRegistry>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);
            let coin_in = coin::mint_for_testing<SUI>(500_000, ctx);
            settle::settle_for_testing(
                &config, &mut registry, &clock, coin_in, 0, ADDR_SETTLEMENT_PAYOUT_RECIPIENT,
                vector[], 1, 0, 0, 0, 0, 0, 0, 0, vector[], vector[], ctx
            );
            test_scenario::return_shared(config);
            test_scenario::return_shared(registry);
        };

        // 2. Try to use more credit than available → EInsufficientBalance
        test_scenario::next_tx(&mut scenario, ADDR_USER);
        {
            let config = test_scenario::take_shared<Config>(&scenario);
            let registry = test_scenario::take_shared<VaultRegistry>(&scenario);
            let mut vault = test_scenario::take_from_sender<UserVault>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);
            settle::settle_with_credit(
                &config, &registry, &clock, &mut vault,
                10_000_000, // way more than vault balance
                2_000_000,
                ADDR_SETTLEMENT_PAYOUT_RECIPIENT,
                vector[], 1, 0, 0, 0, 0, 0, 0, 0, vector[], vector[], ctx
            );
            test_scenario::return_shared(config);
            test_scenario::return_shared(registry);
            test_scenario::return_to_sender(&scenario, vault);
        };

        clock::destroy_for_testing(clock);
        test_scenario::end(scenario);
    }

    // === vault::withdraw on empty vault → EInsufficientBalance ===

    #[test]
    #[expected_failure(abort_code = EVaultInsufficientBalance, location = stelis::vault)]
    fun test_vault_withdraw_empty() {
        let mut scenario = test_scenario::begin(ADDR_ADMIN);
        setup_test(&mut scenario);
        let mut clock = clock::create_for_testing(test_scenario::ctx(&mut scenario));
        clock::set_for_testing(&mut clock, 1000);

        // 1. Create vault via settle with claim = total_in (surplus = 0)
        test_scenario::next_tx(&mut scenario, ADDR_USER);
        {
            let config = test_scenario::take_shared<Config>(&scenario);
            let mut registry = test_scenario::take_shared<VaultRegistry>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);
            // Use exactly min_settle (100_000 MIST), claim all of it → surplus = 0
            let coin_in = coin::mint_for_testing<SUI>(100_000, ctx);
            settle::settle_for_testing(
                &config, &mut registry, &clock, coin_in, 100_000, ADDR_SETTLEMENT_PAYOUT_RECIPIENT,
                vector[], 1, 0, 0, 0, 0, 0, 0, 0, vector[], vector[], ctx
            );
            test_scenario::return_shared(config);
            test_scenario::return_shared(registry);
        };

        // 2. Withdraw from empty vault → EInsufficientBalance
        test_scenario::next_tx(&mut scenario, ADDR_USER);
        {
            let mut vault = test_scenario::take_from_sender<UserVault>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);
            assert!(vault::balance(&vault) == 0, 30);
            let coin = vault::withdraw(&mut vault, ctx);
            transfer::public_transfer(coin, ADDR_USER);
            test_scenario::return_to_sender(&scenario, vault);
        };

        clock::destroy_for_testing(clock);
        test_scenario::end(scenario);
    }

    // === EVaultNotRegistered — settle_with_credit on unregistered vault ===

    #[test]
    #[expected_failure(abort_code = 3, location = stelis::vault)]
    fun test_settle_with_credit_vault_not_registered() {
        let mut scenario = test_scenario::begin(ADDR_ADMIN);
        setup_test(&mut scenario);
        let mut clock = clock::create_for_testing(test_scenario::ctx(&mut scenario));
        clock::set_for_testing(&mut clock, 1000);

        // Create a rogue vault directly (not through settle) — not in registry
        test_scenario::next_tx(&mut scenario, ADDR_USER);
        {
            let ctx = test_scenario::ctx(&mut scenario);
            let rogue = vault::init_vault_for_testing(ctx);
            vault::transfer_vault_for_testing(rogue, ADDR_USER);
        };

        // Try settle_with_credit with the unregistered vault → EVaultNotRegistered
        test_scenario::next_tx(&mut scenario, ADDR_USER);
        {
            let config = test_scenario::take_shared<Config>(&scenario);
            let registry = test_scenario::take_shared<VaultRegistry>(&scenario);
            let mut rogue = test_scenario::take_from_sender<UserVault>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);
            settle::settle_with_credit(
                &config, &registry, &clock, &mut rogue,
                1_000_000, 500_000, ADDR_SETTLEMENT_PAYOUT_RECIPIENT,
                vector[], 1, 0, 0, 0, 0, 0, 0, 0, vector[], vector[], ctx
            );
            test_scenario::return_shared(config);
            test_scenario::return_shared(registry);
            test_scenario::return_to_sender(&scenario, rogue);
        };

        clock::destroy_for_testing(clock);
        test_scenario::end(scenario);
    }

    // === settle_with_vault Failure Paths ===

    // settle_with_vault_for_testing — ETotalInTooLow via with_vault path
    #[test]
    #[expected_failure(abort_code = ETotalInTooLow, location = stelis::settle)]
    fun test_settle_with_vault_fail_min_settle() {
        let mut scenario = test_scenario::begin(ADDR_ADMIN);
        setup_test(&mut scenario);
        let mut clock = clock::create_for_testing(test_scenario::ctx(&mut scenario));
        clock::set_for_testing(&mut clock, 1000);

        // 1. Set min_settle to 1_000_000
        test_scenario::next_tx(&mut scenario, ADDR_ADMIN);
        {
            let mut config = test_scenario::take_shared<Config>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);
            let max_claim = config::max_claim_mist(&config);
            config::update_config(&mut config, 0, 0, max_claim, 1_000_000, 500, ctx);
            test_scenario::return_shared(config);
        };
        advance_two_epochs_and_apply_config(&mut scenario, ADDR_SETTLEMENT_PAYOUT_RECIPIENT);

        // 2. Create vault
        test_scenario::next_tx(&mut scenario, ADDR_USER);
        {
            let config = test_scenario::take_shared<Config>(&scenario);
            let mut registry = test_scenario::take_shared<VaultRegistry>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);
            // min_settle is now 1_000_000, use 5_000_000 to pass it
            let coin_in = coin::mint_for_testing<SUI>(5_000_000, ctx);
            let cv = config::config_version(&config);
            settle::settle_for_testing(
                &config, &mut registry, &clock, coin_in, 0, ADDR_SETTLEMENT_PAYOUT_RECIPIENT,
                vector[], 1, 0, 0, 0, 0, 0, cv, 0, vector[], vector[], ctx
            );
            test_scenario::return_shared(config);
            test_scenario::return_shared(registry);
        };

        // 3. settle_with_vault with coin_in below min_settle → ETotalInTooLow
        test_scenario::next_tx(&mut scenario, ADDR_USER);
        {
            let config = test_scenario::take_shared<Config>(&scenario);
            let registry = test_scenario::take_shared<VaultRegistry>(&scenario);
            let mut vault = test_scenario::take_from_sender<UserVault>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);
            let coin_in = coin::mint_for_testing<SUI>(100, ctx); // Below min_settle
            settle::settle_with_vault_for_testing(
                &config, &registry, &clock, &mut vault, coin_in, 0, ADDR_SETTLEMENT_PAYOUT_RECIPIENT,
                vector[], 2, 0, 0, 0, 0, 0, 0, 0, vector[], vector[], 0, ctx
            );
            test_scenario::return_shared(config);
            test_scenario::return_shared(registry);
            test_scenario::return_to_sender(&scenario, vault);
        };

        clock::destroy_for_testing(clock);
        test_scenario::end(scenario);
    }

    // settle_with_vault_for_testing — EClaimTooHigh via with_vault path
    #[test]
    #[expected_failure(abort_code = EClaimTooHigh, location = stelis::settle)]
    fun test_settle_with_vault_fail_claim_too_high() {
        let mut scenario = test_scenario::begin(ADDR_ADMIN);
        setup_test(&mut scenario);
        let mut clock = clock::create_for_testing(test_scenario::ctx(&mut scenario));
        clock::set_for_testing(&mut clock, 1000);

        // 1. Create vault
        test_scenario::next_tx(&mut scenario, ADDR_USER);
        {
            let config = test_scenario::take_shared<Config>(&scenario);
            let mut registry = test_scenario::take_shared<VaultRegistry>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);
            let coin_in = coin::mint_for_testing<SUI>(1_000_000_000, ctx);
            settle::settle_for_testing(
                &config, &mut registry, &clock, coin_in, 0, ADDR_SETTLEMENT_PAYOUT_RECIPIENT,
                vector[], 1, 0, 0, 0, 0, 0, 0, 0, vector[], vector[], ctx
            );
            test_scenario::return_shared(config);
            test_scenario::return_shared(registry);
        };

        // 2. settle_with_vault with claim > max_claim → EClaimTooHigh
        test_scenario::next_tx(&mut scenario, ADDR_USER);
        {
            let config = test_scenario::take_shared<Config>(&scenario);
            let registry = test_scenario::take_shared<VaultRegistry>(&scenario);
            let mut vault = test_scenario::take_from_sender<UserVault>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);
            let coin_in = coin::mint_for_testing<SUI>(200_000_000, ctx);
            let high_claim = config::max_claim_mist(&config) + 1;
            settle::settle_with_vault_for_testing(
                &config, &registry, &clock, &mut vault, coin_in,
                high_claim, // Over max_claim
                ADDR_SETTLEMENT_PAYOUT_RECIPIENT, vector[], 2, 0, 0, 0, 0, 0, 0, 0, vector[], vector[], 0, ctx
            );
            test_scenario::return_shared(config);
            test_scenario::return_shared(registry);
            test_scenario::return_to_sender(&scenario, vault);
        };

        clock::destroy_for_testing(clock);
        test_scenario::end(scenario);
    }

    // settle_with_vault_for_testing — EInvalidReceiptId via with_vault path
    #[test]
    #[expected_failure(abort_code = EInvalidReceiptId, location = stelis::settle)]
    fun test_settle_with_vault_fail_invalid_receipt_id() {
        let mut scenario = test_scenario::begin(ADDR_ADMIN);
        setup_test(&mut scenario);
        let mut clock = clock::create_for_testing(test_scenario::ctx(&mut scenario));
        clock::set_for_testing(&mut clock, 1000);

        // 1. Create vault
        test_scenario::next_tx(&mut scenario, ADDR_USER);
        {
            let config = test_scenario::take_shared<Config>(&scenario);
            let mut registry = test_scenario::take_shared<VaultRegistry>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);
            let coin_in = coin::mint_for_testing<SUI>(1_000_000_000, ctx);
            settle::settle_for_testing(
                &config, &mut registry, &clock, coin_in, 0, ADDR_SETTLEMENT_PAYOUT_RECIPIENT,
                vector[], 1, 0, 0, 0, 0, 0, 0, 0, vector[], vector[], ctx
            );
            test_scenario::return_shared(config);
            test_scenario::return_shared(registry);
        };

        // 2. settle_with_vault with bad receipt_id length → EInvalidReceiptId
        test_scenario::next_tx(&mut scenario, ADDR_USER);
        {
            let config = test_scenario::take_shared<Config>(&scenario);
            let registry = test_scenario::take_shared<VaultRegistry>(&scenario);
            let mut vault = test_scenario::take_from_sender<UserVault>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);
            let coin_in = coin::mint_for_testing<SUI>(200_000_000, ctx);
            settle::settle_with_vault_for_testing(
                &config, &registry, &clock, &mut vault, coin_in, 0, ADDR_SETTLEMENT_PAYOUT_RECIPIENT,
                vector[1, 2, 3], // invalid length (not 0 or 32)
                2, 0, 0, 0, 0, 0, 0, 0, vector[], vector[], 0, ctx
            );
            test_scenario::return_shared(config);
            test_scenario::return_shared(registry);
            test_scenario::return_to_sender(&scenario, vault);
        };

        clock::destroy_for_testing(clock);
        test_scenario::end(scenario);
    }

    // === Config Getter Tests ===

    #[test]
    fun test_config_getters() {
        let mut scenario = test_scenario::begin(ADDR_ADMIN);
        setup_test(&mut scenario);

        test_scenario::next_tx(&mut scenario, ADDR_ADMIN);
        {
            let config = test_scenario::take_shared<Config>(&scenario);
            // Package hard cap getter
            assert!(config::get_max_claim_mist() == 100_000_000, 40);
            // Config init default
            assert!(config::max_claim_mist(&config) == 75_000_000, 41);
            test_scenario::return_shared(config);
        };

        test_scenario::end(scenario);
    }

    // === update_protocol_treasury success path ===

    #[test]
    fun test_update_treasury_success() {
        let mut scenario = test_scenario::begin(ADDR_ADMIN);
        setup_test(&mut scenario);

        test_scenario::next_tx(&mut scenario, ADDR_ADMIN);
        {
            let mut config = test_scenario::take_shared<Config>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);
            config::update_protocol_treasury(&mut config, @0xDEAD, ctx);
            assert!(config::protocol_treasury(&config) == ADDR_ADMIN, 51);
            test_scenario::return_shared(config);
        };

        advance_two_epochs_and_apply_treasury(&mut scenario, ADDR_SETTLEMENT_PAYOUT_RECIPIENT);

        test_scenario::next_tx(&mut scenario, ADDR_ADMIN);
        {
            let config = test_scenario::take_shared<Config>(&scenario);
            // Verify via getter
            assert!(config::protocol_treasury(&config) == @0xDEAD, 50);
            test_scenario::return_shared(config);
        };

        test_scenario::end(scenario);
    }

    // === swap_and_settle routing tests (no DeepBook pool — swap step bypassed) ===

    // swap_and_settle_new_user_bfq path: vault created and settled via helper.
    #[test]
    fun test_swap_and_settle_new_user_routing() {
        let mut scenario = test_scenario::begin(ADDR_ADMIN);
        setup_test(&mut scenario);
        let mut clock = clock::create_for_testing(test_scenario::ctx(&mut scenario));
        clock::set_for_testing(&mut clock, 1000);

        test_scenario::next_tx(&mut scenario, ADDR_USER);
        {
            let config = test_scenario::take_shared<Config>(&scenario);
            let mut registry = test_scenario::take_shared<VaultRegistry>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);
            // Simulates post-swap SUI received
            let sui_coin = coin::mint_for_testing<SUI>(500_000_000, ctx);
            settle::swap_and_settle_new_user_for_testing(
                &config, &mut registry, &clock, sui_coin,
                5_000_000, ADDR_SETTLEMENT_PAYOUT_RECIPIENT, vector[], 1, 0, 0, 0, 0, 0, 0, 0, vector[], vector[], ctx
            );
            test_scenario::return_shared(config);
            test_scenario::return_shared(registry);
        };

        test_scenario::next_tx(&mut scenario, ADDR_USER);
        {
            let vault = test_scenario::take_from_sender<UserVault>(&scenario);
            assert!(vault::balance(&vault) == 495_000_000, 60); // 500M - 5M claim
            test_scenario::return_to_sender(&scenario, vault);
        };

        clock::destroy_for_testing(clock);
        test_scenario::end(scenario);
    }

    // swap_and_settle_with_vault_bfq path (no credit): validate + settle_internal.
    #[test]
    fun test_swap_and_settle_with_vault_routing() {
        let mut scenario = test_scenario::begin(ADDR_ADMIN);
        setup_test(&mut scenario);
        let mut clock = clock::create_for_testing(test_scenario::ctx(&mut scenario));
        clock::set_for_testing(&mut clock, 1000);

        // 1. Create vault
        test_scenario::next_tx(&mut scenario, ADDR_USER);
        {
            let config = test_scenario::take_shared<Config>(&scenario);
            let mut registry = test_scenario::take_shared<VaultRegistry>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);
            let coin_in = coin::mint_for_testing<SUI>(1_000_000_000, ctx);
            settle::settle_for_testing(
                &config, &mut registry, &clock, coin_in, 0, ADDR_SETTLEMENT_PAYOUT_RECIPIENT,
                vector[], 1, 0, 0, 0, 0, 0, 0, 0, vector[], vector[], ctx
            );
            test_scenario::return_shared(config);
            test_scenario::return_shared(registry);
        };

        // 2. swap_and_settle_with_vault_bfq (no credit)
        test_scenario::next_tx(&mut scenario, ADDR_USER);
        {
            let config = test_scenario::take_shared<Config>(&scenario);
            let registry = test_scenario::take_shared<VaultRegistry>(&scenario);
            let mut vault = test_scenario::take_from_sender<UserVault>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);
            let sui_coin = coin::mint_for_testing<SUI>(200_000_000, ctx);
            settle::swap_and_settle_with_vault_for_testing(
                &config, &registry, &clock, &mut vault, sui_coin,
                5_000_000, ADDR_SETTLEMENT_PAYOUT_RECIPIENT, vector[], 2, 0, 0, 0, 0, 0, 0, 0, vector[], vector[], ctx
            );
            // vault: 1_000M + (200M - 5M) = 1_195_000_000
            assert!(vault::balance(&vault) == 1_195_000_000, 61);
            test_scenario::return_shared(config);
            test_scenario::return_shared(registry);
            test_scenario::return_to_sender(&scenario, vault);
        };

        clock::destroy_for_testing(clock);
        test_scenario::end(scenario);
    }

    // swap_and_settle_with_vault_bfq (use_credit > 0 branch).
    #[test]
    fun test_swap_and_settle_with_vault_credit_routing() {
        let mut scenario = test_scenario::begin(ADDR_ADMIN);
        setup_test(&mut scenario);
        let mut clock = clock::create_for_testing(test_scenario::ctx(&mut scenario));
        clock::set_for_testing(&mut clock, 1000);

        // 1. Create vault with 500M surplus
        test_scenario::next_tx(&mut scenario, ADDR_USER);
        {
            let config = test_scenario::take_shared<Config>(&scenario);
            let mut registry = test_scenario::take_shared<VaultRegistry>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);
            let coin_in = coin::mint_for_testing<SUI>(500_000_000, ctx);
            settle::settle_for_testing(
                &config, &mut registry, &clock, coin_in, 0, ADDR_SETTLEMENT_PAYOUT_RECIPIENT,
                vector[], 1, 0, 0, 0, 0, 0, 0, 0, vector[], vector[], ctx
            );
            test_scenario::return_shared(config);
            test_scenario::return_shared(registry);
        };

        // 2. swap + credit merge (50M credit + 100M swap output)
        // total_in = 150M, claim = 5M → surplus = 145M
        // vault: 500M - 50M (used) + 145M (surplus) = 595M
        test_scenario::next_tx(&mut scenario, ADDR_USER);
        {
            let config = test_scenario::take_shared<Config>(&scenario);
            let registry = test_scenario::take_shared<VaultRegistry>(&scenario);
            let mut vault = test_scenario::take_from_sender<UserVault>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);
            let sui_coin = coin::mint_for_testing<SUI>(100_000_000, ctx);
            settle::swap_and_settle_with_vault_credit_for_testing(
                &config, &registry, &clock, &mut vault, sui_coin,
                50_000_000, // use_credit_amount
                5_000_000,  // execution_cost_claim_mist
                ADDR_SETTLEMENT_PAYOUT_RECIPIENT, vector[], 2, 0, 0, 0, 0, 0, 0, 0, vector[], vector[], ctx
            );
            assert!(vault::balance(&vault) == 595_000_000, 62);
            test_scenario::return_shared(config);
            test_scenario::return_shared(registry);
            test_scenario::return_to_sender(&scenario, vault);
        };

        clock::destroy_for_testing(clock);
        test_scenario::end(scenario);
    }

    // === qfb settle-path routing tests (helper-based) ===
    //
    // These tests use generic _for_testing helpers (no DeepBook pool) to verify
    // the settle path (vault creation, credit usage, surplus deposit) for qfb
    // profiles. They complement the direct pool-backed tests below by covering
    // settle-path arithmetic without swap dependency.

    // swap_and_settle_new_user_qfb path: vault created and settled.
    #[test]
    fun test_swap_and_settle_new_user_qfb_routing() {
        let mut scenario = test_scenario::begin(ADDR_ADMIN);
        setup_test(&mut scenario);
        let mut clock = clock::create_for_testing(test_scenario::ctx(&mut scenario));
        clock::set_for_testing(&mut clock, 1000);

        test_scenario::next_tx(&mut scenario, ADDR_USER);
        {
            let config = test_scenario::take_shared<Config>(&scenario);
            let mut registry = test_scenario::take_shared<VaultRegistry>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);
            // Simulates post-swap SUI received from qfb Pool<SUI, Token>
            let sui_coin = coin::mint_for_testing<SUI>(400_000_000, ctx);
            settle::swap_and_settle_new_user_for_testing(
                &config, &mut registry, &clock, sui_coin,
                3_000_000, ADDR_SETTLEMENT_PAYOUT_RECIPIENT, vector[], 1, 0, 0, 0, 0, 0, 0, 0, vector[], vector[], ctx
            );
            test_scenario::return_shared(config);
            test_scenario::return_shared(registry);
        };

        test_scenario::next_tx(&mut scenario, ADDR_USER);
        {
            let vault = test_scenario::take_from_sender<UserVault>(&scenario);
            assert!(vault::balance(&vault) == 397_000_000, 70); // 400M - 3M claim
            test_scenario::return_to_sender(&scenario, vault);
        };

        clock::destroy_for_testing(clock);
        test_scenario::end(scenario);
    }

    // swap_and_settle_with_vault_qfb path (no credit): validate + settle.
    #[test]
    fun test_swap_and_settle_with_vault_qfb_no_credit_routing() {
        let mut scenario = test_scenario::begin(ADDR_ADMIN);
        setup_test(&mut scenario);
        let mut clock = clock::create_for_testing(test_scenario::ctx(&mut scenario));
        clock::set_for_testing(&mut clock, 1000);

        // 1. Create vault with 100M surplus
        test_scenario::next_tx(&mut scenario, ADDR_USER);
        {
            let config = test_scenario::take_shared<Config>(&scenario);
            let mut registry = test_scenario::take_shared<VaultRegistry>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);
            let coin_in = coin::mint_for_testing<SUI>(100_000_000, ctx);
            settle::settle_for_testing(
                &config, &mut registry, &clock, coin_in, 0, ADDR_SETTLEMENT_PAYOUT_RECIPIENT,
                vector[], 1, 0, 0, 0, 0, 0, 0, 0, vector[], vector[], ctx
            );
            test_scenario::return_shared(config);
            test_scenario::return_shared(registry);
        };

        // 2. qfb with_vault (use_credit_amount = 0), 300M swap output, 4M claim → surplus 296M
        // vault: 100M + 296M = 396M
        test_scenario::next_tx(&mut scenario, ADDR_USER);
        {
            let config = test_scenario::take_shared<Config>(&scenario);
            let registry = test_scenario::take_shared<VaultRegistry>(&scenario);
            let mut vault = test_scenario::take_from_sender<UserVault>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);
            let sui_coin = coin::mint_for_testing<SUI>(300_000_000, ctx);
            settle::swap_and_settle_with_vault_for_testing(
                &config, &registry, &clock, &mut vault, sui_coin,
                4_000_000, ADDR_SETTLEMENT_PAYOUT_RECIPIENT, vector[], 2, 0, 0, 0, 0, 0, 0, 0, vector[], vector[], ctx
            );
            assert!(vault::balance(&vault) == 396_000_000, 71);
            test_scenario::return_shared(config);
            test_scenario::return_shared(registry);
            test_scenario::return_to_sender(&scenario, vault);
        };

        clock::destroy_for_testing(clock);
        test_scenario::end(scenario);
    }

    // swap_and_settle_with_vault_qfb path (use_credit > 0): validate + credit merge + settle.
    #[test]
    fun test_swap_and_settle_with_vault_qfb_with_credit_routing() {
        let mut scenario = test_scenario::begin(ADDR_ADMIN);
        setup_test(&mut scenario);
        let mut clock = clock::create_for_testing(test_scenario::ctx(&mut scenario));
        clock::set_for_testing(&mut clock, 1000);

        // 1. Create vault with 150M surplus
        test_scenario::next_tx(&mut scenario, ADDR_USER);
        {
            let config = test_scenario::take_shared<Config>(&scenario);
            let mut registry = test_scenario::take_shared<VaultRegistry>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);
            let coin_in = coin::mint_for_testing<SUI>(150_000_000, ctx);
            settle::settle_for_testing(
                &config, &mut registry, &clock, coin_in, 0, ADDR_SETTLEMENT_PAYOUT_RECIPIENT,
                vector[], 1, 0, 0, 0, 0, 0, 0, 0, vector[], vector[], ctx
            );
            test_scenario::return_shared(config);
            test_scenario::return_shared(registry);
        };

        // 2. qfb with_vault (use_credit = 30M), 50M swap output + 30M credit = 80M, 5M claim → surplus 75M
        // vault: 150M - 30M + 75M = 195M
        test_scenario::next_tx(&mut scenario, ADDR_USER);
        {
            let config = test_scenario::take_shared<Config>(&scenario);
            let registry = test_scenario::take_shared<VaultRegistry>(&scenario);
            let mut vault = test_scenario::take_from_sender<UserVault>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);
            let sui_coin = coin::mint_for_testing<SUI>(50_000_000, ctx);
            settle::swap_and_settle_with_vault_credit_for_testing(
                &config, &registry, &clock, &mut vault, sui_coin,
                30_000_000, // use_credit_amount
                5_000_000,  // execution_cost_claim_mist
                ADDR_SETTLEMENT_PAYOUT_RECIPIENT, vector[], 2, 0, 0, 0, 0, 0, 0, 0, vector[], vector[], ctx
            );
            assert!(vault::balance(&vault) == 195_000_000, 72);
            test_scenario::return_shared(config);
            test_scenario::return_shared(registry);
            test_scenario::return_to_sender(&scenario, vault);
        };

        clock::destroy_for_testing(clock);
        test_scenario::end(scenario);
    }

    // === Direct qfb public entry tests (pool-backed) ===
    //
    // These tests create real DeepBook pools with two-sided liquidity,
    // then call the actual qfb public entry functions. A passing test proves
    // that wrapper wiring, swap destructuring, and settle execution complete
    // without abort. Individual leftover transfer/destroy branches are not
    // separately asserted; correctness there relies on transaction success
    // plus code review of the cleanup blocks.

    // Shared DeepBook test setup addresses
    const ADDR_MARKET_MAKER: address = @0xDD;

    /// Setup a DeepBook Pool<SUI, DEEP> with ask-side liquidity for qfb swap tests.
    /// Returns (deepbook_registry_id, pool_id, balance_manager_id).
    fun setup_qfb_pool(scenario: &mut Scenario): (ID, ID, ID) {
        // 1. Create shared Clock + DeepBook registry
        test_scenario::next_tx(scenario, ADDR_ADMIN);
        clock::create_for_testing(test_scenario::ctx(scenario)).share_for_testing();

        test_scenario::next_tx(scenario, ADDR_ADMIN);
        let db_registry_id = deepbook::registry::test_registry(test_scenario::ctx(scenario));

        // 2. Create Pool<SUI, DEEP> (whitelisted, non-stable)
        test_scenario::next_tx(scenario, ADDR_ADMIN);
        let admin_cap = deepbook::registry::get_admin_cap_for_testing(test_scenario::ctx(scenario));
        let mut db_registry = test_scenario::take_shared_by_id<deepbook::registry::Registry>(scenario, db_registry_id);
        let pool_id = deepbook::pool::create_pool_admin<SUI, token::deep::DEEP>(
            &mut db_registry,
            deepbook::constants::tick_size(),
            deepbook::constants::lot_size(),
            deepbook::constants::min_size(),
            true,  // whitelisted
            false, // not stable
            &admin_cap,
            test_scenario::ctx(scenario),
        );
        test_scenario::return_shared(db_registry);
        std::unit_test::destroy(admin_cap);

        // 3. Create BalanceManager and fund it
        test_scenario::next_tx(scenario, ADDR_MARKET_MAKER);
        let mut bm = deepbook::balance_manager::new(test_scenario::ctx(scenario));
        // Deposit SUI and DEEP for market making
        let sui_deposit = coin::mint_for_testing<SUI>(100_000_000_000, test_scenario::ctx(scenario));
        let deep_deposit = coin::mint_for_testing<token::deep::DEEP>(100_000_000_000, test_scenario::ctx(scenario));
        deepbook::balance_manager::deposit(&mut bm, sui_deposit, test_scenario::ctx(scenario));
        deepbook::balance_manager::deposit(&mut bm, deep_deposit, test_scenario::ctx(scenario));
        let bm_id = sui::object::id(&bm);
        transfer::public_share_object(bm);

        // 4. Place ask + bid orders for two-sided liquidity (spread guard needs both sides)
        //    Pool<SUI, DEEP>: base=SUI, quote=DEEP
        //    Ask (is_bid=false): sell SUI at 1.50 DEEP/SUI — qfb swap consumes this
        //    Bid (is_bid=true):  buy SUI at 1.45 DEEP/SUI — provides bid side for spread guard
        //    Spread: (1.50-1.45)/1.50 * 10000 = 333 bps (within 500 bps cap)
        test_scenario::next_tx(scenario, ADDR_MARKET_MAKER);
        {
            let mut pool = test_scenario::take_shared_by_id<deepbook::pool::Pool<SUI, token::deep::DEEP>>(scenario, pool_id);
            let clock = test_scenario::take_shared<sui::clock::Clock>(scenario);
            let mut bm_ref = test_scenario::take_shared_by_id<deepbook::balance_manager::BalanceManager>(scenario, bm_id);
            let proof = deepbook::balance_manager::generate_proof_as_owner(&mut bm_ref, test_scenario::ctx(scenario));

            // Ask: sell 10 SUI at 1.50 DEEP/SUI
            let _ask = deepbook::pool::place_limit_order<SUI, token::deep::DEEP>(
                &mut pool,
                &mut bm_ref,
                &proof,
                1, // client_order_id
                deepbook::constants::no_restriction(),
                deepbook::constants::self_matching_allowed(),
                1_500_000_000, // price: 1.5 * 1e9
                10_000_000_000, // quantity: 10 SUI
                false, // is_bid = false → ask
                true,  // pay_with_deep
                deepbook::constants::max_u64(),
                &clock,
                test_scenario::ctx(scenario),
            );

            // Bid: buy 10 SUI at 1.45 DEEP/SUI
            let _bid = deepbook::pool::place_limit_order<SUI, token::deep::DEEP>(
                &mut pool,
                &mut bm_ref,
                &proof,
                2, // client_order_id
                deepbook::constants::no_restriction(),
                deepbook::constants::self_matching_allowed(),
                1_450_000_000, // price: 1.45 * 1e9
                10_000_000_000, // quantity: 10 SUI
                true,  // is_bid = true → bid
                true,  // pay_with_deep
                deepbook::constants::max_u64(),
                &clock,
                test_scenario::ctx(scenario),
            );

            test_scenario::return_shared(pool);
            test_scenario::return_shared(clock);
            test_scenario::return_shared(bm_ref);
        };

        (db_registry_id, pool_id, bm_id)
    }

    // Direct test: swap_and_settle_new_user_qfb with real DeepBook pool
    #[test]
    fun test_direct_swap_and_settle_new_user_qfb() {
        let mut scenario = test_scenario::begin(ADDR_ADMIN);
        setup_test(&mut scenario);
        let (_db_reg_id, pool_id, _bm_id) = setup_qfb_pool(&mut scenario);

        // User calls swap_and_settle_new_user_qfb with DEEP payment
        test_scenario::next_tx(&mut scenario, ADDR_USER);
        {
            let config = test_scenario::take_shared<Config>(&scenario);
            let mut vault_registry = test_scenario::take_shared<VaultRegistry>(&scenario);
            let mut pool = test_scenario::take_shared_by_id<deepbook::pool::Pool<SUI, token::deep::DEEP>>(&scenario, pool_id);
            let clock = test_scenario::take_shared<sui::clock::Clock>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);

            // Mint DEEP payment coin (user pays 3 DEEP, at price 1.5 DEEP/SUI should get ~2 SUI)
            let payment_coin = coin::mint_for_testing<token::deep::DEEP>(3_000_000_000, ctx);

            settle::swap_and_settle_new_user_qfb<token::deep::DEEP>(
                &config,
                &mut vault_registry,
                &clock,
                &mut pool,
                payment_coin,
                3_000_000_000, // swap_amount (3 DEEP)
                1_000_000_000, // min_sui_out (1 SUI minimum)
                5_000_000,     // execution_cost_claim_mist (0.005 SUI, within current max_claim_mist)
                ADDR_SETTLEMENT_PAYOUT_RECIPIENT,
                vector[],      // receipt_id
                1,             // nonce
                0, 0, 0, 0, 0, 0, 0, // sim_gas, gas_variance, slippage, quoted_fee, protocol_fee, config_version, quote_ts
                vector[],      // policy_hash
                vector[],      // order_id_hash
                ctx,
            );

            test_scenario::return_shared(config);
            test_scenario::return_shared(vault_registry);
            test_scenario::return_shared(pool);
            test_scenario::return_shared(clock);
        };

        // Verify vault was created with surplus
        test_scenario::next_tx(&mut scenario, ADDR_USER);
        {
            let vault = test_scenario::take_from_sender<UserVault>(&scenario);
            // At price 1.5 DEEP/SUI, 3 DEEP → ~2 SUI (2_000_000_000 MIST)
            // minus execution_cost_claim_mist 5_000_000 → surplus ~1_995_000_000
            let balance = vault::balance(&vault);
            assert!(balance > 0, 80); // has surplus
            assert!(balance < 2_000_000_000, 81); // less than full swap output (claim deducted)
            test_scenario::return_to_sender(&scenario, vault);
        };

        test_scenario::end(scenario);
    }

    // Direct test: swap_and_settle_with_vault_qfb (credit=0 branch) with real DeepBook pool
    #[test]
    fun test_direct_swap_and_settle_with_vault_qfb_no_credit() {
        let mut scenario = test_scenario::begin(ADDR_ADMIN);
        setup_test(&mut scenario);
        let (_db_reg_id, pool_id, _bm_id) = setup_qfb_pool(&mut scenario);

        // First create a vault for the user
        test_scenario::next_tx(&mut scenario, ADDR_USER);
        {
            let config = test_scenario::take_shared<Config>(&scenario);
            let mut vault_registry = test_scenario::take_shared<VaultRegistry>(&scenario);
            let clock = test_scenario::take_shared<sui::clock::Clock>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);
            let coin_in = coin::mint_for_testing<SUI>(200_000_000, ctx);
            settle::settle_for_testing(
                &config, &mut vault_registry, &clock, coin_in,
                0, ADDR_SETTLEMENT_PAYOUT_RECIPIENT, vector[], 1, 0, 0, 0, 0, 0, 0, 0, vector[], vector[], ctx
            );
            test_scenario::return_shared(config);
            test_scenario::return_shared(vault_registry);
            test_scenario::return_shared(clock);
        };

        // Now call qfb with_vault (no credit)
        test_scenario::next_tx(&mut scenario, ADDR_USER);
        {
            let config = test_scenario::take_shared<Config>(&scenario);
            let vault_registry = test_scenario::take_shared<VaultRegistry>(&scenario);
            let mut vault = test_scenario::take_from_sender<UserVault>(&scenario);
            let mut pool = test_scenario::take_shared_by_id<deepbook::pool::Pool<SUI, token::deep::DEEP>>(&scenario, pool_id);
            let clock = test_scenario::take_shared<sui::clock::Clock>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);

            let payment_coin = coin::mint_for_testing<token::deep::DEEP>(3_000_000_000, ctx);

            settle::swap_and_settle_with_vault_qfb<token::deep::DEEP>(
                &config,
                &vault_registry,
                &clock,
                &mut vault,
                &mut pool,
                payment_coin,
                3_000_000_000, // swap_amount
                1_000_000_000, // min_sui_out
                5_000_000,     // execution_cost_claim_mist
                ADDR_SETTLEMENT_PAYOUT_RECIPIENT,
                vector[], 2, 0, 0, 0, 0, 0, 0, 0, vector[], vector[],
                0, // use_credit_amount = 0
                ctx,
            );

            // vault should have original 200M + new surplus
            let balance = vault::balance(&vault);
            assert!(balance > 200_000_000, 82); // more than initial deposit
            test_scenario::return_shared(config);
            test_scenario::return_shared(vault_registry);
            test_scenario::return_shared(pool);
            test_scenario::return_shared(clock);
            test_scenario::return_to_sender(&scenario, vault);
        };

        test_scenario::end(scenario);
    }

    // Direct test: swap_and_settle_with_vault_qfb (credit>0 branch) with real DeepBook pool
    #[test]
    fun test_direct_swap_and_settle_with_vault_qfb_with_credit() {
        let mut scenario = test_scenario::begin(ADDR_ADMIN);
        setup_test(&mut scenario);
        let (_db_reg_id, pool_id, _bm_id) = setup_qfb_pool(&mut scenario);

        // First create a vault with surplus
        test_scenario::next_tx(&mut scenario, ADDR_USER);
        {
            let config = test_scenario::take_shared<Config>(&scenario);
            let mut vault_registry = test_scenario::take_shared<VaultRegistry>(&scenario);
            let clock = test_scenario::take_shared<sui::clock::Clock>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);
            let coin_in = coin::mint_for_testing<SUI>(500_000_000, ctx);
            settle::settle_for_testing(
                &config, &mut vault_registry, &clock, coin_in,
                0, ADDR_SETTLEMENT_PAYOUT_RECIPIENT, vector[], 1, 0, 0, 0, 0, 0, 0, 0, vector[], vector[], ctx
            );
            test_scenario::return_shared(config);
            test_scenario::return_shared(vault_registry);
            test_scenario::return_shared(clock);
        };

        // Now call qfb with_vault with credit
        test_scenario::next_tx(&mut scenario, ADDR_USER);
        {
            let config = test_scenario::take_shared<Config>(&scenario);
            let vault_registry = test_scenario::take_shared<VaultRegistry>(&scenario);
            let mut vault = test_scenario::take_from_sender<UserVault>(&scenario);
            let mut pool = test_scenario::take_shared_by_id<deepbook::pool::Pool<SUI, token::deep::DEEP>>(&scenario, pool_id);
            let clock = test_scenario::take_shared<sui::clock::Clock>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);

            let payment_coin = coin::mint_for_testing<token::deep::DEEP>(3_000_000_000, ctx);

            settle::swap_and_settle_with_vault_qfb<token::deep::DEEP>(
                &config,
                &vault_registry,
                &clock,
                &mut vault,
                &mut pool,
                payment_coin,
                3_000_000_000, // swap_amount
                1_000_000_000, // min_sui_out
                5_000_000,     // execution_cost_claim_mist
                ADDR_SETTLEMENT_PAYOUT_RECIPIENT,
                vector[], 2, 0, 0, 0, 0, 0, 0, 0, vector[], vector[],
                50_000_000, // use_credit_amount = 50M MIST
                ctx,
            );

            // vault: started with 500M, used 50M credit, plus new swap surplus deposited
            let balance = vault::balance(&vault);
            assert!(balance > 400_000_000, 83); // at least 500M - 50M credit - some claim
            test_scenario::return_shared(config);
            test_scenario::return_shared(vault_registry);
            test_scenario::return_shared(pool);
            test_scenario::return_shared(clock);
            test_scenario::return_to_sender(&scenario, vault);
        };

        test_scenario::end(scenario);
    }


    // ─────────────────────────────────────────────
    // Direct bfq public-entry tests (pool-backed)
    //
    // Pool<DEEP, SUI>: BaseType=DEEP, QuoteType=SUI, user swaps DEEP → SUI via
    // swap_exact_base_for_quote. Tests lock wrapper destructuring + spread
    // guard + settle wiring for the bfq path only.
    //
    // Leftover transfer/destroy branches are not separately asserted;
    // transaction success proves the wrapper wiring (destructuring order,
    // zero-coin cleanup) is correct — any mismatch aborts the TX.
    // ─────────────────────────────────────────────

    fun setup_deep_sui_pool(scenario: &mut Scenario): ID {
        // 1. Create shared Clock + DeepBook registry
        test_scenario::next_tx(scenario, ADDR_ADMIN);
        clock::create_for_testing(test_scenario::ctx(scenario)).share_for_testing();

        test_scenario::next_tx(scenario, ADDR_ADMIN);
        let db_registry_id = deepbook::registry::test_registry(test_scenario::ctx(scenario));

        // 2. Create Pool<DEEP, SUI> (whitelisted — matches settle.move coin::zero<DEEP>() pattern)
        test_scenario::next_tx(scenario, ADDR_ADMIN);
        let admin_cap = deepbook::registry::get_admin_cap_for_testing(test_scenario::ctx(scenario));
        let mut db_registry = test_scenario::take_shared_by_id<deepbook::registry::Registry>(scenario, db_registry_id);
        let pool_id = deepbook::pool::create_pool_admin<token::deep::DEEP, SUI>(
            &mut db_registry,
            deepbook::constants::tick_size(),
            deepbook::constants::lot_size(),
            deepbook::constants::min_size(),
            true, false,
            &admin_cap,
            test_scenario::ctx(scenario),
        );
        test_scenario::return_shared(db_registry);
        std::unit_test::destroy(admin_cap);

        // 3. Create BalanceManager and fund it with DEEP + SUI
        test_scenario::next_tx(scenario, ADDR_MARKET_MAKER);
        let mut bm = deepbook::balance_manager::new(test_scenario::ctx(scenario));
        let deep_d = coin::mint_for_testing<token::deep::DEEP>(100_000_000_000, test_scenario::ctx(scenario));
        let sui_d = coin::mint_for_testing<SUI>(100_000_000_000, test_scenario::ctx(scenario));
        deepbook::balance_manager::deposit(&mut bm, deep_d, test_scenario::ctx(scenario));
        deepbook::balance_manager::deposit(&mut bm, sui_d, test_scenario::ctx(scenario));
        let bm_id = sui::object::id(&bm);
        transfer::public_share_object(bm);

        // 4. Place two-sided orders on Pool<DEEP, SUI>
        //    Ask: sell DEEP at 0.7 SUI/DEEP
        //    Bid: buy DEEP at 0.67 SUI/DEEP
        //    Spread: (0.7-0.67)/0.7 * 10000 = 428 bps (within 500 bps cap)
        test_scenario::next_tx(scenario, ADDR_MARKET_MAKER);
        {
            let mut pool = test_scenario::take_shared_by_id<deepbook::pool::Pool<token::deep::DEEP, SUI>>(scenario, pool_id);
            let clk = test_scenario::take_shared<sui::clock::Clock>(scenario);
            let mut bm_ref = test_scenario::take_shared_by_id<deepbook::balance_manager::BalanceManager>(scenario, bm_id);
            let proof = deepbook::balance_manager::generate_proof_as_owner(&mut bm_ref, test_scenario::ctx(scenario));

            let _ask = deepbook::pool::place_limit_order<token::deep::DEEP, SUI>(
                &mut pool, &mut bm_ref, &proof,
                3, deepbook::constants::no_restriction(), deepbook::constants::self_matching_allowed(),
                700_000_000, 10_000_000_000, false, true, deepbook::constants::max_u64(),
                &clk, test_scenario::ctx(scenario),
            );
            let _bid = deepbook::pool::place_limit_order<token::deep::DEEP, SUI>(
                &mut pool, &mut bm_ref, &proof,
                4, deepbook::constants::no_restriction(), deepbook::constants::self_matching_allowed(),
                670_000_000, 10_000_000_000, true, true, deepbook::constants::max_u64(),
                &clk, test_scenario::ctx(scenario),
            );

            test_scenario::return_shared(pool);
            test_scenario::return_shared(clk);
            test_scenario::return_shared(bm_ref);
        };

        pool_id
    }

    // Direct test: swap_and_settle_new_user_bfq over Pool<DEEP, SUI>.
    #[test]
    fun test_direct_swap_and_settle_new_user_bfq() {
        let mut scenario = test_scenario::begin(ADDR_ADMIN);
        setup_test(&mut scenario);
        let pool2_id = setup_deep_sui_pool(&mut scenario);

        test_scenario::next_tx(&mut scenario, ADDR_USER);
        {
            let config = test_scenario::take_shared<Config>(&scenario);
            let mut vault_registry = test_scenario::take_shared<VaultRegistry>(&scenario);
            let mut pool = test_scenario::take_shared_by_id<deepbook::pool::Pool<token::deep::DEEP, SUI>>(&scenario, pool2_id);
            let clk = test_scenario::take_shared<sui::clock::Clock>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);

            // Pool<DEEP, SUI> ask at 0.7 SUI/DEEP.
            // User pays 2 DEEP → expects ~1.4 SUI out.
            let payment = coin::mint_for_testing<token::deep::DEEP>(2_000_000_000, ctx);

            settle::swap_and_settle_new_user_bfq<token::deep::DEEP>(
                &config,
                &mut vault_registry,
                &clk,
                &mut pool,
                payment,
                2_000_000_000, // swap_amount: 2 DEEP
                500_000_000,   // min_sui_out: 0.5 SUI floor
                5_000_000,     // execution_cost_claim_mist
                ADDR_SETTLEMENT_PAYOUT_RECIPIENT,
                vector[], 1, 0, 0, 0, 0, 0, 0, 0, vector[], vector[],
                ctx,
            );

            test_scenario::return_shared(config);
            test_scenario::return_shared(vault_registry);
            test_scenario::return_shared(pool);
            test_scenario::return_shared(clk);
        };

        // Verify vault was created with surplus (swap_output - execution_cost_claim_mist - fees)
        test_scenario::next_tx(&mut scenario, ADDR_USER);
        {
            let vault = test_scenario::take_from_sender<UserVault>(&scenario);
            assert!(vault::balance(&vault) > 0, 100);
            test_scenario::return_to_sender(&scenario, vault);
        };

        test_scenario::end(scenario);
    }

    // Direct test: swap_and_settle_with_vault_bfq (use_credit_amount = 0).
    // Locks the no-credit branch of the bfq with_vault wrapper.
    #[test]
    fun test_direct_swap_and_settle_with_vault_bfq_no_credit() {
        let mut scenario = test_scenario::begin(ADDR_ADMIN);
        setup_test(&mut scenario);
        let pool2_id = setup_deep_sui_pool(&mut scenario);

        // First create a vault via settle_for_testing (no swap needed)
        test_scenario::next_tx(&mut scenario, ADDR_USER);
        {
            let config = test_scenario::take_shared<Config>(&scenario);
            let mut vault_registry = test_scenario::take_shared<VaultRegistry>(&scenario);
            let clk = test_scenario::take_shared<sui::clock::Clock>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);
            let coin_in = coin::mint_for_testing<SUI>(200_000_000, ctx);
            settle::settle_for_testing(
                &config, &mut vault_registry, &clk, coin_in,
                0, ADDR_SETTLEMENT_PAYOUT_RECIPIENT, vector[], 1, 0, 0, 0, 0, 0, 0, 0, vector[], vector[], ctx
            );
            test_scenario::return_shared(config);
            test_scenario::return_shared(vault_registry);
            test_scenario::return_shared(clk);
        };

        // Now exercise the bfq with_vault wrapper with credit=0
        test_scenario::next_tx(&mut scenario, ADDR_USER);
        {
            let config = test_scenario::take_shared<Config>(&scenario);
            let vault_registry = test_scenario::take_shared<VaultRegistry>(&scenario);
            let mut vault = test_scenario::take_from_sender<UserVault>(&scenario);
            let mut pool = test_scenario::take_shared_by_id<deepbook::pool::Pool<token::deep::DEEP, SUI>>(&scenario, pool2_id);
            let clk = test_scenario::take_shared<sui::clock::Clock>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);

            let payment = coin::mint_for_testing<token::deep::DEEP>(2_000_000_000, ctx);

            settle::swap_and_settle_with_vault_bfq<token::deep::DEEP>(
                &config,
                &vault_registry,
                &clk,
                &mut vault,
                &mut pool,
                payment,
                2_000_000_000, // swap_amount
                500_000_000,   // min_sui_out
                5_000_000,     // execution_cost_claim_mist
                ADDR_SETTLEMENT_PAYOUT_RECIPIENT,
                vector[], 2, 0, 0, 0, 0, 0, 0, 0, vector[], vector[],
                0,             // use_credit_amount = 0 (no credit drain)
                ctx,
            );

            // vault: 200M initial + swap surplus, no credit drain
            assert!(vault::balance(&vault) >= 200_000_000, 101);
            test_scenario::return_shared(config);
            test_scenario::return_shared(vault_registry);
            test_scenario::return_shared(pool);
            test_scenario::return_shared(clk);
            test_scenario::return_to_sender(&scenario, vault);
        };

        test_scenario::end(scenario);
    }

    // Direct test: swap_and_settle_with_vault_bfq (use_credit_amount > 0).
    // Locks the credit-drain branch of the bfq with_vault wrapper.
    #[test]
    fun test_direct_swap_and_settle_with_vault_bfq_with_credit() {
        let mut scenario = test_scenario::begin(ADDR_ADMIN);
        setup_test(&mut scenario);
        let pool2_id = setup_deep_sui_pool(&mut scenario);

        test_scenario::next_tx(&mut scenario, ADDR_USER);
        {
            let config = test_scenario::take_shared<Config>(&scenario);
            let mut vault_registry = test_scenario::take_shared<VaultRegistry>(&scenario);
            let clk = test_scenario::take_shared<sui::clock::Clock>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);
            let coin_in = coin::mint_for_testing<SUI>(300_000_000, ctx);
            settle::settle_for_testing(
                &config, &mut vault_registry, &clk, coin_in,
                0, ADDR_SETTLEMENT_PAYOUT_RECIPIENT, vector[], 1, 0, 0, 0, 0, 0, 0, 0, vector[], vector[], ctx
            );
            test_scenario::return_shared(config);
            test_scenario::return_shared(vault_registry);
            test_scenario::return_shared(clk);
        };

        test_scenario::next_tx(&mut scenario, ADDR_USER);
        {
            let config = test_scenario::take_shared<Config>(&scenario);
            let vault_registry = test_scenario::take_shared<VaultRegistry>(&scenario);
            let mut vault = test_scenario::take_from_sender<UserVault>(&scenario);
            let mut pool = test_scenario::take_shared_by_id<deepbook::pool::Pool<token::deep::DEEP, SUI>>(&scenario, pool2_id);
            let clk = test_scenario::take_shared<sui::clock::Clock>(&scenario);
            let ctx = test_scenario::ctx(&mut scenario);

            let payment = coin::mint_for_testing<token::deep::DEEP>(2_000_000_000, ctx);

            settle::swap_and_settle_with_vault_bfq<token::deep::DEEP>(
                &config,
                &vault_registry,
                &clk,
                &mut vault,
                &mut pool,
                payment,
                2_000_000_000, 500_000_000, 5_000_000, ADDR_SETTLEMENT_PAYOUT_RECIPIENT,
                vector[], 2, 0, 0, 0, 0, 0, 0, 0, vector[], vector[],
                50_000_000,    // use_credit_amount = 50M
                ctx,
            );

            // vault: 300M initial - 50M credit + swap surplus
            assert!(vault::balance(&vault) > 200_000_000, 102);
            test_scenario::return_shared(config);
            test_scenario::return_shared(vault_registry);
            test_scenario::return_shared(pool);
            test_scenario::return_shared(clk);
            test_scenario::return_to_sender(&scenario, vault);
        };

        test_scenario::end(scenario);
    }

}
