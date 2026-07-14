# Canonical Sui Chain Identifiers

The runtime source of truth is `SUI_CHAIN_IDENTIFIERS` in
`@stelis/contracts`. `validateChainIdentity.ts` consumes that table to verify
that configured RPC endpoints connect to the correct network at boot time;
manual deployed-Host tests consume the same table before submitting.

## Values

| Network | chainIdentifier (Base58)                       |
| ------- | ---------------------------------------------- |
| testnet | `69WiPg3DAQiwdxfncX6wYQ2siKwAe6L9BZthQea3JNMD` |
| mainnet | `4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S` |

## What is chainIdentifier?

The `chainIdentifier` is the genesis state-machine result digest of the Sui network.
It is returned by `ledgerService.getServiceInfo().chainId` via the gRPC v2 API.
This value is determined at network genesis and does not change unless the
network is reset (which has not happened for mainnet).

## Verification method

Query any healthy Sui gRPC v2 endpoint:

```ts
import { SuiGrpcClient } from '@mysten/sui/grpc';
const client = new SuiGrpcClient({ network: 'testnet', baseUrl: '<endpoint>' });
const { chainIdentifier } = await client.core.getChainIdentifier();
```

Re-verify from at least two independent endpoints before trusting a new value.
