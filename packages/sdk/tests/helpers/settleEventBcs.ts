import { SETTLE_EVENT_FIELDS } from '@stelis/contracts';
import { SettleEventBcs } from '../../src/server/settleEventDecoder.js';

type SettleEventBcsFieldInput<MoveType extends (typeof SETTLE_EVENT_FIELDS)[number]['moveType']> =
  MoveType extends 'u64'
    ? bigint
    : MoveType extends 'address'
      ? string
      : MoveType extends 'vector<u8>'
        ? Uint8Array
        : never;

export type SettleEventBcsInput = {
  [Field in (typeof SETTLE_EVENT_FIELDS)[number] as Field['name']]: SettleEventBcsFieldInput<
    Field['moveType']
  >;
};

export function serializeSettleEventBcs(input: SettleEventBcsInput): Uint8Array {
  // SettleEventBcs is assembled from the same generated descriptors with
  // Object.fromEntries(), which cannot preserve the per-field generic input
  // mapping. This local bridge restores that generated mapping before calling
  // the authoritative schema; it does not define a second event layout.
  return SettleEventBcs.serialize(
    input as unknown as Parameters<typeof SettleEventBcs.serialize>[0],
  ).toBytes();
}
